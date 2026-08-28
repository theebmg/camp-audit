-- Templates now predefine free-text TASK defaults (matches the Job Lines
-- rework — see chat log) as the primary thing; job_line_defaults (asset
-- field updates) becomes the secondary/advanced, still-supported case.
ALTER TABLE work_order_templates ADD COLUMN task_defaults jsonb NOT NULL DEFAULT '[]';
