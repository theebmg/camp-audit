-- Lets a Calendar Event link to one specific Work Order Task (a scope-of-work
-- line item), not just the parent Work Order. The API sets work_order_id
-- alongside work_order_task_id when linking via a task, so "View Linked Work
-- Order" and existing work_order_id-based logic keep working unchanged.

ALTER TABLE calendar_events
  ADD COLUMN work_order_task_id integer REFERENCES work_order_tasks(id) ON DELETE SET NULL;
CREATE INDEX idx_calendar_events_task ON calendar_events(work_order_task_id);
