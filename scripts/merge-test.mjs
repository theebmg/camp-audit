// Merge test on scratch records, deleted afterwards. Proves the four things Ben asked a merge
// to guarantee: funding history, visits, cabin links and group contacts all move, and zero
// references to the removed person remain.
//
//   docker exec camp-audit node scripts/merge-test.mjs
//
// Note on funding: a merge deliberately does NOT move funding, because funding points at cabin
// HOLDINGS (funding_source = 'cabin_holder' + funding_ref_id), not at people. The holdings move
// with the person via cabin_holder_people, so the funding follows without being touched — and
// the test asserts cabin_holders and the asset links are unchanged, which is the proof.
//
// Everything it writes is named ZZ-MERGETEST and removed at the end.
import * as db from '/app/src/db.js';

const TAG = 'ZZ-MERGETEST';
const fail = [];
const ok = (cond, label) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}`); if (!cond) fail.push(label); };

// Two real holdings to link, and a real asset behind them.
const holdings = (await db.pool.query(
  `select ch.id, ch.name from cabin_holders ch
   where exists (select 1 from assets a where a.cabin_holder_id = ch.id) order by ch.id limit 3`
)).rows;
const [h1, h2, h3] = holdings;

console.log('## setup');
const keep = await db.createPerson({
  name: `${TAG} Keep`, phone: '555-0001', roleIds: [1], cabinHolderIds: [h1.id],
});
const drop = await db.createPerson({
  name: `${TAG} Drop`, phone: '555-0002',
  // Role 1 overlaps with keep (tests the union path); role 2 is unique to drop (tests the move).
  roleIds: [1, 2],
  // h1 overlaps with keep; h2 is unique to drop.
  cabinHolderIds: [h1.id, h2.id],
});
console.log(`  keep #${keep.Id}, drop #${drop.Id}; holdings ${h1.id}/${h2.id}`);

// A visit on each, a calendar visit event on drop, and a group whose contact is drop.
await db.pool.query(
  `insert into visits (person_id, visit_date, source, status, reason)
   values ($1, current_date - 5, 'manual', 'confirmed', $3), ($2, current_date - 3, 'manual', 'confirmed', $3),
          ($2, current_date - 1, 'manual', 'expected', $3)`,
  [keep.Id, drop.Id, `${TAG} visit`]
);
const ev = await db.pool.query(
  `insert into calendar_events (title, event_date, type_id, person_id, visitor_name)
   values ($1, current_date + 7, 1, $2, $3) returning id`,
  [`${TAG} event`, drop.Id, `${TAG} Drop`]
);
const grp = await db.createGroup({ name: `${TAG} Group`, typeId: 1, contactPersonId: drop.Id });

const before = {
  keepVisits: (await db.pool.query('select count(*)::int n from visits where person_id=$1', [keep.Id])).rows[0].n,
  dropVisits: (await db.pool.query('select count(*)::int n from visits where person_id=$1', [drop.Id])).rows[0].n,
};
console.log(`  visits before: keep=${before.keepVisits} drop=${before.dropVisits}`);

console.log('\n## merge');
const result = await db.mergePeople({ keptId: keep.Id, removedId: drop.Id, by: 'mergetest' });
console.log('  repointed:', JSON.stringify(result.Repointed));

console.log('\n## assertions');
const after = await db.getPerson(keep.Id);
ok(after !== null, 'kept person still exists');
ok((await db.pool.query('select count(*)::int n from people where id=$1', [drop.Id])).rows[0].n === 0,
  'removed person is gone');

// Visits moved.
const visits = (await db.pool.query('select count(*)::int n from visits where person_id=$1', [keep.Id])).rows[0].n;
ok(visits === before.keepVisits + before.dropVisits, `all ${before.keepVisits + before.dropVisits} visits moved to the kept person (got ${visits})`);
ok(after.VisitCount === 2, `visit count counts confirmed only, not the expected one (got ${after.VisitCount})`);

// Roles unioned: drop had 1+2, keep had 1 → keep should now have both.
const roles = after.Roles.map((r) => r.Id).sort();
ok(roles.length === 2 && roles[0] === 1 && roles[1] === 2, `roles unioned to both (got ${JSON.stringify(roles)})`);

