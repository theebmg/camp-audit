-- Calendar event types (Build Brief v4 Part 1, addition before step 3
-- ships) — admin-editable, same rule as every other list in this system
-- (Part A, Decision 7: no hardcoded status/role/cause/category lists).
-- gcal_color_id lives directly on the type (not a separate lookup keyed by
-- a generic 'calendar_event' kind) since every calendar_events row now has
-- a real type — when step 3 builds the gcal_event_colors table for
-- job_line/wo_revisit/finding_revisit/pm_due, 'calendar_event' color
-- resolution should read this column instead of getting its own row there.
CREATE TABLE calendar_event_types (
  id            serial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  sort_order    integer NOT NULL DEFAULT 100,
  gcal_color_id text,   -- Google's fixed event colorId, '1'-'11'; null = calendar's own default color
  active        boolean NOT NULL DEFAULT true
);
INSERT INTO calendar_event_types (name, sort_order) VALUES
  ('Constituent Visitation', 10),
  ('Volunteer Workday', 20),
  ('Group Rental', 30),
  ('Board Meeting', 40),
  ('Camp Session', 50),
  ('Other', 60);

-- Nullable during backfill, then locked down — every existing row becomes
-- 'Other' (Decision 7's "Unknown in the seed deliberately, so nobody picks
-- a plausible wrong option or leaves it blank" applies the same way here).
ALTER TABLE calendar_events ADD COLUMN type_id integer REFERENCES calendar_event_types(id);
UPDATE calendar_events SET type_id = (SELECT id FROM calendar_event_types WHERE name = 'Other');
ALTER TABLE calendar_events ALTER COLUMN type_id SET NOT NULL;

-- Start/end time (optional pair, same all-day-unless-both-set rule as
-- job_lines' new scheduled_start_time) and end_date for multi-day span (a
-- Group Rental running Friday to Sunday). NULL end_date, or end_date equal
-- to event_date, both mean single-day — event_date remains the span's
-- start date, kept under its original name to avoid touching the many
-- existing event_date references across recurrence/PM-generation code.
ALTER TABLE calendar_events
  ADD COLUMN start_time  time,
  ADD COLUMN end_time    time,
  ADD COLUMN end_date    date;
