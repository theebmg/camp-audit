-- Camp visitor tracking. A visit is a calendar event, not a new entity —
-- calendar_event_types already seeds 'Constituent Visitation' (0061) and
-- calendar_events already carries date/span/time/recurrence/Google sync,
-- so the visit only needs the who/where/why columns.
--
-- calendar_events had no asset_id before this (only work_order_id/
-- job_line_id, which reach an asset indirectly through a work order) —
-- confirmed against the live schema before adding it here.
--
-- cabin_holder_id is set ONLY by picking a holder in the UI, never by
-- matching visitor_name against cabin_holders.name. visitor_name is always
-- stored (a snapshot, defaulted from the holder's name when one is picked,
-- overridable) so a visit still reads correctly if the holder row is later
-- renamed or deleted — hence ON DELETE SET NULL rather than blocking the
-- delete.
ALTER TABLE calendar_events
  ADD COLUMN visitor_name     text,
  ADD COLUMN cabin_holder_id  integer REFERENCES cabin_holders(id) ON DELETE SET NULL,
  ADD COLUMN asset_id         integer REFERENCES assets(id) ON DELETE SET NULL,
  ADD COLUMN visit_purpose    text,
  ADD COLUMN visitor_contact  text;

CREATE INDEX idx_calendar_events_asset ON calendar_events(asset_id);
CREATE INDEX idx_calendar_events_cabin_holder ON calendar_events(cabin_holder_id);
