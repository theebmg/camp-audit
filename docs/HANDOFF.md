# Handoff — Sychar Operations (camp-audit)

Written 2026-10-03 for a session with no memory of the work. **Read this first.**

---

## 1. Right now: one action away from done

**Goal: the camp board receives the September 2026 board report by email.**

| | |
|---|---|
| Report | #1 "September 2026", **published**, 20 items, 26 photos (4.22 MB as email), 1,802-char summary |
| Gmail | **Connected** 2026-10-03 16:25 as `ben@fracturedrv.com`, no errors |
| Sends as | `"Camp Sychar Operations" <cmms@fracturedrv.com>`, Reply-To `cmms@fracturedrv.com` |
| Emails actually sent | **0** |

**Everything is configured and verified. Nobody has pressed Send yet.**
Reports → Board Report → **Email…** A send over the 15 MB cap is refused, not attempted.

If Ben reports a failure, the reason is recorded at **Admin → Integrations → Email (Gmail)**
under "Last error", and in `mail_settings.last_error` — a toast is no longer the only copy.

---

## 2. The system

| | |
|---|---|
| App | CMMS at **https://audit.fracturedrv.com** |
| Stack | Node/Express + PostgreSQL + vanilla-JS SPA (`public-pg/app.js`, no bundler, one `<script>`) |
| Host | One DigitalOcean box, Docker Compose, behind Caddy. SSH alias `camp` |
| Containers | `camp-audit`; DB `nocodb-db`, database `camp` |
| Repo | `github.com/theebmg/camp-audit`. **Local branch is `text-intake`; it is pushed to `main`** |
| Env | `/root/camp-audit/.env`, mode 600, gitignored |

**Deploy** (every change, no exceptions):
```bash
git push origin text-intake:main
ssh camp 'cd ~/camp-audit && git pull --no-rebase origin main && cd /root/nocodb \
  && docker compose build -q camp-audit && docker compose up -d camp-audit && sleep 8'
# schema changes:
ssh camp 'docker exec camp-audit npm run migrate'
```

`git pull origin main` on the host needs `--no-rebase`: the host has a merge commit of its own
and plain `pull` refuses with "divergent branches".

---

## 3. Standing rules from Ben — these are not negotiable

- **Real production data.** Additive migrations only. No bulk edits to existing records without
  asking first.
- **Investigate before changing.** When behaviour is in question, report findings first.
- **Verify through the UI**, not just the database. Browser-checking has caught bugs that code
  reading did not, repeatedly.
- **Clean up** fixtures and temporary accounts afterwards.
- **Secrets in env vars or the database — never in source, docs or logs.**
- `CLAUDE.md` (repo root): *before searching, building or deploying, run `git fetch` and confirm
  the local branch matches `origin/main`. Never conclude something does not exist from a checkout
  you have not confirmed is current.*

**On tone:** Ben is a camp caretaker, not a cloud-console specialist. He has twice said the work
was over-complicated and once that Google steps were outdated. Lead with the answer. Say what to
do, not how it works, unless he asks.

---

## 4. Verification

```bash
ssh camp 'for t in board-report-test merge-test visits-test intake-test \
  report-photos-test report-photos-levels-test report-refresh-race-test; do \
  printf "%-30s " "$t"; docker exec camp-audit node scripts/$t.mjs 2>&1 | tail -1; done'
```

All seven pass. Each uses scratch records and deletes them, asserting the deletion.

- The two photo tests **SKIP** when the current draft has no photos — run them against report 1:
  `docker exec camp-audit node scripts/report-photos-test.mjs 1`
- `scripts/september-reconcile.mjs` — does the report add up, and are any charges double-counted
- `scripts/check-mail.mjs [address]` — mail config; prints presence and length, never values
- `scripts/report-sample.mjs [text|all|nofunding]` — renders the layout from synthetic data
- Browser: `BASE=... USER_NAME=... PASS=... node scripts/screens.mjs <phase>` (needs a temporary
  admin; delete it afterwards)

---

## 5. Hard-won gotchas — do not rediscover these

**A pass that stamps rows then deletes everything not stamped MUST be serialised.** Two
concurrent `refreshBoardReportSuggestions` deleted 17 of 21 real items, silently. Now behind a
Postgres advisory lock — taken with `pg_try_advisory_lock`, **never** blocking, because a
blocking wait holds a pool connection and deadlocks the pool.

**`COALESCE($n, column)` in an UPDATE can set a value but never clear one.** Bit
`attachment_links.role_id` ("no role" silently kept the old value) and the report snapshots.

**But replacing always is equally wrong.** A board-flagged job line is written by two passes, and
the second (which knows nothing about funding) wiped the first's work. Rule: **omitted means
keep, explicit null means clear.**

**A handler that awaits `api()` without a catch fails silently.** `api()` throws on non-2xx.
`saveErrorMessage()` / `showFieldError()` in `app.js` are the shared shape.

**Update local state from a PATCH response.** `patchReport` discarded it, so correctly saved
dates were repainted from a stale object and appeared to revert.

