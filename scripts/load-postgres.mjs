// One-off: load the JSON dumped by scripts/export-nocodb.mjs into the `camp`
// Postgres database, mapping NocoDB link fields (which carry the NocoDB row Id)
// to real foreign keys via each table's `nc_id` column.
//
// Runs entirely inside ONE transaction — either everything lands or nothing does.
// Safe to re-run: it TRUNCATEs the target tables first (this only ever loads
// from the read-only NocoDB export, never the reverse, so truncating is not
// data loss — the source of truth is still NocoDB until cutover).
//
// NOTE: work_orders/vendors and work_orders/volunteers many-to-many links use a
// NocoDB "Links"-uidt column, which the list-records endpoint reports only as a
// COUNT, not the actual linked rows (see nocodb.js's getLinkFieldId comment).
// There are currently 0 vendors and 0 volunteers in NocoDB, so those junction
// tables load empty here — revisit with listLinkedRecords() if that ever
// stops being true before this script is re-run.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data-export');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), 'utf8'));
}

const multi = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const moId = (v) => (v && typeof v === 'object' ? v.Id : null);
const ts = (v) => (v ? v : null);

async function main() {
  const [locations, assets, workOrders, conditionFindings, volunteers, projects,
    assetUpdates, assetComponents, vendors] = [
    load('locations'), load('assets'), load('workOrders'), load('conditionFindings'),
    load('volunteers'), load('projects'), load('assetUpdates'), load('assetComponents'),
    load('vendors'),
  ];

  const client = await pool.connect();
  const ncToId = {}; // ncToId.locations[ncId] = pgId, etc.
  for (const t of ['locations', 'assets', 'work_orders', 'projects', 'volunteers', 'vendors']) ncToId[t] = {};

  try {
    await client.query('BEGIN');

    // Truncate in dependency order (children first) so a re-run starts clean.
    await client.query(`TRUNCATE work_order_volunteers, work_order_vendors, asset_components,
      asset_updates, condition_findings, work_orders, assets, projects, locations,
      volunteers, vendors RESTART IDENTITY CASCADE`);

    // ── locations: pass 1 (no parent yet) ──────────────────────────────
    for (const l of locations) {
      const { rows } = await client.query(
        `INSERT INTO locations (nc_id, name, location_type, sub_location_type, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6, now()), COALESCE($7,$6, now())) RETURNING id`,
        [l.Id, l.Name, l['Location Type'] || null, multi(l['Sub-Location Type']), l.Notes || null,
          ts(l.CreatedAt), ts(l.UpdatedAt)]
      );
      ncToId.locations[l.Id] = rows[0].id;
    }
    // pass 2: resolve Parent Location
    for (const l of locations) {
      const parentNc = moId(l['Parent Location']);
      if (parentNc != null) {
        await client.query('UPDATE locations SET parent_location_id = $1 WHERE id = $2',
          [ncToId.locations[parentNc], ncToId.locations[l.Id]]);
      }
    }
    console.log(`locations: ${locations.length} loaded`);

    // ── projects (depends on locations) ─────────────────────────────────
    for (const p of projects) {
      const { rows } = await client.query(
        `INSERT INTO projects (nc_id, name, status, location_id, budget, estimated_cost, actual_cost,
           target_date, description, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10, now()), COALESCE($11,$10, now())) RETURNING id`,
        [p.Id, p.Name, p.Status, ncToId.locations[moId(p.Location)] || null, p.Budget,
          p['Estimated Cost'], p['Actual Cost'], p['Target Date'], p['Description/Board Notes'],
          ts(p.CreatedAt), ts(p.UpdatedAt)]
      );
      ncToId.projects[p.Id] = rows[0].id;
    }
    console.log(`projects: ${projects.length} loaded`);

    // ── assets: pass 1 (no parent_asset_id yet; location already loaded) ─
    for (const a of assets) {
      const { rows } = await client.query(
        `INSERT INTO assets (nc_id, name, asset_type, location_id, sub_location_id, condition,
           install_build_year, notes, description, lodge_holder, has_key, key_fits_lock,
           free_standing_building, roof_material, siding_material, foundation_type,
           roof_condition, siding_condition, roof_est_life_expectancy, siding_est_life_expectancy,
           legacy_photos, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
           COALESCE($22, now()), COALESCE($23,$22, now()))
         RETURNING id`,
        [a.Id, a.Name, a['Asset type'], ncToId.locations[moId(a.Location)] || null,
          ncToId.locations[moId(a['Sub-Location'])] || null, a.Condition, a['Install/Build Year'],
          a.Notes, a.Description, a['Lodge Holder'], a['Has Key'], a['Key Fits Lock'],
          a['Free Standing Building'], a['Roof Material'], a['Siding Material'],
          multi(a['Foundation Type']), a['Roof Condition'], a['Siding Condition'],
          a['Roof Estimated Life Expectancy'], a['Siding Estimated Life Expectancy'],
          JSON.stringify(a.Photos || []), ts(a.CreatedAt), ts(a.UpdatedAt)]
      );
      ncToId.assets[a.Id] = rows[0].id;
    }
    // pass 2: resolve Parent Asset (self-referential)
    for (const a of assets) {
      const parentNc = moId(a['Parent Asset']);
      if (parentNc != null) {
        await client.query('UPDATE assets SET parent_asset_id = $1 WHERE id = $2',
          [ncToId.assets[parentNc], ncToId.assets[a.Id]]);
      }
    }
    console.log(`assets: ${assets.length} loaded`);

    // ── work_orders (depends on assets, locations, projects) ────────────
    for (const w of workOrders) {
      const { rows } = await client.query(
        `INSERT INTO work_orders (nc_id, title, asset_id, location_id, project_id, status, priority,
           date_reported, date_completed, estimated_hours, actual_hours, estimated_cost, actual_cost,
           description, legacy_photos, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, COALESCE($16, now()), COALESCE($17,$16, now()))
         RETURNING id`,
        [w.Id, w.Title, ncToId.assets[moId(w.Asset)] || null, ncToId.locations[moId(w.Location)] || null,
          ncToId.projects[moId(w.Project)] || null, w.Status, w.Priority, w['Date Reported'],
          w['Date Completed'], w['Estimated Hours'], w['Actual Hours'], w['Estimated Cost'],
          w['Actual Cost'], w.Description, JSON.stringify(w.Photos || []), ts(w.CreatedAt), ts(w.UpdatedAt)]
      );
      ncToId.work_orders[w.Id] = rows[0].id;
    }
    console.log(`work_orders: ${workOrders.length} loaded`);

    // ── condition_findings (depends on assets, locations, work_orders, projects)
    for (const c of conditionFindings) {
      await client.query(
        `INSERT INTO condition_findings (nc_id, title, asset_id, location_id, system, severity,
           description, recommended_repair, estimated_hours, estimated_cost, status, date_identified,
           work_order_id, project_id, legacy_photos, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, COALESCE($16, now()), COALESCE($17,$16, now()))`,
        [c.Id, c.Title, ncToId.assets[moId(c.Asset)] || null, ncToId.locations[moId(c.Location)] || null,
          c.System, c.Severity, c.Description, c['Recommended Repair'], c['Estimated Hours'],
          c['Estimated Cost'], c.Status, c['Date Identified'], ncToId.work_orders[moId(c['Work Order'])] || null,
          ncToId.projects[moId(c.Project)] || null, JSON.stringify(c.Photos || []), ts(c.CreatedAt), ts(c.UpdatedAt)]
      );
    }
    console.log(`condition_findings: ${conditionFindings.length} loaded`);

    // ── asset_updates (depends on work_orders) ───────────────────────────
    for (const u of assetUpdates) {
      const woNc = moId(u['Work Order']);
      const woId = woNc != null ? ncToId.work_orders[woNc] : null;
      if (woId == null) {
        console.warn(`  skip asset_update nc_id=${u.Id}: no Work Order link (asset_updates.work_order_id is NOT NULL)`);
        continue;
      }
      await client.query(
        `INSERT INTO asset_updates (nc_id, work_order_id, target_field, new_value, applied, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6, now()), COALESCE($7,$6, now()))`,
        [u.Id, woId, u['Target Field'], u['New Value'], !!u.Applied, ts(u.CreatedAt), ts(u.UpdatedAt)]
      );
    }
    console.log(`asset_updates: ${assetUpdates.length} in export`);

    // ── asset_components (depends on assets, work_orders) ────────────────
    for (const e of assetComponents) {
      const assetNc = moId(e.Asset);
      const assetId = assetNc != null ? ncToId.assets[assetNc] : null;
      if (assetId == null) {
        console.warn(`  skip asset_component nc_id=${e.Id}: no Asset link (asset_components.asset_id is NOT NULL)`);
        continue;
      }
      await client.query(
        `INSERT INTO asset_components (nc_id, asset_id, component_type, event_type, material, condition,
           observed_installed_date, est_life_years, est_replacement_year, est_replacement_cost, notes,
           work_order_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE($13, now()), COALESCE($14,$13, now()))`,
        [e.Id, assetId, e['Component Type'], e['Event Type'], e.Material, e.Condition,
          e['Observed/Installed Date'], e['Est Life (years)'], e['Est Replacement Year'],
          e['Est Replacement Cost'], e.Notes, ncToId.work_orders[moId(e['Work Order'])] || null,
          ts(e.CreatedAt), ts(e.UpdatedAt)]
      );
    }
    console.log(`asset_components: ${assetComponents.length} loaded`);

    // ── volunteers / vendors (no dependencies) ───────────────────────────
    for (const v of volunteers) {
      const { rows } = await client.query(
        `INSERT INTO volunteers (nc_id, name, phone, email, skill, active, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, now()), COALESCE($9,$8, now())) RETURNING id`,
        [v.Id, v.Name, v['Phone Number'], v.Email, multi(v.Skill), v.Active !== false, v.Notes,
          ts(v.CreatedAt), ts(v.UpdatedAt)]
      );
      ncToId.volunteers[v.Id] = rows[0].id;
    }
    for (const v of vendors) {
      const { rows } = await client.query(
        `INSERT INTO vendors (nc_id, name, phone, email, specialty, active, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, now()), COALESCE($9,$8, now())) RETURNING id`,
        [v.Id, v.Name, v['Phone Number'], v.Email, multi(v.Specialty), v.Active !== false, v.Notes,
          ts(v.CreatedAt), ts(v.UpdatedAt)]
      );
      ncToId.vendors[v.Id] = rows[0].id;
    }
    console.log(`volunteers: ${volunteers.length} loaded, vendors: ${vendors.length} loaded`);
    if (volunteers.length === 0 && vendors.length === 0) {
      console.log('  (work_order_volunteers / work_order_vendors left empty — see file header note)');
    }

    await client.query('COMMIT');
    console.log('\nCommitted.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ROLLED BACK:', e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
