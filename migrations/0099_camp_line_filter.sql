-- Which line a text came in ON (text-intake brief follow-up).
--
-- The camp line and Ben's Fractured RV business line live in the same Quo workspace, and the
-- API key can see both. Scoping the webhook to the camp number is the first line of defence;
-- this is the second, because a webhook can be re-registered or re-scoped in the Quo app
-- without anyone touching this system.
--
-- Fails closed: with no camp line configured, nothing is processed at all — the same rule the
-- sender allowlist already follows.
ALTER TABLE text_intake_settings
  -- The provider's id for the camp line (e.g. a Quo phone-number id). Deliberately opaque
  -- text, not a phone number: it is whatever the provider calls the line.
  ADD COLUMN camp_line_id     text,
  -- The camp line's number, for display and for providers that only report the number.
  ADD COLUMN camp_line_number text,
  -- Counter for debugging, content never stored — same treatment as an unknown sender.
  ADD COLUMN wrong_line_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_wrong_line_at timestamptz;

-- Which line an item arrived on, so a mis-scoped webhook is visible after the fact rather
-- than only in a counter.
ALTER TABLE incoming_items ADD COLUMN to_line text;
