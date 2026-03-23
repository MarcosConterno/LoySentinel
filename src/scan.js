const { chromium } = require("playwright");

const CAPTCHA_PROVIDERS = [
  { name: "reCAPTCHA", dom: [/recaptcha/i, /g-recaptcha/i], net: [/google\.com\/recaptcha/i] },
  { name: "hCaptcha", dom: [/hcaptcha/i], net: [/hcaptcha\.com/i] },
  { name: "Turnstile", dom: [/turnstile/i, /cf-turnstile/i], net: [/challenges\.cloudflare\.com/i] },
];

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

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
  try {
    await fn();
  } finally {
    page.off("request", onReq);
  }
  return urls;
}

/**
 * Coleta sinais no DOM (sem clicar).
 * Isso é estável e barato.
 */
async function detectVirtualKeyboardSignalsDOM(page) {
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
    } else {
      hints.push("noPasswordInputFound");
    }

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

    const btns = q("button, [role='button'], a, div");
    const numericVisible = btns.filter(el => {
      const txt = (el.innerText || el.textContent || "").trim();
      if (!txt) return false;
      if (!/^[0-9]$/.test(txt)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 18 && r.height >= 18;
    });
    if (numericVisible.length >= 8) hints.push(`numericKeypad:${numericVisible.length}`);

    const dialogs = q('[role="dialog"], .modal, [class*="modal"], [class*="overlay"], [id*="overlay"]');
    if (dialogs.length) hints.push(`overlayOrDialog:${dialogs.length}`);

    const bodyText = (document.body?.innerText || "").toLowerCase();
    if (bodyText.includes("teclado virtual")) hints.push("textTecladoVirtual");
    if (bodyText.includes("digite sua senha")) hints.push("textDigiteSuaSenha");

    const strong =
      hints.some(h => h === "passwordReadonly") ||
      hints.some(h => h === "inputmodeNone") ||
      hints.some(h => h.startsWith("numericKeypad")) ||
      hints.some(h => h.startsWith("keyboardNodes"));

    return { virtualKeyboardLikely: !!strong, hints };
  });
}

/**
 * Faz um teste real de clique (Playwright) para provar se “abre teclado”.
 * Retorna métricas antes/depois do clique e hints.
 */
async function detectVirtualKeyboardByClick(page) {
  const result = {
    attempted: false,
    clicked: false,
    reason: null,
    before: null,
    after: null,
    delta: null,
    hints: [],
  };

  // métrica DOM (antes/depois) para comprovar mudança
  const snapshot = async () => {
    return await page.evaluate(() => {
      const q = (sel) => Array.from(document.querySelectorAll(sel));
      const keyboardSelectors = [
        '[class*="keyboard"]', '[id*="keyboard"]',
        '[class*="keypad"]', '[id*="keypad"]',
        '[class*="pinpad"]', '[id*="pinpad"]',
        '[class*="teclado"]', '[id*="teclado"]',
        '[class*="senha"] [class*="tecla"]',
        '[aria-label*="tecla"]', '[data-key]', '[data-keycode]',
      ];

      const keyboardNodes = keyboardSelectors.flatMap(sel => q(sel));

      const btns = q("button, [role='button'], a, div");
      const numericVisible = btns.filter(el => {
        const txt = (el.innerText || el.textContent || "").trim();
        if (!txt) return false;
        if (!/^[0-9]$/.test(txt)) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 18 && r.height >= 18;
      });

      const dialogs = q('[role="dialog"], .modal, [class*="modal"], [class*="overlay"], [id*="overlay"]');

      return {
        keyboardNodes: keyboardNodes.length,
        numericVisible: numericVisible.length,
        overlays: dialogs.length,
      };
    });
  };

  // 1) acha input password
  const pass = page.locator('input[type="password"]').first();
  const passCount = await pass.count().catch(() => 0);
  if (!passCount) {
    result.reason = "noPasswordInput";
    return result;
  }

  result.attempted = true;

  // 2) tenta clicar no próprio campo senha (muitos teclados abrem assim)
  result.before = await snapshot();

  try {
    await pass.scrollIntoViewIfNeeded().catch(() => {});
    await pass.click({ timeout: 8000 });
    result.clicked = true;
    result.hints.push("clickedPasswordInput");
  } catch (e) {
    result.hints.push("passwordClickFailed");
  }

  // 3) fallback: tenta achar um ícone/botão próximo que pareça “teclado”
  if (!result.clicked) {
    try {
      const candidate = page.locator(
        [
          'text=/teclado virtual/i',
          '[title*="teclado" i]',
          '[aria-label*="teclado" i]',
          '[class*="teclado" i]',
          '[id*="teclado" i]',
          'img[alt*="teclado" i]',
        ].join(",")
      ).first();

      if (await candidate.count().catch(() => 0)) {
        await candidate.click({ timeout: 8000 });
        result.clicked = true;
        result.hints.push("clickedKeyboardCandidate");
      } else {
        result.hints.push("noKeyboardCandidateFound");
      }
    } catch {
      result.hints.push("keyboardCandidateClickFailed");
    }
  }

  // 4) espera curta para renderizar overlay
  await page.waitForTimeout(350);

  result.after = await snapshot();
  result.delta = {
    keyboardNodes: (result.after.keyboardNodes || 0) - (result.before.keyboardNodes || 0),
    numericVisible: (result.after.numericVisible || 0) - (result.before.numericVisible || 0),
    overlays: (result.after.overlays || 0) - (result.before.overlays || 0),
  };

  // 5) prova de que “abriu”
  const openedLikely =
    result.delta.keyboardNodes >= 1 ||
    result.delta.numericVisible >= 5 ||
    result.delta.overlays >= 1;

  if (!openedLikely) {
    result.reason = "clickDidNotRevealKeyboard";
  }

  return { ...result, openedLikely };
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

  // teclado virtual (DOM + clique real)
  const vkDom = await detectVirtualKeyboardSignalsDOM(page);
  const vkClick = await detectVirtualKeyboardByClick(page);

  // decisão final: clique tem prioridade; senão, usa DOM
  const virtualKeyboardLikely = !!(vkClick?.openedLikely || vkDom?.virtualKeyboardLikely);

  const typingHints = uniq([
    ...(vkDom?.hints || []),
    ...(vkClick?.hints || []),
    vkClick?.openedLikely ? "clickRevealedKeyboard" : null,
    vkClick?.reason ? `clickReason:${vkClick.reason}` : null,
  ]);

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
      virtualKeyboardLikely,
      hints: typingHints,
      clickTest: vkClick, // <<< deixa isso para debug (você pode ocultar no PDF se quiser)
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
      await page.waitForTimeout(750);
    });
  } catch (e) {
    errors.push(`goto: ${e?.message || e}`);
  }

  const states = [];
  try {
    const st = await analyzeOneState(page, "Default");

    const html = await page.content().catch(() => "");
    const providers = detectProvidersFrom(html, netUrls);
    const netProviders = detectProvidersFrom("", netUrls);

    st.captcha.providers = providers;
    st.captcha.evidence.domProviders = providers;
    st.captcha.evidence.networkProviders = netProviders;

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
    screenshot: headed.screenshot,
    passes: {
      headed: { timingMs: headed.timingMs, states: headed.states, errors: headed.errors },
      headless: { timingMs: headless.timingMs, states: headless.states, errors: headless.errors },
    }
  });
}

// ✅ AGORA EXPORTA O runPass TAMBÉM (pra debug-scan.js funcionar)
module.exports = { scanHandler, runPass };
