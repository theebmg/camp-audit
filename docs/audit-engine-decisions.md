# Audit Engine — Decisions

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
