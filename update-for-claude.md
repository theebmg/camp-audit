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
- **`work_order_log_entries.job_line_id` migration (0037) is unapplied.**
  `work_order_log_entries` is owned by DB role `nocodb`, not `camp_app` (a
  pre-existing ownership drift, not something this work introduced), and
  `camp_app` has no privilege path to fix it. An operator with Postgres
  superuser access needs to run, once, against the `camp` database:
  `ALTER TABLE work_order_log_entries OWNER TO camp_app;` — then
  `npm run migrate` picks up 0037 normally. Until then, work log entries
  can't be attributed to a specific job line (WO-level notes still work
  fine). **The same ownership drift affects 8 other tables** (`asset_photos`,
  `asset_property_history`, `budget_settings`, `cabin_holders`,
  `capital_campaign_projects`, `other_budget_categories`,
  `report_favorites`, `users`) — none needed by Phase 1, but the next
  migration that touches one of them will hit the same wall; worth fixing
  all of them in one pass with the same `ALTER TABLE ... OWNER TO camp_app`
  the next time a superuser is available.
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
