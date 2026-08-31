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
import { renderChecklistPdf, renderWorkOrderScopePdf } from '../pdf.js';
import { currentUsername, currentRole } from '../requestContext.js';
import {
  listLocations, createLocation, updateLocation, listAssetsByLocation, searchLocationsAndAssets,
  getAssetPropertyFields, getComponentTypeCatalog, getAssetDetail, getAssetHistory,
  submitAudit, getMaintenanceLog, listBuildingTypes, setAssetBuildingType,
  listAssetNotes, createAssetNote, resolveAssetNote, updateAssetFull,
  adminListPropertyFields, adminCreatePropertyField, adminUpdatePropertyField,
  adminListComponentTypes, adminCreateComponentType, adminUpdateComponentType,
  adminCreateBuildingType, adminDeleteBuildingType,
  adminGetApplicabilityMatrix, adminSetApplicability,
  adminListSubAreas, adminCreateSubArea, adminDeleteSubArea,
  listWorkOrders, getWorkOrderDetail, createWorkOrder, updateWorkOrder, duplicateWorkOrder, getWorkOrderSummary,
  listWorkOrderTemplates, createWorkOrderTemplate, updateWorkOrderTemplate, deleteWorkOrderTemplate,
  addAssetUpdateToWorkOrder, deleteAssetUpdate, completeWorkOrder,
  assignVolunteer, unassignVolunteer, assignVendor, unassignVendor,
  listVolunteers, createVolunteer, updateVolunteer, removeVolunteer,
  listVendors, createVendor, updateVendor, removeVendor,
  listSkills, createSkill, searchAssetsLive, createAssetQuick,
  listWorkOrderTasks, createWorkOrderTask, updateWorkOrderTask, deleteWorkOrderTask,
  listWorkOrderLogEntries, createWorkOrderLogEntry, deleteWorkOrderLogEntry,
  listCalendarEventOccurrences, getCalendarEvent, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent,
  listChecklistTemplates, createChecklistTemplate, updateChecklistTemplate, deleteChecklistTemplate,
  getChecklistInstanceForWorkOrder, getChecklistInstanceForCalendarEvent,
  attachChecklistToWorkOrder, attachChecklistToCalendarEvent, detachChecklistInstance, toggleChecklistStep,
  getChecklistInstanceForExport,
  listUsers, countActiveUsers, countActiveAdmins, createUser, updateUser, deleteUser,
  listActivityLog,
  getBudgetSettings, updateBudgetSettings, getBudgetOverview,
  listCapitalCampaignProjects, createCapitalCampaignProject, updateCapitalCampaignProject, deleteCapitalCampaignProject,
  listOtherBudgetCategories, createOtherBudgetCategory, updateOtherBudgetCategory, deleteOtherBudgetCategory,
  listCabinHolders, createCabinHolder, updateCabinHolder, deleteCabinHolder,
  getAssetsReportRawData, getWorkOrdersReportRawData, getWorkOrderLogReportRawData,
  listCrewSessionsForWorkOrder, createCrewSession, deleteCrewSession, getCrewSessionReportRawData, getCrewHoursSummary,
  listReportFavorites, createReportFavorite, deleteReportFavorite,
} from '../db.js';
import {
  buildAssetReportRows, buildWorkOrderReportRows, buildWorkOrderLogReportRows, buildCrewSessionReportRows,
  assetColumnSpecs, WORK_ORDER_COLUMN_SPECS, WORK_ORDER_LOG_COLUMN_SPECS, CREW_SESSION_COLUMN_SPECS,
  columnDefsFromRows, applyReportFilters, rowsToCsv, canonicalFiltersKey,
} from '../reports.js';

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

router.post('/locations', async (req, res, next) => {
  try {
    const { name, parentLocationId, locationType, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'name is required' });
    res.json({ ok: true, location: await createLocation({
      name: name.trim(), parentLocationId: parentLocationId ? Number(parentLocationId) : null,
      locationType: locationType || null, notes: notes || null,
    }) });
  } catch (e) { next(e); }
});

