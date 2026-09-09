-- Build Brief v2 Phase 4 (§4.3): role answers "what is this, relative to this
-- record" — purpose/stage, not subject matter (that's classification, next
-- migration). Lives on the link row (attachment_links.role_id, 0046), not on
-- the attachment itself, because the same file can be "After / Repair" on a
-- job line and "Reference" on the asset simultaneously.
CREATE TABLE attachment_roles (
  id                        serial PRIMARY KEY,
  name                      text NOT NULL UNIQUE,
  sort_order                integer NOT NULL DEFAULT 100,
  default_include_in_report boolean NOT NULL DEFAULT false,
  active                    boolean NOT NULL DEFAULT true
);

-- Before/After pre-tick the report checkbox — tagging something "After /
-- Repair" is already the user saying "this is the proof." Everything else
-- defaults unticked and is overridable per link.
INSERT INTO attachment_roles (name, sort_order, default_include_in_report) VALUES
  ('Before / Condition', 10, true),
  ('After / Repair',     20, true),
  ('During',             30, false),
  ('Evidence',           40, false),
  ('Reference',          50, false),
  ('Documentation',      60, false),
  ('Quote',              70, false),
  ('Invoice',            80, false),
  ('Permit',             90, false),
  ('Warranty',          100, false),
  ('Spec',              110, false);
