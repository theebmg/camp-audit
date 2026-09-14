-- Build Brief v4 step 3: the outbound sync worker itself. Everything up to
-- now (0058-0062) was groundwork — this migration adds what the worker
-- actually needs to create/update/delete real Google events and back off
-- sanely on failure.

-- One Google event id per synced row. Nullable: a job_line only gets one
-- once it has a scheduled_date and the worker has actually run; a
-- calendar_event gets one on its very first sync (see queueGcalSync now
-- being called from createCalendarEvent/createJobLine in db.js, not just
-- the update paths — those were the two enqueue gaps found while building
-- this: neither create path queued a sync, so a line scheduled at creation
-- or a brand-new calendar event would have sat invisible until its next
-- edit).
ALTER TABLE job_lines ADD COLUMN gcal_event_id text;
ALTER TABLE calendar_events ADD COLUMN gcal_event_id text;

-- Retry bookkeeping for the queue migration 0062 already created. next_
-- attempt_at defaults to now() so a freshly-queued row is immediately due;
-- a transient failure pushes it out with exponential backoff (worker-side
-- math, capped — see gcalSync.js), a dead refresh token touches nothing
-- here at all (brief: "do NOT retry on a dead token" — the whole drain
-- aborts before any per-item attempt, so nothing here should count as a
-- failed attempt just because the token was bad that run).
ALTER TABLE gcal_pending_syncs
  ADD COLUMN attempts        integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_error      text;

-- Deletes can't reuse gcal_pending_syncs: by the time the worker drains a
-- delete, the job_line/calendar_event row is already gone (deleteJobLine/
-- deleteCalendarEvent run DELETE immediately, per every other entity in
-- this app — nothing here introduces soft-delete). So the *only* thing the
-- worker needs to finish the job — the Google event id — has to be
-- captured at delete time and carried here, disconnected from any CMMS
-- row. Same backoff columns as gcal_pending_syncs, same reasoning.
CREATE TABLE gcal_pending_deletes (
  id              serial PRIMARY KEY,
  gcal_event_id   text NOT NULL,
  queued_at       timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text
);

-- Color mapping by *kind*, not by entity_type — a calendar_event's color
-- already comes from calendar_event_types.gcal_color_id (migration 0061),
-- admin-editable per type. job_line has no such per-item category, so it
-- gets exactly one row here: every synced job line is one flat color,
-- distinguishing "this came from a job line" from "this came from an
-- admin-typed calendar event" at a glance on the calendar. Deliberately a
-- real table, not a column on some settings singleton — the seeded 'other
-- future kinds land here as their own migrations add rows once those sync
-- paths (wo_revisit / finding_revisit / pm_due — see calendar_event_types'
-- migration comment) actually get built; none of the three are wired into
-- gcal_pending_syncs yet, so only 'job_line' is seeded now.
CREATE TABLE gcal_event_colors (
  kind          text PRIMARY KEY,
  gcal_color_id text
);
INSERT INTO gcal_event_colors (kind) VALUES ('job_line');
