-- Board report: one cost total per completed work order (Nov 2026).
--
-- snap_total_cost / snap_total_funding: the work order's FULL total and who paid it, display only.
-- They are never summed into 'Cost of work shown', which keeps counting this period's spending.
-- no_cost_labor_only: a completed work order marked labor-only stops being flagged as missing a cost.
BEGIN;
ALTER TABLE board_report_items ADD COLUMN snap_total_cost numeric(12,2);
ALTER TABLE board_report_items ADD COLUMN snap_total_funding jsonb;
ALTER TABLE work_orders ADD COLUMN no_cost_labor_only boolean NOT NULL DEFAULT false;
COMMIT;
