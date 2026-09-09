-- Build Brief v2, Phase 4 (attachments) needs this table to exist now because
-- attachments.batch_id (0046) references it — even though nothing populates a
-- batch until Phase 5's email ingest lands. Schema only, brought forward from
-- the brief's own §5.1 definition so the FK in this phase's migration is
-- valid; Phase 5 adds the ingest code that actually writes rows here.
CREATE TABLE attachment_batches (
  id           serial PRIMARY KEY,
  source       text NOT NULL,   -- 'email' | 'upload'
  subject      text,
  body_text    text,
  sender_email text,
  message_id   text UNIQUE,     -- idempotency guard for IMAP polling (Phase 5)
  received_at  timestamptz NOT NULL DEFAULT now(),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
