-- Reworks Job Lines to be free-text scope-of-work by default (asset_updates
-- stays as-is for the separate, optional "also update asset fields" case —
-- audit-style fields like Has Key belong to the audit flow, not routine WOs).
-- Adds independent Calendar Events with recurrence, and simple ordered
-- checklists attachable to a WO or a calendar event.

CREATE TABLE work_order_tasks (
  id            serial PRIMARY KEY,
  work_order_id integer NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  description   text NOT NULL,
  done          boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_work_order_tasks_updated_at BEFORE UPDATE ON work_order_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_work_order_tasks_wo ON work_order_tasks(work_order_id);

-- Calendar events are their own entity — NOT required to have a Work Order.
-- Recurrence is computed on read (no stored occurrence rows), expanded by
-- whatever month range the calendar view is showing.
CREATE TABLE calendar_events (
  id                    serial PRIMARY KEY,
  title                 text NOT NULL,
  description           text,
  event_date            date NOT NULL,
  recurrence_type       text NOT NULL DEFAULT 'none'
                          CHECK (recurrence_type IN ('none','daily','weekly','monthly','yearly')),
  recurrence_interval   integer NOT NULL DEFAULT 1,
  recurrence_end_date   date,
  work_order_id         integer REFERENCES work_orders(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_calendar_events_updated_at BEFORE UPDATE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_calendar_events_date ON calendar_events(event_date);
CREATE INDEX idx_calendar_events_wo ON calendar_events(work_order_id);

-- Simple ORDERED checklists (no branching — see migration brief chat log,
-- deliberately scoped down from conditional logic for v1). A template is the
-- reusable blueprint; an instance is a live, checkable copy attached to one
-- Work Order or one Calendar Event (steps are copied in at attach time, so
-- editing the template later doesn't rewrite history on things already using it).
CREATE TABLE checklist_templates (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE checklist_template_steps (
  id                      serial PRIMARY KEY,
  checklist_template_id   integer NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  step_text               text NOT NULL,
  sort_order              integer NOT NULL DEFAULT 0
);
CREATE TABLE checklist_instances (
  id                      serial PRIMARY KEY,
  checklist_template_id   integer REFERENCES checklist_templates(id) ON DELETE SET NULL,
  name                    text NOT NULL,
  work_order_id           integer REFERENCES work_orders(id) ON DELETE CASCADE,
  calendar_event_id       integer REFERENCES calendar_events(id) ON DELETE CASCADE,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checklist_instance_one_owner CHECK (
    (work_order_id IS NOT NULL)::int + (calendar_event_id IS NOT NULL)::int <= 1
  )
);
CREATE TABLE checklist_instance_steps (
  id                      serial PRIMARY KEY,
  checklist_instance_id   integer NOT NULL REFERENCES checklist_instances(id) ON DELETE CASCADE,
  step_text               text NOT NULL,
  sort_order              integer NOT NULL DEFAULT 0,
  done                    boolean NOT NULL DEFAULT false,
  done_at                 timestamptz
);
CREATE INDEX idx_checklist_instances_wo ON checklist_instances(work_order_id);
CREATE INDEX idx_checklist_instances_event ON checklist_instances(calendar_event_id);
