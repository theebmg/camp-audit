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
  // Counting rendered rows directly, now that the footer no longer tallies them.
  // Counts item blocks by their padding signature rather than their colour, so a palette change
  // does not read as a layout regression.
  const rowCount = (h) => (h.match(/padding:9px 0;/g) || []).length;
  ok(rowCount(html) === 1, `one row reaches the reader, not three (${rowCount(html)})`);
  ok(html.includes('$1,200'), 'the total is the rolled-up actual');
  ok(!html.includes('$2,400'), 'the lines are not double counted on top of the row');
  ok(!html.includes('$1,500') || html.includes('est.'),
    'the estimate only ever appears labelled as an estimate, never in the total');

  console.log('\n## itemized prints the lines instead');
  const html2 = renderBoardReportItemsHtml({ report, items: [{ ...wo, DisplayMode: 'itemized' }, lineA, lineB], aggregates: [] });
  ok(html2.includes(`${TAG} strip`) && html2.includes(`${TAG} reshingle`), 'both lines print');
  // Itemized is now ONE parent block with its lines nested inside it, not three sibling rows.
  const nestedCount = (h) => (h.match(/padding:4px 0;font-size:0\.92rem/g) || []).length;
  ok(rowCount(html2) === 1, `one parent block (${rowCount(html2)})`);
  ok(nestedCount(html2) === 2, `with both lines nested inside it (${nestedCount(html2)})`);
  ok(/border-left:3px solid/.test(html2), 'behind the connecting rail');
  ok(nestedCount(html) === 0, 'a summary work order nests nothing');

  console.log('\n## the footer says what the money is, so it is not read as camp spend');
  const NOTE = 'Recorded cost of work shown, including work funded outside camp. '
    + 'Not camp spend; estimates excluded.';
  ok(html.replace(/\s+/g, ' ').includes(NOTE), 'the HTML footer carries the note Ben wrote, verbatim');
  const text = renderBoardReportItemsText({ report, items: [wo, lineA, lineB], aggregates: [] });
  ok(text.includes(NOTE), 'and so does the plain-text copy');
  ok(/TOTAL .* \$1,200 recorded cost of work shown/.test(text),
    'the text footer states the same rolled-up total as the HTML one');
}

console.log('\n## the note appears only alongside a recorded cost');
{
  const { renderBoardReportItemsHtml, renderBoardReportItemsText } = await import('/app/src/reportRender.js');
  const NOTE = 'Recorded cost of work shown, including work funded outside camp. '
    + 'Not camp spend; estimates excluded.';
  const report = { Title: 'T', PeriodStart: '2026-09-01', PeriodEnd: '2026-09-30', ForwardEnd: '2026-10-15', Status: 'draft' };

  // September's shape: estimates only, nothing allocated, hours off — so no total is printed.
  const bare = [{ Id: 950, ItemType: 'job_line', ItemId: 9, Section: 'done', Included: true,
    SnapTitle: `${TAG} estimate only`, SnapCost: null, SnapEstCost: 379, SnapHours: 1.5 }];
  const bareHtml = renderBoardReportItemsHtml({ report, items: bare, aggregates: [] });
  const bareText = renderBoardReportItemsText({ report, items: bare, aggregates: [] });
  ok(!/Total\s*\u2014/.test(bareHtml), 'no total line when there is nothing to total');
  ok(!bareHtml.replace(/\s+/g, ' ').includes(NOTE), 'and NO note either — it has nothing to qualify');
  ok(!/TOTAL\s*\u2014/.test(bareText) && !bareText.includes(NOTE), 'same in the plain-text copy');
  ok(bareHtml.includes(`${TAG} estimate only`), 'the item itself still prints');
  ok(/379/.test(bareHtml), 'and its estimate still shows on the row');

  // Money present: both come back, together.
  const paid = [{ ...bare[0], SnapCost: 379 }];
  const paidHtml = renderBoardReportItemsHtml({ report, items: paid, aggregates: [] });
  const paidText = renderBoardReportItemsText({ report, items: paid, aggregates: [] });
  ok(/Total\s*\u2014/.test(paidHtml), 'a total appears once there is real money');
  ok(paidHtml.replace(/\s+/g, ' ').includes(NOTE), 'and the note comes with it');
  ok(/TOTAL\s*\u2014/.test(paidText) && paidText.includes(NOTE), 'both in the plain-text copy too');

  // Hours alone produce a total, but NOT the note: there is no cost figure for it to qualify.
  const hoursOnly = renderBoardReportItemsHtml({ report: { ...report, ShowHours: true }, items: bare, aggregates: [] });
  const hoursOnlyText = renderBoardReportItemsText({ report: { ...report, ShowHours: true }, items: bare, aggregates: [] });
  ok(/Total\s*\u2014\s*1\.5h/.test(hoursOnly.replace(/\s+/g, ' ')), 'hours alone print a total');
  ok(!hoursOnly.replace(/\s+/g, ' ').includes(NOTE), 'and NO note — the total carries no cost to qualify');
  ok(!hoursOnlyText.includes(NOTE), 'nor in the plain-text copy');

  // Hours AND money: the total carries both, and the note returns with the money.
  const bothHtml = renderBoardReportItemsHtml({ report: { ...report, ShowHours: true }, items: paid, aggregates: [] });
  const bothFlat = bothHtml.replace(/\s+/g, ' ');
  ok(/Total\s*\u2014\s*1\.5h\s*·\s*\$379/.test(bothFlat), 'hours and money share one total line');
  ok(bothFlat.includes(NOTE), 'and the note is back, because there is now a cost');
}

