-- Funding per allocation, stamped (Build Brief §9, decision Q1).
--
-- A receipt split between a cabin-holder job and an operating-budget job funds each
-- share differently, which a single fund_id on the receipt cannot express.
--
-- STAMPED, not resolved at read: the destination's funding is copied onto the
-- allocation when the split is made and never touched again. Same rule as everything
-- else here — remedy estimates, job-line cascade values, board-report snapshots — so a
-- report reading these rows years later never has to know how they were derived, and
-- re-funding a job line next year cannot rewrite what was already spent.
--
-- expenses.fund_id STAYS, and is not a duplicate of this. The two answer different
-- questions:
--   expenses.fund_id                 — which fund this RECEIPT was charged to
--   expense_allocations.funding_*    — which funding this SHARE is charged to
-- A receipt can be partly split: $100 on Fund A with $60 allocated to a cabin-holder
-- job leaves $40 still unallocated and still drawing on Fund A. Fund balances therefore
-- sum allocated fund shares PLUS each receipt's unallocated remainder, which is the
-- only arithmetic that stays correct while a split is half-finished. (This also means
-- the 6 receipts that currently carry a fund and no destination keep working untouched.)

ALTER TABLE expense_allocations
  ADD COLUMN funding_source text
    CHECK (funding_source IS NULL OR funding_source IN
      ('operating_budget','capital_campaign','cabin_holder','other','fund')),
  ADD COLUMN funding_ref_id integer;

-- Anything already allocated to a job line inherits that line's funding, which is what
-- the split editor will stamp from here on. No rows match today; written so the
-- migration is correct on any database rather than only this one.
UPDATE expense_allocations ea
SET funding_source = jl.funding_source,
    funding_ref_id = jl.funding_ref_id
FROM job_lines jl
WHERE ea.dest_type = 'job_line' AND ea.dest_id = jl.id AND ea.funding_source IS NULL;

-- Everything else falls back to the receipt's own fund, so no existing allocation is
-- left with no funding at all.
UPDATE expense_allocations ea
SET funding_source = 'fund', funding_ref_id = e.fund_id
FROM expenses e
WHERE ea.expense_id = e.id AND ea.funding_source IS NULL AND e.fund_id IS NOT NULL;

CREATE INDEX idx_expense_allocations_funding
  ON expense_allocations(funding_source, funding_ref_id);
