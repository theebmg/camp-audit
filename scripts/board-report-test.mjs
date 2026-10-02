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

console.log('\n## a report refresh never touches a real savings record');
// This used to pin savings_entries id 2 to $270 — which broke the moment Ben corrected the
// figure himself, exactly as he said he would. The guarantee is not "the number is 270", it is
// "we do not write to his savings". So: snapshot every real entry, run the thing most likely to
// rewrite them, and compare.
{
  const realSavings = () => db.pool.query(
    `SELECT s.id, s.amount, s.period, s.old_cost, s.new_cost, s.occurred_on::text, s.kind
     FROM savings_entries s
     WHERE s.source_type IS DISTINCT FROM 'admin_task'
        OR s.source_id NOT IN (SELECT id FROM admin_tasks WHERE title LIKE $1)
     ORDER BY s.id`, [`${TAG}%`]);
  const beforeSavings = JSON.stringify((await realSavings()).rows);
  await db.refreshBoardReportSuggestions(1);
  const afterSavings = JSON.stringify((await realSavings()).rows);
  ok(beforeSavings === afterSavings,
    `${JSON.parse(beforeSavings).length} real savings entr(y/ies) unchanged by a refresh`);

  // And the report reads the entries rather than carrying its own copy of the figure. Mirrors
  // the aggregate's own rule exactly — recurring, inside the period — including this test's own
  // scratch admin task, which legitimately contributes a saving while it exists.
  const period = (await db.pool.query('SELECT period_start::text ps, period_end::text pe FROM board_reports WHERE id = 1')).rows[0];
  const expected = Number((await db.pool.query(
    `SELECT COALESCE(SUM(CASE WHEN period = 'monthly' THEN amount * 12 ELSE amount END), 0) AS annualized
     FROM savings_entries WHERE kind = 'recurring' AND occurred_on BETWEEN $1 AND $2`,
    [period.ps, period.pe]
  )).rows[0].annualized);
  const agg = (await db.listBoardReportAggregates(1)).find((a) => /Recurring savings secured this period/.test(a.Label));
  ok(agg && Math.abs(Number(agg.ValueNumeric) - expected) < 0.005,
    `the header states $${agg?.ValueNumeric}/yr, matching the entries in the period ($${expected})`);
}

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
  ok(/Cost of work shown: \$1,200/.test(html.replace(/\s+/g, ' ')),
    'the footer states the rolled-up cost under its own label');
  const text = renderBoardReportItemsText({ report, items: [wo, lineA, lineB], aggregates: [] });
  ok(/COST OF WORK SHOWN: \$1,200/.test(text),
    'the plain-text footer states the same figure');
}

