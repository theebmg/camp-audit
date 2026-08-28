import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import path from 'path';

import { getTableMeta, listRecords, TABLES } from './nocodb.js';
import { pingDb } from './db.js';
import apiRouter from './routes/api.js';
import manageRouter from './routes/manage.js';
import reportsRouter from './routes/reports.js';
import pgApiRouter from './routes/pg-api.js';

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

function loadUsers() {
  const raw = process.env.APP_USERS || '';
  const users = {};
  raw.split(',').map(s => s.trim()).filter(Boolean).forEach(pair => {
    const i = pair.indexOf(':');
    if (i > 0) users[pair.slice(0, i)] = pair.slice(i + 1);
  });
  return users;
}
const USERS = loadUsers();

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (USERS[username] && USERS[username] === password) {
    req.session.user = username;
    return res.json({ ok: true, user: username });
  }
  res.status(401).json({ ok: false, error: 'Invalid credentials' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
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
app.use('/api', requireAuth, apiRouter);
app.use('/api/manage', requireAuth, manageRouter);
app.use('/api/reports', requireAuth, reportsRouter);
// Postgres frontend preview — separate static bundle, mounted at /next so the
// live UI at / is completely untouched. Shares /style.css from public/.
app.use('/next', express.static(path.join(__dirname, '..', 'public-pg')));
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
  console.log(`Users configured: ${Object.keys(USERS).join(', ') || '(none — set APP_USERS)'}`);
});
