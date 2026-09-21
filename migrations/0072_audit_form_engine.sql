-- Audit Form Engine — form definition side (Build Brief §2, decisions doc §4/§5/§7).
--
-- Replaces the hard-coded audit (asset_property_fields + component_type_catalog
-- prompts, with show/hide split across asset_property_dependencies and
-- component_prompt_dependencies) with one programmable form. The old path stays
-- readable until the migrated seed form covers it; the decisions doc retires it
-- after that, so this migration adds nothing that assumes the old tables live on.
--
-- Two shapes differ deliberately from the brief's §2 text:
--   * remedies carry funding_source + funding_ref_id, not a funding_source_id.
--     job_lines already models funding that way (0031) and a generated line
--     stamps these straight across; a single FK could not express
--     'operating_budget' with no referenced row.
--   * building-type applicability is a join table rather than an array column.
--     §8 makes queryability a hard requirement, and "which questions apply to
--     cabins" should be a join, not an array scan.
--
-- Naming: audit_* here, audit_rounds (not campaigns) in 0073 — capital_campaign_projects
-- already owns "campaign" in this schema.

CREATE TABLE audit_forms (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  description  text,
  target_note  text,                                    -- free text, e.g. "cabins"
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_audit_forms_updated_at BEFORE UPDATE ON audit_forms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE audit_sections (
  id          serial PRIMARY KEY,
  form_id     integer NOT NULL REFERENCES audit_forms(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_index  integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_audit_sections_form ON audit_sections(form_id, sort_index);

CREATE TABLE audit_questions (
  id            serial PRIMARY KEY,
  form_id       integer NOT NULL REFERENCES audit_forms(id) ON DELETE CASCADE,
  section_id    integer REFERENCES audit_sections(id) ON DELETE SET NULL,
  -- Stable slug, denormalized onto every answer. Editing prompt wording keeps
  -- the key; a genuinely different question gets a new one. One namespace across
  -- eras (decisions §5) — migrated question_applicability keys keep their names,
  -- so condition history joins across the cutover.
  question_key  text NOT NULL,
  prompt        text NOT NULL,
  type          text NOT NULL CHECK (type IN ('rating','yes_no','select','number','text','check')),
  required      boolean NOT NULL DEFAULT false,
  allows_photo  boolean NOT NULL DEFAULT false,
  sort_index    integer NOT NULL DEFAULT 0,
  archived      boolean NOT NULL DEFAULT false,         -- never hard-delete a question with answers
  -- [{question_id, option_ids: []}], ANDed. The only condition mechanism (§3).
  show_if       jsonb,
  -- {kind:"component", component_type:"roof"} | {kind:"asset_property", field:"..."}
  maps_to       jsonb,
  UNIQUE (form_id, question_key)
);
CREATE INDEX idx_audit_questions_form ON audit_questions(form_id, sort_index);
CREATE INDEX idx_audit_questions_section ON audit_questions(section_id, sort_index);
-- Cross-form/cross-year analysis joins on the key alone.
CREATE INDEX idx_audit_questions_key ON audit_questions(question_key);

-- Empty set = applies to every building type. Absorbs what question_applicability
-- did for the old audit: one round over mixed buildings asks the right questions
-- per building instead of N/A spam.
CREATE TABLE audit_question_building_types (
  question_id       integer NOT NULL REFERENCES audit_questions(id) ON DELETE CASCADE,
  building_type_id  integer NOT NULL REFERENCES building_types(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, building_type_id)
);
CREATE INDEX idx_audit_qbt_building_type ON audit_question_building_types(building_type_id);

CREATE TABLE audit_question_options (
  id           serial PRIMARY KEY,
  question_id  integer NOT NULL REFERENCES audit_questions(id) ON DELETE CASCADE,
  label        text NOT NULL,      -- display; may be renamed freely
  value        text NOT NULL,      -- stored on answers; renaming a label can't corrupt history
  sort_index   integer NOT NULL DEFAULT 0,
  flag         boolean NOT NULL DEFAULT false,   -- "this answer indicates a problem"
  archived     boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_audit_question_options_question ON audit_question_options(question_id, sort_index);

-- Remedies hang off the leaf option that fully specifies the fix ("Partial +
-- Replace"), not the gate answer ("Poor"). Values here are a template: generation
-- stamps resolved copies onto the job line, so editing a remedy later never moves
-- a WO that already exists (same rule as everywhere else in this app).
CREATE TABLE audit_remedies (
  id              serial PRIMARY KEY,
  option_id       integer NOT NULL REFERENCES audit_question_options(id) ON DELETE CASCADE,
  title_template  text NOT NULL,                        -- supports {asset}
  responsibility  text,
  funding_source  text CHECK (funding_source IN ('operating_budget','capital_campaign','cabin_holder','other')),
  funding_ref_id  integer,
  est_hours       numeric,
  est_cost        numeric,
  sort_index      integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_audit_remedies_option ON audit_remedies(option_id, sort_index);
