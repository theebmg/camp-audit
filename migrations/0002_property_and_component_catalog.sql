-- Config tables that replace "read NocoDB's meta API + @asset-property tag" now
-- that we own the schema in Postgres. Same philosophy: data-driven, editable
-- without a deploy (eventually via NocoDB-as-viewer or a small admin screen —
-- see step 6 of the migration brief), not hard-coded in the app.
--
-- Seeded to match CURRENT live behavior exactly (api.js's isAssetPropertyColumn
-- + ASSET_PROPERTY_DEPENDENCIES + AUDIT_COMPONENT_TYPES), so the new Postgres
-- audit path is a faithful parallel of the NocoDB one, not a redesign yet.
-- NOTE: live NocoDB's flat "Roof Material" / "Siding Material" / "Foundation
-- Type" asset columns are NOT tagged @asset-property — they were superseded by
-- Asset Components rows (see camp-cmms-components-design.md), so they're
-- intentionally excluded here too.

CREATE TABLE asset_property_fields (
  id           serial PRIMARY KEY,
  field_key    text NOT NULL UNIQUE,   -- matches an assets column name
  label        text NOT NULL,
  input_type   text NOT NULL CHECK (input_type IN ('select', 'multiselect', 'text', 'number')),
  options      text[] NOT NULL DEFAULT '{}',
  sort_order   integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true
);

INSERT INTO asset_property_fields (field_key, label, input_type, options, sort_order) VALUES
  ('has_key',                'Has Key',                 'select', ARRAY['Yes','No','Unknown'], 1),
  ('key_fits_lock',          'Key Fits Lock',            'select', ARRAY['Yes','No','Not Tested','N/A'], 2),
  ('free_standing_building', 'Free Standing Building',   'select', ARRAY['Yes','No'], 3);

-- Conditional reveal map for the fields above (field_key -> shows_when values ->
-- reveals these other field_keys). Mirrors ASSET_PROPERTY_DEPENDENCIES in api.js.
CREATE TABLE asset_property_dependencies (
  id           serial PRIMARY KEY,
  field_key    text NOT NULL REFERENCES asset_property_fields(field_key),
  show_when    text[] NOT NULL,
  reveals      text[] NOT NULL
);

INSERT INTO asset_property_dependencies (field_key, show_when, reveals) VALUES
  ('has_key', ARRAY['Yes'], ARRAY['key_fits_lock']);

-- Component types the audit prompts for, and the option lists they accept.
-- Mirrors getComponentSchema() in api.js (previously read from NocoDB meta).
CREATE TABLE component_type_catalog (
  component_type      text PRIMARY KEY,
  event_type_options   text[] NOT NULL,
  condition_options     text[] NOT NULL,
  prompted_in_audit     boolean NOT NULL DEFAULT false,
  sort_order            integer NOT NULL DEFAULT 0
);

INSERT INTO component_type_catalog (component_type, event_type_options, condition_options, prompted_in_audit, sort_order) VALUES
  ('Roof',       ARRAY['Installed','Replaced','Inspected','Repaired','Retired'], ARRAY['Excellent','Good','Fair','Poor','Failed','Unknown'], true, 1),
  ('Siding',     ARRAY['Installed','Replaced','Inspected','Repaired','Retired'], ARRAY['Excellent','Good','Fair','Poor','Failed','Unknown'], true, 2),
  ('Foundation', ARRAY['Installed','Replaced','Inspected','Repaired','Retired'], ARRAY['Excellent','Good','Fair','Poor','Failed','Unknown'], true, 3),
  ('Windows',    ARRAY['Installed','Replaced','Inspected','Repaired','Retired'], ARRAY['Excellent','Good','Fair','Poor','Failed','Unknown'], false, 4),
  ('Doors',      ARRAY['Installed','Replaced','Inspected','Repaired','Retired'], ARRAY['Excellent','Good','Fair','Poor','Failed','Unknown'], false, 5),
  ('HVAC',       ARRAY['Installed','Replaced','Inspected','Repaired','Retired'], ARRAY['Excellent','Good','Fair','Poor','Failed','Unknown'], false, 6),
  ('Flooring',   ARRAY['Installed','Replaced','Inspected','Repaired','Retired'], ARRAY['Excellent','Good','Fair','Poor','Failed','Unknown'], false, 7),
  ('Plumbing',   ARRAY['Installed','Replaced','Inspected','Repaired','Retired'], ARRAY['Excellent','Good','Fair','Poor','Failed','Unknown'], false, 8),
  ('Electrical', ARRAY['Installed','Replaced','Inspected','Repaired','Retired'], ARRAY['Excellent','Good','Fair','Poor','Failed','Unknown'], false, 9),
  ('Other',      ARRAY['Installed','Replaced','Inspected','Repaired','Retired'], ARRAY['Excellent','Good','Fair','Poor','Failed','Unknown'], false, 10);

-- "Free Standing Building" = Yes -> prompt Roof/Siding/Foundation component
-- events during the audit. Mirrors AUDIT_COMPONENT_DEPENDENCY in api.js. One
-- row because there's currently exactly one such gate; add rows if that grows.
CREATE TABLE component_prompt_dependencies (
  id          serial PRIMARY KEY,
  field_key   text NOT NULL REFERENCES asset_property_fields(field_key),
  show_when   text[] NOT NULL
);

INSERT INTO component_prompt_dependencies (field_key, show_when) VALUES
  ('free_standing_building', ARRAY['Yes']);
