// Work order completed date (Nov 2026): the day the work was recorded as done wins over the
// day the work order was closed out. Scratch records only, deleted at the end (asserted).
//
//   docker exec camp-audit node scripts/wo-completed-date-test.mjs
import assert from 'node:assert/strict';
import * as db from '/app/src/db.js';

const TAG = '__wo_completed_date_test__';
const today = new Date().toISOString().slice(0, 10);
async function cleanup() {
  await db.pool.query('DELETE FROM job_lines WHERE work_order_id IN (SELECT id FROM work_orders WHERE title LIKE $1)', [`${TAG}%`]);
  await db.pool.query('DELETE FROM work_order_log_entries WHERE work_order_id IN (SELECT id FROM work_orders WHERE title LIKE $1)', [`${TAG}%`]);
  await db.pool.query('DELETE FROM work_orders WHERE title LIKE $1', [`${TAG}%`]);
  await db.pool.query('DELETE FROM activity_log WHERE entity_label LIKE $1', [`${TAG}%`]);
}
const done = (await db.pool.query('SELECT id FROM job_line_statuses WHERE counts_as_work_performed ORDER BY sort_order LIMIT 1')).rows[0].id;
const doneWo = (await db.pool.query(`SELECT id FROM work_order_statuses WHERE name = 'Done'`)).rows[0].id;
const effective = async (id) => (await db.pool.query(
  `SELECT ${db.WO_DONE_DATE_SQL}::text AS d, w.date_completed::text AS stored FROM work_orders w WHERE w.id = $1`, [id])).rows[0];

await cleanup();
try {
  const asset = (await db.pool.query('select id from assets limit 1')).rows[0];
  const { workOrderId: woId } = await db.createWorkOrder({ title: `${TAG} pump`, assetId: asset.id, priority: 'Medium' });
  const l1 = await db.createJobLine(woId, { title: `${TAG} line` });
  await db.pool.query('UPDATE job_lines SET completed_date = $2 WHERE id = $1', [l1.Id, '2026-10-28']);
  await db.updateJobLine(l1.Id, { status_id: done });

  console.log('## closing in arrears keeps the line’s date');
  await db.updateWorkOrder(woId, { status_id: doneWo });
  let e = await effective(woId);
  assert.equal(e.stored, '2026-10-28', 'close-out stamps the latest line date, not today');
  assert.equal(e.d, '2026-10-28');
  console.log('  ok');

  console.log('## an old auto-stamped close date gives way to the line date');
  await db.pool.query('UPDATE work_orders SET date_completed = $2, date_completed_manual = false WHERE id = $1', [woId, today]);
  e = await effective(woId);
  assert.equal(e.d, '2026-10-28');
  const detail = await db.getWorkOrderDetail(woId);
  assert.equal(String(detail.workOrder['Date Completed']).slice(0, 10), '2026-10-28');
  console.log('  ok');

  console.log('## a date typed on the work order wins; clearing it hands back');
  await db.updateWorkOrder(woId, { date_completed: '2026-10-30' });
  e = await effective(woId);
  assert.equal(e.d, '2026-10-30');
  await db.updateWorkOrder(woId, { date_completed: null });
  e = await effective(woId);
  assert.equal(e.d, '2026-10-28');
  assert.ok(e.stored, 'clearing keeps the stored close date as fallback');
  console.log('  ok');
} finally {
  await cleanup();
  const left = (await db.pool.query('SELECT count(*)::int n FROM work_orders WHERE title LIKE $1', [`${TAG}%`])).rows[0].n;
  assert.equal(left, 0, 'scratch work orders deleted');
}
console.log('all assertions passed');
await db.pool.end();
