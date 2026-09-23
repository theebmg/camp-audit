-- Distinguish "suggested and left alone" from "the user decided something"
-- (Build Brief §5/§6, phase 6).
--
-- Narrowing a draft's period leaves behind items suggested under the old window. They
-- should go — but not the ones carrying a judgment. Unchecking a line, writing a board
-- note on it, or switching a work order to itemized are all decisions, and a date
-- change quietly discarding them would be the worst kind of data loss: silent, and
-- only noticed when the report prints wrong.
--
-- Inferring "touched" from the values (included = false, note not null, mode <>
-- summary) nearly works, but a user who unchecks and re-checks a row is back to
-- looking untouched while having very much decided. An explicit flag, set by the
-- PATCH endpoints, doesn't have that hole.
ALTER TABLE board_report_items
  ADD COLUMN user_touched boolean NOT NULL DEFAULT false;

-- When a row was last produced by a suggestion pass. A pass stamps every row it
-- touches; anything left with an older stamp is no longer suggested by the current
-- period and, if untouched, can go.
ALTER TABLE board_report_items
  ADD COLUMN suggested_at timestamptz NOT NULL DEFAULT now();

-- A job line's work order, frozen with the rest of the snapshot. The renderer needs it
-- to decide whether a line is swallowed by its work order's summary row, and looking it
-- up live would break the moment a line moved between work orders after publish.
ALTER TABLE board_report_items
  ADD COLUMN parent_work_order_id integer;