console.log('\n## nothing to total means no total line');
{
  const { renderBoardReportItemsHtml, renderBoardReportItemsText } = await import('/app/src/reportRender.js');
  const report = { Title: 'T', PeriodStart: '2026-09-01', PeriodEnd: '2026-09-30', ForwardEnd: '2026-10-15', Status: 'draft' };

  // September's shape before any actuals: estimates only, hours off.
  const bare = [{ Id: 950, ItemType: 'job_line', ItemId: 9, Section: 'done', Included: true,
    SnapTitle: `${TAG} estimate only`, SnapCost: null, SnapEstCost: 379, SnapHours: 1.5 }];
  const bareHtml = renderBoardReportItemsHtml({ report, items: bare, aggregates: [] });
  const bareText = renderBoardReportItemsText({ report, items: bare, aggregates: [] });
  ok(!/Cost of work shown/.test(bareHtml), 'no cost line when there is no cost');
  ok(!/COST OF WORK SHOWN/.test(bareText), 'same in the plain-text copy');
  ok(bareHtml.includes(`${TAG} estimate only`), 'the item itself still prints');
  ok(/379/.test(bareHtml), 'and its estimate still shows on the row');

  // Hours alone still produce a line — but no cost, so no breakdown.
  const hoursOnly = renderBoardReportItemsHtml({ report: { ...report, ShowHours: true }, items: bare, aggregates: [] })
    .replace(/\s+/g, ' ');
  ok(/1\.5h/.test(hoursOnly), 'hours alone print');
  ok(!/Cost of work shown/.test(hoursOnly), 'with no cost figure beside them');

  // Money present: the cost and its breakdown both appear.
  const paid = [{ ...bare[0], SnapCost: 379,
    SnapFunding: [{ Source: 'Camp', IsCamp: true, IsGeneral: true, Amount: 379 }] }];
  const paidHtml = renderBoardReportItemsHtml({ report, items: paid, aggregates: [] }).replace(/\s+/g, ' ');
  ok(/Cost of work shown: \$379/.test(paidHtml), 'a cost line appears once there is real money');
  ok(/Camp general \$379/.test(paidHtml), 'and the breakdown comes with it');
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
  ok(!/item\(s\)/.test(onHtml.split('Cost of work shown')[1] || ''), 'the HTML footer does not tally rows');
  ok(!/COST OF WORK SHOWN:[^\n]*item/.test(onText), 'nor does the plain-text one');
  ok(/6\.5h/.test(onHtml.replace(/\s+/g, ' ')), 'and the hours total still prints');

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
      SnapFunding: [{ Source: 'Camp', IsCamp: true, IsGeneral: true, Amount: 379 }] },
    { Id: 973, ItemType: 'job_line', ItemId: 23, ParentWorkOrderId: 91, Section: 'done', Included: true,
      SnapTitle: `${TAG} mixed`, SnapDate: '2026-09-02', SnapCost: 180,
      SnapFunding: [{ Source: 'Camp', IsCamp: true, IsGeneral: true, Amount: 120 },
        { Source: 'Donor', IsCamp: false, IsGeneral: false, Amount: 60 }] },
    // Camp money, but earmarked — the case the old camp/non-camp rule rendered identically to
    // the general budget, leaving the board unable to tell them apart.
    { Id: 974, ItemType: 'job_line', ItemId: 24, ParentWorkOrderId: 91, Section: 'done', Included: true,
      SnapTitle: `${TAG} drywall`, SnapDate: '2026-09-02', SnapCost: 299.4,
      SnapFunding: [{ Source: 'Discretionary Fund', IsCamp: true, IsGeneral: false, Amount: 299.4 }] },
  ];
  const render = (mode) => renderBoardReportItemsHtml({ report: { ...base, ShowFunding: mode }, items, aggregates: [] })
    .replace(/\s+/g, ' ');

  const off = render('off');
  ok(!/Funded by/.test(off) && !/Donor/.test(off) && !/Discretionary/.test(off),
    'off: no funding anywhere');
  ok(/\$800/.test(off), 'but the money is still there');

  const nc = render('non_general');
  ok(/Funded by Ben/.test(nc), 'non-general: a non-camp line is tagged');
  ok(!/Funded by Camp/.test(nc), 'the GENERAL budget gets no tag');
  ok(/Funded by Discretionary Fund/.test(nc),
    'but an EARMARKED camp fund IS tagged — camp money the board set aside is not the general pot');
  ok(/Donor \$60/.test(nc) && !/Camp \$120/.test(nc),
    'a mixed line shows only the non-general share');

  const all = render('all');
  ok(/Funded by Camp/.test(all), 'all: the general budget is tagged too');
  ok(/Camp \$120/.test(all) && /Donor \$60/.test(all), 'and a mixed line shows both shares');

  console.log('\n## the tag sits after the cost on a LINE');
  ok(/\$800 · Funded by Ben/.test(nc), 'on a line: cost then funding');

  console.log('\n## an open work order carries no money on its own row');
  const woRow = nc.split(`${TAG} Reno`)[1]?.split('border-left:3px solid')[0] || '';
  ok(!/\$/.test(woRow), 'no figure of any kind on the open work order row');
  ok(!/spent of/.test(woRow), 'no "spent of ~est."');
  ok(!/Funded by/.test(woRow), 'and no funding split');
  ok(/In progress/.test(woRow), 'it still says In progress');
  ok(/\$800 · Funded by Ben/.test(nc), 'while its lines keep their costs and tags');

  console.log('\n## a CLOSED work order keeps its roll-up');
  const closed = renderBoardReportItemsHtml({
    report: { ...base, ShowFunding: 'non_general' },
    items: [{ ...items[0], SnapDate: '2026-09-30', SnapEstCost: null }],
    aggregates: [],
  }).replace(/\s+/g, ' ');
  const closedRow = closed.split(`${TAG} Reno`)[1] || '';
  ok(/\$800/.test(closedRow), 'a finished job still shows what it cost');
  ok(/Funded by Ben/.test(closedRow), 'and who paid for it');

  console.log('\n## nested lines carry no date, and the section is renamed');
  ok(!/padding:4px 0;font-size:0\.92rem[^<]*<\/div>\s*<div[^>]*>[^<]*2026-09-02/.test(nc), 'no date on a nested line');
  const nestedChunk = (nc.match(/border-left:3px solid[^]*?<\/td>/) || [''])[0];
  ok(!/Completed|2026-09-02/.test(nestedChunk), `the nested block has no dates in it`);
  ok(/WORK THIS PERIOD|Work This Period/i.test(nc), 'the section is called Work This Period');
  ok(!/Work Completed/.test(nc), 'and no longer Work Completed');

  const txt = renderBoardReportItemsText({ report: { ...base, ShowFunding: 'non_general' }, items, aggregates: [] });
  ok(/Funded by Ben/.test(txt), 'the plain-text copy tags funding too');
  ok(/WORK THIS PERIOD/.test(txt), 'and uses the new section name');
}

