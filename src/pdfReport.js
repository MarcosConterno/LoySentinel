const PDFDocument = require("pdfkit");

function yesNo(v) {
  return v ? "SIM" : "NÃO";
}
function safeText(s) {
  return (s ?? "").toString();
}

function pickOneScreenshot(result) {
  // ✅ 1) Primeiro tenta o screenshot top-level (é o que seu front usa)
  if (result?.screenshot?.data) {
    return { label: "Top-level screenshot", screenshot: result.screenshot };
  }

  // 2) Fallback: tenta achar screenshot dentro dos states
  const headlessStates = result?.passes?.headless?.states || [];
  const headedStates = result?.passes?.headed?.states || [];

  const findDefault = (arr) =>
    arr.find((s) => (s.mode || "").toLowerCase() === "default" && s.screenshot?.data);

  const a = findDefault(headedStates);
  if (a) return { label: "Headed / Default", screenshot: a.screenshot };

  const any = [...headedStates, ...headlessStates].find((s) => s.screenshot?.data);
  if (any) return { label: `${any.mode || "Modo"}`, screenshot: any.screenshot };

  return { label: "Sem screenshot", screenshot: null };
}

function drawBadge(doc, label, value, x, y, w) {
  const isYes = !!value;
  doc.roundedRect(x, y, w, 18, 9).fill(isYes ? "#d1fae5" : "#fee2e2");
  doc
    .fillColor(isYes ? "#065f46" : "#991b1b")
    .fontSize(10)
    .text(`${label}: ${yesNo(isYes)}`, x + 10, y + 4, { width: w - 20 });
  doc.fillColor("#111827");
}

function addKV(doc, k, v) {
  doc.fontSize(10).fillColor("#374151").text(`${k}: `, { continued: true });
  doc.fillColor("#111827").text(safeText(v));
}

function addHr(doc) {
  doc.moveDown(0.4);
  doc.strokeColor("#e5e7eb").lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.6);
}

function buildPdfReport(result) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const s = result.summary || {};
    const providers = (s.providers || []).join(", ") || "-";
    const headedModes = s.headedModes ?? (result.passes?.headed?.states?.length ?? 0);
    const headlessModes = s.headlessModes ?? (result.passes?.headless?.states?.length ?? 0);

    const picked = pickOneScreenshot(result);

    doc.fontSize(18).fillColor("#111827").text("Relatório - Login Page Scanner (1 página)");
    doc.fontSize(10).fillColor("#6b7280").text(`URL: ${safeText(result.url)}`);
    doc.fontSize(10).fillColor("#6b7280").text(`Gerado em: ${new Date().toLocaleString("pt-BR")}`);
    doc.moveDown(0.8);

    const y0 = doc.y;
    drawBadge(doc, "Login provável", !!s.loginLikely, 40, y0, 160);
    drawBadge(doc, "Captcha/Challenge", !!s.captchaLikely, 210, y0, 180);
    drawBadge(doc, "Só no headless", !!s.captchaOnlyWhenBotLike, 400, y0, 155);
    doc.moveDown(2);

    doc.fontSize(13).fillColor("#111827").text("Resumo");
    addHr(doc);

    addKV(doc, "Providers detectados", providers);
    addKV(doc, "Modos detectados (Headed)", headedModes);
    addKV(doc, "Modos detectados (Headless)", headlessModes);

    // ✅ Extra: teclado virtual no resumo, se existir
    const vk = !!s.virtualKeyboardLikely || !!s.typingBlockedLikely;
    addKV(doc, "Teclado virtual/digitação bloqueada", vk ? "SIM" : "NÃO");

    doc.moveDown(0.8);

    doc.fontSize(13).fillColor("#111827").text("Print da página");
    doc.fontSize(9).fillColor("#6b7280").text(`Selecionado: ${picked.label}`);
    doc.moveDown(0.4);

    if (picked.screenshot?.data) {
      try {
        const buf = Buffer.from(picked.screenshot.data, "base64");
        doc.image(buf, 40, doc.y, { fit: [515, 360], align: "center" });
        doc.y = doc.y + 370;
      } catch {
        doc.fontSize(10).fillColor("#991b1b").text("Falha ao renderizar o screenshot no PDF.");
      }
    } else {
      doc.fontSize(10).fillColor("#6b7280").text("Screenshot indisponível (timeout/recursos da página).");
      doc.moveDown(0.6);
    }

    doc.fontSize(9).fillColor("#6b7280").text(
      "Nota: este relatório não realiza login. A detecção de 2FA real geralmente aparece após autenticação válida; aqui são exibidos indícios na tela pública.",
      40,
      780 - 40,
      { width: 515 }
    );

    doc.end();
  });
}

module.exports = { buildPdfReport };
