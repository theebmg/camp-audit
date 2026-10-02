# Brief: enable Gmail sending so the September board report can go out

**Audience: an AI assistant with current documentation access.** Written 2026-10-02 by an
assistant whose training data ends May 2026. **The Google Cloud Console UI changes frequently —
treat every Google-side instruction here as a REQUIREMENT TO SATISFY, not a click path to
follow. Verify current steps against Google's live documentation before instructing the user.**

The application side is built, deployed and verified. What remains is Google-side configuration
plus two facts only the user can supply.

---

## 1. Goal

Camp Sychar's board must receive the September 2026 board report by email from the CMMS.

The report is complete and frozen. The only blocker is that the application cannot send mail.

---

## 2. System

| | |
|---|---|
| App | "Sychar Operations", a CMMS at **https://audit.fracturedrv.com** |
| Stack | Node/Express + PostgreSQL + vanilla-JS SPA, no bundler |
| Host | Single DigitalOcean box, Docker Compose, behind Caddy. SSH alias `camp` |
| Repo | `github.com/theebmg/camp-audit`, deploys from `origin/main` |
| Container | `camp-audit`; database container `nocodb-db`, database `camp` |
| Env file | `/root/camp-audit/.env` on the host, mode 600, gitignored, loaded via `env_file` |
| Deploy | `git push origin <branch>:main` → on host: `cd ~/camp-audit && git pull origin main && cd /root/nocodb && docker compose build camp-audit && docker compose up -d camp-audit` |
| Migrations | `docker exec camp-audit npm run migrate` — additive only, one transaction each |

**User:** Ben Greenawalt, camp caretaker. Non-specialist in cloud consoles. Give exact,
current, verified steps — he has already been given stale ones and said so.

---

## 3. Why OAuth, not an app password

Google ended app-password / basic-auth access for Google Workspace accounts (the user reports a
notice citing **14 March 2025**). The account in question is on a Workspace domain, so OAuth 2.0
is the only route.

**Confirm the current state of this policy before advising** — it may have moved again since.

---

## 4. What is already built (application side — do not rebuild)

### Code
| Path | Purpose |
|---|---|
| `src/gmailOAuth.js` | Auth URL, code exchange, token refresh, granted-address lookup |
| `src/routes/gmail-oauth-callback.js` | OAuth callback; mounted BEFORE the auth gate in `src/server.js` because Google navigates the browser to it directly |
| `src/mailer.js` | nodemailer transport; prefers the stored OAuth token over env; rebuilds when credentials change so a reconnect is live without a restart |
| `src/db.js` | `getMailOAuthToken`, `getMailSettings`, `setMailOAuthToken`, `clearMailOAuthToken`, `recordMailError` |
| `scripts/check-mail.mjs` | CLI check; prints which variables are set (never values) and can send a test |

### HTTP endpoints
| Method | Path | Notes |
|---|---|---|
| GET | `/api/pg/gmail/oauth/start` | Admin only. Returns `{ url }` for the consent redirect. Writes a CSRF `state` to the session |
| GET | `/api/pg/gmail/oauth/callback` | **Unauthenticated by design.** Verifies `state`, exchanges the code, stores the refresh token |
| GET | `/api/pg/gmail/status` | Connection state. Never returns the token |
| POST | `/api/pg/gmail/disconnect` | Admin only |
| POST | `/api/pg/gmail/test` | Admin only. `{ to }`. Sends a real message |

### UI
**Admin → Integrations → Email (Gmail).** Shows connection state, the redirect URI to register,
a Connect button, and a test-send box.

### Storage
`mail_settings` (migration 0114), single row: `oauth_user`, `oauth_refresh_token`,
`connected_at`, `connected_by`, `last_error`.

The refresh token is in the **database**, not `.env`, because it is browser-obtained, revocable
from Google's side, and may need re-granting without a deploy.
`GMAIL_OAUTH_REFRESH_TOKEN` in the environment still takes precedence if set.

---

## 5. The exact contract Google must satisfy

These are the values the application uses. They are not negotiable without a code change.

```
Redirect URI   https://audit.fracturedrv.com/api/pg/gmail/oauth/callback
Scope          https://www.googleapis.com/auth/gmail.send
Auth params    access_type=offline  prompt=consent  response_type=code
API required   Gmail API, enabled in the same project as the OAuth client
Client type    Web application
```

`prompt=consent` is set deliberately: Google returns a refresh token only on a true first
consent, and forcing it makes re-connection work rather than silently yielding an access token
alone. The callback **fails loudly** if no refresh token comes back.

