# Runbook: Inbox, Email Ingest, Splitting (Build Brief v2, Phase 5)

Phase 5 landed 2026-09-09. Migrations 0048–0049.

## What changed
- **Critical fix caught by smoke-testing, not by inspection**: migration
  0048 makes `work_orders.wo_number`/`split_root_id` `NOT NULL`, but the
  three places that raw-INSERT into `work_orders`
  (`createWorkOrder`/`duplicateWorkOrder` in db.js; `splitWorkOrder` itself
  was written correctly from the start) didn't set them — every new WO
  creation would have thrown a constraint violation in production. Fixed by
  fetching `nextval(pg_get_serial_sequence('work_orders','id'))` before the
  INSERT so `id`, `wo_number` (defaults to the id as text), and
  `split_root_id` (self-pointing — a fresh WO is its own unsplit root) can
  all go in one statement. `createWorkOrderFromTemplate` (PM
  auto-generation) and `convertRequestToWorkOrder` both already route
  through `createWorkOrder`, so they're covered without their own fix.
  **If you add a fourth place that creates a work order, it must go through
  `createWorkOrder` — never a bare `INSERT INTO work_orders` again.**
- **Splitting** (§5.4): `splitWorkOrder(woId, jobLineIds)` in db.js — only
  on a non-terminal WO, moves the given lines to a new child
  (`work_order_id` UPDATE only; their hours/cost/crew/status/attachments/
  finding links travel for free since nothing else points at the WO, it
  points at them). `wo_number` is always the next flat suffix off
  `split_root_id` ("1000-2", "1000-3", ...), computed from the max existing
  suffix among siblings, never nested. `getWorkOrderFamily(woId)` returns
  every sibling off the same root plus a combined cost/hours total — one
  query on the indexed `split_root_id`, not a recursive walk. WO detail page
  gained a "Split Selected Lines" button (checkbox per job line, reuses
  `.jl-split-select`) and a "Family" toggle panel. The WO grid
  (`renderWorkOrders`) defaults to roots-only with a "+N splits" chip that
  expands children inline; "Show all splits flat" checkbox bypasses grouping.
- **Triage inbox** (§5.3): `listInboxBatches()`/`getInboxCount()` in db.js;
  `renderInbox()` in app.js, grouped by batch, per-batch multi-select
  checkboxes, action row (Create WO / Add to Existing WO / Add to Job Line /
  New Finding / File to Asset reference-only / Void). Void has no confirm
  dialog by design (matches the single-attachment `voidAttachment` from
  Phase 4). EXIF-cluster "select this cluster" chips group a batch's photos
  by `taken_at` proximity (≤5min gaps) — **time-only, not GPS-distance
  refined**; the brief's "80 feet apart" framing implies a GPS check too,
  documented as a follow-up below, not implemented. Nearest-asset-from-GPS
  and fuzzy subject-match asset suggestions
  (`suggestAssetsForText`/`nearestAssetsToGps`) surface as tappable chips in
  every action panel that needs an asset — never auto-assigned.
- **Email ingest** (§5.2): new `src/mailIngest.js` (isolated from
  `mailer.js` the same way `storage.js` is isolated for S3 — only module
  that knows IMAP), polled every 5 minutes from `server.js` via
  `setInterval`, no-ops silently when `IMAP_HOST`/`IMAP_USER`/
  `IMAP_PASSWORD` aren't set (mirrors `mailIsConfigured()`'s convention).
  **Not yet exercised against a live mailbox** — there were no IMAP
  credentials available this session to test with; the code is written
  carefully against imapflow's documented API and is defensive at every
  step (a bad poll logs and returns, never crashes the server), but the
  first real poll once `cmms@fracturedrv.com` credentials are in `.env`
  should be watched. Subject `/\bWO\s*(\d+(-\d+)?)\b/i` skips the inbox
  entirely and attaches straight to that WO (looked up by `wo_number`, so
  it works for both split children like "1000-2" and plain ids). Junk
  filter drops inline/related MIME parts and images under 200px on both
  edges before they ever reach the inbox.
