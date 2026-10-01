-- Enter a saving once, as old cost and new cost (Oct 2026 decisions §5).
--
-- The saving is still stored in `amount` — every reader keeps working untouched — but when it
-- was entered as a before and after, the two figures are kept so the screen can show its
-- working and be edited without retyping the arithmetic.
--
-- Direct entry stays: both columns null means the amount was typed straight in.
ALTER TABLE savings_entries
  ADD COLUMN old_cost numeric CHECK (old_cost IS NULL OR old_cost >= 0),
  ADD COLUMN new_cost numeric CHECK (new_cost IS NULL OR new_cost >= 0);

-- Nothing is backfilled. The existing entry keeps its amount exactly as Ben recorded it; he
-- said he would correct it himself.
