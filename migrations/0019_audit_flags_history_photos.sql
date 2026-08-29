-- Audit walkthrough gets three things it didn't have: a history log for
-- flat/EAV property-field answers (components already get this for free via
-- asset_components' append-only rows), a lightweight per-field "flag for
-- follow-up" that piggybacks on condition_findings instead of inventing a
-- second "something's wrong" concept, and photo attachment on component
-- events + general per-visit condition photos.

CREATE TABLE asset_property_history (
  id serial PRIMARY KEY,
  asset_id integer NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  field_key text NOT NULL,
  old_value text,
  new_value text,
  changed_by text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_property_history_asset_field ON asset_property_history (asset_id, field_key);

ALTER TABLE asset_components ADD COLUMN photo_url text;

CREATE TABLE asset_photos (
  id serial PRIMARY KEY,
  asset_id integer NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  photo_url text NOT NULL,
  caption text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_photos_asset ON asset_photos (asset_id);

-- source_field_key / source_component_type identify which audit answer
-- triggered a quick inline flag (null for the pre-existing "Report a
-- Finding" bolt-on, which isn't tied to one specific field); flagged_value
-- snapshots the answer at flag time so the report tab doesn't need to
-- reconstruct history to show what was flagged.
ALTER TABLE condition_findings ADD COLUMN source_field_key text;
ALTER TABLE condition_findings ADD COLUMN source_component_type text;
ALTER TABLE condition_findings ADD COLUMN flagged_value text;
ALTER TABLE condition_findings ADD COLUMN created_by text;

GRANT ALL PRIVILEGES ON TABLE asset_property_history TO camp_app;
GRANT USAGE, SELECT ON SEQUENCE asset_property_history_id_seq TO camp_app;
GRANT ALL PRIVILEGES ON TABLE asset_photos TO camp_app;
GRANT USAGE, SELECT ON SEQUENCE asset_photos_id_seq TO camp_app;
