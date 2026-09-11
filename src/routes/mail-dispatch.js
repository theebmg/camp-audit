// Single Mailgun inbound route, fanning out to the photo and receipt
// ingest paths — Mailgun's free tier allows only one inbound route, so
// photos@cmms.fracturedrv.com and receipts@cmms.fracturedrv.com both have
// to arrive here instead of at their own dedicated Mailgun routes.
//
// mail-inbound.js and receipt-inbound.js are unchanged as standalone
// endpoints (still mounted, still fully functional with their own
// signature/idempotency checks) — this file calls their exported
// ingestPhotoMail/ingestReceiptMail functions directly, so there's exactly
// one signature verification and one idempotency check per inbound message,
// not two. See those two files for what a given ingest path actually does;
// this file is only the fan-out.
//
// Public route (mounted before the authenticated /api/pg catch-all in
// server.js, same pattern as the other two) — Mailgun is the caller, there's
// no session. The signature check below is what stands in for auth.
import express from 'express';
import { findAttachmentBatchByMessageId } from '../db.js';
import { mailUpload, verifySignature, extractHeader, extractEmailAddress } from '../mailIngestShared.js';
import { ingestPhotoMail } from './mail-inbound.js';
import { ingestReceiptMail } from './receipt-inbound.js';

const router = express.Router();

// Recipient match is exact-address, not domain-suffix (mail-inbound.js's
// MAIL_INBOUND_DOMAIN check is a looser net appropriate for a single
// dedicated address; here two different addresses on the same domain must
// route to two different places, so it has to be the literal address).
// Lowercased — Mailgun's `recipient` field can carry a display name
// ("Camp Receipts <receipts@cmms.fracturedrv.com>") or arrive in mixed
// case, so this always matches on extractEmailAddress()'s parsed-out
// address, never the raw field.
const ROUTES = {
  'photos@cmms.fracturedrv.com': ingestPhotoMail,
  'receipts@cmms.fracturedrv.com': ingestReceiptMail,
};

router.post('/', mailUpload.any(), async (req, res) => {
  try {
    if (!verifySignature(req.body || {})) {
      return res.status(401).json({ ok: false, error: 'Invalid or stale signature' });
    }

    const messageId = extractHeader(req.body, 'Message-Id');
    if (!messageId) return res.json({ ok: true }); // can't dedupe without one — drop rather than risk reprocessing forever, same as both ingest paths

    // Idempotency lives here now, once, ahead of the fan-out — see this
    // file's header comment. Both ingestPhotoMail/ingestReceiptMail's own
    // DB writes still carry their own ON CONFLICT guard as a backstop (that
    // guard was always the authoritative one, this check just skips
    // redundant upload work), so nothing about their correctness changed.
    if (await findAttachmentBatchByMessageId(messageId)) {
      return res.json({ ok: true });
    }

    const recipient = extractEmailAddress(req.body.recipient || '')?.toLowerCase();
    const handler = ROUTES[recipient];
    if (!handler) {
      // Never 5xx here — an unrouted recipient (a typo, a stray CC, mail
      // Mailgun decided to hand us for some other reason) is not a failure
      // we want Mailgun retrying forever. Logged so a real misconfiguration
      // is still visible, just not treated as an ingest error.
      console.log(`mail-dispatch: unrouted recipient "${req.body.recipient || ''}" (message ${messageId}) — 200, not processed`);
      return res.json({ ok: true });
    }

    const result = await handler(req, messageId);
    res.json(result);
  } catch (e) {
    // 5xx so Mailgun retries — a storage failure or transient DB error here
    // must not silently drop the message.
    console.error('mail-dispatch: ingest failed:', e.message);
    res.status(502).json({ ok: false, error: 'Ingest failed' });
  }
});

export default router;
