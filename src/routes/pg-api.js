// Postgres-backed parallel of routes/api.js — the migration brief's "build
// alongside, cut over only when proven" path. Mounted at /api/pg, additive:
// the live /api (NocoDB-backed) is untouched. Covers the step-4 bar: audit
// submit + one report (capital plan) working end-to-end on Postgres.
//
// Property values in request/response bodies here use snake_case field KEYS
// (e.g. "has_key") matching the assets table columns and asset_property_fields
// catalog — NOT the NocoDB "Has Key" title-case labels the live /api uses. The
// frontend will need a small adapter when it's pointed at this path (step 5/8);
// that's expected, not a bug.
import express from 'express';
import multer from 'multer';
import { currentComponentState, sortHistory } from '../components.js';
import { buildCapitalPlanPg } from '../reportDataPg.js';
import { uploadPhoto } from '../storage.js';
import {
  listLocations, listAssetsByLocation, searchLocationsAndAssets,
  getAssetPropertyFields, getComponentTypeCatalog, getAssetDetail, getAssetHistory,
  submitAudit, getMaintenanceLog, listBuildingTypes, setAssetBuildingType,
  listAssetNotes, createAssetNote, resolveAssetNote, updateAssetFull,
  adminListPropertyFields, adminCreatePropertyField, adminUpdatePropertyField,
  adminListComponentTypes, adminCreateComponentType, adminUpdateComponentType,
  adminCreateBuildingType, adminDeleteBuildingType,
  adminGetApplicabilityMatrix, adminSetApplicability,
  adminListSubAreas, adminCreateSubArea, adminDeleteSubArea,
  listWorkOrders, getWorkOrderDetail, createWorkOrder, updateWorkOrder, duplicateWorkOrder,
  listWorkOrderTemplates, createWorkOrderTemplate, updateWorkOrderTemplate, deleteWorkOrderTemplate,
  addAssetUpdateToWorkOrder, deleteAssetUpdate, completeWorkOrder,
  assignVolunteer, unassignVolunteer, assignVendor, unassignVendor,
  listVolunteers, createVolunteer, updateVolunteer, removeVolunteer,
  listVendors, createVendor, updateVendor, removeVendor,
  listSkills, createSkill, searchAssetsLive, createAssetQuick,
} from '../db.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Generic photo upload -> DigitalOcean Spaces, returns the URL to attach
// wherever the caller needs it (a note, a finding, ...). category/ownerId are
// just for readable object keys in the bucket, not access control.
router.post('/upload', upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const url = await uploadPhoto(req.file.buffer, {
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      category: req.body.category || 'misc',
      ownerId: req.body.ownerId || 'unknown',
    });
    res.json({ ok: true, url });
  } catch (e) { next(e); }
});

// Condition Findings severity options — mirrors the live NocoDB Severity select.
// Not schema-driven like asset properties/components (out of scope of the
// property/component config tables); revisit if findings gain their own catalog.
const FINDING_SEVERITY_OPTIONS = ['1 - Monitor', '2 - Minor', '3 - Moderate', '4 - Major', '5 - Safety-Critical'];

router.get('/locations', async (req, res, next) => {
  try {
    res.json({ locations: await listLocations() });
  } catch (e) { next(e); }
});

router.get('/locations/:id/assets', async (req, res, next) => {
  try {
    res.json({ assets: await listAssetsByLocation(req.params.id) });
  } catch (e) { next(e); }
});

router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ locations: [], assets: [] });
    res.json(await searchLocationsAndAssets(q));
  } catch (e) { next(e); }
});

router.get('/options', async (req, res, next) => {
  try {
    const [propertyFields, componentSchema, buildingTypes] = await Promise.all([
      getAssetPropertyFields(), getComponentTypeCatalog(), listBuildingTypes(),
    ]);
    res.json({
      propertyFields,
      componentTypeOptions: componentSchema.componentTypeOptions,
      eventTypeOptions: componentSchema.eventTypeOptions,
      conditionOptions: componentSchema.conditionOptions,
      buildingTypes,
      findingSeverity: FINDING_SEVERITY_OPTIONS,
    });
  } catch (e) { next(e); }
});

