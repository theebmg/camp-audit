-- Reopen, featured-flag expiry, and arrears completion dates.

-- ── 1. Arrears: when the work was marked done, as a fallback ─────────────
-- changeJobLineStatus only sets completed_date when it is empty, and the grid lets a
-- date be cleared — so a line entered in arrears with the date left blank has a
-- resolved status and no date at all, and the board report's Done rule (which keys on
-- completed_date) never sees it. That is the reported bug.
--
-- completed_at records WHEN THE STATUS CHANGED, which is not the same fact as when the
-- work happened. It is a fallback for ordering and inclusion, never a substitute — the
-- UI marks any line relying on it as "date not recorded", so nobody reads the stamp as
-- the work date.
ALTER TABLE job_lines ADD COLUMN completed_at timestamptz;

-- Backfill what can be known: an already-resolved line with a date keeps that date as
-- its stamp. Lines with neither stay null and simply have no fallback to offer.
UPDATE job_lines SET completed_at = completed_date::timestamptz
WHERE completed_date IS NOT NULL AND completed_at IS NULL;

-- ── 2. Featured flags: since when ────────────────────────────────────────
-- "Featured since March" is how a stale flag becomes visible. Without a timestamp the
-- flag is a bare boolean with no way to tell a deliberate feature from one set a year
-- ago and forgotten.
ALTER TABLE work_orders        ADD COLUMN board_focus_set_at timestamptz;
ALTER TABLE job_lines          ADD COLUMN board_focus_set_at timestamptz;
ALTER TABLE condition_findings ADD COLUMN board_focus_set_at timestamptz;

-- Anything already flagged is dated now rather than left null: null would render as
-- "featured since —", which reads like a bug rather than like history.
UPDATE work_orders        SET board_focus_set_at = now() WHERE board_focus AND board_focus_set_at IS NULL;
UPDATE condition_findings SET board_focus_set_at = now() WHERE board_focus AND board_focus_set_at IS NULL;
UPDATE job_lines          SET board_focus_set_at = now() WHERE board_focus AND board_focus_set_at IS NULL;

-- ── 3. Manually added report items ───────────────────────────────────────
-- An item pulled in by hand must survive a suggestion refresh, and must be visibly
-- different from one the rules proposed — otherwise "why is this here?" has no answer.
-- It also counts as user_touched, so the stale-item prune can never remove it.
ALTER TABLE board_report_items ADD COLUMN manually_added boolean NOT NULL DEFAULT false;
