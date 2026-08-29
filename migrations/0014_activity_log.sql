-- History/audit trail: "what has been done" across the app, so an accidental
-- delete (or any change) is visible after the fact. No foreign key on
-- entity_id — a log row for a deleted record must survive that deletion,
-- which is the whole point.

CREATE TABLE activity_log (
  id           serial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  username     text,
  action       text NOT NULL,   -- 'created' | 'updated' | 'deleted' | 'completed' | ...
  entity_type  text NOT NULL,   -- 'location' | 'asset' | 'work_order' | 'volunteer' | ...
  entity_id    integer,
  entity_label text,            -- human-readable name/title captured at the time of the action
  details      text
);
CREATE INDEX idx_activity_log_occurred ON activity_log(occurred_at DESC);
CREATE INDEX idx_activity_log_entity ON activity_log(entity_type, entity_id);
