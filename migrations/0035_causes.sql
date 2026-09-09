-- Phase 1 (1.6): cause is deliberately two separate fields. causes is the
-- admin-editable dropdown that gets counted; cause_note (0034) is freetext
-- that gets read. Freetext must NEVER be promoted into this table — no
-- "add as new option," no autocomplete-from-history. Adding a cause is a
-- deliberate trip to the admin section, nothing else — so there is no code
-- path anywhere that inserts into `causes` except the admin CRUD routes.
CREATE TABLE causes (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 100,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE job_line_causes (
  job_line_id integer NOT NULL REFERENCES job_lines(id) ON DELETE CASCADE,
  cause_id    integer NOT NULL REFERENCES causes(id) ON DELETE CASCADE,
  PRIMARY KEY (job_line_id, cause_id)
);

-- Unknown is seeded deliberately prominent (sort_order 0, ahead of the
-- alphabet): without it, users pick a plausible-but-wrong cause rather than
-- leaving it blank, which produces confident bad data.
INSERT INTO causes (name, sort_order) VALUES
  ('Unknown', 0),
  ('Age / Wear', 10),
  ('Rot', 20),
  ('Water Intrusion', 30),
  ('Pest / Insect', 40),
  ('Storm Damage', 50),
  ('Vandalism', 60),
  ('Improper Install', 70),
  ('Deferred Maintenance', 80),
  ('Failed Component', 90);
