-- PM (preventive maintenance) auto-generation: a recurring Calendar Event can
-- be linked to a Work Order Template. Occurrences on or before today
-- generate a real Work Order on read (see generateDueWorkOrdersForRange in
-- db.js) instead of requiring someone to remember to create one manually.
ALTER TABLE calendar_events ADD COLUMN work_order_template_id integer REFERENCES work_order_templates(id);

-- Preset crew + a Self flag, copied onto each generated Work Order — same
-- shape as work_orders.responsible_self/the volunteer/vendor junctions
-- (migration 0024), just stored as the template's defaults.
ALTER TABLE work_order_templates
  ADD COLUMN responsible_self boolean NOT NULL DEFAULT false,
  ADD COLUMN preset_volunteer_ids integer[] NOT NULL DEFAULT '{}',
  ADD COLUMN preset_vendor_ids integer[] NOT NULL DEFAULT '{}';

-- One row per occurrence that has already generated its Work Order. The
-- UNIQUE constraint is the actual double-generation guard; an advisory lock
-- in generateDueWorkOrdersForRange just avoids two concurrent requests both
-- creating a Work Order before either commits.
CREATE TABLE calendar_event_generated_wo (
  id                  serial PRIMARY KEY,
  calendar_event_id   integer NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  occurrence_date     date NOT NULL,
  work_order_id       integer NOT NULL REFERENCES work_orders(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE(calendar_event_id, occurrence_date)
);
