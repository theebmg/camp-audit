// Google Calendar API integration (Build Brief v4 Part 1) — the only module
// that talks to Google's OAuth/Calendar endpoints, same portability
// discipline src/db.js holds for SQL and src/storage.js holds for S3/Spaces.
//
// No Google SDK dependency. This is a handful of REST calls (OAuth token
// exchange/refresh, calendar create/color, and — once the sync worker in
// step 3 lands — event create/update/delete), so raw fetch matches the
// project's existing no-heavy-SDK style (src/mailer.js does the same thing
// for Gmail's own OAuth2, via nodemailer's built-in support rather than a
// Google API client).
//
// Scope (revised 2026-09-14, after a live 403 "insufficient authentication
// scopes"): calendar.events alone only covers the Events resource
// (list/get/insert/update/delete) — it does NOT cover calendars.get,
// calendars.insert, or calendarList.list/patch, which is everything the
// admin screen's calendar picker and "create a new Camp Work calendar"
// option need (listWritableCalendars, createCampWorkCalendar,
// getPrimaryCalendarEmail below). Three granular scopes instead of the
// single legacy `calendar` scope — narrower than `calendar` (which also
// grants ACLs and free/busy access this app never touches), but wide enough
// to actually cover calendar management, not just events.
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = 'https://audit.fracturedrv.com/api/pg/gcal/oauth/callback';
const SCOPE = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist',
  'https://www.googleapis.com/auth/calendar.calendars',
].join(' ');

export function gcalIsConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function requireConfigured() {
  if (!gcalIsConfigured()) {
    const err = new Error('Google Calendar sync is not configured — set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env');
    err.status = 500;
    throw err;
  }
}

// Step 1 of the OAuth dance — where the admin's browser gets sent to grant
// access. `state` is a per-attempt random token the caller stores in the
// session and verifies on callback: the standard CSRF defense for a flow
// that ends in a plain browser redirect, not a request this app makes
// itself. access_type=offline + prompt=consent are both required to
// actually get a refresh_token back — Google only issues one on true first
// consent, otherwise (prompt=consent forces it every time, which is why
// it's always set here rather than only on first connect).
export function buildAuthUrl(state) {
  requireConfigured();
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(`Google token endpoint error: ${json.error_description || json.error || res.status}`);
    err.status = res.status;
    err.googleError = json.error;
    throw err;
  }
  return json;
}

// Step 2: the callback route trades the one-time `code` for tokens. Only
// this exchange ever returns a refresh_token — every later access-token
// refresh (refreshAccessToken below) returns an access_token only.
export async function exchangeCodeForTokens(code) {
  requireConfigured();
  return tokenRequest({
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
  });
}

// A "dead" refresh token (revoked from the Google Account side, or a
// consent Google has since invalidated) fails with invalid_grant — the
// sync worker (step 3) needs to tell that apart from a transient failure so
// it stops retrying and asks for reauthorization instead of hammering a
// token that will never work again (brief §1.6/§2.2).
export async function refreshAccessToken(refreshToken) {
  requireConfigured();
  try {
    return await tokenRequest({
      refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
    });
  } catch (e) {
    if (e.googleError === 'invalid_grant') e.deadToken = true;
    throw e;
  }
}

// Shared by the admin routes (list/save calendar) and the sync worker
// (step 3) — every caller needs the same two things: a clear error if
// nothing's connected yet, and a fresh access token otherwise (refresh
// tokens are exchanged for a new access token on every use here rather
// than cached, since Google's access tokens are short-lived and this app
// has no in-memory cache to invalidate correctly across the worker's
// separate process). Throws with `deadToken` set (via refreshAccessToken
// above) when the stored refresh token has been revoked — callers that
// distinguish "not configured" from "dead token" for retry purposes
// (the sync worker) should check that flag, not just catch-and-log.
export async function getAccessTokenOrThrow(refreshToken) {
  if (!refreshToken) {
    const err = new Error('Google Calendar is not connected');
    err.status = 400;
    throw err;
  }
  const tokens = await refreshAccessToken(refreshToken);
  return tokens.access_token;
}

// Best-effort revoke when disconnecting (the admin screen's Disconnect
// button) — an already-invalid token 400s here, which is fine; the local
// disconnect (clearGcalConnection in db.js) proceeds either way.
export async function revokeToken(token) {
  await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => {});
}

