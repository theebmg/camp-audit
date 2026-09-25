// Fixture data for the mobile audit's field screens.
//
// Half the screens the audit has to cover cannot be reached with an empty database: the
// runner needs a round, the split editor needs a receipt with line items, the leftover
// prompt needs a job with materials on it. Rather than hand-build that every time, this
// makes it — and, more importantly, takes it away again.
//
// Everything it writes is named with the tag below, and `delete` removes exactly the rows
// carrying that tag. Nothing real is touched, because nothing real is named "[FIXTURE] …".
//
//   docker exec camp-audit node scripts/fixtures.mjs create
//   docker exec camp-audit node scripts/fixtures.mjs list
//   docker exec camp-audit node scripts/fixtures.mjs delete
//
// Runs inside the container because that is where DATABASE_URL lives; it imports the same
// db.js the app does, so a fixture goes through the same code paths a real record would
// and cannot drift from them.
import { pool } from '../src/db.js';
import * as db from '../src/db.js';

const TAG = '[FIXTURE]';
const t = (s) => `${TAG} ${s}`;
const AS_OF = new Date().toISOString().slice(0, 10);

const say = (...a) => console.log(...a);

// ── create ───────────────────────────────────────────────────────────────
async function create() {
  const made = {};

  // A location and an asset of our own, so no real building carries fixture history.
  const loc = await db.createLocation({
    name: t('Test Area'), locationType: 'Area', notes: 'Mobile audit fixture. Safe to delete.',
  });
  made.locationId = loc.Id;
  const asset = await db.createAssetQuick({
    name: t('Test Cabin'), locationId: loc.Id, assetType: 'Cabin',
  });
  made.assetId = asset.Id;
  say(`asset #${asset.Id} in location #${loc.Id}`);

  // 1. A round on the real seed form, one building: reaches the runner, every section,
  //    review, and generation.
  const forms = await db.listAuditForms();
  const form = forms.find((f) => f.Active !== false) || forms[0];
  if (!form) throw new Error('No audit form exists — nothing to run a round against.');
  const round = await db.createAuditRound({
    formId: form.Id, name: t('Mobile audit round'), assetIds: [asset.Id],
    scheduledDate: AS_OF, dueDate: AS_OF,
  });
  made.roundId = round.Id;
  say(`round #${round.Id} on form "${form.Name}"`);

  // 2. Two open findings on that asset, so "Create WO from findings" has candidates and
  //    a job line has something real to link to.
  const findings = [];
  for (const f of [
    { title: t('Gutter pulling away at the north corner'), severity: 'Moderate',
      description: 'Fascia is soft where the gutter has pulled loose. Fixture.' },
    { title: t('Step tread cracked on the back porch'), severity: 'Severe',
      description: 'Middle tread split end to end. Fixture.' },
  ]) {
    const { rows } = await pool.query(
      `INSERT INTO condition_findings (asset_id, title, severity, description, status, date_identified, created_by)
       VALUES ($1,$2,$3,$4,'Open',$5,'fixtures') RETURNING id`,
      [asset.Id, f.title, f.severity, f.description, AS_OF]
    );
    findings.push(rows[0].id);
  }
  made.findingIds = findings;
  say(`findings ${findings.map((i) => `#${i}`).join(', ')}`);

  // 3. A work order with lines — one of them linked to a finding — to reach the card
  //    view, the checklist, the reorder sheet and the reopen prompt.
  // createWorkOrder is the one creator here that returns { workOrderId }, not a row shape
  // with an Id — it reserves the id up front so the WO can be its own split root.
  const { workOrderId: woId } = await db.createWorkOrder({
    title: t('Porch and gutter repairs'), assetId: asset.Id, locationId: loc.Id,
    priority: 'Medium', scheduledDate: AS_OF,
    description: 'Mobile audit fixture work order. Safe to delete.',
  });
  made.workOrderId = woId;
  const lines = [];
  lines.push((await db.createJobLine(woId, {
    title: t('Re-hang gutter, replace soft fascia'), estimatedHours: 3, estimatedCost: 180,
    conditionFindingId: findings[0],
  })).Id);
  lines.push((await db.createJobLine(woId, {
    title: t('Replace cracked tread'), estimatedHours: 1.5, estimatedCost: 45,
    conditionFindingId: findings[1],
  })).Id);
  lines.push((await db.createJobLine(woId, {
    title: t('Paint the repaired sections'), estimatedHours: 2, estimatedCost: 60,
  })).Id);
  made.jobLineIds = lines;
  say(`work order #${woId} with lines ${lines.map((i) => `#${i}`).join(', ')}`);

  // 4. Materials, first, because the receipt's line items point at them. Each gets a
  //    balance on hand at the price actually paid — that reaches materials on hand, the
  //    point-of-use reminder, and count correction.
  const materials = [];
  for (const m of [
    { name: t('Aluminum gutter, 10ft'), unit: 'each', qty: 2, price: 32.00 },
    { name: t('Exterior paint'), unit: 'gal', qty: 1.5, price: 39.62 },
    { name: t('Deck screws'), unit: 'box', qty: 1, price: 20.00 },
  ]) {
    const mat = await db.createMaterial({ name: m.name, unit: m.unit });
    await db.recordMaterialMovement({
      materialId: mat.Id, kind: 'wo_close', quantity: m.qty, unitPrice: m.price,
      workOrderId: woId, note: 'Fixture: left over from the fixture work order.',
      createdBy: 'fixtures',
    });
    materials.push(mat.Id);
  }
  made.materialIds = materials;
  say(`materials ${materials.map((i) => `#${i}`).join(', ')} with stock on hand`);

  // 5. A receipt with line items so the split editor has real money and real lines to
  //    divide — and a second with none, which is the whole-receipt-by-dollar-amount case.
  //
  //    Three of the line items are tagged as tracked materials and allocated to the
  //    fixture work order. That is what the leftover prompt keys off:
  //    getMaterialsUsedOnWorkOrder joins allocations → line items → materials, so a
  //    receipt that is merely *near* the job raises nothing. Without this the prompt at
  //    close correctly never appears, which is exactly what the first run reported.
  const cat = (await db.listExpenseCategories())[0] || null;
  const receipt = await db.createExpense({
    vendor: t('Hardware Store'), amount: 248.31, purchaseDate: AS_OF,
    taxAmount: 14.67, categoryId: cat ? cat.Id : null, assetId: asset.Id,
    notes: 'Mobile audit fixture receipt. Safe to delete.',
  });
  made.receiptId = receipt.Id;
  const LINES = [
    { description: t('Aluminum gutter, 10ft'), quantity: 3, unit: 'each', paidAmount: 96.00, regularPrice: 111.00, mat: 0 },
    { description: t('Cedar tread 2x12'), quantity: 1, unit: 'each', paidAmount: 38.40, mat: null },
    { description: t('Exterior paint, gallon'), quantity: 2, unit: 'gal', paidAmount: 79.24, mat: 1 },
    { description: t('Deck screws, 5lb'), quantity: 1, unit: 'box', paidAmount: 20.00, mat: 2 },
  ];
  for (const li of LINES) {
    const materialId = li.mat == null ? null : materials[li.mat];
    const lineItemId = await db.createExpenseLineItem(receipt.Id, { ...li, materialId });
    if (materialId) {
      await db.createExpenseAllocation(receipt.Id, {
        lineItemId, destType: 'work_order', destId: woId,
        quantity: li.quantity, amount: li.paidAmount, materialId,
      });
    }
  }
  const flatReceipt = await db.createExpense({
    vendor: t('Lumber Yard — no line items'), amount: 412.00, purchaseDate: AS_OF,
    categoryId: cat ? cat.Id : null,
    notes: 'Fixture: emailed receipt with no itemisation, to split by dollar amount.',
  });
  made.flatReceiptId = flatReceipt.Id;
  say(`receipts #${receipt.Id} (4 line items, 3 allocated to the WO) and #${flatReceipt.Id} (flat)`);

  say('\nfixtures created:', JSON.stringify(made));
  return made;
}

// ── list / delete ────────────────────────────────────────────────────────
// The roots: every table that carries the tag in a column of its own. Everything else
// that needs removing hangs off one of these by a foreign key, and is found by following
// those keys rather than by being listed here. An earlier version DID list them, and it
// broke the first time a fixture round wrote an asset_components row nobody had thought
// of — the point of a fixture is that cleaning up cannot depend on remembering.
const ROOTS = [
  ['work_orders',        `title LIKE $1`],   // before assets: its lines reference findings
  ['audit_rounds',       `name LIKE $1`],
  ['expenses',           `vendor LIKE $1`],
  ['materials',          `name LIKE $1`],
  ['condition_findings', `title LIKE $1`],
  ['assets',             `name LIKE $1`],
  ['locations',          `name LIKE $1`],
];

async function tableExists(name) {
  const { rows } = await pool.query('SELECT to_regclass($1) AS t', [`public.${name}`]);
  return !!rows[0].t;
}

const HAS_ID = new Map();
async function hasIdColumn(client, table) {
  if (HAS_ID.has(table)) return HAS_ID.get(table);
  const { rows } = await client.query(
    `SELECT 1 FROM pg_attribute
     WHERE attrelid = $1::regclass AND attname = 'id' AND attnum > 0 AND NOT attisdropped`,
    [table]
  );
  HAS_ID.set(table, rows.length > 0);
  return rows.length > 0;
}

// Every table with a single-column foreign key pointing at `table`.
async function childrenOf(client, table) {
  const { rows } = await client.query(
    `SELECT con.conrelid::regclass::text AS child, att.attname AS col
     FROM pg_constraint con
     JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
     WHERE con.confrelid = $1::regclass
       AND con.contype = 'f'
       AND array_length(con.conkey, 1) = 1`,
    [table]
  );
  return rows;
}

// Delete everything pointing at these ids, depth first, then nothing is left holding a
// reference when the roots go. Rows are only ever matched by an FK column equal to a
// fixture id, so this cannot reach real data.
async function deleteReferencing(client, table, ids, depth = 0, seen = new Set()) {
  if (!ids.length || depth > 4) return;
  for (const { child, col } of await childrenOf(client, table)) {
    if (child === table) continue;             // self-reference: the root delete covers it
    const step = `${child}.${col}`;
    if (seen.has(step)) continue;
    seen.add(step);
    // Grandchildren first, where the child has an id of its own to follow. Ask the
    // catalog whether it does — trying the SELECT and catching the failure aborts the
    // whole transaction, which is a slower way of finding out.
    let childIds = [];
    if (await hasIdColumn(client, child)) {
      const { rows } = await client.query(
        `SELECT id FROM ${child} WHERE ${col} = ANY($1::int[])`, [ids]
      );
      childIds = rows.map((r) => r.id);
    }
    if (childIds.length) await deleteReferencing(client, child, childIds, depth + 1, seen);
    const r = await client.query(`DELETE FROM ${child} WHERE ${col} = ANY($1::int[])`, [ids]);
    if (r.rowCount) say(`  deleted ${r.rowCount} from ${child} (via ${col})`);
  }
}

async function rootIds(client, table, where) {
  const { rows } = await client.query(`SELECT id FROM ${table} WHERE ${where}`, [`${TAG}%`]);
  return rows.map((r) => r.id);
}

async function list() {
  const client = await pool.connect();
  try {
    for (const [table, where] of ROOTS) {
      if (!await tableExists(table)) continue;
      const ids = await rootIds(client, table, where);
      if (ids.length) say(`${String(ids.length).padStart(4)}  ${table}  (${ids.join(', ')})`);
    }
  } finally { client.release(); }
}

async function remove() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // First, because it finds its rows THROUGH expenses: savings_entries names its source
    // by (source_type, source_id) rather than a real FK, so no key walk reaches it and the
    // subquery would come up empty once the receipts are gone.
    const s = await client.query(
      `DELETE FROM savings_entries WHERE source_type = 'expense'
         AND source_id IN (SELECT id FROM expenses WHERE vendor LIKE $1)`, [`${TAG}%`]
    );
    if (s.rowCount) say(`deleted ${s.rowCount} from savings_entries`);
    for (const [table, where] of ROOTS) {
      if (!await tableExists(table)) continue;
      const ids = await rootIds(client, table, where);
      if (!ids.length) continue;
      say(`${table}: ${ids.length}`);
      await deleteReferencing(client, table, ids);
      const r = await client.query(`DELETE FROM ${table} WHERE id = ANY($1::int[])`, [ids]);
      say(`  deleted ${r.rowCount} from ${table}`);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  // Activity rows name the fixtures but reference nothing, so they go last and
  // separately — losing them would not matter, but leaving them is untidy.
  const r = await pool.query(`DELETE FROM activity_log WHERE entity_label LIKE $1`, [`${TAG}%`]);
  if (r.rowCount) say(`deleted ${r.rowCount} from activity_log`);
  say('fixtures removed');
}

const cmd = process.argv[2];
try {
  if (cmd === 'create') await create();
  else if (cmd === 'delete') await remove();
  else if (cmd === 'list') await list();
  else { console.error('usage: fixtures.mjs create|list|delete'); process.exitCode = 1; }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
await pool.end();
