// Frontend for the Postgres-backed API (/api/pg/*) — a preview build, kept
// entirely separate from public/app.js so the live NocoDB-backed app is never
// touched. Same shell/router pattern as the original for familiarity.

const app = document.getElementById('app');
const pageTitle = document.getElementById('pageTitle');
const backBtn = document.getElementById('backBtn');
const menuBtn = document.getElementById('menuBtn');
const logoutBtn = document.getElementById('logoutBtn');
const toastEl = document.getElementById('toast');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const sidebarNavEl = document.getElementById('sidebarNav');
const sidebarUserEl = document.getElementById('sidebarUser');
const breadcrumbsEl = document.getElementById('breadcrumbs');
const globalSearchWrap = document.getElementById('globalSearchWrap');
const globalSearchInput = document.getElementById('globalSearch');
const globalSearchResults = document.getElementById('globalSearchResults');

const state = { user: null, options: null, stack: [] };

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 2500);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401) {
    state.user = null; state.stack = [];
    render('login');
    throw new Error('Not authenticated');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// Uploads one file to DigitalOcean Spaces via the backend, returns its URL.
async function uploadPhotoFile(file, category, ownerId) {
  const fd = new FormData();
  fd.append('photo', file);
  fd.append('category', category);
  fd.append('ownerId', String(ownerId));
  const res = await fetch('/api/pg/upload', { method: 'POST', body: fd });
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error || 'Photo upload failed');
  return body.url;
}

function setChrome({ title, showBack, showLogout }) {
  pageTitle.textContent = title;
  backBtn.hidden = !showBack;
  logoutBtn.hidden = !showLogout;
  menuBtn.hidden = !showLogout;
  globalSearchWrap.hidden = !showLogout;
}

function go(view, params, opts = {}) {
  if (!opts.replace) state.stack.push({ view, params });
  render(view, params);
}
function goBack() {
  state.stack.pop();
  const prev = state.stack.pop();
  if (prev) go(prev.view, prev.params); else go('dashboard', {}, { replace: true });
}

backBtn.addEventListener('click', goBack);
logoutBtn.addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  state.user = null; state.stack = [];
  render('login');
});

const NAV_ITEMS = [
  { icon: '🏠', label: 'Dashboard', view: 'dashboard' },
  { icon: '📍', label: 'Locations', view: 'locations' },
  { icon: '🛠️', label: 'Work Orders', view: 'workOrders' },
  { icon: '👷', label: 'Crew', view: 'crew' },
  { icon: '📋', label: 'Maintenance Log', view: 'maintenanceLog' },
  { icon: '💰', label: 'Capital Plan', view: 'capitalPlan' },
  { icon: '⚙️', label: 'Admin', view: 'admin' },
];

function renderSidebar(activeView) {
  sidebarNavEl.innerHTML = NAV_ITEMS.map((item) => `
    <button class="nav-item ${item.view === activeView ? 'active' : ''}" data-view="${item.view}">
      <span class="nav-icon">${item.icon}</span><span>${item.label}</span>
    </button>`).join('');
  sidebarNavEl.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => { closeSidebar(); go(btn.dataset.view, {}); });
  });
  sidebarUserEl.textContent = state.user ? `Signed in as ${state.user}` : '';
}
function openSidebar() { sidebar.classList.add('open'); sidebarOverlay.hidden = false; }
function closeSidebar() { sidebar.classList.remove('open'); sidebarOverlay.hidden = true; }
menuBtn.addEventListener('click', openSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);
document.getElementById('closeSidebarBtn').addEventListener('click', closeSidebar);

let searchTimer;
globalSearchInput?.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = globalSearchInput.value.trim();
  if (!q) { globalSearchResults.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const { locations, assets } = await api(`/api/pg/search?q=${encodeURIComponent(q)}`);
    globalSearchResults.hidden = false;
    globalSearchResults.innerHTML = [
      ...locations.map((l) => `<div class="list-item" data-kind="loc" data-id="${l.Id}" data-name="${escapeHtml(l.Name)}">📍 ${escapeHtml(l.Name)}</div>`),
      ...assets.map((a) => `<div class="list-item" data-kind="asset" data-id="${a.Id}">🏚️ ${escapeHtml(a.Name)} <span class="muted">${escapeHtml(a.locationName || '')}</span></div>`),
    ].join('') || '<div class="muted" style="padding:10px">No matches</div>';
    globalSearchResults.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => {
      globalSearchResults.hidden = true; globalSearchInput.value = '';
      if (el.dataset.kind === 'loc') go('assetsInLocation', { id: el.dataset.id, name: el.dataset.name });
      else go('assetDetail', { id: el.dataset.id });
    }));
  }, 250);
});

// ---------- Views ----------

async function render(view, params = {}) {
  try {
    if (view === 'login') return renderLogin();
    if (!state.user) return renderLogin();
    if (!state.options) state.options = await api('/api/pg/options');
    renderSidebar(view);
    setChrome({ title: '', showBack: state.stack.length > 1, showLogout: true });
    breadcrumbsEl.hidden = true;
    if (view === 'dashboard') return renderDashboard();
    if (view === 'locations') return renderLocations();
    if (view === 'assetsInLocation') return renderAssetsInLocation(params);
    if (view === 'assetDetail') return renderAssetDetail(params);
    if (view === 'audit') return renderAudit(params);
    if (view === 'assetHistory') return renderAssetHistory(params);
    if (view === 'capitalPlan') return renderCapitalPlan();
    if (view === 'maintenanceLog') return renderMaintenanceLog();
    if (view === 'editAsset') return renderEditAsset(params);
    if (view === 'admin') return renderAdminHub();
    if (view === 'adminAddFieldChoice') return renderAdminAddFieldChoice();
    if (view === 'adminPropertyFields') return renderAdminPropertyFields(params);
    if (view === 'adminComponentTypes') return renderAdminComponentTypes(params);
    if (view === 'adminBuildingTypes') return renderAdminBuildingTypes();
    if (view === 'adminApplicability') return renderAdminApplicability();
    if (view === 'adminSubAreas') return renderAdminSubAreas();
    if (view === 'workOrders') return renderWorkOrders();
    if (view === 'workOrderDetail') return renderWorkOrderDetail(params);
    if (view === 'newWorkOrder') return renderNewWorkOrder(params);
    if (view === 'crew') return renderCrew();
  } catch (e) {
    if (e.message !== 'Not authenticated') toast(e.message);
  }
}

function renderLogin() {
  setChrome({ title: 'Camp Sychar Audit — Sign In', showBack: false, showLogout: false });
  app.innerHTML = `
    <div class="card" style="max-width:360px;margin:40px auto">
      <h3>Sign In</h3>
      <form id="loginForm">
        <div class="field-row"><label>Username</label><input name="username" autocomplete="username" required /></div>
        <div class="field-row"><label>Password</label><input name="password" type="password" autocomplete="current-password" required /></div>
        <button class="btn btn-primary" type="submit" style="width:100%">Sign In</button>
      </form>
    </div>`;
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const body = await api('/login', { method: 'POST', body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }) });
      state.user = body.user;
      go('dashboard', {}, { replace: true });
    } catch (err) { toast(err.message); }
  });
}

