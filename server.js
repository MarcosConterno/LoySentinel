const express = require("express");
const path = require("path");

const { scanHandler } = require("./src/scan");
const { buildPdfReport } = require("./src/pdfReport");

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// scan
app.post("/api/scan", scanHandler);

// pdf (pdfkit server-side)
app.post("/api/pdf", async (req, res) => {
  try {
    const result = req.body;
    const pdf = await buildPdfReport(result);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="LoySentinel-Report.pdf"');
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: "Falha ao gerar PDF.", detail: e?.message || String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("OK na porta", PORT));
