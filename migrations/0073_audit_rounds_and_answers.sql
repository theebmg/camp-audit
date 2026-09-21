-- Audit Form Engine — execution side: rounds, per-building instances, and the
-- answer catalog (Build Brief §2/§4/§8, decisions §1/§7).
--
-- "Round" rather than "campaign": capital_campaign_projects already owns that
-- word here, and audit_campaigns would read ambiguously in every future query.
--
-- The round's asset scope IS its instance rows — a round is created with one
-- instance per asset in scope, so a separate scope table would be a second copy
-- of the same fact and could drift from it.
--
-- Answers are relational rows, one per answered question, never a JSON blob of
-- the form (§8). That is what makes "every building where roof_condition = Poor"
-- a plain WHERE instead of a JSON scan, and it is the whole reason this schema
-- looks the way it does.

CREATE TABLE audit_rounds (
  id              serial PRIMARY KEY,
  form_id         integer NOT NULL REFERENCES audit_forms(id),
  name            text NOT NULL,                  -- "Fall 2026 Cabin Audit"
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  scheduled_date  date,
  due_date        date,                           -- overdue is computed from this, never stored
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_audit_rounds_updated_at BEFORE UPDATE ON audit_rounds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_audit_rounds_form ON audit_rounds(form_id);
CREATE INDEX idx_audit_rounds_due ON audit_rounds(due_date) WHERE status = 'open';

CREATE TABLE audit_round_instances (
  id               serial PRIMARY KEY,
  round_id         integer NOT NULL REFERENCES audit_rounds(id) ON DELETE CASCADE,
  asset_id         integer NOT NULL REFERENCES assets(id),
  status           text NOT NULL DEFAULT 'not_started'
                     CHECK (status IN ('not_started','in_progress','complete')),
  started_at       timestamptz,
  completed_at     timestamptz,
  -- Null is a real answer, not a gap: a clean building completes with no WO and
  -- the completed instance is the record (§4).
  generated_wo_id  integer REFERENCES work_orders(id) ON DELETE SET NULL,
  UNIQUE (round_id, asset_id)
);
-- The rounds screen reads per-building status for 130+ instances as one
-- aggregate over this index, never per-instance fetches (decisions, smaller flags).
CREATE INDEX idx_audit_instances_round_status ON audit_round_instances(round_id, status);
CREATE INDEX idx_audit_instances_asset ON audit_round_instances(asset_id);

CREATE TABLE audit_answers (
  id            serial PRIMARY KEY,
  instance_id   integer NOT NULL REFERENCES audit_round_instances(id) ON DELETE CASCADE,
  question_id   integer NOT NULL REFERENCES audit_questions(id),
  -- Denormalized copy: the join key for cross-year analysis. Survives the
  -- question's prompt being reworded, and survives the form being edited
  -- underneath an open round.
  question_key  text NOT NULL,
  value         text,
  option_id     integer REFERENCES audit_question_options(id),
  note          text,
  -- A question hidden by show_if keeps its stored answer but goes inactive:
  -- excluded from generation and required-checks, restored if it shows again.
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, question_id)
);
CREATE TRIGGER trg_audit_answers_updated_at BEFORE UPDATE ON audit_answers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_audit_answers_instance ON audit_answers(instance_id);
-- The §8 audit-data screen: form + question (+ round) -> asset x answer.
CREATE INDEX idx_audit_answers_key_value ON audit_answers(question_key, value);
CREATE INDEX idx_audit_answers_option ON audit_answers(option_id);

-- Which remedy was actually chosen for a flagged answer, so generation is
-- reproducible and auditable after the fact.
CREATE TABLE audit_answer_remedies (
  id         serial PRIMARY KEY,
  answer_id  integer NOT NULL REFERENCES audit_answers(id) ON DELETE CASCADE,
  remedy_id  integer NOT NULL REFERENCES audit_remedies(id),
  UNIQUE (answer_id, remedy_id)
);
CREATE INDEX idx_audit_answer_remedies_answer ON audit_answer_remedies(answer_id);

-- Decisions §1: finding = the issue record, job line = the work record. The link
-- and its lifecycle already exist (job_lines.condition_finding_id, 0034, with
-- auto-Scheduled/auto-Resolved in db.js) — the engine populates that column when
-- it generates a line, rather than adding a parallel link. What is new is the
-- trail from the answer to the finding it raised, so a finding can be traced
-- back to the audit that found it.
ALTER TABLE condition_findings
  ADD COLUMN audit_answer_id integer REFERENCES audit_answers(id) ON DELETE SET NULL;
CREATE INDEX idx_condition_findings_audit_answer ON condition_findings(audit_answer_id);
