-- Phase 1 (1.3): the rest of job_lines' new columns — complaint/cause_note/
-- correction (filled in during/after the work, not at creation — see 1.6),
-- blocked_reason/blocked_since (Phase 2 will derive a WO-level "blocked"
-- badge from these; the columns land now so Phase 2 has somewhere to write),
-- completed_date, and condition_finding_id (the 1:1 link back to the finding
-- this line addresses — nullable, not every line comes from a finding;
-- closing the line resolves the finding, wired up in Phase 3).
--
-- status_id is deliberately NOT added here. The brief's own migration snippet
-- puts `status_id integer REFERENCES job_line_statuses(id)` in this same
-- section, but job_line_statuses isn't created until Phase 2 (2.1) — a FK to
-- a table that doesn't exist yet is impossible, not a style choice. status_id
-- is added in Phase 2's migration, alongside job_line_statuses, in the same
-- change that gives it something to reference.
ALTER TABLE job_lines
  ADD COLUMN complaint            text,
  ADD COLUMN cause_note           text,
  ADD COLUMN correction           text,
  ADD COLUMN blocked_reason       text,
  ADD COLUMN blocked_since        date,
  ADD COLUMN completed_date       date,
  ADD COLUMN condition_finding_id integer REFERENCES condition_findings(id);
CREATE INDEX idx_job_lines_condition_finding ON job_lines(condition_finding_id);
