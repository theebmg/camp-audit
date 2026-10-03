-- Mail log (Oct 2026).
--
-- A send that failed left one overwritten line in mail_settings.last_error and a toast. Ben
-- pressed Send twice and could not tell whether anything had happened. One row per attempt,
-- written as 'sending' before the message leaves and finished as 'sent' or 'failed', with the
-- plain-language reason and the raw one side by side.
BEGIN;

CREATE TABLE IF NOT EXISTS mail_log (
  id                   bigserial PRIMARY KEY,
  created_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  status               text NOT NULL DEFAULT 'sending',
  recipient            text,
  subject              text,
  context              text,
  sent_by              text,
  size_bytes           integer,
  error_message        text,
  error_detail         text,
  provider_message_id  text,
  CONSTRAINT mail_log_status_check CHECK (status IN ('sending', 'sent', 'failed'))
);

COMMENT ON TABLE mail_log IS
  'One row per outgoing email attempt. error_message is the wording shown to the user; '
  'error_detail is what the mail provider actually said.';

COMMIT;