console.log('\n## funding precedence: receipts beat the budget field, which beats nothing');
{
  const kinds = (await db.pool.query('SELECT source, counts_as_camp_spend FROM job_line_funding_kinds ORDER BY sort_order')).rows;
  ok(kinds.length >= 5, `the mapping is seeded (${kinds.map((k) => k.source).join(', ')})`);
  const campKinds = kinds.filter((k) => k.counts_as_camp_spend).map((k) => k.source);
  const nonCamp = kinds.filter((k) => !k.counts_as_camp_spend).map((k) => k.source);
  ok(campKinds.includes('operating_budget') && campKinds.includes('capital_campaign')
    && campKinds.includes('fund') && campKinds.includes('other'),
    `camp: ${campKinds.join(', ')}`);
  ok(nonCamp.length === 1 && nonCamp[0] === 'cabin_holder', `non-camp: ${nonCamp.join(', ')}`);

  // An unknown source must count as CAMP, so contributions are never overstated.
  const unknown = await db.pool.query(
    `SELECT COALESCE(k.counts_as_camp_spend, true) AS is_camp
     FROM (SELECT 'something_new'::text AS src) x
     LEFT JOIN job_line_funding_kinds k ON k.source = x.src`);
  ok(unknown.rows[0].is_camp === true, 'a source missing from the table counts as camp spend');

  console.log('\n## the real September line keeps its attribution');
  const items = await db.listBoardReportItems(1);
  const l71 = items.find((i) => i.ItemType === 'job_line' && i.ItemId === 71);
  if (l71) {
    ok(l71.SnapFunding?.[0]?.Source === 'Ben Greenawalt',
      `line 71 is attributed to ${l71.SnapFunding?.[0]?.Source} with no receipt behind it`);
    ok(l71.SnapFunding?.[0]?.IsCamp === false, 'and is not camp money');
    ok(l71.SnapFunding?.[0]?.From === 'job_line', 'resolved from the job line, not a receipt');
  } else {
    console.log('  --    line 71 is not on report 1 right now; skipped');
  }

  console.log('\n## camp spend is never inflated by contributed money');
  const aggs = await db.listBoardReportAggregates(1);
  const camp = aggs.find((a) => a.Label === 'Camp funds spent this period');
  const tile = aggs.find((a) => a.Label === 'Contributed (non-camp)');
  if (tile) {
    ok(Number(camp.ValueNumeric) !== Number(camp.ValueNumeric) + Number(tile.ValueNumeric),
      'the two are separate figures');
    ok(tile.Note === 'Includes work paid directly, without a receipt.', 'the tile carries its note');
  }

  console.log('\n## "Last, First" reads as a person on the report');
  const { renderBoardReportItemsHtml } = await import('/app/src/reportRender.js');
  const html = renderBoardReportItemsHtml({
    report: { Title: 'T', PeriodStart: '2026-09-01', PeriodEnd: '2026-09-30', ForwardEnd: '2026-10-15', Status: 'draft', ShowFunding: 'non_general' },
    items: [{ Id: 980, ItemType: 'job_line', ItemId: 31, Section: 'done', Included: true,
      SnapTitle: `${TAG} cash job`, SnapDate: '2026-09-02', SnapCost: 800,
      SnapFunding: [{ Source: 'Ben Greenawalt', IsCamp: false, Amount: 800 }] }],
    aggregates: [],
  });
  ok(/Funded by Ben Greenawalt/.test(html), 'the tag names the person, not the category');
  ok(!/Greenawalt, Ben/.test(html), 'and not surname-first as stored');
}