// Holdings unioned: drop had h1+h2, keep had h1 → keep should now have both.
const holdingIds = after.Holdings.map((h) => h.Id).sort((a, b) => a - b);
ok(holdingIds.length === 2 && holdingIds.includes(h1.id) && holdingIds.includes(h2.id),
  `holdings unioned to both (got ${JSON.stringify(holdingIds)})`);
ok(after.IsCabinHolder === true, 'derived cabin-holder role is true');
ok(after.Cabins.length > 0, `cabins come through the holdings (got ${after.Cabins.length})`);

// Calendar event and group contact repointed.
ok((await db.pool.query('select person_id from calendar_events where id=$1', [ev.rows[0].id])).rows[0].person_id === keep.Id,
  'calendar visit event repointed');
ok((await db.getGroup(grp.Id)).ContactPersonId === keep.Id, 'group contact repointed');

// Zero references anywhere to the removed id — the requirement, checked independently of the
// merge's own internal check.
const refs = [
  ['visits', 'person_id'], ['calendar_events', 'person_id'], ['groups', 'contact_person_id'],
  ['person_role_assignments', 'person_id'], ['cabin_holder_people', 'person_id'],
];
let leftover = 0;
for (const [t, c] of refs) {
  const n = (await db.pool.query(`select count(*)::int n from ${t} where ${c} = $1`, [drop.Id])).rows[0].n;
  if (n) { console.log(`    !! ${t}.${c} still has ${n}`); leftover += n; }
}
ok(leftover === 0, 'zero references remain to the removed person');

// Holdings themselves untouched — a merge is about people, not holdings.
ok((await db.pool.query('select count(*)::int n from cabin_holders')).rows[0].n === 173, 'cabin_holders count unchanged (173)');
ok((await db.pool.query('select count(*)::int n from assets where cabin_holder_id is not null')).rows[0].n === 174,
  'asset holder links unchanged (174)');

// The merge was logged.
const merges = await db.listRecordMerges({ kind: 'person', limit: 5 });
const logged = merges.find((m) => m.RemovedId === drop.Id);
ok(!!logged, 'merge was written to record_merges');
ok(logged && logged.MergedBy === 'mergetest', 'merge records who did it');
ok(logged && Object.keys(logged.Repointed).length > 0, 'merge records what was repointed');

// Merging a record into itself is refused.
try { await db.mergePeople({ keptId: keep.Id, removedId: keep.Id }); ok(false, 'self-merge refused'); }
catch { ok(true, 'self-merge refused'); }

console.log('\n## duplicate check');
const dups = await db.findDuplicatePeople('Jen Lapp');
const hit = dups.find((d) => d.Name === 'Lapp, Jen');
ok(!!hit, `"Jen Lapp" finds "Lapp, Jen" (got ${dups.slice(0, 3).map((d) => d.Name).join(', ') || 'nothing'})`);
ok(hit && hit.MatchScore === 100, 'and scores it as the same name written differently');
ok(hit && hit.Cabins.length > 0, `and shows the cabin for "Did you mean…?" (${hit ? hit.Cabins.map((c) => c.Name).join(', ') : ''})`);
const sandy = await db.findDuplicatePeople('Spain, Sandy');
const randy = sandy.find((d) => d.Name === 'Spain, Randy');
ok(!randy || randy.MatchScore < 100, 'Sandy Spain is NOT reported as the same person as Randy Spain');

console.log('\n## cleanup');
await db.pool.query('delete from visits where reason = $1', [`${TAG} visit`]);
await db.pool.query('delete from calendar_events where title = $1', [`${TAG} event`]);
await db.pool.query('delete from groups where name = $1', [`${TAG} Group`]);
await db.pool.query('delete from record_merges where removed_name like $1', [`${TAG}%`]);
await db.pool.query('delete from people where name like $1', [`${TAG}%`]);
await db.pool.query('delete from activity_log where entity_label like $1', [`${TAG}%`]);
const left = (await db.pool.query('select count(*)::int n from people where name like $1', [`${TAG}%`])).rows[0].n;
ok(left === 0, 'scratch records deleted');
console.log(`\n${fail.length ? `${fail.length} FAILURE(S): ` + fail.join(' | ') : 'all assertions passed'}`);
process.exit(fail.length ? 1 : 0);
