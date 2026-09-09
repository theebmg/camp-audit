# Build Brief v2.1 — Corrections, Verification, and Backups

Camp Sychar CMMS. Follow-on to
`BUILD_BRIEF_v2_joblines_lifecycle_attachments.md`, all seven phases of
which are complete and deployed (migrations 0030–0051).

This brief covers four things, in priority order:

1. Replace IMAP polling with a Mailgun inbound webhook — a design decision
   changed after v2 was written. The IMAP code is dead; do not try to make
   it work.
2. Verify the Phase 1 rollups against hand-calculated values — the
   highest-risk unverified area in the whole refactor.
3. Automated database backups — before real field data enters the system.
4. Two small gaps from the v2 punch list.

Test data is still test data — destructive changes remain fine, no backfill
logic.

## Part 1 — Email ingest: IMAP → Mailgun webhook

### Why this changed

`BUILD_BRIEF_v2` §5.2 specified IMAP polling against `cmms@fracturedrv.com`.
That mailbox was never created and never will be. After the brief was
written, the decision changed to inbound webhook parsing on a dedicated
subdomain:

- `photos@cmms.fracturedrv.com` — a subdomain with its own MX records, so
  the root domain's existing Google Workspace mail is completely untouched.
- Mailgun receives, parses the MIME, and POSTs to our endpoint with
  attachments already extracted as multipart form fields.

This is a net deletion of code. No mailbox, no credentials, no polling
loop, no reconnect logic, no app passwords to expire.

Do not attempt to preserve or adapt the IMAP implementation. Delete it.

### What to remove

- `src/mailIngest.js` (or wherever the IMAP poller lives) — delete outright.
- The polling interval/scheduler that calls it.
- `imapflow`, `mailparser`, and any other IMAP-only dependencies — remove
  from `package.json` if nothing else uses them.
- `IMAP_*` variables from `.env`, `.env.example`, and any config validation.

### What to build

**Endpoint**

`POST /api/pg/mail-inbound` — public (no session auth; Mailgun is the
caller).

**Signature verification — do this first, and do not skip it**

This is a publicly-reachable endpoint that accepts file uploads. Mailgun
signs every request with `timestamp`, `token`, and `signature` fields.
Verify:

```
HMAC-SHA256(key = MAILGUN_SIGNING_KEY, message = timestamp + token) === signature
```

Reject with 401 on any mismatch. Also reject if `timestamp` is more than
~5 minutes old (replay guard). An unsigned or badly-signed request must
never reach the attachment-processing path.

New `.env` vars:

```
MAILGUN_SIGNING_KEY=<from Mailgun dashboard>
MAIL_INBOUND_DOMAIN=cmms.fracturedrv.com
```

**Payload handling**

Mailgun posts `multipart/form-data`. Relevant fields:

| Field | Use |
|---|---|
| `Message-Id` | → `attachment_batches.message_id` (UNIQUE — idempotency) |
| `subject` | → `attachment_batches.subject` |
| `body-plain` | → `attachment_batches.body_text` |
| `sender` / `from` | → `attachment_batches.sender_email` |
| `recipient` | route validation |
| `timestamp` | signature verification + `received_at` |
| `attachment-count` | number of attachment fields |
| `attachment-1`, `attachment-2`, … | the files, already extracted |
| `content-id-map` | JSON map identifying inline/embedded parts |

Attachments arrive as real multipart file parts. There is no MIME parsing
to do — that is the entire point of this change.

**Retries and idempotency — important**

Mailgun retries on any non-2xx response, so duplicate POSTs of the same
message are normal operation, not an error condition.

- `attachment_batches.message_id` UNIQUE is the guard. On conflict, return
  200 and do nothing else. Never create a second batch or re-upload
  attachments.
- Return 200 as soon as the batch and attachments are persisted.
- If storage upload fails, return a 5xx so Mailgun retries — but make sure
  a partial failure doesn't leave a batch row that then blocks the retry
  via the UNIQUE constraint. Either wrap the whole thing in a transaction
  that rolls back the batch row on failure, or write the batch row last.

