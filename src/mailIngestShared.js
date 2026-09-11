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
// these public endpoints. 25MB matches the app-wide per-file ceiling; 25
// files matches Mailgun's own per-message attachment cap.
export const mailUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 25 } });

// Drops signature logos and tracking pixels — anything under ~200px on both
// edges. Void handles whatever slips through. Deliberately a SIZE check
// only — Mailgun's content-id-map marks a lot of real photos as "inline"
// too (iOS Mail and Gmail choose inline-vs-attached on their own, no user
// control), so inline status must never be used to drop a file. See
// extractInlineFieldNames below.
const MIN_IMAGE_EDGE = 200;
export const REPLAY_WINDOW_SECONDS = 5 * 60;

export async function isJunkImage(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    return (meta.width || 0) < MIN_IMAGE_EDGE && (meta.height || 0) < MIN_IMAGE_EDGE;
  } catch {
    return false; // undecodable isn't this filter's call to make — let it through, void handles it
  }
}

export function verifySignature(body) {
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
