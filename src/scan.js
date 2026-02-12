const { chromium } = require("playwright");

const CAPTCHA_PROVIDERS = [
  { name: "reCAPTCHA", dom: [/recaptcha/i, /g-recaptcha/i], net: [/google\.com\/recaptcha/i] },
  { name: "hCaptcha", dom: [/hcaptcha/i], net: [/hcaptcha\.com/i] },
  { name: "Turnstile", dom: [/turnstile/i, /cf-turnstile/i], net: [/challenges\.cloudflare\.com/i] },
];

function uniq(arr) { return [...new Set((arr || []).filter(Boolean))]; }

function detectProvidersFrom(domText, netUrls) {
  const found = [];
  for (const p of CAPTCHA_PROVIDERS) {
    const domHit = p.dom.some((r) => r.test(domText));
    const netHit = p.net.some((r) => netUrls.some((u) => r.test(u)));
    if (domHit || netHit) found.push(p.name);
  }
  return found;
}

async function collectNetwork(page, fn) {
  const urls = [];
  const onReq = (req) => urls.push(req.url());
  page.on("request", onReq);
  try { await fn(); } finally { page.off("request", onReq); }
  return urls;
}

async function detectVirtualKeyboardSignals(page) {
  // Heurística melhor:
  // - input password readonly/disabled
  // - inputmode=none
  // - após clicar no password: aparece overlay/dialog com muitos botões (0-9) ou keypad
  // - presença de containers conhecidos (keyboard, keypad, tec, pinpad)
  return await page.evaluate(async () => {
    const hints = [];

    const q = (sel) => Array.from(document.querySelectorAll(sel));

    const pass = document.querySelector('input[type="password"]') || null;

    if (pass) {
      const ro = pass.hasAttribute("readonly") || pass.readOnly;
      const dis = pass.hasAttribute("disabled") || pass.disabled;
      const im = (pass.getAttribute("inputmode") || "").toLowerCase();

      if (ro) hints.push("passwordReadonly");
      if (dis) hints.push("passwordDisabled");
      if (im === "none") hints.push("inputmodeNone");

      // tenta focar/clicar
      try { pass.focus(); } catch {}
      try { pass.click(); pass.click(); } catch {}
    }

    // Espera curtinha para overlays renderizarem
    await new Promise(r => setTimeout(r, 250));

    // seletor de teclados/keypads comuns
    const keyboardSelectors = [
      '[class*="keyboard"]', '[id*="keyboard"]',
      '[class*="keypad"]', '[id*="keypad"]',
      '[class*="pinpad"]', '[id*="pinpad"]',
      '[class*="teclado"]', '[id*="teclado"]',
      '[class*="senha"] [class*="tecla"]',
      '[aria-label*="tecla"]', '[data-key]', '[data-keycode]',
    ];

    const keyboardNodes = keyboardSelectors.flatMap(sel => q(sel));
    if (keyboardNodes.length) hints.push(`keyboardNodes:${keyboardNodes.length}`);

    // Contar botões numéricos visíveis (0-9), típico de teclado virtual
    const btns = q("button, [role='button'], a, div");
    const numericVisible = btns.filter(el => {
      const txt = (el.innerText || el.textContent || "").trim();
      if (!txt) return false;
      if (!/^[0-9]$/.test(txt)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 18 && r.height >= 18; // ignora lixo
    });
    if (numericVisible.length >= 8) hints.push(`numericKeypad:${numericVisible.length}`);

    // overlay/dialog depois do click
    const dialogs = q('[role="dialog"], .modal, [class*="modal"], [class*="overlay"], [id*="overlay"]');
    if (dialogs.length) hints.push(`overlayOrDialog:${dialogs.length}`);

    // sinais de "digite sua senha pelo teclado virtual"
    const bodyText = (document.body?.innerText || "").toLowerCase();
    if (bodyText.includes("teclado virtual")) hints.push("textTecladoVirtual");
    if (bodyText.includes("digite sua senha")) hints.push("textDigiteSuaSenha");

    // decisão final: se tem hints fortes, marca como virtual keyboard
    const strong =
      hints.some(h => h.startsWith("passwordReadonly")) ||
      hints.some(h => h.startsWith("inputmodeNone")) ||
      hints.some(h => h.startsWith("numericKeypad")) ||
      hints.some(h => h.startsWith("keyboardNodes"));

    return { virtualKeyboardLikely: !!strong, hints };
  });
}

async function analyzeOneState(page, mode) {
  const title = await page.title().catch(() => "");
  const content = await page.content().catch(() => "");
  const domText = `${title}\n${content}`;

  // heurística login
  const hasPassword = /type=["']password["']/i.test(content) || /password/i.test(content);
  const hasUser =
    /(type=["']email["'])|(type=["']text["'])/i.test(content) &&
    /(usuario|usuário|email|cpf|cnpj|login|user|username)/i.test(content);

  // captcha hints
  const captchaDomHints = [];
  if (/captcha/i.test(domText)) captchaDomHints.push("captchaText");
  if (/g-recaptcha|recaptcha/i.test(domText)) captchaDomHints.push("recaptchaDom");
  if (/hcaptcha/i.test(domText)) captchaDomHints.push("hcaptchaDom");
  if (/turnstile|cf-turnstile/i.test(domText)) captchaDomHints.push("turnstileDom");

  // 2FA indícios
  const twoFactorHints = [];
  if (/(2fa|two[- ]factor|duplo fator|autenticador|otp|token|código de verificação)/i.test(domText)) {
    twoFactorHints.push("twoFactorText");
  }

  // teclado virtual/bloqueio
  const vk = await detectVirtualKeyboardSignals(page);

  return {
    mode,
    title,
    login: {
      likelyLogin: !!(hasPassword && hasUser),
      hasPasswordField: !!hasPassword,
      hasUserField: !!hasUser,
    },
    captcha: {
      present: captchaDomHints.length > 0,
      providers: [],
      evidence: {
        domProviders: [],
        networkProviders: [],
        challengeHints: captchaDomHints,
      },
    },
    twoFactor: {
      likelyPresent: twoFactorHints.length > 0,
      hints: twoFactorHints,
    },
    typing: {
      virtualKeyboardLikely: !!vk.virtualKeyboardLikely,
      hints: vk.hints || [],
    },
  };
}

async function runPass({ url, headless }) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: headless
      ? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
      : undefined
  });

  const page = await context.newPage();
  const errors = [];

  const t0 = Date.now();

  let netUrls = [];
  try {
    netUrls = await collectNetwork(page, async () => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(750); // dá tempo de carregar scripts do challenge
    });
  } catch (e) {
    errors.push(`goto: ${e?.message || e}`);
  }

  const states = [];
  try {
    const st = await analyzeOneState(page, "Default");

    const html = await page.content().catch(() => "");
    const providers = detectProvidersFrom(html, netUrls);
    const netProviders = detectProvidersFrom("", netUrls); // simplificado

    st.captcha.providers = providers;
    st.captcha.evidence.domProviders = providers;
    st.captcha.evidence.networkProviders = netProviders;

    // presente se DOM ou network ou palavra captcha
    st.captcha.present = !!(providers.length || netProviders.length || st.captcha.evidence.challengeHints.length);

    states.push(st);
  } catch (e) {
    errors.push(`analyze(Default): ${e?.message || e}`);
  }

  // screenshot: só headed
  let screenshot = { ok: false, reason: "headless (sem screenshot)" };
  if (!headless) {
    try {
      const buf = await page.screenshot({ fullPage: true, timeout: 90000 });
      screenshot = { ok: true, format: "data:image/png;base64", data: buf.toString("base64") };

      // ✅ também anexa no state Default para o pdfReport antigo não falhar
      if (states[0]) states[0].screenshot = screenshot;
    } catch (e) {
      screenshot = { ok: false, reason: `Screenshot indisponível: ${e?.message || e}` };
    }
  }

  await browser.close().catch(() => {});

  const timingMs = Date.now() - t0;
  return { timingMs, states, errors, screenshot, netUrls };
}