function renderDashboard() {
  app.innerHTML = `
    <div class="card"><h3>Welcome${state.user ? `, ${escapeHtml(state.user)}` : ''}</h3>
      <p class="muted">Postgres-backed preview of the audit app. Pick a location to start auditing an asset, or check the reports.</p>
    </div>
    <div class="list-item" data-view="locations">📍 Browse Locations</div>
    <div class="list-item" data-view="maintenanceLog">📋 Maintenance Log</div>
    <div class="list-item" data-view="capitalPlan">💰 Capital Plan</div>`;
  app.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => go(el.dataset.view, {})));
}

async function renderLocations() {
  setChrome({ title: 'Locations', showBack: false, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const { locations } = await api('/api/pg/locations');
  app.innerHTML = locations.map((l) => `
    <div class="list-item" data-id="${l.Id}" data-name="${escapeHtml(l.Name)}">
      <span>📍 ${escapeHtml(l.Name)}</span><span class="pill">${escapeHtml(l['Location Type'] || '')}</span>
    </div>`).join('');
  app.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () =>
    go('assetsInLocation', { id: el.dataset.id, name: el.dataset.name })));
}

async function renderAssetsInLocation({ id, name }) {
  setChrome({ title: name || 'Assets', showBack: true, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const { assets } = await api(`/api/pg/locations/${id}/assets`);
  app.innerHTML = assets.length ? assets.map((a) => `
    <div class="list-item" data-id="${a.Id}">
      <span>🏚️ ${escapeHtml(a.Name)}</span>
      <span class="pill">${escapeHtml(a['Asset type'] || '')}</span>
    </div>`).join('') : '<p class="muted">No assets in this location.</p>';
  app.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => go('assetDetail', { id: el.dataset.id })));
}

function conditionPillClass(c) {
  if (['Good', 'Excellent', 'Fair'].includes(c)) return 'good';
  if (['Poor'].includes(c)) return 'warn';
  if (['Failed', 'Critical'].includes(c)) return 'bad';
  return '';
}

