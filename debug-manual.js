const { chromium } = require("playwright");

(async () => {
  const url = "https://prod.gestorjuridico.com.br/Paginas/Principal/_FSet_Abertura.asp";

  const browser = await chromium.launch({ headless: false, slowMo: 150 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Logs úteis
  page.on("console", (msg) => console.log("PAGE:", msg.text()));
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(800);

  console.log("✅ Página carregada. Abrindo Inspector…");

  // Abre o Playwright Inspector e pausa aqui
  await page.pause();

  // Quando você der "Resume" no Inspector, continua:
  console.log("▶️ Voltou do pause. URL:", page.url());

  // Opcional: tira um print pós-clique manual pra comparar
  await page.waitForTimeout(1000);

  await browser.close();
})();
