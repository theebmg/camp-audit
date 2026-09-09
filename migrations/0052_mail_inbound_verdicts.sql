-- Build Brief v2.1 Part 1: IMAP polling is replaced by a Mailgun inbound
-- webhook (photos@cmms.fracturedrv.com). Mailgun computes SPF/DKIM verdicts
-- for the sender before it ever reaches us, so capture them now even though
-- nothing gates on them today — the mailbox stays deliberately open. Cheap
-- to store, and it's what a whitelist or spam gate would key off later
-- without needing a backfill (there's no way to recover a verdict after the
-- fact once the batch has been ingested).
ALTER TABLE attachment_batches
  ADD COLUMN spf_result  text,
  ADD COLUMN dkim_result text;
