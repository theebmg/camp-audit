-- Makes NEW asset-property fields addable from an admin UI with zero schema
-- changes (no migration file, no ALTER TABLE, no deploy) — the actual point
-- of "fully customizable from an admin panel."
--
-- The 3 fields that exist today (has_key, key_fits_lock, free_standing_building)
-- stay exactly as they are: real columns on `assets`, unchanged. They're marked
-- with column_name so the app knows to read/write them directly.
--
-- Any NEW field created through the admin panel gets column_name = NULL,
-- meaning its values live in asset_property_values instead (one row per
-- asset+field). Functionally identical to the caller; just a storage detail
-- inside db.js, same portability-boundary discipline as everywhere else.

ALTER TABLE asset_property_fields ADD COLUMN column_name text;

UPDATE asset_property_fields SET column_name = field_key
WHERE field_key IN ('has_key', 'key_fits_lock', 'free_standing_building');

CREATE TABLE asset_property_values (
  id          serial PRIMARY KEY,
  asset_id    integer NOT NULL REFERENCES assets(id),
  field_key   text NOT NULL REFERENCES asset_property_fields(field_key),
  value       text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, field_key)
);
CREATE TRIGGER trg_asset_property_values_updated_at BEFORE UPDATE ON asset_property_values
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_asset_property_values_asset ON asset_property_values(asset_id);
