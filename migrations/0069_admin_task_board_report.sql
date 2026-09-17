-- Per-task "Include in board report" flag, the admin-task counterpart to
-- work_orders.board_focus. Defaults true (existing rows included): Ben
-- couldn't name a task he'd keep off the report, so the checkbox is an
-- opt-out rather than the WO's opt-in. Flagged tasks whose status counts as
-- work performed show in the Board Report's Administrative Work section
-- for the period.
ALTER TABLE admin_tasks ADD COLUMN include_in_board_report boolean NOT NULL DEFAULT true;
