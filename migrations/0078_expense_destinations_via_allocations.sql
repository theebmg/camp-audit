-- Destinations move to expense_allocations (phase 2b).
--
-- expenses.work_order_id / job_line_id duplicated what expense_allocations now
-- records, and the two could disagree the moment a receipt was split. One source of
-- truth: EVERY destination is an allocation row, including the unsplit case — picking
-- a work order on the ordinary expense form writes one allocation behind the scenes.
-- The API row shape keeps JobLineId / WorkOrderId (read through the allocation), so
-- nothing downstream changes.
--
-- Same retirement pattern as admin_tasks.recurring_monthly_savings in 0076: copy
-- first, drop second, one transaction. 0 rows carry either column today, so the copy
-- is a no-op in practice — written anyway so this migration is correct on any
-- database, not just this one.
--
-- expenses.asset_id deliberately stays: it is a reporting dimension of the receipt
-- ("this receipt was about Cabin 12"), read by filters and display joins, never by
-- cost rollups. It is not a destination and does not belong in allocations.
-- expenses.fund_id also stays for now — funding-per-allocation is a separate decision.

INSERT INTO expense_allocations (expense_id, dest_type, dest_id, amount)
SELECT e.id, 'job_line', e.job_line_id, COALESCE(e.amount, 0)
FROM expenses e
WHERE e.job_line_id IS NOT NULL AND e.deleted_at IS NULL;

-- Only where a job line didn't already claim it — a row carrying both pointed at one
-- destination, and the line is the more specific of the two.
INSERT INTO expense_allocations (expense_id, dest_type, dest_id, amount)
SELECT e.id, 'work_order', e.work_order_id, COALESCE(e.amount, 0)
FROM expenses e
WHERE e.work_order_id IS NOT NULL AND e.job_line_id IS NULL AND e.deleted_at IS NULL;

ALTER TABLE expenses DROP COLUMN job_line_id;
ALTER TABLE expenses DROP COLUMN work_order_id;