// Deliberate admin action, not a walkthrough button — see migration brief's
// "New tracked FIELDS" section for why this stays separate from asset_notes.
router.patch('/assets/:id/building-type', async (req, res, next) => {
  try {
    const { buildingTypeId } = req.body || {};
    const updated = await setAssetBuildingType(req.params.id, buildingTypeId ?? null);
    if (!updated) return res.status(404).json({ ok: false, error: 'Asset not found' });
    res.json({ ok: true, ...updated });
  } catch (e) { next(e); }
});

// ---- Ad-hoc field notes (pressure-relief valve, distinct from Condition
// Findings — see migration brief) ----

router.get('/assets/:id/notes', async (req, res, next) => {
  try {
    res.json({ notes: await listAssetNotes(req.params.id) });
  } catch (e) { next(e); }
});

router.post('/assets/:id/notes', async (req, res, next) => {
  try {
    const { note, photoUrl } = req.body || {};
    if (!note || !note.trim()) return res.status(400).json({ ok: false, error: 'note text is required' });
    const created = await createAssetNote(req.params.id, { note: note.trim(), photoUrl: photoUrl || null, createdBy: req.session?.user || null });
    res.json({ ok: true, note: created });
  } catch (e) { next(e); }
});

router.patch('/notes/:noteId/resolve', async (req, res, next) => {
  try {
    const resolved = req.body?.resolved !== false;
    const updated = await resolveAssetNote(req.params.noteId, resolved);
    if (!updated) return res.status(404).json({ ok: false, error: 'Note not found' });
    res.json({ ok: true, note: updated });
  } catch (e) { next(e); }
});

router.get('/assets/:id', async (req, res, next) => {
  try {
    const detail = await getAssetDetail(req.params.id);
    if (!detail) return res.status(404).json({ ok: false, error: 'Asset not found' });
    res.json({
      asset: detail.asset,
      properties: detail.properties,
      components: {
        current: currentComponentState(detail.componentRows),
        history: sortHistory(detail.componentRows),
        schema: detail.componentSchema,
      },
      workOrders: detail.workOrders,
      conditionFindings: detail.conditionFindings,
    });
  } catch (e) { next(e); }
});

// Full edit — admin screen, distinct from the guided /audit flow: direct field
// edits only, no component events or findings created here.
router.patch('/assets/:id', async (req, res, next) => {
  try {
    const { core = {}, properties = {} } = req.body || {};
    const detail = await updateAssetFull(req.params.id, { core, properties });
    if (!detail) return res.status(404).json({ ok: false, error: 'Asset not found' });
    res.json({ ok: true, asset: detail.asset });
  } catch (e) { next(e); }
});

router.get('/assets/:id/history', async (req, res, next) => {
  try {
    const { asset, componentRows } = await getAssetHistory(req.params.id);
    if (!asset) return res.status(404).json({ ok: false, error: 'Asset not found' });
    res.json({ asset, history: sortHistory(componentRows) });
  } catch (e) { next(e); }
});

router.post('/assets/:id/audit', async (req, res, next) => {
  try {
    const { properties = {}, componentEvents = [], finding = null } = req.body || {};
    const result = await submitAudit(req.params.id, { properties, componentEvents, finding });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/maintenance-log', async (req, res, next) => {
  try {
    const { componentType, eventType, from, to } = req.query;
    const entries = await getMaintenanceLog({ componentType, eventType, from, to });
    res.json({ entries });
  } catch (e) { next(e); }
});

router.get('/capital-plan', async (req, res, next) => {
  try {
    const { componentType, condition } = req.query;
    const { rows, summary } = await buildCapitalPlanPg({ componentType, condition });
    res.json({ rows, summary });
  } catch (e) { next(e); }
});

// ---- Admin: schema/config management ----
// Every route here is reversible metadata (no DDL) — see db.js's admin
// section header for why new property fields never trigger a schema change.

router.get('/admin/property-fields', async (req, res, next) => {
  try { res.json({ fields: await adminListPropertyFields() }); } catch (e) { next(e); }
});

router.post('/admin/property-fields', async (req, res, next) => {
  try {
    const { fieldKey, label, inputType, options } = req.body || {};
    if (!fieldKey || !label || !['select', 'multiselect', 'text', 'number'].includes(inputType)) {
      return res.status(400).json({ ok: false, error: 'fieldKey, label, and a valid inputType are required' });
    }
    if (!/^[a-z][a-z0-9_]*$/.test(fieldKey)) {
      return res.status(400).json({ ok: false, error: 'fieldKey must be lowercase snake_case (e.g. window_type)' });
    }
    const field = await adminCreatePropertyField({ fieldKey, label, inputType, options: options || [] });
    res.json({ ok: true, field });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, error: `A field with key "${req.body?.fieldKey}" already exists` });
    next(e);
  }
});

