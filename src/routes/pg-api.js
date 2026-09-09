// The app's API — Postgres-backed. Mounted at /api/pg (kept as the mount
// path through the NocoDB cutover; the old NocoDB-backed routes/api.js is gone).
//
// Property values in request/response bodies here use snake_case field KEYS
// (e.g. "has_key") matching the assets table columns and asset_property_fields
// catalog.
import express from 'express';
import multer from 'multer';
import { currentComponentState, sortHistory } from '../components.js';
import { buildCapitalPlanPg, buildBoardReportPg, buildForwardFocusReportPg, buildWorkPerformedReportPg, buildDeferredBacklogReportPg } from '../reportDataPg.js';
import {
  renderBoardReportHtml, renderBoardReportText, renderForwardFocusHtml, renderForwardFocusText, renderPlainEmailHtml,
  renderWorkPerformedHtml, renderWorkPerformedText, renderDeferredBacklogHtml, renderDeferredBacklogText,
} from '../reportRender.js';
import { storeAttachment } from '../storage.js';
import { renderChecklistPdf, renderWorkOrderScopePdf } from '../pdf.js';
import { currentUsername, currentRole } from '../requestContext.js';
import {
  listLocations, createLocation, updateLocation, listAssetsByLocation, searchLocationsAndAssets,
  getAssetPropertyFields, getComponentTypeCatalog, getAssetDetail, getAssetHistory,
  submitAudit, getMaintenanceLog, listBuildingTypes, setAssetBuildingType,
  listAssetNotes, createAssetNote, resolveAssetNote, updateAssetFull,
  listNotes, createNote, updateNote, deleteNote,
  adminListPropertyFields, adminCreatePropertyField, adminUpdatePropertyField,
  adminListComponentTypes, adminCreateComponentType, adminUpdateComponentType,
  adminCreateBuildingType, adminDeleteBuildingType,
  adminGetApplicabilityMatrix, adminSetApplicability,
  adminListSubAreas, adminCreateSubArea, adminDeleteSubArea,
  listWorkOrders, getWorkOrderDetail, createWorkOrder, updateWorkOrder, duplicateWorkOrder, getWorkOrderSummary,
  workOrderRollup, workOrderCloseGate,
  listWorkOrderStatuses, listJobLineStatuses,
  adminListWorkOrderStatuses, adminCreateWorkOrderStatus, adminUpdateWorkOrderStatus, adminDeleteWorkOrderStatus,
  adminListJobLineStatuses, adminCreateJobLineStatus, adminUpdateJobLineStatus, adminDeleteJobLineStatus,
  getDisplaySettings, updateDisplaySettings,
  listWorkOrderTemplates, createWorkOrderTemplate, updateWorkOrderTemplate, deleteWorkOrderTemplate,
  addAssetUpdateToWorkOrder, deleteAssetUpdate, completeWorkOrder,
  listJobLines, getJobLine, createJobLine, updateJobLine, deleteJobLine,
  assignVolunteerToJobLine, unassignVolunteerFromJobLine, assignVendorToJobLine, unassignVendorFromJobLine,
  listCauses, createCause, updateCause, deleteCause,
  listVolunteers, createVolunteer, updateVolunteer, removeVolunteer,
  listVendors, createVendor, updateVendor, removeVendor,
  listSkills, createSkill, searchAssetsLive, createAssetQuick,
  listAttachmentsForEntity, listAttachmentsForEntities, createAttachment, createAndLinkAttachment,
  updateAttachmentLink, detachAttachment, voidAttachment,
  listAttachmentRoles, createAttachmentRole, updateAttachmentRole, deleteAttachmentRole,
  listWorkOrderLogEntries, createWorkOrderLogEntry, deleteWorkOrderLogEntry,
  listCalendarEventOccurrences, getCalendarEvent, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent,
  listJobLinesScheduledInRange,
  generateDueWorkOrdersForRange,
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
  getJobLinesReportRawData, getFindingsReportRawData,
  listReportFavorites, createReportFavorite, deleteReportFavorite,
  adminListRequestFields, adminCreateRequestField, adminUpdateRequestField,
  listMaintenanceRequests, getMaintenanceRequestDetail, updateMaintenanceRequestStatus,
  convertRequestToWorkOrder, linkRequestToAsset, listRequestMessages, createRequestMessage,
  updateConditionFinding, deferFinding, dismissFinding, getFindingsSummary,
  listMapPins, setAssetMapLocation, listMapFeatures, createMapFeature, updateMapFeature, deleteMapFeature,
  listMapLayers, createMapLayer, updateMapLayer, deleteMapLayer,
  listInboxBatches, getInboxCount, suggestAssetsForText, triageAttachToEntity, triageCreateWorkOrder, triageCreateFinding, voidAttachments,
  splitWorkOrder, getWorkOrderFamily,
  listMapCalibrationPoints, createMapCalibrationPoint, deleteMapCalibrationPoint, nearestAssetsToGps,
  listJobLineTemplates, createJobLineTemplate, updateJobLineTemplate, deleteJobLineTemplate,
  getOpenFindingsForWoCreation, createWorkOrderFromFindings,
} from '../db.js';
import { sendMail, mailIsConfigured } from '../mailer.js';
import {
  buildAssetReportRows, buildWorkOrderReportRows, buildWorkOrderLogReportRows, buildCrewSessionReportRows,
  buildJobLineReportRows, JOB_LINE_COLUMN_SPECS, buildFindingReportRows, FINDING_COLUMN_SPECS,
  assetColumnSpecs, WORK_ORDER_COLUMN_SPECS, WORK_ORDER_LOG_COLUMN_SPECS, CREW_SESSION_COLUMN_SPECS,
  columnDefsFromRows, applyReportFilters, rowsToCsv, canonicalFiltersKey,
} from '../reports.js';

