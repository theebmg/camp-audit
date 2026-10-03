-- One funding list, and funders as people (Oct 2026).
--
-- Receipts said WHAT KIND of money (funding_sources) and job lines said WHOSE
-- (funding_source + funding_ref_id, a soft reference to one of four tables). Neither was a
-- superset, and "Personal (Ben)" and "Cabin-Holder > Greenawalt, Ben" were one funder under two
-- names. This gives funding_sources a kind and a reference, and gives job lines and receipt
-- splits a funding_source_id ALONGSIDE the old pair.
--
-- Additive. Nothing is dropped and nothing existing is rewritten: the old pair stays the thing
-- the application reads, and a trigger keeps the new column in step with it, so no write site
-- can be missed. scripts/funding-reconcile.mjs proves the two agree on every row.
--
-- This is the first migration here that CREATES records: one funding_sources row per fund,
-- campaign, category or holder that already funds something. Approved by Ben 2026-10-03.
BEGIN;

ALTER TABLE funding_sources
  ADD COLUMN IF NOT EXISTS kind      text,
  ADD COLUMN IF NOT EXISTS person_id integer REFERENCES people(id),
  ADD COLUMN IF NOT EXISTS fund_id   integer REFERENCES funds(id),
  ADD COLUMN IF NOT EXISTS ref_table text,
  ADD COLUMN IF NOT EXISTS ref_id    integer;

ALTER TABLE funding_sources DROP CONSTRAINT IF EXISTS funding_sources_kind_check;
ALTER TABLE funding_sources ADD CONSTRAINT funding_sources_kind_check CHECK (kind IS NULL OR kind IN
  ('camp_general', 'camp_fund', 'person', 'donor_org', 'in_kind', 'campaign', 'other_category', 'cabin_holding'));

COMMENT ON COLUMN funding_sources.kind IS
  'camp_general | camp_fund (fund_id) | person (person_id) | donor_org | in_kind | campaign / '
  'other_category / cabin_holding (ref_table + ref_id). cabin_holding is a holder with no single '
  'person linked — a label like "Smith Family".';

ALTER TABLE job_lines           ADD COLUMN IF NOT EXISTS funding_source_id integer REFERENCES funding_sources(id);
ALTER TABLE expense_allocations ADD COLUMN IF NOT EXISTS funding_source_id integer REFERENCES funding_sources(id);
CREATE INDEX IF NOT EXISTS idx_job_lines_funding_source_id ON job_lines (funding_source_id);
CREATE INDEX IF NOT EXISTS idx_expense_allocations_funding_source_id ON expense_allocations (funding_source_id);

-- Hours and logins become attributable to a person. username stays: it records who ENTERED a
-- session, which is a different fact from whose hours they were.
ALTER TABLE crew_sessions ADD COLUMN IF NOT EXISTS person_id integer REFERENCES people(id);
ALTER TABLE users         ADD COLUMN IF NOT EXISTS person_id integer REFERENCES people(id);
CREATE INDEX IF NOT EXISTS idx_crew_sessions_person ON crew_sessions (person_id);

-- Classify the four rows that exist. Names and labels are left exactly as they are.
UPDATE funding_sources SET kind = 'camp_general' WHERE kind IS NULL AND is_general;
UPDATE funding_sources SET kind = 'in_kind'      WHERE kind IS NULL AND is_in_kind;
UPDATE funding_sources SET kind = 'donor_org'    WHERE kind IS NULL AND name = 'Donor / designated gift';

-- (source, ref) -> funding_sources.id. With p_create false it only looks, which is what the
-- reconciliation script uses; with true it adds the row the first time something is funded
-- that way.
CREATE OR REPLACE FUNCTION funding_source_id_for(p_source text, p_ref integer, p_create boolean DEFAULT true)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_id integer; v_person integer; v_people integer; v_name text; v_kind text; v_table text;
  v_camp boolean; v_label text;
