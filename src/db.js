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
      COALESCE(SUM(jl.actual_cost), 0) AS actual_cost,
      MIN(jl.scheduled_date) AS earliest_scheduled_date,
      COALESCE(ARRAY_AGG(DISTINCT jl.responsibility_class), '{}') AS responsibility_classes,
      COALESCE(ARRAY_AGG(DISTINCT jl.funding_source), '{}') AS funding_sources
    FROM job_lines jl
    LEFT JOIN (${JOB_LINE_SESSION_HOURS_SQL}) lh ON lh.job_line_id = jl.id
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
           jl.estimated_cost, jl.actual_cost, jl.scheduled_date, jl.completed_date,
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
    `SELECT jl.id, jl.title, jl.correction, jl.completed_date, jl.actual_cost, jl.estimated_cost,
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
  const inUse = await pool.query(`SELECT count(*) FROM job_lines WHERE funding_source = 'cabin_holder' AND funding_ref_id = $1`, [id]);
  if (Number(inUse.rows[0].count) > 0) { const e = new Error(`${inUse.rows[0].count} job line(s) still reference this cabin-holder — reassign them first`); e.status = 400; throw e; }
  const { rows } = await pool.query('DELETE FROM cabin_holders WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'cabin_holder', entityId: Number(id), entityLabel: rows[0].name });
}

// The whole "Budget" section of Capital Plan in one call: operating-budget
// years-to-cover, and itemized-with-rollup views for each funding source.
export async function getBudgetOverview() {
  const settings = await getBudgetSettings();

  // Cost per job line is COALESCE(actual_cost, estimated_cost) — same rule
  // as everywhere else (see this section's header comment). Grouping by job
  // line, not work order, is the point of Phase 1: one WO can have lines
  // against three different funding sources.
  const opRes = await pool.query(`
    SELECT jl.id, ws.name AS status, ws.is_terminal, COALESCE(jl.actual_cost, jl.estimated_cost, 0) AS cost
    FROM job_lines jl JOIN work_orders w ON w.id = jl.work_order_id
    JOIN work_order_statuses ws ON ws.id = w.status_id
    WHERE jl.funding_source = 'operating_budget' AND COALESCE(jl.actual_cost, jl.estimated_cost, 0) > 0
  `);
  const pendingOpCost = opRes.rows.filter((r) => !r.is_terminal).reduce((s, r) => s + Number(r.cost), 0);
  const totalOpCost = opRes.rows.reduce((s, r) => s + Number(r.cost), 0);

  async function itemizedGroups(fundingSource, entities) {
    const lineRes = await pool.query(
      `SELECT jl.id AS job_line_id, jl.title AS job_line_title, jl.funding_ref_id,
              w.id AS work_order_id, w.title AS wo_title, ws.name AS status,
              COALESCE(jl.actual_cost, jl.estimated_cost, 0) AS cost
       FROM job_lines jl JOIN work_orders w ON w.id = jl.work_order_id
       JOIN work_order_statuses ws ON ws.id = w.status_id
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
    SELECT work_order_id, status_id, COUNT(*) AS line_count,
           SUM(COALESCE(actual_cost, estimated_cost, 0)) AS cost,
           SUM(COALESCE(estimated_cost, 0)) AS est_cost
    FROM job_lines GROUP BY work_order_id, status_id
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
            COALESCE(SUM(jl.actual_cost), 0) AS actual_cost,
            MIN(jl.scheduled_date) AS earliest_scheduled_date,
            MAX(jl.scheduled_date) AS latest_scheduled_date,
            COALESCE(ARRAY_AGG(DISTINCT jl.responsibility_class), '{}') AS responsibility_classes
     FROM job_lines jl
     LEFT JOIN (${JOB_LINE_SESSION_HOURS_SQL}) lh ON lh.job_line_id = jl.id
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
    `SELECT funding_source, funding_ref_id, SUM(COALESCE(actual_cost, estimated_cost, 0)) AS cost
     FROM job_lines WHERE work_order_id = $1 GROUP BY funding_source, funding_ref_id`,
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
  return rows.map((r) => ({ Id: r.id, Name: r.name, SortOrder: r.sort_order, Color: r.color, IsTerminal: r.is_terminal }));
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
  return rows.map((r) => ({ Id: r.id, Name: r.name, SortOrder: r.sort_order, Color: r.color, IsTerminal: r.is_terminal, Active: r.active }));
}
export async function adminCreateWorkOrderStatus({ name, sortOrder = 100, color = '#888888', isTerminal = false }) {
  const { rows } = await pool.query(
    'INSERT INTO work_order_statuses (name, sort_order, color, is_terminal) VALUES ($1,$2,$3,$4) RETURNING *',
    [name, sortOrder, color, !!isTerminal]
  );
  await logActivity({ action: 'created', entityType: 'work_order_status', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0];
}
export async function adminUpdateWorkOrderStatus(id, { name, sortOrder, color, isTerminal, active }) {
  const { rows } = await pool.query(
    `UPDATE work_order_statuses SET name = COALESCE($2,name), sort_order = COALESCE($3,sort_order),
       color = COALESCE($4,color), is_terminal = COALESCE($5,is_terminal), active = COALESCE($6,active)
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, sortOrder ?? null, color ?? null, isTerminal ?? null, active ?? null]
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
export async function getDisplaySettings() {
  const { rows } = await pool.query('SELECT wo_progress_weighting, report_image_cap FROM display_settings ORDER BY id LIMIT 1');
  return { WoProgressWeighting: rows[0]?.wo_progress_weighting || 'cost', ReportImageCap: rows[0]?.report_image_cap ?? 4 };
}
export async function updateDisplaySettings({ woProgressWeighting, reportImageCap }) {
  await pool.query(
    `UPDATE display_settings SET
       wo_progress_weighting = COALESCE($1, wo_progress_weighting),
       report_image_cap = COALESCE($2, report_image_cap)
     WHERE id = (SELECT id FROM display_settings ORDER BY id LIMIT 1)`,
    [woProgressWeighting || null, reportImageCap ?? null]
  );
  await logActivity({ action: 'updated', entityType: 'display_settings', entityLabel: 'display settings', details: `weighting=${woProgressWeighting || '—'} imageCap=${reportImageCap ?? '—'}` });
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
    `SELECT w.status_id, ws.name AS old_name, w.title FROM work_orders w JOIN work_order_statuses ws ON ws.id = w.status_id WHERE w.id = $1`,
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
}

// jobLines: [{ title, responsibilityClass, fundingSource, fundingRefId,
// estimatedHours, estimatedCost, scheduledDate }] — the WO creation flow
// (1.7) captures a full job line per "+ Add job line" row; scheduledDate
// defaults to the WO's own date when a line doesn't set its own (1.4).
export async function createWorkOrder({ title, assetId, locationId, priority, description, scheduledDate, assetUpdates = [], jobLines = [] }) {
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
      `INSERT INTO work_orders (id, title, asset_id, location_id, priority, status_id, description, date_reported, wo_number, split_root_id)
       VALUES ($1,$2,$3,$4,$5,(SELECT id FROM work_order_statuses WHERE name = 'Reported'),$6,$7,$8,$1) RETURNING id`,
      [woId, title, assetId || null, locationId || null, priority || 'Medium', description || null, today(), String(woId)]
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
      await client.query(
        `INSERT INTO job_lines (work_order_id, title, sort_order, responsibility_class, funding_source, funding_ref_id, estimated_hours, estimated_cost, scheduled_date, status_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT id FROM job_line_statuses WHERE name = 'Not Started'))`,
        [woId, lineTitle, sortOrder++,
          line.responsibilityClass || 'self', line.fundingSource || 'operating_budget', line.fundingRefId || null,
          line.estimatedHours ?? null, line.estimatedCost ?? null, line.scheduledDate || scheduledDate || null]
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
  const allowed = ['title', 'description', 'priority', 'date_reported', 'date_completed', 'asset_id', 'board_focus'];
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
    // job_line_defaults now holds partial job-line objects (title/
    // responsibilityClass/fundingSource/fundingRefId/estimatedHours/
    // estimatedCost) — see migration 0038/0039. asset_update_defaults is the
    // older, separate "also update an asset field" blueprint, unrelated to
    // job lines.
    JobLineDefaults: r.job_line_defaults, AssetUpdateDefaults: r.asset_update_defaults,
    DefaultResponsibilityClass: r.default_responsibility_class,
    PresetVolunteerIds: r.preset_volunteer_ids, PresetVendorIds: r.preset_vendor_ids,
  };
}
export async function listWorkOrderTemplates() {
  const { rows } = await pool.query('SELECT * FROM work_order_templates ORDER BY name');
  return rows.map(templateRowShape);
}
export async function createWorkOrderTemplate({ name, defaultTitle, defaultPriority, defaultDescription, jobLineDefaults = [], assetUpdateDefaults = [], defaultResponsibilityClass, presetVolunteerIds = [], presetVendorIds = [] }) {
  const { rows } = await pool.query(
    `INSERT INTO work_order_templates (name, default_title, default_priority, default_description, job_line_defaults, asset_update_defaults, default_responsibility_class, preset_volunteer_ids, preset_vendor_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [name, defaultTitle || null, defaultPriority || null, defaultDescription || null, JSON.stringify(jobLineDefaults), JSON.stringify(assetUpdateDefaults),
      defaultResponsibilityClass || null, presetVolunteerIds, presetVendorIds]
  );
  await logActivity({ action: 'created', entityType: 'work_order_template', entityId: rows[0].id, entityLabel: rows[0].name });
  return templateRowShape(rows[0]);
}
export async function updateWorkOrderTemplate(id, { name, defaultTitle, defaultPriority, defaultDescription, jobLineDefaults, assetUpdateDefaults, defaultResponsibilityClass, presetVolunteerIds, presetVendorIds }) {
  const { rows } = await pool.query(
    `UPDATE work_order_templates SET
       name = COALESCE($2,name), default_title = COALESCE($3,default_title),
       default_priority = COALESCE($4,default_priority), default_description = COALESCE($5,default_description),
       job_line_defaults = COALESCE($6,job_line_defaults), asset_update_defaults = COALESCE($7,asset_update_defaults),
       default_responsibility_class = COALESCE($8,default_responsibility_class), preset_volunteer_ids = COALESCE($9,preset_volunteer_ids),
       preset_vendor_ids = COALESCE($10,preset_vendor_ids)
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, defaultTitle ?? null, defaultPriority ?? null, defaultDescription ?? null,
      jobLineDefaults ? JSON.stringify(jobLineDefaults) : null, assetUpdateDefaults ? JSON.stringify(assetUpdateDefaults) : null,
      defaultResponsibilityClass ?? null, presetVolunteerIds ?? null, presetVendorIds ?? null]
  );
  if (rows[0]) await logActivity({ action: 'updated', entityType: 'work_order_template', entityId: rows[0].id, entityLabel: rows[0].name });
  return rows[0] ? templateRowShape(rows[0]) : null;
}
export async function deleteWorkOrderTemplate(id) {
  const { rows } = await pool.query('DELETE FROM work_order_templates WHERE id = $1 RETURNING name', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'work_order_template', entityId: Number(id), entityLabel: rows[0].name });
}

// Instantiates a template into a real Work Order — used by PM auto-generation
// (see generateDueWorkOrdersForRange) where there's no browser session to do
// the client-side prefill renderNewWorkOrder does. job_line_defaults/
// asset_update_defaults are already in createWorkOrder's jobLines/assetUpdates
// shape (same arrays the New Work Order form builds from a template pick), so
// no reshaping needed — default_responsibility_class fills in any line that
// doesn't specify its own. Preset crew attaches to every line created, since
// assignment is per-line now (1.2), not per-WO.
export async function createWorkOrderFromTemplate(templateId, { assetId, locationId, scheduledDate } = {}) {
  const { rows } = await pool.query('SELECT * FROM work_order_templates WHERE id = $1', [templateId]);
  const tpl = rows[0];
  if (!tpl) throw new Error(`Work Order Template #${templateId} not found`);
  const jobLines = (tpl.job_line_defaults || []).map((l) => ({
    ...(typeof l === 'string' ? { title: l } : l),
    responsibilityClass: (typeof l === 'object' && l.responsibilityClass) || tpl.default_responsibility_class || 'self',
  }));
  const { workOrderId } = await createWorkOrder({
    title: tpl.default_title || tpl.name,
    assetId, locationId,
    priority: tpl.default_priority,
    description: tpl.default_description,
    scheduledDate,
    assetUpdates: tpl.asset_update_defaults || [],
    jobLines,
  });
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
    'UPDATE condition_findings SET board_focus = $2 WHERE id = $1 RETURNING id, title, board_focus',
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
  await logActivity({ action: 'deferred', entityType: 'condition_finding', entityId: rows[0].id, entityLabel: rows[0].title, details: reason.trim() });
  return { Id: rows[0].id, Title: rows[0].title };
}
export async function dismissFinding(id, { note }) {
  if (!note?.trim()) { const e = new Error('Dismissing a finding requires a note'); e.status = 400; throw e; }
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
       SELECT work_order_id, SUM(actual_cost) AS total_actual_cost
       FROM job_lines WHERE actual_cost IS NOT NULL GROUP BY work_order_id
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
      SELECT jl.funding_source, COALESCE(jl.actual_cost, jl.estimated_cost, 0) AS cost
      FROM job_lines jl JOIN work_orders w ON w.id = jl.work_order_id
      JOIN work_order_statuses ws ON ws.id = w.status_id
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
    Complaint: r.complaint, CauseNote: r.cause_note, Correction: r.correction,
    BlockedReason: r.blocked_reason, BlockedSince: r.blocked_since, CompletedDate: r.completed_date,
    ConditionFindingId: r.condition_finding_id,
  };
}

// One line's full detail — used by the job-line edit form, which needs the
// funding label, status flags, cause names, and assigned crew alongside the
// bare columns.
async function hydrateJobLine(row) {
  const shaped = jobLineRowShape(row);
  const [fundingRefLabel, statusRows, causes, assignees] = await Promise.all([
    getFundingRefLabel(row.funding_source, row.funding_ref_id),
    pool.query('SELECT name, color, is_terminal, counts_as_work_performed, requires_note, note_label FROM job_line_statuses WHERE id = $1', [row.status_id]),
    pool.query(`SELECT c.id, c.name FROM job_line_causes jlc JOIN causes c ON c.id = jlc.cause_id WHERE jlc.job_line_id = $1 ORDER BY c.sort_order, c.name`, [row.id]),
    getJobLineAssignees(row.id),
  ]);
  const s = statusRows.rows[0] || {};
  return {
    ...shaped, FundingRefLabel: fundingRefLabel,
    StatusName: s.name, StatusColor: s.color, StatusIsTerminal: s.is_terminal,
    StatusCountsAsWorkPerformed: s.counts_as_work_performed,
    Causes: causes.rows.map((c) => ({ Id: c.id, Name: c.name })), ...assignees,
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
  if (conditionFindingId) await autoScheduleFindingIfLinked(pool, conditionFindingId);
  await logActivity({ action: 'created', entityType: 'job_line', entityId: rows[0].id, entityLabel: rows[0].title, details: `On Work Order #${woId}` });
  return hydrateJobLine(rows[0]);
}

// Phase 3 (3): a finding moves Open -> Scheduled the moment a job line links
// to it — automatic, no note, because linking IS the decision (something is
// now going to happen to it). Only fires from Open; a finding already
// Resolved/Deferred/Dismissed doesn't get silently reopened by a later link.
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
  await client.query(`UPDATE condition_findings SET status = 'Resolved' WHERE id = $1`, [findingId]);
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
  if (newStatus.counts_as_work_performed && !cur.completed_date) {
    setCols.push('completed_date = CURRENT_DATE');
  }
  await client.query(`UPDATE job_lines SET ${setCols.join(', ')} WHERE id = $1`, vals);
  if (newStatus.counts_as_work_performed) await autoResolveLinkedFinding(client, jobLineId);
  const noteText = statusNote?.trim()
    ? `Job line "${cur.title}" → ${newStatus.name}: ${statusNote.trim()}`
    : `Job line "${cur.title}" status: ${cur.old_name} → ${newStatus.name}`;
  await client.query(
    'INSERT INTO work_order_log_entries (work_order_id, note, status_change, username) VALUES ($1,$2,$3,$4)',
    [cur.work_order_id, noteText, newStatus.name, currentUsername()]
  );
}

const JOB_LINE_UPDATE_COLUMNS = [
  'title', 'responsibility_class', 'funding_source', 'funding_ref_id',
  'estimated_hours', 'actual_hours', 'estimated_cost', 'actual_cost', 'scheduled_date',
  'complaint', 'cause_note', 'correction', 'blocked_reason', 'blocked_since', 'completed_date',
  'condition_finding_id',
];
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
  const { rows } = await pool.query('DELETE FROM job_lines WHERE id = $1 RETURNING title, work_order_id', [id]);
  if (rows[0]) await logActivity({ action: 'deleted', entityType: 'job_line', entityId: Number(id), entityLabel: rows[0].title, details: `On Work Order #${rows[0].work_order_id}` });
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

const ATTACHMENT_ENTITY_TYPES = new Set(['asset', 'work_order', 'job_line', 'condition_finding', 'asset_component', 'maintenance_request', 'asset_note', 'expense']);

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
export async function createMailInboundBatch({ subject, bodyText, senderEmail, messageId, receivedAt, spfResult, dkimResult, attachments, targetWorkOrderId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO attachment_batches (source, subject, body_text, sender_email, message_id, received_at, spf_result, dkim_result)
       VALUES ('email',$1,$2,$3,$4,$5,$6,$7) ON CONFLICT (message_id) DO NOTHING RETURNING id`,
      [subject, bodyText, senderEmail, messageId, receivedAt, spfResult, dkimResult]
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
export async function createReceiptInboundBatch({ subject, bodyText, senderEmail, messageId, receivedAt, spfResult, dkimResult, attachments, parsed }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO attachment_batches (source, subject, body_text, sender_email, message_id, received_at, spf_result, dkim_result)
       VALUES ('email',$1,$2,$3,$4,$5,$6,$7) ON CONFLICT (message_id) DO NOTHING RETURNING id`,
      [subject, bodyText, senderEmail, messageId, receivedAt, spfResult, dkimResult]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return null; }
    const batchId = rows[0].id;

    const expenseRes = await client.query(
      `INSERT INTO expenses (vendor, amount, purchase_date, triage_status, batch_id, source, parsed_confidence)
       VALUES ($1,$2,$3,'inbox',$4,'email',$5) RETURNING id`,
      [parsed?.vendor || null, parsed?.amount ?? null, parsed?.purchaseDate || null, batchId, parsed?.confidence || 'none']
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
  const { rows: spentRows } = await pool.query(
    `SELECT fund_id, COALESCE(SUM(amount), 0) AS spent FROM expenses WHERE fund_id IS NOT NULL AND triage_status != 'void' AND deleted_at IS NULL GROUP BY fund_id`
  );
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
    CategoryId: r.category_id, CategoryName: r.category_name || null,
    FundId: r.fund_id, FundName: r.fund_name || null,
    JobLineId: r.job_line_id, JobLineTitle: r.job_line_title || null,
    WorkOrderId: r.work_order_id, WorkOrderTitle: r.work_order_title || null,
    AssetId: r.asset_id, AssetName: r.asset_name || null,
    Notes: r.notes, TriageStatus: r.triage_status, Source: r.source, ParsedConfidence: r.parsed_confidence,
    CreatedBy: r.created_by, CreatedAt: r.created_at,
    Subject: r.batch_subject || null, SenderEmail: r.batch_sender_email || null, ReceivedAt: r.batch_received_at || null,
  };
}
const EXPENSE_SELECT = `
  SELECT e.*, ec.name AS category_name, f.name AS fund_name,
         jl.title AS job_line_title, wo.title AS work_order_title, a.name AS asset_name,
         b.subject AS batch_subject, b.sender_email AS batch_sender_email, b.received_at AS batch_received_at
  FROM expenses e
  LEFT JOIN expense_categories ec ON ec.id = e.category_id
  LEFT JOIN funds f ON f.id = e.fund_id
  LEFT JOIN job_lines jl ON jl.id = e.job_line_id
  LEFT JOIN work_orders wo ON wo.id = e.work_order_id
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

export async function listExpenses({ fundId, categoryId, vendor, jobLineId, workOrderId, assetId, dateFrom, dateTo, taxChargedInError, unclassified } = {}) {
  const clauses = [`e.triage_status != 'void'`, 'e.deleted_at IS NULL'];
  const params = [];
  const add = (clause, val) => { params.push(val); clauses.push(clause.replace('$N', `$${params.length}`)); };
  if (fundId) add('e.fund_id = $N', Number(fundId));
  if (categoryId) add('e.category_id = $N', Number(categoryId));
  if (vendor) add('e.vendor ILIKE $N', `%${vendor}%`);
  if (jobLineId) add('e.job_line_id = $N', Number(jobLineId));
  if (workOrderId) add('e.work_order_id = $N', Number(workOrderId));
  if (assetId) add('e.asset_id = $N', Number(assetId));
  if (dateFrom) add('e.purchase_date >= $N', dateFrom);
  if (dateTo) add('e.purchase_date <= $N', dateTo);
  if (taxChargedInError) clauses.push('e.tax_charged_in_error = true');
  if (unclassified) clauses.push('(e.fund_id IS NULL OR e.category_id IS NULL)');
  const { rows } = await pool.query(`${EXPENSE_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY e.purchase_date DESC NULLS LAST, e.created_at DESC`, params);
  return rows.map(expenseRowToApi);
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
  vendor, amount, purchaseDate, taxAmount, taxChargedInError, categoryId, fundId, jobLineId, workOrderId, assetId, notes, createdBy,
}) {
  const resolvedFundId = await inheritedFundId(jobLineId, fundId);
  const { rows } = await pool.query(
    `INSERT INTO expenses (vendor, amount, purchase_date, tax_amount, tax_charged_in_error, category_id, fund_id, job_line_id, work_order_id, asset_id, notes, triage_status, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'triaged','manual',$12) RETURNING id`,
    [vendor || null, amount ?? null, purchaseDate || null, taxAmount ?? null, !!taxChargedInError, categoryId || null,
      resolvedFundId ?? null, jobLineId || null, workOrderId || null, assetId || null, notes || null, createdBy || null]
  );
  await logActivity({ action: 'created', entityType: 'expense', entityId: rows[0].id, entityLabel: vendor || 'Expense' });
  return getExpense(rows[0].id);
}

const EXPENSE_UPDATE_COLUMNS = {
  vendor: 'vendor', amount: 'amount', purchaseDate: 'purchase_date', taxAmount: 'tax_amount',
  taxChargedInError: 'tax_charged_in_error', categoryId: 'category_id', jobLineId: 'job_line_id',
  workOrderId: 'work_order_id', assetId: 'asset_id', notes: 'notes',
};
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

export async function getExpensesReportRawData() {
  const { rows } = await pool.query(`
    SELECT e.*, ec.name AS category_name, f.name AS fund_name,
           jl.title AS job_line_title, wo.title AS work_order_title, wo.wo_number,
           a.name AS asset_name, l.name AS location_name,
           (SELECT count(*) FROM attachment_links al WHERE al.entity_type = 'expense' AND al.entity_id = e.id) AS receipt_count
    FROM expenses e
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    LEFT JOIN funds f ON f.id = e.fund_id
    LEFT JOIN job_lines jl ON jl.id = e.job_line_id
    LEFT JOIN work_orders wo ON wo.id = e.work_order_id
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
    SELECT b.id, b.subject, b.body_text, b.sender_email, b.received_at,
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
  return rows.map((r) => ({ Id: r.id, Subject: r.subject, BodyText: r.body_text, SenderEmail: r.sender_email, ReceivedAt: r.received_at, Attachments: r.attachments }));
}

// Dashboard badge (§5.3) — "the failure mode is a junk drawer of 400
// untriaged photos; the badge is the only thing preventing it."
export async function getInboxCount() {
  const { rows } = await pool.query(`SELECT count(*) FROM attachments WHERE triage_status = 'inbox' AND deleted_at IS NULL`);
  return Number(rows[0].count);
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
  // actual-or-estimated-per-line convention as getBudgetOverview (see its
  // header comment), computed directly from job_lines so a WO with a mix of
  // actualed and not-yet-actualed lines contributes both correctly instead
  // of the all-or-nothing WO-level fallback above.
  const { rows: costRows } = await pool.query(
    `SELECT COALESCE(SUM(COALESCE(jl.actual_cost, jl.estimated_cost, 0)), 0) AS cost
     FROM job_lines jl JOIN work_orders w ON w.id = jl.work_order_id WHERE w.split_root_id = $1`,
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
    JobLineId: r.job_line_id, JobLineTitle: r.job_line_title,
    WorkOrderTemplateId: r.work_order_template_id,
  };
}

// Expands recurring events into their occurrence dates within [fromDate, toDate]
// (YYYY-MM-DD strings). Each returned entry is one occurrence, tagged with its
// concrete Date so the calendar can place it on the right day.
//
// A PM-template-linked event has no static work_order_id of its own — each
// occurrence gets its own generated Work Order once due (see
// generateDueWorkOrdersForRange), so occurrences are joined against
// calendar_event_generated_wo and WorkOrderId/WorkOrderTitle are overridden
// per-occurrence when one has been generated. This means the existing
// WorkOrderId-based "View Linked Work Order" UI keeps working unchanged
// instead of a occurrence showing as a phantom entry with no real WO.
export async function listCalendarEventOccurrences(fromDate, toDate) {
  const { rows } = await pool.query(
    `SELECT e.*, w.title AS wo_title, jl.title AS job_line_title FROM calendar_events e
     LEFT JOIN work_orders w ON w.id = e.work_order_id
     LEFT JOIN job_lines jl ON jl.id = e.job_line_id
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
    for (const occDate of expandRecurrence(row, rangeStart, rangeEnd)) {
      const occStr = occDate.toISOString().slice(0, 10);
      const gen = genByKey.get(`${row.id}:${occStr}`);
      out.push({
        ...shaped,
        OccurrenceDate: occStr,
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
    `SELECT jl.id, jl.title, jl.scheduled_date, jl.work_order_id,
            w.title AS wo_title, ws.name AS wo_status, ws.color AS wo_status_color, w.priority,
            a.id AS asset_id, a.name AS asset_name
     FROM job_lines jl
     JOIN work_orders w ON w.id = jl.work_order_id
     JOIN work_order_statuses ws ON ws.id = w.status_id
     LEFT JOIN assets a ON a.id = w.asset_id
     WHERE jl.scheduled_date BETWEEN $1 AND $2
     ORDER BY jl.scheduled_date`,
    [fromDate, toDate]
  );
  return rows.map((r) => ({
    JobLineId: r.id, JobLineTitle: r.title, ScheduledDate: r.scheduled_date,
    WorkOrderId: r.work_order_id, WorkOrderTitle: r.wo_title, WorkOrderStatus: r.wo_status, WorkOrderStatusColor: r.wo_status_color, Priority: r.priority,
    Asset: r.asset_id ? { Id: r.asset_id, Name: r.asset_name } : null,
  }));
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
  const { rows } = await pool.query(
    `SELECT e.*, w.title AS wo_title, jl.title AS job_line_title FROM calendar_events e
     LEFT JOIN work_orders w ON w.id = e.work_order_id
     LEFT JOIN job_lines jl ON jl.id = e.job_line_id
     WHERE e.id = $1`,
    [id]
  );
  return rows[0] ? calendarEventRowShape(rows[0]) : null;
}

export async function createCalendarEvent({ title, description, eventDate, recurrenceType, recurrenceInterval, recurrenceEndDate, workOrderId, jobLineId, workOrderTemplateId }) {
  const { rows } = await pool.query(
    `INSERT INTO calendar_events (title, description, event_date, recurrence_type, recurrence_interval, recurrence_end_date, work_order_id, job_line_id, work_order_template_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [title, description || null, eventDate, recurrenceType || 'none', recurrenceInterval || 1, recurrenceEndDate || null, workOrderId || null, jobLineId || null, workOrderTemplateId || null]
  );
  await logActivity({ action: 'created', entityType: 'calendar_event', entityId: rows[0].id, entityLabel: rows[0].title });
  return calendarEventRowShape(rows[0]);
}

export async function updateCalendarEvent(id, fields) {
  const allowed = ['title', 'description', 'event_date', 'recurrence_type', 'recurrence_interval', 'recurrence_end_date', 'work_order_id', 'job_line_id', 'work_order_template_id'];
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
