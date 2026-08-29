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

// Handed to a vendor or volunteer so they know what's being asked of them —
// deliberately leaves out estimated/actual cost (that's our internal budget
// number, not something to hand the person quoting or doing the work) and
// internal-only fields; if the user wants cost included later that's a
// one-line addition here.
export function renderWorkOrderScopePdf({ title, assetName, locationName, priority, scheduledDate, description, tasks, volunteers, vendors, checklistSteps }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#777').text('SCOPE OF WORK');
    doc.fillColor('#000').fontSize(20).font('Helvetica-Bold').moveDown(0.15).text(title);
    doc.moveDown(0.3);

    const metaLine = [assetName, locationName].filter(Boolean).join(' — ');
    if (metaLine) doc.fontSize(12).font('Helvetica').fillColor('#333').text(metaLine);
    const detailBits = [];
    if (priority) detailBits.push(`Priority: ${priority}`);
    if (scheduledDate) detailBits.push(`Scheduled: ${new Date(scheduledDate).toLocaleDateString()}`);
    if (detailBits.length) doc.fontSize(11).fillColor('#555').text(detailBits.join('    '));
    doc.fillColor('#000').moveDown(1);

    if (description) {
      doc.fontSize(13).font('Helvetica-Bold').text('Description');
      doc.fontSize(12).font('Helvetica').moveDown(0.2).text(description, { width: 495 });
      doc.moveDown(1);
    }

    if (tasks?.length) {
      doc.fontSize(13).font('Helvetica-Bold').text('Scope of Work');
      doc.moveDown(0.3);
      tasks.forEach((t) => {
        doc.fontSize(12).font('Helvetica').text(`•  ${t}`, 60, doc.y, { width: 485 });
        doc.moveDown(0.3);
      });
      doc.moveDown(0.7);
    }

    if (checklistSteps?.length) {
      doc.fontSize(13).font('Helvetica-Bold').text('Checklist');
      doc.moveDown(0.3);
      checklistSteps.forEach((s) => {
        const y = doc.y;
        doc.rect(60, y + 2, 12, 12).lineWidth(1).stroke();
        doc.fontSize(12).font('Helvetica').text(s, 82, y, { width: 463 });
        doc.moveDown(0.3);
      });
      doc.moveDown(0.7);
    }

    const assignedTo = [...(volunteers || []), ...(vendors || [])];
    if (assignedTo.length) {
      doc.fontSize(13).font('Helvetica-Bold').text('Assigned To');
      doc.fontSize(12).font('Helvetica').moveDown(0.2).text(assignedTo.join(', '));
      doc.moveDown(1);
    }

    doc.fontSize(9).font('Helvetica').fillColor('#777').text(`Generated ${new Date().toLocaleString()}`);

    doc.end();
  });
}
