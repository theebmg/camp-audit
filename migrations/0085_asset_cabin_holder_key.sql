-- A real foreign key from assets to cabin_holders (open-questions Q2).
--
-- The relationship has been a case-insensitive text match this whole time:
--   LEFT JOIN assets a ON lower(trim(a.lodge_holder)) = lower(ch.name)
-- It works on today's data — 174 of 174 assets with a lodge_holder match a
-- cabin_holders row — and it is one rename away from silently breaking, with nothing
-- enforcing it. cabin_holders is confirmed the same entity the funding picker uses
-- (funding_source 'cabin_holder' → funding_ref_id → cabin_holders), so the key points
-- at the record funding already references rather than a parallel one.
--
-- lodge_holder is KEPT and untouched. The key is backfilled beside it, and reads move
-- over only once it's verified — a rename that breaks the text match would otherwise
-- take the display name with it before anyone noticed.
--
-- Backfill rule: exactly ONE matching holder, or nothing. A name matching two holders
-- is ambiguous and guessing which is meant would quietly attach a cabin to the wrong
-- person; those are left NULL and reported instead.

ALTER TABLE assets
  ADD COLUMN cabin_holder_id integer REFERENCES cabin_holders(id) ON DELETE SET NULL;
CREATE INDEX idx_assets_cabin_holder ON assets(cabin_holder_id);

UPDATE assets a
SET cabin_holder_id = m.holder_id
FROM (
  SELECT a2.id AS asset_id, min(ch.id) AS holder_id
  FROM assets a2
  JOIN cabin_holders ch
    ON lower(trim(ch.name)) = lower(trim(a2.lodge_holder))
  WHERE a2.lodge_holder IS NOT NULL AND trim(a2.lodge_holder) <> ''
  GROUP BY a2.id
  HAVING count(ch.id) = 1          -- exactly one match, never a guess
) m
WHERE a.id = m.asset_id;
