-- Phase 1 (1.2): hours, cost, funding and scheduling move from work_orders
-- down to job_lines. A single WO can now have lines funded from three
-- different sources with three different schedules (roof from capital
-- campaign on Tuesday, deck from a cabin holder on Saturday, one cabin, one
-- WO) — that's the whole point of this rework, not an edge case to work
-- around. Work-order-level totals become derived rollups computed on read
-- (see workOrderRollup() in db.js) and are never stored again.
--
-- Test data only — no backfill. A WO's existing estimate/actual/funding/
-- schedule values are simply dropped; anyone re-scoping existing test WOs
-- re-enters them as job lines.

ALTER TABLE job_lines
  ADD COLUMN estimated_hours numeric,
  ADD COLUMN actual_hours    numeric,
  ADD COLUMN estimated_cost  numeric,
  ADD COLUMN actual_cost     numeric,
  ADD COLUMN funding_source  text NOT NULL DEFAULT 'operating_budget'
    CHECK (funding_source IN ('operating_budget','capital_campaign','cabin_holder','other')),
  ADD COLUMN funding_ref_id  integer,
  ADD COLUMN scheduled_date  date;
CREATE INDEX idx_job_lines_funding ON job_lines(funding_source, funding_ref_id);
CREATE INDEX idx_job_lines_scheduled_date ON job_lines(scheduled_date);

ALTER TABLE work_orders
  DROP COLUMN estimated_hours,
  DROP COLUMN actual_hours,
  DROP COLUMN estimated_cost,
  DROP COLUMN actual_cost,
  DROP COLUMN funding_source,
  DROP COLUMN funding_ref_id,
  DROP COLUMN scheduled_date;
