# Audit Engine — Schema Reference

Kept current with the migrations (Build Brief §8). Written for a maintainer who
has never seen this code. Snake_case in the DB; the API layer converts to
PascalCase via row-shape functions in `src/db.js`.

Migrations: `0072_audit_form_engine.sql`, `0073_audit_rounds_and_answers.sql`,
`0074_due_dates_and_checklist_sections.sql`.

## Model in one paragraph

A **form** has **sections** holding **questions**. A question offers **options**;
an option may be marked as a flag ("this answer indicates a problem"), and a flagged
leaf option carries **remedies** — templates for the job lines that fix it. A **round**
runs one form over a set of assets, creating one **instance** per asset. Walking a
building records one **answer** row per question. Flagged answers produce findings and
job lines; the chosen remedies are recorded in **answer_remedies** so generation is
reproducible.

## Form definition

### audit_forms
`id` · `name` · `description` · `target_note` (free text, e.g. "cabins") · `active` · `created_at` · `updated_at`

### audit_sections
`id` · `form_id` → audit_forms (cascade) · `name` · `sort_index`
One section per screen in the runner.

### audit_questions
`id` · `form_id` → audit_forms (cascade) · `section_id` → audit_sections (set null) ·
`question_key` · `prompt` · `type` · `required` · `allows_photo` · `sort_index` ·
`archived` · `show_if` (jsonb) · `maps_to` (jsonb)

- `type` ∈ `rating | yes_no | select | number | text | check`. The first three use
  options; the rest don't.
- `question_key` — stable slug (`roof_condition`), denormalized onto every answer.
  Rewording the prompt keeps the key; a genuinely different question gets a new key.
  One namespace across eras, so history joins across the old-audit cutover.
- `archived` — questions with answers are archived, never deleted.
- `UNIQUE (form_id, question_key)`; separate index on `question_key` alone for
  cross-form analysis.

### audit_question_building_types
`question_id` + `building_type_id` → building_types. Composite PK.
**Empty set means the question applies to every building type.** Replaces the old
`question_applicability` table; stops N/A spam when one round covers mixed buildings.

### audit_question_options
`id` · `question_id` → audit_questions (cascade) · `label` · `value` · `sort_index` ·
`flag` · `archived`

`label` is display and may be renamed freely; `value` is what answers store, so a
rename can't corrupt history. `flag` marks the answer as indicating a problem.

### audit_remedies
`id` · `option_id` → audit_question_options (cascade) · `title_template` ·
`responsibility` · `funding_source` · `funding_ref_id` · `est_hours` · `est_cost` ·
`sort_index`

Remedies hang off the **leaf** option that fully specifies the fix ("Partial → Replace"),
not the gate answer ("Poor"). One option may carry several. `title_template` supports
the `{asset}` token. `funding_source` ∈ `operating_budget | capital_campaign |
cabin_holder | other` with `funding_ref_id` as the polymorphic reference — the same
shape `job_lines` uses (0031), so generation stamps straight across.

**Values here are a template.** Generation copies resolved values onto the job line, so
editing a remedy later never moves a work order that already exists.

## Execution

### audit_rounds
`id` · `form_id` → audit_forms · `name` · `status` (`open | closed`) ·
`scheduled_date` · `due_date` · `created_at` · `updated_at`

Called *rounds*, not campaigns — `capital_campaign_projects` already owns that word.
Overdue is computed from `due_date`, never stored as a status.

### audit_round_instances
`id` · `round_id` → audit_rounds (cascade) · `asset_id` → assets · `status`
(`not_started | in_progress | complete`) · `started_at` · `completed_at` ·
`generated_wo_id` → work_orders (set null) · `UNIQUE (round_id, asset_id)`

**The round's asset scope IS its instance rows** — there is no separate scope table,
because a second copy of that fact could drift from it.

A null `generated_wo_id` on a complete instance is a real answer, not a gap: a clean
building produces no WO and the completed instance is the record.

### audit_answers
`id` · `instance_id` → audit_round_instances (cascade) · `question_id` → audit_questions ·
`question_key` · `value` · `option_id` → audit_question_options · `note` · `active` ·
`created_at` · `updated_at` · `UNIQUE (instance_id, question_id)`

One row per answered question — **never a JSON blob of the form.** This is what makes
"every building where `roof_condition = Poor`" a plain `WHERE` instead of a JSON scan,
and it is the reason this schema looks the way it does.

`active` carries show_if state: a question hidden by a changed answer keeps its stored
answer but goes inactive — excluded from generation and required-checks, restored if it
shows again.

Photos attach through the existing unified attachments join with role `audit`.

### audit_answer_remedies
`id` · `answer_id` → audit_answers (cascade) · `remedy_id` → audit_remedies ·
`UNIQUE (answer_id, remedy_id)`

Which remedy was actually chosen, so generation is reproducible and auditable.

## JSON shapes

### show_if
```json
[{ "question_id": 12, "option_ids": [45, 46] }]
```
A list of conditions, **ANDed**. The question renders only when every referenced
question's current answer is one of the listed options. Chains are allowed — a
follow-up can trigger off a follow-up. **This is the only condition mechanism**; there
is no cross-question math, no cross-instance logic, no nested boolean builder.

### maps_to
```json
{ "kind": "component", "component_type": "roof" }
{ "kind": "asset_property", "field": "interior_finish" }
```
Optional per question. On instance completion:
- `component` — writes an *Inspected* row into `asset_components` for that asset and
  type with the answered condition, so condition history keeps feeding capital planning.
- `asset_property` — writes the property through the existing router in
  `writeAssetProperties` (`asset_property_fields.column_name` set → a real `assets`
  column; null → `asset_property_values`).

Routing is **additive**: the answer is stored in `audit_answers` regardless.

## Links to existing tables

- `job_lines.condition_finding_id` (0034) — the issue↔work link. Already carries
  auto-Scheduled / auto-Resolved behavior in `db.js`; the engine populates it at
  generation rather than adding a parallel link.
- `condition_findings.audit_answer_id` (0073) — the reverse trail, new: which answer
  raised this finding.
- `work_orders.due_date` (0074) — settable on any WO by hand, not only on
  scheduler-materialized ones. Distinct from `scheduled_date` (when we intend to do it)
  and `revisit_date` (when a deferred item comes back up).
- `checklist_template_steps.section` / `checklist_instance_steps.section` (0074) —
  nullable; existing steps keep NULL and render ungrouped as they do today.
