// Asset Components domain logic: pure functions over plain Asset Components rows.
// No NocoDB imports here on purpose (see ADDENDUM in camp-cmms-components-design.md)
// — this is the ONE place "current state" is defined, so every screen (audit
// prefill, per-asset history, camp-wide log) agrees on what "current" means.

const DATE_FIELD = 'Observed/Installed Date';
const TYPE_FIELD = 'Component Type';
const EVENT_FIELD = 'Event Type';

// Installed/Replaced events reset the lifespan clock; Inspected/Repaired/Retired
// update condition (and history) but don't move the replacement-year estimate.
const CLOCK_EVENT_TYPES = new Set(['Installed', 'Replaced']);

function byDateDesc(a, b) {
  const da = a[DATE_FIELD] || '';
  const db = b[DATE_FIELD] || '';
  if (da === db) return (b.Id || 0) - (a.Id || 0);
  return da < db ? 1 : -1;
}

export function computeReplacementYear(row) {
  const date = row?.[DATE_FIELD];
  const life = row?.['Est Life (years)'];
  if (!date || life == null) return null;
  const year = Number(String(date).slice(0, 4));
  if (Number.isNaN(year)) return null;
  return year + Number(life);
}

// Given ALL Asset Components rows for one asset, derive current state per
// Component Type:
//   - condition  = newest row of ANY Event Type (an Inspected row can update
//                  condition without being an Installed/Replaced event)
//   - clock      = newest row whose Event Type is Installed/Replaced — this is
//                  what the replacement-year estimate is computed from
// Returns { [componentType]: { condition, conditionDate, conditionEventType,
//   material, installedDate, estLifeYears, estReplacementYear,
//   estReplacementCost, latestRow, clockRow } }
export function currentComponentState(rows) {
  const byType = new Map();
  for (const row of rows) {
    const type = row[TYPE_FIELD];
    if (!type) continue;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(row);
  }

  const result = {};
  for (const [type, typeRows] of byType) {
    const sorted = [...typeRows].sort(byDateDesc);
    const newest = sorted[0];
    const clockRow = sorted.find((r) => CLOCK_EVENT_TYPES.has(r[EVENT_FIELD])) || null;

    result[type] = {
      condition: newest?.Condition ?? null,
      conditionDate: newest?.[DATE_FIELD] ?? null,
      conditionEventType: newest?.[EVENT_FIELD] ?? null,
      material: clockRow?.Material ?? newest?.Material ?? null,
      installedDate: clockRow?.[DATE_FIELD] ?? null,
      estLifeYears: clockRow?.['Est Life (years)'] ?? null,
      estReplacementYear: clockRow?.['Est Replacement Year'] ?? computeReplacementYear(clockRow),
      estReplacementCost: clockRow?.['Est Replacement Cost'] ?? null,
      latestRow: newest,
      clockRow,
    };
  }
  return result;
}

// History = the same log, unfiltered, newest first. No separate storage — a read
// of the same rows currentComponentState() consumes.
export function sortHistory(rows) {
  return [...rows].sort(byDateDesc);
}
