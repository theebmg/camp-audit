-- Fields the rolled-up report rows need (Oct 2026 decisions §2, §2c, §7).

-- Estimates are shown as "est." on OPEN items and never summed into a total, so they need
-- their own column rather than being folded into snap_cost.
ALTER TABLE board_report_items
  ADD COLUMN snap_est_cost  numeric,
  -- "Camp $1,000 · Personal $240", built at snapshot time from the receipts allocated to the
  -- item's lines. Stored rather than resolved at read, like every other snap_ field: a
  -- published report must not change when a receipt is re-split later.
  ADD COLUMN snap_funding   jsonb;

-- An admin task is one piece of work with a start and an end (§7). task_date becomes the
-- start; this is the finish. Nullable — an open task has no completion date — and no
-- backfill, so existing tasks keep reading exactly as they do now until Ben edits them.
ALTER TABLE admin_tasks ADD COLUMN completed_date date;