**Everything downstream is unchanged**

Keep exactly as built in Phase 5:

- Batch creation, one email = one batch.
- Junk filtering at ingest: drop images under ~200px; drop parts identified
  as inline/embedded via `content-id-map` rather than genuine attachments.
- Subject shortcuts: `/\bWO\s*(\d+(-\d+)?)\b/i` attaches directly to that
  work order and skips the inbox.
- Fuzzy asset-name matching on the subject → top 3 suggestions, never
  auto-assign.
- "Use subject as work order title" checkbox, default ticked.
- The triage inbox, EXIF processing, GPS asset suggestion, all of it.

**Store the sender verdicts**

Mailgun includes SPF/DKIM results for the sender in the payload. Add
columns to `attachment_batches` and store them:

```sql
ALTER TABLE attachment_batches
  ADD COLUMN spf_result  text,
  ADD COLUMN dkim_result text;
```

Not used for filtering today — the mailbox is deliberately open. These are
what a whitelist or spam gate would gate on later, and they cost nothing to
capture now.

**Requirement this introduces**

The app must be publicly reachable at a stable HTTPS URL when mail
arrives. This was not a dependency under the polling design. Note it in
the runbook.

**Verification**

Send a real email with 3 photo attachments from a phone to
`photos@cmms.fracturedrv.com`. Confirm: batch row created, 3 attachments in
Spaces with thumbnails, EXIF `taken_at` and GPS populated, signature check
passing, and a deliberate replay of the same `Message-Id` creating nothing
new.

Also send one with "WO 1000" in the subject and confirm it bypasses the
inbox and lands on that work order.

## Part 2 — Verify the Phase 1 rollups

This is the highest-risk unverified area in the entire refactor, and its
failure mode is silent. Phase 1 moved `estimated_cost`, `actual_cost`,
`estimated_hours`, `actual_hours`, `funding_source`, and `funding_ref_id`
from `work_orders` down to `job_lines`, and rewrote the capital plan,
budget view, and dashboard to aggregate lines instead of work orders.

Nothing crashes if that arithmetic is wrong. It just produces a number on a
board report that is quietly incorrect — which is worse than a crash,
because it gets believed.

### Build a verification fixture

Write a script (`scripts/verify-rollups.js` or similar) that creates a
known scenario, asserts every derived number against hand-calculated
expected values, and prints a pass/fail table. Keep it in the repo — it
should be re-runnable after future changes.

**Scenario A — mixed funding on one work order**

One work order on one asset, three job lines:

| Line | Est. cost | Act. cost | Est. hrs | Act. hrs | Funding source | Status |
|---|---|---|---|---|---|---|
| Roof | 8000 | 8750 | 40 | 44 | capital_campaign | Done |
| Deck | 2000 | 1900 | 16 | 14 | cabin_holder | Done |
| Windows | 1000 | — | 8 | 2 | operating_budget | In Progress |

Assert:

- WO estimated cost rollup = 11000
- WO actual cost rollup = 10650
- WO estimated hours = 64, actual hours = 60
- Cost-weighted progress = 10000/11000 = 90.9% (lines with a
  counts_as_work_performed status, over total estimated)
- Line-count progress = 2/3
- Capital plan shows 8750 under capital_campaign for this asset — not
  10650, and not the whole WO under one source
- Budget view shows 1900 under that cabin holder and 0 actual under
  operating budget (windows has no actual cost yet)
- Dashboard totals match the sum across all three

**Scenario B — crew session hours**

Add to Scenario A:

- One `crew_sessions` row, 6 hrs, `job_line_id` = Roof
- One `crew_sessions` row, 4 hrs, `job_line_id` = NULL (WO-level)

Assert:

- Roof line actual hours includes the 6
- WO actual hours total includes both (10 hrs from sessions)
- The null-line 4 hrs is excluded from any line-level percentage
  calculation
- No line shows inflated hours from the unattributed session

**Scenario C — split integrity**

Split the Windows line off Scenario A into a child WO.

Assert:

