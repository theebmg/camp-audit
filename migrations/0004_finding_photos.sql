-- New-photo storage for Condition Findings, distinct from legacy_photos
-- (which only holds migrated NocoDB attachment metadata). New uploads go to
-- DigitalOcean Spaces; only the URL is stored here — see src/storage.js.
ALTER TABLE condition_findings ADD COLUMN photo_urls text[] NOT NULL DEFAULT '{}';
