import express from 'express';
import multer from 'multer';
import {
  getTableMeta, listRecords, getRecord, listLinkedRecords,
  createRecord, updateRecord, deleteRecord, linkRecords, unlinkRecords, getLinkFieldId,
  uploadAttachment, attachmentUrl, TABLES,
} from '../nocodb.js';
import { currentComponentState, sortHistory } from '../components.js';
import { buildActivity, buildCapitalPlan } from '../reportData.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const withPhotoUrls = (photos) => (photos || []).map((p) => ({ ...p, url: attachmentUrl(p.signedPath) }));

// Alphabetical sort for browse/pick lists (Locations, Assets, Work Orders, Manage
// Data, search results, ...). Deliberately NOT used for the Maintenance Log
// (chronological) or Capital Plan (soonest-replacement-first) — alphabetizing
// those would break the thing that makes them useful.
const byField = (field) => (a, b) => String(a[field] || '').localeCompare(String(b[field] || ''), undefined, { sensitivity: 'base' });

const ASSET_PROPERTY_TAG = '@asset-property';

// Conditional audit question logic: field -> values that reveal other fields.
// Edit this map when a new dependent question is added; everything else is schema-driven.
const ASSET_PROPERTY_DEPENDENCIES = [
  { field: 'Has Key', showWhen: ['Yes'], reveals: ['Key Fits Lock'] },
];

// Component Types the audit flow prompts for when Free Standing Building = Yes.
// Roof/Siding/Foundation used to be flat @asset-property fields; they're now
// Asset Components rows instead (see camp-cmms-components-design.md). Extend this
// list, not the flat-field map above, to add another audited component type.
const AUDIT_COMPONENT_DEPENDENCY = { field: 'Free Standing Building', showWhen: ['Yes'] };
const AUDIT_COMPONENT_TYPES = ['Roof', 'Siding', 'Foundation'];

function isAssetPropertyColumn(col) {
  return typeof col.description === 'string' && col.description.includes(ASSET_PROPERTY_TAG);
}

function toQuestionField(col, currentValues) {
  const isSelect = col.uidt === 'SingleSelect' || col.uidt === 'MultiSelect';
  return {
    title: col.title,
    uidt: col.uidt,
    multi: col.uidt === 'MultiSelect',
    options: isSelect ? (col.colOptions?.options || []).map((o) => o.title) : null,
    currentValue: currentValues ? currentValues[col.title] ?? null : undefined,
  };
}

// Schema-derived question set: which Assets columns are audited, their live option
// lists, and the conditional reveal map. currentValues is optional (omit for a
// schema-only response, e.g. to preview questions with no asset selected yet).
async function buildAssetPropertyQuestionSet(currentValues) {
  const meta = await getTableMeta(TABLES.assets);
  const fields = meta.columns.filter(isAssetPropertyColumn).map((c) => toQuestionField(c, currentValues));
  const revealed = new Set(ASSET_PROPERTY_DEPENDENCIES.flatMap((d) => d.reveals));
  const topLevel = fields.filter((f) => !revealed.has(f.title)).map((f) => f.title);
  return { fields, topLevel, dependencies: ASSET_PROPERTY_DEPENDENCIES };
}

const today = () => new Date().toISOString().slice(0, 10);

// Component Type / Event Type / Condition option lists, straight from live schema
// so the audit UI and the WO/report screens can never drift from what NocoDB accepts.
async function getComponentSchema() {
  const meta = await getTableMeta(TABLES.assetComponents);
  const opts = (title) => (meta.columns.find((c) => c.title === title)?.colOptions?.options || []).map((o) => o.title);
  return {
    componentTypeOptions: opts('Component Type'),
    eventTypeOptions: opts('Event Type'),
    conditionOptions: opts('Condition'),
    promptTypes: AUDIT_COMPONENT_TYPES,
    promptWhen: AUDIT_COMPONENT_DEPENDENCY,
  };
}

