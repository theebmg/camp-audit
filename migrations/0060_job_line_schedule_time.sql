-- Times on scheduled work (Build Brief v4 Part 1, addition before step 3
-- ships): job_lines.scheduled_date is a bare date, so Google Calendar sync
-- had no time to offer beyond an all-day event. Both new columns are
-- optional and travel together — a line with a date but no start_time
-- stays an all-day event on sync (plenty of work is genuinely "sometime
-- Tuesday," and the sync shouldn't invent a time for it); a line with both
-- set syncs as a timed event. Duration (not an end_time column) to match
-- how this table already expresses time spent — estimated_hours/
-- actual_hours are both decimal hours, not a start/end pair.
ALTER TABLE job_lines
  ADD COLUMN scheduled_start_time      time,
  ADD COLUMN scheduled_duration_hours  numeric;
