-- Saved Reports-tab views ("favorites") so a filter combination a user
-- builds once doesn't need rebuilding by hand every visit. Scoped per
-- username (not shared) -- each admin/standard user gets their own list.
CREATE TABLE report_favorites (
  id serial PRIMARY KEY,
  username text NOT NULL,
  entity text NOT NULL,
  label text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}',
  visible_columns jsonb,
  sort_key text,
  sort_dir text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_report_favorites_username_entity ON report_favorites (username, entity);

GRANT ALL PRIVILEGES ON TABLE report_favorites TO camp_app;
GRANT USAGE, SELECT ON SEQUENCE report_favorites_id_seq TO camp_app;
