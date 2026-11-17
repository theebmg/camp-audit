-- Board report financial summary fixes (Nov 2026).
--
-- show_named_contributors: per report, default OFF. Off, the board sees "Contributed" rather than
-- a person's name, on the financial summary and on per-item funding lines. Published reports went
-- out with names showing, so they are switched on here to keep the copy of record reading as sent.
--
-- tracking_start_date: where "cumulative" figures start. Empty = the earliest recorded cost or
-- receipt date.
BEGIN;
ALTER TABLE board_reports ADD COLUMN show_named_contributors boolean NOT NULL DEFAULT false;
UPDATE board_reports SET show_named_contributors = true WHERE status = 'published';
ALTER TABLE display_settings ADD COLUMN tracking_start_date date;
COMMIT;
