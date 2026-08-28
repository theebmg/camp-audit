// Applies migrations/*.sql to the `camp` database in filename order, tracking
// what's already applied in schema_migrations. Each migration runs in its own
// transaction. Run with: npm run migrate
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(r => r.version));

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let ranAny = false;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`Applying ${file} ...`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  OK`);
        ranAny = true;
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(`  FAILED: ${e.message}`);
        process.exitCode = 1;
        return;
      }
    }
    if (!ranAny) console.log('Nothing to apply — schema is up to date.');
  } finally {
    client.release();
    await pool.end();
  }
}

main();
