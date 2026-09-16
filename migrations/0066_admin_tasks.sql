-- Administrative tasks — Ben's work that isn't tied to an asset or a work
-- order (vendor calls, account cleanup, insurance paperwork). Documentation,
-- not accounting: no asset, no funding source, no job lines, no cost.
--
-- Checked first that nothing already covers this. There has never been a
-- standalone `tasks` table: migration 0009 created `work_order_tasks` (a
-- WO-bound checklist, work_order_id NOT NULL), 0030 renamed it to
-- `job_lines`, and 0038 renamed the last `*task*` FK columns. Its only UI
-- is the job-line UI on a work order — it requires a WO and carries hours/
-- cost/funding/responsibility, which is exactly what this must not have.
--
-- Status and category are both admin-editable tables, per Decision 7 (no
-- hardcoded status/category lists). counts_as_work_performed mirrors
-- job_line_statuses: it decides whether a task shows in the Work Performed
-- report's Administrative Work section (and whether its savings count).

CREATE TABLE admin_task_categories (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  sort_order  integer NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true
);
INSERT INTO admin_task_categories (name, sort_order) VALUES
  ('Vendor/Account', 10),
  ('Insurance', 20),
  ('Compliance', 30),
  ('Planning', 40),
  ('Board/Governance', 50),
  ('Other', 60);

CREATE TABLE admin_task_statuses (
  id                        serial PRIMARY KEY,
  name                      text NOT NULL UNIQUE,
  sort_order                integer NOT NULL DEFAULT 100,
  counts_as_work_performed  boolean NOT NULL DEFAULT false,
  active                    boolean NOT NULL DEFAULT true
);
-- In Progress / Waiting count: a vendor call made while still waiting on a
-- callback is real work done in that range. To Do and Cancelled don't.
INSERT INTO admin_task_statuses (name, sort_order, counts_as_work_performed) VALUES
  ('To Do', 10, false),
  ('In Progress', 20, true),
  ('Waiting on Others', 30, true),
  ('Done', 40, true),
  ('Cancelled', 50, false);

CREATE TABLE admin_tasks (
  id                         serial PRIMARY KEY,
  title                      text NOT NULL,
  description                text,
  task_date                  date NOT NULL DEFAULT current_date,
  hours                      numeric(7,2) CHECK (hours IS NULL OR hours >= 0),
  status_id                  integer NOT NULL REFERENCES admin_task_statuses(id),
  category_id                integer REFERENCES admin_task_categories(id),
  -- Blank most of the time; filled in when the task eliminated or reduced a
  -- recurring cost (a cancelled subscription, a renegotiated rate).
  recurring_monthly_savings  numeric(12,2) CHECK (recurring_monthly_savings IS NULL OR recurring_monthly_savings >= 0),
  created_by                 text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_admin_tasks_updated_at BEFORE UPDATE ON admin_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_admin_tasks_date ON admin_tasks(task_date);
