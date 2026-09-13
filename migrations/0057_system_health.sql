-- System health (Build Brief v4 Part 2): backups, calendar sync, and mail
-- ingest all fail silently today — nothing but a log file, or (for backups,
-- since the pre-live audit's B6 fix) a bespoke backup_runs table, ever
-- notices. One shared table generalizes "is this subsystem OK" so the next
-- integration gets monitoring for free instead of reinventing backup_runs's
-- pattern from scratch each time.
--
-- last_success and last_failure are separate columns, never collapsed into
-- one — same reasoning as backup_runs already applies per-row (started_at/
-- finished_at, one status per run): a failure tonight must not erase that
-- last night succeeded. `state` is the at-a-glance current read; the two
-- timestamps are what a dashboard or an alert actually reasons about, since
-- state alone can't answer "how long has this actually been broken" or
-- "was there ever a good run at all."
CREATE TABLE system_health (
  id            serial PRIMARY KEY,
  subsystem     text NOT NULL UNIQUE,
  last_success  timestamptz,
  last_failure  timestamptz,
  last_message  text,
  state         text NOT NULL DEFAULT 'unknown'
                  CHECK (state IN ('ok','warning','failed','unknown')),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_health (subsystem) VALUES ('backup'), ('gcal_sync'), ('mail_ingest');
