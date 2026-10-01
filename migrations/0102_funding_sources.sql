-- Who paid (Oct 2026 decisions §2b).
--
-- Funding source lives on the EXPENSE, because that is where money changes hands. A job line's
-- funding split is therefore derived from the receipts allocated to it, never stored twice.
--
-- Not to be confused with the existing job_lines.funding_source, which is a BUDGET category
-- (operating_budget / capital_campaign / cabin_holder / other) answering "which pot is this
-- meant to come out of". This answers "whose money actually went in".
CREATE TABLE funding_sources (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  -- Camp money leaving the camp's account. Drives "Spent this period" in the report header.
  counts_as_camp_spend boolean NOT NULL DEFAULT false,
  -- Money or value coming IN from outside the camp — personal, donated, or in-kind. Reported
  -- separately so a contribution is never mixed into camp spend.
  is_contribution      boolean NOT NULL DEFAULT false,
  -- No cash changed hands: donated labour or materials, logged at estimated value.
  is_in_kind           boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO funding_sources (name, counts_as_camp_spend, is_contribution, is_in_kind, sort_order) VALUES
  ('Camp funds',             true,  false, false, 10),
  ('Personal (Ben)',         false, true,  false, 20),
  ('Donor / designated gift', false, true,  false, 30),
  ('In-kind',                false, true,  true,  40);

-- Nullable on purpose and NOT backfilled: Ben marks the personal ones himself, and an
-- unset expense must read as unset rather than as a guess that it was camp money.
ALTER TABLE expenses ADD COLUMN funding_source_id integer REFERENCES funding_sources(id) ON DELETE SET NULL;
CREATE INDEX idx_expenses_funding_source ON expenses (funding_source_id) WHERE funding_source_id IS NOT NULL;

-- In-kind has no receipt behind it, so it needs somewhere to say what it was.
ALTER TABLE expenses ADD COLUMN in_kind_note text;
