-- Second half of 0036 — see that file's comment. Blocked until an operator
-- with DB-superuser access runs, once, against the `camp` database:
--
--   ALTER TABLE work_order_log_entries OWNER TO camp_app;
--
-- (work_order_log_entries is currently owned by role `nocodb`, not
-- `camp_app`, from some earlier migration run — every other table in this
-- schema is camp_app-owned. camp_app has no privilege path to fix this
-- itself: it isn't a member of the `nocodb` role and ALTER TABLE OWNER
-- requires ownership or superuser, not just GRANTed privileges.) Once that
-- ownership fix has been run by hand, `npm run migrate` picks this file up
-- normally.
ALTER TABLE work_order_log_entries ADD COLUMN job_line_id integer REFERENCES job_lines(id) ON DELETE SET NULL;
CREATE INDEX idx_wo_log_entries_job_line ON work_order_log_entries(job_line_id);
