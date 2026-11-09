// Texted receipt → work order / job line (Nov 2026). Scratch records only, all deleted at the
// end (asserted). Covers: existing-charge lookup on a WO vs a line, filing as a new charge with
// payer + destination, filing onto an existing charge (photo only), and that moving a receipt
// filed onto an existing charge takes the photo back off without deleting the charge.
//
//   docker exec camp-audit node scripts/receipt-to-wo-test.mjs
import assert from 'node:assert/strict';
import * as db from '/app/src/db.js';

const TAG = '__receipt_to_wo_test__';
const scratch = { items: [], attachments: [] };
async function cleanup() {
  const exp = `SELECT id FROM expenses WHERE vendor LIKE '${TAG}%'`;
  await db.pool.query(`DELETE FROM attachment_links WHERE entity_type = 'expense' AND entity_id IN (${exp})`);
  await db.pool.query(`DELETE FROM expense_allocations WHERE expense_id IN (${exp})`);
  await db.pool.query(`DELETE FROM savings_entries WHERE source_type = 'expense' AND source_id IN (${exp})`).catch(() => {});
  if (scratch.items.length) {
    await db.pool.query('DELETE FROM incoming_moves WHERE item_id = ANY($1::int[])', [scratch.items]).catch(() => {});
    await db.pool.query(`DELETE FROM attachment_links WHERE entity_type = 'incoming_item' AND entity_id = ANY($1::int[])`, [scratch.items]);
    await db.pool.query('UPDATE expenses SET incoming_item_id = NULL WHERE incoming_item_id = ANY($1::int[])', [scratch.items]);
  }
  await db.pool.query(`DELETE FROM expenses WHERE vendor LIKE $1`, [`${TAG}%`]);
  if (scratch.items.length) await db.pool.query('DELETE FROM incoming_items WHERE id = ANY($1::int[])', [scratch.items]);
  if (scratch.attachments.length) {
    await db.pool.query('DELETE FROM attachment_links WHERE attachment_id = ANY($1::int[])', [scratch.attachments]);
    await db.pool.query('DELETE FROM attachments WHERE id = ANY($1::int[])', [scratch.attachments]);
  }
  await db.pool.query('DELETE FROM job_lines WHERE work_order_id IN (SELECT id FROM work_orders WHERE title LIKE $1)', [`${TAG}%`]);
  await db.pool.query('DELETE FROM work_order_log_entries WHERE work_order_id IN (SELECT id FROM work_orders WHERE title LIKE $1)', [`${TAG}%`]);
  await db.pool.query('DELETE FROM work_orders WHERE title LIKE $1', [`${TAG}%`]);
  await db.pool.query('DELETE FROM activity_log WHERE entity_label LIKE $1', [`${TAG}%`]);
}
async function newItem() {
  const { rows } = await db.pool.query(
    `INSERT INTO incoming_items (source, body_text, received_at, received_date, received_time)
     VALUES ('manual', $1, now(), CURRENT_DATE, '12:00') RETURNING id`, [`${TAG} receipt text`]);
  const id = rows[0].id; scratch.items.push(id);
  const a = await db.createAttachment({ url: 'https://example.invalid/r.jpg', thumbUrl: null, kind: 'image', mimeType: 'image/jpeg' });
  scratch.attachments.push(a.Id);
  await db.linkAttachment(a.Id, { entityType: 'incoming_item', entityId: id });
  return { id, attachmentId: a.Id };
}
const photosOn = async (expenseId) => (await db.pool.query(
  `SELECT count(*)::int n FROM attachment_links WHERE entity_type = 'expense' AND entity_id = $1`, [expenseId])).rows[0].n;

