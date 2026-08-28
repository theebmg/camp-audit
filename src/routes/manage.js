import express from 'express';
import {
  getTableMeta, listRecords, getRecord, createRecord, updateRecord,
  deleteRecord, linkRecords, unlinkRecords, getLinkFieldId, TABLES,
} from '../nocodb.js';

const router = express.Router();

// Every table the Manage UI can browse/edit. `key` is the URL segment; `title`
// is what the UI shows. Add a row here to make a new table manageable — nothing
// else in this file is table-specific.
const MANAGE_TABLES = [
  { key: 'locations', title: 'Locations', id: TABLES.locations },
  { key: 'volunteers', title: 'Volunteers', id: TABLES.volunteers },
  { key: 'vendors', title: 'Vendors', id: TABLES.vendors },
  { key: 'projects', title: 'Projects', id: TABLES.projects },
  { key: 'assets', title: 'Assets', id: TABLES.assets },
  { key: 'workOrders', title: 'Work Orders', id: TABLES.workOrders },
  { key: 'conditionFindings', title: 'Condition Findings', id: TABLES.conditionFindings },
  { key: 'assetUpdates', title: 'Asset Updates', id: TABLES.assetUpdates },
  { key: 'assetComponents', title: 'Asset Components', id: TABLES.assetComponents },
];
const byKey = new Map(MANAGE_TABLES.map((t) => [t.key, t]));
const byId = new Map(MANAGE_TABLES.map((t) => [t.id, t]));

const SYSTEM_FIELDS = new Set([
  'Id', 'CreatedAt', 'UpdatedAt', 'nc_created_by', 'nc_updated_by', 'nc_order', '__nc_deleted', 'nc_row_meta',
]);

function requireTable(req, res, next) {
  const table = byKey.get(req.params.key);
  if (!table) return res.status(404).json({ ok: false, error: `Unknown table "${req.params.key}"` });
  req.manageTable = table;
  next();
}

// Classify a NocoDB column into what kind of form control the generic Manage UI
// should render, and what it needs to render it. Unknown/exotic types fall back
// to read-only rather than risk writing something malformed.
function classifyColumn(col) {
  if (SYSTEM_FIELDS.has(col.title) || col.title.startsWith('_nc_m2m_') || col.system) return null;
  if (col.uidt === 'LinkToAnotherRecord' || col.uidt === 'Links') {
    const relatedTable = byId.get(col.colOptions?.fk_related_model_id);
    return {
      title: col.title,
      kind: 'link',
      linkType: col.colOptions?.type, // 'mo' | 'om' | 'mm'
      // Only mo (many-to-one, i.e. this row points at ONE related row) is
      // editable generically — that covers "assign this Asset a Location",
      // "assign this Work Order an Asset", etc. om/mm sides show read-only
      // (they're the reverse of some other table's mo field — edit it there).
      editable: col.colOptions?.type === 'mo',
      relatedTableKey: relatedTable?.key ?? null,
      relatedTableTitle: relatedTable?.title ?? null,
    };
  }
  if (col.uidt === 'SingleSelect') return { title: col.title, kind: 'select', editable: true, options: (col.colOptions?.options || []).map((o) => o.title) };
  if (col.uidt === 'MultiSelect') return { title: col.title, kind: 'multiselect', editable: true, options: (col.colOptions?.options || []).map((o) => o.title) };
  if (col.uidt === 'LongText') return { title: col.title, kind: 'longtext', editable: true };
  if (col.uidt === 'SingleLineText') return { title: col.title, kind: 'text', editable: true };
  if (col.uidt === 'Number' || col.uidt === 'Decimal') return { title: col.title, kind: 'number', editable: true };
  if (col.uidt === 'Currency') return { title: col.title, kind: 'currency', editable: true };
  if (col.uidt === 'Date') return { title: col.title, kind: 'date', editable: true };
  if (col.uidt === 'DateTime') return { title: col.title, kind: 'datetime', editable: true };
  if (col.uidt === 'Checkbox') return { title: col.title, kind: 'checkbox', editable: true };
  if (col.uidt === 'Attachment') return { title: col.title, kind: 'attachment', editable: false, note: 'Attachments aren’t editable here yet — use NocoDB.' };
  // Formula / Rollup / CreatedTime / LastModifiedTime / CreatedBy / LastModifiedBy / ID / anything else
  return { title: col.title, kind: 'readonly', editable: false };
}

