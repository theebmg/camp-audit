// One-off: pull every row from every NocoDB table this app knows about and
// dump it to JSON files. Read-only against NocoDB — safe to re-run any time.
// Output feeds scripts/load-postgres.mjs. Output dir is gitignored (raw
// production data doesn't belong in the repo).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listRecords, TABLES } from '../src/nocodb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data-export');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  const summary = {};
  for (const [key, tableId] of Object.entries(TABLES)) {
    const rows = await listRecords(tableId, { limit: 10000 });
    fs.writeFileSync(path.join(OUT_DIR, `${key}.json`), JSON.stringify(rows, null, 2));
    summary[key] = rows.length;
    console.log(`${key}: ${rows.length} rows`);
  }
  fs.writeFileSync(path.join(OUT_DIR, '_summary.json'), JSON.stringify(summary, null, 2));
  console.log('\nDone. Exported to', OUT_DIR);
}

main().catch((e) => { console.error(e); process.exit(1); });
