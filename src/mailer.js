// Email sending — isolated here the same way nocodb.js isolates NocoDB access.
// Supports two Gmail auth modes, tried in this order:
//   1. OAuth2 (GMAIL_USER + GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET +
//      GMAIL_OAUTH_REFRESH_TOKEN) — required when App Passwords are disabled for
//      the account (common on managed Workspace accounts you're not an admin on).
//   2. App Password (GMAIL_USER + GMAIL_APP_PASSWORD) — simpler, works when
//      available.
//
// GMAIL_USER is the account actually authenticating to Gmail's SMTP relay.
// The visible "From" address can be a DIFFERENT address (MAIL_FROM_ADDRESS) —
// Gmail's relay allows this as long as that address is a verified "Send Mail
// As" alias on GMAIL_USER's own account (Settings > Accounts > Send mail as).
// That's the whole trick: you never need admin rights over the alias's own
// mailbox, only over the Gmail account you authenticate as.
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { refreshAccessToken } from './gmailOAuth.js';

// A stored OAuth connection beats anything in the environment, because it is the one that can
// be re-granted from the browser when Google revokes it. Read lazily and cached only for as long
// as the credentials behind it are unchanged — reconnecting must take effect without a restart.
let transporter = null;
let transporterKey = null;

async function storedOAuth() {
  try {
    const db = await import('./db.js');
    return await db.getMailOAuthToken();
  } catch {
    return null;   // never let a database hiccup turn into "email is not configured"
  }
}

async function getTransporter() {
  const stored = await storedOAuth();

  const user = stored?.user || process.env.GMAIL_USER;
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = stored?.refreshToken || process.env.GMAIL_OAUTH_REFRESH_TOKEN;

  // Rebuild whenever any of it changes, so a reconnect is live immediately.
  const key = [user, clientId, refreshToken ? 'tok' : '', process.env.GMAIL_APP_PASSWORD ? 'pw' : ''].join('|');
  if (transporter && transporterKey === key) return transporter;
  transporter = null;
  transporterKey = key;
  const appPassword = process.env.GMAIL_APP_PASSWORD;

  if (user && clientId && clientSecret && refreshToken) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { type: 'OAuth2', user, clientId, clientSecret, refreshToken },
    });
    return transporter;
  }
  if (user && appPassword) {
    transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass: appPassword } });
    return transporter;
  }

  // Say which piece is missing. The old blanket "set GMAIL_USER plus..." was wrong and actively
  // misleading once OAuth arrived: the connection existed, the client was configured, and the
  // only thing absent was the account address — which no amount of .env editing would have fixed.
  const missing = [];
  if (!clientId || !clientSecret) missing.push('an OAuth client (GMAIL_OAUTH_CLIENT_ID / _SECRET)');
  if (!refreshToken && !appPassword) missing.push('a connection — use Admin → Integrations → Email (Gmail)');
  if (refreshToken && !user) {
    missing.push(
      'the address of the connected account. Reconnect from Admin → Integrations → Email (Gmail): '
      + 'the earlier grant did not include the email permission, so there is nothing to '
      + 'authenticate as'
    );
  }
  const err = new Error(`Email cannot be sent — missing ${missing.join('; and ')}.`);
  err.status = 500;
  throw err;
}

// Async now: a stored OAuth connection counts, and that lives in the database.
export async function mailIsConfigured() {
  const stored = await storedOAuth();
  if (stored?.refreshToken) return true;
  return Boolean(process.env.GMAIL_USER
    && (process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_OAUTH_REFRESH_TOKEN));
}

// Generic send. `from`/`fromName` default to the MAIL_FROM_* env vars (the
// alias), falling back to GMAIL_USER itself if those aren't set, so existing
// callers (reports) keep working unconfigured-alias-wise.
// `attachments` is nodemailer's shape. A board report passes inline images with a `cid`, which
// is what makes a photo render in the body rather than only as a file at the bottom.
// The account that AUTHENTICATES and the address mail APPEARS FROM are deliberately different.
// Gmail authenticates as ben@, and sends as cmms@ — which it permits only because cmms@ is a
// verified "send mail as" alias on that account. Get this wrong and Google silently rewrites the
// From header to the authenticating account, and the board sees a personal address.
//
// Falls back to the connected account rather than to GMAIL_USER, which is no longer where the
// authenticating identity lives — without this, an unset MAIL_FROM_ADDRESS produced
// "From: undefined".
export async function resolveFromHeaders() {
  const stored = await storedOAuth();
  const authAccount = stored?.user || process.env.GMAIL_USER || null;
  const fromAddress = process.env.MAIL_FROM_ADDRESS || authAccount;
  const fromName = process.env.MAIL_FROM_NAME;
  return {
    authAccount,
    fromAddress,
    from: fromName ? `"${fromName}" <${fromAddress}>` : fromAddress,
    // Replies to a board report belong with camp operations, not in a personal inbox, so this
    // follows the From address unless MAIL_REPLY_TO says otherwise.
    replyTo: process.env.MAIL_REPLY_TO || fromAddress,
  };
}

