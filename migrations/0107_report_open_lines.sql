-- "Still to do" under an open work order (Oct 2026 layout change).
--
-- The report only ever carried COMPLETED job lines as items. What a job still has left is just
-- as much the board's business, but those lines are not report items in their own right — they
-- belong to the work order's row. Stamped alongside the rest of the snapshot so a published
-- report keeps what it went out with.
BEGIN;

ALTER TABLE board_report_items
  ADD COLUMN IF NOT EXISTS snap_open_lines jsonb;

COMMENT ON COLUMN board_report_items.snap_open_lines IS
  'Titles of this work order''s lines that are not finished, stamped at suggest time. '
  'Printed as "Still to do" under an open work order. Null on anything else.';

COMMIT;