const router = express.Router();
// 25MB, not 15 — most mail servers reject above 25MB anyway (Phase 5 email
// ingest), so the upload path matches that ceiling everywhere, not just here.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---- Attachments (Build Brief v2 Phase 4) — replaces the old generic
// /upload + nine per-locus photo tables. One route ingests (resize/thumb/
// EXIF via storage.js) and, when entityType+entityId are given, links in the
// same step. Omitting them uploads unlinked — the audit form and the public
// maintenance-request portal need this because the row a photo belongs to
// (a finding, a component event, the request itself) doesn't exist until the
// whole form submits; the caller links it afterward, server-side. ----

router.post('/attachments', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const meta = await storeAttachment(req.file.buffer, {
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      category: req.body.category || 'misc',
      ownerId: req.body.ownerId || 'unknown',
    });
    const { entityType, entityId, roleId, classification, caption } = req.body || {};
    if (entityType && entityId) {
      const { attachment, linkId } = await createAndLinkAttachment(meta,
        { entityType, entityId: Number(entityId), roleId: roleId ? Number(roleId) : null, classification: classification || null, caption: caption || null },
        { source: 'upload', uploadedBy: currentUsername() });
      return res.json({ ok: true, attachment: { ...attachment, LinkId: linkId } });
    }
    const attachment = await createAttachment(meta, { source: 'upload', uploadedBy: currentUsername() });
    res.json({ ok: true, attachment });
  } catch (e) { next(e); }
});

router.get('/attachments', async (req, res, next) => {
  try {
    const { entityType, entityId } = req.query;
    if (!entityType || !entityId) return res.status(400).json({ ok: false, error: 'entityType and entityId are required' });
    res.json({ attachments: await listAttachmentsForEntity(entityType, entityId) });
  } catch (e) { next(e); }
});

router.patch('/attachment-links/:linkId', async (req, res, next) => {
  try {
    const { roleId, classification, caption, includeInReport, sortOrder, vendorId, quotedAmount, quoteDate, isSelectedQuote } = req.body || {};
    const updated = await updateAttachmentLink(req.params.linkId, {
      roleId: roleId === undefined ? undefined : (roleId ? Number(roleId) : null),
      classification, caption, includeInReport, sortOrder, vendorId: vendorId ? Number(vendorId) : undefined,
      quotedAmount, quoteDate, isSelectedQuote,
    });
    if (!updated) return res.status(404).json({ ok: false, error: 'Attachment link not found' });
    res.json({ ok: true, attachment: updated });
  } catch (e) { next(e); }
});

// Detach — removes this one link only. Fast, no confirm expected client-side.
router.delete('/attachment-links/:linkId', async (req, res, next) => {
  try { await detachAttachment(req.params.linkId); res.json({ ok: true }); } catch (e) { next(e); }
});

