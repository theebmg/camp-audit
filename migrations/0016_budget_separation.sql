-- Separates capital planning from the operating budget, per the board-
-- presentation need: work orders get tagged with WHERE their money comes
-- from (operating budget / a capital campaign project / a cabin-holder /
-- a user-defined "other" category). This app is not an accounting system —
-- these are cost estimates for planning/presentation, not a ledger of
-- record. funding_ref_id is a soft (unenforced) reference: it points at
-- capital_campaign_projects.id, cabin_holders.id, or other_budget_categories.id
-- depending on funding_source — a real FK isn't possible across three
-- different target tables, so the app validates it instead.

CREATE TABLE budget_settings (
  id                      serial PRIMARY KEY,
  annual_operating_budget numeric NOT NULL DEFAULT 0,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO budget_settings (annual_operating_budget) VALUES (0);

CREATE TABLE capital_campaign_projects (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE other_budget_categories (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cabin_holders (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE work_orders ADD COLUMN funding_source text NOT NULL DEFAULT 'operating_budget'
  CHECK (funding_source IN ('operating_budget','capital_campaign','cabin_holder','other'));
ALTER TABLE work_orders ADD COLUMN funding_ref_id integer;
CREATE INDEX idx_work_orders_funding ON work_orders(funding_source, funding_ref_id);
