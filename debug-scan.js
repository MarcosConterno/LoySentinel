const { runPass } = require("./src/scan");

(async () => {
  const url = "https://prod.gestorjuridico.com.br/Paginas/Principal/_FSet_Abertura.asp";
  const r = await runPass({ url, headless: false });
  console.log(JSON.stringify(r.states?.[0]?.typing, null, 2));
})();