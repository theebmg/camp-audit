-- Board reports: a per-report switch for work picked up by SCHEDULED date (Nov 2026).
--
-- Coming Up and Overdue are filled from job lines' scheduled dates. Ben wants that to be his
-- choice per report: on, they arrive as today; off, only flagged items and anything he added or
-- ticked by hand appear there. Defaults on, so every existing report reads exactly as before;
-- a new draft inherits the previous report's setting, like show_hours.
BEGIN;
ALTER TABLE board_reports ADD COLUMN show_scheduled boolean NOT NULL DEFAULT true;
COMMIT;
