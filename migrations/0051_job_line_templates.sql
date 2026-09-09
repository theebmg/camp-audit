-- Build Brief v2 Phase 7 (§7.1): job line templates supply WORDING AND
-- DEFAULTS ONLY, never grouping — a finding stays 1:1 with the job line it
-- becomes (§7.1: "the moment one template line covers two findings,
-- automatic finding resolution breaks"). Follows the existing data-driven
-- pattern (question_applicability keyed by building_type_id,
-- component_sub_areas keyed by component type) so a new template needs no
-- deploy.
--
-- component_type is a text FK to component_type_catalog, not a new
-- component_types(id) table — same reasoning as attachments.classification
-- in migration 0046 (that table already exists and IS this vocabulary;
-- see that migration's comment).
CREATE TABLE job_line_templates (
  id                            serial PRIMARY KEY,
  building_type_id              integer REFERENCES building_types(id),
  component_type                text REFERENCES component_type_catalog(component_type),
  default_title                 text NOT NULL,
  default_responsibility_class  text CHECK (default_responsibility_class IN ('self','volunteer','vendor','cabin_holder')),
  default_funding_source        text CHECK (default_funding_source IN ('operating_budget','capital_campaign','cabin_holder','other')),
  sort_order                    integer NOT NULL DEFAULT 100,
  active                        boolean NOT NULL DEFAULT true
);

-- A few starter examples covering the component types already seeded in
-- component_type_catalog (migration 0002) — not building-type-specific, so
-- they match regardless of which building type the finding's asset has.
-- {asset} in default_title is substituted with the asset's name at use time.
INSERT INTO job_line_templates (component_type, default_title, default_responsibility_class, default_funding_source, sort_order) VALUES
  ('Roof',       'Roof repair — {asset}',       'vendor', 'capital_campaign', 10),
  ('Siding',     'Siding repair — {asset}',     'self',   'operating_budget', 20),
  ('Foundation', 'Foundation repair — {asset}', 'vendor', 'capital_campaign', 30),
  ('Windows',    'Window repair — {asset}',     'self',   'operating_budget', 40);
