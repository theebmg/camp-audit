-- The seed form: the old hard-coded audit, migrated (Addendum §1, decisions §4).
--
-- MECHANICAL PART — no judgment involved:
--   asset_property_fields (8)   -> questions, keys preserved
--   component_type_catalog (11) -> questions, keys prefixed component_
--   asset_property_dependencies -> show_if  (has_key = Yes reveals key_fits_lock)
--   component_prompt_dependencies -> show_if (components gated on free_standing_building)
--   question_applicability      -> audit_question_building_types
--
-- AUTHORED PART — every row marked is_fixture = true:
--   The old audit had no flag semantics and no remedies; it let a human type one
--   free-text finding per audit. Which answers mean "there's a problem", and what fix
--   each implies, existed only in Ben's head. So flags and remedies here are
--   PLACEHOLDERS that make the answer -> finding -> job line chain testable, and are
--   listed in docs/audit-engine-decisions.md for review in the builder before any real
--   round runs. Costs are deliberately round ($100, 1 hour) so nobody mistakes them for
--   estimates.
--
-- Deviation worth knowing: the instruction named "roof, siding and interior". Roof and
-- Siding are component conditions and take the rating rule (Fair/Poor/Failed flag).
-- There is no interior CONDITION question in the old audit — interior_finish records
-- construction ("Finished" / "Open Studs"), not a defect, and flagging a building for
-- having open studs would be a claim about these buildings I have no basis to make.
-- The third remedy therefore hangs off key_fits_lock = "No", which is unambiguously the
-- yes/no rule the instruction describes: a key that does not fit its lock is a problem.

INSERT INTO audit_forms (name, description, target_note)
VALUES ('Building Audit',
        'Migrated from the original hard-coded audit. Flags and remedies marked as fixtures are placeholders pending review.',
        'All buildings');

INSERT INTO audit_sections (form_id, name, sort_index)
SELECT f.id, s.name, s.sort_index
FROM audit_forms f, (VALUES ('Building', 10), ('Access', 20), ('Condition', 30)) AS s(name, sort_index)
WHERE f.name = 'Building Audit';

-- ── Property-field questions ─────────────────────────────────────────────
INSERT INTO audit_questions (form_id, section_id, question_key, prompt, type, sort_index, maps_to)
SELECT f.id,
       (SELECT id FROM audit_sections WHERE form_id = f.id
         AND name = CASE WHEN pf.field_key IN ('has_key','key_fits_lock') THEN 'Access' ELSE 'Building' END),
       pf.field_key, pf.label,
       CASE WHEN pf.input_type = 'number' THEN 'number' ELSE 'select' END,
       pf.sort_order,
       jsonb_build_object('kind', 'asset_property', 'field', pf.field_key)
FROM asset_property_fields pf, audit_forms f
WHERE f.name = 'Building Audit' AND pf.active;

INSERT INTO audit_question_options (question_id, label, value, sort_index)
SELECT q.id, opt.label, opt.label, opt.ord
FROM audit_questions q
JOIN audit_forms f ON f.id = q.form_id AND f.name = 'Building Audit'
JOIN asset_property_fields pf ON pf.field_key = q.question_key
CROSS JOIN LATERAL unnest(pf.options) WITH ORDINALITY AS opt(label, ord)
WHERE pf.input_type <> 'number';

-- ── Component-condition questions ────────────────────────────────────────
INSERT INTO audit_questions (form_id, section_id, question_key, prompt, type, sort_index, allows_photo, maps_to)
SELECT f.id,
       (SELECT id FROM audit_sections WHERE form_id = f.id AND name = 'Condition'),
       'component_' || lower(replace(ct.component_type, ' ', '_')),
       ct.component_type || ' condition',
       'rating', 100 + ct.sort_order, true,
       jsonb_build_object('kind', 'component', 'component_type', ct.component_type)
FROM component_type_catalog ct, audit_forms f
WHERE f.name = 'Building Audit';

INSERT INTO audit_question_options (question_id, label, value, sort_index)
SELECT q.id, opt.label, opt.label, opt.ord
FROM audit_questions q
JOIN audit_forms f ON f.id = q.form_id AND f.name = 'Building Audit'
JOIN component_type_catalog ct
  ON 'component_' || lower(replace(ct.component_type, ' ', '_')) = q.question_key