async function getComponentsForAsset(assetId) {
  const linkFieldId = await getLinkFieldId(TABLES.assets, 'Asset Components');
  return listLinkedRecords(TABLES.assets, linkFieldId, assetId, {
    limit: 1000,
    fields: 'Id,Title,Component Type,Event Type,Material,Condition,Observed/Installed Date,Est Life (years),Est Replacement Year,Est Replacement Cost,Notes,Work Order',
  });
}

// ---- Locations / Assets (read) ----

router.get('/locations', async (req, res, next) => {
  try {
    const locations = await listRecords(TABLES.locations, { limit: 1000, fields: 'Id,Name,Location Type' });
    res.json({ locations: locations.sort(byField('Name')) });
  } catch (e) { next(e); }
});

router.get('/locations/:id/assets', async (req, res, next) => {
  try {
    const linkFieldId = await getLinkFieldId(TABLES.locations, 'Assets');
    const assets = await listLinkedRecords(TABLES.locations, linkFieldId, req.params.id, {
      limit: 1000,
      fields: 'Id,Name,Asset type,Condition',
    });
    res.json({ assets: assets.sort(byField('Name')) });
  } catch (e) { next(e); }
});

router.get('/assets/:id', async (req, res, next) => {
  try {
    const [asset, properties, componentRows, componentSchema, workOrders, conditionFindings] = await Promise.all([
      getRecord(TABLES.assets, req.params.id),
      buildAssetPropertyQuestionSet(undefined),
      getComponentsForAsset(req.params.id),
      getComponentSchema(),
      (async () => {
        const linkFieldId = await getLinkFieldId(TABLES.assets, 'Work Orders');
        return listLinkedRecords(TABLES.assets, linkFieldId, req.params.id, { limit: 200, fields: 'Id,Title,Status,Priority' });
      })(),
      (async () => {
        const linkFieldId = await getLinkFieldId(TABLES.assets, 'Condition Findings');
        return listLinkedRecords(TABLES.assets, linkFieldId, req.params.id, { limit: 200, fields: 'Id,Title,Severity,Status' });
      })(),
    ]);
    properties.fields.forEach((f) => { f.currentValue = asset[f.title] ?? null; });
    res.json({
      asset,
      properties,
      components: {
        current: currentComponentState(componentRows),
        history: sortHistory(componentRows),
        schema: componentSchema,
      },
      workOrders: [...workOrders].sort((a, b) => b.Id - a.Id),
      conditionFindings: [...conditionFindings].sort((a, b) => b.Id - a.Id),
    });
  } catch (e) { next(e); }
});

// Global search across Locations + Assets, for the always-on search bar. Small
// in-memory tables (hundreds of rows), so a simple substring filter is plenty.
router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ locations: [], assets: [] });
    const [locations, assets] = await Promise.all([
      listRecords(TABLES.locations, { limit: 1000, fields: 'Id,Name,Location Type' }),
      listRecords(TABLES.assets, { limit: 1000, fields: 'Id,Name,Asset type,Location' }),
    ]);
    const matchedLocations = locations
      .filter((l) => (l.Name || '').toLowerCase().includes(q))
      .sort(byField('Name'))
      .slice(0, 20);
    const matchedAssets = assets
      .filter((a) => (a.Name || '').toLowerCase().includes(q))
      .sort(byField('Name'))
      .slice(0, 20)
      .map((a) => ({
        Id: a.Id,
        Name: a.Name,
        assetType: a['Asset type'],
        locationId: a.Location?.Id ?? null,
        locationName: a.Location?.Name ?? null,
      }));
    res.json({ locations: matchedLocations, assets: matchedAssets });
  } catch (e) { next(e); }
});

// Activity dashboard: a merged, most-recent-first feed of the three things that
// actually happen day to day — component events (installs/inspections/etc.),
// Condition Findings, and Work Orders — each tagged with `kind` so the frontend
// can show the right icon and link. This is the default landing screen.
router.get('/activity', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 40, 200);
    const entries = await buildActivity({ limit });
    res.json({ entries });
  } catch (e) { next(e); }
});

