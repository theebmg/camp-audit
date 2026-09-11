// Reports v1: pure row-shaping/filter/CSV logic for the Assets + Work Orders
// export tab. No DB access here on purpose (db.js's getAssetsReportRawData /
// getWorkOrdersReportRawData fetch the raw data) — same separation as
// components.js's currentComponentState, so this stays testable and the
// "what does a report row look like" question lives in exactly one place.
import { currentComponentState } from './components.js';

// Work order/job line status is a real admin-editable catalog now (Phase 2)
// — WORK_ORDER_COLUMN_SPECS deliberately omits a fixed `options` list for
// Status/Status Change below so columnDefsFromRows() derives the filter's
// checkbox list from whatever status names actually appear in the report
// rows, instead of a hardcoded array going stale the moment someone adds or
// renames a status in Admin. Priority and funding source are still fixed —
// neither is an admin-editable table (see the brief: funding_source stays a
// CHECK enum, priority was never part of this rework).
export const WO_PRIORITY_OPTIONS = ['Low', 'Medium', 'High', 'Urgent'];
// 'fund' added Build Brief v3 Part 1 — see migration 0053's header comment
// for why job_lines.funding_source needed a fifth value.
export const FUNDING_SOURCE_LABELS = {
  operating_budget: 'Operating Budget', capital_campaign: 'Capital Campaign', cabin_holder: 'Cabin-Holder', other: 'Other', fund: 'Fund',
};

export function buildAssetReportRows({ assets, propertyFields, eavByAsset, componentRowsByAsset, flagsByAsset }, componentTypeOptions) {
  return assets.map((a) => {
    const row = {
      'Asset Name': a.name, Location: a.location_name, 'Building Type': a.building_type_name,
      'Cabin/Lodge Holder': a.lodge_holder,
    };
    for (const f of propertyFields) {
      const v = f.columnName ? a[f.columnName] : eavByAsset.get(a.id)?.get(f.fieldKey);
      row[f.title] = v ?? null;
    }
    const current = currentComponentState(componentRowsByAsset.get(a.id) || []);
    for (const type of componentTypeOptions) {
      const s = current[type];
      row[`${type} Condition`] = s?.condition ?? null;
      row[`${type} Material`] = s?.material ?? null;
      row[`${type} Install Date`] = s?.installedDate ?? null;
    }
    const flags = [...(flagsByAsset.get(a.id) || [])];
    row.Flagged = flags.length ? 'Yes' : 'No';
    row['Flagged Fields'] = flags.join(', ') || null;
    row._id = a.id;
    row._entity = 'asset';
    return row;
  });
}

// responsibility_classes/funding_sources are now arrays — a WO can have
// self+vendor lines, or lines against two different funding sources, at once
// (the whole point of job lines carrying these instead of the work order).
const RESPONSIBILITY_LABELS = { self: 'Self', volunteer: 'Volunteer', vendor: 'Vendor', cabin_holder: 'Cabin-Holder' };
export function buildWorkOrderReportRows({ workOrders, volByWo, venByWo }) {
  return workOrders.map((w) => {
    const parties = (w.responsibility_classes || []).map((c) => RESPONSIBILITY_LABELS[c] || c);
    const fundingLabels = (w.funding_sources || []).map((s) => FUNDING_SOURCE_LABELS[s] || s);
    return {
      Title: w.title, Status: w.status, Priority: w.priority,
      'Funding Source': fundingLabels.join(', ') || null,
      Asset: w.asset_name, Location: w.location_name,
      'Scheduled Date': w.scheduled_date, 'Date Reported': w.date_reported, 'Date Completed': w.date_completed,
      'Estimated Cost': w.estimated_cost, 'Actual Cost': w.actual_cost,
      'Estimated Hours': w.estimated_hours, 'Actual Hours': w.actual_hours,
      'Responsible Party': parties.join(', ') || null,
      Volunteers: (volByWo.get(w.id) || []).join(', ') || null,
      Vendors: (venByWo.get(w.id) || []).join(', ') || null,
      _id: w.id,
      _entity: 'workOrder',
    };
  });
}

