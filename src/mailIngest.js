// Inbound email ingest — the cmms@... mailbox feeding the triage inbox
// (Build Brief v2 Phase 5). Isolated from mailer.js (outbound only) the same
// way storage.js is isolated for S3 — this is the only module that knows
// IMAP. Polled on an interval from server.js. Every exported function is
// safe to call unconfigured (no-ops) or when the mailbox is unreachable
// (logs and returns — a bad poll must never crash the app).
//
// NOT YET EXERCISED AGAINST A LIVE MAILBOX — there were no IMAP_* credentials
// available to test with in this session. Written carefully against
// imapflow's documented API and defensive at every step, but verify the
// first real poll once IMAP_HOST/IMAP_USER/IMAP_PASSWORD are set (see
// update-for-claude.md's Phase 5 runbook).
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import sharp from 'sharp';
import { pool, linkAttachment } from './db.js';
import { storeAttachment } from './storage.js';

export function imapIsConfigured() {
  return Boolean(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD);
}

// Subject shortcut (§5.2): "WO 1000" or "WO 1000-2" attaches straight to
// that work order and skips the inbox entirely — the touchless case of
// sending the after photo for the job you're standing in front of.
const WO_SUBJECT_RE = /\bWO\s*(\d+(?:-\d+)?)\b/i;

// Drops signature logos and tracking pixels — anything under ~200px on both
// edges. Void handles whatever slips through.
const MIN_IMAGE_EDGE = 200;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // matches the app-wide ceiling (§4.5) — most mail servers reject above this anyway

async function isJunkImage(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    return (meta.width || 0) < MIN_IMAGE_EDGE && (meta.height || 0) < MIN_IMAGE_EDGE;
  } catch {
    return false; // undecodable isn't this filter's call to make — let it through, void handles it
  }
}

async function ingestOneMessage(rawSource) {
  const parsed = await simpleParser(rawSource);
  const messageId = parsed.messageId || null;
  if (!messageId) return; // can't dedupe without one — extremely rare, drop rather than risk reprocessing forever
  const subject = parsed.subject || '(no subject)';
  const senderEmail = parsed.from?.value?.[0]?.address || null;
  const bodyText = parsed.text || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // message_id UNIQUE is the double-processing guard (§5.2) — a poll that
    // sees the same message twice (network hiccup, IMAP server quirk) is a
    // silent no-op here, not a duplicate batch.
    const { rows } = await client.query(
      `INSERT INTO attachment_batches (source, subject, body_text, sender_email, message_id, received_at)
       VALUES ('email',$1,$2,$3,$4,$5) ON CONFLICT (message_id) DO NOTHING RETURNING id`,
      [subject, bodyText, senderEmail, messageId, parsed.date || new Date()]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return; }
    const batchId = rows[0].id;

    let targetWorkOrderId = null;
    const woMatch = subject.match(WO_SUBJECT_RE);
    if (woMatch) {
      const woRes = await client.query('SELECT id FROM work_orders WHERE wo_number = $1', [woMatch[1]]);
      targetWorkOrderId = woRes.rows[0]?.id || null;
    }

    // Real attachments only — inline/related parts (contentDisposition
    // 'inline', or referenced by a cid) are signature logos and the like,
    // not photos someone meant to send.
    const realAttachments = (parsed.attachments || []).filter((a) => a.contentDisposition !== 'inline' && !a.related);
    for (const a of realAttachments) {
      if (!a.content || a.content.length > MAX_ATTACHMENT_BYTES) continue;
      if (a.contentType?.startsWith('image/') && await isJunkImage(a.content)) continue;

      const meta = await storeAttachment(a.content, {
        filename: a.filename || 'attachment', mimetype: a.contentType, category: 'email', ownerId: `batch-${batchId}`,
      });
      const insertRes = await client.query(
        `INSERT INTO attachments (url, thumb_url, kind, mime_type, file_size, original_filename, width, height, taken_at, gps_lat, gps_lng, source, batch_id, triage_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'email',$12,$13) RETURNING id`,
        [meta.url, meta.thumbUrl, meta.kind, meta.mimeType, meta.fileSize, meta.originalFilename, meta.width, meta.height,
          meta.takenAt, meta.gpsLat, meta.gpsLng, batchId, targetWorkOrderId ? 'triaged' : 'inbox']
      );
      if (targetWorkOrderId) {
        await linkAttachment(insertRes.rows[0].id, { entityType: 'work_order', entityId: targetWorkOrderId }, client);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('mailIngest: failed to ingest a message:', e.message);
  } finally {
    client.release();
  }
}

let polling = false;
// Called on an interval from server.js. Open relay by design (§5.2, settled
// — no sender whitelist yet, structured so one is a single check to add to
// ingestOneMessage later).
export async function pollInbox() {
  if (!imapIsConfigured() || polling) return;
  polling = true;
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(process.env.IMAP_MAILBOX || 'INBOX');
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      for (const uid of uids || []) {
        try {
          const msg = await client.download(uid, undefined, { uid: true });
          const chunks = [];
          for await (const chunk of msg.content) chunks.push(chunk);
          await ingestOneMessage(Buffer.concat(chunks));
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } catch (e) {
          console.error('mailIngest: failed on message uid', uid, e.message);
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.error('mailIngest: poll failed:', e.message);
  } finally {
    try { await client.logout(); } catch { /* already disconnected */ }
    polling = false;
  }
}
