-- A footnote under a header tile (Oct 2026).
--
-- "Contributed (non-camp)" needs to say that it includes work paid for directly with no
-- receipt, because that figure is not purely receipt-backed and a board reading it alongside
-- camp spend would otherwise assume it is. Snapshotted with the rest of the aggregate so a
-- published report keeps the wording it went out with.
BEGIN;

ALTER TABLE board_report_aggregates
  ADD COLUMN IF NOT EXISTS note text;

COMMENT ON COLUMN board_report_aggregates.note IS
  'Small print under the tile. Null for tiles that need no qualification.';

COMMIT;
