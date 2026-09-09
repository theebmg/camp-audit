# Build Brief v2 — Job Lines, Lifecycle, Attachments

**Camp Sychar CMMS** — continuation brief. Read alongside the existing
`BUILD_BRIEF.md` (original scaffold) and `update-for-claude.md` (asset-property
runbook). Current state: Postgres-backed Express/vanilla-JS app, 29 migrations
applied, `src/db.js` + `src/routes/pg-api.js` + `public-pg/app.js`.

**All data currently in the system is test data.** It can be dropped, rewritten,
or destructively migrated with no backup and no preservation logic. Do not write
backfill code for existing rows. Do not write defensive migrations. Take the
clean path.

**Do not re-litigate the design decisions below — they are settled after a long
design conversation.** Build against them. If something is technically
impossible or self-contradictory, stop and say so rather than silently changing
the design.

---

## The one-sentence summary

The **job line becomes the unit of work** (hours, cost, funding, responsibility,
status, scope, attachments all live there; the work order becomes a container
that rolls them up), work orders and findings get real lifecycles, and the nine
existing photo attachment points collapse into one polymorphic attachment system
with an email-fed triage inbox.

---

## Why (context — do not skip, it explains the constraints)

This system is going in front of a camp board that needs to be shown *what
condition the property is actually in* and *that money is being assessed before
it is spent*. Almost every design decision below exists to make a specific
report possible. When implementing, if a choice makes the reporting worse but
the code cleaner, choose the reporting.

The operator is a single person walking 337 assets with a phone. Every decision
that can be deferred out of the field should be. Capture must be zero-decision;
classification happens later at a desk.

---

# Phase 1 — Job lines become the unit of work

**This is the largest structural change. Do it first, alone, and get it right.**

## 1.1 Rename

`work_order_tasks` → **`job_lines`**. Rename `work_order_task_photos` →
irrelevant (removed in Phase 4). Update every reference in `db.js`,
`routes/pg-api.js`, `public-pg/app.js`. "Task" collides with too many other
concepts; "job line" is the term used everywhere else in the system's language.

## 1.2 What moves down from `work_orders` to `job_lines`

These columns are **removed from `work_orders`** and added to `job_lines`:

| Column | Notes |
|---|---|
| `estimated_hours` | |
| `actual_hours` | |
| `estimated_cost` | |
| `actual_cost` | |
| `funding_source` | existing CHECK enum from migration 0016 |
| `funding_ref_id` | soft ref, same validation rules as 0016 |
| `responsible_self` | replaced by `responsibility_class` — see 1.3 |
| `scheduled_date` | see 1.4 |

The `work_order_volunteers` / `work_order_vendors` junctions are **replaced** by
`job_line_volunteers` / `job_line_vendors` with identical shape.

Work-order-level values for all of the above become **derived rollups**,
computed on read, never stored. Add a `workOrderRollup(woId)` helper in `db.js`
and use it everywhere the old columns were read.

### Consequence you must handle
`getBudgetView` / capital plan (`db.js` ~line 982–1030) and the dashboard
aggregates currently read `work_orders.funding_source` and
`COALESCE(actual_cost, estimated_cost)` directly. **These must be rewritten to
group job lines, not work orders.** A single WO can now have lines funded from
three different sources — that is the point, not an edge case (roof from capital
campaign, deck from cabin holder, windows from operating budget, one cabin, one
WO).

## 1.3 New columns on `job_lines`

```sql
ALTER TABLE job_lines
  ADD COLUMN status_id            integer REFERENCES job_line_statuses(id),
  ADD COLUMN responsibility_class text NOT NULL DEFAULT 'self'
    CHECK (responsibility_class IN ('self','volunteer','vendor','cabin_holder')),
  ADD COLUMN scheduled_date       date,
  ADD COLUMN complaint            text,
  ADD COLUMN cause_note           text,
  ADD COLUMN correction           text,
  ADD COLUMN blocked_reason       text,
  ADD COLUMN blocked_since        date,
  ADD COLUMN completed_date       date,
  ADD COLUMN condition_finding_id integer REFERENCES condition_findings(id);
```

`cabin_holder` as a responsibility class is deliberate and important — cabin
holders frequently take on part of the work for their own cabin. It joins to the
existing `cabin_holders` table (migration 0016).

`condition_finding_id` is the **1:1 link back to the finding this line
addresses** (nullable — not every line comes from a finding). Closing the line
resolves the finding. See Phase 3.

