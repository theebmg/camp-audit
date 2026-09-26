-- People & Groups (text-intake brief §1, redesigned).
--
-- cabin_holders is NOT the people table and is not touched here. It is a list of cabin
-- HOLDINGS, derived from imported asset text by syncCabinHoldersFromAssets(), and it contains
-- labels, roles, organizations and crews as well as humans. Converting it into a people table
-- needed a not-a-person flag, an alias table, and a fight with the sync — three patches for
-- one wrong premise. So people live in their own table and a link table joins them to the
-- holdings they hold.
--
-- Unchanged by this migration: cabin_holders rows, the sync, assets.cabin_holder_id,
-- assets.lodge_holder, and funding (funding_source = 'cabin_holder' keeps pointing at
-- cabin_holders). The sync can keep running because it only ever manages holdings.
--
-- "Cabin holder" is a DERIVED role: a person with at least one linked holding is one. It is
-- deliberately absent from person_roles, so there is one source of truth for it.

-- ── People ───────────────────────────────────────────────────────────────
CREATE TABLE people (
  id               serial PRIMARY KEY,
  -- NOT unique. Two real people can share a name, and §1's duplicate check ends in "create
  -- new anyway" — which a unique constraint would refuse.
  name             text NOT NULL,
  phone            text,
  email            text,
  notes            text,
  -- Volunteer role fields. text[] of skill_catalog names, matching volunteers.skill, which is
  -- the convention already in use rather than a new join table.
  volunteer_skills text[] NOT NULL DEFAULT '{}',
  volunteer_notes  text,
  -- Vendor-contact role field. Vendors stay organizations; a person points at one.
  vendor_id        integer REFERENCES vendors(id) ON DELETE SET NULL,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_people_updated_at BEFORE UPDATE ON people
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Substring search in the picker, and the duplicate check.
CREATE INDEX idx_people_name_lower ON people (lower(name));

-- ── Roles: admin-editable, like every other list in this system ───────────
-- No "Cabin holder" row: that role is derived from cabin_holder_people.
CREATE TABLE person_roles (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  sort_order  integer NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO person_roles (name, sort_order) VALUES
  ('Volunteer',      10),
  ('Camp attendee',  20),
  ('Vendor contact', 30);

CREATE TABLE person_role_assignments (
  person_id  integer NOT NULL REFERENCES people(id)       ON DELETE CASCADE,
  role_id    integer NOT NULL REFERENCES person_roles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, role_id)
);
CREATE INDEX idx_person_role_assignments_role ON person_role_assignments (role_id);

-- ── People ↔ holdings ────────────────────────────────────────────────────
-- Many-to-many both ways on purpose: a person can hold two cabins (two of them do today), and
-- a holding can name more than one person later. A label holding simply has no row here.
CREATE TABLE cabin_holder_people (
  cabin_holder_id integer NOT NULL REFERENCES cabin_holders(id) ON DELETE CASCADE,
  person_id       integer NOT NULL REFERENCES people(id)        ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cabin_holder_id, person_id)
);
CREATE INDEX idx_cabin_holder_people_person ON cabin_holder_people (person_id);

