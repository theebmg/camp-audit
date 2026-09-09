-- Build Brief v2, Phase 2 (2.3): Deferred requires both a reason and a
-- revisit_date — enforced at the API layer (db.js), not just the UI, because
-- that enforcement is where the board credibility comes from. Same pattern
-- will be reused for deferred findings in Phase 3 (one implementation, both
-- sources feed the calendar/dashboard "due" surfaces the same way).
ALTER TABLE work_orders
  ADD COLUMN deferred_reason text,
  ADD COLUMN revisit_date    date;
CREATE INDEX idx_work_orders_revisit ON work_orders(revisit_date);

-- Build Brief v2 (2.6): one admin-wide setting for whether the WO grid's
-- progress bar defaults to cost-weighted or line-count-weighted. Cost-
-- weighted is the default per the brief (finishing two of three lines while
-- the roof — most of the money — sits untouched is "67% done" by count and
-- roughly 20% by money; showing the board the first number overstates
-- progress). A dedicated single-row table, same shape as budget_settings,
-- rather than a generic key-value store — this is the only display
-- preference that exists right now.
CREATE TABLE display_settings (
  id                      serial PRIMARY KEY,
  wo_progress_weighting   text NOT NULL DEFAULT 'cost' CHECK (wo_progress_weighting IN ('cost', 'count'))
);
INSERT INTO display_settings (wo_progress_weighting) VALUES ('cost');
