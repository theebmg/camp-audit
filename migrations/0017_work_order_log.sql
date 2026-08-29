-- A running work log per Work Order — free-text updates, optional hours
-- logged, optional status change — distinct from Tasks (scope-of-work
-- checklist) and from the single Estimated/Actual Hours aggregate fields.
-- This is what "log time, track updates, what's been done" feeds into,
-- and what future reporting will read from.

CREATE TABLE work_order_log_entries (
  id             serial PRIMARY KEY,
  work_order_id  integer NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  note           text NOT NULL,
  hours          numeric,
  status_change  text,
  username       text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_wo_log_entries_wo ON work_order_log_entries(work_order_id, created_at DESC);
