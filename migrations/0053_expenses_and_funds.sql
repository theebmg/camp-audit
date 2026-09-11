-- Build Brief v3 Part 1: expense tracking + funds.
--
-- Conflict with the existing funding_source/funding_ref_id model on job_lines
-- (flagged to Ben before this migration was written, go-ahead given to
-- proceed): migration 0031 constrains job_lines.funding_source to
-- ('operating_budget','capital_campaign','cabin_holder','other') and
-- funding_ref_id is a soft, app-validated pointer into whichever of
-- capital_campaign_projects / cabin_holders / other_budget_categories
-- matches. The brief's §3.3 fund inheritance ("default fund_id from that
-- line's funding_ref_id if the line's funding_source is a fund") presupposes
-- a fifth funding_source value that doesn't exist yet. This migration adds
-- 'fund' as a legal funding_source (job_lines only — work_orders dropped
-- these columns in 0031 and never got them back) so funding_ref_id can point
-- at funds.id the same soft way it already points at the other three tables.
-- getFundingRefLabel (db.js) and the job-line funding picker (app.js) are
-- updated in the same pass as the rest of Part 1 wiring.

-- A fund is money with a ceiling Ben is personally accountable for — not a
-- general ledger, not the camp's operating budget (that stays a label with
-- no balance tracked; the treasurer owns that number). Expired funds drop
-- out of the default picker but stay selectable, and spending past `amount`
-- warns without blocking anything.
CREATE TABLE funds (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  amount         numeric NOT NULL,
  start_date     date,
  end_date       date,
  authorized_by  text,
  notes          text,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO funds (name, amount, start_date, end_date, authorized_by) VALUES
  ('Discretionary Audit Fund', 5000, current_date, '2026-12-31', 'Camp Sychar board');

-- What kind of thing an expense was — independent axis from fund (which pot
-- it came from). Admin-editable; freetext never gets promoted into this
-- list, same rule as `causes`.
CREATE TABLE expense_categories (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 100,
  active     boolean NOT NULL DEFAULT true
);
INSERT INTO expense_categories (name, sort_order) VALUES
  ('Materials', 10), ('Tools', 20), ('Fuel', 30), ('Contractor', 40),
  ('Permit', 50), ('Supplies', 60), ('Other', 70);

-- Nearly everything nullable on purpose — an expense arrives from email with
-- almost nothing filled in and gets completed at triage, same shape as the
-- photo inbox's attachments row. Camp debit card only: there is no
-- reimbursement/pending/committed state, purchase_date is spend date, full
-- stop (see the brief's "do not re-litigate" list).
CREATE TABLE expenses (
  id                   serial PRIMARY KEY,
  vendor               text,
  amount               numeric,
  purchase_date        date,
  tax_amount           numeric,
  tax_charged_in_error boolean NOT NULL DEFAULT false,
  category_id          integer REFERENCES expense_categories(id),
  fund_id              integer REFERENCES funds(id),
  job_line_id          integer REFERENCES job_lines(id) ON DELETE SET NULL,
  work_order_id        integer REFERENCES work_orders(id) ON DELETE SET NULL,
  asset_id             integer REFERENCES assets(id) ON DELETE SET NULL,
  notes                text,
  triage_status        text NOT NULL DEFAULT 'triaged'
                         CHECK (triage_status IN ('inbox','triaged','void')),
  batch_id             integer REFERENCES attachment_batches(id) ON DELETE SET NULL,
  source               text NOT NULL DEFAULT 'manual'
                         CHECK (source IN ('manual','email')),
  parsed_confidence    text,   -- 'parsed' | 'partial' | 'none' — UI hint only
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
CREATE INDEX idx_expenses_fund ON expenses(fund_id);
CREATE INDEX idx_expenses_job_line ON expenses(job_line_id);
CREATE INDEX idx_expenses_triage ON expenses(triage_status) WHERE deleted_at IS NULL;

-- Receipts are attachments (attachment_links.entity_type = 'expense',
-- entity_id = expenses.id, role 'Receipt') — no second file store.
INSERT INTO attachment_roles (name, sort_order, default_include_in_report)
  SELECT 'Receipt', 75, false
  WHERE NOT EXISTS (SELECT 1 FROM attachment_roles WHERE name = 'Receipt');

-- See the header comment: widen job_lines.funding_source to allow a fifth
-- pool, 'fund', pointing (softly, like the other three) at funds.id.
ALTER TABLE job_lines DROP CONSTRAINT job_lines_funding_source_check;
ALTER TABLE job_lines ADD CONSTRAINT job_lines_funding_source_check
  CHECK (funding_source IN ('operating_budget','capital_campaign','cabin_holder','other','fund'));