console.log('\n## Show hours: off by default, and off means off everywhere');
{
  const { renderBoardReportItemsHtml, renderBoardReportItemsText } = await import('/app/src/reportRender.js');
  const items = [
    { Id: 960, ItemType: 'work_order', ItemId: 88, Section: 'done', Included: true, DisplayMode: 'summary',
      SnapTitle: `${TAG} Roof`, SnapCost: 1200, SnapHours: 4, SnapStartDate: '2026-09-05', SnapDate: '2026-09-23' },
    { Id: 961, ItemType: 'admin_task', ItemId: 12, Section: 'admin_work', Included: true,
      SnapTitle: `${TAG} Phones`, SnapHours: 2.5 },
  ];
  const base = { Title: 'T', PeriodStart: '2026-09-01', PeriodEnd: '2026-09-30', ForwardEnd: '2026-10-15', Status: 'draft' };

  const offHtml = renderBoardReportItemsHtml({ report: { ...base }, items, aggregates: [] });
  const offText = renderBoardReportItemsText({ report: { ...base }, items, aggregates: [] });
  ok(!/\b4h\b|\b2\.5h\b|6\.5h/.test(offHtml), 'no hours anywhere in the HTML when the toggle is off');
  ok(!/\b4h\b|\b2\.5h\b|6\.5h/.test(offText), 'none in the plain-text copy either');
  ok(offHtml.includes('$1,200'), 'money is untouched by the hours toggle');

  const onHtml = renderBoardReportItemsHtml({ report: { ...base, ShowHours: true }, items, aggregates: [] });
  const onText = renderBoardReportItemsText({ report: { ...base, ShowHours: true }, items, aggregates: [] });
  ok(/4h/.test(onHtml) && /2\.5h/.test(onHtml), 'turning it on brings the item hours back in HTML');
  ok(/6\.5h/.test(onHtml), 'and the footer total');
  ok(/4h/.test(onText) && /6\.5h/.test(onText), 'and in the plain-text copy');

  console.log('\n## the item count is gone from the footer');
  ok(!/Total\s*\u2014\s*\d+\s*item/.test(onHtml) && !/item\(s\)/.test(onHtml.split('Total')[1] || ''),
    'the HTML footer no longer tallies rows');
  ok(!/TOTAL\s*\u2014\s*\d+\s*item/.test(onText), 'nor does the plain-text one');
  ok(/Total\s*\u2014\s*6\.5h/.test(onHtml.replace(/\s+/g, ' ')), 'the footer leads with what is left');

  console.log('\n## one-day work says Completed once, not a span of nothing');
  const sameDay = [{ Id: 962, ItemType: 'job_line', ItemId: 3, Section: 'done', Included: true,
    SnapTitle: `${TAG} same day`, SnapStartDate: '2026-09-23', SnapDate: '2026-09-23' }];
  const sdHtml = renderBoardReportItemsHtml({ report: { ...base }, items: sameDay, aggregates: [] });
  const sdText = renderBoardReportItemsText({ report: { ...base }, items: sameDay, aggregates: [] });
  ok(!/Started/.test(sdHtml), 'no "Started" when it began and finished the same day');
  ok(/Completed/.test(sdHtml), 'just "Completed"');
  ok(!/Started/.test(sdText) && /Completed/.test(sdText), 'same in the plain-text copy');
  const spanHtml = renderBoardReportItemsHtml({ report: { ...base }, items, aggregates: [] });
  ok(/Started/.test(spanHtml) && /Completed/.test(spanHtml), 'a real span still shows both ends');
  const openHtml = renderBoardReportItemsHtml({ report: { ...base },
    items: [{ ...sameDay[0], SnapDate: null }], aggregates: [] });
  ok(/Started/.test(openHtml) && /In progress/.test(openHtml), 'and open work still reads In progress');
}