**`.btn` is `width:100%`.** A button inside a flex row goes off-screen. Use `.btn-inline` and
`.list-item-actionable`. **Playwright's `.click()` scrolls into view and hides this** — assert
the bounding box, or click without `force`.

**Object storage returns transient 503s.** Photo fetches retry three times; thumbnails retry in
the browser.

**`mailIsConfigured()` is async.** An un-awaited Promise is always truthy.

**Check constraints on `source` columns** have bitten twice (`expenses`, `attachments`).

**`cabin_holders` is cabin HOLDINGS, not people** — derived from `assets.lodge_holder` by a sync
that only ever INSERTs, never deletes.

**Adding a screen to `NAV_ITEMS` is not enough** — it must be in `DEFAULT_NAV_LAYOUT` too. Admin
screens go in `ADMIN_CATEGORIES`; put them in the right category or they will not be found.

---

## 6. Board report — how it works now

**Publish ≠ send.** Publish freezes the report as the copy of record, deletes unchecked items
permanently, clears board-focus flags, and opens a new empty draft. The confirmation says all of
this. **Unpublish** (admin only) restores the flags from a snapshot taken at publish; deleted
items do not come back.

Published reports are at **Past Reports** on the report screen, read-only behind a banner.

**Money rules (Ben's decisions):**
- Totals are **actuals only**; estimates print as `~$X est.` on open items and never sum.
- A work order's row rolls up its lines; **what is printed and what is counted are separate** or
  the roll-up and its lines double count.
- **Open work orders carry no money at all** on their row — no roll-up, no split, no
  percentage-of-estimate. Lines keep their own costs. Closed ones keep the roll-up.
- Footer: `Cost of work shown: $X` then a breakdown by funder. Any cost with no funder lands in
  **Unattributed** so the parts always add to the whole.
- Section headings carry no money.

**Funding precedence:** the receipt's fund → the split's own funding → the receipt's category →
the job line's own Funding Source (for work paid with no receipt at all).

**`show_funding`:** `off` / `non_general` (default) / `all`. Non-general tags everything except
the general operating budget — **earmarked camp funds are tagged**, while still counting as camp
spend. `show_hours`: per report, default off. Both inherit from the previous report.

**Approved Funds** block prints usage, remaining, days left and how much is not yet linked to
work. Per-report show/hide. One fund exists: Discretionary Audit Fund, $5,000.

---

## 7. Outstanding

**Needs Ben:**
1. **Press Send.** Nothing else blocks it.
2. **Rotate the OAuth client secret** — it was pasted into a chat transcript on 2026-10-02.
   Client `618947223294-dm17fa14…`. Add a new secret in Cloud Console, put it in `.env` as
   `GMAIL_OAUTH_CLIENT_SECRET`, delete the old.
3. One receipt, **$42.60**, is linked to no work: counts as camp spend, attributed to no job.
4. A savings note reads "$277/month" while the record says $300, so the report states $3,600/yr.
   The record is authoritative.

**Proposed, not built** (do not build without a decision):
- `docs/people-consolidation-proposal.md` — one people list; funders, visitors, cabin holders and
  volunteers as roles on a person. **Picker token matching and merge preview are small and
  independent — could ship any time.** The backfill would CREATE records, which needs explicit
  approval: no migration in this project has done that.
- `docs/funding-unification-proposal.md` — one funding vocabulary for receipts and job lines.
- `docs/hosted-photo-page-proposal.md` — recommendation was to hold.

**Known-harmless:** an empty second draft (#26) exists, the shell created when #1 published.
Unpublishing #1 removes it.

---

## 8. Other integrations

- **Text intake (Quo/OpenPhone)** — live, scoped to the camp line, fails closed. Allowlist has
  **1 entry**. Signature: `openphone-signature: hmac;1;<ts-ms>;<base64>`, HMAC-SHA256 over
  `"<ts>.<rawBody>"`, key **base64-decoded**; `req.rawBody` is stashed by the `express.json()`
  verify hook.
- **Google Calendar** — connected, separate OAuth client (project `691559247304`). Gmail uses its
  own (`618947223294`) so re-consenting one never affects the other.
- **Backups** — nightly 02:45 UTC, `pg_dump -Fc` to `/root/backups/` plus Dropbox, 30-day
  retention. Failures now email `BACKUP_ALERT_EMAIL`. **A full restore has never been rehearsed**
  — the procedure is in `docs/backup-and-restore.md`.

---

## 9. Migrations 0095–0114

People/groups/visits (0095–0096), text intake (0097–0100), report fields (0101, 0103–0105),
funding sources (0102), show_hours (0106), open lines (0107), show_funding (0108), job-line
funding kinds (0109), aggregate note (0110), general funding (0111), per-report funds (0112),
publish snapshot (0113), mail OAuth (0114).

**Always dry-run** inside `BEGIN … ROLLBACK` against the live schema, each negative probe behind
its own `SAVEPOINT` — a failed statement otherwise poisons the transaction and hides every probe
after it.
