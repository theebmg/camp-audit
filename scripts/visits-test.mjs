// End-to-end test of the visitor log (§2) on scratch records, deleted afterwards.
//
//   docker exec camp-audit node scripts/visits-test.mjs
//
// Covers: a calendar visit event becoming an expected visit, the projection being idempotent,
// the "Did they show up?" queue, all three answers (yes / no / different day), the
// already-expected match, group headcounts, and Visitor Activity reading the log rather than
// the calendar. Everything it writes is named ZZ-VISITTEST.
import * as db from '/app/src/db.js';
import { buildVisitorActivityReportPg } from '/app/src/reportDataPg.js';

const TAG = 'ZZ-VISITTEST';
const fail = [];
const ok = (cond, label) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}`); if (!cond) fail.push(label); };
const iso = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n) => iso(new Date(Date.now() + n * 86400000));

console.log('## setup');
// A person who holds a cabin (so the report's Cabin Holders split is exercised) and one who
// does not, plus a group.
const holding = (await db.pool.query(
  `select ch.id, ch.name, (select a.id from assets a where a.cabin_holder_id = ch.id limit 1) asset_id
   from cabin_holders ch where exists (select 1 from assets a where a.cabin_holder_id = ch.id) limit 1`
)).rows[0];
const holder = await db.createPerson({ name: `${TAG} Holder`, cabinHolderIds: [holding.id] });
const plain = await db.createPerson({ name: `${TAG} Plain` });
const group = await db.createGroup({ name: `${TAG} Youth Group`, typeId: 1 });
ok(holder.IsCabinHolder === true, 'the holder person is a derived cabin holder');
ok(plain.IsCabinHolder === false, 'the other person is not');

// A calendar visit event in the PAST (so it lands in the queue) and one in the future.
const past = daysFromNow(-4);
const future = daysFromNow(6);
const evPast = (await db.pool.query(
  `insert into calendar_events (title, event_date, type_id, person_id, visit_purpose)
   values ($1, $2, 1, $3, $4) returning id`,
  [`${TAG} past visit`, past, holder.Id, `${TAG} reason`]
)).rows[0];
const evFuture = (await db.pool.query(
  `insert into calendar_events (title, event_date, type_id, group_id, visit_purpose)
   values ($1, $2, 3, $3, $4) returning id`,
  [`${TAG} future group visit`, future, group.Id, `${TAG} reason`]
)).rows[0];
console.log(`  events #${evPast.id} (${past}) and #${evFuture.id} (${future})`);

console.log('\n## calendar projection');
const r1 = await db.projectCalendarVisits({ from: daysFromNow(-30), to: daysFromNow(30) });
console.log(`  projected ${r1.Projected}, skipped ${r1.Skipped.length}`);
const mine = async () => (await db.pool.query(
  `select v.*, v.visit_date::text d from visits v where v.calendar_event_id = any($1::int[]) order by v.visit_date`,
  [[evPast.id, evFuture.id]]
)).rows;
let vs = await mine();
ok(vs.length === 2, `both events made a visit (got ${vs.length})`);
ok(vs.every((v) => v.status === 'expected'), 'both are expected');
ok(vs.every((v) => v.called_ahead === true), 'both are called_ahead = true, because scheduling IS calling ahead');
ok(vs.every((v) => v.source === 'calendar'), 'both have source = calendar');

// Idempotency: running it again must not duplicate.
await db.projectCalendarVisits({ from: daysFromNow(-30), to: daysFromNow(30) });
vs = await mine();
ok(vs.length === 2, `re-running the projection did not duplicate (still ${vs.length})`);

console.log('\n## the "Did they show up?" queue');
const awaiting = await db.listVisitsAwaitingConfirmation();
const pastVisit = awaiting.find((v) => v.CalendarEventId === evPast.id);
ok(!!pastVisit, 'the past event is in the queue');
ok(!awaiting.some((v) => v.CalendarEventId === evFuture.id), 'the future event is NOT in the queue yet');

console.log('\n## answer: different day');
const corrected = daysFromNow(-3);
const conf = await db.confirmVisit(pastVisit.Id, { showedUp: true, visitDate: corrected, arrivalTime: '14:30', durationMinutes: 90, by: 'visitstest' });
ok(conf.Status === 'confirmed', 'status is confirmed');
ok(conf.VisitDate === corrected, `date corrected to ${corrected} (got ${conf.VisitDate})`);
ok(conf.ArrivalTime === '14:30', `arrival time recorded (got ${conf.ArrivalTime})`);
ok(conf.ConfirmedBy === 'visitstest', 'records who confirmed it');
ok(!(await db.listVisitsAwaitingConfirmation()).some((v) => v.Id === pastVisit.Id), 'it left the queue');

// And the projection must not undo that correction.
await db.projectCalendarVisits({ from: daysFromNow(-30), to: daysFromNow(30) });
const after = (await db.pool.query('select visit_date::text d, status from visits where id=$1', [pastVisit.Id])).rows[0];
ok(after.d === corrected && after.status === 'confirmed',
  `re-projecting did not rewrite a confirmed visit (date ${after.d}, status ${after.status})`);

