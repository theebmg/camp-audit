-- Phase 1 (1.2): "assigned crew" moves from the work order to the job line —
-- same reasoning as funding: a vendor is on the roof line, volunteers are on
-- the deck line, same WO. Identical shape to the junctions they replace.
CREATE TABLE job_line_volunteers (
  job_line_id   integer NOT NULL REFERENCES job_lines(id) ON DELETE CASCADE,
  volunteer_id  integer NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
  PRIMARY KEY (job_line_id, volunteer_id)
);

CREATE TABLE job_line_vendors (
  job_line_id  integer NOT NULL REFERENCES job_lines(id) ON DELETE CASCADE,
  vendor_id    integer NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  PRIMARY KEY (job_line_id, vendor_id)
);

DROP TABLE work_order_volunteers;
DROP TABLE work_order_vendors;
