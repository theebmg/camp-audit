// Concurrent refreshes must not eat a report's items (Oct 2026).
//
//   docker exec camp-audit node scripts/report-refresh-race-test.mjs [reportId]
//
// Each suggestion pass stamps the rows it writes with its own id and then deletes every row
// NOT carrying that id. Run two passes at once and the first one's prune deletes what the
// second has just written — which destroyed 17 of 21 items on the real September report.
// Nothing here is scratch: it runs the real refresh, which is safe and re-runnable by design,
// and asserts the item count never drops.
import * as db from '/app/src/db.js';

const REPORT = Number(process.argv[2]) || 1;
const fail = [];
const ok = (c, l) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${l}`); if (!c) fail.push(l); };

const count = async () => (await db.pool.query(
  'SELECT count(*)::int n FROM board_report_items WHERE report_id=$1', [REPORT])).rows[0].n;

console.log('## a single refresh settles the report');
await db.refreshBoardReportSuggestions(REPORT);
const settled = await count();
console.log(`    ${settled} item(s)`);
ok(settled > 0, 'the report has items to lose');

console.log('\n## five refreshes at once');
const results = await Promise.all([1, 2, 3, 4, 5].map(() => db.refreshBoardReportSuggestions(REPORT)));
const after = await count();
console.log(`    ${after} item(s), pruned per pass: ${results.map((r) => r.prunedCount).join(', ')}`);
ok(after === settled, `not one item was lost (${settled} before, ${after} after)`);
ok(results.every((r) => r.prunedCount === 0), 'and no pass pruned anything the others had written');

console.log('\n## ten, interleaved with reads');
const before2 = await count();
await Promise.all([
  ...Array.from({ length: 10 }, () => db.refreshBoardReportSuggestions(REPORT)),
  ...Array.from({ length: 10 }, () => db.listBoardReportItems(REPORT)),
]);
const after2 = await count();
ok(after2 === before2, `still ${after2}, was ${before2}`);

console.log('\n## the items are the real ones, not an empty set that merely stayed empty');
const items = await db.listBoardReportItems(REPORT);
ok(items.some((i) => i.ItemType === 'work_order'), 'work orders are present');
ok(items.some((i) => i.ItemType === 'job_line'), 'job lines are present');

console.log(`\n${fail.length ? `${fail.length} FAILURE(S): ` + fail.join(' | ') : 'all assertions passed'}`);
process.exit(fail.length ? 1 : 0);
