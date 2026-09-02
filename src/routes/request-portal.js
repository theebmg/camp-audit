// Public Maintenance Request Portal — deliberately UNAUTHENTICATED (see
// server.js: mounted without requireAuth). Anyone with the link can submit a
// request. This is the only pg-backed router that doesn't sit behind a login,
// so it stays intentionally narrow: read the active field catalog + a plain
// location list, upload a photo, and submit. Everything else (list, review,
// approve/deny, convert to Work Order, email) lives in pg-api.js behind auth.
import express from 'express';
import multer from 'multer';
import { getRequestFormFields, createMaintenanceRequest, listLocations, createRequestMessage } from '../db.js';
import { uploadPhoto } from '../storage.js';
import { sendMail, mailIsConfigured } from '../mailer.js';
import { renderPlainEmailHtml } from '../reportRender.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// Very light abuse guard for an unauthenticated endpoint: cap submissions per
// IP per hour. Not a real rate-limiter (in-memory, resets on deploy) — good
// enough for a small camp's traffic; revisit if it's ever actually abused.
const submitTimestamps = new Map();
function tooManyFromIp(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const recent = (submitTimestamps.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  submitTimestamps.set(ip, recent);
  return recent.length > 10;
}

router.get('/fields', async (req, res, next) => {
  try {
    res.json({ fields: await getRequestFormFields() });
  } catch (e) { next(e); }
});

router.get('/locations', async (req, res, next) => {
  try {
    const locations = await listLocations();
    res.json({ locations: locations.map((l) => ({ Id: l.Id, Name: l.Name })) });
  } catch (e) { next(e); }
});

router.post('/upload', upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No image uploaded' });
    const url = await uploadPhoto(req.file.buffer, {
      filename: req.file.originalname, mimetype: req.file.mimetype, category: 'requests', ownerId: 'public',
    });
    res.json({ ok: true, url });
  } catch (e) { next(e); }
});

router.post('/submit', async (req, res, next) => {
  try {
    if (tooManyFromIp(req.ip)) {
      return res.status(429).json({ ok: false, error: 'Too many requests submitted from this connection — please try again later.' });
    }
    // Honeypot: a field named "company" that's hidden via CSS on the real form.
    // A human never fills it in; a bot filling every field will.
    if (req.body?.company) return res.json({ ok: true }); // pretend success, drop it silently
    const { values, photoUrls } = req.body || {};
    const request = await createMaintenanceRequest({ values: values || {}, photoUrls: Array.isArray(photoUrls) ? photoUrls : [] });

    if (mailIsConfigured() && request.RequesterEmail) {
      const subject = `We received your maintenance request (Ref #${request.Id})`;
      const text = `Hi${request.RequesterName ? ' ' + request.RequesterName : ''},\n\n`
        + `Thanks — we received your maintenance request (Ref #${request.Id}) and will follow up by email once it's been reviewed.\n\n`
        + (request.Description ? `What you told us:\n${request.Description}\n\n` : '')
        + `— Camp Sychar Maintenance`;
      try {
        await sendMail({ to: request.RequesterEmail, subject, text, html: renderPlainEmailHtml(subject, text) });
        await createRequestMessage(request.Id, { subject, body: text, toEmail: request.RequesterEmail, sentBy: 'system' });
      } catch (e) {
        await createRequestMessage(request.Id, { subject, body: text, toEmail: request.RequesterEmail, sentBy: 'system', status: 'failed', error: e.message });
      }
    }

    res.json({ ok: true, id: request.Id });
  } catch (e) { next(e); }
});

export default router;
