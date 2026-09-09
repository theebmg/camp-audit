-- 0030 renamed work_order_tasks to job_lines; Postgres retargets existing FK
-- constraints automatically (they follow the table's OID, not its name), so
-- calendar_events.work_order_task_id and work_order_task_photos.task_id
-- already silently point at job_lines. Renaming the columns themselves here
-- so the code reading them isn't stuck saying "task" forever. No functional
-- change, purely closes the naming gap the table rename left behind.
ALTER TABLE calendar_events RENAME COLUMN work_order_task_id TO job_line_id;
ALTER INDEX idx_calendar_events_task RENAME TO idx_calendar_events_job_line;

ALTER TABLE work_order_task_photos RENAME COLUMN task_id TO job_line_id;
ALTER INDEX idx_work_order_task_photos_task RENAME TO idx_work_order_task_photos_job_line;
