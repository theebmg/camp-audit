// Is email actually set up, and does it work?
//
//   docker exec camp-audit node scripts/check-mail.mjs                 # check config only
//   docker exec camp-audit node scripts/check-mail.mjs you@example.com # also send a test
//
// Never prints a secret: only whether a variable is set and how long it is.
import { mailIsConfigured, sendMail } from '/app/src/mailer.js';

const show = (name, { secret = false } = {}) => {
  const v = process.env[name];
  const state = v ? 'set' : 'NOT SET';
  const extra = v ? (secret ? ` (${v.length} chars)` : ` = ${v}`) : '';
  console.log(`  ${state.padEnd(8)} ${name}${extra}`);
};

console.log('CONFIGURATION');
show('GMAIL_USER');
show('GMAIL_APP_PASSWORD', { secret: true });
show('GMAIL_OAUTH_CLIENT_ID', { secret: true });
show('GMAIL_OAUTH_CLIENT_SECRET', { secret: true });
show('GMAIL_OAUTH_REFRESH_TOKEN', { secret: true });
show('MAIL_FROM_ADDRESS');
show('MAIL_FROM_NAME');
show('BACKUP_ALERT_EMAIL');

const configured = await mailIsConfigured();
console.log(`\nmailIsConfigured(): ${configured}`);

if (!configured) {
  console.log(`
NOT CONFIGURED. The app needs GMAIL_USER plus ONE of:
  · GMAIL_APP_PASSWORD                         (simplest; needs 2-step verification on)
  · the three GMAIL_OAUTH_* values             (for accounts where app passwords are disabled)

Add them to /root/camp-audit/.env on the server, then:
  cd /root/nocodb && docker compose up -d camp-audit

MAIL_FROM_ADDRESS is optional: a verified "Send mail as" alias to appear as the sender.
`);
  process.exit(1);
}

const to = process.argv[2];
if (!to) {
  console.log('\nConfigured. Pass an address to send a real test:');
  console.log('  docker exec camp-audit node scripts/check-mail.mjs you@example.com');
  process.exit(0);
}

console.log(`\nsending a test to ${to} …`);
try {
  await sendMail({
    to,
    subject: 'Sychar Operations — mail test',
    text: 'If you are reading this, the board report can be emailed from the app.',
    html: '<p>If you are reading this, the board report can be emailed from the app.</p>',
  });
  console.log('SENT. Check that inbox (and the spam folder the first time).');
} catch (e) {
  console.log(`FAILED: ${e.message}`);
  if (/Invalid login|Username and Password not accepted/i.test(e.message)) {
    console.log('\nThat is Google rejecting the credentials. Usual causes:');
    console.log('  · the app password was typed with its spaces — remove them');
    console.log('  · 2-step verification is off, so app passwords do not exist for that account');
    console.log('  · the account is managed and its admin has disabled app passwords — use OAuth instead');
  }
  process.exit(1);
}
