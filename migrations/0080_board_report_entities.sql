-- Board reports become entities: draft -> publish, with saved sends (Build Brief §3/§4).
--
-- Until now the board report was computed live from two query params and written
-- nowhere, which means every past report already shifted as work continued —
-- regenerating last month's numbers today gives different answers, because only the
-- completed section was ever period-bounded. Publishing freezes it.
--
-- Snapshots are STRUCTURED COLUMNS, not a JSON blob (§0): a published report has to
-- stay queryable — "what did we tell the board about Cabin 12 last spring" is a WHERE,
-- not a document search. The rendered HTML/text on a send is stored in addition to the
-- rows, never instead of them.

CREATE TABLE board_reports (
  id             serial PRIMARY KEY,
  title          text NOT NULL,                     -- "March 2026" or whatever Ben calls it
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  forward_start  date NOT NULL,
  forward_end    date NOT NULL,
  summary_notes  text,                              -- the narrative overview
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz
);
CREATE TRIGGER trg_board_reports_updated_at BEFORE UPDATE ON board_reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- One working draft at a time (§3). Enforced rather than assumed, so a second tab
-- can't quietly create a rival draft that then loses whichever was saved last.
CREATE UNIQUE INDEX idx_board_reports_one_draft ON board_reports((status)) WHERE status = 'draft';
CREATE INDEX idx_board_reports_published ON board_reports(published_at DESC) WHERE status = 'published';

CREATE TABLE board_report_items (
  id            serial PRIMARY KEY,
  report_id     integer NOT NULL REFERENCES board_reports(id) ON DELETE CASCADE,
  item_type     text NOT NULL CHECK (item_type IN
                  ('work_order','job_line','admin_task','calendar_event','condition_finding','projected_occurrence')),
  -- For projected_occurrence this is the calendar_event id; item_date disambiguates
  -- which occurrence, since the work order it will become doesn't exist yet.
  item_id       integer NOT NULL,
  item_date     date,
  section       text NOT NULL CHECK (section IN ('done','coming_up','overdue','admin_work')),
  -- Suggestions arrive pre-checked; unchecking is what makes inclusion explicit
  -- rather than a rule nobody can override.
  included      boolean NOT NULL DEFAULT true,
  -- Summary is the default for every work order, itemized is a deliberate choice (§6).
  display_mode  text NOT NULL DEFAULT 'summary' CHECK (display_mode IN ('summary','itemized')),
  -- Board-facing, deliberately separate from the WO's internal notes, which never
  -- leak into a report (§6).
  report_note   text,
  sort_index    integer NOT NULL DEFAULT 0,
  -- Frozen at publish so a published report renders identically months later.
  snap_title       text,
  snap_subtitle    text,
  snap_asset_name  text,
  snap_status      text,
  snap_date        date,
  snap_hours       numeric,
  snap_cost        numeric,
  snap_progress    text,     -- "6 of 18 tasks complete this period"
  UNIQUE (report_id, item_type, item_id, item_date)
);
CREATE INDEX idx_board_report_items_report ON board_report_items(report_id, section, sort_index);
CREATE INDEX idx_board_report_items_included ON board_report_items(report_id, included);

-- Counts, money, savings, backlog, visitor activity — the parts of the report with
-- nothing to check or uncheck. One row per figure rather than a blob, so a published
-- number stays as queryable as an included item.
CREATE TABLE board_report_aggregates (
  id            serial PRIMARY KEY,
  report_id     integer NOT NULL REFERENCES board_reports(id) ON DELETE CASCADE,
  group_key     text NOT NULL,      -- 'open_by_status', 'funding_totals', 'savings', ...
  label         text NOT NULL,
  value_numeric numeric,
  value_text    text,
  sort_index    integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_board_report_aggregates_report ON board_report_aggregates(report_id, group_key, sort_index);

-- Every send is kept, draft or published, exactly as it went out (§3). A corrected
-- version sent later adds a row; it never replaces one.
CREATE TABLE board_report_sends (
  id             serial PRIMARY KEY,
  report_id      integer NOT NULL REFERENCES board_reports(id) ON DELETE CASCADE,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  recipients     text NOT NULL,
  subject        text NOT NULL,
  was_draft      boolean NOT NULL,
  snapshot_html  text NOT NULL,
  snapshot_text  text NOT NULL,
  sent_by        text
);
CREATE INDEX idx_board_report_sends_report ON board_report_sends(report_id, sent_at DESC);
