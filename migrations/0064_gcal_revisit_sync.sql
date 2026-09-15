-- Build Brief v4 step 3, closing the "revisit dates" gap flagged in
-- update-for-claude.md after the sync worker's first pass: a deferred work
-- order or deferred finding's revisit_date was intended scope for the
-- outbound sync all along (Ben's call, 2026-09-15) — just not built in the
-- first drain-worker pass because the design ("what does a synthetic
-- Google event for a prompt, not an appointment, even look like") needed a
-- real decision first.

-- Two more entity_type values alongside 'job_line'/'calendar_event'. Same
-- queue, same worker, same retry/backoff columns — a revisit date needing
-- (re)synced is exactly the same kind of "this row changed, Google needs
-- to hear about it" fact as a job line's schedule changing.
ALTER TABLE gcal_pending_syncs DROP CONSTRAINT gcal_pending_syncs_entity_type_check;
ALTER TABLE gcal_pending_syncs ADD CONSTRAINT gcal_pending_syncs_entity_type_check
  CHECK (entity_type IN ('job_line', 'calendar_event', 'wo_revisit', 'finding_revisit'));

-- One Google event id per revisit-carrying row, same nullable-until-first-
-- sync pattern as job_lines.gcal_event_id / calendar_events.gcal_event_id
-- (migration 0063). Revisit prompts are never edited in place on Google
-- (they're all-day, never draggable) but still need an id to know whether
-- to insert vs. update vs., on leaving Deferred, delete.
ALTER TABLE work_orders ADD COLUMN gcal_event_id text;
ALTER TABLE condition_findings ADD COLUMN gcal_event_id text;

-- One shared color for both revisit kinds, not two — the brief's own
-- wording ("own color... distinct from job lines") treats deferred work
-- orders and deferred findings as one visual concept ("a prompt, not an
-- appointment"), not two things needing to be told apart from each other.
-- Keyed by 'kind' (gcal_event_colors' existing axis, migration 0063 —
-- independent of entity_type) rather than adding a second row.
INSERT INTO gcal_event_colors (kind) VALUES ('revisit');