console.log('\n## answer: no-show');
const gv = (await mine()).find((v) => v.calendar_event_id === evFuture.id);
const noShow = await db.confirmVisit(gv.id, { showedUp: false, by: 'visitstest' });
ok(noShow.Status === 'no_show', 'status is no_show');
ok((await db.getGroup(group.Id)).VisitCount === 0, 'a no-show does not count as a group visit');

console.log('\n## already-expected match');
const expectedSoon = await db.createVisit({
  personId: plain.Id, visitDate: daysFromNow(-1), status: 'expected', source: 'calendar',
});
const match = await db.findMatchingExpectedVisit({ personId: plain.Id, visitDate: daysFromNow(0) });
ok(match && match.Id === expectedSoon.Id, 'a visit one day off matches the expectation');
const noMatch = await db.findMatchingExpectedVisit({ personId: plain.Id, visitDate: daysFromNow(9) });
ok(!noMatch, 'a visit nine days off does not');

console.log('\n## manual and text visits default called_ahead = no');
const manual = await db.createVisit({ personId: plain.Id, visitDate: daysFromNow(-2), source: 'manual', reason: `${TAG} manual` });
ok(manual.CalledAhead === false, 'a manual visit defaults to no call');
ok(manual.Status === 'confirmed', 'and is confirmed, because it already happened');
const texted = await db.createVisit({ personId: plain.Id, visitDate: daysFromNow(-2), source: 'text', reason: `${TAG} text` });
ok(texted.CalledAhead === false, 'a texted visit defaults to no call');

console.log('\n## group headcount');
const gVisit = await db.createVisit({ groupId: group.Id, visitDate: daysFromNow(-2), headcount: 15, source: 'manual', reason: `${TAG} group` });
ok(gVisit.Headcount === 15, 'headcount stored');
const gAfter = await db.getGroup(group.Id);
ok(gAfter.VisitCount === 1, `group shows 1 confirmed visit (got ${gAfter.VisitCount})`);
ok(gAfter.TypicalHeadcount === 15, `group shows a typical headcount (got ${gAfter.TypicalHeadcount})`);

console.log('\n## person profile visit history');
const holderAfter = await db.getPerson(holder.Id);
ok(holderAfter.VisitCount === 1, `holder has 1 confirmed visit (got ${holderAfter.VisitCount})`);
ok(holderAfter.Visits.length >= 1, 'and the visit list is populated');
ok(holderAfter.LastVisit === corrected, `last visit is the corrected date (got ${holderAfter.LastVisit})`);

console.log('\n## Visitor Activity reads the visit log');
const report = await buildVisitorActivityReportPg({ from: daysFromNow(-30), to: daysFromNow(1) });
const inHolders = report.holders.find((h) => h.name === `${TAG} Holder`);
const inOther = report.oneOff.find((h) => h.name === `${TAG} Plain`);
const groupInOther = report.oneOff.find((h) => h.name === `${TAG} Youth Group`);
ok(!!inHolders, 'the cabin holder appears under Cabin Holders');
ok(!!inOther, 'the non-holder appears under Other Visitors');
ok(!!groupInOther, 'the group appears under Other Visitors');
ok(groupInOther && groupInOther.isGroup === true, 'and is flagged as a group');
ok(groupInOther && groupInOther.typicalHeadcount === 15, 'with its typical headcount');
ok(!report.oneOff.some((h) => h.name === `${TAG} Youth Group` && h.visitCount > 1), 'the no-show is not counted');
ok(report.groupVisits >= 1, 'the report reports group visits separately');

console.log('\n## cleanup');
await db.pool.query('delete from visits where person_id in (select id from people where name like $1) or group_id in (select id from groups where name like $1)', [`${TAG}%`]);
await db.pool.query('delete from calendar_events where title like $1', [`${TAG}%`]);
await db.pool.query('delete from groups where name like $1', [`${TAG}%`]);
await db.pool.query('delete from people where name like $1', [`${TAG}%`]);
await db.pool.query('delete from activity_log where entity_label like $1', [`${TAG}%`]);
const left = (await db.pool.query(
  `select (select count(*) from people where name like $1) p,
          (select count(*) from groups where name like $1) g,
          (select count(*) from visits v where v.reason like $1) v,
          (select count(*) from calendar_events where title like $1) e`, [`${TAG}%`]
)).rows[0];
ok(Number(left.p) + Number(left.g) + Number(left.v) + Number(left.e) === 0,
  `scratch records deleted (people ${left.p}, groups ${left.g}, visits ${left.v}, events ${left.e})`);

console.log(`\n${fail.length ? `${fail.length} FAILURE(S): ` + fail.join(' | ') : 'all assertions passed'}`);
process.exit(fail.length ? 1 : 0);