- **Map GPS calibration** (§5.3): `map_calibration_points` table (0049),
  exactly 3 points enforced at the `createMapCalibrationPoint` layer (a 4th
  insert is rejected — delete one first). `solveAffine`/`gpsToMapPixel` in
  db.js solve the 6-parameter affine transform via Cramer's rule on a fixed
  3×3 system, recomputed live from whatever points are stored (no caching)
  so editing a point takes effect immediately. Admin page at Admin → System
  → Map GPS Calibration. **Caught and fixed during smoke-testing**: the
  first version compared `p.lat`/`p.mapX` (lowercase) against
  `listMapCalibrationPoints()`'s actual `Lat`/`MapX` (PascalCase) output,
  silently producing `NaN` for every calibrated point — verified fixed with
  a live 3-point round-trip before considering this phase done.

## Known gaps / follow-ups
- EXIF clustering is time-only (≤5min gaps), not the brief's full
  "shot within 4 minutes, 80 feet apart" — a GPS-haversine-distance check
  should join the time check once there's real GPS-tagged test data to
  verify against (there wasn't any this session).
- Email ingest is unverified against a live mailbox — see above. Test the
  first real poll once IMAP credentials exist; watch the container logs
  (`mailIngest: poll failed: ...` / `mailIngest: failed to ingest a
  message`) for anything imapflow's actual server behavior didn't match the
  documented API this was written against.
- No sender whitelist on email ingest (§5.2, settled/deliberate for now) —
  `ingestOneMessage` is the single place to add one later.
- Hard-delete reaper for `deleted_at`-older-than-30-days attachments is
  still not built (same low-priority gap noted in Phase 4).

# Runbook: Attachments (Build Brief v2, Phase 4)

Phase 4 landed 2026-09-09. Migrations 0044–0047. Read this before touching
any photo/document upload path anywhere in the app — every one of them now
goes through the same system.

## What changed
- Nine separate photo loci (`assets.legacy_photos`, `asset_photos`,
  `asset_components.photo_url`, `condition_findings.photo_urls`/
  `legacy_photos`, `work_orders.legacy_photos`, `work_order_photos`,
  `work_order_task_photos`, `maintenance_request_photos`,
  `asset_notes.photo_url`) are gone, dropped in 0047 with no data migration
  (all test data, per the brief). Three of the nine were already dead
  (jsonb columns with no read/write path anywhere) — found during the sweep,
  not previously documented.
- Replaced by two tables (0046): `attachments` (the file + metadata: url,
  thumb_url, kind, mime_type, dimensions, caption, classification, EXIF
  taken_at/gps, triage_status, deleted_at) and `attachment_links` (the
  many-to-many join: entity_type/entity_id, role_id, include_in_report,
  sort_order, plus quote-only columns for Phase 6). One file can be linked to
  several entities at once — e.g. a finding photo that's also the job line's
  before-shot.
- **Deviation from the brief as written**: §4.4 specifies a new
  `component_types` table for photo classification. That table already
  exists under a different name — `component_type_catalog` (migration
  0002), which backs the live "Component Types" admin page and is the exact
  vocabulary component_sub_areas/asset_components already use. Creating a
  second table would have caused the exact drift §4.4 warns against, so
  `attachments.classification` is a `text` FK straight to
  `component_type_catalog(component_type)` instead of a new surrogate-id
  table. No `component_types` table exists — don't add one.
- `attachment_roles` (0045, admin-editable, Admin → Work Orders →
  Attachment Roles) is what/why — Before/After/Evidence/Quote/etc.
  `attachment_batches` (0044) exists as schema-only groundwork for Phase 5's
  email ingest — nothing writes to it yet.
- `src/storage.js` grew from one function (`uploadPhoto`) to
  `storeAttachment()`: images are resized to a 2000px long edge at quality
  82 with a 400px thumbnail generated alongside (both re-encoded to JPEG
  regardless of source format), EXIF `DateTimeOriginal`/GPS are read from
  the *original* buffer before resize strips it (via `exifr`), documents
  pass through unresized with no thumbnail. New deps: `sharp`, `exifr`.
- `src/db.js`: `listAttachmentsForEntity`/`listAttachmentsForEntities` (bulk,
  N+1-safe) read; `createAttachment` (unlinked) + `linkAttachment` +
  `createAndLinkAttachment` (the common upload+link-in-one-transaction path)
  write; `updateAttachmentLink` edits role/classification/caption/
  include-in-report/quote fields; `detachAttachment` removes one link;
  `voidAttachment` soft-deletes everywhere at once (cascades link removal,
  sets `deleted_at`+`triage_status='void'`, file untouched in Spaces — no
  confirm dialog by design, see its comment). Admin CRUD for
  `attachment_roles` mirrors `listCauses`/`createCause`/etc exactly.
- `POST /api/pg/attachments` (multipart) is now the single ingest route for
  everything, replacing the old generic `/api/pg/upload` plus five
  locus-specific photo routes. Omitting `entityType`/`entityId` uploads
  **unlinked** — required for the audit form and the public
  maintenance-request portal, where the row a photo belongs to (a finding, a
  component event, the request itself) doesn't exist yet at upload time;
  `submitAudit`/`createAssetNote`/`createMaintenanceRequest` accept
  `attachmentIds` and link them server-side, inside the same transaction
  that creates the parent row. Max upload size is now 25MB everywhere
  (brief §4.5), up from 15MB (8MB on the public portal).
- Frontend: one shared widget, `renderAttachmentSection(entityType,
  entityId, container, opts)` in `public-pg/app.js`, used everywhere a
  photo/doc attaches to something — asset reference photos, per-finding
  photos, per-component-event photos (history view), job-line photos, a new
  WO-level "Documents" card (permits/invoices not tied to one line — work
  photos still default to the job line per §4.2), maintenance-request
  photos, asset-note photos. Capture is zero-decision (tap "+ Add", camera
  opens, done); tapping an existing thumbnail opens an edit panel
  (role/classification/caption/include-in-report/Detach/Void) — role and
  classification are never prompted for at capture time, matching the
  brief's "classification happens later at a desk." `state.options` (the
  `/api/pg/options` bundle, loaded once at login) now carries
  `attachmentRoles` so the widget never needs its own fetch for the roster.
