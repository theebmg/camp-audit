-- Conditional checklist steps: a step can declare "only show me once step X
-- is checked/unchecked". Applies to both templates (the authored blueprint)
-- and instances (the live, in-use copy) — instances need their own
-- self-referential link since they're an independent copy of the steps.

ALTER TABLE checklist_template_steps ADD COLUMN depends_on_step_id integer
  REFERENCES checklist_template_steps(id) ON DELETE SET NULL;
ALTER TABLE checklist_template_steps ADD COLUMN show_when_checked boolean NOT NULL DEFAULT true;

ALTER TABLE checklist_instance_steps ADD COLUMN depends_on_instance_step_id integer
  REFERENCES checklist_instance_steps(id) ON DELETE SET NULL;
ALTER TABLE checklist_instance_steps ADD COLUMN show_when_checked boolean NOT NULL DEFAULT true;
