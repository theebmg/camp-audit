// End-to-end test of text intake (§3–§7) on scratch records, deleted afterwards.
//
//   docker exec camp-audit node scripts/intake-test.mjs
//
// Everything except a real Quo delivery is covered here, because the webhook is tested by
// signing a payload with a secret we set ourselves — the same HMAC the real sender uses. What
// is NOT covered without Ben's key is listed in docs/open-questions.md.
import crypto from 'crypto';
import * as db from '/app/src/db.js';
import { verifyQuoSignature } from '/app/src/routes/quo-inbound.js';

const TAG = 'ZZ-INTAKETEST';
const fail = [];
const ok = (cond, label) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}`); if (!cond) fail.push(label); };

console.log('## timestamps (§4) — America/New_York, never the server zone');
// 2026-07-04 21:30 Eastern is 2026-07-05 01:30 UTC. The date must stay the 4th.
const ninePmEastern = new Date('2026-07-05T01:30:00Z');
const parts = db.toEasternParts(ninePmEastern);
ok(parts.date === '2026-07-04', `a 9:30 PM text stays on its own day (got ${parts.date})`);
ok(parts.time.startsWith('21:30'), `and keeps its local time (got ${parts.time})`);
// And in winter, when the offset changes.
const winter = db.toEasternParts(new Date('2026-01-05T02:30:00Z'));
ok(winter.date === '2026-01-04', `the same holds across the DST boundary (got ${winter.date})`);

console.log('\n## hint parsing (§5) — the first word only, nothing else');
for (const [input, hint, display] of [
  ['visitor Chuck Davis came Thursday', 'visitor', 'Chuck Davis came Thursday'],
  ['Receipt: lumber yard $412', 'receipt', 'lumber yard $412'],
  ['FIX the sump pump is leaking', 'fix', 'the sump pump is leaking'],
  ['note new key code is 1234', 'note', 'new key code is 1234'],
  ['the gutter came loose again', null, 'the gutter came loose again'],
  ['visitors are here', null, 'visitors are here'],
]) {
  const r = db.parseIncomingHint(input);
  ok(r.hint === hint && r.display === display,
    `"${input.slice(0, 34)}" → hint ${JSON.stringify(r.hint)}, text "${r.display.slice(0, 30)}"`);
}

console.log('\n## phone matching (§3) — an allowlist that only matches one spelling is useless');
const forms = ['+15551234567', '(555) 123-4567', '555.123.4567', '5551234567', '1-555-123-4567'];
const normalized = forms.map(db.normalizePhone);
ok(new Set(normalized).size === 1, `every spelling normalizes the same (got ${JSON.stringify([...new Set(normalized)])})`);

console.log('\n## webhook signature (§3)');
const SECRET = 'test-secret-not-the-real-one';
const payload = JSON.stringify({ type: 'message.received', data: { from: '+15551234567', text: 'hello' } });
const rawBody = Buffer.from(payload);
const ts = Math.floor(Date.now() / 1000);
const sign = (body, t, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');

ok(verifyQuoSignature({ rawBody, signature: sign(rawBody, ts), timestamp: ts, secret: SECRET }).ok,
  'a correctly signed delivery is accepted');
ok(verifyQuoSignature({ rawBody, signature: `sha256=${sign(rawBody, ts)}`, timestamp: ts, secret: SECRET }).ok,
  'the sha256= prefixed form is accepted too');
ok(!verifyQuoSignature({ rawBody, signature: sign(rawBody, ts, 'wrong'), timestamp: ts, secret: SECRET }).ok,
  'a signature from the wrong secret is rejected');
ok(!verifyQuoSignature({ rawBody, signature: sign(Buffer.from('tampered'), ts), timestamp: ts, secret: SECRET }).ok,
  'a body that does not match its signature is rejected');
ok(!verifyQuoSignature({ rawBody, signature: sign(rawBody, ts), timestamp: ts, secret: null }).ok,
  'no configured secret means nothing is accepted');
ok(!verifyQuoSignature({ rawBody, signature: null, timestamp: ts, secret: SECRET }).ok,
  'an unsigned delivery is rejected');
const oldTs = ts - 3600;
ok(!verifyQuoSignature({ rawBody, signature: sign(rawBody, oldTs), timestamp: oldTs, secret: SECRET }).ok,
  'a correctly signed but hour-old delivery is rejected as a replay');

console.log('\n## allowlist (§3) — fails closed');
const before = await db.getTextIntakeSettings();
await db.updateTextIntakeSettings({ allowedSenders: [] });
ok(!await db.isAllowedSender('+15551234567'), 'an empty allowlist accepts nobody');
await db.updateTextIntakeSettings({ allowedSenders: ['(555) 123-4567'] });
ok(await db.isAllowedSender('+15551234567'), 'a number on the list is accepted in a different spelling');
ok(!await db.isAllowedSender('+15559999999'), 'a number not on the list is not');

console.log('\n## idempotency (§3) — a retry changes nothing');
const first = await db.createIncomingItem({
  externalId: `${TAG}-evt-1`, fromNumber: '+15551234567',
  bodyText: `visitor ${TAG} came by to check the roof`,
  receivedAt: ninePmEastern,
});
ok(first.Created === true, 'the first delivery creates an item');
ok(first.Item.Hint === 'visitor', 'and picks up its hint');
ok(first.Item.ReceivedDate === '2026-07-04', 'and stores the Eastern date, not the UTC one');
const retry = await db.createIncomingItem({
  externalId: `${TAG}-evt-1`, fromNumber: '+15551234567', bodyText: 'same delivery again',
  receivedAt: ninePmEastern,
});
ok(retry.Created === false, 'a retry does not create a second item');
ok(retry.Item.Id === first.Item.Id, 'and returns the original');
ok(retry.Item.BodyText === first.Item.BodyText, 'and does not overwrite what was stored');

console.log('\n## filing (§5)');
const person = await db.createPerson({ name: `${TAG} Visitor` });
const filed = await db.fileIncomingItem(first.Item.Id, {
  filedAs: 'visitor', personId: person.Id, visitDate: first.Item.ReceivedDate, by: 'intaketest',
});
ok(filed.Entity === 'visit', 'a visitor item becomes a visit');
const visit = await db.getVisit(filed.EntityId);
ok(visit.Source === 'text', 'the visit records that it came from a text');
ok(visit.CalledAhead === false, 'and defaults to no call, per §2');
ok(visit.VisitDate === '2026-07-04', 'and keeps the Eastern date');
const afterFile = await db.getIncomingItem(first.Item.Id);
ok(afterFile.Status === 'filed' && afterFile.FiledAs === 'visitor', 'the item is marked filed');
ok(afterFile.FiledBy === 'intaketest', 'and records who filed it');

console.log('\n## receipt filing goes where an emailed receipt goes');
const r2 = await db.createIncomingItem({
  externalId: `${TAG}-evt-2`, fromNumber: '+15551234567',
  bodyText: `receipt ${TAG} hardware store`, receivedAt: new Date(),
});
const receiptFiled = await db.fileIncomingItem(r2.Item.Id, { filedAs: 'receipt', vendor: `${TAG} Hardware`, amount: 42.5, by: 'intaketest' });
ok(receiptFiled.Entity === 'expense', 'a receipt item becomes an expense');
const exp = (await db.pool.query('select source, triage_status, incoming_item_id from expenses where id=$1', [receiptFiled.EntityId])).rows[0];
ok(exp.source === 'text', 'with source = text');
ok(exp.triage_status === 'inbox', 'landing in the triage inbox, like an emailed receipt');
ok(exp.incoming_item_id === r2.Item.Id, 'and linked back to the text it came from');

console.log('\n## Move to… (§6)');
const moved = await db.moveIncomingItem(r2.Item.Id, { filedAs: 'fix', by: 'intaketest' });
ok(moved.Entity === 'attachment_batch', 'a receipt can be moved to fix');
const movedItem = await db.getIncomingItem(r2.Item.Id);
ok(movedItem.FiledAs === 'fix', 'the item now reads as fix');
ok((movedItem.Moves || []).length === 1, 'and the move is recorded');
ok(movedItem.Moves[0].FromKind === 'receipt' && movedItem.Moves[0].ToKind === 'fix', 'with both ends of it');
const goneExpense = (await db.pool.query('select deleted_at from expenses where id=$1', [receiptFiled.EntityId])).rows[0];
ok(!!goneExpense.deleted_at, 'and the expense it used to be is removed');

console.log('\n## Move refuses to break a split receipt');
const r3 = await db.createIncomingItem({ externalId: `${TAG}-evt-3`, fromNumber: '+15551234567', bodyText: `receipt ${TAG} split one`, receivedAt: new Date() });
const splitFiled = await db.fileIncomingItem(r3.Item.Id, { filedAs: 'receipt', vendor: `${TAG} Split`, amount: 100, by: 'intaketest' });
// Two allocations = a split.
const wo = (await db.pool.query('select id from work_orders order by id desc limit 1')).rows[0];
if (wo) {
  await db.pool.query(`insert into expense_allocations (expense_id, dest_type, dest_id, amount, funding_source)
    values ($1,'work_order',$2,50,'operating_budget'), ($1,'work_order',$2,50,'operating_budget')`, [splitFiled.EntityId, wo.id]);
  const itemNow = await db.getIncomingItem(r3.Item.Id);
  const plan = await db.describeUnfilePlan(itemNow);
  ok(plan.CanRemove === false, 'a split receipt cannot be silently unfiled');
  ok(/split/i.test(plan.Reason || ''), `and the reason says why (${(plan.Reason || '').slice(0, 60)}…)`);
  const movedSplit = await db.moveIncomingItem(r3.Item.Id, { filedAs: 'note', assetId: (await db.pool.query('select id from assets limit 1')).rows[0].id, noteText: 'moved', by: 'intaketest' });
  ok(!!movedSplit.LeftBehind, 'the move still happens and says what it left behind');
  const stillThere = (await db.pool.query('select deleted_at from expenses where id=$1', [splitFiled.EntityId])).rows[0];
  ok(!stillThere.deleted_at, 'and the split expense is left intact rather than broken');
} else {
  console.log('  (skipped the split case — no work order to allocate against)');
}

console.log('\n## dismiss keeps the record (§5)');
const r4 = await db.createIncomingItem({ externalId: `${TAG}-evt-4`, fromNumber: '+15551234567', bodyText: `${TAG} never mind`, receivedAt: new Date() });
const dismissed = await db.dismissIncomingItem(r4.Item.Id, { by: 'intaketest' });
ok(dismissed.Status === 'dismissed', 'dismiss marks the item');
ok((await db.getIncomingItem(r4.Item.Id)) !== null, 'and does not delete it');

console.log('\n## cleanup');
await db.updateTextIntakeSettings({ allowedSenders: before.AllowedSenders, sendConfirmation: before.SendConfirmation });
const ids = (await db.pool.query('select id from incoming_items where external_id like $1', [`${TAG}%`])).rows.map((r) => r.id);
if (ids.length) {
  await db.pool.query('delete from visits where incoming_item_id = any($1::int[])', [ids]);
  await db.pool.query('delete from expense_allocations where expense_id in (select id from expenses where incoming_item_id = any($1::int[]))', [ids]);
  await db.pool.query('delete from expenses where incoming_item_id = any($1::int[])', [ids]);
  await db.pool.query('delete from attachment_batches where incoming_item_id = any($1::int[])', [ids]);
  await db.pool.query('delete from asset_notes where note = $1', ['moved']);
  await db.pool.query('delete from incoming_items where id = any($1::int[])', [ids]);
}
await db.pool.query('delete from people where name like $1', [`${TAG}%`]);
await db.pool.query('delete from activity_log where entity_label like $1', [`${TAG}%`]);
const left = (await db.pool.query(
  `select (select count(*) from incoming_items where external_id like $1) i,
          (select count(*) from people where name like $1) p,
          (select count(*) from expenses where vendor like $1) e`, [`${TAG}%`]
)).rows[0];
ok(Number(left.i) + Number(left.p) + Number(left.e) === 0,
  `scratch records deleted (items ${left.i}, people ${left.p}, expenses ${left.e})`);

console.log(`\n${fail.length ? `${fail.length} FAILURE(S): ` + fail.join(' | ') : 'all assertions passed'}`);
process.exit(fail.length ? 1 : 0);
