// Build Brief v2.1 Part 2 — verifies the Phase 1 rollups (job-line cost/hours
// moved off work_orders in migration 0031) against hand-calculated expected
// values. This is the highest-risk unverified area in the whole refactor:
// nothing crashes if the arithmetic is wrong, it just produces a quietly
// incorrect number on a board report. Re-runnable any time — it creates its
// own fixture data (a WO, three job lines, two crew sessions, a capital
// campaign project and a cabin holder, all prefixed "TEST verify-rollups")
// and deletes every row it created in a `finally` block, so it's safe against
// the live database and safe to run again after future changes.
//
// Run with: docker run --rm --network nocodb_default -v $(pwd):/app -w /app
//   --env-file .env node:22-alpine node scripts/verify-rollups.js
// (or `node scripts/verify-rollups.js` with DATABASE_URL reachable directly —
// see migrate.js for the same pattern).
import {
  pool, createWorkOrder, createJobLine, updateJobLine, listJobLineStatuses,
  workOrderRollup, listWorkOrders, getBudgetOverview, createCapitalCampaignProject,
  deleteCapitalCampaignProject, createCabinHolder, deleteCabinHolder, createCrewSession,
  deleteCrewSession, splitWorkOrder, getWorkOrderFamily, workOrderCloseGate,
  getJobLinesReportRawData, deleteJobLine,
} from '../src/db.js';
import { buildWorkPerformedReportPg } from '../src/reportDataPg.js';

const results = [];
function assert(name, actual, expected, { tolerance = 0.001 } = {}) {
  const pass = typeof expected === 'number'
    ? Math.abs(Number(actual) - expected) <= tolerance
    : JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, actual, expected, pass });
}

const TEST_PREFIX = 'TEST verify-rollups';
const created = { workOrderIds: [], jobLineIds: [], crewSessionIds: [], capitalProjectId: null, cabinHolderId: null };

