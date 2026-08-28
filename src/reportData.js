// Shared report-building logic: pulls from NocoDB, returns plain data. Used by
// both the existing /api/activity + /api/capital-plan endpoints and the new
// /api/reports/* endpoints, so "what counts as recent activity" / "what counts as
// the capital plan" is defined in exactly one place.
import { listRecords, TABLES } from './nocodb.js';
import { currentComponentState } from './components.js';

export async function buildActivity({ from, to, limit = 500 } = {}) {
  const [components, findings, workOrders] = await Promise.all([
    listRecords(TABLES.assetComponents, { limit: 2000, fields: 'Id,CreatedAt,Component Type,Event Type,Condition,Material,Notes,Asset' }),
    listRecords(TABLES.conditionFindings, { limit: 2000, fields: 'Id,CreatedAt,Title,Severity,Description,Asset' }),
    listRecords(TABLES.workOrders, { limit: 2000, fields: 'Id,CreatedAt,Title,Status,Priority,Description,Asset' }),
  ]);

  let entries = [
    ...components.map((c) => ({
      kind: 'component',
      at: c.CreatedAt,
      title: `${c['Event Type'] || 'Logged'}: ${c['Component Type'] || 'Component'}`,
      detail: [c.Material, c.Condition].filter(Boolean).join(' · '),
      notes: c.Notes || '',
      assetId: c.Asset?.Id ?? null,
      assetName: c.Asset?.Name ?? null,
    })),
    ...findings.map((f) => ({
      kind: 'finding',
      at: f.CreatedAt,
      title: f.Title || 'Finding',
      detail: f.Severity || '',
      notes: f.Description || '',
      assetId: f.Asset?.Id ?? null,
      assetName: f.Asset?.Name ?? null,
    })),
    ...workOrders.map((w) => ({
      kind: 'workorder',
      at: w.CreatedAt,
      title: w.Title,
      detail: [w.Priority, w.Status].filter(Boolean).join(' · '),
      notes: w.Description || '',
      assetId: w.Asset?.Id ?? null,
      assetName: w.Asset?.Name ?? null,
      woId: w.Id,
    })),
  ];

  if (from) entries = entries.filter((e) => (e.at || '') >= from);
  if (to) entries = entries.filter((e) => (e.at || '') <= `${to}z`); // date-only `to` should include that whole day

  entries.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return entries.slice(0, limit);
}

function replacementBucket(estYear) {
  if (estYear == null) return 'Unknown';
  const yearsAway = estYear - new Date().getFullYear();
  if (yearsAway < 0) return 'Overdue';
  if (yearsAway <= 2) return '0–2 yrs';
  if (yearsAway <= 5) return '3–5 yrs';
  return '5+ yrs';
}

export async function buildCapitalPlan({ componentType, condition } = {}) {
  const [componentRows, assets] = await Promise.all([
    listRecords(TABLES.assetComponents, {
      limit: 5000,
      fields: 'Id,Component Type,Event Type,Material,Condition,Observed/Installed Date,Est Life (years),Est Replacement Year,Est Replacement Cost,Asset',
    }),
    listRecords(TABLES.assets, { limit: 1000, fields: 'Id,Name,Location' }),
  ]);
  const assetById = new Map(assets.map((a) => [a.Id, a]));

  const byAsset = new Map();
  for (const row of componentRows) {
    const assetId = row.Asset?.Id;
    if (!assetId) continue;
    if (!byAsset.has(assetId)) byAsset.set(assetId, []);
    byAsset.get(assetId).push(row);
  }

  let rows = [];
  for (const [assetId, rowsForAsset] of byAsset) {
    const asset = assetById.get(assetId);
    const current = currentComponentState(rowsForAsset);
    for (const [type, state] of Object.entries(current)) {
      rows.push({
        assetId,
        assetName: asset?.Name || `#${assetId}`,
        locationName: asset?.Location?.Name || null,
        componentType: type,
        condition: state.condition,
        conditionDate: state.conditionDate,
        material: state.material,
        installedDate: state.installedDate,
        estLifeYears: state.estLifeYears,
        estReplacementYear: state.estReplacementYear,
        estReplacementCost: state.estReplacementCost,
        bucket: replacementBucket(state.estReplacementYear),
      });
    }
  }

  if (componentType) rows = rows.filter((r) => r.componentType === componentType);
  if (condition) rows = rows.filter((r) => r.condition === condition);

  rows.sort((a, b) => (a.estReplacementYear ?? Infinity) - (b.estReplacementYear ?? Infinity));

  const bucketOrder = ['Overdue', '0–2 yrs', '3–5 yrs', '5+ yrs', 'Unknown'];
  const summary = bucketOrder.map((bucket) => {
    const inBucket = rows.filter((r) => r.bucket === bucket);
    return {
      bucket,
      count: inBucket.length,
      totalCost: inBucket.reduce((sum, r) => sum + (r.estReplacementCost || 0), 0),
    };
  });

  return { rows, summary };
}
