-- Phase 1 (1.2/1.3): responsible_self was a single boolean on work_orders —
-- yes/no self, with volunteer/vendor tracked separately via the junction
-- tables. That can't express "self did the demo, a vendor did the roof" on
-- one WO. responsibility_class replaces it at the line level, as one of four
-- mutually exclusive values per line. cabin_holder is a first-class value
-- (not just a funding source) because cabin holders frequently do the work
-- themselves for their own cabin, not just pay for it.
ALTER TABLE job_lines
  ADD COLUMN responsibility_class text NOT NULL DEFAULT 'self'
    CHECK (responsibility_class IN ('self','volunteer','vendor','cabin_holder'));

ALTER TABLE work_orders DROP COLUMN responsible_self;
