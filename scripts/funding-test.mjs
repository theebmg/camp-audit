// One funding list (0116/0117), exercised end to end on scratch records that are deleted
// afterwards.
//
//   docker exec camp-audit node scripts/funding-test.mjs
//
// Proves: a job line can name a person as its funder; the database turns ('person', id) into
// that person's funder row; duplicating a work order carries the funder through; the WO rollup
// names the person; a merge moves the funding with the person; a funder in use cannot be deleted;
// and the old and new representations agree throughout.
import * as db from '/app/src/db.js';

const TAG = 'ZZ-FUNDTEST';
const fail = [];
const ok = (cond, label) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}`); if (!cond) fail.push(label); };
const q = (sql, vals) => db.pool.query(sql, vals).then((r) => r.rows);
const before = (await q('select count(*)::int n from funding_sources'))[0].n;

console.log('## setup');
const payer = await db.createPerson({ name: `${TAG} Payer` });
const other = await db.createPerson({ name: `${TAG} Other` });
const asset = (await q('select id from assets limit 1'))[0];
const { workOrderId: wo } = await db.createWorkOrder({
  title: `${TAG} work order`, assetId: asset.id, priority: 'Low',
  jobLines: [
    { title: `${TAG} paid by a person`, fundingSource: 'person', fundingRefId: payer.Id, estimatedCost: 100 },
    { title: `${TAG} camp`, fundingSource: 'operating_budget' },
  ],
});
const lines = await db.listJobLines(wo);
const pl = lines.find((l) => l.Title.includes('paid by a person'));

console.log('\n## a person as funder');
const funder = (await q('select * from funding_sources where person_id = $1', [payer.Id]))[0];
ok(!!funder, 'a funder row was made for the person on first use');
ok(funder && funder.kind === 'person' && funder.counts_as_camp_spend === false, 'it is a contribution, not camp spend');
ok(pl.FundingSource === 'funder' && pl.FundingRefId === funder?.id, `the line stores ('funder', row id), never 'person' (got ${pl.FundingSource}/${pl.FundingRefId})`);
ok(pl.FundingRefLabel === `${TAG} Payer`, `and is labelled with the person's name (got ${pl.FundingRefLabel})`);
const raw = (await q('select funding_source_id from job_lines where id = $1', [pl.Id]))[0];
ok(raw.funding_source_id === funder?.id, 'funding_source_id points at the same row');

console.log('\n## a second line for the same person reuses the row');
const second = await db.createJobLine(wo, { title: `${TAG} second`, fundingSource: 'person', fundingRefId: payer.Id });
ok((await q('select count(*)::int n from funding_sources where person_id = $1', [payer.Id]))[0].n === 1, 'still one funder row');
ok(second.FundingRefId === funder?.id, 'and the new line points at it');

console.log('\n## changing a line');
await db.updateJobLine(pl.Id, { funding_source: 'operating_budget', funding_ref_id: null });
ok((await q('select funding_source_id from job_lines where id = $1', [pl.Id]))[0].funding_source_id
  === (await q(`select id from funding_sources where kind = 'camp_general'`))[0].id, 'back to camp: funding_source_id follows');
await db.updateJobLine(pl.Id, { funding_source: 'person', funding_ref_id: payer.Id });
ok((await q('select funding_source, funding_source_id from job_lines where id = $1', [pl.Id]))[0].funding_source_id === funder?.id,
  'and back to the person');

console.log('\n## rollup, options, ledger');
const rollup = await db.workOrderRollup(wo);
ok(rollup.FundingBreakdown.some((f) => f.FundingSource === 'funder' && f.FundingRefLabel === `${TAG} Payer`),
  'the work order rollup names the person');
const opts = await db.listFundingOptions();
ok(opts.options.some((o) => o.value === `person::${payer.Id}`), 'the person is offered in the picker');
ok(opts.aliases[`funder::${funder?.id}`] === `person::${payer.Id}`, 'and a line saved against them opens showing them');
const overview = await db.getBudgetOverview();
const ledger = (overview.Funders || []).find((f) => f.Id === funder?.id);
ok(!!ledger && ledger.Items.length === 2, `Capital Plan lists what they fund (got ${ledger ? ledger.Items.length : 'no entry'})`);
const profile = await db.getPerson(payer.Id);
ok(profile.FundedLines.length === 2, `their profile lists the lines they fund (got ${profile.FundedLines.length})`);

console.log('\n## duplicate carries the funder');
const dup = await db.duplicateWorkOrder(wo);
const dupId = dup?.workOrderId ?? dup?.Id ?? dup?.id ?? dup;
const dupLines = await q('select funding_source, funding_ref_id, funding_source_id from job_lines where work_order_id = $1 order by sort_order, id', [dupId]);
ok(dupLines.length >= 2 && dupLines[0].funding_source === 'funder' && dupLines[0].funding_source_id === funder?.id,
  'the copy is funded by the same person');

console.log('\n## guards');
try { await q('delete from funding_sources where id = $1', [funder.id]); ok(false, 'a funder in use cannot be deleted'); }
catch { ok(true, 'a funder in use cannot be deleted'); }
try { await db.updateJobLine(pl.Id, { funding_source: 'funder', funding_ref_id: 99999999 }); ok(false, 'a funder that does not exist is refused'); }
catch { ok(true, 'a funder that does not exist is refused'); }

console.log('\n## merge moves the funding with the person');
await db.mergePeople({ keptId: other.Id, removedId: payer.Id, by: 'fundtest' });
ok((await q('select person_id from funding_sources where id = $1', [funder.id]))[0].person_id === other.Id, 'the funder row now belongs to the kept person');
ok((await db.getPerson(other.Id)).FundedLines.length >= 2, 'and the kept person shows the funded lines');
ok((await db.getJobLine(pl.Id)).FundingRefLabel === `${TAG} Other`, 'and the line is labelled with the kept person');

console.log('\n## the two representations agree');
const rec = await db.reconcileFunding();
ok(rec.job_lines.disagreements.length === 0 && rec.expense_allocations.disagreements.length === 0, 'no disagreements anywhere');

console.log('\n## cleanup');
await q('delete from work_orders where id = any($1::int[])', [[wo, dupId].filter(Boolean)]);
await q('delete from job_lines where title like $1', [`${TAG}%`]);
await q('delete from funding_sources where id = $1', [funder.id]);
await q('delete from record_merges where removed_name like $1', [`${TAG}%`]);
await q('delete from people where name like $1', [`${TAG}%`]);
await q('delete from activity_log where entity_label like $1', [`${TAG}%`]);
const left = (await q(
  `select (select count(*) from people where name like $1)::int + (select count(*) from work_orders where title like $1)::int
        + (select count(*) from job_lines where title like $1)::int as n`, [`${TAG}%`]))[0].n;
ok(left === 0, 'scratch records deleted');
ok((await q('select count(*)::int n from funding_sources'))[0].n === before, `funding list is back to ${before} rows`);
console.log(`\n${fail.length ? `${fail.length} FAILURE(S): ` + fail.join(' | ') : 'all assertions passed'}`);
await db.pool.end();
process.exit(fail.length ? 1 : 0);