// Misc dropdown options the frontend needs, all derived from live schema so nothing
// drifts out of sync with NocoDB (finding severity, WO priority, valid WO target fields).
router.get('/options', async (req, res, next) => {
  try {
    const [assetsMeta, cfMeta, woMeta, auMeta] = await Promise.all([
      getTableMeta(TABLES.assets),
      getTableMeta(TABLES.conditionFindings),
      getTableMeta(TABLES.workOrders),
      getTableMeta(TABLES.assetUpdates),
    ]);
    const propertyTitles = new Set(assetsMeta.columns.filter(isAssetPropertyColumn).map((c) => c.title));
    const targetFieldCol = auMeta.columns.find((c) => c.title === 'Target Field');
    const validTargetFields = (targetFieldCol?.colOptions?.options || []).map((o) => o.title);
    const severityCol = cfMeta.columns.find((c) => c.title === 'Severity');
    const priorityCol = woMeta.columns.find((c) => c.title === 'Priority');
    const statusCol = woMeta.columns.find((c) => c.title === 'Status');
    const componentSchema = await getComponentSchema();
    res.json({
      findingSeverity: (severityCol?.colOptions?.options || []).map((o) => o.title),
      workOrderPriority: (priorityCol?.colOptions?.options || []).map((o) => o.title),
      workOrderStatus: (statusCol?.colOptions?.options || []).map((o) => o.title),
      workOrderTargetFields: validTargetFields.filter((t) => propertyTitles.has(t)),
      componentTypeOptions: componentSchema.componentTypeOptions,
      eventTypeOptions: componentSchema.eventTypeOptions,
      conditionOptions: componentSchema.conditionOptions,
    });
  } catch (e) { next(e); }
});

// ---- Audit submit (write): PATCH flat asset fields, CREATE Component event rows,
// optionally POST + link a finding ----

router.post('/assets/:id/audit', async (req, res, next) => {
  try {
    const assetId = req.params.id;
    const { properties = {}, componentEvents = [], finding = null } = req.body || {};

    const meta = await getTableMeta(TABLES.assets);
    const propertyCols = new Map(meta.columns.filter(isAssetPropertyColumn).map((c) => [c.title, c]));

    const updates = {};
    for (const [key, value] of Object.entries(properties)) {
      const col = propertyCols.get(key);
      if (!col) continue; // ignore anything that isn't a live @asset-property field
      const validOptions = (col.colOptions?.options || []).map((o) => o.title);
      if (col.uidt === 'MultiSelect') {
        const values = (Array.isArray(value) ? value : [value]).filter((v) => validOptions.includes(v));
        updates[key] = values.join(',');
      } else if (col.uidt === 'SingleSelect') {
        if (validOptions.includes(value)) updates[key] = value;
      } else {
        updates[key] = value;
      }
    }

    if (Object.keys(updates).length > 0) {
      await updateRecord(TABLES.assets, assetId, updates);
    }

    const componentSchema = await getComponentSchema();
    const assetLinkFieldId = await getLinkFieldId(TABLES.assetComponents, 'Asset');
    const asset = await getRecord(TABLES.assets, assetId);

    const createdComponents = [];
    for (const ev of componentEvents) {
      if (!ev?.componentType || !componentSchema.promptTypes.includes(ev.componentType)) continue;
      if (!componentSchema.componentTypeOptions.includes(ev.componentType)) continue;
      const eventType = componentSchema.eventTypeOptions.includes(ev.eventType) ? ev.eventType : 'Inspected';
      const condition = componentSchema.conditionOptions.includes(ev.condition) ? ev.condition : null;
      const observedDate = ev.observedDate || today();
      const row = await createRecord(TABLES.assetComponents, {
        Title: `${asset.Name} — ${ev.componentType} — ${observedDate.slice(0, 4)}`,
        'Component Type': ev.componentType,
        'Event Type': eventType,
        Material: ev.material || null,
        Condition: condition,
        'Observed/Installed Date': observedDate,
        'Est Life (years)': ev.estLifeYears ?? null,
        'Est Replacement Cost': ev.estReplacementCost ?? null,
        Notes: ev.notes || null,
      });
      await linkRecords(TABLES.assetComponents, assetLinkFieldId, row.Id, Number(assetId));
      createdComponents.push(row);
    }

    let createdFinding = null;
    if (finding && finding.description && finding.severity) {
      const findingAssetLinkFieldId = await getLinkFieldId(TABLES.conditionFindings, 'Asset');
      createdFinding = await createRecord(TABLES.conditionFindings, {
        Title: finding.title || `Finding on Asset #${assetId}`,
        Severity: finding.severity,
        Description: finding.description,
        'Recommended Repair': finding.recommendedRepair || null,
        'Estimated Hours': finding.estimatedHours ?? null,
        'Estimated Cost': finding.estimatedCost ?? null,
        Status: 'Open',
        'Date Identified': today(),
      });
      await linkRecords(TABLES.conditionFindings, findingAssetLinkFieldId, createdFinding.Id, Number(assetId));
    }

    const updatedAsset = await getRecord(TABLES.assets, assetId);
    res.json({ ok: true, asset: updatedAsset, components: createdComponents, finding: createdFinding });
  } catch (e) { next(e); }
});

