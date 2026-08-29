-- Cabin-holders were only ever created lazily (one at a time, when a WO got
-- tagged), so the roster was incomplete and looked hand-entered. A name is
-- the natural identity here — a person can hold more than one cabin, and
-- their WO costs should roll up under one holder regardless of which asset
-- prompted the tag — so make it unique and let db.js sync the full roster
-- from assets.lodge_holder on read (see syncCabinHoldersFromAssets).
ALTER TABLE cabin_holders ADD CONSTRAINT cabin_holders_name_key UNIQUE (name);
