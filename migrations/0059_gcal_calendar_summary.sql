-- Manual calendar selection (Build Brief v4 Part 1, revised 2026-09-14):
-- Ben wants to pick which calendar sync writes to — including one he's
-- already made himself and shared in from the camp Google account — rather
-- than always auto-creating "Camp Work" during the OAuth callback. Calendar
-- choice now happens as its own step after connecting (see
-- saveGcalCalendar in db.js), so the admin screen needs the chosen
-- calendar's display name on hand without an extra live API call every
-- time it renders.
ALTER TABLE gcal_connection ADD COLUMN calendar_summary text;