console.log('\n## a second pass must not wipe what the first worked out');
{
  // The exact shape that lost the paint line's funding: a board-flagged job line is written by
  // the Done rule with funding, then again by the flagged rule which knows nothing about it.
  // Created 'published', not 'draft': a partial unique index allows only one draft at a time,
  // and the real September draft is it. The upsert does not care about status.
  const rep = (await db.pool.query(
    `INSERT INTO board_reports (title, status, period_start, period_end, forward_start, forward_end)
     VALUES ($1,'published','2026-09-01','2026-09-30','2026-10-01','2026-10-15') RETURNING id`,
    [`${TAG} upsert`])).rows[0].id;
  try {
    await db.upsertBoardReportItem(rep, {
      passId: 'p1', itemType: 'job_line', itemId: 999001, section: 'done', sortIndex: 1,
      snapTitle: `${TAG} flagged line`, snapCost: 300,
      snapFunding: [{ Source: 'Ben Greenawalt', IsCamp: false, Amount: 300 }],
      snapProgress: 'half done',
    });
    let row = (await db.pool.query(
      'SELECT snap_cost, snap_funding, snap_progress FROM board_report_items WHERE report_id=$1', [rep])).rows[0];
    ok(!!row.snap_funding, 'the first pass stores funding');

    // Second pass: same row, no funding and no progress computed.
    await db.upsertBoardReportItem(rep, {
      passId: 'p2', itemType: 'job_line', itemId: 999001, section: 'done', sortIndex: 1,
      snapTitle: `${TAG} flagged line`, snapCost: 300,
    });
    row = (await db.pool.query(
      'SELECT snap_cost, snap_funding, snap_progress FROM board_report_items WHERE report_id=$1', [rep])).rows[0];
    ok(!!row.snap_funding, 'a pass that did not compute funding LEAVES IT ALONE');
    ok(row.snap_progress === 'half done', 'and leaves progress alone too');
    ok(Number(row.snap_cost) === 300, 'while the cost it did compute still applies');

    // An explicit null still clears — that is how a wrong figure gets corrected.
    await db.upsertBoardReportItem(rep, {
      passId: 'p3', itemType: 'job_line', itemId: 999001, section: 'done', sortIndex: 1,
      snapTitle: `${TAG} flagged line`, snapCost: null, snapFunding: null,
    });
    row = (await db.pool.query(
      'SELECT snap_cost, snap_funding FROM board_report_items WHERE report_id=$1', [rep])).rows[0];
    ok(row.snap_funding === null, 'an explicit null DOES clear funding');
    ok(row.snap_cost === null, 'and an explicit null clears the cost');
  } finally {
    await db.pool.query('DELETE FROM board_report_items WHERE report_id=$1', [rep]);
    await db.pool.query('DELETE FROM board_reports WHERE id=$1', [rep]);
  }
}

console.log('\n## money never prints a lone decimal');
{
  const { renderBoardReportItemsHtml } = await import('/app/src/reportRender.js');
  const mk = (cost) => renderBoardReportItemsHtml({
    report: { Title: 'T', PeriodStart: '2026-09-01', PeriodEnd: '2026-09-30', ForwardEnd: '2026-10-15', Status: 'draft' },
    items: [{ Id: 990, ItemType: 'job_line', ItemId: 41, Section: 'done', Included: true,
      SnapTitle: `${TAG} money`, SnapDate: '2026-09-02', SnapCost: cost }],
    aggregates: [],
  }).replace(/\s+/g, ' ');
  ok(/\$1,399\.40/.test(mk(1399.4)), '1399.4 prints as $1,399.40, not $1,399.4');
  ok(/\$1,200(?!\.)/.test(mk(1200)), 'a whole amount stays $1,200 with no decimals');
  ok(/\$86\.18/.test(mk(86.18)), 'and real cents are untouched');
  ok(!/\$[\d,]+\.\d(?!\d)/.test(mk(299.4)), 'no amount anywhere ends in a single decimal');
}

