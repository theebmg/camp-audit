import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import path from 'path';

import { getTableMeta, listRecords, TABLES } from './nocodb.js';
import { pingDb, verifyUserCredentials } from './db.js';
import { requestContext } from './requestContext.js';
import apiRouter from './routes/api.js';
import manageRouter from './routes/manage.js';
import reportsRouter from './routes/reports.js';
import pgApiRouter from './routes/pg-api.js';
import requestPortalRouter from './routes/request-portal.js';

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

// Health check (no auth) — proves NocoDB reachable + Assets readable.
app.get('/health', async (req, res) => {
  try {
    const meta = await getTableMeta(TABLES.assets);
    const sample = await listRecords(TABLES.assets, { limit: 1 });
    res.json({
      ok: true,
      nocodb: 'reachable',
      assetsTable: meta?.title,
      assetFieldCount: meta?.columns?.length,
      sampleAssetCount: sample?.length ?? 0,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// DB health check (no auth) — proves the app can reach the new `camp` Postgres
// database. Separate from /health (which checks NocoDB) so each dependency's
// status is visible on its own during the Postgres migration.
app.get('/db-health', async (req, res) => {
  try {
    const row = await pingDb();
    res.json({ ok: true, db: row.db, serverTime: row.now });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

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
app.use('/api', requireAuth, apiRouter);
app.use('/api/manage', requireAuth, manageRouter);
app.use('/api/reports', requireAuth, reportsRouter);
// Postgres frontend preview — separate static bundle, mounted at /next so the
// live UI at / is completely untouched. Shares /style.css from public/.
app.use('/next', express.static(path.join(__dirname, '..', 'public-pg')));
// Friendly public URL for the request form (no login) — same file as /next/request.html.
app.get('/request', (req, res) => res.sendFile(path.join(__dirname, '..', 'public-pg', 'request.html')));
app.use(express.static(path.join(__dirname, '..', 'public')));

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
});
