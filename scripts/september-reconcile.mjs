// Does the September report add up? (decisions: "regenerate September so I can check totals
// reconcile"). Read-only apart from the refresh, which is safe and re-runnable.
//
//   docker exec camp-audit node scripts/september-reconcile.mjs [reportId]
import * as db from '/app/src/db.js';
import { renderBoardReportFromItems } from '/app/src/reportDataPg.js';

const REPORT = Number(process.argv[2]) || 1;
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

await db.refreshBoardReportSuggestions(REPORT);
const { html, text, data } = await renderBoardReportFromItems(REPORT, { withPhotos: false });
const { report, items, aggregates } = data;

const summaryWo = new Set(items.filter((i) => i.Included && i.ItemType === 'work_order' && i.DisplayMode === 'summary').map((i) => i.ItemId));
const visible = items.filter((i) => i.Included && !(i.ItemType === 'job_line' && summaryWo.has(i.ParentWorkOrderId)));
// What is PRINTED is not what is COUNTED: a work order's row carries the roll-up of its lines,
// so adding both counts the same money twice. Same rule the renderer uses.
const woIds = new Set(visible.filter((i) => i.ItemType === 'work_order').map((i) => i.ItemId));
const counted = visible.filter((i) => i.ItemType !== 'job_line' || !woIds.has(i.ParentWorkOrderId));
const cost = counted.reduce((t, i) => t + (i.SnapCost || 0), 0);
const hours = counted.reduce((t, i) => t + (i.SnapHours || 0), 0);
const est = counted.reduce((t, i) => t + (i.SnapEstCost || 0), 0);

console.log(`BOARD REPORT ${REPORT} — ${report.Title}`);
console.log(`${report.PeriodStart} to ${report.PeriodEnd}, looking ahead to ${report.ForwardEnd}\n`);

console.log('ITEM COUNT');
console.log(`  stored            ${items.length}`);
console.log(`  included          ${items.filter((i) => i.Included).length}`);
console.log(`  hidden under a summary work order  ${items.filter((i) => i.Included).length - visible.length}`);
console.log(`  PRINTED           ${visible.length}`);
console.log(`  COUNTED           ${counted.length}   <- work orders and admin tasks, not their lines`);
const m = html.match(/Total\s*\u2014\s*([^<]*)/);
console.log(`  footer reads      ${m ? m[1].trim() : '(no total line)'}`);
const fm = m && /\$([\d,]+(?:\.\d\d)?)/.exec(m[1]);
const footerNum = fm ? Number(fm[1].replace(/,/g, '')) : 0;
console.log(`  RECONCILES        ${Math.abs(footerNum - cost) < 0.005 ? 'YES' : `NO (footer ${footerNum} vs computed ${cost})`}\n`);

console.log('MONEY');
console.log(`  recorded cost of work shown   ${money(cost)}   <- actuals only, this is the footer figure`);
console.log(`  estimates on open work        ~${money(est)}   <- shown per item, never in a total`);
console.log(`  hours                         ${hours}\n`);

console.log('HEADER');
for (const a of aggregates.filter((a) => ['money', 'savings'].includes(a.GroupKey))) {
  console.log(`  ${a.Label}: ${a.ValueNumeric != null ? money(a.ValueNumeric) : (a.ValueText || '-')}`);
}

const NOTE = 'Recorded cost of work shown, including work funded outside camp. Not camp spend; estimates excluded.';
console.log(`\nFOOTER NOTE PRESENT   html: ${html.replace(/\s+/g, ' ').includes(NOTE)}   text: ${text.includes(NOTE)}`);

console.log('\nSECTIONS');
for (const s of ['done', 'coming_up', 'overdue', 'admin_work']) {
  const rows = visible.filter((i) => i.Section === s);
  if (!rows.length) continue;
  console.log(`  ${s} (${counted.filter((i) => i.Section === s).length} counted, ${rows.length} printed)`);
  for (const r of rows) {
    const bits = [r.SnapCost != null ? money(r.SnapCost) : null,
      r.SnapEstCost != null && !r.SnapDate ? `~${money(r.SnapEstCost)} est.` : null,
      r.SnapHours ? `${r.SnapHours}h` : null].filter(Boolean).join(' · ');
    console.log(`      ${String(r.SnapTitle).slice(0, 52).padEnd(52)} ${bits}`);
  }
}

// The gap Ben already knows about, restated with today's numbers.
const unalloc = (await db.pool.query(
  `SELECT COALESCE(SUM(e.amount), 0) total, count(*)::int n FROM expenses e
   WHERE e.triage_status != 'void' AND e.deleted_at IS NULL
     AND e.purchase_date BETWEEN $1 AND $2
     AND NOT EXISTS (SELECT 1 FROM expense_allocations ea WHERE ea.expense_id = e.id)`,
  [report.PeriodStart, report.PeriodEnd])).rows[0];
console.log(`\nWHY THE RECORDED COST IS WHAT IT IS`);
console.log(`  ${unalloc.n} receipt(s) totalling ${money(unalloc.total)} in this period are not split onto any job line,`);
console.log(`  so no work can claim them as actual cost. Splitting them is what turns the`);
console.log(`  ${money(cost)} above into real money against the work.`);
process.exit(0);
