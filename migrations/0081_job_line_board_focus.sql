-- "Feature on board report" at the job-line level (Build Brief §2, phase 5).
--
-- work_orders.board_focus and condition_findings.board_focus already exist (0026) and
-- are KEPT — only their label changes, from "Forward Focus" to "Feature on board
-- report". What they mean is now explicit: include this item in Coming Up regardless of
-- the date window.
--
-- Job lines need the same flag because inclusion moved to line level: a work order can
-- have one line worth showing the board and four that are routine, and flagging the
-- whole WO to surface one line is the blunt instrument this replaces.
ALTER TABLE job_lines ADD COLUMN board_focus boolean NOT NULL DEFAULT false;
CREATE INDEX idx_job_lines_board_focus ON job_lines(board_focus) WHERE board_focus;
