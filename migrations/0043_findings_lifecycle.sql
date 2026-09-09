-- Build Brief v2, Phase 3: condition_findings.status has been 'Open' at
-- insert with no path out (hardcoded in three places in db.js), so "Open"
-- has been standing for both "urgent, unaddressed" and "reviewed, can wait
-- five years." A real lifecycle: Open (insert) -> Scheduled (auto, when a
-- job line links to it) -> Resolved (auto, when that job line reaches a
-- counts_as_work_performed status) or Deferred/Dismissed (manual, both
-- requiring an explanation). Nothing is ever deleted.
--
-- reviewed_by/reviewed_at mirror the pattern already in maintenance_requests
-- and make every manual deferral/dismissal attributable — the difference
-- between a decision and a thing that quietly didn't happen. Auto-transitions
-- (Scheduled, Resolved) don't stamp these; they're not a person's decision.
--
-- Test data only, and the only status value in use today is 'Open' (verified
-- before writing this migration), so the CHECK constraint is safe to add
-- with no cleanup needed.
ALTER TABLE condition_findings
  ADD COLUMN deferred_reason text,
  ADD COLUMN revisit_date    date,
  ADD COLUMN dismiss_note    text,
  ADD COLUMN reviewed_by     text,
  ADD COLUMN reviewed_at     timestamptz;
ALTER TABLE condition_findings ADD CONSTRAINT condition_findings_status_check
  CHECK (status IN ('Open', 'Scheduled', 'Resolved', 'Deferred', 'Dismissed'));
CREATE INDEX idx_condition_findings_revisit ON condition_findings(revisit_date);