// ---- Reports: per-asset history timeline + camp-wide maintenance log ----
// Both are reads of the same Asset Components log, unfiltered, sorted by date —
// no separate storage. See currentComponentState()/sortHistory() in components.js.

router.get('/assets/:id/history', async (req, res, next) => {
  try {
    const [asset, componentRows] = await Promise.all([
      getRecord(TABLES.assets, req.params.id),
      getComponentsForAsset(req.params.id),
    ]);
    res.json({ asset, history: sortHistory(componentRows) });
  } catch (e) { next(e); }
});

router.get('/maintenance-log', async (req, res, next) => {
  try {
    const { componentType, eventType, from, to } = req.query;
    const rows = await listRecords(TABLES.assetComponents, {
      limit: 5000,
      fields: 'Id,Title,Component Type,Event Type,Material,Condition,Observed/Installed Date,Est Life (years),Est Replacement Year,Est Replacement Cost,Notes,Asset,Work Order',
    });
    let filtered = rows;
    if (componentType) filtered = filtered.filter((r) => r['Component Type'] === componentType);
    if (eventType) filtered = filtered.filter((r) => r['Event Type'] === eventType);
    if (from) filtered = filtered.filter((r) => (r['Observed/Installed Date'] || '') >= from);
    if (to) filtered = filtered.filter((r) => (r['Observed/Installed Date'] || '') <= to);
    res.json({ entries: sortHistory(filtered) });
  } catch (e) { next(e); }
});

// Capital-planning view: current state per (Asset, Component Type), not the raw
// log — one row per component, sorted by soonest est. replacement year, with a
// funding-forecast summary bucketed the way a board report would want it.
router.get('/capital-plan', async (req, res, next) => {
  try {
    const { componentType, condition } = req.query;
    const { rows, summary } = await buildCapitalPlan({ componentType, condition });
    res.json({ rows, summary });
  } catch (e) { next(e); }
});

// ---- Phase 2: Work Orders + Asset Updates write-back ----

router.get('/work-orders', async (req, res, next) => {
  try {
    const workOrders = await listRecords(TABLES.workOrders, {
      limit: 1000,
      fields: 'Id,Title,Status,Priority,Date Reported,Date Completed,Asset,Location',
    });
    res.json({ workOrders: workOrders.sort(byField('Title')) });
  } catch (e) { next(e); }
});

