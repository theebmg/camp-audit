-- Build Brief v2, Phase 2 (2.2): work_orders.status becomes an admin-editable
-- table instead of a bare text column, matching the schema-driven philosophy
-- used everywhere else (asset properties, component types, causes...).
--
-- Urgent is deleted as a status — it's a priority and already exists on the
-- `priority` column. Keeping it as a status meant an urgent in-progress job
-- couldn't be both, silently undercounting.
--
-- On Hold / Blocked is NOT a status — it's orthogonal to pipeline position (a
-- half-finished roof waiting on materials is genuinely both In Progress and
-- blocked). Blocked lives as blocked_reason/blocked_since on job_lines
-- (already added in 0034); a WO is derived-blocked if any line has one set.
--
-- Test data only: every existing work order defaults to 'Reported' via the
-- column default below rather than a per-row status-string mapping — no
-- backfill logic, per the brief's guardrail.
CREATE TABLE work_order_statuses (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  sort_order  integer NOT NULL DEFAULT 100,
  color       text NOT NULL DEFAULT '#888888',
  is_terminal boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true
);
INSERT INTO work_order_statuses (name, sort_order, color, is_terminal) VALUES
  ('Reported',    10, '#888888', false),
  ('Assessed',    20, '#3b82f6', false),
  ('Scheduled',   30, '#8b5cf6', false),
  ('In Progress', 40, '#f59e0b', false),
  ('Done',        50, '#22c55e', true),
  ('Deferred',    60, '#64748b', true),
  ('Cancelled',   70, '#ef4444', true);

ALTER TABLE work_orders ADD COLUMN status_id integer REFERENCES work_order_statuses(id);
UPDATE work_orders SET status_id = (SELECT id FROM work_order_statuses WHERE name = 'Reported');
ALTER TABLE work_orders ALTER COLUMN status_id SET NOT NULL;
CREATE INDEX idx_work_orders_status ON work_orders(status_id);

ALTER TABLE work_orders DROP COLUMN status;
