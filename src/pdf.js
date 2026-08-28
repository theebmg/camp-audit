// Checklist PDF export. Portability boundary: the only module that knows
// about pdfkit — callers just get a Buffer back.
import PDFDocument from 'pdfkit';

export function renderChecklistPdf({ checklistName, contextLabel, steps }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).font('Helvetica-Bold').text(checklistName);
    if (contextLabel) doc.fontSize(11).font('Helvetica').fillColor('#555').text(contextLabel);
    doc.fillColor('#000').moveDown(0.3);
    doc.fontSize(9).font('Helvetica').fillColor('#777')
      .text(`Exported ${new Date().toLocaleString()}`);
    doc.fillColor('#000').moveDown(1);

    const visibleSteps = steps.filter((s) => s.visible !== false);
    visibleSteps.forEach((s, i) => {
      const y = doc.y;
      doc.rect(50, y + 2, 12, 12).lineWidth(1).stroke();
      if (s.done) {
        doc.moveTo(52, y + 8).lineTo(56, y + 12).lineTo(60, y + 4).lineWidth(1.5).stroke();
      }
      doc.fontSize(12).font('Helvetica').text(s.text, 72, y, { width: 470 });
      if (s.doneAt) {
        doc.fontSize(9).fillColor('#888').text(`  completed ${new Date(s.doneAt).toLocaleDateString()}`, { continued: false });
        doc.fillColor('#000');
      }
      doc.moveDown(0.5);
    });

    if (!visibleSteps.length) doc.fontSize(12).fillColor('#888').text('No steps.');

    doc.end();
  });
}
