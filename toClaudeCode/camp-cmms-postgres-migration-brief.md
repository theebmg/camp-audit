# Build Brief — Migrate camp-audit from NocoDB-API to own Postgres

Companion to BUILD_BRIEF.md and camp-cmms-components-design.md. This spec moves the
app's **system of record** from "NocoDB's API over NocoDB's tables" to **our own
Postgres schema**, while KEEPING NocoDB as a read/edit spreadsheet viewer over that
same database. The app talks SQL directly; NocoDB becomes an admin GUI, not the API
layer.

Read the existing code first — especially `src/nocodb.js` (the isolated data layer),
`src/routes/api.js` (audit submit, reports), and `src/components.js` (current-state
logic). The portability boundary Claude Code already maintained is what makes this
contained.

---

## Why this migration

- Want full schema control (building types, component sub-areas, clean relations)
  without NocoDB link-column quirks / importer fragility / feature gating.
- Reporting is easier in SQL: capital-planning and history reports become single
  queries instead of hand-rolled JS over API envelopes. The app ALREADY renders and
  emails its own reports (reportData.js / reportRender.js / mailer.js) — only the
  data-fetch underneath changes.
- The app's data access is already isolated in ONE module (nocodb.js), so swapping
  it for a Postgres client is a contained change; routes/reports/frontend mostly
  don't change.

## Non-negotiable safety rule: build alongside, cut over only when proven

- The current NocoDB-API app WORKS. Do NOT break or delete it. Build the Postgres
  path in parallel (new module, new DB) and cut the app over only when it does
  everything the current one does, verified. Keep NocoDB stack running throughout.
- The user is mid-move (relocating within days). A snag must never leave them with
  no working system. Fallback = the current app, untouched, still runnable.

---

## Hosting & cost (decided)

- **Postgres lives on the existing droplet.** Reuse the Postgres SERVER NocoDB
  already runs (container `nocodb-db`), but in a SEPARATE database (not NocoDB's).
  One Postgres server, two databases: NocoDB's, and ours (e.g. `camp`). This avoids
  a second Postgres container's RAM cost. (If cleaner in practice, a separate
  Postgres container is acceptable, but default to shared-server/separate-db.)
- **$0/month added.** No managed DB, no new droplet. Watch RAM (droplet is 4GB +
  swap; running NocoDB + its PG + app is fine, but do NOT resize back to 2GB until
  this is settled — keep 4GB headroom).
- Use the `pg` npm library in the app. Connection string in `.env` (gitignored),
  never in the repo.

---

## Target Postgres schema

Design proper tables with real foreign keys. Names below are a starting point; keep
them clean and consistent (snake_case columns). All tables get `id serial primary
key`, `created_at timestamptz default now()`, `updated_at timestamptz`.

### Core tables (mirror current model, cleaned up)
- **locations** — self-referextial tree. `id, name, parent_location_id (fk
  locations.id), type, notes`. (51 rows exist.)
- **assets** — `id, name, asset_type, location_id (fk), parent_asset_id (fk
  assets.id, for genuine containment only), building_type (fk building_types.id or
  a text/enum — see below), lodge_holder, description`, plus the stable
  @asset-property-style fields that remain flat (has_key, key_fits_lock,
  free_standing_building, indoor_plumbing, half_or_whole_cabin, window_count,
  window_style, interior_finish). (337 rows exist.)
- **asset_components** — the event log (see camp-cmms-components-design.md).
  `id, asset_id (fk), component_type, sub_area (nullable — see below), event_type,
  material, condition, observed_installed_date date, est_life_years int,
  est_replacement_year int, est_replacement_cost numeric, notes, work_order_id (fk
  nullable)`. Current-state logic = the same "newest per (asset, component_type[,
  sub_area]); clock = newest Installed/Replaced" rule, now expressible in SQL
  (DISTINCT ON / window functions).
- **condition_findings** — `id, asset_id (fk), title, system, severity,
  description, recommended_repair, estimated_hours, estimated_cost, status,
  date_identified, work_order_id (fk nullable)`.
- **work_orders** — `id, title, status, asset_id (fk nullable), location_id (fk
  nullable), project_id (fk nullable), ...costs/dates`.
- **asset_updates** — WO→asset write-back instructions (may be simplifiable now
  that we control SQL; keep the concept: a WO can carry N field/value changes
  applied on completion).
- **projects, volunteers, vendors** — as currently used.

### NEW: building types + type-driven conditional questions
The whole point of the form expansion: **don't ask N/A questions for building types
that don't have them.**

- **building_types** — `id, name` (Cabin, Lodge/Hotel, Restroom/Shower, Pavilion/
  Shelter, Utility/Equipment, Tabernacle, Other — confirm the real list with the
  user). Each asset has a building_type.
- **question_applicability** — drives which questions/components apply to which
  building type. Two clean ways; pick one and keep it in ONE place:
  1. A table: `building_type_id, question_key, applies (bool)` — data-driven,
     editable in NocoDB later. Preferred (no code change to re-tune).
  2. A config map in code keyed by building type. Simpler, but code-edit to change.
  Recommendation: **data-driven table**, so the user can adjust applicability from
  the NocoDB grid without a deploy.

