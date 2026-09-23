-- Note routing and audit-sourced asset notes (Addendum §4, §5c).
--
-- §5c asked for a table of dated asset notes. asset_notes already is one (0001_init):
-- asset_id, note, resolved, created_by, created_at, updated_at. So this is two additive
-- columns, not a new table — and nothing to migrate.
ALTER TABLE asset_notes
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','audit')),
  ADD COLUMN source_answer_id integer REFERENCES audit_answers(id) ON DELETE SET NULL;
CREATE INDEX idx_asset_notes_source_answer ON asset_notes(source_answer_id) WHERE source_answer_id IS NOT NULL;

-- Where a note captured in the runner should ALSO go. The original always stays on the
-- audit answer — routing adds a linked copy, it never moves the record — so this column
-- describes a destination, not a location.
--
-- Stored rather than inferred so "all job notes from Fall 2026" is a WHERE clause,
-- which is the whole reason §4 asks for it to be queryable.
ALTER TABLE audit_answers
  ADD COLUMN note_destination text NOT NULL DEFAULT 'audit_only'
    CHECK (note_destination IN ('audit_only','asset','job'));

-- A job note whose building ends with no work order is STRANDED: the review screen has
-- to ask what to do with it rather than dropping it. Recording when it was dealt with
-- keeps "show me the ones still unresolved" a query instead of a guess.
ALTER TABLE audit_answers
  ADD COLUMN note_resolved_at timestamptz;
