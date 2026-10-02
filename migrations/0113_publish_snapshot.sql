-- What publishing took away, so it can be given back (Oct 2026).
--
-- Publishing clears the "Include on board report" flag on everything it carried — correctly:
-- the flag means the board still owes this a look, and a published report answers that. But
-- nothing recorded WHICH items were flagged, so the step could not be undone. Pressing Publish
-- was a one-way door.
--
-- Unchecked items are deleted on publish and are NOT recoverable from here; the confirmation
-- says so plainly instead of pretending otherwise.
BEGIN;

ALTER TABLE board_reports
  ADD COLUMN IF NOT EXISTS publish_snapshot jsonb;

COMMENT ON COLUMN board_reports.publish_snapshot IS
  'Taken at publish: the board_focus flags cleared, so Unpublish can restore them. '
  'Null on a report that was never published, or published before this existed.';

COMMIT;