- Component-event attachments (`entity_type = 'asset_component'`) get their
  `classification` pre-filled from the event's own `component_type` at
  upload time — the one case where a guess is never wrong, since it isn't a
  guess (§4.4).

## Known gaps / follow-ups
- Quote fields (`vendor_id`/`quoted_amount`/`quote_date`/`is_selected_quote`
  on `attachment_links`) exist in the schema but have no UI yet — that's
  explicitly Phase 6 work (§6.4) per the brief's own phase split; don't add
  it early, the report-side consumption (Quote Comparison, "Quotes
  received" count) needs to land at the same time.
- Hard-delete reaper (purging `deleted_at`-older-than-30-days rows and their
  Spaces objects) is not built — the brief marks it optional/low-priority.
  Voided files currently sit in Spaces forever with no automated cleanup
  (same as the pre-existing orphan risk from any DELETE that isn't a void).
- `POST /api/pg/attachments` doesn't yet enforce the whitelist of valid
  `entityType` values at the HTTP layer beyond what `linkAttachment` checks
  server-side (400 on an unknown type) — fine functionally, just means a
  bad request surfaces as a 500-shaped error path one layer lower than
  ideal. Low priority.
- EXIF GPS/`taken_at` extraction is wired and tested (`storeAttachment`
  reads both from the original buffer before resize), but nothing in the UI
  surfaces them yet — Phase 5's nearest-asset-from-GPS triage suggestion and
  EXIF-clustering are what actually consume these columns.

# Runbook: Findings Lifecycle (Build Brief v2, Phase 3)

Phase 3 landed 2026-09-09, same session as Phases 1-2. Migration 0043.
`condition_findings.status` stays a plain text column (not a table like
work order/job line status) — the brief only asks for these five fixed
values, not an admin-editable catalog, so a CHECK constraint is enough.

## What changed
- Lifecycle: `Open` (insert, unchanged) → `Scheduled` (auto, the instant a
  job line's `condition_finding_id` points at it —
  `autoScheduleFindingIfLinked` in db.js, called from both `createJobLine`
  and `updateJobLine`) → `Resolved` (auto, the instant that job line reaches
  a `counts_as_work_performed` status — `autoResolveLinkedFinding`, called
  from `changeJobLineStatus`) or `Deferred`/`Dismissed` (manual, via
  `deferFinding`/`dismissFinding`, both requiring an explanation enforced
  server-side, both stamping `reviewed_by`/`reviewed_at`).
- **`job_lines.condition_finding_id` has no UI to set it yet** — nothing in
  Phases 1-3 creates a job line pre-linked to a finding. That's Phase 7
  ("Create WO from findings"). The db.js plumbing (createJobLine accepts
  `conditionFindingId`, updateJobLine accepts `condition_finding_id`) is
  ready for it; there's just no button yet.
- Asset Detail's Findings card (the only place findings are visible at all —
  there's still no dedicated finding detail view) gained a status pill and
  inline Defer/Dismiss mini-forms, and shows the deferred/dismiss reason
  once decided.
- Dashboard gained a Findings widget: Open count ("should trend to zero")
  and count of findings not linked to any job line (the data-quality
  signal) — `GET /api/pg/findings-summary`.
- **Found and fixed a pre-existing bug while sweeping for Phase 2 fallout**:
  `listMapPins`/`listMapFeatures` in db.js had raw SQL filtering work orders
  by `status NOT IN ('Completed', 'Cancelled')` — those status names never
  matched the app's real ones ('Done'/'Cancelled'), so the map's board-focus
  aggregation was silently always-false even before this rework. Both now
  join `work_order_statuses` and filter on `NOT is_terminal`.

## Known gaps / follow-ups
- No dedicated Findings report source in Reports v1 yet (only the Assets
  report's "Flagged"/"Flagged Fields" columns, which only ever looked at
  Open findings — untouched by this phase, still correct). The Deferred
  Maintenance Backlog and "Open Findings Not On Any WO" named reports are
  explicitly Phase 6 work; the columns this phase added
  (`deferred_reason`/`revisit_date`/`dismiss_note`) are what Phase 6 reads.

---

# Runbook: Lifecycle & Status (Build Brief v2, Phase 2)

Phase 2 landed 2026-09-09, same session as Phase 1. Migrations 0040–0042.
`work_orders.status` and the old `done` boolean on `job_lines` are both
**gone** — both are now `status_id` FKs into admin-editable tables.

## What changed
- `work_order_statuses` (Reported/Assessed/Scheduled/In Progress/Done/
  Deferred/Cancelled — Done/Deferred/Cancelled terminal). `work_orders.
  status_id` replaces `status`. **Urgent is gone as a status** (it's a
  priority); **On Hold is gone as a status** (blocked lives on the job line).
- `job_line_statuses` (Not Started/In Progress/Waiting on Parts/Waiting on
  Approval/Waiting on Weather/Done/Not Needed/Cancelled). `job_lines.
  status_id` replaces the `done` boolean entirely — there is no `Done`
  column anymore, only `StatusId`/`StatusName` (check `IsTerminal`, not a
  boolean, to ask "is this line finished").
- **Every status transition, on either table, writes a
  `work_order_log_entries` row automatically** — `changeWorkOrderStatus` and
  `changeJobLineStatus` in db.js are the *only* two places either
  `status_id` column is ever written; nothing else may update them directly.
  A job-line status with `requires_note = true` throws (400) unless a
  `statusNote` is supplied — enforced server-side, not just in the UI.
- `work_orders.deferred_reason`/`revisit_date` are required together the
  moment status becomes 'Deferred' (enforced in `changeWorkOrderStatus`) and
  cleared automatically on any other status change.
- `workOrderCloseGate(woId)` (db.js) answers "can this WO close" — true once
  every job line is terminal (not "all Done"; Not Needed counts). It never
  auto-closes anything; the WO detail page shows a banner suggesting review
  when true, but the manual "Complete Work Order" button is always available
  regardless.
- `display_settings.wo_progress_weighting` (single row, 'cost' or 'count')
  drives the WO grid's segmented progress bar — `JOB_LINE_STATUS_BREAKDOWN_SQL`
  in db.js computes the per-status cost/count breakdown embedded into
  `listWorkOrders()`'s rows (`StatusBreakdown`, `PercentCompleteCost`,
  `PercentCompleteCount`, `TerminalLineCount`). Admin toggle lives on the
  Work Order Statuses admin page.
- Status pills everywhere read a literal `color` off the row (`StatusColor`
  on WOs, job lines, and calendar/job-line-scheduled entries) via
  `statusPillHtml`/`statusColorStyle` in app.js — there is no hardcoded
  name→CSS-class map left for work order or job line status. The Capital
  Plan budget page's item pills are the one exception (neutral, no color
  plumbed through `getBudgetOverview` yet — low-value to add, `Status` there
  is just a display string).