const ASSET_UPDATE_FIELDS = 'Id,Title,Target Field,New Value,Applied';

// mm link fields created via the meta API (Assigned Vendors) don't reliably expand
// inline on a plain record fetch — NocoDB quirk, see camp-cmms notes. Always read
// assignment fields through the dedicated links-list endpoint instead of trusting
// what getRecord() returns for them.
async function getAssignees(woId) {
  const [volLinkFieldId, venLinkFieldId] = await Promise.all([
    getLinkFieldId(TABLES.workOrders, 'Assigned Volunteers'),
    getLinkFieldId(TABLES.workOrders, 'Assigned Vendors'),
  ]);
  const [volunteers, vendors] = await Promise.all([
    listLinkedRecords(TABLES.workOrders, volLinkFieldId, woId, { limit: 100, fields: 'Id,Name,Skill,Phone Number' }),
    listLinkedRecords(TABLES.workOrders, venLinkFieldId, woId, { limit: 100, fields: 'Id,Name,Specialty,Phone Number' }),
  ]);
  return { volunteers, vendors };
}

router.get('/work-orders/:id', async (req, res, next) => {
  try {
    const [workOrder, assetUpdates, assignees] = await Promise.all([
      getRecord(TABLES.workOrders, req.params.id),
      (async () => {
        const linkFieldId = await getLinkFieldId(TABLES.workOrders, 'Asset Updates');
        return listLinkedRecords(TABLES.workOrders, linkFieldId, req.params.id, { limit: 1000, fields: ASSET_UPDATE_FIELDS });
      })(),
      getAssignees(req.params.id),
    ]);
    res.json({ workOrder, assetUpdates, photos: withPhotoUrls(workOrder.Photos), ...assignees });
  } catch (e) { next(e); }
});

router.post('/work-orders/:id/photos', upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const uploaded = await uploadAttachment(req.file.buffer, req.file.originalname, req.file.mimetype);
    const current = await getRecord(TABLES.workOrders, req.params.id);
    await updateRecord(TABLES.workOrders, req.params.id, { Photos: [...(current.Photos || []), ...uploaded] });
    const fresh = await getRecord(TABLES.workOrders, req.params.id);
    res.json({ ok: true, photos: withPhotoUrls(fresh.Photos) });
  } catch (e) { next(e); }
});

router.delete('/work-orders/:id/photos/:photoId', async (req, res, next) => {
  try {
    const current = await getRecord(TABLES.workOrders, req.params.id);
    const remaining = (current.Photos || []).filter((p) => p.id !== req.params.photoId);
    await updateRecord(TABLES.workOrders, req.params.id, { Photos: remaining });
    res.json({ ok: true, photos: withPhotoUrls(remaining) });
  } catch (e) { next(e); }
});

router.patch('/work-orders/:id', async (req, res, next) => {
  try {
    const woMeta = await getTableMeta(TABLES.workOrders);
    const optionsFor = (title) => (woMeta.columns.find((c) => c.title === title)?.colOptions?.options || []).map((o) => o.title);
    const priorityOptions = optionsFor('Priority');
    const statusOptions = optionsFor('Status');

    const body = req.body || {};
    const updates = {};
    if (body.title != null) updates.Title = body.title;
    if (body.description !== undefined) updates.Description = body.description || null;
    if (body.priority != null && priorityOptions.includes(body.priority)) updates.Priority = body.priority;
    if (body.status != null && statusOptions.includes(body.status)) updates.Status = body.status;
    if (body.dateReported !== undefined) updates['Date Reported'] = body.dateReported || null;
    if (body.dateCompleted !== undefined) updates['Date Completed'] = body.dateCompleted || null;
    // Hours are stored as a whole-number (bigint) column in NocoDB — round rather
    // than send a decimal string, which Postgres rejects outright.
    const toInt = (v) => (v === '' || v == null ? null : Math.round(Number(v)));
    const toNum = (v) => (v === '' || v == null ? null : Number(v));
    if (body.estimatedHours !== undefined) updates['Estimated Hours'] = toInt(body.estimatedHours);
    if (body.actualHours !== undefined) updates['Actual Hours'] = toInt(body.actualHours);
    if (body.estimatedCost !== undefined) updates['Estimated Cost'] = toNum(body.estimatedCost);
    if (body.actualCost !== undefined) updates['Actual Cost'] = toNum(body.actualCost);

    if (Object.keys(updates).length > 0) {
      await updateRecord(TABLES.workOrders, req.params.id, updates);
    }
    const workOrder = await getRecord(TABLES.workOrders, req.params.id);
    res.json({ ok: true, workOrder });
  } catch (e) { next(e); }
});

