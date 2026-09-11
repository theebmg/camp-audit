// Mailgun inbound webhook — replaces the IMAP poller (Build Brief v2.1 Part
// 1). Mailgun receives mail at photos@cmms.fracturedrv.com (a dedicated
// subdomain with its own MX records — the root domain's Google Workspace
// mail is untouched), parses the MIME itself, and POSTs here with
// attachments already split out as multipart file fields. There is no MIME
// parsing left to do on our side — that's the entire point of the move away
// from IMAP+mailparser.
//
// Build Brief v3 (Mailgun free-tier consolidation): Mailgun's free plan
// allows only one inbound route, so both photos@ and receipts@ now arrive
// through mail-dispatch.js, which verifies the signature and checks
// idempotency ONCE and then calls ingestPhotoMail directly (exported below)
// — no second HTTP round trip. This file's own POST / route stays wired up
// and fully functional (signature + idempotency of its own) so nothing
// breaks mid-cutover or if a route ever points here directly again; it just
// delegates the actual processing to the same exported function.
import express from 'express';
import { findAttachmentBatchByMessageId, findWorkOrderIdByNumber, createMailInboundBatch } from '../db.js';
import { storeAttachment } from '../storage.js';
import {
  mailParsers, isJunkImage, verifySignatureDetailed, extractHeader, extractEmailAddress, extractInlineFieldNames, logInboundHit,
} from '../mailIngestShared.js';

const router = express.Router();

// Subject shortcut (§5.2, unchanged from the IMAP implementation): "WO 1000"
// or "WO 1000-2" attaches straight to that work order and skips the inbox
// entirely — the touchless case of sending the after photo for the job
// you're standing in front of.
const WO_SUBJECT_RE = /\bWO\s*(\d+(?:-\d+)?)\b/i;

// The actual ingest — everything after signature verification and the
// Message-Id idempotency check, both of which the caller (this file's own
// route, or mail-dispatch.js) has already done before calling this.
// Returns the response payload; never sends a response itself, so it's
// equally callable from a direct route or a dispatcher.
export async function ingestPhotoMail(req, messageId) {
  const subject = req.body.subject || '(no subject)';
  const bodyText = req.body['body-plain'] || null;
  const senderEmail = extractEmailAddress(req.body.sender || req.body.from);
  const receivedAt = req.body.timestamp ? new Date(Number(req.body.timestamp) * 1000) : new Date();
  const spfResult = req.body['X-Mailgun-Spf'] || extractHeader(req.body, 'X-Mailgun-Spf');
  const dkimResult = req.body['X-Mailgun-Dkim-Check-Result'] || extractHeader(req.body, 'X-Mailgun-Dkim-Check-Result');

  let targetWorkOrderId = null;
  const woMatch = subject.match(WO_SUBJECT_RE);
  if (woMatch) targetWorkOrderId = await findWorkOrderIdByNumber(woMatch[1]);

  // content-id-map identifies inline/embedded parts (signature logos,
  // tracking pixels, but ALSO a real photo — iOS Mail and the Gmail app
  // both choose inline-vs-attached on their own with no user control, per
  // Ben: "coming from an iPhone, it doesn't give me great control over
  // what method it chooses"). So inline is tracked for the log line below
  // only, never used to drop a file — isJunkImage's size check is what
  // actually separates a tracking pixel/signature logo (near-universally
  // under 200px) from a real photo (near-universally far larger), inline
  // or not.
  const inlineFieldNames = extractInlineFieldNames(req.body);

  const realFiles = (req.files || [])
    .filter((f) => /^attachment-\d+$/.test(f.fieldname));

  const uploaded = [];
  let junkFiltered = 0;
  for (const f of realFiles) {
    if (f.mimetype?.startsWith('image/') && await isJunkImage(f.buffer)) { junkFiltered++; continue; }
    const meta = await storeAttachment(f.buffer, {
      filename: f.originalname || 'attachment', mimetype: f.mimetype, category: 'email', ownerId: `msg-${messageId.replace(/[^a-zA-Z0-9]/g, '')}`,
    });
    uploaded.push(meta);
  }

  // Success-path visibility — this route otherwise only logs on throw, so
  // a batch that lands with zero attachments (every file filtered as
  // inline/junk, or Mailgun sending no files field at all) is silent and
  // indistinguishable from "no photos were sent" without this.
  console.log(
    `mail-inbound: message ${messageId} — files=${(req.files || []).length} ` +
    `fieldnames=[${(req.files || []).map((f) => f.fieldname).join(',')}] ` +
    `inlineFieldnames=[${[...inlineFieldNames].join(',')}] ` +
    `realFiles=${realFiles.length} junkFiltered=${junkFiltered} uploaded=${uploaded.length}`
  );

  // Batch row is written last, together with the attachment rows, in one
  // transaction — see createMailInboundBatch's comment for why. If
  // anything above this point throws, no batch row exists yet and
  // Mailgun's retry starts clean instead of being blocked by the UNIQUE
  // constraint on a half-ingested batch.
  const batchId = await createMailInboundBatch({
    subject, bodyText, senderEmail, messageId, receivedAt, spfResult, dkimResult,
    attachments: uploaded, targetWorkOrderId,
  });
  if (batchId === null) return { ok: true }; // raced with another retry — already created, nothing to do

  return { ok: true, batchId, attachmentCount: uploaded.length };
}

router.post('/', mailParsers, async (req, res) => {
  try {
    logInboundHit('mail-inbound', req);
    const sig = verifySignatureDetailed(req.body || {});
    if (!sig.ok) {
      console.log(`mail-inbound: signature rejected — ${sig.reason}`);
      return res.status(401).json({ ok: false, error: 'Invalid or stale signature' });
    }

    const inboundDomain = process.env.MAIL_INBOUND_DOMAIN;
    const recipient = req.body.recipient || '';
    if (inboundDomain && recipient && !recipient.toLowerCase().endsWith(`@${inboundDomain.toLowerCase()}`)) {
      return res.status(400).json({ ok: false, error: 'Recipient does not match configured inbound domain' });
    }

    const messageId = extractHeader(req.body, 'Message-Id');
    if (!messageId) {
      console.log('mail-inbound: no extractable Message-Id — 200, not processed (can\'t dedupe without one)');
      return res.json({ ok: true }); // drop rather than risk reprocessing forever, same as the IMAP version
    }

    // Idempotency: Mailgun retries any non-2xx, so seeing the same
    // Message-Id again is normal operation. Check BEFORE doing any storage
    // upload, so a retry of an already-ingested message never re-uploads
    // attachments — only the final DB write (createMailInboundBatch) is the
    // authoritative guard (ON CONFLICT), this is just to skip redundant work.
    if (await findAttachmentBatchByMessageId(messageId)) {
      return res.json({ ok: true });
    }

    const result = await ingestPhotoMail(req, messageId);
    res.json(result);
  } catch (e) {
    // 5xx so Mailgun retries — a storage failure or transient DB error here
    // must not silently drop the message.
    console.error('mail-inbound: ingest failed:', e.message);
    res.status(502).json({ ok: false, error: 'Ingest failed' });
  }
});

export default router;
