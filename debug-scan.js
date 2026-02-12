const { chromium } = require("playwright");
const { scanHandler } = require("./src/scan"); // se precisar, mas melhor chamar runPass (abaixo)

// Se você não exportou runPass, exporta (vou te mostrar já)
const { runPass } = require("./src/scan");

(async () => {
  const url = "https://prod.gestorjuridico.com.br/Paginas/Principal/_FSet_Abertura.asp";

  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

  // PAUSA AQUI e abre o Inspector (com PWDEBUG=1)
  await page.pause();

  await browser.close();
})();