-- Stop the suggestion refresh from pruning rows it just wrote.
--
-- The prune compared board_report_items.suggested_at (set by the DATABASE) against a
-- passStartedAt captured in JAVASCRIPT. Two clocks, sub-second precision, and now() is
-- frozen to transaction start — so rows written by a pass could carry a timestamp
-- EARLIER than the moment the pass claimed to begin, and the prune deleted them.
--
-- Live symptom: refreshing a draft alternated between emptying it (17 rows pruned) and
-- refilling it. The two surviving rows both happened to be user_touched.
--
-- A timestamp is the wrong tool for "did this pass touch this row". A pass token is
-- exact: each refresh mints an id, every row it writes carries that id, and the prune
-- removes rows carrying a DIFFERENT id. No clocks, no precision, nothing to skew.
ALTER TABLE board_report_items ADD COLUMN last_pass_id text;

-- Existing rows get a token so the first refresh after this deploy doesn't treat every
-- one of them as stale and delete them.
UPDATE board_report_items SET last_pass_id = 'pre-0093' WHERE last_pass_id IS NULL;
