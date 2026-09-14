// Build Brief v4, step 3 — cron entry point for the outbound Google
// Calendar sync worker, same pattern as cleanup-orphaned-uploads.js: a
// standalone script, invoked periodically via `docker exec camp-audit node
// scripts/gcal-sync-worker.js`, that connects, does one drain pass, and
// exits. All the actual logic lives in src/gcalSync.js, shared with the
// admin screen's "Sync now"/"Regenerate all events" buttons.
//
// Safe to run by hand any time: node scripts/gcal-sync-worker.js
import { runGcalSyncDrain } from '../src/gcalSync.js';
import { pool } from '../src/db.js';

runGcalSyncDrain()
  .then((result) => { console.log('gcal-sync-worker:', JSON.stringify(result)); })
  .catch((e) => { console.error('gcal-sync-worker: FAILED', e); process.exitCode = 1; })
  .finally(() => pool.end());