### Which OAuth client
The app reads, in order:
1. `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET`
2. falling back to `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (the existing Google
   Calendar integration, Google Cloud project **691559247304**)

Setting the Gmail-specific pair leaves Calendar untouched.

---

## 6. Google-side work required

**Verify each against current Google documentation — the UI and the terminology have both moved
in the past and this brief's author cannot see the current console.**

1. **Determine which organisation owns project 691559247304.** The app currently reuses that
   project's OAuth client.

2. **Determine the OAuth consent screen's user type.** If it is **Internal** and the owning
   organisation is not the domain of the sending account, consent will be refused. The user has
   already hit exactly this on `campsychar.org` while setting up Calendar sync. In that case a
   new OAuth client in a project owned by the sending account's domain is required, and its
   credentials go into `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET`.

3. **Enable the Gmail API** in whichever project holds the client. If this is missed, consent
   succeeds and sending fails later with a permission error — a confusing failure mode worth
   pre-empting.

4. **Register the redirect URI** above on that client, exactly, with no trailing slash. A
   mismatch produces `redirect_uri_mismatch` at consent time.

5. **Check whether publishing / verification is required** for this scope and user type before
   the account can consent. `gmail.send` is a restricted scope; whether an unverified app can be
   used by accounts inside the owning organisation, and what limits apply, is exactly the kind
   of policy that may have changed. **Check current requirements.**

---

## 7. Two facts only the user can supply

### a. Is `cmms@fracturedrv.com` a mailbox or an alias?

- **A Workspace user with its own seat** → connect as it directly.
- **An alias on Ben's own account** → connect as **Ben's** account. Mail still appears from
  `cmms@` because `MAIL_FROM_ADDRESS` is already set to it — but Gmail honours that only if
  `cmms@` is a verified *send mail as* address on the authenticating account. Otherwise Google
  rewrites the sender.

**An alias cannot authenticate to Gmail.** This determines which account completes the consent.

### b. Who owns project 691559247304, and is its consent screen Internal?

Determines whether the existing OAuth client can be reused or a new one is needed.

---

## 8. Sequence once Google is configured

1. App: **Admin → Integrations → Email (Gmail) → Connect Gmail**, sign in as the account from
   7a, grant.
2. Same screen: **Send test email** to a known address. Errors are shown in full.
3. Alternative check from the shell:
   `docker exec camp-audit node scripts/check-mail.mjs someone@example.com`
4. Send the report: **Reports → Board Report → Email…**

---

## 9. Report state (no action needed — this part is finished)

Report #1 "September 2026", status `published`, period 2026-09-01 to 2026-09-30:

| | |
|---|---|
| Items | 20 |
| Photos selected | 26 — 4.22 MB as an email, under the 15 MB cap |
| Summary | 1,802 characters |
| Cost of work shown | $2,442.45 |
| Camp funds spent this period | $995.05 |
| Contributed (non-camp) | $1,300.00 |

A send over the size cap is **refused**, not attempted, because a bounce is harder to notice
than an error.

---

## 10. Already configured on the host

```
MAIL_FROM_ADDRESS   = cmms@fracturedrv.com
MAIL_FROM_NAME      = Camp Sychar Operations
BACKUP_ALERT_EMAIL  = cmms@fracturedrv.com
```

Also present and unrelated: `GOOGLE_OAUTH_CLIENT_ID/SECRET` (Calendar), `QUO_*` (SMS intake),
`SPACES_*` (object storage), `MAILGUN_SIGNING_KEY` (inbound mail), `DATABASE_URL`,
`SESSION_SECRET`.

**Never print a secret's value.** `scripts/check-mail.mjs` reports presence and length only.

---

## 11. Non-blocking loose ends

- One receipt, **$42.60**, is not linked to any work: counted as camp spend, attributed to no job.
- An empty second draft, report **#26**, exists — the shell created when #1 was published.
  Harmless; unpublishing #1 removes it automatically.
- **4 items were deleted** by a second publish. Unchecked items are dropped at publish and do not
  return; a refresh re-proposes them if they still qualify.
- A savings note reads "$277/month" while the stored record says $300, so the report states
  $3,600/yr. The record is authoritative; the note is prose the user can edit.

---

## 12. Working agreements with this user

- Real production data. **Additive migrations only**; no bulk edits to existing records without
  asking first.
- Investigate and report before changing anything whose correct behaviour is in question.
- Verify through the UI, not only the database. Clean up fixtures and temporary accounts.
- Secrets live in environment variables or the database — **never in source, docs, or logs**.
- `CLAUDE.md` in the repo root: before searching, building or deploying, run `git fetch` and
  confirm the local branch matches `origin/main`. Never conclude something does not exist from a
  checkout not confirmed current.