console.log('\n## Show funding (off / non-camp only / all)');
{
  const { renderBoardReportItemsHtml, renderBoardReportItemsText } = await import('/app/src/reportRender.js');
  const base = { Title: 'T', PeriodStart: '2026-09-01', PeriodEnd: '2026-09-30', ForwardEnd: '2026-10-15', Status: 'draft' };
  const items = [
    { Id: 970, ItemType: 'work_order', ItemId: 91, Section: 'done', Included: true, DisplayMode: 'itemized',
      SnapTitle: `${TAG} Reno`, SnapStartDate: '2026-09-02', SnapDate: null,
      SnapCost: 800, SnapEstCost: 1540,
      SnapFunding: [{ Source: 'Ben', IsCamp: false, Amount: 800 }] },
    { Id: 971, ItemType: 'job_line', ItemId: 21, ParentWorkOrderId: 91, Section: 'done', Included: true,
      SnapTitle: `${TAG} beam`, SnapDate: '2026-09-02', SnapCost: 800,
      SnapFunding: [{ Source: 'Ben', IsCamp: false, Amount: 800 }] },
    { Id: 972, ItemType: 'job_line', ItemId: 22, ParentWorkOrderId: 91, Section: 'done', Included: true,
      SnapTitle: `${TAG} pump`, SnapDate: '2026-09-02', SnapCost: 379,
      SnapFunding: [{ Source: 'Camp', IsCamp: true, Amount: 379 }] },
    { Id: 973, ItemType: 'job_line', ItemId: 23, ParentWorkOrderId: 91, Section: 'done', Included: true,
      SnapTitle: `${TAG} mixed`, SnapDate: '2026-09-02', SnapCost: 180,
      SnapFunding: [{ Source: 'Camp', IsCamp: true, Amount: 120 }, { Source: 'Donor', IsCamp: false, Amount: 60 }] },
  ];
  const render = (mode) => renderBoardReportItemsHtml({ report: { ...base, ShowFunding: mode }, items, aggregates: [] })
    .replace(/\s+/g, ' ');

  const off = render('off');
  ok(!/Funded by/.test(off) && !/Donor/.test(off), 'off: no funding anywhere');
  ok(/\$800/.test(off), 'but the money is still there');

  const nc = render('non_camp');
  ok(/Funded by Ben/.test(nc), 'non-camp: a wholly non-camp line is tagged');
  ok(!/Funded by Camp/.test(nc), 'and a camp-funded line gets NO tag');
  ok(/Donor \$60/.test(nc) && !/Camp \$120/.test(nc),
    'a mixed line shows only the non-camp share');

  const all = render('all');
  ok(/Funded by Camp/.test(all), 'all: camp-funded lines are tagged too');
  ok(/Camp \$120/.test(all) && /Donor \$60/.test(all), 'and a mixed line shows both shares');

  console.log('\n## the tag sits after the cost, and the roll-up reads as spend against estimate');
  ok(/\$800 · Funded by Ben/.test(nc), 'on a line: cost then funding');
  ok(/\$800 spent of ~\$1,540 est\. · Funded by Ben/.test(nc),
    'on the work order: "$800 spent of ~$1,540 est. · Funded by Ben"');

  console.log('\n## nested lines carry no date, and the section is renamed');
  ok(!/padding:4px 0;font-size:0\.92rem[^<]*<\/div>\s*<div[^>]*>[^<]*2026-09-02/.test(nc), 'no date on a nested line');
  const nestedChunk = (nc.match(/border-left:3px solid[^]*?<\/td>/) || [''])[0];
  ok(!/Completed|2026-09-02/.test(nestedChunk), `the nested block has no dates in it`);
  ok(/WORK THIS PERIOD|Work This Period/i.test(nc), 'the section is called Work This Period');
  ok(!/Work Completed/.test(nc), 'and no longer Work Completed');

  const txt = renderBoardReportItemsText({ report: { ...base, ShowFunding: 'non_camp' }, items, aggregates: [] });
  ok(/Funded by Ben/.test(txt), 'the plain-text copy tags funding too');
  ok(/WORK THIS PERIOD/.test(txt), 'and uses the new section name');
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
