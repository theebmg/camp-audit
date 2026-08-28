// Postgres-backed mirror of reportData.js's buildCapitalPlan. Kept as a separate
// module (rather than editing reportData.js) so the live NocoDB-backed app is
// never touched by this migration — see the brief's "build alongside, don't
// break the current one" rule. Reuses currentComponentState() from
// components.js UNCHANGED, so "what counts as current" stays defined once,
// regardless of which database it reads from.
import { getAllComponentRowsWithAssetInfo } from './db.js';
import { currentComponentState } from './components.js';

function replacementBucket(estYear) {
  if (estYear == null) return 'Unknown';
  const yearsAway = estYear - new Date().getFullYear();
  if (yearsAway < 0) return 'Overdue';
  if (yearsAway <= 2) return '0–2 yrs';
  if (yearsAway <= 5) return '3–5 yrs';
  return '5+ yrs';
}

export async function buildCapitalPlanPg({ componentType, condition } = {}) {
  const { componentRows, assetById } = await getAllComponentRowsWithAssetInfo();

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