- `WO_STATUS_OPTIONS` is gone from both `reports.js` and `app.js`. Reports
  v1's Status/Status Change columns derive their filter checkboxes from
  whatever names actually appear in the exported rows (`columnDefsFromRows`'
  "distinct" path) instead of a fixed list, since `reports.js` deliberately
  has no DB access to fetch the live catalog itself.

## Known gaps / follow-ups
- Job-line status-change log entries can't set `job_line_id` on the log row
  yet — same pending-migration-0037 blocker as Phase 1 (see that section
  below). The line's title is folded into the note text instead.
- `getBudgetOverview`'s itemized Capital Plan rows don't carry a status
  color (`Status` is a bare name there) — cosmetic gap, not a correctness
  one.

---

# Runbook: Job Lines (Build Brief v2, Phase 1)

Phase 1 of `toClaudeCode/BUILD_BRIEF_v2_joblines_lifecycle_attachments.md` landed
2026-09-09: `work_order_tasks` was renamed to **`job_lines`** and became the
real unit of work — hours, cost, funding, responsibility, scheduling, and
crew assignment all moved off `work_orders` onto it. Migrations 0030–0039
(0037 pending — see below). Read this before touching work orders, job
lines, calendar, budget, or reports code; the shape changed everywhere.

## What moved, and where it lives now
- `job_lines` (was `work_order_tasks`): `title` (was `description`),
  `estimated_hours/actual_hours/estimated_cost/actual_cost`,
  `funding_source/funding_ref_id`, `scheduled_date`, `responsibility_class`
  (`self`/`volunteer`/`vendor`/`cabin_holder` — replaces the old
  `work_orders.responsible_self` boolean), `complaint/cause_note/correction`,
  `blocked_reason/blocked_since/completed_date`, `condition_finding_id`.
