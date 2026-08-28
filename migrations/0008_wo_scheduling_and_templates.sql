-- Supports: rescheduling/reassigning work orders, a calendar view, and
-- reusable "canned" work order templates for repeatable tasks.

ALTER TABLE work_orders ADD COLUMN scheduled_date date;

-- Job-line defaults stored as JSONB (array of {targetField, newValue}) rather
-- than a separate relational table — it's just a blueprint copied in at
-- creation time, never queried on its own, so the extra join isn't worth it.
CREATE TABLE work_order_templates (
  id                     serial PRIMARY KEY,
  name                   text NOT NULL,
  default_title          text,
  default_priority       text,
  default_description    text,
  job_line_defaults      jsonb NOT NULL DEFAULT '[]',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_work_order_templates_updated_at BEFORE UPDATE ON work_order_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
