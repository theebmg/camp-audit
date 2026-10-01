// Quo inbound webhook — message.received only (text-intake brief §3).
//
// THIS FILE IS THE ONLY QUO-SPECIFIC CODE IN THE SYSTEM. Everything downstream of it
// (createIncomingItem, the settings, the Incoming inbox, filing) is provider-agnostic: it
// deals in a sender, a receiving line, some text, a timestamp and some image URLs. Swapping
// Quo for another texting provider means writing a sibling of this file and changing nothing
// else.
//
// Deliberately kept out of here, for that reason:
//   - credentials            → environment variables (QUO_API_KEY, QUO_SIGNING_SECRET)
//   - which numbers matter   → text_intake_settings, editable in the UI
//   - what a message becomes → db.js's filing layer, which knows nothing about texting
//
// Quo is OpenPhone underneath: api.quo.com and api.openphone.com return byte-identical
// responses for the same key. The signature scheme below is OpenPhone's, confirmed against
// the real registered webhook rather than assumed.
import express from 'express';
import crypto from 'crypto';
import {
  createIncomingItem, isAllowedSender, countIgnoredSender, countWrongLine, noteDelivery,
  getTextIntakeSettings, normalizePhone, linkAttachment, createAttachment,
  noteIncomingMediaFailure,
} from '../db.js';
import { storeAttachment } from '../storage.js';

const router = express.Router();

const API_BASE = process.env.QUO_API_BASE || 'https://api.quo.com/v1';
// A delivery older than this is refused even with a valid signature, so a captured request
// cannot be replayed later.
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

// ── Signature ─────────────────────────────────────────────────────────────
// Quo sends one header carrying everything:
//
//   openphone-signature: hmac;1;<timestamp-ms>;<base64 signature>
//
// The signature is HMAC-SHA256 over "<timestamp>.<rawBody>", keyed with the signing secret
// BASE64-DECODED to its 32 raw bytes, and the result is base64 — not hex, and not the secret
// used as a literal string. My first version got all three wrong, which would have rejected
// every delivery while the secret was perfectly correct.
export function verifyQuoSignature({ rawBody, signatureHeader, secret, now = Date.now() }) {
  if (!secret) return { ok: false, why: 'QUO_SIGNING_SECRET is not set' };
  if (!signatureHeader) return { ok: false, why: 'no signature header' };

  const parts = String(signatureHeader).split(';');
  if (parts.length !== 4) return { ok: false, why: 'signature header is not the expected 4 fields' };
  const [scheme, version, timestamp, provided] = parts;
  if (scheme !== 'hmac') return { ok: false, why: `unexpected scheme ${scheme}` };
  if (version !== '1') return { ok: false, why: `unexpected signature version ${version}` };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, why: 'unparseable timestamp' };
  const age = Math.abs(now - ts);
  if (age > REPLAY_WINDOW_MS) return { ok: false, why: `timestamp ${Math.round(age / 1000)}s outside the replay window` };

  const keyBytes = Buffer.from(secret, 'base64');
  if (!keyBytes.length) return { ok: false, why: 'signing secret decoded to nothing' };

  const expected = crypto.createHmac('sha256', keyBytes)
    .update(`${timestamp}.`).update(rawBody).digest();

  const providedBytes = Buffer.from(provided, 'base64');
  if (providedBytes.length !== expected.length) return { ok: false, why: 'signature length mismatch' };
  if (!crypto.timingSafeEqual(providedBytes, expected)) return { ok: false, why: 'signature mismatch' };
  return { ok: true };
}

// The one place that knows Quo's payload shape. Returns the provider-neutral fields the rest
// of the system works in.
export function readQuoMessage(body) {
  const d = body?.data?.object || body?.data || body || {};
  // `to` is the line it arrived ON; `from` is who sent it. phoneNumberId names the workspace
  // line, which is the reliable identifier — a number can be formatted several ways.
  const toRaw = Array.isArray(d.to) ? d.to[0] : d.to;
  const media = d.media || d.attachments || [];
  return {
    from: d.from || d.participants?.[0] || null,
    to: toRaw || null,
    lineId: d.phoneNumberId || d.phone_number_id || null,
    direction: d.direction || null,
    text: typeof d.text === 'string' ? d.text : (d.body || ''),
    receivedAt: (d.createdAt || d.created_at) ? new Date(d.createdAt || d.created_at) : new Date(),
    mediaUrls: (Array.isArray(media) ? media : [media])
      .map((m) => (typeof m === 'string' ? m : m?.url))
      .filter(Boolean),
    externalId: body?.id || d.id || null,
  };
}

// Media URLs expire, so they are fetched now rather than stored as links (§3).
//
// Returns { ids, failures }. The failures matter: a photo that silently fails to attach looks
// exactly like a text that never had one, and that is how a check constraint on
// attachments.source hid every texted photo for a fortnight — fetched, resized, uploaded, then
// rejected at the final INSERT, with a console warning nobody reads. The caller now records
// the failure on the item itself.
async function ingestMedia(urls) {
  const ids = [];
  const failures = [];
  for (const url of urls.slice(0, 10)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { failures.push(`fetch returned ${res.status}`); continue; }
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      if (!/^image\//.test(contentType)) { failures.push(`not an image (${contentType})`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = contentType.split('/')[1]?.split(';')[0] || 'jpg';
      // Same pipeline and option shape as the email photo ingest, so a texted photo and an
      // emailed one are resized and stored identically.
      const meta = await storeAttachment(buf, {
        filename: `text-${Date.now()}-${ids.length}.${ext}`,
        mimetype: contentType,
        category: 'text',
        ownerId: `quo-${Date.now()}`,
      });
      const attachment = await createAttachment(meta, { source: 'text', uploadedBy: 'quo' });
      ids.push(attachment.Id);
    } catch (e) {
      failures.push(e.message);
    }
  }
  if (failures.length) console.error('[quo] MEDIA FAILED:', failures.join(' | '));
  return { ids, failures };
}

