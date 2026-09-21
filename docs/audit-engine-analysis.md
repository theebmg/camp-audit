# Audit Engine — Codebase Analysis

Written 2026-09-20, before any code, against the live schema and database.
Companion to `docs/audit-engine-decisions.md`, which answers the questions raised here.

## Summary

The Build Brief treats several subsystems as new that already exist in this app.
Building to the brief literally would have produced a third checklist system, a
second recurrence engine, and a second question-key namespace.

## Already present

| Brief section | Already in the codebase |
|---|---|
| §2 checklists on templates + WOs | `checklist_templates`, `checklist_template_steps`, `checklist_instances`, `checklist_instance_steps` — with conditional steps (`depends_on_step_id`, `show_when_checked`, migration 0011) |
| §6 recurrence → materialize WO, idempotent | `generateDueWorkOrdersForRange()` — recurrence expansion, `calendar_event_generated_wo` guard table, `pg_advisory_xact_lock`, capped at today |
| §8 stable `question_key` | `question_applicability` keys audit questions by `question_key` + building type |
| §3 show-if conditions | `asset_property_dependencies` (`show_when`/`reveals`), `component_prompt_dependencies` |
| §8 filter + CSV export | Reports v1 — faceted filter + CSV across 7 entities, `findings` among them |
| §6 deferred/revisit surfacing | `work_orders.revisit_date` (indexed); `condition_findings` lifecycle Open → Scheduled → Resolved/Deferred/Dismissed (0043) |
| §2 job line ↔ finding link | `job_lines.condition_finding_id` (0034) **plus** auto-Scheduled / auto-Resolved already implemented in `db.js` |

## Scale reality

Live counts at time of writing:

```
assets 340 · locations 50           <- real catalog
condition_findings 2 · work_orders 5 · asset_components 5
work_order_templates 0 · checklist_templates 0 · calendar_events 2
```

The catalog is real; the operational data is test data. The brief's guardrail
"the existing hard-coded audit flow stays working" was protecting 2 findings and
5 component rows — the most expensive constraint in the brief, guarding almost
nothing. Raising this is what led to decisions §4 (retire it).

## Genuinely new

- The 11 form-engine tables (forms, sections, questions, options, remedies, rounds, instances, answers, answer-remedies, question↔building-type).
- Per-answer autosave with a retry queue. Today's audit is a single atomic `POST /assets/:id/audit` carrying `{properties, componentEvents, finding}` — note *one* finding.
- The form runner and the form builder.
- Campaign/round screen, computed overdue, dashboard strip.
- The first true background job in the app (existing PM generation is lazily triggered by `GET /calendar-events`, so nothing materializes if nobody opens the calendar).
- Query surfaces: asset condition history tab, audit data screen, round report.

## Notes carried into the build

- `work_order_tasks` (migration 0009) no longer exists — dropped later. WO checklists arrive via the `checklist_*` tables.
- The DB is snake_case; the API layer converts to PascalCase via row-shape functions (`jobLineRowShape` etc.). New endpoints follow that convention.
- The brief says `wo_templates`; the table is `work_order_templates`.
- `capital_campaign_projects` already owns "campaign" — audit uses `audit_rounds`.
- 340 assets makes "130+ instances without choking" real: the round screen needs one aggregate query.
