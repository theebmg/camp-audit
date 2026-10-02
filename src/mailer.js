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

export async function sendMail({ to, subject, html, text, replyTo, attachments }) {
  const t = await getTransporter();
  const h = await resolveFromHeaders();
  return t.sendMail({
    from: h.from, to, subject, html, text,
    ...(attachments && attachments.length ? { attachments } : {}),
    replyTo: replyTo || h.replyTo,
  });
}

export async function sendReportEmail({ to, subject, html, text }) {
  return sendMail({ to, subject, html, text });
}
