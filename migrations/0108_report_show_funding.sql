-- Funding on the report (Oct 2026).
--
-- 1. show_funding: per report, like show_hours, inheriting from the last report.
--      'off'      — no funding anywhere
--      'non_camp' — tag only money that did NOT come from camp funds (the default: the board's
--                   question is "what did this cost camp", so camp money needs no tag)
--      'all'      — tag every cost with where the money came from
--
-- 2. funding_sources.short_label: what the tag says. "Funded by Ben" reads better on a line
--    than "Funded by Personal (Ben)". Admin-editable like the rest of the vocabulary; the full
--    name is still what the expense form and the header use.
BEGIN;

ALTER TABLE board_reports
  ADD COLUMN IF NOT EXISTS show_funding text NOT NULL DEFAULT 'non_camp';

ALTER TABLE board_reports
  DROP CONSTRAINT IF EXISTS board_reports_show_funding_check;
ALTER TABLE board_reports
  ADD CONSTRAINT board_reports_show_funding_check
  CHECK (show_funding IN ('off', 'non_camp', 'all'));

ALTER TABLE funding_sources
  ADD COLUMN IF NOT EXISTS short_label text;

-- Seeded from the names already in use; anything added later falls back to its full name.
UPDATE funding_sources SET short_label = 'Camp'   WHERE name = 'Camp funds'              AND short_label IS NULL;
UPDATE funding_sources SET short_label = 'Ben'    WHERE name = 'Personal (Ben)'          AND short_label IS NULL;
UPDATE funding_sources SET short_label = 'Donor'  WHERE name = 'Donor / designated gift' AND short_label IS NULL;
UPDATE funding_sources SET short_label = 'In-kind' WHERE name = 'In-kind'                AND short_label IS NULL;

COMMENT ON COLUMN board_reports.show_funding IS
  'off | non_camp | all — how much funding detail this report prints. Inherited by a new draft.';
COMMENT ON COLUMN funding_sources.short_label IS
  'Short name for report tags ("Funded by Ben"). Falls back to name when unset.';

COMMIT;
