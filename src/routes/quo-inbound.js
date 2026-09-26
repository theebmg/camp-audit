// Quo inbound webhook — message.received only (text-intake brief §3).
//
// Deliberately shaped like mail-dispatch.js, which has been doing this job for email: verify
// the signature against the RAW body, check idempotency once, then hand off. The differences
// are that Quo signs with an HMAC over a timestamped payload rather than Mailgun's token
// scheme, and that a text has no Message-Id — so idempotency keys on the `webhook-id` header,
// held by a UNIQUE column rather than by this file remembering to look.
//
// Secrets: QUO_SIGNING_SECRET and QUO_API_KEY are environment variables. They are never
// written to the database, never logged, and never returned by any route.
import express from 'express';
import crypto from 'crypto';
import {
  createIncomingItem, isAllowedSender, countIgnoredSender, noteDelivery,
  getTextIntakeSettings, normalizePhone,
} from '../db.js';
import { storeAttachment } from '../storage.js';
import { createAttachment } from '../db.js';

const router = express.Router();

// A delivery older than this is refused even with a good signature, so a captured request
// cannot be replayed later. Same window the mail ingest uses.
const REPLAY_WINDOW_SECONDS = 5 * 60;

// Verify against the raw bytes. Parsing first and re-serialising would compare a signature to
// something the sender never signed — key ordering and whitespace would differ.
export function verifyQuoSignature({ rawBody, signature, timestamp, secret }) {
  if (!secret) return { ok: false, why: 'QUO_SIGNING_SECRET is not set' };
  if (!signature) return { ok: false, why: 'no signature header' };
  if (!timestamp) return { ok: false, why: 'no timestamp header' };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age)) return { ok: false, why: 'unparseable timestamp' };
  if (age > REPLAY_WINDOW_SECONDS) return { ok: false, why: `timestamp ${age}s outside the replay window` };

  const expected = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.`).update(rawBody).digest('hex');

  // Providers send this variously as hex, as "sha256=hex", or as several space-separated
  // candidates during a key rotation. Accept any that matches, in constant time.
  const candidates = String(signature).split(/[\s,]+/).map((s) => s.replace(/^sha256=/i, '').trim()).filter(Boolean);
  const expectedBuf = Buffer.from(expected, 'hex');
  for (const cand of candidates) {
    let candBuf;
    try { candBuf = Buffer.from(cand, 'hex'); } catch { continue; }
    if (candBuf.length === expectedBuf.length && crypto.timingSafeEqual(candBuf, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, why: 'signature mismatch' };
}

// Quo's shapes vary by API version; read defensively rather than assuming one.
function readMessage(body) {
  const d = body?.data || body?.message || body || {};
  const from = d.from || d.sender || d.from_number || d.fromNumber
    || (typeof d.participant === 'string' ? d.participant : d.participant?.number) || null;
  const text = d.text ?? d.body ?? d.message ?? d.content ?? '';
  const at = d.created_at || d.createdAt || d.timestamp || d.sent_at || body?.created_at || null;
  const media = d.media || d.attachments || d.media_urls || d.mediaUrls || [];
  const mediaUrls = (Array.isArray(media) ? media : [media])
    .map((m) => (typeof m === 'string' ? m : m?.url || m?.uri || m?.href))
    .filter(Boolean);
  return {
    from,
    text: typeof text === 'string' ? text : String(text ?? ''),
    receivedAt: at ? new Date(at) : new Date(),
    mediaUrls,
  };
}

// Media URLs expire, so they are fetched now rather than stored as links (§3).
async function ingestMedia(urls) {
  const ids = [];
  for (const url of urls.slice(0, 10)) {
    try {
      const res = await fetch(url, { headers: process.env.QUO_API_KEY ? { Authorization: `Bearer ${process.env.QUO_API_KEY}` } : {} });
      if (!res.ok) { console.warn(`[quo] media fetch ${res.status} for one attachment`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      if (!/^image\//.test(contentType)) { console.warn(`[quo] skipping non-image ${contentType}`); continue; }
      const ext = contentType.split('/')[1]?.split(';')[0] || 'jpg';
      // Same pipeline and the same option shape as the email photo ingest, so resizing and
      // storage behave identically for a texted photo and an emailed one.
      const meta = await storeAttachment(buf, {
        filename: `text-${Date.now()}-${ids.length}.${ext}`,
        mimetype: contentType,
        category: 'text',
        ownerId: `quo-${Date.now()}`,
      });
      const attachment = await createAttachment(meta, { source: 'text', uploadedBy: 'quo' });
      ids.push(attachment.Id);
    } catch (e) {
      console.warn('[quo] media fetch failed:', e.message);
    }
  }
  return ids;
}

// The confirmation reply (§7). Best effort: a failed reply must never fail the delivery, or
// Quo retries a message that was already stored.
async function sendConfirmation(toNumber) {
  try {
    const s = await getTextIntakeSettings();
    if (!s.SendConfirmation) return;
    if (!process.env.QUO_API_KEY) { console.warn('[quo] no API key, skipping confirmation'); return; }
    const from = s.ReplyFromNumber;
    if (!from) { console.warn('[quo] no reply-from number set, skipping confirmation'); return; }
    const res = await fetch('https://api.quo.com/v1/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.QUO_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: toNumber, text: s.ConfirmationText }),
    });
    if (!res.ok) console.warn(`[quo] confirmation reply failed: ${res.status}`);
  } catch (e) {
    console.warn('[quo] confirmation reply failed:', e.message);
  }
}

// req.rawBody is stashed by the global express.json() verify hook in server.js. Using
// express.raw() here would be too late — the JSON parser has already consumed the stream, and
// req.body would be a parsed object, so every signature check would fail.
router.post('/', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody
    : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
  const signature = req.get('quo-signature') || req.get('x-quo-signature') || req.get('webhook-signature');
  const timestamp = req.get('quo-timestamp') || req.get('x-quo-timestamp') || req.get('webhook-timestamp');
  const webhookId = req.get('webhook-id') || req.get('quo-webhook-id') || req.get('x-quo-webhook-id');

  const verdict = verifyQuoSignature({ rawBody, signature, timestamp, secret: process.env.QUO_SIGNING_SECRET });
  if (!verdict.ok) {
    // Never say which check failed to the caller; an attacker learns nothing from a 401.
    console.warn(`[quo] rejected delivery: ${verdict.why}`);
    return res.status(401).json({ ok: false });
  }

  let body;
  try { body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(rawBody.toString('utf8')); }
  catch { console.warn('[quo] body was not JSON'); return res.status(400).json({ ok: false }); }

  const eventType = body?.type || body?.event || body?.event_type || '';
  if (eventType && !/message[._]received/i.test(eventType)) {
    // Subscribed to message.received only, but acknowledge anything else so it is not retried.
    return res.json({ ok: true, ignored: `event ${eventType}` });
  }

  await noteDelivery();
  const msg = readMessage(body);

  // Sender allowlist (§3). Anything else is counted and dropped — no content is stored, and
  // the message keeps working normally in Quo because this system simply did nothing with it.
  if (!await isAllowedSender(msg.from)) {
    await countIgnoredSender();
    console.log(`[quo] ignored a message from a sender not on the allowlist`);
    return res.json({ ok: true, ignored: 'sender not allowed' });
  }

  try {
    // Idempotency: the UNIQUE external_id means a retry finds the existing row. Media is only
    // fetched when the row is actually new, so a retry cannot duplicate attachments either.
    const existing = await createIncomingItem({
      externalId: webhookId || `quo:${msg.from}:${msg.receivedAt.toISOString()}`,
      fromNumber: normalizePhone(msg.from),
      bodyText: msg.text,
      receivedAt: msg.receivedAt,
      source: 'text',
    });
    if (!existing.Created) {
      console.log('[quo] duplicate delivery ignored');
      return res.json({ ok: true, duplicate: true, itemId: existing.Item?.Id });
    }

    if (msg.mediaUrls.length) {
      const ids = await ingestMedia(msg.mediaUrls);
      const { linkAttachment } = await import('../db.js');
      for (const id of ids) {
        await linkAttachment(id, { entityType: 'incoming_item', entityId: existing.Item.Id });
      }
    }

    // After storing, never before: a reply that claims "in Incoming" has to be true.
    await sendConfirmation(msg.from);
    return res.json({ ok: true, itemId: existing.Item.Id });
  } catch (e) {
    console.error('[quo] ingest failed:', e.message);
    // A 500 asks Quo to retry, which is right: the message is not stored and idempotency
    // makes the retry safe.
    return res.status(500).json({ ok: false });
  }
});

export default router;