CROSS JOIN LATERAL unnest(ct.condition_options) WITH ORDINALITY AS opt(label, ord);

-- ── show_if: has_key = Yes reveals key_fits_lock ─────────────────────────
UPDATE audit_questions q
SET show_if = jsonb_build_array(jsonb_build_object(
      'question_id', gate.id,
      'option_ids', (SELECT jsonb_agg(o.id) FROM audit_question_options o
                     WHERE o.question_id = gate.id AND o.label = ANY(dep.show_when))))
FROM asset_property_dependencies dep
JOIN audit_questions gate ON gate.question_key = dep.field_key
JOIN audit_forms gf ON gf.id = gate.form_id AND gf.name = 'Building Audit'
WHERE q.question_key = ANY(dep.reveals) AND q.form_id = gate.form_id;

-- ── show_if: component prompts gated on free_standing_building ───────────
UPDATE audit_questions q
SET show_if = jsonb_build_array(jsonb_build_object(
      'question_id', gate.id,
      'option_ids', (SELECT jsonb_agg(o.id) FROM audit_question_options o
                     WHERE o.question_id = gate.id AND o.label = ANY(dep.show_when))))
FROM component_prompt_dependencies dep
JOIN audit_questions gate ON gate.question_key = dep.field_key
JOIN audit_forms gf ON gf.id = gate.form_id AND gf.name = 'Building Audit'
JOIN component_type_catalog ct ON ct.prompted_in_audit
-- q is the UPDATE target, so it can only be referenced here, never in a FROM join.
WHERE q.form_id = gate.form_id
  AND q.question_key = 'component_' || lower(replace(ct.component_type, ' ', '_'));

-- ── Building-type applicability ──────────────────────────────────────────
INSERT INTO audit_question_building_types (question_id, building_type_id)
SELECT q.id, qa.building_type_id
FROM question_applicability qa
JOIN audit_questions q ON q.question_key = qa.question_key
JOIN audit_forms f ON f.id = q.form_id AND f.name = 'Building Audit'
WHERE qa.applies
ON CONFLICT DO NOTHING;

-- ── FIXTURES: flags ──────────────────────────────────────────────────────
-- Rating questions: Fair and Poor flag, per the instruction. Failed flags too — it is
-- strictly worse than Poor, and flagging Poor while ignoring Failed would be indefensible.
-- Severe (drives the asset's Poor condition status, §5d) is Poor and Failed only.
UPDATE audit_question_options o
SET flag = true, is_fixture = true,
    severe = (o.label IN ('Poor', 'Failed'))
FROM audit_questions q
JOIN audit_forms f ON f.id = q.form_id AND f.name = 'Building Audit'
WHERE o.question_id = q.id AND q.type = 'rating' AND o.label IN ('Fair', 'Poor', 'Failed');

-- The yes/no rule: a key that does not fit its lock is a problem.
UPDATE audit_question_options o
SET flag = true, is_fixture = true
FROM audit_questions q
JOIN audit_forms f ON f.id = q.form_id AND f.name = 'Building Audit'
WHERE o.question_id = q.id AND q.question_key = 'key_fits_lock' AND o.label = 'No';

-- ── FIXTURES: three remedies ─────────────────────────────────────────────
INSERT INTO audit_remedies (option_id, title_template, responsibility, funding_source, est_hours, est_cost, is_fixture)
SELECT o.id, r.title, 'self', 'operating_budget', 1, 100, true
FROM audit_questions q
JOIN audit_forms f ON f.id = q.form_id AND f.name = 'Building Audit'
JOIN audit_question_options o ON o.question_id = q.id
JOIN (VALUES
  ('component_roof',   'Poor',   'Repair roof — {asset}'),
  ('component_siding', 'Poor',   'Repair siding — {asset}'),
  ('key_fits_lock',    'No',     'Re-key or replace lock — {asset}')
) AS r(qkey, olabel, title)
  ON r.qkey = q.question_key AND r.olabel = o.label;