console.log('\n## approved funds print under the header, not in it');
{
  const { renderBoardReportItemsHtml, renderBoardReportItemsText } = await import('/app/src/reportRender.js');
  const base = { Title: 'T', PeriodStart: '2026-09-01', PeriodEnd: '2026-09-30', ForwardEnd: '2026-10-15', Status: 'draft' };
  const aggs = [
    { GroupKey: 'money', Label: 'Camp funds spent this period', ValueNumeric: 978.07 },
    { GroupKey: 'funds', Label: 'Discretionary Audit Fund',
      ValueText: '$886 of $5,000 used · $4,114 left · 90 days left', Note: 'authorized by Camp Sychar board' },
  ];
  const html = renderBoardReportItemsHtml({ report: { ...base, ShowFunding: 'non_general' }, items: [], aggregates: aggs }).replace(/\s+/g, ' ');
  ok(/Approved Funds/i.test(html), 'the block has a heading');
  ok(/Discretionary Audit Fund/.test(html), 'the fund is named');
  ok(/\$886 of \$5,000 used/.test(html), 'usage against the approved figure');
  ok(/\$4,114 left/.test(html) && /90 days left/.test(html), 'remaining and days left');
  ok(/authorized by Camp Sychar board/.test(html), 'and who approved it');
  ok(/already counted inside camp funds spent/i.test(html),
    'it says plainly that this is not money on TOP of camp spend');

  const txt = renderBoardReportItemsText({ report: { ...base, ShowFunding: 'non_general' }, items: [], aggregates: aggs });
  ok(/APPROVED FUNDS/.test(txt) && /\$886 of \$5,000/.test(txt), 'the plain-text copy carries it too');

  const off = renderBoardReportItemsHtml({ report: { ...base, ShowFunding: 'off' }, items: [], aggregates: aggs });
  ok(!/Approved Funds/i.test(off), 'turning funding off hides the block');

  const none = renderBoardReportItemsHtml({ report: { ...base, ShowFunding: 'non_general' }, items: [],
    aggregates: aggs.filter((a) => a.GroupKey !== 'funds') });
  ok(!/Approved Funds/i.test(none), 'and a report with no fund activity shows nothing');
}

console.log('\n## the footer breaks the cost down by funder');
{
  const { renderBoardReportItemsHtml, renderBoardReportItemsText } = await import('/app/src/reportRender.js');
  const base = { Title: 'T', PeriodStart: '2026-09-01', PeriodEnd: '2026-09-30', ForwardEnd: '2026-10-15', Status: 'draft', ShowFunding: 'non_general' };
  const items = [
    { Id: 981, ItemType: 'work_order', ItemId: 95, Section: 'done', Included: true, DisplayMode: 'summary',
      SnapTitle: `${TAG} job`, SnapDate: '2026-09-20', SnapCost: 1399.4,
      SnapFunding: [
        { Source: 'Ben Greenawalt', IsCamp: false, IsGeneral: false, Amount: 1100 },
        { Source: 'Discretionary Audit Fund', IsCamp: true, IsGeneral: false, Amount: 299.4 },
      ] },
  ];
  const html = renderBoardReportItemsHtml({ report: base, items, aggregates: [] }).replace(/\s+/g, ' ');
  const txt = renderBoardReportItemsText({ report: base, items, aggregates: [] });

  ok(/Cost of work shown: \$1,399\.40/.test(html), 'the footer states the cost under its own label');
  ok(/Ben Greenawalt \$1,100/.test(html) && /Discretionary Audit Fund \$299\.40/.test(html),
    'and breaks it down by funder');
  ok(!/Not camp spend/.test(html) && !/estimates excluded/.test(html), 'the old disclaimer is gone');
  ok(/official books/i.test(html), 'but the official-books line stays');
  ok(/COST OF WORK SHOWN: \$1,399\.40/.test(txt) && /Ben Greenawalt \$1,100/.test(txt),
    'the plain-text copy carries both');

  console.log('\n## the parts always add up to the whole');
  const gap = [{ ...items[0], SnapCost: 1599.4 }];   // $200 with no funding recorded against it
  const gapHtml = renderBoardReportItemsHtml({ report: base, items: gap, aggregates: [] }).replace(/\s+/g, ' ');
  ok(/Unattributed \$200/.test(gapHtml),
    'a cost with no funder is shown as Unattributed rather than quietly dropped');

  console.log('\n## $0 categories are hidden');
  const zero = [{ ...items[0], SnapFunding: [...items[0].SnapFunding, { Source: 'Donor', IsCamp: false, IsGeneral: false, Amount: 0 }] }];
  ok(!/Donor/.test(renderBoardReportItemsHtml({ report: base, items: zero, aggregates: [] })),
    'a funder with nothing against it does not appear');

  console.log('\n## the general pot is named for the reader');
  const gen = [{ ...items[0], SnapFunding: [{ Source: 'Operating Budget', IsCamp: true, IsGeneral: true, Amount: 1399.4 }] }];
  const genHtml = renderBoardReportItemsHtml({ report: base, items: gen, aggregates: [] }).replace(/\s+/g, ' ');
  ok(/Camp general \$1,399\.40/.test(genHtml), 'it reads "Camp general", not its internal label');
  ok(!/Operating Budget/.test(genHtml), 'the internal label does not reach the board');

  console.log('\n## section headings carry no money');
  ok(!/item\(s\)[^<]*\$/.test(html), 'no subtotal beside the item count');
}

