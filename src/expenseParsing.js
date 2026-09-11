// Build Brief v3 Part 2 (§2.2): pull vendor/amount/purchase-date suggestions
// out of a receipt email's subject/body text. Regex only — no OCR, no AI
// vision pipeline in this pass (photos of paper receipts get manual entry
// for now; that's a deliberate phase-two call, not an oversight).
//
// Everything this module returns is a SUGGESTION. The triage screen always
// shows editable fields pre-filled with these values and visibly marked as
// parsed — nothing here writes to the database or gets treated as confirmed.

const CURRENCY_RE = /\$\s?([\d,]+\.\d{2})/g;
const DATE_RE = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b|\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/i;

function toIsoDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function biggestAmount(text) {
  const amounts = [...text.matchAll(CURRENCY_RE)].map((m) => Number(m[1].replace(/,/g, '')));
  if (!amounts.length) return null;
  return Math.max(...amounts);
}

function findDate(text) {
  const m = text.match(DATE_RE);
  return m ? toIsoDate(m[1] || m[2]) : null;
}

// Amazon order confirmations: "Order Total: $42.17", subject usually
// "Your Amazon.com order of ... has shipped/been placed".
function parseAmazon(subject, body) {
  const totalMatch = body.match(/order total:?\s*\$?([\d,]+\.\d{2})/i) || body.match(/grand total:?\s*\$?([\d,]+\.\d{2})/i);
  const amount = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : biggestAmount(body);
  const dateMatch = body.match(/order (?:placed|date).{0,20}?(\w+ \d{1,2},? \d{4})/i);
  const purchaseDate = dateMatch ? toIsoDate(dateMatch[1]) : findDate(body) || findDate(subject);
  return { vendor: 'Amazon', amount, purchaseDate };
}

// Home Depot / Lowe's emailed receipts: "Total: $x.xx", date near the top.
function parseHomeImprovement(vendor, body) {
  const totalMatch = body.match(/total:?\s*\$?([\d,]+\.\d{2})/i);
  const amount = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : biggestAmount(body);
  return { vendor, amount, purchaseDate: findDate(body) };
}

// Generic fallback: whatever looks like a currency total and a date. Weakest
// confidence — used whenever nothing more specific matched.
function parseGeneric(subject, body) {
  return { vendor: null, amount: biggestAmount(body) ?? biggestAmount(subject), purchaseDate: findDate(body) || findDate(subject) };
}

export function parseReceiptEmail({ subject = '', bodyText = '', senderEmail = '' } = {}) {
  const subj = subject || '';
  const body = bodyText || '';
  const sender = (senderEmail || '').toLowerCase();

  let result;
  let vendorKnown = false;
  if (sender.includes('amazon.com') || /amazon/i.test(subj)) {
    result = parseAmazon(subj, body);
    vendorKnown = true;
  } else if (sender.includes('homedepot.com') || /home depot/i.test(subj)) {
    result = parseHomeImprovement('Home Depot', body);
    vendorKnown = true;
  } else if (sender.includes('lowes.com') || /lowe'?s/i.test(subj)) {
    result = parseHomeImprovement("Lowe's", body);
    vendorKnown = true;
  } else {
    result = parseGeneric(subj, body);
  }

  const gotAmount = result.amount != null && !Number.isNaN(result.amount);
  const gotDate = !!result.purchaseDate;
  const gotVendor = vendorKnown || !!result.vendor;

  let confidence = 'none';
  if (gotAmount && gotDate && gotVendor) confidence = 'parsed';
  else if (gotAmount || gotDate || gotVendor) confidence = 'partial';

  return {
    vendor: result.vendor || null,
    amount: gotAmount ? result.amount : null,
    purchaseDate: result.purchaseDate || null,
    confidence,
  };
}
