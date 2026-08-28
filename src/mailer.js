// Email sending — isolated here the same way nocodb.js isolates NocoDB access.
// Supports two Gmail auth modes, tried in this order:
//   1. OAuth2 (GMAIL_USER + GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET +
//      GMAIL_OAUTH_REFRESH_TOKEN) — required when App Passwords are disabled for
//      the account (common on managed Workspace accounts you're not an admin on).
//   2. App Password (GMAIL_USER + GMAIL_APP_PASSWORD) — simpler, works when
//      available.
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

export async function sendReportEmail({ to, subject, html, text }) {
  const t = getTransporter();
  return t.sendMail({ from: process.env.GMAIL_USER, to, subject, html, text });
}
