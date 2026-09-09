-- Phase 1 (1.5): job lines get their own hours, sourced from crew_sessions
-- and work_order_log_entries — both nullable, because genuine WO-level time
-- exists (e.g. general site cleanup on a multi-line WO) and must not be
-- forced onto a line. Line actual hours = sum of crew_sessions.hours where
-- job_line_id matches; WO actual hours = sum of all sessions on the WO,
-- line-attributed or not; null-line hours still roll into the WO total but
-- are excluded from line-level percentage calculations (see workOrderRollup
-- in db.js). ON DELETE SET NULL, not CASCADE — deleting a job line should
-- never silently delete the hours logged against it.
--
-- Split from work_order_log_entries' half of this change (0037): that table
-- is currently owned by a different DB role (`nocodb`, not `camp_app`) from
-- some earlier migration quirk, so camp_app can't ALTER it until an operator
-- with superuser access runs `ALTER TABLE work_order_log_entries OWNER TO
-- camp_app;` once. Splitting means this half isn't blocked by that.
ALTER TABLE crew_sessions ADD COLUMN job_line_id integer REFERENCES job_lines(id) ON DELETE SET NULL;
CREATE INDEX idx_crew_sessions_job_line ON crew_sessions(job_line_id);
