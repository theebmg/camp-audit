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

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;

  const user = process.env.GMAIL_USER;
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_OAUTH_REFRESH_TOKEN;
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

  const err = new Error(
    'Email sending is not configured — set GMAIL_USER plus either GMAIL_APP_PASSWORD, ' +
    'or GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET + GMAIL_OAUTH_REFRESH_TOKEN in .env'
  );
  err.status = 500;
  throw err;
}

export function mailIsConfigured() {
  return Boolean(process.env.GMAIL_USER && (process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_OAUTH_REFRESH_TOKEN));
}

// Generic send. `from`/`fromName` default to the MAIL_FROM_* env vars (the
// alias), falling back to GMAIL_USER itself if those aren't set, so existing
// callers (reports) keep working unconfigured-alias-wise.
export async function sendMail({ to, subject, html, text, replyTo }) {
  const t = getTransporter();
  const fromAddress = process.env.MAIL_FROM_ADDRESS || process.env.GMAIL_USER;
  const fromName = process.env.MAIL_FROM_NAME;
  const from = fromName ? `"${fromName}" <${fromAddress}>` : fromAddress;
  return t.sendMail({
    from, to, subject, html, text,
    replyTo: replyTo || process.env.MAIL_REPLY_TO || fromAddress,
  });
}

export async function sendReportEmail({ to, subject, html, text }) {
  return sendMail({ to, subject, html, text });
}
