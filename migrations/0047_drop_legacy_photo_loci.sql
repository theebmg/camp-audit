-- Build Brief v2 Phase 4 (§4.1): the nine photo loci this app grew one at a
-- time are now replaced by attachments/attachment_links (0046). All data
-- here is test data — no backfill, no migration of existing rows, per the
-- brief's own instruction. Three of these (assets.legacy_photos,
-- condition_findings.legacy_photos, work_orders.legacy_photos) were already
-- dead — leftover jsonb columns from the original NocoDB import with no
-- read or write path anywhere in the app.
ALTER TABLE assets             DROP COLUMN legacy_photos;
ALTER TABLE condition_findings DROP COLUMN legacy_photos;
ALTER TABLE condition_findings DROP COLUMN photo_urls;
ALTER TABLE work_orders        DROP COLUMN legacy_photos;
ALTER TABLE asset_components   DROP COLUMN photo_url;
ALTER TABLE asset_notes        DROP COLUMN photo_url;

DROP TABLE asset_photos;
DROP TABLE work_order_photos;
DROP TABLE work_order_task_photos;
DROP TABLE maintenance_request_photos;
