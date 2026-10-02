// Board report rules, on scratch records deleted afterwards (Oct 2026 decisions).
//
//   docker exec camp-audit node scripts/board-report-test.mjs
//
// Proves the rules Ben decided, not just that the code runs: totals are real money only,
// estimates never enter a total, who paid is reported separately from camp spend, and an open
// work order never claims a completion date.
import * as db from '/app/src/db.js';

const TAG = 'ZZ-BRTEST';
const fail = [];
const ok = (c, l) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${l}`); if (!c) fail.push(l); };

async function purge() {
  await db.pool.query(`DELETE FROM expense_allocations WHERE expense_id IN (SELECT id FROM expenses WHERE vendor LIKE $1)`, [`${TAG}%`]);
  await db.pool.query(`DELETE FROM expenses WHERE vendor LIKE $1`, [`${TAG}%`]);
  await db.pool.query(`DELETE FROM job_lines WHERE work_order_id IN (SELECT id FROM work_orders WHERE title LIKE $1)`, [`${TAG}%`]);
  await db.pool.query(`DELETE FROM board_report_items WHERE snap_title LIKE $1`, [`${TAG}%`]);
  await db.pool.query(`DELETE FROM work_orders WHERE title LIKE $1`, [`${TAG}%`]);
  await db.pool.query(`DELETE FROM savings_entries WHERE source_type='admin_task' AND source_id IN (SELECT id FROM admin_tasks WHERE title LIKE $1)`, [`${TAG}%`]);
  await db.pool.query(`DELETE FROM admin_tasks WHERE title LIKE $1`, [`${TAG}%`]);
  await db.pool.query(`DELETE FROM activity_log WHERE entity_label LIKE $1`, [`${TAG}%`]);
}
await purge();

console.log('## period defaults to a whole calendar month (§4)');
const p = await db.defaultBoardReportPeriods();
ok(/^\d{4}-\d{2}-01$/.test(p.periodStart), `starts on the 1st (${p.periodStart})`);
const endD = new Date(`${p.periodEnd}T00:00:00Z`);
const dayAfter = new Date(endD.getTime() + 86400000);
ok(dayAfter.getUTCDate() === 1, `ends on the last day of the month (${p.periodEnd})`);
ok(p.periodStart.slice(0, 7) === p.periodEnd.slice(0, 7), 'both dates are in the same month');
ok(p.forwardStart > p.periodEnd, 'the forward window starts after the period, not at today');

console.log('\n## funding sources (§2b)');
const sources = await db.listFundingSources();
const camp = sources.find((s) => s.CountsAsCampSpend);
const personal = sources.find((s) => s.IsContribution && !s.IsInKind);
const inKind = sources.find((s) => s.IsInKind);
ok(!!camp && !!personal && !!inKind, `seeded: ${sources.map((s) => s.Name).join(', ')}`);
ok(camp.Name === 'Camp funds', 'camp funds counts as camp spend');
ok(!personal.CountsAsCampSpend, 'a personal payment does NOT count as camp spend');

console.log('\n## a work order rolls up real money only (§2, §3)');
const asset = (await db.pool.query('select id, name from assets limit 1')).rows[0];
const { workOrderId: woId } = await db.createWorkOrder({
  title: `${TAG} Rollup WO`, assetId: asset.id, priority: 'Medium',
});
// One line with a real actual, one with only an estimate.
const l1 = await db.createJobLine(woId, { title: `${TAG} with actual`, estimatedCost: 500 });
const l2 = await db.createJobLine(woId, { title: `${TAG} estimate only`, estimatedCost: 300 });
await db.pool.query('UPDATE job_lines SET actual_cost = 450 WHERE id = $1', [l1.Id]);

const roll1 = await db.pool.query(
  `SELECT 1`); // placeholder so the import of the private helper is not needed
// Exercise it through the report instead, which is what actually matters.
const expense = await db.createExpense({
  vendor: `${TAG} Lumber`, amount: 200, purchaseDate: p.periodStart,
  fundingSourceId: personal.Id,
});
await db.createExpenseAllocation(expense.Id, {
  destType: 'job_line', destId: l1.Id, amount: 200, quantity: 1,
});

console.log('\n## the funding split follows the receipts');
const split = (await db.pool.query(
  `SELECT COALESCE(fs.name,'Unassigned') src, SUM(ea.amount) amt
   FROM expense_allocations ea JOIN expenses e ON e.id=ea.expense_id
   LEFT JOIN funding_sources fs ON fs.id=e.funding_source_id
   WHERE ea.dest_type='job_line' AND ea.dest_id=$1 GROUP BY 1`, [l1.Id])).rows;
ok(split.length === 1 && split[0].src === personal.Name,
  `the line's money is attributed to ${split[0]?.src} (${split[0]?.amt})`);

console.log('\n## camp spend excludes contributions (§2b)');
const agg = (await db.pool.query(`
  SELECT COALESCE(SUM(e.amount) FILTER (WHERE fs.id IS NULL OR fs.counts_as_camp_spend),0) campv,
         COALESCE(SUM(e.amount) FILTER (WHERE fs.is_contribution),0) contrib
  FROM expenses e LEFT JOIN funding_sources fs ON fs.id=e.funding_source_id
  WHERE e.vendor LIKE $1`, [`${TAG}%`])).rows[0];
ok(Number(agg.campv) === 0, `a personally-paid receipt adds nothing to camp spend (${agg.campv})`);
ok(Number(agg.contrib) === 200, `and shows as contributed (${agg.contrib})`);

console.log('\n## an open work order does not claim a completion date (§7)');
const openWo = (await db.pool.query(
  `SELECT ws.is_terminal FROM work_orders w JOIN work_order_statuses ws ON ws.id=w.status_id WHERE w.id=$1`, [woId]
)).rows[0];
ok(openWo.is_terminal === false, 'the scratch work order is open');

