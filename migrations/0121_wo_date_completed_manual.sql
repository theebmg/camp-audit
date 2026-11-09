-- Work orders: remember whether date_completed was typed by a person (Nov 2026).
--
-- Closing a work order stamped today's date on it, so a job finished 10/28 but closed out
-- during month-end tidying on 11/1 went to the board report as 11/1. The day the work was
-- recorded as done must win. When date_completed was set automatically, readers now use the
-- latest completed date on the work order's job lines; when a person typed it on the work
-- order, theirs wins. Existing rows default to false (automatic) — no data is changed.
BEGIN;
ALTER TABLE work_orders ADD COLUMN date_completed_manual boolean NOT NULL DEFAULT false;
COMMIT;
