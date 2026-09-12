-- Expenses HTML email viewer (Ben's request, 2026-09-12): Mailgun already
-- sends body-html alongside body-plain on every inbound message, but only
-- body-plain was ever stored. Vendor receipt emails (Amazon/Home Depot/etc.)
-- are designed for HTML rendering — line-item tables, formatted totals — and
-- the plain-text alternate part these vendors generate is frequently mangled
-- (see expenseParsing.js's CURRENCY_RE comment: Amazon's plain-text part
-- drops the decimal point out of prices rendered via a dollars/cents span
-- split in the source HTML, e.g. "$47.16" -> "4716"). Storing body-html lets
-- the expense detail view show the email as it was actually designed to look.
ALTER TABLE attachment_batches ADD COLUMN body_html text;