// Build Brief v2 Phase 6 (§6.1) — the job line, not the work order, is the
// report's grain. A WO with lines from three funding sources shows as three
// rows, correctly, because that WO's money really does come from three
// places (same reasoning as buildWorkOrderReportRows' arrays, one level down).
export function buildJobLineReportRows({ jobLines, causesByLine, volByLine, venByLine }) {
  return jobLines.map((jl) => ({
    'Job Line': jl.title, 'Work Order': jl.wo_title, 'WO Number': jl.wo_number,
    Status: jl.status, 'Counts As Work Performed': jl.counts_as_work_performed ? 'Yes' : 'No',
    Responsibility: RESPONSIBILITY_LABELS[jl.responsibility_class] || jl.responsibility_class,
    'Funding Source': FUNDING_SOURCE_LABELS[jl.funding_source] || jl.funding_source,
    Asset: jl.asset_name, Location: jl.location_name, Project: jl.project_name,
    'Scheduled Date': jl.scheduled_date, 'Completed Date': jl.completed_date,
    'Estimated Cost': jl.estimated_cost, 'Actual Cost': jl.actual_cost,
    'Estimated Hours': jl.estimated_hours, 'Actual Hours': jl.actual_hours,
    Cause: (causesByLine.get(jl.id) || []).join(', ') || null,
    Volunteers: (volByLine.get(jl.id) || []).join(', ') || null,
    Vendors: (venByLine.get(jl.id) || []).join(', ') || null,
    'Quotes Received': Number(jl.quote_count || 0),
    _id: jl.work_order_id,
    _entity: 'workOrder',
  }));
}

export const JOB_LINE_COLUMN_SPECS = [
  { key: 'Job Line', label: 'Job Line', group: 'Job Line Info', default: true },
  { key: 'Work Order', label: 'Work Order', group: 'Job Line Info', default: true },
  { key: 'WO Number', label: 'WO Number', group: 'Job Line Info' },
  { key: 'Status', label: 'Status', group: 'Job Line Info', default: true },
  { key: 'Counts As Work Performed', label: 'Counts As Work Performed', options: ['Yes', 'No'], group: 'Job Line Info', default: true },
  { key: 'Responsibility', label: 'Responsibility', options: ['Self', 'Volunteer', 'Vendor', 'Cabin-Holder'], group: 'Job Line Info' },
  { key: 'Funding Source', label: 'Funding Source', options: Object.values(FUNDING_SOURCE_LABELS), group: 'Job Line Info' },
  { key: 'Asset', label: 'Asset', group: 'Job Line Info', default: true },
  { key: 'Location', label: 'Location', group: 'Job Line Info' },
  { key: 'Project', label: 'Project', group: 'Job Line Info' },
  { key: 'Scheduled Date', label: 'Scheduled Date', group: 'Dates & Cost', type: 'date' },
  { key: 'Completed Date', label: 'Completed Date', group: 'Dates & Cost', type: 'date', default: true },
  { key: 'Estimated Cost', label: 'Estimated Cost', group: 'Dates & Cost' },
  { key: 'Actual Cost', label: 'Actual Cost', group: 'Dates & Cost', default: true },
  { key: 'Estimated Hours', label: 'Estimated Hours', group: 'Dates & Cost' },
  { key: 'Actual Hours', label: 'Actual Hours', group: 'Dates & Cost' },
  { key: 'Cause', label: 'Cause', group: 'Job Line Info' },
  { key: 'Volunteers', label: 'Volunteers', group: 'Crew' },
  { key: 'Vendors', label: 'Vendors', group: 'Crew' },
  { key: 'Quotes Received', label: 'Quotes Received', group: 'Crew' },
];

// Findings report source (§6.1/§6.2.4) — "Open Findings Not On Any Work
// Order" is just this source filtered to Status=Open, On Work Order=No; no
// bespoke report needed for that one (unlike the Deferred backlog, which
// needs severity grouping + dollar totals — see reportDataPg.js).
export function buildFindingReportRows({ findings }) {
  return findings.map((f) => ({
    Title: f.title, Severity: f.severity, Status: f.status,
    Asset: f.asset_name, Location: f.location_name,
    'Date Identified': f.date_identified, 'Estimated Cost': f.estimated_cost,
    'On Work Order': f.on_work_order ? 'Yes' : 'No',
    'Board Focus': f.board_focus ? 'Yes' : 'No',
    'Deferred Reason': f.deferred_reason, 'Revisit Date': f.revisit_date, 'Dismiss Note': f.dismiss_note,
    Description: f.description,
    _id: f.id,
    _entity: 'conditionFinding',
  }));
}

