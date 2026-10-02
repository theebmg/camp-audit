-- Gmail OAuth credentials (Oct 2026).
--
-- Google requires OAuth for Workspace accounts — app passwords are no longer available — and a
-- refresh token is not like the other secrets in .env: it is obtained by a browser consent flow,
-- it can be revoked from the Google side, and it may need re-granting without a deploy. So it
-- lives in the database, written by the callback route, rather than in a file somebody has to
-- hand-edit over SSH.
--
-- GMAIL_OAUTH_REFRESH_TOKEN in the environment still wins if set, so nothing that already works
-- changes.
BEGIN;

CREATE TABLE IF NOT EXISTS mail_settings (
  id                   integer PRIMARY KEY DEFAULT 1,
  oauth_user           text,
  oauth_refresh_token  text,
  connected_at         timestamptz,
  connected_by         text,
  last_error           text,
  CONSTRAINT mail_settings_single_row CHECK (id = 1)
);

INSERT INTO mail_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE mail_settings IS
  'Gmail OAuth for sending. One row. The refresh token is a credential: never log it, never '
  'return it over the API — only whether it is present.';

COMMIT;
