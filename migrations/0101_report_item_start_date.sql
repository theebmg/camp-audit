-- Report rows show when work started as well as when it finished (Oct 2026 decisions §7):
-- "Started 9/5 · Completed 9/23", or "Started 9/5 · In progress".
--
-- snap_date already holds the finish. This is its pair. Additive, nullable, no backfill — the
-- next refresh of a draft fills it in from the work order, and a published report keeps the
-- snapshot it was published with, which is the point of snapshotting.
ALTER TABLE board_report_items ADD COLUMN snap_start_date date;
