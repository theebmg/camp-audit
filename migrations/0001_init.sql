-- Core schema for the `camp` database. Mirrors the current NocoDB tables
-- (see toClaudeCode/camp-cmms-postgres-migration-brief.md) plus the new
-- building-type / applicability / sub-area / notes concepts the migration adds.
--
-- Every table that maps 1:1 from an existing NocoDB row carries `nc_id`
-- (that row's NocoDB Id) so the one-off data-migration script can upsert
-- idempotently and so we can cross-check counts against the known-good
-- NocoDB numbers (337 assets, 51 locations, ...) after loading.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── locations ────────────────────────────────────────────────────────────
CREATE TABLE locations (
  id                  serial PRIMARY KEY,
  nc_id               integer UNIQUE,
  name                text NOT NULL,
  parent_location_id  integer REFERENCES locations(id),
  location_type       text,
  sub_location_type   text[] NOT NULL DEFAULT '{}',
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_locations_updated_at BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_locations_parent ON locations(parent_location_id);

-- ── building_types (NEW) ────────────────────────────────────────────────
CREATE TABLE building_types (
  id    serial PRIMARY KEY,
  name  text NOT NULL UNIQUE
);

-- ── projects ─────────────────────────────────────────────────────────────
CREATE TABLE projects (
  id              serial PRIMARY KEY,
  nc_id           integer UNIQUE,
  name            text,
  status          text,
  location_id     integer REFERENCES locations(id),
  budget          numeric,
  estimated_cost  numeric,
  actual_cost     numeric,
  target_date     date,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── assets ───────────────────────────────────────────────────────────────
CREATE TABLE assets (
  id                          serial PRIMARY KEY,
  nc_id                       integer UNIQUE,
  name                        text NOT NULL,
  asset_type                  text,
  location_id                 integer REFERENCES locations(id),
  sub_location_id             integer REFERENCES locations(id),
  parent_asset_id             integer REFERENCES assets(id),
  building_type_id            integer REFERENCES building_types(id),
  condition                   text,
  install_build_year          integer,
  notes                       text,
  description                 text,
  lodge_holder                text,
  -- stable @asset-property-style flat facts
  has_key                     text,
  key_fits_lock               text,
  free_standing_building      text,
  roof_material                text,
  siding_material              text,
  foundation_type               text[] NOT NULL DEFAULT '{}',
  roof_condition                text,
  siding_condition               text,
  roof_est_life_expectancy        text,
  siding_est_life_expectancy      text,
  indoor_plumbing              text,
  half_or_whole_cabin           text,
  window_count                  integer,
  window_style                  text,
  interior_finish                text,
  legacy_photos               jsonb NOT NULL DEFAULT '[]',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_assets_updated_at BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_assets_location ON assets(location_id);
CREATE INDEX idx_assets_parent ON assets(parent_asset_id);
CREATE INDEX idx_assets_building_type ON assets(building_type_id);

-- ── work_orders ──────────────────────────────────────────────────────────
CREATE TABLE work_orders (
  id               serial PRIMARY KEY,
  nc_id            integer UNIQUE,
  title            text,
  asset_id         integer REFERENCES assets(id),
  location_id      integer REFERENCES locations(id),
  project_id       integer REFERENCES projects(id),
  status           text,
  priority         text,
  date_reported    date,
  date_completed   date,
  estimated_hours  numeric,
  actual_hours     numeric,
  estimated_cost   numeric,
  actual_cost      numeric,
  description      text,
  legacy_photos    jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_work_orders_updated_at BEFORE UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_work_orders_asset ON work_orders(asset_id);
CREATE INDEX idx_work_orders_location ON work_orders(location_id);
CREATE INDEX idx_work_orders_project ON work_orders(project_id);

-- ── condition_findings ───────────────────────────────────────────────────
CREATE TABLE condition_findings (
  id                   serial PRIMARY KEY,
  nc_id                integer UNIQUE,
  title                text,
  asset_id             integer REFERENCES assets(id),
  location_id          integer REFERENCES locations(id),
  system               text,
  severity             text,
  description          text,
  recommended_repair   text,
  estimated_hours      numeric,
  estimated_cost       numeric,
  status               text,
  date_identified      date,
  work_order_id        integer REFERENCES work_orders(id),
  project_id           integer REFERENCES projects(id),
  legacy_photos        jsonb NOT NULL DEFAULT '[]',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_condition_findings_updated_at BEFORE UPDATE ON condition_findings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_condition_findings_asset ON condition_findings(asset_id);
CREATE INDEX idx_condition_findings_wo ON condition_findings(work_order_id);

-- ── asset_updates (WO → asset write-back instructions) ──────────────────
CREATE TABLE asset_updates (
  id             serial PRIMARY KEY,
  nc_id          integer UNIQUE,
  work_order_id  integer NOT NULL REFERENCES work_orders(id),
  target_field   text NOT NULL,
  new_value      text,
  applied        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_asset_updates_updated_at BEFORE UPDATE ON asset_updates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_asset_updates_wo ON asset_updates(work_order_id);

-- ── asset_components (event log; current-state = newest per (asset,
--    component_type, sub_area)) ────────────────────────────────────────
CREATE TABLE asset_components (
  id                        serial PRIMARY KEY,
  nc_id                     integer UNIQUE,
  asset_id                  integer NOT NULL REFERENCES assets(id),
  component_type            text NOT NULL,
  sub_area                  text,
  event_type                text,
  material                  text,
  condition                 text,
  observed_installed_date   date,
  est_life_years            integer,
  est_replacement_year      integer,
  est_replacement_cost      numeric,
  notes                     text,
  work_order_id             integer REFERENCES work_orders(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_asset_components_updated_at BEFORE UPDATE ON asset_components
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_asset_components_asset ON asset_components(asset_id, component_type, sub_area);
CREATE INDEX idx_asset_components_wo ON asset_components(work_order_id);

-- ── component_sub_areas (NEW — config: which sub-areas exist per
--    component_type, e.g. Floor -> corners) ──────────────────────────────
CREATE TABLE component_sub_areas (
  id              serial PRIMARY KEY,
  component_type  text NOT NULL,
  sub_area        text NOT NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  UNIQUE (component_type, sub_area)
);

-- ── question_applicability (NEW — data-driven: which questions/components
--    apply to which building type; editable from NocoDB, no deploy) ──────
CREATE TABLE question_applicability (
  id                 serial PRIMARY KEY,
  building_type_id   integer NOT NULL REFERENCES building_types(id),
  question_key       text NOT NULL,
  applies            boolean NOT NULL DEFAULT true,
  UNIQUE (building_type_id, question_key)
);

-- ── asset_notes (NEW — ad-hoc field notes/follow-ups; pressure-relief
--    valve, distinct from Condition Findings) ────────────────────────────
CREATE TABLE asset_notes (
  id          serial PRIMARY KEY,
  asset_id    integer NOT NULL REFERENCES assets(id),
  note        text NOT NULL,
  photo_url   text,
  resolved    boolean NOT NULL DEFAULT false,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_asset_notes_updated_at BEFORE UPDATE ON asset_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_asset_notes_asset ON asset_notes(asset_id);

-- ── volunteers ───────────────────────────────────────────────────────────
CREATE TABLE volunteers (
  id          serial PRIMARY KEY,
  nc_id       integer UNIQUE,
  name        text NOT NULL,
  phone       text,
  email       text,
  skill       text[] NOT NULL DEFAULT '{}',
  active      boolean NOT NULL DEFAULT true,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_volunteers_updated_at BEFORE UPDATE ON volunteers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── vendors ──────────────────────────────────────────────────────────────
CREATE TABLE vendors (
  id          serial PRIMARY KEY,
  nc_id       integer UNIQUE,
  name        text NOT NULL,
  phone       text,
  email       text,
  specialty   text[] NOT NULL DEFAULT '{}',
  active      boolean NOT NULL DEFAULT true,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_vendors_updated_at BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── work_order_volunteers / work_order_vendors (many-to-many junctions) ──
CREATE TABLE work_order_volunteers (
  work_order_id  integer NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  volunteer_id   integer NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
  PRIMARY KEY (work_order_id, volunteer_id)
);

CREATE TABLE work_order_vendors (
  work_order_id  integer NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  vendor_id      integer NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  PRIMARY KEY (work_order_id, vendor_id)
);

-- ── seed: building_types (confirm real list with user; data-driven, so
--    edit via SQL/NocoDB later needs no deploy) ──────────────────────────
INSERT INTO building_types (name) VALUES
  ('Cabin'), ('Lodge/Hotel'), ('Restroom/Shower'), ('Pavilion/Shelter'),
  ('Utility/Equipment'), ('Tabernacle'), ('Other');

-- ── seed: component_sub_areas (confirm real vocab with user; editable
--    without a deploy) ────────────────────────────────────────────────────
INSERT INTO component_sub_areas (component_type, sub_area, sort_order) VALUES
  ('Floor',   'NE Corner', 1), ('Floor',   'NW Corner', 2),
  ('Floor',   'SE Corner', 3), ('Floor',   'SW Corner', 4),
  ('Floor',   'Center',    5),
  ('Ceiling', 'NE Corner', 1), ('Ceiling', 'NW Corner', 2),
  ('Ceiling', 'SE Corner', 3), ('Ceiling', 'SW Corner', 4),
  ('Roof',    'N Slope',   1), ('Roof',    'S Slope',   2),
  ('Roof',    'E Slope',   3), ('Roof',    'W Slope',   4);
