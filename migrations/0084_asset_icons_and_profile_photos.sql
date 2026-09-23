-- Asset type icons and per-asset profile photos (Addendum §5a).
--
-- Icons hang off assets.asset_type, NOT building_types. Checked before writing this:
-- 338 of 340 assets have a NULL building_type_id, while asset_type is populated on all
-- but 2 — "Full Cabin" (118), "Room" (117), "RV Site" (25), "Camp Building" (17) and so
-- on. building_types exists but is effectively unused, so hanging icons there would
-- have given 338 buildings the same generic fallback. The addendum's own examples
-- ("cabin, camp building, tabernacle") are asset_type values, which is the giveaway.
--
-- asset_type is free text on assets, so the icons need a table of their own to be
-- admin-editable — same rule as every other list here. Seeded from the values actually
-- in use; anything unseeded, misspelt or added later simply falls back, and an admin
-- can give it an icon without a migration.
--
-- The profile photo is a DESIGNATION, not a second copy: the file stays in attachments,
-- linked as it already is, and this column only says which one is the face of the
-- asset. Deleting the attachment nulls the pointer and the icon comes back.

CREATE TABLE asset_type_icons (
  asset_type  text PRIMARY KEY,
  icon        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 100,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO asset_type_icons (asset_type, icon, sort_order) VALUES
  ('Full Cabin',           '🛖',  10),
  ('Half Cabin',           '🛖',  20),
  ('Room',                 '🚪',  30),
  ('RV Site',              '🚐',  40),
  ('Camp Building',        '🏢',  50),
  ('Tabernacle',           '⛪',  60),
  ('Restrooms',            '🚻',  70),
  ('Showers',              '🚿',  80),
  ('Bath House',           '🛁',  90),
  ('Laundry',              '🧺', 100),
  ('Maintenance Building', '🧰', 110),
  ('Garage',               '🚗', 120),
  ('Tractor',              '🚜', 130),
  ('Trailer',              '🚛', 140),
  ('Gate',                 '🚧', 150)
ON CONFLICT (asset_type) DO NOTHING;

ALTER TABLE assets
  ADD COLUMN profile_attachment_id integer REFERENCES attachments(id) ON DELETE SET NULL;
CREATE INDEX idx_assets_profile_attachment ON assets(profile_attachment_id);
