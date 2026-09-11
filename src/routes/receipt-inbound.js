// Mailgun inbound webhook for receipts — Build Brief v3 Part 2. Mirrors
// mail-inbound.js exactly for the security-critical bits (signature check,
// replay window, idempotency guard on Message-Id) via mailIngestShared.js;
// what differs is what gets created from an inbound message — an `expenses`
// inbox row (pre-filled by expenseParsing.js) instead of a batch of unlinked
// attachments.
//
// Build Brief v3 (Mailgun free-tier consolidation): Mailgun's free plan
// allows only one inbound route, so both photos@ and receipts@ now arrive
// through mail-dispatch.js, which verifies the signature and checks
// idempotency ONCE and then calls ingestReceiptMail directly (exported
// below) — no second HTTP round trip. This file's own POST / route stays
// wired up and fully functional (signature + idempotency of its own) so
// nothing breaks mid-cutover or if a route ever points here directly again;
// it just delegates the actual processing to the same exported function.
//
// Do NOT filter inline-marked attachments here (see mailIngestShared.js's
// isJunkImage comment) — receipts are, if anything, MORE likely than photos
// to arrive inline (iOS Mail/Gmail choose this on their own), and PDFs
// (non-image, no resize) are a common shape for emailed receipts.
import express from 'express';
import { findAttachmentBatchByMessageId, createReceiptInboundBatch } from '../db.js';
import { storeAttachment } from '../storage.js';
import { parseReceiptEmail } from '../expenseParsing.js';
import {
  mailUpload, isJunkImage, verifySignatureDetailed, extractHeader, extractEmailAddress, extractInlineFieldNames, logInboundHit,
} from '../mailIngestShared.js';

const router = express.Router();

// The actual ingest — everything after signature verification and the
// Message-Id idempotency check, both of which the caller (this file's own
// route, or mail-dispatch.js) has already done before calling this.
// Returns the response payload; never sends a response itself.
export async function ingestReceiptMail(req, messageId) {
  const subject = req.body.subject || '(no subject)';
  const bodyText = req.body['body-plain'] || null;
  const senderEmail = extractEmailAddress(req.body.sender || req.body.from);
  const receivedAt = req.body.timestamp ? new Date(Number(req.body.timestamp) * 1000) : new Date();
  const spfResult = req.body['X-Mailgun-Spf'] || extractHeader(req.body, 'X-Mailgun-Spf');
  const dkimResult = req.body['X-Mailgun-Dkim-Check-Result'] || extractHeader(req.body, 'X-Mailgun-Dkim-Check-Result');

  const parsed = parseReceiptEmail({ subject, bodyText, senderEmail });

  const inlineFieldNames = extractInlineFieldNames(req.body);
  const realFiles = (req.files || []).filter((f) => /^attachment-\d+$/.test(f.fieldname));

  const uploaded = [];
  let junkFiltered = 0;
  for (const f of realFiles) {
    if (f.mimetype?.startsWith('image/') && await isJunkImage(f.buffer)) { junkFiltered++; continue; }
    const meta = await storeAttachment(f.buffer, {
      filename: f.originalname || 'receipt', mimetype: f.mimetype, category: 'receipt', ownerId: `msg-${messageId.replace(/[^a-zA-Z0-9]/g, '')}`,
    });
    uploaded.push(meta);
  }

  // Success-path visibility — see mail-inbound.js's identical comment. A
  // receipt with zero attachments (a pure forwarded confirmation email) is
  // routine, not a failure, but should still be visible in the logs.
  console.log(
    `receipt-inbound: message ${messageId} — files=${(req.files || []).length} ` +
    `fieldnames=[${(req.files || []).map((f) => f.fieldname).join(',')}] ` +
    `inlineFieldnames=[${[...inlineFieldNames].join(',')}] ` +
    `realFiles=${realFiles.length} junkFiltered=${junkFiltered} uploaded=${uploaded.length} ` +
    `parsed=${JSON.stringify(parsed)}`
  );

  const result = await createReceiptInboundBatch({
    subject, bodyText, senderEmail, messageId, receivedAt, spfResult, dkimResult, attachments: uploaded, parsed,
  });
  if (result === null) return { ok: true }; // raced with another retry — already created, nothing to do

  return { ok: true, ...result, attachmentCount: uploaded.length };
}

router.post('/', mailUpload.any(), async (req, res) => {
  try {
    logInboundHit('receipt-inbound', req);
    const sig = verifySignatureDetailed(req.body || {});
    if (!sig.ok) {
      console.log(`receipt-inbound: signature rejected — ${sig.reason}`);
      return res.status(401).json({ ok: false, error: 'Invalid or stale signature' });
    }

    const inboundDomain = process.env.MAIL_INBOUND_DOMAIN;
    const recipient = req.body.recipient || '';
    if (inboundDomain && recipient && !recipient.toLowerCase().endsWith(`@${inboundDomain.toLowerCase()}`)) {
      return res.status(400).json({ ok: false, error: 'Recipient does not match configured inbound domain' });
    }

    const messageId = extractHeader(req.body, 'Message-Id');
    if (!messageId) {
      console.log('receipt-inbound: no extractable Message-Id — 200, not processed (can\'t dedupe without one)');
      return res.json({ ok: true }); // drop rather than risk reprocessing forever
    }

    // Idempotency: Mailgun retries any non-2xx, so seeing the same
    // Message-Id again is normal operation. Check BEFORE doing any storage
    // upload — only the final DB write (createReceiptInboundBatch) is the
    // authoritative guard (ON CONFLICT), this just skips redundant work.
    if (await findAttachmentBatchByMessageId(messageId)) {
      return res.json({ ok: true });
    }

    const result = await ingestReceiptMail(req, messageId);
    res.json(result);
  } catch (e) {
    // 5xx so Mailgun retries — a storage failure or transient DB error here
    // must not silently drop the message.
    console.error('receipt-inbound: ingest failed:', e.message);
    res.status(502).json({ ok: false, error: 'Ingest failed' });
  }
});

export default router;