- `job_line_volunteers`/`job_line_vendors` replace
  `work_order_volunteers`/`work_order_vendors`. "Assigned crew" is a per-line
  concept now — there is no WO-level crew list anymore. `getWorkOrderCrewRoster`
  in db.js (union across a WO's lines) backs the crew-session attendee picker.
- `work_orders` keeps only what's true of the whole job: asset/location/
  priority/status/dates/description/board_focus. Its cost/hours/schedule are
  **derived rollups, never stored** — `workOrderRollup(woId)` in db.js is the
  single-WO version (with a per-funding-source breakdown); `listWorkOrders()`
  and every list-shaped read path embed the `JOB_LINE_ROLLUP_SQL` subquery
  instead of calling that function in a loop. **If you add a new place that
  reads WO-level cost/hours/schedule, it must go through one of these two —
  never re-add a column to `work_orders` for this.**
- `causes` (admin-editable, seeded with "Unknown" first) + `job_line_causes`
  is the multi-select a job line's Cause field reads. `cause_note` is
  freetext and must **never** feed back into `causes` — no "add as new
  option" anywhere, ever. Managed at Admin → Work Orders → Causes.
- `crew_sessions.job_line_id` and `work_order_log_entries.job_line_id` are
  both nullable — genuine WO-level time/notes still exist and shouldn't be
  forced onto one line.
- `calendar_events.job_line_id` (was `work_order_task_id`) and
  `work_order_task_photos.job_line_id` (was `task_id`) were repointed/renamed
  in migration 0038, not just retargeted — the columns are named for what
  they reference now.
- `work_order_templates.job_line_defaults` now holds partial job-line objects
  (`{title, responsibilityClass}`), and the **old** `job_line_defaults`
  (asset-update blueprints) was renamed to `asset_update_defaults`. Don't
  confuse the two — this exact collision (two different things both called
  "job line") is why the rename happened; see migration 0039's comment.
- The Board report (`reportDataPg.js`'s `buildBoardReportPg`, fed by
  `getBoardReportRawData` in db.js) and Reports v1's Work Orders export
  (`getWorkOrdersReportRawData`) both now aggregate from `job_lines` — a WO's
  funding/cost/hours can legitimately span more than one value.

## Known gaps / follow-ups
- ~~`work_order_log_entries.job_line_id` migration (0037) is unapplied~~ —
  **resolved 2026-09-09.** Ownership drift fixed (`ALTER TABLE ... OWNER TO
  camp_app` run as the `nocodb` superuser role against the `camp` database)
  for all 10 affected tables — the 8 originally listed here plus
  `activity_log` and `work_order_log_entries` itself, which the earlier
  sweep undercounted. Migration 0037 is now applied. Job-line status-change
  log entries can be tagged with `job_line_id` going forward.
  **How to run migrations against this host:** the running `camp-audit`
  container's image does not include `scripts/` or `migrations/` (see its
  `Dockerfile` — only `src`/`public`/`public-pg` are copied), and
  `nocodb-db` publishes no host port, so `npm run migrate` from the bare
  host fails both for missing env and for DNS. Use a throwaway container on
  the compose network instead:
  `docker run --rm --network nocodb_default -v /root/camp-audit:/app:ro -w /app -e DATABASE_URL="$(grep DATABASE_URL /root/camp-audit/.env | cut -d= -f2-)" node:22-alpine node scripts/migrate.js`
