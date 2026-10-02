-- "General" funding, and the renamed report mode (Oct 2026).
--
-- The default tag rule was "tag what camp did not pay for". That hid earmarked camp funds: the
-- drywall line came out of the Discretionary Fund and printed with no tag at all, exactly as if
-- it had come from the general operating budget. The board could not tell the two apart.
--
-- The rule becomes "tag everything except the GENERAL operating budget". Earmarked camp money
-- is still camp spend — this changes what is LABELLED, not what is counted.
BEGIN;

ALTER TABLE job_line_funding_kinds ADD COLUMN IF NOT EXISTS is_general boolean NOT NULL DEFAULT false;
ALTER TABLE funding_sources        ADD COLUMN IF NOT EXISTS is_general boolean NOT NULL DEFAULT false;

-- Exactly one of each is the general pot. Everything else — funds, cabin holders, donors,
-- in-kind — earns a tag.
UPDATE job_line_funding_kinds SET is_general = (source = 'operating_budget');
UPDATE funding_sources        SET is_general = (name = 'Camp funds');

-- 'non_camp' becomes 'non_general'. The constraint is widened first so existing rows stay valid
-- while they are rewritten, then narrowed again to drop the old value.
ALTER TABLE board_reports DROP CONSTRAINT IF EXISTS board_reports_show_funding_check;
ALTER TABLE board_reports ADD CONSTRAINT board_reports_show_funding_check
  CHECK (show_funding IN ('off', 'non_camp', 'non_general', 'all'));

UPDATE board_reports SET show_funding = 'non_general' WHERE show_funding = 'non_camp';
ALTER TABLE board_reports ALTER COLUMN show_funding SET DEFAULT 'non_general';

ALTER TABLE board_reports DROP CONSTRAINT board_reports_show_funding_check;
ALTER TABLE board_reports ADD CONSTRAINT board_reports_show_funding_check
  CHECK (show_funding IN ('off', 'non_general', 'all'));

COMMENT ON COLUMN job_line_funding_kinds.is_general IS
  'The general operating budget — the one source that needs no tag on the report.';
COMMENT ON COLUMN funding_sources.is_general IS
  'The general camp pot. Earmarked funds are camp spend but are NOT general, so they are tagged.';

COMMIT;