## 1.4 Scheduled date behaviour
Job line `scheduled_date` **defaults to the WO's scheduled date on creation** but
is independently editable. Vendor comes Tuesday, volunteers come Saturday, same
work order. The calendar must render job lines, not work orders, when a WO's
lines have divergent dates.

## 1.5 Hours

`crew_sessions` gets `job_line_id integer REFERENCES job_lines(id) ON DELETE SET NULL`
(nullable — genuinely WO-level time exists and must not be forced onto a line).

- Line actual hours = sum of `crew_sessions.hours` where `job_line_id` matches.
- WO actual hours = sum of all sessions on that WO, line-attributed or not.
- Null-line hours roll into the WO total but are **excluded from line-level
  percentage calculations**.

Same treatment for `work_order_log_entries.hours` — add `job_line_id`, nullable.

In the crew-session UI, the job line picker is **optional** and defaults to
unset. Do not make it required; it is one more tap in the field.

## 1.6 Complaint / Cause / Correction

`complaint` and `correction` are freetext on the line. Cause is **two separate
fields, deliberately**:

```sql
CREATE TABLE causes (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 100,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE job_line_causes (
  job_line_id integer NOT NULL REFERENCES job_lines(id) ON DELETE CASCADE,
  cause_id    integer NOT NULL REFERENCES causes(id) ON DELETE CASCADE,
  PRIMARY KEY (job_line_id, cause_id)
);
```

Seed: `Age / Wear`, `Rot`, `Water Intrusion`, `Pest / Insect`, `Storm Damage`,
`Vandalism`, `Improper Install`, `Deferred Maintenance`, `Failed Component`,
`Unknown`.

**CRITICAL — get this exactly right:**
- The cause multi-select reads **only** from the `causes` table.
- `cause_note` is freetext saved to that line only.
- **Freetext must NEVER be promoted into the `causes` table.** No "add as new
  option," no autocomplete-from-history, no learning. Adding a cause is a
  deliberate trip to the admin section, nothing else.
- Include `Unknown` in the seed and keep it prominent. Without it, users pick a
  plausible-but-wrong cause rather than leaving it blank, which produces
  confident bad data.

The dropdown is what gets counted. The note is what gets read.

## 1.7 Work order creation flow

1. Pick asset → location/project/priority context fills in.
2. **"+ Add job line"**, repeatable. Each line captures: title/description,
   responsibility class (+ vendor/volunteer/cabin-holder picker), funding source
   + ref, estimated hours, estimated cost, scheduled date (defaults to WO date).
3. Save.

Complaint/cause/correction is filled in during/after the work, not at creation.

---

# Phase 2 — Work order & job line lifecycle

## 2.1 Job line statuses (admin-editable table)

```sql
CREATE TABLE job_line_statuses (
  id                       serial PRIMARY KEY,
  name                     text NOT NULL UNIQUE,
  sort_order               integer NOT NULL DEFAULT 100,
  color                    text NOT NULL DEFAULT '#888888',
  is_terminal              boolean NOT NULL DEFAULT false,
  counts_as_work_performed boolean NOT NULL DEFAULT false,
  requires_note            boolean NOT NULL DEFAULT false,
  note_label               text,
  active                   boolean NOT NULL DEFAULT true
);
```

The two flags do different jobs and neither can be inferred from the other:

- **`is_terminal`** — this line no longer blocks the WO from closing.
- **`counts_as_work_performed`** — this line represents work actually done.

`Not Needed` is terminal but is NOT work performed. That distinction is what
makes the board report honest: *"12 lines completed, 3 determined unnecessary on
inspection"* is a much better and truer sentence than *"15 lines closed."*

Seed:

| name | terminal | work performed | requires note | note label |
|---|---|---|---|---|
| Not Started | no | no | no | |
| In Progress | no | no | no | |
| Waiting on Parts | no | no | yes | What are we waiting on? |
| Waiting on Approval | no | no | yes | Waiting on whom? |
| Waiting on Weather | no | no | no | |
| Done | yes | **yes** | no | |
| Not Needed | yes | no | yes | Why was this not needed? |
| Cancelled | yes | no | yes | Why cancelled? |

When `requires_note` is true, the UI prompts with `note_label` as the prompt
text and will not save without an answer. A contextual question gets answered; a
generic empty box does not.