- `job_lines.status_id` (and the `job_line_statuses` table it references) is
  Phase 2 work, not Phase 1 — see the brief's own 1.3/2.1 split. Job lines
  currently have no status field at all beyond the boolean `done`.
- Job-line-level responsibility assignment only captures the **class**
  (self/volunteer/vendor/cabin-holder) at WO-creation time; picking the
  *specific* volunteer/vendor happens afterward on the WO detail page, same
  deferral the app already used pre-Phase-1 for `responsibleSelf`/crew.
- The old WO-level funding combobox (search + inline "create new") was
  retired — job lines pick funding refs from a plain `<select>`. Creating a
  brand-new Capital Campaign Project / Cabin-Holder / Other category happens
  on the Capital Plan page, which already has full CRUD for all three.
- `duplicateWorkOrder` now actually copies job lines (title/responsibility/
  funding/estimates, not actuals or crew) — previously its comment claimed
  to but the code didn't.

---

# Runbook: Adding a New Asset Property

*(e.g. "Window Type", "HVAC Type", "Flooring") — Camp Sychar CMMS on NocoDB*

This is the checklist for adding a new **asset property** — a stable fact about
an asset that you track and keep current (like Roof Material or Has Key), and
that a Work Order can change on completion.

Keep this current. Every time the system grows, the number of places a change
touches grows too; this file is what stops you chasing your tail later.

---

## Definitions (so you put things in the right place)

- **Asset property** → a stable fact about the asset. Lives as a column on the
  **Assets** table. Examples: Roof Material, Has Key, Window Type.
- **Finding** → something observed during an inspection. Lives on **Condition
  Findings**. Not this runbook.
- **A change a Work Order makes** → recorded as an **Asset Updates** row linked
  to that WO. The completion logic writes it into the asset property.

If the new thing is a *stable fact about the asset*, it's an asset property and
this runbook applies.

---

## The manual checklist (works today)

To add one new asset property — call it **Window Type** as the running example —
touch these places, in order:

### 1. Assets table — add the column
- Assets table → **+ New field**
- Name: `Window Type`
- Type: **Single select** (use single-select for a fixed set of values; use
  text only if truly freeform)
- Options: e.g. `Single-Pane / Double-Pane / Storm / None / Unknown`
- Always include **Unknown** (and **N/A** where "doesn't apply" is real), so you
  can save without guessing and later filter for what's still unaudited.

### 2. Asset Updates table — add it as a Target Field option
- Asset Updates table → open the **Target Field** single-select field → **add
  the option** `Window Type`
