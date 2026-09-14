-- Build Brief v4 Part 1, groundwork for step 3 (the outbound sync worker,
-- not built yet — see gcal.js's header comment). Something has to record
-- "this row changed, Google needs to hear about it" the moment it happens,
-- not whenever step 3 gets built, or every date change made before then
-- (via the job-line form, and now via the calendar's drag-to-reschedule)
-- would be invisible to the worker on day one. One row per entity, latest
-- change wins (ON CONFLICT bumps queued_at rather than duplicating) — the
-- worker doesn't care how many times something moved, only that it needs
-- to look at it once before it's done.
CREATE TABLE gcal_pending_syncs (
  entity_type  text NOT NULL CHECK (entity_type IN ('job_line', 'calendar_event')),
  entity_id    integer NOT NULL,
  queued_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id)
);
