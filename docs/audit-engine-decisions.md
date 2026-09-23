# Audit Engine — Decisions

> See also **`docs/audit-engine-addendum.md`** — seed-form fixtures, ad-hoc flags,
> note routing and the asset profile page. Open decisions live in
> **`docs/open-questions.md`**.

Answers to `docs/audit-engine-analysis.md`. Stated leans in the analysis are
approved unless contradicted here. Implementation choices made under these
decisions are logged at the bottom.

## 1. Findings: the engine feeds them, with a linkage rule

Flagged leaf answers CREATE `condition_findings`. Generated job lines LINK to their
finding. Closing/resolving the job line resolves the linked finding — the work
record drives the issue record, so the two can never drift.

**Finding = the issue record. Job line = the work record.**

Covers the flag-but-don't-fix case: if an audit flags something and no line is
generated this year, the finding stays Open/Deferred on its own lifecycle — the
deferred-maintenance lane working as intended. Capital planning keeps getting fed.

## 2. Checklists: extend the existing system

Add `section` to `checklist_template_steps` / `checklist_instance_steps`. Do not
build the brief's §2 parallel tables. Keep conditional steps; the brief's
sections-without-conditions is a subset, not a replacement.

## 3. Scheduler: keep the calendar machinery

Keep `generateDueWorkOrdersForRange`, the guard table, and the advisory lock — that
idempotency beats the brief's `last_materialized_for`. Add:
- `campaign_form` (audit round) as a second target type
- a boot-time `setInterval` invoking generation daily, so materialization no longer
  depends on someone opening the calendar

No new `schedules` table unless the calendar-event model genuinely can't express
`lead_days`/`grace_days` — if it can't, extend calendar events rather than
parallel-building.

## 4. Old audit flow: retire it — migrate the QUESTIONS, not just the rows

Coexistence guardrail dropped; it was written before we knew it protected 2 findings
and 5 component rows. Migrate those rows in one pass, delete the old audit path once
the engine covers it.

The valuable migration is the question definitions: convert `question_applicability`
plus the `asset_property_dependencies` / `component_prompt_dependencies` rules into
the new engine's seed form. **That form IS the Phase 1 fixture.**

**New requirement this exposes:** building-type applicability. The old system's
`question_applicability` prevented N/A spam by building type. Audit questions get an
optional "applies to building types" filter driven by `building_types`, so one round
over mixed buildings asks the right questions per building. Part of the question
schema from the start.

## 5. question_key: shared namespace

One namespace across eras. Migrated questions keep their existing keys.

## 6. maps_to / asset properties: consolidate, don't pick blind

Determine which store the UI actually READS, make it canonical, migrate the other into
it, delete the loser. If both are read by different screens, STOP and report before
migrating.

## 7. Naming

- `work_order_templates` as it exists; fix the brief's `wo_templates` references.
- `audit_rounds` (and `audit_round_*` children), not `audit_campaigns`. UI label:
  "Audit Rounds."

## Confirmations

- Atomic POST → per-answer autosave: accepted cost. Load-bearing for walking 160
  buildings; not optional.
- New endpoints follow the existing PascalCase row-shape convention.
- Phase 1 fixture is the migrated old-audit form, not an invented one.
- Round screen: single aggregate query. No per-instance fetches at 340 assets.
- `work_order_tasks` being gone is fine; WO checklists arrive via §2.

## Unchanged from the brief

One WO per building per instance; clean building = no WO; remedy estimates snapshot at
generation; answers as one relational row each; condition-history tab on assets; audit
data screen with filters + CSV (extend Reports v1); overdue as a computed flag with the
dashboard strip; `docs/audit-schema.md` kept current with the migrations.

---

# Implementation log

Choices made while building, per "log the choice in the decisions doc."

## §6 — RESOLVED 2026-09-23: keep the EAV escape hatch

Decision: keep both stores. `asset_property_fields.column_name` is a router, not a
duplicate — being able to add a property field without shipping a migration serves
future admins, and the capability is unused rather than broken.

`maps_to: { kind: "asset_property" }` writes through the existing router
(`writeAssetProperties`, db.js ~345–390), so it inherits correct behavior for both
column-backed and EAV-backed fields automatically.

**No migration. No deletion. No data moved.** The section below records the
investigation that led here.

## §6 — reported, NOT migrated (this is the stop-and-report case, with a different fact)

The premise was that two live stores hold the same properties. They do not.

`asset_property_fields.column_name` is a **router**, one store per field:

- `column_name` set → the value lives in a real `assets` column
- `column_name` NULL → the value lives in `asset_property_values` (EAV), the
  escape hatch added by 0005 so an admin can add a property field without a migration

Live data:

- All 8 `asset_property_fields` rows have `column_name` set → all flat columns
- `asset_property_values` holds **0 rows**
- Column-backed fields that also have EAV rows: **none**

`getAssetDetail` reads both and merges, which looks like a dual read but isn't: for
any given field exactly one side can produce a value.

**So there is no loser to delete.** Deleting the EAV table would remove the
admin-extensible-fields capability, which is unused but not broken. Recommendation,
and what the schema assumes: leave both, and have `maps_to: asset_property` write
through the existing router (`writeAssetProperties`, db.js ~345–390) so it inherits
correct behavior for both kinds of field. No data migration, no deletion.

Flagged for a decision rather than actioned: whether to keep the EAV escape hatch at
all is a product call, not a schema one, and nothing in this build depends on it.

## §1 — link column already existed