router.patch('/admin/property-fields/:id', async (req, res, next) => {
  try {
    const { label, options, active, sortOrder } = req.body || {};
    const field = await adminUpdatePropertyField(req.params.id, { label, options, active, sortOrder });
    if (!field) return res.status(404).json({ ok: false, error: 'Field not found' });
    res.json({ ok: true, field });
  } catch (e) { next(e); }
});

router.get('/admin/component-types', async (req, res, next) => {
  try { res.json({ componentTypes: await adminListComponentTypes() }); } catch (e) { next(e); }
});

router.post('/admin/component-types', async (req, res, next) => {
  try {
    const { componentType, eventTypeOptions, conditionOptions, promptedInAudit } = req.body || {};
    if (!componentType || !Array.isArray(eventTypeOptions) || !Array.isArray(conditionOptions)) {
      return res.status(400).json({ ok: false, error: 'componentType, eventTypeOptions[], conditionOptions[] are required' });
    }
    const row = await adminCreateComponentType({ componentType, eventTypeOptions, conditionOptions, promptedInAudit });
    res.json({ ok: true, componentType: row });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, error: `Component type "${req.body?.componentType}" already exists` });
    next(e);
  }
});

router.patch('/admin/component-types/:type', async (req, res, next) => {
  try {
    const { eventTypeOptions, conditionOptions, promptedInAudit, sortOrder } = req.body || {};
    const row = await adminUpdateComponentType(req.params.type, { eventTypeOptions, conditionOptions, promptedInAudit, sortOrder });
    if (!row) return res.status(404).json({ ok: false, error: 'Component type not found' });
    res.json({ ok: true, componentType: row });
  } catch (e) { next(e); }
});

router.get('/admin/building-types', async (req, res, next) => {
  try { res.json({ buildingTypes: await listBuildingTypes() }); } catch (e) { next(e); }
});

router.post('/admin/building-types', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    res.json({ ok: true, buildingType: await adminCreateBuildingType(name) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, error: `Building type "${req.body?.name}" already exists` });
    next(e);
  }
});

