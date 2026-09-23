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
    CabinHolderId: a.cabin_holder_id ?? null,
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
    pool.query(
      `SELECT w.id, w.title, ws.name AS status, ws.color AS status_color, w.priority
       FROM work_orders w JOIN work_order_statuses ws ON ws.id = w.status_id
       WHERE w.asset_id = $1 ORDER BY w.id DESC LIMIT 200`,
      [assetId]
    ),
    pool.query(
      `SELECT id, title, severity, status, board_focus, deferred_reason, revisit_date, dismiss_note
       FROM condition_findings WHERE asset_id = $1 ORDER BY id DESC LIMIT 200`,
      [assetId]
    ),
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
    workOrders: workOrders.rows.map((r) => ({ Id: r.id, Title: r.title, Status: r.status, StatusColor: r.status_color, Priority: r.priority })),
    conditionFindings: findings.rows.map((r) => ({
      Id: r.id, Title: r.title, Severity: r.severity, Status: r.status, BoardFocus: r.board_focus,
      DeferredReason: r.deferred_reason, RevisitDate: r.revisit_date, DismissNote: r.dismiss_note,
    })),
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

export async function submitAudit(assetId, { properties = {}, componentEvents = [], finding = null, generalAttachmentIds = [] }) {
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
           observed_installed_date, est_life_years, est_replacement_cost, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [assetId, ev.componentType, ev.subArea || null, eventType, ev.material || null, condition,
          observedDate, ev.estLifeYears ?? null, ev.estReplacementCost ?? null, ev.notes || null]
      );
      createdComponents.push(componentRowToNocoShape(rows[0]));
      // Classification pre-fills from the component's own type — the one
      // case in this phase where the guess is always right, since it's not a
      // guess (§4.4: "attaching to a component event whose type is known
      // pre-fills classification").
      for (const attachmentId of ev.attachmentIds || []) {
        await linkAttachment(attachmentId, { entityType: 'asset_component', entityId: rows[0].id, classification: ev.componentType }, client);
      }
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
           estimated_hours, estimated_cost, status, date_identified, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Open',$8,$9) RETURNING *`,
        [assetId, finding.title || `Finding on Asset #${assetId}`, finding.severity, finding.description,
          finding.recommendedRepair || null, finding.estimatedHours ?? null, finding.estimatedCost ?? null, today, username]
      );
      createdFinding = rows[0];
      for (const attachmentId of finding.attachmentIds || []) {
        await linkAttachment(attachmentId, { entityType: 'condition_finding', entityId: createdFinding.id }, client);
      }
    }

    for (const attachmentId of generalAttachmentIds) {
      await linkAttachment(attachmentId, { entityType: 'asset', entityId: assetId }, client);
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

// Crew-session hours attributed to one job line, pre-aggregated to a single
// row per job_line_id BEFORE it's ever joined to job_lines — a line can have
// several sessions, so joining the raw crew_sessions table directly would
// fan out job_lines rows and inflate every other SUM() alongside it. Reused
// everywhere a job line's "actual hours" needs to reflect logged crew time,
// not just what was hand-typed into the Actual Hours field (migration 0036's
// intent — "Line actual hours = sum of crew_sessions.hours where job_line_id
// matches" — which nothing had actually implemented until Build Brief v2.1
// Part 2's rollup verification caught the gap: a crew session never moved
// any actual_hours total by a single hour before this).
const JOB_LINE_SESSION_HOURS_SQL = `
  SELECT job_line_id, SUM(hours) AS session_hours
  FROM crew_sessions WHERE job_line_id IS NOT NULL AND hours IS NOT NULL
  GROUP BY job_line_id
`;

// Build Brief v3 Part 5: actual_cost becomes a rollup of linked expenses,
// exactly as actual_hours rolls up crew_sessions above — same pre-aggregate-
// before-joining shape, for the same fan-out reason (a line can have several
// expenses). Manual override stays available: jl.actual_cost is still a
// plain hand-typed column (for a vendor invoice paid directly, donated
// materials valued, anything with no receipt), and this only ADDS linked
// expense totals on top — never replaces it. Every call site below joins
// this alongside JOB_LINE_SESSION_HOURS_SQL wherever a line's actual cost is
// presented as a rollup/total; the job-line EDIT FORM's Actual Cost input
// deliberately stays on the raw column (jobLineRowShape/hydrateJobLine) —
// same reasoning as the Actual Hours input, see its comment.
// Reads allocations (0078), not expenses.job_line_id — a split receipt contributes
// only its share to each line, which the old single pointer could not express. The
// triage/deleted filters stay on the expense: a voided receipt allocates nothing.
const JOB_LINE_EXPENSE_COST_SQL = `
  SELECT ea.dest_id AS job_line_id, SUM(ea.amount) AS expense_cost
  FROM expense_allocations ea
  JOIN expenses e ON e.id = ea.expense_id
  WHERE ea.dest_type = 'job_line' AND e.triage_status != 'void' AND e.deleted_at IS NULL
  GROUP BY ea.dest_id
`;
// NULL only when there's truly nothing recorded either way, so an
// untouched line still reads as "—" instead of a misleading $0 — same
// null-preservation the raw column already had before this rollup existed.
const JOB_LINE_ACTUAL_COST_EXPR = `(CASE WHEN jl.actual_cost IS NULL AND ec.expense_cost IS NULL THEN NULL
    ELSE COALESCE(jl.actual_cost,0) + COALESCE(ec.expense_cost,0) END)`;

// A job line's contribution to a forward-looking budget total: $0 once the
// LINE itself (not its work order — a WO can stay open with other lines
// still going while this one is long since decided) reaches a terminal
// status that isn't counts_as_work_performed (Not Needed/Cancelled — nothing
// was spent and nothing remains owed), otherwise its realized actual cost
// (manual + linked expenses) if known, else its estimate (not yet realized,
// still pending). Requires job_line_statuses joined as `jls` alongside
// whatever JOB_LINE_ACTUAL_COST_EXPR itself requires (`ec`).
const JOB_LINE_COMMITTED_COST_EXPR = `(CASE WHEN jls.is_terminal AND NOT jls.counts_as_work_performed THEN 0
    ELSE COALESCE(${JOB_LINE_ACTUAL_COST_EXPR}, jl.estimated_cost, 0) END)`;

// Shared rollup subquery: every work order's job lines summed into one row
// (hours/cost totals, line count, earliest scheduled date, distinct
// responsibility classes present). Embedded via LEFT JOIN everywhere a list
// of work orders needs its lines' totals without an N+1 query per row — see
// workOrderRollup() below for the single-WO, richer version (with per-
// funding-source breakdown) the WO detail page needs.
//
// actual_hours = SUM(job_lines.actual_hours) [hand-typed] + attributed
// session hours + unattributed (job_line_id IS NULL) session hours on this
// WO — genuine WO-level time (e.g. general site cleanup on a multi-line WO)
// has nowhere to live on any one job line, so it's added once at the WO
// level here rather than per line (see JOB_LINE_SESSION_HOURS_SQL's comment
// and migration 0036). The inner subquery pre-aggregates per line first so
// the outer LEFT JOIN to unattributed WO-level hours can't fan out the
// per-line SUMs above it.
const JOB_LINE_ROLLUP_SQL = `
  SELECT jl_agg.work_order_id, jl_agg.line_count, jl_agg.estimated_hours,
    jl_agg.actual_hours + COALESCE(unattr.hours, 0) AS actual_hours,
    jl_agg.estimated_cost, jl_agg.actual_cost, jl_agg.earliest_scheduled_date,
    jl_agg.responsibility_classes, jl_agg.funding_sources
  FROM (
    SELECT jl.work_order_id,
      COUNT(*) AS line_count,
      COALESCE(SUM(jl.estimated_hours), 0) AS estimated_hours,
      COALESCE(SUM(jl.actual_hours), 0) + COALESCE(SUM(lh.session_hours), 0) AS actual_hours,
      COALESCE(SUM(jl.estimated_cost), 0) AS estimated_cost,
      COALESCE(SUM(jl.actual_cost), 0) + COALESCE(SUM(ec.expense_cost), 0) AS actual_cost,
      MIN(jl.scheduled_date) AS earliest_scheduled_date,
      COALESCE(ARRAY_AGG(DISTINCT jl.responsibility_class), '{}') AS responsibility_classes,
      COALESCE(ARRAY_AGG(DISTINCT jl.funding_source), '{}') AS funding_sources
    FROM job_lines jl
    LEFT JOIN (${JOB_LINE_SESSION_HOURS_SQL}) lh ON lh.job_line_id = jl.id
    LEFT JOIN (${JOB_LINE_EXPENSE_COST_SQL}) ec ON ec.job_line_id = jl.id
    GROUP BY jl.work_order_id
  ) jl_agg
  LEFT JOIN (
    SELECT work_order_id, SUM(hours) AS hours FROM crew_sessions
    WHERE job_line_id IS NULL AND hours IS NOT NULL GROUP BY work_order_id
  ) unattr ON unattr.work_order_id = jl_agg.work_order_id
`;

export async function getWorkOrdersReportRawData() {
  const [woRows, volRows, venRows] = await Promise.all([
    pool.query(
      `SELECT w.id, w.title, ws.name AS status, w.priority, w.date_reported, w.date_completed,
              jl.earliest_scheduled_date AS scheduled_date,
              jl.estimated_hours, jl.estimated_cost, jl.actual_hours, jl.actual_cost,
              jl.funding_sources, jl.responsibility_classes,
              a.name AS asset_name, l.name AS location_name
       FROM work_orders w
       JOIN work_order_statuses ws ON ws.id = w.status_id
       LEFT JOIN assets a ON a.id = w.asset_id
       LEFT JOIN locations l ON l.id = w.location_id
       LEFT JOIN (${JOB_LINE_ROLLUP_SQL}) jl ON jl.work_order_id = w.id
       ORDER BY w.id DESC`
    ),
    pool.query(
      `SELECT jl.work_order_id, v.name FROM job_line_volunteers jlv
       JOIN job_lines jl ON jl.id = jlv.job_line_id JOIN volunteers v ON v.id = jlv.volunteer_id`
    ),
    pool.query(
      `SELECT jl.work_order_id, vd.name FROM job_line_vendors jlv
       JOIN job_lines jl ON jl.id = jlv.job_line_id JOIN vendors vd ON vd.id = jlv.vendor_id`
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

// Build Brief v2 Phase 6 (§6.1) — job lines as a first-class report source,
// not a sub-detail of work orders. quote_count backs the "Quotes received"
// column (§6.4) — shopping discipline visible across every job at once.
export async function getJobLinesReportRawData() {
  const { rows } = await pool.query(`
    SELECT jl.id, jl.title, jl.complaint, jl.correction, jl.responsibility_class, jl.funding_source,
           jl.estimated_hours, COALESCE(jl.actual_hours, 0) + COALESCE(lh.session_hours, 0) AS actual_hours,
           jl.estimated_cost, ${JOB_LINE_ACTUAL_COST_EXPR} AS actual_cost, jl.scheduled_date, jl.completed_date,
           jls.name AS status, jls.counts_as_work_performed,
           w.id AS work_order_id, w.wo_number, w.title AS wo_title,
           a.name AS asset_name, l.name AS location_name, pr.name AS project_name,
           (SELECT count(*) FROM attachment_links al2 JOIN attachment_roles ar2 ON ar2.id = al2.role_id
            WHERE al2.entity_type = 'job_line' AND al2.entity_id = jl.id AND ar2.name = 'Quote') AS quote_count
    FROM job_lines jl
    JOIN job_line_statuses jls ON jls.id = jl.status_id
    JOIN work_orders w ON w.id = jl.work_order_id
    LEFT JOIN assets a ON a.id = w.asset_id
    LEFT JOIN locations l ON l.id = w.location_id
    LEFT JOIN projects pr ON pr.id = w.project_id
    LEFT JOIN (${JOB_LINE_SESSION_HOURS_SQL}) lh ON lh.job_line_id = jl.id
    LEFT JOIN (${JOB_LINE_EXPENSE_COST_SQL}) ec ON ec.job_line_id = jl.id
    ORDER BY jl.id DESC`
  );
  const [causeRows, volRows, venRows] = await Promise.all([
    pool.query(`SELECT jlc.job_line_id, c.name FROM job_line_causes jlc JOIN causes c ON c.id = jlc.cause_id`),
    pool.query(`SELECT jlv.job_line_id, v.name FROM job_line_volunteers jlv JOIN volunteers v ON v.id = jlv.volunteer_id`),
    pool.query(`SELECT jlv.job_line_id, vd.name FROM job_line_vendors jlv JOIN vendors vd ON vd.id = jlv.vendor_id`),
  ]);
  const groupBy = (list, keyField) => { const m = new Map(); for (const r of list) { if (!m.has(r[keyField])) m.set(r[keyField], []); m.get(r[keyField]).push(r.name); } return m; };
  return {
    jobLines: rows,
    causesByLine: groupBy(causeRows.rows, 'job_line_id'),
    volByLine: groupBy(volRows.rows, 'job_line_id'),
    venByLine: groupBy(venRows.rows, 'job_line_id'),
  };
}

// Findings as a first-class report source — covers "Open Findings Not On
// Any Work Order" (§6.2.4) as a filter on OnWorkOrder=No rather than a
// bespoke report, since it needs no grouping/totals beyond a list.
export async function getFindingsReportRawData() {
  const { rows } = await pool.query(`
    SELECT cf.id, cf.title, cf.severity, cf.status, cf.description, cf.estimated_cost, cf.date_identified,
           cf.deferred_reason, cf.revisit_date, cf.dismiss_note, cf.board_focus,
           a.name AS asset_name, COALESCE(l.name, al.name) AS location_name,
           EXISTS (SELECT 1 FROM job_lines jl WHERE jl.condition_finding_id = cf.id) AS on_work_order
    FROM condition_findings cf
    LEFT JOIN assets a ON a.id = cf.asset_id
    LEFT JOIN locations l ON l.id = cf.location_id
    LEFT JOIN locations al ON al.id = a.location_id
    ORDER BY cf.id DESC`
  );
  return { findings: rows };
}

// ── Named reports (Build Brief v2 Phase 6, §6.2) ────────────────────────────

// Images only, capped per work order (§6.3) — documents link, never embed.
// Auto-selected by role priority (a role's own sort_order, so "Before/After"
// naturally sorts ahead of "Reference") then link sort_order/upload time.
// Brief also asks for a manual reselect-when-over-cap step in the UI; not
// built this phase (no real photo data existed to validate a picker
// against) — see update-for-claude.md's Phase 6 runbook.
async function getReportImagesForJobLines(jobLineIds, jobLineToWoMap, cap) {
  const byWo = new Map();
  if (!jobLineIds.length) return byWo;
  const { rows } = await pool.query(
    `SELECT al.entity_id AS job_line_id, a.id, a.url, a.thumb_url, a.caption, ar.sort_order AS role_sort, al.sort_order, al.created_at
     FROM attachment_links al
     JOIN attachments a ON a.id = al.attachment_id AND a.deleted_at IS NULL AND a.kind = 'image'
     LEFT JOIN attachment_roles ar ON ar.id = al.role_id
     WHERE al.entity_type = 'job_line' AND al.entity_id = ANY($1::int[]) AND al.include_in_report
     ORDER BY COALESCE(ar.sort_order, 999), al.sort_order, al.created_at`,
    [jobLineIds]
  );
  for (const r of rows) {
    const woId = jobLineToWoMap.get(r.job_line_id);
    if (woId == null) continue;
    if (!byWo.has(woId)) byWo.set(woId, []);
    const list = byWo.get(woId);
    if (list.length < cap) list.push({ Id: r.id, Url: r.url, ThumbUrl: r.thumb_url, Caption: r.caption });
  }
  return byWo;
}

// "Work Performed in a Date Range" (§6.2.1) — job lines with
// counts_as_work_performed=true and a completed_date in range, REGARDLESS of
// the parent WO's status. This is deliberate and is the whole reason job
// lines report independently: it proves six months of activity while half
// the big multi-line jobs are legitimately still open.
export async function getWorkPerformedRawData({ from, to }) {
  const { rows } = await pool.query(
    `SELECT jl.id, jl.title, jl.correction, jl.completed_date, ${JOB_LINE_ACTUAL_COST_EXPR} AS actual_cost, jl.estimated_cost,
            COALESCE(jl.actual_hours, 0) + COALESCE(lh.session_hours, 0) AS actual_hours,
            w.id AS work_order_id, w.wo_number, w.title AS wo_title,
            a.name AS asset_name, COALESCE(l.name, al.name) AS location_name
     FROM job_lines jl
     JOIN job_line_statuses jls ON jls.id = jl.status_id
     JOIN work_orders w ON w.id = jl.work_order_id
     LEFT JOIN assets a ON a.id = w.asset_id
     LEFT JOIN locations l ON l.id = w.location_id
     LEFT JOIN locations al ON al.id = a.location_id
     LEFT JOIN (${JOB_LINE_SESSION_HOURS_SQL}) lh ON lh.job_line_id = jl.id
     LEFT JOIN (${JOB_LINE_EXPENSE_COST_SQL}) ec ON ec.job_line_id = jl.id
     WHERE jls.counts_as_work_performed AND jl.completed_date BETWEEN $1 AND $2
     ORDER BY COALESCE(l.name, al.name) NULLS LAST, w.id, jl.sort_order`,
    [from, to]
  );
  const { ReportImageCap } = await getDisplaySettings();
  const jobLineToWoMap = new Map(rows.map((r) => [r.id, r.work_order_id]));
  const imagesByWo = await getReportImagesForJobLines(rows.map((r) => r.id), jobLineToWoMap, ReportImageCap);
  return { lines: rows, imagesByWo };
}

// "Deferred Maintenance Backlog" (§6.2.2) — likely the single most useful
// artifact this system produces (the brief's own words): every deferred
// finding, grouped by severity, with dollar totals. The capital-campaign
// argument, built as a named report rather than assembled from filters
// because the grouping/totals are the point.
export async function getDeferredFindingsBacklogRawData() {
  const { rows } = await pool.query(
    `SELECT cf.id, cf.title, cf.severity, cf.estimated_cost, cf.deferred_reason, cf.revisit_date,
            a.name AS asset_name, COALESCE(l.name, al.name) AS location_name
     FROM condition_findings cf
     LEFT JOIN assets a ON a.id = cf.asset_id
     LEFT JOIN locations l ON l.id = cf.location_id
     LEFT JOIN locations al ON al.id = a.location_id
     WHERE cf.status = 'Deferred'
     ORDER BY cf.severity DESC, cf.estimated_cost DESC NULLS LAST`
  );
  return { findings: rows };
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
    `SELECT id, note, resolved, created_by, created_at FROM asset_notes
     WHERE asset_id = $1 ORDER BY created_at DESC`,
    [assetId]
  );
  const attachments = await listAttachmentsForEntities('asset_note', rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, attachments: attachments.get(r.id) || [] }));
}

export async function createAssetNote(assetId, { note, attachmentIds = [], createdBy = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO asset_notes (asset_id, note, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [assetId, note, createdBy]
    );
    for (const attachmentId of attachmentIds) {
      await linkAttachment(attachmentId, { entityType: 'asset_note', entityId: rows[0].id }, client);
    }
    await client.query('COMMIT');
    await logActivity({ action: 'created', entityType: 'asset_note', entityId: rows[0].id, entityLabel: note, details: `On asset #${assetId}` });
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function resolveAssetNote(noteId, resolved = true) {
  const { rows } = await pool.query(
    `UPDATE asset_notes SET resolved = $1 WHERE id = $2 RETURNING *`,
    [resolved, noteId]
  );
  if (rows[0]) await logActivity({ action: 'toggled', entityType: 'asset_note', entityId: rows[0].id, entityLabel: rows[0].note, details: resolved ? 'resolved' : 'reopened' });
  return rows[0] || null;
}

// ── Notes scratchpad — standalone, user-categorized notes (not tied to an
//    asset). Categories are whatever text the user types, same free-tagging
//    approach as map layers, so new categories never need a code change. ──

export async function listNotes() {
  const { rows } = await pool.query('SELECT * FROM notes ORDER BY done ASC, updated_at DESC');
  return rows;
}

export async function createNote({ title, body = null, category = 'General' }) {
  const { rows } = await pool.query(
    `INSERT INTO notes (title, body, category, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [title, body, category || 'General', currentUsername()]
  );
  await logActivity({ action: 'created', entityType: 'note', entityId: rows[0].id, entityLabel: title, details: category });
  return rows[0];
}

export async function updateNote(id, { title, body, category, done }) {
  const sets = ['updated_at = now()'];
  const vals = [];
  let i = 1;
  if (title !== undefined) { sets.push(`title = $${i++}`); vals.push(title); }
  if (body !== undefined) { sets.push(`body = $${i++}`); vals.push(body); }
  if (category !== undefined) { sets.push(`category = $${i++}`); vals.push(category || 'General'); }
  if (done !== undefined) { sets.push(`done = $${i++}`); vals.push(!!done); }
  vals.push(id);
  const { rows } = await pool.query(`UPDATE notes SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
  return rows[0] || null;
}

export async function deleteNote(id) {
  const { rows } = await pool.query('DELETE FROM notes WHERE id = $1 RETURNING title', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'note', entityId: id, entityLabel: rows[0].title });
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
  const inUse = await pool.query(`SELECT count(*) FROM job_lines WHERE funding_source = 'capital_campaign' AND funding_ref_id = $1`, [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} job line(s) still reference this project — reassign them first`); e.status = 400; throw e; }
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
  const inUse = await pool.query(`SELECT count(*) FROM job_lines WHERE funding_source = 'other' AND funding_ref_id = $1`, [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} job line(s) still reference this category — reassign them first`); e.status = 400; throw e; }
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
  // Now that assets.cabin_holder_id exists (0085), the same sync maintains it: a
  // lodge_holder typed today gets its key on the next read, so the FK never falls
  // behind the text it was derived from. Exactly one match or nothing — a name
  // matching two holders is ambiguous, and guessing would attach a cabin to the wrong
  // person silently.
  await pool.query(`
    UPDATE assets a
    SET cabin_holder_id = m.holder_id
    FROM (
      SELECT a2.id AS asset_id, min(ch.id) AS holder_id
      FROM assets a2
      JOIN cabin_holders ch ON lower(trim(ch.name)) = lower(trim(a2.lodge_holder))
      WHERE a2.lodge_holder IS NOT NULL AND trim(a2.lodge_holder) <> ''
      GROUP BY a2.id
      HAVING count(ch.id) = 1
    ) m
    WHERE a.id = m.asset_id
      AND (a.cabin_holder_id IS NULL OR a.cabin_holder_id <> m.holder_id)
  `);
}

export async function listCabinHolders() {
  await syncCabinHoldersFromAssets();
  const { rows } = await pool.query(`
    SELECT ch.id, ch.name, ch.notes AS description,
      COALESCE(json_agg(json_build_object('Id', a.id, 'Name', a.name)) FILTER (WHERE a.id IS NOT NULL), '[]') AS linked_assets
    FROM cabin_holders ch
    LEFT JOIN assets a ON a.cabin_holder_id = ch.id
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
  const inUse = await pool.query(`SELECT count(*) FROM job_lines WHERE funding_source = 'cabin_holder' AND funding_ref_id = $1`, [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} job line(s) still reference this cabin-holder — reassign them first`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM cabin_holders WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'cabin_holder', entityId: Number(id), entityLabel: rows[0].name });
}

// The whole "Budget" section of Capital Plan in one call: operating-budget
// years-to-cover, and itemized-with-rollup views for each funding source.
export async function getBudgetOverview() {
  const settings = await getBudgetSettings();

  // Cost per job line is JOB_LINE_COMMITTED_COST_EXPR — same rule as
  // everywhere else (see its header comment). Grouping by job line, not
  // work order, is the point of Phase 1: one WO can have lines against
  // three different funding sources, and — the bug this used to have — a
  // line's own done/not-done state is not its work order's: a WO can stay
  // open (other lines still going) long after one particular line finished,
  // and this used to key pending-vs-done off ws.is_terminal (the WORK
  // ORDER's status) instead of jls.is_terminal (the LINE's own status),
  // so a completed line sitting in a still-open WO was counted as pending
  // spend that hadn't happened yet, and a Not Needed/Cancelled line's
  // estimate was counted as spend at all.
  const opRes = await pool.query(`
    SELECT jl.id, jls.name AS status, jls.is_terminal, ${JOB_LINE_COMMITTED_COST_EXPR} AS cost
    FROM job_lines jl JOIN work_orders w ON w.id = jl.work_order_id
    JOIN job_line_statuses jls ON jls.id = jl.status_id
    LEFT JOIN (${JOB_LINE_EXPENSE_COST_SQL}) ec ON ec.job_line_id = jl.id
    WHERE jl.funding_source = 'operating_budget' AND ${JOB_LINE_COMMITTED_COST_EXPR} > 0
  `);
  const pendingOpCost = opRes.rows.filter((r) => !r.is_terminal).reduce((s, r) => s + Number(r.cost), 0);
  const totalOpCost = opRes.rows.reduce((s, r) => s + Number(r.cost), 0);

  async function itemizedGroups(fundingSource, entities) {
    const lineRes = await pool.query(
      `SELECT jl.id AS job_line_id, jl.title AS job_line_title, jl.funding_ref_id,
              w.id AS work_order_id, w.title AS wo_title, jls.name AS status,
              ${JOB_LINE_COMMITTED_COST_EXPR} AS cost
       FROM job_lines jl JOIN work_orders w ON w.id = jl.work_order_id
       JOIN job_line_statuses jls ON jls.id = jl.status_id
       LEFT JOIN (${JOB_LINE_EXPENSE_COST_SQL}) ec ON ec.job_line_id = jl.id
       WHERE jl.funding_source = $1`,
      [fundingSource]
    );
    return entities.map((ent) => {
      const items = lineRes.rows.filter((r) => r.funding_ref_id === ent.Id).map((r) => ({
        WorkOrderId: r.work_order_id, JobLineId: r.job_line_id,
        Title: `${r.wo_title} — ${r.job_line_title}`, Status: r.status, Cost: Number(r.cost),
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
// open (non-Done) work orders. "Scheduled" is now derived from job lines
// (1.4/1.2 moved scheduled_date off work_orders) — a WO counts by the
// EARLIEST date among its lines; zero lines, or lines with no date at all,
// count as unscheduled.
// Build Brief v2, Phase 2: "by status" is now whatever's in work_order_statuses
// (admin-editable, no hardcoded list in the frontend — see reports.js/app.js).
// "By schedule" is unchanged from Phase 1: derived from job lines, terminal
// statuses excluded (a Deferred or Cancelled WO isn't "due" anything).
export async function getWorkOrderSummary() {
  const { rows } = await pool.query(`
    SELECT ws.id AS status_id, ws.name AS status_name, ws.color, ws.is_terminal,
           MIN(jl.scheduled_date) AS earliest_scheduled_date
    FROM work_orders w
    JOIN work_order_statuses ws ON ws.id = w.status_id
    LEFT JOIN job_lines jl ON jl.work_order_id = w.id
    GROUP BY w.id, ws.id, ws.name, ws.color, ws.is_terminal
  `);
  const byStatus = new Map();
  const todayStr = today();
  let dueToday = 0, pastDue = 0, dueFuture = 0, unscheduled = 0;
  for (const row of rows) {
    if (!byStatus.has(row.status_id)) byStatus.set(row.status_id, { Id: row.status_id, Name: row.status_name, Color: row.color, Count: 0 });
    byStatus.get(row.status_id).Count++;
    if (row.is_terminal) continue;
    const sd = row.earliest_scheduled_date ? row.earliest_scheduled_date.toISOString().slice(0, 10) : null;
    if (!sd) unscheduled++;
    else if (sd === todayStr) dueToday++;
    else if (sd < todayStr) pastDue++;
    else dueFuture++;
  }
  return {
    ByStatus: [...byStatus.values()],
    DueToday: dueToday, PastDue: pastDue, DueFuture: dueFuture, Unscheduled: unscheduled,
  };
}

// Per-work-order breakdown of job-line cost/count by status — the segmented
// progress bar (2.6) and its two derived numbers below.
//
// terminal_cost/terminal_lines (is_terminal-based) back TerminalLineCount,
// the "X/Y lines" caption under the bar — "no longer blocks the WO from
// closing" is genuinely what that caption means, so Not Needed/Cancelled
// correctly count there.
//
// performed_est_cost/performed_lines (counts_as_work_performed-based, and
// estimated_cost throughout rather than COALESCE(actual,estimated)) back
// PercentCompleteCost/PercentCompleteCount below — "how much of the planned
// work is actually done." These must NOT reuse the terminal/actual-cost
// numbers above: is_terminal wrongly counts a "Not Needed" line as progress
// (job_line_statuses' migration 0041 comment is explicit that the two flags
// mean different things and neither is derivable from the other), and mixing
// actual cost into a lines-in-progress' still-estimated total skews the %
// by whatever those completed lines ran over or under budget — e.g. a line
// that finished $750 over its $8000 estimate should count as "$8000 of
// planned work done," not silently inflate the whole WO's % complete because
// the numerator grew and the denominator (for the lines still estimated)
// didn't.
const JOB_LINE_STATUS_BREAKDOWN_SQL = `
  SELECT t.work_order_id,
    json_agg(json_build_object('statusId', s.id, 'name', s.name, 'color', s.color, 'isTerminal', s.is_terminal, 'lineCount', t.line_count, 'cost', t.cost) ORDER BY s.sort_order) AS breakdown,
    SUM(CASE WHEN s.is_terminal THEN t.cost ELSE 0 END) AS terminal_cost,
    SUM(t.cost) AS total_cost,
    SUM(CASE WHEN s.is_terminal THEN t.line_count ELSE 0 END) AS terminal_lines,
    SUM(t.line_count) AS total_lines,
    SUM(CASE WHEN s.counts_as_work_performed THEN t.est_cost ELSE 0 END) AS performed_est_cost,
    SUM(t.est_cost) AS total_est_cost,
    SUM(CASE WHEN s.counts_as_work_performed THEN t.line_count ELSE 0 END) AS performed_lines
  FROM (
    SELECT jl.work_order_id, jl.status_id, COUNT(*) AS line_count,
           SUM(COALESCE(${JOB_LINE_ACTUAL_COST_EXPR}, jl.estimated_cost, 0)) AS cost,
           SUM(COALESCE(jl.estimated_cost, 0)) AS est_cost
    FROM job_lines jl
    LEFT JOIN (${JOB_LINE_EXPENSE_COST_SQL}) ec ON ec.job_line_id = jl.id
    GROUP BY jl.work_order_id, jl.status_id
  ) t
  JOIN job_line_statuses s ON s.id = t.status_id
  GROUP BY t.work_order_id
`;

export async function listWorkOrders() {
  const { rows } = await pool.query(
    `SELECT w.id, w.title, w.wo_number, w.parent_wo_id, w.split_root_id, ws.id AS status_id, ws.name AS status, ws.color AS status_color, ws.is_terminal AS status_is_terminal,
            w.priority, w.date_reported, w.date_completed, w.deferred_reason, w.revisit_date,
            jl.earliest_scheduled_date AS scheduled_date,
            jl.line_count, jl.estimated_hours, jl.estimated_cost, jl.actual_hours, jl.actual_cost,
            slb.breakdown, slb.terminal_cost, slb.total_cost, slb.terminal_lines, slb.total_lines,
            slb.performed_est_cost, slb.total_est_cost, slb.performed_lines,
            w.asset_id, a.name AS asset_name, w.location_id, l.name AS location_name,
            EXISTS (SELECT 1 FROM job_lines bjl WHERE bjl.work_order_id = w.id AND bjl.blocked_reason IS NOT NULL) AS is_blocked
     FROM work_orders w
     JOIN work_order_statuses ws ON ws.id = w.status_id
     LEFT JOIN assets a ON a.id = w.asset_id
     LEFT JOIN locations l ON l.id = w.location_id
     LEFT JOIN (${JOB_LINE_ROLLUP_SQL}) jl ON jl.work_order_id = w.id
     LEFT JOIN (${JOB_LINE_STATUS_BREAKDOWN_SQL}) slb ON slb.work_order_id = w.id
     ORDER BY w.id DESC`
  );
  return rows.map((r) => {
    const totalLines = Number(r.total_lines || 0);
    const terminalLines = Number(r.terminal_lines || 0);
    const totalEstCost = Number(r.total_est_cost || 0);
    const performedEstCost = Number(r.performed_est_cost || 0);
    const performedLines = Number(r.performed_lines || 0);
    return {
      Id: r.id, Title: r.title, WoNumber: r.wo_number, ParentWoId: r.parent_wo_id, SplitRootId: r.split_root_id,
      Status: r.status, StatusId: r.status_id, StatusColor: r.status_color, StatusIsTerminal: r.status_is_terminal,
      Priority: r.priority, IsBlocked: r.is_blocked,
      'Date Reported': r.date_reported, 'Date Completed': r.date_completed, 'Scheduled Date': r.scheduled_date,
      DeferredReason: r.deferred_reason, RevisitDate: r.revisit_date,
      LineCount: Number(r.line_count || 0),
      'Estimated Hours': r.estimated_hours != null ? Number(r.estimated_hours) : null,
      'Estimated Cost': r.estimated_cost != null ? Number(r.estimated_cost) : null,
      'Actual Hours': r.actual_hours != null ? Number(r.actual_hours) : null,
      'Actual Cost': r.actual_cost != null ? Number(r.actual_cost) : null,
      StatusBreakdown: r.breakdown || [],
      TerminalLineCount: terminalLines,
      PercentCompleteCost: totalEstCost > 0 ? performedEstCost / totalEstCost : (totalLines > 0 ? performedLines / totalLines : 0),
      PercentCompleteCount: totalLines > 0 ? performedLines / totalLines : 0,
      Asset: r.asset_id ? { Id: r.asset_id, Name: r.asset_name } : null,
      Location: r.location_id ? { Id: r.location_id, Name: r.location_name } : null,
    };
  });
}

async function getAssetUpdatesForWorkOrder(woId) {
  const { rows } = await pool.query(
    `SELECT id, target_field, new_value, applied FROM asset_updates WHERE work_order_id = $1 ORDER BY id`,
    [woId]
  );
  return rows.map((r) => ({ Id: r.id, 'Target Field': r.target_field, 'New Value': r.new_value, Applied: r.applied }));
}

// Single-WO rollup: totals across its job lines, plus a per-funding-source
// cost breakdown (a WO can now be funded from several sources at once — the
// whole reason job lines carry funding_source instead of the WO). Used by
// the WO detail page and by report sources that need one WO's full picture,
// not a list-wide aggregate (see JOB_LINE_ROLLUP_SQL for that).
export async function workOrderRollup(woId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS line_count,
            COALESCE(SUM(jl.estimated_hours), 0) AS estimated_hours,
            COALESCE(SUM(jl.actual_hours), 0) + COALESCE(SUM(lh.session_hours), 0) AS actual_hours_from_lines,
            COALESCE(SUM(jl.estimated_cost), 0) AS estimated_cost,
            COALESCE(SUM(jl.actual_cost), 0) + COALESCE(SUM(ec.expense_cost), 0) AS actual_cost,
            MIN(jl.scheduled_date) AS earliest_scheduled_date,
            MAX(jl.scheduled_date) AS latest_scheduled_date,
            COALESCE(ARRAY_AGG(DISTINCT jl.responsibility_class), '{}') AS responsibility_classes
     FROM job_lines jl
     LEFT JOIN (${JOB_LINE_SESSION_HOURS_SQL}) lh ON lh.job_line_id = jl.id
     LEFT JOIN (${JOB_LINE_EXPENSE_COST_SQL}) ec ON ec.job_line_id = jl.id
     WHERE jl.work_order_id = $1`,
    [woId]
  );
  const r = rows[0];
  // Genuine WO-level time (job_line_id IS NULL — e.g. general site cleanup
  // across a multi-line WO) has no one line to attribute to, so it's added
  // once here rather than per line — see JOB_LINE_SESSION_HOURS_SQL's comment.
  const { rows: unattrRows } = await pool.query(
    `SELECT COALESCE(SUM(hours), 0) AS hours FROM crew_sessions WHERE work_order_id = $1 AND job_line_id IS NULL AND hours IS NOT NULL`,
    [woId]
  );
  const actualHours = Number(r.actual_hours_from_lines) + Number(unattrRows[0].hours);
  const fundingRes = await pool.query(
    `SELECT jl.funding_source, jl.funding_ref_id, SUM(COALESCE(${JOB_LINE_ACTUAL_COST_EXPR}, jl.estimated_cost, 0)) AS cost
     FROM job_lines jl
     LEFT JOIN (${JOB_LINE_EXPENSE_COST_SQL}) ec ON ec.job_line_id = jl.id
     WHERE jl.work_order_id = $1 GROUP BY jl.funding_source, jl.funding_ref_id`,
    [woId]
  );
  const fundingBreakdown = await Promise.all(fundingRes.rows.map(async (fr) => ({
    FundingSource: fr.funding_source, FundingRefId: fr.funding_ref_id,
    FundingRefLabel: await getFundingRefLabel(fr.funding_source, fr.funding_ref_id),
    Cost: Number(fr.cost),
  })));
  return {
    LineCount: Number(r.line_count),
    EstimatedHours: Number(r.estimated_hours), ActualHours: actualHours,
    EstimatedCost: Number(r.estimated_cost), ActualCost: Number(r.actual_cost),
    EarliestScheduledDate: r.earliest_scheduled_date, LatestScheduledDate: r.latest_scheduled_date,
    ResponsibilityClasses: r.responsibility_classes,
    FundingBreakdown: fundingBreakdown,
  };
}

export async function getWorkOrderDetail(woId) {
  const { rows } = await pool.query(
    `SELECT w.*, ws.name AS status_name, ws.color AS status_color, ws.is_terminal AS status_is_terminal,
            a.name AS asset_name, a.lodge_holder AS asset_lodge_holder, l.name AS location_name,
            EXISTS (SELECT 1 FROM job_lines bjl WHERE bjl.work_order_id = w.id AND bjl.blocked_reason IS NOT NULL) AS is_blocked
     FROM work_orders w
     JOIN work_order_statuses ws ON ws.id = w.status_id
     LEFT JOIN assets a ON a.id = w.asset_id LEFT JOIN locations l ON l.id = w.location_id
     WHERE w.id = $1`,
    [woId]
  );
  const w = rows[0];
  if (!w) return null;
  const [assetUpdates, rollup, crewRoster, closeGate] = await Promise.all([
    getAssetUpdatesForWorkOrder(woId), workOrderRollup(woId), getWorkOrderCrewRoster(woId), workOrderCloseGate(woId),
  ]);
  return {
    workOrder: {
      Id: w.id, Title: w.title, Status: w.status_name, StatusId: w.status_id, StatusColor: w.status_color, StatusIsTerminal: w.status_is_terminal,
      Priority: w.priority, IsBlocked: w.is_blocked,
      'Date Reported': w.date_reported, 'Date Completed': w.date_completed,
      DeferredReason: w.deferred_reason, RevisitDate: w.revisit_date,
      Description: w.description,
      BoardFocus: w.board_focus,
      WoNumber: w.wo_number, ParentWoId: w.parent_wo_id, SplitRootId: w.split_root_id,
      // null = this WO follows the global cascade default (§3.7).
      CascadeConfig: normalizeCascadeConfig(w.cascade_config),
      Asset: w.asset_id ? { Id: w.asset_id, Name: w.asset_name, LodgeHolder: w.asset_lodge_holder } : null,
      Location: w.location_id ? { Id: w.location_id, Name: w.location_name } : null,
    },
    rollup,
    crewRoster,
    closeGate,
    assetUpdates,
  };
}

// 2.5's close gate: a WO CAN close once no line is non-terminal — not "all
// Done" (a line correctly marked Not Needed still lets the WO close). This
// never triggers an auto-close (the brief is explicit: closing is always a
// deliberate action); it only tells the UI whether to show the "review and
// close?" prompt.
export async function workOrderCloseGate(woId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE NOT s.is_terminal) AS non_terminal, COUNT(*) AS total
     FROM job_lines jl JOIN job_line_statuses s ON s.id = jl.status_id
     WHERE jl.work_order_id = $1`,
    [woId]
  );
  const r = rows[0];
  return { ReadyToClose: Number(r.total) > 0 && Number(r.non_terminal) === 0, LineCount: Number(r.total) };
}

// funding_ref_id points at a different table depending on funding_source
// (no real FK possible across four target tables — see migration 0016).
// 'fund' (Build Brief v3 Part 1) added funds.id as a fifth target, wired in
// the same soft, app-validated way as the other three.
async function getFundingRefLabel(fundingSource, fundingRefId) {
  if (!fundingRefId) return null;
  const table = { capital_campaign: 'capital_campaign_projects', cabin_holder: 'cabin_holders', other: 'other_budget_categories', fund: 'funds' }[fundingSource];
  if (!table) return null;
  const { rows } = await pool.query(`SELECT name FROM ${table} WHERE id = $1`, [fundingRefId]);
  return rows[0]?.name || null;
}

const today = () => new Date().toISOString().slice(0, 10);

// ── Work order / job line status catalogs (Phase 2, 2.1/2.2) — admin-
//    editable, read by the frontend instead of a hardcoded list. ───────────
export async function listWorkOrderStatuses() {
  const { rows } = await pool.query('SELECT * FROM work_order_statuses WHERE active ORDER BY sort_order, name');
  return rows.map((r) => ({ Id: r.id, Name: r.name, SortOrder: r.sort_order, Color: r.color, IsTerminal: r.is_terminal, IsReview: r.is_review }));
}
export async function listJobLineStatuses() {
  const { rows } = await pool.query('SELECT * FROM job_line_statuses WHERE active ORDER BY sort_order, name');
  return rows.map((r) => ({
    Id: r.id, Name: r.name, SortOrder: r.sort_order, Color: r.color, IsTerminal: r.is_terminal,
    CountsAsWorkPerformed: r.counts_as_work_performed, RequiresNote: r.requires_note, NoteLabel: r.note_label,
  }));
}

// ── Admin CRUD for the two status catalogs — same in-use-guard pattern as
//    causes/sub-areas/building types: block deleting a status something
//    still references, deactivate instead. ────────────────────────────────
export async function adminListWorkOrderStatuses() {
  const { rows } = await pool.query('SELECT * FROM work_order_statuses ORDER BY sort_order, name');
  return rows.map((r) => ({ Id: r.id, Name: r.name, SortOrder: r.sort_order, Color: r.color, IsTerminal: r.is_terminal, IsReview: r.is_review, Active: r.active }));
}
export async function adminCreateWorkOrderStatus({ name, sortOrder = 100, color = '#888888', isTerminal = false, isReview = false }) {
  const { rows } = await pool.query(
    'INSERT INTO work_order_statuses (name, sort_order, color, is_terminal, is_review) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [name, sortOrder, color, !!isTerminal, !!isReview]
  );
  await logActivity({ action: 'created', entityType: 'work_order_status', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0];
}
export async function adminUpdateWorkOrderStatus(id, { name, sortOrder, color, isTerminal, isReview, active }) {
  const { rows } = await pool.query(
    `UPDATE work_order_statuses SET name = COALESCE($2,name), sort_order = COALESCE($3,sort_order),
       color = COALESCE($4,color), is_terminal = COALESCE($5,is_terminal), active = COALESCE($6,active),
       is_review = COALESCE($7,is_review)
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, sortOrder ?? null, color ?? null, isTerminal ?? null, active ?? null, isReview ?? null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'work_order_status', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] || null;
}
export async function adminDeleteWorkOrderStatus(id) {
  const inUse = await pool.query('SELECT count(*) FROM work_orders WHERE status_id = $1', [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} work order(s) still use this status — deactivate it instead`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM work_order_statuses WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'work_order_status', entityId: Number(id), entityLabel: rows[0].name });
}

export async function adminListJobLineStatuses() {
  const { rows } = await pool.query('SELECT * FROM job_line_statuses ORDER BY sort_order, name');
  return rows.map((r) => ({
    Id: r.id, Name: r.name, SortOrder: r.sort_order, Color: r.color, IsTerminal: r.is_terminal,
    CountsAsWorkPerformed: r.counts_as_work_performed, RequiresNote: r.requires_note, NoteLabel: r.note_label, Active: r.active,
  }));
}
export async function adminCreateJobLineStatus({ name, sortOrder = 100, color = '#888888', isTerminal = false, countsAsWorkPerformed = false, requiresNote = false, noteLabel = null }) {
  const { rows } = await pool.query(
    `INSERT INTO job_line_statuses (name, sort_order, color, is_terminal, counts_as_work_performed, requires_note, note_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name, sortOrder, color, !!isTerminal, !!countsAsWorkPerformed, !!requiresNote, noteLabel || null]
  );
  await logActivity({ action: 'created', entityType: 'job_line_status', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0];
}
export async function adminUpdateJobLineStatus(id, { name, sortOrder, color, isTerminal, countsAsWorkPerformed, requiresNote, noteLabel, active }) {
  const { rows } = await pool.query(
    `UPDATE job_line_statuses SET name = COALESCE($2,name), sort_order = COALESCE($3,sort_order),
       color = COALESCE($4,color), is_terminal = COALESCE($5,is_terminal),
       counts_as_work_performed = COALESCE($6,counts_as_work_performed),
       requires_note = COALESCE($7,requires_note), note_label = COALESCE($8,note_label), active = COALESCE($9,active)
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, sortOrder ?? null, color ?? null, isTerminal ?? null, countsAsWorkPerformed ?? null, requiresNote ?? null, noteLabel ?? null, active ?? null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'job_line_status', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] || null;
}
export async function adminDeleteJobLineStatus(id) {
  const inUse = await pool.query('SELECT count(*) FROM job_lines WHERE status_id = $1', [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} job line(s) still use this status — deactivate it instead`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM job_line_statuses WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'job_line_status', entityId: Number(id), entityLabel: rows[0].name });
}

// ── Display settings (2.6) — single admin-wide toggle for now: whether the
//    WO grid's progress bar defaults to cost-weighted or line-count-weighted. ─
// The cascade-capable grid columns (§3.7). Every one of these is exposed as
// a toggle in admin/settings and in the per-WO cascade popover; the names are
// the job_lines column names, which is also what pinned_fields stores.
export const CASCADE_COLUMNS = ['responsibility_class', 'funding_source', 'status_id', 'scheduled_date'];
export const CASCADE_DEFAULTS = { responsibility_class: true, funding_source: true, status_id: true, scheduled_date: true };
// Anything not a known column, or not a boolean, is dropped rather than
// trusted — a stale config from an older build can't smuggle in a column.
export function normalizeCascadeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const out = {};
  for (const col of CASCADE_COLUMNS) if (typeof cfg[col] === 'boolean') out[col] = cfg[col];
  return Object.keys(out).length ? out : null;
}

export async function getDisplaySettings() {
  const { rows } = await pool.query('SELECT wo_progress_weighting, report_image_cap, nav_layout, cascade_defaults FROM display_settings ORDER BY id LIMIT 1');
  return {
    WoProgressWeighting: rows[0]?.wo_progress_weighting || 'cost',
    ReportImageCap: rows[0]?.report_image_cap ?? 4,
    NavLayout: rows[0]?.nav_layout ?? null,
    CascadeDefaults: { ...CASCADE_DEFAULTS, ...(normalizeCascadeConfig(rows[0]?.cascade_defaults) || {}) },
  };
}
// navLayout: undefined = leave alone, null = reset to the built-in default
// (COALESCE can't express that, hence the separate $4 flag).
export async function updateDisplaySettings({ woProgressWeighting, reportImageCap, navLayout, cascadeDefaults }) {
  // cascadeDefaults is merged onto the current value rather than replacing
  // it, so a settings screen that only knows about three of the four columns
  // can't silently wipe the fourth.
  const mergedCascade = cascadeDefaults === undefined
    ? null
    : JSON.stringify({ ...CASCADE_DEFAULTS, ...((await getDisplaySettings()).CascadeDefaults), ...(normalizeCascadeConfig(cascadeDefaults) || {}) });
  await pool.query(
    `UPDATE display_settings SET
       wo_progress_weighting = COALESCE($1, wo_progress_weighting),
       report_image_cap = COALESCE($2, report_image_cap),
       nav_layout = CASE WHEN $4 THEN $3::jsonb ELSE nav_layout END,
       cascade_defaults = COALESCE($5::jsonb, cascade_defaults)
     WHERE id = (SELECT id FROM display_settings ORDER BY id LIMIT 1)`,
    [woProgressWeighting || null, reportImageCap ?? null, navLayout ? JSON.stringify(navLayout) : null, navLayout !== undefined, mergedCascade]
  );
  // Nav reorders save on every move — don't flood the activity feed with them.
  if (woProgressWeighting !== undefined || reportImageCap !== undefined || cascadeDefaults !== undefined) {
    await logActivity({ action: 'updated', entityType: 'display_settings', entityLabel: 'display settings', details: `weighting=${woProgressWeighting || '—'} imageCap=${reportImageCap ?? '—'}${cascadeDefaults !== undefined ? ' cascadeDefaults changed' : ''}` });
  }
  return getDisplaySettings();
}
async function resolveWorkOrderStatusId(nameOrId) {
  if (typeof nameOrId === 'number') return nameOrId;
  if (/^\d+$/.test(String(nameOrId))) return Number(nameOrId);
  const { rows } = await pool.query('SELECT id FROM work_order_statuses WHERE name = $1', [nameOrId]);
  if (!rows[0]) { const e = new Error(`"${nameOrId}" is not a known work order status`); e.status = 400; throw e; }
  return rows[0].id;
}

// Every status transition writes a work_order_log_entries row automatically
// (2.4) — no exceptions, no silent updates. This is the one place a WO's
// status_id is ever written, so every caller (the WO fields form, the quick
// "Update Status To" log-entry shortcut) goes through the same enforcement:
// Deferred requires a reason + revisit_date (2.3), checked at the API layer
// because that's where the board credibility comes from.
async function changeWorkOrderStatus(client, woId, newStatusId, { deferredReason, revisitDate } = {}) {
  const { rows: curRows } = await client.query(
    `SELECT w.status_id, ws.name AS old_name, w.title, w.gcal_event_id FROM work_orders w JOIN work_order_statuses ws ON ws.id = w.status_id WHERE w.id = $1`,
    [woId]
  );
  const cur = curRows[0];
  if (!cur) { const e = new Error('Work Order not found'); e.status = 404; throw e; }
  if (cur.status_id === newStatusId) return;
  const { rows: newRows } = await client.query('SELECT name FROM work_order_statuses WHERE id = $1', [newStatusId]);
  const newName = newRows[0]?.name;
  if (!newName) { const e = new Error('Unknown work order status'); e.status = 400; throw e; }
  if (newName === 'Deferred' && (!deferredReason || !revisitDate)) {
    const e = new Error('Deferring a work order requires a reason and a revisit date'); e.status = 400; throw e;
  }
  const setCols = ['status_id = $2'];
  const vals = [woId, newStatusId];
  if (newName === 'Deferred') {
    setCols.push(`deferred_reason = $3`, `revisit_date = $4`);
    vals.push(deferredReason, revisitDate);
  } else {
    setCols.push('deferred_reason = NULL', 'revisit_date = NULL');
  }
  if (newName === 'Done') setCols.push(`date_completed = COALESCE(date_completed, CURRENT_DATE)`);
  await client.query(`UPDATE work_orders SET ${setCols.join(', ')} WHERE id = $1`, vals);
  await client.query(
    'INSERT INTO work_order_log_entries (work_order_id, note, status_change, username) VALUES ($1,$2,$3,$4)',
    [woId, `Status changed: ${cur.old_name} → ${newName}`, newName, currentUsername()]
  );
  // Revisit sync (Build Brief v4 step 3, closed 2026-09-15): entering
  // Deferred queues the prompt event; leaving it — to anything else — tears
  // it down. A revisit date is a commitment tied to being Deferred, not a
  // fact worth keeping visible once the WO has moved on.
  if (newName === 'Deferred') {
    await queueGcalSync(client, 'wo_revisit', woId);
  } else if (cur.old_name === 'Deferred') {
    await queueGcalDelete(cur.gcal_event_id);
    await client.query('UPDATE work_orders SET gcal_event_id = NULL WHERE id = $1', [woId]);
    await client.query('DELETE FROM gcal_pending_syncs WHERE entity_type = $1 AND entity_id = $2', ['wo_revisit', woId]);
  }
}

// jobLines: [{ title, responsibilityClass, fundingSource, fundingRefId,
// estimatedHours, estimatedCost, scheduledDate }] — the WO creation flow
// (1.7) captures a full job line per "+ Add job line" row; scheduledDate
// defaults to the WO's own date when a line doesn't set its own (1.4).
export async function createWorkOrder({ title, assetId, locationId, priority, description, scheduledDate, assetUpdates = [], jobLines = [], cascadeConfig }) {
  const propertyFields = await getAssetPropertyFields();
  const byLabel = new Map(propertyFields.map((f) => [f.title, f]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A freshly created WO is its own unsplit root (§5.4: split_root_id
    // points at itself until/unless it's ever split off). wo_number is a
    // display string, defaulted to the real id — fetching the id up front
    // via nextval lets both go in the same INSERT instead of an INSERT+UPDATE.
    const { rows: idRows } = await client.query(`SELECT nextval(pg_get_serial_sequence('work_orders','id')) AS id`);
    const woId = Number(idRows[0].id);
    const { rows } = await client.query(
      `INSERT INTO work_orders (id, title, asset_id, location_id, priority, status_id, description, date_reported, wo_number, split_root_id, cascade_config)
       VALUES ($1,$2,$3,$4,$5,(SELECT id FROM work_order_statuses WHERE name = 'Reported'),$6,$7,$8,$1,$9) RETURNING id`,
      [woId, title, assetId || null, locationId || null, priority || 'Medium', description || null, today(), String(woId),
        normalizeCascadeConfig(cascadeConfig) ? JSON.stringify(normalizeCascadeConfig(cascadeConfig)) : null]
    );
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
    for (const line of jobLines) {
      const lineTitle = (typeof line === 'string' ? line : line?.title || '').trim();
      if (!lineTitle) continue;
      // A line can be CREATED already sitting in any status — that's arrears
      // entry (recording work that already happened). requires_note from the
      // status config governs lifecycle TRANSITIONS on saved lines
      // (changeJobLineStatus), never creation, so nothing prompts here.
      const statusId = await resolveInitialJobLineStatus(client, line.statusId);
      const { rows: lineRows } = await client.query(
        `INSERT INTO job_lines (work_order_id, title, sort_order, responsibility_class, funding_source, funding_ref_id,
           estimated_hours, estimated_cost, scheduled_date, status_id, pinned_fields, completed_date, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
           CASE WHEN (SELECT counts_as_work_performed FROM job_line_statuses WHERE id = $10) THEN CURRENT_DATE ELSE NULL END,
           -- A line created ALREADY resolved never passes through changeJobLineStatus,
           -- so this is its only chance to be stamped. Without it, clearing the date
           -- later leaves the line with neither and it vanishes from Done entirely.
           CASE WHEN (SELECT counts_as_work_performed FROM job_line_statuses WHERE id = $10) THEN now() ELSE NULL END)
         RETURNING id, scheduled_date`,
        [woId, lineTitle, sortOrder++,
          line.responsibilityClass || 'self', line.fundingSource || 'operating_budget', line.fundingRefId || null,
          line.estimatedHours ?? null, line.estimatedCost ?? null, line.scheduledDate || scheduledDate || null,
          statusId, JSON.stringify(sanitizePinnedFields(line.pinnedFields))]
      );
      // Same reason createJobLine queues one (see its header comment): a line
      // born with a date needs to reach the calendar sync worker on day one,
      // not wait for someone to edit it later.
      if (lineRows[0].scheduled_date) await queueGcalSync(client, 'job_line', lineRows[0].id);
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
  const allowed = ['title', 'description', 'priority', 'date_reported', 'date_completed', 'asset_id', 'board_focus', 'board_focus_set_at'];
  const setCols = [];
  const vals = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    setCols.push(`${key} = $${i++}`);
    vals.push(value === '' ? null : value);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existsRows } = await client.query('SELECT id FROM work_orders WHERE id = $1', [woId]);
    if (!existsRows.length) { await client.query('ROLLBACK'); return null; }
    if (setCols.length) {
      vals.push(woId);
      await client.query(`UPDATE work_orders SET ${setCols.join(', ')} WHERE id = $${i}`, vals);
    }
    if (fields.status_id != null) {
      await changeWorkOrderStatus(client, woId, await resolveWorkOrderStatusId(fields.status_id), {
        deferredReason: fields.deferred_reason, revisitDate: fields.revisit_date,
      });
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
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
// The manual note (if any) and the automatic "Status changed: X → Y" entry
// (2.4, via changeWorkOrderStatus) are deliberately two separate log rows —
// one is what the operator wrote, the other is the unconditional audit trail.
export async function createWorkOrderLogEntry(woId, { note, hours, statusChange }) {
  const { rows } = await pool.query(
    'INSERT INTO work_order_log_entries (work_order_id, note, hours, username) VALUES ($1,$2,$3,$4) RETURNING *',
    [woId, note, hours ?? null, currentUsername()]
  );
  if (statusChange) {
    const statusId = await resolveWorkOrderStatusId(statusChange);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await changeWorkOrderStatus(client, woId, statusId, {});
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
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
// and pending job lines (scope, funding, responsibility, estimates — but not
// actuals, crew assignments, or scheduled dates) — a clean slate otherwise
// (Open status, no dates). Good for "this happens again next month" without
// retyping everything. Previously this comment claimed to copy job lines but
// the code didn't; fixed as part of the Phase 1 rework.
export async function duplicateWorkOrder(woId) {
  const src = await pool.query('SELECT * FROM work_orders WHERE id = $1', [woId]);
  const w = src.rows[0];
  if (!w) return null;
  const [srcUpdates, srcLines] = await Promise.all([
    pool.query('SELECT target_field, new_value FROM asset_updates WHERE work_order_id = $1', [woId]),
    pool.query('SELECT title, sort_order, responsibility_class, funding_source, funding_ref_id, estimated_hours, estimated_cost FROM job_lines WHERE work_order_id = $1 ORDER BY sort_order, id', [woId]),
  ]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Same self-pointing-root / wo_number-from-id pattern as createWorkOrder
    // — a duplicate is a brand new, never-split WO, not a sibling of the
    // original.
    const { rows: idRows } = await client.query(`SELECT nextval(pg_get_serial_sequence('work_orders','id')) AS id`);
    const newId = Number(idRows[0].id);
    await client.query(
      `INSERT INTO work_orders (id, title, asset_id, location_id, priority, status_id, description, date_reported, wo_number, split_root_id)
       VALUES ($1,$2,$3,$4,$5,(SELECT id FROM work_order_statuses WHERE name = 'Reported'),$6,$7,$8,$1)`,
      [newId, `${w.title} (Copy)`, w.asset_id, w.location_id, w.priority, w.description, today(), String(newId)]
    );
    for (const u of srcUpdates.rows) {
      await client.query(
        `INSERT INTO asset_updates (work_order_id, target_field, new_value, applied) VALUES ($1,$2,$3,false)`,
        [newId, u.target_field, u.new_value]
      );
    }
    for (const l of srcLines.rows) {
      await client.query(
        `INSERT INTO job_lines (work_order_id, title, sort_order, responsibility_class, funding_source, funding_ref_id, estimated_hours, estimated_cost, status_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(SELECT id FROM job_line_statuses WHERE name = 'Not Started'))`,
        [newId, l.title, l.sort_order, l.responsibility_class, l.funding_source, l.funding_ref_id, l.estimated_hours, l.estimated_cost]
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
    DefaultDescription: r.default_description,
    // The template's own blurb ("when to reach for this one"), distinct
    // from DefaultDescription, which fills the created WO's description.
    Description: r.description,
    // Template lines live in work_order_template_lines as of migration 0071
    // and are attached as `Lines` by listWorkOrderTemplates/getWorkOrderTemplate.
    // job_line_defaults is the dormant pre-0071 column — kept on disk, never
    // read. asset_update_defaults is the older, separate "also update an
    // asset field" blueprint, unrelated to job lines.
    AssetUpdateDefaults: r.asset_update_defaults,
    DefaultResponsibilityClass: r.default_responsibility_class,
    PresetVolunteerIds: r.preset_volunteer_ids, PresetVendorIds: r.preset_vendor_ids,
  };
}
export async function listWorkOrderTemplates() {
  const { rows } = await pool.query('SELECT * FROM work_order_templates ORDER BY name');
  return Promise.all(rows.map(async (r) => ({ ...templateRowShape(r), Lines: await templateLines(r.id) })));
}
export async function getWorkOrderTemplate(id) {
  const { rows } = await pool.query('SELECT * FROM work_order_templates WHERE id = $1', [id]);
  if (!rows[0]) return null;
  return { ...templateRowShape(rows[0]), Lines: await templateLines(rows[0].id) };
}
export async function createWorkOrderTemplate({ name, description, defaultTitle, defaultPriority, defaultDescription, lines = [], assetUpdateDefaults = [], defaultResponsibilityClass, presetVolunteerIds = [], presetVendorIds = [] }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO work_order_templates (name, description, default_title, default_priority, default_description, asset_update_defaults, default_responsibility_class, preset_volunteer_ids, preset_vendor_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, description || null, defaultTitle || null, defaultPriority || null, defaultDescription || null, JSON.stringify(assetUpdateDefaults),
        defaultResponsibilityClass || null, presetVolunteerIds, presetVendorIds]
    );
    await writeTemplateLines(client, rows[0].id, lines);
    await client.query('COMMIT');
    await logActivity({ action: 'created', entityType: 'work_order_template', entityId: rows[0].id, entityLabel: rows[0].name });
    return { ...templateRowShape(rows[0]), Lines: await templateLines(rows[0].id) };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
export async function updateWorkOrderTemplate(id, { name, description, defaultTitle, defaultPriority, defaultDescription, lines, assetUpdateDefaults, defaultResponsibilityClass, presetVolunteerIds, presetVendorIds }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE work_order_templates SET
         name = COALESCE($2,name), default_title = COALESCE($3,default_title),
         default_priority = COALESCE($4,default_priority), default_description = COALESCE($5,default_description),
         asset_update_defaults = COALESCE($6,asset_update_defaults),
         default_responsibility_class = COALESCE($7,default_responsibility_class), preset_volunteer_ids = COALESCE($8,preset_volunteer_ids),
         preset_vendor_ids = COALESCE($9,preset_vendor_ids),
         description = CASE WHEN $11 THEN $10 ELSE description END
       WHERE id = $1 RETURNING *`,
      [id, name ?? null, defaultTitle ?? null, defaultPriority ?? null, defaultDescription ?? null,
        assetUpdateDefaults ? JSON.stringify(assetUpdateDefaults) : null,
        defaultResponsibilityClass ?? null, presetVolunteerIds ?? null, presetVendorIds ?? null,
        description ?? null, description !== undefined]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return null; }
    // undefined = leave the lines alone; [] = the user really did remove them all.
    if (lines !== undefined) await writeTemplateLines(client, rows[0].id, lines || []);
    await client.query('COMMIT');
    await logActivity({ action: 'updated', entityType: 'work_order_template', entityId: rows[0].id, entityLabel: rows[0].name });
    return { ...templateRowShape(rows[0]), Lines: await templateLines(rows[0].id) };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
export async function deleteWorkOrderTemplate(id) {
  const { rows } = await pool.query('DELETE FROM work_order_templates WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'work_order_template', entityId: Number(id), entityLabel: rows[0].name });
}

// Preset crew attaches to every line created, since assignment is per-line
// now (1.2), not per-WO. default_responsibility_class fills in any template
// line that doesn't specify its own.
//
// Instantiates a template. Two callers, one resolver:
//   * PM auto-generation (generateDueWorkOrdersForRange) and the future
//     scheduler call it for real and get back a created work order id.
//   * The grid's "New WO from template" calls it with dryRun, which resolves
//     the same line set — pinned/following state included — and hands it
//     straight to the grid WITHOUT writing anything. That's what keeps §8's
//     "pre-populates the grid ... saves normally" and "the UI uses this same
//     endpoint" from being two different code paths, and stops an abandoned
//     template pick from leaving a stray work order behind.
// `overrides` sets WO-level fields (title/priority/description) on top of the
// template's own defaults.
export async function createWorkOrderFromTemplate(templateId, { assetId, locationId, scheduledDate, overrides = {}, dryRun = false } = {}) {
  const { rows } = await pool.query('SELECT * FROM work_order_templates WHERE id = $1', [templateId]);
  const tpl = rows[0];
  if (!tpl) { const e = new Error(`Work Order Template #${templateId} not found`); e.status = 404; throw e; }
  const jobLines = resolveTemplateLines(await templateLines(tpl.id), { defaultResponsibilityClass: tpl.default_responsibility_class });
  const woFields = {
    title: overrides.title || tpl.default_title || tpl.name,
    assetId, locationId,
    priority: overrides.priority || tpl.default_priority,
    description: overrides.description !== undefined ? overrides.description : tpl.default_description,
    scheduledDate,
    assetUpdates: tpl.asset_update_defaults || [],
    jobLines,
  };
  if (dryRun) {
    return {
      dryRun: true,
      template: { ...templateRowShape(tpl), Lines: await templateLines(tpl.id) },
      workOrder: { title: woFields.title, priority: woFields.priority, description: woFields.description, assetId: assetId ?? null, scheduledDate: scheduledDate ?? null },
      jobLines,
      presetVolunteerIds: tpl.preset_volunteer_ids || [],
      presetVendorIds: tpl.preset_vendor_ids || [],
    };
  }
  const { workOrderId } = await createWorkOrder(woFields);
  if (tpl.preset_volunteer_ids?.length || tpl.preset_vendor_ids?.length) {
    const { rows: lineRows } = await pool.query('SELECT id FROM job_lines WHERE work_order_id = $1', [workOrderId]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const line of lineRows) {
        for (const volunteerId of tpl.preset_volunteer_ids || []) {
          await client.query(`INSERT INTO job_line_volunteers (job_line_id, volunteer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [line.id, volunteerId]);
        }
        for (const vendorId of tpl.preset_vendor_ids || []) {
          await client.query(`INSERT INTO job_line_vendors (job_line_id, vendor_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [line.id, vendorId]);
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return workOrderId;
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

// Condition Findings have no dedicated detail view/route yet (they're
// listed read-only on the Asset detail page) — this is the one mutable
// field they need for now: the Forward Focus board flag.
export async function updateConditionFinding(id, { boardFocus }) {
  const { rows } = await pool.query(
    `UPDATE condition_findings SET board_focus = $2,
       board_focus_set_at = CASE WHEN $2 THEN COALESCE(board_focus_set_at, now()) ELSE NULL END
     WHERE id = $1 RETURNING id, title, board_focus`,
    [id, !!boardFocus]
  );
  if (!rows[0]) return null;
  await logActivity({ action: 'updated', entityType: 'condition_finding', entityId: rows[0].id, entityLabel: rows[0].title, details: boardFocus ? 'Flagged for board focus' : 'Unflagged from board focus' });
  return { Id: rows[0].id, Title: rows[0].title, BoardFocus: rows[0].board_focus };
}

// Phase 3's two manual finding transitions — both require an explanation,
// enforced here (not just in the UI), for the same "board credibility"
// reason Deferred work orders do: reviewed_by/reviewed_at make the decision
// attributable, same pattern as maintenance_requests.
export async function deferFinding(id, { reason, revisitDate }) {
  if (!reason?.trim() || !revisitDate) { const e = new Error('Deferring a finding requires a reason and a revisit date'); e.status = 400; throw e; }
  const { rows } = await pool.query(
    `UPDATE condition_findings SET status = 'Deferred', deferred_reason = $2, revisit_date = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1 RETURNING id, title`,
    [id, reason.trim(), revisitDate, currentUsername()]
  );
  if (!rows[0]) return null;
  // Revisit sync (Build Brief v4 step 3, closed 2026-09-15): a freshly
  // Deferred finding needs its prompt event on Google on day one.
  await queueGcalSync(pool, 'finding_revisit', rows[0].id);
  await logActivity({ action: 'deferred', entityType: 'condition_finding', entityId: rows[0].id, entityLabel: rows[0].title, details: reason.trim() });
  return { Id: rows[0].id, Title: rows[0].title };
}
export async function dismissFinding(id, { note }) {
  if (!note?.trim()) { const e = new Error('Dismissing a finding requires a note'); e.status = 400; throw e; }
  const { rows: curRows } = await pool.query('SELECT status, gcal_event_id FROM condition_findings WHERE id = $1', [id]);
  const cur = curRows[0];
  if (cur?.status === 'Deferred') {
    // Leaving Deferred tears the revisit prompt down — the same reasoning
    // changeWorkOrderStatus applies to a Deferred work order's revisit event.
    await queueGcalDelete(cur.gcal_event_id);
    await pool.query('UPDATE condition_findings SET gcal_event_id = NULL WHERE id = $1', [id]);
    await pool.query('DELETE FROM gcal_pending_syncs WHERE entity_type = $1 AND entity_id = $2', ['finding_revisit', id]);
  }
  const { rows } = await pool.query(
    `UPDATE condition_findings SET status = 'Dismissed', dismiss_note = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1 RETURNING id, title`,
    [id, note.trim(), currentUsername()]
  );
  if (!rows[0]) return null;
  await logActivity({ action: 'dismissed', entityType: 'condition_finding', entityId: rows[0].id, entityLabel: rows[0].title, details: note.trim() });
  return { Id: rows[0].id, Title: rows[0].title };
}

// Dashboard signal (3): Open should trend to zero — every finding is
// supposed to end up with a decision made on it, one way or another. The
// second count is the data-quality check: findings nobody has even put on a
// work order yet.
export async function getFindingsSummary() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'Open') AS open_count,
      COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM job_lines jl WHERE jl.condition_finding_id = condition_findings.id)) AS not_on_wo_count
    FROM condition_findings
  `);
  return { OpenCount: Number(rows[0].open_count), NotOnAnyWorkOrderCount: Number(rows[0].not_on_wo_count) };
}

// ── Job line templates (Build Brief v2 Phase 7, §7.1) — admin-editable
//    wording/defaults, keyed loosely by building type + component type,
//    same data-driven pattern as question_applicability/
//    component_sub_areas. Templates supply defaults only, never grouping —
//    findings stay 1:1 with the job lines they become. ─────────────────────

function jobLineTemplateRowShape(r) {
  return {
    Id: r.id, BuildingTypeId: r.building_type_id, ComponentType: r.component_type,
    DefaultTitle: r.default_title, DefaultResponsibilityClass: r.default_responsibility_class,
    DefaultFundingSource: r.default_funding_source, SortOrder: r.sort_order, Active: r.active,
  };
}
export async function listJobLineTemplates({ includeInactive = false } = {}) {
  const { rows } = await pool.query(`SELECT * FROM job_line_templates ${includeInactive ? '' : 'WHERE active'} ORDER BY sort_order, id`);
  return rows.map(jobLineTemplateRowShape);
}
export async function createJobLineTemplate({ buildingTypeId, componentType, defaultTitle, defaultResponsibilityClass, defaultFundingSource, sortOrder = 100 }) {
  const { rows } = await pool.query(
    `INSERT INTO job_line_templates (building_type_id, component_type, default_title, default_responsibility_class, default_funding_source, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [buildingTypeId || null, componentType || null, defaultTitle, defaultResponsibilityClass || null, defaultFundingSource || null, sortOrder]
  );
  await logActivity({ action: 'created', entityType: 'job_line_template', entityId: rows[0].id, entityLabel: rows[0].default_title });
  return jobLineTemplateRowShape(rows[0]);
}
export async function updateJobLineTemplate(id, { buildingTypeId, componentType, defaultTitle, defaultResponsibilityClass, defaultFundingSource, sortOrder, active }) {
  const { rows } = await pool.query(
    `UPDATE job_line_templates SET
       building_type_id = COALESCE($2, building_type_id), component_type = COALESCE($3, component_type),
       default_title = COALESCE($4, default_title), default_responsibility_class = COALESCE($5, default_responsibility_class),
       default_funding_source = COALESCE($6, default_funding_source), sort_order = COALESCE($7, sort_order), active = COALESCE($8, active)
     WHERE id = $1 RETURNING *`,
    [id, buildingTypeId ?? null, componentType ?? null, defaultTitle ?? null, defaultResponsibilityClass ?? null, defaultFundingSource ?? null, sortOrder ?? null, active ?? null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'job_line_template', entityId: rows[0].id, entityLabel: rows[0].default_title });
  return rows[0] ? jobLineTemplateRowShape(rows[0]) : null;
}
export async function deleteJobLineTemplate(id) {
  const { rows } = await pool.query('DELETE FROM job_line_templates WHERE id = $1 RETURNING default_title', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'job_line_template', entityId: Number(id), entityLabel: rows[0].default_title });
}

// Most specific match wins: building type + component type, then component
// type alone, then building type alone. Never guesses across component
// types — a Roof template must not apply to a Foundation finding.
function matchJobLineTemplate(templates, buildingTypeId, componentType) {
  return templates.find((t) => t.BuildingTypeId === buildingTypeId && t.ComponentType === componentType)
    || (componentType ? templates.find((t) => !t.BuildingTypeId && t.ComponentType === componentType) : null)
    || (buildingTypeId ? templates.find((t) => t.BuildingTypeId === buildingTypeId && !t.ComponentType) : null)
    || null;
}

// ── Create WO from findings (Build Brief v2 Phase 7, §7.2) — the end of a
//    walkthrough: every open finding for the asset, pre-filled from its
//    template, one checkbox each. Untick anything not going on this WO. ────

// Every open finding for the asset, each with its template-suggested line
// title (falling back to the finding's own title when no template matches)
// so the "New WO" screen can render checkboxes with editable titles already
// filled in — capture stays fast, nothing is guessed silently.
export async function getOpenFindingsForWoCreation(assetId) {
  const [findingsRes, assetRes, templates] = await Promise.all([
    pool.query(`SELECT * FROM condition_findings WHERE asset_id = $1 AND status = 'Open' ORDER BY id`, [assetId]),
    pool.query('SELECT name, building_type_id FROM assets WHERE id = $1', [assetId]),
    listJobLineTemplates(),
  ]);
  const asset = assetRes.rows[0];
  return findingsRes.rows.map((f) => {
    const tmpl = matchJobLineTemplate(templates, asset?.building_type_id, f.source_component_type);
    const suggestedTitle = tmpl ? tmpl.DefaultTitle.replace('{asset}', asset?.name || `Asset #${assetId}`) : f.title;
    return {
      Id: f.id, Title: f.title, Severity: f.severity, Description: f.description, EstimatedCost: f.estimated_cost,
      SuggestedTitle: suggestedTitle,
      SuggestedResponsibilityClass: tmpl?.DefaultResponsibilityClass || 'self',
      SuggestedFundingSource: tmpl?.DefaultFundingSource || 'operating_budget',
    };
  });
}

// One job line per checked finding, `condition_finding_id` set on each —
// createJobLine's existing auto-schedule-on-link (Phase 3) fires for every
// one, so every finding on this WO moves Open -> Scheduled for free. Funding
// and responsibility class get adjusted afterward on the WO screen, where
// there's a keyboard (§7.2) — this only needs to get the WO created fast.
export async function createWorkOrderFromFindings(assetId, findingSelections) {
  if (!findingSelections?.length) { const e = new Error('Select at least one finding'); e.status = 400; throw e; }
  const assetRes = await pool.query('SELECT name FROM assets WHERE id = $1', [assetId]);
  const assetName = assetRes.rows[0]?.name || `Asset #${assetId}`;
  const { workOrderId } = await createWorkOrder({ title: `Findings — ${assetName}`, assetId });
  for (const sel of findingSelections) {
    await createJobLine(workOrderId, {
      title: sel.title, responsibilityClass: sel.responsibilityClass || 'self', fundingSource: sel.fundingSource || 'operating_budget',
      estimatedCost: sel.estimatedCost ?? null, conditionFindingId: sel.findingId,
    });
  }
  return { workOrderId };
}

// Everything currently flagged board_focus, across both Work Orders and
// Condition Findings — the Forward Focus report's raw material.
export async function getBoardFocusItems() {
  const [woRes, cfRes] = await Promise.all([
    pool.query(`
      SELECT w.id, w.title, w.priority, ws.name AS status, a.name AS asset_name,
             e.work_order_template_id,
             COALESCE(jl.estimated_cost, 0) AS estimated_cost
      FROM work_orders w
      JOIN work_order_statuses ws ON ws.id = w.status_id
      LEFT JOIN assets a ON a.id = w.asset_id
      LEFT JOIN calendar_event_generated_wo g ON g.work_order_id = w.id
      LEFT JOIN calendar_events e ON e.id = g.calendar_event_id
      LEFT JOIN (${JOB_LINE_ROLLUP_SQL}) jl ON jl.work_order_id = w.id
      WHERE w.board_focus = true
      ORDER BY w.id DESC
    `),
    pool.query(`
      SELECT cf.id, cf.title, cf.estimated_cost, cf.severity, cf.status, a.name AS asset_name
      FROM condition_findings cf LEFT JOIN assets a ON a.id = cf.asset_id
      WHERE cf.board_focus = true
      ORDER BY cf.id DESC
    `),
  ]);
  return { workOrders: woRes.rows, conditionFindings: cfRes.rows };
}

// Average total actual cost (summed across job lines) of past completed Work
// Orders generated from this template via a recurring Calendar Event — used
// so a PM-recurring item's forward cost projection is grounded in what the
// job has actually cost before, not just its (often stale) estimate.
export async function historicalAvgActualCost(templateId) {
  const { rows } = await pool.query(
    `SELECT AVG(wo_actual.total_actual_cost) AS avg_cost
     FROM calendar_event_generated_wo g
     JOIN calendar_events e ON e.id = g.calendar_event_id
     JOIN work_orders w ON w.id = g.work_order_id
     JOIN (
       SELECT jl.work_order_id, SUM(COALESCE(jl.actual_cost,0) + COALESCE(ec.expense_cost,0)) AS total_actual_cost
       FROM job_lines jl
       LEFT JOIN (${JOB_LINE_EXPENSE_COST_SQL}) ec ON ec.job_line_id = jl.id
       WHERE jl.actual_cost IS NOT NULL OR ec.expense_cost IS NOT NULL
       GROUP BY jl.work_order_id
     ) wo_actual ON wo_actual.work_order_id = w.id
     JOIN work_order_statuses ws ON ws.id = w.status_id
     WHERE e.work_order_template_id = $1 AND ws.name = 'Done'`,
    [templateId]
  );
  return rows[0]?.avg_cost != null ? Number(rows[0].avg_cost) : null;
}

// Raw material for the monthly Board report (reportDataPg.js's
// buildBoardReportPg does the shaping/grouping — this stays the only place
// that knows SQL, per the portability boundary). Open-WO counts/funding
// totals are grouped by job line now (Phase 1 moved cost/funding there);
// "upcoming"/"overdue" list individual job lines rather than whole work
// orders, since a WO's lines can have divergent dates (1.4) — a board seeing
// "Roof — Cabin 4 — overdue" is more useful than "WO #12 — overdue" when
// two of that WO's three lines are already done.
export async function getBoardReportRawData({ periodStart, periodEnd, todayStr }) {
  const [openStatusRes, openFundingRes, completedRes, upcomingRes, overdueRes] = await Promise.all([
    // One row per non-terminal WO regardless of whether it has job lines yet
    // (a freshly-Reported WO with no lines should still count as open).
    // "Open" now means NOT is_terminal — Deferred/Cancelled are terminal too,
    // not just Done, so they're correctly excluded here.
    pool.query(`SELECT ws.name AS status, w.priority FROM work_orders w JOIN work_order_statuses ws ON ws.id = w.status_id WHERE NOT ws.is_terminal`),
    // Funding totals only make sense for WOs that have costed lines —
    // separate query, one row per line, so a WO split across two funding
    // sources contributes to both totals correctly.
    pool.query(`
      SELECT jl.funding_source, COALESCE(${JOB_LINE_ACTUAL_COST_EXPR}, jl.estimated_cost, 0) AS cost
      FROM job_lines jl JOIN work_orders w ON w.id = jl.work_order_id
      JOIN work_order_statuses ws ON ws.id = w.status_id
      LEFT JOIN (${JOB_LINE_EXPENSE_COST_SQL}) ec ON ec.job_line_id = jl.id
      WHERE NOT ws.is_terminal
    `),
    pool.query(`
      SELECT w.id, w.title, w.date_completed, a.name AS asset_name,
             jl.estimated_cost, jl.actual_cost, jl.funding_sources
      FROM work_orders w
      JOIN work_order_statuses ws ON ws.id = w.status_id
      LEFT JOIN assets a ON a.id = w.asset_id
      LEFT JOIN (${JOB_LINE_ROLLUP_SQL}) jl ON jl.work_order_id = w.id
      WHERE ws.name = 'Done' AND w.date_completed BETWEEN $1 AND $2
      ORDER BY w.date_completed DESC
    `, [periodStart, periodEnd]),
    pool.query(`
      SELECT jl.id AS job_line_id, jl.title AS job_line_title, jl.scheduled_date,
             w.id AS work_order_id, w.title AS wo_title, w.priority, a.name AS asset_name
      FROM job_lines jl JOIN work_orders w ON w.id = jl.work_order_id
      JOIN work_order_statuses ws ON ws.id = w.status_id
      LEFT JOIN assets a ON a.id = w.asset_id
      WHERE NOT ws.is_terminal AND jl.scheduled_date >= $1
      ORDER BY jl.scheduled_date ASC
    `, [todayStr]),
    pool.query(`
      SELECT jl.id AS job_line_id, jl.title AS job_line_title, jl.scheduled_date,
             w.id AS work_order_id, w.title AS wo_title, w.priority, a.name AS asset_name
      FROM job_lines jl JOIN work_orders w ON w.id = jl.work_order_id
      JOIN work_order_statuses ws ON ws.id = w.status_id
      LEFT JOIN assets a ON a.id = w.asset_id
      WHERE NOT ws.is_terminal AND jl.scheduled_date < $1
      ORDER BY jl.scheduled_date ASC
    `, [todayStr]),
  ]);
  return {
    openStatusRows: openStatusRes.rows, openFundingRows: openFundingRes.rows,
    completedRows: completedRes.rows, upcomingRows: upcomingRes.rows, overdueRows: overdueRes.rows,
  };
}

// Reopen (§1). Moves to Review rather than back to open: the work happened, the record
// needs adjusting, and dropping it into the open queue would misrepresent that.
//
// Deliberately does NOT touch job line statuses — a reopen is about editing the record,
// not undoing the work. Changing a line back to an unresolved status is a separate act
// and reopens its finding through the ordinary path.
//
// date_completed is KEPT. Clearing it would mean a re-close stamps today's date onto
// work that happened weeks ago — the same misdating §3 exists to prevent. The board
// report's Done rule keys on STATUS as well as date, so a reopened WO drops out of Done
// on status alone while its real completion date survives.
export async function reopenWorkOrder(woId, { reason } = {}) {
  const { rows: cur } = await pool.query(
    `SELECT w.id, w.title, w.date_completed::text AS date_completed, ws.name AS status, ws.is_terminal, ws.is_review
     FROM work_orders w JOIN work_order_statuses ws ON ws.id = w.status_id WHERE w.id = $1`,
    [woId]
  );
  if (!cur[0]) return null;
  if (!cur[0].is_terminal && !cur[0].is_review) {
    const e = new Error('That work order is already open'); e.status = 400; throw e;
  }
  const { rows: review } = await pool.query(
    `SELECT id FROM work_order_statuses WHERE is_review ORDER BY sort_order LIMIT 1`
  );
  if (!review[0]) { const e = new Error('No Review status is configured'); e.status = 400; throw e; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await changeWorkOrderStatus(client, woId, review[0].id, {});
    await client.query(
      `INSERT INTO work_order_log_entries (work_order_id, note, username) VALUES ($1,$2,$3)`,
      [woId, `Reopened from ${cur[0].status}${cur[0].date_completed ? ` (completed ${cur[0].date_completed})` : ''}${reason ? ` — ${reason}` : ''}`, currentUsername()]
    );
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await logActivity({ action: 'reopened', entityType: 'work_order', entityId: Number(woId), entityLabel: cur[0].title });
  return getWorkOrder(woId);
}

// What was already recorded as left over at the last close, so re-closing ADJUSTS those
// numbers instead of adding a second "in" movement on top of them (§1).
export async function getRecordedLeftovers(workOrderId) {
  const { rows } = await pool.query(
    `SELECT m.material_id, mt.name, mt.unit,
            SUM(m.quantity) AS recorded,
            (SELECT unit_price FROM material_movements
             WHERE material_id = m.material_id AND work_order_id = $1 AND unit_price IS NOT NULL
             ORDER BY created_at DESC LIMIT 1) AS unit_price
     FROM material_movements m
     JOIN materials mt ON mt.id = m.material_id
     WHERE m.work_order_id = $1 AND m.kind IN ('wo_close','correction')
     GROUP BY m.material_id, mt.name, mt.unit`,
    [workOrderId]
  );
  return rows.map((r) => ({
    MaterialId: r.material_id, Name: r.name, Unit: r.unit,
    Recorded: Number(r.recorded),
    UnitPrice: r.unit_price != null ? Number(r.unit_price) : null,
  }));
}

// Re-close: the difference between what was recorded before and what is being recorded
// now is filed as a CORRECTION, so the balance ends up right and the history says why
// it moved — rather than a second wo_close doubling the stock.
export async function reconcileLeftoversOnReclose(workOrderId, leftovers, { createdBy } = {}) {
  const prior = new Map((await getRecordedLeftovers(workOrderId)).map((l) => [l.MaterialId, l]));
  const results = [];
  for (const l of leftovers) {
    const materialId = Number(l.materialId);
    const want = Number(l.quantity);
    if (!Number.isFinite(want) || want < 0) continue;
    const already = prior.get(materialId)?.Recorded ?? 0;
    const delta = Math.round((want - already) * 100) / 100;
    if (delta === 0) continue;
    await recordMaterialMovement({
      materialId,
      kind: already > 0 ? 'correction' : 'wo_close',
      quantity: delta,
      unitPrice: l.unitPrice ?? prior.get(materialId)?.UnitPrice ?? null,
      workOrderId,
      note: already > 0
        ? `Adjusted at re-close: ${already} → ${want}`
        : 'Left over at work order close',
      createdBy,
    });
    results.push({ MaterialId: materialId, From: already, To: want, Delta: delta });
  }
  return results;
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
    await changeWorkOrderStatus(client, woId, await resolveWorkOrderStatusId('Done'), {});
    await clearBoardFocusOnResolve(client, 'work_order', woId);
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

// WO-level assignVolunteer/assignVendor removed in Phase 1 — "assigned crew"
// is a job-line concept now (see assignVolunteerToJobLine and friends,
// above). Reassigning crew always happens through a specific line.

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
    `SELECT (SELECT count(*) FROM job_line_volunteers WHERE volunteer_id = $1)
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
    `SELECT (SELECT count(*) FROM job_line_vendors WHERE vendor_id = $1)
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
    Id: r.id, WorkOrderId: r.work_order_id, WorkOrderTitle: r.wo_title, JobLineId: r.job_line_id,
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
// jobLineId is optional (1.5) — the picker in the UI defaults to unset;
// genuine WO-level time (general site cleanup across several lines) should
// stay unattributed to any one line.
export async function createCrewSession({ workOrderId, jobLineId, activity, sessionDate, hours, note, volunteerIds = [], vendorIds = [] }) {
  if (!workOrderId && !activity) throw new Error('A session needs either a Work Order or an activity label');
  const client = await pool.connect();
  let sessionId;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO crew_sessions (work_order_id, job_line_id, activity, session_date, hours, note, username)
       VALUES ($1,$2,$3,COALESCE($4,CURRENT_DATE),$5,$6,$7) RETURNING id`,
      [workOrderId || null, jobLineId || null, activity || null, sessionDate || null, hours ?? null, note || null, currentUsername()]
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
    `SELECT a.id, a.name, a.asset_type, a.location_id, l.name AS location_name, a.lodge_holder, (a.map_x IS NOT NULL) AS on_map
     FROM assets a LEFT JOIN locations l ON l.id = a.location_id
     WHERE a.name ILIKE $1 ORDER BY a.name LIMIT 20`,
    [`%${q}%`]
  );
  return rows.map((r) => ({ Id: r.id, Name: r.name, assetType: r.asset_type, locationId: r.location_id, locationName: r.location_name, holderName: r.lodge_holder, onMap: r.on_map }));
}

// §9: the searchable combobox filters client-side, so the asset picker needs
// the whole list once per page rather than a server round-trip per keystroke.
// ~340 rows — small enough that paging it would cost more than it saves, and
// it's the same shape searchAssetsLive returns so both feed one component.
export async function listAllAssetsForPicker() {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.asset_type, a.location_id, l.name AS location_name, a.lodge_holder, (a.map_x IS NOT NULL) AS on_map
     FROM assets a LEFT JOIN locations l ON l.id = a.location_id ORDER BY a.name`
  );
  return rows.map((r) => ({ Id: r.id, Name: r.name, assetType: r.asset_type, locationId: r.location_id, locationName: r.location_name, holderName: r.lodge_holder, onMap: r.on_map }));
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

// ── Interactive Map — pins are assets with map_x/map_y set (image-pixel
//    coords on the base map image — see CAMP_MAP_IMAGE in public-pg/app.js
//    for the current file — not lat/lng). A pin's color is derived, never
//    stored — the worst OPEN condition_findings.severity for that asset —
//    but only when its layer has color_by_condition=true; otherwise it's a
//    flat layer color. Severity strings are "N - Label" (see
//    FINDING_SEVERITY_OPTIONS in pg-api.js); we sort/threshold on the
//    leading integer. Layers are user-managed rows in map_layers, never
//    hardcoded (see listMapLayers below) — a building pin references one
//    via assets.map_layer_id (defaulting to "Buildings"), and every
//    map_features point/line/zone via its own layer_id. ─────────────────
export async function listMapPins() {
  const { rows } = await pool.query(`
    SELECT a.id, a.name, a.asset_type, a.map_x, a.map_y, a.location_id, l.name AS location_name,
           a.map_layer_id, a.lodge_holder,
           cf.max_severity, cf.open_count,
           COALESCE(cf.any_focus, false) OR COALESCE(wo.any_focus, false) AS board_focus
    FROM assets a
    LEFT JOIN locations l ON l.id = a.location_id
    LEFT JOIN LATERAL (
      SELECT max(substring(severity from '^\d+')::int) AS max_severity,
             count(*) AS open_count,
             bool_or(board_focus) AS any_focus
      FROM condition_findings
      WHERE asset_id = a.id AND status = 'Open'
    ) cf ON true
    LEFT JOIN LATERAL (
      SELECT bool_or(w.board_focus) AS any_focus
      FROM work_orders w JOIN work_order_statuses ws ON ws.id = w.status_id
      WHERE w.asset_id = a.id AND NOT ws.is_terminal
    ) wo ON true
    WHERE a.map_x IS NOT NULL AND a.map_y IS NOT NULL
    ORDER BY a.name
  `);
  return rows.map((r) => ({
    ref: 'asset',
    id: r.id,
    name: r.name,
    category: r.asset_type,
    mapX: r.map_x,
    mapY: r.map_y,
    layerId: r.map_layer_id,
    locationId: r.location_id,
    locationName: r.location_name,
    holderName: r.lodge_holder,
    openFindingCount: Number(r.open_count) || 0,
    maxSeverity: r.max_severity, // 1-5 or null; frontend buckets into red/amber/green
    boardFocus: r.board_focus,
  }));
}

export async function setAssetMapLocation(assetId, { mapX, mapY, layerId }) {
  const { rows } = await pool.query(
    `UPDATE assets SET
       map_x = $2, map_y = $3,
       map_layer_id = COALESCE($4, map_layer_id, (SELECT id FROM map_layers WHERE name = 'Buildings' LIMIT 1)),
       updated_at = now()
     WHERE id = $1 RETURNING id, name, map_x, map_y, map_layer_id`,
    [assetId, mapX, mapY, layerId || null]
  );
  if (!rows[0]) return null;
  await logActivity({ action: mapX === null ? 'removed map pin for' : 'moved map pin for', entityType: 'asset', entityId: rows[0].id, entityLabel: rows[0].name });
  return { Id: rows[0].id, Name: rows[0].name, mapX: rows[0].map_x, mapY: rows[0].map_y, LayerId: rows[0].map_layer_id };
}

const MAP_FEATURE_KINDS = new Set(['point', 'line', 'zone']);
const MAP_FEATURE_SELECT = `
  SELECT f.id, f.kind, f.label, f.points, f.asset_id, f.style, f.layer_id,
         a.name AS asset_name, a.lodge_holder,
         cf.max_severity, cf.open_count,
         COALESCE(cf.any_focus, false) OR COALESCE(wo.any_focus, false) AS board_focus
  FROM map_features f
  LEFT JOIN assets a ON a.id = f.asset_id
  LEFT JOIN LATERAL (
    SELECT max(substring(severity from '^\\d+')::int) AS max_severity,
           count(*) AS open_count,
           bool_or(board_focus) AS any_focus
    FROM condition_findings
    WHERE asset_id = f.asset_id AND status = 'Open'
  ) cf ON true
  LEFT JOIN LATERAL (
    SELECT bool_or(w.board_focus) AS any_focus
    FROM work_orders w JOIN work_order_statuses ws ON ws.id = w.status_id
    WHERE w.asset_id = f.asset_id AND NOT ws.is_terminal
  ) wo ON true
`;
function formatMapFeatureRow(r) {
  return {
    Id: r.id, Kind: r.kind, Label: r.label, Points: r.points, AssetId: r.asset_id, Style: r.style, LayerId: r.layer_id,
    AssetName: r.asset_name, HolderName: r.lodge_holder,
    OpenFindingCount: Number(r.open_count) || 0, MaxSeverity: r.max_severity, BoardFocus: r.board_focus,
  };
}
async function getMapFeatureFull(id) {
  const { rows } = await pool.query(`${MAP_FEATURE_SELECT} WHERE f.id = $1`, [id]);
  return rows[0] ? formatMapFeatureRow(rows[0]) : null;
}

export async function listMapFeatures() {
  const { rows } = await pool.query(`${MAP_FEATURE_SELECT} ORDER BY f.id`);
  return rows.map(formatMapFeatureRow);
}

export async function createMapFeature({ kind, label, points, assetId, style, layerId }) {
  if (!kind || !MAP_FEATURE_KINDS.has(kind) || !points) { const err = new Error('kind (point, line, or zone) and points are required'); err.status = 400; throw err; }
  const { rows } = await pool.query(
    `INSERT INTO map_features (kind, label, points, asset_id, style, layer_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [kind, label || null, JSON.stringify(points), assetId || null, style ? JSON.stringify(style) : null, layerId || null]
  );
  const full = await getMapFeatureFull(rows[0].id);
  await logActivity({ action: 'created', entityType: 'map_feature', entityId: full.Id, entityLabel: full.Label || full.Kind });
  return full;
}

// Partial update — only columns whose key is present in `patch` are
// touched. A drag-end PATCH that sends only {points} can never silently
// wipe assetId/layerId (the previous asset_id=$n / always-overwrite version
// did exactly that on every points-only save), and an explicit null (unlink
// asset, clear layer) is distinguishable from "field not sent" this way.
export async function updateMapFeature(id, patch) {
  const sets = [];
  const vals = [id];
  const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
  if ('kind' in patch) {
    if (!MAP_FEATURE_KINDS.has(patch.kind)) { const err = new Error('kind must be point, line, or zone'); err.status = 400; throw err; }
    add('kind', patch.kind);
  }
  if ('label' in patch) add('label', patch.label ?? null);
  if ('points' in patch) add('points', patch.points ? JSON.stringify(patch.points) : null);
  if ('assetId' in patch) add('asset_id', patch.assetId ?? null);
  if ('style' in patch) add('style', patch.style ? JSON.stringify(patch.style) : null);
  if ('layerId' in patch) add('layer_id', patch.layerId ?? null);
  if (sets.length) {
    sets.push('updated_at = now()');
    const { rows } = await pool.query(`UPDATE map_features SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, vals);
    if (!rows[0]) return null;
  } else {
    const { rows } = await pool.query('SELECT id FROM map_features WHERE id = $1', [id]);
    if (!rows[0]) return null;
  }
  const full = await getMapFeatureFull(id);
  await logActivity({ action: 'updated', entityType: 'map_feature', entityId: full.Id, entityLabel: full.Label || full.Kind });
  return full;
}

export async function deleteMapFeature(id) {
  const { rows } = await pool.query('DELETE FROM map_features WHERE id = $1 RETURNING kind, label', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'map_feature', entityId: Number(id), entityLabel: rows[0].label || rows[0].kind });
}

// ── Map layers — user-defined, not hardcoded. "Add a layer" is a row
//    insert; recoloring/reordering/hiding/deleting is an update on that
//    row. Deleting a layer just orphans its features/pins (layer_id/
//    map_layer_id -> null via FK ON DELETE SET NULL) rather than blocking
//    or cascading — they keep showing, just unlabeled, until reassigned. ──
const MAP_LAYER_GEOMETRIES = new Set(['point', 'line', 'zone', 'mixed']);
function formatMapLayerRow(r) {
  return {
    Id: r.id, Name: r.name, Geometry: r.geometry, Color: r.color, Icon: r.icon,
    ZIndex: r.z_index, DefaultVisible: r.default_visible, ColorByCondition: r.color_by_condition,
  };
}

export async function listMapLayers() {
  const { rows } = await pool.query('SELECT * FROM map_layers ORDER BY z_index, id');
  return rows.map(formatMapLayerRow);
}

export async function createMapLayer({ name, geometry, color, icon, zIndex, defaultVisible, colorByCondition }) {
  if (!name || !name.trim()) { const err = new Error('name is required'); err.status = 400; throw err; }
  const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(z_index), 0) + 10 AS next FROM map_layers');
  const { rows } = await pool.query(
    `INSERT INTO map_layers (name, geometry, color, icon, z_index, default_visible, color_by_condition)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      name.trim(),
      MAP_LAYER_GEOMETRIES.has(geometry) ? geometry : 'point',
      color || '#2b6cb0',
      icon || null,
      zIndex ?? maxRows[0].next,
      defaultVisible !== false,
      !!colorByCondition,
    ]
  );
  await logActivity({ action: 'created', entityType: 'map_layer', entityId: rows[0].id, entityLabel: rows[0].name });
  return formatMapLayerRow(rows[0]);
}

export async function updateMapLayer(id, patch) {
  const sets = [];
  const vals = [id];
  const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
  if ('name' in patch) {
    if (!patch.name || !patch.name.trim()) { const err = new Error('name is required'); err.status = 400; throw err; }
    add('name', patch.name.trim());
  }
  if ('geometry' in patch) add('geometry', MAP_LAYER_GEOMETRIES.has(patch.geometry) ? patch.geometry : 'point');
  if ('color' in patch) add('color', patch.color);
  if ('icon' in patch) add('icon', patch.icon ?? null);
  if ('zIndex' in patch) add('z_index', patch.zIndex);
  if ('defaultVisible' in patch) add('default_visible', !!patch.defaultVisible);
  if ('colorByCondition' in patch) add('color_by_condition', !!patch.colorByCondition);
  if (!sets.length) {
    const { rows } = await pool.query('SELECT * FROM map_layers WHERE id = $1', [id]);
    return rows[0] ? formatMapLayerRow(rows[0]) : null;
  }
  sets.push('updated_at = now()');
  const { rows } = await pool.query(`UPDATE map_layers SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
  if (!rows[0]) return null;
  await logActivity({ action: 'updated', entityType: 'map_layer', entityId: rows[0].id, entityLabel: rows[0].name });
  return formatMapLayerRow(rows[0]);
}

export async function deleteMapLayer(id) {
  const { rows } = await pool.query('DELETE FROM map_layers WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'map_layer', entityId: Number(id), entityLabel: rows[0].name });
}

// ── Job Lines — the unit of work (Build Brief v2, Phase 1). Hours, cost,
//    funding, responsibility, scope, and scheduling all live here now;
//    work_orders holds only what's true of the whole job (asset, location,
//    priority, status) and rolls its lines up on read via workOrderRollup().
//    Distinct from asset_updates, which is the separate, optional "this WO
//    also changes an asset property field" mechanism — audit-style fields
//    (Has Key, Window Count, ...) stay reserved for the audit flow. ─────────

function jobLineRowShape(r) {
  return {
    Id: r.id, WorkOrderId: r.work_order_id, Title: r.title, SortOrder: r.sort_order,
    StatusId: r.status_id, ResponsibilityClass: r.responsibility_class,
    FundingSource: r.funding_source, FundingRefId: r.funding_ref_id,
    EstimatedHours: r.estimated_hours != null ? Number(r.estimated_hours) : null,
    ActualHours: r.actual_hours != null ? Number(r.actual_hours) : null,
    EstimatedCost: r.estimated_cost != null ? Number(r.estimated_cost) : null,
    ActualCost: r.actual_cost != null ? Number(r.actual_cost) : null,
    ScheduledDate: r.scheduled_date,
    ScheduledStartTime: r.scheduled_start_time, ScheduledDurationHours: r.scheduled_duration_hours != null ? Number(r.scheduled_duration_hours) : null,
    Complaint: r.complaint, CauseNote: r.cause_note, Correction: r.correction,
    BlockedReason: r.blocked_reason, BlockedSince: r.blocked_since, CompletedDate: r.completed_date,
    ConditionFindingId: r.condition_finding_id,
    // Grid-only rendering metadata (§3): which cascade columns this line had
    // PINNED when it was last saved. The real columns above are always fully
    // stamped, so nothing outside the grid ever needs to read this.
    PinnedFields: Array.isArray(r.pinned_fields) ? r.pinned_fields : [],
  };
}

// One line's full detail — used by the job-line edit form, which needs the
// funding label, status flags, cause names, and assigned crew alongside the
// bare columns.
async function hydrateJobLine(row) {
  const shaped = jobLineRowShape(row);
  const [fundingRefLabel, statusRows, causes, assignees, expenseAgg] = await Promise.all([
    getFundingRefLabel(row.funding_source, row.funding_ref_id),
    pool.query('SELECT name, color, is_terminal, counts_as_work_performed, requires_note, note_label FROM job_line_statuses WHERE id = $1', [row.status_id]),
    pool.query(`SELECT c.id, c.name FROM job_line_causes jlc JOIN causes c ON c.id = jlc.cause_id WHERE jlc.job_line_id = $1 ORDER BY c.sort_order, c.name`, [row.id]),
    getJobLineAssignees(row.id),
    // Build Brief v3 Part 5: the Actual Cost INPUT stays the raw manual
    // column (jobLineRowShape above) — same as Actual Hours — but the edit
    // form still needs to show what's linked, so it's surfaced separately
    // here rather than folded into ActualCost itself.
    pool.query(`SELECT count(*) AS n, COALESCE(SUM(ea.amount), 0) AS total
                FROM expense_allocations ea JOIN expenses e ON e.id = ea.expense_id
                WHERE ea.dest_type = 'job_line' AND ea.dest_id = $1
                  AND e.triage_status != 'void' AND e.deleted_at IS NULL`, [row.id]),
  ]);
  const s = statusRows.rows[0] || {};
  return {
    ...shaped, FundingRefLabel: fundingRefLabel,
    StatusName: s.name, StatusColor: s.color, StatusIsTerminal: s.is_terminal,
    StatusCountsAsWorkPerformed: s.counts_as_work_performed,
    Causes: causes.rows.map((c) => ({ Id: c.id, Name: c.name })), ...assignees,
    LinkedExpenseCount: Number(expenseAgg.rows[0].n), LinkedExpenseTotal: Number(expenseAgg.rows[0].total),
  };
}

export async function listJobLines(woId) {
  const { rows } = await pool.query('SELECT * FROM job_lines WHERE work_order_id = $1 ORDER BY sort_order, id', [woId]);
  return Promise.all(rows.map(hydrateJobLine));
}

export async function getJobLine(id) {
  const { rows } = await pool.query('SELECT * FROM job_lines WHERE id = $1', [id]);
  return rows[0] ? hydrateJobLine(rows[0]) : null;
}

// Creation only takes the fields the field-capture flow (1.7) actually asks
// for at WO-creation time; complaint/cause/correction are filled in later,
// during/after the work (1.6), through updateJobLine. Every new line starts
// 'Not Started' — status changes from there go through changeJobLineStatus.
export async function createJobLine(woId, {
  title, responsibilityClass = 'self', fundingSource = 'operating_budget', fundingRefId = null,
  estimatedHours = null, estimatedCost = null, scheduledDate = null, conditionFindingId = null,
}) {
  const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM job_lines WHERE work_order_id = $1', [woId]);
  const { rows } = await pool.query(
    `INSERT INTO job_lines (work_order_id, title, sort_order, responsibility_class, funding_source, funding_ref_id, estimated_hours, estimated_cost, scheduled_date, condition_finding_id, status_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(SELECT id FROM job_line_statuses WHERE name = 'Not Started')) RETURNING *`,
    [woId, title, maxRows[0].next, responsibilityClass, fundingSource, fundingRefId, estimatedHours, estimatedCost, scheduledDate, conditionFindingId]
  );
  // A line created with a scheduled_date already set (e.g. from a template,
  // or Create WO from Findings) needs to reach the sync worker on day one —
  // otherwise it'd sit invisible on Google's calendar until its next edit
  // through updateJobLine, which is the only other place this gets queued.
  if (scheduledDate) await queueGcalSync(pool, 'job_line', rows[0].id);
  if (conditionFindingId) await autoScheduleFindingIfLinked(pool, conditionFindingId);
  await logActivity({ action: 'created', entityType: 'job_line', entityId: rows[0].id, entityLabel: rows[0].title, details: `On Work Order #${woId}` });
  return hydrateJobLine(rows[0]);
}

// Phase 3 (3): a finding moves Open -> Scheduled the moment a job line links
// to it — automatic, no note, because linking IS the decision (something is
// now going to happen to it). Only fires from Open; a finding already
// Resolved/Deferred/Dismissed doesn't get silently reopened by a later link.
// A featured flag clears itself the moment the thing stops being outstanding (§2).
// Recorded in the work order's log where there is one, so the flag disappearing is
// explained rather than just noticed.
async function clearBoardFocusOnResolve(client, kind, id) {
  if (kind === 'job_line') {
    const { rows } = await client.query(
      `UPDATE job_lines SET board_focus = false, board_focus_set_at = NULL
       WHERE id = $1 AND board_focus RETURNING work_order_id, title`, [id]
    );
    if (rows[0]) {
      await client.query(
        `INSERT INTO work_order_log_entries (work_order_id, note, username) VALUES ($1,$2,$3)`,
        [rows[0].work_order_id, `Board feature cleared automatically — "${rows[0].title}" was completed`, currentUsername()]
      );
    }
    return;
  }
  if (kind === 'work_order') {
    const { rows } = await client.query(
      `UPDATE work_orders SET board_focus = false, board_focus_set_at = NULL
       WHERE id = $1 AND board_focus RETURNING id`, [id]
    );
    if (rows[0]) {
      await client.query(
        `INSERT INTO work_order_log_entries (work_order_id, note, username) VALUES ($1,$2,$3)`,
        [id, 'Board feature cleared automatically — work order completed', currentUsername()]
      );
    }
    return;
  }
  if (kind === 'finding') {
    await client.query(
      `UPDATE condition_findings SET board_focus = false, board_focus_set_at = NULL
       WHERE id = $1 AND board_focus`, [id]
    );
  }
}

async function autoScheduleFindingIfLinked(queryable, findingId) {
  await queryable.query(`UPDATE condition_findings SET status = 'Scheduled' WHERE id = $1 AND status = 'Open'`, [findingId]);
}

// Phase 3 (3): a finding moves to Resolved automatically the instant its
// linked job line reaches a counts_as_work_performed status — no manual
// step, no note (this isn't a "decision," it's a consequence of the work
// itself being done). Fires regardless of the finding's current status,
// matching the brief's table exactly ("Resolved — auto — when its job line
// reaches a counts_as_work_performed status").
async function autoResolveLinkedFinding(client, jobLineId) {
  const { rows } = await client.query('SELECT condition_finding_id FROM job_lines WHERE id = $1', [jobLineId]);
  const findingId = rows[0]?.condition_finding_id;
  if (!findingId) return;
  await clearBoardFocusOnResolve(client, 'finding', findingId);
  const { rows: curRows } = await client.query('SELECT status, gcal_event_id FROM condition_findings WHERE id = $1', [findingId]);
  const cur = curRows[0];
  await client.query(`UPDATE condition_findings SET status = 'Resolved' WHERE id = $1`, [findingId]);
  if (cur?.status === 'Deferred') {
    // This fires "regardless of the finding's current status" (see this
    // function's own header comment) — including straight out of Deferred,
    // which needs the same revisit-event teardown a manual dismiss/WO status
    // change gets. Auto-resolve is a real exit from Deferred, not a no-op.
    await queueGcalDelete(cur.gcal_event_id);
    await client.query('UPDATE condition_findings SET gcal_event_id = NULL WHERE id = $1', [findingId]);
    await client.query('DELETE FROM gcal_pending_syncs WHERE entity_type = $1 AND entity_id = $2', ['finding_revisit', findingId]);
  }
}

// Every job-line status transition writes a work_order_log_entries row
// (2.4) — same unconditional-logging rule as work orders. requires_note
// (2.1) blocks the save without an answer to note_label, since a contextual
// question gets answered but a generic empty box doesn't. counts_as_work_
// performed statuses stamp completed_date once (never overwritten here —
// see updateJobLine for the explicit-edit path). work_order_log_entries has
// no job_line_id column live yet (migration 0037 pending — see
// update-for-claude.md), so the line's title is folded into the note text
// instead of a structured link, for now.
async function changeJobLineStatus(client, jobLineId, newStatusId, { statusNote } = {}) {
  const { rows: curRows } = await client.query(
    `SELECT jl.status_id, jl.title, jl.work_order_id, jl.completed_date, s.name AS old_name
     FROM job_lines jl JOIN job_line_statuses s ON s.id = jl.status_id WHERE jl.id = $1`,
    [jobLineId]
  );
  const cur = curRows[0];
  if (!cur) { const e = new Error('Job line not found'); e.status = 404; throw e; }
  if (cur.status_id === newStatusId) return;
  const { rows: newRows } = await client.query(
    'SELECT name, requires_note, note_label, counts_as_work_performed FROM job_line_statuses WHERE id = $1', [newStatusId]
  );
  const newStatus = newRows[0];
  if (!newStatus) { const e = new Error('Unknown job line status'); e.status = 400; throw e; }
  if (newStatus.requires_note && !statusNote?.trim()) {
    const e = new Error(newStatus.note_label || `A note is required to mark this line "${newStatus.name}"`); e.status = 400; throw e;
  }
  const setCols = ['status_id = $2'];
  const vals = [jobLineId, newStatusId];
  // completed_at is when the STATUS changed, which is not the same fact as when the
  // work happened — it exists so a line entered in arrears with the date left blank
  // still has something to order and include by (§3).
  if (newStatus.counts_as_work_performed) setCols.push('completed_at = COALESCE(completed_at, now())');
  if (newStatus.counts_as_work_performed && !cur.completed_date) {
    setCols.push('completed_date = CURRENT_DATE');
  }
  await client.query(`UPDATE job_lines SET ${setCols.join(', ')} WHERE id = $1`, vals);
  if (newStatus.counts_as_work_performed) {
    await autoResolveLinkedFinding(client, jobLineId);
    // The featured flag means "the board should see this because it is outstanding".
    // Once it is done it stops being outstanding and appears in Done through the
    // ordinary rule, so the flag clears itself rather than lingering (§2).
    await clearBoardFocusOnResolve(client, 'job_line', jobLineId);
  }
  const noteText = statusNote?.trim()
    ? `Job line "${cur.title}" → ${newStatus.name}: ${statusNote.trim()}`
    : `Job line "${cur.title}" status: ${cur.old_name} → ${newStatus.name}`;
  await client.query(
    'INSERT INTO work_order_log_entries (work_order_id, note, status_change, username) VALUES ($1,$2,$3,$4)',
    [cur.work_order_id, noteText, newStatus.name, currentUsername()]
  );
}

// Build Brief v4 Part 1 groundwork: records that an entity's calendar-
// relevant fields changed, for the step-3 sync worker (not built yet) to
// pick up later — see migration 0062's header comment. One row per entity;
// a second change before the worker gets to it just bumps queued_at rather
// than piling up duplicates, since the worker only needs to see the
// current state once, not every intermediate edit.
async function queueGcalSync(queryable, entityType, entityId) {
  await queryable.query(
    `INSERT INTO gcal_pending_syncs (entity_type, entity_id) VALUES ($1,$2)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET queued_at = now(), attempts = 0, next_attempt_at = now(), last_error = NULL`,
    [entityType, entityId]
  );
}

// Delete-side counterpart, migration 0063: by the time a job_line/
// calendar_event row is actually gone, there's nothing left to re-query for
// a Google event id, so deleteJobLine/deleteCalendarEvent capture it in the
// same statement that deletes the row and hand it straight here. A line/
// event that was never synced (gcalEventId null — e.g. deleted before the
// worker ever ran) has nothing on Google to clean up.
async function queueGcalDelete(gcalEventId) {
  if (!gcalEventId) return;
  await pool.query('INSERT INTO gcal_pending_deletes (gcal_event_id) VALUES ($1)', [gcalEventId]);
}

const JOB_LINE_UPDATE_COLUMNS = [
  'title', 'responsibility_class', 'funding_source', 'funding_ref_id',
  'estimated_hours', 'actual_hours', 'estimated_cost', 'actual_cost', 'scheduled_date',
  'scheduled_start_time', 'scheduled_duration_hours',
  'complaint', 'cause_note', 'correction', 'blocked_reason', 'blocked_since', 'completed_date',
  'condition_finding_id',
];
// Any of these changing is a calendar-visible move — the job-line edit
// form's Scheduled Date field and the Calendar's drag-to-reschedule both
// go through this same function, so queuing the sync once here (rather
// than at each call site) means neither path can forget to.
const JOB_LINE_SCHEDULE_COLUMNS = ['scheduled_date', 'scheduled_start_time', 'scheduled_duration_hours'];
export async function updateJobLine(id, fields) {
  const setCols = []; const vals = []; let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'causeIds' || key === 'status_id' || key === 'statusNote') continue; // handled separately below
    if (!JOB_LINE_UPDATE_COLUMNS.includes(key)) continue;
    setCols.push(`${key} = $${i++}`);
    vals.push(value === '' ? null : value);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existsRows } = await client.query('SELECT id FROM job_lines WHERE id = $1', [id]);
    if (!existsRows.length) { await client.query('ROLLBACK'); return null; }
    if (setCols.length) {
      vals.push(id);
      await client.query(`UPDATE job_lines SET ${setCols.join(', ')} WHERE id = $${i}`, vals);
    }
    if (JOB_LINE_SCHEDULE_COLUMNS.some((c) => c in fields)) {
      await queueGcalSync(client, 'job_line', Number(id));
    }
    if (fields.status_id != null) {
      await changeJobLineStatus(client, id, Number(fields.status_id), { statusNote: fields.statusNote });
    }
    if (fields.condition_finding_id) {
      await autoScheduleFindingIfLinked(client, fields.condition_finding_id);
    }
    if (fields.causeIds !== undefined) {
      await client.query('DELETE FROM job_line_causes WHERE job_line_id = $1', [id]);
      for (const causeId of fields.causeIds || []) {
        await client.query('INSERT INTO job_line_causes (job_line_id, cause_id) VALUES ($1,$2)', [id, causeId]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const { rows } = await pool.query('SELECT * FROM job_lines WHERE id = $1', [id]);
  await logActivity({ action: 'updated', entityType: 'job_line', entityId: rows[0].id, entityLabel: rows[0].title });
  return hydrateJobLine(rows[0]);
}
export async function deleteJobLine(id) {
  const { rows } = await pool.query('DELETE FROM job_lines WHERE id = $1 RETURNING title, work_order_id, gcal_event_id', [id]);
  if (!rows[0]) return;
  await queueGcalDelete(rows[0].gcal_event_id);
  await pool.query('DELETE FROM gcal_pending_syncs WHERE entity_type = $1 AND entity_id = $2', ['job_line', Number(id)]);
  await logActivity({ action: 'deleted', entityType: 'job_line', entityId: Number(id), entityLabel: rows[0].title, details: `On Work Order #${rows[0].work_order_id}` });
}

// ── Job Line Grid (Build Brief: grid / CSV import / templates) ────────────
//
// The grid is an ENTRY surface, not a storage model. Everything it does with
// cascade/pin state resolves to fully stamped column values before it ever
// reaches Postgres (§3's save semantics) — a report, a PDF, or a five-year-old
// work order never has to know cascade exists. pinned_fields is carried along
// purely so reopening the same WO in the grid can redraw which cells were
// following and which were pinned.

// pinned_fields is rendering metadata, so it gets the same treatment as any
// other client-supplied blob: only known cascade column names survive.
function sanitizePinnedFields(fields) {
  if (!Array.isArray(fields)) return [];
  return [...new Set(fields.filter((f) => CASCADE_COLUMNS.includes(f)))];
}

// A line may be created directly into any status (arrears entry). Falls back
// to the catalog's first non-terminal status rather than the literal name
// 'Not Started', which is admin-renameable like every other status.
async function resolveInitialJobLineStatus(queryable, statusId) {
  if (statusId != null && statusId !== '') {
    const { rows } = await queryable.query('SELECT id FROM job_line_statuses WHERE id = $1', [Number(statusId)]);
    if (rows[0]) return rows[0].id;
  }
  const { rows } = await queryable.query(
    `SELECT id FROM job_line_statuses WHERE active ORDER BY is_terminal, sort_order, id LIMIT 1`
  );
  if (!rows[0]) { const e = new Error('No active job line status is configured'); e.status = 500; throw e; }
  return rows[0].id;
}

const GRID_LINE_COLUMNS = {
  title: 'title', responsibilityClass: 'responsibility_class', fundingSource: 'funding_source',
  fundingRefId: 'funding_ref_id', estimatedHours: 'estimated_hours', estimatedCost: 'estimated_cost',
  scheduledDate: 'scheduled_date',
};

// Grid save for an EXISTING work order. One transaction: lines the grid knew
// about but no longer sends are deleted, lines with an id are updated in
// place (keeping their crew, photos, expenses and log history), lines without
// one are inserted, and sort_order is rewritten to the grid's row order.
//
// `knownLineIds` is what the grid loaded when it opened. Only lines in that
// set are eligible for deletion — a line added from the card view in another
// tab while the grid sat open is left alone instead of being silently
// destroyed by a stale payload.
export async function replaceWorkOrderJobLines(woId, lines = [], { knownLineIds = null } = {}) {
  const client = await pool.connect();
  const gcalDeletes = [];
  const gcalSyncs = [];
  try {
    await client.query('BEGIN');
    const { rows: woRows } = await client.query('SELECT id FROM work_orders WHERE id = $1', [woId]);
    if (!woRows.length) { await client.query('ROLLBACK'); return null; }

    const { rows: existingRows } = await client.query(
      'SELECT id, status_id, scheduled_date, scheduled_start_time, scheduled_duration_hours FROM job_lines WHERE work_order_id = $1', [woId]
    );
    const existing = new Map(existingRows.map((r) => [r.id, r]));
    const keptIds = new Set(lines.map((l) => Number(l.id)).filter((n) => Number.isInteger(n)));
    const deletable = knownLineIds ? new Set(knownLineIds.map(Number)) : new Set(existing.keys());

    for (const row of existingRows) {
      if (keptIds.has(row.id) || !deletable.has(row.id)) continue;
      const { rows: delRows } = await client.query(
        'DELETE FROM job_lines WHERE id = $1 RETURNING title, gcal_event_id', [row.id]
      );
      await client.query('DELETE FROM gcal_pending_syncs WHERE entity_type = $1 AND entity_id = $2', ['job_line', row.id]);
      if (delRows[0]?.gcal_event_id) gcalDeletes.push(delRows[0].gcal_event_id);
      await logActivity({ action: 'deleted', entityType: 'job_line', entityId: row.id, entityLabel: delRows[0]?.title, details: `On Work Order #${woId}` });
    }

    let sortOrder = 0;
    for (const line of lines) {
      const title = String(line?.title ?? '').trim();
      if (!title) continue; // §2: rows with an empty title are silently dropped
      const pinned = JSON.stringify(sanitizePinnedFields(line.pinnedFields));
      const id = Number.isInteger(Number(line.id)) && existing.has(Number(line.id)) ? Number(line.id) : null;

      if (id == null) {
        const statusId = await resolveInitialJobLineStatus(client, line.statusId);
        const { rows } = await client.query(
          `INSERT INTO job_lines (work_order_id, title, sort_order, responsibility_class, funding_source, funding_ref_id,
             estimated_hours, estimated_cost, scheduled_date, status_id, pinned_fields, completed_date, completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             CASE WHEN (SELECT counts_as_work_performed FROM job_line_statuses WHERE id = $10) THEN CURRENT_DATE ELSE NULL END,
             CASE WHEN (SELECT counts_as_work_performed FROM job_line_statuses WHERE id = $10) THEN now() ELSE NULL END)
           RETURNING id, scheduled_date`,
          [woId, title, sortOrder++, line.responsibilityClass || 'self', line.fundingSource || 'operating_budget',
            numOrNull(line.fundingRefId), numOrNull(line.estimatedHours), numOrNull(line.estimatedCost),
            line.scheduledDate || null, statusId, pinned]
        );
        await logActivity({ action: 'created', entityType: 'job_line', entityId: rows[0].id, entityLabel: title, details: `On Work Order #${woId}` });
        if (rows[0].scheduled_date) gcalSyncs.push(rows[0].id);
        continue;
      }

      const prev = existing.get(id);
      await client.query(
        `UPDATE job_lines SET title = $2, responsibility_class = $3, funding_source = $4, funding_ref_id = $5,
           estimated_hours = $6, estimated_cost = $7, scheduled_date = $8, sort_order = $9, pinned_fields = $10
         WHERE id = $1`,
        [id, title, line.responsibilityClass || 'self', line.fundingSource || 'operating_budget',
          numOrNull(line.fundingRefId), numOrNull(line.estimatedHours), numOrNull(line.estimatedCost),
          line.scheduledDate || null, sortOrder++, pinned]
      );
      // A saved line's status change IS a lifecycle transition, so it goes
      // through changeJobLineStatus — requires_note is enforced and the work
      // log gets its row, exactly as it would from the card view (§2).
      if (line.statusId != null && Number(line.statusId) !== prev.status_id) {
        await changeJobLineStatus(client, id, Number(line.statusId), { statusNote: line.statusNote });
      }
      if (String(prev.scheduled_date ?? '') !== String(line.scheduledDate || '')) gcalSyncs.push(id);
    }

    for (const lineId of gcalSyncs) await queueGcalSync(client, 'job_line', lineId);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  for (const eventId of gcalDeletes) await queueGcalDelete(eventId);
  return listJobLines(woId);
}

const numOrNull = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

// §7: drag/Alt-arrow reorder from the grid, and the mobile reorder sheet,
// both land here. Ids not on this WO are ignored; any line the caller left
// out keeps its relative position after the ones it did send.
export async function reorderJobLines(woId, orderedIds = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id FROM job_lines WHERE work_order_id = $1 ORDER BY sort_order, id', [woId]);
    const valid = new Set(rows.map((r) => r.id));
    const ordered = orderedIds.map(Number).filter((id) => valid.has(id));
    const rest = rows.map((r) => r.id).filter((id) => !ordered.includes(id));
    const final = [...ordered, ...rest];
    for (let i = 0; i < final.length; i++) {
      await client.query('UPDATE job_lines SET sort_order = $2 WHERE id = $1', [final[i], i]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return listJobLines(woId);
}

export async function setWorkOrderCascadeConfig(woId, cascadeConfig) {
  const normalized = normalizeCascadeConfig(cascadeConfig);
  const { rows } = await pool.query(
    'UPDATE work_orders SET cascade_config = $2 WHERE id = $1 RETURNING cascade_config',
    [woId, normalized ? JSON.stringify(normalized) : null]
  );
  if (!rows[0]) return null;
  return { CascadeConfig: normalizeCascadeConfig(rows[0].cascade_config) };
}

// §10: after a save, should we offer to move this WO to Review? Yes when
// every line is in a resolved (is_terminal) status and the WO itself is
// neither already in review nor already terminal. This only ever produces a
// PROMPT — nothing here changes a status, and closing stays manual.
export async function getWorkOrderReviewPrompt(woId) {
  const [gate, woRes, reviewRes] = await Promise.all([
    workOrderCloseGate(woId),
    pool.query(
      `SELECT ws.name AS status_name, ws.is_terminal, ws.is_review
       FROM work_orders w JOIN work_order_statuses ws ON ws.id = w.status_id WHERE w.id = $1`, [woId]
    ),
    pool.query('SELECT id, name FROM work_order_statuses WHERE is_review AND active ORDER BY sort_order, id LIMIT 1'),
  ]);
  const wo = woRes.rows[0];
  const review = reviewRes.rows[0];
  if (!wo) return null;
  return {
    AllLinesResolved: gate.ReadyToClose,
    LineCount: gate.LineCount,
    ReviewStatus: review ? { Id: review.id, Name: review.name } : null,
    ShouldPrompt: !!(gate.ReadyToClose && review && !wo.is_review && !wo.is_terminal),
  };
}

// ── Work Order template lines (§8) ───────────────────────────────────────
//
// work_order_template_lines replaced the old job_line_defaults JSONB in
// migration 0071 (see its header). Templates deliberately carry NO dates —
// a template says what work is done, never when.

async function templateLines(templateId) {
  const { rows } = await pool.query(
    'SELECT * FROM work_order_template_lines WHERE template_id = $1 ORDER BY sort_index, id', [templateId]
  );
  return rows.map((r) => ({
    Id: r.id, SortIndex: r.sort_index, Title: r.title,
    ResponsibilityClass: r.responsibility_class, FundingSource: r.funding_source, FundingRefId: r.funding_ref_id,
    EstimatedHours: r.estimated_hours != null ? Number(r.estimated_hours) : null,
    EstimatedCost: r.estimated_cost != null ? Number(r.estimated_cost) : null,
  }));
}

async function writeTemplateLines(client, templateId, lines) {
  await client.query('DELETE FROM work_order_template_lines WHERE template_id = $1', [templateId]);
  let i = 0;
  for (const line of lines) {
    const title = String(line?.title ?? '').trim();
    if (!title) continue;
    await client.query(
      `INSERT INTO work_order_template_lines (template_id, sort_index, title, responsibility_class, funding_source, funding_ref_id, estimated_hours, estimated_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [templateId, i++, title, line.responsibilityClass || null, line.fundingSource || null,
        numOrNull(line.fundingRefId), numOrNull(line.estimatedHours), numOrNull(line.estimatedCost)]
    );
  }
}

// Turns a template into the exact line set the grid (or the scheduler) should
// get. §8's rule, identical to import's (§5): a template cell WITH a value
// arrives pinned; a blank one follows row 1. Dates are never in a template,
// so scheduled_date always follows.
function resolveTemplateLines(lines, { defaultResponsibilityClass } = {}) {
  return lines.map((l) => {
    const responsibilityClass = l.ResponsibilityClass || defaultResponsibilityClass || null;
    const pinnedFields = [];
    if (responsibilityClass) pinnedFields.push('responsibility_class');
    if (l.FundingSource) pinnedFields.push('funding_source');
    return {
      title: l.Title,
      responsibilityClass: responsibilityClass || 'self',
      fundingSource: l.FundingSource || 'operating_budget',
      fundingRefId: l.FundingRefId ?? null,
      estimatedHours: l.EstimatedHours, estimatedCost: l.EstimatedCost,
      scheduledDate: null,
      pinnedFields,
    };
  });
}

// §8's "Save as template": snapshots a WO's lines. Statuses and dates are
// deliberately NOT captured — a template describes work, not its progress or
// its calendar.
export async function saveWorkOrderAsTemplate(woId, { name, description } = {}) {
  const { rows: woRows } = await pool.query('SELECT title, priority, description FROM work_orders WHERE id = $1', [woId]);
  const wo = woRows[0];
  if (!wo) { const e = new Error('Work Order not found'); e.status = 404; throw e; }
  const { rows: lineRows } = await pool.query(
    `SELECT title, responsibility_class, funding_source, funding_ref_id, estimated_hours, estimated_cost
     FROM job_lines WHERE work_order_id = $1 ORDER BY sort_order, id`, [woId]
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO work_order_templates (name, description, default_title, default_priority, default_description)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [String(name || '').trim() || wo.title, description || null, wo.title, wo.priority, wo.description]
    );
    await writeTemplateLines(client, rows[0].id, lineRows.map((r) => ({
      title: r.title, responsibilityClass: r.responsibility_class, fundingSource: r.funding_source,
      fundingRefId: r.funding_ref_id, estimatedHours: r.estimated_hours, estimatedCost: r.estimated_cost,
    })));
    await client.query('COMMIT');
    await logActivity({ action: 'created', entityType: 'work_order_template', entityId: rows[0].id, entityLabel: rows[0].name, details: `Saved from Work Order #${woId}` });
    return { ...templateRowShape(rows[0]), Lines: await templateLines(rows[0].id) };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Causes catalog (1.6) — admin-editable dropdown that gets counted.
//    cause_note (freetext) is what gets read; the two never mix — nothing
//    here ever promotes freetext into this table. ──────────────────────────
export async function listCauses({ includeInactive = false } = {}) {
  const { rows } = await pool.query(`SELECT id, name, sort_order, active FROM causes ${includeInactive ? '' : 'WHERE active'} ORDER BY sort_order, name`);
  return rows.map((r) => ({ Id: r.id, Name: r.name, SortOrder: r.sort_order, Active: r.active }));
}
export async function createCause({ name, sortOrder = 100 }) {
  const { rows } = await pool.query('INSERT INTO causes (name, sort_order) VALUES ($1,$2) RETURNING *', [name, sortOrder]);
  await logActivity({ action: 'created', entityType: 'cause', entityId: rows[0].id, entityLabel: rows[0].name });
  return { Id: rows[0].id, Name: rows[0].name, SortOrder: rows[0].sort_order, Active: rows[0].active };
}
export async function updateCause(id, { name, sortOrder, active }) {
  const { rows } = await pool.query(
    'UPDATE causes SET name = COALESCE($2,name), sort_order = COALESCE($3,sort_order), active = COALESCE($4,active) WHERE id = $1 RETURNING *',
    [id, name ?? null, sortOrder ?? null, active ?? null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'cause', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? { Id: rows[0].id, Name: rows[0].name, SortOrder: rows[0].sort_order, Active: rows[0].active } : null;
}
export async function deleteCause(id) {
  const inUse = await pool.query('SELECT count(*) FROM job_line_causes WHERE cause_id = $1', [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} job line(s) still use this cause — deactivate it instead of deleting`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM causes WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'cause', entityId: Number(id), entityLabel: rows[0].name });
}

// ── Job Line volunteers/vendors — "assigned crew" now lives per-line, not
//    per-WO (a vendor on the roof line, volunteers on the deck line, same
//    WO). Identical shape/behavior to the old work_order_volunteers/vendors
//    junctions they replaced. ───────────────────────────────────────────────
async function getJobLineAssignees(jobLineId) {
  const [vol, ven] = await Promise.all([
    pool.query(
      `SELECT v.id, v.name, v.phone, v.skill FROM job_line_volunteers jlv
       JOIN volunteers v ON v.id = jlv.volunteer_id WHERE jlv.job_line_id = $1 ORDER BY v.name`,
      [jobLineId]
    ),
    pool.query(
      `SELECT vd.id, vd.name, vd.phone, vd.specialty FROM job_line_vendors jlv
       JOIN vendors vd ON vd.id = jlv.vendor_id WHERE jlv.job_line_id = $1 ORDER BY vd.name`,
      [jobLineId]
    ),
  ]);
  return {
    volunteers: vol.rows.map((r) => ({ Id: r.id, Name: r.name, 'Phone Number': r.phone, Skill: r.skill })),
    vendors: ven.rows.map((r) => ({ Id: r.id, Name: r.name, 'Phone Number': r.phone, Specialty: r.specialty })),
  };
}
export async function assignVolunteerToJobLine(jobLineId, volunteerId) {
  await pool.query(`INSERT INTO job_line_volunteers (job_line_id, volunteer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [jobLineId, volunteerId]);
  return getJobLineAssignees(jobLineId);
}
export async function unassignVolunteerFromJobLine(jobLineId, volunteerId) {
  await pool.query('DELETE FROM job_line_volunteers WHERE job_line_id = $1 AND volunteer_id = $2', [jobLineId, volunteerId]);
  return getJobLineAssignees(jobLineId);
}
export async function assignVendorToJobLine(jobLineId, vendorId) {
  await pool.query(`INSERT INTO job_line_vendors (job_line_id, vendor_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [jobLineId, vendorId]);
  return getJobLineAssignees(jobLineId);
}
export async function unassignVendorFromJobLine(jobLineId, vendorId) {
  await pool.query('DELETE FROM job_line_vendors WHERE job_line_id = $1 AND vendor_id = $2', [jobLineId, vendorId]);
  return getJobLineAssignees(jobLineId);
}
// Union of every volunteer/vendor assigned to ANY line on a WO — the crew-
// session attendee picker (1.5: the job-line picker there is optional) draws
// from this rather than one line, since a session can cover general WO work.
async function getWorkOrderCrewRoster(woId) {
  const [vol, ven] = await Promise.all([
    pool.query(
      `SELECT DISTINCT v.id, v.name FROM job_line_volunteers jlv
       JOIN job_lines jl ON jl.id = jlv.job_line_id JOIN volunteers v ON v.id = jlv.volunteer_id
       WHERE jl.work_order_id = $1 ORDER BY v.name`,
      [woId]
    ),
    pool.query(
      `SELECT DISTINCT vd.id, vd.name FROM job_line_vendors jlv
       JOIN job_lines jl ON jl.id = jlv.job_line_id JOIN vendors vd ON vd.id = jlv.vendor_id
       WHERE jl.work_order_id = $1 ORDER BY vd.name`,
      [woId]
    ),
  ]);
  return { volunteers: vol.rows.map((r) => ({ Id: r.id, Name: r.name })), vendors: ven.rows.map((r) => ({ Id: r.id, Name: r.name })) };
}

// ── Attachments — the unified polymorphic attachment system (Build Brief v2
//    Phase 4) that replaced nine separate per-locus photo columns/tables
//    (work_order_photos, work_order_task_photos, asset_photos, and six
//    others). One file, many links: `attachments` holds the object itself
//    (url/thumb/metadata); `attachment_links` is the many-to-many join to
//    whatever it's attached to — a roof photo can be the evidence on the
//    finding, the before shot on the job line, and the reference image on
//    the asset simultaneously, uploaded once. ──────────────────────────────

const ATTACHMENT_ENTITY_TYPES = new Set(['asset', 'work_order', 'job_line', 'condition_finding', 'asset_component', 'maintenance_request', 'asset_note', 'expense', 'admin_task']);

function attachmentRowShape(a) {
  return {
    Id: a.id, Url: a.url, ThumbUrl: a.thumb_url, Kind: a.kind, MimeType: a.mime_type,
    FileSize: a.file_size, OriginalFilename: a.original_filename, Width: a.width, Height: a.height,
    Caption: a.caption, Classification: a.classification, TakenAt: a.taken_at,
    GpsLat: a.gps_lat, GpsLng: a.gps_lng, Source: a.source, TriageStatus: a.triage_status,
    UploadedBy: a.uploaded_by, CreatedAt: a.created_at,
  };
}
function attachmentLinkRowShape(row) {
  return {
    ...attachmentRowShape(row),
    LinkId: row.link_id, EntityType: row.entity_type, EntityId: row.entity_id,
    RoleId: row.role_id, RoleName: row.role_name, IncludeInReport: row.include_in_report, SortOrder: row.sort_order,
    VendorId: row.vendor_id, QuotedAmount: row.quoted_amount, QuoteDate: row.quote_date, IsSelectedQuote: row.is_selected_quote,
  };
}
const ATTACHMENT_LINK_SELECT = `
  SELECT al.id AS link_id, al.entity_type, al.entity_id, al.role_id, ar.name AS role_name,
         al.include_in_report, al.sort_order, al.vendor_id, al.quoted_amount, al.quote_date, al.is_selected_quote,
         a.id, a.url, a.thumb_url, a.kind, a.mime_type, a.file_size, a.original_filename, a.width, a.height,
         a.caption, a.classification, a.taken_at, a.gps_lat, a.gps_lng, a.source, a.triage_status, a.uploaded_by, a.created_at
  FROM attachment_links al
  JOIN attachments a ON a.id = al.attachment_id
  LEFT JOIN attachment_roles ar ON ar.id = al.role_id
  WHERE a.deleted_at IS NULL`;

export async function listAttachmentsForEntity(entityType, entityId) {
  const { rows } = await pool.query(`${ATTACHMENT_LINK_SELECT} AND al.entity_type = $1 AND al.entity_id = $2 ORDER BY al.sort_order, al.id`, [entityType, entityId]);
  return rows.map(attachmentLinkRowShape);
}
// Bulk variant for list-shaped pages (every job line on a WO) — one query
// instead of one per row, same N+1-avoidance pattern used elsewhere in here.
export async function listAttachmentsForEntities(entityType, entityIds) {
  const byEntity = new Map();
  if (!entityIds.length) return byEntity;
  const { rows } = await pool.query(`${ATTACHMENT_LINK_SELECT} AND al.entity_type = $1 AND al.entity_id = ANY($2::int[]) ORDER BY al.sort_order, al.id`, [entityType, entityIds]);
  for (const r of rows) {
    const list = byEntity.get(r.entity_id) || [];
    list.push(attachmentLinkRowShape(r));
    byEntity.set(r.entity_id, list);
  }
  return byEntity;
}

async function resolveIncludeInReport(client, roleId, explicit) {
  if (explicit !== null && explicit !== undefined) return explicit;
  if (!roleId) return false;
  const { rows } = await client.query('SELECT default_include_in_report FROM attachment_roles WHERE id = $1', [roleId]);
  return rows[0]?.default_include_in_report ?? false;
}

// Creates the attachment row from a storage.js ingest result with NO link
// yet. Needed because the audit form and the maintenance-request portal
// upload photos before the row they belong to exists (a finding/component
// event/request isn't created until the whole form submits) — the caller
// links it afterward, inside the same transaction that creates the parent row.
export async function createAttachment(meta, { source = 'upload', uploadedBy = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO attachments (url, thumb_url, kind, mime_type, file_size, original_filename, width, height, taken_at, gps_lat, gps_lng, source, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [meta.url, meta.thumbUrl, meta.kind, meta.mimeType, meta.fileSize, meta.originalFilename, meta.width, meta.height,
      meta.takenAt, meta.gpsLat, meta.gpsLng, source, uploadedBy]
  );
  return attachmentRowShape(rows[0]);
}

// Orphaned-upload cleanup (scripts/cleanup-orphaned-uploads.js, 2026-09-12):
// createAttachment above is the ONLY code path that ever produces an
// unlinked 'upload'-sourced row — every legitimate caller (the audit form,
// asset notes, the maintenance-request portal) links it within seconds, in
// the same transaction that creates the parent row it belongs to. So
// `source = 'upload' AND zero attachment_links rows` occurring past a
// generous age cutoff is an unambiguous signature for "the form that would
// have linked this was abandoned" (a dropped connection, a closed tab, a
// reload before submit) — never a normal in-flight upload, never anything
// from the email inbox (source='email', a deliberately-unlinked-for-now
// state that IS legitimate and must never be swept here).
export async function findOrphanedUploadAttachments({ olderThanHours = 48 } = {}) {
  const { rows } = await pool.query(
    `SELECT a.id, a.url, a.thumb_url, a.original_filename, a.created_at
     FROM attachments a
     WHERE a.source = 'upload' AND a.deleted_at IS NULL
       AND a.created_at < now() - ($1 || ' hours')::interval
       AND NOT EXISTS (SELECT 1 FROM attachment_links al WHERE al.attachment_id = a.id)
     ORDER BY a.created_at`,
    [olderThanHours]
  );
  return rows.map((r) => ({ Id: r.id, Url: r.url, ThumbUrl: r.thumb_url, OriginalFilename: r.original_filename, CreatedAt: r.created_at }));
}

// Routes orphaned uploads into the triage inbox instead of deleting them
// (2026-09-13, superseding the hard-delete this originally shipped with):
// an orphaned audit photo was taken standing in a building, and re-shooting
// it means driving back out there, so silently destroying the file is the
// wrong default for something this expensive to replace. An unlinked upload
// past the age floor is functionally the same as a photo emailed in with no
// job attached yet — Part A's "storage is pennies, no reaper" stance already
// covers not second-guessing that kind of thing — so it gets the same
// treatment: one attachment_batches row (source='upload') so it renders on
// the same inbox screen, with the same actions, as anything Mailgun delivers.
export async function createInboxBatchForAttachments({ subject, note, attachmentIds }) {
  if (!attachmentIds.length) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO attachment_batches (source, subject, note, received_at) VALUES ('upload', $1, $2, now()) RETURNING id`,
      [subject, note]
    );
    const batchId = rows[0].id;
    await client.query(`UPDATE attachments SET batch_id = $1, triage_status = 'inbox' WHERE id = ANY($2::int[])`, [batchId, attachmentIds]);
    await client.query('COMMIT');
    return batchId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Best-effort asset-name lookup for the cleanup job's inbox subject lines —
// looked up in bulk rather than per-orphan since a night's worth of orphans
// commonly share an asset.
export async function getAssetNamesByIds(ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query('SELECT id, name FROM assets WHERE id = ANY($1::int[])', [ids]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function linkAttachment(attachmentId, { entityType, entityId, roleId = null, classification = null, caption = null, includeInReport = null, sortOrder = 0, vendorId = null, quotedAmount = null, quoteDate = null, isSelectedQuote = false }, client = pool) {
  if (!ATTACHMENT_ENTITY_TYPES.has(entityType)) { const e = new Error(`Unknown attachment entity type: ${entityType}`); e.status = 400; throw e; }
  const include = await resolveIncludeInReport(client, roleId, includeInReport);
  if (classification !== null || caption !== null) {
    await client.query('UPDATE attachments SET classification = COALESCE($2, classification), caption = COALESCE($3, caption) WHERE id = $1', [attachmentId, classification, caption]);
  }
  const { rows } = await client.query(
    `INSERT INTO attachment_links (attachment_id, entity_type, entity_id, role_id, include_in_report, sort_order, vendor_id, quoted_amount, quote_date, is_selected_quote)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [attachmentId, entityType, entityId, roleId, include, sortOrder, vendorId, quotedAmount, quoteDate, isSelectedQuote]
  );
  await logActivity({ action: 'attached', entityType, entityId: Number(entityId) });
  return rows[0].id;
}

// The common case: upload + link in one step. Everything except the
// "entity doesn't exist yet" flows above (which call createAttachment then
// linkAttachment separately, inside their own transaction) goes through this.
export async function createAndLinkAttachment(meta, link, opts) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertRes = await client.query(
      `INSERT INTO attachments (url, thumb_url, kind, mime_type, file_size, original_filename, width, height, caption, classification, taken_at, gps_lat, gps_lng, source, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [meta.url, meta.thumbUrl, meta.kind, meta.mimeType, meta.fileSize, meta.originalFilename, meta.width, meta.height,
        link.caption || null, link.classification || null, meta.takenAt, meta.gpsLat, meta.gpsLng, opts?.source || 'upload', opts?.uploadedBy || null]
    );
    const attachment = insertRes.rows[0];
    const linkId = await linkAttachment(attachment.id, { ...link, caption: null, classification: null }, client);
    await client.query('COMMIT');
    return { attachment: attachmentRowShape(attachment), linkId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function updateAttachmentLink(linkId, { roleId, classification, caption, includeInReport, sortOrder, vendorId, quotedAmount, quoteDate, isSelectedQuote }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const linkRes = await client.query('SELECT attachment_id FROM attachment_links WHERE id = $1', [linkId]);
    if (!linkRes.rows[0]) { await client.query('ROLLBACK'); return null; }
    const attachmentId = linkRes.rows[0].attachment_id;
    if (classification !== undefined || caption !== undefined) {
      await client.query('UPDATE attachments SET classification = COALESCE($2, classification), caption = COALESCE($3, caption) WHERE id = $1', [attachmentId, classification ?? null, caption ?? null]);
    }
    const include = includeInReport !== undefined ? includeInReport : (roleId !== undefined ? await resolveIncludeInReport(client, roleId, null) : undefined);
    await client.query(
      `UPDATE attachment_links SET
         role_id = COALESCE($2, role_id), include_in_report = COALESCE($3, include_in_report),
         sort_order = COALESCE($4, sort_order), vendor_id = COALESCE($5, vendor_id),
         quoted_amount = COALESCE($6, quoted_amount), quote_date = COALESCE($7, quote_date),
         is_selected_quote = COALESCE($8, is_selected_quote)
       WHERE id = $1`,
      [linkId, roleId ?? null, include ?? null, sortOrder ?? null, vendorId ?? null, quotedAmount ?? null, quoteDate ?? null, isSelectedQuote ?? null]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const { rows } = await pool.query(`${ATTACHMENT_LINK_SELECT} AND al.id = $1`, [linkId]);
  return rows[0] ? attachmentLinkRowShape(rows[0]) : null;
}

// Detach — the common, low-consequence action: removes one link. File and
// attachment untouched, other links unaffected.
export async function detachAttachment(linkId) {
  const { rows } = await pool.query('DELETE FROM attachment_links WHERE id = $1 RETURNING entity_type, entity_id', [linkId]);
  if (rows[0]) await logActivity({ action: 'detached attachment from', entityType: rows[0].entity_type, entityId: rows[0].entity_id });
}

// Void — soft delete. Fast, one-tap, no confirm dialog by design (junk mail
// attachments are the case this exists for — hesitation is the enemy). File
// in Spaces is untouched; hard delete is a separate, low-priority reaper
// script this phase doesn't build.
export async function voidAttachment(attachmentId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM attachment_links WHERE attachment_id = $1`, [attachmentId]);
    await client.query(`UPDATE attachments SET deleted_at = now(), triage_status = 'void' WHERE id = $1`, [attachmentId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await logActivity({ action: 'voided', entityType: 'attachment', entityId: Number(attachmentId) });
}

// ── Attachment roles (admin-editable, §4.3 — "what is this, relative to
//    this record": Before/After/Evidence/Quote/etc. Lives on the link, not
//    the file, since the same photo can be a different role on each entity
//    it's attached to.) ─────────────────────────────────────────────────────
export async function listAttachmentRoles({ includeInactive = false } = {}) {
  const { rows } = await pool.query(`SELECT id, name, sort_order, default_include_in_report, active FROM attachment_roles ${includeInactive ? '' : 'WHERE active'} ORDER BY sort_order, name`);
  return rows.map((r) => ({ Id: r.id, Name: r.name, SortOrder: r.sort_order, DefaultIncludeInReport: r.default_include_in_report, Active: r.active }));
}
export async function createAttachmentRole({ name, sortOrder = 100, defaultIncludeInReport = false }) {
  const { rows } = await pool.query('INSERT INTO attachment_roles (name, sort_order, default_include_in_report) VALUES ($1,$2,$3) RETURNING *', [name, sortOrder, defaultIncludeInReport]);
  await logActivity({ action: 'created', entityType: 'attachment_role', entityId: rows[0].id, entityLabel: rows[0].name });
  return { Id: rows[0].id, Name: rows[0].name, SortOrder: rows[0].sort_order, DefaultIncludeInReport: rows[0].default_include_in_report, Active: rows[0].active };
}
export async function updateAttachmentRole(id, { name, sortOrder, defaultIncludeInReport, active }) {
  const { rows } = await pool.query(
    'UPDATE attachment_roles SET name = COALESCE($2,name), sort_order = COALESCE($3,sort_order), default_include_in_report = COALESCE($4,default_include_in_report), active = COALESCE($5,active) WHERE id = $1 RETURNING *',
    [id, name ?? null, sortOrder ?? null, defaultIncludeInReport ?? null, active ?? null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'attachment_role', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? { Id: rows[0].id, Name: rows[0].name, SortOrder: rows[0].sort_order, DefaultIncludeInReport: rows[0].default_include_in_report, Active: rows[0].active } : null;
}
export async function deleteAttachmentRole(id) {
  const inUse = await pool.query('SELECT count(*) FROM attachment_links WHERE role_id = $1', [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} attachment(s) still use this role — deactivate it instead of deleting`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM attachment_roles WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'attachment_role', entityId: Number(id), entityLabel: rows[0].name });
}

// ── Mail-inbound ingest (Build Brief v2.1 Part 1) — the Mailgun webhook
//    route (routes/mail-inbound.js) does signature verification, multipart
//    parsing, junk filtering, and storage uploads; everything that touches
//    SQL happens here, same boundary as the rest of the app. ──────────────

export async function findAttachmentBatchByMessageId(messageId) {
  const { rows } = await pool.query('SELECT id FROM attachment_batches WHERE message_id = $1', [messageId]);
  return rows[0]?.id || null;
}

export async function findWorkOrderIdByNumber(woNumber) {
  const { rows } = await pool.query('SELECT id FROM work_orders WHERE wo_number = $1', [woNumber]);
  return rows[0]?.id || null;
}

// Writes the batch row and its attachments together, in one transaction, only
// after every attachment has already been uploaded to Spaces (attachments
// param is a list of storeAttachment() results). This is deliberate ordering,
// not incidental: if it failed with the batch row written first and the
// upload loop second, a retry of the same Message-Id would hit the UNIQUE
// constraint's ON CONFLICT DO NOTHING, silently no-op, and leave the batch
// permanently short its attachments. Writing the batch row last means a
// failed attempt leaves no batch row at all, so Mailgun's retry starts clean.
// Returns null (not an error) if the batch already exists — the caller's
// idempotency case, not a failure.
export async function createMailInboundBatch({ subject, bodyText, bodyHtml, senderEmail, messageId, receivedAt, spfResult, dkimResult, attachments, targetWorkOrderId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO attachment_batches (source, subject, body_text, body_html, sender_email, message_id, received_at, spf_result, dkim_result)
       VALUES ('email',$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (message_id) DO NOTHING RETURNING id`,
      [subject, bodyText, bodyHtml, senderEmail, messageId, receivedAt, spfResult, dkimResult]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return null; }
    const batchId = rows[0].id;

    for (const meta of attachments) {
      const insertRes = await client.query(
        `INSERT INTO attachments (url, thumb_url, kind, mime_type, file_size, original_filename, width, height, taken_at, gps_lat, gps_lng, source, batch_id, triage_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'email',$12,$13) RETURNING id`,
        [meta.url, meta.thumbUrl, meta.kind, meta.mimeType, meta.fileSize, meta.originalFilename, meta.width, meta.height,
          meta.takenAt, meta.gpsLat, meta.gpsLng, batchId, targetWorkOrderId ? 'triaged' : 'inbox']
      );
      if (targetWorkOrderId) {
        await linkAttachment(insertRes.rows[0].id, { entityType: 'work_order', entityId: targetWorkOrderId }, client);
      }
    }
    await client.query('COMMIT');
    return batchId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Receipt-inbound ingest (Build Brief v3 Part 2) — the second Mailgun
//    route (routes/receipt-inbound.js). Mirrors createMailInboundBatch's
//    transaction shape exactly (batch row written last, together with its
//    attachments, for the same retry-safety reason), but the row that lands
//    in the inbox is an `expenses` row — pre-filled from expenseParsing.js —
//    not a set of unlinked attachments. Every receipt attachment gets linked
//    to that expense immediately (role 'Receipt'); there's no WO-subject-
//    shortcut equivalent here, receipts don't skip triage. ─────────────────
export async function createReceiptInboundBatch({ subject, bodyText, bodyHtml, senderEmail, messageId, receivedAt, spfResult, dkimResult, attachments, parsed }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO attachment_batches (source, subject, body_text, body_html, sender_email, message_id, received_at, spf_result, dkim_result)
       VALUES ('email',$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (message_id) DO NOTHING RETURNING id`,
      [subject, bodyText, bodyHtml, senderEmail, messageId, receivedAt, spfResult, dkimResult]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return null; }
    const batchId = rows[0].id;

    // purchase_date defaults to the day the email hit receipts@ (camp-local,
    // not UTC — a 9pm Eastern forward is still that day), NOT the date
    // regex-parsed out of the body: that parse grabs whatever date appears
    // first (ship dates, footers) and left the field blank when it found
    // nothing. Still editable at triage like every other field.
    const expenseRes = await client.query(
      `INSERT INTO expenses (vendor, amount, purchase_date, triage_status, batch_id, source, parsed_confidence)
       VALUES ($1,$2,($3::timestamptz AT TIME ZONE 'America/New_York')::date,'inbox',$4,'email',$5) RETURNING id`,
      [parsed?.vendor || null, parsed?.amount ?? null, receivedAt || new Date(), batchId, parsed?.confidence || 'none']
    );
    const expenseId = expenseRes.rows[0].id;

    const roleRes = await client.query(`SELECT id FROM attachment_roles WHERE name = 'Receipt'`);
    const receiptRoleId = roleRes.rows[0]?.id || null;

    for (const meta of attachments) {
      const insertRes = await client.query(
        `INSERT INTO attachments (url, thumb_url, kind, mime_type, file_size, original_filename, width, height, taken_at, gps_lat, gps_lng, source, batch_id, triage_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'email',$12,'triaged') RETURNING id`,
        [meta.url, meta.thumbUrl, meta.kind, meta.mimeType, meta.fileSize, meta.originalFilename, meta.width, meta.height,
          meta.takenAt, meta.gpsLat, meta.gpsLng, batchId]
      );
      await linkAttachment(insertRes.rows[0].id, { entityType: 'expense', entityId: expenseId, roleId: receiptRoleId }, client);
    }
    await client.query('COMMIT');
    return { batchId, expenseId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Funds (Build Brief v3 Part 1, §1.1) — money with a ceiling Ben is
//    personally accountable for, NOT a general ledger. amount is a reference
//    line: spending past it warns (getFundBalances) and is always allowed,
//    never blocked. Expired funds (past end_date) drop out of the default
//    picker (activeOnly) but stay selectable for backdated entry. ──────────
export async function listFunds({ activeOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM funds ${activeOnly ? "WHERE active AND (end_date IS NULL OR end_date >= current_date)" : ''} ORDER BY active DESC, end_date DESC NULLS LAST, name`
  );
  return rows.map((r) => ({
    Id: r.id, Name: r.name, Amount: Number(r.amount), StartDate: r.start_date, EndDate: r.end_date,
    AuthorizedBy: r.authorized_by, Notes: r.notes, Active: r.active,
    Expired: !!(r.end_date && new Date(r.end_date) < new Date(new Date().toISOString().slice(0, 10))),
  }));
}
export async function createFund({ name, amount, startDate, endDate, authorizedBy, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO funds (name, amount, start_date, end_date, authorized_by, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [name, amount, startDate || null, endDate || null, authorizedBy || null, notes || null]
  );
  await logActivity({ action: 'created', entityType: 'fund', entityId: rows[0].id, entityLabel: name });
  return (await listFunds()).find((f) => f.Id === rows[0].id);
}
export async function updateFund(id, { name, amount, startDate, endDate, authorizedBy, notes, active }) {
  const { rows } = await pool.query(
    `UPDATE funds SET name = COALESCE($2,name), amount = COALESCE($3,amount), start_date = COALESCE($4,start_date),
       end_date = COALESCE($5,end_date), authorized_by = COALESCE($6,authorized_by), notes = COALESCE($7,notes), active = COALESCE($8,active)
     WHERE id = $1 RETURNING id, name`,
    [id, name ?? null, amount ?? null, startDate ?? null, endDate ?? null, authorizedBy ?? null, notes ?? null, active ?? null]
  );
  if (!rows[0]) return null;
  await logActivity({ action: 'updated', entityType: 'fund', entityId: rows[0].id, entityLabel: rows[0].name });
  return (await listFunds()).find((f) => f.Id === rows[0].id);
}
export async function deleteFund(id) {
  const inUse = await pool.query(
    `SELECT (SELECT count(*) FROM job_lines WHERE funding_source = 'fund' AND funding_ref_id = $1)
          + (SELECT count(*) FROM expenses WHERE fund_id = $1) AS count`,
    [id]
  );
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} record(s) still use this fund — deactivate it instead of deleting`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM funds WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'fund', entityId: Number(id), entityLabel: rows[0].name });
}

// Dashboard fund tile (§3.4) — "$X of $Y remaining · N days left". Spent =
// sum of non-void expenses with that fund_id; over-spend is a positive
// Overage number the frontend renders in a warning color, never blocked.
export async function getFundBalances() {
  const funds = await listFunds();
  // Two halves of the same money (0083): shares explicitly allocated to a fund, plus
  // the part of each receipt nobody has split yet, which still draws on the fund the
  // receipt was charged to. Summing only one half understates spend while a split is
  // half-finished.
  const { rows: spentRows } = await pool.query(`
    SELECT fund_id, COALESCE(SUM(spent), 0) AS spent FROM (
      SELECT ea.funding_ref_id AS fund_id, SUM(ea.amount) AS spent
      FROM expense_allocations ea JOIN expenses e ON e.id = ea.expense_id
      WHERE ea.funding_source = 'fund' AND ea.funding_ref_id IS NOT NULL
        AND e.triage_status != 'void' AND e.deleted_at IS NULL
      GROUP BY ea.funding_ref_id
      UNION ALL
      SELECT e.fund_id, GREATEST(COALESCE(e.amount, 0) - COALESCE(alloc.total, 0), 0) AS spent
      FROM expenses e
      LEFT JOIN (SELECT expense_id, SUM(amount) AS total FROM expense_allocations GROUP BY expense_id) alloc
        ON alloc.expense_id = e.id
      WHERE e.fund_id IS NOT NULL AND e.triage_status != 'void' AND e.deleted_at IS NULL
    ) parts
    GROUP BY fund_id
  `);
  const spentByFund = new Map(spentRows.map((r) => [r.fund_id, Number(r.spent)]));
  const today = new Date();
  return funds.map((f) => {
    const spent = spentByFund.get(f.Id) || 0;
    const remaining = f.Amount - spent;
    const daysLeft = f.EndDate ? Math.ceil((new Date(f.EndDate) - today) / 86400000) : null;
    return { ...f, Spent: spent, Remaining: remaining, OverBudget: remaining < 0, DaysLeft: daysLeft };
  });
}

// ── Expense categories (Build Brief v3 Part 1, §1.2) — admin-editable,
//    same freetext-never-promoted rule as `causes`. ─────────────────────────
export async function listExpenseCategories({ includeInactive = false } = {}) {
  const { rows } = await pool.query(`SELECT id, name, sort_order, active FROM expense_categories ${includeInactive ? '' : 'WHERE active'} ORDER BY sort_order, name`);
  return rows.map((r) => ({ Id: r.id, Name: r.name, SortOrder: r.sort_order, Active: r.active }));
}
export async function createExpenseCategory({ name, sortOrder = 100 }) {
  const { rows } = await pool.query('INSERT INTO expense_categories (name, sort_order) VALUES ($1,$2) RETURNING *', [name, sortOrder]);
  await logActivity({ action: 'created', entityType: 'expense_category', entityId: rows[0].id, entityLabel: rows[0].name });
  return { Id: rows[0].id, Name: rows[0].name, SortOrder: rows[0].sort_order, Active: rows[0].active };
}
export async function updateExpenseCategory(id, { name, sortOrder, active }) {
  const { rows } = await pool.query(
    'UPDATE expense_categories SET name = COALESCE($2,name), sort_order = COALESCE($3,sort_order), active = COALESCE($4,active) WHERE id = $1 RETURNING *',
    [id, name ?? null, sortOrder ?? null, active ?? null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'expense_category', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? { Id: rows[0].id, Name: rows[0].name, SortOrder: rows[0].sort_order, Active: rows[0].active } : null;
}
export async function deleteExpenseCategory(id) {
  const inUse = await pool.query('SELECT count(*) FROM expenses WHERE category_id = $1', [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} expense(s) still use this category — deactivate it instead of deleting`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM expense_categories WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'expense_category', entityId: Number(id), entityLabel: rows[0].name });
}

// ── Expenses (Build Brief v3 Part 1/3) — camp-debit-card spending. Nearly
//    everything is nullable on the row itself; triage is where an inbox
//    expense gets completed. Void is soft (triage_status='void'), same
//    one-tap/undo pattern as attachment void — junk (spam receipts, a
//    forwarded email with no purchase) will arrive here same as the photo
//    inbox. ────────────────────────────────────────────────────────────────
function expenseRowToApi(r) {
  return {
    Id: r.id, Vendor: r.vendor, Amount: r.amount != null ? Number(r.amount) : null, PurchaseDate: r.purchase_date,
    TaxAmount: r.tax_amount != null ? Number(r.tax_amount) : null, TaxChargedInError: r.tax_charged_in_error,
    RegularPrice: r.regular_price != null ? Number(r.regular_price) : null,
    CategoryId: r.category_id, CategoryName: r.category_name || null,
    FundId: r.fund_id, FundName: r.fund_name || null,
    JobLineId: r.job_line_title != null ? r.dest_id : null, JobLineTitle: r.job_line_title || null,
    WorkOrderId: r.work_order_title != null ? r.dest_id : null, WorkOrderTitle: r.work_order_title || null,
    AssetId: r.asset_id, AssetName: r.asset_name || null,
    Notes: r.notes, TriageStatus: r.triage_status, Source: r.source, ParsedConfidence: r.parsed_confidence,
    CreatedBy: r.created_by, CreatedAt: r.created_at,
    Subject: r.batch_subject || null, SenderEmail: r.batch_sender_email || null, ReceivedAt: r.batch_received_at || null,
    BodyText: r.batch_body_text || null, BodyHtml: r.batch_body_html || null,
  };
}
// batch_body_text/batch_body_html is the whole point of the join for a
// triage screen: an expense parsed from email arrives with nothing but
// suggested values — the only way to actually confirm "is $55.64 right"
// without leaving the app is to show the source email it came from, not
// just the parsed-out fields. HTML is what vendor receipt emails are
// actually designed to look like (see 0055's migration comment on why
// plain-text alone is unreliable); plain text stays available as a
// fallback toggle in the UI.
const EXPENSE_SELECT = `
  SELECT e.*, ec.name AS category_name, f.name AS fund_name, d.dest_id,
         jl.title AS job_line_title, wo.title AS work_order_title, a.name AS asset_name,
         b.subject AS batch_subject, b.sender_email AS batch_sender_email, b.received_at AS batch_received_at,
         b.body_text AS batch_body_text, b.body_html AS batch_body_html
  FROM expenses e
  LEFT JOIN expense_categories ec ON ec.id = e.category_id
  LEFT JOIN funds f ON f.id = e.fund_id
  -- The destination is an allocation now. The row shape still exposes a single
  -- JobLineId/WorkOrderId, which is the unsplit case; a split receipt reports its
  -- destinations through Allocations instead, and these read as the first one.
  LEFT JOIN LATERAL (
    SELECT ea.dest_type, ea.dest_id FROM expense_allocations ea
    WHERE ea.expense_id = e.id AND ea.dest_type IN ('job_line','work_order')
    ORDER BY ea.id LIMIT 1
  ) d ON true
  LEFT JOIN job_lines jl ON d.dest_type = 'job_line' AND jl.id = d.dest_id
  LEFT JOIN work_orders wo ON d.dest_type = 'work_order' AND wo.id = d.dest_id
  LEFT JOIN assets a ON a.id = e.asset_id
  LEFT JOIN attachment_batches b ON b.id = e.batch_id`;

export async function listExpenseInbox() {
  const { rows } = await pool.query(`${EXPENSE_SELECT} WHERE e.triage_status = 'inbox' AND e.deleted_at IS NULL ORDER BY e.created_at DESC`);
  const expenses = rows.map(expenseRowToApi);
  if (!expenses.length) return expenses;
  const { rows: attRows } = await pool.query(
    `SELECT al.entity_id, a.id, a.url, a.thumb_url, a.kind, a.original_filename
     FROM attachment_links al JOIN attachments a ON a.id = al.attachment_id
     WHERE al.entity_type = 'expense' AND al.entity_id = ANY($1::int[]) AND a.deleted_at IS NULL`,
    [expenses.map((e) => e.Id)]
  );
  const byExpense = new Map();
  for (const r of attRows) {
    if (!byExpense.has(r.entity_id)) byExpense.set(r.entity_id, []);
    byExpense.get(r.entity_id).push({ Id: r.id, Url: r.url, ThumbUrl: r.thumb_url, Kind: r.kind, OriginalFilename: r.original_filename });
  }
  for (const e of expenses) e.Attachments = byExpense.get(e.Id) || [];
  return expenses;
}

// Dashboard badge (§3.1) — same role as getInboxCount for photos.
export async function getExpenseInboxCount() {
  const { rows } = await pool.query(`SELECT count(*) FROM expenses WHERE triage_status = 'inbox' AND deleted_at IS NULL`);
  return Number(rows[0].count);
}

// sortBy/limit/offset are for the Expenses page's "All Expenses" list (Ben's
// request, 2026-09-12, §3) — a plain "what have I entered" browse, distinct
// from the Reports data explorer (grouping/export/charts stay Reports-only,
// on purpose). Only passing `limit` switches the query into paginated mode
// (adds a companion COUNT(*) so the frontend knows whether "Load more" has
// anything left) — every existing caller (Recent Expenses, Reports raw data
// via getExpensesReportRawData) calls this with no limit and keeps getting
// the plain array it always got, unpaginated, most-recent-first.
const EXPENSE_SORT_COLUMNS = {
  date: 'e.purchase_date',
  amount: 'e.amount',
};
export async function listExpenses({
  fundId, categoryId, vendor, jobLineId, workOrderId, assetId, dateFrom, dateTo, taxChargedInError, unclassified,
  sortBy = 'date', sortDir = 'desc', limit, offset = 0,
} = {}) {
  const clauses = [`e.triage_status != 'void'`, 'e.deleted_at IS NULL'];
  const params = [];
  const add = (clause, val) => { params.push(val); clauses.push(clause.replace('$N', `$${params.length}`)); };
  if (fundId) add('e.fund_id = $N', Number(fundId));
  if (categoryId) add('e.category_id = $N', Number(categoryId));
  if (vendor) add('e.vendor ILIKE $N', `%${vendor}%`);
  if (jobLineId) add(`EXISTS (SELECT 1 FROM expense_allocations ea WHERE ea.expense_id = e.id AND ea.dest_type = 'job_line' AND ea.dest_id = $N)`, Number(jobLineId));
  if (workOrderId) add(`EXISTS (SELECT 1 FROM expense_allocations ea WHERE ea.expense_id = e.id AND ea.dest_type = 'work_order' AND ea.dest_id = $N)`, Number(workOrderId));
  if (assetId) add('e.asset_id = $N', Number(assetId));
  if (dateFrom) add('e.purchase_date >= $N', dateFrom);
  if (dateTo) add('e.purchase_date <= $N', dateTo);
  if (taxChargedInError) clauses.push('e.tax_charged_in_error = true');
  if (unclassified) clauses.push('(e.fund_id IS NULL OR e.category_id IS NULL)');
  const where = clauses.join(' AND ');

  const sortCol = EXPENSE_SORT_COLUMNS[sortBy] || EXPENSE_SORT_COLUMNS.date;
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
  let sql = `${EXPENSE_SELECT} WHERE ${where} ORDER BY ${sortCol} ${dir} NULLS LAST, e.created_at ${dir}`;
  if (limit) { params.push(Number(limit)); sql += ` LIMIT $${params.length}`; params.push(Number(offset)); sql += ` OFFSET $${params.length}`; }
  const { rows } = await pool.query(sql, params);
  const expenses = rows.map(expenseRowToApi);
  if (!limit) return expenses;

  const { rows: countRows } = await pool.query(`SELECT count(*) FROM expenses e WHERE ${where}`, params.slice(0, params.length - 2));
  return { expenses, total: Number(countRows[0].count) };
}

export async function getExpense(id) {
  const { rows } = await pool.query(`${EXPENSE_SELECT} WHERE e.id = $1`, [id]);
  return rows[0] ? expenseRowToApi(rows[0]) : null;
}

// Fund inheritance (§3.3) — when a job line is given, and the caller hasn't
// explicitly chosen a fund, default fund_id from that line's funding_ref_id
// IF the line's funding_source is 'fund'. Overridable: an explicit fundId
// (including explicit null, i.e. "no fund") always wins over inheritance.
// Returns undefined when nothing about funding was touched at all, so the
// caller (updateExpense's dynamic column builder) can tell "leave alone"
// apart from "set to null."
async function inheritedFundId(jobLineId, fundId) {
  if (fundId !== undefined) return fundId;
  if (!jobLineId) return jobLineId === undefined ? undefined : null;
  const { rows } = await pool.query(`SELECT funding_source, funding_ref_id FROM job_lines WHERE id = $1`, [jobLineId]);
  const jl = rows[0];
  return (jl && jl.funding_source === 'fund') ? jl.funding_ref_id : null;
}

export async function createExpense({
  vendor, amount, purchaseDate, taxAmount, taxChargedInError, categoryId, fundId, jobLineId, workOrderId, assetId, notes, regularPrice, createdBy,
}) {
  const resolvedFundId = await inheritedFundId(jobLineId, fundId);
  const { rows } = await pool.query(
    `INSERT INTO expenses (vendor, amount, purchase_date, tax_amount, tax_charged_in_error, category_id, fund_id, asset_id, notes, regular_price, triage_status, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'triaged','manual',$11) RETURNING id`,
    [vendor || null, amount ?? null, purchaseDate || null, taxAmount ?? null, !!taxChargedInError, categoryId || null,
      resolvedFundId ?? null, assetId || null, notes || null, regularPrice ?? null, createdBy || null]
  );
  const id = rows[0].id;
  // The ordinary form's single destination is just a one-way split — written here so
  // allocations are the only place a destination ever lives (0078).
  await setExpenseDestination(id, { jobLineId, workOrderId, amount });
  await writeExpenseDiscountSaving(id, { amount, regularPrice, purchaseDate });
  await logActivity({ action: 'created', entityType: 'expense', entityId: id, entityLabel: vendor || 'Expense' });
  return getExpense(id);
}

// What funding does a new split inherit? A job line knows its own; a work order's lines
// may disagree, so it only answers when they agree; everything else falls back to the
// receipt's fund. Whatever this returns is COPIED onto the allocation and never
// re-derived — that is what "stamped" means (0083).
export async function resolveAllocationFunding({ destType, destId, fallbackFundId = null }) {
  const fallback = fallbackFundId
    ? { fundingSource: 'fund', fundingRefId: fallbackFundId }
    : { fundingSource: 'operating_budget', fundingRefId: null };
  if (destType === 'job_line' && destId) {
    const { rows } = await pool.query('SELECT funding_source, funding_ref_id FROM job_lines WHERE id = $1', [destId]);
    if (rows[0]) return { fundingSource: rows[0].funding_source, fundingRefId: rows[0].funding_ref_id };
  }
  if (destType === 'work_order' && destId) {
    const { rows } = await pool.query(
      `SELECT DISTINCT funding_source, funding_ref_id FROM job_lines WHERE work_order_id = $1`, [destId]
    );
    // One answer only when the whole work order agrees — guessing on a mixed WO would
    // stamp a number that was never true.
    if (rows.length === 1) return { fundingSource: rows[0].funding_source, fundingRefId: rows[0].funding_ref_id };
  }
  return fallback;
}

// The unsplit case: at most one job_line/work_order allocation, carrying the whole
// amount. Leaves any leftover/admin_task rows and any line-item splits alone — those
// are managed by the split editor, not by picking a destination on the main form.
export async function setExpenseDestination(expenseId, { jobLineId, workOrderId, amount }) {
  if (jobLineId === undefined && workOrderId === undefined) return;
  await pool.query(
    `DELETE FROM expense_allocations
     WHERE expense_id = $1 AND line_item_id IS NULL AND dest_type IN ('job_line','work_order')`,
    [expenseId]
  );
  const destType = jobLineId ? 'job_line' : (workOrderId ? 'work_order' : null);
  const destId = jobLineId || workOrderId || null;
  if (!destType) return;
  const { rows } = await pool.query('SELECT amount, fund_id FROM expenses WHERE id = $1', [expenseId]);
  const total = amount ?? (rows[0]?.amount != null ? Number(rows[0].amount) : 0);
  const funding = await resolveAllocationFunding({
    destType, destId, fallbackFundId: rows[0]?.fund_id ?? null,
  });
  await pool.query(
    `INSERT INTO expense_allocations (expense_id, dest_type, dest_id, amount, funding_source, funding_ref_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [expenseId, destType, destId, total ?? 0, funding.fundingSource, funding.fundingRefId]
  );
}

// regular_price - amount is a one-time saving, counted ONCE at the purchase on the
// full receipt. Allocation distributes each destination's share of it; it never
// creates more. Re-recorded from scratch on every write so editing the price down
// doesn't leave a stale saving behind.
export async function writeExpenseDiscountSaving(expenseId, { amount, regularPrice, purchaseDate } = {}) {
  await pool.query(`DELETE FROM savings_entries WHERE source_type = 'expense' AND source_id = $1`, [expenseId]);
  const paid = amount == null ? null : Number(amount);
  const regular = regularPrice == null ? null : Number(regularPrice);
  if (paid == null || regular == null || !(regular > paid)) return;
  await pool.query(
    `INSERT INTO savings_entries (kind, amount, source_type, source_id, occurred_on, note)
     VALUES ('one_time', $1, 'expense', $2, COALESCE($3::date, CURRENT_DATE), 'Regular price less paid price')`,
    [Math.round((regular - paid) * 100) / 100, expenseId, purchaseDate || null]
  );
}

const EXPENSE_UPDATE_COLUMNS = {
  vendor: 'vendor', amount: 'amount', purchaseDate: 'purchase_date', taxAmount: 'tax_amount',
  taxChargedInError: 'tax_charged_in_error', categoryId: 'category_id',
  assetId: 'asset_id', notes: 'notes', regularPrice: 'regular_price',
};
// jobLineId/workOrderId are deliberately absent — they're allocations now (0078),
// written by setExpenseDestination below.
// Triage/edit — same row for "complete an inbox row" and "edit an existing
// expense," same as attachment triage. Moves triage_status to 'triaged' on
// any save from the inbox unless the caller explicitly voids instead. Only
// touches columns actually present in `fields` (undefined = leave alone,
// null = explicitly clear) — same convention as updateJobLine, needed here
// because several of these fields (category/job line/fund) must be
// independently clearable without a full-form resubmit wiping the rest.
export async function updateExpense(id, fields) {
  const setCols = []; const vals = []; let i = 2;
  for (const [key, col] of Object.entries(EXPENSE_UPDATE_COLUMNS)) {
    if (fields[key] === undefined) continue;
    setCols.push(`${col} = $${i++}`);
    vals.push(fields[key]);
  }
  const resolvedFundId = await inheritedFundId(fields.jobLineId, fields.fundId);
  if (resolvedFundId !== undefined) { setCols.push(`fund_id = $${i++}`); vals.push(resolvedFundId); }
  // Destination and discount live outside the column set now, so they're applied even
  // when nothing on the expense row itself changed.
  await setExpenseDestination(id, { jobLineId: fields.jobLineId, workOrderId: fields.workOrderId, amount: fields.amount });
  if ('regularPrice' in fields || 'amount' in fields) {
    const cur = await getExpense(id);
    if (cur) {
      await writeExpenseDiscountSaving(id, {
        amount: 'amount' in fields ? fields.amount : cur.Amount,
        regularPrice: 'regularPrice' in fields ? fields.regularPrice : cur.RegularPrice,
        purchaseDate: fields.purchaseDate ?? cur.PurchaseDate,
      });
    }
  }
  if (!setCols.length) return getExpense(id);
  setCols.push(`triage_status = CASE WHEN triage_status = 'inbox' THEN 'triaged' ELSE triage_status END`);
  const { rows } = await pool.query(
    `UPDATE expenses SET ${setCols.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING id, vendor`,
    [id, ...vals]
  );
  if (!rows[0]) return null;
  await logActivity({ action: 'updated', entityType: 'expense', entityId: rows[0].id, entityLabel: rows[0].vendor || 'Expense' });
  return getExpense(id);
}

// Void — one tap, no confirm, same reasoning as voidAttachment: junk
// (a spam email, a forwarded newsletter) will land in the inbox, and asking
// for a confirm on every one of those is friction with no upside. File
// itself is untouched; this only flips triage_status.
export async function voidExpense(id) {
  const { rows } = await pool.query(`UPDATE expenses SET triage_status = 'void' WHERE id = $1 AND deleted_at IS NULL RETURNING id, vendor`, [id]);
  if (rows[0]) await logActivity({ action: 'voided', entityType: 'expense', entityId: rows[0].id, entityLabel: rows[0].vendor || 'Expense' });
}
export async function unvoidExpense(id) {
  const { rows } = await pool.query(`UPDATE expenses SET triage_status = 'triaged' WHERE id = $1 AND triage_status = 'void' RETURNING id, vendor`, [id]);
  if (rows[0]) await logActivity({ action: 'unvoided', entityType: 'expense', entityId: rows[0].id, entityLabel: rows[0].vendor || 'Expense' });
}

// Money header and savings (Build Brief §7). Recurring and one-time savings are
// reported SEPARATELY and never summed: $275/month secured forever and a $40 bulk
// discount are not the same kind of number, and adding them produces a figure that
// means nothing.
export async function computeBoardReportAggregates(reportId) {
  const report = await getBoardReport(reportId);
  if (!report) return [];
  const yearStart = `${String(report.PeriodEnd).slice(0, 4)}-01-01`;
  const out = [];

  // Total spend reads the RECEIPTS, not their allocations. Allocations divide the same
  // money between destinations — they never add to it — so summing them under-reports
  // every receipt nobody has split yet, which is most of them. (Found the hard way:
  // this said $0 spent against 11 real receipts, because none had been split.)
  // Allocations are how spend is ATTRIBUTED — per fund, per job — not how it is totalled.
  const spend = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS period FROM expenses
     WHERE triage_status != 'void' AND deleted_at IS NULL
       AND purchase_date BETWEEN $1 AND $2`,
    [report.PeriodStart, report.PeriodEnd]
  );
  const ytd = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS ytd FROM expenses
     WHERE triage_status != 'void' AND deleted_at IS NULL
       AND purchase_date BETWEEN $1 AND $2`,
    [yearStart, report.PeriodEnd]
  );
  out.push({ groupKey: 'money', label: 'Spent this period', valueNumeric: Number(spend.rows[0].period) });
  out.push({ groupKey: 'money', label: 'Spent year to date', valueNumeric: Number(ytd.rows[0].ytd) });

  // Recurring is reported as an annual rate — that's how a monthly saving is worth
  // understanding — while storage keeps the monthly figure that was negotiated.
  const rec = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN period = 'monthly' THEN amount * 12 ELSE amount END), 0) AS annualized
     FROM savings_entries WHERE kind = 'recurring' AND occurred_on BETWEEN $1 AND $2`,
    [report.PeriodStart, report.PeriodEnd]
  );
  const recAll = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN period = 'monthly' THEN amount * 12 ELSE amount END), 0) AS annualized
     FROM savings_entries WHERE kind = 'recurring' AND occurred_on <= $1`,
    [report.PeriodEnd]
  );
  const one = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM savings_entries
     WHERE kind = 'one_time' AND occurred_on BETWEEN $1 AND $2`,
    [report.PeriodStart, report.PeriodEnd]
  );
  out.push({ groupKey: 'savings', label: 'Recurring savings secured this period (per year)', valueNumeric: Number(rec.rows[0].annualized) });
  out.push({ groupKey: 'savings', label: 'Recurring savings secured to date (per year)', valueNumeric: Number(recAll.rows[0].annualized) });
  out.push({ groupKey: 'savings', label: 'One-time savings this period', valueNumeric: Number(one.rows[0].total) });

  await replaceBoardReportAggregates(reportId, out);
  return listBoardReportAggregates(reportId);
}

// Search for anything that can go on a report, regardless of status or date (§3). The
// suggestion rules decide what is PROPOSED; this exists so no rule can keep something
// off a report that belongs on it.
export async function searchBoardReportCandidates(q, limit = 30) {
  const like = `%${q}%`;
  const [wos, lines, findings, tasks] = await Promise.all([
    pool.query(
      `SELECT w.id, w.title, ws.name AS status, a.name AS asset_name
       FROM work_orders w JOIN work_order_statuses ws ON ws.id = w.status_id
       LEFT JOIN assets a ON a.id = w.asset_id
       WHERE w.title ILIKE $1 ORDER BY w.id DESC LIMIT $2`, [like, limit]),
    pool.query(
      `SELECT jl.id, jl.title, s.name AS status, w.id AS work_order_id, w.title AS wo_title,
              COALESCE(jl.completed_date, jl.completed_at::date)::text AS completed_date,
              (jl.completed_date IS NULL AND jl.completed_at IS NOT NULL) AS date_inferred,
              jl.actual_hours, jl.estimated_cost, a.name AS asset_name
       FROM job_lines jl JOIN job_line_statuses s ON s.id = jl.status_id
       JOIN work_orders w ON w.id = jl.work_order_id
       LEFT JOIN assets a ON a.id = w.asset_id
       WHERE jl.title ILIKE $1 ORDER BY jl.id DESC LIMIT $2`, [like, limit]),
    pool.query(
      `SELECT cf.id, cf.title, cf.status, cf.estimated_cost, a.name AS asset_name
       FROM condition_findings cf LEFT JOIN assets a ON a.id = cf.asset_id
       WHERE cf.title ILIKE $1 ORDER BY cf.id DESC LIMIT $2`, [like, limit]),
    pool.query(
      `${ADMIN_TASK_SELECT} WHERE t.title ILIKE $1 ORDER BY t.id DESC LIMIT $2`, [like, limit]),
  ]);
  return [
    ...wos.rows.map((r) => ({ ItemType: 'work_order', ItemId: r.id, Title: r.title,
      Subtitle: r.asset_name, Status: r.status })),
    ...lines.rows.map((r) => ({ ItemType: 'job_line', ItemId: r.id, Title: r.title,
      Subtitle: r.date_inferred ? `${r.wo_title} · date not recorded` : r.wo_title,
      Status: r.status, ParentWorkOrderId: r.work_order_id, AssetName: r.asset_name,
      Date: r.completed_date, Hours: r.actual_hours, Cost: r.estimated_cost })),
    ...findings.rows.map((r) => ({ ItemType: 'condition_finding', ItemId: r.id, Title: r.title,
      Subtitle: r.asset_name, Status: r.status, Cost: r.estimated_cost })),
    ...tasks.rows.map((r) => { const t = adminTaskRowShape(r); return {
      ItemType: 'admin_task', ItemId: t.Id, Title: t.Title, Subtitle: t.CategoryName,
      Status: t.StatusName, Date: t.TaskDate, Hours: t.Hours }; }),
  ];
}

// Adds a searched item to the draft. Marked manually_added AND user_touched, so a
// suggestion refresh can neither remove it nor pretend it proposed it.
export async function addBoardReportItemManually(reportId, item) {
  const report = await getBoardReport(reportId);
  if (!report) return null;
  if (report.Status === 'published') {
    const e = new Error('Published reports are read-only'); e.status = 409; throw e;
  }
  const section = item.section || (item.ItemType === 'admin_task' ? 'admin_work' : 'done');
  // No pass token: a hand-added item belongs to no suggestion pass, and the prune
  // skips it anyway on manually_added.
  await upsertBoardReportItem(reportId, {
    itemType: item.ItemType, itemId: item.ItemId, section,
    included: true, sortIndex: 0,
    parentWorkOrderId: item.ParentWorkOrderId ?? null,
    snapTitle: item.Title, snapSubtitle: item.Subtitle, snapAssetName: item.AssetName ?? null,
    snapStatus: item.Status, snapDate: item.Date ?? null,
    snapHours: item.Hours ?? null, snapCost: item.Cost ?? null,
  });
  await pool.query(
    `UPDATE board_report_items SET manually_added = true, user_touched = true
     WHERE report_id = $1 AND item_type = $2 AND item_id = $3`,
    [reportId, item.ItemType, item.ItemId]
  );
  return listBoardReportItems(reportId);
}

// ── Board report suggestions (Build Brief §5) ────────────────────────────
// Everything here is a SUGGESTION. Each pass upserts rows pre-checked, and
// upsertBoardReportItem never overwrites an explicit include/exclude, so re-running
// after a date change can't undo a decision. Nothing is ever force-included.

// Done: job lines resolved inside the backward period — line level, so a work order
// with 2 of 5 lines finished contributes those 2 and not itself.
async function suggestDoneJobLines(reportId, passId, { periodStart, periodEnd }) {
  // Falls back to completed_at — when the line was MARKED done — so work entered in
  // arrears with the date left blank still reaches the report (§3). The fallback is
  // reported back so the UI can say "date not recorded" rather than passing a status
  // timestamp off as the day the work happened.
  const { rows } = await pool.query(
    `SELECT jl.id, jl.title,
            COALESCE(jl.completed_date, jl.completed_at::date)::text AS completed_date,
            (jl.completed_date IS NULL AND jl.completed_at IS NOT NULL) AS date_inferred,
            jl.actual_hours,
            COALESCE(${JOB_LINE_ACTUAL_COST_EXPR}, jl.estimated_cost) AS cost,
            w.id AS work_order_id, w.title AS wo_title, a.name AS asset_name, s.name AS status_name
     FROM job_lines jl
     JOIN job_line_statuses s ON s.id = jl.status_id
     JOIN work_orders w ON w.id = jl.work_order_id
     LEFT JOIN assets a ON a.id = w.asset_id
     LEFT JOIN (${JOB_LINE_EXPENSE_COST_SQL}) ec ON ec.job_line_id = jl.id
     WHERE s.counts_as_work_performed
       -- EITHER date landing in the period qualifies, rather than COALESCE picking one
       -- and discarding the other: a line whose recorded date is outside the window but
       -- which was marked done inside it is exactly the arrears case this serves.
       AND (jl.completed_date BETWEEN $1 AND $2
            OR jl.completed_at::date BETWEEN $1 AND $2)
     ORDER BY COALESCE(jl.completed_date, jl.completed_at::date) DESC, jl.id`,
    [periodStart, periodEnd]
  );
  const woSeen = new Set();
  for (const [i, r] of rows.entries()) {
    // The WO rides along as the grouping header the screen expands.
    if (!woSeen.has(r.work_order_id)) {
      woSeen.add(r.work_order_id);
      await upsertBoardReportItem(reportId, { passId,
        itemType: 'work_order', itemId: r.work_order_id, section: 'done', sortIndex: i,
        snapTitle: r.wo_title, snapAssetName: r.asset_name,
      });
    }
    await upsertBoardReportItem(reportId, { passId,
      itemType: 'job_line', itemId: r.id, section: 'done', sortIndex: i,
      parentWorkOrderId: r.work_order_id,
      snapTitle: r.title,
      snapSubtitle: r.date_inferred ? `${r.wo_title} · date not recorded` : r.wo_title,
      snapAssetName: r.asset_name,
      snapStatus: r.status_name, snapDate: r.completed_date,
      snapHours: r.actual_hours, snapCost: r.cost,
    });
  }
  return rows.length;
}

// Admin work: existing opt-out semantics preserved exactly — flagged tasks arrive
// pre-checked, unflagged ones arrive unchecked rather than absent, so an excluded task
// is visible as a decision instead of vanishing.
async function suggestAdminTasks(reportId, passId, { periodStart, periodEnd }) {
  const { rows } = await pool.query(
    `${ADMIN_TASK_SELECT} WHERE s.counts_as_work_performed AND t.task_date BETWEEN $1 AND $2
     ORDER BY t.task_date, t.id`,
    [periodStart, periodEnd]
  );
  for (const [i, r] of rows.entries()) {
    const t = adminTaskRowShape(r);
    await upsertBoardReportItem(reportId, { passId,
      itemType: 'admin_task', itemId: t.Id, section: 'admin_work', sortIndex: i,
      included: t.IncludeInBoardReport,
      snapTitle: t.Title, snapSubtitle: t.CategoryName, snapStatus: t.StatusName,
      snapDate: t.TaskDate, snapHours: t.Hours,
    });
  }
  return rows.length;
}

// Coming Up: scheduled inside the forward window, plus anything flagged regardless of
// date, plus overdue. Overdue is computed, never a stored status, so it clears itself.
async function suggestComingUp(reportId, passId, { forwardStart, forwardEnd }) {
  const todayStr = today();
  const { rows } = await pool.query(
    `SELECT jl.id, jl.title, jl.scheduled_date::text AS scheduled_date, jl.estimated_cost,
            jl.board_focus, COALESCE(jl.board_focus_set_at, w.board_focus_set_at) AS focus_since,
            w.id AS work_order_id, w.title AS wo_title, w.board_focus AS wo_focus,
            a.name AS asset_name, s.is_terminal
     FROM job_lines jl
     JOIN job_line_statuses s ON s.id = jl.status_id
     JOIN work_orders w ON w.id = jl.work_order_id
     JOIN work_order_statuses ws ON ws.id = w.status_id
     LEFT JOIN assets a ON a.id = w.asset_id
     WHERE NOT s.is_terminal AND NOT ws.is_terminal
       AND (jl.scheduled_date BETWEEN $1 AND $2 OR jl.board_focus OR w.board_focus
            OR jl.scheduled_date < $3)
     ORDER BY jl.scheduled_date NULLS LAST, jl.id`,
    [forwardStart, forwardEnd, todayStr]
  );
  for (const [i, r] of rows.entries()) {
    const overdue = r.scheduled_date && r.scheduled_date < todayStr;
    await upsertBoardReportItem(reportId, { passId,
      itemType: 'job_line', itemId: r.id, section: overdue ? 'overdue' : 'coming_up', sortIndex: i,
      parentWorkOrderId: r.work_order_id,
      snapTitle: r.title,
      // "Featured since March" — a stale flag should be visible as stale.
      snapSubtitle: (r.board_focus || r.wo_focus) && r.focus_since
        ? `${r.wo_title} · featured since ${new Date(r.focus_since).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`
        : r.wo_title,
      snapAssetName: r.asset_name,
      snapDate: r.scheduled_date, snapCost: r.estimated_cost,
    });
  }
  return rows.length;
}

// Findings flagged "Feature on board report" — no date at all, which is the point:
// a deferred finding belongs in front of the board precisely because nothing is
// scheduled for it.
async function suggestFeaturedFindings(reportId, passId) {
  const { rows } = await pool.query(
    `SELECT cf.id, cf.title, cf.estimated_cost, cf.severity, cf.status, a.name AS asset_name
     FROM condition_findings cf LEFT JOIN assets a ON a.id = cf.asset_id
     WHERE cf.board_focus = true ORDER BY cf.id DESC`
  );
  for (const [i, r] of rows.entries()) {
    await upsertBoardReportItem(reportId, { passId,
      itemType: 'condition_finding', itemId: r.id, section: 'coming_up', sortIndex: 1000 + i,
      snapTitle: r.title, snapSubtitle: r.severity, snapAssetName: r.asset_name,
      snapStatus: r.status, snapCost: r.estimated_cost,
    });
  }
  return rows.length;
}

// Calendar events whose TYPE is opted in, plus scheduler occurrences projected from
// the recurrence machinery. listCalendarEventOccurrences is a pure read that already
// reports which occurrences are materialized, so a projection is replaced by its real
// work order rather than duplicated alongside it.
async function suggestCalendarAndProjections(reportId, passId, { forwardStart, forwardEnd }) {
  const occurrences = await listCalendarEventOccurrences(forwardStart, forwardEnd);
  const { rows: typeRows } = await pool.query(
    'SELECT id FROM calendar_event_types WHERE show_on_board_report'
  );
  const showTypes = new Set(typeRows.map((t) => t.id));
  let n = 0;
  for (const [i, occ] of occurrences.entries()) {
    const isPm = !!occ.WorkOrderTemplateId;
    if (!isPm && !showTypes.has(occ.TypeId)) continue;
    // listCalendarEventOccurrences overrides WorkOrderId with the generated one when
    // calendar_event_generated_wo has a row for this occurrence, so for a PM occurrence
    // a set WorkOrderId means "already materialized". That's the dedupe: the real work
    // order becomes the item and the projection is never written beside it.
    if (isPm && occ.WorkOrderId) {
      await upsertBoardReportItem(reportId, { passId,
        itemType: 'work_order', itemId: occ.WorkOrderId, section: 'coming_up', sortIndex: 2000 + i,
        snapTitle: occ.WorkOrderTitle || occ.Title, snapDate: occ.OccurrenceDate,
      });
    } else {
      const cost = isPm ? await historicalAvgActualCost(occ.WorkOrderTemplateId) : null;
      await upsertBoardReportItem(reportId, { passId,
        itemType: 'projected_occurrence', itemId: occ.Id, itemDate: occ.OccurrenceDate,
        section: 'coming_up', sortIndex: 2000 + i,
        snapTitle: occ.Title, snapDate: occ.OccurrenceDate, snapCost: cost,
        // Forward Focus's cost basis, preserved on merge: a projection priced from what
        // the job has actually cost before beats a stale estimate.
        snapSubtitle: cost != null ? 'hist. avg' : null,
      });
    }
    n += 1;
  }
  return n;
}

// One pass over every rule. Safe to re-run — that's what makes changing the period on
// the screen cheap, and why upsert never clobbers a decision.
export async function refreshBoardReportSuggestions(reportId) {
  const report = await getBoardReport(reportId);
  if (!report) return null;
  if (report.Status === 'published') {
    const e = new Error('Published reports are read-only'); e.status = 409; throw e;
  }
  const periods = {
    periodStart: report.PeriodStart, periodEnd: report.PeriodEnd,
    forwardStart: report.ForwardStart, forwardEnd: report.ForwardEnd,
  };
  // A token, not a timestamp: "did THIS pass write this row" is an exact question, and
  // comparing a JS clock to the database's was what made the prune delete rows the pass
  // had just written (0093).
  const passId = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const counts = {
    done: await suggestDoneJobLines(reportId, passId, periods),
    adminWork: await suggestAdminTasks(reportId, passId, periods),
    comingUp: await suggestComingUp(reportId, passId, periods),
    featured: await suggestFeaturedFindings(reportId, passId),
    calendar: await suggestCalendarAndProjections(reportId, passId, periods),
  };
  // Drop what the current period no longer suggests — but only where the user never
  // decided anything about it. An unchecked row, a board note, or an itemized work
  // order is a judgment, and a date change must not throw one away silently.
  const { rows: pruned } = await pool.query(
    `DELETE FROM board_report_items
     WHERE report_id = $1 AND NOT user_touched AND manually_added = false
       AND last_pass_id IS DISTINCT FROM $2
     RETURNING id`,
    [reportId, passId]
  );
  return {
    counts,
    prunedCount: pruned.length,
    items: await listBoardReportItems(reportId),
  };
}

// ── Board reports as entities (Build Brief §3/§4) ────────────────────────
// Draft -> publish, with every send kept. Publishing freezes both the items and the
// aggregates, because until now only the completed section was period-bounded and
// every other figure silently moved as work continued.

function boardReportRowShape(r) {
  return {
    Id: r.id, Title: r.title, Status: r.status,
    PeriodStart: r.period_start_text || r.period_start,
    PeriodEnd: r.period_end_text || r.period_end,
    ForwardStart: r.forward_start_text || r.forward_start,
    ForwardEnd: r.forward_end_text || r.forward_end,
    SummaryNotes: r.summary_notes,
    CreatedAt: r.created_at, UpdatedAt: r.updated_at, PublishedAt: r.published_at,
  };
}

const BOARD_REPORT_SELECT = `
  SELECT r.*, r.period_start::text AS period_start_text, r.period_end::text AS period_end_text,
         r.forward_start::text AS forward_start_text, r.forward_end::text AS forward_end_text
  FROM board_reports r`;

// §4: backward runs from the last PUBLISHED report's period_end (first ever: the start
// of this month) through today. Forward defaults to the same length, so "last 30 days /
// next 30 days" falls out rather than being a second thing to configure.
export async function defaultBoardReportPeriods() {
  const { rows } = await pool.query(
    `SELECT period_end::text AS period_end FROM board_reports
     WHERE status = 'published' ORDER BY period_end DESC, id DESC LIMIT 1`
  );
  const todayStr = today();
  const start = rows[0]?.period_end || `${todayStr.slice(0, 7)}-01`;
  const spanDays = Math.max(1, Math.round((new Date(todayStr) - new Date(start)) / 86400000));
  const forwardEnd = new Date(new Date(todayStr).getTime() + spanDays * 86400000)
    .toISOString().slice(0, 10);
  return { periodStart: start, periodEnd: todayStr, forwardStart: todayStr, forwardEnd };
}

// One draft at a time — the partial unique index enforces it, this just makes the
// screen idempotent: opening the report is "give me the draft," not "make one."
export async function getOrCreateDraftBoardReport() {
  const existing = await pool.query(`${BOARD_REPORT_SELECT} WHERE r.status = 'draft' LIMIT 1`);
  if (existing.rows[0]) return boardReportRowShape(existing.rows[0]);
  const p = await defaultBoardReportPeriods();
  const title = new Date(p.periodEnd).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const { rows } = await pool.query(
    `INSERT INTO board_reports (title, status, period_start, period_end, forward_start, forward_end)
     VALUES ($1,'draft',$2,$3,$4,$5) RETURNING id`,
    [title, p.periodStart, p.periodEnd, p.forwardStart, p.forwardEnd]
  );
  return getBoardReport(rows[0].id);
}

export async function getBoardReport(id) {
  const { rows } = await pool.query(`${BOARD_REPORT_SELECT} WHERE r.id = $1`, [id]);
  return rows[0] ? boardReportRowShape(rows[0]) : null;
}

export async function listBoardReports() {
  const { rows } = await pool.query(
    `${BOARD_REPORT_SELECT} ORDER BY COALESCE(r.published_at, r.created_at) DESC`
  );
  return rows.map(boardReportRowShape);
}

const BOARD_REPORT_UPDATE_COLUMNS = {
  title: 'title', periodStart: 'period_start', periodEnd: 'period_end',
  forwardStart: 'forward_start', forwardEnd: 'forward_end', summaryNotes: 'summary_notes',
};
// Published reports are read-only: a report the board has already seen must not change
// underneath them, which is the entire point of publishing.
export async function updateBoardReport(id, fields) {
  const cur = await getBoardReport(id);
  if (!cur) return null;
  if (cur.Status === 'published') {
    const e = new Error('Published reports are read-only'); e.status = 409; throw e;
  }
  const setCols = []; const vals = []; let i = 2;
  for (const [key, col] of Object.entries(BOARD_REPORT_UPDATE_COLUMNS)) {
    if (fields[key] === undefined) continue;
    setCols.push(`${col} = $${i++}`); vals.push(fields[key]);
  }
  if (!setCols.length) return cur;
  await pool.query(`UPDATE board_reports SET ${setCols.join(', ')} WHERE id = $1`, [id, ...vals]);
  return getBoardReport(id);
}

export async function listBoardReportItems(reportId) {
  const { rows } = await pool.query(
    `SELECT *, item_date::text AS item_date_text, snap_date::text AS snap_date_text
     FROM board_report_items WHERE report_id = $1 ORDER BY section, sort_index, id`,
    [reportId]
  );
  return rows.map((r) => ({
    Id: r.id, ItemType: r.item_type, ItemId: r.item_id, ItemDate: r.item_date_text,
    Section: r.section, Included: r.included, DisplayMode: r.display_mode,
    ReportNote: r.report_note, SortIndex: r.sort_index,
    SnapTitle: r.snap_title, SnapSubtitle: r.snap_subtitle, SnapAssetName: r.snap_asset_name,
    SnapStatus: r.snap_status, SnapDate: r.snap_date_text,
    SnapHours: r.snap_hours != null ? Number(r.snap_hours) : null,
    SnapCost: r.snap_cost != null ? Number(r.snap_cost) : null,
    SnapProgress: r.snap_progress,
    ParentWorkOrderId: r.parent_work_order_id,
    UserTouched: r.user_touched,
    ManuallyAdded: r.manually_added,
  }));
}

// Upsert so the suggestion pass and a user's toggle write the same row. A suggestion
// never overwrites a decision already made: included/display_mode/report_note are only
// set on insert unless explicitly passed.
export async function upsertBoardReportItem(reportId, {
  itemType, itemId, itemDate = null, section, included, displayMode, reportNote, sortIndex,
  snapTitle, snapSubtitle, snapAssetName, snapStatus, snapDate, snapHours, snapCost, snapProgress,
  parentWorkOrderId = null, passId = null,
}) {
  const { rows } = await pool.query(
    `INSERT INTO board_report_items
       (report_id, item_type, item_id, item_date, section, included, display_mode, report_note, sort_index,
        snap_title, snap_subtitle, snap_asset_name, snap_status, snap_date, snap_hours, snap_cost, snap_progress,
        parent_work_order_id, suggested_at, last_pass_id)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,true),COALESCE($7,'summary'),$8,COALESCE($9,0),
             $10,$11,$12,$13,$14,$15,$16,$17,$18,now(),$19)
     -- Matches the expression index from 0092: item_date is nullable, and NULL is
     -- DISTINCT from NULL in a plain unique constraint, so a bare column list here
     -- could never find the existing row and every pass inserted a duplicate.
     ON CONFLICT (report_id, item_type, item_id, (COALESCE(item_date, DATE '1900-01-01'))) DO UPDATE SET
       section      = EXCLUDED.section,
       included     = COALESCE($6, board_report_items.included),
       display_mode = COALESCE($7, board_report_items.display_mode),
       report_note  = COALESCE($8, board_report_items.report_note),
       snap_title   = COALESCE(EXCLUDED.snap_title, board_report_items.snap_title),
       snap_subtitle= COALESCE(EXCLUDED.snap_subtitle, board_report_items.snap_subtitle),
       snap_asset_name = COALESCE(EXCLUDED.snap_asset_name, board_report_items.snap_asset_name),
       snap_status  = COALESCE(EXCLUDED.snap_status, board_report_items.snap_status),
       snap_date    = COALESCE(EXCLUDED.snap_date, board_report_items.snap_date),
       snap_hours   = COALESCE(EXCLUDED.snap_hours, board_report_items.snap_hours),
       snap_cost    = COALESCE(EXCLUDED.snap_cost, board_report_items.snap_cost),
       snap_progress= COALESCE(EXCLUDED.snap_progress, board_report_items.snap_progress)
     RETURNING id`,
    [reportId, itemType, itemId, itemDate, section, included ?? null, displayMode ?? null,
      reportNote ?? null, sortIndex ?? null, snapTitle ?? null, snapSubtitle ?? null,
      snapAssetName ?? null, snapStatus ?? null, snapDate ?? null, snapHours ?? null,
      snapCost ?? null, snapProgress ?? null, parentWorkOrderId, passId]
  );
  return rows[0].id;
}

// Checking a work order is shorthand for checking all its lines (§6): the WO row is a
// grouping header, so its own checkbox has to carry the lines with it or the tri-state
// would lie.
export async function setBoardReportItemIncluded(reportId, itemId, included) {
  const { rows } = await pool.query(
    `UPDATE board_report_items SET included = $3, user_touched = true
     WHERE report_id = $1 AND id = $2 RETURNING item_type, item_id`,
    [reportId, itemId, !!included]
  );
  if (!rows[0]) return null;
  if (rows[0].item_type === 'work_order') {
    await pool.query(
      `UPDATE board_report_items SET included = $3, user_touched = true
       WHERE report_id = $1 AND item_type = 'job_line'
         AND item_id IN (SELECT id FROM job_lines WHERE work_order_id = $2)`,
      [reportId, rows[0].item_id, !!included]
    );
  }
  return listBoardReportItems(reportId);
}

export async function setBoardReportItemFields(reportId, itemId, { displayMode, reportNote }) {
  const setCols = []; const vals = []; let i = 3;
  if (displayMode !== undefined) { setCols.push(`display_mode = $${i++}`); vals.push(displayMode); }
  if (reportNote !== undefined) { setCols.push(`report_note = $${i++}`); vals.push(reportNote); }
  if (!setCols.length) return listBoardReportItems(reportId);
  await pool.query(
    `UPDATE board_report_items SET ${setCols.join(', ')}, user_touched = true
     WHERE report_id = $1 AND id = $2`,
    [reportId, itemId, ...vals]
  );
  return listBoardReportItems(reportId);
}

export async function replaceBoardReportAggregates(reportId, aggregates) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM board_report_aggregates WHERE report_id = $1', [reportId]);
    for (const [idx, a] of aggregates.entries()) {
      await client.query(
        `INSERT INTO board_report_aggregates (report_id, group_key, label, value_numeric, value_text, sort_index)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [reportId, a.groupKey, a.label, a.valueNumeric ?? null, a.valueText ?? null, a.sortIndex ?? idx]
      );
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

export async function listBoardReportAggregates(reportId) {
  const { rows } = await pool.query(
    `SELECT * FROM board_report_aggregates WHERE report_id = $1 ORDER BY group_key, sort_index, id`,
    [reportId]
  );
  return rows.map((r) => ({
    Id: r.id, GroupKey: r.group_key, Label: r.label,
    ValueNumeric: r.value_numeric != null ? Number(r.value_numeric) : null,
    ValueText: r.value_text, SortIndex: r.sort_index,
  }));
}

// Publish: drop the items nobody checked, then freeze. Excluded rows are deleted rather
// than kept as included=false, so a published report contains exactly what the board
// saw — no shadow list of things that were considered and cut.
export async function publishBoardReport(id) {
  const cur = await getBoardReport(id);
  if (!cur) return null;
  if (cur.Status === 'published') return cur;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM board_report_items WHERE report_id = $1 AND NOT included', [id]);
    await client.query(
      `UPDATE board_reports SET status = 'published', published_at = now() WHERE id = $1`, [id]
    );
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await logActivity({ action: 'published', entityType: 'board_report', entityId: Number(id), entityLabel: cur.Title });
  return getBoardReport(id);
}

// Every time a report leaves the app, a copy of exactly what left is kept. Email,
// download and a deliberate "Save a copy" are the same event as far as the record is
// concerned — the difference is only how it left.
export async function recordBoardReportOutput(reportId, { kind, recipients, subject, wasDraft, html, text, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO board_report_outputs (report_id, kind, recipients, subject, was_draft, snapshot_html, snapshot_text, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [reportId, kind, recipients || null, subject, !!wasDraft, html, text, createdBy || null]
  );
  return { Id: rows[0].id, Kind: kind, CreatedAt: rows[0].created_at };
}

export async function listBoardReportOutputs(reportId = null) {
  const { rows } = await pool.query(
    reportId
      ? `SELECT o.*, r.title FROM board_report_outputs o JOIN board_reports r ON r.id = o.report_id
         WHERE o.report_id = $1 ORDER BY o.created_at DESC`
      : `SELECT o.*, r.title FROM board_report_outputs o JOIN board_reports r ON r.id = o.report_id
         ORDER BY o.created_at DESC`,
    reportId ? [reportId] : []
  );
  return rows.map((r) => ({
    Id: r.id, ReportId: r.report_id, ReportTitle: r.title, Kind: r.kind, CreatedAt: r.created_at,
    Recipients: r.recipients, Subject: r.subject, WasDraft: r.was_draft, CreatedBy: r.created_by,
  }));
}

export async function getBoardReportOutput(outputId) {
  const { rows } = await pool.query(
    `SELECT o.*, r.title FROM board_report_outputs o JOIN board_reports r ON r.id = o.report_id WHERE o.id = $1`,
    [outputId]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    Id: r.id, ReportId: r.report_id, ReportTitle: r.title, Kind: r.kind, CreatedAt: r.created_at,
    Recipients: r.recipients, Subject: r.subject, WasDraft: r.was_draft,
    SnapshotHtml: r.snapshot_html, SnapshotText: r.snapshot_text, CreatedBy: r.created_by,
  };
}

// ── Split editor: line items and allocations (Build Brief §9) ────────────

export async function listExpenseLineItems(expenseId) {
  const { rows } = await pool.query(
    `SELECT li.*, m.name AS material_name, m.unit AS material_unit
     FROM expense_line_items li LEFT JOIN materials m ON m.id = li.material_id
     WHERE li.expense_id = $1 ORDER BY li.sort_index, li.id`,
    [expenseId]
  );
  return rows.map((r) => ({
    Id: r.id, ExpenseId: r.expense_id, Description: r.description,
    Quantity: r.quantity != null ? Number(r.quantity) : null, Unit: r.unit,
    PaidAmount: r.paid_amount != null ? Number(r.paid_amount) : null,
    RegularPrice: r.regular_price != null ? Number(r.regular_price) : null,
    MaterialId: r.material_id, MaterialName: r.material_name || null, MaterialUnit: r.material_unit || null,
    SortIndex: r.sort_index,
  }));
}

export async function listExpenseAllocations(expenseId) {
  const { rows } = await pool.query(
    `SELECT ea.*, jl.title AS job_line_title, w.title AS work_order_title,
            t.title AS admin_task_title, m.name AS material_name
     FROM expense_allocations ea
     LEFT JOIN job_lines jl ON ea.dest_type = 'job_line' AND jl.id = ea.dest_id
     LEFT JOIN work_orders w ON ea.dest_type = 'work_order' AND w.id = ea.dest_id
     LEFT JOIN admin_tasks t ON ea.dest_type = 'admin_task' AND t.id = ea.dest_id
     LEFT JOIN materials m ON m.id = ea.material_id
     WHERE ea.expense_id = $1 ORDER BY ea.id`,
    [expenseId]
  );
  return rows.map((r) => ({
    Id: r.id, ExpenseId: r.expense_id, LineItemId: r.line_item_id,
    DestType: r.dest_type, DestId: r.dest_id,
    DestLabel: r.job_line_title || r.work_order_title || r.admin_task_title
      || (r.dest_type === 'leftover' ? `Leftover stock${r.material_name ? ` — ${r.material_name}` : ''}` : null),
    Quantity: r.quantity != null ? Number(r.quantity) : null,
    Amount: Number(r.amount),
    SavingsAmount: r.savings_amount != null ? Number(r.savings_amount) : 0,
    MaterialId: r.material_id, MaterialName: r.material_name || null,
    FundingSource: r.funding_source, FundingRefId: r.funding_ref_id,
  }));
}

export async function createExpenseLineItem(expenseId, { description, quantity, unit, paidAmount, regularPrice, materialId, sortIndex }) {
  const { rows } = await pool.query(
    `INSERT INTO expense_line_items (expense_id, description, quantity, unit, paid_amount, regular_price, material_id, sort_index)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,0)) RETURNING id`,
    [expenseId, description, quantity ?? null, unit || null, paidAmount ?? null, regularPrice ?? null, materialId || null, sortIndex ?? null]
  );
  return rows[0].id;
}

export async function deleteExpenseLineItem(lineItemId) {
  await pool.query('DELETE FROM expense_line_items WHERE id = $1', [lineItemId]);
}

// Savings follow the split proportionally and are never created by it: the receipt's
// discount was counted once at purchase (§9), so each share carries its slice and the
// slices add back up to the whole.
async function distributeSavings(expenseId) {
  const { rows: er } = await pool.query(
    'SELECT amount, regular_price FROM expenses WHERE id = $1', [expenseId]
  );
  const paid = er[0]?.amount != null ? Number(er[0].amount) : null;
  const regular = er[0]?.regular_price != null ? Number(er[0].regular_price) : null;
  const discount = (paid != null && regular != null && regular > paid) ? regular - paid : 0;
  const { rows: al } = await pool.query(
    'SELECT id, amount FROM expense_allocations WHERE expense_id = $1 ORDER BY id', [expenseId]
  );
  const total = al.reduce((t, a) => t + Number(a.amount), 0);
  for (const a of al) {
    const share = (discount > 0 && total > 0) ? Math.round((discount * (Number(a.amount) / total)) * 100) / 100 : 0;
    await pool.query('UPDATE expense_allocations SET savings_amount = $2 WHERE id = $1', [a.id, share]);
  }
}

export async function createExpenseAllocation(expenseId, {
  lineItemId, destType, destId, quantity, amount, materialId, fundingSource, fundingRefId,
}) {
  const { rows: er } = await pool.query('SELECT fund_id FROM expenses WHERE id = $1', [expenseId]);
  // An explicit choice in the split editor wins; otherwise it inherits and is stamped.
  const funding = (fundingSource !== undefined && fundingSource !== null)
    ? { fundingSource, fundingRefId: fundingRefId ?? null }
    : await resolveAllocationFunding({ destType, destId, fallbackFundId: er[0]?.fund_id ?? null });
  const { rows } = await pool.query(
    `INSERT INTO expense_allocations
       (expense_id, line_item_id, dest_type, dest_id, quantity, amount, material_id, funding_source, funding_ref_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [expenseId, lineItemId || null, destType, destId || null, quantity ?? null,
      amount ?? 0, materialId || null, funding.fundingSource, funding.fundingRefId]
  );
  await distributeSavings(expenseId);
  return rows[0].id;
}

export async function deleteExpenseAllocation(allocationId) {
  const { rows } = await pool.query(
    'DELETE FROM expense_allocations WHERE id = $1 RETURNING expense_id', [allocationId]
  );
  if (rows[0]) await distributeSavings(rows[0].expense_id);
}

// What's left to split. The everyday single-destination case never shows this; it
// exists so a partially split receipt says plainly how much is still unassigned.
export async function getExpenseSplitSummary(expenseId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(e.amount, 0) AS total,
            COALESCE((SELECT SUM(amount) FROM expense_allocations WHERE expense_id = e.id), 0) AS allocated
     FROM expenses e WHERE e.id = $1`,
    [expenseId]
  );
  if (!rows[0]) return null;
  const total = Number(rows[0].total);
  const allocated = Number(rows[0].allocated);
  return {
    Total: total, Allocated: allocated,
    Unallocated: Math.round((total - allocated) * 100) / 100,
    FullyAllocated: Math.abs(total - allocated) < 0.005,
  };
}

// ── Scheduler: materializing audit rounds (Build Brief §6) ───────────────
// Reuses the machinery that already generates PM work orders — recurrence expansion, a
// guard table, an advisory lock — rather than a parallel scheduler. The one real gap
// was that nothing ran unless someone opened the calendar; startAuditScheduler fixes
// that without adding a dependency.

export async function generateDueAuditRoundsForRange(fromDate, toDate) {
  const todayStr = today();
  const cappedTo = toDate < todayStr ? toDate : todayStr;
  if (cappedTo < fromDate) return [];
  const occurrences = (await listCalendarEventOccurrences(fromDate, cappedTo))
    .filter((o) => o.AuditFormId);
  const created = [];
  for (const occ of occurrences) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Same lock the WO generator uses: two instances booting together must not both
      // create the round.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cegr:${occ.Id}:${occ.OccurrenceDate}`]);
      const { rows: exists } = await client.query(
        'SELECT 1 FROM calendar_event_generated_round WHERE calendar_event_id = $1 AND occurrence_date = $2',
        [occ.Id, occ.OccurrenceDate]
      );
      if (exists[0]) { await client.query('ROLLBACK'); continue; }

      const { rows: scope } = await client.query(
        'SELECT asset_id FROM calendar_event_audit_scope WHERE calendar_event_id = $1', [occ.Id]
      );
      if (!scope.length) { await client.query('ROLLBACK'); continue; }

      const dueDate = new Date(new Date(occ.OccurrenceDate).getTime() + (occ.AuditGraceDays ?? 14) * 86400000)
        .toISOString().slice(0, 10);
      const { rows: rr } = await client.query(
        `INSERT INTO audit_rounds (form_id, name, scheduled_date, due_date) VALUES ($1,$2,$3,$4) RETURNING id`,
        [occ.AuditFormId, `${occ.Title} — ${occ.OccurrenceDate}`, occ.OccurrenceDate, dueDate]
      );
      const roundId = rr[0].id;
      for (const sc of scope) {
        await client.query(
          `INSERT INTO audit_round_instances (round_id, asset_id) VALUES ($1,$2)
           ON CONFLICT (round_id, asset_id) DO NOTHING`, [roundId, sc.asset_id]
        );
      }
      await client.query(
        `INSERT INTO calendar_event_generated_round (calendar_event_id, occurrence_date, round_id)
         VALUES ($1,$2,$3)`, [occ.Id, occ.OccurrenceDate, roundId]
      );
      await client.query('COMMIT');
      created.push(roundId);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('audit round materialization failed:', e.message);
    } finally { client.release(); }
  }
  return created;
}

// The daily job. Until now materialization only happened when someone opened the
// calendar, so a scheduled round could sit undone simply because nobody looked. A
// boot-time interval is enough here — no new dependency, and the guard tables make
// double-runs harmless.
let auditSchedulerTimer = null;
export function startAuditScheduler() {
  if (auditSchedulerTimer) return;
  const run = async () => {
    try {
      const from = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
      const to = today();
      const wos = await generateDueWorkOrdersForRange(from, to);
      const rounds = await generateDueAuditRoundsForRange(from, to);
      if (wos.length || rounds.length) {
        console.log(`scheduler: ${wos.length} work order(s), ${rounds.length} audit round(s) materialized`);
      }
    } catch (e) { console.error('scheduler run failed:', e.message); }
  };
  // A minute after boot so it never competes with startup, then daily.
  setTimeout(run, 60_000);
  auditSchedulerTimer = setInterval(run, 24 * 60 * 60 * 1000);
  console.log('scheduler: daily materialization armed');
}

// Overdue is COMPUTED, never stored (§6), so it clears itself when work completes.
// Includes deferred items whose revisit date has passed — surfacing those was already
// owed before this brief.
export async function getOverdueStrip() {
  const [wos, rounds, revisits] = await Promise.all([
    pool.query(
      `SELECT w.id, w.title, w.due_date::text AS due_date,
              (CURRENT_DATE - w.due_date) AS days_over
       FROM work_orders w JOIN work_order_statuses ws ON ws.id = w.status_id
       WHERE NOT ws.is_terminal AND w.due_date IS NOT NULL AND w.due_date < CURRENT_DATE
       ORDER BY w.due_date LIMIT 20`),
    pool.query(
      `SELECT r.id, r.name, r.due_date::text AS due_date,
              (CURRENT_DATE - r.due_date) AS days_over,
              count(i.id)::int total,
              count(i.id) FILTER (WHERE i.status = 'complete')::int complete
       FROM audit_rounds r LEFT JOIN audit_round_instances i ON i.round_id = r.id
       WHERE r.status = 'open' AND r.due_date IS NOT NULL AND r.due_date < CURRENT_DATE
       GROUP BY r.id, r.name, r.due_date
       HAVING count(i.id) FILTER (WHERE i.status = 'complete') < count(i.id)
       ORDER BY r.due_date LIMIT 20`),
    pool.query(
      `SELECT cf.id, cf.title, cf.revisit_date::text AS revisit_date,
              (CURRENT_DATE - cf.revisit_date) AS days_over
       FROM condition_findings cf
       WHERE cf.status = 'Deferred' AND cf.revisit_date IS NOT NULL AND cf.revisit_date < CURRENT_DATE
       ORDER BY cf.revisit_date LIMIT 20`),
  ]);
  return {
    WorkOrders: wos.rows.map((r) => ({ Id: r.id, Title: r.title, DueDate: r.due_date, DaysOver: Number(r.days_over) })),
    Rounds: rounds.rows.map((r) => ({
      Id: r.id, Name: r.name, DueDate: r.due_date, DaysOver: Number(r.days_over),
      Percent: r.total ? Math.round((r.complete / r.total) * 100) : 0,
    })),
    DeferredRevisits: revisits.rows.map((r) => ({ Id: r.id, Title: r.title, RevisitDate: r.revisit_date, DaysOver: Number(r.days_over) })),
  };
}

// ── Query surfaces (Build Brief §8) ──────────────────────────────────────
// The proof the data isn't buried. All plain SQL over audit_answers, which is exactly
// why answers are relational rows and not a JSON blob of each form.

// Every audit answer ever recorded for one asset, newest round first, with the work it
// produced interleaved — "Roof: Fair (2026) → Poor (2027) → Replaced (WO 1042)".
export async function getAssetConditionHistory(assetId) {
  const { rows } = await pool.query(
    `SELECT an.id, an.question_key, an.value, an.note, an.kind,
            q.prompt, o.flag, o.severe,
            r.name AS round_name, i.completed_at, i.generated_wo_id,
            w.title AS wo_title, cf.id AS finding_id, cf.status AS finding_status
     FROM audit_answers an
     JOIN audit_round_instances i ON i.id = an.instance_id
     JOIN audit_rounds r ON r.id = i.round_id
     LEFT JOIN audit_questions q ON q.id = an.question_id
     LEFT JOIN audit_question_options o ON o.id = an.option_id
     LEFT JOIN work_orders w ON w.id = i.generated_wo_id
     LEFT JOIN condition_findings cf ON cf.audit_answer_id = an.id
     WHERE i.asset_id = $1 AND an.active
     ORDER BY i.completed_at DESC NULLS FIRST, an.question_key`,
    [assetId]
  );
  // Grouped by question so the same key across years reads as one story.
  const byKey = new Map();
  for (const r of rows) {
    const key = r.question_key;
    if (!byKey.has(key)) byKey.set(key, { QuestionKey: key, Prompt: r.prompt || 'Flagged separately', Entries: [] });
    byKey.get(key).Entries.push({
      AnswerId: r.id, Value: r.value, Note: r.note, Kind: r.kind,
      Flagged: !!r.flag, Severe: !!r.severe, RoundName: r.round_name,
      CompletedAt: r.completed_at, WorkOrderId: r.generated_wo_id, WorkOrderTitle: r.wo_title,
      FindingId: r.finding_id, FindingStatus: r.finding_status,
    });
  }
  return [...byKey.values()];
}

// Asset condition status (§5d): three states, always WITH the reasons. Computed on
// read, never stored, so it clears itself as work completes.
export async function getAssetConditionStatus(assetId) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*) FROM work_orders w
          JOIN work_order_statuses ws ON ws.id = w.status_id
        WHERE w.asset_id = $1 AND NOT ws.is_terminal AND w.due_date IS NOT NULL AND w.due_date < CURRENT_DATE) AS overdue_wos,
       (SELECT count(*) FROM work_orders w
          JOIN work_order_statuses ws ON ws.id = w.status_id
        WHERE w.asset_id = $1 AND NOT ws.is_terminal) AS open_wos,
       (SELECT count(*) FROM condition_findings cf
        WHERE cf.asset_id = $1 AND cf.status IN ('Open','Scheduled','Deferred')) AS open_findings,
       (SELECT max(i.completed_at) FROM audit_round_instances i
        WHERE i.asset_id = $1 AND i.status = 'complete') AS last_audit`,
    [assetId]
  );
  const m = rows[0];
  // Severe = a flagged answer in the LATEST completed audit whose option is marked
  // severe and whose finding hasn't been resolved. Fair is worth a work order; only
  // Poor/Failed is worth calling the building poor.
  const { rows: sev } = await pool.query(
    `SELECT q.prompt, an.value, r.name AS round_name
     FROM audit_round_instances i
     JOIN audit_rounds r ON r.id = i.round_id
     JOIN audit_answers an ON an.instance_id = i.id AND an.active
     JOIN audit_question_options o ON o.id = an.option_id AND o.severe
     LEFT JOIN audit_questions q ON q.id = an.question_id
     LEFT JOIN condition_findings cf ON cf.audit_answer_id = an.id
     WHERE i.asset_id = $1 AND i.status = 'complete'
       AND i.completed_at = (SELECT max(completed_at) FROM audit_round_instances
                             WHERE asset_id = $1 AND status = 'complete')
       AND (cf.id IS NULL OR cf.status NOT IN ('Resolved','Dismissed'))`,
    [assetId]
  );

  const reasons = [];
  for (const sv of sev) reasons.push(`${sv.prompt || 'Flagged'}: ${sv.value} (${sv.round_name})`);
  if (Number(m.overdue_wos)) reasons.push(`${m.overdue_wos} overdue work order(s)`);
  if (Number(m.open_findings)) reasons.push(`${m.open_findings} open finding(s)`);
  if (Number(m.open_wos)) reasons.push(`${m.open_wos} open work order(s)`);

  let status;
  if (Number(m.overdue_wos) > 0 || sev.length > 0) status = 'Poor';
  else if (Number(m.open_findings) > 0 || Number(m.open_wos) > 0) status = 'Needs attention';
  else status = 'Good';

  return {
    Status: status,
    Reasons: reasons,
    NeverAudited: !m.last_audit,
    LastAuditAt: m.last_audit,
  };
}

// The audit data screen (§8): form + question (+ round) -> asset x answer, filterable,
// with counts. "All buildings where roof_condition = Poor" is a WHERE clause.
export async function queryAuditAnswers({ formId, questionKey, value, roundId, limit = 500 }) {
  const where = ['an.active']; const vals = [];
  if (formId) { vals.push(formId); where.push(`r.form_id = $${vals.length}`); }
  if (questionKey) { vals.push(questionKey); where.push(`an.question_key = $${vals.length}`); }
  if (value) { vals.push(value); where.push(`an.value = $${vals.length}`); }
  if (roundId) { vals.push(roundId); where.push(`r.id = $${vals.length}`); }
  vals.push(limit);
  const { rows } = await pool.query(
    `SELECT a.id AS asset_id, a.name AS asset_name, l.name AS location_name,
            an.question_key, an.value, an.note, o.flag, o.severe,
            r.name AS round_name, i.completed_at, i.generated_wo_id
     FROM audit_answers an
     JOIN audit_round_instances i ON i.id = an.instance_id
     JOIN audit_rounds r ON r.id = i.round_id
     JOIN assets a ON a.id = i.asset_id
     LEFT JOIN locations l ON l.id = a.location_id
     LEFT JOIN audit_question_options o ON o.id = an.option_id
     WHERE ${where.join(' AND ')}
     ORDER BY a.name LIMIT $${vals.length}`,
    vals
  );
  const counts = new Map();
  for (const r of rows) counts.set(r.value, (counts.get(r.value) || 0) + 1);
  return {
    Rows: rows.map((r) => ({
      AssetId: r.asset_id, AssetName: r.asset_name, LocationName: r.location_name,
      QuestionKey: r.question_key, Value: r.value, Note: r.note,
      Flagged: !!r.flag, Severe: !!r.severe, RoundName: r.round_name,
      CompletedAt: r.completed_at, WorkOrderId: r.generated_wo_id,
    })),
    Counts: [...counts.entries()].map(([Value, Count]) => ({ Value, Count })).sort((a, b) => b.Count - a.Count),
  };
}

// Distinct question keys in use, so the data screen offers the real vocabulary.
export async function listAuditQuestionKeys(formId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT q.question_key, q.prompt FROM audit_questions q
     WHERE ($1::int IS NULL OR q.form_id = $1::int) AND NOT q.archived
     ORDER BY q.prompt`,
    [formId || null]
  );
  return rows.map((r) => ({ QuestionKey: r.question_key, Prompt: r.prompt }));
}

// Round report (§8): completion, flags by question, and what it generated — the
// budget-ask artifact.
export async function getAuditRoundReport(roundId) {
  const round = await getAuditRound(roundId);
  if (!round) return null;
  const [progress, flags, wos] = await Promise.all([
    pool.query(
      `SELECT count(*)::int total, count(*) FILTER (WHERE status = 'complete')::int complete,
              count(*) FILTER (WHERE generated_wo_id IS NOT NULL)::int with_wo
       FROM audit_round_instances WHERE round_id = $1`, [roundId]),
    pool.query(
      `SELECT COALESCE(q.prompt, 'Flagged separately') AS prompt, an.value, count(*)::int c
       FROM audit_answers an
       JOIN audit_round_instances i ON i.id = an.instance_id
       LEFT JOIN audit_questions q ON q.id = an.question_id
       LEFT JOIN audit_question_options o ON o.id = an.option_id
       WHERE i.round_id = $1 AND an.active AND (o.flag OR an.kind = 'adhoc_flag')
       GROUP BY 1, 2 ORDER BY c DESC`, [roundId]),
    pool.query(
      `SELECT w.id, w.title, a.name AS asset_name,
              COALESCE(sum(jl.estimated_hours), 0) AS hours,
              COALESCE(sum(jl.estimated_cost), 0) AS cost
       FROM audit_round_instances i
       JOIN work_orders w ON w.id = i.generated_wo_id
       JOIN assets a ON a.id = i.asset_id
       LEFT JOIN job_lines jl ON jl.work_order_id = w.id
       WHERE i.round_id = $1
       GROUP BY w.id, w.title, a.name ORDER BY cost DESC`, [roundId]),
  ]);
  const p = progress.rows[0];
  return {
    Round: round,
    Total: p.total, Complete: p.complete, WithWorkOrder: p.with_wo,
    Percent: p.total ? Math.round((p.complete / p.total) * 100) : 0,
    FlagsByQuestion: flags.rows.map((r) => ({ Prompt: r.prompt, Value: r.value, Count: r.c })),
    WorkOrders: wos.rows.map((r) => ({
      Id: r.id, Title: r.title, AssetName: r.asset_name,
      Hours: Number(r.hours), Cost: Number(r.cost),
    })),
    TotalHours: wos.rows.reduce((t, r) => t + Number(r.hours), 0),
    TotalCost: wos.rows.reduce((t, r) => t + Number(r.cost), 0),
  };
}

// ── Form builder (Build Brief §7) ────────────────────────────────────────
// A question with answers is ARCHIVED, never deleted — history has to stay readable.

export async function getAuditFormFull(formId) {
  const [form, sections, questions, options, remedies, btypes] = await Promise.all([
    pool.query('SELECT * FROM audit_forms WHERE id = $1', [formId]),
    pool.query('SELECT * FROM audit_sections WHERE form_id = $1 ORDER BY sort_index, id', [formId]),
    pool.query(
      `SELECT q.*, (SELECT count(*) FROM audit_answers a WHERE a.question_id = q.id) AS answer_count
       FROM audit_questions q WHERE q.form_id = $1 ORDER BY q.sort_index, q.id`, [formId]),
    pool.query(
      `SELECT o.* FROM audit_question_options o JOIN audit_questions q ON q.id = o.question_id
       WHERE q.form_id = $1 ORDER BY o.sort_index, o.id`, [formId]),
    pool.query(
      `SELECT r.* FROM audit_remedies r JOIN audit_question_options o ON o.id = r.option_id
       JOIN audit_questions q ON q.id = o.question_id WHERE q.form_id = $1 ORDER BY r.sort_index, r.id`, [formId]),
    pool.query(
      `SELECT b.*, bt.name FROM audit_question_building_types b
       JOIN building_types bt ON bt.id = b.building_type_id
       JOIN audit_questions q ON q.id = b.question_id WHERE q.form_id = $1`, [formId]),
  ]);
  if (!form.rows[0]) return null;

  const remByOpt = new Map();
  for (const r of remedies.rows) {
    if (!remByOpt.has(r.option_id)) remByOpt.set(r.option_id, []);
    remByOpt.get(r.option_id).push({
      Id: r.id, TitleTemplate: r.title_template, Responsibility: r.responsibility,
      FundingSource: r.funding_source, FundingRefId: r.funding_ref_id,
      EstHours: r.est_hours != null ? Number(r.est_hours) : null,
      EstCost: r.est_cost != null ? Number(r.est_cost) : null,
      IsFixture: r.is_fixture,
    });
  }
  const optByQ = new Map();
  for (const o of options.rows) {
    if (!optByQ.has(o.question_id)) optByQ.set(o.question_id, []);
    optByQ.get(o.question_id).push({
      Id: o.id, Label: o.label, Value: o.value, SortIndex: o.sort_index,
      Flag: o.flag, Severe: o.severe, Archived: o.archived, IsFixture: o.is_fixture,
      Remedies: remByOpt.get(o.id) || [],
    });
  }
  const btByQ = new Map();
  for (const b of btypes.rows) {
    if (!btByQ.has(b.question_id)) btByQ.set(b.question_id, []);
    btByQ.get(b.question_id).push({ Id: b.building_type_id, Name: b.name });
  }

  return {
    Form: { Id: form.rows[0].id, Name: form.rows[0].name, Description: form.rows[0].description,
      TargetNote: form.rows[0].target_note, Active: form.rows[0].active },
    Sections: sections.rows.map((x) => ({ Id: x.id, Name: x.name, SortIndex: x.sort_index })),
    Questions: questions.rows.map((q) => ({
      Id: q.id, SectionId: q.section_id, QuestionKey: q.question_key, Prompt: q.prompt,
      Type: q.type, Required: q.required, AllowsPhoto: q.allows_photo, SortIndex: q.sort_index,
      Archived: q.archived, ShowIf: q.show_if, MapsTo: q.maps_to,
      AnswerCount: Number(q.answer_count),
      Options: optByQ.get(q.id) || [], BuildingTypes: btByQ.get(q.id) || [],
    })),
  };
}

export async function createAuditForm({ name, description, targetNote }) {
  const { rows } = await pool.query(
    'INSERT INTO audit_forms (name, description, target_note) VALUES ($1,$2,$3) RETURNING id',
    [name, description || null, targetNote || null]
  );
  await logActivity({ action: 'created', entityType: 'audit_form', entityId: rows[0].id, entityLabel: name });
  return rows[0].id;
}

export async function createAuditSection(formId, { name, sortIndex }) {
  const { rows } = await pool.query(
    'INSERT INTO audit_sections (form_id, name, sort_index) VALUES ($1,$2,COALESCE($3,0)) RETURNING id',
    [formId, name, sortIndex ?? null]
  );
  return rows[0].id;
}

export async function updateAuditSection(id, { name, sortIndex }) {
  await pool.query(
    'UPDATE audit_sections SET name = COALESCE($2,name), sort_index = COALESCE($3,sort_index) WHERE id = $1',
    [id, name ?? null, sortIndex ?? null]
  );
}

// question_key is generated from the prompt when not given, and then LEFT ALONE:
// rewording a prompt keeps the key, because the key is what joins this question's
// answers across years (§8).
function slugifyKey(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'question';
}

export async function createAuditQuestion(formId, {
  sectionId, questionKey, prompt, type = 'select', required = false, allowsPhoto = false,
  sortIndex, showIf = null, mapsTo = null, options = [],
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let key = questionKey || slugifyKey(prompt);
    // Keys are unique per form; a collision gets a numeric suffix rather than an error
    // in the middle of someone building a form.
    const { rows: clash } = await client.query(
      'SELECT count(*)::int c FROM audit_questions WHERE form_id = $1 AND question_key = $2', [formId, key]
    );
    if (clash[0].c) key = `${key}_${Date.now().toString(36).slice(-4)}`;
    const { rows } = await client.query(
      `INSERT INTO audit_questions (form_id, section_id, question_key, prompt, type, required, allows_photo, sort_index, show_if, maps_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,0),$9,$10) RETURNING id`,
      [formId, sectionId || null, key, prompt, type, !!required, !!allowsPhoto, sortIndex ?? null,
        showIf ? JSON.stringify(showIf) : null, mapsTo ? JSON.stringify(mapsTo) : null]
    );
    const qid = rows[0].id;
    for (const [i, o] of options.entries()) {
      await client.query(
        'INSERT INTO audit_question_options (question_id, label, value, sort_index, flag, severe) VALUES ($1,$2,$3,$4,$5,$6)',
        [qid, o.label, o.value ?? o.label, i, !!o.flag, !!o.severe]
      );
    }
    await client.query('COMMIT');
    return qid;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

const QUESTION_COLUMNS = {
  sectionId: 'section_id', prompt: 'prompt', type: 'type', required: 'required',
  allowsPhoto: 'allows_photo', sortIndex: 'sort_index', archived: 'archived',
};
export async function updateAuditQuestion(id, fields) {
  const set = []; const vals = []; let i = 2;
  for (const [k, col] of Object.entries(QUESTION_COLUMNS)) {
    if (fields[k] === undefined) continue;
    set.push(`${col} = $${i++}`); vals.push(fields[k]);
  }
  if (fields.showIf !== undefined) { set.push(`show_if = $${i++}`); vals.push(fields.showIf ? JSON.stringify(fields.showIf) : null); }
  if (fields.mapsTo !== undefined) { set.push(`maps_to = $${i++}`); vals.push(fields.mapsTo ? JSON.stringify(fields.mapsTo) : null); }
  if (!set.length) return;
  await pool.query(`UPDATE audit_questions SET ${set.join(', ')} WHERE id = $1`, [id, ...vals]);
}

// Rewrites every sort_index from the order given. Gaps of 10 leave room for a later
// insert without a second rewrite, and doing the whole list at once means the order on
// screen and the order stored can't disagree.
export async function reorderAuditQuestions(formId, questionIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [i, qid] of questionIds.entries()) {
      await client.query(
        'UPDATE audit_questions SET sort_index = $3 WHERE id = $1 AND form_id = $2',
        [qid, formId, (i + 1) * 10]
      );
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

export async function reorderAuditSections(formId, sectionIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [i, sid] of sectionIds.entries()) {
      await client.query(
        'UPDATE audit_sections SET sort_index = $3 WHERE id = $1 AND form_id = $2',
        [sid, formId, (i + 1) * 10]
      );
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// Archive, never delete, when answers exist. A question nobody ever answered is safe to
// remove outright — keeping it would just be clutter with no history to protect.
export async function removeAuditQuestion(id) {
  const { rows } = await pool.query('SELECT count(*)::int c FROM audit_answers WHERE question_id = $1', [id]);
  if (rows[0].c > 0) {
    await pool.query('UPDATE audit_questions SET archived = true WHERE id = $1', [id]);
    return { archived: true, answers: rows[0].c };
  }
  await pool.query('DELETE FROM audit_questions WHERE id = $1', [id]);
  return { deleted: true };
}

export async function createAuditOption(questionId, { label, value, flag = false, severe = false, sortIndex }) {
  const { rows } = await pool.query(
    'INSERT INTO audit_question_options (question_id, label, value, flag, severe, sort_index) VALUES ($1,$2,$3,$4,$5,COALESCE($6,0)) RETURNING id',
    [questionId, label, value ?? label, !!flag, !!severe, sortIndex ?? null]
  );
  return rows[0].id;
}

// Editing an option clears its fixture mark: once a human has decided, it is no longer
// a placeholder, and the "show me everything still marked fixture" query should stop
// reporting it.
export async function updateAuditOption(id, { label, flag, severe, archived }) {
  const set = []; const vals = []; let i = 2;
  if (label !== undefined) { set.push(`label = $${i++}`); vals.push(label); }
  if (flag !== undefined) { set.push(`flag = $${i++}`); vals.push(!!flag); }
  if (severe !== undefined) { set.push(`severe = $${i++}`); vals.push(!!severe); }
  if (archived !== undefined) { set.push(`archived = $${i++}`); vals.push(!!archived); }
  if (!set.length) return;
  set.push('is_fixture = false');
  await pool.query(`UPDATE audit_question_options SET ${set.join(', ')} WHERE id = $1`, [id, ...vals]);
}

export async function createAuditRemedy(optionId, { titleTemplate, responsibility, fundingSource, fundingRefId, estHours, estCost }) {
  const { rows } = await pool.query(
    `INSERT INTO audit_remedies (option_id, title_template, responsibility, funding_source, funding_ref_id, est_hours, est_cost)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [optionId, titleTemplate, responsibility || null, fundingSource || null, fundingRefId || null, estHours ?? null, estCost ?? null]
  );
  return rows[0].id;
}

export async function updateAuditRemedy(id, fields) {
  const map = { titleTemplate: 'title_template', responsibility: 'responsibility',
    fundingSource: 'funding_source', fundingRefId: 'funding_ref_id', estHours: 'est_hours', estCost: 'est_cost' };
  const set = []; const vals = []; let i = 2;
  for (const [k, col] of Object.entries(map)) {
    if (fields[k] === undefined) continue;
    set.push(`${col} = $${i++}`); vals.push(fields[k]);
  }
  if (!set.length) return;
  set.push('is_fixture = false');   // edited by a human, so no longer a placeholder
  await pool.query(`UPDATE audit_remedies SET ${set.join(', ')} WHERE id = $1`, [id, ...vals]);
}

export async function deleteAuditRemedy(id) {
  await pool.query('DELETE FROM audit_remedies WHERE id = $1', [id]);
}

// "Add follow-up" on an option: a new question whose show_if is pre-wired to it, which
// is what makes the tree visible as structure instead of a separate logic screen (§7).
export async function addFollowUpQuestion(formId, optionId, { prompt, type = 'select', options = [] }) {
  const { rows } = await pool.query(
    `SELECT o.question_id, q.section_id, q.sort_index FROM audit_question_options o
     JOIN audit_questions q ON q.id = o.question_id WHERE o.id = $1`, [optionId]
  );
  if (!rows[0]) return null;
  return createAuditQuestion(formId, {
    sectionId: rows[0].section_id, prompt, type, options,
    sortIndex: (rows[0].sort_index ?? 0) + 1,
    showIf: [{ question_id: rows[0].question_id, option_ids: [Number(optionId)] }],
  });
}

// Everything still marked as a placeholder. The builder surfaces this as a warning
// before a real round runs, which is the whole point of the marker.
export async function listAuditFixtures(formId) {
  const [opts, rems] = await Promise.all([
    pool.query(
      `SELECT o.id, o.label, q.prompt, q.question_key FROM audit_question_options o
       JOIN audit_questions q ON q.id = o.question_id
       WHERE q.form_id = $1 AND o.is_fixture ORDER BY q.sort_index, o.sort_index`, [formId]),
    pool.query(
      `SELECT r.id, r.title_template, r.est_hours, r.est_cost, o.label, q.prompt FROM audit_remedies r
       JOIN audit_question_options o ON o.id = r.option_id
       JOIN audit_questions q ON q.id = o.question_id
       WHERE q.form_id = $1 AND r.is_fixture ORDER BY r.id`, [formId]),
  ]);
  return {
    Options: opts.rows.map((r) => ({ Id: r.id, Label: r.label, Prompt: r.prompt, QuestionKey: r.question_key })),
    Remedies: rems.rows.map((r) => ({ Id: r.id, Title: r.title_template, OptionLabel: r.label, Prompt: r.prompt,
      EstHours: r.est_hours != null ? Number(r.est_hours) : null, EstCost: r.est_cost != null ? Number(r.est_cost) : null })),
  };
}

// ── Audit engine: rounds and the runner (Build Brief §3/§4/§5) ───────────

export async function listAuditForms() {
  const { rows } = await pool.query(
    `SELECT f.*, (SELECT count(*) FROM audit_questions q WHERE q.form_id = f.id AND NOT q.archived) AS question_count
     FROM audit_forms f WHERE f.active ORDER BY f.name`
  );
  return rows.map((r) => ({
    Id: r.id, Name: r.name, Description: r.description, TargetNote: r.target_note,
    QuestionCount: Number(r.question_count),
  }));
}

// A round is created with one instance per asset in scope — the instances ARE the
// scope, so there is no second copy of that fact to drift.
export async function createAuditRound({ formId, name, assetIds = [], scheduledDate, dueDate }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO audit_rounds (form_id, name, scheduled_date, due_date) VALUES ($1,$2,$3,$4) RETURNING id`,
      [formId, name, scheduledDate || null, dueDate || null]
    );
    const roundId = rows[0].id;
    for (const assetId of assetIds) {
      await client.query(
        `INSERT INTO audit_round_instances (round_id, asset_id) VALUES ($1,$2)
         ON CONFLICT (round_id, asset_id) DO NOTHING`,
        [roundId, assetId]
      );
    }
    await client.query('COMMIT');
    await logActivity({ action: 'created', entityType: 'audit_round', entityId: roundId, entityLabel: name });
    return getAuditRound(roundId);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

export async function getAuditRound(id) {
  const { rows } = await pool.query(
    `SELECT r.*, f.name AS form_name,
            r.scheduled_date::text AS scheduled_date_text, r.due_date::text AS due_date_text
     FROM audit_rounds r JOIN audit_forms f ON f.id = r.form_id WHERE r.id = $1`,
    [id]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    Id: r.id, FormId: r.form_id, FormName: r.form_name, Name: r.name, Status: r.status,
    ScheduledDate: r.scheduled_date_text, DueDate: r.due_date_text, CreatedAt: r.created_at,
  };
}

// Per-building status for the whole round in ONE aggregate — 130+ instances must not
// become 130 queries (§5).
export async function listAuditRoundInstances(roundId) {
  const { rows } = await pool.query(
    `SELECT i.id, i.asset_id, i.status, i.generated_wo_id, i.completed_at,
            a.name AS asset_name, a.asset_type, l.name AS location_name,
            ic.icon, at.thumb_url, at.url,
            (SELECT count(*) FROM audit_answers an WHERE an.instance_id = i.id AND an.active) AS answered,
            (SELECT count(*) FROM audit_answers an
               JOIN audit_question_options o ON o.id = an.option_id
             WHERE an.instance_id = i.id AND an.active AND o.flag) AS flagged,
            w.title AS wo_title
     FROM audit_round_instances i
     JOIN assets a ON a.id = i.asset_id
     LEFT JOIN locations l ON l.id = a.location_id
     LEFT JOIN asset_type_icons ic ON ic.asset_type = a.asset_type
     LEFT JOIN attachments at ON at.id = a.profile_attachment_id AND at.deleted_at IS NULL
     LEFT JOIN work_orders w ON w.id = i.generated_wo_id
     WHERE i.round_id = $1
     ORDER BY l.name NULLS LAST, a.name`,
    [roundId]
  );
  return rows.map((r) => ({
    Id: r.id, AssetId: r.asset_id, AssetName: r.asset_name, AssetType: r.asset_type,
    LocationName: r.location_name, Status: r.status, CompletedAt: r.completed_at,
    GeneratedWorkOrderId: r.generated_wo_id, GeneratedWorkOrderTitle: r.wo_title,
    Answered: Number(r.answered), Flagged: Number(r.flagged),
    Face: { PhotoUrl: r.thumb_url || r.url || null, Icon: r.icon || '🏢' },
  }));
}

export async function listAuditRounds() {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.status, r.due_date::text AS due_date, f.name AS form_name,
            count(i.id)::int AS total,
            count(i.id) FILTER (WHERE i.status = 'complete')::int AS complete
     FROM audit_rounds r
     JOIN audit_forms f ON f.id = r.form_id
     LEFT JOIN audit_round_instances i ON i.round_id = r.id
     GROUP BY r.id, r.name, r.status, r.due_date, f.name
     ORDER BY r.created_at DESC`
  );
  return rows.map((r) => ({
    Id: r.id, Name: r.name, Status: r.status, DueDate: r.due_date, FormName: r.form_name,
    Total: r.total, Complete: r.complete,
    Percent: r.total ? Math.round((r.complete / r.total) * 100) : 0,
  }));
}

// Everything the runner needs for one building, in one call: the form, this building's
// answers so far, and the asset's standing notes — which appear BEFORE the walkthrough
// so "the shutoff is behind the shed" is read on the way in, not discovered after (§5c).
export async function getAuditInstance(instanceId) {
  const { rows: ir } = await pool.query(
    `SELECT i.*, r.form_id, r.name AS round_name, a.name AS asset_name, a.asset_type,
            a.building_type_id, l.name AS location_name
     FROM audit_round_instances i
     JOIN audit_rounds r ON r.id = i.round_id
     JOIN assets a ON a.id = i.asset_id
     LEFT JOIN locations l ON l.id = a.location_id
     WHERE i.id = $1`,
    [instanceId]
  );
  if (!ir[0]) return null;
  const inst = ir[0];

  const [sections, questions, options, answers, photos, notes] = await Promise.all([
    pool.query('SELECT id, name, sort_index FROM audit_sections WHERE form_id = $1 ORDER BY sort_index, id', [inst.form_id]),
    pool.query(
      `SELECT q.* FROM audit_questions q
       WHERE q.form_id = $1 AND NOT q.archived
         -- Building-type applicability: no rows means "every type" (§4 of the decisions).
         AND (NOT EXISTS (SELECT 1 FROM audit_question_building_types b WHERE b.question_id = q.id)
              OR $2::int IS NULL
              OR EXISTS (SELECT 1 FROM audit_question_building_types b
                         WHERE b.question_id = q.id AND b.building_type_id = $2::int))
       ORDER BY q.sort_index, q.id`,
      [inst.form_id, inst.building_type_id]
    ),
    pool.query(
      `SELECT o.* FROM audit_question_options o
       JOIN audit_questions q ON q.id = o.question_id
       WHERE q.form_id = $1 AND NOT o.archived ORDER BY o.sort_index, o.id`,
      [inst.form_id]
    ),
    pool.query('SELECT * FROM audit_answers WHERE instance_id = $1', [instanceId]),
    // Photos hang off the ANSWER, through the same polymorphic attachment_links every
    // other photo in this app uses — no second file store for audits.
    pool.query(
      `SELECT al.entity_id AS answer_id, at.id, at.url, at.thumb_url
       FROM attachment_links al
       JOIN attachments at ON at.id = al.attachment_id AND at.deleted_at IS NULL
       WHERE al.entity_type = 'audit_answer'
         AND al.entity_id IN (SELECT id FROM audit_answers WHERE instance_id = $1)
       ORDER BY al.sort_order, al.id`,
      [instanceId]
    ),
    pool.query(
      `SELECT id, note, source, created_by, created_at FROM asset_notes
       WHERE asset_id = $1 AND NOT resolved ORDER BY created_at DESC LIMIT 20`,
      [inst.asset_id]
    ),
  ]);

  const optByQ = new Map();
  for (const o of options.rows) {
    if (!optByQ.has(o.question_id)) optByQ.set(o.question_id, []);
    optByQ.get(o.question_id).push({
      Id: o.id, Label: o.label, Value: o.value, Flag: o.flag, Severe: o.severe, IsFixture: o.is_fixture,
    });
  }

  return {
    Instance: {
      Id: inst.id, RoundId: inst.round_id, RoundName: inst.round_name, Status: inst.status,
      AssetId: inst.asset_id, AssetName: inst.asset_name, AssetType: inst.asset_type,
      LocationName: inst.location_name, GeneratedWorkOrderId: inst.generated_wo_id,
    },
    Sections: sections.rows.map((s) => ({ Id: s.id, Name: s.name, SortIndex: s.sort_index })),
    Questions: questions.rows.map((q) => ({
      Id: q.id, SectionId: q.section_id, QuestionKey: q.question_key, Prompt: q.prompt,
      Type: q.type, Required: q.required, AllowsPhoto: q.allows_photo, ShowIf: q.show_if,
      MapsTo: q.maps_to, Options: optByQ.get(q.id) || [],
    })),
    Answers: answers.rows.map((a) => ({
      Id: a.id, QuestionId: a.question_id, SectionId: a.section_id, Kind: a.kind,
      QuestionKey: a.question_key, Value: a.value, OptionId: a.option_id, Note: a.note,
      NoteDestination: a.note_destination, Active: a.active,
      Photos: photos.rows.filter((ph) => ph.answer_id === a.id)
        .map((ph) => ({ Id: ph.id, Url: ph.url, ThumbUrl: ph.thumb_url })),
    })),
    AssetNotes: notes.rows.map((n) => ({
      Id: n.id, Note: n.note, Source: n.source, CreatedBy: n.created_by, CreatedAt: n.created_at,
    })),
  };
}

// One answer, saved on its own. The runner posts per answer rather than per form so a
// dropped connection costs one field, not a building — and the retry queue on the client
// has something idempotent to retry against.
export async function saveAuditAnswer(instanceId, { questionId, questionKey, value, optionId, note, noteDestination, active = true }) {
  const { rows } = await pool.query(
    `INSERT INTO audit_answers (instance_id, question_id, question_key, value, option_id, note, note_destination, active)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'audit_only'),$8)
     ON CONFLICT (instance_id, question_id) DO UPDATE SET
       value = EXCLUDED.value, option_id = EXCLUDED.option_id, note = EXCLUDED.note,
       note_destination = COALESCE($7, audit_answers.note_destination),
       active = EXCLUDED.active
     RETURNING id`,
    [instanceId, questionId, questionKey, value ?? null, optionId ?? null, note ?? null, noteDestination ?? null, active]
  );
  await pool.query(
    `UPDATE audit_round_instances
     SET status = CASE WHEN status = 'not_started' THEN 'in_progress' ELSE status END,
         started_at = COALESCE(started_at, now())
     WHERE id = $1`,
    [instanceId]
  );
  return rows[0].id;
}

// A photo can be taken before the question is answered, so the row has to exist to
// hang it on. Upserts an empty answer and hands back its id — the value arrives later
// through the ordinary save path.
export async function ensureAuditAnswer(instanceId, { questionId, questionKey }) {
  const { rows } = await pool.query(
    `INSERT INTO audit_answers (instance_id, question_id, question_key)
     VALUES ($1,$2,$3)
     ON CONFLICT (instance_id, question_id) DO UPDATE SET question_key = EXCLUDED.question_key
     RETURNING id`,
    [instanceId, questionId, questionKey]
  );
  return rows[0].id;
}

// "Flag something else" — something the form never asked about. Same table, so it shows
// up in the audit data screen and the asset's history alongside everything else.
export async function addAdhocFlag(instanceId, { sectionId, description, note, noteDestination, remedy }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO audit_answers (instance_id, section_id, kind, question_key, value, note, note_destination)
       VALUES ($1,$2,'adhoc_flag','adhoc_flag',$3,$4,COALESCE($5,'audit_only')) RETURNING id`,
      [instanceId, sectionId, description, note ?? null, noteDestination ?? null]
    );
    const answerId = rows[0].id;
    if (remedy && remedy.title) {
      await client.query(
        `INSERT INTO audit_answer_remedies (answer_id, title, responsibility, funding_source, funding_ref_id, est_hours, est_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [answerId, remedy.title, remedy.responsibility || null, remedy.fundingSource || null,
          remedy.fundingRefId || null, remedy.estHours ?? null, remedy.estCost ?? null]
      );
    }
    await client.query(
      `UPDATE audit_round_instances
       SET status = CASE WHEN status = 'not_started' THEN 'in_progress' ELSE status END,
           started_at = COALESCE(started_at, now())
       WHERE id = $1`,
      [instanceId]
    );
    await client.query('COMMIT');
    return answerId;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

export async function chooseAnswerRemedy(answerId, remedyId) {
  await pool.query(
    `INSERT INTO audit_answer_remedies (answer_id, remedy_id) VALUES ($1,$2)
     ON CONFLICT (answer_id, remedy_id) DO NOTHING`,
    [answerId, remedyId]
  );
}

// The asset-property router in one place (audit decisions §6): a field with a
// column_name is a real assets column, one without lives in asset_property_values.
// Both stores are kept deliberately — the EAV side is the escape hatch that lets an
// admin add a property field without a migration.
export async function writeAssetPropertyViaRouter(assetId, fieldKey, value) {
  const { rows } = await pool.query(
    'SELECT column_name FROM asset_property_fields WHERE field_key = $1', [fieldKey]
  );
  if (!rows[0]) return false;
  if (rows[0].column_name) {
    await pool.query(`UPDATE assets SET ${rows[0].column_name} = $1 WHERE id = $2`, [value, assetId]);
  } else {
    await pool.query(
      `INSERT INTO asset_property_values (asset_id, field_key, value) VALUES ($1,$2,$3)
       ON CONFLICT (asset_id, field_key) DO UPDATE SET value = EXCLUDED.value`,
      [assetId, fieldKey, value]
    );
  }
  return true;
}

// ── Audit review and generation (Build Brief §4, Addendum §4) ────────────

// What this building's completed audit will produce. Read-only: the review screen shows
// it, the grid lets it be edited, and nothing is created until completeAuditInstance.
export async function getAuditReview(instanceId) {
  const inst = await getAuditInstance(instanceId);
  if (!inst) return null;

  const { rows: flagged } = await pool.query(
    `SELECT an.id AS answer_id, an.kind, an.value, an.note, an.note_destination,
            q.prompt, q.question_key, o.label AS option_label, o.severe,
            sec.name AS section_name
     FROM audit_answers an
     LEFT JOIN audit_questions q ON q.id = an.question_id
     LEFT JOIN audit_question_options o ON o.id = an.option_id
     LEFT JOIN audit_sections sec ON sec.id = COALESCE(an.section_id, q.section_id)
     WHERE an.instance_id = $1 AND an.active
       AND (o.flag = true OR an.kind = 'adhoc_flag')
     ORDER BY an.id`,
    [instanceId]
  );

  // Remedies: a template one carries the option's values, an inline one carries its own.
  // Generation reads a single shape either way (0086).
  const { rows: remedies } = await pool.query(
    `SELECT ar.id, ar.answer_id, ar.remedy_id,
            COALESCE(ar.title, r.title_template) AS title,
            COALESCE(ar.responsibility, r.responsibility) AS responsibility,
            COALESCE(ar.funding_source, r.funding_source) AS funding_source,
            COALESCE(ar.funding_ref_id, r.funding_ref_id) AS funding_ref_id,
            COALESCE(ar.est_hours, r.est_hours) AS est_hours,
            COALESCE(ar.est_cost, r.est_cost) AS est_cost,
            COALESCE(r.is_fixture, false) AS is_fixture
     FROM audit_answer_remedies ar
     LEFT JOIN audit_remedies r ON r.id = ar.remedy_id
     WHERE ar.answer_id = ANY($1::int[])`,
    [flagged.map((f) => f.answer_id)]
  );
  const byAnswer = new Map();
  for (const r of remedies) {
    if (!byAnswer.has(r.answer_id)) byAnswer.set(r.answer_id, []);
    byAnswer.get(r.answer_id).push({
      Id: r.id, RemedyId: r.remedy_id,
      // {asset} is substituted at generation so the stored line names the building.
      Title: String(r.title || '').replace(/\{asset\}/g, inst.Instance.AssetName),
      Responsibility: r.responsibility, FundingSource: r.funding_source, FundingRefId: r.funding_ref_id,
      EstHours: r.est_hours != null ? Number(r.est_hours) : null,
      EstCost: r.est_cost != null ? Number(r.est_cost) : null,
      IsFixture: r.is_fixture,
    });
  }

  // A job note on a building that ends with no work order is STRANDED — the review
  // screen has to ask rather than drop it (§4).
  const strandedNotes = flagged
    .filter((f) => f.note && f.note_destination === 'job')
    .map((f) => ({ AnswerId: f.answer_id, Note: f.note, Prompt: f.prompt || f.value }));

  const lines = flagged.flatMap((f) => (byAnswer.get(f.answer_id) || []).map((r) => ({ ...r, AnswerId: f.answer_id })));

  return {
    Instance: inst.Instance,
    Flagged: flagged.map((f) => ({
      AnswerId: f.answer_id, Kind: f.kind, SectionName: f.section_name,
      // "Roof: Poor" — the chain as the reviewer reads it.
      Chain: f.kind === 'adhoc_flag' ? `Flagged: ${f.value}` : `${f.prompt}: ${f.option_label || f.value}`,
      Severe: !!f.severe, Note: f.note, NoteDestination: f.note_destination,
      Remedies: byAnswer.get(f.answer_id) || [],
    })),
    ProposedLines: lines,
    StrandedJobNotes: lines.length ? [] : strandedNotes,
    // A clean building is a real outcome, not a gap: the completed instance is the record.
    Clean: flagged.length === 0,
  };
}

// Completing a building: findings for every flagged answer, one work order with the
// chosen lines, maps_to routing, and note delivery. One transaction — a half-generated
// building would be worse than none.
export async function completeAuditInstance(instanceId, { lines = null, strandedNoteChoices = {}, createdBy } = {}) {
  const review = await getAuditReview(instanceId);
  if (!review) return null;
  const assetId = review.Instance.AssetId;
  const useLines = lines || review.ProposedLines;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. A finding per flagged answer — the ISSUE record, which outlives any one work
    //    order and keeps the deferred-maintenance lane fed even when nothing is fixed
    //    this year (decisions §1).
    const findingByAnswer = new Map();
    for (const f of review.Flagged) {
      const { rows } = await client.query(
        `INSERT INTO condition_findings (title, asset_id, status, date_identified, description, audit_answer_id, created_by)
         VALUES ($1,$2,'Open',CURRENT_DATE,$3,$4,$5) RETURNING id`,
        [f.Chain, assetId, f.Note || null, f.AnswerId, createdBy || null]
      );
      findingByAnswer.set(f.AnswerId, rows[0].id);
    }

    // 2. One work order per building, only if there is work to do.
    let workOrderId = null;
    if (useLines.length) {
      // Same pattern createWorkOrder uses: reserve the id first so the row can be its
      // own unsplit root and carry its id as wo_number in ONE insert. currval() does
      // not work here — the id column's own default calls nextval, so currval would
      // point at a different number than the row actually got.
      const { rows: idRows } = await client.query(
        `SELECT nextval(pg_get_serial_sequence('work_orders','id')) AS id`
      );
      workOrderId = Number(idRows[0].id);
      await client.query(
        `INSERT INTO work_orders (id, title, asset_id, status_id, split_root_id, wo_number, date_reported)
         VALUES ($1,$2,$3,(SELECT id FROM work_order_statuses WHERE name = 'Reported'),$1,$4,CURRENT_DATE)`,
        [workOrderId, `${review.Instance.RoundName} — ${review.Instance.AssetName}`, assetId, String(workOrderId)]
      );

      for (const l of useLines) {
        // Estimates are SNAPSHOTS: editing a remedy template later never moves a work
        // order that already exists.
        await client.query(
          `INSERT INTO job_lines (work_order_id, title, responsibility_class, funding_source, funding_ref_id,
                                  estimated_hours, estimated_cost, status_id, condition_finding_id)
           VALUES ($1,$2,$3,COALESCE($4,'operating_budget'),$5,$6,$7,
                   (SELECT id FROM job_line_statuses ORDER BY sort_order LIMIT 1), $8)`,
          [workOrderId, l.Title, l.Responsibility || 'self', l.FundingSource, l.FundingRefId,
            l.EstHours, l.EstCost, findingByAnswer.get(l.AnswerId) || null]
        );
      }
    }

    // 3. maps_to routing — additive: the answer is already stored regardless (§4).
    const { rows: mapped } = await client.query(
      `SELECT an.value, q.maps_to FROM audit_answers an
       JOIN audit_questions q ON q.id = an.question_id
       WHERE an.instance_id = $1 AND an.active AND q.maps_to IS NOT NULL`,
      [instanceId]
    );
    for (const m of mapped) {
      if (!m.value) continue;
      if (m.maps_to.kind === 'component') {
        await client.query(
          `INSERT INTO asset_components (asset_id, component_type, event_type, condition)
           VALUES ($1,$2,'Inspected',$3)`,
          [assetId, m.maps_to.component_type, m.value]
        );
      }
      // asset_property goes through the existing router after commit, so column-backed
      // and EAV-backed fields behave identically (audit decisions §6).
    }

    // 4. Notes: the original always stays on the answer; routing adds a linked copy.
    const { rows: noted } = await client.query(
      `SELECT id, note, note_destination FROM audit_answers
       WHERE instance_id = $1 AND note IS NOT NULL AND note_destination <> 'audit_only'`,
      [instanceId]
    );
    for (const n of noted) {
      const choice = strandedNoteChoices[n.id];
      const dest = (n.note_destination === 'job' && !workOrderId) ? (choice || 'audit_only') : n.note_destination;
      if (dest === 'asset') {
        await client.query(
          `INSERT INTO asset_notes (asset_id, note, source, source_answer_id, created_by)
           VALUES ($1,$2,'audit',$3,$4)`,
          [assetId, `From ${review.Instance.RoundName}: ${n.note}`, n.id, createdBy || null]
        );
      } else if (dest === 'job' && workOrderId) {
        await client.query(
          `INSERT INTO work_order_log_entries (work_order_id, note, username)
           VALUES ($1,$2,$3)`,
          [workOrderId, `From ${review.Instance.RoundName}: ${n.note}`, createdBy || null]
        );
      }
      await client.query('UPDATE audit_answers SET note_resolved_at = now() WHERE id = $1', [n.id]);
    }

    await client.query(
      `UPDATE audit_round_instances SET status = 'complete', completed_at = now(), generated_wo_id = $2 WHERE id = $1`,
      [instanceId, workOrderId]
    );
    await client.query('COMMIT');

    // Property writes go through the same router submitAudit uses, outside the
    // transaction that created the work order — a failed property write must not undo
    // the audit that produced it.
    for (const m of mapped) {
      if (m.maps_to.kind === 'asset_property' && m.value) {
        try { await writeAssetPropertyViaRouter(assetId, m.maps_to.field, m.value); } catch { /* non-fatal */ }
      }
    }

    return { InstanceId: instanceId, WorkOrderId: workOrderId, Findings: findingByAnswer.size, Lines: useLines.length };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// ── Asset icons and profile photos (Addendum §5a) ────────────────────────
// An asset's face is its own photo when it has one, and its type's icon otherwise, so
// a list of 340 buildings never reads as identical rows.
//
// Icons key off assets.asset_type, NOT building_types: 338 of 340 assets have a NULL
// building_type_id while asset_type is populated on all but 2 (see docs/asset-profile-5a.md).

export async function listAssetTypeIcons() {
  const { rows } = await pool.query(
    `SELECT t.asset_type, i.icon, COALESCE(i.sort_order, 999) AS sort_order, t.count
     FROM (SELECT asset_type, count(*)::int AS count FROM assets
           WHERE asset_type IS NOT NULL AND trim(asset_type) <> '' GROUP BY asset_type) t
     FULL OUTER JOIN asset_type_icons i ON i.asset_type = t.asset_type
     ORDER BY sort_order, t.asset_type`
  );
  return rows.map((r) => ({
    AssetType: r.asset_type, Icon: r.icon || null,
    AssetCount: r.count != null ? Number(r.count) : 0,
    SortOrder: Number(r.sort_order),
  }));
}

export async function setAssetTypeIcon(assetType, icon) {
  if (!icon) {
    await pool.query('DELETE FROM asset_type_icons WHERE asset_type = $1', [assetType]);
    return { AssetType: assetType, Icon: null };
  }
  const { rows } = await pool.query(
    `INSERT INTO asset_type_icons (asset_type, icon) VALUES ($1,$2)
     ON CONFLICT (asset_type) DO UPDATE SET icon = EXCLUDED.icon, updated_at = now()
     RETURNING asset_type, icon`,
    [assetType, icon]
  );
  return { AssetType: rows[0].asset_type, Icon: rows[0].icon };
}

// Designates an existing attachment as the asset's face. The attachment must already be
// linked to this asset — this never moves or copies a file, it only points at one.
export async function setAssetProfilePhoto(assetId, attachmentId) {
  if (attachmentId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM attachment_links
       WHERE entity_type = 'asset' AND entity_id = $1 AND attachment_id = $2`,
      [assetId, attachmentId]
    );
    if (!rows[0]) {
      const e = new Error('That photo is not attached to this asset'); e.status = 400; throw e;
    }
  }
  await pool.query('UPDATE assets SET profile_attachment_id = $2 WHERE id = $1', [assetId, attachmentId || null]);
  return getAssetFace(assetId);
}

// One shape used by the asset header, asset lists and search results, so the same
// building looks the same everywhere it appears.
export async function getAssetFace(assetId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.asset_type, i.icon, at.thumb_url, at.url, a.profile_attachment_id
     FROM assets a
     LEFT JOIN asset_type_icons i ON i.asset_type = a.asset_type
     LEFT JOIN attachments at ON at.id = a.profile_attachment_id AND at.deleted_at IS NULL
     WHERE a.id = $1`,
    [assetId]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    AssetId: r.id, Name: r.name, AssetType: r.asset_type,
    PhotoUrl: r.thumb_url || r.url || null,
    ProfileAttachmentId: r.profile_attachment_id,
    Icon: r.icon || '🏢',
  };
}

// Bulk form for lists: one query per page rather than one per row. At 340 assets the
// per-row version would be the whole page's cost.
export async function getAssetFaces(assetIds = []) {
  if (!assetIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT a.id, i.icon, at.thumb_url, at.url
     FROM assets a
     LEFT JOIN asset_type_icons i ON i.asset_type = a.asset_type
     LEFT JOIN attachments at ON at.id = a.profile_attachment_id AND at.deleted_at IS NULL
     WHERE a.id = ANY($1::int[])`,
    [assetIds]
  );
  return new Map(rows.map((r) => [r.id, { PhotoUrl: r.thumb_url || r.url || null, Icon: r.icon || '🏢' }]));
}

// ── Materials & leftovers (Build Brief §10) ──────────────────────────────
// Deliberately not an inventory system. One list, one balance each, and the
// balance is always the sum of movements — never a stored number that could
// drift from the history explaining it.

function materialRowShape(r) {
  return {
    Id: r.id, Name: r.name, Unit: r.unit, Active: r.active,
    Balance: r.balance != null ? Number(r.balance) : 0,
    LastUnitPrice: r.last_unit_price != null ? Number(r.last_unit_price) : null,
    LastMovedAt: r.last_moved_at || null,
  };
}

const MATERIAL_SELECT = `
  SELECT m.*,
         COALESCE(mv.balance, 0) AS balance,
         mv.last_unit_price,
         mv.last_moved_at
  FROM materials m
  LEFT JOIN LATERAL (
    SELECT SUM(quantity) AS balance,
           MAX(created_at) AS last_moved_at,
           (SELECT unit_price FROM material_movements
            WHERE material_id = m.id AND unit_price IS NOT NULL
            ORDER BY created_at DESC LIMIT 1) AS last_unit_price
    FROM material_movements WHERE material_id = m.id
  ) mv ON true`;

// Substring match, same shape the searchable combobox expects elsewhere.
// withBalanceOnly backs the "Materials on hand" screen; the combobox wants
// everything, including materials that are out of stock.
export async function listMaterials({ q, withBalanceOnly = false, includeInactive = false } = {}) {
  const where = []; const vals = [];
  if (!includeInactive) where.push('m.active');
  if (q) { vals.push(`%${q}%`); where.push(`m.name ILIKE $${vals.length}`); }
  // The balance is a lateral aggregate, so it can't be filtered in the same WHERE —
  // it goes in HAVING-equivalent position via a wrapping condition on the join output.
  if (withBalanceOnly) where.push('COALESCE(mv.balance, 0) > 0');
  const { rows } = await pool.query(
    `${MATERIAL_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY m.name`,
    vals
  );
  return rows.map(materialRowShape);
}

export async function getMaterial(id) {
  const { rows } = await pool.query(`${MATERIAL_SELECT} WHERE m.id = $1`, [id]);
  return rows[0] ? materialRowShape(rows[0]) : null;
}

// "Add new" inline from the combobox. Name+unit is the identity: "Drywall 1/2" in
// sheets and in square feet are different things to count.
export async function createMaterial({ name, unit }) {
  const { rows } = await pool.query(
    `INSERT INTO materials (name, unit) VALUES ($1,$2)
     ON CONFLICT (name, unit) DO UPDATE SET active = true
     RETURNING id`,
    [String(name).trim(), String(unit).trim()]
  );
  await logActivity({ action: 'created', entityType: 'material', entityId: rows[0].id, entityLabel: name });
  return getMaterial(rows[0].id);
}

// Every balance change is a row. Corrections included — that's the whole point:
// "someone counted 3 and the system said 4" stays visible instead of being
// silently overwritten.
export async function recordMaterialMovement({
  materialId, kind, quantity, unitPrice, workOrderId, jobLineId, note, createdBy,
}) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty === 0) {
    const err = new Error('Movement quantity must be a non-zero number');
    err.status = 400; throw err;
  }
  // Callers pass a magnitude; the kind decides the direction, so a UI can't
  // accidentally file a removal that adds stock.
  const signed = kind === 'correction' ? qty : (kind === 'wo_close' ? Math.abs(qty) : -Math.abs(qty));
  const { rows } = await pool.query(
    `INSERT INTO material_movements (material_id, kind, quantity, unit_price, work_order_id, job_line_id, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [materialId, kind, signed, unitPrice ?? null, workOrderId || null, jobLineId || null, note || null, createdBy || null]
  );
  return { Id: rows[0].id, MaterialId: materialId, Kind: kind, Quantity: signed };
}

export async function listMaterialMovements(materialId) {
  const { rows } = await pool.query(
    `SELECT mm.*, w.title AS work_order_title, jl.title AS job_line_title
     FROM material_movements mm
     LEFT JOIN work_orders w ON w.id = mm.work_order_id
     LEFT JOIN job_lines jl ON jl.id = mm.job_line_id
     WHERE mm.material_id = $1 ORDER BY mm.created_at DESC, mm.id DESC`,
    [materialId]
  );
  return rows.map((r) => ({
    Id: r.id, Kind: r.kind, Quantity: Number(r.quantity),
    UnitPrice: r.unit_price != null ? Number(r.unit_price) : null,
    WorkOrderId: r.work_order_id, WorkOrderTitle: r.work_order_title || null,
    JobLineId: r.job_line_id, JobLineTitle: r.job_line_title || null,
    Note: r.note, CreatedBy: r.created_by, CreatedAt: r.created_at,
  }));
}

// WO close (§10): which materials did this work order actually buy, and at what price?
// Drives the "Any materials left over?" prompt — one row per material, blank meaning
// none, so the fast path is closing the WO without typing anything.
export async function getMaterialsUsedOnWorkOrder(workOrderId) {
  const { rows } = await pool.query(
    `SELECT m.id AS material_id, m.name, m.unit,
            SUM(ea.quantity) AS quantity,
            CASE WHEN SUM(ea.quantity) > 0 THEN SUM(ea.amount) / SUM(ea.quantity) ELSE NULL END AS unit_price
     FROM expense_allocations ea
     JOIN expense_line_items li ON li.id = ea.line_item_id
     JOIN materials m ON m.id = li.material_id
     JOIN expenses e ON e.id = ea.expense_id
     WHERE e.triage_status != 'void' AND e.deleted_at IS NULL
       AND ea.quantity IS NOT NULL AND ea.quantity > 0
       AND (
         (ea.dest_type = 'work_order' AND ea.dest_id = $1)
         OR (ea.dest_type = 'job_line' AND ea.dest_id IN (SELECT id FROM job_lines WHERE work_order_id = $1))
       )
     GROUP BY m.id, m.name, m.unit
     ORDER BY m.name`,
    [workOrderId]
  );
  return rows.map((r) => ({
    MaterialId: r.material_id, Name: r.name, Unit: r.unit,
    QuantityUsed: Number(r.quantity),
    UnitPrice: r.unit_price != null ? Math.round(Number(r.unit_price) * 100) / 100 : null,
  }));
}

// Point-of-use reminder (§10): "You should have 4 sheets of Drywall 1/2 4x8 left."
// Returns null rather than a zero so a caller can treat "nothing on hand" as "say
// nothing" without checking a number.
export async function getMaterialOnHand(materialId) {
  const m = await getMaterial(materialId);
  if (!m || !(m.Balance > 0)) return null;
  return { MaterialId: m.Id, Name: m.Name, Unit: m.Unit, Balance: m.Balance, UnitPrice: m.LastUnitPrice };
}

// Drawing from stock moves cost at the price actually paid and is NOT a saving —
// the saving was already counted once, when the material was bought (§10).
export async function useMaterialFromStock({ materialId, quantity, jobLineId, workOrderId, createdBy }) {
  const onHand = await getMaterialOnHand(materialId);
  if (!onHand) { const e = new Error('No stock on hand for that material'); e.status = 400; throw e; }
  const qty = Math.min(Math.abs(Number(quantity)), onHand.Balance);
  await recordMaterialMovement({
    materialId, kind: 'to_job', quantity: qty, unitPrice: onHand.UnitPrice,
    workOrderId, jobLineId, note: 'Used from on-hand stock', createdBy,
  });
  return { MaterialId: materialId, QuantityUsed: qty, UnitPrice: onHand.UnitPrice,
    Cost: onHand.UnitPrice != null ? Math.round(qty * onHand.UnitPrice * 100) / 100 : null };
}

export async function getExpensesReportRawData() {
  const { rows } = await pool.query(`
    SELECT e.*, ec.name AS category_name, f.name AS fund_name,
           jl.title AS job_line_title, wo.title AS work_order_title, wo.wo_number,
           a.name AS asset_name, l.name AS location_name,
           (SELECT count(*) FROM attachment_links al WHERE al.entity_type = 'expense' AND al.entity_id = e.id) AS receipt_count
    FROM expenses e
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    LEFT JOIN funds f ON f.id = e.fund_id
    LEFT JOIN LATERAL (
      SELECT ea.dest_type, ea.dest_id FROM expense_allocations ea
      WHERE ea.expense_id = e.id AND ea.dest_type IN ('job_line','work_order')
      ORDER BY ea.id LIMIT 1
    ) d ON true
    LEFT JOIN job_lines jl ON d.dest_type = 'job_line' AND jl.id = d.dest_id
    LEFT JOIN work_orders wo ON d.dest_type = 'work_order' AND wo.id = d.dest_id
    LEFT JOIN assets a ON a.id = e.asset_id
    LEFT JOIN locations l ON l.id = a.location_id
    WHERE e.triage_status != 'void' AND e.deleted_at IS NULL
    ORDER BY e.purchase_date DESC NULLS LAST, e.created_at DESC`
  );
  return { expenses: rows };
}

// ── Triage inbox (Build Brief v2 Phase 5, §5.3) — batches with at least one
//    attachment still in triage_status='inbox'. A batch is a suggestion, not
//    a commitment: acting on a subset of its photos leaves the rest in the
//    inbox (triage_status only changes for the attachments actually acted
//    on), so a 20-photo walkthrough email can become three separate WOs
//    without losing track of what's left. ──────────────────────────────────

export async function listInboxBatches() {
  const { rows } = await pool.query(`
    SELECT b.id, b.subject, b.body_text, b.sender_email, b.received_at, b.note,
           json_agg(json_build_object(
             'Id', a.id, 'Url', a.url, 'ThumbUrl', a.thumb_url, 'Kind', a.kind,
             'Width', a.width, 'Height', a.height, 'TakenAt', a.taken_at,
             'GpsLat', a.gps_lat, 'GpsLng', a.gps_lng, 'OriginalFilename', a.original_filename
           ) ORDER BY a.taken_at NULLS LAST, a.id) AS attachments
    FROM attachment_batches b
    JOIN attachments a ON a.batch_id = b.id AND a.triage_status = 'inbox' AND a.deleted_at IS NULL
    GROUP BY b.id
    ORDER BY b.received_at DESC`
  );
  return rows.map((r) => ({ Id: r.id, Subject: r.subject, BodyText: r.body_text, SenderEmail: r.sender_email, ReceivedAt: r.received_at, Note: r.note, Attachments: r.attachments }));
}

// Dashboard badge (§5.3) — "the failure mode is a junk drawer of 400
// untriaged photos; the badge is the only thing preventing it."
export async function getInboxCount() {
  const { rows } = await pool.query(`SELECT count(*) FROM attachments WHERE triage_status = 'inbox' AND deleted_at IS NULL`);
  return Number(rows[0].count);
}

// ── System health (Build Brief v4 Part 2) — one shared table so backups,
//    calendar sync, and mail ingest (and whatever integration comes after
//    those) all report through the same mechanism instead of each growing
//    its own bespoke status table the way backup_runs originally did.
//    backup_runs itself stays as the detailed per-run log (started/finished/
//    detail for every single run) — this table is only ever the current
//    at-a-glance read per subsystem, one row each, overwritten in place.
//
//    last_success and last_failure are tracked separately (never collapsed
//    into one "last run" field) for the same reason the old backup-specific
//    status check already got right: a failure tonight must not erase that
//    last night succeeded. ─────────────────────────────────────────────────

// Only a subsystem with a genuine expected cadence gets judged for
// staleness. Backups are the one instance of that today (B6's original
// >48h threshold, carried over unchanged). Mail ingest deliberately has no
// cadence — "no mail for a week is normal" (Build Brief v4 §2.2) — and must
// never be flagged by this. gcal_sync (step 3, now built) still isn't given
// one either: the worker writes success/failure on every cron tick it
// actually runs, so a real failure already shows as `state = 'failed'`
// without needing a staleness check on top — the only gap a staleness
// check would catch is the cron job itself silently not running at all
// (crashed script, removed crontab line), which isn't distinguishable from
// "healthy and just quiet" without a bespoke heartbeat, and nothing
// currently reads `Stale` for this subsystem anyway.
const STALE_AFTER_HOURS = { backup: 48 };

export async function getSystemHealth() {
  const { rows } = await pool.query('SELECT * FROM system_health ORDER BY subsystem');
  return rows.map((r) => {
    const staleAfterHours = STALE_AFTER_HOURS[r.subsystem];
    const hoursSinceSuccess = r.last_success ? (Date.now() - new Date(r.last_success).getTime()) / 3600000 : null;
    const stale = staleAfterHours != null && (hoursSinceSuccess == null || hoursSinceSuccess > staleAfterHours);
    return {
      Subsystem: r.subsystem, LastSuccess: r.last_success, LastFailure: r.last_failure,
      LastMessage: r.last_message, State: r.state, UpdatedAt: r.updated_at, Stale: stale,
    };
  });
}

// The two write paths every subsystem funnels through. Kept as plain
// UPDATEs (not upserts) — the three subsystem rows are seeded by migration
// 0057, so a typo'd subsystem name here is a bug worth surfacing as "zero
// rows updated" rather than silently creating a fourth row nothing reads.
export async function recordSystemHealthSuccess(subsystem, message = null) {
  await pool.query(
    `UPDATE system_health SET last_success = now(), last_message = $2, state = 'ok', updated_at = now() WHERE subsystem = $1`,
    [subsystem, message]
  );
}
export async function recordSystemHealthFailure(subsystem, message = null) {
  await pool.query(
    `UPDATE system_health SET last_failure = now(), last_message = $2, state = 'failed', updated_at = now() WHERE subsystem = $1`,
    [subsystem, message]
  );
}

// ── Google Calendar connection (Build Brief v4 Part 1) — one singleton
//    row, same pattern as display_settings/budget_settings. src/gcal.js (the
//    only module that talks to Google's APIs) never touches SQL directly;
//    the OAuth route composes the two, the same way any other route
//    composes storage.js + db.js. ──────────────────────────────────────────

export async function getGcalConnection() {
  const { rows } = await pool.query('SELECT * FROM gcal_connection ORDER BY id LIMIT 1');
  const r = rows[0];
  return {
    Connected: !!r?.refresh_token,
    GoogleEmail: r?.google_email || null,
    CalendarId: r?.calendar_id || null,
    CalendarSummary: r?.calendar_summary || null,
    ConnectedAt: r?.connected_at || null,
    ConnectedBy: r?.connected_by || null,
  };
}

// Internal — only the sync worker (step 3) and the calendar-picker routes
// need the raw token to make authenticated calls, so it's deliberately not
// part of getGcalConnection's public shape above.
export async function getGcalRefreshToken() {
  const { rows } = await pool.query('SELECT refresh_token FROM gcal_connection ORDER BY id LIMIT 1');
  return rows[0]?.refresh_token || null;
}

// Just the OAuth identity — calendar choice is a deliberately separate step
// (saveGcalCalendar below), made after connecting rather than during the
// callback, since listing calendars needs a token the callback has only
// just obtained (2026-09-14 revision: Ben may already have a calendar built
// for this, e.g. one made directly in the camp Google account and shared to
// his own, rather than always wanting a fresh auto-created one). Doesn't
// touch calendar_id/calendar_summary at all, so a reconnect (token died,
// re-authorized) never forgets a previously chosen calendar.
export async function saveGcalConnection({ refreshToken, googleEmail, connectedBy }) {
  await pool.query(
    `UPDATE gcal_connection SET refresh_token = $1, google_email = $2, connected_at = now(), connected_by = $3
     WHERE id = (SELECT id FROM gcal_connection ORDER BY id LIMIT 1)`,
    [refreshToken, googleEmail, connectedBy]
  );
  await logActivity({ action: 'connected', entityType: 'gcal_connection', entityLabel: googleEmail || 'Google Calendar' });
}

// The calendar-picker's write path (admin screen, after connecting) —
// either an existing calendar the account can write to, or one this app
// just created via gcal.js's createCampWorkCalendar.
export async function saveGcalCalendar({ calendarId, calendarSummary }) {
  await pool.query(
    `UPDATE gcal_connection SET calendar_id = $1, calendar_summary = $2
     WHERE id = (SELECT id FROM gcal_connection ORDER BY id LIMIT 1)`,
    [calendarId, calendarSummary]
  );
  await logActivity({ action: 'updated', entityType: 'gcal_connection', entityLabel: `sync calendar: ${calendarSummary || calendarId}` });
}

export async function clearGcalConnection() {
  const { rows } = await pool.query('SELECT google_email FROM gcal_connection ORDER BY id LIMIT 1');
  await pool.query(
    `UPDATE gcal_connection SET refresh_token = NULL, google_email = NULL, calendar_id = NULL, calendar_summary = NULL, connected_at = NULL, connected_by = NULL
     WHERE id = (SELECT id FROM gcal_connection ORDER BY id LIMIT 1)`
  );
  await logActivity({ action: 'disconnected', entityType: 'gcal_connection', entityLabel: rows[0]?.google_email || 'Google Calendar' });
}

// Both the refresh token (to get a fresh access token) and the target
// calendar id, in one round trip — what every sync-worker run needs before
// it can do anything at all.
export async function getGcalSyncTarget() {
  const { rows } = await pool.query('SELECT refresh_token, calendar_id FROM gcal_connection ORDER BY id LIMIT 1');
  return { refreshToken: rows[0]?.refresh_token || null, calendarId: rows[0]?.calendar_id || null };
}

// ── Step 3: outbound sync worker support. Queue reads/writes and the
//    per-entity detail queries the worker needs to build a Google event
//    body — orchestration itself (retry math, event bodies, calling
//    gcal.js) lives in gcalSync.js, kept out of db.js like every other
//    non-SQL concern in this file. ──────────────────────────────────────────

// queued_at comes back as ::text, not the bare timestamptz column — pg's
// wire protocol only round-trips a timestamptz through node-postgres as a
// JS Date at millisecond precision, but the column itself stores
// microseconds (DEFAULT now()). Handing that truncated Date back as the
// optimistic-concurrency guard in resolveGcalSync/markGcalSyncRetry below
// would never match the stored value again — found live, first real drain
// run: two genuinely-succeeded items stayed stuck in the queue forever
// because their "delete if still this queued_at" WHERE clause silently
// matched zero rows every time. Comparing as text sidesteps the precision
// loss entirely.
export async function listDueGcalSyncs(limit = 25) {
  const { rows } = await pool.query(
    `SELECT entity_type, entity_id, queued_at::text AS queued_at, attempts FROM gcal_pending_syncs
     WHERE next_attempt_at <= now() ORDER BY queued_at LIMIT $1`,
    [limit]
  );
  return rows;
}
export async function listDueGcalDeletes(limit = 25) {
  const { rows } = await pool.query(
    `SELECT id, gcal_event_id, attempts FROM gcal_pending_deletes
     WHERE next_attempt_at <= now() ORDER BY queued_at LIMIT $1`,
    [limit]
  );
  return rows;
}

// Deleted with a queued_at guard: if the row changed again (a newer edit
// bumped queued_at) between the worker reading it and finishing the API
// call, this DELETE affects zero rows and the newer change stays queued
// for the next pass instead of being silently dropped.
export async function resolveGcalSync(entityType, entityId, queuedAt) {
  await pool.query(
    'DELETE FROM gcal_pending_syncs WHERE entity_type = $1 AND entity_id = $2 AND queued_at::text = $3',
    [entityType, entityId, queuedAt]
  );
}
export async function markGcalSyncRetry(entityType, entityId, queuedAt, { attempts, nextAttemptAt, error }) {
  await pool.query(
    `UPDATE gcal_pending_syncs SET attempts = $4, next_attempt_at = $5, last_error = $6
     WHERE entity_type = $1 AND entity_id = $2 AND queued_at::text = $3`,
    [entityType, entityId, queuedAt, attempts, nextAttemptAt, error]
  );
}
export async function resolveGcalDelete(id) {
  await pool.query('DELETE FROM gcal_pending_deletes WHERE id = $1', [id]);
}
export async function markGcalDeleteRetry(id, { attempts, nextAttemptAt, error }) {
  await pool.query(
    'UPDATE gcal_pending_deletes SET attempts = $2, next_attempt_at = $3, last_error = $4 WHERE id = $1',
    [id, attempts, nextAttemptAt, error]
  );
}

// Deliberately its own narrow query, not hydrateJobLine — the worker needs
// exactly what goes into a Google event body (title, schedule, the WO/
// asset context for the summary/description) and nothing else; hydrateJobLine's
// cause/assignee/expense-rollup joins would be wasted work on every sync.
export async function getJobLineForGcalSync(id) {
  const { rows } = await pool.query(
    `SELECT jl.id, jl.title, jl.scheduled_date, jl.scheduled_start_time, jl.scheduled_duration_hours, jl.gcal_event_id,
            w.id AS work_order_id, w.title AS wo_title, jls.name AS status_name,
            a.name AS asset_name, l.name AS location_name
     FROM job_lines jl
     JOIN work_orders w ON w.id = jl.work_order_id
     JOIN job_line_statuses jls ON jls.id = jl.status_id
     LEFT JOIN assets a ON a.id = w.asset_id
     LEFT JOIN locations l ON l.id = COALESCE(a.location_id, w.location_id)
     WHERE jl.id = $1`,
    [id]
  );
  return rows[0] || null;
}
export async function setJobLineGcalEventId(id, gcalEventId) {
  await pool.query('UPDATE job_lines SET gcal_event_id = $2 WHERE id = $1', [id, gcalEventId]);
}

// Raw row (not calendarEventRowShape) — CALENDAR_EVENT_SELECT already joins
// in everything the event body needs (type name/color, WO/job-line titles)
// and the worker wants the underlying column names, not the frontend's
// PascalCase shape.
export async function getCalendarEventForGcalSync(id) {
  const { rows } = await pool.query(`${CALENDAR_EVENT_SELECT} WHERE e.id = $1`, [id]);
  return rows[0] || null;
}
export async function setCalendarEventGcalEventId(id, gcalEventId) {
  await pool.query('UPDATE calendar_events SET gcal_event_id = $2 WHERE id = $1', [id, gcalEventId]);
}

// Revisit prompts (migration 0064) — a deferred work order or deferred
// finding's revisit_date, synced as its own all-day "Revisit — ..." Google
// event, never draggable/timed (brief, 2026-09-15: "they're prompts, not
// appointments"). "who deferred it" has no dedicated column on work_orders
// (unlike condition_findings.reviewed_by) — changeWorkOrderStatus already
// writes a work_order_log_entries row with username on every status change,
// so the most recent 'Deferred' one is that answer, without a new column.
export async function getWorkOrderRevisitForGcalSync(id) {
  const { rows } = await pool.query(
    `SELECT w.id, w.title, w.revisit_date, w.deferred_reason, w.gcal_event_id, ws.name AS status_name,
            a.id AS asset_id, a.name AS asset_name,
            (SELECT le.username FROM work_order_log_entries le
             WHERE le.work_order_id = w.id AND le.status_change = 'Deferred'
             ORDER BY le.created_at DESC LIMIT 1) AS deferred_by
     FROM work_orders w
     JOIN work_order_statuses ws ON ws.id = w.status_id
     LEFT JOIN assets a ON a.id = w.asset_id
     WHERE w.id = $1`,
    [id]
  );
  return rows[0] || null;
}
export async function setWorkOrderGcalEventId(id, gcalEventId) {
  await pool.query('UPDATE work_orders SET gcal_event_id = $2 WHERE id = $1', [id, gcalEventId]);
}
export async function getFindingRevisitForGcalSync(id) {
  const { rows } = await pool.query(
    `SELECT cf.id, cf.title, cf.revisit_date, cf.deferred_reason, cf.reviewed_by AS deferred_by, cf.gcal_event_id, cf.status,
            a.id AS asset_id, a.name AS asset_name
     FROM condition_findings cf
     LEFT JOIN assets a ON a.id = cf.asset_id
     WHERE cf.id = $1`,
    [id]
  );
  return rows[0] || null;
}
export async function setFindingGcalEventId(id, gcalEventId) {
  await pool.query('UPDATE condition_findings SET gcal_event_id = $2 WHERE id = $1', [id, gcalEventId]);
}

export async function getGcalEventColors() {
  const { rows } = await pool.query('SELECT kind, gcal_color_id FROM gcal_event_colors ORDER BY kind');
  return rows.map((r) => ({ Kind: r.kind, GcalColorId: r.gcal_color_id }));
}
export async function setGcalEventColor(kind, gcalColorId) {
  const { rowCount } = await pool.query('UPDATE gcal_event_colors SET gcal_color_id = $2 WHERE kind = $1', [kind, gcalColorId || null]);
  if (!rowCount) { const e = new Error(`Unknown event color kind: ${kind}`); e.status = 400; throw e; }
}

// Admin "Regenerate all events" (brief §1.7) — re-enqueues every job line
// that's actually scheduled and every calendar event, resetting retry state
// on anything already queued. For after a color-mapping change, a calendar
// switch, or just wanting to confirm sync is healthy again post-reconnect —
// not something normal editing needs, since every real edit already queues
// itself.
export async function requeueAllGcalSyncs() {
  await pool.query(`
    INSERT INTO gcal_pending_syncs (entity_type, entity_id)
    SELECT 'job_line', id FROM job_lines WHERE scheduled_date IS NOT NULL
    UNION ALL
    SELECT 'calendar_event', id FROM calendar_events
    UNION ALL
    SELECT 'wo_revisit', w.id FROM work_orders w JOIN work_order_statuses ws ON ws.id = w.status_id
      WHERE ws.name = 'Deferred' AND w.revisit_date IS NOT NULL
    UNION ALL
    SELECT 'finding_revisit', id FROM condition_findings WHERE status = 'Deferred' AND revisit_date IS NOT NULL
    ON CONFLICT (entity_type, entity_id) DO UPDATE
      SET queued_at = now(), attempts = 0, next_attempt_at = now(), last_error = NULL
  `);
}

// Fuzzy asset-name match for a batch's subject/body (§5.2) — plain word
// overlap, not a real search index. Never auto-assigns; the inbox surfaces
// the top matches as tappable suggestions only. A silent wrong match
// against 337 assets is worse than no match.
export async function suggestAssetsForText(text, limit = 3) {
  if (!text) return [];
  const words = new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  if (!words.size) return [];
  const { rows } = await pool.query('SELECT id, name FROM assets');
  const scored = rows.map((r) => {
    const nameWords = r.name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const score = nameWords.filter((w) => words.has(w)).length;
    return { Id: r.id, Name: r.name, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ Id, Name }) => ({ Id, Name }));
}

async function markTriaged(attachmentIds, client = pool) {
  if (!attachmentIds.length) return;
  await client.query(`UPDATE attachments SET triage_status = 'triaged' WHERE id = ANY($1::int[])`, [attachmentIds]);
}

// The common triage action: link a batch of selected inbox photos onto an
// EXISTING entity (an existing WO, a job line, an asset for reference-only
// filing, etc) and mark them triaged. "Create WO" / "New finding" below
// create the parent row first, then call this the same way.
export async function triageAttachToEntity(attachmentIds, entityType, entityId, { roleId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of attachmentIds) await linkAttachment(id, { entityType, entityId, roleId }, client);
    await markTriaged(attachmentIds, client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function triageCreateWorkOrder(attachmentIds, { assetId, title }) {
  const { workOrderId } = await createWorkOrder({ assetId, title });
  await triageAttachToEntity(attachmentIds, 'work_order', workOrderId);
  return { workOrderId };
}

export async function triageCreateFinding(attachmentIds, { assetId, severity, description }) {
  const { rows } = await pool.query(
    `INSERT INTO condition_findings (asset_id, title, severity, description, status, date_identified, created_by)
     VALUES ($1,$2,$3,$4,'Open',$5,$6) RETURNING id`,
    [assetId, (description || '').slice(0, 80) || 'Finding from inbox', severity, description, today(), currentUsername()]
  );
  await triageAttachToEntity(attachmentIds, 'condition_finding', rows[0].id);
  return { findingId: rows[0].id };
}

// Void is one tap, no confirm, per the attachment-level voidAttachment
// comment — this is the multi-select version for the inbox's own Void action.
export async function voidAttachments(attachmentIds) {
  for (const id of attachmentIds) await voidAttachment(id);
}

// ── Work order splitting (Build Brief v2 Phase 5, §5.4) — `id serial` stays
//    the real primary key everywhere; wo_number is a DISPLAY string only,
//    always the next flat suffix off the root ("1000-2", "1000-3", ...),
//    never nested. Only available on a non-terminal WO — discovering more
//    work on a closed job creates a new WO, never a retroactive child. ─────

export async function splitWorkOrder(woId, jobLineIds) {
  if (!jobLineIds?.length) { const e = new Error('Select at least one job line to split off'); e.status = 400; throw e; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const woRes = await client.query(
      `SELECT w.*, ws.is_terminal FROM work_orders w JOIN work_order_statuses ws ON ws.id = w.status_id WHERE w.id = $1`, [woId]
    );
    const wo = woRes.rows[0];
    if (!wo) { const e = new Error('Work order not found'); e.status = 404; throw e; }
    if (wo.is_terminal) { const e = new Error('Cannot split a closed work order — a new WO for follow-on work keeps completion dates meaningful'); e.status = 400; throw e; }

    const lineCheck = await client.query(`SELECT id, scheduled_date FROM job_lines WHERE id = ANY($1::int[]) AND work_order_id = $2`, [jobLineIds, woId]);
    if (lineCheck.rows.length !== jobLineIds.length) { const e = new Error('One or more selected lines do not belong to this work order'); e.status = 400; throw e; }

    const rootId = wo.split_root_id;
    const rootRes = await client.query('SELECT wo_number FROM work_orders WHERE id = $1', [rootId]);
    const siblingsRes = await client.query('SELECT wo_number FROM work_orders WHERE split_root_id = $1', [rootId]);
    // The root itself occupies suffix 1 (it's never relabelled "-1" — §5.4 —
    // but the FIRST child off it must still be "-2", not "-1"), so an
    // unsuffixed wo_number (the root, always present in this result set)
    // falls back to 1, not 0. Falling back to 0 here was a real bug: the
    // very first split off a fresh WO produced "-1" instead of "-2" (caught
    // by scripts/verify-rollups.js, Build Brief v2.1 Part 2).
    const nextSuffix = 1 + Math.max(1, ...siblingsRes.rows.map((r) => Number(r.wo_number.match(/-(\d+)$/)?.[1]) || 1));
    const newWoNumber = `${rootRes.rows[0].wo_number}-${nextSuffix}`;

    // Child starts at Assessed or Scheduled (§5.4) — Scheduled if any moved
    // line already has a date, Assessed otherwise (lines exist with
    // hours+cost, matching 2.2's own definition of that status).
    const targetStatusName = lineCheck.rows.some((r) => r.scheduled_date) ? 'Scheduled' : 'Assessed';
    const statusRes = await client.query('SELECT id FROM work_order_statuses WHERE name = $1', [targetStatusName]);

    const childRes = await client.query(
      `INSERT INTO work_orders (asset_id, location_id, project_id, priority, status_id, wo_number, parent_wo_id, split_root_id, title, description, board_focus, date_reported)
       SELECT asset_id, location_id, project_id, priority, $2, $3, $1, $4, title, description, board_focus, $5
       FROM work_orders WHERE id = $1 RETURNING id`,
      [woId, statusRes.rows[0].id, newWoNumber, rootId, today()]
    );
    const childId = childRes.rows[0].id;

    // Lines carry their own hours/cost/funding/crew/status/attachments/
    // finding links with them — nothing else to re-sort (attachment_links
    // point at job_line ids, which don't change, so photos travel for free).
    await client.query(`UPDATE job_lines SET work_order_id = $1 WHERE id = ANY($2::int[])`, [childId, jobLineIds]);

    await client.query('COMMIT');
    await logActivity({ action: 'split off', entityType: 'work_order', entityId: childId, entityLabel: newWoNumber, details: `From WO ${wo.wo_number}` });
    return { workOrderId: childId, woNumber: newWoNumber };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Family rollup (§5.4) — every sibling off the same root, with a combined
// total. Without this a split silently fragments project totals; a single
// query on the indexed split_root_id, not a recursive walk.
export async function getWorkOrderFamily(woId) {
  const rootRes = await pool.query('SELECT split_root_id FROM work_orders WHERE id = $1', [woId]);
  if (!rootRes.rows[0]) return null;
  const rootId = rootRes.rows[0].split_root_id;
  const { rows: members } = await pool.query(
    `SELECT w.id, w.wo_number, w.title, ws.name AS status_name, ws.color AS status_color
     FROM work_orders w JOIN work_order_statuses ws ON ws.id = w.status_id
     WHERE w.split_root_id = $1 ORDER BY w.id`,
    [rootId]
  );
  // EstimatedCost/ActualCost/EstimatedHours/ActualHours are plain sums across
  // members — a split must not change the family total (Build Brief v2.1
  // Part 2, Scenario C). Previously this summed `rollup.ActualCost ||
  // rollup.EstimatedCost || 0` per WO, which is wrong two ways: it drops a
  // WO's estimated-only lines entirely the moment that SAME wo also has even
  // one actualed line (falls through to ActualCost, discarding the rest),
  // and `||` treats a legitimate ActualCost of 0 as falsy and silently
  // substitutes EstimatedCost instead.
  let estimatedCost = 0, actualCost = 0, estimatedHours = 0, actualHours = 0;
  const memberDetails = [];
  for (const m of members) {
    const rollup = await workOrderRollup(m.id);
    memberDetails.push({ Id: m.id, WoNumber: m.wo_number, Title: m.title, Status: m.status_name, StatusColor: m.status_color, Rollup: rollup });
    estimatedCost += rollup.EstimatedCost;
    actualCost += rollup.ActualCost;
    estimatedHours += rollup.EstimatedHours;
    actualHours += rollup.ActualHours;
  }
  // TotalCost is the single blended figure the Family panel shows — same
  // JOB_LINE_COMMITTED_COST_EXPR convention as getBudgetOverview (see its
  // header comment), computed directly from job_lines so a WO with a mix of
  // actualed and not-yet-actualed lines contributes both correctly instead
  // of the all-or-nothing WO-level fallback above. This used to hand-roll
  // COALESCE(jl.actual_cost, jl.estimated_cost, 0) here instead of reusing
  // the shared expression, which silently dropped every linked-expense cost
  // (a line paid for entirely through a linked expense, with no manual
  // actual_cost typed in, read as if nothing had been spent and fell back to
  // its estimate) and still counted a Not Needed/Cancelled line's estimate
  // as real spend.
  const { rows: costRows } = await pool.query(
    `SELECT COALESCE(SUM(${JOB_LINE_COMMITTED_COST_EXPR}), 0) AS cost
     FROM job_lines jl JOIN work_orders w ON w.id = jl.work_order_id
     JOIN job_line_statuses jls ON jls.id = jl.status_id
     LEFT JOIN (${JOB_LINE_EXPENSE_COST_SQL}) ec ON ec.job_line_id = jl.id
     WHERE w.split_root_id = $1`,
    [rootId]
  );
  return {
    RootId: rootId, Members: memberDetails,
    EstimatedCost: estimatedCost, ActualCost: actualCost,
    EstimatedHours: estimatedHours, ActualHours: actualHours,
    TotalCost: Number(costRows[0].cost), TotalHours: actualHours || estimatedHours,
  };
}

// ── Map GPS calibration (Build Brief v2 Phase 5, §5.3) — a one-time affine
//    fit from real-world GPS to the base map image's pixel space, from exactly
//    3 non-collinear reference points (assets already carry map_x/map_y —
//    migration 0027). Recomputed live from whatever points are stored rather
//    than cached, so editing a point via the admin/map UI takes effect
//    immediately. ───────────────────────────────────────────────────────────

export async function listMapCalibrationPoints() {
  const { rows } = await pool.query('SELECT id, label, lat, lng, map_x, map_y FROM map_calibration_points ORDER BY id');
  return rows.map((r) => ({ Id: r.id, Label: r.label, Lat: r.lat, Lng: r.lng, MapX: r.map_x, MapY: r.map_y }));
}
export async function createMapCalibrationPoint({ label, lat, lng, mapX, mapY }) {
  const countRes = await pool.query('SELECT count(*) FROM map_calibration_points');
  if (Number(countRes.rows[0].count) >= 3) { const e = new Error('Only 3 calibration points are used — delete one before adding another'); e.status = 400; throw e; }
  const { rows } = await pool.query('INSERT INTO map_calibration_points (label, lat, lng, map_x, map_y) VALUES ($1,$2,$3,$4,$5) RETURNING *', [label, lat, lng, mapX, mapY]);
  return { Id: rows[0].id, Label: rows[0].label, Lat: rows[0].lat, Lng: rows[0].lng, MapX: rows[0].map_x, MapY: rows[0].map_y };
}
export async function deleteMapCalibrationPoint(id) {
  await pool.query('DELETE FROM map_calibration_points WHERE id = $1', [id]);
}

// Solves x' = a·lat + b·lng + c and y' = d·lat + e·lng + f from exactly 3
// point correspondences via Cramer's rule — a fixed 3x3 linear solve, no
// matrix library needed. Returns null for (near-)collinear points, which
// have no unique solution.
function solveAffine(points) {
  const det3 = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const A = points.map((p) => [p.Lat, p.Lng, 1]);
  const D = det3(A);
  if (Math.abs(D) < 1e-9) return null;
  const solveFor = (target) => {
    const b = points.map(target);
    const withCol = (col) => A.map((row, i) => row.map((v, j) => (j === col ? b[i] : v)));
    return [det3(withCol(0)) / D, det3(withCol(1)) / D, det3(withCol(2)) / D];
  };
  return { xCoef: solveFor((p) => p.MapX), yCoef: solveFor((p) => p.MapY) };
}

export async function gpsToMapPixel(lat, lng) {
  const points = await listMapCalibrationPoints();
  if (points.length < 3) return null;
  const transform = solveAffine(points);
  if (!transform) return null;
  const { xCoef, yCoef } = transform;
  return { x: xCoef[0] * lat + xCoef[1] * lng + xCoef[2], y: yCoef[0] * lat + yCoef[1] * lng + yCoef[2] };
}

// "Confirm or correct" (§5.3) — nearest N assets to a photo's EXIF GPS, in
// map-pixel space so distance is meaningful regardless of calibration scale.
export async function nearestAssetsToGps(lat, lng, limit = 5) {
  const pixel = await gpsToMapPixel(lat, lng);
  if (!pixel) return [];
  const { rows } = await pool.query('SELECT id, name, map_x, map_y FROM assets WHERE map_x IS NOT NULL AND map_y IS NOT NULL');
  return rows
    .map((r) => ({ Id: r.id, Name: r.name, DistancePx: Math.hypot(r.map_x - pixel.x, r.map_y - pixel.y) }))
    .sort((a, b) => a.DistancePx - b.DistancePx)
    .slice(0, limit);
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

function calendarEventRowShape(r) {
  return {
    Id: r.id, Title: r.title, Description: r.description, EventDate: r.event_date,
    RecurrenceType: r.recurrence_type, RecurrenceInterval: r.recurrence_interval, RecurrenceEndDate: r.recurrence_end_date,
    WorkOrderId: r.work_order_id, WorkOrderTitle: r.wo_title,
    JobLineId: r.job_line_id, JobLineTitle: r.job_line_title,
    WorkOrderTemplateId: r.work_order_template_id,
    AuditFormId: r.audit_form_id ?? null,
    AuditLeadDays: r.audit_lead_days ?? null,
    AuditGraceDays: r.audit_grace_days ?? null,
    TypeId: r.type_id, TypeName: r.type_name, TypeGcalColorId: r.type_gcal_color_id,
    StartTime: r.start_time, EndTime: r.end_time, EndDate: r.end_date,
    VisitorName: r.visitor_name, VisitPurpose: r.visit_purpose, VisitorContact: r.visitor_contact,
    CabinHolderId: r.cabin_holder_id, CabinHolderName: r.cabin_holder_name,
    AssetId: r.asset_id, AssetName: r.asset_name,
  };
}

// Expands recurring events into their occurrence dates within [fromDate, toDate]
// (YYYY-MM-DD strings). Each returned entry is one occurrence, tagged with its
// concrete Date so the calendar can place it on the right day. Fast-forwards
// past irrelevant early occurrences instead of walking one at a time from
// the original date, so an old yearly/monthly event viewed much later
// doesn't require hundreds of loop iterations.
//
// spanMs (added for multi-day events, Build Brief v4 Part 1 addition) is how
// many days past event_date the span's end_date runs — a Friday-to-Sunday
// Group Rental has spanMs = 2 days, and "in range" now means the whole
// [occStart, occStart + spanMs] window overlaps [rangeStart, rangeEnd], not
// just occStart itself. Otherwise an event starting in August but running
// into September would silently vanish from September's calendar.
//
// A PM-template-linked event has no static work_order_id of its own — each
// occurrence gets its own generated Work Order once due (see
// generateDueWorkOrdersForRange), so occurrences are joined against
// calendar_event_generated_wo and WorkOrderId/WorkOrderTitle are overridden
// per-occurrence when one has been generated. This means the existing
// WorkOrderId-based "View Linked Work Order" UI keeps working unchanged
// instead of a occurrence showing as a phantom entry with no real WO.
function expandRecurrence(event, rangeStart, rangeEnd) {
  const base = new Date(event.event_date);
  const spanMs = event.end_date ? Math.max(0, new Date(event.end_date) - base) : 0;
  const type = event.recurrence_type;
  const interval = Math.max(1, event.recurrence_interval || 1);
  const endLimit = event.recurrence_end_date ? new Date(event.recurrence_end_date) : null;
  const overlaps = (occStart) => (occStart.getTime() + spanMs) >= rangeStart.getTime() && occStart <= rangeEnd;
  if (type === 'none' || !type) {
    return overlaps(base) ? [base] : [];
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
    if (overlaps(cursor)) occurrences.push(new Date(cursor));
    cursor = addInterval(cursor, type, interval);
  }
  return occurrences;
}

const CALENDAR_EVENT_SELECT = `
  SELECT e.*, w.title AS wo_title, jl.title AS job_line_title, t.name AS type_name, t.gcal_color_id AS type_gcal_color_id,
         a.name AS asset_name, ch.name AS cabin_holder_name
  FROM calendar_events e
  LEFT JOIN LATERAL (
    SELECT ea.dest_type, ea.dest_id FROM expense_allocations ea
    WHERE ea.expense_id = e.id AND ea.dest_type IN ('job_line','work_order')
    ORDER BY ea.id LIMIT 1
  ) d ON true
  LEFT JOIN work_orders w ON d.dest_type = 'work_order' AND w.id = d.dest_id
  LEFT JOIN job_lines jl ON d.dest_type = 'job_line' AND jl.id = d.dest_id
  LEFT JOIN calendar_event_types t ON t.id = e.type_id
  LEFT JOIN assets a ON a.id = e.asset_id
  LEFT JOIN cabin_holders ch ON ch.id = e.cabin_holder_id`;

export async function listCalendarEventOccurrences(fromDate, toDate) {
  const { rows } = await pool.query(
    `${CALENDAR_EVENT_SELECT}
     WHERE e.event_date <= $2 AND (e.recurrence_end_date IS NULL OR e.recurrence_end_date >= $1)`,
    [fromDate, toDate]
  );
  const { rows: genRows } = await pool.query(
    `SELECT g.calendar_event_id, g.occurrence_date, g.work_order_id, w.title AS wo_title
     FROM calendar_event_generated_wo g JOIN work_orders w ON w.id = g.work_order_id
     WHERE g.occurrence_date BETWEEN $1 AND $2`,
    [fromDate, toDate]
  );
  const genByKey = new Map(genRows.map((r) => [`${r.calendar_event_id}:${r.occurrence_date.toISOString().slice(0, 10)}`, r]));
  const rangeStart = new Date(fromDate);
  const rangeEnd = new Date(toDate);
  const out = [];
  for (const row of rows) {
    const shaped = calendarEventRowShape(row);
    const spanMs = row.end_date ? Math.max(0, new Date(row.end_date) - new Date(row.event_date)) : 0;
    for (const occDate of expandRecurrence(row, rangeStart, rangeEnd)) {
      const occStr = occDate.toISOString().slice(0, 10);
      const occEndStr = new Date(occDate.getTime() + spanMs).toISOString().slice(0, 10);
      const gen = genByKey.get(`${row.id}:${occStr}`);
      out.push({
        ...shaped,
        OccurrenceDate: occStr,
        OccurrenceEndDate: occEndStr,
        WorkOrderId: gen ? gen.work_order_id : shaped.WorkOrderId,
        WorkOrderTitle: gen ? gen.wo_title : shaped.WorkOrderTitle,
      });
    }
  }
  return out;
}

// Job lines with a scheduled_date in range — what the Calendar page and the
// dashboard's week-strip render for "work happening on this day" now (1.4:
// a WO's lines can have divergent dates, so the calendar shows lines, not
// work orders). Each row carries its own WO title/status/asset so the
// calendar entry can read "🛠️ Cabin 4: Roof repair — In Progress" without a
// second round trip.
export async function listJobLinesScheduledInRange(fromDate, toDate) {
  const { rows } = await pool.query(
    `SELECT jl.id, jl.title, jl.scheduled_date, jl.scheduled_start_time, jl.scheduled_duration_hours, jl.work_order_id,
            w.title AS wo_title, ws.name AS wo_status, ws.color AS wo_status_color, w.priority,
            jls.id AS status_id, jls.name AS status_name, jls.color AS status_color, jls.is_terminal AS status_is_terminal,
            a.id AS asset_id, a.name AS asset_name
     FROM job_lines jl
     JOIN work_orders w ON w.id = jl.work_order_id
     JOIN work_order_statuses ws ON ws.id = w.status_id
     JOIN job_line_statuses jls ON jls.id = jl.status_id
     LEFT JOIN assets a ON a.id = w.asset_id
     WHERE jl.scheduled_date BETWEEN $1 AND $2
     ORDER BY jl.scheduled_date`,
    [fromDate, toDate]
  );
  return rows.map((r) => ({
    JobLineId: r.id, JobLineTitle: r.title, ScheduledDate: r.scheduled_date,
    ScheduledStartTime: r.scheduled_start_time, ScheduledDurationHours: r.scheduled_duration_hours != null ? Number(r.scheduled_duration_hours) : null,
    WorkOrderId: r.work_order_id, WorkOrderTitle: r.wo_title, WorkOrderStatus: r.wo_status, WorkOrderStatusColor: r.wo_status_color, Priority: r.priority,
    // The LINE's own status — distinct from the WO's above — is what
    // decides drag-eligibility on the Calendar (a terminal line, Done/Not
    // Needed/Cancelled, is a closed decision and stays put even if its work
    // order is still open with other lines going).
    StatusId: r.status_id, StatusName: r.status_name, StatusColor: r.status_color, StatusIsTerminal: r.status_is_terminal,
    Asset: r.asset_id ? { Id: r.asset_id, Name: r.asset_name } : null,
  }));
}

// Everything currently deferred with a revisit date — a work order Deferred
// (2.3) or a condition finding Deferred, each with a reason + a promised
// future date. Not job-line-shaped (no asset/funding to schedule against)
// and not draggable on the Calendar: a revisit date is a commitment already
// made for a stated reason, not an open scheduling slot, so it's surfaced
// here purely for "what's already on the books" visibility (the whole point
// of week/day view — see Build Brief v4 Part 1 amendment).
export async function listRevisitDatesInRange(fromDate, toDate) {
  const [woRows, findingRows] = await Promise.all([
    pool.query(
      `SELECT w.id, w.title, w.revisit_date, w.deferred_reason, a.id AS asset_id, a.name AS asset_name
       FROM work_orders w LEFT JOIN assets a ON a.id = w.asset_id
       JOIN work_order_statuses ws ON ws.id = w.status_id
       WHERE ws.name = 'Deferred' AND w.revisit_date BETWEEN $1 AND $2`,
      [fromDate, toDate]
    ),
    pool.query(
      `SELECT cf.id, cf.title, cf.revisit_date, cf.deferred_reason, a.id AS asset_id, a.name AS asset_name
       FROM condition_findings cf LEFT JOIN assets a ON a.id = cf.asset_id
       WHERE cf.status = 'Deferred' AND cf.revisit_date BETWEEN $1 AND $2`,
      [fromDate, toDate]
    ),
  ]);
  return [
    ...woRows.rows.map((r) => ({
      RevisitEntityType: 'workOrder', WorkOrderId: r.id, Title: r.title, RevisitDate: r.revisit_date,
      DeferredReason: r.deferred_reason, Asset: r.asset_id ? { Id: r.asset_id, Name: r.asset_name } : null,
    })),
    ...findingRows.rows.map((r) => ({
      RevisitEntityType: 'finding', FindingId: r.id, Title: r.title, RevisitDate: r.revisit_date,
      DeferredReason: r.deferred_reason, Asset: r.asset_id ? { Id: r.asset_id, Name: r.asset_name } : null,
    })),
  ];
}

// Every job line still waiting to be put on the calendar — the Scheduling
// Queue's raw material (Build Brief v4 Part 1 amendment). Terminal lines
// (Done/Not Needed/Cancelled) are excluded even if somehow dateless: there's
// nothing left to schedule about a closed line. Small camp-scale dataset —
// fetched whole and filtered/sorted client-side, same pattern as the
// Calendar's old "Unscheduled Work Orders" sidebar it replaces.
export async function listUnscheduledJobLines() {
  const { rows } = await pool.query(
    `SELECT jl.id, jl.title, jl.funding_source, jl.funding_ref_id, jl.estimated_cost, jl.estimated_hours,
            w.id AS work_order_id, w.title AS wo_title, w.priority,
            ws.id AS wo_status_id, ws.name AS wo_status, ws.color AS wo_status_color,
            a.id AS asset_id, a.name AS asset_name, l.id AS location_id, l.name AS location_name
     FROM job_lines jl
     JOIN work_orders w ON w.id = jl.work_order_id
     JOIN work_order_statuses ws ON ws.id = w.status_id
     JOIN job_line_statuses jls ON jls.id = jl.status_id
     LEFT JOIN assets a ON a.id = w.asset_id
     LEFT JOIN locations l ON l.id = COALESCE(a.location_id, w.location_id)
     WHERE jl.scheduled_date IS NULL AND NOT jls.is_terminal
     ORDER BY w.id DESC`
  );
  return await Promise.all(rows.map(async (r) => ({
    JobLineId: r.id, JobLineTitle: r.title, EstimatedCost: r.estimated_cost != null ? Number(r.estimated_cost) : null,
    EstimatedHours: r.estimated_hours != null ? Number(r.estimated_hours) : null,
    FundingSource: r.funding_source, FundingRefId: r.funding_ref_id,
    FundingRefLabel: await getFundingRefLabel(r.funding_source, r.funding_ref_id),
    WorkOrderId: r.work_order_id, WorkOrderTitle: r.wo_title, Priority: r.priority,
    WorkOrderStatusId: r.wo_status_id, WorkOrderStatus: r.wo_status, WorkOrderStatusColor: r.wo_status_color,
    Asset: r.asset_id ? { Id: r.asset_id, Name: r.asset_name } : null,
    Location: r.location_id ? { Id: r.location_id, Name: r.location_name } : null,
  })));
}

// PM auto-generation: for every occurrence in [fromDate, min(toDate, today)]
// of a Calendar Event linked to a Work Order Template, generate its Work
// Order if it hasn't been already. Capping at today means opening the
// calendar for a future month never generates anything early. Called from
// the GET /calendar-events route, so both the dedicated calendar page and
// the dashboard's calendar widget (same endpoint) trigger it.
export async function generateDueWorkOrdersForRange(fromDate, toDate) {
  const todayStr = today();
  const cappedTo = toDate < todayStr ? toDate : todayStr;
  if (cappedTo < fromDate) return [];
  const occurrences = (await listCalendarEventOccurrences(fromDate, cappedTo))
    .filter((o) => o.WorkOrderTemplateId);
  const createdWorkOrderIds = [];
  for (const occ of occurrences) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Advisory lock serializes concurrent requests racing to generate the
      // same occurrence; UNIQUE(calendar_event_id, occurrence_date) on
      // calendar_event_generated_wo is the actual guard this backs up.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cegw:${occ.Id}:${occ.OccurrenceDate}`]);
      const { rows: existing } = await client.query(
        'SELECT 1 FROM calendar_event_generated_wo WHERE calendar_event_id = $1 AND occurrence_date = $2',
        [occ.Id, occ.OccurrenceDate]
      );
      if (!existing.length) {
        const workOrderId = await createWorkOrderFromTemplate(occ.WorkOrderTemplateId, { scheduledDate: occ.OccurrenceDate });
        await client.query(
          `INSERT INTO calendar_event_generated_wo (calendar_event_id, occurrence_date, work_order_id) VALUES ($1,$2,$3)
           ON CONFLICT (calendar_event_id, occurrence_date) DO NOTHING`,
          [occ.Id, occ.OccurrenceDate, workOrderId]
        );
        createdWorkOrderIds.push(workOrderId);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return createdWorkOrderIds;
}

export async function getCalendarEvent(id) {
  const { rows } = await pool.query(`${CALENDAR_EVENT_SELECT} WHERE e.id = $1`, [id]);
  return rows[0] ? calendarEventRowShape(rows[0]) : null;
}

// typeId defaults to 'Other' (Decision 7: never leave a controlled field
// unset, so nobody ends up on a phantom "no type" event) — resolved by name
// rather than requiring the frontend to know the seeded id.
export async function createCalendarEvent({ title, description, eventDate, endDate, startTime, endTime, recurrenceType, recurrenceInterval, recurrenceEndDate, workOrderId, jobLineId, workOrderTemplateId, typeId, visitorName, cabinHolderId, assetId, visitPurpose, visitorContact }) {
  let resolvedTypeId = typeId || null;
  if (!resolvedTypeId) {
    const { rows } = await pool.query(`SELECT id FROM calendar_event_types WHERE name = 'Other'`);
    resolvedTypeId = rows[0]?.id || null;
  }
  const visitor = await applyCabinHolderVisitDefaults({ cabin_holder_id: cabinHolderId, visitor_name: visitorName, asset_id: assetId });
  const { rows } = await pool.query(
    `INSERT INTO calendar_events (title, description, event_date, end_date, start_time, end_time, recurrence_type, recurrence_interval, recurrence_end_date, work_order_id, job_line_id, work_order_template_id, type_id,
                                  visitor_name, cabin_holder_id, asset_id, visit_purpose, visitor_contact)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [title, description || null, eventDate, endDate || null, startTime || null, endTime || null,
      recurrenceType || 'none', recurrenceInterval || 1, recurrenceEndDate || null, workOrderId || null, jobLineId || null, workOrderTemplateId || null, resolvedTypeId,
      visitor.visitor_name, visitor.cabin_holder_id, visitor.asset_id, visitPurpose?.trim() || null, visitorContact?.trim() || null]
  );
  // Unlike a job line (which may or may not have a scheduled_date yet),
  // every calendar_event row has a real event_date from the moment it's
  // created — it always needs to reach Google, not just on later edits.
  await queueGcalSync(pool, 'calendar_event', rows[0].id);
  await logActivity({ action: 'created', entityType: 'calendar_event', entityId: rows[0].id, entityLabel: rows[0].title });
  return calendarEventRowShape(rows[0]);
}

// Every column the synced Google event's body reads — see
// JOB_LINE_SCHEDULE_COLUMNS's comment for why this is checked once here
// rather than at each call site. Started as just the four schedule columns
// the Calendar's drag touches; the visitor columns joined it because the
// Google summary/description are built from them (a changed visitor or
// asset is a different event on Google's side, not a no-op).
const CALENDAR_EVENT_GCAL_COLUMNS = [
  'event_date', 'end_date', 'start_time', 'end_time', 'title', 'description', 'type_id',
  'visitor_name', 'cabin_holder_id', 'asset_id', 'visit_purpose', 'visitor_contact',
];
export async function updateCalendarEvent(id, fields) {
  const allowed = [
    'title', 'description', 'event_date', 'end_date', 'start_time', 'end_time',
    'recurrence_type', 'recurrence_interval', 'recurrence_end_date', 'work_order_id', 'job_line_id', 'work_order_template_id', 'type_id',
    'visitor_name', 'cabin_holder_id', 'asset_id', 'visit_purpose', 'visitor_contact',
  ];
  // Only when the holder link is actually changing to a new holder in this
  // save, and only for columns the request didn't send — an edit that
  // re-saves the same holder never re-derives anything, so a visitor_name
  // or asset the user overrode (including cleared) stays that way.
  if (fields.cabin_holder_id && !('visitor_name' in fields && 'asset_id' in fields)) {
    const { rows: current } = await pool.query('SELECT cabin_holder_id FROM calendar_events WHERE id = $1', [id]);
    if (current[0] && current[0].cabin_holder_id !== fields.cabin_holder_id) {
      const merged = await applyCabinHolderVisitDefaults({ cabin_holder_id: fields.cabin_holder_id, visitor_name: fields.visitor_name, asset_id: fields.asset_id });
      fields = { ...fields, visitor_name: merged.visitor_name, asset_id: merged.asset_id };
    }
  }
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
  if (CALENDAR_EVENT_GCAL_COLUMNS.some((c) => c in fields)) {
    await queueGcalSync(pool, 'calendar_event', Number(id));
  }
  const event = await getCalendarEvent(id);
  await logActivity({ action: 'updated', entityType: 'calendar_event', entityId: Number(id), entityLabel: event?.Title });
  return event;
}

// Cabin-holder defaults for a visit: visitor_name falls back to the
// holder's name, asset_id to the holder's cabin. Only fills a value the
// caller left undefined (didn't send at all) — an explicit null/'' is an
// override, e.g. a holder visiting camp generally rather than their cabin.
// The UI applies the same defaults at pick time so the user sees them;
// this covers API callers that send only the holder. "The holder's cabin" means assets.lodge_holder
// (cabin_holders has no asset column of its own; listCabinHolders derives
// LinkedAssets the same way) and is only defaulted when the holder has
// exactly one — with two cabins there's no right guess, so the UI offers
// both and the server leaves it unset rather than silently picking one.
// cabin_holder_id always arrives from an explicit pick; this never looks a
// holder up by visitor_name.
async function applyCabinHolderVisitDefaults({ cabin_holder_id, visitor_name, asset_id }) {
  const out = { cabin_holder_id: cabin_holder_id || null, visitor_name: visitor_name?.trim() || null, asset_id: asset_id || null };
  if (!out.cabin_holder_id || (visitor_name !== undefined && asset_id !== undefined)) return out;
  const { rows } = await pool.query(
    `SELECT ch.name, COALESCE(json_agg(a.id ORDER BY a.name) FILTER (WHERE a.id IS NOT NULL), '[]') AS asset_ids
     FROM cabin_holders ch LEFT JOIN assets a ON a.cabin_holder_id = ch.id
     WHERE ch.id = $1 GROUP BY ch.id`,
    [out.cabin_holder_id]
  );
  if (!rows[0]) { const e = new Error('Cabin holder not found'); e.status = 400; throw e; }
  if (visitor_name === undefined) out.visitor_name = rows[0].name;
  if (asset_id === undefined && rows[0].asset_ids.length === 1) out.asset_id = rows[0].asset_ids[0];
  return out;
}

// Visitor events overlapping `date` at the asset a job line is about to be
// scheduled on — the scheduling warning (warn, never block: same contract
// as fund overage and the linked-expense double-count confirm). "At the
// asset" includes its ancestors: a visitor at a cabin conflicts with work
// on that cabin's porch or water heater (a child asset) just as much as
// with work on the cabin itself. Pass either assetId directly (new WO form,
// before any job line exists) or jobLineId (resolved through its work
// order, since job lines carry no asset of their own). Recurring and
// multi-day visits are expanded through listCalendarEventOccurrences, the
// same expansion the Calendar renders from, so the two can't disagree.
export async function listVisitorConflicts({ date, assetId, jobLineId }) {
  let resolvedAssetId = assetId ? Number(assetId) : null;
  if (!resolvedAssetId && jobLineId) {
    const { rows } = await pool.query('SELECT w.asset_id FROM job_lines jl JOIN work_orders w ON w.id = jl.work_order_id WHERE jl.id = $1', [jobLineId]);
    resolvedAssetId = rows[0]?.asset_id || null;
  }
  if (!resolvedAssetId || !date) return [];
  const { rows: chain } = await pool.query(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_asset_id, 0 AS depth FROM assets WHERE id = $1
       UNION ALL
       SELECT a.id, a.parent_asset_id, c.depth + 1 FROM assets a JOIN chain c ON a.id = c.parent_asset_id WHERE c.depth < 10
     ) SELECT id FROM chain`,
    [resolvedAssetId]
  );
  const assetIds = new Set(chain.map((r) => r.id));
  return (await listCalendarEventOccurrences(date, date))
    .filter((o) => o.VisitorName && o.AssetId && assetIds.has(o.AssetId))
    .map((o) => ({
      EventId: o.Id, Title: o.Title, VisitorName: o.VisitorName, CabinHolderId: o.CabinHolderId,
      AssetId: o.AssetId, AssetName: o.AssetName, VisitPurpose: o.VisitPurpose,
      OccurrenceDate: o.OccurrenceDate, OccurrenceEndDate: o.OccurrenceEndDate,
      StartTime: o.StartTime, EndTime: o.EndTime, TypeName: o.TypeName,
    }));
}

// Visitor Activity report's raw material — every visit occurrence in range.
// A visit is any calendar event with a visitor_name, regardless of type:
// Constituent Visitation is the expected type, but a Volunteer Workday
// someone logs against a specific visitor/cabin is still a visit. Expanded
// per occurrence (a recurring monthly visit counts once per month), and a
// multi-day stay counts once, on its start date's occurrence.
export async function getVisitorActivityRawData({ from, to }) {
  return (await listCalendarEventOccurrences(from, to))
    .filter((o) => o.VisitorName)
    .sort((a, b) => a.OccurrenceDate.localeCompare(b.OccurrenceDate));
}

export async function deleteCalendarEvent(id) {
  const { rows } = await pool.query('DELETE FROM calendar_events WHERE id = $1 RETURNING title, gcal_event_id', [id]);
  if (!rows[0]) return;
  await queueGcalDelete(rows[0].gcal_event_id);
  await pool.query('DELETE FROM gcal_pending_syncs WHERE entity_type = $1 AND entity_id = $2', ['calendar_event', Number(id)]);
  await logActivity({ action: 'deleted', entityType: 'calendar_event', entityId: Number(id), entityLabel: rows[0].title });
}

// ── Calendar event types (Build Brief v4 Part 1, added before step 3
//    outbound sync) — admin-editable, same rule as every other list in this
//    system (Part A, Decision 7: no hardcoded status/role/cause/category
//    lists). gcal_color_id lives directly on the type, not a separate
//    lookup keyed by a generic 'calendar_event' kind, since every
//    calendar_events row now has a real type — step 3's gcal_event_colors
//    table (job_line/wo_revisit/finding_revisit/pm_due) should read this
//    column for 'calendar_event' color resolution instead of getting its
//    own generic row there. Type also drives the synced Google event's
//    title prefix (e.g. "Visitation — Dorothy, Bethel 04") — that
//    construction happens in step 3's event-building code, not here. ──────
export async function listCalendarEventTypes({ includeInactive = false } = {}) {
  const { rows } = await pool.query(`SELECT * FROM calendar_event_types ${includeInactive ? '' : 'WHERE active'} ORDER BY sort_order, name`);
  return rows.map((r) => ({ Id: r.id, Name: r.name, SortOrder: r.sort_order, GcalColorId: r.gcal_color_id, Active: r.active }));
}
export async function createCalendarEventType({ name, sortOrder = 100, gcalColorId = null }) {
  const { rows } = await pool.query(
    'INSERT INTO calendar_event_types (name, sort_order, gcal_color_id) VALUES ($1,$2,$3) RETURNING *',
    [name, sortOrder, gcalColorId || null]
  );
  await logActivity({ action: 'created', entityType: 'calendar_event_type', entityId: rows[0].id, entityLabel: rows[0].name });
  return { Id: rows[0].id, Name: rows[0].name, SortOrder: rows[0].sort_order, GcalColorId: rows[0].gcal_color_id, Active: rows[0].active };
}
// Full overwrite of name/sortOrder/gcalColorId (the admin edit form always
// submits all three together) — deliberately NOT a COALESCE-style partial
// update like updateAttachmentRole, because gcalColorId needs to be
// clearable back to null ("use the calendar's own default color") and
// COALESCE can never distinguish "explicitly clear this" from "leave it
// alone." Toggling Active is a separate, dedicated function below for
// exactly that reason.
export async function updateCalendarEventType(id, { name, sortOrder, gcalColorId }) {
  const { rows } = await pool.query(
    'UPDATE calendar_event_types SET name = $2, sort_order = $3, gcal_color_id = $4 WHERE id = $1 RETURNING *',
    [id, name, sortOrder, gcalColorId || null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'calendar_event_type', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? { Id: rows[0].id, Name: rows[0].name, SortOrder: rows[0].sort_order, GcalColorId: rows[0].gcal_color_id, Active: rows[0].active } : null;
}
export async function setCalendarEventTypeActive(id, active) {
  const { rows } = await pool.query('UPDATE calendar_event_types SET active = $2 WHERE id = $1 RETURNING *', [id, active]);
  if (rows[0]) await logActivity({ action: active ? 'reactivated' : 'deactivated', entityType: 'calendar_event_type', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? { Id: rows[0].id, Name: rows[0].name, SortOrder: rows[0].sort_order, GcalColorId: rows[0].gcal_color_id, Active: rows[0].active } : null;
}
export async function deleteCalendarEventType(id) {
  const inUse = await pool.query('SELECT count(*) FROM calendar_events WHERE type_id = $1', [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} calendar event(s) still use this type — deactivate it instead of deleting`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM calendar_event_types WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'calendar_event_type', entityId: Number(id), entityLabel: rows[0].name });
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
      `INSERT INTO checklist_template_steps (checklist_template_id, step_text, sort_order, show_when_checked, section)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [templateId, s.text, i, s.showWhenChecked !== false, s.section || null]
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
        Text: s.step_text, Section: s.section || null, ShowWhenChecked: s.show_when_checked,
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
      Id: s.id, StepText: s.step_text, Section: s.section || null, Done: s.done, SortOrder: s.sort_order,
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
        `INSERT INTO checklist_instance_steps (checklist_instance_id, step_text, sort_order, show_when_checked, section)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [instanceId, s.step_text, s.sort_order, s.show_when_checked, s.section || null]
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
export async function createMaintenanceRequest({ values = {}, attachmentIds = [] }) {
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
    for (const attachmentId of attachmentIds) {
      await linkAttachment(attachmentId, { entityType: 'maintenance_request', entityId: request.id }, client);
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

  request.Photos = await listAttachmentsForEntity('maintenance_request', id);

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

// ── Administrative tasks (migration 0066) — Ben's work that isn't tied to an
//    asset or a work order: vendor calls, account cleanup, insurance
//    paperwork. Documentation, not accounting — deliberately no asset, fund,
//    job lines or cost. Attachments ride the shared polymorphic system
//    (entity_type 'admin_task'). Categories and statuses are admin-editable
//    lists, same shape as expense_categories / job_line_statuses. ──────────

function adminTaskCategoryRowShape(r) {
  return { Id: r.id, Name: r.name, SortOrder: r.sort_order, Active: r.active };
}
export async function listAdminTaskCategories({ includeInactive = false } = {}) {
  const { rows } = await pool.query(`SELECT * FROM admin_task_categories ${includeInactive ? '' : 'WHERE active'} ORDER BY sort_order, name`);
  return rows.map(adminTaskCategoryRowShape);
}
export async function createAdminTaskCategory({ name, sortOrder = 100 }) {
  const { rows } = await pool.query('INSERT INTO admin_task_categories (name, sort_order) VALUES ($1,$2) RETURNING *', [name, sortOrder]);
  await logActivity({ action: 'created', entityType: 'admin_task_category', entityId: rows[0].id, entityLabel: rows[0].name });
  return adminTaskCategoryRowShape(rows[0]);
}
export async function updateAdminTaskCategory(id, { name, sortOrder, active }) {
  const { rows } = await pool.query(
    'UPDATE admin_task_categories SET name = COALESCE($2,name), sort_order = COALESCE($3,sort_order), active = COALESCE($4,active) WHERE id = $1 RETURNING *',
    [id, name ?? null, sortOrder ?? null, active ?? null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'admin_task_category', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? adminTaskCategoryRowShape(rows[0]) : null;
}
export async function deleteAdminTaskCategory(id) {
  const inUse = await pool.query('SELECT count(*) FROM admin_tasks WHERE category_id = $1', [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} task(s) still use this category — deactivate it instead of deleting`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM admin_task_categories WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'admin_task_category', entityId: Number(id), entityLabel: rows[0].name });
}

function adminTaskStatusRowShape(r) {
  return { Id: r.id, Name: r.name, SortOrder: r.sort_order, CountsAsWorkPerformed: r.counts_as_work_performed, Active: r.active };
}
export async function listAdminTaskStatuses({ includeInactive = false } = {}) {
  const { rows } = await pool.query(`SELECT * FROM admin_task_statuses ${includeInactive ? '' : 'WHERE active'} ORDER BY sort_order, name`);
  return rows.map(adminTaskStatusRowShape);
}
export async function createAdminTaskStatus({ name, sortOrder = 100, countsAsWorkPerformed = false }) {
  const { rows } = await pool.query(
    'INSERT INTO admin_task_statuses (name, sort_order, counts_as_work_performed) VALUES ($1,$2,$3) RETURNING *',
    [name, sortOrder, !!countsAsWorkPerformed]
  );
  await logActivity({ action: 'created', entityType: 'admin_task_status', entityId: rows[0].id, entityLabel: rows[0].name });
  return adminTaskStatusRowShape(rows[0]);
}
export async function updateAdminTaskStatus(id, { name, sortOrder, countsAsWorkPerformed, active }) {
  const { rows } = await pool.query(
    `UPDATE admin_task_statuses SET name = COALESCE($2,name), sort_order = COALESCE($3,sort_order),
       counts_as_work_performed = COALESCE($4,counts_as_work_performed), active = COALESCE($5,active)
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, sortOrder ?? null, countsAsWorkPerformed ?? null, active ?? null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'admin_task_status', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? adminTaskStatusRowShape(rows[0]) : null;
}
export async function deleteAdminTaskStatus(id) {
  const inUse = await pool.query('SELECT count(*) FROM admin_tasks WHERE status_id = $1', [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} task(s) still use this status — deactivate it instead of deleting`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM admin_task_statuses WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'admin_task_status', entityId: Number(id), entityLabel: rows[0].name });
}

function adminTaskRowShape(r) {
  return {
    Id: r.id, Title: r.title, Description: r.description, TaskDate: r.task_date_text,
    Hours: r.hours != null ? Number(r.hours) : null,
    StatusId: r.status_id, StatusName: r.status_name, StatusCountsAsWorkPerformed: r.status_counts_as_work_performed,
    CategoryId: r.category_id, CategoryName: r.category_name,
    RecurringMonthlySavings: r.recurring_monthly_savings != null ? Number(r.recurring_monthly_savings) : null,
    IncludeInBoardReport: r.include_in_board_report,
    AttachmentCount: r.attachment_count != null ? Number(r.attachment_count) : undefined,
    CreatedBy: r.created_by, CreatedAt: r.created_at, UpdatedAt: r.updated_at,
  };
}
// savings moved out to savings_entries (0076) so purchases can record savings the
// same way, but the shape callers see is unchanged: RecurringMonthlySavings still
// comes back on the task, now read through this subquery rather than a column. One
// recurring monthly entry per task is the invariant writeAdminTaskSaving maintains.
const ADMIN_TASK_SELECT = `
  SELECT t.*, t.task_date::text AS task_date_text, s.name AS status_name, s.counts_as_work_performed AS status_counts_as_work_performed, c.name AS category_name,
         (SELECT se.amount FROM savings_entries se
          WHERE se.source_type = 'admin_task' AND se.source_id = t.id
            AND se.kind = 'recurring' AND se.period = 'monthly'
          ORDER BY se.id LIMIT 1) AS recurring_monthly_savings,
         (SELECT count(*) FROM attachment_links al JOIN attachments a ON a.id = al.attachment_id AND a.deleted_at IS NULL
          WHERE al.entity_type = 'admin_task' AND al.entity_id = t.id) AS attachment_count
  FROM admin_tasks t
  JOIN admin_task_statuses s ON s.id = t.status_id
  LEFT JOIN admin_task_categories c ON c.id = t.category_id`;

// TaskDate goes out as plain YYYY-MM-DD text (task_date_text above) rather
// than a pg Date — a date-only value has no timezone to get wrong.
export async function listAdminTasks({ statusId, categoryId, dateFrom, dateTo, q } = {}) {
  const where = []; const vals = [];
  if (statusId) { vals.push(Number(statusId)); where.push(`t.status_id = $${vals.length}`); }
  if (categoryId) { vals.push(Number(categoryId)); where.push(`t.category_id = $${vals.length}`); }
  if (dateFrom) { vals.push(dateFrom); where.push(`t.task_date >= $${vals.length}`); }
  if (dateTo) { vals.push(dateTo); where.push(`t.task_date <= $${vals.length}`); }
  if (q) { vals.push(`%${q}%`); where.push(`(t.title ILIKE $${vals.length} OR t.description ILIKE $${vals.length})`); }
  const { rows } = await pool.query(
    `${ADMIN_TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.task_date DESC, t.id DESC`,
    vals
  );
  return rows.map(adminTaskRowShape);
}
export async function getAdminTask(id) {
  const { rows } = await pool.query(`${ADMIN_TASK_SELECT} WHERE t.id = $1`, [id]);
  return rows[0] ? adminTaskRowShape(rows[0]) : null;
}

// Status defaults to the first active status flagged as work performed
// ('Done' as seeded) when the caller sends none — logging a task after the
// fact is the common case, and a task with no status can't exist
// (status_id NOT NULL, Decision 7).
async function resolveAdminTaskStatusId(statusId) {
  if (statusId) return statusId;
  const { rows } = await pool.query(
    `SELECT id FROM admin_task_statuses WHERE active ORDER BY (name = 'Done') DESC, counts_as_work_performed DESC, sort_order LIMIT 1`
  );
  if (!rows[0]) { const e = new Error('No active admin task statuses — add one in Admin'); e.status = 400; throw e; }
  return rows[0].id;
}
export async function createAdminTask({ title, description, taskDate, hours, statusId, categoryId, recurringMonthlySavings, includeInBoardReport = true, createdBy }) {
  const resolvedStatusId = await resolveAdminTaskStatusId(statusId);
  const { rows } = await pool.query(
    `INSERT INTO admin_tasks (title, description, task_date, hours, status_id, category_id, include_in_board_report, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [title, description || null, taskDate || null, hours ?? null, resolvedStatusId, categoryId || null, includeInBoardReport !== false, createdBy || null]
  );
  await writeAdminTaskSaving(rows[0].id, recurringMonthlySavings ?? null, taskDate || null);
  await logActivity({ action: 'created', entityType: 'admin_task', entityId: rows[0].id, entityLabel: title });
  return getAdminTask(rows[0].id);
}

// One recurring monthly savings entry per admin task. null/0 removes it, so clearing
// the field clears the saving rather than leaving a stale row the report would keep
// counting. occurredOn follows the task's date — when the saving was secured.
export async function writeAdminTaskSaving(taskId, amount, taskDate) {
  const n = amount == null || amount === '' ? null : Number(amount);
  await pool.query(
    `DELETE FROM savings_entries
     WHERE source_type = 'admin_task' AND source_id = $1 AND kind = 'recurring' AND period = 'monthly'`,
    [taskId]
  );
  if (n == null || !(n > 0)) return;
  await pool.query(
    `INSERT INTO savings_entries (kind, amount, period, source_type, source_id, occurred_on)
     VALUES ('recurring', $1, 'monthly', 'admin_task', $2, COALESCE($3::date, CURRENT_DATE))`,
    [n, taskId, taskDate || null]
  );
}

const ADMIN_TASK_COLUMNS = {
  title: 'title', description: 'description', taskDate: 'task_date', hours: 'hours',
  statusId: 'status_id', categoryId: 'category_id',
  includeInBoardReport: 'include_in_board_report',
};
// Not in ADMIN_TASK_COLUMNS on purpose — it lives in savings_entries now.
export async function updateAdminTask(id, fields) {
  const setCols = []; const vals = [];
  for (const [key, col] of Object.entries(ADMIN_TASK_COLUMNS)) {
    if (!(key in fields)) continue;
    vals.push(fields[key]);
    setCols.push(`${col} = $${vals.length}`);
  }
  if ('recurringMonthlySavings' in fields) {
    const cur = await getAdminTask(id);
    if (!cur) return null;
    await writeAdminTaskSaving(id, fields.recurringMonthlySavings, fields.taskDate ?? cur.TaskDate);
  }
  if (!setCols.length) return getAdminTask(id);
  vals.push(id);
  const { rows } = await pool.query(`UPDATE admin_tasks SET ${setCols.join(', ')} WHERE id = $${vals.length} RETURNING id, title`, vals);
  if (!rows[0]) return null;
  await logActivity({ action: 'updated', entityType: 'admin_task', entityId: rows[0].id, entityLabel: rows[0].title });
  return getAdminTask(id);
}
// Hard delete — a task is Ben's own note, nothing hangs off it but
// attachment links. The links go with it (attachment_links is polymorphic,
// so no FK cascade does this for us); the files themselves stay, same as
// detaching them, so a document still linked elsewhere is untouched.
export async function deleteAdminTask(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM attachment_links WHERE entity_type = 'admin_task' AND entity_id = $1`, [id]);
    // savings_entries is polymorphic, so no FK cascade reaches it — same reason the
    // attachment links above have to be deleted by hand.
    await client.query(`DELETE FROM savings_entries WHERE source_type = 'admin_task' AND source_id = $1`, [id]);
    const { rows } = await client.query('DELETE FROM admin_tasks WHERE id = $1 RETURNING title', [id]);
    await client.query('COMMIT');
    if (rows[0]) await logActivity({ action: 'deleted', entityType: 'admin_task', entityId: Number(id), entityLabel: rows[0].title });
    return !!rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Work Performed report's Administrative Work section — tasks dated in
// range whose status counts as work performed (In Progress / Waiting /
// Done as seeded; To Do and Cancelled don't). Savings are only totalled
// over these same tasks: a cost reduction on a task that never happened
// isn't a saving.
// Board Report's Administrative Work section — same "counts as work
// performed" rule as the Work Performed report, narrowed to flagged tasks.
export async function getAdminTasksBoardReportRawData({ from, to }) {
  const { rows } = await pool.query(
    `${ADMIN_TASK_SELECT} WHERE s.counts_as_work_performed AND t.include_in_board_report AND t.task_date BETWEEN $1 AND $2 ORDER BY t.task_date, t.id`,
    [from, to]
  );
  return rows.map(adminTaskRowShape);
}
export async function getAdminTasksWorkPerformedRawData({ from, to }) {
  const { rows } = await pool.query(
    `${ADMIN_TASK_SELECT} WHERE s.counts_as_work_performed AND t.task_date BETWEEN $1 AND $2 ORDER BY t.task_date, t.id`,
    [from, to]
  );
  return rows.map(adminTaskRowShape);
}