`job_lines.condition_finding_id` (0034) plus auto-Scheduled / auto-Resolved in `db.js`
already implement the linkage rule exactly as specified. No new column, no new
lifecycle logic. The engine populates that column at generation.

Added instead: `condition_findings.audit_answer_id`, so a finding can be traced back to
the answer that raised it — the direction that did *not* exist.

## Schema shape choices

- **Remedy funding is `funding_source` + `funding_ref_id`**, not the brief's
  `funding_source_id`. `job_lines` models funding that way (0031) and generation stamps
  straight across; a single FK can't express `operating_budget` with no referenced row.
- **Building-type applicability is a join table**, `audit_question_building_types`, not
  an array column. §8 makes queryability a hard requirement. Empty set = applies to all.
- **No separate round-scope table.** A round's scope IS its instance rows; storing the
  scope twice invites drift.
- **`audit_answers.active`** carries the show_if hidden state, so generation and
  required-checks filter server-side rather than trusting the client's view.
- **`UNIQUE (form_id, question_key)`** plus a standalone index on `question_key`:
  unique within a form, joinable across forms and eras.

---

# OPEN QUESTION — blocking Phase 1 completion

Raised 2026-09-20, restated here 2026-09-22 because it was never answered and
should not live only in a terminal transcript.

**Status: the schema is live (0072–0074). The seed form is not started. All audit
tables are at 0 rows. Phase 2 (runner) cannot begin without a form to run.**

## The question

Decisions §4 says the Phase 1 fixture is the migrated old-audit form. That migration
splits in two, and only half of it is mechanical.

**Mechanical — no input needed.** The 8 `asset_property_fields` and 11
`component_type_catalog` entries become questions with their options;
`asset_property_dependencies` and `component_prompt_dependencies` become `show_if`
chains; `question_applicability` becomes `audit_question_building_types`. Keys
preserved per §5.

**Not mechanical.** The old audit has **no flag semantics and no remedies**. It let a
human type one free-text finding per audit. So:

- which answers mean "there's a problem" (`audit_question_options.flag`), and
- what fix each flagged leaf implies (`audit_remedies`: title template,
  responsibility, funding, hours, cost)

exist only in Ben's head. Nothing in the database encodes either one.

## The three ways forward

1. **Seed mechanically with `flag` unset and no remedies**, then hand-author flags and
   remedies for the roof / siding / interior subset only — enough to build and test the
   runner against. Everything else gets marked up later in the builder.
   *Recommended:* unblocks Phase 2 immediately and commits to no guesses about the
   buildings.
2. **Pull a minimal builder forward from Phase 4** so the flags and remedies can be
   authored in-app before the runner exists.
3. **Ben supplies the flag/remedy rules** for the seed questions and they're encoded
   faithfully.

Answering this unblocks Phase 2 of the audit engine. It does not block the board
report / purchases work, which proceeds on its own branch.

---

# Seed form — RESOLVED 2026-09-23

Option 1 **plus the hand-authored subset**: seed mechanically, then author flags and
remedies for roof / siding / interior only, so the generation chain (flagged answer →
remedy → job line → finding) can be tested as soon as the runner exists rather than
waiting for the Phase 4 builder.

## Conditions

1. **Everything authored is labelled test data.** Each authored flag and remedy carries
   a fixture marker, and every one is listed in this document. To be reviewed and
   replaced in the builder before any real audit round runs.
2. **Obvious defaults only.** `Poor` and `Fair` rating options flag. `No` flags on
   yes/no questions where no means a problem. Remedy hours and costs stay round and
   plainly placeholder — $100, 1 hour — so nobody mistakes them for estimates.
3. **Flags and remedies are form-level, set once in the builder, never during an
   audit.** The runner only records answers. Per-building adjustment happens on the
   review screen before WO creation, and changes that building's generated lines only —
   never the form's rules.

## Runner addition: "Flag something else"

Every section gets a **Flag something else** control: free-text description, optional
photo, optional hand-typed remedy (title, responsibility, funding, hours, cost).
It creates a finding, and a generated job line when a remedy was entered — the same
path a flagged answer takes.

Stored as an **answer tied to the section, not a question**, so ad-hoc flags stay
queryable alongside everything else. A free-text flag that keeps recurring across
buildings is the signal to add a real question in the builder.

## Two schema additions this implies (not yet built)

The 0072–0074 schema is already live, so both need a migration when the audit engine
resumes after the board-report branch merges.

**1. Section-tied answers.** `audit_answers.question_id` is currently NOT NULL with
`UNIQUE (instance_id, question_id)`. Ad-hoc flags need:
- `question_id` made nullable, `section_id` added (nullable FK to `audit_sections`)
- a CHECK that exactly one of the two is set
- the existing unique constraint still works — Postgres treats NULLs as distinct, so a
  building can carry several ad-hoc flags per section

**2. Ad-hoc remedies.** `audit_answer_remedies` currently requires `remedy_id`, which an
ad-hoc remedy has no template for. Proposal: make `remedy_id` nullable and add the
inline fields (`title`, `responsibility`, `funding_source`, `funding_ref_id`,
`est_hours`, `est_cost`) to the same table, so one row either points at a template
remedy or carries its own values, and generation reads one table either way.

**3. Fixture marking.** `audit_question_options.flag` is a bare boolean and
`audit_remedies` has no note field, so there is nowhere to record "this is test data."
Proposal: `is_fixture boolean NOT NULL DEFAULT false` on both, which makes
"show me everything still marked fixture" a query the builder can surface as a warning
before a real round runs.

## Sequencing

After the board-report branch merges. Then: seed form, then runner, per the build order.
