-- Build Brief v2, Phase 1: "the job line becomes the unit of work." Step one
-- is the rename itself — work_order_tasks (currently a bare scope-of-work
-- checklist) becomes job_lines, the table that will carry hours, cost,
-- funding, responsibility, status, and attachments in the migrations that
-- follow. Renaming first, in its own migration, keeps every later diff in
-- this series readable against the final name instead of the old one.
--
-- description -> title: job_lines is about to gain complaint/cause_note/
-- correction (0034) — real descriptive text fields. Keeping a column called
-- "description" alongside those invites confusion about which field is which.
-- "title" matches work_orders.title / condition_findings.title, the same
-- short-label role this column already plays.
ALTER TABLE work_order_tasks RENAME TO job_lines;
ALTER TABLE job_lines RENAME COLUMN description TO title;

ALTER TABLE job_lines RENAME CONSTRAINT work_order_tasks_pkey TO job_lines_pkey;
ALTER SEQUENCE work_order_tasks_id_seq RENAME TO job_lines_id_seq;
ALTER INDEX idx_work_order_tasks_wo RENAME TO idx_job_lines_wo;
ALTER TRIGGER trg_work_order_tasks_updated_at ON job_lines RENAME TO trg_job_lines_updated_at;
