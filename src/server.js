import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import path from 'path';

import { pingDb, verifyUserCredentials } from './db.js';
import { requestContext } from './requestContext.js';
import pgApiRouter from './routes/pg-api.js';
import requestPortalRouter from './routes/request-portal.js';
import mailInboundRouter from './routes/mail-inbound.js';
import receiptInboundRouter from './routes/receipt-inbound.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-env',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
}));

// Accounts live in the `users` table (Admin > Users) — see db.js's
// verifyUserCredentials/hashPassword. Replaces the old APP_USERS env-var pair.
app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  try {
    const user = await verifyUserCredentials(username, password);
    if (user) {
      req.session.user = user.Username;
      req.session.role = user.Role;
      return res.json({ ok: true, user: user.Username, role: user.Role });
    }
  } catch (e) {
    console.error('Login check failed:', e.message);
    return res.status(500).json({ ok: false, error: 'Login temporarily unavailable' });
  }
  res.status(401).json({ ok: false, error: 'Invalid credentials' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function requireAuth(req, res, next) {
  if (req.session?.user) {
    return requestContext.run({ username: req.session.user, role: req.session.role || 'standard' }, next);
  }
  res.status(401).json({ ok: false, error: 'Not authenticated' });
}

// Health check (no auth) — proves the app can reach the `camp` Postgres database.
app.get('/health', async (req, res) => {
  try {
    const row = await pingDb();
    res.json({ ok: true, db: row.db, serverTime: row.now });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Mailgun inbound webhook (Build Brief v2.1 Part 1, replaces the old IMAP
// poller) — public; the caller is Mailgun, not a logged-in user, and the
// route does its own signature verification instead of a session. MUST be
// mounted before the '/api/pg' requireAuth block below: Express matches
// app.use paths by prefix in registration order, so '/api/pg' would
// otherwise intercept '/api/pg/mail-inbound/*' and reject it with
// requireAuth before this router ever saw the request.
app.use('/api/pg/mail-inbound', mailInboundRouter);
// Second Mailgun route for emailed receipts (Build Brief v3 Part 2) — same
// public/pre-auth mounting reason as mail-inbound above. Ben's Mailgun route
// for receipts@cmms.fracturedrv.com points at this exact path.
app.use('/api/pg/receipt-inbound', receiptInboundRouter);
// Postgres-backed parallel API (migration in progress) — additive, does not
// replace /api. See toClaudeCode/camp-cmms-postgres-migration-brief.md.
app.use('/api/pg', requireAuth, pgApiRouter);
// Maintenance Request Portal's public submit endpoints — deliberately NOT
// behind requireAuth; anyone with the link can submit a request. Review,
// approve/deny, and convert-to-Work-Order stay under /api/pg (authenticated).
// Mounted BEFORE the '/api' catch-all below: Express matches app.use paths
// by prefix, so '/api' would otherwise intercept '/api/request-portal/*'
// requests and reject them with requireAuth before this router ever saw them.
app.use('/api/request-portal', requestPortalRouter);
// The Postgres-backed app (formerly the /next preview) is now the app —
// served at root. /next redirects so anything bookmarked mid-cutover still lands.
app.get('/next', (req, res) => res.redirect(301, '/'));
app.get(/^\/next\/(.*)/, (req, res) => res.redirect(301, `/${req.params[0]}`));
// Friendly public URL for the request form (no login) — same file served at /request.html.
app.get('/request', (req, res) => res.sendFile(path.join(__dirname, '..', 'public-pg', 'request.html')));
app.use(express.static(path.join(__dirname, '..', 'public-pg')));

// JSON error handler — without this, an uncaught error anywhere in the API routes
// falls through to Express's default HTML error page. The frontend's fetch().json()
// then silently fails to parse it and reports a generic "Request failed" instead
// of the real error message.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status && err.status < 600 ? err.status : 500).json({ ok: false, error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`camp-audit listening on :${PORT}`);
  // Email-fed triage inbox (Build Brief v2.1 Part 1) is now the Mailgun
  // webhook at /api/pg/mail-inbound (routes/mail-inbound.js) — nothing to
  // start here. The old IMAP poll interval is gone along with mailIngest.js.
});
