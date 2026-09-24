-- A job line "Deferred" status, so deferring a work order can defer its open lines
-- rather than cancelling them. Deferred work is coming back and cancelled work isn't;
-- collapsing the two loses the only thing the distinction carries, which is why
-- changeWorkOrderStatus refuses to resolve lines this way until the status exists.
--
-- counts_as_work_performed is FALSE, and that is load-bearing rather than incidental:
-- changeJobLineStatus resolves a line's linked condition finding on exactly that flag,
-- and deferring work is not a reason to call its finding fixed. db.js refuses a
-- configuration that turns this on, for the same reason.
--
-- requires_note is FALSE: deferring a work order applies this to every open line at
-- once, and the work order's own deferred_reason — which IS required — already says why.
-- Asking again per line would be the same answer typed N times.
--
-- Sort order 75 places it between Not Needed (70) and Cancelled (80): the three
-- terminal-but-not-completed outcomes sit together, after Done.
INSERT INTO job_line_statuses (name, sort_order, color, is_terminal, counts_as_work_performed, requires_note, note_label)
VALUES ('Deferred', 75, '#a855f7', true, false, false, NULL)
ON CONFLICT (name) DO NOTHING;
