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
  return locationRowShape(rows[0]);
}

export async function updateLocation(id, { name, parentLocationId, locationType, notes }) {
  const { rows } = await pool.query(
    `UPDATE locations SET name = $2, parent_location_id = $3, location_type = $4, notes = $5 WHERE id = $1 RETURNING *`,
    [id, name, parentLocationId || null, locationType || null, notes || null]
  );
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
    `SELECT w.id, w.title, w.status, w.priority, w.date_reported, w.date_completed, w.scheduled_date,
            w.asset_id, a.name AS asset_name, w.location_id, l.name AS location_name
     FROM work_orders w
     LEFT JOIN assets a ON a.id = w.asset_id
     LEFT JOIN locations l ON l.id = w.location_id
     ORDER BY w.id DESC`
  );
  return rows.map((r) => ({
    Id: r.id, Title: r.title, Status: r.status, Priority: r.priority,
    'Date Reported': r.date_reported, 'Date Completed': r.date_completed, 'Scheduled Date': r.scheduled_date,
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
      'Date Reported': w.date_reported, 'Date Completed': w.date_completed, 'Scheduled Date': w.scheduled_date,
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
    'scheduled_date', 'asset_id', 'estimated_hours', 'actual_hours', 'estimated_cost', 'actual_cost'];
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
  return rows[0] ? templateRowShape(rows[0]) : null;
}
export async function deleteWorkOrderTemplate(id) {
  await pool.query('DELETE FROM work_order_templates WHERE id = $1', [id]);
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
  return { Id: rows[0].id, Description: rows[0].description, Done: rows[0].done, SortOrder: rows[0].sort_order };
}
export async function updateWorkOrderTask(id, { description, done }) {
  const { rows } = await pool.query(
    'UPDATE work_order_tasks SET description = COALESCE($2,description), done = COALESCE($3,done) WHERE id = $1 RETURNING *',
    [id, description ?? null, done ?? null]
  );
  return rows[0] ? { Id: rows[0].id, Description: rows[0].description, Done: rows[0].done, SortOrder: rows[0].sort_order } : null;
}
export async function deleteWorkOrderTask(id) {
  await pool.query('DELETE FROM work_order_tasks WHERE id = $1', [id]);
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
  return rowCount ? getCalendarEvent(id) : null;
}

export async function deleteCalendarEvent(id) {
  await pool.query('DELETE FROM calendar_events WHERE id = $1', [id]);
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
  return all.find((t) => t.Id === id) || null;
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
  return all.find((t) => t.Id === Number(id)) || null;
}

export async function deleteChecklistTemplate(id) {
  await pool.query('DELETE FROM checklist_templates WHERE id = $1', [id]);
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
  await pool.query('DELETE FROM checklist_instances WHERE id = $1', [instanceId]);
}
export async function toggleChecklistStep(stepId, done) {
  const { rows } = await pool.query(
    'UPDATE checklist_instance_steps SET done = $2, done_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1 RETURNING *',
    [stepId, done]
  );
  return rows[0] || null;
}
