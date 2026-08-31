// Postgres client + query functions for the app's own `camp` database.
//
// Portability boundary: this is the ONLY module that knows connection details or
// speaks SQL, same discipline as nocodb.js for the NocoDB API. Functions here
// return objects SHAPED like what nocodb.js returns (Title Case keys, link
// fields as { Id, Name } / arrays) wherever a caller needs to reuse existing
// NocoDB-era logic (components.js's currentComponentState/sortHistory) without
// modification — so "current state" stays defined in exactly one place.
//
// `camp` is a separate database on the SAME Postgres server NocoDB already runs
// (container nocodb-db) — see toClaudeCode/camp-cmms-postgres-migration-brief.md.
// NocoDB's own database is untouched.

import pg from 'pg';
import crypto from 'crypto';
import { currentUsername } from './requestContext.js';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('FATAL: DATABASE_URL env var is not set. The app cannot talk to Postgres.');
}

export const pool = new Pool({ connectionString });

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error:', err.message);
});

export async function pingDb() {
  const res = await pool.query('SELECT now() AS now, current_database() AS db');
  return res.rows[0];
}

// ── Activity log ("what has been done") ─────────────────────────────────
// Called from mutating functions below, right after a create/update/delete
// succeeds. Never allowed to fail the calling operation — a logging hiccup
// shouldn't block the actual mutation.
export async function logActivity({ action, entityType, entityId, entityLabel, details }) {
  try {
    await pool.query(
      `INSERT INTO activity_log (username, action, entity_type, entity_id, entity_label, details)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [currentUsername(), action, entityType, entityId ?? null, entityLabel ?? null, details ?? null]
    );
  } catch (e) {
    console.error('activity log insert failed:', e.message);
  }
}

export async function listActivityLog({ limit = 200, entityType, action, username } = {}) {
  const clauses = []; const vals = []; let i = 1;
  if (entityType) { clauses.push(`entity_type = $${i++}`); vals.push(entityType); }
  if (action) { clauses.push(`action = $${i++}`); vals.push(action); }
  if (username) { clauses.push(`username = $${i++}`); vals.push(username); }
  vals.push(limit);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM activity_log ${where} ORDER BY occurred_at DESC LIMIT $${i}`,
    vals
  );
  return rows.map((r) => ({
    Id: r.id, OccurredAt: r.occurred_at, Username: r.username, Action: r.action,
    EntityType: r.entity_type, EntityId: r.entity_id, EntityLabel: r.entity_label, Details: r.details,
  }));
}

// ── Locations / Assets (read) ───────────────────────────────────────────

function locationRowShape(r) {
  return { Id: r.id, Name: r.name, 'Location Type': r.location_type, ParentLocationId: r.parent_location_id, Notes: r.notes };
}

export async function listLocations() {
  const { rows } = await pool.query('SELECT id, name, location_type, parent_location_id, notes FROM locations ORDER BY name');
  return rows.map(locationRowShape);
}

export async function createLocation({ name, parentLocationId, locationType, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO locations (name, parent_location_id, location_type, notes) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name, parentLocationId || null, locationType || null, notes || null]
  );
  await logActivity({ action: 'created', entityType: 'location', entityId: rows[0].id, entityLabel: rows[0].name });
  return locationRowShape(rows[0]);
}