// Sent through Gmail's HTTPS API, not SMTP. This host's provider blocks outbound 25/465/587, so
// an SMTP send can only ever time out — and gmail.send, the one scope this app asks for, is the
// API's scope in any case. The upload endpoint takes the raw message, so nodemailer still builds
// the MIME (inline photos included) and only the transport differs.
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';

function buildRaw(message) {
  return new Promise((resolve, reject) => {
    new MailComposer(message).compile().build((err, buf) => (err ? reject(err) : resolve(buf)));
  });
}

async function sendViaGmailApi(refreshToken, message) {
  const { access_token: accessToken } = await refreshAccessToken(refreshToken);
  const raw = await buildRaw(message);
  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'message/rfc822' },
    body: raw,
    signal: AbortSignal.timeout(90000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Gmail API ${res.status}: ${json.error?.message || res.statusText}`);
    err.httpStatus = res.status;
    err.googleReason = json.error?.errors?.[0]?.reason || json.error?.status || null;
    throw err;
  }
  return { messageId: json.id || null, bytes: raw.length };
}

// What Ben reads. The raw error is kept beside it in the log for whoever has to fix it.
export function friendlyMailError(err, to) {
  const raw = String(err?.message || err || '');
  const reconnect = 'Reconnect at Admin → Integrations → Email (Gmail).';
  if (/^Email cannot be sent/.test(raw)) return raw;
  if (err?.googleError === 'invalid_grant' || /invalid_grant|expired or revoked/i.test(raw)) {
    return `Google has withdrawn this app's permission to send. ${reconnect}`;
  }
  if (err?.httpStatus === 401) return `Google did not accept the app's sign-in. ${reconnect}`;
  if (err?.httpStatus === 403 && /has not been used|is disabled|accessNotConfigured/i.test(raw)) {
    return 'The Gmail API is not switched on for the Google project this app uses.';
  }
  if (err?.httpStatus === 403) return `The Gmail connection is not allowed to send mail. ${reconnect}`;
  if (err?.httpStatus === 400 && /To header|recipient|address/i.test(raw)) {
    return `"${to}" is not an address Gmail will accept. Check it for typos.`;
  }
  if (err?.httpStatus === 413 || /too large/i.test(raw)) {
    return 'The message is too large for Gmail. Deselect some photos and try again.';
  }
  if (err?.httpStatus === 429 || /rate ?limit|quota/i.test(raw)) {
    return "Gmail's sending limit has been reached for now. Try again later.";
  }
  if (err?.httpStatus >= 500) return 'Gmail had a problem on its side. Try again in a few minutes.';
  if (/timeout|timed out|ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|aborted/i.test(raw)) {
    return 'The server could not reach Google. Try again in a minute.';
  }
  return `Gmail refused the message: ${raw}`;
}

// Every send is logged — Sending, then Sent or Failed — so "did it go?" has an answer that does
// not depend on having caught a toast. A logging failure never blocks or fails a send.
export async function sendMail({ to, subject, html, text, replyTo, attachments, context, by }) {
  const db = await import('./db.js');
  const logId = await db.startMailLog({ recipient: to, subject, context, by }).catch(() => null);
  try {
    const h = await resolveFromHeaders();
    const message = {
      from: h.from, to, subject, html, text,
      ...(attachments && attachments.length ? { attachments } : {}),
      replyTo: replyTo || h.replyTo,
    };
    const stored = await storedOAuth();
    const refreshToken = stored?.refreshToken || process.env.GMAIL_OAUTH_REFRESH_TOKEN;
    let result;
    if (refreshToken) {
      result = await sendViaGmailApi(refreshToken, message);
    } else {
      // App-password fallback. SMTP is blocked from this host, so this exists for a host where
      // it is not.
      const info = await (await getTransporter()).sendMail(message);
      result = { messageId: info?.messageId || null, bytes: null };
    }
    await db.finishMailLog(logId, { status: 'sent', ...result }).catch(() => {});
    return result;
  } catch (err) {
    const friendly = friendlyMailError(err, to);
    await db.finishMailLog(logId, { status: 'failed', error: friendly, detail: err?.message }).catch(() => {});
    const out = new Error(friendly);
    out.status = 502;
    out.detail = err?.message;
    throw out;
  }
}

export async function sendReportEmail({ to, subject, html, text }) {
  return sendMail({ to, subject, html, text });
}