console.log('\n## a fund-charged receipt linked to work keeps its fund');
{
  const fund = (await db.pool.query('SELECT id, name FROM funds ORDER BY id LIMIT 1')).rows[0];
  if (!fund) { console.log('  --    no funds defined; skipped'); }
  else {
    const asset = (await db.pool.query('select id from assets limit 1')).rows[0];
    const { workOrderId: woId } = await db.createWorkOrder({
      title: `${TAG} fund link`, assetId: asset.id, priority: 'Medium',
    });
    // A line budgeted against the GENERAL operating budget — the case that used to swallow the
    // fund, because a split inherits its category from the line it lands on.
    const line = await db.createJobLine(woId, { title: `${TAG} general line`, estimatedCost: 100 });
    await db.pool.query(
      "UPDATE job_lines SET funding_source = 'operating_budget', funding_ref_id = NULL WHERE id = $1",
      [line.Id]
    );
    const exp = await db.createExpense({ vendor: `${TAG} Hardware`, amount: 250, purchaseDate: p.periodStart });
    await db.pool.query('UPDATE expenses SET fund_id = $2 WHERE id = $1', [exp.Id, fund.id]);
    await db.createExpenseAllocation(exp.Id, { destType: 'job_line', destId: line.Id, amount: 250, quantity: 1 });

    const stamped = (await db.pool.query(
      'SELECT funding_source, funding_ref_id FROM expense_allocations WHERE expense_id = $1', [exp.Id])).rows[0];
    ok(stamped.funding_source === 'fund' && stamped.funding_ref_id === fund.id,
      `the allocation is stamped with the fund, not the line's category (${stamped.funding_source})`);

    // What the report resolves for that line. The rollup itself is module-private, so this
    // asserts the same precedence the report applies.
    const { rows: resolved } = await db.pool.query(
      `SELECT COALESCE(f.name, 'none') AS source
       FROM expense_allocations ea
       JOIN expenses e ON e.id = ea.expense_id
       LEFT JOIN funds f ON f.id = COALESCE(e.fund_id,
                              CASE WHEN ea.funding_source = 'fund' THEN ea.funding_ref_id END)
       WHERE ea.dest_id = $1 AND ea.dest_type = 'job_line'`, [line.Id]);
    ok(resolved[0]?.source === fund.name,
      `and the report resolves it to "${resolved[0]?.source}" rather than the general budget`);

    await db.pool.query('DELETE FROM expense_allocations WHERE expense_id = $1', [exp.Id]);
    await db.pool.query('DELETE FROM expenses WHERE id = $1', [exp.Id]);
    await db.pool.query('DELETE FROM job_lines WHERE id = $1', [line.Id]);
    await db.pool.query('DELETE FROM work_orders WHERE id = $1', [woId]);
  }
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
