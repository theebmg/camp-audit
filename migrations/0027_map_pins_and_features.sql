-- Interactive asset map. Coordinates are IMAGE PIXELS on the campmap.webp
-- illustration (2500x3700, origin top-left) — NOT lat/lng, no PostGIS.
--
-- map_x/map_y live on `assets` only, not `locations`: buildings are already
-- represented as assets (asset_type = 'Camp Building', 'Full Cabin', ...) and
-- that's the row condition_findings/work_orders/asset_components key off of,
-- so it's the row the map pin needs to color. `locations` is just the
-- containment hierarchy assets attach to and has no map presence of its own;
-- areas/roads/water lines are drawn via map_features instead.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS map_x double precision;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS map_y double precision;

-- Water lines, sewer lines, zones — polylines/polygons in image-pixel coords.
CREATE TABLE IF NOT EXISTS map_features (
    id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind        text NOT NULL,              -- 'water_line' | 'sewer_line' | 'zone'
    label       text,
    points      jsonb NOT NULL,             -- [[x,y],[x,y],...] in image pixels
    asset_id    integer REFERENCES assets(id) ON DELETE SET NULL,
    style       jsonb,                      -- {color, weight}
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
