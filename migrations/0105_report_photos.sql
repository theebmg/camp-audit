-- Photos on the board report (Oct 2026 brief, Part 2A and 2C).

-- Which photos go with this report, and where they sit.
CREATE TABLE board_report_photos (
  id            serial PRIMARY KEY,
  report_id     integer NOT NULL REFERENCES board_reports(id) ON DELETE CASCADE,
  attachment_id integer NOT NULL REFERENCES attachments(id)   ON DELETE CASCADE,
  -- The report row this photo belongs under. NULL means a report-level photo — a general
  -- progress shot that is not about one particular job (§2A).
  item_id       integer REFERENCES board_report_items(id) ON DELETE CASCADE,
  included      boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  -- What the label said when the report was sent. Stamped like every other snap_ field, so a
  -- published report keeps the caption it went out with even if the work order is renamed.
  snap_label    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, attachment_id)
);
CREATE INDEX idx_board_report_photos_report ON board_report_photos (report_id, sort_order);
CREATE INDEX idx_board_report_photos_item ON board_report_photos (item_id) WHERE item_id IS NOT NULL;

-- The label prefix comes from the role vocabulary rather than from hardcoded strings (§2C), so
-- renaming a role or adding one is an admin job and not a code change. NULL means the photo is
-- captioned with its description alone — which is what a Reference or a Spec should do.
ALTER TABLE attachment_roles ADD COLUMN report_label_prefix text;

UPDATE attachment_roles SET report_label_prefix = 'BEFORE' WHERE name = 'Before / Condition';
UPDATE attachment_roles SET report_label_prefix = 'AFTER'  WHERE name = 'After / Repair';
UPDATE attachment_roles SET report_label_prefix = 'DURING' WHERE name = 'During';

-- Ordering for the before → during → after run in the email. Roles without a prefix sort last.
ALTER TABLE attachment_roles ADD COLUMN report_stage_order integer;
UPDATE attachment_roles SET report_stage_order = 1 WHERE name = 'Before / Condition';
UPDATE attachment_roles SET report_stage_order = 2 WHERE name = 'During';
UPDATE attachment_roles SET report_stage_order = 3 WHERE name = 'After / Repair';

-- A configurable email budget, so the warning threshold is not buried in code (§2B).
ALTER TABLE display_settings ADD COLUMN report_email_budget_mb integer NOT NULL DEFAULT 15;
