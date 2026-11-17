-- Performed by + volunteer thanks on the board report (Nov 2026).
--
-- No new tables: "performed by" is the job line's existing responsibility_class (Self is shown
-- as In-house) plus the vendors and volunteers already linkable to a line (job_line_vendors,
-- job_line_volunteers). These columns add only what was missing:
--   people.no_board_report_name   opt-out from being named in the board report's thank-you line
--   board_reports.thanks_text      Ben's edited thank-you line; NULL = generate it
--   board_reports.thanks_hidden    leave the thank-you line out of this report
--   work_orders.performed_by_confirmed  "In-house is right" — stops the report screen flagging a
--                                  completed work order whose lines were all left on the default
--   board_report_items.snap_performed_by  the tag printed on a work order's row, frozen at publish
BEGIN;
ALTER TABLE people ADD COLUMN no_board_report_name boolean NOT NULL DEFAULT false;
ALTER TABLE board_reports ADD COLUMN thanks_text text;
ALTER TABLE board_reports ADD COLUMN thanks_hidden boolean NOT NULL DEFAULT false;
ALTER TABLE work_orders ADD COLUMN performed_by_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE board_report_items ADD COLUMN snap_performed_by text;
COMMIT;
