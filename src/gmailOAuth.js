// Gmail OAuth — the only way a Workspace account can send through Gmail now that app passwords
// are gone. Deliberately a near-copy of src/gcal.js's flow rather than a shared abstraction:
// the two grant different scopes, to different Google products, and are revoked independently.
// Merging them would mean losing calendar access every time mail was re-consented.
//
// The client id/secret are REUSED from the calendar integration when no Gmail-specific pair is
// set, because they are the same Google Cloud project. A separate pair is supported for the case
// Ben hit on campsychar.org: an OAuth consent screen set to "Internal" refuses accounts from any
// other domain, so sending as fracturedrv.com may need a client owned by that domain.
const CLIENT_ID = process.env.GMAIL_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;

// Must match a URI registered on the OAuth client in Google Cloud Console, exactly.
export const REDIRECT_URI = 'https://audit.fracturedrv.com/api/pg/gmail/oauth/callback';

// gmail.send is the narrowest scope that can send — not compose, not full mail access. This app
// sends board reports and never reads a mailbox.
//
// 'openid email' is here for one reason: SMTP needs to know WHICH mailbox it is authenticating,
// and gmail.send alone cannot tell us. The obvious route — Gmail's users.getProfile — requires a
// READ scope this app deliberately does not ask for, so it returned nothing and the connection
// was stored with no address against it, after which sending failed with "not configured".
// 'email' adds no access to anything; it only puts the address in the token response.
const SCOPE = [
  'https://www.googleapis.com/auth/gmail.send',
  'openid',
  'email',
].join(' ');

export function gmailOAuthIsConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function requireConfigured() {
  if (!gmailOAuthIsConfigured()) {
    const err = new Error(
      'Gmail OAuth is not configured — set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET '
      + '(or reuse GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET) in .env'
    );
    err.status = 500;
    throw err;
  }
}

// access_type=offline + prompt=consent are both required to get a refresh_token at all: Google
// issues one only on a true first consent, and prompt=consent forces that every time, which is
// what makes re-connecting work rather than silently returning an access token and nothing else.
//
// login_hint puts the right account in front of someone signed into several.
export function buildAuthUrl(state, loginHint = null) {
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
  if (loginHint) params.set('login_hint', loginHint);
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
    const err = new Error(`Google token endpoint: ${json.error_description || json.error || res.status}`);
    err.status = res.status;
    err.googleError = json.error;
    throw err;
  }
  return json;
}

// Only this exchange ever returns a refresh_token. Every later refresh returns an access token
// and nothing else, which is why the refresh token is the thing worth storing.
export async function exchangeCodeForTokens(code) {
  requireConfigured();
  return tokenRequest({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });
}

export async function refreshAccessToken(refreshToken) {
  requireConfigured();
  return tokenRequest({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
}

// Which account the token belongs to. Not a nicety: nodemailer needs it to authenticate, and a
// connection stored without it cannot send at all.
//
// Read from the id_token Google returns alongside the access token. The payload is decoded
// WITHOUT signature verification, which is safe here and only here: this token came straight
// back from Google's own token endpoint over TLS in response to a request this server made with
// its own client secret. It was never handled by a browser or a user. A token arriving by any
// other path would have to be verified properly.
export function emailFromIdToken(idToken) {
  try {
    const payload = String(idToken || '').split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return json.email || null;
  } catch {
    return null;
  }
}

// Fallback for a token granted before 'email' was requested, and a belt-and-braces second
// source. Needs a read scope, so it will simply return null on a send-only grant.
export async function fetchGrantedEmail(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.email || null;
  } catch {
    return null;
  }
}

export const OAUTH_CLIENT_ID_FOR_DISPLAY = CLIENT_ID
  ? `${String(CLIENT_ID).slice(0, 12)}…${String(CLIENT_ID).slice(-14)}`
  : null;
