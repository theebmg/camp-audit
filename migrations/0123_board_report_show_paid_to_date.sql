-- Board reports: a per-report switch for "Paid to date — all sources" (Nov 2026).
--
-- Ben wants to show the board, as a whole, how much each person and pot has put into the work —
-- above all his own money. Off by default for old reports so published ones read as before; the
-- current draft is turned on because he asked for it. New drafts inherit the last report's
-- setting, like show_hours.
BEGIN;
ALTER TABLE board_reports ADD COLUMN show_paid_to_date boolean NOT NULL DEFAULT false;
UPDATE board_reports SET show_paid_to_date = true WHERE status = 'draft';
COMMIT;