// ---- Job lines (Asset Updates) on an existing Work Order ----

router.post('/work-orders/:id/asset-updates', async (req, res, next) => {
  try {
    const { targetField, newValue } = req.body || {};
    const assetsMeta = await getTableMeta(TABLES.assets);
    const propertyTitles = new Set(assetsMeta.columns.filter(isAssetPropertyColumn).map((c) => c.title));
    const auMeta = await getTableMeta(TABLES.assetUpdates);
    const targetFieldCol = auMeta.columns.find((c) => c.title === 'Target Field');
    const validTargetFields = new Set((targetFieldCol?.colOptions?.options || []).map((o) => o.title));
    if (!targetField || !propertyTitles.has(targetField) || !validTargetFields.has(targetField)) {
      return res.status(400).json({ ok: false, error: 'targetField must be a live @asset-property field that is also a valid Asset Updates Target Field option' });
    }
    const row = await createRecord(TABLES.assetUpdates, {
      Title: `${targetField} -> ${newValue}`,
      'Target Field': targetField,
      'New Value': String(newValue ?? ''),
      Applied: false,
    });
    const woLinkFieldId = await getLinkFieldId(TABLES.assetUpdates, 'Work Order');
    await linkRecords(TABLES.assetUpdates, woLinkFieldId, row.Id, Number(req.params.id));
    res.json({ ok: true, assetUpdate: row });
  } catch (e) { next(e); }
});

