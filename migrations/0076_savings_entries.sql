-- One savings model (Build Brief §8, phase 2).
--
-- Savings lived on exactly one column, admin_tasks.recurring_monthly_savings, with no
-- one-time concept anywhere. The report needs savings from purchases too, split by
-- kind and never summed into a single figure. Keeping the old column AND adding a
-- general table would be the dual-source pattern this codebase has been removing, so
-- the column moves in and is retired in the same transaction — migrate.js runs each
-- file atomically, so the drop cannot outrun the copy.
--
-- Storage keeps the period rather than pre-annualizing: a $275/month subscription is
-- what was actually negotiated, and "$3,300/yr" is a presentation of it. Annualizing
-- at write time would lose the number the user typed.

CREATE TABLE savings_entries (
  id           serial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('recurring','one_time')),
  amount       numeric(12,2) NOT NULL CHECK (amount >= 0),
  -- Recurring says over what span the amount repeats; one-time has no period.
  period       text CHECK (period IN ('monthly','annual')),
  source_type  text NOT NULL CHECK (source_type IN ('admin_task','expense')),
  source_id    integer NOT NULL,
  -- When the saving was secured. Drives "this period" and calendar-year YTD.
  occurred_on  date NOT NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT savings_entries_period_matches_kind CHECK (
    (kind = 'recurring' AND period IS NOT NULL) OR
    (kind = 'one_time'  AND period IS NULL)
  )
);
CREATE INDEX idx_savings_entries_source ON savings_entries(source_type, source_id);
CREATE INDEX idx_savings_entries_occurred ON savings_entries(occurred_on);
CREATE INDEX idx_savings_entries_kind ON savings_entries(kind, occurred_on);

-- Move every existing admin-task saving in. task_date is when the saving was secured;
-- the old column was always a monthly recurring figure, so kind/period are known.
INSERT INTO savings_entries (kind, amount, period, source_type, source_id, occurred_on, note)
SELECT 'recurring', t.recurring_monthly_savings, 'monthly', 'admin_task', t.id,
       COALESCE(t.task_date, CURRENT_DATE),
       'Migrated from admin_tasks.recurring_monthly_savings'
FROM admin_tasks t
WHERE t.recurring_monthly_savings IS NOT NULL
  AND t.recurring_monthly_savings > 0;

ALTER TABLE admin_tasks DROP COLUMN recurring_monthly_savings;
