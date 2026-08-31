-- Attendance-based hours tracking for volunteers and vendors, independent of
-- Work Orders. A crew_session is a dated block of work — optionally tied to a
-- Work Order, or standalone (e.g. "Mowing") via the free-text `activity`
-- label — with a single hours figure for the whole session, credited equally
-- to everyone who attended (see work_order_log_entries for the precedent:
-- hours already lived at the session/note level, never per-person). Jobs
-- Done for a person is derived by counting distinct work_order_id across
-- their sessions; standalone activities don't count as a "job".

CREATE TABLE crew_sessions (
  id             serial PRIMARY KEY,
  work_order_id  integer REFERENCES work_orders(id) ON DELETE SET NULL,
  activity       text,
  session_date   date NOT NULL DEFAULT CURRENT_DATE,
  hours          numeric,
  note           text,
  username       text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crew_sessions_date ON crew_sessions(session_date);
CREATE INDEX idx_crew_sessions_wo ON crew_sessions(work_order_id);

CREATE TABLE crew_session_volunteers (
  session_id    integer NOT NULL REFERENCES crew_sessions(id) ON DELETE CASCADE,
  volunteer_id  integer NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, volunteer_id)
);
CREATE INDEX idx_csv_volunteer ON crew_session_volunteers(volunteer_id);

CREATE TABLE crew_session_vendors (
  session_id  integer NOT NULL REFERENCES crew_sessions(id) ON DELETE CASCADE,
  vendor_id   integer NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, vendor_id)
);
CREATE INDEX idx_csv_vendor ON crew_session_vendors(vendor_id);