The audit API builds each building's question set = the base questions filtered by
that building type's applicability. Extends the existing dependency mechanism
(`ASSET_PROPERTY_DEPENDENCIES` in api.js) rather than replacing it.

### NEW: component sub-areas (roof/ceiling/floor "by corners" etc.)
The user wants to record condition for parts of a component — e.g. floor NE corner
vs SW corner, ceiling by section. Model as an optional `sub_area` on
asset_components:
- A component event may target the whole component (`sub_area = null`) or a named
  sub-area (`sub_area = 'NE corner'`).
- Current-state grouping becomes per (asset, component_type, sub_area). A component
  with no sub-areas behaves exactly as today (one null sub_area).
- Keep the sub-area vocabulary per component_type configurable (a small table or
  config), so Floor can have corners while Roof has slopes, etc. Confirm the real
  sub-area sets with the user.

### Expanded audit questions to support (confirm exact list with user)
Roof, Ceiling, Floor (with sub-areas incl. corners), Siding, Windows (count +
style), plus stable asset facts: half-or-whole cabin (verify), indoor plumbing
(y/n), interior finish (finished vs open studs). Route each to the right home:
- component-shaped w/ condition+history → asset_components rows (roof, ceiling,
  floor, siding, windows-as-component if you track their condition)
- stable single-value facts → columns on assets (indoor_plumbing, window_count,
  window_style, interior_finish, half_or_whole_cabin)
Follow the same "component vs asset-property" split the app already uses.

---

## Data migration (NocoDB → our Postgres)

The data is already clean and verified (337 assets, 51 locations, component rows,
findings). This is far easier than the original Atlas→NocoDB migration.

1. Export current data from NocoDB (API or CSV per table). The app's nocodb.js can
   read every table already — a one-off export script can pull all rows as JSON.
2. Transform to the new schema (map link fields → foreign keys by matching on the
   IDs/names already present). Because we control the target, set FKs directly — no
   junction-table juggling, no importer.
3. Load into Postgres inside a transaction; verify counts and spot-check links
   (same rigor as before: 337 assets, location FKs correct, parent-asset
   containment correct, component rows attached to right assets).
4. Keep the NocoDB data in place as the fallback until the Postgres app is proven.

---

## Data-layer swap: nocodb.js → db.js

- Create `src/db.js` exposing the SAME shape of functions the app already calls
  (listRecords-equivalents returning plain arrays/objects, getRecord, createRecord,
  updateRecord, plus real relational queries for reports). Routes and components.js
  should need minimal changes because they already consume plain objects.
- Move the "current component state" logic: it can stay in components.js as pure
  functions over rows (unchanged), OR move into SQL (DISTINCT ON) for reports.
  Keep ONE definition of "current" — do not duplicate the rule.
- Reports (reportData.js) become SQL queries. This is the big win: capital plan =
  one query (current component per asset, grouped by replacement-year bucket, sum
  cost); history = select components for asset order by date; camp-wide log = same
  without the asset filter.
- mailer.js / reportRender.js are downstream of the data and should barely change.

Keep db.js the ONLY module that knows SQL / connection details, exactly as nocodb.js
was the only one that knew NocoDB — same portability discipline.

---

## NocoDB as viewer over the new database (keep the grid)

- Add the new `camp` database as an external data source in NocoDB (NocoDB supports
  connecting to existing Postgres). This gives the spreadsheet grid — sort, filter,
  hand-edit a cell, bulk fixes — over OUR tables, without NocoDB owning them.
- Do SCHEMA changes in SQL (migrations), not in NocoDB's UI, to keep the schema
  authoritative in our migrations. Use NocoDB to view/edit ROWS.
- Note: NocoDB may add its own metadata tables alongside ours; that's fine. Some
  custom types may show as generic in the grid; acceptable for data editing.
- Fallbacks if NocoDB-over-external-PG is annoying: pgAdmin or Adminer give the same
  table view. The app will also grow its own admin screens over time.

---

## Backups (make "I don't have to worry" actually true)

- Nightly `pg_dump` of the `camp` database, gzipped, rotated locally (~14 days),
  like the existing nocodb-backup.sh — mirror that script for the new DB.
- **CRITICAL: copy each dump OFF the droplet.** A backup on the same droplet dies
  with the droplet. **Off-box destination = the user's existing Dropbox** (already
  paid for; DB dumps are small).
  - Use **rclone** on the droplet as the uploader (`rclone copy` the dump to a
    dedicated Dropbox folder, e.g. `/Apps/camp-cmms-backups/`). rclone is the
    general "server → any cloud" tool, so the destination can be changed later
    with a config edit, not a rewrite.
  - Dropbox uses OAuth, so rclone needs a **one-time headless authorize** (browser
    step done on the user's PC, token pasted back — rclone has a documented
    remote-setup flow for headless servers). Walk the user through this when
    setting it up; after that it runs unattended.
  - One-way push only (`rclone copy`, never a two-way sync that could delete on
    either side). Prune old Dropbox dumps in the script or let them accumulate
    (they're small).
  - Independence note: Dropbox is a different provider from DigitalOcean, so it
    covers droplet loss AND DO-account loss. Good enough; the local copy covers
    the (vanishingly unlikely) Dropbox-account-loss case.
- **Optional but recommended: enable DigitalOcean's weekly droplet backup/snapshot**
  (~20% of droplet cost). That's whole-machine recovery (app + DB + configs as a
  restorable image) versus the DB-only dumps — the two together are robust: dumps
  give recent data between snapshots, the snapshot rebuilds the whole box if needed.