router.patch('/locations/:id', async (req, res, next) => {
  try {
    const { name, parentLocationId, locationType, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'name is required' });
    const location = await updateLocation(req.params.id, {
      name: name.trim(), parentLocationId: parentLocationId ? Number(parentLocationId) : null,
      locationType: locationType || null, notes: notes || null,
    });
    if (!location) return res.status(404).json({ ok: false, error: 'Location not found' });
    res.json({ ok: true, location });
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
      currentUser: { username: currentUsername(), role: currentRole() },
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
    const { asset, componentRows, propertyHistory } = await getAssetHistory(req.params.id);
    if (!asset) return res.status(404).json({ ok: false, error: 'Asset not found' });
    res.json({ asset, history: sortHistory(componentRows), propertyHistory });
  } catch (e) { next(e); }
});

router.post('/assets/:id/audit', async (req, res, next) => {
  try {
    const { properties = {}, componentEvents = [], finding = null, generalPhotos = [] } = req.body || {};
    const result = await submitAudit(req.params.id, { properties, componentEvents, finding, generalPhotos });
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

// ── Reports v1: filterable/exportable Assets + Work Orders. Not the full
//    custom report builder (arbitrary fields/functions) — deliberately
//    scoped to a faceted filter + CSV export, with another entity addable
//    later by following the same pattern (see reports.js). ────────────────

async function getReportRowsAndSpecs(entity) {
  if (entity === 'assets') {
    const raw = await getAssetsReportRawData();
    const componentSchema = await getComponentTypeCatalog();
    return {
      rows: buildAssetReportRows(raw, componentSchema.componentTypeOptions),
      specs: assetColumnSpecs(raw.propertyFields, componentSchema.componentTypeOptions),
    };
  }
  if (entity === 'workOrders') {
    const raw = await getWorkOrdersReportRawData();
    return { rows: buildWorkOrderReportRows(raw), specs: WORK_ORDER_COLUMN_SPECS };
  }
  if (entity === 'workOrderLog') {
    const raw = await getWorkOrderLogReportRawData();
    return { rows: buildWorkOrderLogReportRows(raw), specs: WORK_ORDER_LOG_COLUMN_SPECS };
  }
  if (entity === 'crewSessions') {
    const raw = await getCrewSessionReportRawData();
    return { rows: buildCrewSessionReportRows(raw), specs: CREW_SESSION_COLUMN_SPECS };
  }
  return null;
}

function parseJsonQueryParam(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

router.get('/reports/schema', async (req, res, next) => {
  try {
    const result = await getReportRowsAndSpecs(req.query.entity);
    if (!result) return res.status(400).json({ ok: false, error: 'Unknown entity' });
    res.json({ columns: columnDefsFromRows(result.rows, result.specs) });
  } catch (e) { next(e); }
});

router.get('/reports/data', async (req, res, next) => {
  try {
    const result = await getReportRowsAndSpecs(req.query.entity);
    if (!result) return res.status(400).json({ ok: false, error: 'Unknown entity' });
    res.json({ rows: applyReportFilters(result.rows, parseJsonQueryParam(req.query.filters)) });
  } catch (e) { next(e); }
});

router.get('/reports/export', async (req, res, next) => {
  try {
    const result = await getReportRowsAndSpecs(req.query.entity);
    if (!result) return res.status(400).json({ ok: false, error: 'Unknown entity' });
    const filtered = applyReportFilters(result.rows, parseJsonQueryParam(req.query.filters));
    const columns = parseJsonQueryParam(req.query.columns);
    const columnKeys = columns && columns.length ? columns : result.specs.map((s) => s.key);
    const csv = rowsToCsv(filtered, columnKeys);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.query.entity}-report.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});

router.get('/reports/favorites', async (req, res, next) => {
  try {
    if (!req.query.entity) return res.status(400).json({ ok: false, error: 'entity is required' });
    res.json({ favorites: await listReportFavorites(req.query.entity) });
  } catch (e) { next(e); }
});

router.post('/reports/favorites', async (req, res, next) => {
  try {
    const { entity, label, filters, visibleColumns, sortKey, sortDir } = req.body || {};
    if (!entity || !label?.trim()) return res.status(400).json({ ok: false, error: 'A name for this view is required' });
    if (!filters || !Object.keys(filters).length) return res.status(400).json({ ok: false, error: 'Apply at least one filter before saving a favorite' });
    const existing = await listReportFavorites(entity);
    const key = canonicalFiltersKey(filters);
    const dupe = existing.find((f) => canonicalFiltersKey(f.Filters) === key);
    if (dupe) return res.status(409).json({ ok: false, error: `You already have a favorite with these exact filters: "${dupe.Label}"` });
    const favorite = await createReportFavorite({ entity, label: label.trim(), filters, visibleColumns, sortKey, sortDir });
    res.json({ ok: true, favorite });
  } catch (e) { next(e); }
});

router.delete('/reports/favorites/:id', async (req, res, next) => {
  try { await deleteReportFavorite(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

router.get('/capital-plan', async (req, res, next) => {
  try {
    const { componentType, condition } = req.query;
    const { rows, summary } = await buildCapitalPlanPg({ componentType, condition });
    res.json({ rows, summary });
  } catch (e) { next(e); }
});

// ---- Budget separation: operating budget vs. capital campaigns vs.
//      cabin-holder-funded work vs. user-defined "other" categories ----

router.get('/budget/overview', async (req, res, next) => {
  try { res.json(await getBudgetOverview()); } catch (e) { next(e); }
});
router.get('/budget/settings', async (req, res, next) => {
  try { res.json(await getBudgetSettings()); } catch (e) { next(e); }
});
router.put('/budget/settings', async (req, res, next) => {
  try {
    const { annualOperatingBudget } = req.body || {};
    if (annualOperatingBudget == null || Number.isNaN(Number(annualOperatingBudget))) {
      return res.status(400).json({ ok: false, error: 'annualOperatingBudget must be a number' });
    }
    res.json({ ok: true, settings: await updateBudgetSettings(Number(annualOperatingBudget)) });
  } catch (e) { next(e); }
});

// Capital Campaign Projects, Other Categories, and Cabin-Holders are all the
// same shape (name/description, cost-itemized via work_orders) — one
// generic set of routes per funding-entity type.
function fundingEntityRoutes(path, { list, create, update, remove }) {
  router.get(`/${path}`, async (req, res, next) => {
    try { res.json({ items: await list() }); } catch (e) { next(e); }
  });
  router.post(`/${path}`, async (req, res, next) => {
    try {
      const { name, description, notes } = req.body || {};
      if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'Name is required' });
      res.json({ ok: true, item: await create({ name: name.trim(), description, notes }) });
    } catch (e) { next(e); }
  });
  router.patch(`/${path}/:id`, async (req, res, next) => {
    try {
      const { name, description, notes } = req.body || {};
      const item = await update(req.params.id, { name: name?.trim(), description, notes });
      if (!item) return res.status(404).json({ ok: false, error: 'Not found' });
      res.json({ ok: true, item });
    } catch (e) { next(e); }
  });
  router.delete(`/${path}/:id`, async (req, res, next) => {
    try { await remove(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
  });
}
fundingEntityRoutes('budget/capital-campaign-projects', {
  list: listCapitalCampaignProjects, create: createCapitalCampaignProject,
  update: updateCapitalCampaignProject, remove: deleteCapitalCampaignProject,
});
fundingEntityRoutes('budget/other-categories', {
  list: listOtherBudgetCategories, create: createOtherBudgetCategory,
  update: updateOtherBudgetCategory, remove: deleteOtherBudgetCategory,
});
fundingEntityRoutes('budget/cabin-holders', {
  list: listCabinHolders, create: createCabinHolder, update: updateCabinHolder, remove: deleteCabinHolder,
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
    const [tasks, checklist, logEntries, crewSessions] = await Promise.all([
      listWorkOrderTasks(req.params.id), getChecklistInstanceForWorkOrder(req.params.id), listWorkOrderLogEntries(req.params.id),
      listCrewSessionsForWorkOrder(req.params.id),
    ]);
    res.json({ ...detail, tasks, checklist, logEntries, crewSessions });
  } catch (e) { next(e); }
});

router.post('/work-orders/:id/log', async (req, res, next) => {
  try {
    const { note, hours, statusChange } = req.body || {};
    if (!note || !note.trim()) return res.status(400).json({ ok: false, error: 'A note is required' });
    const entry = await createWorkOrderLogEntry(req.params.id, {
      note: note.trim(), hours: hours ? Number(hours) : null, statusChange: statusChange || null,
    });
    res.json({ ok: true, entry });
  } catch (e) { next(e); }
});
router.delete('/work-order-log/:id', async (req, res, next) => {
  try { await deleteWorkOrderLogEntry(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---- Crew Sessions — attendance-based hours, optionally tied to a Work
// Order (workOrderId) or standalone (activity label instead) ----

router.post('/crew-sessions', async (req, res, next) => {
  try {
    const { workOrderId, activity, sessionDate, hours, note, volunteerIds, vendorIds } = req.body || {};
    if (!workOrderId && !(activity || '').trim()) {
      return res.status(400).json({ ok: false, error: 'A session needs either a Work Order or an activity label' });
    }
    const session = await createCrewSession({
      workOrderId: workOrderId || null, activity: activity?.trim() || null,
      sessionDate: sessionDate || null, hours: hours ? Number(hours) : null, note: note?.trim() || null,
      volunteerIds: (volunteerIds || []).map(Number), vendorIds: (vendorIds || []).map(Number),
    });
    res.json({ ok: true, session });
  } catch (e) { next(e); }
});
router.delete('/crew-sessions/:id', async (req, res, next) => {
  try { await deleteCrewSession(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

router.get('/crew-hours/summary', async (req, res, next) => {
  try { res.json(await getCrewHoursSummary({ from: req.query.from || null, to: req.query.to || null })); } catch (e) { next(e); }
});

// ---- Work Order Tasks (free-text job lines — the default way to add work) ----

router.post('/work-orders/:id/tasks', async (req, res, next) => {
  try {
    const { description } = req.body || {};
    if (!description || !description.trim()) return res.status(400).json({ ok: false, error: 'description is required' });
    res.json({ ok: true, task: await createWorkOrderTask(req.params.id, description.trim()) });
  } catch (e) { next(e); }
});
router.patch('/work-order-tasks/:taskId', async (req, res, next) => {
  try {
    const { description, done } = req.body || {};
    const task = await updateWorkOrderTask(req.params.taskId, { description, done });
    if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
    res.json({ ok: true, task });
  } catch (e) { next(e); }
});
router.delete('/work-order-tasks/:taskId', async (req, res, next) => {
  try { await deleteWorkOrderTask(req.params.taskId); res.json({ ok: true }); } catch (e) { next(e); }
});

router.post('/work-orders', async (req, res, next) => {
  try {
    const { title, assetId, locationId, priority, description, scheduledDate, assetUpdates, tasks } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, error: 'title is required' });
    const result = await createWorkOrder({ title, assetId, locationId, priority, description, scheduledDate, assetUpdates, tasks });
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
    if (body.fundingSource != null) fields.funding_source = body.fundingSource;
    if (body.fundingRefId !== undefined) fields.funding_ref_id = body.fundingRefId === '' ? null : Number(body.fundingRefId);
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
    const { name, defaultTitle, defaultPriority, defaultDescription, taskDefaults, jobLineDefaults } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    res.json({ ok: true, template: await createWorkOrderTemplate({ name, defaultTitle, defaultPriority, defaultDescription, taskDefaults, jobLineDefaults }) });
  } catch (e) { next(e); }
});
router.patch('/work-order-templates/:id', async (req, res, next) => {
  try {
    const { name, defaultTitle, defaultPriority, defaultDescription, taskDefaults, jobLineDefaults } = req.body || {};
    const template = await updateWorkOrderTemplate(req.params.id, { name, defaultTitle, defaultPriority, defaultDescription, taskDefaults, jobLineDefaults });
    if (!template) return res.status(404).json({ ok: false, error: 'Template not found' });
    res.json({ ok: true, template });
  } catch (e) { next(e); }
});
router.delete('/work-order-templates/:id', async (req, res, next) => {
  try { await deleteWorkOrderTemplate(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---- Calendar Events (independent of Work Orders; optional link either way) ----

router.get('/calendar-events', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to (YYYY-MM-DD) are required' });
    res.json({ occurrences: await listCalendarEventOccurrences(from, to) });
  } catch (e) { next(e); }
});
router.get('/calendar-events/:id', async (req, res, next) => {
  try {
    const event = await getCalendarEvent(req.params.id);
    if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
    const checklist = await getChecklistInstanceForCalendarEvent(req.params.id);
    res.json({ event, checklist });
  } catch (e) { next(e); }
});
router.post('/calendar-events', async (req, res, next) => {
  try {
    const { title, description, eventDate, recurrenceType, recurrenceInterval, recurrenceEndDate, workOrderId, workOrderTaskId } = req.body || {};
    if (!title || !eventDate) return res.status(400).json({ ok: false, error: 'title and eventDate are required' });
    res.json({ ok: true, event: await createCalendarEvent({ title, description, eventDate, recurrenceType, recurrenceInterval, recurrenceEndDate, workOrderId, workOrderTaskId }) });
  } catch (e) { next(e); }
});
router.patch('/calendar-events/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const fields = {};
    if (body.title != null) fields.title = body.title;
    if (body.description !== undefined) fields.description = body.description;
    if (body.eventDate != null) fields.event_date = body.eventDate;
    if (body.recurrenceType != null) fields.recurrence_type = body.recurrenceType;
    if (body.recurrenceInterval != null) fields.recurrence_interval = body.recurrenceInterval;
    if (body.recurrenceEndDate !== undefined) fields.recurrence_end_date = body.recurrenceEndDate;
    if (body.workOrderId !== undefined) fields.work_order_id = body.workOrderId === '' ? null : Number(body.workOrderId);
    if (body.workOrderTaskId !== undefined) fields.work_order_task_id = body.workOrderTaskId === '' ? null : Number(body.workOrderTaskId);
    const event = await updateCalendarEvent(req.params.id, fields);
    if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
    res.json({ ok: true, event });
  } catch (e) { next(e); }
});
router.delete('/calendar-events/:id', async (req, res, next) => {
  try { await deleteCalendarEvent(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---- Checklists (simple ordered steps — templates + live checkable instances) ----

router.get('/checklist-templates', async (req, res, next) => {
  try { res.json({ templates: await listChecklistTemplates() }); } catch (e) { next(e); }
});
router.post('/checklist-templates', async (req, res, next) => {
  try {
    const { name, steps } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    res.json({ ok: true, template: await createChecklistTemplate({ name, steps }) });
  } catch (e) { next(e); }
});
router.patch('/checklist-templates/:id', async (req, res, next) => {
  try {
    const { name, steps } = req.body || {};
    const template = await updateChecklistTemplate(req.params.id, { name, steps });
    if (!template) return res.status(404).json({ ok: false, error: 'Template not found' });
    res.json({ ok: true, template });
  } catch (e) { next(e); }
});
router.delete('/checklist-templates/:id', async (req, res, next) => {
  try { await deleteChecklistTemplate(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

router.post('/work-orders/:id/checklist', async (req, res, next) => {
  try {
    const { templateId } = req.body || {};
    if (!templateId) return res.status(400).json({ ok: false, error: 'templateId is required' });
    res.json({ ok: true, checklist: await attachChecklistToWorkOrder(req.params.id, templateId) });
  } catch (e) { next(e); }
});
router.post('/calendar-events/:id/checklist', async (req, res, next) => {
  try {
    const { templateId } = req.body || {};
    if (!templateId) return res.status(400).json({ ok: false, error: 'templateId is required' });
    res.json({ ok: true, checklist: await attachChecklistToCalendarEvent(req.params.id, templateId) });
  } catch (e) { next(e); }
});
router.delete('/checklist-instances/:id', async (req, res, next) => {
  try { await detachChecklistInstance(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});
router.patch('/checklist-steps/:id', async (req, res, next) => {
  try {
    const { done } = req.body || {};
    const step = await toggleChecklistStep(req.params.id, !!done);
    if (!step) return res.status(404).json({ ok: false, error: 'Step not found' });
    res.json({ ok: true, step });
  } catch (e) { next(e); }
});

// A step whose dependency isn't satisfied is left out of the export, same as
// what's shown on screen — the PDF should match what you'd actually see.
router.get('/checklist-instances/:id/pdf', async (req, res, next) => {
  try {
    const instance = await getChecklistInstanceForExport(req.params.id);
    if (!instance) return res.status(404).json({ ok: false, error: 'Checklist not found' });
    const stepById = new Map(instance.Steps.map((s) => [s.Id, s]));
    const isVisible = (s) => {
      if (s.DependsOnInstanceStepId == null) return true;
      const dep = stepById.get(s.DependsOnInstanceStepId);
      return dep ? dep.Done === s.ShowWhenChecked : true;
    };
    const pdf = await renderChecklistPdf({
      checklistName: instance.Name,
      contextLabel: instance.ContextLabel,
      steps: instance.Steps.map((s) => ({ text: s.StepText, done: s.Done, visible: isVisible(s) })),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${instance.Name.replace(/[^a-z0-9]+/gi, '-')}.pdf"`);
    res.send(pdf);
  } catch (e) { next(e); }
});

// Handed to a vendor or volunteer so there's a record every repair went
// through the system (see the user's "all future repairs run through this"
// request) — deliberately excludes cost figures, see pdf.js.
router.get('/work-orders/:id/scope-pdf', async (req, res, next) => {
  try {
    const detail = await getWorkOrderDetail(req.params.id);
    if (!detail) return res.status(404).json({ ok: false, error: 'Work Order not found' });
    const [tasks, checklist] = await Promise.all([
      listWorkOrderTasks(req.params.id), getChecklistInstanceForWorkOrder(req.params.id),
    ]);
    let checklistSteps = null;
    if (checklist) {
      const stepById = new Map(checklist.Steps.map((s) => [s.Id, s]));
      const isVisible = (s) => {
        if (s.DependsOnInstanceStepId == null) return true;
        const dep = stepById.get(s.DependsOnInstanceStepId);
        return dep ? dep.Done === s.ShowWhenChecked : true;
      };
      checklistSteps = checklist.Steps.filter(isVisible).map((s) => s.StepText);
    }
    const w = detail.workOrder;
    const pdf = await renderWorkOrderScopePdf({
      title: w.Title,
      assetName: w.Asset?.Name,
      locationName: w.Location?.Name,
      priority: w.Priority,
      scheduledDate: w['Scheduled Date'],
      description: w.Description,
      tasks: tasks.filter((t) => !t.Done).map((t) => t.Description),
      volunteers: (detail.volunteers || []).map((v) => v.Name),
      vendors: (detail.vendors || []).map((v) => v.Name),
      checklistSteps,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Scope of Work - ${w.Title.replace(/[^a-z0-9]+/gi, '-')}.pdf"`);
    res.send(pdf);
  } catch (e) { next(e); }
});

// ---- Users (Admin tab — replaces editing APP_USERS/SQL by hand) ----
// Any logged-in user can manage accounts here; this app has no separate
// admin role — the whole tab is already behind the login session.

router.get('/users', async (req, res, next) => {
  try { res.json({ users: await listUsers() }); } catch (e) { next(e); }
});

router.post('/users', async (req, res, next) => {
  try {
    const { username, password, email, role } = req.body || {};
    if (!username || !username.trim()) return res.status(400).json({ ok: false, error: 'Username is required' });
    if (!password || password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
    const user = await createUser({ username: username.trim(), password, email: (email || '').trim(), role });
    res.json({ ok: true, user });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'That username is already taken' });
    next(e);
  }
});

router.patch('/users/:id', async (req, res, next) => {
  try {
    const { email, password, active, role } = req.body || {};
    if (password !== undefined && password !== '' && password.length < 6) {
      return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
    }
    const target = (await listUsers()).find((u) => u.Id === Number(req.params.id));
    if (active === false && target?.Active && (await countActiveUsers()) <= 1) {
      return res.status(400).json({ ok: false, error: 'Cannot deactivate the last active user — you would be locked out' });
    }
    if (role === 'standard' && target?.Role === 'admin' && (await countActiveAdmins()) <= 1) {
      return res.status(400).json({ ok: false, error: 'Cannot demote the last admin — no one would be left to manage roles' });
    }
    const user = await updateUser(req.params.id, {
      email: email !== undefined ? email.trim() : undefined,
      password: password || undefined,
      active: active !== undefined ? !!active : undefined,
      role: role !== undefined ? role : undefined,
    });
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    res.json({ ok: true, user });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'That username is already taken' });
    next(e);
  }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    const target = (await listUsers()).find((u) => u.Id === Number(req.params.id));
    if (!target) return res.status(404).json({ ok: false, error: 'User not found' });
    if (target.Active && (await countActiveUsers()) <= 1) {
      return res.status(400).json({ ok: false, error: 'Cannot delete the last active user — you would be locked out' });
    }
    if (target.Active && target.Role === 'admin' && (await countActiveAdmins()) <= 1) {
      return res.status(400).json({ ok: false, error: 'Cannot delete the last admin — no one would be left to manage roles' });
    }
    await deleteUser(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Activity log ("what has been done") ----

router.get('/activity-log', async (req, res, next) => {
  try {
    const { entityType, action, limit, username } = req.query;
    res.json({ entries: await listActivityLog({ entityType, action, username, limit: limit ? Number(limit) : undefined }) });
  } catch (e) { next(e); }
});

// ---- Dashboard aggregates ----

router.get('/dashboard/wo-summary', async (req, res, next) => {
  try { res.json(await getWorkOrderSummary()); } catch (e) { next(e); }
});

export default router;
