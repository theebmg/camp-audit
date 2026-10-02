-- Is a job line's budget funding camp money or not? (Oct 2026)
--
-- Two funding vocabularies exist and only one of them knows this. Receipts carry
-- funding_sources.counts_as_camp_spend; job lines carry a bare `funding_source` string with no
-- such flag, so the report had no way to tell cabin-holder money from camp money. This table
-- supplies it, admin-editable like every other vocabulary here.
--
-- Unknown counts as CAMP, matching the rule already used for receipts: over-counting
-- contributions understates what camp spent, which is the more misleading error in front of a
-- board.
BEGIN;

CREATE TABLE IF NOT EXISTS job_line_funding_kinds (
  source                text PRIMARY KEY,
  label                 text NOT NULL,
  counts_as_camp_spend  boolean NOT NULL DEFAULT true,
  sort_order            integer NOT NULL DEFAULT 100,
  created_at            timestamptz NOT NULL DEFAULT now()
);

INSERT INTO job_line_funding_kinds (source, label, counts_as_camp_spend, sort_order) VALUES
  ('operating_budget', 'Operating Budget',  true,  10),
  ('capital_campaign', 'Capital Campaign',  true,  20),
  ('fund',             'Fund',              true,  30),
  ('other',            'Other',             true,  40),
  ('cabin_holder',     'Cabin-Holder',      false, 50)
ON CONFLICT (source) DO NOTHING;

COMMENT ON TABLE job_line_funding_kinds IS
  'Maps job_lines.funding_source to whether that money is camp spend. Admin-editable; a source '
  'missing from this table is treated as camp spend.';

COMMIT;