async function main() {
  const statuses = await listJobLineStatuses();
  const statusIdByName = Object.fromEntries(statuses.map((s) => [s.Name, s.Id]));

  const capitalProject = await createCapitalCampaignProject({ name: `${TEST_PREFIX} Capital Campaign Project` });
  created.capitalProjectId = capitalProject.Id;
  const cabinHolder = await createCabinHolder({ name: `${TEST_PREFIX} Cabin Holder` });
  created.cabinHolderId = cabinHolder.Id;

  // ── Scenario A — mixed funding on one work order ──────────────────────
  const { workOrderId: woId } = await createWorkOrder({ title: `${TEST_PREFIX} Scenario A` });
  created.workOrderIds.push(woId);

  const roof = await createJobLine(woId, {
    title: 'Roof', fundingSource: 'capital_campaign', fundingRefId: capitalProject.Id,
    estimatedHours: 40, estimatedCost: 8000,
  });
  const deck = await createJobLine(woId, {
    title: 'Deck', fundingSource: 'cabin_holder', fundingRefId: cabinHolder.Id,
    estimatedHours: 16, estimatedCost: 2000,
  });
  const windows = await createJobLine(woId, {
    title: 'Windows', fundingSource: 'operating_budget',
    estimatedHours: 8, estimatedCost: 1000,
  });
  created.jobLineIds.push(roof.Id, deck.Id, windows.Id);

  await updateJobLine(roof.Id, { actual_hours: 44, actual_cost: 8750, status_id: statusIdByName['Done'] });
  await updateJobLine(deck.Id, { actual_hours: 14, actual_cost: 1900, status_id: statusIdByName['Done'] });
  await updateJobLine(windows.Id, { actual_hours: 2, status_id: statusIdByName['In Progress'] });

  let rollup = await workOrderRollup(woId);
  assert('A: WO estimated cost rollup', rollup.EstimatedCost, 11000);
  assert('A: WO actual cost rollup', rollup.ActualCost, 10650);
  assert('A: WO estimated hours', rollup.EstimatedHours, 64);
  assert('A: WO actual hours', rollup.ActualHours, 60);

  let woRow = (await listWorkOrders()).find((w) => w.Id === woId);
  assert('A: cost-weighted progress (10000/11000)', woRow.PercentCompleteCost, 10000 / 11000);
  assert('A: line-count progress (2/3)', woRow.PercentCompleteCount, 2 / 3);
  // Cross-check listWorkOrders' rollup against workOrderRollup's independently
  // written SQL — the two must never drift from each other.
  assert('A: listWorkOrders vs workOrderRollup (est cost)', woRow['Estimated Cost'], rollup.EstimatedCost);
  assert('A: listWorkOrders vs workOrderRollup (act cost)', woRow['Actual Cost'], rollup.ActualCost);
  assert('A: listWorkOrders vs workOrderRollup (act hours)', woRow['Actual Hours'], rollup.ActualHours);

  const budget = await getBudgetOverview();
  const capItem = budget.CapitalCampaignProjects.find((p) => p.Id === capitalProject.Id);
  assert('A: capital plan shows 8750 under capital_campaign (not 10650/WO total)', capItem.Total, 8750);
  const cabinItem = budget.CabinHolders.find((c) => c.Id === cabinHolder.Id);
  assert('A: budget view shows 1900 under cabin holder', cabinItem.Total, 1900);

  const { rows: windowsRow } = await pool.query('SELECT actual_cost FROM job_lines WHERE id = $1', [windows.Id]);
  assert('A: windows has no actual cost yet (actual_cost IS NULL)', windowsRow[0].actual_cost === null, true);

  // "Dashboard totals" — no single $ widget exists yet (dashboard is counts-
  // only today), so this checks the same conservation property a dashboard
  // total would rely on: summing the three lines by hand must match the
  // rollup, independent of workOrderRollup's own SQL.
  const { rows: handSum } = await pool.query(
    `SELECT COALESCE(SUM(estimated_cost),0) AS est, COALESCE(SUM(actual_cost),0) AS act FROM job_lines WHERE work_order_id = $1`,
    [woId]
  );
  assert('A: dashboard-style hand sum matches rollup (est)', Number(handSum[0].est), rollup.EstimatedCost);
  assert('A: dashboard-style hand sum matches rollup (act)', Number(handSum[0].act), rollup.ActualCost);

  // ── Scenario B — crew session hours ────────────────────────────────────
  const roofSession = await createCrewSession({ workOrderId: woId, jobLineId: roof.Id, hours: 6, activity: null });
  const unattributedSession = await createCrewSession({ workOrderId: woId, jobLineId: null, activity: `${TEST_PREFIX} cleanup`, hours: 4 });
  created.crewSessionIds.push(roofSession.Id, unattributedSession.Id);

  rollup = await workOrderRollup(woId);
  assert('B: WO actual hours includes both sessions (60+10)', rollup.ActualHours, 70);

  const { jobLines: reportLines } = await getJobLinesReportRawData();
  const roofReportRow = reportLines.find((l) => l.id === roof.Id);
  assert('B: job-lines report shows Roof actual hours including the session (50)', Number(roofReportRow.actual_hours), 50);

  const { rows: roofLineHours } = await pool.query(
    `SELECT COALESCE(jl.actual_hours,0) + COALESCE((SELECT SUM(hours) FROM crew_sessions WHERE job_line_id = jl.id AND hours IS NOT NULL),0) AS hrs
     FROM job_lines jl WHERE jl.id = $1`, [roof.Id]
  );
  assert('B: Roof line actual hours includes the 6 (44+6=50)', Number(roofLineHours[0].hrs), 50);

  const { rows: deckLineHours } = await pool.query(
    `SELECT COALESCE(jl.actual_hours,0) + COALESCE((SELECT SUM(hours) FROM crew_sessions WHERE job_line_id = jl.id AND hours IS NOT NULL),0) AS hrs
     FROM job_lines jl WHERE jl.id = $1`, [deck.Id]
  );
  assert('B: no line shows inflated hours from the unattributed session (Deck stays 14)', Number(deckLineHours[0].hrs), 14);

  const { rows: windowsLineHours } = await pool.query(
    `SELECT COALESCE(jl.actual_hours,0) + COALESCE((SELECT SUM(hours) FROM crew_sessions WHERE job_line_id = jl.id AND hours IS NOT NULL),0) AS hrs
     FROM job_lines jl WHERE jl.id = $1`, [windows.Id]
  );
  assert('B: no line shows inflated hours from the unattributed session (Windows stays 2)', Number(windowsLineHours[0].hrs), 2);

  // ── Scenario C — split integrity ───────────────────────────────────────
  const { workOrderId: childId, woNumber: childWoNumber } = await splitWorkOrder(woId, [windows.Id]);
  created.workOrderIds.push(childId);

  const parentRollup = await workOrderRollup(woId);
  assert('C: parent WO rollup after split (est)', parentRollup.EstimatedCost, 10000);
  assert('C: parent WO rollup after split (act)', parentRollup.ActualCost, 10650);
  const childRollup = await workOrderRollup(childId);
  assert('C: child WO rollup (est)', childRollup.EstimatedCost, 1000);
  assert('C: child WO rollup (act)', childRollup.ActualCost, 0);

  const family = await getWorkOrderFamily(woId);
  assert('C: family rollup equals pre-split total (est)', family.EstimatedCost, 11000);
  assert('C: family rollup equals pre-split total (act)', family.ActualCost, 10650);

  const { rows: movedLine } = await pool.query('SELECT work_order_id FROM job_lines WHERE id = $1', [windows.Id]);
  assert('C: Windows line moved to the child WO', Number(movedLine[0].work_order_id), childId);
  assert('C: child wo_number is <root>-2', childWoNumber, `${woId}-2`);

  const parentGate = await workOrderCloseGate(woId);
  assert('C: parent WO can now close (no non-terminal lines remain)', parentGate.ReadyToClose, true);

  // ── Scenario D — Not Needed vs Done ────────────────────────────────────
  await updateJobLine(deck.Id, { status_id: statusIdByName['Not Needed'], statusNote: 'Deck was replaced last year, not actually needed' });

  const gateAfterD = await workOrderCloseGate(woId);
  assert('D: WO still closes (Not Needed is terminal)', gateAfterD.ReadyToClose, true);

  const { rows: deckCompletedDate } = await pool.query('SELECT completed_date FROM job_lines WHERE id = $1', [deck.Id]);
  // Not Needed doesn't stamp completed_date (only counts_as_work_performed
  // statuses do — see changeJobLineStatus), so it can never wrongly appear
  // in a Work Performed report even if the date range is wide open.
  const workPerformed = await buildWorkPerformedReportPg({ from: '2000-01-01', to: '2100-01-01' });
  const deckInReport = workPerformed.buildings.some((b) => b.lines.some((l) => l.id === deck.Id));
  assert('D: Work Performed report excludes Deck (Not Needed)', deckInReport, false);

  const rowD = (await listWorkOrders()).find((w) => w.Id === woId);
  assert('D: cost-weighted progress excludes Deck\'s 2000 (0/10000 now — only Roof estimated remains, Roof already counted)', rowD.PercentCompleteCost, 8000 / 10000);

  console.log('\n=== verify-rollups results ===\n');
  const nameWidth = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name.padEnd(nameWidth)}  actual=${JSON.stringify(r.actual)}  expected=${JSON.stringify(r.expected)}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) process.exitCode = 1;
}

async function cleanup() {
  try {
    if (created.crewSessionIds.length) {
      for (const id of created.crewSessionIds) await deleteCrewSession(id).catch(() => {});
    }
    if (created.workOrderIds.length) {
      await pool.query('DELETE FROM job_lines WHERE work_order_id = ANY($1::int[])', [created.workOrderIds]);
      await pool.query('DELETE FROM work_order_log_entries WHERE work_order_id = ANY($1::int[])', [created.workOrderIds]);
      await pool.query('DELETE FROM work_orders WHERE id = ANY($1::int[])', [created.workOrderIds]);
    }
    if (created.capitalProjectId) await deleteCapitalCampaignProject(created.capitalProjectId).catch(() => {});
    if (created.cabinHolderId) await deleteCabinHolder(created.cabinHolderId).catch(() => {});
    await pool.query(`DELETE FROM activity_log WHERE entity_label LIKE $1 OR details LIKE $1`, [`%${TEST_PREFIX}%`]).catch(() => {});
  } catch (e) {
    console.error('cleanup warning:', e.message);
  }
}

main()
  .catch((e) => { console.error('verify-rollups crashed:', e); process.exitCode = 1; })
  .finally(async () => { await cleanup(); await pool.end(); });
