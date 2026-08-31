-- Maintenance Request Portal: a public "someone reports a problem" intake,
-- deliberately separate from Work Orders. A request is never auto-turned into
-- a Work Order — it sits in its own status lifecycle (submitted -> approved/
-- denied -> converted/closed) until a person reviews it and, if warranted,
-- clicks "Convert to Work Order" (see convertRequestToWorkOrder in db.js).
--
-- Field configurability mirrors the asset_property_fields pattern from
-- migration 0005: maintenance_request_fields lists what shows on the PUBLIC
-- form and whether it's required. A handful of "core" fields (requester name/
-- email/phone, location, priority, description) are real columns on
-- maintenance_requests (column_name set); anything an admin adds later is
-- EAV-backed in maintenance_request_field_values (column_name null) — same
-- "no schema change to add a field" property as asset properties.
--
-- Note: `asset` is deliberately NOT a public-form field — the 337-asset
-- inventory isn't exposed to anonymous submitters. Linking a request to a
-- specific asset is an internal reviewer action (asset_id below), done from
-- the admin-side request detail screen with the existing asset search.

CREATE TABLE maintenance_request_fields (
  id          serial PRIMARY KEY,
  field_key   text NOT NULL UNIQUE,
  label       text NOT NULL,
  input_type  text NOT NULL, -- text | textarea | select | multiselect | number | date | checkbox | location
  options     text[] NOT NULL DEFAULT '{}',
  required    boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 100,
  help_text   text,
  column_name text, -- set = real column on maintenance_requests; null = EAV
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE maintenance_requests (
  id              serial PRIMARY KEY,
  status          text NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','approved','denied','converted','closed')),
  requester_name  text,
  requester_email text NOT NULL,
  requester_phone text,
  location_id     integer REFERENCES locations(id),
  asset_id        integer REFERENCES assets(id), -- set only by an internal reviewer, never by the public form
  priority        text,
  description     text,
  public_token    text NOT NULL UNIQUE, -- opaque reference given to the requester; no lookup UI yet, but keeps the door open
  work_order_id   integer REFERENCES work_orders(id),
  reviewed_by     text,
  reviewed_at     timestamptz,
  review_note     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_maintenance_requests_updated_at BEFORE UPDATE ON maintenance_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_maintenance_requests_status ON maintenance_requests(status, created_at DESC);

CREATE TABLE maintenance_request_field_values (
  id          serial PRIMARY KEY,
  request_id  integer NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  field_key   text NOT NULL,
  value       text,
  UNIQUE (request_id, field_key)
);
CREATE INDEX idx_maintenance_request_field_values_request ON maintenance_request_field_values(request_id);

CREATE TABLE maintenance_request_photos (
  id          serial PRIMARY KEY,
  request_id  integer NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  photo_url   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_maintenance_request_photos_request ON maintenance_request_photos(request_id);

-- Outbound-only correspondence log: automatic status-change notices AND
-- free-form emails an admin sends from inside the request detail screen.
-- There's no inbound reply parsing (no mailbox polling) — replies land in
-- whatever inbox the requester's email client uses, same as any other email.
CREATE TABLE maintenance_request_messages (
  id          serial PRIMARY KEY,
  request_id  integer NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  subject     text NOT NULL,
  body        text NOT NULL,
  to_email    text NOT NULL,
  sent_by     text NOT NULL, -- 'system' for automatic status-change notices, else a username
  status      text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_maintenance_request_messages_request ON maintenance_request_messages(request_id, created_at);

INSERT INTO maintenance_request_fields (field_key, label, input_type, required, sort_order, column_name) VALUES
  ('requester_name',  'Your Name',          'text',     true,  10, 'requester_name'),
  ('requester_email', 'Your Email',         'text',     true,  20, 'requester_email'),
  ('requester_phone', 'Phone (optional)',   'text',     false, 30, 'requester_phone'),
  ('location',        'Location',           'location', true,  40, 'location_id'),
  ('priority',        'Priority',           'select',   false, 50, 'priority'),
  ('description',     'What''s the problem?', 'textarea', true, 60, 'description');

UPDATE maintenance_request_fields SET options = ARRAY['Low','Medium','High','Urgent'] WHERE field_key = 'priority';

GRANT ALL PRIVILEGES ON TABLE maintenance_request_fields TO camp_app;
GRANT USAGE, SELECT ON SEQUENCE maintenance_request_fields_id_seq TO camp_app;
GRANT ALL PRIVILEGES ON TABLE maintenance_requests TO camp_app;
GRANT USAGE, SELECT ON SEQUENCE maintenance_requests_id_seq TO camp_app;
GRANT ALL PRIVILEGES ON TABLE maintenance_request_field_values TO camp_app;
GRANT USAGE, SELECT ON SEQUENCE maintenance_request_field_values_id_seq TO camp_app;
GRANT ALL PRIVILEGES ON TABLE maintenance_request_photos TO camp_app;
GRANT USAGE, SELECT ON SEQUENCE maintenance_request_photos_id_seq TO camp_app;
GRANT ALL PRIVILEGES ON TABLE maintenance_request_messages TO camp_app;
GRANT USAGE, SELECT ON SEQUENCE maintenance_request_messages_id_seq TO camp_app;