## 2.2 Work order statuses

```sql
CREATE TABLE work_order_statuses (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  sort_order  integer NOT NULL DEFAULT 100,
  color       text NOT NULL DEFAULT '#888888',
  is_terminal boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true
);
```

Seed, in order: `Reported`, `Assessed`, `Scheduled`, `In Progress`, `Done`
(terminal), `Deferred` (terminal), `Cancelled` (terminal).

- **Reported** — exists, not scoped.
- **Assessed** — job lines exist with hours + cost. A fully scoped proposal that
  can be handed to the board.
- **Scheduled** — has a date and named crew.
- **In Progress** — work has started.
- **Done / Deferred / Cancelled** — terminal.

`work_orders.status` becomes `status_id integer REFERENCES work_order_statuses(id)`.

**`Urgent` is deleted as a status.** It is a priority and already exists on the
`priority` column. Its presence as a status meant an urgent in-progress job
could not be both, silently undercounting.

**`On Hold` / `Blocked` is NOT a status.** Blocked is orthogonal to pipeline
position — a half-finished roof waiting on materials is genuinely both In
Progress and blocked. Blocked lives as `blocked_reason` + `blocked_since` on the
**job line** (1.3). A WO is *derived* blocked if any line has a non-null
`blocked_reason`; surface this as a flag/badge on the WO row with the reason on
hover, never as a status value.

## 2.3 Deferred

`Deferred` on a work order **requires** both a reason and a `revisit_date`.
Enforce at the API layer, not just the UI. The enforcement is where the board
credibility comes from.

```sql
ALTER TABLE work_orders
  ADD COLUMN deferred_reason text,
  ADD COLUMN revisit_date    date;
```

Deferred revisit dates must surface on the **calendar and the dashboard**
("due today" / upcoming) via the same mechanism as everything else on the
calendar. Same pattern for deferred findings (Phase 3) — one implementation,
both sources.

## 2.4 Status change logging

**Every** status transition — work order and job line — writes a
`work_order_log_entries` row automatically (`status_change` field already
exists; add `job_line_id` per 1.5). No exceptions, no silent updates.

This is what produces dwell-time reporting: *"average 34 days blocked on board
approval"* is the kind of number that changes a board meeting, and it comes free
if the logging is unconditional.

Job line notes **append with timestamp and username**, never overwrite.

## 2.5 Close gate

A work order can close when **no job line is in a non-terminal status.** Not
"all lines Done."

When the last line goes terminal, **prompt for review — never auto-close.** The
prompt is a review screen (set actual costs, pick report attachments, confirm).
There must also always be a manual "Close Work Order" button available; closing
is never automatic.

## 2.6 Progress display

Grid row shows a **segmented progress bar** (segments colored by line status) plus:

```
2/3 lines · $2,400 of $11,000 · 10 of 42 hrs
```

**Percent-complete must be cost-weighted by default, not line-count-weighted.**
Finishing the deck and window while the roof is untouched is "67% by count" and
roughly 20% by money. Showing the board the first number overstates progress.

- Grid: cost-weighted by default. One admin view-preference setting to change the
  grid default globally.
- WO detail: show all three (count, cost, hours). No per-row toggles in the grid.

---

# Phase 3 — Findings lifecycle

Findings already live on the asset (`condition_findings.asset_id`). Nothing
moves. The problem is that `'Open'` is hardcoded at insert in three places in
`db.js` with no path out, so "Open" means both "urgent, unaddressed" and
"reviewed, can wait five years."

Replace with a real lifecycle where **every finding has had a decision made on it:**

| Status | Set by | Requires |
|---|---|---|
| `Open` | insert | — |
| `Scheduled` | **auto** on conversion to a job line | — |
| `Resolved` | **auto** when its job line reaches a `counts_as_work_performed` status | — |
| `Deferred` | manual | reason + `revisit_date` |
| `Dismissed` | manual | note |

```sql
ALTER TABLE condition_findings
  ADD COLUMN deferred_reason text,
  ADD COLUMN revisit_date    date,
  ADD COLUMN dismiss_note    text,
  ADD COLUMN reviewed_by     text,
  ADD COLUMN reviewed_at     timestamptz;
```

Nothing is ever deleted. `reviewed_by`/`reviewed_at` mirror the pattern already
in `maintenance_requests` and make every deferral attributable — the difference
between a decision and a thing that quietly didn't happen.

