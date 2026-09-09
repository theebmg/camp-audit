-- Build Brief v2 Phase 6 (§6.3): "Cap embedded images per work order at 4
-- (configurable in admin)" — the Work Performed report's embed limit. Same
-- single-row settings table pattern as wo_progress_weighting (0042).
ALTER TABLE display_settings ADD COLUMN report_image_cap integer NOT NULL DEFAULT 4;
