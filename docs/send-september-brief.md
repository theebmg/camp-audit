# Getting the September board report to the board

Written 2026-10-02. **The goal is one thing: the board receives the September report.**
Everything below is either done or is a step toward that.

---

## Where it stands

**The report itself is finished.** Report #1, "September 2026", published, frozen:

| | |
|---|---|
| Items | 20 |
| Photos selected | 26 (4.22 MB as an email — within the 15 MB limit) |
| Summary | 1,802 characters |
| Cost of work shown | **$2,442.45** |
| Camp funds spent this period | $995.05 |
| Contributed (non-camp) | $1,300.00 |

**The one thing stopping it being sent: the app cannot send email.** Nothing else is blocking.

---

## Why it cannot send yet

Gmail used to accept an app password. **Google stopped allowing that for Workspace accounts
from 14 March 2025**, so the only route now is OAuth: granting permission once in a browser,
after which the app holds a refresh token.

That flow is now built and deployed. It is waiting on configuration in Google Cloud Console,
which only you can do.

---

## The steps, in order

### 1. Decide what `cmms@fracturedrv.com` is

This governs everything after it, and I do not know the answer.

- **A real Workspace user** (its own seat and password) → connect as it directly. Done.
- **An alias on your own account** → you connect as **your** account, and mail still appears from
  `cmms@` because `MAIL_FROM_ADDRESS` is already set to it. Gmail only honours that once `cmms@`
  is a verified **Send mail as** address: Gmail → Settings → Accounts → *Send mail as* → Add
  another email address → verify.

An alias **cannot** authenticate to Gmail's SMTP. That is the whole reason this matters.

### 2. Check who owns Google Cloud project `691559247304`

This is the project your Calendar sync already uses, and the app reuses its OAuth client.

Console → the project picker shows the owning organisation.

- **Owned by fracturedrv.com** → carry on to step 3.
- **Owned by campsychar.org, with the consent screen set to Internal** → it will refuse a
  fracturedrv.com account outright. This is the same wall the Calendar work hit. You then need a
  **new OAuth client in a fracturedrv.com-owned project** (step 3 in that project instead), and
  send me the client id and secret — I will set `GMAIL_OAUTH_CLIENT_ID` and
  `GMAIL_OAUTH_CLIENT_SECRET`, which the app prefers over the Calendar pair. Calendar keeps
  working untouched.

### 3. Enable the Gmail API

APIs & Services → **Library** → search *Gmail API* → **Enable**.

Without this, consent succeeds and sending fails with a permission error, which is a confusing
way to find out.

### 4. Register the redirect URI

APIs & Services → Credentials → your OAuth 2.0 Client ID → **Authorised redirect URIs** → Add:

```
https://audit.fracturedrv.com/api/pg/gmail/oauth/callback
```

Exactly that — no trailing slash. A mismatch gives `redirect_uri_mismatch` at consent time.

### 5. Connect

In the app: **Admin → Integrations → Email (Gmail) → Connect Gmail.**

Sign in as the account from step 1 and grant it. It asks for one permission, *send email on your
behalf*, and cannot read your mailbox.

You come back to the app with a message saying whether it worked.

### 6. Prove it

Same screen, **Send test email** → your own address → Send.

If Google refuses, the error is shown in full on that screen rather than swallowed.

### 7. Send the report

Reports → Board Report → **Email…** → the board's address.

The 26 photos are embedded in the message. If the total ever exceeded 15 MB the send would be
refused rather than silently bounced.

---

## What I need from you

1. Whether `cmms@fracturedrv.com` is a mailbox or an alias.
2. Who owns project 691559247304 — and, if it is campsychar.org with an Internal consent screen,
   a client id and secret from a fracturedrv.com project.

Tell me either and I will do the rest.

---

## Already done, so you do not have to think about it

- `MAIL_FROM_ADDRESS=cmms@fracturedrv.com` and `MAIL_FROM_NAME=Camp Sychar Operations` are set.
- `BACKUP_ALERT_EMAIL=cmms@fracturedrv.com` — nightly backup failures will reach you once mail
  works.
- The OAuth flow, the admin screen, the callback, the test button, and a command-line checker
  (`docker exec camp-audit node scripts/check-mail.mjs`).
- The refresh token is stored in the database, not a hand-edited file, so re-granting it later
  needs no deploy.

## Loose ends, none of them blocking

- **One receipt, $42.60, is not linked to any work**, so it counts as camp spend but is not
  attributed to a job on the report.
- **A second, empty "September 2026" draft (#26) exists** — the shell the screen created when the
  report was published. Harmless. Unpublishing #1 clears it away automatically.
- **4 items were deleted** when you published the second time: unchecked items are dropped at
  publish, and they do not come back. A refresh re-proposes them if they still qualify.
- The savings note still reads "$277/month" while the stored record says $300, so the report
  states $3,600/yr.