async function scanHandler(req, res) {
  const url = (req.body?.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL obrigatória." });

  const t0 = Date.now();

  const headed = await runPass({ url, headless: false });
  const headless = await runPass({ url, headless: true });

  const headedCaptcha = headed.states.some(s => s.captcha.present);
  const headlessCaptcha = headless.states.some(s => s.captcha.present);

  const providers = uniq([
    ...headed.states.flatMap(s => s.captcha.providers || []),
    ...headless.states.flatMap(s => s.captcha.providers || []),
  ]);

  const typingBlockedLikely = false;
  const virtualKeyboardLikely =
    headed.states.some(s => s.typing?.virtualKeyboardLikely) ||
    headless.states.some(s => s.typing?.virtualKeyboardLikely);

  const summary = {
    captchaLikely: headedCaptcha || headlessCaptcha,
    captchaOnScreen: headedCaptcha,
    captchaOnlyWhenBotLike: !headedCaptcha && headlessCaptcha,
    providers,
    typingBlockedLikely,
    virtualKeyboardLikely,
    antiAutomationLikely: (!headedCaptcha && headlessCaptcha) || virtualKeyboardLikely,
    loginLikely: headed.states.some(s => s.login?.likelyLogin) || headless.states.some(s => s.login?.likelyLogin),
    headedModes: headed.states.length,
    headlessModes: headless.states.length,
  };

  res.json({
    url,
    title: headed.states?.[0]?.title || "",
    timingMs: Date.now() - t0,
    summary,
    screenshot: headed.screenshot, // mantém no topo também
    passes: {
      headed: { timingMs: headed.timingMs, states: headed.states, errors: headed.errors },
      headless: { timingMs: headless.timingMs, states: headless.states, errors: headless.errors },
    }
  });
}

module.exports = { scanHandler };