async function renderAssetDetail({ id }) {
  setChrome({ title: 'Asset', showBack: true, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const [detail, notesRes] = await Promise.all([
    api(`/api/pg/assets/${id}`), api(`/api/pg/assets/${id}/notes`),
  ]);
  const { asset, properties, components, workOrders, conditionFindings } = detail;
  const notes = notesRes.notes;

  const propRows = properties.topLevel.map((title) => {
    const f = properties.fields.find((x) => x.title === title);
    return `<div class="muted">${escapeHtml(title)}: <strong>${escapeHtml(f.currentValue ?? '—')}</strong></div>`;
  }).join('');

  const componentRows = Object.entries(components.current).map(([type, s]) => `
    <div class="list-item" style="cursor:default">
      <span>${escapeHtml(type)}</span>
      <span class="pill ${conditionPillClass(s.condition)}">${escapeHtml(s.condition || 'Unknown')}${s.estReplacementYear ? ` · est. ${s.estReplacementYear}` : ''}</span>
    </div>`).join('') || '<p class="muted">No component history yet.</p>';

  const buildingTypeOptions = state.options.buildingTypes.map((b) =>
    `<option value="${b.Id}" ${asset.buildingTypeId === b.Id ? 'selected' : ''}>${escapeHtml(b.Name)}</option>`).join('');

  const noteRows = notes.map((n) => `
    <div class="note-item ${n.resolved ? 'resolved' : ''}" data-id="${n.id}">
      <div>${escapeHtml(n.note)}</div>
      ${n.photo_url ? `<a href="${escapeHtml(n.photo_url)}" target="_blank" rel="noopener"><img src="${escapeHtml(n.photo_url)}" alt="" style="max-width:120px;border-radius:8px;margin-top:6px;display:block" /></a>` : ''}
      <div class="muted">${new Date(n.created_at).toLocaleDateString()}${n.created_by ? ` · ${escapeHtml(n.created_by)}` : ''}
        <a href="#" class="resolve-note" data-id="${n.id}" data-next="${!n.resolved}">${n.resolved ? 'reopen' : 'mark resolved'}</a>
      </div>
    </div>`).join('') || '<p class="muted">No notes yet.</p>';

  app.innerHTML = `
    <div class="card">
      <h3>${escapeHtml(asset.Name)}</h3>
      <div class="muted">${escapeHtml(asset['Asset type'] || '')} · Condition: ${escapeHtml(asset.Condition || 'Unknown')}</div>
      <div class="field-row" style="margin-top:12px">
        <label>Building Type</label>
        <select id="buildingTypeSelect"><option value="">— unset —</option>${buildingTypeOptions}</select>
      </div>
      ${propRows}
      <div class="btn-row">
        <button class="btn btn-primary" id="startAuditBtn">Start Audit</button>
        <button class="btn btn-secondary" id="viewHistoryBtn">View History</button>
        <button class="btn btn-secondary" id="editAssetBtn">Edit Asset</button>
        <button class="btn btn-secondary" id="newWoBtn">New Work Order</button>
      </div>
    </div>

    <div class="card"><h3>Components</h3>${componentRows}</div>

    <div class="card"><h3>Work Orders (${workOrders.length})</h3>
      ${workOrders.map((w) => `<div class="list-item" data-wo-id="${w.Id}"><span>${escapeHtml(w.Title)}</span><span class="pill ${w.Status === 'Done' ? 'good' : ''}">${escapeHtml(w.Status || '')}</span></div>`).join('') || '<p class="muted">None yet.</p>'}
    </div>

    <div class="card"><h3>Findings (${conditionFindings.length})</h3>
      ${conditionFindings.map((f) => `<div class="list-item" style="cursor:default"><span>${escapeHtml(f.Title || '')}</span><span class="pill">${escapeHtml(f.Severity || '')}</span></div>`).join('') || '<p class="muted">None yet.</p>'}
    </div>

    <div class="card">
      <h3>Field Notes</h3>
      <div id="noteList">${noteRows}</div>
      <form id="noteForm" style="margin-top:10px">
        <div class="field-row"><textarea name="note" placeholder="Quick note or follow-up for this asset…" required></textarea></div>
        <div class="field-row"><label>Photo (optional)</label><input type="file" name="photo" accept="image/*" capture="environment" /></div>
        <button class="btn btn-secondary" type="submit">Add Note</button>
      </form>
    </div>`;

  document.getElementById('startAuditBtn').addEventListener('click', () => go('audit', { id }));
  document.getElementById('viewHistoryBtn').addEventListener('click', () => go('assetHistory', { id }));
  document.getElementById('editAssetBtn').addEventListener('click', () => go('editAsset', { id }));
  document.getElementById('newWoBtn').addEventListener('click', () => go('newWorkOrder', { assetId: id, assetName: asset.Name }));
  app.querySelectorAll('[data-wo-id]').forEach((el) => el.addEventListener('click', () => go('workOrderDetail', { id: el.dataset.woId })));
  document.getElementById('buildingTypeSelect').addEventListener('change', async (e) => {
    const label = e.target.options[e.target.selectedIndex].text;
    if (!confirm(`Change building type to "${label}"? This affects which questions apply to this asset.`)) {
      e.target.value = asset.buildingTypeId ?? '';
      return;
    }
    await api(`/api/pg/assets/${id}/building-type`, { method: 'PATCH', body: JSON.stringify({ buildingTypeId: e.target.value ? Number(e.target.value) : null }) });
    toast('Building type updated');
  });
  document.getElementById('noteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const note = fd.get('note');
    const file = fd.get('photo');
    try {
      let photoUrl = null;
      if (file && file.size) photoUrl = await uploadPhotoFile(file, 'notes', id);
      await api(`/api/pg/assets/${id}/notes`, { method: 'POST', body: JSON.stringify({ note, photoUrl }) });
      toast('Note added');
      renderAssetDetail({ id });
    } catch (err) { toast(err.message); }
  });
  app.querySelectorAll('.resolve-note').forEach((el) => el.addEventListener('click', async (e) => {
    e.preventDefault();
    await api(`/api/pg/notes/${el.dataset.id}/resolve`, { method: 'PATCH', body: JSON.stringify({ resolved: el.dataset.next === 'true' }) });
    renderAssetDetail({ id });
  }));
}

async function renderAudit({ id }) {
  setChrome({ title: 'Audit', showBack: true, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const detail = await api(`/api/pg/assets/${id}`);
  const { asset, properties, components } = detail;
  const fieldByKey = new Map(properties.fields.map((f) => [f.fieldKey, f]));
  const labelToKey = new Map(properties.fields.map((f) => [f.title, f.fieldKey]));

  function fieldHtml(f) {
    const opts = (f.options || []).map((o) => `<option value="${escapeHtml(o)}" ${f.currentValue === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
    const control = f.options
      ? `<select name="prop_${f.fieldKey}"><option value="">— select —</option>${opts}</select>`
      : `<input name="prop_${f.fieldKey}" type="${f.uidt === 'Number' ? 'number' : 'text'}" value="${escapeHtml(f.currentValue ?? '')}" />`;
    return `<div class="field-row" data-field="${f.fieldKey}">
      <label>${escapeHtml(f.title)}</label>
      ${control}
    </div>`;
  }

  const topFieldsHtml = properties.topLevel.map((title) => fieldHtml(fieldByKey.get(labelToKey.get(title)))).join('');
  const dependencyBlocks = properties.dependencies.map((d) => {
    const revealFields = d.reveals.map((title) => fieldHtml(fieldByKey.get(labelToKey.get(title)))).join('');
    return `<div class="reveal" data-depends-on="${labelToKey.get(d.field)}" data-show-when='${JSON.stringify(d.showWhen)}' hidden>${revealFields}</div>`;
  }).join('');

  const componentBlock = components.schema.promptWhen ? `
    <div class="reveal" id="componentPromptBlock" data-depends-on="${labelToKey.get(components.schema.promptWhen.field)}"
         data-show-when='${JSON.stringify(components.schema.promptWhen.showWhen)}' hidden>
      <h3 style="margin-top:0">Component Check</h3>
      ${components.schema.promptTypes.map((type) => `
        <div class="card" data-component="${escapeHtml(type)}">
          <h3>${escapeHtml(type)}</h3>
          <div class="field-row"><label>Event Type</label>
            <select class="comp-event">${components.schema.eventTypeOptions.map((o) => `<option ${o === 'Inspected' ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select>
          </div>
          <div class="field-row"><label>Condition</label>
            <select class="comp-condition"><option value="">— select —</option>${components.schema.conditionOptions.map((o) => `<option>${escapeHtml(o)}</option>`).join('')}</select>
          </div>
          <div class="field-row"><label>Material</label><input class="comp-material" /></div>
          <div class="field-row"><label>Notes</label><textarea class="comp-notes"></textarea></div>
        </div>`).join('')}
    </div>` : '';

  app.innerHTML = `
    <div class="card">
      <h3>Auditing: ${escapeHtml(asset.Name)}</h3>
      <form id="auditForm">
        ${topFieldsHtml}
        ${dependencyBlocks}
        ${componentBlock}
        <div class="card">
          <h3>Report a Finding (optional)</h3>
          <div class="field-row"><label>Severity</label>
            <select name="findingSeverity"><option value="">— none —</option>${(state.options.findingSeverity || []).map((s) => `<option>${escapeHtml(s)}</option>`).join('')}</select>
          </div>
          <div class="field-row"><label>Description</label><textarea name="findingDescription"></textarea></div>
          <div class="field-row"><label>Photo (optional)</label><input type="file" name="findingPhoto" accept="image/*" capture="environment" multiple /></div>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Submit Audit</button>
          <button class="btn btn-secondary" type="button" id="cancelAuditBtn">Cancel</button>
        </div>
      </form>
    </div>`;

  function wireConditionalReveals() {
    document.querySelectorAll('[data-depends-on]').forEach((block) => {
      const key = block.dataset.dependsOn;
      const showWhen = JSON.parse(block.dataset.showWhen);
      const select = document.querySelector(`select[name="prop_${key}"]`);
      if (!select) return;
      const update = () => { block.hidden = !showWhen.includes(select.value); };
      select.addEventListener('change', update);
      update();
    });
  }
  wireConditionalReveals();

  document.getElementById('cancelAuditBtn').addEventListener('click', goBack);
  document.getElementById('auditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const propertiesOut = {};
    properties.fields.forEach((f) => {
      const v = fd.get(`prop_${f.fieldKey}`);
      if (v) propertiesOut[f.fieldKey] = v;
    });
    const componentEvents = [];
    document.querySelectorAll('#componentPromptBlock [data-component]').forEach((card) => {
      const condition = card.querySelector('.comp-condition').value;
      const eventType = card.querySelector('.comp-event').value;
      const material = card.querySelector('.comp-material').value;
      const notes = card.querySelector('.comp-notes').value;
      if (!condition && !material && !notes) return; // skip untouched component cards
      componentEvents.push({ componentType: card.dataset.component, eventType, condition, material, notes });
    });
    const severity = fd.get('findingSeverity');
    const description = fd.get('findingDescription');
    const findingPhotos = fd.getAll('findingPhoto').filter((f) => f && f.size);

    try {
      let finding = null;
      if (severity && description) {
        const photoUrls = [];
        for (const file of findingPhotos) photoUrls.push(await uploadPhotoFile(file, 'findings', id));
        finding = { severity, description, photoUrls };
      }
      await api(`/api/pg/assets/${id}/audit`, { method: 'POST', body: JSON.stringify({ properties: propertiesOut, componentEvents, finding }) });
      toast('Audit submitted');
      state.stack.pop(); // drop this audit entry
      go('assetDetail', { id }, { replace: true });
    } catch (err) { toast(err.message); }
  });
}

async function renderAssetHistory({ id }) {
  setChrome({ title: 'History', showBack: true, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const { asset, history } = await api(`/api/pg/assets/${id}/history`);
  app.innerHTML = `<div class="card"><h3>${escapeHtml(asset.Name)} — Component History</h3></div>` +
    (history.length ? history.map((h) => `
      <div class="card">
        <div><strong>${escapeHtml(h['Component Type'])}</strong> — ${escapeHtml(h['Event Type'] || '')}
          <span class="pill ${conditionPillClass(h.Condition)}">${escapeHtml(h.Condition || '')}</span></div>
        <div class="muted">${escapeHtml(h['Observed/Installed Date'] || '')} · ${escapeHtml(h.Material || '')}</div>
        ${h.Notes ? `<div>${escapeHtml(h.Notes)}</div>` : ''}
      </div>`).join('') : '<p class="muted">No history yet.</p>');
}

async function renderCapitalPlan() {
  setChrome({ title: 'Capital Plan', showBack: false, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const { rows, summary } = await api('/api/pg/capital-plan');
  const buckets = summary.map((b) => `
    <div class="bucket-tile"><div class="n">${b.count}</div><div class="muted">${escapeHtml(b.bucket)}</div>
      <div class="muted">$${Number(b.totalCost || 0).toLocaleString()}</div></div>`).join('');
  const tableRows = rows.map((r) => `
    <tr class="clickable-row" data-asset-id="${r.assetId}">
      <td>${escapeHtml(r.assetName)}</td><td>${escapeHtml(r.locationName || '')}</td>
      <td>${escapeHtml(r.componentType)}</td>
      <td><span class="pill ${conditionPillClass(r.condition)}">${escapeHtml(r.condition || '')}</span></td>
      <td>${r.estReplacementYear ?? '—'}</td>
      <td>${r.estReplacementCost ? '$' + Number(r.estReplacementCost).toLocaleString() : '—'}</td>
      <td>${escapeHtml(r.bucket)}</td>
    </tr>`).join('');
  app.innerHTML = `
    <div class="summary-buckets">${buckets}</div>
    <div class="card" style="overflow-x:auto">
      <table class="report-table">
        <thead><tr><th>Asset</th><th>Location</th><th>Component</th><th>Condition</th><th>Est. Year</th><th>Est. Cost</th><th>Bucket</th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="7" class="muted">No component data yet.</td></tr>'}</tbody>
      </table>
    </div>`;
  app.querySelectorAll('.clickable-row').forEach((tr) => tr.addEventListener('click', () => go('assetDetail', { id: tr.dataset.assetId })));
}

async function renderMaintenanceLog() {
  setChrome({ title: 'Maintenance Log', showBack: false, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const { entries } = await api('/api/pg/maintenance-log');
  app.innerHTML = `<div class="card" style="overflow-x:auto">
    <table class="report-table">
      <thead><tr><th>Date</th><th>Asset</th><th>Component</th><th>Event</th><th>Condition</th><th>Material</th><th>Notes</th></tr></thead>
      <tbody>${entries.map((e) => `
        <tr class="clickable-row" data-asset-id="${e.Asset?.Id ?? ''}">
          <td>${escapeHtml(e['Observed/Installed Date'] || '')}</td>
          <td>${escapeHtml(e.Asset?.Name || '')}</td>
          <td>${escapeHtml(e['Component Type'])}</td>
          <td>${escapeHtml(e['Event Type'] || '')}</td>
          <td>${escapeHtml(e.Condition || '')}</td>
          <td>${escapeHtml(e.Material || '')}</td>
          <td>${escapeHtml(e.Notes || '')}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">No entries yet.</td></tr>'}</tbody>
    </table>
  </div>`;
  app.querySelectorAll('.clickable-row').forEach((tr) => {
    if (!tr.dataset.assetId) return;
    tr.addEventListener('click', () => go('assetDetail', { id: tr.dataset.assetId }));
  });
}

// ---------- Edit Asset (full direct edit — core fields + every property field,
// no conditional hiding, distinct from the guided Audit walkthrough) ----------

async function renderEditAsset({ id }) {
  setChrome({ title: 'Edit Asset', showBack: true, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const [detail, locsRes] = await Promise.all([api(`/api/pg/assets/${id}`), api('/api/pg/locations')]);
  const { asset, properties } = detail;
  const locOptions = locsRes.locations.map((l) => `<option value="${l.Id}" ${asset.locationId === l.Id ? 'selected' : ''}>${escapeHtml(l.Name)}</option>`).join('');
  const buildingTypeOptions = state.options.buildingTypes.map((b) => `<option value="${b.Id}" ${asset.buildingTypeId === b.Id ? 'selected' : ''}>${escapeHtml(b.Name)}</option>`).join('');

  const propertyFieldsHtml = properties.fields.map((f) => {
    const opts = (f.options || []).map((o) => `<option value="${escapeHtml(o)}" ${f.currentValue === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
    return `<div class="field-row">
      <label>${escapeHtml(f.title)}</label>
      ${f.options ? `<select name="prop_${f.fieldKey}"><option value="">— unset —</option>${opts}</select>`
        : `<input name="prop_${f.fieldKey}" type="${f.uidt === 'Number' ? 'number' : 'text'}" value="${escapeHtml(f.currentValue ?? '')}" />`}
    </div>`;
  }).join('');

  app.innerHTML = `
    <div class="card">
      <h3>Edit: ${escapeHtml(asset.Name)}</h3>
      <p class="muted">Direct field edits — no history or findings created. For inspections/condition changes, use Start Audit instead.</p>
      <form id="editAssetForm">
        <div class="field-row"><label>Name</label><input name="core_name" value="${escapeHtml(asset.Name)}" required /></div>
        <div class="field-row"><label>Asset Type</label><input name="core_asset_type" value="${escapeHtml(asset['Asset type'] || '')}" /></div>
        <div class="field-row"><label>Location</label><select name="core_location_id">${locOptions}</select></div>
        <div class="field-row"><label>Building Type</label><select name="core_building_type_id"><option value="">— unset —</option>${buildingTypeOptions}</select></div>
        <div class="field-row"><label>Condition</label><input name="core_condition" value="${escapeHtml(asset.Condition || '')}" placeholder="Good / Fair / Poor / Critical" /></div>
        <div class="field-row"><label>Install/Build Year</label><input name="core_install_build_year" type="number" value="${asset['Install/Build Year'] ?? ''}" /></div>
        <div class="field-row"><label>Lodge Holder</label><input name="core_lodge_holder" value="${escapeHtml(asset['Lodge Holder'] || '')}" /></div>
        <div class="field-row"><label>Description</label><textarea name="core_description">${escapeHtml(asset.Description || '')}</textarea></div>
        <div class="field-row"><label>Notes</label><textarea name="core_notes">${escapeHtml(asset.Notes || '')}</textarea></div>
        <h3>Property Fields</h3>
        ${propertyFieldsHtml}
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Save Changes</button>
          <button class="btn btn-secondary" type="button" id="cancelEditBtn">Cancel</button>
        </div>
      </form>
    </div>`;

  document.getElementById('cancelEditBtn').addEventListener('click', goBack);
  document.getElementById('editAssetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!confirm(`Save these changes to "${asset.Name}"?`)) return;
    const fd = new FormData(e.target);
    const core = {
      name: fd.get('core_name'), asset_type: fd.get('core_asset_type'),
      location_id: fd.get('core_location_id') ? Number(fd.get('core_location_id')) : null,
      building_type_id: fd.get('core_building_type_id') ? Number(fd.get('core_building_type_id')) : null,
      condition: fd.get('core_condition'), install_build_year: fd.get('core_install_build_year') ? Number(fd.get('core_install_build_year')) : null,
      lodge_holder: fd.get('core_lodge_holder'), description: fd.get('core_description'), notes: fd.get('core_notes'),
    };
    const propertiesOut = {};
    properties.fields.forEach((f) => { propertiesOut[f.fieldKey] = fd.get(`prop_${f.fieldKey}`) ?? ''; });
    try {
      await api(`/api/pg/assets/${id}`, { method: 'PATCH', body: JSON.stringify({ core, properties: propertiesOut }) });
      toast('Asset updated');
      go('assetDetail', { id }, { replace: true });
    } catch (err) { toast(err.message); }
  });
}

// ---------- Admin ----------

async function renderAdminHub() {
  setChrome({ title: 'Admin', showBack: false, showLogout: true });
  app.innerHTML = `
    <div class="card"><h3>Schema & Configuration</h3>
      <p class="muted">Everything here takes effect immediately — no deploy, no restart.</p></div>
    <div class="list-item" data-view="adminAddFieldChoice">➕ Add New Field</div>
    <div class="list-item" data-view="adminPropertyFields">🏷️ Property Fields</div>
    <div class="list-item" data-view="adminComponentTypes">🧩 Component Types</div>
    <div class="list-item" data-view="adminBuildingTypes">🏛️ Building Types</div>
    <div class="list-item" data-view="adminApplicability">✅ Applicability Matrix</div>
    <div class="list-item" data-view="adminSubAreas">📐 Component Sub-Areas</div>`;
  app.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => go(el.dataset.view, {})));
}

function renderAdminAddFieldChoice() {
  setChrome({ title: 'Add New Field', showBack: true, showLogout: true });
  app.innerHTML = `
    <div class="card">
      <h3>What kind of thing is this?</h3>
      <p class="muted">This decides where it's stored and how reports treat it — pick carefully, it's not easily changed later.</p>
    </div>
    <div class="card" id="choicePropertyBtn" style="cursor:pointer">
      <h3>🏷️ Asset Property</h3>
      <p class="muted">A stable, single-value fact about the asset that doesn't change often — like Has Key or Window Type. One current value per asset.</p>
    </div>
    <div class="card" id="choiceComponentBtn" style="cursor:pointer">
      <h3>🧩 Component</h3>
      <p class="muted">A part tracked over time with condition + replacement history — like Roof or HVAC. Every audit adds a new event; "current state" is the newest one.</p>
    </div>`;
  document.getElementById('choicePropertyBtn').addEventListener('click', () => go('adminPropertyFields', { openAdd: true }));
  document.getElementById('choiceComponentBtn').addEventListener('click', () => go('adminComponentTypes', { openAdd: true }));
}

async function renderAdminPropertyFields({ openAdd } = {}) {
  setChrome({ title: 'Property Fields', showBack: true, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const { fields } = await api('/api/pg/admin/property-fields');
  const rows = fields.map((f) => `
    <div class="list-item" style="cursor:default">
      <span><strong>${escapeHtml(f.label)}</strong> <span class="muted">(${escapeHtml(f.field_key)}) — ${escapeHtml(f.input_type)}${f.options?.length ? ': ' + f.options.map(escapeHtml).join(', ') : ''}</span></span>
      <button class="btn btn-secondary toggle-active" data-id="${f.id}" data-next="${!f.active}">${f.active ? 'Deactivate' : 'Activate'}</button>
    </div>`).join('') || '<p class="muted">No property fields yet.</p>';

  app.innerHTML = `
    <div class="card"><h3>Property Fields</h3><p class="muted">Stable single-value facts about an asset (like Has Key). ${fields.filter(f=>!f.column_name).length} of these are flexibly stored (added here, no schema change); ${fields.filter(f=>f.column_name).length} are original built-in fields.</p></div>
    ${rows}
    <div class="card">
      <h3>${openAdd ? 'Add Field' : 'Add Another Field'}</h3>
      <form id="addFieldForm">
        <div class="field-row"><label>Label</label><input name="label" placeholder="e.g. Window Type" required /></div>
        <div class="field-row"><label>Field Key (lowercase, no spaces)</label><input name="fieldKey" placeholder="e.g. window_type" pattern="[a-z][a-z0-9_]*" required /></div>
        <div class="field-row"><label>Type</label>
          <select name="inputType">
            <option value="select">Single choice (select)</option>
            <option value="multiselect">Multiple choice (multiselect)</option>
            <option value="text">Free text</option>
            <option value="number">Number</option>
          </select>
        </div>
        <div class="field-row"><label>Options (comma-separated, if applicable)</label><input name="options" placeholder="e.g. Single-Pane, Double-Pane, Storm, Unknown" /></div>
        <button class="btn btn-primary" type="submit">Create Field</button>
      </form>
    </div>`;

  document.querySelector('#addFieldForm [name="label"]').addEventListener('input', (e) => {
    const keyInput = document.querySelector('#addFieldForm [name="fieldKey"]');
    if (!keyInput.dataset.touched) keyInput.value = e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  });
  document.querySelector('#addFieldForm [name="fieldKey"]').addEventListener('input', (e) => { e.target.dataset.touched = 'true'; });

  document.querySelectorAll('.toggle-active').forEach((btn) => btn.addEventListener('click', async () => {
    const action = btn.dataset.next === 'true' ? 'Reactivate' : 'Deactivate';
    if (!confirm(`${action} this field? ${action === 'Deactivate' ? 'It will stop appearing in the audit form and Edit Asset screen (existing data is kept).' : 'It will reappear in the audit form.'}`)) return;
    await api(`/api/pg/admin/property-fields/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.next === 'true' }) });
    renderAdminPropertyFields();
  }));

  document.getElementById('addFieldForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const inputType = fd.get('inputType');
    const options = fd.get('options').split(',').map((s) => s.trim()).filter(Boolean);
    if (!confirm(`Create new property field "${fd.get('label')}"? It'll appear in the audit form for every asset immediately.`)) return;
    try {
      await api('/api/pg/admin/property-fields', { method: 'POST', body: JSON.stringify({ fieldKey: fd.get('fieldKey'), label: fd.get('label'), inputType, options }) });
      toast('Field created — available immediately in the audit form');
      state.options = null; // force refresh of cached options (building types etc. unaffected, but keep it simple)
      renderAdminPropertyFields();
    } catch (err) { toast(err.message); }
  });
}

async function renderAdminComponentTypes({ openAdd } = {}) {
  setChrome({ title: 'Component Types', showBack: true, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const { componentTypes } = await api('/api/pg/admin/component-types');
  const rows = componentTypes.map((c) => `
    <div class="list-item" style="cursor:default">
      <span><strong>${escapeHtml(c.component_type)}</strong> <span class="muted">events: ${c.event_type_options.map(escapeHtml).join(', ')} · conditions: ${c.condition_options.map(escapeHtml).join(', ')}</span></span>
      <label class="muted" style="display:flex;align-items:center;gap:6px"><input type="checkbox" class="prompt-toggle" data-type="${escapeHtml(c.component_type)}" ${c.prompted_in_audit ? 'checked' : ''}/> prompted in audit</label>
    </div>`).join('') || '<p class="muted">No component types yet.</p>';

  app.innerHTML = `
    <div class="card"><h3>Component Types</h3><p class="muted">Parts tracked over time with condition + replacement history. "Prompted in audit" controls whether the walkthrough asks about it (currently gated on Free Standing Building = Yes for all prompted types).</p></div>
    ${rows}
    <div class="card">
      <h3>${openAdd ? 'Add Component Type' : 'Add Another Component Type'}</h3>
      <form id="addCompForm">
        <div class="field-row"><label>Name</label><input name="componentType" placeholder="e.g. Chimney" required /></div>
        <div class="field-row"><label>Event Type Options (comma-separated)</label><input name="eventTypeOptions" value="Installed, Replaced, Inspected, Repaired, Retired" required /></div>
        <div class="field-row"><label>Condition Options (comma-separated)</label><input name="conditionOptions" value="Excellent, Good, Fair, Poor, Failed, Unknown" required /></div>
        <div class="field-row"><label><input type="checkbox" name="promptedInAudit" /> Prompt for this during the audit walkthrough</label></div>
        <button class="btn btn-primary" type="submit">Create Component Type</button>
      </form>
    </div>`;

  document.querySelectorAll('.prompt-toggle').forEach((cb) => cb.addEventListener('change', async () => {
    if (!confirm(`${cb.checked ? 'Start' : 'Stop'} prompting for "${cb.dataset.type}" during the audit walkthrough (when Free Standing Building = Yes)?`)) {
      cb.checked = !cb.checked;
      return;
    }
    await api(`/api/pg/admin/component-types/${encodeURIComponent(cb.dataset.type)}`, { method: 'PATCH', body: JSON.stringify({ promptedInAudit: cb.checked }) });
    toast('Updated');
  }));

  document.getElementById('addCompForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!confirm(`Create new component type "${fd.get('componentType')}"?`)) return;
    try {
      await api('/api/pg/admin/component-types', {
        method: 'POST',
        body: JSON.stringify({
          componentType: fd.get('componentType'),
          eventTypeOptions: fd.get('eventTypeOptions').split(',').map((s) => s.trim()).filter(Boolean),
          conditionOptions: fd.get('conditionOptions').split(',').map((s) => s.trim()).filter(Boolean),
          promptedInAudit: fd.get('promptedInAudit') === 'on',
        }),
      });
      toast('Component type created');
      renderAdminComponentTypes();
    } catch (err) { toast(err.message); }
  });
}

async function renderAdminBuildingTypes() {
  setChrome({ title: 'Building Types', showBack: true, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const { buildingTypes } = await api('/api/pg/admin/building-types');
  const rows = buildingTypes.map((b) => `
    <div class="list-item" style="cursor:default">
      <span>${escapeHtml(b.Name)}</span>
      <button class="btn btn-secondary delete-bt" data-id="${b.Id}">Delete</button>
    </div>`).join('');

  app.innerHTML = `
    <div class="card"><h3>Building Types</h3></div>
    ${rows}
    <div class="card">
      <h3>Add Building Type</h3>
      <form id="addBtForm">
        <div class="field-row"><label>Name</label><input name="name" required /></div>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>
    </div>`;

  document.querySelectorAll('.delete-bt').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Delete this building type? Only works if no assets currently use it.')) return;
    try { await api(`/api/pg/admin/building-types/${btn.dataset.id}`, { method: 'DELETE' }); renderAdminBuildingTypes(); }
    catch (err) { toast(err.message); }
  }));
  document.getElementById('addBtForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name');
    if (!confirm(`Add new building type "${name}"?`)) return;
    try {
      await api('/api/pg/admin/building-types', { method: 'POST', body: JSON.stringify({ name }) });
      renderAdminBuildingTypes();
    } catch (err) { toast(err.message); }
  });
}

async function renderAdminApplicability() {
  setChrome({ title: 'Applicability Matrix', showBack: true, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const { buildingTypes, questionKeys, matrix } = await api('/api/pg/admin/applicability');
  const header = questionKeys.map((q) => `<th>${escapeHtml(q.label)}</th>`).join('');
  const rows = matrix.map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.buildingTypeName)}</strong></td>
      ${row.cells.map((c) => `<td style="text-align:center"><input type="checkbox" class="applies-cb" data-bt="${row.buildingTypeId}" data-qk="${escapeHtml(c.questionKey)}" ${c.applies ? 'checked' : ''}/></td>`).join('')}
    </tr>`).join('');

  app.innerHTML = `
    <div class="card"><h3>Applicability Matrix</h3>
      <p class="muted">Unchecked = that question/component is skipped for that building type during the audit. Checked (default) = it applies.</p>
    </div>
    <div class="card" style="overflow-x:auto">
      <table class="report-table"><thead><tr><th>Building Type</th>${header}</tr></thead><tbody>${rows}</tbody></table>
    </div>`;

  app.querySelectorAll('.applies-cb').forEach((cb) => cb.addEventListener('change', async () => {
    try {
      await api('/api/pg/admin/applicability', { method: 'PUT', body: JSON.stringify({ buildingTypeId: Number(cb.dataset.bt), questionKey: cb.dataset.qk, applies: cb.checked }) });
    } catch (err) { toast(err.message); cb.checked = !cb.checked; }
  }));
}

async function renderAdminSubAreas() {
  setChrome({ title: 'Component Sub-Areas', showBack: true, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const { subAreas } = await api('/api/pg/admin/sub-areas');
  const byType = new Map();
  subAreas.forEach((s) => { if (!byType.has(s.component_type)) byType.set(s.component_type, []); byType.get(s.component_type).push(s); });
  const groups = [...byType.entries()].map(([type, areas]) => `
    <div class="card"><h3>${escapeHtml(type)}</h3>
      ${areas.map((a) => `<div class="list-item" style="cursor:default"><span>${escapeHtml(a.sub_area)}</span><button class="btn btn-secondary delete-sa" data-id="${a.id}" data-name="${escapeHtml(a.sub_area)}" data-type="${escapeHtml(type)}">Delete</button></div>`).join('')}
    </div>`).join('') || '<p class="muted">No sub-areas defined yet.</p>';

  app.innerHTML = `
    <div class="card"><h3>Component Sub-Areas</h3><p class="muted">Optional named parts of a component (e.g. Floor → NE Corner). A component with none behaves as a single whole.</p></div>
    ${groups}
    <div class="card">
      <h3>Add Sub-Area</h3>
      <form id="addSaForm">
        <div class="field-row"><label>Component Type</label><input name="componentType" placeholder="e.g. Floor" required /></div>
        <div class="field-row"><label>Sub-Area Name</label><input name="subArea" placeholder="e.g. NE Corner" required /></div>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>
    </div>`;

  document.querySelectorAll('.delete-sa').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm(`Delete sub-area "${btn.dataset.name}" from ${btn.dataset.type}? This cannot be undone from the app — you'd need to re-add it manually.`)) return;
    await api(`/api/pg/admin/sub-areas/${btn.dataset.id}`, { method: 'DELETE' });
    toast('Sub-area deleted');
    renderAdminSubAreas();
  }));
  document.getElementById('addSaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!confirm(`Add sub-area "${fd.get('subArea')}" to ${fd.get('componentType')}?`)) return;
    try {
      await api('/api/pg/admin/sub-areas', { method: 'POST', body: JSON.stringify({ componentType: fd.get('componentType'), subArea: fd.get('subArea') }) });
      renderAdminSubAreas();
    } catch (err) { toast(err.message); }
  });
}

// ---------- Work Orders ----------

async function renderWorkOrders() {
  setChrome({ title: 'Work Orders', showBack: false, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const { workOrders } = await api('/api/pg/work-orders');
  const rows = workOrders.map((w) => `
    <div class="list-item" data-id="${w.Id}">
      <span>${escapeHtml(w.Title)}${w.Asset ? ` <span class="muted">— ${escapeHtml(w.Asset.Name)}</span>` : ''}</span>
      <span class="pill ${w.Status === 'Done' ? 'good' : w.Priority === 'Urgent' || w.Priority === 'High' ? 'warn' : ''}">${escapeHtml(w.Status || '')} · ${escapeHtml(w.Priority || '')}</span>
    </div>`).join('') || '<p class="muted">No work orders yet.</p>';
  app.innerHTML = `
    <div class="btn-row" style="margin-bottom:12px"><button class="btn btn-primary" id="newWoBtnTop">+ New Work Order</button></div>
    ${rows}`;
  document.getElementById('newWoBtnTop').addEventListener('click', () => go('newWorkOrder', {}));
  app.querySelectorAll('.list-item[data-id]').forEach((el) => el.addEventListener('click', () => go('workOrderDetail', { id: el.dataset.id })));
}

async function renderNewWorkOrder({ assetId, assetName }) {
  setChrome({ title: 'New Work Order', showBack: true, showLogout: true });
  let assets = [];
  if (!assetId) {
    const { locations } = await api('/api/pg/locations');
    const allAssets = await Promise.all(locations.map((l) => api(`/api/pg/locations/${l.Id}/assets`).then((r) => r.assets.map((a) => ({ ...a, locName: l.Name })))));
    assets = allAssets.flat();
  }
  app.innerHTML = `
    <div class="card">
      <h3>New Work Order</h3>
      <form id="newWoForm">
        <div class="field-row"><label>Title</label><input name="title" required /></div>
        ${assetId
          ? `<div class="field-row"><label>Asset</label><input value="${escapeHtml(assetName)}" disabled /></div>`
          : `<div class="field-row"><label>Asset</label><select name="assetId" required><option value="">— select —</option>${assets.map((a) => `<option value="${a.Id}">${escapeHtml(a.Name)} (${escapeHtml(a.locName)})</option>`).join('')}</select></div>`}
        <div class="field-row"><label>Priority</label>
          <select name="priority"><option>Low</option><option selected>Medium</option><option>High</option><option>Urgent</option></select>
        </div>
        <div class="field-row"><label>Description</label><textarea name="description"></textarea></div>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Create Work Order</button>
          <button class="btn btn-secondary" type="button" id="cancelWoBtn">Cancel</button>
        </div>
      </form>
    </div>`;
  document.getElementById('cancelWoBtn').addEventListener('click', goBack);
  document.getElementById('newWoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const title = fd.get('title');
    const finalAssetId = assetId || fd.get('assetId');
    if (!confirm(`Create work order "${title}"?`)) return;
    try {
      const result = await api('/api/pg/work-orders', { method: 'POST', body: JSON.stringify({ title, assetId: Number(finalAssetId), priority: fd.get('priority'), description: fd.get('description') }) });
      toast('Work order created');
      go('workOrderDetail', { id: result.workOrderId }, { replace: true });
    } catch (err) { toast(err.message); }
  });
}

async function renderWorkOrderDetail({ id }) {
  setChrome({ title: 'Work Order', showBack: true, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const [detail, allVolunteers, allVendors] = await Promise.all([
    api(`/api/pg/work-orders/${id}`), api('/api/pg/volunteers'), api('/api/pg/vendors'),
  ]);
  const { workOrder: wo, assetUpdates, volunteers, vendors } = detail;
  const propertyFieldTitles = state.options.propertyFields.map((f) => f.title);

  const jobLineRows = assetUpdates.map((u) => `
    <div class="list-item" style="cursor:default">
      <span>${escapeHtml(u['Target Field'])} → <strong>${escapeHtml(u['New Value'])}</strong></span>
      <span>
        <span class="pill ${u.Applied ? 'good' : ''}">${u.Applied ? 'Applied' : 'Pending'}</span>
        ${!u.Applied ? `<button class="btn btn-secondary delete-au" data-id="${u.Id}" data-label="${escapeHtml(u['Target Field'])}" style="margin-left:8px">Delete</button>` : ''}
      </span>
    </div>`).join('') || '<p class="muted">No job lines yet.</p>';

  const assignedVolIds = new Set(volunteers.map((v) => v.Id));
  const assignedVenIds = new Set(vendors.map((v) => v.Id));
  const availableVols = allVolunteers.volunteers.filter((v) => !assignedVolIds.has(v.Id));
  const availableVens = allVendors.vendors.filter((v) => !assignedVenIds.has(v.Id));

  app.innerHTML = `
    <div class="card">
      <h3>${escapeHtml(wo.Title)}</h3>
      ${wo.Asset ? `<p class="muted">Asset: ${escapeHtml(wo.Asset.Name)}</p>` : ''}
      <form id="woFieldsForm">
        <div class="field-row"><label>Status</label>
          <select name="status">${['Open', 'In Progress', 'On Hold', 'Urgent', 'Done'].map((s) => `<option ${wo.Status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </div>
        <div class="field-row"><label>Priority</label>
          <select name="priority">${['Low', 'Medium', 'High', 'Urgent'].map((s) => `<option ${wo.Priority === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </div>
        <div class="field-row"><label>Description</label><textarea name="description">${escapeHtml(wo.Description || '')}</textarea></div>
        <div class="field-row"><label>Estimated Hours</label><input name="estimatedHours" type="number" value="${wo['Estimated Hours'] ?? ''}" /></div>
        <div class="field-row"><label>Actual Hours</label><input name="actualHours" type="number" value="${wo['Actual Hours'] ?? ''}" /></div>
        <div class="field-row"><label>Estimated Cost</label><input name="estimatedCost" type="number" step="0.01" value="${wo['Estimated Cost'] ?? ''}" /></div>
        <div class="field-row"><label>Actual Cost</label><input name="actualCost" type="number" step="0.01" value="${wo['Actual Cost'] ?? ''}" /></div>
        <button class="btn btn-secondary" type="submit">Save Changes</button>
      </form>
      <div class="btn-row">
        <button class="btn btn-primary" id="completeWoBtn" ${wo.Status === 'Done' ? 'disabled' : ''}>${wo.Status === 'Done' ? 'Completed' : 'Complete Work Order'}</button>
      </div>
    </div>

    <div class="card">
      <h3>Job Lines (Asset Updates)</h3>
      <p class="muted">Applied automatically when you Complete this Work Order.</p>
      ${jobLineRows}
      <form id="addJobLineForm" style="margin-top:10px">
        <div class="field-row"><label>Field</label><select name="targetField" required><option value="">— select —</option>${propertyFieldTitles.map((t) => `<option>${escapeHtml(t)}</option>`).join('')}</select></div>
        <div class="field-row"><label>New Value</label><input name="newValue" required /></div>
        <button class="btn btn-secondary" type="submit">Add Job Line</button>
      </form>
    </div>

    <div class="card">
      <h3>Assigned Crew</h3>
      <h4 style="margin-bottom:6px">Volunteers</h4>
      ${volunteers.map((v) => `<div class="list-item" style="cursor:default"><span>${escapeHtml(v.Name)}</span><button class="btn btn-secondary unassign-vol" data-id="${v.Id}" data-name="${escapeHtml(v.Name)}">Remove</button></div>`).join('') || '<p class="muted">None assigned.</p>'}
      <form id="assignVolForm" style="margin-top:8px">
        <div class="field-row"><select name="volunteerId"><option value="">— add volunteer —</option>${availableVols.map((v) => `<option value="${v.Id}">${escapeHtml(v.Name)}</option>`).join('')}</select></div>
        <button class="btn btn-secondary" type="submit">Assign</button>
      </form>
      <h4 style="margin:16px 0 6px">Vendors</h4>
      ${vendors.map((v) => `<div class="list-item" style="cursor:default"><span>${escapeHtml(v.Name)}</span><button class="btn btn-secondary unassign-ven" data-id="${v.Id}" data-name="${escapeHtml(v.Name)}">Remove</button></div>`).join('') || '<p class="muted">None assigned.</p>'}
      <form id="assignVenForm" style="margin-top:8px">
        <div class="field-row"><select name="vendorId"><option value="">— add vendor —</option>${availableVens.map((v) => `<option value="${v.Id}">${escapeHtml(v.Name)}</option>`).join('')}</select></div>
        <button class="btn btn-secondary" type="submit">Assign</button>
      </form>
    </div>`;

  document.getElementById('woFieldsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!confirm('Save changes to this work order?')) return;
    const fd = new FormData(e.target);
    try {
      await api(`/api/pg/work-orders/${id}`, { method: 'PATCH', body: JSON.stringify({
        status: fd.get('status'), priority: fd.get('priority'), description: fd.get('description'),
        estimatedHours: fd.get('estimatedHours'), actualHours: fd.get('actualHours'),
        estimatedCost: fd.get('estimatedCost'), actualCost: fd.get('actualCost'),
      }) });
      toast('Work order updated');
      renderWorkOrderDetail({ id });
    } catch (err) { toast(err.message); }
  });

  document.getElementById('completeWoBtn').addEventListener('click', async () => {
    if (!confirm(`Complete this Work Order? All pending job lines will be written to "${wo.Asset?.Name || 'the asset'}" immediately — this directly changes real asset data.`)) return;
    try {
      await api(`/api/pg/work-orders/${id}/complete`, { method: 'POST' });
      toast('Work order completed — asset updated');
      renderWorkOrderDetail({ id });
    } catch (err) { toast(err.message); }
  });

  document.getElementById('addJobLineForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!confirm(`Add job line: set "${fd.get('targetField')}" to "${fd.get('newValue')}" when this WO completes?`)) return;
    try {
      await api(`/api/pg/work-orders/${id}/asset-updates`, { method: 'POST', body: JSON.stringify({ targetField: fd.get('targetField'), newValue: fd.get('newValue') }) });
      renderWorkOrderDetail({ id });
    } catch (err) { toast(err.message); }
  });

  app.querySelectorAll('.delete-au').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm(`Delete the "${btn.dataset.label}" job line?`)) return;
    try { await api(`/api/pg/work-orders/${id}/asset-updates/${btn.dataset.id}`, { method: 'DELETE' }); renderWorkOrderDetail({ id }); }
    catch (err) { toast(err.message); }
  }));

  document.getElementById('assignVolForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const volunteerId = new FormData(e.target).get('volunteerId');
    if (!volunteerId) return;
    if (!confirm('Assign this volunteer to the work order?')) return;
    await api(`/api/pg/work-orders/${id}/volunteers`, { method: 'POST', body: JSON.stringify({ volunteerId: Number(volunteerId) }) });
    renderWorkOrderDetail({ id });
  });
  document.getElementById('assignVenForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const vendorId = new FormData(e.target).get('vendorId');
    if (!vendorId) return;
    if (!confirm('Assign this vendor to the work order?')) return;
    await api(`/api/pg/work-orders/${id}/vendors`, { method: 'POST', body: JSON.stringify({ vendorId: Number(vendorId) }) });
    renderWorkOrderDetail({ id });
  });
  app.querySelectorAll('.unassign-vol').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm(`Remove ${btn.dataset.name} from this work order?`)) return;
    await api(`/api/pg/work-orders/${id}/volunteers/${btn.dataset.id}`, { method: 'DELETE' });
    renderWorkOrderDetail({ id });
  }));
  app.querySelectorAll('.unassign-ven').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm(`Remove ${btn.dataset.name} from this work order?`)) return;
    await api(`/api/pg/work-orders/${id}/vendors/${btn.dataset.id}`, { method: 'DELETE' });
    renderWorkOrderDetail({ id });
  }));
}