- Test a restore once (dump → restore into a scratch DB → verify) so the backup is
  known-good, not theoretical.

## Photos / attachments

The current app already has photo upload (uploadAttachment in nocodb.js, Photos on
Condition Findings). Preserve this through the migration:
- **Image FILES live in DigitalOcean Spaces** (S3-compatible object storage; the
  database stores only a reference/URL, never the binary). Spaces is in-account and
  the same S3-style tooling rclone already speaks.
- Photos are a **field-tool**: attachable in the field to a Finding, a Note (below),
  and ideally to a component event (e.g. a photo of the new roof). Wire the upload
  path to Spaces; store the returned object URL on the relevant row.
- Keep the upload logic in the data layer / a small storage module, same boundary
  discipline as db.js.

## Ad-hoc notes & field creation (two DIFFERENT things — keep them separate)

The user can't pre-think every field. Two mechanisms handle this WITHOUT letting the
schema rot into an Atlas-style pile of ad-hoc columns:

### Ad-hoc notes / follow-ups — a FIELD tool (build into the walkthrough)
- A lightweight **notes / follow-ups** capability: attach a free-text note (and
  optional photo) to a specific asset in the moment ("check the loose step next
  visit"). This is just INSERTing a row — no schema change, no risk.
- Model as either a small `asset_notes` table (asset_id, note, photo_url, created_at,
  resolved bool) or reuse Condition Findings for anything that's a real deficiency.
  A quick to-do that isn't a deficiency belongs in notes, not findings.
- This is the pressure-relief valve for "there's no field for this yet."

### New tracked FIELDS — a deliberate ADMIN action (NOT a walkthrough button)
- Adding a new *question the form asks for every building* is schema editing. Do
  NOT expose this as a button on the field walkthrough — thumb-typed schema changes
  in the field are how structure rots.
- Instead, a **considered admin flow**: add the field via the NocoDB grid (over the
  new Postgres DB) OR a small admin screen. Crucially, the flow must FORCE the
  placement decision the app already depends on: is this new thing an **asset
  property** (flat, single-value, stable), an **asset component** (condition +
  history, event-log), or a **finding** (point-in-time deficiency)? That three-way
  choice is what keeps reports/capital-planning working.
- Keep the schema-driven adoption that already exists: once a field is added and
  tagged (the `@asset-property` pattern, or a component type added to the audited
  list), the form should pick it up with no code change — same principle, now over
  Postgres. Ease of adding fields is preserved; it's just a deliberate act at a
  keyboard, not a reflex on a hillside.
- Workflow that ties it together: when the user notices they keep writing the same
  kind of ad-hoc NOTE, that's the signal to promote it to a real field — thought
  through and placed correctly. Notes in the moment → considered field later.

---

## Suggested build order

1. Stand up the `camp` Postgres database on the droplet's existing PG server.
   Connectivity from the app (a `/health`-style DB ping) before anything else.
2. Write the schema as SQL migration files (core tables + building_types +
   applicability + sub-areas). Version them in the repo.
3. Export current NocoDB data → transform → load into Postgres in a transaction.
   Verify counts and links against the known-good numbers.
4. Build `src/db.js`; port routes to it behind a flag or on a branch so the NocoDB
   app still runs. Get audit submit + one report working end-to-end on Postgres.
5. Rebuild the audit form with building-type applicability + component sub-areas.
   Include ad-hoc NOTES (+ optional photo) as a field tool, and wire photo uploads
   to DigitalOcean Spaces (DB stores the URL, not the binary).
6. Build the deliberate admin "add a tracked field" flow (forces the asset-property
   vs component vs finding placement choice); keep schema-driven form adoption.
7. Connect NocoDB to the new DB as viewer. Set up nightly pg_dump + rclone→Dropbox
   off-box copy (one-time headless OAuth); optionally enable DO weekly droplet
   snapshot; test a restore.
8. Cut the live app over to Postgres only after it matches the NocoDB app's behavior.
   Keep NocoDB (now viewer) and the old data as fallback until confident.

## Guardrails
- Build alongside; never leave the user without a working system mid-move.
- DB connection string + any mail creds live in gitignored .env, never the repo.
- Migrate into a transaction; verify counts/links before trusting it.
- Keep db.js the sole SQL-aware module (portability boundary, same as nocodb.js).
- Off-box backup is part of "done", not a later nicety.
