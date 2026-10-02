-- Which approved funds this report shows (Oct 2026).
--
-- Absence of a row means SHOWN: a fund with activity appears unless it has been explicitly
-- hidden on this report. That way a fund that starts seeing spend next month turns up on its
-- own, rather than staying invisible because nobody knew to tick it.
--
-- Hiding a fund affects the Approved Funds block only. Line-level funding tags always print —
-- what paid for a job is part of the work, not a presentation choice.
BEGIN;

CREATE TABLE IF NOT EXISTS board_report_funds (
  report_id  integer NOT NULL REFERENCES board_reports(id) ON DELETE CASCADE,
  fund_id    integer NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  included   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (report_id, fund_id)
);

COMMENT ON TABLE board_report_funds IS
  'Per-report show/hide for the Approved Funds block. No row = shown, when the fund has activity.';

COMMIT;