export const FINDING_COLUMN_SPECS = [
  { key: 'Title', label: 'Title', group: 'Finding Info', default: true },
  { key: 'Severity', label: 'Severity', group: 'Finding Info', default: true },
  { key: 'Status', label: 'Status', options: ['Open', 'Scheduled', 'Resolved', 'Deferred', 'Dismissed'], group: 'Finding Info', default: true },
  { key: 'Asset', label: 'Asset', group: 'Finding Info', default: true },
  { key: 'Location', label: 'Location', group: 'Finding Info' },
  { key: 'Date Identified', label: 'Date Identified', group: 'Finding Info', type: 'date' },
  { key: 'Estimated Cost', label: 'Estimated Cost', group: 'Finding Info', default: true },
  { key: 'On Work Order', label: 'On Work Order', options: ['Yes', 'No'], group: 'Finding Info', default: true },
  { key: 'Board Focus', label: 'Board Focus', options: ['Yes', 'No'], group: 'Finding Info' },
  { key: 'Deferred Reason', label: 'Deferred Reason', group: 'Finding Info' },
  { key: 'Revisit Date', label: 'Revisit Date', group: 'Finding Info', type: 'date' },
  { key: 'Dismiss Note', label: 'Dismiss Note', group: 'Finding Info' },
  { key: 'Description', label: 'Description', group: 'Finding Info' },
];

// "Progress made" — one row per Work Order Log entry (status change / note /
// hours logged), not per Work Order, so a status change and a later note both
// show up as their own dated row. Row clicks land on the parent Work Order
// (there's no standalone log-entry detail view).
export function buildWorkOrderLogReportRows({ logEntries }) {
  return logEntries.map((l) => ({
    'Logged At': l.created_at, 'Work Order': l.wo_title, Asset: l.asset_name, Location: l.location_name,
    Note: l.note, Hours: l.hours, 'Status Change': l.status_change, 'Logged By': l.username,
    _id: l.work_order_id,
    _entity: 'workOrder',
  }));
}

// One row per Crew Session — a dated block of volunteer/vendor work,
// optionally tied to a Work Order (see migration 0022). "Job" here means
// tied to a Work Order; a standalone activity like "Mowing" shows in its own
// Activity column instead.
export function buildCrewSessionReportRows({ sessions }) {
  return sessions.map((s) => ({
    Date: s.Date, 'Work Order': s.WorkOrderTitle || null, Activity: s.Activity || null,
    Asset: s.AssetName, Location: s.LocationName, Hours: s.Hours,
    Volunteers: s.Volunteers.join(', ') || null, Vendors: s.Vendors.join(', ') || null,
    Note: s.Note, 'Logged By': s.Username,
    _id: s.WorkOrderId || null,
    _entity: s.WorkOrderId ? 'workOrder' : null,
  }));
}

export const CREW_SESSION_COLUMN_SPECS = [
  { key: 'Date', label: 'Date', group: 'Crew Session', type: 'date', default: true },
  { key: 'Work Order', label: 'Work Order', group: 'Crew Session', default: true },
  { key: 'Activity', label: 'Activity', group: 'Crew Session', default: true },
  { key: 'Asset', label: 'Asset', group: 'Crew Session' },
  { key: 'Location', label: 'Location', group: 'Crew Session' },
  { key: 'Hours', label: 'Hours', group: 'Crew Session', default: true },
  { key: 'Volunteers', label: 'Volunteers', group: 'Crew', default: true },
  { key: 'Vendors', label: 'Vendors', group: 'Crew' },
  { key: 'Note', label: 'Note', group: 'Crew Session' },
  { key: 'Logged By', label: 'Logged By', group: 'Crew Session' },
];

export function assetColumnSpecs(propertyFields, componentTypeOptions) {
  const specs = [
    { key: 'Asset Name', label: 'Asset Name', group: 'Asset Info', default: true },
    { key: 'Location', label: 'Location', group: 'Asset Info', default: true },
    { key: 'Building Type', label: 'Building Type', group: 'Asset Info' },
    { key: 'Cabin/Lodge Holder', label: 'Cabin/Lodge Holder', group: 'Asset Info', default: true },
  ];
  for (const f of propertyFields) specs.push({ key: f.title, label: f.title, options: f.options || undefined, group: 'Property Answers' });
  for (const type of componentTypeOptions) {
    specs.push({ key: `${type} Condition`, label: `${type} Condition`, group: 'Components' });
    specs.push({ key: `${type} Material`, label: `${type} Material`, group: 'Components' });
    specs.push({ key: `${type} Install Date`, label: `${type} Install Date`, group: 'Components', type: 'date' });
  }
  specs.push({ key: 'Flagged', label: 'Flagged', options: ['Yes', 'No'], group: 'Flags', default: true });
  specs.push({ key: 'Flagged Fields', label: 'Flagged Fields', group: 'Flags', default: true });
  return specs;
}