**Open count should trend to zero** and is the system's data-quality signal.
Surface it on the dashboard, along with a count of findings not on any work
order.

### The report this exists for
Filter to `Deferred`, group by severity, sum `estimated_cost` → a **deferred
maintenance backlog with dollar values**. This is a standard capital-planning
document and likely the single most useful artifact the system produces. Build
it as a named report (Phase 6), not something to assemble from filters.

---

# Phase 4 — Attachments

## 4.1 What it replaces

Delete all nine existing photo loci. **Do not migrate their data** (test data
only): `assets.legacy_photos`, `asset_photos`, `asset_components.photo_url`,
`condition_findings.photo_urls`, `condition_findings.legacy_photos`,
`work_orders.legacy_photos`, `work_order_photos`, `work_order_task_photos`,
`maintenance_request_photos`, `asset_notes.photo_url`.

## 4.2 Schema

```sql
CREATE TABLE attachments (
  id                serial PRIMARY KEY,
  url               text NOT NULL,
  thumb_url         text,
  kind              text NOT NULL DEFAULT 'image'
                      CHECK (kind IN ('image','document','audio','other')),
  mime_type         text,
  file_size         integer,
  original_filename text,
  width             integer,
  height            integer,
  caption           text,
  classification_id integer REFERENCES component_types(id),
  taken_at          timestamptz,
  gps_lat           double precision,
  gps_lng           double precision,
  source            text NOT NULL DEFAULT 'upload'
                      CHECK (source IN ('upload','email','field')),
  batch_id          integer REFERENCES attachment_batches(id) ON DELETE SET NULL,
  triage_status     text NOT NULL DEFAULT 'triaged'
                      CHECK (triage_status IN ('inbox','triaged','void')),
  uploaded_by       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE TABLE attachment_links (
  id                 serial PRIMARY KEY,
  attachment_id      integer NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  entity_type        text NOT NULL,   -- 'asset' | 'work_order' | 'job_line'
                                      -- | 'condition_finding' | 'asset_component'
                                      -- | 'maintenance_request' | 'asset_note'
  entity_id          integer NOT NULL,
  role_id            integer REFERENCES attachment_roles(id),
  include_in_report  boolean NOT NULL DEFAULT false,
  sort_order         integer NOT NULL DEFAULT 0,
  -- quote-specific, null for everything else
  vendor_id          integer REFERENCES vendors(id),
  quoted_amount      numeric,
  quote_date         date,
  is_selected_quote  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attachment_id, entity_type, entity_id, role_id)
);
CREATE INDEX idx_attachment_links_entity ON attachment_links(entity_type, entity_id);
```

**Many-to-many is the whole point.** One photo of a leaking roof is
simultaneously the evidence on the finding, the "before" on the job line, and
the reference image on the asset — one file, three links, uploaded once.

`entity_type = 'job_line'` is first-class and is the **default** target for work
photos. Do not attach work photos at WO level. When a job line is split off into
a child WO (Phase 5), its attachments travel with it automatically because they
were never attached to the parent.

## 4.3 Roles (admin-editable)

```sql
CREATE TABLE attachment_roles (
  id                        serial PRIMARY KEY,
  name                      text NOT NULL UNIQUE,
  sort_order                integer NOT NULL DEFAULT 100,
  default_include_in_report boolean NOT NULL DEFAULT false,
  active                    boolean NOT NULL DEFAULT true
);
```

Seed: `Before / Condition` (report ✓), `After / Repair` (report ✓), `During`,
`Evidence`, `Reference`, `Documentation`, `Quote`, `Invoice`, `Permit`,
`Warranty`, `Spec`.

Role answers *what is this, relative to this record*. Because role lives on the
link, the same file is "After / Repair" on the job line and "Reference" on the
asset.

`default_include_in_report` pre-ticks the report checkbox based on role, always
overridable per link. Tagging something "After / Repair" is already the user
saying *this is the proof*.

## 4.4 Classification

Separate axis from role. Role = purpose/stage. Classification = **what part of
the building this depicts** (Roof, Foundation, Electrical, Plumbing).

```sql
CREATE TABLE component_types (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 100,
  active     boolean NOT NULL DEFAULT true
);
```

Seed from the distinct `component_type` values in `component_sub_areas` /
`asset_components`. **One vocabulary, one place to edit, no drift** between
"Roof" the component and "Roofing" the photo tag.

