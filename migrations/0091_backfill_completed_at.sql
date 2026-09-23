-- Backfill completed_at on resolved lines that never got one.
--
-- A line created ALREADY in a resolved status (the job-line grid lets a status be
-- picked at creation) never passes through changeJobLineStatus, which is the only place
-- that stamped completed_at. 0090's backfill covered lines that had a completed_date to
-- copy from; this covers the rest, using created_at — the line was recorded as done when
-- it was created, so that is the closest honest approximation of "when it was marked
-- done", and it is a fallback the UI labels rather than presents as the work date.
--
-- 0 rows on this database today (every resolved line already has one), written so the
-- migration is correct wherever it runs and so the case can't silently reappear.
UPDATE job_lines jl
SET completed_at = COALESCE(jl.completed_date::timestamptz, jl.created_at)
FROM job_line_statuses s
WHERE s.id = jl.status_id
  AND s.counts_as_work_performed
  AND jl.completed_at IS NULL;