async function getManageSchema(table) {
  const meta = await getTableMeta(table.id);
  const primaryCol = meta.columns.find((c) => c.pv) || meta.columns.find((c) => c.title === 'Title' || c.title === 'Name');
  const fields = meta.columns.map(classifyColumn).filter(Boolean);
  return { primaryField: primaryCol?.title ?? 'Id', fields };
}

router.get('/tables', (req, res) => {
  res.json({ tables: MANAGE_TABLES.map(({ key, title }) => ({ key, title })) });
});

router.get('/:key/schema', requireTable, async (req, res, next) => {
  try {
    const schema = await getManageSchema(req.manageTable);
    res.json(schema);
  } catch (e) { next(e); }
});

// Lightweight list: just Id + the primary/display field, for the browse screen.
router.get('/:key/records', requireTable, async (req, res, next) => {
  try {
    const schema = await getManageSchema(req.manageTable);
    const rows = await listRecords(req.manageTable.id, { limit: 2000, fields: `Id,${schema.primaryField}` });
    const sorted = [...rows].sort((a, b) =>
      String(a[schema.primaryField] || '').localeCompare(String(b[schema.primaryField] || ''), undefined, { sensitivity: 'base' }));
    res.json({ records: sorted, primaryField: schema.primaryField });
  } catch (e) { next(e); }
});

router.get('/:key/records/:id', requireTable, async (req, res, next) => {
  try {
    const record = await getRecord(req.manageTable.id, req.params.id);
    res.json({ record });
  } catch (e) { next(e); }
});

// Split an incoming { fields, links } body against the live schema: flat/select/
// checkbox values go straight into a NocoDB PATCH/CREATE body; editable (mo) link
// values get applied separately via link/unlink calls, since NocoDB doesn't accept
// link values in the plain record body.
function splitPayload(schema, body) {
  const fieldMap = new Map(schema.fields.map((f) => [f.title, f]));
  const values = {};
  const links = {};
  for (const [key, value] of Object.entries(body.fields || {})) {
    const f = fieldMap.get(key);
    if (!f || !f.editable) continue;
    if (f.kind === 'select') {
      if (f.options.includes(value)) values[key] = value;
    } else if (f.kind === 'multiselect') {
      const list = (Array.isArray(value) ? value : [value]).filter((v) => f.options.includes(v));
      values[key] = list.join(',');
    } else {
      values[key] = value;
    }
  }
  for (const [key, value] of Object.entries(body.links || {})) {
    const f = fieldMap.get(key);
    if (!f || f.kind !== 'link' || !f.editable) continue;
    links[key] = value; // a record Id, or null to clear
  }
  return { values, links };
}

router.post('/:key/records', requireTable, async (req, res, next) => {
  try {
    const schema = await getManageSchema(req.manageTable);
    const { values, links } = splitPayload(schema, req.body || {});
    const created = await createRecord(req.manageTable.id, values);
    for (const [fieldTitle, targetId] of Object.entries(links)) {
      if (targetId == null) continue;
      const linkFieldId = await getLinkFieldId(req.manageTable.id, fieldTitle);
      await linkRecords(req.manageTable.id, linkFieldId, created.Id, Number(targetId));
    }
    const record = await getRecord(req.manageTable.id, created.Id);
    res.json({ ok: true, record });
  } catch (e) { next(e); }
});

router.patch('/:key/records/:id', requireTable, async (req, res, next) => {
  try {
    const schema = await getManageSchema(req.manageTable);
    const { values, links } = splitPayload(schema, req.body || {});
    if (Object.keys(values).length > 0) {
      await updateRecord(req.manageTable.id, req.params.id, values);
    }
    for (const [fieldTitle, targetId] of Object.entries(links)) {
      const linkFieldId = await getLinkFieldId(req.manageTable.id, fieldTitle);
      const current = await getRecord(req.manageTable.id, req.params.id);
      const existing = current[fieldTitle];
      if (existing?.Id != null) {
        await unlinkRecords(req.manageTable.id, linkFieldId, req.params.id, existing.Id);
      }
      if (targetId != null) {
        await linkRecords(req.manageTable.id, linkFieldId, req.params.id, Number(targetId));
      }
    }
    const record = await getRecord(req.manageTable.id, req.params.id);
    res.json({ ok: true, record });
  } catch (e) { next(e); }
});

router.delete('/:key/records/:id', requireTable, async (req, res, next) => {
  try {
    await deleteRecord(req.manageTable.id, req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
