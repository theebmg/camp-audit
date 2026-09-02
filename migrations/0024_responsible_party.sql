-- Who's actually going to do the work. Volunteer/Vendor are already
-- inferable from the work_order_volunteers/work_order_vendors junction
-- tables (a row there means "assigned"); only "Self" needs new storage
-- since there's no camp-staff entity to join against. The three are not
-- mutually exclusive — a job can be both Self (you schedule/oversee) and
-- Vendor (they perform it).
ALTER TABLE work_orders ADD COLUMN responsible_self boolean NOT NULL DEFAULT false;
