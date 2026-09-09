-- Build Brief v2, Phase 2 (2.1): job_lines.status_id was deliberately left
-- out of Phase 1's migration 0034 because this table didn't exist yet — a FK
-- to a nonexistent table is impossible, not a style choice (see 0034's
-- comment). Landing both together now.
--
-- is_terminal and counts_as_work_performed do different jobs and neither can
-- be inferred from the other: is_terminal means this line no longer blocks
-- the WO from closing; counts_as_work_performed means real work happened.
-- "Not Needed" is terminal but NOT work performed — the distinction that
-- makes "12 lines completed, 3 determined unnecessary on inspection" a
-- reportable, honest sentence instead of "15 lines closed."
CREATE TABLE job_line_statuses (
  id                       serial PRIMARY KEY,
  name                     text NOT NULL UNIQUE,
  sort_order               integer NOT NULL DEFAULT 100,
  color                    text NOT NULL DEFAULT '#888888',
  is_terminal              boolean NOT NULL DEFAULT false,
  counts_as_work_performed boolean NOT NULL DEFAULT false,
  requires_note            boolean NOT NULL DEFAULT false,
  note_label               text,
  active                   boolean NOT NULL DEFAULT true
);
INSERT INTO job_line_statuses (name, sort_order, color, is_terminal, counts_as_work_performed, requires_note, note_label) VALUES
  ('Not Started',         10, '#888888', false, false, false, NULL),
  ('In Progress',         20, '#f59e0b', false, false, false, NULL),
  ('Waiting on Parts',    30, '#eab308', false, false, true,  'What are we waiting on?'),
  ('Waiting on Approval', 40, '#eab308', false, false, true,  'Waiting on whom?'),
  ('Waiting on Weather',  50, '#38bdf8', false, false, false, NULL),
  ('Done',                60, '#22c55e', true,  true,  false, NULL),
  ('Not Needed',          70, '#64748b', true,  false, true,  'Why was this not needed?'),
  ('Cancelled',           80, '#ef4444', true,  false, true,  'Why cancelled?');

ALTER TABLE job_lines ADD COLUMN status_id integer REFERENCES job_line_statuses(id);
UPDATE job_lines SET status_id = (SELECT id FROM job_line_statuses WHERE name = 'Not Started');
ALTER TABLE job_lines ALTER COLUMN status_id SET NOT NULL;
CREATE INDEX idx_job_lines_status ON job_lines(status_id);

-- Now that job_lines has a real status, `done` is redundant with
-- status_id -> is_terminal/counts_as_work_performed — one boolean and one
-- richer lifecycle shouldn't both claim to say "is this finished." Existing
-- `done = true` lines move to 'Done'; the column is dropped.
UPDATE job_lines SET status_id = (SELECT id FROM job_line_statuses WHERE name = 'Done') WHERE done;
ALTER TABLE job_lines DROP COLUMN done;
