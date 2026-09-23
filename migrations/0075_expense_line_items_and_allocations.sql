-- Purchases, split receipts (Build Brief §9, phase 2).
--
-- "Purchase" is a UI label, not a table. expenses already IS the receipt entity —
-- vendor, date, amount, receipt attachment (attachment_links role 'Receipt'), tax
-- handling, fund/category attribution, a triage inbox, and the email ingestion that
-- produced 10 of the 11 rows in the system. A separate purchases table would be a
-- second receipt store and a second ingestion story, so this extends what's here.
--
-- Two shapes of split, deliberately:
--   * line_item_id NULL  -> splitting the WHOLE expense by dollar amount. This is the
--     common case for an emailed receipt that was never itemized, and itemizing is
--     never a precondition for splitting.
--   * line_item_id set   -> splitting one line item, by quantity, with the dollar
--     share carried alongside.
-- amount is therefore NOT NULL in both shapes and is the single figure cost rollups
-- read; quantity is the optional detail.
--
-- material_id on line items arrives in phase 3 with the materials table rather than
-- being a forward reference to a table that doesn't exist yet.

ALTER TABLE expenses ADD COLUMN regular_price numeric
  CHECK (regular_price IS NULL OR regular_price >= 0);
COMMENT ON COLUMN expenses.regular_price IS
  'What this would have cost without the deal. regular_price - amount becomes a one_time savings_entries row.';

CREATE TABLE expense_line_items (
  id            serial PRIMARY KEY,
  expense_id    integer NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  description   text NOT NULL,
  quantity      numeric CHECK (quantity IS NULL OR quantity >= 0),
  unit          text,
  paid_amount   numeric CHECK (paid_amount IS NULL OR paid_amount >= 0),
  regular_price numeric CHECK (regular_price IS NULL OR regular_price >= 0),
  sort_index    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_expense_line_items_expense ON expense_line_items(expense_id, sort_index);

CREATE TABLE expense_allocations (
  id             serial PRIMARY KEY,
  expense_id     integer NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  -- NULL = this allocation splits the whole expense, by dollars.
  line_item_id   integer REFERENCES expense_line_items(id) ON DELETE CASCADE,
  dest_type      text NOT NULL CHECK (dest_type IN ('work_order','job_line','admin_task','leftover')),
  -- NULL only for 'leftover', which has no destination row until phase 3 gives it a material.
  dest_id        integer,
  quantity       numeric CHECK (quantity IS NULL OR quantity >= 0),
  amount         numeric NOT NULL CHECK (amount >= 0),
  -- Proportional share of the receipt's discount. Savings are counted ONCE, at the
  -- purchase; allocation distributes the share and never creates new savings.
  savings_amount numeric NOT NULL DEFAULT 0 CHECK (savings_amount >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_allocations_dest_id_required
    CHECK (dest_type = 'leftover' OR dest_id IS NOT NULL)
);
CREATE INDEX idx_expense_allocations_expense ON expense_allocations(expense_id);
CREATE INDEX idx_expense_allocations_line_item ON expense_allocations(line_item_id);
-- WO/job-line cost rollups read allocations through this.
CREATE INDEX idx_expense_allocations_dest ON expense_allocations(dest_type, dest_id);
