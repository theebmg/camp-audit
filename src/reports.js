// Reports v1: pure row-shaping/filter/CSV logic for the Assets + Work Orders
// export tab. No DB access here on purpose (db.js's getAssetsReportRawData /
// getWorkOrdersReportRawData fetch the raw data) — same separation as
// components.js's currentComponentState, so this stays testable and the
// "what does a report row look like" question lives in exactly one place.
import { currentComponentState } from './components.js';

// Work Order Status/Priority and funding source aren't schema-driven catalogs
// like asset properties/components (see app.js's WO_STATUS_OPTIONS /
// FUNDING_SOURCE_LABELS, which these mirror) — fixed lists here so report
// filters can offer them without a free-text box.
export const WO_STATUS_OPTIONS = ['Open', 'In Progress', 'On Hold', 'Urgent', 'Done'];
export const WO_PRIORITY_OPTIONS = ['Low', 'Medium', 'High', 'Urgent'];
export const FUNDING_SOURCE_LABELS = {
  operating_budget: 'Operating Budget', capital_campaign: 'Capital Campaign', cabin_holder: 'Cabin-Holder', other: 'Other',
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

export function buildWorkOrderReportRows({ workOrders, volByWo, venByWo }) {
  return workOrders.map((w) => ({
    Title: w.title, Status: w.status, Priority: w.priority,
    'Funding Source': FUNDING_SOURCE_LABELS[w.funding_source] || w.funding_source || null,
    Asset: w.asset_name, Location: w.location_name,
    'Scheduled Date': w.scheduled_date, 'Date Reported': w.date_reported, 'Date Completed': w.date_completed,
    'Estimated Cost': w.estimated_cost, 'Actual Cost': w.actual_cost,
    'Estimated Hours': w.estimated_hours, 'Actual Hours': w.actual_hours,
    Volunteers: (volByWo.get(w.id) || []).join(', ') || null,
    Vendors: (venByWo.get(w.id) || []).join(', ') || null,
    _id: w.id,
    _entity: 'workOrder',
  }));
}

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
    specs.push({ key: `${type} Install Date`, label: `${type} Install Date`, group: 'Components' });
  }
  specs.push({ key: 'Flagged', label: 'Flagged', options: ['Yes', 'No'], group: 'Flags', default: true });
  specs.push({ key: 'Flagged Fields', label: 'Flagged Fields', group: 'Flags', default: true });
  return specs;
}

export const WORK_ORDER_COLUMN_SPECS = [
  { key: 'Title', label: 'Title', group: 'Work Order Info', default: true },
  { key: 'Status', label: 'Status', options: WO_STATUS_OPTIONS, group: 'Work Order Info', default: true },
  { key: 'Priority', label: 'Priority', options: WO_PRIORITY_OPTIONS, group: 'Work Order Info', default: true },
  { key: 'Funding Source', label: 'Funding Source', options: Object.values(FUNDING_SOURCE_LABELS), group: 'Work Order Info' },
  { key: 'Asset', label: 'Asset', group: 'Work Order Info', default: true },
  { key: 'Location', label: 'Location', group: 'Work Order Info' },
  { key: 'Scheduled Date', label: 'Scheduled Date', group: 'Dates & Cost', default: true },
  { key: 'Date Reported', label: 'Date Reported', group: 'Dates & Cost' },
  { key: 'Date Completed', label: 'Date Completed', group: 'Dates & Cost' },
  { key: 'Estimated Cost', label: 'Estimated Cost', group: 'Dates & Cost' },
  { key: 'Actual Cost', label: 'Actual Cost', group: 'Dates & Cost' },
  { key: 'Estimated Hours', label: 'Estimated Hours', group: 'Dates & Cost' },
  { key: 'Actual Hours', label: 'Actual Hours', group: 'Dates & Cost' },
  { key: 'Volunteers', label: 'Volunteers', group: 'Crew' },
  { key: 'Vendors', label: 'Vendors', group: 'Crew' },
];

// A column is either "fixed" (a known options list) or "distinct" (derived
// from whatever values actually appear in `rows`) — either way the frontend
// gets a pre-populated list to check, never a free-text box that can typo its
// way to zero results.
export function columnDefsFromRows(rows, specs) {
  return specs.map((d) => {
    const options = d.options || [...new Set(rows.map((r) => r[d.key]).filter((v) => v !== null && v !== undefined && v !== ''))].sort();
    return { key: d.key, label: d.label, group: d.group, default: !!d.default, options };
  });
}

// filters: { [columnKey]: string[] } — OR within one column's selected
// values, AND across different columns. Always a plain value list from the
// client, never raw SQL/text, so there's no injection surface to worry about.
export function applyReportFilters(rows, filters) {
  if (!filters) return rows;
  const entries = Object.entries(filters).filter(([, vals]) => Array.isArray(vals) && vals.length);
  if (!entries.length) return rows;
  return rows.filter((row) => entries.every(([key, vals]) => vals.includes(row[key] == null ? '' : String(row[key]))));
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