// The confirmation reply (§7). Best effort: a failed reply must never fail the delivery, or
// Quo retries a message that was already stored.
async function sendConfirmation(toNumber, settings) {
  try {
    if (!settings.SendConfirmation) return;
    if (!process.env.QUO_API_KEY) { console.warn('[quo] no API key, skipping confirmation'); return; }
    const from = settings.CampLineNumber || settings.ReplyFromNumber;
    if (!from) { console.warn('[quo] no camp line number set, skipping confirmation'); return; }
    const res = await fetch(`${API_BASE}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.QUO_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [toNumber], content: settings.ConfirmationText }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.warn(`[quo] confirmation reply failed: ${res.status}`);
  } catch (e) {
    console.warn('[quo] confirmation reply failed:', e.message);
  }
}

// req.rawBody is stashed by the global express.json() verify hook in server.js. Reading
// req.body here instead would compare the signature against a re-serialised object the sender
// never signed — key order and whitespace differ.
router.post('/', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody
    : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
  const signatureHeader = req.get('openphone-signature') || req.get('quo-signature') || req.get('x-quo-signature');
  const webhookId = req.get('webhook-id') || req.get('x-webhook-id');

  const verdict = verifyQuoSignature({ rawBody, signatureHeader, secret: process.env.QUO_SIGNING_SECRET });
  if (!verdict.ok) {
    // The caller is told nothing beyond 401; the reason goes to our log only.
    console.warn(`[quo] rejected delivery: ${verdict.why}`);
    return res.status(401).json({ ok: false });
  }

  let body;
  try {
    body = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body))
      ? req.body : JSON.parse(rawBody.toString('utf8'));
  } catch { console.warn('[quo] body was not JSON'); return res.status(400).json({ ok: false }); }

  const eventType = body?.type || body?.event || '';
  if (eventType && !/message\.received/i.test(eventType)) {
    // Subscribed to message.received only; acknowledge anything else so it is not retried.
    return res.json({ ok: true, ignored: `event ${eventType}` });
  }

  await noteDelivery();
  const msg = readQuoMessage(body);
  const settings = await getTextIntakeSettings();

  // An outbound message echoed back is not an intake event.
  if (msg.direction && msg.direction !== 'incoming') {
    return res.json({ ok: true, ignored: `direction ${msg.direction}` });
  }

  // ── Which line did this arrive on? ──────────────────────────────────────
  // The camp line and Ben's business line share a Quo workspace, and this API key can see
  // both. The webhook is scoped to the camp number, which is the first line of defence — but
  // a webhook can be re-scoped in the Quo app without this system knowing, so the receiving
  // line is checked here too. Fails closed: no camp line configured means nothing is
  // processed, the same rule the sender allowlist follows.
  if (!settings.CampLineId && !settings.CampLineNumber) {
    await countWrongLine();
    console.warn('[quo] no camp line configured — nothing is processed until one is set');
    return res.json({ ok: true, ignored: 'camp line not configured' });
  }
  const lineMatches = (settings.CampLineId && msg.lineId && settings.CampLineId === msg.lineId)
    || (settings.CampLineNumber && msg.to && normalizePhone(settings.CampLineNumber) === normalizePhone(msg.to));
  if (!lineMatches) {
    await countWrongLine();
    console.log('[quo] ignored a message addressed to another line in the workspace');
    return res.json({ ok: true, ignored: 'not the camp line' });
  }

  // ── Who sent it? ────────────────────────────────────────────────────────
  if (!await isAllowedSender(msg.from)) {
    await countIgnoredSender();
    console.log('[quo] ignored a message from a sender not on the allowlist');
    return res.json({ ok: true, ignored: 'sender not allowed' });
  }

  try {
    // Idempotency: a UNIQUE external_id means a retry finds the existing row. Media is only
    // fetched when the row is actually new, so a retry cannot duplicate attachments either.
    const result = await createIncomingItem({
      externalId: webhookId || msg.externalId || `quo:${msg.from}:${msg.receivedAt.toISOString()}`,
      fromNumber: normalizePhone(msg.from),
      toLine: msg.lineId || normalizePhone(msg.to),
      bodyText: msg.text,
      receivedAt: msg.receivedAt,
      source: 'text',
    });
    if (!result.Created) {
      console.log('[quo] duplicate delivery ignored');
      return res.json({ ok: true, duplicate: true, itemId: result.Item?.Id });
    }

    if (msg.mediaUrls.length) {
      const { ids, failures } = await ingestMedia(msg.mediaUrls);
      for (const id of ids) {
        await linkAttachment(id, { entityType: 'incoming_item', entityId: result.Item.Id });
      }
      // Written onto the item so the Incoming screen can say "2 photos didn't come through"
      // rather than showing a message that just looks empty.
      if (failures.length) {
        await noteIncomingMediaFailure(result.Item.Id, msg.mediaUrls.length, failures);
      }
    }

    // After storing, never before: a reply that claims "in Incoming" has to be true.
    await sendConfirmation(msg.from, settings);
    return res.json({ ok: true, itemId: result.Item.Id });
  } catch (e) {
    console.error('[quo] ingest failed:', e.message);
    // A 500 asks Quo to retry, which is right: nothing was stored, and idempotency makes the
    // retry safe.
    return res.status(500).json({ ok: false });
  }
});

export default router;