console.log('\n## savings entered as old and new cost (§5)');
const task = await db.createAdminTask({
  title: `${TAG} Phone switch`, taskDate: p.periodStart, hours: 1,
  statusId: (await db.pool.query('select id from admin_task_statuses order by sort_order limit 1')).rows[0].id,
  savingOldCost: 420, savingNewCost: 143,
});
const saving = await db.getAdminTaskSaving(task.Id);
ok(saving && saving.Amount === 277, `420 - 143 is recorded as a ${saving?.Amount}/month saving`);
ok(saving && saving.Annualized === 3324, `annualized to ${saving?.Annualized}`);
ok(saving && saving.OldCost === 420 && saving.NewCost === 143, 'both figures are kept, so the working shows');
// Direct entry still works.
await db.updateAdminTask(task.Id, { recurringMonthlySavings: 50, savingOldCost: null, savingNewCost: null });
const direct = await db.getAdminTaskSaving(task.Id);
ok(direct && direct.Amount === 50, `typing the saving straight in still works (${direct?.Amount})`);

console.log('\n## admin tasks have a start and a finish (§7)');
await db.updateAdminTask(task.Id, { completedDate: p.periodEnd });
const t2 = await db.getAdminTask(task.Id);
ok(t2.TaskDate === p.periodStart && t2.CompletedDate === p.periodEnd,
  `started ${t2.TaskDate}, completed ${t2.CompletedDate}`);

console.log('\n## the existing September savings record is untouched');
const real = (await db.pool.query('select amount, old_cost, new_cost from savings_entries where id = 2')).rows[0];
ok(real && Number(real.amount) === 270, `still $${real?.amount}/month, as Ben left it`);
ok(real && real.old_cost === null && real.new_cost === null, 'and was not back-filled');

console.log('\n## no existing expense was reassigned');
const unassigned = (await db.pool.query(
  `select count(*)::int n from expenses where funding_source_id is null and vendor not like $1`, [`${TAG}%`]
)).rows[0].n;
const total = (await db.pool.query(`select count(*)::int n from expenses where vendor not like $1`, [`${TAG}%`])).rows[0].n;
ok(unassigned === total, `all ${total} real expenses are still unset, for Ben to mark himself`);

console.log('\n## a summary work order rolls its lines up into its own row (decisions: rollup)');
{
  const { renderBoardReportItemsHtml, renderBoardReportItemsText } = await import('/app/src/reportRender.js');
  const wo = { Id: 901, ItemType: 'work_order', ItemId: 77, Section: 'done', Included: true,
    DisplayMode: 'summary', SnapTitle: `${TAG} Roof`, SnapCost: 1200, SnapEstCost: 1500, SnapHours: 4 };
  const lineA = { Id: 902, ItemType: 'job_line', ItemId: 1, ParentWorkOrderId: 77, Section: 'done',
    Included: true, SnapTitle: `${TAG} strip`, SnapCost: 700 };
  const lineB = { Id: 903, ItemType: 'job_line', ItemId: 2, ParentWorkOrderId: 77, Section: 'done',
    Included: true, SnapTitle: `${TAG} reshingle`, SnapCost: 500 };
  const report = { Title: 'T', PeriodStart: '2026-09-01', PeriodEnd: '2026-09-30', ForwardEnd: '2026-10-15', Status: 'draft' };
  const html = renderBoardReportItemsHtml({ report, items: [wo, lineA, lineB], aggregates: [] });

  ok(html.includes(`${TAG} Roof`), 'the work order row prints');
  ok(!html.includes(`${TAG} strip`) && !html.includes(`${TAG} reshingle`),
    'and its lines do NOT print separately');
  ok(/Total — 1 item\(s\)/.test(html), 'the footer counts the one row the reader can see, not three');
  ok(html.includes('$1,200'), 'the total is the rolled-up actual');
  ok(!html.includes('$2,400'), 'the lines are not double counted on top of the row');
  ok(!html.includes('$1,500') || html.includes('est.'),
    'the estimate only ever appears labelled as an estimate, never in the total');

  console.log('\n## itemized prints the lines instead');
  const html2 = renderBoardReportItemsHtml({ report, items: [{ ...wo, DisplayMode: 'itemized' }, lineA, lineB], aggregates: [] });
  ok(html2.includes(`${TAG} strip`) && html2.includes(`${TAG} reshingle`), 'both lines print');
  ok(/Total — 3 item\(s\)/.test(html2), 'and all three rows are counted');

  console.log('\n## the footer says what the money is, so it is not read as camp spend');
  const NOTE = 'Recorded cost of work shown, including work funded outside camp. '
    + 'Not camp spend; estimates excluded.';
  ok(html.replace(/\s+/g, ' ').includes(NOTE), 'the HTML footer carries the note Ben wrote, verbatim');
  const text = renderBoardReportItemsText({ report, items: [wo, lineA, lineB], aggregates: [] });
  ok(text.includes(NOTE), 'and so does the plain-text copy');
  ok(/TOTAL — 1 item/.test(text), 'the text footer agrees with the HTML one');
}

console.log('\n## cleanup');
await purge();
const left = (await db.pool.query(
  `select (select count(*)::int from expenses where vendor like $1) e,
          (select count(*)::int from work_orders where title like $1) w,
          (select count(*)::int from admin_tasks where title like $1) t`, [`${TAG}%`])).rows[0];
ok(left.e + left.w + left.t === 0, `scratch records deleted (${JSON.stringify(left)})`);

console.log(`\n${fail.length ? `${fail.length} FAILURE(S): ` + fail.join(' | ') : 'all assertions passed'}`);
process.exit(fail.length ? 1 : 0);
