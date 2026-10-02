-- "Show hours" on a board report (Oct 2026).
--
-- Per report, not global: one month's report may be about labour and the next about money.
-- Default OFF, so every report that already exists keeps its hours hidden until Ben turns them
-- on — additive, nothing rewritten, no existing report changes what it prints except by losing
-- a figure he has asked not to see by default.
--
-- Hours stay recorded on job lines and admin tasks regardless. This governs the REPORT only.
BEGIN;

ALTER TABLE board_reports
  ADD COLUMN IF NOT EXISTS show_hours boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN board_reports.show_hours IS
  'Print hours on this report (footer, section headers, item rows). Default off. A new draft '
  'inherits whatever the previous report used.';

COMMIT;
