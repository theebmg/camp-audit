-- Job Line Grid (Build Brief: grid / CSV import / templates), §11.
--
-- All additive — the WO tables hold real data now, so nothing here drops,
-- resets, or rewrites an existing row's meaning.
--
-- NOTE on sort_index: the brief calls for `sort_index INT` on job lines, but
-- job_lines.sort_order (migration 0001) already IS that integer — it's what
-- listJobLines/getWorkOrderDetail/the Scope PDF/reports all order by today.
-- Adding a second ordering column would leave two columns both claiming to
-- say "which line comes first," which is exactly the ambiguity the brief is
-- trying to remove. The grid's drag/Alt-arrow reorder persists into
-- sort_order instead; treat "sort_index" in the brief and "sort_order" here
-- as the same field.

-- Per-line pin/follow metadata. Rendering ONLY — the resolved values are
-- always fully stamped into the real columns (§3's save semantics), so
-- nothing about a report or an old WO depends on reading this back.
-- Entries are column names: responsibility_class, funding_source,
-- status_id, scheduled_date.
ALTER TABLE job_lines ADD COLUMN pinned_fields jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Per-WO cascade override. NULL means "use the global default in
-- display_settings.cascade_defaults" — an explicit object overrides it for
-- this work order only.
ALTER TABLE work_orders ADD COLUMN cascade_config jsonb;

-- Global cascade defaults. display_settings is the app's existing
-- single-row settings table (wo_progress_weighting, report_image_cap,
-- nav_layout), so the grid's defaults live alongside them rather than in a
-- new table of their own.
ALTER TABLE display_settings ADD COLUMN cascade_defaults jsonb NOT NULL
  DEFAULT '{"responsibility_class": true, "funding_source": true, "status_id": true, "scheduled_date": true}'::jsonb;

-- §10's review prompt needs to know WHICH work-order status means "in
-- review." Statuses are admin-editable (name, order and colour can all
-- change), so this is a flag rather than a name match — renaming "Review" to
-- "Awaiting Sign-off" must not silently break the prompt.
ALTER TABLE work_order_statuses ADD COLUMN is_review boolean NOT NULL DEFAULT false;

-- Seed the Review status itself, between In Progress (40) and Done (50).
-- Non-terminal: a WO in Review is still open, and closing stays the manual
-- action it has always been (see workOrderCloseGate's header comment).
-- ON CONFLICT so a hand-added "Review" row on any environment is adopted
-- rather than duplicated.
INSERT INTO work_order_statuses (name, sort_order, color, is_terminal, is_review)
VALUES ('Review', 45, '#0ea5e9', false, true)
ON CONFLICT (name) DO UPDATE SET is_review = true;