export async function updateLocation(id, { name, parentLocationId, locationType, notes }) {
  const { rows } = await pool.query(
    `UPDATE locations SET name = $2, parent_location_id = $3, location_type = $4, notes = $5 WHERE id = $1 RETURNING *`,
    [id, name, parentLocationId || null, locationType || null, notes || null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'location', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? locationRowShape(rows[0]) : null;
}

export async function listAssetsByLocation(locationId) {
  const { rows } = await pool.query(
    `SELECT id, name, asset_type, condition FROM assets WHERE location_id = $1 ORDER BY name`,
    [locationId]
  );
  return rows.map((r) => ({ Id: r.id, Name: r.name, 'Asset type': r.asset_type, Condition: r.condition }));
}

export async function searchLocationsAndAssets(q) {
  const like = `%${q}%`;
  const [locs, assets] = await Promise.all([
    pool.query(`SELECT id, name, location_type FROM locations WHERE name ILIKE $1 ORDER BY name LIMIT 20`, [like]),
    pool.query(
      `SELECT a.id, a.name, a.asset_type, a.location_id, l.name AS location_name
       FROM assets a LEFT JOIN locations l ON l.id = a.location_id
       WHERE a.name ILIKE $1 ORDER BY a.name LIMIT 20`,
      [like]
    ),
  ]);
  return {
    locations: locs.rows.map((r) => ({ Id: r.id, Name: r.name, 'Location Type': r.location_type })),
    assets: assets.rows.map((r) => ({
      Id: r.id, Name: r.name, assetType: r.asset_type, locationId: r.location_id, locationName: r.location_name,
    })),
  };
}

// ── Asset-property field catalog (replaces NocoDB meta + @asset-property tag) ─

// buildingTypeId is optional — when given, excludes fields with an explicit
// question_applicability row of applies=false for that type. No row = applies
// (safe default; matches pre-building-type behavior when nothing's configured).
export async function getAssetPropertyFields(buildingTypeId) {
  const { rows } = await pool.query(
    `SELECT apf.field_key, apf.label, apf.input_type, apf.options, apf.column_name
     FROM asset_property_fields apf
     WHERE apf.active
       AND NOT EXISTS (
         SELECT 1 FROM question_applicability qa
         WHERE qa.question_key = apf.field_key AND qa.applies = false
           AND qa.building_type_id = $1
       )
     ORDER BY apf.sort_order`,
    [buildingTypeId || null]
  );
  return rows.map((r) => ({
    fieldKey: r.field_key,
    title: r.label,
    uidt: r.input_type === 'multiselect' ? 'MultiSelect' : r.input_type === 'select' ? 'SingleSelect' : r.input_type === 'number' ? 'Number' : 'Text',
    multi: r.input_type === 'multiselect',
    options: r.options.length ? r.options : null,
    columnName: r.column_name, // set = real assets column; null = EAV-backed (asset_property_values)
  }));
}

export async function listBuildingTypes() {
  const { rows } = await pool.query('SELECT id, name FROM building_types ORDER BY name');
  return rows.map((r) => ({ Id: r.id, Name: r.name }));
}

export async function setAssetBuildingType(assetId, buildingTypeId) {
  const { rows } = await pool.query(
    'UPDATE assets SET building_type_id = $1 WHERE id = $2 RETURNING id, building_type_id',
    [buildingTypeId, assetId]
  );
  return rows[0] || null;
}

export async function getAssetPropertyDependencies() {
  const { rows } = await pool.query(
    `SELECT apf.label AS field, d.show_when, ARRAY_AGG(r.label ORDER BY r.sort_order) AS reveal_labels
     FROM asset_property_dependencies d
     JOIN asset_property_fields apf ON apf.field_key = d.field_key
     JOIN LATERAL unnest(d.reveals) AS rev_key ON true
     JOIN asset_property_fields r ON r.field_key = rev_key
     GROUP BY apf.label, d.show_when`
  );
  return rows.map((r) => ({ field: r.field, showWhen: r.show_when, reveals: r.reveal_labels }));
}

// buildingTypeId is optional — same applies=false exclusion rule as
// getAssetPropertyFields, keyed on component_type instead of field_key.
export async function getComponentTypeCatalog(buildingTypeId) {
  const { rows } = await pool.query(
    `SELECT ctc.component_type, ctc.event_type_options, ctc.condition_options, ctc.prompted_in_audit
     FROM component_type_catalog ctc
     WHERE NOT EXISTS (
       SELECT 1 FROM question_applicability qa
       WHERE qa.question_key = ctc.component_type AND qa.applies = false
         AND qa.building_type_id = $1
     )
     ORDER BY ctc.sort_order`,
    [buildingTypeId || null]
  );
  const componentTypeOptions = rows.map((r) => r.component_type);
  const conditionOptions = rows[0]?.condition_options || [];
  const eventTypeOptions = rows[0]?.event_type_options || [];
  const promptTypes = rows.filter((r) => r.prompted_in_audit).map((r) => r.component_type);
  const { rows: depRows } = await pool.query(
    `SELECT apf.label AS field, d.show_when FROM component_prompt_dependencies d
     JOIN asset_property_fields apf ON apf.field_key = d.field_key LIMIT 1`
  );
  return {
    componentTypeOptions,
    eventTypeOptions,
    conditionOptions,
    promptTypes,
    promptWhen: depRows[0] ? { field: depRows[0].field, showWhen: depRows[0].show_when } : null,
  };
}

// ── Asset detail (asset + its property values + component rows, NocoDB-shaped) ─

function assetRowToNocoShape(a) {
  return {
    Id: a.id,
    Name: a.name,
    'Asset type': a.asset_type,
    Condition: a.condition,
    'Install/Build Year': a.install_build_year,
    Notes: a.notes,
    Description: a.description,
    'Lodge Holder': a.lodge_holder,
    'Has Key': a.has_key,
    'Key Fits Lock': a.key_fits_lock,
    'Free Standing Building': a.free_standing_building,
    buildingTypeId: a.building_type_id,
    locationId: a.location_id,
    subLocationId: a.sub_location_id,
    parentAssetId: a.parent_asset_id,
  };
}

function componentRowToNocoShape(c) {
  return {
    Id: c.id,
    Title: `${c.component_type} — ${c.observed_installed_date || ''}`.trim(),
    'Component Type': c.component_type,
    'Event Type': c.event_type,
    Material: c.material,
    Condition: c.condition,
    'Observed/Installed Date': c.observed_installed_date,
    'Est Life (years)': c.est_life_years,
    'Est Replacement Year': c.est_replacement_year,
    'Est Replacement Cost': c.est_replacement_cost,
    Notes: c.notes,
    'Photo URL': c.photo_url,
    Asset: { Id: c.asset_id, Name: c.asset_name },
    'Work Order': c.work_order_id ? { Id: c.work_order_id } : null,
  };
}

async function getAssetRow(assetId) {
  const { rows } = await pool.query('SELECT * FROM assets WHERE id = $1', [assetId]);
  return rows[0] || null;
}

async function getComponentRowsForAsset(assetId) {
  const { rows } = await pool.query(
    `SELECT * FROM asset_components WHERE asset_id = $1 ORDER BY observed_installed_date DESC NULLS LAST, id DESC`,
    [assetId]
  );
  return rows.map(componentRowToNocoShape);
}

async function getAssetPropertyValuesEav(assetId) {
  const { rows } = await pool.query('SELECT field_key, value FROM asset_property_values WHERE asset_id = $1', [assetId]);
  return new Map(rows.map((r) => [r.field_key, r.value]));
}

export async function getAssetDetail(assetId) {
  const assetRow = await getAssetRow(assetId);
  if (!assetRow) return null;
  const buildingTypeId = assetRow.building_type_id;
  const [propertyFields, componentRows, componentSchema, workOrders, findings, eavValues] = await Promise.all([
    getAssetPropertyFields(buildingTypeId),
    getComponentRowsForAsset(assetId),
    getComponentTypeCatalog(buildingTypeId),
    pool.query(`SELECT id, title, status, priority FROM work_orders WHERE asset_id = $1 ORDER BY id DESC LIMIT 200`, [assetId]),
    pool.query(`SELECT id, title, severity, status FROM condition_findings WHERE asset_id = $1 ORDER BY id DESC LIMIT 200`, [assetId]),
    getAssetPropertyValuesEav(assetId),
  ]);
  const asset = assetRowToNocoShape(assetRow);
  const fields = propertyFields.map((f) => ({
    ...f,
    currentValue: (f.columnName ? assetRow[f.columnName] : eavValues.get(f.fieldKey)) ?? null,
  }));
  const dependencies = await getAssetPropertyDependencies();
  const revealed = new Set(dependencies.flatMap((d) => d.reveals));
  return {
    asset,
    properties: { fields, topLevel: fields.filter((f) => !revealed.has(f.title)).map((f) => f.title), dependencies },
    componentRows, // callers pass this straight into components.js's currentComponentState/sortHistory
    componentSchema,
    workOrders: workOrders.rows.map((r) => ({ Id: r.id, Title: r.title, Status: r.status, Priority: r.priority })),
    conditionFindings: findings.rows.map((r) => ({ Id: r.id, Title: r.title, Severity: r.severity, Status: r.status })),
  };
}

// Flat/EAV property-field changes logged by submitAudit — components already
// get history for free via asset_components' append-only rows, this covers
// the rest (Has Key, Window Style, etc.).
export async function getAssetPropertyHistory(assetId) {
  const { rows } = await pool.query(
    `SELECT h.field_key, apf.label, h.old_value, h.new_value, h.changed_by, h.changed_at
     FROM asset_property_history h
     LEFT JOIN asset_property_fields apf ON apf.field_key = h.field_key
     WHERE h.asset_id = $1
     ORDER BY h.changed_at DESC, h.id DESC`,
    [assetId]
  );
  return rows.map((r) => ({
    FieldKey: r.field_key, Label: r.label || r.field_key, 'Old Value': r.old_value, 'New Value': r.new_value,
    ChangedBy: r.changed_by, ChangedAt: r.changed_at,
  }));
}

export async function getAssetHistory(assetId) {
  const [assetRow, componentRows, propertyHistory] = await Promise.all([
    getAssetRow(assetId), getComponentRowsForAsset(assetId), getAssetPropertyHistory(assetId),
  ]);
  return { asset: assetRow ? assetRowToNocoShape(assetRow) : null, componentRows, propertyHistory };
}

// ── Audit submit (write): one transaction — UPDATE property columns, INSERT
//    component events, log property-field history, create inline flags as
//    condition_findings, optionally INSERT a linked finding + general photos ─

// Default severity for a quick inline "flag for follow-up" — the lightest
// tier, since these are call-outs to revisit, not the heavier bolt-on
// Finding (which has its own explicit severity picker).
const FLAG_DEFAULT_SEVERITY = '1 - Monitor';

export async function submitAudit(assetId, { properties = {}, componentEvents = [], finding = null, generalPhotos = [] }) {
  const propertyFields = await getAssetPropertyFields();
  const byKey = new Map(propertyFields.map((f) => [f.fieldKey, f]));
  const [assetRowBefore, eavValuesBefore] = await Promise.all([getAssetRow(assetId), getAssetPropertyValuesEav(assetId)]);
  const username = currentUsername();

  // properties keyed by fieldKey (e.g. "has_key") -> { value, flagged, flagNote }.
  const setCols = [];
  const setVals = [];
  const eavUpdates = []; // fields with no real column — go to asset_property_values instead
  const historyEntries = []; // { fieldKey, oldValue, newValue } — only for fields that actually changed
  const propertyFlags = []; // { fieldKey, label, value, note }
  let i = 1;
  for (const [key, entry] of Object.entries(properties)) {
    const field = byKey.get(key);
    if (!field) continue; // ignore anything that isn't a live property field
    const value = entry?.value;
    if (field.options && !field.multi && !field.options.includes(value)) continue;
    const oldValueRaw = field.columnName ? assetRowBefore?.[field.columnName] : eavValuesBefore.get(key);
    const oldValue = oldValueRaw == null ? null : String(oldValueRaw);
    const newValue = value == null ? null : String(value);
    if (oldValue !== newValue) historyEntries.push({ fieldKey: key, oldValue, newValue });
    if (field.columnName) {
      setCols.push(`${field.columnName} = $${i++}`);
      setVals.push(value);
    } else {
      eavUpdates.push([key, value]);
    }
    if (entry?.flagged) propertyFlags.push({ fieldKey: key, label: field.title, value: newValue, note: entry.flagNote || null });
  }

  const componentCatalog = await getComponentTypeCatalog();
  const today = new Date().toISOString().slice(0, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (setCols.length) {
      setVals.push(assetId);
      await client.query(`UPDATE assets SET ${setCols.join(', ')} WHERE id = $${i}`, setVals);
    }
    for (const [fieldKey, value] of eavUpdates) {
      await client.query(
        `INSERT INTO asset_property_values (asset_id, field_key, value) VALUES ($1,$2,$3)
         ON CONFLICT (asset_id, field_key) DO UPDATE SET value = EXCLUDED.value`,
        [assetId, fieldKey, value]
      );
    }
    for (const h of historyEntries) {
      await client.query(
        `INSERT INTO asset_property_history (asset_id, field_key, old_value, new_value, changed_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [assetId, h.fieldKey, h.oldValue, h.newValue, username]
      );
    }
    for (const f of propertyFlags) {
      await client.query(
        `INSERT INTO condition_findings (asset_id, title, severity, description, status, date_identified,
           source_field_key, flagged_value, created_by)
         VALUES ($1,$2,$3,$4,'Open',$5,$6,$7,$8)`,
        [assetId, `${f.label}: ${f.value ?? '—'}`, FLAG_DEFAULT_SEVERITY, f.note || `Flagged during audit (${f.label} = ${f.value ?? '—'})`,
          today, f.fieldKey, f.value, username]
      );
    }

    const createdComponents = [];
    for (const ev of componentEvents) {
      if (!ev?.componentType || !componentCatalog.promptTypes.includes(ev.componentType)) continue;
      if (!componentCatalog.componentTypeOptions.includes(ev.componentType)) continue;
      const eventType = componentCatalog.eventTypeOptions.includes(ev.eventType) ? ev.eventType : 'Inspected';
      const condition = componentCatalog.conditionOptions.includes(ev.condition) ? ev.condition : null;
      const observedDate = ev.observedDate || today;
      const { rows } = await client.query(
        `INSERT INTO asset_components (asset_id, component_type, sub_area, event_type, material, condition,
           observed_installed_date, est_life_years, est_replacement_cost, notes, photo_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [assetId, ev.componentType, ev.subArea || null, eventType, ev.material || null, condition,
          observedDate, ev.estLifeYears ?? null, ev.estReplacementCost ?? null, ev.notes || null, ev.photoUrl || null]
      );
      createdComponents.push(componentRowToNocoShape(rows[0]));
      if (ev.flagged) {
        const label = `${ev.componentType}${condition ? `: ${condition}` : ''}`;
        await client.query(
          `INSERT INTO condition_findings (asset_id, title, severity, description, status, date_identified,
             source_component_type, flagged_value, created_by)
           VALUES ($1,$2,$3,$4,'Open',$5,$6,$7,$8)`,
          [assetId, label, FLAG_DEFAULT_SEVERITY, ev.flagNote || `Flagged during audit (${label})`,
            today, ev.componentType, condition, username]
        );
      }
    }

    let createdFinding = null;
    if (finding && finding.description && finding.severity) {
      const { rows } = await client.query(
        `INSERT INTO condition_findings (asset_id, title, severity, description, recommended_repair,
           estimated_hours, estimated_cost, status, date_identified, photo_urls, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Open',$8,$9,$10) RETURNING *`,
        [assetId, finding.title || `Finding on Asset #${assetId}`, finding.severity, finding.description,
          finding.recommendedRepair || null, finding.estimatedHours ?? null, finding.estimatedCost ?? null, today,
          finding.photoUrls || [], username]
      );
      createdFinding = rows[0];
    }

    for (const url of generalPhotos) {
      if (!url) continue;
      await client.query(
        `INSERT INTO asset_photos (asset_id, photo_url, created_by) VALUES ($1,$2,$3)`,
        [assetId, url, username]
      );
    }

    await client.query('COMMIT');
    const updatedAssetRow = await getAssetRow(assetId);
    return { asset: assetRowToNocoShape(updatedAssetRow), components: createdComponents, finding: createdFinding };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Reports ──────────────────────────────────────────────────────────────

export async function getMaintenanceLog({ componentType, eventType, from, to } = {}) {
  const conds = [];
  const vals = [];
  let i = 1;
  if (componentType) { conds.push(`ac.component_type = $${i++}`); vals.push(componentType); }
  if (eventType) { conds.push(`ac.event_type = $${i++}`); vals.push(eventType); }
  if (from) { conds.push(`ac.observed_installed_date >= $${i++}`); vals.push(from); }
  if (to) { conds.push(`ac.observed_installed_date <= $${i++}`); vals.push(to); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT ac.*, a.name AS asset_name FROM asset_components ac
     LEFT JOIN assets a ON a.id = ac.asset_id
     ${where}
     ORDER BY ac.observed_installed_date DESC NULLS LAST, ac.id DESC LIMIT 5000`,
    vals
  );
  return rows.map(componentRowToNocoShape);
}

// All asset_components rows + minimal asset/location info, for buildCapitalPlan-
// equivalent logic in the pg-api route (reuses components.js's currentComponentState,
// same rule as everywhere else — see file header).
export async function getAllComponentRowsWithAssetInfo() {
  const [componentRows, assets] = await Promise.all([
    pool.query('SELECT * FROM asset_components ORDER BY asset_id, observed_installed_date DESC NULLS LAST, id DESC'),
    pool.query(
      `SELECT a.id, a.name, l.name AS location_name FROM assets a LEFT JOIN locations l ON l.id = a.location_id`
    ),
  ]);
  return {
    componentRows: componentRows.rows.map(componentRowToNocoShape),
    assetById: new Map(assets.rows.map((a) => [a.id, { Id: a.id, Name: a.name, Location: a.location_name ? { Name: a.location_name } : null }])),
  };
}

// ── Reports v1 (filterable/exportable Assets + Work Orders — see
//    reports.js for the pure row-shaping/filter/CSV logic that consumes this
//    raw data; kept out of db.js on purpose, same boundary as
//    components.js's currentComponentState) ─────────────────────────────

export async function getAssetsReportRawData() {
  const [assetsRows, propertyFields, eavRows, componentRows, findingsRows] = await Promise.all([
    pool.query(
      `SELECT a.*, l.name AS location_name, bt.name AS building_type_name
       FROM assets a
       LEFT JOIN locations l ON l.id = a.location_id
       LEFT JOIN building_types bt ON bt.id = a.building_type_id
       ORDER BY a.name`
    ),
    getAssetPropertyFields(),
    pool.query('SELECT asset_id, field_key, value FROM asset_property_values'),
    pool.query('SELECT * FROM asset_components'),
    pool.query(`SELECT asset_id, source_field_key, source_component_type FROM condition_findings WHERE status = 'Open'`),
  ]);

  const eavByAsset = new Map();
  for (const r of eavRows.rows) {
    if (!eavByAsset.has(r.asset_id)) eavByAsset.set(r.asset_id, new Map());
    eavByAsset.get(r.asset_id).set(r.field_key, r.value);
  }
  const componentRowsByAsset = new Map();
  for (const r of componentRows.rows) {
    if (!componentRowsByAsset.has(r.asset_id)) componentRowsByAsset.set(r.asset_id, []);
    componentRowsByAsset.get(r.asset_id).push(componentRowToNocoShape(r));
  }
  const propByKey = new Map(propertyFields.map((f) => [f.fieldKey, f]));
  const flagsByAsset = new Map();
  for (const r of findingsRows.rows) {
    const label = r.source_field_key ? (propByKey.get(r.source_field_key)?.title || r.source_field_key) : (r.source_component_type || 'General');
    if (!flagsByAsset.has(r.asset_id)) flagsByAsset.set(r.asset_id, new Set());
    flagsByAsset.get(r.asset_id).add(label);
  }

  return { assets: assetsRows.rows, propertyFields, eavByAsset, componentRowsByAsset, flagsByAsset };
}

export async function getWorkOrdersReportRawData() {
  const [woRows, volRows, venRows] = await Promise.all([
    pool.query(
      `SELECT w.id, w.title, w.status, w.priority, w.date_reported, w.date_completed, w.scheduled_date,
              w.estimated_hours, w.estimated_cost, w.actual_hours, w.actual_cost, w.funding_source,
              a.name AS asset_name, l.name AS location_name
       FROM work_orders w
       LEFT JOIN assets a ON a.id = w.asset_id
       LEFT JOIN locations l ON l.id = w.location_id
       ORDER BY w.id DESC`
    ),
    pool.query(
      `SELECT wov.work_order_id, v.name FROM work_order_volunteers wov JOIN volunteers v ON v.id = wov.volunteer_id`
    ),
    pool.query(
      `SELECT wov.work_order_id, vd.name FROM work_order_vendors wov JOIN vendors vd ON vd.id = wov.vendor_id`
    ),
  ]);
  const volByWo = new Map();
  for (const r of volRows.rows) { if (!volByWo.has(r.work_order_id)) volByWo.set(r.work_order_id, []); volByWo.get(r.work_order_id).push(r.name); }
  const venByWo = new Map();
  for (const r of venRows.rows) { if (!venByWo.has(r.work_order_id)) venByWo.set(r.work_order_id, []); venByWo.get(r.work_order_id).push(r.name); }
  return { workOrders: woRows.rows, volByWo, venByWo };
}

// "Progress made" (status changes, notes, hours logged — see migration 0017's
// comment: "what future reporting will read from") — one row per log entry,
// not per Work Order, so a single WO with five updates shows as five rows.
export async function getWorkOrderLogReportRawData() {
  const { rows } = await pool.query(
    `SELECT l.id, l.note, l.hours, l.status_change, l.username, l.created_at,
            w.id AS work_order_id, w.title AS wo_title, a.name AS asset_name, loc.name AS location_name
     FROM work_order_log_entries l
     JOIN work_orders w ON w.id = l.work_order_id
     LEFT JOIN assets a ON a.id = w.asset_id
     LEFT JOIN locations loc ON loc.id = w.location_id
     ORDER BY l.created_at DESC`
  );
  return { logEntries: rows };
}

// Saved Reports-tab filter combinations ("favorites") — scoped to the
// current session's username so each person's list is their own, same
// attribution pattern as activity_log/audit flags.
export async function listReportFavorites(entity) {
  const { rows } = await pool.query(
    `SELECT id, label, filters, visible_columns, sort_key, sort_dir FROM report_favorites
     WHERE username = $1 AND entity = $2 ORDER BY id`,
    [currentUsername(), entity]
  );
  return rows.map((r) => ({ Id: r.id, Label: r.label, Filters: r.filters, VisibleColumns: r.visible_columns, SortKey: r.sort_key, SortDir: r.sort_dir }));
}

export async function createReportFavorite({ entity, label, filters, visibleColumns, sortKey, sortDir }) {
  const { rows } = await pool.query(
    `INSERT INTO report_favorites (username, entity, label, filters, visible_columns, sort_key, sort_dir)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, label, filters, visible_columns, sort_key, sort_dir`,
    [currentUsername(), entity, label, JSON.stringify(filters || {}), visibleColumns ? JSON.stringify(visibleColumns) : null, sortKey || null, sortDir || null]
  );
  const r = rows[0];
  return { Id: r.id, Label: r.label, Filters: r.filters, VisibleColumns: r.visible_columns, SortKey: r.sort_key, SortDir: r.sort_dir };
}

export async function deleteReportFavorite(id) {
  await pool.query('DELETE FROM report_favorites WHERE id = $1 AND username = $2', [id, currentUsername()]);
}

// ── Ad-hoc field notes (pressure-relief valve — see migration brief's "Ad-hoc
//    notes & field creation" section). Just INSERT/UPDATE — no schema risk. ──

export async function listAssetNotes(assetId) {
  const { rows } = await pool.query(
    `SELECT id, note, photo_url, resolved, created_by, created_at FROM asset_notes
     WHERE asset_id = $1 ORDER BY created_at DESC`,
    [assetId]
  );
  return rows;
}

export async function createAssetNote(assetId, { note, photoUrl = null, createdBy = null }) {
  const { rows } = await pool.query(
    `INSERT INTO asset_notes (asset_id, note, photo_url, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [assetId, note, photoUrl, createdBy]
  );
  await logActivity({ action: 'created', entityType: 'asset_note', entityId: rows[0].id, entityLabel: note, details: `On asset #${assetId}` });
  return rows[0];
}

export async function resolveAssetNote(noteId, resolved = true) {
  const { rows } = await pool.query(
    `UPDATE asset_notes SET resolved = $1 WHERE id = $2 RETURNING *`,
    [resolved, noteId]
  );
  if (rows[0]) await logActivity({ action: 'toggled', entityType: 'asset_note', entityId: rows[0].id, entityLabel: rows[0].note, details: resolved ? 'resolved' : 'reopened' });
  return rows[0] || null;
}

// ── Full asset edit (core fields + property fields, one call) — the
//    "Edit Asset" admin screen. Distinct from submitAudit: no component
//    events or findings here, just direct field edits. ─────────────────────

const ASSET_CORE_COLUMNS = [
  'name', 'asset_type', 'location_id', 'sub_location_id', 'parent_asset_id',
  'condition', 'install_build_year', 'notes', 'description', 'lodge_holder', 'building_type_id',
];

export async function updateAssetFull(assetId, { core = {}, properties = {} }) {
  const propertyFields = await getAssetPropertyFields();
  const byKey = new Map(propertyFields.map((f) => [f.fieldKey, f]));

  const setCols = [];
  const setVals = [];
  let i = 1;
  for (const [key, value] of Object.entries(core)) {
    if (!ASSET_CORE_COLUMNS.includes(key)) continue;
    setCols.push(`${key} = $${i++}`);
    setVals.push(value === '' ? null : value);
  }
  const eavUpdates = [];
  for (const [key, value] of Object.entries(properties)) {
    const field = byKey.get(key);
    if (!field) continue;
    if (field.options && !field.multi && value && !field.options.includes(value)) continue;
    if (field.columnName) { setCols.push(`${field.columnName} = $${i++}`); setVals.push(value === '' ? null : value); }
    else eavUpdates.push([key, value === '' ? null : value]);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (setCols.length) {
      setVals.push(assetId);
      await client.query(`UPDATE assets SET ${setCols.join(', ')} WHERE id = $${i}`, setVals);
    }
    for (const [fieldKey, value] of eavUpdates) {
      await client.query(
        `INSERT INTO asset_property_values (asset_id, field_key, value) VALUES ($1,$2,$3)
         ON CONFLICT (asset_id, field_key) DO UPDATE SET value = EXCLUDED.value`,
        [assetId, fieldKey, value]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const detail = await getAssetDetail(assetId);
  await logActivity({ action: 'updated', entityType: 'asset', entityId: Number(assetId), entityLabel: detail?.asset?.Name });
  return detail;
}

// ── Admin: schema/config CRUD — the point of "fully customizable, no deploy
//    needed." Adding a field/component type/building type here never issues
//    DDL; new property fields are always EAV-backed (see migration 0005). ──

export async function adminListPropertyFields() {
  const { rows } = await pool.query(
    `SELECT id, field_key, label, input_type, options, sort_order, active, column_name
     FROM asset_property_fields ORDER BY sort_order`
  );
  return rows;
}

export async function adminCreatePropertyField({ fieldKey, label, inputType, options = [], sortOrder = 100 }) {
  const { rows } = await pool.query(
    `INSERT INTO asset_property_fields (field_key, label, input_type, options, sort_order)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [fieldKey, label, inputType, options, sortOrder]
  );
  await logActivity({ action: 'created', entityType: 'property_field', entityId: rows[0].id, entityLabel: rows[0].label });
  return rows[0];
}

export async function adminUpdatePropertyField(id, { label, options, active, sortOrder }) {
  const { rows } = await pool.query(
    `UPDATE asset_property_fields SET
       label = COALESCE($2, label), options = COALESCE($3, options),
       active = COALESCE($4, active), sort_order = COALESCE($5, sort_order)
     WHERE id = $1 RETURNING *`,
    [id, label ?? null, options ?? null, active ?? null, sortOrder ?? null]
  );
  if (rows[0]) {
    await logActivity({
      action: active === false ? 'deactivated' : active === true ? 'reactivated' : 'updated',
      entityType: 'property_field', entityId: rows[0].id, entityLabel: rows[0].label,
    });
  }
  return rows[0] || null;
}

export async function adminListComponentTypes() {
  const { rows } = await pool.query(
    `SELECT component_type, event_type_options, condition_options, prompted_in_audit, sort_order
     FROM component_type_catalog ORDER BY sort_order`
  );
  return rows;
}

export async function adminCreateComponentType({ componentType, eventTypeOptions, conditionOptions, promptedInAudit = false, sortOrder = 100 }) {
  const { rows } = await pool.query(
    `INSERT INTO component_type_catalog (component_type, event_type_options, condition_options, prompted_in_audit, sort_order)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [componentType, eventTypeOptions, conditionOptions, promptedInAudit, sortOrder]
  );
  await logActivity({ action: 'created', entityType: 'component_type', entityLabel: rows[0].component_type });
  return rows[0];
}

export async function adminUpdateComponentType(componentType, { eventTypeOptions, conditionOptions, promptedInAudit, sortOrder }) {
  const { rows } = await pool.query(
    `UPDATE component_type_catalog SET
       event_type_options = COALESCE($2, event_type_options),
       condition_options = COALESCE($3, condition_options),
       prompted_in_audit = COALESCE($4, prompted_in_audit),
       sort_order = COALESCE($5, sort_order)
     WHERE component_type = $1 RETURNING *`,
    [componentType, eventTypeOptions ?? null, conditionOptions ?? null, promptedInAudit ?? null, sortOrder ?? null]
  );
  if (rows[0] && promptedInAudit !== undefined && promptedInAudit !== null) {
    await logActivity({ action: 'toggled', entityType: 'component_type', entityLabel: componentType, details: promptedInAudit ? 'now prompted in audit' : 'no longer prompted in audit' });
  }
  return rows[0] || null;
}

export async function adminCreateBuildingType(name) {
  const { rows } = await pool.query('INSERT INTO building_types (name) VALUES ($1) RETURNING *', [name]);
  await logActivity({ action: 'created', entityType: 'building_type', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0];
}

export async function adminDeleteBuildingType(id) {
  const inUse = await pool.query('SELECT count(*) FROM assets WHERE building_type_id = $1', [id]);
  if (Number(inUse.rows[0].count) > 0) {
    const err = new Error(`${inUse.rows[0].count} asset(s) still use this building type — reassign them first`);
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query('DELETE FROM building_types WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'building_type', entityId: Number(id), entityLabel: rows[0].name });
}

// Full applicability matrix: every (building type × question key) pair the
// admin can toggle. question keys = active property fields + component types.
export async function adminGetApplicabilityMatrix() {
  const [buildingTypes, propertyFields, componentTypes, rules] = await Promise.all([
    pool.query('SELECT id, name FROM building_types ORDER BY name'),
    pool.query('SELECT field_key, label FROM asset_property_fields WHERE active ORDER BY sort_order'),
    pool.query('SELECT component_type FROM component_type_catalog ORDER BY sort_order'),
    pool.query('SELECT building_type_id, question_key, applies FROM question_applicability'),
  ]);
  const questionKeys = [
    ...propertyFields.rows.map((f) => ({ key: f.field_key, label: f.label })),
    ...componentTypes.rows.map((c) => ({ key: c.component_type, label: c.component_type })),
  ];
  const ruleMap = new Map(rules.rows.map((r) => [`${r.building_type_id}:${r.question_key}`, r.applies]));
  return {
    buildingTypes: buildingTypes.rows.map((b) => ({ id: b.id, name: b.name })),
    questionKeys,
    // applies defaults true when no explicit row exists — matches runtime filtering rule.
    matrix: buildingTypes.rows.map((b) => ({
      buildingTypeId: b.id,
      buildingTypeName: b.name,
      cells: questionKeys.map((q) => ({ questionKey: q.key, applies: ruleMap.get(`${b.id}:${q.key}`) ?? true })),
    })),
  };
}

export async function adminSetApplicability(buildingTypeId, questionKey, applies) {
  await pool.query(
    `INSERT INTO question_applicability (building_type_id, question_key, applies) VALUES ($1,$2,$3)
     ON CONFLICT (building_type_id, question_key) DO UPDATE SET applies = EXCLUDED.applies`,
    [buildingTypeId, questionKey, applies]
  );
  const bt = await pool.query('SELECT name FROM building_types WHERE id = $1', [buildingTypeId]);
  await logActivity({
    action: 'toggled', entityType: 'applicability', entityLabel: `${questionKey} — ${bt.rows[0]?.name || `building type #${buildingTypeId}`}`,
    details: applies ? 'applies' : "doesn't apply",
  });
}

export async function adminListSubAreas() {
  const { rows } = await pool.query('SELECT id, component_type, sub_area, sort_order FROM component_sub_areas ORDER BY component_type, sort_order');
  return rows;
}

export async function adminCreateSubArea(componentType, subArea, sortOrder = 100) {
  const { rows } = await pool.query(
    'INSERT INTO component_sub_areas (component_type, sub_area, sort_order) VALUES ($1,$2,$3) RETURNING *',
    [componentType, subArea, sortOrder]
  );
  await logActivity({ action: 'created', entityType: 'sub_area', entityId: rows[0].id, entityLabel: `${subArea} (${componentType})` });
  return rows[0];
}

export async function adminDeleteSubArea(id) {
  const { rows } = await pool.query('DELETE FROM component_sub_areas WHERE id = $1 RETURNING sub_area, component_type', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'sub_area', entityId: Number(id), entityLabel: `${rows[0].sub_area} (${rows[0].component_type})` });
}

// ── Budget separation: operating budget vs. capital campaigns vs.
//    cabin-holder-funded work vs. user-defined "other" categories. Cost
//    estimates for board presentation/planning — NOT an accounting system;
//    "cost" per WO is COALESCE(actual_cost, estimated_cost) throughout. ────

export async function getBudgetSettings() {
  const { rows } = await pool.query('SELECT annual_operating_budget FROM budget_settings ORDER BY id LIMIT 1');
  return { AnnualOperatingBudget: Number(rows[0]?.annual_operating_budget || 0) };
}
export async function updateBudgetSettings(annualOperatingBudget) {
  await pool.query(
    `UPDATE budget_settings SET annual_operating_budget = $1, updated_at = now()
     WHERE id = (SELECT id FROM budget_settings ORDER BY id LIMIT 1)`,
    [annualOperatingBudget]
  );
  await logActivity({ action: 'updated', entityType: 'budget_settings', entityLabel: 'Annual Operating Budget', details: `$${Number(annualOperatingBudget).toLocaleString()}` });
  return getBudgetSettings();
}

function fundingEntityRowShape(r) { return { Id: r.id, Name: r.name, Description: r.description }; }

export async function listCapitalCampaignProjects() {
  const { rows } = await pool.query('SELECT id, name, description FROM capital_campaign_projects ORDER BY name');
  return rows.map(fundingEntityRowShape);
}
export async function createCapitalCampaignProject({ name, description }) {
  const { rows } = await pool.query('INSERT INTO capital_campaign_projects (name, description) VALUES ($1,$2) RETURNING *', [name, description || null]);
  await logActivity({ action: 'created', entityType: 'capital_campaign_project', entityId: rows[0].id, entityLabel: rows[0].name });
  return fundingEntityRowShape(rows[0]);
}
export async function updateCapitalCampaignProject(id, { name, description }) {
  const { rows } = await pool.query('UPDATE capital_campaign_projects SET name = COALESCE($2,name), description = $3 WHERE id = $1 RETURNING *', [id, name || null, description ?? null]);
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'capital_campaign_project', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? fundingEntityRowShape(rows[0]) : null;
}
export async function deleteCapitalCampaignProject(id) {
  const inUse = await pool.query(`SELECT count(*) FROM work_orders WHERE funding_source = 'capital_campaign' AND funding_ref_id = $1`, [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} work order(s) still reference this project — reassign them first`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM capital_campaign_projects WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'capital_campaign_project', entityId: Number(id), entityLabel: rows[0].name });
}

export async function listOtherBudgetCategories() {
  const { rows } = await pool.query('SELECT id, name, description FROM other_budget_categories ORDER BY name');
  return rows.map(fundingEntityRowShape);
}
export async function createOtherBudgetCategory({ name, description }) {
  const { rows } = await pool.query('INSERT INTO other_budget_categories (name, description) VALUES ($1,$2) RETURNING *', [name, description || null]);
  await logActivity({ action: 'created', entityType: 'other_budget_category', entityId: rows[0].id, entityLabel: rows[0].name });
  return fundingEntityRowShape(rows[0]);
}
export async function updateOtherBudgetCategory(id, { name, description }) {
  const { rows } = await pool.query('UPDATE other_budget_categories SET name = COALESCE($2,name), description = $3 WHERE id = $1 RETURNING *', [id, name || null, description ?? null]);
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'other_budget_category', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? fundingEntityRowShape(rows[0]) : null;
}
export async function deleteOtherBudgetCategory(id) {
  const inUse = await pool.query(`SELECT count(*) FROM work_orders WHERE funding_source = 'other' AND funding_ref_id = $1`, [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} work order(s) still reference this category — reassign them first`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM other_budget_categories WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'other_budget_category', entityId: Number(id), entityLabel: rows[0].name });
}

// The roster is derived, not hand-entered: every distinct assets.lodge_holder
// value should have a matching cabin_holders row. Called before every list
// read so a newly-set lodge_holder shows up next time the page loads, with
// no separate "sync" action for anyone to remember to run. Idempotent
// (ON CONFLICT DO NOTHING against the name unique constraint).
export async function syncCabinHoldersFromAssets() {
  await pool.query(`
    INSERT INTO cabin_holders (name)
    SELECT DISTINCT trim(lodge_holder) FROM assets
    WHERE lodge_holder IS NOT NULL AND trim(lodge_holder) != ''
    ON CONFLICT (name) DO NOTHING
  `);
}

export async function listCabinHolders() {
  await syncCabinHoldersFromAssets();
  const { rows } = await pool.query(`
    SELECT ch.id, ch.name, ch.notes AS description,
      COALESCE(json_agg(json_build_object('Id', a.id, 'Name', a.name)) FILTER (WHERE a.id IS NOT NULL), '[]') AS linked_assets
    FROM cabin_holders ch
    LEFT JOIN assets a ON lower(trim(a.lodge_holder)) = lower(ch.name)
    GROUP BY ch.id, ch.name, ch.notes
    ORDER BY ch.name
  `);
  return rows.map((r) => ({ ...fundingEntityRowShape(r), LinkedAssets: r.linked_assets }));
}
export async function createCabinHolder({ name, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO cabin_holders (name, notes) VALUES ($1,$2)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
    [name, notes || null]
  );
  await logActivity({ action: 'created', entityType: 'cabin_holder', entityId: rows[0].id, entityLabel: rows[0].name });
  return { Id: rows[0].id, Name: rows[0].name, Description: rows[0].notes };
}
export async function updateCabinHolder(id, { name, notes }) {
  const { rows } = await pool.query('UPDATE cabin_holders SET name = COALESCE($2,name), notes = $3 WHERE id = $1 RETURNING *', [id, name || null, notes ?? null]);
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'cabin_holder', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? { Id: rows[0].id, Name: rows[0].name, Description: rows[0].notes } : null;
}
export async function deleteCabinHolder(id) {
  const inUse = await pool.query(`SELECT count(*) FROM work_orders WHERE funding_source = 'cabin_holder' AND funding_ref_id = $1`, [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} work order(s) still reference this cabin-holder — reassign them first`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM cabin_holders WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'cabin_holder', entityId: Number(id), entityLabel: rows[0].name });
}

// The whole "Budget" section of Capital Plan in one call: operating-budget
// years-to-cover, and itemized-with-rollup views for each funding source.
export async function getBudgetOverview() {
  const settings = await getBudgetSettings();

  const opRes = await pool.query(`
    SELECT id, title, status, priority, COALESCE(actual_cost, estimated_cost, 0) AS cost
    FROM work_orders WHERE funding_source = 'operating_budget' AND COALESCE(actual_cost, estimated_cost, 0) > 0
    ORDER BY status != 'Done', id DESC
  `);
  const pendingOpCost = opRes.rows.filter((r) => r.status !== 'Done').reduce((s, r) => s + Number(r.cost), 0);
  const totalOpCost = opRes.rows.reduce((s, r) => s + Number(r.cost), 0);

  async function itemizedGroups(fundingSource, entities) {
    const woRes = await pool.query(
      `SELECT id, title, status, funding_ref_id, COALESCE(actual_cost, estimated_cost, 0) AS cost
       FROM work_orders WHERE funding_source = $1`,
      [fundingSource]
    );
    return entities.map((ent) => {
      const items = woRes.rows.filter((r) => r.funding_ref_id === ent.Id).map((r) => ({
        WorkOrderId: r.id, Title: r.title, Status: r.status, Cost: Number(r.cost),
      }));
      return { ...ent, Items: items, Total: items.reduce((s, i) => s + i.Cost, 0) };
    });
  }

  const [campaignProjects, otherCategories, cabinHolders] = await Promise.all([
    listCapitalCampaignProjects().then((ents) => itemizedGroups('capital_campaign', ents)),
    listOtherBudgetCategories().then((ents) => itemizedGroups('other', ents)),
    listCabinHolders().then((ents) => itemizedGroups('cabin_holder', ents)),
  ]);

  return {
    OperatingBudget: {
      AnnualOperatingBudget: settings.AnnualOperatingBudget,
      PendingCost: pendingOpCost,
      TotalCost: totalOpCost,
      YearsToCover: settings.AnnualOperatingBudget > 0 ? pendingOpCost / settings.AnnualOperatingBudget : null,
    },
    CapitalCampaignProjects: campaignProjects,
    CapitalCampaignTotal: campaignProjects.reduce((s, p) => s + p.Total, 0),
    OtherCategories: otherCategories,
    OtherTotal: otherCategories.reduce((s, p) => s + p.Total, 0),
    CabinHolders: cabinHolders,
    CabinHolderTotal: cabinHolders.reduce((s, p) => s + p.Total, 0),
  };
}

// ── Work Orders + Asset Updates write-back (brief's Phase 2) ───────────────

// Dashboard aggregate: status breakdown + schedule-vs-today breakdown for
// open (non-Done) work orders. One query, no row-by-row JS looping needed.
export async function getWorkOrderSummary() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'Open')        AS open,
      COUNT(*) FILTER (WHERE status = 'In Progress')  AS in_progress,
      COUNT(*) FILTER (WHERE status = 'On Hold')      AS on_hold,
      COUNT(*) FILTER (WHERE status = 'Urgent')       AS urgent,
      COUNT(*) FILTER (WHERE status = 'Done')         AS done,
      COUNT(*) FILTER (WHERE status != 'Done' AND scheduled_date = CURRENT_DATE) AS due_today,
      COUNT(*) FILTER (WHERE status != 'Done' AND scheduled_date < CURRENT_DATE) AS past_due,
      COUNT(*) FILTER (WHERE status != 'Done' AND scheduled_date > CURRENT_DATE) AS due_future,
      COUNT(*) FILTER (WHERE status != 'Done' AND scheduled_date IS NULL) AS unscheduled
    FROM work_orders
  `);
  const r = rows[0];
  return {
    Open: Number(r.open), InProgress: Number(r.in_progress), OnHold: Number(r.on_hold),
    Urgent: Number(r.urgent), Done: Number(r.done),
    DueToday: Number(r.due_today), PastDue: Number(r.past_due), DueFuture: Number(r.due_future),
    Unscheduled: Number(r.unscheduled),
  };
}

export async function listWorkOrders() {
  const { rows } = await pool.query(
    `SELECT w.id, w.title, w.status, w.priority, w.date_reported, w.date_completed, w.scheduled_date,
            w.estimated_hours, w.estimated_cost, w.actual_hours, w.actual_cost,
            w.asset_id, a.name AS asset_name, w.location_id, l.name AS location_name
     FROM work_orders w
     LEFT JOIN assets a ON a.id = w.asset_id
     LEFT JOIN locations l ON l.id = w.location_id
     ORDER BY w.id DESC`
  );
  return rows.map((r) => ({
    Id: r.id, Title: r.title, Status: r.status, Priority: r.priority,
    'Date Reported': r.date_reported, 'Date Completed': r.date_completed, 'Scheduled Date': r.scheduled_date,
    'Estimated Hours': r.estimated_hours, 'Estimated Cost': r.estimated_cost,
    'Actual Hours': r.actual_hours, 'Actual Cost': r.actual_cost,
    Asset: r.asset_id ? { Id: r.asset_id, Name: r.asset_name } : null,
    Location: r.location_id ? { Id: r.location_id, Name: r.location_name } : null,
  }));
}

async function getAssetUpdatesForWorkOrder(woId) {
  const { rows } = await pool.query(
    `SELECT id, target_field, new_value, applied FROM asset_updates WHERE work_order_id = $1 ORDER BY id`,
    [woId]
  );
  return rows.map((r) => ({ Id: r.id, 'Target Field': r.target_field, 'New Value': r.new_value, Applied: r.applied }));
}

async function getWorkOrderAssignees(woId) {
  const [vol, ven] = await Promise.all([
    pool.query(
      `SELECT v.id, v.name, v.phone, v.skill FROM work_order_volunteers wov
       JOIN volunteers v ON v.id = wov.volunteer_id WHERE wov.work_order_id = $1 ORDER BY v.name`,
      [woId]
    ),
    pool.query(
      `SELECT vd.id, vd.name, vd.phone, vd.specialty FROM work_order_vendors wov
       JOIN vendors vd ON vd.id = wov.vendor_id WHERE wov.work_order_id = $1 ORDER BY vd.name`,
      [woId]
    ),
  ]);
  return {
    volunteers: vol.rows.map((r) => ({ Id: r.id, Name: r.name, 'Phone Number': r.phone, Skill: r.skill })),
    vendors: ven.rows.map((r) => ({ Id: r.id, Name: r.name, 'Phone Number': r.phone, Specialty: r.specialty })),
  };
}

export async function getWorkOrderDetail(woId) {
  const { rows } = await pool.query(
    `SELECT w.*, a.name AS asset_name, a.lodge_holder AS asset_lodge_holder, l.name AS location_name FROM work_orders w
     LEFT JOIN assets a ON a.id = w.asset_id LEFT JOIN locations l ON l.id = w.location_id
     WHERE w.id = $1`,
    [woId]
  );
  const w = rows[0];
  if (!w) return null;
  const [assetUpdates, assignees, fundingRefLabel] = await Promise.all([
    getAssetUpdatesForWorkOrder(woId), getWorkOrderAssignees(woId), getFundingRefLabel(w.funding_source, w.funding_ref_id),
  ]);
  return {
    workOrder: {
      Id: w.id, Title: w.title, Status: w.status, Priority: w.priority,
      'Date Reported': w.date_reported, 'Date Completed': w.date_completed, 'Scheduled Date': w.scheduled_date,
      'Estimated Hours': w.estimated_hours, 'Actual Hours': w.actual_hours,
      'Estimated Cost': w.estimated_cost, 'Actual Cost': w.actual_cost,
      Description: w.description,
      Asset: w.asset_id ? { Id: w.asset_id, Name: w.asset_name, LodgeHolder: w.asset_lodge_holder } : null,
      Location: w.location_id ? { Id: w.location_id, Name: w.location_name } : null,
      FundingSource: w.funding_source, FundingRefId: w.funding_ref_id, FundingRefLabel: fundingRefLabel,
    },
    assetUpdates,
    ...assignees,
  };
}

// funding_ref_id points at a different table depending on funding_source
// (no real FK possible across three target tables — see migration 0016).
async function getFundingRefLabel(fundingSource, fundingRefId) {
  if (!fundingRefId) return null;
  const table = { capital_campaign: 'capital_campaign_projects', cabin_holder: 'cabin_holders', other: 'other_budget_categories' }[fundingSource];
  if (!table) return null;
  const { rows } = await pool.query(`SELECT name FROM ${table} WHERE id = $1`, [fundingRefId]);
  return rows[0]?.name || null;
}

const today = () => new Date().toISOString().slice(0, 10);

export async function createWorkOrder({ title, assetId, locationId, priority, description, scheduledDate, assetUpdates = [], tasks = [] }) {
  const propertyFields = await getAssetPropertyFields();
  const byLabel = new Map(propertyFields.map((f) => [f.title, f]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO work_orders (title, asset_id, location_id, priority, status, description, date_reported, scheduled_date)
       VALUES ($1,$2,$3,$4,'Open',$5,$6,$7) RETURNING id`,
      [title, assetId || null, locationId || null, priority || 'Medium', description || null, today(), scheduledDate || null]
    );
    const woId = rows[0].id;
    const created = [];
    for (const u of assetUpdates) {
      if (!u?.targetField || !byLabel.has(u.targetField)) continue; // must be a live property field label
      const { rows: auRows } = await client.query(
        `INSERT INTO asset_updates (work_order_id, target_field, new_value, applied) VALUES ($1,$2,$3,false) RETURNING *`,
        [woId, u.targetField, String(u.newValue ?? '')]
      );
      created.push(auRows[0]);
    }
    let sortOrder = 0;
    for (const t of tasks) {
      const desc = (typeof t === 'string' ? t : t?.description || '').trim();
      if (!desc) continue;
      await client.query(
        `INSERT INTO work_order_tasks (work_order_id, description, sort_order) VALUES ($1,$2,$3)`,
        [woId, desc, sortOrder++]
      );
    }
    await client.query('COMMIT');
    await logActivity({ action: 'created', entityType: 'work_order', entityId: woId, entityLabel: title });
    return { workOrderId: woId, assetUpdates: created };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function updateWorkOrder(woId, fields) {
  const allowed = ['title', 'description', 'priority', 'status', 'date_reported', 'date_completed',
    'scheduled_date', 'asset_id', 'estimated_hours', 'actual_hours', 'estimated_cost', 'actual_cost',
    'funding_source', 'funding_ref_id'];
  const setCols = [];
  const vals = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    setCols.push(`${key} = $${i++}`);
    vals.push(value === '' ? null : value);
  }
  if (!setCols.length) return getWorkOrderDetail(woId);
  vals.push(woId);
  const { rowCount } = await pool.query(`UPDATE work_orders SET ${setCols.join(', ')} WHERE id = $${i}`, vals);
  if (!rowCount) return null;
  const detail = await getWorkOrderDetail(woId);
  await logActivity({ action: 'updated', entityType: 'work_order', entityId: Number(woId), entityLabel: detail?.workOrder?.Title });
  return detail;
}

// ── Work Order log — free-text updates + optional hours + optional status
//    change, distinct from Tasks (scope-of-work) and the single Actual
//    Hours aggregate. Feeds future reporting. ───────────────────────────

export async function listWorkOrderLogEntries(woId) {
  const { rows } = await pool.query(
    'SELECT * FROM work_order_log_entries WHERE work_order_id = $1 ORDER BY created_at DESC',
    [woId]
  );
  return rows.map((r) => ({
    Id: r.id, Note: r.note, Hours: r.hours != null ? Number(r.hours) : null,
    StatusChange: r.status_change, Username: r.username, CreatedAt: r.created_at,
  }));
}

// Logging an entry can optionally also change the WO's status in the same
// action ("log what I did, and mark it In Progress") — one motion instead
// of two separate saves.
export async function createWorkOrderLogEntry(woId, { note, hours, statusChange }) {
  const { rows } = await pool.query(
    'INSERT INTO work_order_log_entries (work_order_id, note, hours, status_change, username) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [woId, note, hours ?? null, statusChange || null, currentUsername()]
  );
  if (statusChange) await pool.query('UPDATE work_orders SET status = $2 WHERE id = $1', [woId, statusChange]);
  const woRes = await pool.query('SELECT title FROM work_orders WHERE id = $1', [woId]);
  await logActivity({
    action: 'created', entityType: 'work_order_log_entry', entityId: rows[0].id, entityLabel: woRes.rows[0]?.title,
    details: [hours ? `${hours}h` : null, statusChange ? `status → ${statusChange}` : null].filter(Boolean).join(', ') || undefined,
  });
  return {
    Id: rows[0].id, Note: rows[0].note, Hours: rows[0].hours != null ? Number(rows[0].hours) : null,
    StatusChange: rows[0].status_change, Username: rows[0].username, CreatedAt: rows[0].created_at,
  };
}

export async function deleteWorkOrderLogEntry(id) {
  const { rows } = await pool.query('DELETE FROM work_order_log_entries WHERE id = $1 RETURNING note, work_order_id', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'work_order_log_entry', entityId: Number(id), entityLabel: rows[0].note, details: `On Work Order #${rows[0].work_order_id}` });
}

// Fresh copy: same title (+ " (Copy)"), asset, location, priority, description,
// and pending job lines — but a clean slate otherwise (Open status, no dates,
// no actuals, no crew assignments, no applied-history). Good for "this happens
// again next month" without retyping everything.
export async function duplicateWorkOrder(woId) {
  const src = await pool.query('SELECT * FROM work_orders WHERE id = $1', [woId]);
  const w = src.rows[0];
  if (!w) return null;
  const srcUpdates = await pool.query('SELECT target_field, new_value FROM asset_updates WHERE work_order_id = $1', [woId]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO work_orders (title, asset_id, location_id, priority, status, description, date_reported)
       VALUES ($1,$2,$3,$4,'Open',$5,$6) RETURNING id`,
      [`${w.title} (Copy)`, w.asset_id, w.location_id, w.priority, w.description, today()]
    );
    const newId = rows[0].id;
    for (const u of srcUpdates.rows) {
      await client.query(
        `INSERT INTO asset_updates (work_order_id, target_field, new_value, applied) VALUES ($1,$2,$3,false)`,
        [newId, u.target_field, u.new_value]
      );
    }
    await client.query('COMMIT');
    await logActivity({ action: 'created', entityType: 'work_order', entityId: newId, entityLabel: `${w.title} (Copy)`, details: `Duplicated from Work Order #${woId}` });
    return newId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Work Order templates ("canned" WOs for repeatable tasks) ───────────────

function templateRowShape(r) {
  return {
    Id: r.id, Name: r.name, DefaultTitle: r.default_title, DefaultPriority: r.default_priority,
    DefaultDescription: r.default_description, TaskDefaults: r.task_defaults, JobLineDefaults: r.job_line_defaults,
  };
}
export async function listWorkOrderTemplates() {
  const { rows } = await pool.query('SELECT * FROM work_order_templates ORDER BY name');
  return rows.map(templateRowShape);
}
export async function createWorkOrderTemplate({ name, defaultTitle, defaultPriority, defaultDescription, taskDefaults = [], jobLineDefaults = [] }) {
  const { rows } = await pool.query(
    `INSERT INTO work_order_templates (name, default_title, default_priority, default_description, task_defaults, job_line_defaults)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, defaultTitle || null, defaultPriority || null, defaultDescription || null, JSON.stringify(taskDefaults), JSON.stringify(jobLineDefaults)]
  );
  await logActivity({ action: 'created', entityType: 'work_order_template', entityId: rows[0].id, entityLabel: rows[0].name });
  return templateRowShape(rows[0]);
}
export async function updateWorkOrderTemplate(id, { name, defaultTitle, defaultPriority, defaultDescription, taskDefaults, jobLineDefaults }) {
  const { rows } = await pool.query(
    `UPDATE work_order_templates SET
       name = COALESCE($2,name), default_title = COALESCE($3,default_title),
       default_priority = COALESCE($4,default_priority), default_description = COALESCE($5,default_description),
       task_defaults = COALESCE($6,task_defaults), job_line_defaults = COALESCE($7,job_line_defaults)
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, defaultTitle ?? null, defaultPriority ?? null, defaultDescription ?? null,
      taskDefaults ? JSON.stringify(taskDefaults) : null, jobLineDefaults ? JSON.stringify(jobLineDefaults) : null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'work_order_template', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? templateRowShape(rows[0]) : null;
}
export async function deleteWorkOrderTemplate(id) {
  const { rows } = await pool.query('DELETE FROM work_order_templates WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'work_order_template', entityId: Number(id), entityLabel: rows[0].name });
}

// targetField is a property-field LABEL (matches an asset_property_fields.label),
// so any admin-added field is automatically a valid, working write-back target —
// no separate "Target Field option list" to keep in sync (the old NocoDB failure
// mode the brief calls out).
export async function addAssetUpdateToWorkOrder(woId, targetField, newValue) {
  const propertyFields = await getAssetPropertyFields();
  const field = propertyFields.find((f) => f.title === targetField);
  if (!field) {
    const err = new Error(`"${targetField}" is not a live property field`);
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    `INSERT INTO asset_updates (work_order_id, target_field, new_value, applied) VALUES ($1,$2,$3,false) RETURNING *`,
    [woId, targetField, String(newValue ?? '')]
  );
  await logActivity({ action: 'created', entityType: 'asset_update', entityId: rows[0].id, entityLabel: `${targetField} → ${newValue}`, details: `On Work Order #${woId}` });
  return rows[0];
}

export async function deleteAssetUpdate(auId) {
  const { rows } = await pool.query('SELECT applied, target_field, new_value, work_order_id FROM asset_updates WHERE id = $1', [auId]);
  if (!rows[0]) return { notFound: true };
  if (rows[0].applied) return { alreadyApplied: true };
  await pool.query('DELETE FROM asset_updates WHERE id = $1', [auId]);
  await logActivity({ action: 'deleted', entityType: 'asset_update', entityId: Number(auId), entityLabel: `${rows[0].target_field} → ${rows[0].new_value}`, details: `On Work Order #${rows[0].work_order_id}` });
  return { ok: true };
}

// Completing a WO: apply every pending Asset Update to its target field (real
// column or EAV, resolved the same way submitAudit does), mark each applied,
// then close the WO. One transaction.
export async function completeWorkOrder(woId) {
  const woRes = await pool.query('SELECT asset_id FROM work_orders WHERE id = $1', [woId]);
  if (!woRes.rows[0]) return null;
  const assetId = woRes.rows[0].asset_id;
  if (!assetId) {
    const err = new Error('Work Order has no linked Asset — nothing to write back');
    err.status = 400;
    throw err;
  }
  const propertyFields = await getAssetPropertyFields();
  const byLabel = new Map(propertyFields.map((f) => [f.title, f]));
  const pending = await pool.query('SELECT id, target_field, new_value FROM asset_updates WHERE work_order_id = $1 AND applied = false', [woId]);

  const client = await pool.connect();
  const appliedIds = [];
  try {
    await client.query('BEGIN');
    for (const u of pending.rows) {
      const field = byLabel.get(u.target_field);
      if (!field) continue; // field was since deactivated/removed — skip, don't fail the whole completion
      if (field.columnName) {
        await client.query(`UPDATE assets SET ${field.columnName} = $1 WHERE id = $2`, [u.new_value, assetId]);
      } else {
        await client.query(
          `INSERT INTO asset_property_values (asset_id, field_key, value) VALUES ($1,$2,$3)
           ON CONFLICT (asset_id, field_key) DO UPDATE SET value = EXCLUDED.value`,
          [assetId, field.fieldKey, u.new_value]
        );
      }
      await client.query('UPDATE asset_updates SET applied = true WHERE id = $1', [u.id]);
      appliedIds.push(u.id);
    }
    await client.query(`UPDATE work_orders SET status = 'Done', date_completed = $1 WHERE id = $2`, [today(), woId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const detail = await getWorkOrderDetail(woId);
  await logActivity({
    action: 'completed', entityType: 'work_order', entityId: Number(woId), entityLabel: detail?.workOrder?.Title,
    details: appliedIds.length ? `Applied ${appliedIds.length} asset field update(s)` : undefined,
  });
  return { ...detail, appliedUpdateIds: appliedIds };
}

export async function assignVolunteer(woId, volunteerId) {
  await pool.query(
    `INSERT INTO work_order_volunteers (work_order_id, volunteer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [woId, volunteerId]
  );
  return getWorkOrderAssignees(woId);
}
export async function unassignVolunteer(woId, volunteerId) {
  await pool.query('DELETE FROM work_order_volunteers WHERE work_order_id = $1 AND volunteer_id = $2', [woId, volunteerId]);
  return getWorkOrderAssignees(woId);
}
export async function assignVendor(woId, vendorId) {
  await pool.query(
    `INSERT INTO work_order_vendors (work_order_id, vendor_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [woId, vendorId]
  );
  return getWorkOrderAssignees(woId);
}
export async function unassignVendor(woId, vendorId) {
  await pool.query('DELETE FROM work_order_vendors WHERE work_order_id = $1 AND vendor_id = $2', [woId, vendorId]);
  return getWorkOrderAssignees(woId);
}

function volunteerRowShape(r) {
  return { Id: r.id, Name: r.name, 'Phone Number': r.phone, Email: r.email, Address: r.address, Skill: r.skill, Active: r.active };
}
function vendorRowShape(r) {
  return { Id: r.id, Name: r.name, 'Phone Number': r.phone, Email: r.email, Address: r.address, Specialty: r.specialty, Active: r.active };
}

export async function listVolunteers({ includeInactive = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM volunteers ${includeInactive ? '' : 'WHERE active'} ORDER BY name`
  );
  return rows.map(volunteerRowShape);
}
export async function createVolunteer({ name, phone, email, address, skill = [] }) {
  const { rows } = await pool.query(
    `INSERT INTO volunteers (name, phone, email, address, skill) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, phone || null, email || null, address || null, skill]
  );
  await logActivity({ action: 'created', entityType: 'volunteer', entityId: rows[0].id, entityLabel: rows[0].name });
  return volunteerRowShape(rows[0]);
}
export async function updateVolunteer(id, { name, phone, email, address, skill }) {
  const { rows } = await pool.query(
    `UPDATE volunteers SET name = COALESCE($2,name), phone = COALESCE($3,phone), email = COALESCE($4,email),
       address = COALESCE($5,address), skill = COALESCE($6, skill)
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, phone ?? null, email ?? null, address ?? null, skill ?? null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'volunteer', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? volunteerRowShape(rows[0]) : null;
}
// Hard-deletes only if never assigned to a Work Order (mirrors
// adminDeleteBuildingType's block-if-in-use pattern); otherwise deactivates
// so WO assignment history isn't silently lost.
export async function removeVolunteer(id) {
  const nameRes = await pool.query('SELECT name FROM volunteers WHERE id = $1', [id]);
  const name = nameRes.rows[0]?.name;
  const used = await pool.query(
    `SELECT (SELECT count(*) FROM work_order_volunteers WHERE volunteer_id = $1)
           + (SELECT count(*) FROM crew_session_volunteers WHERE volunteer_id = $1) AS count`,
    [id]
  );
  if (Number(used.rows[0].count) > 0) {
    await pool.query('UPDATE volunteers SET active = false WHERE id = $1', [id]);
    await logActivity({ action: 'deactivated', entityType: 'volunteer', entityId: Number(id), entityLabel: name });
    return { deactivated: true };
  }
  await pool.query('DELETE FROM volunteers WHERE id = $1', [id]);
  await logActivity({ action: 'deleted', entityType: 'volunteer', entityId: Number(id), entityLabel: name });
  return { deleted: true };
}

export async function listVendors({ includeInactive = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM vendors ${includeInactive ? '' : 'WHERE active'} ORDER BY name`
  );
  return rows.map(vendorRowShape);
}
export async function createVendor({ name, phone, email, address, specialty = [] }) {
  const { rows } = await pool.query(
    `INSERT INTO vendors (name, phone, email, address, specialty) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, phone || null, email || null, address || null, specialty]
  );
  await logActivity({ action: 'created', entityType: 'vendor', entityId: rows[0].id, entityLabel: rows[0].name });
  return vendorRowShape(rows[0]);
}
export async function updateVendor(id, { name, phone, email, address, specialty }) {
  const { rows } = await pool.query(
    `UPDATE vendors SET name = COALESCE($2,name), phone = COALESCE($3,phone), email = COALESCE($4,email),
       address = COALESCE($5,address), specialty = COALESCE($6, specialty)
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, phone ?? null, email ?? null, address ?? null, specialty ?? null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'vendor', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? vendorRowShape(rows[0]) : null;
}
export async function removeVendor(id) {
  const nameRes = await pool.query('SELECT name FROM vendors WHERE id = $1', [id]);
  const name = nameRes.rows[0]?.name;
  const used = await pool.query(
    `SELECT (SELECT count(*) FROM work_order_vendors WHERE vendor_id = $1)
           + (SELECT count(*) FROM crew_session_vendors WHERE vendor_id = $1) AS count`,
    [id]
  );
  if (Number(used.rows[0].count) > 0) {
    await pool.query('UPDATE vendors SET active = false WHERE id = $1', [id]);
    await logActivity({ action: 'deactivated', entityType: 'vendor', entityId: Number(id), entityLabel: name });
    return { deactivated: true };
  }
  await pool.query('DELETE FROM vendors WHERE id = $1', [id]);
  await logActivity({ action: 'deleted', entityType: 'vendor', entityId: Number(id), entityLabel: name });
  return { deleted: true };
}

// ── Crew Sessions — attendance-based hours tracking, independent of Work
//    Orders. A session is a dated block of work — optionally tied to a WO,
//    optionally just a free-text `activity` label (e.g. "Mowing") — with one
//    hours figure credited to everyone who attended (see migration 0022:
//    hours already lived at the session/note level for WOs, never
//    per-person; this generalizes that to standalone work too). "Jobs" for a
//    person = distinct work_order_id across their sessions; standalone
//    activities don't count as a job. ──────────────────────────────────────

function crewSessionRowShape(r) {
  return {
    Id: r.id, WorkOrderId: r.work_order_id, WorkOrderTitle: r.wo_title,
    Activity: r.activity, Date: r.session_date, Hours: r.hours != null ? Number(r.hours) : null,
    Note: r.note, Username: r.username, CreatedAt: r.created_at,
    Volunteers: r.volunteer_names || [], Vendors: r.vendor_names || [],
  };
}

const CREW_SESSION_SELECT = `
  SELECT cs.*, w.title AS wo_title,
         COALESCE(ARRAY_AGG(DISTINCT v.name) FILTER (WHERE v.name IS NOT NULL), '{}') AS volunteer_names,
         COALESCE(ARRAY_AGG(DISTINCT vd.name) FILTER (WHERE vd.name IS NOT NULL), '{}') AS vendor_names
  FROM crew_sessions cs
  LEFT JOIN work_orders w ON w.id = cs.work_order_id
  LEFT JOIN crew_session_volunteers csv ON csv.session_id = cs.id
  LEFT JOIN volunteers v ON v.id = csv.volunteer_id
  LEFT JOIN crew_session_vendors csd ON csd.session_id = cs.id
  LEFT JOIN vendors vd ON vd.id = csd.vendor_id`;

async function getCrewSessionById(id) {
  const { rows } = await pool.query(`${CREW_SESSION_SELECT} WHERE cs.id = $1 GROUP BY cs.id, w.title`, [id]);
  return rows[0] ? crewSessionRowShape(rows[0]) : null;
}

export async function listCrewSessionsForWorkOrder(woId) {
  const { rows } = await pool.query(
    `${CREW_SESSION_SELECT} WHERE cs.work_order_id = $1 GROUP BY cs.id, w.title ORDER BY cs.session_date DESC, cs.created_at DESC`,
    [woId]
  );
  return rows.map(crewSessionRowShape);
}

// A session needs either a Work Order or a free-text activity label —
// enforced here, not in the DB, so the error message can be specific.
export async function createCrewSession({ workOrderId, activity, sessionDate, hours, note, volunteerIds = [], vendorIds = [] }) {
  if (!workOrderId && !activity) throw new Error('A session needs either a Work Order or an activity label');
  const client = await pool.connect();
  let sessionId;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO crew_sessions (work_order_id, activity, session_date, hours, note, username)
       VALUES ($1,$2,COALESCE($3,CURRENT_DATE),$4,$5,$6) RETURNING id`,
      [workOrderId || null, activity || null, sessionDate || null, hours ?? null, note || null, currentUsername()]
    );
    sessionId = rows[0].id;
    for (const vId of volunteerIds) {
      await client.query('INSERT INTO crew_session_volunteers (session_id, volunteer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [sessionId, vId]);
    }
    for (const vdId of vendorIds) {
      await client.query('INSERT INTO crew_session_vendors (session_id, vendor_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [sessionId, vdId]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await logActivity({
    action: 'created', entityType: 'crew_session', entityId: sessionId,
    entityLabel: activity || `Work Order #${workOrderId}`,
    details: [hours ? `${hours}h` : null, `${volunteerIds.length + vendorIds.length} attendee(s)`].filter(Boolean).join(', '),
  });
  return getCrewSessionById(sessionId);
}

export async function deleteCrewSession(id) {
  const { rows } = await pool.query('DELETE FROM crew_sessions WHERE id = $1 RETURNING activity, work_order_id', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'crew_session', entityId: Number(id), entityLabel: rows[0].activity || `Work Order #${rows[0].work_order_id}` });
}

// "Progress made" per person — one row per session, mirrors
// getWorkOrderLogReportRawData's shape/ordering for the Reports tab.
export async function getCrewSessionReportRawData() {
  const { rows } = await pool.query(
    `SELECT cs.*, w.title AS wo_title, a.name AS asset_name, loc.name AS location_name,
            COALESCE(ARRAY_AGG(DISTINCT v.name) FILTER (WHERE v.name IS NOT NULL), '{}') AS volunteer_names,
            COALESCE(ARRAY_AGG(DISTINCT vd.name) FILTER (WHERE vd.name IS NOT NULL), '{}') AS vendor_names
     FROM crew_sessions cs
     LEFT JOIN work_orders w ON w.id = cs.work_order_id
     LEFT JOIN assets a ON a.id = w.asset_id
     LEFT JOIN locations loc ON loc.id = w.location_id
     LEFT JOIN crew_session_volunteers csv ON csv.session_id = cs.id
     LEFT JOIN volunteers v ON v.id = csv.volunteer_id
     LEFT JOIN crew_session_vendors csd ON csd.session_id = cs.id
     LEFT JOIN vendors vd ON vd.id = csd.vendor_id
     GROUP BY cs.id, w.title, a.name, loc.name
     ORDER BY cs.session_date DESC, cs.created_at DESC`
  );
  return { sessions: rows.map((r) => ({ ...crewSessionRowShape(r), AssetName: r.asset_name, LocationName: r.location_name })) };
}

// Per-person totals for the Hours report — LEFT JOINs from volunteers/vendors
// (not crew_sessions) so everyone shows even with 0 hours in range, with the
// date filter applied in the JOIN condition rather than WHERE so people with
// no sessions in range aren't dropped entirely. `from`/`to` are plain
// YYYY-MM-DD strings (or null for open-ended) — never build these with
// `.toISOString()` client-side, see app.js's isoDate() comment.
export async function getCrewHoursSummary({ from, to } = {}) {
  const params = [from || null, to || null];
  const shape = (r) => ({ Id: r.id, Name: r.name, Active: r.active, Sessions: Number(r.sessions), Jobs: Number(r.jobs), Hours: Number(r.hours) });
  const [volRes, venRes] = await Promise.all([
    pool.query(
      `SELECT v.id, v.name, v.active,
              COUNT(DISTINCT cs.id) AS sessions,
              COUNT(DISTINCT cs.work_order_id) AS jobs,
              COALESCE(SUM(cs.hours), 0) AS hours
       FROM volunteers v
       LEFT JOIN crew_session_volunteers csv ON csv.volunteer_id = v.id
       LEFT JOIN crew_sessions cs ON cs.id = csv.session_id
         AND ($1::date IS NULL OR cs.session_date >= $1)
         AND ($2::date IS NULL OR cs.session_date <= $2)
       GROUP BY v.id, v.name, v.active
       ORDER BY hours DESC, v.name`,
      params
    ),
    pool.query(
      `SELECT vd.id, vd.name, vd.active,
              COUNT(DISTINCT cs.id) AS sessions,
              COUNT(DISTINCT cs.work_order_id) AS jobs,
              COALESCE(SUM(cs.hours), 0) AS hours
       FROM vendors vd
       LEFT JOIN crew_session_vendors csd ON csd.vendor_id = vd.id
       LEFT JOIN crew_sessions cs ON cs.id = csd.session_id
         AND ($1::date IS NULL OR cs.session_date >= $1)
         AND ($2::date IS NULL OR cs.session_date <= $2)
       GROUP BY vd.id, vd.name, vd.active
       ORDER BY hours DESC, vd.name`,
      params
    ),
  ]);
  return { volunteers: volRes.rows.map(shape), vendors: venRes.rows.map(shape) };
}

// ── Skill catalog — shared by volunteers.skill and vendors.specialty. Same
//    "add on the fly, no deploy" philosophy as the rest of the admin system. ──

export async function listSkills() {
  const { rows } = await pool.query('SELECT id, name FROM skill_catalog ORDER BY name');
  return rows.map((r) => ({ Id: r.id, Name: r.name }));
}
export async function createSkill(name) {
  const { rows } = await pool.query(
    `INSERT INTO skill_catalog (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
    [name]
  );
  return { Id: rows[0].id, Name: rows[0].name };
}

// ── Asset quick-create + live search — for the "add an asset without leaving
//    the screen" combobox used anywhere an asset needs to be picked. ────────

export async function searchAssetsLive(q) {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.asset_type, a.location_id, l.name AS location_name
     FROM assets a LEFT JOIN locations l ON l.id = a.location_id
     WHERE a.name ILIKE $1 ORDER BY a.name LIMIT 20`,
    [`%${q}%`]
  );
  return rows.map((r) => ({ Id: r.id, Name: r.name, assetType: r.asset_type, locationId: r.location_id, locationName: r.location_name }));
}

export async function createAssetQuick({ name, locationId, assetType }) {
  const { rows } = await pool.query(
    `INSERT INTO assets (name, location_id, asset_type) VALUES ($1,$2,$3) RETURNING id, name, location_id, asset_type`,
    [name, locationId || null, assetType || null]
  );
  const r = rows[0];
  await logActivity({ action: 'created', entityType: 'asset', entityId: r.id, entityLabel: r.name });
  return { Id: r.id, Name: r.name, assetType: r.asset_type, locationId: r.location_id, locationName: null };
}

// ── Work Order Tasks — free-text scope-of-work job lines (the default way to
//    add work to a WO). Distinct from asset_updates, which is the separate,
//    optional "this WO also changes an asset property field" mechanism —
//    audit-style fields (Has Key, Window Count, ...) stay reserved for the
//    audit flow; routine work doesn't need to touch them. ───────────────────

export async function listWorkOrderTasks(woId) {
  const { rows } = await pool.query(
    'SELECT id, description, done, sort_order FROM work_order_tasks WHERE work_order_id = $1 ORDER BY sort_order, id',
    [woId]
  );
  return rows.map((r) => ({ Id: r.id, Description: r.description, Done: r.done, SortOrder: r.sort_order }));
}
export async function createWorkOrderTask(woId, description) {
  const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM work_order_tasks WHERE work_order_id = $1', [woId]);
  const { rows } = await pool.query(
    'INSERT INTO work_order_tasks (work_order_id, description, sort_order) VALUES ($1,$2,$3) RETURNING *',
    [woId, description, maxRows[0].next]
  );
  await logActivity({ action: 'created', entityType: 'task', entityId: rows[0].id, entityLabel: rows[0].description, details: `On Work Order #${woId}` });
  return { Id: rows[0].id, Description: rows[0].description, Done: rows[0].done, SortOrder: rows[0].sort_order };
}
export async function updateWorkOrderTask(id, { description, done }) {
  const { rows } = await pool.query(
    'UPDATE work_order_tasks SET description = COALESCE($2,description), done = COALESCE($3,done) WHERE id = $1 RETURNING *',
    [id, description ?? null, done ?? null]
  );
  if (rows[0]) {
    if (done !== undefined && done !== null) {
      await logActivity({ action: 'toggled', entityType: 'task', entityId: rows[0].id, entityLabel: rows[0].description, details: done ? 'checked' : 'unchecked' });
    } else if (description) {
      await logActivity({ action: 'updated', entityType: 'task', entityId: rows[0].id, entityLabel: rows[0].description });
    }
  }
  return rows[0] ? { Id: rows[0].id, Description: rows[0].description, Done: rows[0].done, SortOrder: rows[0].sort_order } : null;
}
export async function deleteWorkOrderTask(id) {
  const { rows } = await pool.query('DELETE FROM work_order_tasks WHERE id = $1 RETURNING description, work_order_id', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'task', entityId: Number(id), entityLabel: rows[0].description, details: `On Work Order #${rows[0].work_order_id}` });
}

// ── Calendar Events — independent of Work Orders (optional link either way).
//    Recurrence is expanded on read for whatever date range is requested;
//    no occurrence rows are stored. ──────────────────────────────────────────

function addInterval(date, type, n) {
  const d = new Date(date);
  if (type === 'daily') d.setUTCDate(d.getUTCDate() + n);
  else if (type === 'weekly') d.setUTCDate(d.getUTCDate() + n * 7);
  else if (type === 'monthly') d.setUTCMonth(d.getUTCMonth() + n);
  else if (type === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + n);
  return d;
}

// Returns the Date occurrences of one event that fall within [rangeStart, rangeEnd].
// Fast-forwards past irrelevant early occurrences instead of walking one at a
// time from the original date, so an old yearly/monthly event viewed much
// later doesn't require hundreds of loop iterations.
function expandRecurrence(event, rangeStart, rangeEnd) {
  const base = new Date(event.event_date);
  const type = event.recurrence_type;
  const interval = Math.max(1, event.recurrence_interval || 1);
  const endLimit = event.recurrence_end_date ? new Date(event.recurrence_end_date) : null;
  if (type === 'none' || !type) {
    return (base >= rangeStart && base <= rangeEnd) ? [base] : [];
  }
  let n = 0;
  if (rangeStart > base) {
    const approxUnitMs = { daily: 86400000, weekly: 604800000, monthly: 2629800000, yearly: 31557600000 }[type];
    n = Math.max(0, Math.floor((rangeStart - base) / (approxUnitMs * interval)) - 2);
  }
  let cursor = addInterval(base, type, n * interval);
  const occurrences = [];
  let guard = 0;
  while (cursor <= rangeEnd && guard < 400) {
    guard++;
    if (endLimit && cursor > endLimit) break;
    if (cursor >= rangeStart && cursor <= rangeEnd) occurrences.push(new Date(cursor));
    cursor = addInterval(cursor, type, interval);
  }
  return occurrences;
}

function calendarEventRowShape(r) {
  return {
    Id: r.id, Title: r.title, Description: r.description, EventDate: r.event_date,
    RecurrenceType: r.recurrence_type, RecurrenceInterval: r.recurrence_interval, RecurrenceEndDate: r.recurrence_end_date,
    WorkOrderId: r.work_order_id, WorkOrderTitle: r.wo_title,
    WorkOrderTaskId: r.work_order_task_id, TaskDescription: r.task_description,
  };
}

// Expands recurring events into their occurrence dates within [fromDate, toDate]
// (YYYY-MM-DD strings). Each returned entry is one occurrence, tagged with its
// concrete Date so the calendar can place it on the right day.
export async function listCalendarEventOccurrences(fromDate, toDate) {
  const { rows } = await pool.query(
    `SELECT e.*, w.title AS wo_title, t.description AS task_description FROM calendar_events e
     LEFT JOIN work_orders w ON w.id = e.work_order_id
     LEFT JOIN work_order_tasks t ON t.id = e.work_order_task_id
     WHERE e.event_date <= $2 AND (e.recurrence_end_date IS NULL OR e.recurrence_end_date >= $1)`,
    [fromDate, toDate]
  );
  const rangeStart = new Date(fromDate);
  const rangeEnd = new Date(toDate);
  const out = [];
  for (const row of rows) {
    const shaped = calendarEventRowShape(row);
    for (const occDate of expandRecurrence(row, rangeStart, rangeEnd)) {
      out.push({ ...shaped, OccurrenceDate: occDate.toISOString().slice(0, 10) });
    }
  }
  return out;
}

export async function getCalendarEvent(id) {
  const { rows } = await pool.query(
    `SELECT e.*, w.title AS wo_title, t.description AS task_description FROM calendar_events e
     LEFT JOIN work_orders w ON w.id = e.work_order_id
     LEFT JOIN work_order_tasks t ON t.id = e.work_order_task_id
     WHERE e.id = $1`,
    [id]
  );
  return rows[0] ? calendarEventRowShape(rows[0]) : null;
}

export async function createCalendarEvent({ title, description, eventDate, recurrenceType, recurrenceInterval, recurrenceEndDate, workOrderId, workOrderTaskId }) {
  const { rows } = await pool.query(
    `INSERT INTO calendar_events (title, description, event_date, recurrence_type, recurrence_interval, recurrence_end_date, work_order_id, work_order_task_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [title, description || null, eventDate, recurrenceType || 'none', recurrenceInterval || 1, recurrenceEndDate || null, workOrderId || null, workOrderTaskId || null]
  );
  await logActivity({ action: 'created', entityType: 'calendar_event', entityId: rows[0].id, entityLabel: rows[0].title });
  return calendarEventRowShape(rows[0]);
}

export async function updateCalendarEvent(id, fields) {
  const allowed = ['title', 'description', 'event_date', 'recurrence_type', 'recurrence_interval', 'recurrence_end_date', 'work_order_id', 'work_order_task_id'];
  const setCols = []; const vals = []; let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    setCols.push(`${key} = $${i++}`);
    vals.push(value === '' ? null : value);
  }
  if (!setCols.length) return getCalendarEvent(id);
  vals.push(id);
  const { rowCount } = await pool.query(`UPDATE calendar_events SET ${setCols.join(', ')} WHERE id = $${i}`, vals);
  if (!rowCount) return null;
  const event = await getCalendarEvent(id);
  await logActivity({ action: 'updated', entityType: 'calendar_event', entityId: Number(id), entityLabel: event?.Title });
  return event;
}

export async function deleteCalendarEvent(id) {
  const { rows } = await pool.query('DELETE FROM calendar_events WHERE id = $1 RETURNING title', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'calendar_event', entityId: Number(id), entityLabel: rows[0].title });
}

// ── Checklists — simple ORDERED steps (no branching, v1 scope). Templates are
//    reusable; instances are live checkable copies attached to one WO or one
//    Calendar Event. ─────────────────────────────────────────────────────────

// Steps accepted for create/update are [{ text, dependsOnIndex, showWhenChecked }]
// — dependsOnIndex is a position within the SAME steps array (not a DB id),
// since a step being newly added in the same save has no id yet. Resolved to
// real depends_on_step_id values in a second pass after insert.
async function writeTemplateSteps(client, templateId, steps) {
  const ids = [];
  for (let i = 0; i < steps.length; i++) {
    const s = typeof steps[i] === 'string' ? { text: steps[i] } : steps[i];
    const { rows } = await client.query(
      'INSERT INTO checklist_template_steps (checklist_template_id, step_text, sort_order, show_when_checked) VALUES ($1,$2,$3,$4) RETURNING id',
      [templateId, s.text, i, s.showWhenChecked !== false]
    );
    ids.push(rows[0].id);
  }
  for (let i = 0; i < steps.length; i++) {
    const s = typeof steps[i] === 'string' ? {} : steps[i];
    if (s.dependsOnIndex != null && ids[s.dependsOnIndex] != null) {
      await client.query('UPDATE checklist_template_steps SET depends_on_step_id = $1 WHERE id = $2', [ids[s.dependsOnIndex], ids[i]]);
    }
  }
}

export async function listChecklistTemplates() {
  const { rows } = await pool.query('SELECT * FROM checklist_templates ORDER BY name');
  const steps = await pool.query('SELECT * FROM checklist_template_steps ORDER BY checklist_template_id, sort_order');
  const byTemplate = new Map();
  for (const s of steps.rows) {
    if (!byTemplate.has(s.checklist_template_id)) byTemplate.set(s.checklist_template_id, []);
    byTemplate.get(s.checklist_template_id).push(s);
  }
  return rows.map((r) => {
    const stepRows = byTemplate.get(r.id) || [];
    const idToIndex = new Map(stepRows.map((s, i) => [s.id, i]));
    return {
      Id: r.id, Name: r.name,
      Steps: stepRows.map((s) => ({
        Text: s.step_text, ShowWhenChecked: s.show_when_checked,
        DependsOnIndex: s.depends_on_step_id != null ? idToIndex.get(s.depends_on_step_id) : null,
      })),
    };
  });
}

export async function createChecklistTemplate({ name, steps = [] }) {
  const client = await pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('INSERT INTO checklist_templates (name) VALUES ($1) RETURNING *', [name]);
    id = rows[0].id;
    await writeTemplateSteps(client, id, steps);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
  const all = await listChecklistTemplates();
  const created = all.find((t) => t.Id === id) || null;
  await logActivity({ action: 'created', entityType: 'checklist_template', entityId: id, entityLabel: name });
  return created;
}

export async function updateChecklistTemplate(id, { name, steps }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (name) await client.query('UPDATE checklist_templates SET name = $2 WHERE id = $1', [id, name]);
    if (steps) {
      await client.query('DELETE FROM checklist_template_steps WHERE checklist_template_id = $1', [id]);
      await writeTemplateSteps(client, id, steps);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
  const all = await listChecklistTemplates();
  const updated = all.find((t) => t.Id === Number(id)) || null;
  if (updated) await logActivity({ action: 'updated', entityType: 'checklist_template', entityId: Number(id), entityLabel: updated.Name });
  return updated;
}

export async function deleteChecklistTemplate(id) {
  const { rows } = await pool.query('DELETE FROM checklist_templates WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'checklist_template', entityId: Number(id), entityLabel: rows[0].name });
}

async function getChecklistInstanceFull(instanceId) {
  const inst = await pool.query('SELECT * FROM checklist_instances WHERE id = $1', [instanceId]);
  if (!inst.rows[0]) return null;
  const steps = await pool.query('SELECT * FROM checklist_instance_steps WHERE checklist_instance_id = $1 ORDER BY sort_order, id', [instanceId]);
  return {
    Id: inst.rows[0].id, Name: inst.rows[0].name,
    WorkOrderId: inst.rows[0].work_order_id, CalendarEventId: inst.rows[0].calendar_event_id,
    Steps: steps.rows.map((s) => ({
      Id: s.id, StepText: s.step_text, Done: s.done, SortOrder: s.sort_order,
      DependsOnInstanceStepId: s.depends_on_instance_step_id, ShowWhenChecked: s.show_when_checked,
    })),
  };
}

export async function getChecklistInstanceForWorkOrder(woId) {
  const { rows } = await pool.query('SELECT id FROM checklist_instances WHERE work_order_id = $1', [woId]);
  return rows[0] ? getChecklistInstanceFull(rows[0].id) : null;
}
export async function getChecklistInstanceForCalendarEvent(eventId) {
  const { rows } = await pool.query('SELECT id FROM checklist_instances WHERE calendar_event_id = $1', [eventId]);
  return rows[0] ? getChecklistInstanceFull(rows[0].id) : null;
}

async function attachChecklist({ templateId, workOrderId, calendarEventId }) {
  const tpl = await pool.query('SELECT * FROM checklist_templates WHERE id = $1', [templateId]);
  if (!tpl.rows[0]) { const err = new Error('Checklist template not found'); err.status = 400; throw err; }
  const stepsRes = await pool.query(
    'SELECT id, step_text, sort_order, depends_on_step_id, show_when_checked FROM checklist_template_steps WHERE checklist_template_id = $1 ORDER BY sort_order',
    [templateId]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO checklist_instances (checklist_template_id, name, work_order_id, calendar_event_id) VALUES ($1,$2,$3,$4) RETURNING id',
      [templateId, tpl.rows[0].name, workOrderId || null, calendarEventId || null]
    );
    const instanceId = rows[0].id;
    const templateIdToInstanceId = new Map(); // maps template_step.id -> new instance_step.id
    for (const s of stepsRes.rows) {
      const { rows: newStep } = await client.query(
        'INSERT INTO checklist_instance_steps (checklist_instance_id, step_text, sort_order, show_when_checked) VALUES ($1,$2,$3,$4) RETURNING id',
        [instanceId, s.step_text, s.sort_order, s.show_when_checked]
      );
      templateIdToInstanceId.set(s.id, newStep[0].id);
    }
    for (const s of stepsRes.rows) {
      if (s.depends_on_step_id != null && templateIdToInstanceId.has(s.depends_on_step_id)) {
        await client.query(
          'UPDATE checklist_instance_steps SET depends_on_instance_step_id = $1 WHERE id = $2',
          [templateIdToInstanceId.get(s.depends_on_step_id), templateIdToInstanceId.get(s.id)]
        );
      }
    }
    await client.query('COMMIT');
    const details = workOrderId ? `On Work Order #${workOrderId}` : calendarEventId ? `On Calendar Event #${calendarEventId}` : undefined;
    await logActivity({ action: 'created', entityType: 'checklist_instance', entityId: instanceId, entityLabel: tpl.rows[0].name, details });
    return getChecklistInstanceFull(instanceId);
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}
export async function attachChecklistToWorkOrder(woId, templateId) { return attachChecklist({ templateId, workOrderId: woId }); }
export async function attachChecklistToCalendarEvent(eventId, templateId) { return attachChecklist({ templateId, calendarEventId: eventId }); }

// For the PDF export route — the instance's steps plus a human label for
// whatever it's attached to (a Work Order or a Calendar Event).
export async function getChecklistInstanceForExport(instanceId) {
  const instance = await getChecklistInstanceFull(instanceId);
  if (!instance) return null;
  let contextLabel = null;
  if (instance.WorkOrderId) {
    const { rows } = await pool.query('SELECT title FROM work_orders WHERE id = $1', [instance.WorkOrderId]);
    if (rows[0]) contextLabel = `Work Order: ${rows[0].title}`;
  } else if (instance.CalendarEventId) {
    const { rows } = await pool.query('SELECT title FROM calendar_events WHERE id = $1', [instance.CalendarEventId]);
    if (rows[0]) contextLabel = `Calendar Event: ${rows[0].title}`;
  }
  return { ...instance, ContextLabel: contextLabel };
}

export async function detachChecklistInstance(instanceId) {
  const { rows } = await pool.query('DELETE FROM checklist_instances WHERE id = $1 RETURNING name, work_order_id, calendar_event_id', [instanceId]);
  if (rows[0]) {
    const details = rows[0].work_order_id ? `From Work Order #${rows[0].work_order_id}` : rows[0].calendar_event_id ? `From Calendar Event #${rows[0].calendar_event_id}` : undefined;
    await logActivity({ action: 'deleted', entityType: 'checklist_instance', entityId: Number(instanceId), entityLabel: rows[0].name, details });
  }
}
export async function toggleChecklistStep(stepId, done) {
  const { rows } = await pool.query(
    'UPDATE checklist_instance_steps SET done = $2, done_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1 RETURNING *',
    [stepId, done]
  );
  if (rows[0]) await logActivity({ action: 'toggled', entityType: 'checklist_step', entityId: rows[0].id, entityLabel: rows[0].step_text, details: done ? 'checked' : 'unchecked' });
  return rows[0] || null;
}

// ── Login accounts (replaces the single APP_USERS env-var pair) ────────────
// password_hash is "salt:derivedKeyHex" from Node's built-in scrypt — no new
// dependency, no plaintext at rest.

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}
function verifyPassword(password, stored) {
  const [salt, hashHex] = (stored || '').split(':');
  if (!salt || !hashHex) return false;
  const storedBuf = Buffer.from(hashHex, 'hex');
  const derivedBuf = crypto.scryptSync(password, salt, storedBuf.length);
  return storedBuf.length === derivedBuf.length && crypto.timingSafeEqual(storedBuf, derivedBuf);
}
function userRowShape(r) {
  return { Id: r.id, Username: r.username, Email: r.email, Active: r.active, Role: r.role };
}

export async function listUsers() {
  const { rows } = await pool.query('SELECT id, username, email, active, role FROM users ORDER BY username');
  return rows.map(userRowShape);
}

export async function countActiveUsers() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE active');
  return rows[0].n;
}

export async function countActiveAdmins() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE active AND role = 'admin'`);
  return rows[0].n;
}

export async function createUser({ username, password, email, role }) {
  const { rows } = await pool.query(
    'INSERT INTO users (username, password_hash, email, role) VALUES ($1,$2,$3,$4) RETURNING id, username, email, active, role',
    [username, hashPassword(password), email || null, role === 'admin' ? 'admin' : 'standard']
  );
  await logActivity({ action: 'created', entityType: 'user', entityId: rows[0].id, entityLabel: rows[0].username });
  return userRowShape(rows[0]);
}

export async function updateUser(id, { email, password, active, role }) {
  const sets = []; const vals = []; let i = 1;
  if (email !== undefined) { sets.push(`email = $${i++}`); vals.push(email || null); }
  if (password) { sets.push(`password_hash = $${i++}`); vals.push(hashPassword(password)); }
  if (active !== undefined) { sets.push(`active = $${i++}`); vals.push(active); }
  if (role !== undefined) { sets.push(`role = $${i++}`); vals.push(role === 'admin' ? 'admin' : 'standard'); }
  if (!sets.length) {
    const { rows } = await pool.query('SELECT id, username, email, active, role FROM users WHERE id = $1', [id]);
    return rows[0] ? userRowShape(rows[0]) : null;
  }
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, username, email, active, role`,
    vals
  );
  if (rows[0]) {
    // Never log the password itself — just note that a reset happened.
    const notes = [
      password ? 'password reset' : null,
      active === false ? 'deactivated' : active === true ? 'reactivated' : null,
      role !== undefined ? `role → ${rows[0].role}` : null,
    ].filter(Boolean);
    await logActivity({ action: 'updated', entityType: 'user', entityId: rows[0].id, entityLabel: rows[0].username, details: notes.join(', ') || undefined });
  }
  return rows[0] ? userRowShape(rows[0]) : null;
}

export async function deleteUser(id) {
  const { rows } = await pool.query('DELETE FROM users WHERE id = $1 RETURNING username', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'user', entityId: Number(id), entityLabel: rows[0].username });
}

export async function verifyUserCredentials(username, password) {
  const { rows } = await pool.query('SELECT id, username, password_hash, active, role FROM users WHERE username = $1', [username]);
  const u = rows[0];
  if (!u || !u.active) return null;
  if (!verifyPassword(password, u.password_hash)) return null;
  return { Id: u.id, Username: u.username, Role: u.role };
}

// ── Maintenance Request Portal ──────────────────────────────────────────
// Public submissions land here, never as Work Orders — see migration 0021.
// Field configurability mirrors asset_property_fields (0005): a request field
// with column_name set writes a real column on maintenance_requests; one with
// column_name null is EAV-backed in maintenance_request_field_values. Mailing
// is intentionally NOT done in this module (same boundary discipline as
// storage.js for Spaces) — routes call mailer.js themselves and log the
// result via createRequestMessage.

function requestRowShape(r) {
  return {
    Id: r.id, Status: r.status,
    RequesterName: r.requester_name, RequesterEmail: r.requester_email, RequesterPhone: r.requester_phone,
    LocationId: r.location_id, LocationName: r.location_name ?? null,
    AssetId: r.asset_id, AssetName: r.asset_name ?? null,
    Priority: r.priority, Description: r.description,
    PublicToken: r.public_token, WorkOrderId: r.work_order_id, WorkOrderTitle: r.work_order_title ?? null,
    ReviewedBy: r.reviewed_by, ReviewedAt: r.reviewed_at, ReviewNote: r.review_note,
    CreatedAt: r.created_at, UpdatedAt: r.updated_at,
  };
}

// Active fields only — what the public form renders.
export async function getRequestFormFields() {
  const { rows } = await pool.query(
    `SELECT field_key, label, input_type, options, required, help_text, column_name
     FROM maintenance_request_fields WHERE active ORDER BY sort_order`
  );
  return rows.map((r) => ({
    fieldKey: r.field_key, label: r.label, inputType: r.input_type,
    options: r.options, required: r.required, helpText: r.help_text, columnName: r.column_name,
  }));
}

export async function adminListRequestFields() {
  const { rows } = await pool.query(
    `SELECT id, field_key, label, input_type, options, required, active, sort_order, help_text, column_name
     FROM maintenance_request_fields ORDER BY sort_order`
  );
  return rows;
}

export async function adminCreateRequestField({ fieldKey, label, inputType, options = [], required = false, sortOrder = 100, helpText }) {
  const { rows } = await pool.query(
    `INSERT INTO maintenance_request_fields (field_key, label, input_type, options, required, sort_order, help_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [fieldKey, label, inputType, options, required, sortOrder, helpText || null]
  );
  await logActivity({ action: 'created', entityType: 'request_field', entityId: rows[0].id, entityLabel: rows[0].label });
  return rows[0];
}

export async function adminUpdateRequestField(id, { label, options, required, active, sortOrder, helpText }) {
  const { rows } = await pool.query(
    `UPDATE maintenance_request_fields SET
       label = COALESCE($2, label), options = COALESCE($3, options),
       required = COALESCE($4, required), active = COALESCE($5, active),
       sort_order = COALESCE($6, sort_order), help_text = COALESCE($7, help_text)
     WHERE id = $1 RETURNING *`,
    [id, label ?? null, options ?? null, required ?? null, active ?? null, sortOrder ?? null, helpText ?? null]
  );
  if (rows[0]) {
    await logActivity({
      action: active === false ? 'deactivated' : active === true ? 'reactivated' : 'updated',
      entityType: 'request_field', entityId: rows[0].id, entityLabel: rows[0].label,
    });
  }
  return rows[0] || null;
}

const REQUEST_CORE_COLUMNS = new Set(['requester_name', 'requester_email', 'requester_phone', 'location_id', 'priority', 'description']);

// values: { [fieldKey]: string | string[] }. Unknown/inactive field keys are
// silently ignored — validated against the LIVE active-field catalog, not
// whatever the client happened to submit.
export async function createMaintenanceRequest({ values = {}, photoUrls = [] }) {
  const fields = await getRequestFormFields();
  const missing = fields.filter((f) => f.required && !String(values[f.fieldKey] ?? '').trim());
  if (missing.length) {
    const err = new Error(`Missing required field(s): ${missing.map((f) => f.label).join(', ')}`);
    err.status = 400;
    throw err;
  }

  const core = { requester_name: null, requester_email: null, requester_phone: null, location_id: null, priority: null, description: null };
  const extra = [];
  for (const f of fields) {
    const raw = values[f.fieldKey];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Array.isArray(raw) ? raw.join(', ') : String(raw);
    if (f.columnName && REQUEST_CORE_COLUMNS.has(f.columnName)) {
      core[f.columnName] = f.columnName === 'location_id' ? (Number(value) || null) : value;
    } else if (!f.columnName) {
      extra.push({ fieldKey: f.fieldKey, value });
    }
  }
  if (!core.requester_email) {
    const err = new Error('An email address is required so we can respond.');
    err.status = 400;
    throw err;
  }

  const token = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO maintenance_requests
         (requester_name, requester_email, requester_phone, location_id, priority, description, public_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [core.requester_name, core.requester_email, core.requester_phone, core.location_id, core.priority, core.description, token]
    );
    const request = rows[0];
    for (const e of extra) {
      await client.query(
        `INSERT INTO maintenance_request_field_values (request_id, field_key, value) VALUES ($1,$2,$3)`,
        [request.id, e.fieldKey, e.value]
      );
    }
    for (const url of photoUrls) {
      await client.query(`INSERT INTO maintenance_request_photos (request_id, photo_url) VALUES ($1,$2)`, [request.id, url]);
    }
    await client.query('COMMIT');
    await logActivity({
      action: 'created', entityType: 'maintenance_request', entityId: request.id,
      entityLabel: core.requester_name || core.requester_email,
      details: core.description ? core.description.slice(0, 120) : undefined,
    });
    return requestRowShape(request);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listMaintenanceRequests({ status } = {}) {
  const params = [];
  let where = '';
  if (status) { params.push(status); where = 'WHERE r.status = $1'; }
  const { rows } = await pool.query(
    `SELECT r.*, l.name AS location_name, a.name AS asset_name
     FROM maintenance_requests r
     LEFT JOIN locations l ON l.id = r.location_id
     LEFT JOIN assets a ON a.id = r.asset_id
     ${where}
     ORDER BY r.created_at DESC`,
    params
  );
  return rows.map(requestRowShape);
}

export async function getMaintenanceRequestDetail(id) {
  const { rows } = await pool.query(
    `SELECT r.*, l.name AS location_name, a.name AS asset_name, w.title AS work_order_title
     FROM maintenance_requests r
     LEFT JOIN locations l ON l.id = r.location_id
     LEFT JOIN assets a ON a.id = r.asset_id
     LEFT JOIN work_orders w ON w.id = r.work_order_id
     WHERE r.id = $1`,
    [id]
  );
  if (!rows[0]) return null;
  const request = requestRowShape(rows[0]);

  const fieldDefs = await adminListRequestFields(); // include inactive — old values may reference a since-retired field
  const fieldByKey = new Map(fieldDefs.map((f) => [f.field_key, f]));
  const { rows: valueRows } = await pool.query(
    `SELECT field_key, value FROM maintenance_request_field_values WHERE request_id = $1`, [id]
  );
  request.CustomFields = valueRows.map((v) => ({
    fieldKey: v.field_key, label: fieldByKey.get(v.field_key)?.label || v.field_key, value: v.value,
  }));

  const { rows: photoRows } = await pool.query(
    `SELECT id, photo_url, created_at FROM maintenance_request_photos WHERE request_id = $1 ORDER BY id`, [id]
  );
  request.Photos = photoRows.map((p) => ({ Id: p.id, Url: p.photo_url, CreatedAt: p.created_at }));

  return request;
}

export async function listRequestMessages(requestId) {
  const { rows } = await pool.query(
    `SELECT id, subject, body, to_email, sent_by, status, error, created_at
     FROM maintenance_request_messages WHERE request_id = $1 ORDER BY created_at`,
    [requestId]
  );
  return rows.map((m) => ({
    Id: m.id, Subject: m.subject, Body: m.body, ToEmail: m.to_email,
    SentBy: m.sent_by, Status: m.status, Error: m.error, CreatedAt: m.created_at,
  }));
}

// Logs an email the caller already attempted to send (or failed to). Never
// throws on its own — a logging hiccup shouldn't mask the original send result.
export async function createRequestMessage(requestId, { subject, body, toEmail, sentBy, status = 'sent', error = null }) {
  const { rows } = await pool.query(
    `INSERT INTO maintenance_request_messages (request_id, subject, body, to_email, sent_by, status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [requestId, subject, body, toEmail, sentBy, status, error]
  );
  await logActivity({
    action: 'sent', entityType: 'maintenance_request_message', entityId: rows[0].id, entityLabel: subject,
    details: `To ${toEmail}, on Request #${requestId}${status === 'failed' ? ' (FAILED)' : ''}`,
  });
  return rows[0];
}

export async function updateMaintenanceRequestStatus(id, { status, reviewNote }) {
  const { rows } = await pool.query(
    `UPDATE maintenance_requests SET
       status = COALESCE($2, status), review_note = COALESCE($3, review_note),
       reviewed_by = $4, reviewed_at = now()
     WHERE id = $1 RETURNING *`,
    [id, status ?? null, reviewNote ?? null, currentUsername()]
  );
  if (rows[0]) {
    await logActivity({
      action: 'updated', entityType: 'maintenance_request', entityId: rows[0].id,
      entityLabel: rows[0].requester_name || rows[0].requester_email,
      details: status ? `status → ${status}` : 'review note updated',
    });
  }
  return rows[0] ? requestRowShape(rows[0]) : null;
}

export async function linkRequestToAsset(id, assetId) {
  const { rows } = await pool.query(
    `UPDATE maintenance_requests SET asset_id = $2 WHERE id = $1 RETURNING *`,
    [id, assetId || null]
  );
  return rows[0] ? requestRowShape(rows[0]) : null;
}

// Deliberate, explicit action — never automatic. Creates a real Work Order
// pre-filled from the request, and marks the request converted + linked.
export async function convertRequestToWorkOrder(id, { scheduledDate } = {}) {
  const { rows } = await pool.query(`SELECT * FROM maintenance_requests WHERE id = $1`, [id]);
  const request = rows[0];
  if (!request) return null;
  if (request.work_order_id) {
    const err = new Error('This request has already been converted to a Work Order');
    err.status = 400;
    throw err;
  }
  const title = `Request #${request.id}: ${(request.description || 'Maintenance request').slice(0, 80)}`;
  const wo = await createWorkOrder({
    title, assetId: request.asset_id, locationId: request.location_id,
    priority: request.priority || 'Medium', description: request.description, scheduledDate,
  });
  const { rows: updated } = await pool.query(
    `UPDATE maintenance_requests SET status = 'converted', work_order_id = $2, reviewed_by = $3, reviewed_at = now()
     WHERE id = $1 RETURNING *`,
    [id, wo.workOrderId, currentUsername()]
  );
  await logActivity({
    action: 'converted', entityType: 'maintenance_request', entityId: id,
    entityLabel: request.requester_name || request.requester_email, details: `→ Work Order #${wo.workOrderId}`,
  });
  return { request: requestRowShape(updated[0]), workOrderId: wo.workOrderId };
}
