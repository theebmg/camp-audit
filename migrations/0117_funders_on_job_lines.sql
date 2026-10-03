-- A person, a donor or an in-kind gift as the funder of a job line (Oct 2026).
--
-- 0116 gave funding one list. This lets the old pair POINT AT that list: funding_source =
-- 'funder' with funding_ref_id = funding_sources.id. Everything that copies the pair — duplicate,
-- split, cascade, templates — therefore carries a person-funder through unchanged, with no code
-- path needing to know.
--
-- A form may also write ('person', people.id). The trigger turns that into the person's funder
-- row, creating it the first time that person funds anything, so 'person' is never stored.
--
-- Additive: one vocabulary row, wider CHECKs, no existing row touched.
BEGIN;

INSERT INTO job_line_funding_kinds (source, label, counts_as_camp_spend, sort_order, is_general)
VALUES ('funder', 'Person / Donor', false, 60, false)
ON CONFLICT (source) DO NOTHING;

ALTER TABLE job_lines DROP CONSTRAINT job_lines_funding_source_check;
ALTER TABLE job_lines ADD CONSTRAINT job_lines_funding_source_check
  CHECK (funding_source IN ('operating_budget', 'capital_campaign', 'cabin_holder', 'other', 'fund', 'funder'));
ALTER TABLE expense_allocations DROP CONSTRAINT expense_allocations_funding_source_check;
ALTER TABLE expense_allocations ADD CONSTRAINT expense_allocations_funding_source_check
  CHECK (funding_source IS NULL OR funding_source IN ('operating_budget', 'capital_campaign', 'cabin_holder', 'other', 'fund', 'funder'));
ALTER TABLE work_order_template_lines DROP CONSTRAINT work_order_template_lines_funding_source_check;
ALTER TABLE work_order_template_lines ADD CONSTRAINT work_order_template_lines_funding_source_check
  CHECK (funding_source IS NULL OR funding_source IN ('operating_budget', 'capital_campaign', 'cabin_holder', 'other', 'fund', 'funder'));

-- The person's funder row, made on first use. Named for the person; a contribution, not camp spend.
CREATE OR REPLACE FUNCTION funder_for_person(p_person integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_id integer; v_name text;
BEGIN
  SELECT id INTO v_id FROM funding_sources WHERE person_id = p_person ORDER BY id LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT name INTO v_name FROM people WHERE id = p_person;
  IF v_name IS NULL THEN RAISE EXCEPTION 'No such person (%) to fund this', p_person; END IF;
  IF EXISTS (SELECT 1 FROM funding_sources WHERE name = v_name) THEN v_name := v_name || ' (person #' || p_person || ')'; END IF;
  INSERT INTO funding_sources (name, kind, person_id, counts_as_camp_spend, is_contribution, sort_order)
  VALUES (v_name, 'person', p_person, false, true, 200) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- 0116's lookup, taught the new kind. Everything else delegates to the original body.
ALTER FUNCTION funding_source_id_for(text, integer, boolean) RENAME TO funding_source_id_for_legacy;
CREATE OR REPLACE FUNCTION funding_source_id_for(p_source text, p_ref integer, p_create boolean DEFAULT true)
RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  IF p_source = 'funder' THEN
    RETURN (SELECT id FROM funding_sources WHERE id = p_ref);
  END IF;
  RETURN funding_source_id_for_legacy(p_source, p_ref, p_create);
END $$;

CREATE OR REPLACE FUNCTION sync_funding_source_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.funding_source = 'person' THEN
    NEW.funding_ref_id := funder_for_person(NEW.funding_ref_id);
    NEW.funding_source := 'funder';
  END IF;
  IF NEW.funding_source = 'funder' AND NOT EXISTS (SELECT 1 FROM funding_sources WHERE id = NEW.funding_ref_id) THEN
    RAISE EXCEPTION 'That funder no longer exists';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.funding_source_id IS NULL OR NEW.funding_source = 'funder' THEN
      NEW.funding_source_id := funding_source_id_for(NEW.funding_source, NEW.funding_ref_id);
    END IF;
  ELSIF NEW.funding_source IS DISTINCT FROM OLD.funding_source
     OR NEW.funding_ref_id IS DISTINCT FROM OLD.funding_ref_id THEN
    NEW.funding_source_id := funding_source_id_for(NEW.funding_source, NEW.funding_ref_id);
  END IF;
  RETURN NEW;
END $$;

-- Templates carry the pair but have no funding_source_id; they only need 'person' resolved.
CREATE OR REPLACE FUNCTION normalize_funding_pair() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.funding_source = 'person' THEN
    NEW.funding_ref_id := funder_for_person(NEW.funding_ref_id);
    NEW.funding_source := 'funder';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_wo_template_lines_funding ON work_order_template_lines;
CREATE TRIGGER trg_wo_template_lines_funding BEFORE INSERT OR UPDATE ON work_order_template_lines
  FOR EACH ROW EXECUTE FUNCTION normalize_funding_pair();

-- A funder that job lines point at through the soft pair must not be deletable from under them.
CREATE OR REPLACE FUNCTION guard_funding_source_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM job_lines WHERE funding_source = 'funder' AND funding_ref_id = OLD.id)
     OR EXISTS (SELECT 1 FROM expense_allocations WHERE funding_source = 'funder' AND funding_ref_id = OLD.id)
     OR EXISTS (SELECT 1 FROM work_order_template_lines WHERE funding_source = 'funder' AND funding_ref_id = OLD.id) THEN
    RAISE EXCEPTION 'This funder is still named on job lines, receipt splits or templates — reassign them first';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_guard_funding_source_delete ON funding_sources;
CREATE TRIGGER trg_guard_funding_source_delete BEFORE DELETE ON funding_sources
  FOR EACH ROW EXECUTE FUNCTION guard_funding_source_delete();

COMMIT;
