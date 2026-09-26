-- Visitor log (text-intake brief §2). The one visit store.
--
-- Built before the merge tool on purpose: a merge has to repoint visits, and writing merge
-- against a table that does not exist yet would mean writing it twice.
--
-- Visitor Activity used to be derived straight off calendar occurrences with a visitor_name
-- (getVisitorActivityRawData). It is repointed at this table in the same change. Calendar
-- visit events keep their role: they SCHEDULE a visit, which lands here as `expected`.

CREATE TABLE visits (
  id                serial PRIMARY KEY,

  -- Who. Exactly one of the two, enforced below — a visit is a person or a group, never both
  -- and never free text.
  person_id         integer REFERENCES people(id) ON DELETE CASCADE,
  group_id          integer REFERENCES groups(id) ON DELETE CASCADE,
  -- Groups always; optional for a person who brought guests.
  headcount         integer CHECK (headcount IS NULL OR headcount > 0),

  -- Where. A cabin (asset) or an area (location); either, neither, not both required.
  asset_id          integer REFERENCES assets(id)    ON DELETE SET NULL,
  location_id       integer REFERENCES locations(id) ON DELETE SET NULL,

  visit_date        date NOT NULL,
  -- NULL means "not stated", which is a real answer and not missing data.
  arrival_time      time,
  duration_minutes  integer CHECK (duration_minutes IS NULL OR duration_minutes > 0),

  reason            text,
  -- A visit logged from a text or by hand with no matching expected visit defaults to false;
  -- one created from a calendar event is true, because scheduling it IS calling ahead.
  called_ahead      boolean NOT NULL DEFAULT false,
  notes             text,

  status            text NOT NULL DEFAULT 'confirmed'
                      CHECK (status IN ('expected', 'confirmed', 'no_show')),
  source            text NOT NULL
                      CHECK (source IN ('text', 'manual', 'calendar')),

  -- Set when the visit came from a calendar event. Kept so the "Did they show up?" queue can
  -- name the event, and so re-running the projection updates rather than duplicates.
  calendar_event_id integer REFERENCES calendar_events(id) ON DELETE SET NULL,
  -- Which occurrence of a recurring event this is. A monthly visit makes one row per month.
  occurrence_date   date,

  confirmed_by      text,
  confirmed_at      timestamptz,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT visits_person_xor_group
    CHECK ((person_id IS NOT NULL) <> (group_id IS NOT NULL))
);

CREATE TRIGGER trg_visits_updated_at BEFORE UPDATE ON visits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_visits_date ON visits (visit_date DESC);
CREATE INDEX idx_visits_person ON visits (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX idx_visits_group ON visits (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX idx_visits_asset ON visits (asset_id) WHERE asset_id IS NOT NULL;
-- The "Did they show up?" queue: expected visits whose date has passed.
CREATE INDEX idx_visits_expected ON visits (visit_date) WHERE status = 'expected';

-- One visit per calendar occurrence. Without this, re-running the projection after an event is
-- edited would add a second expected visit instead of updating the first. Partial, because
-- rows with no event are unconstrained — and NULLs being DISTINCT in Postgres would make a
-- plain unique index do nothing for them anyway.
CREATE UNIQUE INDEX idx_visits_one_per_occurrence
  ON visits (calendar_event_id, occurrence_date)
  WHERE calendar_event_id IS NOT NULL;

-- ── Backfill: the one existing visit ─────────────────────────────────────
-- Event 18, Rebecca Conley, 2026-09-17, already carries person_id from 0095. It is in the
-- past and it happened, so it lands as confirmed rather than expected — there is nothing to
-- ask about a visit that was recorded after the fact.
INSERT INTO visits (person_id, asset_id, visit_date, reason, called_ahead, status, source,
                    calendar_event_id, occurrence_date, created_by)
SELECT e.person_id, e.asset_id, e.event_date, e.visit_purpose, true, 'confirmed', 'calendar',
       e.id, e.event_date, 'migration 0096'
FROM calendar_events e
WHERE e.person_id IS NOT NULL
  AND e.visitor_name IS NOT NULL;