`component_sub_areas.component_type` and `asset_components.component_type` remain
text columns for now — converting them to FKs is a follow-up, not part of this
work. Note it in the runbook.

**Inheritance:** attaching to a job line or component event whose type is known
pre-fills classification. It is only typed when the guess is wrong.

## 4.5 Ingest processing

- **Images:** resize to max 2000px long edge, quality ~82, strip nothing but
  read EXIF first. Generate a ~400px thumbnail. Keep large but light.
- **EXIF:** read `DateTimeOriginal` → `taken_at`, GPS → `gps_lat`/`gps_lng`.
  `taken_at` is what photos sort by, not `created_at` — a week's worth uploaded
  on Sunday must still sort correctly.
- **Documents:** stored as-is, no resize, file-type icon in place of a thumbnail.
- **Set `ContentType` correctly on the Spaces upload.** A PDF stored as
  `application/octet-stream` downloads instead of previewing, which feels broken
  every time.
- Max file size 25MB (most mail servers reject above this anyway).
- All of this stays inside `src/storage.js`. That portability boundary is
  deliberate — nothing else in the codebase may know about S3/Spaces.
- `ACL: 'public-read'` stays as-is. Settled: no sensitive third-party data is
  going into this system.

## 4.6 Delete semantics — three distinct operations

| Operation | Effect |
|---|---|
| **Detach** | Removes one `attachment_links` row. File and attachment untouched, other links unaffected. The common case. |
| **Void** | Soft delete: set `attachments.deleted_at`, `triage_status = 'void'`, cascade-remove links. Disappears from every screen. **File in Spaces untouched — one-click undo.** |
| **Hard delete** | Separate reaper script only, targeting `deleted_at` older than 30 days. Optional; low priority. |

Void must be a fast, low-consequence action (swipe/one tap, no confirm dialog).
Junk *will* arrive via email and hesitation is the enemy.

## 4.7 Where attachments can be added

All three paths must work:
1. The triage inbox (email-fed) — Phase 5.
2. An **"Attach file"** button on the inbox page itself (direct upload).
3. Inline on any WO, job line, asset, finding, or component — existing behaviour,
   preserved, now writing to the new tables.

---

# Phase 5 — Inbox, email ingest, and splitting

## 5.1 Batches

```sql
CREATE TABLE attachment_batches (
  id               serial PRIMARY KEY,
  source           text NOT NULL,   -- 'email' | 'upload'
  subject          text,
  body_text        text,
  sender_email     text,
  message_id       text UNIQUE,     -- idempotency guard for IMAP polling
  received_at      timestamptz NOT NULL DEFAULT now(),
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
```

**One email = one batch.** That is the grouping primitive and it costs nothing —
two jobs, two emails.

But a batch is a **suggestion, not a commitment**. Twenty photos from a full
walkthrough arrive in one email and become three work orders. The inbox does the
real work.

## 5.2 Email ingest

> **SUPERSEDED by Build Brief v2.1 Part 1.** `cmms@fracturedrv.com` was
> never created and never will be — the design changed to a Mailgun inbound
> webhook at `photos@cmms.fracturedrv.com` (a dedicated subdomain), with
> Mailgun doing the MIME parsing instead of an IMAP poll +
> `imapflow`/`mailparser`. See
> `toClaudeCode/BUILD_BRIEF_v2.1_corrections_verification_backups.md` and
> `update-for-claude.md`'s "Mail Ingest → Mailgun Webhook" runbook for what
> was actually built. The subject-line shortcuts, fuzzy asset matching, and
> junk filtering described below carried over unchanged in behavior — only
> the transport and dedupe-key extraction changed (`message_id` UNIQUE is
> still the guard).

- ~~Mailbox: `cmms@fracturedrv.com`. IMAP poll on an interval (5 min is fine).~~
- **Open relay for now** — no sender whitelist. Settled. Structure the code so a
  whitelist is a single check to add later.
- `message_id` UNIQUE is the double-processing guard.
- **Filter junk at ingest**, before it reaches the inbox: drop images under
  ~200px, and drop MIME parts marked `inline`/`related` rather than genuine
  attachments. This kills signature logos and tracking pixels. Void handles the
  rest.
- Subject and body land on the batch.
- ~~Mailer code already exists (`src/mailer.js`) — outbound only. This is new
  inbound work; keep it in its own module.~~

