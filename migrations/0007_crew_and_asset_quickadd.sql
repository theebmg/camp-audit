-- Supports: full volunteer/vendor CRUD with address, a shared skill/specialty
-- catalog (data-driven, same pattern as building_types), and asset quick-create
-- from any picker in the app.

ALTER TABLE volunteers ADD COLUMN address text;
ALTER TABLE vendors ADD COLUMN address text;

-- Shared by volunteers.skill and vendors.specialty — historically the same
-- trade categories applied to both in NocoDB, so one catalog avoids managing
-- two near-identical lists. Editable via the Crew screen ("add on the fly")
-- and the Admin panel.
CREATE TABLE skill_catalog (
  id     serial PRIMARY KEY,
  name   text NOT NULL UNIQUE
);

INSERT INTO skill_catalog (name) VALUES
  ('Carpentry'), ('Roofing'), ('Electrical'), ('Plumbing'), ('HVAC'),
  ('Painting'), ('Masonry'), ('Landscaping'), ('General / Non-Skilled'), ('Other');
