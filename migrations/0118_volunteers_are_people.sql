-- Volunteers are people (Oct 2026).
--
-- `volunteers` was a second person list from before `people` existed: name, phone, email, skills.
-- The crew and job-line screens still read it. Rather than rewrite every one of those reads, the
-- table steps aside and a VIEW of the same name and shape takes its place, backed by people who
-- hold the Volunteer role. Every existing query keeps working; there is one person list.
--
-- Safe only because nothing is in it: the single row was test data, deleted with Ben's approval,
-- and neither join table has ever held a row. The migration refuses to run otherwise. The old
-- table is kept as volunteers_retired, not dropped.
BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM volunteers) > 0
     OR (SELECT count(*) FROM crew_session_volunteers) > 0
     OR (SELECT count(*) FROM job_line_volunteers) > 0 THEN
    RAISE EXCEPTION 'volunteers or its join tables are not empty — move those rows to people first';
  END IF;
END $$;

ALTER TABLE volunteers RENAME TO volunteers_retired;

-- volunteer_id now means people.id. No cascade: a person with crew history is not deletable by
-- accident, and a merge moves the history explicitly (PERSON_REFERENCES).
ALTER TABLE crew_session_volunteers DROP CONSTRAINT crew_session_volunteers_volunteer_id_fkey;
ALTER TABLE crew_session_volunteers ADD CONSTRAINT crew_session_volunteers_volunteer_id_fkey
  FOREIGN KEY (volunteer_id) REFERENCES people(id);
ALTER TABLE job_line_volunteers DROP CONSTRAINT job_line_volunteers_volunteer_id_fkey;
ALTER TABLE job_line_volunteers ADD CONSTRAINT job_line_volunteers_volunteer_id_fkey
  FOREIGN KEY (volunteer_id) REFERENCES people(id);

-- Everyone with the Volunteer role, plus anyone who has ever been on a crew — so history keeps
-- its names after someone stops volunteering. `active` is what the pickers filter on: only
-- current role-holders are offered.
CREATE VIEW volunteers AS
SELECT p.id, p.name, p.phone, p.email, NULL::text AS address,
       COALESCE(p.volunteer_skills, '{}') AS skill,
       (p.active AND r.person_id IS NOT NULL) AS active,
       p.volunteer_notes AS notes, p.created_at, p.updated_at
FROM people p
LEFT JOIN (
  SELECT DISTINCT a.person_id FROM person_role_assignments a
  JOIN person_roles pr ON pr.id = a.role_id WHERE pr.name = 'Volunteer'
) r ON r.person_id = p.id
WHERE r.person_id IS NOT NULL
   OR EXISTS (SELECT 1 FROM crew_session_volunteers c WHERE c.volunteer_id = p.id)
   OR EXISTS (SELECT 1 FROM job_line_volunteers j WHERE j.volunteer_id = p.id);

COMMIT;
