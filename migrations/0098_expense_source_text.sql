-- A receipt can now arrive by text (text-intake brief §5), and expenses.source only allowed
-- 'manual' and 'email'. Caught by the intake test rather than in production: filing a texted
-- receipt failed the check constraint.
--
-- Widened rather than dropped, because the point of the constraint is that source is a known
-- set — an unconstrained column would let a typo through silently.
ALTER TABLE expenses DROP CONSTRAINT expenses_source_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_source_check
  CHECK (source IN ('manual', 'email', 'text'));

-- attachment_batches.source is plain text with no constraint today, so a texted photo batch
-- already works. Left alone rather than constrained here: tightening a column this migration
-- does not otherwise touch is how an unrelated insert starts failing next week.
