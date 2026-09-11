-- Follow-up to 0053: job_line_templates.default_funding_source has the same
-- CHECK-enum shape as job_lines.funding_source and needs the same 'fund'
-- value — the template admin form (Default Funding Source dropdown) reads
-- FUNDING_SOURCE_LABELS, which now includes 'fund', so saving a template
-- with it selected would otherwise fail this constraint.
ALTER TABLE job_line_templates DROP CONSTRAINT job_line_templates_default_funding_source_check;
ALTER TABLE job_line_templates ADD CONSTRAINT job_line_templates_default_funding_source_check
  CHECK (default_funding_source IN ('operating_budget','capital_campaign','cabin_holder','other','fund'));
