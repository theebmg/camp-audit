# Audit Engine — Addendum (seed form, ad-hoc flags, note routing, asset profile)

Adds to `docs/audit-engine-decisions.md`. Sequencing unchanged: the audit engine
resumes after `board-report-purchases` merges. The one exception is **§5a (photos +
profile layout)**, which has no dependency on the engine and may be built whenever
convenient.

Guardrails unchanged: real data, additive migrations, existing conventions, everything
visible and queryable in-app.

## 1. Seed form — option 1 plus test fixtures

- Seed mechanically: the 8 `asset_property_fields` and 11 `component_type_catalog`
  entries become questions with options; dependency rules become `show_if` chains;
  `question_applicability` becomes `audit_question_building_types`; keys preserved.
- Hand-author flags and remedies for **roof, siding and interior only**, so the
  answer → finding → job line chain is testable immediately.
- **Label every authored flag and remedy as a fixture** (`is_fixture = true`) and list
  each in the decisions doc. Reviewed and replaced in the builder before any real round.
- Obvious defaults only: `Poor` and `Fair` flag; `No` flags where no means a problem.
  Placeholder remedy values: $100, 1 hour.
- Flags and remedies are defined **once per form in the builder**, never during an audit.
  The runner records answers. The review screen adjusts that building's generated lines
  only, never the form's rules.

## 2. §6 — keep the EAV escape hatch

Both property stores stay as the router they are. `maps_to: asset_property` writes
through `writeAssetProperties`. No migration, no deletion.

## 3. "Flag something else" (runner)

- On every section of the runner.
- Captures free-text description, optional photo(s), optional hand-typed remedy
  (title, responsibility, funding, hours, cost).
- Creates a condition finding; with a remedy, generates a job line at review, exactly
  like a flagged answer.
- Stored as an answer tied to the **section** (`question_id` null, `section_id` set,
  type `adhoc_flag`), so it is queryable alongside regular answers and appears in the
  audit data screen and asset condition history.

## 4. Audit note routing

Every note captured in the runner gets a destination:

- **Audit only** (default): stays on the audit record.
- **Asset note:** also creates an asset note (§5c) with source "From \<round name\>" and
  a link back to the answer.
- **Job note:** attaches to the job line that answer generates. Notes on a section or
  ad-hoc flag without their own line attach to the building's WO as a whole.

Rules:
- The original note **always** remains on the audit answer. Routing adds a linked copy;
  it never moves or removes the audit record.
- **Job note with no job:** if the building ends with no WO, the review screen lists the
  stranded job notes and asks per note — asset note, or keep audit-only. **No note is
  silently dropped.**
- The destination is stored on the note row, so routing is queryable ("all job notes
  from Fall 2026").

## 5. Asset profile page

A redesign of the existing asset detail page (`getAssetDetail`), not a new system.

### 5a. Photos and type icons — no engine dependency, may ship anytime
- Default icon per asset type (cabin, camp building, tabernacle…), configurable in
  settings.
- Replaceable with a per-asset profile photo via the existing attachments pipeline
  (resize on ingest).
- Shown on the asset page header **and** in asset lists and search results.
- In the runner, any exterior photo can be marked **"Use as profile photo."**

### 5b. Layout, top to bottom
1. **Header:** photo, name, type, location. For cabins, the **current cabin holder** in
   smaller text under the name.
2. **Condition:** status plus the reasons driving it (§5d).
3. **Notes:** asset notes, newest first (§5c).
4. **Open work:** active WOs and open findings.
5. **History:** completed work, audit condition history over time, components and
   replacement years.

### 5c. Asset notes
- Dated entries, not a single text field: `asset_id`, body, `created_at`,
  `source` (manual | audit), source link (answer id when from an audit), author.
- Addable on the profile; audit-routed notes arrive the same way with their source shown.
- Newest first. Editable and deletable — deleting an audit-sourced entry never touches
  the audit answer.
- **Shown at the top of the runner** when starting an audit on that building, so
  standing notes ("shutoff is behind the shed") are seen before the walk-through.
- Separate from WO notes. Never merged, never pulled into WOs or board reports.

### 5d. Condition status — depends on the audit engine
- Three states: **Good / Needs attention / Poor**, always displayed **with reasons**,
  e.g. "Roof: Poor (Fall 2026 audit) · 2 open findings · 1 overdue WO."
- Never a bare numeric score.
- Default rule, thresholds editable in settings:
  - **Poor:** any overdue WO on the asset, or any flagged answer in its latest completed
    audit still unresolved whose option is marked **severe** (add an optional `severe`
    boolean on `audit_question_options`; fixture-flag Poor ratings as severe).
  - **Needs attention:** any open finding or open WO, and not Poor.
  - **Good:** none of the above.
  - **No audit yet:** "Not yet audited" alongside the open-work status.
- Computed on read, never stored. Clears itself as work completes.

## 6. Acceptance checklist (additions)

- [ ] Seed form migrated; fixture flags/remedies tagged and listed; generation chain testable end to end.
- [ ] "Flag something else" on every section creates a finding and optional job line; stored as a queryable section-level answer.
- [ ] Every runner note has audit-only / asset / job routing; originals stay on the audit; stranded job notes resolved at review, never dropped.
- [ ] Asset type icons and profile photos on the asset page and in lists; "use as profile photo" works from the runner.
- [ ] Profile layout: header, condition with reasons, notes, open work, history.
- [ ] Asset notes are dated entries with source; shown at the top of the runner.
- [ ] Condition status shows reasons, uses the editable rule, never a bare score, updates as work completes.

---

## Investigation results (done 2026-09-23, before building)

**§5c — `asset_notes` already exists.** Created in `0001_init.sql`, currently 2 rows:
`id`, `asset_id`, `note`, `resolved`, `created_by`, `created_at`, `updated_at`.
(`photo_url` was in the original migration but has since been dropped.) So §5c is
**two additive columns**, not a new table: `source` (`manual | audit`) and
`source_answer_id`. Nothing to migrate.

**§5b — the cabin-holder relationship exists, but as a string join.** See
`docs/open-questions.md`, Q2. It works on today's data and has no foreign key.
