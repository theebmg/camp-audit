// Postgres-backed mirror of reportData.js's buildCapitalPlan. Kept as a separate
// module (rather than editing reportData.js) so the live NocoDB-backed app is
// never touched by this migration — see the brief's "build alongside, don't
// break the current one" rule. Reuses currentComponentState() from
// components.js UNCHANGED, so "what counts as current" stays defined once,
// regardless of which database it reads from.
import {
  getAllComponentRowsWithAssetInfo, getBoardReportRawData, getBoardFocusItems, historicalAvgActualCost,
  getWorkPerformedRawData, getDeferredFindingsBacklogRawData,
} from './db.js';
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
// Open-WO counts/funding totals are a live snapshot ("where things stand
// right now"), grouped by job line since Phase 1 moved cost/funding there —
// a WO with lines from two funding sources contributes to both totals, which
// is correct: that WO's money really does come from two places.
// "Completed This Period" sums each WO's lines' costs and lists every
// funding source that touched it. "Upcoming"/"Overdue" list job lines, not
// work orders — see getBoardReportRawData's comment for why.
export async function buildBoardReportPg({ periodStart, periodEnd } = {}) {
  const todayStr = today();
  const start = periodStart || `${todayStr.slice(0, 7)}-01`;
  const end = periodEnd || todayStr;

  const { openStatusRows, openFundingRows, completedRows, upcomingRows, overdueRows } = await getBoardReportRawData({ periodStart: start, periodEnd: end, todayStr });

  const statusCounts = new Map();
  const priorityCounts = new Map();
  for (const r of openStatusRows) {
    statusCounts.set(r.status, (statusCounts.get(r.status) || 0) + 1);
    priorityCounts.set(r.priority, (priorityCounts.get(r.priority) || 0) + 1);
  }
  const fundingTotals = new Map();
  for (const r of openFundingRows) {
    const key = r.funding_source || 'unspecified';
    fundingTotals.set(key, (fundingTotals.get(key) || 0) + Number(r.cost));
  }

  const rowShape = (r) => ({
    id: r.job_line_id, workOrderId: r.work_order_id, title: r.wo_title, jobLineTitle: r.job_line_title,
    scheduledDate: r.scheduled_date, priority: r.priority, assetName: r.asset_name,
  });

  return {
    periodStart: start, periodEnd: end,
    statusCounts: [...statusCounts.entries()].map(([status, count]) => ({ status, count })),
    priorityCounts: [...priorityCounts.entries()].map(([priority, count]) => ({ priority, count })),
    fundingSourceTotals: [...fundingTotals.entries()].map(([fundingSource, total]) => ({
      fundingSource, label: FUNDING_SOURCE_LABELS[fundingSource] || fundingSource, total,
    })),
    completed: completedRows.map((r) => ({
      id: r.id, title: r.title, dateCompleted: r.date_completed, assetName: r.asset_name,
      cost: Number(r.actual_cost ?? r.estimated_cost ?? 0),
      fundingSource: (r.funding_sources || []).map((s) => FUNDING_SOURCE_LABELS[s] || s).join(', ') || null,
    })),
    upcoming: upcomingRows.map(rowShape),
    overdue: overdueRows.map(rowShape),
  };
}

// Board-flagged Work Orders + Condition Findings, cost-sorted. A one-off
// item shows its estimated_cost as-is; a PM-recurring Work Order (one
// generated from a template-linked Calendar Event) shows the historical
// average actual cost of past instances instead, when there is one —
// grounded in reality rather than a possibly-stale estimate.
export async function buildForwardFocusReportPg() {
  const { workOrders, conditionFindings } = await getBoardFocusItems();

  const items = [];
  for (const w of workOrders) {
    let cost = w.estimated_cost != null ? Number(w.estimated_cost) : null;
    let costBasis = 'estimated';
    if (w.work_order_template_id) {
      const avg = await historicalAvgActualCost(w.work_order_template_id);
      if (avg != null) { cost = avg; costBasis = 'historical average'; }
    }
    items.push({ kind: 'workOrder', id: w.id, title: w.title, assetName: w.asset_name, priority: w.priority, status: w.status, cost, costBasis });
  }
  for (const cf of conditionFindings) {
    items.push({
      kind: 'conditionFinding', id: cf.id, title: cf.title, assetName: cf.asset_name, priority: cf.severity, status: cf.status,
      cost: cf.estimated_cost != null ? Number(cf.estimated_cost) : null, costBasis: 'estimated',
    });
  }
  items.sort((a, b) => (b.cost ?? -Infinity) - (a.cost ?? -Infinity));
  const total = items.reduce((sum, i) => sum + (i.cost || 0), 0);
  return { items, total };
}

// Build Brief v2 Phase 6 (§6.2.1) — grouped by building (Location), with
// each building's total cost/hours and its lines' embedded After photos.
// Every line shows regardless of its parent WO's status — see
// getWorkPerformedRawData's comment for why that's the whole point.
export async function buildWorkPerformedReportPg({ from, to }) {
  const { lines, imagesByWo } = await getWorkPerformedRawData({ from, to });

  const byLocation = new Map();
  for (const l of lines) {
    const key = l.location_name || 'Unassigned';
    if (!byLocation.has(key)) byLocation.set(key, []);
    byLocation.get(key).push({
      id: l.id, title: l.title, correction: l.correction, completedDate: l.completed_date,
      cost: Number(l.actual_cost ?? l.estimated_cost ?? 0), hours: Number(l.actual_hours ?? 0),
      workOrderId: l.work_order_id, woNumber: l.wo_number, woTitle: l.wo_title, assetName: l.asset_name,
      images: imagesByWo.get(l.work_order_id) || [],
    });
  }
  const buildings = [...byLocation.entries()].map(([location, lineItems]) => ({
    location, lines: lineItems,
    totalCost: lineItems.reduce((s, i) => s + i.cost, 0),
    totalHours: lineItems.reduce((s, i) => s + i.hours, 0),
  })).sort((a, b) => a.location.localeCompare(b.location));

  return {
    from, to, buildings,
    totalLines: lines.length,
    totalCost: buildings.reduce((s, b) => s + b.totalCost, 0),
    totalHours: buildings.reduce((s, b) => s + b.totalHours, 0),
  };
}

// Build Brief v2 Phase 6 (§6.2.2) — "the single most useful artifact this
// system produces." Grouped by severity (worst first), each group's dollar
// total is the capital-campaign argument.
export async function buildDeferredBacklogReportPg() {
  const { findings } = await getDeferredFindingsBacklogRawData();
  const bySeverity = new Map();
  for (const f of findings) {
    const key = f.severity || 'Unspecified';
    if (!bySeverity.has(key)) bySeverity.set(key, []);
    bySeverity.get(key).push({
      id: f.id, title: f.title, assetName: f.asset_name, locationName: f.location_name,
      cost: f.estimated_cost != null ? Number(f.estimated_cost) : null,
      deferredReason: f.deferred_reason, revisitDate: f.revisit_date,
    });
  }
  // condition_findings.severity is free text like "5 - Safety-Critical" —
  // sorting descending puts the highest number (most severe) first without
  // needing a hardcoded severity order table.
  const groups = [...bySeverity.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([severity, items]) => ({
    severity, items, totalCost: items.reduce((s, i) => s + (i.cost || 0), 0),
  }));
  return { groups, totalCost: groups.reduce((s, g) => s + g.totalCost, 0), totalCount: findings.length };
}
