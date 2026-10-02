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

// Whatever draft the app would open, not a hardcoded id: a published report is read-only and
// refreshing it throws, so assuming an id makes this test fail on a button press.
const REPORT = Number(process.argv[2]) || (await db.getOrCreateDraftBoardReport()).Id;
const fail = [];
const ok = (c, l) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${l}`); if (!c) fail.push(l); };

const count = async () => (await db.pool.query(
  'SELECT count(*)::int n FROM board_report_items WHERE report_id=$1', [REPORT])).rows[0].n;

// The draft can legitimately be empty — anything already published is never proposed again —
// so this makes its own item to lose rather than depending on what happens to be on the report.
const asset = (await db.pool.query('select id from assets limit 1')).rows[0];
const { workOrderId: scratchWo } = await db.createWorkOrder({
  title: 'ZZ-RACE scratch', assetId: asset.id, priority: 'Medium',
});
await db.pool.query('UPDATE work_orders SET board_focus = true WHERE id = $1', [scratchWo]);

console.log('## a single refresh settles the report');
const t0 = Date.now();
await db.refreshBoardReportSuggestions(REPORT);
console.log(`    one pass takes ${Date.now() - t0}ms`);
const settled = await count();
console.log(`    ${settled} item(s)`);
ok(settled > 0, `the report has items to lose (${settled})`);

console.log('\n## five refreshes at once');
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
const results = await Promise.all([1, 2, 3, 4, 5].map(() => settle(db.refreshBoardReportSuggestions(REPORT))));
const after = await count();
const ran = results.filter((r) => r.ok);
console.log(`    ${after} item(s); ${ran.length}/5 passes ran, pruned: ${ran.map((r) => r.v.prunedCount).join(', ')}`);
ok(after === settled, `not one item was lost (${settled} before, ${after} after)`);
ok(ran.every((r) => r.v.prunedCount === 0), 'and no pass pruned anything another had written');
ok(ran.length >= 1, 'at least one pass got through');

console.log('\n## ten, interleaved with reads');
const before2 = await count();
await Promise.all([
  ...Array.from({ length: 10 }, () => settle(db.refreshBoardReportSuggestions(REPORT))),
  ...Array.from({ length: 10 }, () => settle(db.listBoardReportItems(REPORT))),
]);
const after2 = await count();
ok(after2 === before2, `still ${after2}, was ${before2}`);

console.log('\n## the items are the real ones, not an empty set that merely stayed empty');
const items = await db.listBoardReportItems(REPORT);
ok(items.some((i) => i.ItemType === 'work_order'), `work orders are present (${items.length} item(s))`);

console.log('\n## cleanup');
await db.pool.query(
  'DELETE FROM board_report_items WHERE item_type = $1 AND item_id = $2', ['work_order', scratchWo]);
await db.pool.query('DELETE FROM work_orders WHERE id = $1', [scratchWo]);
ok((await db.pool.query('SELECT count(*)::int n FROM work_orders WHERE title = $1',
  ['ZZ-RACE scratch'])).rows[0].n === 0, 'scratch work order deleted');

console.log(`\n${fail.length ? `${fail.length} FAILURE(S): ` + fail.join(' | ') : 'all assertions passed'}`);
process.exit(fail.length ? 1 : 0);