async function calendarApi(accessToken, method, path, body) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`Google Calendar API error (${res.status}): ${json?.error?.message || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// The account's own email, purely for display on the admin screen
// ("connected as ben@..."). The primary calendar's own id IS the account's
// email address, so no separate userinfo scope/call is needed — just the
// calendar.calendars scope this module already requests (calendars.get is
// outside calendar.events, which is what caused the original 403 here).
export async function getPrimaryCalendarEmail(accessToken) {
  const primary = await calendarApi(accessToken, 'GET', '/calendars/primary');
  return primary.id;
}

// Creates a fresh "Camp Work" calendar — one option in the admin screen's
// calendar picker (src/routes/pg-api.js's POST /gcal/calendar), alongside
// pointing sync at a calendar the admin already made themselves (revised
// 2026-09-14: calendar choice is no longer automatic-and-immediate during
// the OAuth callback, since Ben may already have a purpose-built calendar,
// e.g. one created directly in the camp Google account and shared to his
// own). Inserting a calendar automatically adds it to the creating
// account's own calendar list, which is what makes the follow-up colorId
// patch below valid immediately.
//
// Given its own color at creation (brief §1.4's calendar-level color, a
// different axis from the future per-event colorId in gcal_event_colors) so
// everything from the CMMS reads as one block in Google's UI with no
// per-event work. The colorId is read from Google's own /colors list rather
// than a hardcoded guess — calendar-level colorIds are a different, larger
// ID space than event colorIds and neither is worth hardcoding against.
export async function createCampWorkCalendar(accessToken) {
  const calendar = await calendarApi(accessToken, 'POST', '/calendars', {
    summary: 'Camp Work',
    description: 'Mirrors scheduled maintenance work from Sychar Operations. Managed automatically — edits made directly in Google Calendar are overwritten on the next sync.',
  });
  const colors = await calendarApi(accessToken, 'GET', '/colors');
  const colorId = Object.keys(colors?.calendar || {}).sort((a, b) => Number(a) - Number(b))[0];
  if (colorId) {
    await calendarApi(accessToken, 'PATCH', `/users/me/calendarList/${encodeURIComponent(calendar.id)}`, { colorId });
  }
  return calendar.id;
}

// Calendars the connected account can write to — powers the admin screen's
// picker (brief revision, 2026-09-14) so sync can point at any calendar Ben
// has edit access to, including the primary calendar or one shared in from
// elsewhere, not only a calendar this app created. `primary` is surfaced so
// the picker can label it clearly — nothing here blocks selecting it, that
// call is left to the admin now that this is an explicit manual choice.
//
// showHidden=true is required here (found live, 2026-09-14): calendarList.list
// silently OMITS any entry marked hidden by default, and a calendar someone
// just shared with you starts out hidden in your list until you manually
// toggle it visible in Google Calendar's own UI — so a freshly-shared
// calendar like "Sychar Events" would never appear in this picker without it,
// even with full owner-level access. minAccessRole=writer asks Google to do
// the writer-or-better filtering server-side; the client-side filter below
// stays as a harmless belt-and-suspenders check.
export async function listWritableCalendars(accessToken) {
  const list = await calendarApi(accessToken, 'GET', '/users/me/calendarList?showHidden=true&minAccessRole=writer');
  return (list?.items || [])
    .filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer')
    .map((c) => ({ id: c.id, summary: c.summary, primary: !!c.primary }));
}

// ── Step 3: event create/update/delete on the connected calendar. Bodies
//    are built entirely by the caller (gcalSync.js) — this module stays
//    "just talks to Google," same as everywhere else here. ─────────────────

export async function insertEvent(accessToken, calendarId, eventBody) {
  return calendarApi(accessToken, 'POST', `/calendars/${encodeURIComponent(calendarId)}/events`, eventBody);
}

// PUT (full replace), not PATCH — the worker always rebuilds the complete
// desired body from the CMMS row, never a partial field set, so PUT's
// semantics are exactly right. Also sidesteps a real Google API quirk found
// live: PATCHing an existing all-day event's start/end into a timed
// dateTime+timeZone pair (or vice versa) 400s with "Invalid start time"
// even though the identical body succeeds as an insert or as a timed-to-
// timed patch — PUT handles the all-day/timed transition correctly where
// PATCH doesn't.
export async function updateEvent(accessToken, calendarId, eventId, eventBody) {
  return calendarApi(accessToken, 'PUT', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, eventBody);
}

// A 404/410 here means the event is already gone from Google's side (hand-
// deleted despite the one-way-mirror warning, or already cleaned up by a
// previous run that crashed after the API call but before the CMMS-side
// bookkeeping) — that's the caller's desired end state either way, so it's
// treated as success rather than a retryable failure.
export async function deleteEvent(accessToken, calendarId, eventId) {
  try {
    await calendarApi(accessToken, 'DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  } catch (e) {
    if (e.status === 404 || e.status === 410) return;
    throw e;
  }
}
