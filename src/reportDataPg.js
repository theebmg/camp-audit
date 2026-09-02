// Postgres-backed mirror of reportData.js's buildCapitalPlan. Kept as a separate
// module (rather than editing reportData.js) so the live NocoDB-backed app is
// never touched by this migration — see the brief's "build alongside, don't
// break the current one" rule. Reuses currentComponentState() from
// components.js UNCHANGED, so "what counts as current" stays defined once,
// regardless of which database it reads from.
import { getAllComponentRowsWithAssetInfo, pool } from './db.js';
import { currentComponentState } from './components.js';
import { FUNDING_SOURCE_LABELS } from './reports.js';

const today = () => new Date().toISOString().slice(0, 10);

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

// Open-WO counts/funding totals are a live snapshot ("where things stand
// right now"), not scoped to the period — only "Completed This Period" uses
// [periodStart, periodEnd]. Upcoming/overdue are relative to today rather
// than periodEnd, since a board wants to see what's late right now even if
// the reporting period nominally ended earlier.
export async function buildBoardReportPg({ periodStart, periodEnd } = {}) {
  const todayStr = today();
  const start = periodStart || `${todayStr.slice(0, 7)}-01`;
  const end = periodEnd || todayStr;

  const [openRes, completedRes, upcomingRes, overdueRes] = await Promise.all([
    pool.query(`
      SELECT status, priority, funding_source, COALESCE(actual_cost, estimated_cost, 0) AS cost
      FROM work_orders WHERE status != 'Done'
    `),
    pool.query(`
      SELECT w.id, w.title, w.date_completed, w.funding_source, COALESCE(w.actual_cost, w.estimated_cost, 0) AS cost,
             a.name AS asset_name
      FROM work_orders w LEFT JOIN assets a ON a.id = w.asset_id
      WHERE w.status = 'Done' AND w.date_completed BETWEEN $1 AND $2
      ORDER BY w.date_completed DESC
    `, [start, end]),
    pool.query(`
      SELECT w.id, w.title, w.scheduled_date, w.priority, a.name AS asset_name
      FROM work_orders w LEFT JOIN assets a ON a.id = w.asset_id
      WHERE w.status != 'Done' AND w.scheduled_date >= $1
      ORDER BY w.scheduled_date ASC
    `, [todayStr]),
    pool.query(`
      SELECT w.id, w.title, w.scheduled_date, w.priority, a.name AS asset_name
      FROM work_orders w LEFT JOIN assets a ON a.id = w.asset_id
      WHERE w.status != 'Done' AND w.scheduled_date < $1
      ORDER BY w.scheduled_date ASC
    `, [todayStr]),
  ]);

  const statusCounts = new Map();
  const priorityCounts = new Map();
  const fundingTotals = new Map();
  for (const r of openRes.rows) {
    statusCounts.set(r.status, (statusCounts.get(r.status) || 0) + 1);
    priorityCounts.set(r.priority, (priorityCounts.get(r.priority) || 0) + 1);
    const key = r.funding_source || 'unspecified';
    fundingTotals.set(key, (fundingTotals.get(key) || 0) + Number(r.cost));
  }

  const rowShape = (r) => ({
    id: r.id, title: r.title, scheduledDate: r.scheduled_date, priority: r.priority, assetName: r.asset_name,
  });

  return {
    periodStart: start, periodEnd: end,
    statusCounts: [...statusCounts.entries()].map(([status, count]) => ({ status, count })),
    priorityCounts: [...priorityCounts.entries()].map(([priority, count]) => ({ priority, count })),
    fundingSourceTotals: [...fundingTotals.entries()].map(([fundingSource, total]) => ({
      fundingSource, label: FUNDING_SOURCE_LABELS[fundingSource] || fundingSource, total,
    })),
    completed: completedRes.rows.map((r) => ({
      id: r.id, title: r.title, dateCompleted: r.date_completed, assetName: r.asset_name,
      cost: Number(r.cost), fundingSource: r.funding_source,
    })),
    upcoming: upcomingRes.rows.map(rowShape),
    overdue: overdueRes.rows.map(rowShape),
  };
}
