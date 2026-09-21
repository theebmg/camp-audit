-- Work Order templates, §8 of the grid build brief.
--
-- The brief asks for new `wo_templates` / `wo_template_lines` tables, but
-- work_order_templates already exists (migration 0008, reshaped by 0039) and
-- is already the app's template concept: it backs the New WO "Start from
-- Template" picker, the admin Work Order Templates screen, and
-- calendar_events.work_order_template_id. A second, parallel template table
-- would mean two template lists in admin and two things called a template.
-- So: extend this one, and give it the real lines table the brief describes.
--
-- Deliberately NO date column on a template line — a template says what work
-- is done, never when (§8).

ALTER TABLE work_order_templates ADD COLUMN description text;

CREATE TABLE work_order_template_lines (
  id                   serial PRIMARY KEY,
  template_id          integer NOT NULL REFERENCES work_order_templates(id) ON DELETE CASCADE,
  sort_index           integer NOT NULL DEFAULT 0,
  title                text NOT NULL,
  responsibility_class text,
  funding_source       text,
  funding_ref_id       integer,
  estimated_hours      numeric,
  estimated_cost       numeric,
  CONSTRAINT work_order_template_lines_responsibility_class_check
    CHECK (responsibility_class IS NULL OR responsibility_class = ANY (ARRAY['self','volunteer','vendor','cabin_holder'])),
  CONSTRAINT work_order_template_lines_funding_source_check
    CHECK (funding_source IS NULL OR funding_source = ANY (ARRAY['operating_budget','capital_campaign','cabin_holder','other','fund']))
);
CREATE INDEX idx_wo_template_lines_template ON work_order_template_lines(template_id, sort_index);

-- Backfill from the old job_line_defaults JSONB so no existing template
-- loses its lines. Entries are either a bare title string or
-- {title, responsibilityClass} — both shapes are handled below.
INSERT INTO work_order_template_lines (template_id, sort_index, title, responsibility_class)
SELECT t.id,
       (d.ord - 1)::int,
       COALESCE(NULLIF(d.value ->> 'title', ''), d.value #>> '{}'),
       NULLIF(d.value ->> 'responsibilityClass', '')
FROM work_order_templates t
CROSS JOIN LATERAL jsonb_array_elements(t.job_line_defaults) WITH ORDINALITY AS d(value, ord)
WHERE COALESCE(NULLIF(d.value ->> 'title', ''), d.value #>> '{}') IS NOT NULL
  AND COALESCE(NULLIF(d.value ->> 'title', ''), d.value #>> '{}') <> '';

-- job_line_defaults is left in place (the guardrail is "additive only"), but
-- it is now DORMANT: work_order_template_lines is the single source of truth
-- from here on and nothing reads the JSONB column any more.