await cleanup();
try {
  const asset = (await db.pool.query('select id from assets limit 1')).rows[0];
  const { workOrderId: woId } = await db.createWorkOrder({ title: `${TAG} WO`, assetId: asset.id, priority: 'Medium' });
  const l1 = await db.createJobLine(woId, { title: `${TAG} line 1` });
  const l2 = await db.createJobLine(woId, { title: `${TAG} line 2` });
  const onLine = await db.createExpense({ vendor: `${TAG} Ace`, amount: 42.6, purchaseDate: '2026-11-01', jobLineId: l1.Id });
  const onWo = await db.createExpense({ vendor: `${TAG} Lowes`, amount: 100, purchaseDate: '2026-11-02', workOrderId: woId });

  console.log('## existing charges: a work order sees its own and its lines’; a line sees only its own');
  const forWo = await db.listExistingChargesFor({ workOrderId: woId });
  assert.deepEqual(forWo.map((c) => c.Id).sort(), [onLine.Id, onWo.Id].sort());
  assert.deepEqual((await db.listExistingChargesFor({ jobLineId: l1.Id })).map((c) => c.Id), [onLine.Id]);
  assert.equal((await db.listExistingChargesFor({ jobLineId: l2.Id })).length, 0);
  console.log('  ok');

  console.log('## a new charge: payer + job line, triaged because it has an amount and a place');
  const payer = (await db.pool.query('SELECT id FROM funding_sources ORDER BY id LIMIT 1')).rows[0]?.id || null;
  const it1 = await newItem();
  const f1 = await db.fileIncomingItem(it1.id, { filedAs: 'receipt', vendor: `${TAG} Tractor Supply`, amount: 18.5,
    purchaseDate: '2026-11-03', fundingSourceId: payer, workOrderId: woId, jobLineId: l2.Id });
  assert.equal(f1.Entity, 'expense');
  const e1 = (await db.pool.query('SELECT triage_status, funding_source_id FROM expenses WHERE id = $1', [f1.EntityId])).rows[0];
  assert.equal(e1.triage_status, 'triaged');
  if (payer) assert.equal(e1.funding_source_id, payer);
  assert.deepEqual((await db.listExistingChargesFor({ jobLineId: l2.Id })).map((c) => c.Id), [f1.EntityId]);
  assert.equal(await photosOn(f1.EntityId), 1);
  console.log('  ok');

  console.log('## "it’s one of these": only the photo is added, no second expense');
  const before = (await db.pool.query(`SELECT count(*)::int n FROM expenses WHERE vendor LIKE $1 AND deleted_at IS NULL`, [`${TAG}%`])).rows[0].n;
  const it2 = await newItem();
  const f2 = await db.fileIncomingItem(it2.id, { filedAs: 'receipt', existingExpenseId: onLine.Id });
  assert.equal(f2.Entity, 'expense_receipt');
  assert.equal(f2.EntityId, onLine.Id);
  assert.equal(await photosOn(onLine.Id), 1);
  const after = (await db.pool.query(`SELECT count(*)::int n FROM expenses WHERE vendor LIKE $1 AND deleted_at IS NULL`, [`${TAG}%`])).rows[0].n;
  assert.equal(after, before, 'no new expense');
  console.log('  ok');

  console.log('## moving it elsewhere takes the photo back off and keeps the charge');
  await db.moveIncomingItem(it2.id, { filedAs: 'fix', workOrderId: null });
  assert.equal(await photosOn(onLine.Id), 0);
  const kept = (await db.pool.query('SELECT deleted_at FROM expenses WHERE id = $1', [onLine.Id])).rows[0];
  assert.equal(kept.deleted_at, null, 'the existing charge was not deleted');
  console.log('  ok');
} finally {
  // The fix move above made an attachment batch for the scratch item.
  if (scratch.items.length) {
    await db.pool.query(`DELETE FROM attachment_links WHERE entity_type = 'attachment_batch' AND entity_id IN (SELECT id FROM attachment_batches WHERE incoming_item_id = ANY($1::int[]))`, [scratch.items]).catch(() => {});
    await db.pool.query('DELETE FROM attachment_batches WHERE incoming_item_id = ANY($1::int[])', [scratch.items]);
  }
  await cleanup();
  const left = (await db.pool.query(
    `SELECT (SELECT count(*) FROM work_orders WHERE title LIKE $1) + (SELECT count(*) FROM expenses WHERE vendor LIKE $1)
          + (SELECT count(*) FROM incoming_items WHERE body_text LIKE $1) AS n`, [`${TAG}%`])).rows[0].n;
  assert.equal(Number(left), 0, 'scratch records deleted');
}
console.log('all assertions passed');
await db.pool.end();
