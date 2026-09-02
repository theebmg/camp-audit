-- Lets someone flag a Work Order or Condition Finding as worth calling out
-- in the board-facing Forward Focus report, independent of status/severity
-- (a Low-priority WO can still be board-relevant, e.g. it's expensive or
-- politically sensitive; a High-severity finding might already be routine).
ALTER TABLE work_orders ADD COLUMN board_focus boolean NOT NULL DEFAULT false;
ALTER TABLE condition_findings ADD COLUMN board_focus boolean NOT NULL DEFAULT false;
