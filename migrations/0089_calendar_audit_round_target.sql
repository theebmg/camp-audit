-- Calendar events can materialize an AUDIT ROUND, not just a work order
-- (Build Brief §6, decisions §3).
--
-- The scheduler machinery already exists and is better than the brief's proposal:
-- generateDueWorkOrdersForRange expands recurrence, guards with
-- calendar_event_generated_wo and an advisory lock, and is idempotent across restarts.
-- Rather than building a parallel `schedules` table, a calendar event gains a second
-- target — the audit form it should open a round for — and the same guard pattern gets
-- its own table.
--
-- lead_days/grace_days from the brief map onto what already exists: the event date IS
-- the occurrence, materialization happens when it comes due, and due_date is set from
-- grace_days at creation.
ALTER TABLE calendar_events
  ADD COLUMN audit_form_id integer REFERENCES audit_forms(id) ON DELETE SET NULL,
  ADD COLUMN audit_lead_days  integer NOT NULL DEFAULT 14,
  ADD COLUMN audit_grace_days integer NOT NULL DEFAULT 14;

-- The same shape as calendar_event_generated_wo, for the same reason: one row per
-- (event, occurrence) is what makes re-running the job harmless.
CREATE TABLE calendar_event_generated_round (
  id                serial PRIMARY KEY,
  calendar_event_id integer NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  occurrence_date   date NOT NULL,
  round_id          integer NOT NULL REFERENCES audit_rounds(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (calendar_event_id, occurrence_date)
);
CREATE INDEX idx_cegr_round ON calendar_event_generated_round(round_id);

-- Which buildings a scheduled round covers. Resolved to explicit instances at
-- materialization, so the round's scope is still its instances — this is the recipe,
-- not the scope.
CREATE TABLE calendar_event_audit_scope (
  calendar_event_id integer NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  asset_id          integer NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY (calendar_event_id, asset_id)
);
