-- Build Brief v2 Phase 5 (§5.4): a WO can be split — some job lines carry on
-- under the original job, the rest move to a sibling. `id serial` stays the
-- real primary key and every FK everywhere keeps pointing at it unchanged;
-- wo_number is purely a DISPLAY string ("1000", "1000-2", "1000-3", ...),
-- always the next flat suffix off the root, never nested ("1000-2-2") —
-- three-deep numbers become unreadable exactly when things are already
-- messy. parent_wo_id records true lineage; split_root_id (a WO's own id,
-- for a never-split WO) is what makes the family rollup query a single
-- indexed lookup instead of a recursive walk.
--
-- Every existing WO becomes its own unsplit root here — not a backfill of
-- old semantics (there were none: this concept didn't exist before), just
-- establishing the invariant the new NOT NULL columns need to be usable at
-- all, same as any migration that adds a required column to a live table.
ALTER TABLE work_orders
  ADD COLUMN wo_number     text,
  ADD COLUMN parent_wo_id  integer REFERENCES work_orders(id),
  ADD COLUMN split_root_id integer REFERENCES work_orders(id);

UPDATE work_orders SET wo_number = id::text, split_root_id = id;

ALTER TABLE work_orders ALTER COLUMN wo_number SET NOT NULL;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_wo_number_key UNIQUE (wo_number);
ALTER TABLE work_orders ALTER COLUMN split_root_id SET NOT NULL;
CREATE INDEX idx_work_orders_split_root ON work_orders(split_root_id);
