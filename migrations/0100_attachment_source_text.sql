-- A photo can arrive by text (text-intake brief §3), and attachments.source only allowed
-- 'upload', 'email' and 'field'. Every texted photo was fetched, resized and uploaded to
-- storage, then rejected at the final INSERT — and ingestMedia's catch logged a warning and
-- carried on, so the text landed with no photo and no error anyone would see.
--
-- This is the sibling of 0098, which widened expenses.source for the same reason. I fixed that
-- one when a test caught it and did not think to check this one.
--
-- Widened rather than dropped: the point of the constraint is that source is a known set.
ALTER TABLE attachments DROP CONSTRAINT attachments_source_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_source_check
  CHECK (source IN ('upload', 'email', 'field', 'text'));

-- And somewhere to record that a photo did not come through, so the Incoming screen can say so
-- instead of showing what looks like an ordinary text with no picture.
ALTER TABLE incoming_items
  ADD COLUMN media_expected integer NOT NULL DEFAULT 0,
  ADD COLUMN media_error    text;
