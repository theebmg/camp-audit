-- Wires up building-type-driven question applicability (the actual point of
-- the form expansion per the migration brief) and seeds exactly ONE
-- illustrative applicability exclusion, so the filtering mechanism is
-- provably working end-to-end without this app fabricating Camp Sychar's real
-- building-type classifications or applicability rules — those are the
-- operator's domain knowledge to fill in (via NocoDB-as-viewer or SQL, no
-- deploy needed, once connected — see step 7 of the brief).
--
-- question_key here matches either an asset_property_fields.field_key (e.g.
-- 'has_key') or a component_type_catalog.component_type (e.g. 'Roof').

-- ILLUSTRATIVE EXAMPLE ONLY — remove or adjust once the operator reviews:
-- a Restroom/Shower building has no individually-held key, so "Has Key"
-- doesn't apply there. Proves the exclusion mechanism works; not a claim
-- about how Camp Sychar's restrooms are actually keyed.
INSERT INTO question_applicability (building_type_id, question_key, applies)
SELECT id, 'has_key', false FROM building_types WHERE name = 'Restroom/Shower';

-- Single, explicit test classification (not a bulk guess across all 337
-- assets — that's a real content decision for the operator). Ebenezer 22 is
-- the same asset already touched by the pg-migration audit-submit smoke test.
UPDATE assets SET building_type_id = (SELECT id FROM building_types WHERE name = 'Cabin')
WHERE nc_id = 74;