// Void — soft-deletes the file everywhere it's linked. One tap, no confirm —
// see voidAttachment's comment in db.js for why.
router.post('/attachments/:id/void', async (req, res, next) => {
  try { await voidAttachment(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

router.get('/attachment-roles', async (req, res, next) => {
  try { res.json({ roles: await listAttachmentRoles({ includeInactive: currentRole() === 'admin' }) }); } catch (e) { next(e); }
});
router.post('/admin/attachment-roles', async (req, res, next) => {
  try {
    const { name, sortOrder } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'Name is required' });
    res.json({ ok: true, role: await createAttachmentRole({ name: name.trim(), sortOrder }) });
  } catch (e) { next(e); }
});
router.patch('/admin/attachment-roles/:id', async (req, res, next) => {
  try {
    const { name, sortOrder, defaultIncludeInReport, active } = req.body || {};
    const updated = await updateAttachmentRole(req.params.id, { name, sortOrder, defaultIncludeInReport, active });
    if (!updated) return res.status(404).json({ ok: false, error: 'Role not found' });
    res.json({ ok: true, role: updated });
  } catch (e) { next(e); }
});
router.delete('/admin/attachment-roles/:id', async (req, res, next) => {
  try { await deleteAttachmentRole(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---- Triage inbox (Build Brief v2 Phase 5) ----

router.get('/inbox', async (req, res, next) => {
  try { res.json({ batches: await listInboxBatches() }); } catch (e) { next(e); }
});
router.get('/inbox/count', async (req, res, next) => {
  try { res.json({ count: await getInboxCount() }); } catch (e) { next(e); }
});
router.get('/inbox/suggest-assets', async (req, res, next) => {
  try {
    const { text, lat, lng } = req.query;
    if (lat && lng) return res.json({ suggestions: await nearestAssetsToGps(Number(lat), Number(lng)) });
    res.json({ suggestions: await suggestAssetsForText(text || '') });
  } catch (e) { next(e); }
});
router.post('/inbox/attach', async (req, res, next) => {
  try {
    const { attachmentIds, entityType, entityId, roleId } = req.body || {};
    if (!Array.isArray(attachmentIds) || !attachmentIds.length) return res.status(400).json({ ok: false, error: 'attachmentIds is required' });
    await triageAttachToEntity(attachmentIds, entityType, Number(entityId), { roleId: roleId ? Number(roleId) : null });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.post('/inbox/create-work-order', async (req, res, next) => {
  try {
    const { attachmentIds, assetId, title } = req.body || {};
    if (!Array.isArray(attachmentIds) || !attachmentIds.length) return res.status(400).json({ ok: false, error: 'attachmentIds is required' });
    if (!title) return res.status(400).json({ ok: false, error: 'title is required' });
    res.json({ ok: true, ...(await triageCreateWorkOrder(attachmentIds, { assetId: assetId ? Number(assetId) : null, title })) });
  } catch (e) { next(e); }
});
router.post('/inbox/create-finding', async (req, res, next) => {
  try {
    const { attachmentIds, assetId, severity, description } = req.body || {};
    if (!Array.isArray(attachmentIds) || !attachmentIds.length) return res.status(400).json({ ok: false, error: 'attachmentIds is required' });
    if (!assetId || !severity || !description) return res.status(400).json({ ok: false, error: 'assetId, severity, and description are required' });
    res.json({ ok: true, ...(await triageCreateFinding(attachmentIds, { assetId: Number(assetId), severity, description })) });
  } catch (e) { next(e); }
});
router.post('/inbox/void', async (req, res, next) => {
  try {
    const { attachmentIds } = req.body || {};
    if (!Array.isArray(attachmentIds) || !attachmentIds.length) return res.status(400).json({ ok: false, error: 'attachmentIds is required' });
    await voidAttachments(attachmentIds);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Work order splitting + family (Build Brief v2 Phase 5, §5.4) ----

router.post('/work-orders/:id/split', async (req, res, next) => {
  try {
    const { jobLineIds } = req.body || {};
    if (!Array.isArray(jobLineIds) || !jobLineIds.length) return res.status(400).json({ ok: false, error: 'jobLineIds is required' });
    res.json({ ok: true, ...(await splitWorkOrder(Number(req.params.id), jobLineIds.map(Number))) });
  } catch (e) { next(e); }
});
router.get('/work-orders/:id/family', async (req, res, next) => {
  try {
    const family = await getWorkOrderFamily(req.params.id);
    if (!family) return res.status(404).json({ ok: false, error: 'Work order not found' });
    res.json(family);
  } catch (e) { next(e); }
});

// ---- Map GPS calibration (Build Brief v2 Phase 5, §5.3) ----

router.get('/admin/map-calibration', async (req, res, next) => {
  try { res.json({ points: await listMapCalibrationPoints() }); } catch (e) { next(e); }
});
router.post('/admin/map-calibration', async (req, res, next) => {
  try {
    const { label, lat, lng, mapX, mapY } = req.body || {};
    if (!label || lat == null || lng == null || mapX == null || mapY == null) return res.status(400).json({ ok: false, error: 'label, lat, lng, mapX, and mapY are all required' });
    res.json({ ok: true, point: await createMapCalibrationPoint({ label, lat: Number(lat), lng: Number(lng), mapX: Number(mapX), mapY: Number(mapY) }) });
  } catch (e) { next(e); }
});
router.delete('/admin/map-calibration/:id', async (req, res, next) => {
  try { await deleteMapCalibrationPoint(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
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
    const [propertyFields, componentSchema, buildingTypes, workOrderStatuses, jobLineStatuses, displaySettings, attachmentRoles] = await Promise.all([
      getAssetPropertyFields(), getComponentTypeCatalog(), listBuildingTypes(),
      listWorkOrderStatuses(), listJobLineStatuses(), getDisplaySettings(), listAttachmentRoles(),
    ]);
    res.json({
      propertyFields,
      componentTypeOptions: componentSchema.componentTypeOptions,
      eventTypeOptions: componentSchema.eventTypeOptions,
      conditionOptions: componentSchema.conditionOptions,
      buildingTypes,
      workOrderStatuses, jobLineStatuses, displaySettings,
      findingSeverity: FINDING_SEVERITY_OPTIONS,
      attachmentRoles,
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

// ---- Interactive map — pins are assets with map_x/map_y set (image-pixel
// coords on the base map image — see CAMP_MAP_IMAGE in public-pg/app.js —
// origin top-left — never lat/lng).
// Buildings are already `assets` rows (asset_type = 'Camp Building', etc.),
// which is also where condition_findings/work_orders key off of, so pins
// only live on assets; `locations` has no map presence of its own. ----

router.get('/map/pins', async (req, res, next) => {
  try {
    res.json({ pins: await listMapPins() });
  } catch (e) { next(e); }
});

router.patch('/map/pins/:id', async (req, res, next) => {
  try {
    const { mapX, mapY, layerId } = req.body || {};
    // null/null explicitly unplaces the asset from the map; anything else
    // must be a real coordinate pair.
    const unplacing = mapX === null && mapY === null;
    if (!unplacing && (typeof mapX !== 'number' || typeof mapY !== 'number')) {
      return res.status(400).json({ ok: false, error: 'mapX and mapY (numbers) are required' });
    }
    const updated = await setAssetMapLocation(req.params.id, { mapX: unplacing ? null : mapX, mapY: unplacing ? null : mapY, layerId });
    if (!updated) return res.status(404).json({ ok: false, error: 'Asset not found' });
    res.json({ ok: true, pin: updated });
  } catch (e) { next(e); }
});

// ---- Map layers — user-defined (name/color/icon/z-order/visibility/
// condition-coloring is all just data in map_layers), never hardcoded on
// the server or client. See listMapLayers in db.js. ----

router.get('/map/layers', async (req, res, next) => {
  try { res.json({ layers: await listMapLayers() }); } catch (e) { next(e); }
});

router.post('/map/layers', async (req, res, next) => {
  try {
    const { name, geometry, color, icon, zIndex, defaultVisible, colorByCondition } = req.body || {};
    res.json({ ok: true, layer: await createMapLayer({ name, geometry, color, icon, zIndex, defaultVisible, colorByCondition }) });
  } catch (e) { next(e); }
});

router.patch('/map/layers/:id', async (req, res, next) => {
  try {
    const updated = await updateMapLayer(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ ok: false, error: 'Layer not found' });
    res.json({ ok: true, layer: updated });
  } catch (e) { next(e); }
});

router.delete('/map/layers/:id', async (req, res, next) => {
  try {
    await deleteMapLayer(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/notes', async (req, res, next) => {
  try { res.json({ notes: await listNotes() }); } catch (e) { next(e); }
});

router.post('/notes', async (req, res, next) => {
  try {
    const { title, body, category } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ ok: false, error: 'Title is required' });
    res.json({ ok: true, note: await createNote({ title: title.trim(), body, category }) });
  } catch (e) { next(e); }
});

router.patch('/notes/:id', async (req, res, next) => {
  try {
    const updated = await updateNote(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ ok: false, error: 'Note not found' });
    res.json({ ok: true, note: updated });
  } catch (e) { next(e); }
});

router.delete('/notes/:id', async (req, res, next) => {
  try {
    await deleteNote(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/map-features', async (req, res, next) => {
  try {
    res.json({ features: await listMapFeatures() });
  } catch (e) { next(e); }
});

router.post('/map-features', async (req, res, next) => {
  try {
    const { kind, label, points, assetId, style, layerId } = req.body || {};
    const created = await createMapFeature({ kind, label, points, assetId, style, layerId });
    res.json({ ok: true, feature: created });
  } catch (e) { next(e); }
});

router.patch('/map-features/:id', async (req, res, next) => {
  try {
    const updated = await updateMapFeature(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ ok: false, error: 'Map feature not found' });
    res.json({ ok: true, feature: updated });
  } catch (e) { next(e); }
});

router.delete('/map-features/:id', async (req, res, next) => {
  try {
    await deleteMapFeature(req.params.id);
    res.json({ ok: true });
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
    const { note, attachmentIds } = req.body || {};
    if (!note || !note.trim()) return res.status(400).json({ ok: false, error: 'note text is required' });
    const created = await createAssetNote(req.params.id, { note: note.trim(), attachmentIds: Array.isArray(attachmentIds) ? attachmentIds : [], createdBy: req.session?.user || null });
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

router.patch('/condition-findings/:id', async (req, res, next) => {
  try {
    const { boardFocus } = req.body || {};
    const finding = await updateConditionFinding(req.params.id, { boardFocus });
    if (!finding) return res.status(404).json({ ok: false, error: 'Condition Finding not found' });
    res.json({ ok: true, finding });
  } catch (e) { next(e); }
});
router.post('/condition-findings/:id/defer', async (req, res, next) => {
  try {
    const { reason, revisitDate } = req.body || {};
    const finding = await deferFinding(req.params.id, { reason, revisitDate });
    if (!finding) return res.status(404).json({ ok: false, error: 'Condition Finding not found' });
    res.json({ ok: true, finding });
  } catch (e) { next(e); }
});
router.post('/condition-findings/:id/dismiss', async (req, res, next) => {
  try {
    const { note } = req.body || {};
    const finding = await dismissFinding(req.params.id, { note });
    if (!finding) return res.status(404).json({ ok: false, error: 'Condition Finding not found' });
    res.json({ ok: true, finding });
  } catch (e) { next(e); }
});
router.get('/findings-summary', async (req, res, next) => {
  try { res.json(await getFindingsSummary()); } catch (e) { next(e); }
});

// ---- Create WO from findings (Build Brief v2 Phase 7, §7.2) ----

router.get('/assets/:id/open-findings-for-wo', async (req, res, next) => {
  try { res.json({ findings: await getOpenFindingsForWoCreation(req.params.id) }); } catch (e) { next(e); }
});
router.post('/assets/:id/create-wo-from-findings', async (req, res, next) => {
  try {
    const { findings } = req.body || {}; // [{ findingId, title, responsibilityClass, fundingSource, estimatedCost }]
    if (!Array.isArray(findings) || !findings.length) return res.status(400).json({ ok: false, error: 'Select at least one finding' });
    res.json({ ok: true, ...(await createWorkOrderFromFindings(req.params.id, findings)) });
  } catch (e) { next(e); }
});

router.get('/admin/job-line-templates', async (req, res, next) => {
  try { res.json({ templates: await listJobLineTemplates({ includeInactive: currentRole() === 'admin' }) }); } catch (e) { next(e); }
});
router.post('/admin/job-line-templates', async (req, res, next) => {
  try {
    const { buildingTypeId, componentType, defaultTitle, defaultResponsibilityClass, defaultFundingSource, sortOrder } = req.body || {};
    if (!defaultTitle?.trim()) return res.status(400).json({ ok: false, error: 'Default title is required' });
    res.json({ ok: true, template: await createJobLineTemplate({ buildingTypeId, componentType, defaultTitle: defaultTitle.trim(), defaultResponsibilityClass, defaultFundingSource, sortOrder }) });
  } catch (e) { next(e); }
});
router.patch('/admin/job-line-templates/:id', async (req, res, next) => {
  try {
    const updated = await updateJobLineTemplate(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ ok: false, error: 'Template not found' });
    res.json({ ok: true, template: updated });
  } catch (e) { next(e); }
});
router.delete('/admin/job-line-templates/:id', async (req, res, next) => {
  try { await deleteJobLineTemplate(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
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
    const { properties = {}, componentEvents = [], finding = null, generalAttachmentIds = [] } = req.body || {};
    const result = await submitAudit(req.params.id, { properties, componentEvents, finding, generalAttachmentIds });
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
  if (entity === 'jobLines') {
    const raw = await getJobLinesReportRawData();
    return { rows: buildJobLineReportRows(raw), specs: JOB_LINE_COLUMN_SPECS };
  }
  if (entity === 'findings') {
    const raw = await getFindingsReportRawData();
    return { rows: buildFindingReportRows(raw), specs: FINDING_COLUMN_SPECS };
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

// ---- Board / monthly report — HTML + browser print, same email pattern as
//      the legacy Activity/Capital reports in routes/reports.js. ----

router.get('/reports/board/preview', async (req, res, next) => {
  try {
    const { periodStart, periodEnd } = req.query;
    const data = await buildBoardReportPg({ periodStart, periodEnd });
    res.json({ title: 'Board Report', html: renderBoardReportHtml(data), text: renderBoardReportText(data) });
  } catch (e) { next(e); }
});

router.post('/reports/board/send', async (req, res, next) => {
  try {
    const { periodStart, periodEnd, recipient, subject } = req.body || {};
    if (!recipient) return res.status(400).json({ ok: false, error: 'recipient is required' });
    const data = await buildBoardReportPg({ periodStart, periodEnd });
    await sendMail({
      to: recipient,
      subject: subject || `Camp Sychar — Board Report (${data.periodStart} to ${data.periodEnd})`,
      html: renderBoardReportHtml(data),
      text: renderBoardReportText(data),
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/reports/forward-focus/preview', async (req, res, next) => {
  try {
    const data = await buildForwardFocusReportPg();
    res.json({ title: 'Forward Focus', html: renderForwardFocusHtml(data), text: renderForwardFocusText(data) });
  } catch (e) { next(e); }
});

router.post('/reports/forward-focus/send', async (req, res, next) => {
  try {
    const { recipient, subject } = req.body || {};
    if (!recipient) return res.status(400).json({ ok: false, error: 'recipient is required' });
    const data = await buildForwardFocusReportPg();
    await sendMail({
      to: recipient,
      subject: subject || 'Camp Sychar — Forward Focus',
      html: renderForwardFocusHtml(data),
      text: renderForwardFocusText(data),
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Work Performed / Deferred Backlog — named reports (Build Brief v2 Phase 6) ----

router.get('/reports/work-performed/preview', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to are required' });
    const data = await buildWorkPerformedReportPg({ from, to });
    res.json({ title: 'Work Performed', html: renderWorkPerformedHtml(data), text: renderWorkPerformedText(data) });
  } catch (e) { next(e); }
});
router.post('/reports/work-performed/send', async (req, res, next) => {
  try {
    const { from, to, recipient, subject } = req.body || {};
    if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to are required' });
    if (!recipient) return res.status(400).json({ ok: false, error: 'recipient is required' });
    const data = await buildWorkPerformedReportPg({ from, to });
    await sendMail({ to: recipient, subject: subject || `Camp Sychar — Work Performed (${from} to ${to})`, html: renderWorkPerformedHtml(data), text: renderWorkPerformedText(data) });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/reports/deferred-backlog/preview', async (req, res, next) => {
  try {
    const data = await buildDeferredBacklogReportPg();
    res.json({ title: 'Deferred Maintenance Backlog', html: renderDeferredBacklogHtml(data), text: renderDeferredBacklogText(data) });
  } catch (e) { next(e); }
});
router.post('/reports/deferred-backlog/send', async (req, res, next) => {
  try {
    const { recipient, subject } = req.body || {};
    if (!recipient) return res.status(400).json({ ok: false, error: 'recipient is required' });
    const data = await buildDeferredBacklogReportPg();
    await sendMail({ to: recipient, subject: subject || 'Camp Sychar — Deferred Maintenance Backlog', html: renderDeferredBacklogHtml(data), text: renderDeferredBacklogText(data) });
    res.json({ ok: true });
  } catch (e) { next(e); }
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

// Maintenance Request Portal's field builder — same "no schema change" shape
// as Property Fields, but a separate catalog (maintenance_request_fields)
// since these fields drive the PUBLIC form, not the audit.
const REQUEST_FIELD_TYPES = ['text', 'textarea', 'select', 'multiselect', 'number', 'date', 'checkbox'];

router.get('/admin/request-fields', async (req, res, next) => {
  try { res.json({ fields: await adminListRequestFields() }); } catch (e) { next(e); }
});

router.post('/admin/request-fields', async (req, res, next) => {
  try {
    const { fieldKey, label, inputType, options, required, helpText } = req.body || {};
    if (!fieldKey || !label || !REQUEST_FIELD_TYPES.includes(inputType)) {
      return res.status(400).json({ ok: false, error: 'fieldKey, label, and a valid inputType are required' });
    }
    if (!/^[a-z][a-z0-9_]*$/.test(fieldKey)) {
      return res.status(400).json({ ok: false, error: 'fieldKey must be lowercase snake_case (e.g. gate_code)' });
    }
    const field = await adminCreateRequestField({ fieldKey, label, inputType, options: options || [], required: !!required, helpText });
    res.json({ ok: true, field });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, error: `A field with key "${req.body?.fieldKey}" already exists` });
    next(e);
  }
});

router.patch('/admin/request-fields/:id', async (req, res, next) => {
  try {
    const { label, options, required, active, sortOrder, helpText } = req.body || {};
    const field = await adminUpdateRequestField(req.params.id, { label, options, required, active, sortOrder, helpText });
    if (!field) return res.status(404).json({ ok: false, error: 'Field not found' });
    res.json({ ok: true, field });
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
    const [jobLines, checklist, logEntries, crewSessions, photos] = await Promise.all([
      listJobLines(req.params.id), getChecklistInstanceForWorkOrder(req.params.id), listWorkOrderLogEntries(req.params.id),
      listCrewSessionsForWorkOrder(req.params.id), listAttachmentsForEntity('work_order', req.params.id),
    ]);
    const jobLineAttachments = await listAttachmentsForEntities('job_line', jobLines.map((jl) => jl.Id));
    for (const jl of jobLines) jl.Photos = jobLineAttachments.get(jl.Id) || [];
    res.json({ ...detail, jobLines, checklist, logEntries, crewSessions, photos });
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
// Order (workOrderId) or standalone (activity label instead). jobLineId is
// optional (1.5) — most sessions cover general WO work, not one line. ----

router.post('/crew-sessions', async (req, res, next) => {
  try {
    const { workOrderId, jobLineId, activity, sessionDate, hours, note, volunteerIds, vendorIds } = req.body || {};
    if (!workOrderId && !(activity || '').trim()) {
      return res.status(400).json({ ok: false, error: 'A session needs either a Work Order or an activity label' });
    }
    const session = await createCrewSession({
      workOrderId: workOrderId || null, jobLineId: jobLineId || null, activity: activity?.trim() || null,
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

// ---- Job Lines (the unit of work — Build Brief v2 Phase 1) ----

router.post('/work-orders/:id/job-lines', async (req, res, next) => {
  try {
    const { title, responsibilityClass, fundingSource, fundingRefId, estimatedHours, estimatedCost, scheduledDate } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ ok: false, error: 'title is required' });
    res.json({
      ok: true,
      jobLine: await createJobLine(req.params.id, {
        title: title.trim(), responsibilityClass, fundingSource,
        fundingRefId: fundingRefId === '' || fundingRefId == null ? null : Number(fundingRefId),
        estimatedHours: estimatedHours === '' || estimatedHours == null ? null : Number(estimatedHours),
        estimatedCost: estimatedCost === '' || estimatedCost == null ? null : Number(estimatedCost),
        scheduledDate: scheduledDate || null,
      }),
    });
  } catch (e) { next(e); }
});
router.patch('/job-lines/:jobLineId', async (req, res, next) => {
  try {
    const body = req.body || {};
    const fields = {};
    if (body.title != null) fields.title = body.title;
    if (body.statusId != null) fields.status_id = Number(body.statusId);
    if (body.statusNote !== undefined) fields.statusNote = body.statusNote;
    if (body.responsibilityClass != null) fields.responsibility_class = body.responsibilityClass;
    if (body.fundingSource != null) fields.funding_source = body.fundingSource;
    if (body.fundingRefId !== undefined) fields.funding_ref_id = body.fundingRefId === '' ? null : Number(body.fundingRefId);
    if (body.estimatedHours !== undefined) fields.estimated_hours = body.estimatedHours === '' ? null : Number(body.estimatedHours);
    if (body.actualHours !== undefined) fields.actual_hours = body.actualHours === '' ? null : Number(body.actualHours);
    if (body.estimatedCost !== undefined) fields.estimated_cost = body.estimatedCost === '' ? null : Number(body.estimatedCost);
    if (body.actualCost !== undefined) fields.actual_cost = body.actualCost === '' ? null : Number(body.actualCost);
    if (body.scheduledDate !== undefined) fields.scheduled_date = body.scheduledDate;
    if (body.complaint !== undefined) fields.complaint = body.complaint;
    if (body.causeNote !== undefined) fields.cause_note = body.causeNote;
    if (body.correction !== undefined) fields.correction = body.correction;
    if (body.blockedReason !== undefined) fields.blocked_reason = body.blockedReason;
    if (body.blockedSince !== undefined) fields.blocked_since = body.blockedSince;
    if (body.completedDate !== undefined) fields.completed_date = body.completedDate;
    if (body.causeIds !== undefined) fields.causeIds = (body.causeIds || []).map(Number);
    const jobLine = await updateJobLine(req.params.jobLineId, fields);
    if (!jobLine) return res.status(404).json({ ok: false, error: 'Job line not found' });
    res.json({ ok: true, jobLine });
  } catch (e) { next(e); }
});
router.delete('/job-lines/:jobLineId', async (req, res, next) => {
  try { await deleteJobLine(req.params.jobLineId); res.json({ ok: true }); } catch (e) { next(e); }
});

router.post('/job-lines/:jobLineId/volunteers', async (req, res, next) => {
  try { res.json(await assignVolunteerToJobLine(req.params.jobLineId, req.body?.volunteerId)); } catch (e) { next(e); }
});
router.delete('/job-lines/:jobLineId/volunteers/:volunteerId', async (req, res, next) => {
  try { res.json(await unassignVolunteerFromJobLine(req.params.jobLineId, req.params.volunteerId)); } catch (e) { next(e); }
});
router.post('/job-lines/:jobLineId/vendors', async (req, res, next) => {
  try { res.json(await assignVendorToJobLine(req.params.jobLineId, req.body?.vendorId)); } catch (e) { next(e); }
});
router.delete('/job-lines/:jobLineId/vendors/:vendorId', async (req, res, next) => {
  try { res.json(await unassignVendorFromJobLine(req.params.jobLineId, req.params.vendorId)); } catch (e) { next(e); }
});

// ---- Causes catalog (admin-editable — 1.6) ----
router.get('/causes', async (req, res, next) => {
  try { res.json({ causes: await listCauses({ includeInactive: currentRole() === 'admin' }) }); } catch (e) { next(e); }
});
router.post('/admin/causes', async (req, res, next) => {
  try {
    const { name, sortOrder } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'Name is required' });
    res.json({ ok: true, cause: await createCause({ name: name.trim(), sortOrder }) });
  } catch (e) { next(e); }
});
router.patch('/admin/causes/:id', async (req, res, next) => {
  try {
    const { name, sortOrder, active } = req.body || {};
    const cause = await updateCause(req.params.id, { name, sortOrder, active });
    if (!cause) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, cause });
  } catch (e) { next(e); }
});
router.delete('/admin/causes/:id', async (req, res, next) => {
  try { await deleteCause(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---- Work order / job line status catalogs (2.1/2.2) — admin-editable,
// read by the frontend instead of a hardcoded list (WO_STATUS_OPTIONS is
// gone from both reports.js and app.js as of this route existing). ----
router.get('/work-order-statuses', async (req, res, next) => {
  try { res.json({ statuses: await listWorkOrderStatuses() }); } catch (e) { next(e); }
});
router.get('/job-line-statuses', async (req, res, next) => {
  try { res.json({ statuses: await listJobLineStatuses() }); } catch (e) { next(e); }
});
router.get('/admin/work-order-statuses', async (req, res, next) => {
  try { res.json({ statuses: await adminListWorkOrderStatuses() }); } catch (e) { next(e); }
});
router.post('/admin/work-order-statuses', async (req, res, next) => {
  try {
    const { name, sortOrder, color, isTerminal } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'Name is required' });
    res.json({ ok: true, status: await adminCreateWorkOrderStatus({ name: name.trim(), sortOrder, color, isTerminal }) });
  } catch (e) { next(e); }
});
router.patch('/admin/work-order-statuses/:id', async (req, res, next) => {
  try {
    const { name, sortOrder, color, isTerminal, active } = req.body || {};
    const status = await adminUpdateWorkOrderStatus(req.params.id, { name, sortOrder, color, isTerminal, active });
    if (!status) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, status });
  } catch (e) { next(e); }
});
router.delete('/admin/work-order-statuses/:id', async (req, res, next) => {
  try { await adminDeleteWorkOrderStatus(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});
router.get('/admin/job-line-statuses', async (req, res, next) => {
  try { res.json({ statuses: await adminListJobLineStatuses() }); } catch (e) { next(e); }
});
router.post('/admin/job-line-statuses', async (req, res, next) => {
  try {
    const { name, sortOrder, color, isTerminal, countsAsWorkPerformed, requiresNote, noteLabel } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'Name is required' });
    res.json({ ok: true, status: await adminCreateJobLineStatus({ name: name.trim(), sortOrder, color, isTerminal, countsAsWorkPerformed, requiresNote, noteLabel }) });
  } catch (e) { next(e); }
});
router.patch('/admin/job-line-statuses/:id', async (req, res, next) => {
  try {
    const { name, sortOrder, color, isTerminal, countsAsWorkPerformed, requiresNote, noteLabel, active } = req.body || {};
    const status = await adminUpdateJobLineStatus(req.params.id, { name, sortOrder, color, isTerminal, countsAsWorkPerformed, requiresNote, noteLabel, active });
    if (!status) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, status });
  } catch (e) { next(e); }
});
router.delete('/admin/job-line-statuses/:id', async (req, res, next) => {
  try { await adminDeleteJobLineStatus(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---- Display settings (2.6) ----
router.get('/display-settings', async (req, res, next) => {
  try { res.json(await getDisplaySettings()); } catch (e) { next(e); }
});
router.put('/display-settings', async (req, res, next) => {
  try {
    const { woProgressWeighting, reportImageCap } = req.body || {};
    if (woProgressWeighting !== undefined && !['cost', 'count'].includes(woProgressWeighting)) return res.status(400).json({ ok: false, error: 'woProgressWeighting must be "cost" or "count"' });
    if (reportImageCap !== undefined && (!Number.isInteger(reportImageCap) || reportImageCap < 1)) return res.status(400).json({ ok: false, error: 'reportImageCap must be a positive integer' });
    res.json({ ok: true, settings: await updateDisplaySettings({ woProgressWeighting, reportImageCap }) });
  } catch (e) { next(e); }
});

router.post('/work-orders', async (req, res, next) => {
  try {
    const { title, assetId, locationId, priority, description, scheduledDate, assetUpdates, jobLines } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, error: 'title is required' });
    const result = await createWorkOrder({ title, assetId, locationId, priority, description, scheduledDate, assetUpdates, jobLines });
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
    if (body.statusId != null) fields.status_id = Number(body.statusId);
    if (body.deferredReason !== undefined) fields.deferred_reason = body.deferredReason;
    if (body.revisitDate !== undefined) fields.revisit_date = body.revisitDate;
    if (body.assetId !== undefined) fields.asset_id = body.assetId === '' ? null : Number(body.assetId);
    if (body.dateReported !== undefined) fields.date_reported = body.dateReported;
    if (body.dateCompleted !== undefined) fields.date_completed = body.dateCompleted;
    if (body.boardFocus !== undefined) fields.board_focus = !!body.boardFocus;
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
    if (result.alreadyApplied) return res.status(400).json({ ok: false, error: 'This field update was already applied to the asset' });
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
    const { name, defaultTitle, defaultPriority, defaultDescription, jobLineDefaults, assetUpdateDefaults, defaultResponsibilityClass, presetVolunteerIds, presetVendorIds } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    res.json({ ok: true, template: await createWorkOrderTemplate({ name, defaultTitle, defaultPriority, defaultDescription, jobLineDefaults, assetUpdateDefaults, defaultResponsibilityClass, presetVolunteerIds, presetVendorIds }) });
  } catch (e) { next(e); }
});
router.patch('/work-order-templates/:id', async (req, res, next) => {
  try {
    const { name, defaultTitle, defaultPriority, defaultDescription, jobLineDefaults, assetUpdateDefaults, defaultResponsibilityClass, presetVolunteerIds, presetVendorIds } = req.body || {};
    const template = await updateWorkOrderTemplate(req.params.id, { name, defaultTitle, defaultPriority, defaultDescription, jobLineDefaults, assetUpdateDefaults, defaultResponsibilityClass, presetVolunteerIds, presetVendorIds });
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
    await generateDueWorkOrdersForRange(from, to);
    res.json({ occurrences: await listCalendarEventOccurrences(from, to) });
  } catch (e) { next(e); }
});
// Job lines with a scheduled_date in range — what the calendar renders for
// "work happening on this day" (1.4: a WO's lines can have divergent dates).
router.get('/job-lines/scheduled', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to (YYYY-MM-DD) are required' });
    res.json({ jobLines: await listJobLinesScheduledInRange(from, to) });
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
    const { title, description, eventDate, recurrenceType, recurrenceInterval, recurrenceEndDate, workOrderId, jobLineId, workOrderTemplateId } = req.body || {};
    if (!title || !eventDate) return res.status(400).json({ ok: false, error: 'title and eventDate are required' });
    res.json({ ok: true, event: await createCalendarEvent({ title, description, eventDate, recurrenceType, recurrenceInterval, recurrenceEndDate, workOrderId, jobLineId, workOrderTemplateId }) });
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
    if (body.jobLineId !== undefined) fields.job_line_id = body.jobLineId === '' ? null : Number(body.jobLineId);
    if (body.workOrderTemplateId !== undefined) fields.work_order_template_id = body.workOrderTemplateId === '' ? null : Number(body.workOrderTemplateId);
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
    const [jobLines, checklist] = await Promise.all([
      listJobLines(req.params.id), getChecklistInstanceForWorkOrder(req.params.id),
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
      scheduledDate: detail.rollup?.EarliestScheduledDate,
      description: w.Description,
      tasks: jobLines.filter((l) => !l.Done).map((l) => l.Title),
      volunteers: (detail.crewRoster?.volunteers || []).map((v) => v.Name),
      vendors: (detail.crewRoster?.vendors || []).map((v) => v.Name),
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

// ---- Maintenance Request Portal (review side — the public submit endpoints
//      live in routes/request-portal.js, unauthenticated) ----
//
// A request is NEVER auto-converted to a Work Order. Status moves only on a
// reviewer's deliberate action here, and "approved" is just a status — the
// separate /convert endpoint is what actually creates the Work Order.

function requestStatusEmail(request, status, reviewNote) {
  const greeting = `Hi${request.RequesterName ? ' ' + request.RequesterName : ''},`;
  const note = reviewNote ? `\n\nNote from our team:\n${reviewNote}` : '';
  const sign = '\n\n— Camp Sychar Maintenance';
  let content;
  switch (status) {
    case 'approved':
      content = { subject: `Your maintenance request has been approved (Ref #${request.Id})`, text: `${greeting}\n\nGood news — your maintenance request has been approved and is in our queue.${note}${sign}` };
      break;
    case 'denied':
      content = { subject: `Update on your maintenance request (Ref #${request.Id})`, text: `${greeting}\n\nWe've reviewed your maintenance request and won't be moving forward with it at this time.${note}${sign}` };
      break;
    case 'converted':
      content = { subject: `Your maintenance request is being worked on (Ref #${request.Id})`, text: `${greeting}\n\nYour maintenance request has been approved and a work order has been created for it.${note}${sign}` };
      break;
    case 'closed':
      content = { subject: `Your maintenance request has been closed (Ref #${request.Id})`, text: `${greeting}\n\nYour maintenance request (Ref #${request.Id}) has been closed.${note}${sign}` };
      break;
    default:
      return null;
  }
  return { ...content, html: renderPlainEmailHtml(content.subject, content.text) };
}

async function notifyRequester(request, status, reviewNote) {
  const content = requestStatusEmail(request, status, reviewNote);
  if (!content || !request.RequesterEmail) return;
  if (!mailIsConfigured()) {
    await createRequestMessage(request.Id, { subject: content.subject, body: content.text, toEmail: request.RequesterEmail, sentBy: 'system', status: 'failed', error: 'Email not configured' });
    return;
  }
  try {
    await sendMail({ to: request.RequesterEmail, subject: content.subject, text: content.text, html: content.html });
    await createRequestMessage(request.Id, { subject: content.subject, body: content.text, toEmail: request.RequesterEmail, sentBy: 'system' });
  } catch (e) {
    await createRequestMessage(request.Id, { subject: content.subject, body: content.text, toEmail: request.RequesterEmail, sentBy: 'system', status: 'failed', error: e.message });
  }
}

router.get('/requests', async (req, res, next) => {
  try { res.json({ requests: await listMaintenanceRequests({ status: req.query.status }) }); } catch (e) { next(e); }
});

router.get('/requests/:id', async (req, res, next) => {
  try {
    const request = await getMaintenanceRequestDetail(req.params.id);
    if (!request) return res.status(404).json({ ok: false, error: 'Request not found' });
    res.json({ request });
  } catch (e) { next(e); }
});

router.patch('/requests/:id/status', async (req, res, next) => {
  try {
    const { status, reviewNote, notify = true } = req.body || {};
    if (status && !['submitted', 'approved', 'denied', 'converted', 'closed'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'Invalid status' });
    }
    const request = await updateMaintenanceRequestStatus(req.params.id, { status, reviewNote });
    if (!request) return res.status(404).json({ ok: false, error: 'Request not found' });
    if (status && notify) await notifyRequester(request, status, reviewNote);
    res.json({ ok: true, request });
  } catch (e) { next(e); }
});

router.patch('/requests/:id/asset', async (req, res, next) => {
  try {
    const request = await linkRequestToAsset(req.params.id, req.body?.assetId || null);
    if (!request) return res.status(404).json({ ok: false, error: 'Request not found' });
    res.json({ ok: true, request });
  } catch (e) { next(e); }
});

// The one deliberate bridge from Requests into Work Orders. Never automatic.
router.post('/requests/:id/convert', async (req, res, next) => {
  try {
    const result = await convertRequestToWorkOrder(req.params.id, { scheduledDate: req.body?.scheduledDate });
    if (!result) return res.status(404).json({ ok: false, error: 'Request not found' });
    await notifyRequester(result.request, 'converted', req.body?.reviewNote);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/requests/:id/messages', async (req, res, next) => {
  try { res.json({ messages: await listRequestMessages(req.params.id) }); } catch (e) { next(e); }
});

// Free-form email from inside the app — "or allow me to email from inside."
router.post('/requests/:id/messages', async (req, res, next) => {
  try {
    const { subject, body } = req.body || {};
    if (!subject?.trim() || !body?.trim()) return res.status(400).json({ ok: false, error: 'subject and body are required' });
    const request = await getMaintenanceRequestDetail(req.params.id);
    if (!request) return res.status(404).json({ ok: false, error: 'Request not found' });
    try {
      await sendMail({ to: request.RequesterEmail, subject, text: body, html: renderPlainEmailHtml(subject, body) });
      const message = await createRequestMessage(request.Id, { subject, body, toEmail: request.RequesterEmail, sentBy: currentUsername() || 'unknown' });
      res.json({ ok: true, message });
    } catch (e) {
      await createRequestMessage(request.Id, { subject, body, toEmail: request.RequesterEmail, sentBy: currentUsername() || 'unknown', status: 'failed', error: e.message });
      res.status(502).json({ ok: false, error: `Email failed to send: ${e.message}` });
    }
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
