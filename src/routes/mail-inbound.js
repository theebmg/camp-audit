// Mailgun inbound webhook — replaces the IMAP poller (Build Brief v2.1 Part
// 1). Mailgun receives mail at photos@cmms.fracturedrv.com (a dedicated
// subdomain with its own MX records — the root domain's Google Workspace
// mail is untouched), parses the MIME itself, and POSTs here with
// attachments already split out as multipart file fields. There is no MIME
// parsing left to do on our side — that's the entire point of the move away
// from IMAP+mailparser.
//
// Public route (mounted before the authenticated /api/pg catch-all in
// server.js, same pattern as request-portal.js) — Mailgun is the caller,
// there's no session. The signature check below is what stands in for auth.
import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import sharp from 'sharp';
import { findAttachmentBatchByMessageId, findWorkOrderIdByNumber, createMailInboundBatch } from '../db.js';
import { storeAttachment } from '../storage.js';

const router = express.Router();

// Mailgun's timestamp/token/signature fields arrive as regular multipart form
// fields alongside the attachment files, not as headers — there's no way to
// verify the signature before the body is parsed, so multer's own limits
// (not the signature check) are the first line of defense against abuse of
// this public endpoint. 25MB matches the app-wide per-file ceiling (§4.5);
// 25 files matches Mailgun's own per-message attachment cap.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 25 } });

// Subject shortcut (§5.2, unchanged from the IMAP implementation): "WO 1000"
// or "WO 1000-2" attaches straight to that work order and skips the inbox
// entirely — the touchless case of sending the after photo for the job
// you're standing in front of.
const WO_SUBJECT_RE = /\bWO\s*(\d+(?:-\d+)?)\b/i;

// Drops signature logos and tracking pixels — anything under ~200px on both
// edges. Void handles whatever slips through.
const MIN_IMAGE_EDGE = 200;
const REPLAY_WINDOW_SECONDS = 5 * 60;

async function isJunkImage(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    return (meta.width || 0) < MIN_IMAGE_EDGE && (meta.height || 0) < MIN_IMAGE_EDGE;
  } catch {
    return false; // undecodable isn't this filter's call to make — let it through, void handles it
  }
}

function verifySignature(body) {
  const { timestamp, token, signature } = body;
  if (!timestamp || !token || !signature) return false;
  const key = process.env.MAILGUN_SIGNING_KEY;
  if (!key) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > REPLAY_WINDOW_SECONDS) return false; // replay guard
  const expected = crypto.createHmac('sha256', key).update(timestamp + token).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Mailgun's parsed-message payload doesn't always carry a dedicated
// "Message-Id" field — fall back to message-headers (a JSON array of
// [name, value] pairs) so a mail server that only puts it in the raw
// headers still gets a usable dedupe key. Without one we can't dedupe at
// all, so a message with neither is dropped (see below), same call the old
// IMAP ingest made.
function extractHeader(body, name) {
  if (body[name]) return body[name];
  try {
    const headers = JSON.parse(body['message-headers'] || '[]');
    const hit = headers.find(([k]) => k?.toLowerCase() === name.toLowerCase());
    return hit?.[1] || null;
  } catch {
    return null;
  }
}

function extractEmailAddress(raw) {
  if (!raw) return null;
  const match = raw.match(/[^\s<@]+@[^\s>]+/);
  return match ? match[0] : raw;
}

router.post('/', upload.any(), async (req, res) => {
  try {
    if (!verifySignature(req.body || {})) {
      return res.status(401).json({ ok: false, error: 'Invalid or stale signature' });
    }

    const inboundDomain = process.env.MAIL_INBOUND_DOMAIN;
    const recipient = req.body.recipient || '';
    if (inboundDomain && recipient && !recipient.toLowerCase().endsWith(`@${inboundDomain.toLowerCase()}`)) {
      return res.status(400).json({ ok: false, error: 'Recipient does not match configured inbound domain' });
    }

    const messageId = extractHeader(req.body, 'Message-Id');
    if (!messageId) return res.json({ ok: true }); // can't dedupe without one — drop rather than risk reprocessing forever, same as the IMAP version

    // Idempotency: Mailgun retries any non-2xx, so seeing the same
    // Message-Id again is normal operation. Check BEFORE doing any storage
    // upload, so a retry of an already-ingested message never re-uploads
    // attachments — only the final DB write (createMailInboundBatch) is the
    // authoritative guard (ON CONFLICT), this is just to skip redundant work.
    if (await findAttachmentBatchByMessageId(messageId)) {
      return res.json({ ok: true });
    }

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
    // tracking pixels referenced by cid: in an HTML body) by the attachment
    // field name Mailgun gave them — same role mailparser's
    // contentDisposition/related check played against raw MIME.
    let inlineFieldNames = new Set();
    try {
      const cidMap = JSON.parse(req.body['content-id-map'] || '{}');
      inlineFieldNames = new Set(Object.values(cidMap));
    } catch { /* absent or malformed — treat nothing as inline */ }

    const realFiles = (req.files || [])
      .filter((f) => /^attachment-\d+$/.test(f.fieldname) && !inlineFieldNames.has(f.fieldname));

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
    if (batchId === null) return res.json({ ok: true }); // raced with another retry — already created, nothing to do

    res.json({ ok: true, batchId, attachmentCount: uploaded.length });
  } catch (e) {
    // 5xx so Mailgun retries — a storage failure or transient DB error here
    // must not silently drop the message.
    console.error('mail-inbound: ingest failed:', e.message);
    res.status(502).json({ ok: false, error: 'Ingest failed' });
  }
});

export default router;
