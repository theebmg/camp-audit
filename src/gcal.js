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
// Scope is deliberately narrow: calendar.events, not the full `calendar`
// scope (brief §1.7) — this app only ever needs to create/update/delete
// events on a calendar it owns, never to read or manage calendars generally.

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = 'https://audit.fracturedrv.com/api/pg/gcal/oauth/callback';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

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
// email address, so no separate userinfo scope/call is needed beyond
// calendar.events.
export async function getPrimaryCalendarEmail(accessToken) {
  const primary = await calendarApi(accessToken, 'GET', '/calendars/primary');
  return primary.id;
}

// Creates the dedicated "Camp Work" calendar (brief §1.3) — never the
// primary calendar. Called once, on first authorization; the resulting
// calendarId is stored in gcal_connection and reused for every event this
// app ever writes. Inserting a calendar automatically adds it to the
// creating account's own calendar list, which is what makes the follow-up
// colorId patch below valid immediately.
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
