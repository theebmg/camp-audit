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

// ── Locations / Assets (read) ───────────────────────────────────────────

export async function listLocations() {
  const { rows } = await pool.query('SELECT id, name, location_type FROM locations ORDER BY name');
  return rows.map((r) => ({ Id: r.id, Name: r.name, 'Location Type': r.location_type }));
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

export async function getAssetHistory(assetId) {
  const [assetRow, componentRows] = await Promise.all([getAssetRow(assetId), getComponentRowsForAsset(assetId)]);
  return { asset: assetRow ? assetRowToNocoShape(assetRow) : null, componentRows };
}

// ── Audit submit (write): one transaction — UPDATE property columns, INSERT
//    component events, optionally INSERT a linked finding ──────────────────

export async function submitAudit(assetId, { properties = {}, componentEvents = [], finding = null }) {
  const propertyFields = await getAssetPropertyFields();
  const byKey = new Map(propertyFields.map((f) => [f.fieldKey, f]));
  // properties keyed by fieldKey (e.g. "has_key") — see route for the label->key mapping.
  const setCols = [];
  const setVals = [];
  const eavUpdates = []; // fields with no real column — go to asset_property_values instead
  let i = 1;
  for (const [key, value] of Object.entries(properties)) {
    const field = byKey.get(key);
    if (!field) continue; // ignore anything that isn't a live property field
    if (field.options && !field.multi && !field.options.includes(value)) continue;
    if (field.columnName) {
      setCols.push(`${field.columnName} = $${i++}`);
      setVals.push(value);
    } else {
      eavUpdates.push([key, value]);
    }
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
    }

    let createdFinding = null;
    if (finding && finding.description && finding.severity) {
      const { rows } = await client.query(
        `INSERT INTO condition_findings (asset_id, title, severity, description, recommended_repair,
           estimated_hours, estimated_cost, status, date_identified, photo_urls)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Open',$8,$9) RETURNING *`,
        [assetId, finding.title || `Finding on Asset #${assetId}`, finding.severity, finding.description,
          finding.recommendedRepair || null, finding.estimatedHours ?? null, finding.estimatedCost ?? null, today,
          finding.photoUrls || []]
      );
      createdFinding = rows[0];
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
  return rows[0];
}

export async function resolveAssetNote(noteId, resolved = true) {
  const { rows } = await pool.query(
    `UPDATE asset_notes SET resolved = $1 WHERE id = $2 RETURNING *`,
    [resolved, noteId]
  );
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
  return getAssetDetail(assetId);
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
  return rows[0] || null;
}

export async function adminCreateBuildingType(name) {
  const { rows } = await pool.query('INSERT INTO building_types (name) VALUES ($1) RETURNING *', [name]);
  return rows[0];
}

export async function adminDeleteBuildingType(id) {
  const inUse = await pool.query('SELECT count(*) FROM assets WHERE building_type_id = $1', [id]);
  if (Number(inUse.rows[0].count) > 0) {
    const err = new Error(`${inUse.rows[0].count} asset(s) still use this building type — reassign them first`);
    err.status = 400;
    throw err;
  }
  await pool.query('DELETE FROM building_types WHERE id = $1', [id]);
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
  return rows[0];
}

export async function adminDeleteSubArea(id) {
  await pool.query('DELETE FROM component_sub_areas WHERE id = $1', [id]);
}

// ── Work Orders + Asset Updates write-back (brief's Phase 2) ───────────────

export async function listWorkOrders() {
  const { rows } = await pool.query(
    `SELECT w.id, w.title, w.status, w.priority, w.date_reported, w.date_completed,
            w.asset_id, a.name AS asset_name, w.location_id, l.name AS location_name
     FROM work_orders w
     LEFT JOIN assets a ON a.id = w.asset_id
     LEFT JOIN locations l ON l.id = w.location_id
     ORDER BY w.id DESC`
  );
  return rows.map((r) => ({
    Id: r.id, Title: r.title, Status: r.status, Priority: r.priority,
    'Date Reported': r.date_reported, 'Date Completed': r.date_completed,
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
    `SELECT w.*, a.name AS asset_name, l.name AS location_name FROM work_orders w
     LEFT JOIN assets a ON a.id = w.asset_id LEFT JOIN locations l ON l.id = w.location_id
     WHERE w.id = $1`,
    [woId]
  );
  const w = rows[0];
  if (!w) return null;
  const [assetUpdates, assignees] = await Promise.all([getAssetUpdatesForWorkOrder(woId), getWorkOrderAssignees(woId)]);
  return {
    workOrder: {
      Id: w.id, Title: w.title, Status: w.status, Priority: w.priority,
      'Date Reported': w.date_reported, 'Date Completed': w.date_completed,
      'Estimated Hours': w.estimated_hours, 'Actual Hours': w.actual_hours,
      'Estimated Cost': w.estimated_cost, 'Actual Cost': w.actual_cost,
      Description: w.description,
      Asset: w.asset_id ? { Id: w.asset_id, Name: w.asset_name } : null,
      Location: w.location_id ? { Id: w.location_id, Name: w.location_name } : null,
    },
    assetUpdates,
    ...assignees,
  };
}

const today = () => new Date().toISOString().slice(0, 10);

export async function createWorkOrder({ title, assetId, locationId, priority, description, assetUpdates = [] }) {
  const propertyFields = await getAssetPropertyFields();
  const byLabel = new Map(propertyFields.map((f) => [f.title, f]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO work_orders (title, asset_id, location_id, priority, status, description, date_reported)
       VALUES ($1,$2,$3,$4,'Open',$5,$6) RETURNING id`,
      [title, assetId || null, locationId || null, priority || 'Medium', description || null, today()]
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
    await client.query('COMMIT');
    return { workOrderId: woId, assetUpdates: created };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function updateWorkOrder(woId, fields) {
  const allowed = ['title', 'description', 'priority', 'status', 'date_reported', 'date_completed', 'estimated_hours', 'actual_hours', 'estimated_cost', 'actual_cost'];
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
  return getWorkOrderDetail(woId);
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
  return rows[0];
}

export async function deleteAssetUpdate(auId) {
  const { rows } = await pool.query('SELECT applied FROM asset_updates WHERE id = $1', [auId]);
  if (!rows[0]) return { notFound: true };
  if (rows[0].applied) return { alreadyApplied: true };
  await pool.query('DELETE FROM asset_updates WHERE id = $1', [auId]);
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
  return volunteerRowShape(rows[0]);
}
export async function updateVolunteer(id, { name, phone, email, address, skill }) {
  const { rows } = await pool.query(
    `UPDATE volunteers SET name = COALESCE($2,name), phone = COALESCE($3,phone), email = COALESCE($4,email),
       address = COALESCE($5,address), skill = COALESCE($6, skill)
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, phone ?? null, email ?? null, address ?? null, skill ?? null]
  );
  return rows[0] ? volunteerRowShape(rows[0]) : null;
}
// Hard-deletes only if never assigned to a Work Order (mirrors
// adminDeleteBuildingType's block-if-in-use pattern); otherwise deactivates
// so WO assignment history isn't silently lost.
export async function removeVolunteer(id) {
  const used = await pool.query('SELECT count(*) FROM work_order_volunteers WHERE volunteer_id = $1', [id]);
  if (Number(used.rows[0].count) > 0) {
    await pool.query('UPDATE volunteers SET active = false WHERE id = $1', [id]);
    return { deactivated: true };
  }
  await pool.query('DELETE FROM volunteers WHERE id = $1', [id]);
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
  return vendorRowShape(rows[0]);
}
export async function updateVendor(id, { name, phone, email, address, specialty }) {
  const { rows } = await pool.query(
    `UPDATE vendors SET name = COALESCE($2,name), phone = COALESCE($3,phone), email = COALESCE($4,email),
       address = COALESCE($5,address), specialty = COALESCE($6, specialty)
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, phone ?? null, email ?? null, address ?? null, specialty ?? null]
  );
  return rows[0] ? vendorRowShape(rows[0]) : null;
}
export async function removeVendor(id) {
  const used = await pool.query('SELECT count(*) FROM work_order_vendors WHERE vendor_id = $1', [id]);
  if (Number(used.rows[0].count) > 0) {
    await pool.query('UPDATE vendors SET active = false WHERE id = $1', [id]);
    return { deactivated: true };
  }
  await pool.query('DELETE FROM vendors WHERE id = $1', [id]);
  return { deleted: true };
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
  return { Id: r.id, Name: r.name, assetType: r.asset_type, locationId: r.location_id, locationName: null };
}
