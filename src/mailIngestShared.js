// Shared plumbing for every Mailgun inbound webhook route (mail-inbound.js,
// receipt-inbound.js) — signature verification, multipart upload config, and
// the header/address/junk-image helpers every route needs identically.
// Build Brief v3 Part 2: factored out of mail-inbound.js so two routes never
// drift on the security-critical bits (signature check, replay window).
import multer from 'multer';
import crypto from 'crypto';
import sharp from 'sharp';

// Mailgun's timestamp/token/signature fields arrive as regular multipart form
// fields alongside the attachment files, not as headers — there's no way to
// verify the signature before the body is parsed, so multer's own limits
// (not the signature check) are the first line of defense against abuse of
// these public endpoints. fileSize/files match Mailgun's own per-message
// caps (25MB total, 25 attachments).
//
// fieldSize is set explicitly because busboy's default is 1MB *per non-file
// form field* — a real forwarded email's body-html (or message-headers, for
// a long thread) can land anywhere up to the low single-digit MB range even
// when the message as a whole is nowhere near Mailgun's 25MB cap, and a
// truncated field just silently drops data rather than erroring (see
// busboy's multipart parser — it sets valueTruncated and keeps going, no
// exception). 25MB comfortably clears Mailgun's own ceiling for any single
// field. Found while investigating a 401 on a forwarded receipt — see
// logInboundHit/verifySignatureDetailed below for how a future occurrence
// gets diagnosed instead of vanishing.
export const mailUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 25, fieldSize: 25 * 1024 * 1024 },
});

// Drops signature logos and tracking pixels — anything under ~200px on both
// edges. Void handles whatever slips through. Deliberately a SIZE check
// only — Mailgun's content-id-map marks a lot of real photos as "inline"
// too (iOS Mail and Gmail choose inline-vs-attached on their own, no user
// control), so inline status must never be used to drop a file. See
// extractInlineFieldNames below.
const MIN_IMAGE_EDGE = 200;
// Mailgun signs a message once at first-send time and reuses that same
// timestamp/token/signature on retries — it does not re-sign per attempt.
// Its retry schedule runs out to several hours, so a narrow window (this was
// 5 minutes) makes every retry past the first one fail permanently on a
// stale timestamp, silently, with no way to recover except a fresh send.
// Message-Id + the attachment_batches UNIQUE constraint is what actually
// prevents duplicate processing (see createMailInboundBatch/
// createReceiptInboundBatch's ON CONFLICT), not this window — so widening
// it costs nothing. 24h comfortably covers Mailgun's documented retry
// schedule with room to spare.
export const REPLAY_WINDOW_SECONDS = 24 * 60 * 60;

export async function isJunkImage(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    return (meta.width || 0) < MIN_IMAGE_EDGE && (meta.height || 0) < MIN_IMAGE_EDGE;
  } catch {
    return false; // undecodable isn't this filter's call to make — let it through, void handles it
  }
}

// Every branch below returns its own `reason` — a 401 investigated three
// rounds deep on one opaque "Invalid or stale signature" before this
// existed. Callers log `reason` server-side (see logInboundHit's sibling
// call in each route) and still return the same generic message to Mailgun;
// the detail is for our logs, not the response body.
export function verifySignatureDetailed(body) {
  const { timestamp, token, signature } = body || {};
  const key = process.env.MAILGUN_SIGNING_KEY;
  if (!key) return { ok: false, reason: 'MAILGUN_SIGNING_KEY is not configured' };
  const missing = ['timestamp', 'token', 'signature'].filter((f) => !body?.[f]);
  if (missing.length) return { ok: false, reason: `missing field(s): ${missing.join(', ')}` };
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age)) return { ok: false, reason: `timestamp is not a valid number: "${timestamp}"` };
  if (age > REPLAY_WINDOW_SECONDS) return { ok: false, reason: `stale timestamp — age ${Math.round(age)}s exceeds ${REPLAY_WINDOW_SECONDS}s window` };
  const expected = crypto.createHmac('sha256', key).update(timestamp + token).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok: match, reason: match ? 'ok' : 'HMAC mismatch' };
}
export function verifySignature(body) { return verifySignatureDetailed(body).ok; }

// Logged at the very top of every route, before the signature check — a
// pre-verification failure was previously invisible end to end (nothing in
// our logs, nothing to compare against Mailgun's own delivery log). Field
// PRESENCE only, never values — timestamp/token/signature aren't secret
// (HMAC output and a nonce, not the key), but there's no reason to echo
// arbitrary email content into logs either. `fieldKeys` is the full list of
// what multer actually parsed out of the body — the fastest way to spot a
// payload shape that doesn't match what the rest of the route expects.
export function logInboundHit(routeLabel, req) {
  const b = req.body || {};
  console.log(
    `${routeLabel}: inbound POST — recipient="${b.recipient || ''}" ` +
    `content-length=${req.headers['content-length'] || '?'} ` +
    `hasTimestamp=${!!b.timestamp} hasToken=${!!b.token} hasSignature=${!!b.signature} ` +
    `fieldKeys=[${Object.keys(b).join(',')}] fileFields=[${(req.files || []).map((f) => f.fieldname).join(',')}]`
  );
}

// Mailgun's parsed-message payload doesn't always carry a dedicated
// "Message-Id" field — fall back to message-headers (a JSON array of
// [name, value] pairs) so a mail server that only puts it in the raw
// headers still gets a usable dedupe key. Without one we can't dedupe at
// all, so a message with neither is dropped by the caller, same call the
// old IMAP ingest made.
export function extractHeader(body, name) {
  if (body[name]) return body[name];
  try {
    const headers = JSON.parse(body['message-headers'] || '[]');
    const hit = headers.find(([k]) => k?.toLowerCase() === name.toLowerCase());
    return hit?.[1] || null;
  } catch {
    return null;
  }
}

export function extractEmailAddress(raw) {
  if (!raw) return null;
  const match = raw.match(/[^\s<@]+@[^\s>]+/);
  return match ? match[0] : raw;
}

// content-id-map identifies inline/embedded parts (signature logos, tracking
// pixels, but ALSO a real photo — see isJunkImage's comment above). Tracked
// for logging only, never used to drop a file.
export function extractInlineFieldNames(body) {
  try {
    const cidMap = JSON.parse(body['content-id-map'] || '{}');
    return new Set(Object.values(cidMap));
  } catch {
    return new Set(); // absent or malformed — treat nothing as inline
  }
}
