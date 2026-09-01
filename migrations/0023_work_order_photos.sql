-- "Solution" photos — proof a job got done — distinct from every other photo
-- locus in the schema, which is all audit/evidence: condition_findings
-- (problem found), asset_photos/asset_components (asset reference/condition
-- history), maintenance_request_photos (what the public reported). Storage
-- is uncapped here; the report/export layer decides how many of these to
-- show (see reports/pdf code), not the schema.
CREATE TABLE work_order_photos (
  id            serial PRIMARY KEY,
  work_order_id integer NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  photo_url     text NOT NULL,
  caption       text,
  sort_order    integer NOT NULL DEFAULT 0,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_work_order_photos_wo ON work_order_photos(work_order_id);

-- Per job-line completion photos, same shape one level down.
CREATE TABLE work_order_task_photos (
  id          serial PRIMARY KEY,
  task_id     integer NOT NULL REFERENCES work_order_tasks(id) ON DELETE CASCADE,
  photo_url   text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_work_order_task_photos_task ON work_order_task_photos(task_id);