- **The option label MUST exactly match the Assets column name** (`Window Type`
  = `Window Type`). The write-back matches by name; a mismatch means the update
  silently writes nothing.

### 3. The audit form (if you capture this field during walkthroughs)
- If you want to record Window Type during a building walkthrough, add the field
  to the relevant **form view** and set any conditional-display rule (e.g. show
  only when Free-Standing Building = Yes).
- Skip if it's not something you capture in the field.

### 4. The WO interface (when it exists)
- **If the interface hard-codes the list of asset fields anywhere**, add
  `Window Type` there too.
- **If the interface reads fields dynamically** (see next section), you touch
  NOTHING here — this is the whole point of building it that way.

### 5. Dashboards / views (optional)
- If you want to group or report by the new property, add it to the relevant
  grid/dashboard views. Optional, do it when you actually need the report.

---

## The chase-your-tail failure modes (what this runbook prevents)

- **Added the Assets column but not the Asset Updates option** → WOs can't
  declare a change to it; write-back never fires for that field.
- **Names don't match exactly** → the write-back matches Target Field label to
  Assets column name. `Window Type` vs `Windows` = silent no-op. Match them
  character-for-character.
- **Hard-coded the field list in the interface** → every new property needs a
  code change. Avoid by reading the schema dynamically (below).

---

## The goal: a schema-driven interface (less chasing, build toward this)

Your instinct — "an interface that just knows what to update based on what I'm
adding" — is the right architecture. The idea: instead of hard-coding
`["Roof Material", "Has Key", ...]` in your app, the app **asks NocoDB what
fields the Assets table has** at runtime, and builds its dropdowns from that.

### How it works
NocoDB's meta API returns a table's full field list. Fetch the Assets table's
fields, filter to the ones you consider "editable asset properties," and use
that list to populate:
- the **Target Field** dropdown when creating an Asset Update
- any field pickers in the WO or audit interface

Then **adding a column to Assets automatically makes it available everywhere** —
step 1 of the manual checklist becomes the ONLY step. Steps 2 and 4 disappear.

### The meta endpoint
```
GET https://nocodb.fracturedrv.com/api/v2/meta/tables/{ASSETS_TABLE_ID}
  header: xc-token: <your token>
```
Returns JSON including a `columns` array — each with `title`, `uidt` (field
type, e.g. `SingleSelect`), and for selects the available options under
`colOptions`. Your app reads this to know both *which* fields exist and *what
values* each accepts.

### How to mark which columns are "asset properties"
Not every Assets column is an editable property (Name, Location, rollups
aren't). Two clean ways to let the app know which to include:
- **Naming/description convention** — put a marker in each property field's
  *description* (NocoDB fields have descriptions), e.g. `@asset-property`, and
  have the app include only fields whose description contains it. Most flexible.
- **A hardcoded exclude list** — simpler: include all single-selects except a
  known set (Name, Asset Type, Condition if you treat it specially, etc.). Less
  precise but easy.

The description-marker approach means: to add a new editable property, you add
the column AND put `@asset-property` in its description — and the whole system
picks it up. That's as close to "it just knows" as it gets.

### Validating the New Value against allowed options
Because the meta response includes each select's options, the interface can
validate that a New Value is actually one of the target field's allowed values
BEFORE saving the Asset Update — catching typos at entry instead of at
write-back. This is the payoff of reading options dynamically.

---

## Where the reference IDs live
Base and table IDs (for API calls) are recorded in your memory / project notes:
- Base: `p0rfnut85c1hmpa`
- Assets table: `mcwn0dntwh9sani`
- Work Orders: `m828b9fafbkim2k`
- Condition Findings: `mwjnwa9me35w92i`
- (Asset Updates: get its table ID from the meta `/tables` list once created)

---

## TL;DR

- **Adding a property today (manual):** Assets column → matching Asset Updates
  Target Field option → (form if captured) → (interface if hard-coded) →
  (views if reported on). Names must match exactly.
- **The fix for the chasing:** build the interface to read the Assets schema
  from the meta API and mark editable properties with an `@asset-property`
  description tag. Then adding a property = add the column, done.