router.delete('/work-orders/:id/asset-updates/:auId', async (req, res, next) => {
  try {
    const row = await getRecord(TABLES.assetUpdates, req.params.auId);
    if (row.Applied) {
      return res.status(400).json({ ok: false, error: 'This job line was already applied to the asset — remove it in Manage Data if you really need to.' });
    }
    await deleteRecord(TABLES.assetUpdates, req.params.auId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Assign / unassign Volunteers and Vendors on a Work Order ----

router.post('/work-orders/:id/volunteers', async (req, res, next) => {
  try {
    const linkFieldId = await getLinkFieldId(TABLES.workOrders, 'Assigned Volunteers');
    await linkRecords(TABLES.workOrders, linkFieldId, req.params.id, Number(req.body?.volunteerId));
    res.json(await getAssignees(req.params.id));
  } catch (e) { next(e); }
});

router.delete('/work-orders/:id/volunteers/:volunteerId', async (req, res, next) => {
  try {
    const linkFieldId = await getLinkFieldId(TABLES.workOrders, 'Assigned Volunteers');
    await unlinkRecords(TABLES.workOrders, linkFieldId, req.params.id, Number(req.params.volunteerId));
    res.json(await getAssignees(req.params.id));
  } catch (e) { next(e); }
});

router.post('/work-orders/:id/vendors', async (req, res, next) => {
  try {
    const linkFieldId = await getLinkFieldId(TABLES.workOrders, 'Assigned Vendors');
    await linkRecords(TABLES.workOrders, linkFieldId, req.params.id, Number(req.body?.vendorId));
    res.json(await getAssignees(req.params.id));
  } catch (e) { next(e); }
});

router.delete('/work-orders/:id/vendors/:vendorId', async (req, res, next) => {
  try {
    const linkFieldId = await getLinkFieldId(TABLES.workOrders, 'Assigned Vendors');
    await unlinkRecords(TABLES.workOrders, linkFieldId, req.params.id, Number(req.params.vendorId));
    res.json(await getAssignees(req.params.id));
  } catch (e) { next(e); }
});

router.post('/work-orders', async (req, res, next) => {
  try {
    const { title, assetId, locationId, priority, description, assetUpdates = [] } = req.body || {};
    if (!title || !assetId) {
      return res.status(400).json({ ok: false, error: 'title and assetId are required' });
    }

    const wo = await createRecord(TABLES.workOrders, {
      Title: title,
      Priority: priority || 'Medium',
      Status: 'Open',
      Description: description || null,
      'Date Reported': today(),
    });

    const assetLinkFieldId = await getLinkFieldId(TABLES.workOrders, 'Asset');
    await linkRecords(TABLES.workOrders, assetLinkFieldId, wo.Id, Number(assetId));

    if (locationId) {
      const locLinkFieldId = await getLinkFieldId(TABLES.workOrders, 'Location');
      await linkRecords(TABLES.workOrders, locLinkFieldId, wo.Id, Number(locationId));
    }

    // Target Field must be both a live @asset-property field AND a valid option on
    // the Asset Updates.Target Field select, or the write-back would silently no-op.
    const assetsMeta = await getTableMeta(TABLES.assets);
    const propertyTitles = new Set(assetsMeta.columns.filter(isAssetPropertyColumn).map((c) => c.title));
    const auMeta = await getTableMeta(TABLES.assetUpdates);
    const targetFieldCol = auMeta.columns.find((c) => c.title === 'Target Field');
    const validTargetFields = new Set((targetFieldCol?.colOptions?.options || []).map((o) => o.title));
    const woLinkFieldId = await getLinkFieldId(TABLES.assetUpdates, 'Work Order');

    const createdUpdates = [];
    for (const u of assetUpdates) {
      if (!u?.targetField || !propertyTitles.has(u.targetField) || !validTargetFields.has(u.targetField)) continue;
      const row = await createRecord(TABLES.assetUpdates, {
        Title: `${u.targetField} -> ${u.newValue}`,
        'Target Field': u.targetField,
        'New Value': String(u.newValue ?? ''),
        Applied: false,
      });
      await linkRecords(TABLES.assetUpdates, woLinkFieldId, row.Id, wo.Id);
      createdUpdates.push(row);
    }

    res.json({ ok: true, workOrder: wo, assetUpdates: createdUpdates });
  } catch (e) { next(e); }
});

router.post('/work-orders/:id/complete', async (req, res, next) => {
  try {
    const woId = req.params.id;
    const wo = await getRecord(TABLES.workOrders, woId);
    const assetId = wo.Asset?.Id;
    if (!assetId) return res.status(400).json({ ok: false, error: 'Work Order has no linked Asset' });

    const linkFieldId = await getLinkFieldId(TABLES.workOrders, 'Asset Updates');
    const updates = await listLinkedRecords(TABLES.workOrders, linkFieldId, woId, {
      limit: 1000,
      fields: ASSET_UPDATE_FIELDS,
    });
    const pending = updates.filter((u) => !u.Applied);

    const appliedUpdateIds = [];
    for (const u of pending) {
      await updateRecord(TABLES.assets, assetId, { [u['Target Field']]: u['New Value'] });
      await updateRecord(TABLES.assetUpdates, u.Id, { Applied: true });
      appliedUpdateIds.push(u.Id);
    }

    await updateRecord(TABLES.workOrders, woId, { Status: 'Done', 'Date Completed': today() });

    const workOrder = await getRecord(TABLES.workOrders, woId);
    const asset = await getRecord(TABLES.assets, assetId);
    res.json({ ok: true, workOrder, asset, appliedUpdateIds });
  } catch (e) { next(e); }
});

export default router;