export const WORK_ORDER_COLUMN_SPECS = [
  { key: 'Title', label: 'Title', group: 'Work Order Info', default: true },
  { key: 'Status', label: 'Status', group: 'Work Order Info', default: true },
  { key: 'Priority', label: 'Priority', options: WO_PRIORITY_OPTIONS, group: 'Work Order Info', default: true },
  { key: 'Funding Source', label: 'Funding Source', options: Object.values(FUNDING_SOURCE_LABELS), group: 'Work Order Info' },
  { key: 'Asset', label: 'Asset', group: 'Work Order Info', default: true },
  { key: 'Location', label: 'Location', group: 'Work Order Info' },
  { key: 'Scheduled Date', label: 'Scheduled Date', group: 'Dates & Cost', type: 'date', default: true },
  { key: 'Date Reported', label: 'Date Reported', group: 'Dates & Cost', type: 'date' },
  { key: 'Date Completed', label: 'Date Completed', group: 'Dates & Cost', type: 'date' },
  { key: 'Estimated Cost', label: 'Estimated Cost', group: 'Dates & Cost' },
  { key: 'Actual Cost', label: 'Actual Cost', group: 'Dates & Cost' },
  { key: 'Estimated Hours', label: 'Estimated Hours', group: 'Dates & Cost' },
  { key: 'Actual Hours', label: 'Actual Hours', group: 'Dates & Cost' },
  { key: 'Responsible Party', label: 'Responsible Party', options: ['Self', 'Volunteer', 'Vendor', 'Cabin-Holder'], group: 'Crew', default: true },
  { key: 'Volunteers', label: 'Volunteers', group: 'Crew' },
  { key: 'Vendors', label: 'Vendors', group: 'Crew' },
];

export const WORK_ORDER_LOG_COLUMN_SPECS = [
  { key: 'Logged At', label: 'Logged At', group: 'Progress Log', type: 'date', default: true },
  { key: 'Work Order', label: 'Work Order', group: 'Progress Log', default: true },
  { key: 'Asset', label: 'Asset', group: 'Progress Log' },
  { key: 'Location', label: 'Location', group: 'Progress Log' },
  { key: 'Status Change', label: 'Status Change', group: 'Progress Log', default: true },
  { key: 'Hours', label: 'Hours', group: 'Progress Log' },
  { key: 'Note', label: 'Note', group: 'Progress Log', default: true },
  { key: 'Logged By', label: 'Logged By', group: 'Progress Log' },
];

// Expenses report source (Build Brief v3 Part 4) — covers all four named
// reports the brief asks for as filtered views of one source, rather than
// four bespoke report builders: "Fund Breakdown" = filter Fund; "Spend by
// Category"/"Spend by Vendor" = filter or sort on those columns; "Tax
// Charged in Error" = filter that column true; "Unclassified Expenses" =
// Fund and/or Category left blank. The explorer's existing filter/sort/CSV
// machinery already does all of this — no separate report needed.
export function buildExpenseReportRows({ expenses }) {
  return expenses.map((e) => ({
    Vendor: e.vendor, Amount: e.amount != null ? Number(e.amount) : null, 'Purchase Date': e.purchase_date,
    Category: e.category_name, Fund: e.fund_name,
    'Tax Amount': e.tax_amount != null ? Number(e.tax_amount) : null,
    'Tax Charged In Error': e.tax_charged_in_error ? 'Yes' : 'No',
    'Job Line': e.job_line_title, 'Work Order': e.work_order_title, 'WO Number': e.wo_number,
    Asset: e.asset_name, Location: e.location_name,
    Receipts: Number(e.receipt_count || 0), Source: e.source === 'email' ? 'Email' : 'Manual',
    Notes: e.notes,
    _id: e.id,
    _entity: 'expense',
  }));
}

