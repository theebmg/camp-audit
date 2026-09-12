-- Backup status surfacing (Ben's request, 2026-09-12, fix 3 of the pre-live
-- audit's B6 finding): nightly backup success/failure previously only ever
-- reached a log file nothing in the app reads. scripts/backup.sh now writes
-- one row here per run (success or failure) via a plain `docker exec ...
-- psql` call at the end of each branch — the same trust-auth path it
-- already uses for pg_dump, no new credentials. The app reads this table
-- like any other data (getBackupStatus in db.js) to show a warning on the
-- dashboard when the most recent run failed or the last success is stale.
CREATE TABLE backup_runs (
  id           serial PRIMARY KEY,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL CHECK (status IN ('ok', 'failed')),
  detail       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_backup_runs_finished ON backup_runs(finished_at DESC);
