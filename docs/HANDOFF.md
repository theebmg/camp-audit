# Handoff — where we are (2026-10-01)

Written for a fresh session with no memory of the conversation. Read this first, then
`docs/board-report-investigation.md`.

**Branch `text-intake`, in sync with `origin/main`. Last commit `946da1b`. Last migration
`0101`. Everything is deployed and live.**

---

## Right now: blocked on Ben, mid-way through the board report work

The current job is the **Board Report brief (Oct 2026)** — bug fixes and features for the
September report, which is the first one going to the camp board. It is **real data**.

Ben answered eight investigation questions in a decisions brief. **Step 1 of his ordering is
done and deployed.** Step 2 is blocked on a question put to him and not yet answered.

### The blocking question

His rule is **"totals are real money only — roll up actual cost, estimates never go into a
total."** Investigating that turned up:

| Line on the September report | Estimate | Actual | Allocated |
|---|---|---|---|
| Replace hinges on gate | $86.18 | — | $0 |
| Wall removal / beam | $800.00 | — | $0 |
| Drywall total cost | $440.00 | — | $0 |
| Replace Sump Pump | $379.00 | — | $0 |
| Install Dehumidifier | $180.00 | — | $0 |
| | **$1,885.18** | **$0.00** | **$0.00** |

**Every costed line is an estimate. Actual cost across the whole report is $0.** There are
$935.47 of real receipts, but **none is allocated to any job line**, so no work can claim any
actual cost. Applying his rule literally makes the report read $0.

Three options were put to him:

1. He splits the September receipts onto job lines first (the split editor exists), then roll
   up actuals. Most truthful; also unblocks funding source.
2. Roll up actuals now — September reads $0 recorded cost.
3. Show both, labelled: `$0 recorded · $1,885 estimated`.

Recommended 1 if he has twenty minutes, else 3 for this month and 1 before October's.

**Do not build the rollup until he answers.** He was explicit: don't change how a figure is
calculated until he confirms what it should be.

### Also waiting on him

- **Admin tasks have only `task_date`** — no completion date. His §7 wants start *and* finish
  on admin tasks so he can merge tasks 4 and 6 (the start and the end of one piece of work).
  Needs one additive column; he was asked and has not said go.
- **The correct recurring savings figure.** Stored is $270/month; his note says $277/month; his
  summary prose says "about $3,300 a year". Three numbers, one report.

---

## Two corrections he sent mid-work — honour these

1. **§5 savings:** do **not** change the existing savings record (id 2). Build UI so he can edit
   it himself — amount, period, and an old-cost/new-cost entry mode that computes the saving.
2. **§2b funding source:** do **not** reassign any existing expenses. Make funding source a
   field he sets per expense on the form and editable afterwards. He will mark the personal
   ones himself.

---

## What is done and deployed (step 1)

All in `946da1b`:

- **Footer counts only what is printed.** `visibleItems()` in `src/reportRender.js` is now one
  shared rule used by the sections, the grand footer and the text renderer. Relabelled
  "recorded cost of work shown".
- **Period defaults to a whole calendar month**, forward window anchored to `period_end` rather
  than today. Verified across year boundaries and February.
- **Both work-order code paths capture the same detail.** Rows carry a start date
  (`snap_start_date`, migration 0101) and read "Started 9/5 · Completed 9/23" or "… · In
  progress".