router.delete('/admin/building-types/:id', async (req, res, next) => {
  try {
    await adminDeleteBuildingType(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/admin/applicability', async (req, res, next) => {
  try { res.json(await adminGetApplicabilityMatrix()); } catch (e) { next(e); }
});

router.put('/admin/applicability', async (req, res, next) => {
  try {
    const { buildingTypeId, questionKey, applies } = req.body || {};
    if (buildingTypeId == null || !questionKey || typeof applies !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'buildingTypeId, questionKey, applies(boolean) are required' });
    }
    await adminSetApplicability(buildingTypeId, questionKey, applies);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/admin/sub-areas', async (req, res, next) => {
  try { res.json({ subAreas: await adminListSubAreas() }); } catch (e) { next(e); }
});

router.post('/admin/sub-areas', async (req, res, next) => {
  try {
    const { componentType, subArea, sortOrder } = req.body || {};
    if (!componentType || !subArea) return res.status(400).json({ ok: false, error: 'componentType and subArea are required' });
    res.json({ ok: true, subArea: await adminCreateSubArea(componentType, subArea, sortOrder) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'That sub-area already exists for this component type' });
    next(e);
  }
});

router.delete('/admin/sub-areas/:id', async (req, res, next) => {
  try {
    await adminDeleteSubArea(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Work Orders + Asset Updates write-back (brief's Phase 2) ----

router.get('/work-orders', async (req, res, next) => {
  try { res.json({ workOrders: await listWorkOrders() }); } catch (e) { next(e); }
});

router.get('/work-orders/:id', async (req, res, next) => {
  try {
    const detail = await getWorkOrderDetail(req.params.id);
    if (!detail) return res.status(404).json({ ok: false, error: 'Work Order not found' });
    res.json(detail);
  } catch (e) { next(e); }
});

router.post('/work-orders', async (req, res, next) => {
  try {
    const { title, assetId, locationId, priority, description, scheduledDate, assetUpdates } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, error: 'title is required' });
    const result = await createWorkOrder({ title, assetId, locationId, priority, description, scheduledDate, assetUpdates });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.post('/work-orders/:id/duplicate', async (req, res, next) => {
  try {
    const newId = await duplicateWorkOrder(req.params.id);
    if (!newId) return res.status(404).json({ ok: false, error: 'Work Order not found' });
    res.json({ ok: true, workOrderId: newId });
  } catch (e) { next(e); }
});

router.patch('/work-orders/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const fields = {};
    if (body.title != null) fields.title = body.title;
    if (body.description !== undefined) fields.description = body.description;
    if (body.priority != null) fields.priority = body.priority;
    if (body.status != null) fields.status = body.status;
    if (body.assetId !== undefined) fields.asset_id = body.assetId === '' ? null : Number(body.assetId);
    if (body.dateReported !== undefined) fields.date_reported = body.dateReported;
    if (body.dateCompleted !== undefined) fields.date_completed = body.dateCompleted;
    if (body.scheduledDate !== undefined) fields.scheduled_date = body.scheduledDate;
    if (body.estimatedHours !== undefined) fields.estimated_hours = body.estimatedHours === '' ? null : Math.round(Number(body.estimatedHours));
    if (body.actualHours !== undefined) fields.actual_hours = body.actualHours === '' ? null : Math.round(Number(body.actualHours));
    if (body.estimatedCost !== undefined) fields.estimated_cost = body.estimatedCost === '' ? null : Number(body.estimatedCost);
    if (body.actualCost !== undefined) fields.actual_cost = body.actualCost === '' ? null : Number(body.actualCost);
    const detail = await updateWorkOrder(req.params.id, fields);
    if (!detail) return res.status(404).json({ ok: false, error: 'Work Order not found' });
    res.json({ ok: true, ...detail });
  } catch (e) { next(e); }
});

router.post('/work-orders/:id/asset-updates', async (req, res, next) => {
  try {
    const { targetField, newValue } = req.body || {};
    const row = await addAssetUpdateToWorkOrder(req.params.id, targetField, newValue);
    res.json({ ok: true, assetUpdate: row });
  } catch (e) { next(e); }
});

router.delete('/work-orders/:id/asset-updates/:auId', async (req, res, next) => {
  try {
    const result = await deleteAssetUpdate(req.params.auId);
    if (result.notFound) return res.status(404).json({ ok: false, error: 'Not found' });
    if (result.alreadyApplied) return res.status(400).json({ ok: false, error: 'This job line was already applied to the asset' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/work-orders/:id/complete', async (req, res, next) => {
  try {
    const result = await completeWorkOrder(req.params.id);
    if (!result) return res.status(404).json({ ok: false, error: 'Work Order not found' });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.post('/work-orders/:id/volunteers', async (req, res, next) => {
  try { res.json(await assignVolunteer(req.params.id, req.body?.volunteerId)); } catch (e) { next(e); }
});
router.delete('/work-orders/:id/volunteers/:volunteerId', async (req, res, next) => {
  try { res.json(await unassignVolunteer(req.params.id, req.params.volunteerId)); } catch (e) { next(e); }
});
router.post('/work-orders/:id/vendors', async (req, res, next) => {
  try { res.json(await assignVendor(req.params.id, req.body?.vendorId)); } catch (e) { next(e); }
});
router.delete('/work-orders/:id/vendors/:vendorId', async (req, res, next) => {
  try { res.json(await unassignVendor(req.params.id, req.params.vendorId)); } catch (e) { next(e); }
});

router.get('/volunteers', async (req, res, next) => {
  try { res.json({ volunteers: await listVolunteers({ includeInactive: req.query.all === '1' }) }); } catch (e) { next(e); }
});
router.post('/volunteers', async (req, res, next) => {
  try {
    const { name, phone, email, address, skill } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    res.json({ ok: true, volunteer: await createVolunteer({ name, phone, email, address, skill }) });
  } catch (e) { next(e); }
});
router.patch('/volunteers/:id', async (req, res, next) => {
  try {
    const { name, phone, email, address, skill } = req.body || {};
    const volunteer = await updateVolunteer(req.params.id, { name, phone, email, address, skill });
    if (!volunteer) return res.status(404).json({ ok: false, error: 'Volunteer not found' });
    res.json({ ok: true, volunteer });
  } catch (e) { next(e); }
});
router.delete('/volunteers/:id', async (req, res, next) => {
  try { res.json({ ok: true, ...(await removeVolunteer(req.params.id)) }); } catch (e) { next(e); }
});

router.get('/vendors', async (req, res, next) => {
  try { res.json({ vendors: await listVendors({ includeInactive: req.query.all === '1' }) }); } catch (e) { next(e); }
});
router.post('/vendors', async (req, res, next) => {
  try {
    const { name, phone, email, address, specialty } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    res.json({ ok: true, vendor: await createVendor({ name, phone, email, address, specialty }) });
  } catch (e) { next(e); }
});
router.patch('/vendors/:id', async (req, res, next) => {
  try {
    const { name, phone, email, address, specialty } = req.body || {};
    const vendor = await updateVendor(req.params.id, { name, phone, email, address, specialty });
    if (!vendor) return res.status(404).json({ ok: false, error: 'Vendor not found' });
    res.json({ ok: true, vendor });
  } catch (e) { next(e); }
});
router.delete('/vendors/:id', async (req, res, next) => {
  try { res.json({ ok: true, ...(await removeVendor(req.params.id)) }); } catch (e) { next(e); }
});

router.get('/skills', async (req, res, next) => {
  try { res.json({ skills: await listSkills() }); } catch (e) { next(e); }
});
router.post('/skills', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    res.json({ ok: true, skill: await createSkill(name) });
  } catch (e) { next(e); }
});

// ---- Asset live search + quick-create — for any "pick an asset" combobox
// in the app. Always hits the DB fresh (no cached list), so an asset added
// anywhere shows up in every picker immediately. ----

router.get('/assets-search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    res.json({ assets: q ? await searchAssetsLive(q) : [] });
  } catch (e) { next(e); }
});

router.post('/assets', async (req, res, next) => {
  try {
    const { name, locationId, assetType } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'name is required' });
    const asset = await createAssetQuick({ name: name.trim(), locationId, assetType });
    res.json({ ok: true, asset });
  } catch (e) { next(e); }
});

// ---- Work Order templates ("canned" WOs for repeatable tasks) ----

router.get('/work-order-templates', async (req, res, next) => {
  try { res.json({ templates: await listWorkOrderTemplates() }); } catch (e) { next(e); }
});
router.post('/work-order-templates', async (req, res, next) => {
  try {
    const { name, defaultTitle, defaultPriority, defaultDescription, jobLineDefaults } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    res.json({ ok: true, template: await createWorkOrderTemplate({ name, defaultTitle, defaultPriority, defaultDescription, jobLineDefaults }) });
  } catch (e) { next(e); }
});
router.patch('/work-order-templates/:id', async (req, res, next) => {
  try {
    const { name, defaultTitle, defaultPriority, defaultDescription, jobLineDefaults } = req.body || {};
    const template = await updateWorkOrderTemplate(req.params.id, { name, defaultTitle, defaultPriority, defaultDescription, jobLineDefaults });
    if (!template) return res.status(404).json({ ok: false, error: 'Template not found' });
    res.json({ ok: true, template });
  } catch (e) { next(e); }
});
router.delete('/work-order-templates/:id', async (req, res, next) => {
  try { await deleteWorkOrderTemplate(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

export default router;