export const EXPENSE_COLUMN_SPECS = [
  { key: 'Vendor', label: 'Vendor', group: 'Expense Info', default: true },
  { key: 'Amount', label: 'Amount', group: 'Expense Info', default: true },
  { key: 'Purchase Date', label: 'Purchase Date', group: 'Expense Info', type: 'date', default: true },
  { key: 'Category', label: 'Category', group: 'Expense Info', default: true },
  { key: 'Fund', label: 'Fund', group: 'Expense Info', default: true },
  { key: 'Tax Amount', label: 'Tax Amount', group: 'Tax' },
  { key: 'Tax Charged In Error', label: 'Tax Charged In Error', options: ['Yes', 'No'], group: 'Tax', default: true },
  { key: 'Job Line', label: 'Job Line', group: 'Linked To' },
  { key: 'Work Order', label: 'Work Order', group: 'Linked To' },
  { key: 'WO Number', label: 'WO Number', group: 'Linked To' },
  { key: 'Asset', label: 'Asset', group: 'Linked To' },
  { key: 'Location', label: 'Location', group: 'Linked To' },
  { key: 'Receipts', label: 'Receipts', group: 'Expense Info' },
  { key: 'Source', label: 'Source', options: ['Email', 'Manual'], group: 'Expense Info' },
  { key: 'Notes', label: 'Notes', group: 'Expense Info' },
];

// A column is either "fixed" (a known options list), "distinct" (derived
// from whatever values actually appear in `rows`), or "date" (a from/to range
// control instead of a checkbox list — checking off individual calendar
// dates one at a time isn't a usable filter). Fixed/distinct always give the
// frontend a pre-populated list to check, never a free-text box that can
// typo its way to zero results.
export function columnDefsFromRows(rows, specs) {
  return specs.map((d) => {
    if (d.type === 'date') return { key: d.key, label: d.label, group: d.group, default: !!d.default, type: 'date', options: [] };
    const options = d.options || [...new Set(rows.map((r) => r[d.key]).filter((v) => v !== null && v !== undefined && v !== ''))].sort();
    return { key: d.key, label: d.label, group: d.group, default: !!d.default, options };
  });
}

// filters: { [columnKey]: string[] | { from?, to? } } — a plain value list
// (OR within the column, AND across columns) for categorical columns, or a
// from/to range for date columns. Always plain data from the client, never
// raw SQL/text, so there's no injection surface to worry about.
export function applyReportFilters(rows, filters) {
  if (!filters) return rows;
  const entries = Object.entries(filters).filter(([, v]) => v && (Array.isArray(v) ? v.length : (v.from || v.to)));
  if (!entries.length) return rows;
  return rows.filter((row) => entries.every(([key, v]) => {
    if (Array.isArray(v)) {
      // "Responsible Party" cells are joined multi-value strings ("Self, Vendor"),
      // not a single value — match if any selected option appears in the cell.
      if (key === 'Responsible Party') {
        const cellValues = row[key] ? String(row[key]).split(', ') : [];
        return v.some((opt) => cellValues.includes(opt));
      }
      return v.includes(row[key] == null ? '' : String(row[key]));
    }
    const raw = row[key];
    if (!raw) return false; // a range filter is active but this row has no date — excluded
    const t = new Date(raw).getTime();
    if (Number.isNaN(t)) return false;
    if (v.from && t < new Date(v.from).getTime()) return false;
    if (v.to && t > new Date(`${v.to}T23:59:59`).getTime()) return false;
    return true;
  }));
}

export function rowsToCsv(rows, columnKeys) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columnKeys.map(esc).join(',');
  const lines = rows.map((r) => columnKeys.map((k) => esc(r[k])).join(','));
  return [header, ...lines].join('\r\n');
}

// Two saved views are "the same" once each column's selected values are
// sorted (so checking the same boxes in a different order doesn't count as
// different) and the columns themselves are in a stable order — used to
// block saving an exact duplicate favorite. Mirrored in app.js since the
// frontend also wants an instant check before round-tripping to the server.
function normalizeFiltersForCompare(filters) {
  const out = {};
  for (const [k, v] of Object.entries(filters || {})) {
    if (Array.isArray(v)) { if (v.length) out[k] = [...v].sort(); }
    else if (v && (v.from || v.to)) out[k] = { from: v.from || null, to: v.to || null };
  }
  return out;
}
export function canonicalFiltersKey(filters) {
  const norm = normalizeFiltersForCompare(filters);
  return JSON.stringify(Object.keys(norm).sort().map((k) => [k, norm[k]]));
}
