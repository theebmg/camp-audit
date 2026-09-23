-- Ad-hoc flags, ad-hoc remedies, fixture markers and severity (Addendum §3/§1/§5d).

-- ── 1. Answers can belong to a SECTION instead of a question ─────────────
-- "Flag something else" records something the form never asked about. It is still an
-- answer — it belongs in the same table so it shows up in the audit data screen and the
-- asset's condition history alongside everything else, rather than in a side channel
-- nobody queries.
--
-- Postgres treats NULLs as distinct in a unique index, so the existing
-- UNIQUE (instance_id, question_id) keeps working AND a building can carry several
-- ad-hoc flags per section.
ALTER TABLE audit_answers ALTER COLUMN question_id DROP NOT NULL;
ALTER TABLE audit_answers
  ADD COLUMN section_id integer REFERENCES audit_sections(id) ON DELETE SET NULL,
  ADD COLUMN kind text NOT NULL DEFAULT 'answer' CHECK (kind IN ('answer','adhoc_flag'));
ALTER TABLE audit_answers
  ADD CONSTRAINT audit_answers_question_xor_section CHECK (
    (kind = 'answer'     AND question_id IS NOT NULL) OR
    (kind = 'adhoc_flag' AND section_id  IS NOT NULL AND question_id IS NULL)
  );
CREATE INDEX idx_audit_answers_section ON audit_answers(section_id) WHERE section_id IS NOT NULL;

-- ── 2. A remedy typed by hand has no template to point at ────────────────
-- One row either references a template remedy or carries its own values, so generation
-- reads a single table either way rather than merging two sources at the point where
-- work orders get created.
ALTER TABLE audit_answer_remedies ALTER COLUMN remedy_id DROP NOT NULL;
ALTER TABLE audit_answer_remedies
  ADD COLUMN title text,
  ADD COLUMN responsibility text,
  ADD COLUMN funding_source text
    CHECK (funding_source IS NULL OR funding_source IN
      ('operating_budget','capital_campaign','cabin_holder','other','fund')),
  ADD COLUMN funding_ref_id integer,
  ADD COLUMN est_hours numeric,
  ADD COLUMN est_cost numeric;
ALTER TABLE audit_answer_remedies
  ADD CONSTRAINT audit_answer_remedies_template_or_inline CHECK (
    remedy_id IS NOT NULL OR title IS NOT NULL
  );

-- ── 3. Fixture markers ───────────────────────────────────────────────────
-- The seed form's flags and remedies are placeholders authored to make the
-- answer → finding → job line chain testable, NOT real rules. Marking them in the data
-- means "show me everything still marked fixture" is a query the builder can run before
-- a real audit round, instead of a promise someone has to remember.
ALTER TABLE audit_question_options ADD COLUMN is_fixture boolean NOT NULL DEFAULT false;
ALTER TABLE audit_remedies         ADD COLUMN is_fixture boolean NOT NULL DEFAULT false;

-- ── 4. Severity, for the asset condition status (§5d) ────────────────────
-- Not every flagged answer means the building is Poor. "Fair" is worth a work order;
-- "Failed" is worth saying the building is in poor condition. Only the second is severe.
ALTER TABLE audit_question_options ADD COLUMN severe boolean NOT NULL DEFAULT false;
