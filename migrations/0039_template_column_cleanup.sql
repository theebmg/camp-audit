-- work_order_templates.job_line_defaults already existed before this brief,
-- meaning something entirely different: a blueprint of asset_updates
-- (targetField/newValue pairs) to stamp onto a new WO. The brief repurposes
-- "job line" for the renamed work_order_tasks, so left alone the app would
-- have two contradictory things both called "job line defaults." Renaming
-- the old one out of the way first, then reusing the now-free name for its
-- proper meaning (task_defaults, upgraded from bare strings to partial
-- job-line objects — title/responsibilityClass/fundingSource/fundingRefId/
-- estimatedHours/estimatedCost — to match the richer WO-creation flow in
-- 1.7; scheduledDate is deliberately not part of a template default since it
-- should keep defaulting from the WO's own date, per 1.4).
ALTER TABLE work_order_templates RENAME COLUMN job_line_defaults TO asset_update_defaults;
ALTER TABLE work_order_templates RENAME COLUMN task_defaults TO job_line_defaults;

-- responsible_self was a template-level "does this default to self" flag,
-- the same shape as the work_orders column 0032 just replaced with
-- responsibility_class. Presets now describe a line's default responsibility
-- class instead of a single yes/no. Test data only, no backfill (same rule
-- as every other column in this series) — existing templates just get
-- re-set from the admin screen.
ALTER TABLE work_order_templates ADD COLUMN default_responsibility_class text
  CHECK (default_responsibility_class IN ('self','volunteer','vendor','cabin_holder'));
ALTER TABLE work_order_templates DROP COLUMN responsible_self;
