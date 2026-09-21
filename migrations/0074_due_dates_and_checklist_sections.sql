-- Adjacent changes the audit engine needs (Build Brief §2/§6, decisions §2/§3).
--
-- 1. work_orders.due_date — a plain field, settable on any WO by hand, not just
--    on scheduler-materialized ones. Overdue stays a COMPUTED flag (due_date past
--    AND work unresolved); it is never written as a status, so it clears itself
--    when the work completes and can't go stale.
--
--    work_orders.scheduled_date (0008) and revisit_date (0042) already exist and
--    mean different things: scheduled = when we intend to do it, revisit = when a
--    deferred item comes back up, due = when it is late. The dashboard strip reads
--    due_date and revisit_date together.
--
-- 2. Checklist sections. The brief's §2 asked for template_checklist_sections /
--    template_checklist_items / wo_checklist_items — a third checklist system in an
--    app that already has checklist_templates + checklist_template_steps +
--    checklist_instances + checklist_instance_steps, the latter with conditional
--    steps (0011) the brief's shape can't express. Decisions §2: extend instead.
--    A nullable section is the whole difference; existing steps keep NULL and
--    render as they do today, ungrouped.

ALTER TABLE work_orders ADD COLUMN due_date date;
CREATE INDEX idx_work_orders_due ON work_orders(due_date);

ALTER TABLE checklist_template_steps ADD COLUMN section text;
ALTER TABLE checklist_instance_steps ADD COLUMN section text;
