-- Fix duplicate report items for anything without an item_date.
--
-- board_report_items had UNIQUE (report_id, item_type, item_id, item_date), and
-- item_date is nullable. Postgres treats NULLs as DISTINCT in a unique constraint, so
-- for every item that has no date — admin tasks, work orders, job lines, findings, i.e.
-- almost everything — the constraint never matched and ON CONFLICT could never fire.
-- Each suggestion pass therefore INSERTED A NEW ROW instead of updating the existing
-- one, and the report accumulated duplicates.
--
-- (The same NULL-distinctness is relied on deliberately elsewhere — it's what lets a
-- building carry several ad-hoc flags per section. Here it was a liability.)
--
-- The fix is an expression index over a sentinel date, so NULL compares equal to NULL
-- and the upsert can find its row. item_date stays nullable and keeps its meaning;
-- only the uniqueness test changes.

-- Collapse existing duplicates first, keeping the row a human is most likely to have
-- touched: one that carries a decision beats one that doesn't, then the newest.
DELETE FROM board_report_items a
USING board_report_items b
WHERE a.report_id = b.report_id
  AND a.item_type = b.item_type
  AND a.item_id   = b.item_id
  AND COALESCE(a.item_date, DATE '1900-01-01') = COALESCE(b.item_date, DATE '1900-01-01')
  AND (
    (a.user_touched < b.user_touched)
    OR (a.user_touched = b.user_touched AND a.id < b.id)
  );

ALTER TABLE board_report_items
  DROP CONSTRAINT IF EXISTS board_report_items_report_id_item_type_item_id_item_date_key;

CREATE UNIQUE INDEX idx_board_report_items_unique
  ON board_report_items (report_id, item_type, item_id, (COALESCE(item_date, DATE '1900-01-01')));
