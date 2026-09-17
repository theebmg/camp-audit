-- Sidebar nav layout: which section each nav item sits in and its order,
-- reorderable from the sidebar's "Reorder menu" edit mode. Same single-row
-- display_settings pattern as wo_progress_weighting (0042) and
-- report_image_cap (0050). Shape: [{ "header": "Daily" | null, "items":
-- ["dashboard", ...] }, ...]. NULL means "use the built-in default" — that's
-- what "Reset to default" writes, so future default changes reach anyone who
-- never customized. The client reconciles stale layouts (drops views that no
-- longer exist, slots in nav items added after the layout was saved).
ALTER TABLE display_settings ADD COLUMN nav_layout jsonb;