- **Cosmetics:** asset name no longer prints twice; admin category out of the title line (fixed
  at source *and* in the renderer, because the upsert's `COALESCE` cannot clear a stored value).
- **Ragged money table:** equal cell counts with a filler cell and `table-layout:fixed`.

**September now reconciles: 6 items counted, 6 printed, 3.5h.** Cost shows nothing because of
the blocking question above.

---

## Still to build, in his order

1. ~~Fixes 1, 4, 7, 8, ragged table~~ **done**
2. **Rollup of actual cost** — blocked, see above
3. **Funding source (§2b)** — propose schema + layout *before* building. Vocabulary seeded with
   Camp funds / Personal (Ben) / Donor / In-kind. Belongs on `expenses`. Note it cannot produce
   a per-WO breakdown until receipts are split onto lines.
4. **Progress on open WOs (§2c)** — weight by estimated cost of lines; fall back to listing
   lines completed this period when too few have estimates.
5. **Savings old/new cost entry (§5)** — UI only, per the correction above.
6. **Part 2 of the original brief** — photo selection, email-sized copies, before/after labels,
   rich text editor.

### Part 2 groundwork already answered

- **Image resizing shipped.** `src/storage.js`: 2000px long edge, JPEG q82, 400px thumbs, EXIF
  read before the re-encode. Only an *email-sized* copy (~1600px) is missing.
- **Photos can link to job lines with no migration.** `attachment_links.entity_type` already
  permits `job_line` in schema and in the JS allowlist (`ATTACHMENT_ENTITY_TYPES`); nothing uses
  it. UI work only.
- **Role vocabulary** is `attachment_roles`, admin-editable. `Before / Condition` and
  `After / Repair` already have `default_include_in_report = true` — so pre-selecting on *that*
  is simpler than special-casing "after", and uses the vocabulary rather than hardcoding.

---

## Hard-won gotchas — do not rediscover these

**Check constraints on `source` columns.** Adding a new source value means widening a CHECK.
`expenses.source` and `attachments.source` have both bitten (migrations 0098, 0100). The second
cost a fortnight of silently lost texted photos: fetched, resized, uploaded, then rejected at
the final INSERT while a `catch` logged a warning nobody read.

**Never swallow an ingest failure.** That bug was invisible because the handler caught and
continued. Failures are now recorded on the row (`incoming_items.media_error`).

**Snapshot upserts use `COALESCE(EXCLUDED.x, existing.x)`** — they can fill a null but can never
clear a stored value. If a field must be removed, fix the source *and* guard the renderer.

**Dry-run every migration** inside `BEGIN … ROLLBACK` against the live schema, with each
negative probe behind its own `SAVEPOINT` — a failed statement otherwise poisons the
transaction and hides every probe after it.

**Quo is OpenPhone.** Signature is `openphone-signature: hmac;1;<ts-ms>;<base64>`, HMAC-SHA256
over `"<ts>.<rawBody>"`, key **base64-decoded**. `req.rawBody` is stashed by the global
`express.json()` verify hook — reading `req.body` would compare against a re-serialised object.

**`cabin_holders` is cabin HOLDINGS, not people.** Derived from `assets.lodge_holder` by a sync
that runs before every list read. People live in `people`, joined by `cabin_holder_people`.
Never merge people by walking foreign keys alone — funding uses an unconstrained
`(funding_source, funding_ref_id)` pair that no key describes.

**Adding a screen to `NAV_ITEMS` is not enough** — it must also be in `DEFAULT_NAV_LAYOUT` or it
is invisible with no error. There is now a fallback that appends anything unplaced.

---

## Deploy and verify

```bash
# deploy
git push origin <branch>:main
ssh camp 'cd ~/camp-audit && git pull -q origin main && cd /root/nocodb \
  && docker compose build -q camp-audit && docker compose up -d camp-audit \
  && sleep 6 && docker exec camp-audit npm run migrate'

# tests, all against real data on scratch records they delete afterwards
docker exec camp-audit node scripts/merge-test.mjs      # 22 assertions
docker exec camp-audit node scripts/visits-test.mjs     # 35
docker exec camp-audit node scripts/intake-test.mjs     # 41

# browser verification (needs a temporary admin account; delete it afterwards)
BASE=https://audit.fracturedrv.com USER_NAME=<user> PASS=<pass> node scripts/screens.mjs <phase> [filter]
```

Standing rules from Ben: real data, additive migrations only, nothing destructive, no bulk
edits to existing records without asking, log questions in `docs/open-questions.md` as
"decided, pending Ben's review" and keep going, verify through the UI, clean up fixtures and
temporary accounts afterwards.

---

## Recently finished, for context

- **Text intake (Quo)** — webhook live and scoped to the camp line, Incoming inbox, four filing
  paths, Move-to, confirmation reply. **The allowlist is still empty**, so nothing is processed
  until Ben puts his cell number in Incoming → Text settings.
- **People & Groups, Visitor log** — built, tested, deployed.
- **Sessions** — `connect-pg-simple`, 90-day sliding; a deploy no longer signs him out.
- **Google Calendar "busy"** — not a bug. Events are correct on Google's side; the calendar is
  shared with his viewing account as free/busy only, and `campsychar.org` Workspace policy greys
  out the fix. He is deciding whether to move the sync to his own account; if the OAuth consent
  screen turns out to be Internal, he will need his own OAuth client (project number
  **691559247304** is the current one).