BEGIN
  IF p_source IS NULL THEN RETURN NULL; END IF;

  IF p_source = 'operating_budget' THEN
    SELECT id INTO v_id FROM funding_sources WHERE kind = 'camp_general' ORDER BY id LIMIT 1;
    RETURN v_id;
  END IF;

  SELECT counts_as_camp_spend, label INTO v_camp, v_label FROM job_line_funding_kinds WHERE source = p_source;
  v_camp := COALESCE(v_camp, true);
  v_label := COALESCE(v_label, p_source);

  IF p_source = 'fund' AND p_ref IS NOT NULL THEN
    SELECT id INTO v_id FROM funding_sources WHERE fund_id = p_ref ORDER BY id LIMIT 1;
    IF v_id IS NOT NULL OR NOT p_create THEN RETURN v_id; END IF;
    SELECT name INTO v_name FROM funds WHERE id = p_ref;
    v_kind := 'camp_fund';
  ELSIF p_source = 'cabin_holder' AND p_ref IS NOT NULL THEN
    -- A holding that names exactly one person is that person funding the work as themselves.
    SELECT count(*), min(person_id) INTO v_people, v_person FROM cabin_holder_people WHERE cabin_holder_id = p_ref;
    IF v_people = 1 THEN
      SELECT id INTO v_id FROM funding_sources WHERE person_id = v_person ORDER BY id LIMIT 1;
      IF v_id IS NOT NULL OR NOT p_create THEN RETURN v_id; END IF;
      SELECT name INTO v_name FROM people WHERE id = v_person;
      v_kind := 'person';
    ELSE
      v_person := NULL;
      SELECT id INTO v_id FROM funding_sources WHERE ref_table = 'cabin_holders' AND ref_id = p_ref ORDER BY id LIMIT 1;
      IF v_id IS NOT NULL OR NOT p_create THEN RETURN v_id; END IF;
      SELECT name INTO v_name FROM cabin_holders WHERE id = p_ref;
      v_kind := 'cabin_holding'; v_table := 'cabin_holders';
    END IF;
  ELSE
    -- A campaign project, an "other" category, or any kind with no specific reference.
    v_table := CASE p_source WHEN 'capital_campaign' THEN 'capital_campaign_projects'
                             WHEN 'other' THEN 'other_budget_categories'
                             WHEN 'cabin_holder' THEN 'cabin_holders'
                             WHEN 'fund' THEN 'funds' END;
    v_kind := CASE p_source WHEN 'capital_campaign' THEN 'campaign' WHEN 'other' THEN 'other_category'
                            WHEN 'cabin_holder' THEN 'cabin_holding' WHEN 'fund' THEN 'camp_fund' END;
    IF v_kind IS NULL THEN RETURN NULL; END IF;
    SELECT id INTO v_id FROM funding_sources
     WHERE kind = v_kind AND person_id IS NULL AND fund_id IS NULL
       AND ref_table IS NOT DISTINCT FROM (CASE WHEN p_ref IS NULL THEN NULL ELSE v_table END)
       AND ref_id IS NOT DISTINCT FROM p_ref
     ORDER BY id LIMIT 1;
    IF v_id IS NOT NULL OR NOT p_create THEN RETURN v_id; END IF;
    IF p_ref IS NULL THEN v_name := v_label; v_table := NULL;
    ELSIF p_source = 'capital_campaign' THEN SELECT name INTO v_name FROM capital_campaign_projects WHERE id = p_ref;
    ELSIF p_source = 'other' THEN SELECT name INTO v_name FROM other_budget_categories WHERE id = p_ref;
    END IF;
  END IF;

  v_name := COALESCE(NULLIF(btrim(v_name), ''), v_label || ' #' || p_ref);
  -- name is UNIQUE; a fund and a person could share one.
  IF EXISTS (SELECT 1 FROM funding_sources WHERE name = v_name) THEN
    v_name := v_name || ' (' || v_label || ')';
  END IF;
  IF EXISTS (SELECT 1 FROM funding_sources WHERE name = v_name) THEN
    v_name := v_name || ' #' || COALESCE(p_ref, 0);
  END IF;

  INSERT INTO funding_sources (name, kind, person_id, fund_id, ref_table, ref_id,
                               counts_as_camp_spend, is_contribution, sort_order)
  VALUES (v_name, v_kind, v_person, CASE WHEN v_kind = 'camp_fund' THEN p_ref END,
          v_table, CASE WHEN v_kind IN ('camp_fund', 'person') THEN NULL ELSE p_ref END,
          v_camp, NOT v_camp, 200)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- "Personal (Ben)" is the one person-funder that already exists as a row. It is attached to
-- the person behind the holdings that already fund job lines — and only when that is
-- unambiguous: exactly one person across every funding holding. The row's name is untouched.
UPDATE funding_sources fs
   SET kind = 'person', person_id = x.person_id
  FROM (
    SELECT min(chp.person_id) AS person_id
      FROM job_lines jl
      JOIN cabin_holder_people chp ON chp.cabin_holder_id = jl.funding_ref_id
     WHERE jl.funding_source = 'cabin_holder'
    HAVING count(DISTINCT chp.person_id) = 1
  ) x
 WHERE fs.name = 'Personal (Ben)' AND fs.kind IS NULL AND x.person_id IS NOT NULL;

-- Keep the new column in step with the old pair on every write, whatever code path made it.
-- Fires only when the pair is what changed, so a later release that writes funding_source_id
-- directly is not overruled.
CREATE OR REPLACE FUNCTION sync_funding_source_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.funding_source_id IS NULL THEN
      NEW.funding_source_id := funding_source_id_for(NEW.funding_source, NEW.funding_ref_id);
    END IF;
  ELSIF NEW.funding_source IS DISTINCT FROM OLD.funding_source
     OR NEW.funding_ref_id IS DISTINCT FROM OLD.funding_ref_id THEN
    NEW.funding_source_id := funding_source_id_for(NEW.funding_source, NEW.funding_ref_id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_job_lines_funding_source_id ON job_lines;
CREATE TRIGGER trg_job_lines_funding_source_id BEFORE INSERT OR UPDATE ON job_lines
  FOR EACH ROW EXECUTE FUNCTION sync_funding_source_id();
DROP TRIGGER IF EXISTS trg_expense_allocations_funding_source_id ON expense_allocations;
CREATE TRIGGER trg_expense_allocations_funding_source_id BEFORE INSERT OR UPDATE ON expense_allocations
  FOR EACH ROW EXECUTE FUNCTION sync_funding_source_id();

-- Backfill. Fills only the new, empty column; no existing value is changed — including
-- updated_at, which is why its trigger is stood down for these two statements.
ALTER TABLE job_lines DISABLE TRIGGER trg_job_lines_updated_at;
UPDATE job_lines SET funding_source_id = funding_source_id_for(funding_source, funding_ref_id)
 WHERE funding_source_id IS NULL AND funding_source IS NOT NULL;
UPDATE expense_allocations SET funding_source_id = funding_source_id_for(funding_source, funding_ref_id)
 WHERE funding_source_id IS NULL AND funding_source IS NOT NULL;

ALTER TABLE job_lines ENABLE TRIGGER trg_job_lines_updated_at;

-- A login whose person is unambiguous through the funder row just linked. Anything else is
-- linked by hand from the person's profile.
UPDATE users u SET person_id = fs.person_id
  FROM funding_sources fs
 WHERE u.person_id IS NULL AND u.username = 'ben' AND fs.name = 'Personal (Ben)' AND fs.person_id IS NOT NULL;

COMMIT;
