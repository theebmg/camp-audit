// Do the old and new funding representations agree?
//
//   docker exec camp-audit node scripts/funding-reconcile.mjs
//
// Since 0116 a job line and a receipt split each carry funding twice: the old
// (funding_source, funding_ref_id) pair the application still reads, and funding_source_id into
// the one funding list. A trigger keeps them in step. This reads every row and reports any that
// disagree. It changes nothing. Exit code 1 if anything disagrees.
import * as db from '/app/src/db.js';

const result = await db.reconcileFunding();
let bad = 0;
for (const [table, r] of Object.entries(result)) {
  console.log(`${table}: ${r.rows} row(s), ${r.disagreements.length} disagreement(s)`);
  for (const d of r.disagreements) {
    bad += 1;
    console.log(`  #${d.id}: ${d.funding_source}/${d.funding_ref_id ?? '-'} is source ${d.funding_source_id ?? 'NULL'}, expected ${d.expected ?? 'NULL'}`);
  }
}
const { rows } = await db.pool.query(
  `SELECT fs.id, fs.name, fs.kind, p.name AS person, f.name AS fund,
          (SELECT count(*) FROM job_lines jl WHERE jl.funding_source_id = fs.id)::int AS lines,
          (SELECT count(*) FROM expense_allocations ea WHERE ea.funding_source_id = fs.id)::int AS splits,
          (SELECT count(*) FROM expenses e WHERE e.funding_source_id = fs.id)::int AS receipts
   FROM funding_sources fs
   LEFT JOIN people p ON p.id = fs.person_id LEFT JOIN funds f ON f.id = fs.fund_id
   ORDER BY fs.sort_order, fs.id`
);
console.log('\nThe funding list:');
for (const r of rows) {
  console.log(`  #${r.id} ${r.name} [${r.kind || 'unclassified'}]${r.person ? ` -> person ${r.person}` : ''}${r.fund ? ` -> fund ${r.fund}` : ''}`
    + ` · ${r.lines} job line(s), ${r.splits} split(s), ${r.receipts} receipt(s)`);
}
console.log(bad ? `\n${bad} DISAGREEMENT(S)` : '\nall rows agree');
await db.pool.end();
process.exit(bad ? 1 : 0);
