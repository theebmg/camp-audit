// NocoDB Data API client.
// The API token lives ONLY here (server-side), read from env. The browser never sees it.
//
// Portability boundary: this is the ONLY module that knows about NocoDB URLs, the
// xc-token header, or NocoDB's response shapes ({ list: [...] } envelopes, internal
// _nc_m2m_* junction fields, the two different link-column uidt spellings). Callers
// get plain arrays/objects back. If this app ever needs to move off NocoDB, only
// this file should have to change.

const BASE_URL = process.env.NC_URL || 'https://nocodb.fracturedrv.com';
// NC_URL may be an internal docker-network address (e.g. http://nocodb:8080) for
// efficient server-to-server calls — that's unreachable from the browser. Links we
// hand back to the frontend (attachment URLs) must use the public address instead.
const PUBLIC_BASE_URL = process.env.NC_PUBLIC_URL || BASE_URL;
const TOKEN = process.env.NC_TOKEN;

// Table IDs for the Sychar base (p0rfnut85c1hmpa). Override via env if they ever change.
export const TABLES = {
  locations:        process.env.NC_TBL_LOCATIONS        || 'mkyqlm9b3z9ua7h',
  assets:           process.env.NC_TBL_ASSETS           || 'mcwn0dntwh9sani',
  workOrders:       process.env.NC_TBL_WORK_ORDERS      || 'm828b9fafbkim2k',
  conditionFindings:process.env.NC_TBL_COND_FINDINGS    || 'mwjnwa9me35w92i',
  volunteers:       process.env.NC_TBL_VOLUNTEERS       || 'mdug0yptbhp2yr1',
  projects:         process.env.NC_TBL_PROJECTS         || 'maifuufxc1ei26s',
  assetUpdates:     process.env.NC_TBL_ASSET_UPDATES    || 'm19j4bugaofnk7a',
  assetComponents:  process.env.NC_TBL_ASSET_COMPONENTS || 'm5ubjp5vmbu2ofn',
  vendors:          process.env.NC_TBL_VENDORS           || 'mavc38ui5dlossq',
};

if (!TOKEN) {
  console.error('FATAL: NC_TOKEN env var is not set. The app cannot talk to NocoDB.');
}

function headers() {
  return { 'xc-token': TOKEN, 'Content-Type': 'application/json' };
}

async function ncFetch(path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const err = new Error(`NocoDB ${res.status} on ${opts.method || 'GET'} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Drop NocoDB's internal junction-table bookkeeping fields (_nc_m2m_*) so callers
// only ever see the friendly named link fields (Asset, Location, Work Order, ...).
function stripInternal(record) {
  if (!record || typeof record !== 'object') return record;
  const clean = {};
  for (const [k, v] of Object.entries(record)) {
    if (k.startsWith('_nc_m2m_')) continue;
    clean[k] = v;
  }
  return clean;
}

// ---- META (schema) ----
export async function getTableMeta(tableId) {
  return ncFetch(`/api/v2/meta/tables/${tableId}`);
}

// Resolve a link field's column id by table + title. NocoDB reports link columns
// under two different uidt spellings depending on how they were created
// (`LinkToAnotherRecord` for older/UI-created ones, `Links` for ones created via
// this API) — both mean the same thing. Cached per process; restart the app if a
// link field is renamed in NocoDB.
const linkFieldIdCache = new Map();
export async function getLinkFieldId(tableId, fieldTitle) {
  const cacheKey = `${tableId}:${fieldTitle}`;
  if (linkFieldIdCache.has(cacheKey)) return linkFieldIdCache.get(cacheKey);
  const meta = await getTableMeta(tableId);
  const col = meta.columns.find((c) => c.title === fieldTitle && (c.uidt === 'LinkToAnotherRecord' || c.uidt === 'Links'));
  if (!col) throw new Error(`Could not find link field "${fieldTitle}" on table ${tableId} in the live schema`);
  linkFieldIdCache.set(cacheKey, col.id);
  return col.id;
}

// ---- RECORDS ----
// list* functions return plain arrays (NocoDB's { list, pageInfo } envelope and
// per-record _nc_m2m_* noise are unwrapped here). Pass a `limit` well above the
// expected row count — NocoDB's own page-size default is small and callers here
// don't paginate.
export async function listRecords(tableId, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) qs.set(k, v);
  const q = qs.toString();
  const data = await ncFetch(`/api/v2/tables/${tableId}/records${q ? `?${q}` : ''}`);
  return (data.list || []).map(stripInternal);
}

export async function getRecord(tableId, recordId) {
  const record = await ncFetch(`/api/v2/tables/${tableId}/records/${recordId}`);
  return stripInternal(record);
}

// List records linked to a single row through a link field (e.g. a Location's Assets).
export async function listLinkedRecords(tableId, linkFieldId, rowId, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) qs.set(k, v);
  const q = qs.toString();
  const data = await ncFetch(`/api/v2/tables/${tableId}/links/${encodeURIComponent(linkFieldId)}/records/${rowId}${q ? `?${q}` : ''}`);
  return (data.list || []).map(stripInternal);
}

export async function createRecord(tableId, fields) {
  const record = await ncFetch(`/api/v2/tables/${tableId}/records`, {
    method: 'POST',
    body: JSON.stringify(fields),
  });
  return stripInternal(record);
}

// Update an existing record. NocoDB v2 PATCH expects the record's Id in the body.
export async function updateRecord(tableId, recordId, fields) {
  return ncFetch(`/api/v2/tables/${tableId}/records`, {
    method: 'PATCH',
    body: JSON.stringify({ Id: recordId, ...fields }),
  });
}

// Link a record (e.g. set a Condition Finding's Asset link).
export async function linkRecords(tableId, linkFieldId, rowId, targetIds) {
  const ids = Array.isArray(targetIds) ? targetIds : [targetIds];
  return ncFetch(`/api/v2/tables/${tableId}/links/${encodeURIComponent(linkFieldId)}/records/${rowId}`, {
    method: 'POST',
    body: JSON.stringify(ids.map((Id) => ({ Id }))),
  });
}

// Unlink a record (e.g. clear a Condition Finding's Asset link before setting a new one).
export async function unlinkRecords(tableId, linkFieldId, rowId, targetIds) {
  const ids = Array.isArray(targetIds) ? targetIds : [targetIds];
  return ncFetch(`/api/v2/tables/${tableId}/links/${encodeURIComponent(linkFieldId)}/records/${rowId}`, {
    method: 'DELETE',
    body: JSON.stringify(ids.map((Id) => ({ Id }))),
  });
}

export async function deleteRecord(tableId, recordId) {
  return ncFetch(`/api/v2/tables/${tableId}/records`, {
    method: 'DELETE',
    body: JSON.stringify({ Id: recordId }),
  });
}

// Upload a file to NocoDB's storage and get back attachment metadata (does NOT
// attach it to a record — PATCH the target Attachment field with the result).
export async function uploadAttachment(buffer, filename, mimetype) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), filename);
  const res = await fetch(`${BASE_URL}/api/v2/storage/upload`, {
    method: 'POST',
    headers: { 'xc-token': TOKEN },
    body: form,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : [];
  if (!res.ok) {
    const err = new Error(`NocoDB ${res.status} on storage upload: ${text}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// NocoDB's attachment signedPath is a relative, time-limited URL — always build
// it fresh from a just-fetched record rather than caching it anywhere long-lived.
export function attachmentUrl(signedPath) {
  return `${PUBLIC_BASE_URL}/${signedPath}`;
}

export { BASE_URL };