- Parent WO rollup = 10000 est / 10650 act (Windows removed)
- Child WO rollup = 1000 est / 0 act
- Family rollup via `split_root_id` = 11000 est / 10650 act — i.e.
  identical to the pre-split parent total. A split must not change the
  family total.
- Windows' attachments, crew sessions, and `condition_finding_id` moved
  with the line
- Parent WO can now close (no non-terminal lines remain), and prompts for
  review rather than auto-closing
- Child `wo_number` is `<root>-2`, parent stays unchanged

**Scenario D — Not Needed vs Done**

Set the Deck line to Not Needed instead of Done.

Assert:

- WO still closes (terminal status, gate is "no non-terminal lines")
- Work Performed report excludes Deck (`counts_as_work_performed = false`)
- Cost-weighted progress excludes Deck's 2000
- Report language distinguishes completed from determined-unnecessary

### If any assertion fails

Fix the aggregation, not the test. The expected values above are
arithmetic, not opinion.

## Part 3 — Database backups

Priority: do this before any real field data is entered. Today the
database holds test data and losing it costs nothing. Within weeks it will
hold condition observations that can only be regenerated by physically
re-walking 337 buildings. That data is genuinely irreplaceable.

### Build

`scripts/backup.sh` (or a Node equivalent if that fits the deploy better):

- `pg_dump` the database, custom format (`-Fc`), gzipped.
- Filename `sychar-YYYY-MM-DD-HHMM.dump.gz`.
- Upload to a separate Spaces bucket from attachments — not a folder in the
  same bucket. A credential compromise or fat-fingered bucket delete should
  not take both.
- Delete remote backups older than 30 days.
- Log success/failure with a timestamp somewhere you'll actually see it.

Nightly cron. Credentials from `.env`, never hardcoded.

Reuse the S3 client in `src/storage.js` if convenient, but the backup
script is allowed to talk to Spaces directly — it is operational tooling,
not app code, and the portability boundary is about the application.

### Then actually test the restore

An untested backup is a rumor. Restore one dump into a scratch database,
run the app against it, and confirm the data is there and the app boots.
Document the exact restore command in the runbook so it can be run under
pressure without thinking.

### Note in the runbook

Spaces objects (the attachments themselves) are not covered by this.
Spaces has its own durability and photos are less catastrophic than the
structured data, but this should be stated explicitly rather than assumed.

## Part 4 — Punch list

Lower priority than Parts 1–3. Do them after, or when convenient.

### 4.1 Report image over-cap reselection

`BUILD_BRIEF_v2` §6.3 specifies that when more images qualify for a report
than the per-WO embed cap allows, the user selects which are embedded.
Auto-pick currently stands in. Build the selection UI: show all qualifying
images for the WO, let the user tick up to the cap, remainder fall back to
links.

### 4.2 GPS-distance refinement in EXIF clustering

Clustering is currently time-only. Add distance: photos within ~10 minutes
and ~100 feet cluster together. Photos lacking GPS fall back to time-only
rather than being excluded. Low value relative to the nearest-asset
suggestion, which already works — do it last.

### 4.3 Not doing

The hard-delete reaper for voided attachments stays unbuilt. The brief
marks it low-priority and it remains so — voided files sitting in Spaces
cost pennies.

## Working instructions

- Part 1 first, then Part 2, then Part 3. Stop after each and report before
  continuing.
- Before writing Part 1 code, tell me what you find in the existing IMAP
  implementation and confirm what's being deleted.
- Do not re-litigate settled design. If something is impossible or
  self-contradictory, stop and say so.
- Preserve the portability boundaries: `src/db.js` is the only module that
  knows SQL; `src/storage.js` is the only module in the application that
  knows S3/Spaces.
- Smoke-test against the live system rather than relying on code review —
  that practice caught the `wo_number` and GPS NaN bugs and should
  continue.
- Update `update-for-claude.md` as touch-points change, and correct the
  stale IMAP section of `BUILD_BRIEF_v2` (or mark it superseded by this
  brief) so the repo doesn't carry a design that was abandoned.
- Migrations continue from 0052, same comment style — explain why, not
  just what.
