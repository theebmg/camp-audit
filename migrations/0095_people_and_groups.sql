-- People & Groups (text-intake brief §1).
--
-- cabin_holders BECOMES the people table. It is not renamed and nothing is migrated out of
-- it, because two real foreign keys (assets.cabin_holder_id, calendar_events.cabin_holder_id)
-- and one soft reference with no FK at all (funding_ref_id where funding_source =
-- 'cabin_holder', on six tables) all point at it today. The UI calls them People; the table
-- keeps its name so none of that has to move. See docs/text-intake-analysis.md §0.2.
--
-- Additive only. Every existing row keeps working with no roles and no contact details.

-- ── People ───────────────────────────────────────────────────────────────
ALTER TABLE cabin_holders
  -- The brief's basic fields; neither existed.
  ADD COLUMN phone            text,
  ADD COLUMN email            text,
  -- Some of these rows are not people: cabin purposes (Storage, Nurse's Cabin), roles
  -- (SongLeader, Youth Evangelist), organizations (OMS, WGM Missions) and placeholders
  -- (Blank Lot). They are load-bearing — cabins point at them — so they stay, but they are
  -- hidden from people pickers, the duplicate check and people counts.
  ADD COLUMN not_a_person     boolean NOT NULL DEFAULT false,
  -- Volunteer role fields. text[] of skill_catalog names, matching volunteers.skill, which
  -- is the convention already in use rather than a new join table.
  ADD COLUMN volunteer_skills text[] NOT NULL DEFAULT '{}',
  ADD COLUMN volunteer_notes  text,
  -- Vendor-contact role field. Vendors stay organizations; a person points at one.
  ADD COLUMN vendor_id        integer REFERENCES vendors(id) ON DELETE SET NULL,
  ADD COLUMN updated_at       timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER trg_cabin_holders_updated_at BEFORE UPDATE ON cabin_holders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Case-insensitive name lookup for the duplicate check and the picker's substring search.
CREATE INDEX idx_cabin_holders_name_lower ON cabin_holders (lower(name));
CREATE INDEX idx_cabin_holders_is_person ON cabin_holders (not_a_person) WHERE NOT not_a_person;

-- ── Roles: admin-editable, like every other list in this system ───────────
CREATE TABLE person_roles (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  sort_order  integer NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO person_roles (name, sort_order) VALUES
  ('Cabin holder',   10),
  ('Volunteer',      20),
  ('Camp attendee',  30),
  ('Vendor contact', 40);

CREATE TABLE person_role_assignments (
  person_id  integer NOT NULL REFERENCES cabin_holders(id) ON DELETE CASCADE,
  role_id    integer NOT NULL REFERENCES person_roles(id)  ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, role_id)
);
CREATE INDEX idx_person_role_assignments_role ON person_role_assignments (role_id);

-- Anyone a cabin actually points at is a cabin holder. Derived from the data rather than
-- assumed: 174 of 340 assets carry a cabin_holder_id.
INSERT INTO person_role_assignments (person_id, role_id)
SELECT DISTINCT a.cabin_holder_id, (SELECT id FROM person_roles WHERE name = 'Cabin holder')
FROM assets a
WHERE a.cabin_holder_id IS NOT NULL
ON CONFLICT DO NOTHING;

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
  type_id           integer REFERENCES group_types(id)   ON DELETE SET NULL,
  -- Optional contact person, from People.
  contact_person_id integer REFERENCES cabin_holders(id) ON DELETE SET NULL,
  notes             text,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_groups_updated_at BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_groups_name_lower ON groups (lower(name));
CREATE INDEX idx_groups_contact ON groups (contact_person_id);

-- ── Name aliases — what makes a merge stick ──────────────────────────────
-- cabin_holders is a DERIVED roster: syncCabinHoldersFromAssets() runs before every list
-- read and re-inserts a row for every distinct assets.lodge_holder text. All 173 holders are
-- backed by that text today — not one was hand-made. So a merge that only repointed keys
-- would be silently undone on the next page load, because the sync would recreate the row it
-- had just removed.
--
-- The fix is an alias, not a rewrite of assets.lodge_holder. lodge_holder is the original
-- imported text and should stay as it was typed; what changes is which person that text
-- resolves to. A merge records the removed name as an alias of the kept person, the sync
-- stops inventing a row for an aliased name, and a future import of the same variant lands on
-- the right person by itself.
CREATE TABLE cabin_holder_aliases (
  id         serial PRIMARY KEY,
  -- The spelling seen in the wild (e.g. 'Lapp, Jen'). Matched case-insensitively, trimmed.
  name       text NOT NULL,
  person_id  integer NOT NULL REFERENCES cabin_holders(id) ON DELETE CASCADE,
  -- Why the alias exists, for the audit trail.
  source     text NOT NULL DEFAULT 'merge' CHECK (source IN ('merge', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_cabin_holder_aliases_name ON cabin_holder_aliases (lower(btrim(name)));
CREATE INDEX idx_cabin_holder_aliases_person ON cabin_holder_aliases (person_id);

-- ── Merge log ────────────────────────────────────────────────────────────
-- Every merge is recorded, including exactly what was repointed and how many rows, because
-- the polymorphic funding references cannot be reconstructed afterwards from the schema.
CREATE TABLE record_merges (
  id           serial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('person', 'group')),
  kept_id      integer NOT NULL,
  kept_name    text NOT NULL,
  removed_id   integer NOT NULL,
  removed_name text NOT NULL,
  -- { "table.column": rows_repointed, … } — the audit trail for a merge.
  repointed    jsonb NOT NULL DEFAULT '{}'::jsonb,
  merged_by    text,
  merged_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_record_merges_kept ON record_merges (kind, kept_id);

-- ── Flag the rows that are not people ────────────────────────────────────
-- Chosen by reading all 173 names, not by pattern match. Purposes, roles, organizations and
-- placeholders. Listed in docs/open-questions.md for Ben's review; anything ambiguous —
-- surname-only rows like Starbuck or Dearth, "Hill Evangelist", "Rev. Greenawalt",
-- "Shiltz, George to Be Transitioned" — is deliberately LEFT as a person.
UPDATE cabin_holders SET not_a_person = true WHERE name IN (
  'Storage',                      -- cabin purpose
  'Blank Lot',                    -- placeholder
  'Historical',                   -- cabin purpose
  'Nurse''s Cabin',               -- cabin purpose
  'Matron''s Room',               -- cabin purpose
  'SongLeader',                   -- role
  'Youth Evangelist',             -- role
  'Children''s Evangelists',      -- role
  'Children''s Ministry - Blaine', -- ministry/purpose label
  'Keene Crew',                   -- a crew, not a person
  'Full Cabin - Boyette',         -- cabin label
  'OMS',                          -- organization
  'WGM Missions',                 -- organization
  'Bethany Missions'              -- organization
);

-- A row that is not a person cannot hold a role.
DELETE FROM person_role_assignments pra
USING cabin_holders c
WHERE c.id = pra.person_id AND c.not_a_person;