### Subject line shortcuts
- Subject matching `/\bWO\s*(\d+(-\d+)?)\b/i` → attach directly to that work
  order, **skip the inbox entirely**. This makes the most common case (sending
  the after photo for the job you're standing in front of) fully touchless.
- Otherwise, **fuzzy-match the subject against asset names** and surface the top
  3 as tappable suggestions in the inbox. Never auto-assign — a silent wrong
  match against 337 assets is worse than no match.
- A checkbox, **default ticked**, offering "Use subject as work order title."

## 5.3 The triage inbox

Grid of thumbnails, newest batch first, grouped by batch.

- **Multi-select** photos within a batch.
- Act on the selection: **Create WO** / **Add to existing WO** / **Add to job
  line** / **New finding** / **File to asset (reference only)** / **Void**.
- Selected items get their links and leave the inbox (`triage_status = 'triaged'`).
  The rest of the batch stays. Repeat until empty.
- **"File as reference, no job" must be a first-class button.** Without it, junk
  work orders get created just to file pictures.
- **EXIF clustering** suggests sub-groups within a batch: *"these 6 were shot
  within 4 minutes, 80 feet apart."* One tap selects the cluster.
- **Nearest-asset suggestion from GPS.** Requires a one-time affine calibration
  from 3 known GPS points to the `campmap.webp` image-pixel space (assets already
  carry `map_x`/`map_y` from migration 0027). Store the transform in a settings
  table. Turns triage from "search" into "confirm or correct."
- **Inbox count badge on the dashboard.** The failure mode is a junk drawer of
  400 untriaged photos; the badge is the only thing preventing it.

## 5.4 Work order splitting

```sql
ALTER TABLE work_orders
  ADD COLUMN wo_number     text,
  ADD COLUMN parent_wo_id  integer REFERENCES work_orders(id),
  ADD COLUMN split_root_id integer REFERENCES work_orders(id);
```

- `id serial` stays the primary key. **`wo_number` is a display string only.**
- Root WO: `wo_number = '1000'`, `split_root_id` points at itself.
- Children: `1000-2`, `1000-3`, … **Flat numbering, always the next available
  suffix off the root** — never `1000-2-2`. Three-deep nested numbers become
  unreadable at exactly the moment things are already messy. `parent_wo_id`
  records true lineage so the family tree is still accurate; the number just
  doesn't try to encode it.
- The original **stays `1000`**, never gets relabelled `1000-1`. Anything already
  referencing "WO 1000" stays valid.

### Split operation
1. On an open WO, **multi-select job lines** to split off.
2. Create child WO; copy asset, location, project, priority.
3. **Move** the selected `job_lines` rows to the child (they carry their own
   hours, cost, funding, crew, status, attachments, and finding links — nothing
   to re-sort).
4. WO-level log entries stay with the parent.
5. Child starts at `Assessed` or `Scheduled`.

**Splitting is only available on a non-terminal WO.** Discovering more work on a
closed job creates a new WO, never a retroactive child — otherwise completion
dates stop meaning anything.

### Display
- **Grid defaults to roots only**, one row per family, with a chip on the parent:
  `1000 · +2 splits`. Clicking expands the children nested inline. A filter
  toggle shows all splits flat when wanted. Nothing hidden, nothing cluttered.
- Inside a WO, a **"Family"** button opens the full tree: every sibling, every
  job line under each, clickable straight through to that split — plus a
  **combined rollup at the top** (total hours and cost across the family).
  That rollup is the reason `split_root_id` exists; without it a split silently
  fragments project totals.

---

# Phase 6 — Reports

Job lines become a first-class reporting entity, not a sub-detail of work orders.

## 6.1 Report sources
- **Job line report source** with filters on: line status,
  `counts_as_work_performed`, responsibility class, funding source, asset,
  location, project, cause, date range, crew.
- Rollup views grouping by work order and by `split_root_id`.
- Role and classification are **selectable report parameters** (e.g. "show only
  Before/Condition and After/Repair").

## 6.2 Named reports to build
1. **Work Performed in a Date Range** — job lines with
   `counts_as_work_performed = true` and a completion date in range, *regardless
   of parent WO status*. Grouped by building, with After photos attached. This
   is the fall-to-spring board document and the whole reason job lines report
   independently: it proves six months of activity while half the big jobs are
   legitimately still open.
2. **Deferred Maintenance Backlog** — deferred findings, grouped by severity,
   with dollar totals. The capital-campaign argument.
3. **Quote Comparison** — per job line: vendor, amount, date, selected flag.
4. **Open Findings Not On Any Work Order** — the data-quality report.

## 6.3 Attachments in reports

- **Images embed. Documents link.** The board report is the one document where
  embedded before/after photos do the persuading — a link gets clicked by two of
  fourteen board members, an embedded image is seen by all fourteen. Nobody needs
  a vendor quote rendered inline, but they do need it one tap away.
- Only links with `include_in_report = true` appear.
- **Cap embedded images per work order at 4 (configurable in admin)**; the
  remainder fall back to links. Forty embedded photos is a 60MB PDF that bounces
  off half the board's mail servers.
- Embed at ~1200px; link the full-size original.
- Report generation must let the user **select which images** are embedded when
  more than the cap qualify.

## 6.4 Quotes

Quotes attach to the **job line** — you shop the roof, not the whole cabin.
Multiple per line, one flagged `is_selected_quote`.

Renders as a small table under the line: vendor, amount, date, selected marker,
each clickable to the PDF. Add a **"Quotes received"** count column to the job
line report so shopping discipline is visible across every job at once — a
stronger statement than any single line item.

`vendor_id` joins the existing `vendors` table (never freetext), which yields
"who did we use and what did we pay" across every job at year end.

---

# Phase 7 — Audit → work order

## 7.1 Job line templates

Follow the existing data-driven pattern (`question_applicability` keyed by
`building_type_id`, `component_sub_areas` keyed by component type):

```sql
CREATE TABLE job_line_templates (
  id                            serial PRIMARY KEY,
  building_type_id              integer REFERENCES building_types(id),
  component_type_id             integer REFERENCES component_types(id),
  default_title                 text NOT NULL,
  default_responsibility_class  text,
  default_funding_source        text,
  sort_order                    integer NOT NULL DEFAULT 100,
  active                        boolean NOT NULL DEFAULT true
);
```

A finding on Roof for a Cabin seeds a line titled `Roof repair — {asset}` with
class and funding pre-filled. No deploy needed to add a template.

**Templates supply wording and defaults only — never grouping.** Findings stay
1:1 with job lines. The moment one template line covers two findings, automatic
finding resolution breaks and you are back to a confirmation dialog.

## 7.2 Create WO from findings

At the end of a walkthrough: every open finding for that asset, listed with a
checkbox and a pre-filled line title from its template. Untick anything not going
on this WO. One button creates the WO with one job line per checked finding
(`job_lines.condition_finding_id` set, findings → `Scheduled`).

Funding and responsibility class get adjusted afterward on the WO screen, where
there's a keyboard.

---

# Build order

Each phase should land and be usable before the next starts.

1. **Phase 1** — job lines as the unit of work. Largest and riskiest; do it alone.
   Includes rewriting capital plan / budget / dashboard aggregates.
2. **Phase 2** — lifecycle, statuses, progress display.
3. **Phase 3** — findings lifecycle.
4. **Phase 4** — attachments unification (delete old loci, no data migration).
5. **Phase 5** — inbox, email ingest, splitting.
6. **Phase 6** — reports.
7. **Phase 7** — audit → WO.

Rationale: phases 1–3 are what the fall condition walkthroughs will pour data
into, so they must land first. The inbox works with manual upload before email
ingest exists.

---

# Guardrails

- **All existing data is test data.** Destructive migrations are fine. Do not
  write backfill or preservation logic.
- Migrations continue from `0030`. One migration per logical change, with a
  comment header explaining *why*, matching the style of `0001`–`0029`.
- **Preserve the portability boundaries.** `src/db.js` is the only module that
  knows SQL. `src/storage.js` is the only module that knows S3/Spaces. Do not
  leak either.
- Follow the existing schema-driven philosophy: **if a list can be a table
  editable from admin, make it a table.** No hardcoded status/role/cause lists in
  the frontend. `WO_STATUS_OPTIONS` in `src/reports.js` and `public-pg/app.js`
  must be read from the database.
- Update `update-for-claude.md` (the runbook) with the new touch-points as they
  change — that file exists specifically to stop the chase-your-tail failure mode
  and it will go stale fast during this work.
- Mobile-first. This is used one-handed on a phone while standing in a cabin.
- If a design choice makes the code cleaner but the board reporting worse, choose
  the reporting.
