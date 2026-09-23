-- Which calendar event types belong on the board report (Build Brief §5, phase 2).
--
-- calendar_event_types already exists (0061) and calendar_events.type_id is NOT NULL on
-- every row, so this is one additive column rather than a new table and a backfill.
--
-- Default off: a board report that silently starts listing every group rental and
-- constituent visit is worse than one that lists nothing until asked. Opt in per type
-- in admin/settings.
ALTER TABLE calendar_event_types
  ADD COLUMN show_on_board_report boolean NOT NULL DEFAULT false;
