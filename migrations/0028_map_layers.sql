-- User-defined map layers. A layer is DATA (name/color/icon/z-order/
-- visibility/condition-coloring), not a hardcoded category — Ben creates
-- "Electrical", "Trash", "Water valves" etc. from the UI, never a code
-- change. Points, lines and zones dropped anywhere on the map all live in
-- map_features (kind now just describes GEOMETRY — 'point'|'line'|'zone' —
-- the semantic meaning, e.g. "this is a sewer line", lives on the layer it
-- belongs to instead of being baked into kind).
CREATE TABLE IF NOT EXISTS map_layers (
    id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name               text NOT NULL,
    geometry           text NOT NULL DEFAULT 'point',  -- 'point' | 'line' | 'zone' | 'mixed' — add-tool hint
    color              text NOT NULL DEFAULT '#2b6cb0',
    icon               text,                           -- emoji for point markers on this layer
    z_index            integer NOT NULL DEFAULT 0,
    default_visible    boolean NOT NULL DEFAULT true,
    color_by_condition boolean NOT NULL DEFAULT false,  -- asset-linked points/lines color by condition_findings severity instead of the layer color
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE map_features ADD COLUMN IF NOT EXISTS layer_id integer REFERENCES map_layers(id) ON DELETE SET NULL;

-- Building pins are assets, not map_features rows, but still need a layer
-- for panel visibility/z-order/recoloring — a real FK (not name-matching
-- "Buildings" at render time) so the layer stays reliable through a rename.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS map_layer_id integer REFERENCES map_layers(id) ON DELETE SET NULL;

-- Starter layers — editable/renameable/deletable rows, not fixed
-- categories. Building pins (assets.map_x/map_y) render under "Buildings"
-- for panel/visibility/z-order purposes even though they're not
-- map_features rows themselves.
INSERT INTO map_layers (name, geometry, color, icon, z_index, default_visible, color_by_condition)
SELECT * FROM (VALUES
    ('Zones',        'zone',  '#5c8a4e', NULL,   10, true, false),
    ('Water lines',  'line',  '#2b6cb0', NULL,   20, true, false),
    ('Sewer lines',  'line',  '#8a6d3b', NULL,   30, true, false),
    ('Buildings',    'point', '#4b6b5c', '🏠',   40, true, true),
    ('Water valves', 'point', '#2b6cb0', '🚰',   50, true, true),
    ('Electrical',   'point', '#d0902a', '⚡',   60, true, true),
    ('Trash',        'point', '#8a8272', '🗑️',  70, true, false),
    ('Sewer',        'point', '#8a6d3b', '🕳️',  80, true, true)
) AS seed(name, geometry, color, icon, z_index, default_visible, color_by_condition)
WHERE NOT EXISTS (SELECT 1 FROM map_layers);

-- Backfill existing lines/zones onto their matching seed layer before
-- normalizing kind down to pure geometry.
UPDATE map_features f SET layer_id = l.id
FROM map_layers l
WHERE f.layer_id IS NULL AND f.kind = 'water_line' AND l.name = 'Water lines';
UPDATE map_features f SET layer_id = l.id
FROM map_layers l
WHERE f.layer_id IS NULL AND f.kind = 'sewer_line' AND l.name = 'Sewer lines';
UPDATE map_features f SET layer_id = l.id
FROM map_layers l
WHERE f.layer_id IS NULL AND f.kind = 'zone' AND l.name = 'Zones';

UPDATE map_features SET kind = 'line' WHERE kind IN ('water_line', 'sewer_line');

UPDATE assets SET map_layer_id = (SELECT id FROM map_layers WHERE name = 'Buildings')
WHERE map_x IS NOT NULL AND map_layer_id IS NULL;