async function renderCrew() {
  setChrome({ title: 'Crew', showBack: false, showLogout: true });
  app.innerHTML = '<p class="muted">Loading…</p>';
  const [vols, vens] = await Promise.all([api('/api/pg/volunteers'), api('/api/pg/vendors')]);
  app.innerHTML = `
    <div class="card"><h3>Volunteers</h3>
      ${vols.volunteers.map((v) => `<div class="list-item" style="cursor:default"><span>${escapeHtml(v.Name)}</span><span class="muted">${escapeHtml(v['Phone Number'] || '')}</span></div>`).join('') || '<p class="muted">None yet.</p>'}
      <form id="addVolForm" style="margin-top:10px">
        <div class="field-row"><label>Name</label><input name="name" required /></div>
        <div class="field-row"><label>Phone</label><input name="phone" /></div>
        <button class="btn btn-secondary" type="submit">Add Volunteer</button>
      </form>
    </div>
    <div class="card"><h3>Vendors</h3>
      ${vens.vendors.map((v) => `<div class="list-item" style="cursor:default"><span>${escapeHtml(v.Name)}</span><span class="muted">${escapeHtml(v['Phone Number'] || '')}</span></div>`).join('') || '<p class="muted">None yet.</p>'}
      <form id="addVenForm" style="margin-top:10px">
        <div class="field-row"><label>Name</label><input name="name" required /></div>
        <div class="field-row"><label>Phone</label><input name="phone" /></div>
        <button class="btn btn-secondary" type="submit">Add Vendor</button>
      </form>
    </div>`;
  document.getElementById('addVolForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!confirm(`Add volunteer "${fd.get('name')}"?`)) return;
    await api('/api/pg/volunteers', { method: 'POST', body: JSON.stringify({ name: fd.get('name'), phone: fd.get('phone') }) });
    renderCrew();
  });
  document.getElementById('addVenForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!confirm(`Add vendor "${fd.get('name')}"?`)) return;
    await api('/api/pg/vendors', { method: 'POST', body: JSON.stringify({ name: fd.get('name'), phone: fd.get('phone') }) });
    renderCrew();
  });
}

// ---------- Boot ----------

(async function boot() {
  try {
    const res = await fetch('/api/pg/options');
    if (res.status === 401) return render('login');
    // We don't know the username without a /whoami endpoint; the session cookie
    // is enough to proceed, this just skips the "Signed in as ..." label until
    // the next successful /login call populates it.
    state.user = state.user || 'you';
    go('dashboard', {});
  } catch {
    render('login');
  }
})();
