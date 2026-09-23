-- Materials and leftovers (Build Brief §10, phase 3).
--
-- Explicitly NOT an inventory system: no counts, no reorder points, no locations, no
-- stock dashboard. One list of named materials and one balance each, so the app can
-- answer "you should have 4 sheets of drywall left" at the moment that matters.
--
-- Balance is never stored. It is the sum of material_movements, so a correction is a
-- logged row rather than an overwrite, and the history of how a balance got where it is
-- survives. Storing a balance column too would let the two disagree, and the one that
-- disagreed would be the one nobody could explain.
--
-- Quantity is signed: + adds to the balance, - takes from it. kind says why, and the
-- CHECK keeps the sign consistent with the meaning so a 'tossed' row can't
-- accidentally add stock.

CREATE TABLE materials (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  unit        text NOT NULL,                       -- 'sheets', 'ft', 'gal'
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, unit)
);
CREATE INDEX idx_materials_active ON materials(active, name);

CREATE TABLE material_movements (
  id             serial PRIMARY KEY,
  material_id    integer NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('wo_close','to_job','correction','tossed')),
  quantity       numeric NOT NULL CHECK (quantity <> 0),
  -- Carried at the price actually paid, so drawing from stock later moves real cost
  -- rather than a guess. Null for a correction that only fixes a count.
  unit_price     numeric CHECK (unit_price IS NULL OR unit_price >= 0),
  -- Where it came from / went to. Both nullable: a correction belongs to neither.
  work_order_id  integer REFERENCES work_orders(id) ON DELETE SET NULL,
  job_line_id    integer REFERENCES job_lines(id) ON DELETE SET NULL,
  note           text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT material_movements_sign_matches_kind CHECK (
    (kind = 'wo_close'   AND quantity > 0) OR
    (kind = 'to_job'     AND quantity < 0) OR
    (kind = 'tossed'     AND quantity < 0) OR
    (kind = 'correction')
  )
);
CREATE INDEX idx_material_movements_material ON material_movements(material_id, created_at);
CREATE INDEX idx_material_movements_wo ON material_movements(work_order_id);

-- Deferred from 0075 rather than forward-referencing a table that didn't exist yet.
-- Optional: not every purchase is of a tracked material.
ALTER TABLE expense_line_items
  ADD COLUMN material_id integer REFERENCES materials(id) ON DELETE SET NULL;
CREATE INDEX idx_expense_line_items_material ON expense_line_items(material_id);

-- Which material a 'leftover' allocation is stock OF. Null stays legal for the other
-- destination types, and the CHECK ties the two together so a leftover row can't be
-- stock of nothing.
ALTER TABLE expense_allocations
  ADD COLUMN material_id integer REFERENCES materials(id) ON DELETE SET NULL;
ALTER TABLE expense_allocations
  ADD CONSTRAINT expense_allocations_leftover_needs_material
  CHECK (dest_type <> 'leftover' OR material_id IS NOT NULL);