-- ── Groups ───────────────────────────────────────────────────────────────
CREATE TABLE group_types (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  sort_order  integer NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO group_types (name, sort_order) VALUES
  ('Youth group',  10),
  ('Church group', 20),
  ('Work team',    30),
  ('Other',        40);

CREATE TABLE groups (
  id                serial PRIMARY KEY,
  name              text NOT NULL,
  type_id           integer REFERENCES group_types(id) ON DELETE SET NULL,
  contact_person_id integer REFERENCES people(id)      ON DELETE SET NULL,
  notes             text,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_groups_updated_at BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_groups_name_lower ON groups (lower(name));
CREATE INDEX idx_groups_contact ON groups (contact_person_id);

-- ── Merge log ────────────────────────────────────────────────────────────
-- Every merge is recorded with what was repointed and how many rows, because a merge spans
-- tables that no single foreign key describes.
CREATE TABLE record_merges (
  id           serial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('person', 'group')),
  kept_id      integer NOT NULL,
  kept_name    text NOT NULL,
  removed_id   integer NOT NULL,
  removed_name text NOT NULL,
  -- { "table.column": rows_repointed, … }
  repointed    jsonb NOT NULL DEFAULT '{}'::jsonb,
  merged_by    text,
  merged_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_record_merges_kept ON record_merges (kind, kept_id);

-- ── Calendar visit events point at people and groups ─────────────────────
-- visitor_name / visitor_contact stay for now: they are what the Google sync builds its
-- summary from, and the board report still reads them until §2 repoints Visitor Activity.
ALTER TABLE calendar_events
  ADD COLUMN person_id integer REFERENCES people(id) ON DELETE SET NULL,
  ADD COLUMN group_id  integer REFERENCES groups(id) ON DELETE SET NULL;
CREATE INDEX idx_calendar_events_person ON calendar_events (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX idx_calendar_events_group  ON calendar_events (group_id)  WHERE group_id  IS NOT NULL;

-- ── Seed one person per holding that names a human ───────────────────────
-- Three rules, in order:
--   1. The 14 label holdings get no person. Matched by exact name — chosen by reading all 173,
--      not by pattern: cabin purposes, roles, organizations, a crew, two labels.
--   2. Two exact variant pairs collapse to one person each, because the same human holds two
--      cabins under two spellings. Found by normalising: lowercase, drop punctuation, split on
--      comma / & / and / slash / plus, sort the parts, compare.
--   3. Everything else gets one person, named exactly as the holding is named. Names are NOT
--      reformatted — "Lapp, Jen" stays "Lapp, Jen" — because silently rewriting 157 names is
--      Ben's call, not a migration's. Logged as a question.
CREATE TEMP TABLE seed_map (cabin_holder_id integer, person_name text) ON COMMIT DROP;

INSERT INTO seed_map (cabin_holder_id, person_name)
SELECT c.id,
       CASE
         -- Ben Greenawalt: Ebenezer 22 and Peace 18.
         WHEN c.name IN ('Ben Greenawalt', 'Greenawalt, Ben') THEN 'Ben Greenawalt'
         -- Jill Martin: Tabernacle 13 and Weatherwax 30 Upstairs.
         WHEN c.name IN ('Martin, Jill', 'Jill Martin')       THEN 'Jill Martin'
         ELSE c.name
       END
FROM cabin_holders c
WHERE c.name NOT IN (
  'Storage',                       -- cabin purpose
  'Blank Lot',                     -- placeholder
  'Historical',                    -- cabin purpose
  'Nurse''s Cabin',                -- cabin purpose
  'Matron''s Room',                -- cabin purpose
  'SongLeader',                    -- role
  'Youth Evangelist',              -- role
  'Children''s Evangelists',       -- role
  'Children''s Ministry - Blaine',  -- ministry/purpose label
  'Keene Crew',                    -- a crew, not a person
  'Full Cabin - Boyette',          -- cabin label
  'OMS',                           -- organization
  'WGM Missions',                  -- organization
  'Bethany Missions'               -- organization
);

INSERT INTO people (name)
SELECT DISTINCT person_name FROM seed_map;

INSERT INTO cabin_holder_people (cabin_holder_id, person_id)
SELECT s.cabin_holder_id, p.id
FROM seed_map s
JOIN people p ON p.name = s.person_name;

-- ── Convert the one existing visit to a person link ──────────────────────
-- Event 18, "Rebecca Conley Visit", 2026-09-17, visitor_name 'Conley, Rebecca',
-- cabin_holder_id 51. Resolved through the holding link rather than by name matching, so it
-- lands on the person that holding just seeded.
UPDATE calendar_events e
SET person_id = chp.person_id
FROM cabin_holder_people chp
WHERE e.cabin_holder_id = chp.cabin_holder_id
  AND e.visitor_name IS NOT NULL
  AND e.person_id IS NULL;
