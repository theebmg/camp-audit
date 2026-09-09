-- Build Brief v2 Phase 4 (§4.2): the polymorphic attachment system that
-- replaces all nine of the old per-locus photo columns/tables (dropped next
-- migration). One file, many links — a roof photo is simultaneously the
-- evidence on the finding, the before shot on the job line, and the
-- reference image on the asset, uploaded once.
--
-- Deviation from the brief as written: §4.4 specifies a new `component_types`
-- table for photo classification, seeded from the distinct component_type
-- values already used by component_sub_areas/asset_components. That table
-- (`component_type_catalog`, migration 0002) already exists and IS that exact
-- vocabulary — it's what backs the live "Component Types" admin page. Adding
-- a second table would itself create the drift §4.4 explicitly warns against
-- ("one vocabulary, one place to edit, no drift"), so `classification`
-- references the existing catalog by its natural text key instead of a new
-- surrogate id.
CREATE TABLE attachments (
  id                serial PRIMARY KEY,
  url               text NOT NULL,
  thumb_url         text,
  kind              text NOT NULL DEFAULT 'image'
                      CHECK (kind IN ('image','document','audio','other')),
  mime_type         text,
  file_size         integer,
  original_filename text,
  width             integer,
  height            integer,
  caption           text,
  classification    text REFERENCES component_type_catalog(component_type),
  taken_at          timestamptz,
  gps_lat           double precision,
  gps_lng           double precision,
  source            text NOT NULL DEFAULT 'upload'
                      CHECK (source IN ('upload','email','field')),
  batch_id          integer REFERENCES attachment_batches(id) ON DELETE SET NULL,
  triage_status     text NOT NULL DEFAULT 'triaged'
                      CHECK (triage_status IN ('inbox','triaged','void')),
  uploaded_by       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE TABLE attachment_links (
  id                 serial PRIMARY KEY,
  attachment_id      integer NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  entity_type        text NOT NULL,   -- 'asset' | 'work_order' | 'job_line'
                                      -- | 'condition_finding' | 'asset_component'
                                      -- | 'maintenance_request' | 'asset_note'
  entity_id          integer NOT NULL,
  role_id            integer REFERENCES attachment_roles(id),
  include_in_report  boolean NOT NULL DEFAULT false,
  sort_order         integer NOT NULL DEFAULT 0,
  -- quote-specific, null for everything else (job-line quotes, Phase 6 §6.4)
  vendor_id          integer REFERENCES vendors(id),
  quoted_amount      numeric,
  quote_date         date,
  is_selected_quote  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attachment_id, entity_type, entity_id, role_id)
);
CREATE INDEX idx_attachment_links_entity ON attachment_links(entity_type, entity_id);
CREATE INDEX idx_attachments_triage ON attachments(triage_status) WHERE deleted_at IS NULL;
