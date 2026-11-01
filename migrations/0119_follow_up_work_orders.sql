-- Follow-up work orders (Nov 2026).
--
-- A temporary fix needs a record that the real fix is still owed. At close-out a work order is
-- given a resolution type — Permanent, Interim (temporary fix) or Partial (some done, the rest
-- put off) — and an Interim or Partial one either gets a follow-up work order or a reason why not.
-- Deferred stays a STATUS, not a resolution type: a deferred work order already carries its own
-- reason and revisit date, so it is its own follow-up.
--
-- NOT parent_wo_id: that column is the split parent (1000 -> 1000-2) and drives the split
-- family's combined totals. A follow-up is a new piece of work after the fact, with its own
-- number and its own money, so it gets its own link.
--
-- Additive only. Every existing row keeps NULL in every new column.
BEGIN;

ALTER TABLE work_orders
  ADD COLUMN follow_up_of_wo_id integer REFERENCES work_orders(id) ON DELETE SET NULL,
  ADD COLUMN follow_up_of_job_line_id integer REFERENCES job_lines(id) ON DELETE SET NULL,
  ADD COLUMN resolution_type text CHECK (resolution_type IN ('permanent', 'interim', 'partial')),
  ADD COLUMN follow_up_declined_reason text;

-- A single line can be the interim fix inside an otherwise finished work order.
ALTER TABLE job_lines
  ADD COLUMN resolution_type text CHECK (resolution_type IN ('permanent', 'interim', 'partial'));

CREATE INDEX work_orders_follow_up_of_wo_id_idx ON work_orders (follow_up_of_wo_id)
  WHERE follow_up_of_wo_id IS NOT NULL;

COMMIT;
