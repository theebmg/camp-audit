-- Email-sourced expenses now default purchase_date to the day the message
-- arrived at receipts@ (camp-local), see createReceiptInboundBatch. Backfill
-- the existing email rows that were left blank because the body parse found
-- no date — rows that already have a date (parsed or set at triage) are left
-- alone.
UPDATE expenses e
   SET purchase_date = (b.received_at AT TIME ZONE 'America/New_York')::date
  FROM attachment_batches b
 WHERE e.batch_id = b.id
   AND e.source = 'email'
   AND e.purchase_date IS NULL;
