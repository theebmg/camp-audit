-- Wires the "expanded audit questions" from the migration brief into the
-- property-field catalog. The columns themselves already exist on `assets`
-- (added in 0001_init.sql) — this just makes them live, editable questions
-- via asset_property_fields, same as has_key/key_fits_lock/free_standing_building.
-- column_name is set (not NULL) because these are real columns, not EAV.
--
-- Option wording is a best-effort default per the brief's loose spec
-- ("half-or-whole cabin (verify)", "finished vs open studs") — adjust freely
-- via the admin panel; nothing here is hard-coded elsewhere.
INSERT INTO asset_property_fields (field_key, label, input_type, options, column_name, sort_order) VALUES
  ('indoor_plumbing',     'Indoor Plumbing',       'select', ARRAY['Yes','No','Unknown'],                          'indoor_plumbing',     10),
  ('half_or_whole_cabin', 'Half or Whole Cabin',   'select', ARRAY['Full','Half','Unknown'],                       'half_or_whole_cabin', 11),
  ('window_count',        'Window Count',          'number', ARRAY[]::text[],                                     'window_count',        12),
  ('window_style',        'Window Style',          'select', ARRAY['Single-Pane','Double-Pane','Storm','None','Unknown'], 'window_style',  13),
  ('interior_finish',     'Interior Finish',       'select', ARRAY['Finished','Open Studs','Unknown'],             'interior_finish',     14);
