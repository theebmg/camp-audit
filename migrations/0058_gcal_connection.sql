-- Google Calendar connection state (Build Brief v4 Part 1, step 2 of 4) —
-- one row, same singleton pattern as display_settings/budget_settings.
-- Holds what the OAuth admin screen shows (connection status, connected
-- account, target calendar) and what the sync worker (step 3) will need to
-- make authenticated Calendar API calls. The refresh token lives here, not
-- .env, because it's obtained at runtime via the consent flow, not
-- configured at deploy (brief §1.7).
CREATE TABLE gcal_connection (
  id             serial PRIMARY KEY,
  refresh_token  text,
  google_email   text,
  calendar_id    text,
  connected_at   timestamptz,
  connected_by   text
);
INSERT INTO gcal_connection (id) VALUES (default);
