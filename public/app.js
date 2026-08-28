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

const state = {
  user: null,
  options: null,
  stack: [],
};

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
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    state.user = null;
    state.stack = [];
    render('login');
    throw new Error('Not authenticated');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body;
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
  if (prev) go(prev.view, prev.params);
  else go('dashboard', {}, { replace: true });
}

function goToStackIndex(i) {
  state.stack = state.stack.slice(0, i + 1);
  const entry = state.stack[state.stack.length - 1];
  render(entry.view, entry.params);
}

backBtn.addEventListener('click', goBack);
logoutBtn.addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  state.user = null;
  state.stack = [];
  render('login');
});

// ---------- Sidebar (responsive: persistent rail on wide screens, drawer on mobile) ----------

const NAV_ITEMS = [
  { icon: '🏠', label: 'Dashboard', view: 'dashboard' },
  { icon: '📍', label: 'Locations', view: 'locations' },
  { icon: '🛠️', label: 'Work Orders', view: 'workOrders' },
  { icon: '📋', label: 'Maintenance Log', view: 'maintenanceLog' },
  { icon: '💰', label: 'Capital Plan', view: 'capitalPlan' },
  { icon: '📧', label: 'Reports', view: 'reports' },
  { icon: '🗂️', label: 'Manage Data', view: 'manageTables' },
];

const VIEW_TO_NAV_SECTION = {
  dashboard: 'dashboard',
  locations: 'locations', assets: 'locations', assetDetail: 'locations', audit: 'locations', assetHistory: 'locations',
  workOrders: 'workOrders', workOrderDetail: 'workOrders', newWorkOrder: 'workOrders',
  maintenanceLog: 'maintenanceLog',
  capitalPlan: 'capitalPlan',
  reports: 'reports',
  manageTables: 'manageTables', manageList: 'manageTables', manageRecord: 'manageTables',
};

function openSidebar() { sidebar.classList.add('open'); sidebarOverlay.hidden = false; }
function closeSidebar() { sidebar.classList.remove('open'); sidebarOverlay.hidden = true; }
menuBtn.addEventListener('click', openSidebar);
document.getElementById('closeSidebarBtn').addEventListener('click', closeSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);

function renderSidebarNav(view) {
  const activeSection = VIEW_TO_NAV_SECTION[view] || null;
  sidebarNavEl.innerHTML = NAV_ITEMS.map((item) => `
    <button class="nav-item ${activeSection === item.view ? 'active' : ''}" data-nav-view="${item.view}">
      <span class="nav-icon">${item.icon}</span> ${escapeHtml(item.label)}
    </button>
  `).join('');
  sidebarNavEl.querySelectorAll('[data-nav-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeSidebar();
      go(btn.dataset.navView, {});
    });
  });
  sidebarUserEl.textContent = state.user && state.user !== true ? `Logged in as ${state.user}` : '';
}

// ---------- Breadcrumbs ----------

function breadcrumbLabel(entry) {
  switch (entry.view) {
    case 'dashboard': return 'Dashboard';
    case 'locations': return 'Locations';
    case 'assets': return entry.params.locationName || 'Assets';
    case 'assetDetail': return entry.params.assetName || 'Asset';
    case 'audit': return entry.params.assetName || 'Audit';
    case 'assetHistory': return entry.params.assetName ? `${entry.params.assetName} History` : 'History';
    case 'workOrders': return 'Work Orders';
    case 'newWorkOrder': return 'New Work Order';
    case 'workOrderDetail': return 'Work Order';
    case 'maintenanceLog': return 'Maintenance Log';
    case 'capitalPlan': return 'Capital Plan';
    case 'reports': return 'Reports';
    case 'manageTables': return 'Manage Data';
    case 'manageList': return entry.params.tableTitle || 'Records';
    case 'manageRecord': return entry.params.tableTitle
      ? (entry.params.recordId ? `Edit ${entry.params.tableTitle}` : `New ${entry.params.tableTitle}`)
      : 'Record';
    default: return entry.view;
  }
}

function renderBreadcrumbs() {
  if (state.stack.length <= 1) { breadcrumbsEl.hidden = true; breadcrumbsEl.innerHTML = ''; return; }
  breadcrumbsEl.hidden = false;
  breadcrumbsEl.innerHTML = state.stack.map((entry, i) => {
    const isLast = i === state.stack.length - 1;
    const label = escapeHtml(breadcrumbLabel(entry));
    return isLast
      ? `<span class="crumb-current">${label}</span>`
      : `<a data-crumb-index="${i}">${label}</a><span class="crumb-sep">&rsaquo;</span>`;
  }).join('');
  breadcrumbsEl.querySelectorAll('[data-crumb-index]').forEach((el) => {
    el.addEventListener('click', () => goToStackIndex(Number(el.dataset.crumbIndex)));
  });
}

// ---------- Global search (always visible once logged in) ----------

let searchDebounce;
globalSearchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = globalSearchInput.value.trim();
  if (!q) { globalSearchResults.hidden = true; globalSearchResults.innerHTML = ''; return; }
  searchDebounce = setTimeout(() => runGlobalSearch(q), 200);
});
globalSearchInput.addEventListener('focus', () => {
  if (globalSearchInput.value.trim() && globalSearchResults.innerHTML) globalSearchResults.hidden = false;
});
document.addEventListener('click', (e) => {
  if (!globalSearchWrap.contains(e.target)) globalSearchResults.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') globalSearchResults.hidden = true;
});

async function runGlobalSearch(q) {
  let data;
  try {
    data = await api(`/api/search?q=${encodeURIComponent(q)}`);
  } catch {
    return;
  }
  const locHtml = data.locations.length ? `
    <div class="result-group-title">Locations</div>
    ${data.locations.map((l) => `
      <div class="result-item" data-search-location="${l.Id}" data-search-name="${escapeHtml(l.Name)}">
        ${escapeHtml(l.Name)} <span class="meta">${escapeHtml(l['Location Type'] || '')}</span>
      </div>
    `).join('')}
  ` : '';
  const assetHtml = data.assets.length ? `
    <div class="result-group-title">Assets</div>
    ${data.assets.map((a) => `
      <div class="result-item" data-search-asset="${a.Id}" data-search-name="${escapeHtml(a.Name)}">
        ${escapeHtml(a.Name)} <span class="meta">${escapeHtml(a.locationName || '')}</span>
      </div>
    `).join('')}
  ` : '';
  globalSearchResults.innerHTML = (locHtml || assetHtml)
    ? locHtml + assetHtml
    : `<div class="no-results">No matches for "${escapeHtml(q)}"</div>`;
  globalSearchResults.hidden = false;

  globalSearchResults.querySelectorAll('[data-search-location]').forEach((el) => {
    el.addEventListener('click', () => {
      globalSearchInput.value = '';
      globalSearchResults.hidden = true;
      go('assets', { locationId: el.dataset.searchLocation, locationName: el.dataset.searchName });
    });
  });
  globalSearchResults.querySelectorAll('[data-search-asset]').forEach((el) => {
    el.addEventListener('click', () => {
      globalSearchInput.value = '';
      globalSearchResults.hidden = true;
      go('assetDetail', { assetId: el.dataset.searchAsset, assetName: el.dataset.searchName });
    });
  });
}

async function render(view, params = {}) {
  app.innerHTML = '<div class="spinner">Loading…</div>';
  if (view === 'login') {
    breadcrumbsEl.hidden = true;
  } else {
    renderSidebarNav(view);
    renderBreadcrumbs();
  }
  try {
    switch (view) {
      case 'login': return await renderLogin();
      case 'dashboard': return await renderDashboard();
      case 'locations': return await renderLocations();
      case 'assets': return await renderAssets(params);
      case 'assetDetail': return await renderAssetDetail(params);
      case 'audit': return await renderAudit(params);
      case 'workOrders': return await renderWorkOrders();
      case 'newWorkOrder': return await renderNewWorkOrder(params);
      case 'workOrderDetail': return await renderWorkOrderDetail(params);
      case 'assetHistory': return await renderAssetHistory(params);
      case 'maintenanceLog': return await renderMaintenanceLog();
      case 'capitalPlan': return await renderCapitalPlan();
      case 'reports': return await renderReports();
      case 'manageTables': return await renderManageTables();
      case 'manageList': return await renderManageList(params);
      case 'manageRecord': return await renderManageRecord(params);
      default: return await renderDashboard();
    }
  } catch (e) {
    app.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`;
  }
}

// ---------- Login ----------
function renderLogin() {
  setChrome({ title: 'Camp Sychar Audit', showBack: false, showLogout: false });
  app.innerHTML = `
    <div class="card">
      <label>Username</label>
      <input type="text" id="loginUser" autocomplete="username" />
      <label>Password</label>
      <input type="password" id="loginPass" autocomplete="current-password" />
      <div id="loginError"></div>
      <button class="btn btn-primary" id="loginBtn">Log In</button>
    </div>
  `;
  document.getElementById('loginBtn').addEventListener('click', doLogin);
  document.getElementById('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

async function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.innerHTML = '';
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || 'Login failed');
    state.user = body.user;
    state.stack = [];
    go('dashboard');
  } catch (e) {
    errEl.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`;
  }
}

// ---------- Dashboard (default landing screen) ----------

const ACTIVITY_ICONS = { component: '🔧', finding: '⚠️', workorder: '🛠️' };

async function renderDashboard() {
  setChrome({ title: 'Dashboard', showBack: false, showLogout: true });
  const { entries } = await api('/api/activity');
  app.innerHTML = `
    <div class="section-title">Recent Activity</div>
    ${entries.length ? entries.map((e) => `
      <div class="list-item" data-kind="${e.kind}" data-wo-id="${e.woId || ''}" data-asset-id="${e.assetId || ''}" data-asset-name="${escapeHtml(e.assetName || '')}">
        <div>
          <div>${ACTIVITY_ICONS[e.kind] || '•'} ${escapeHtml(e.title)}</div>
          <div class="meta">${escapeHtml(e.assetName || '')}${e.assetName && e.detail ? ' · ' : ''}${escapeHtml(e.detail || '')}</div>
          <div class="meta">${escapeHtml((e.at || '').slice(0, 16))}</div>
        </div>
        <span class="chev">&rsaquo;</span>
      </div>
    `).join('') : `<div class="empty">No activity yet — start an audit or create a Work Order.</div>`}
  `;
  app.querySelectorAll('.list-item').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.kind === 'workorder' && el.dataset.woId) {
        go('workOrderDetail', { woId: el.dataset.woId });
      } else if (el.dataset.assetId) {
        go('assetDetail', { assetId: el.dataset.assetId, assetName: el.dataset.assetName });
      }
    });
  });
}

// ---------- Locations ----------
async function renderLocations() {
  setChrome({ title: 'Locations', showBack: false, showLogout: true });
  const { locations } = await api('/api/locations');
  app.innerHTML = `
    <input type="text" id="locSearch" class="search-box" placeholder="Search locations…" />
    <div id="locList"></div>
  `;
  const listEl = document.getElementById('locList');
  function draw(filter) {
    const f = (filter || '').toLowerCase();
    const filtered = locations.filter((l) => (l.Name || '').toLowerCase().includes(f));
    listEl.innerHTML = filtered.length
      ? filtered.map((l) => `
        <div class="list-item" data-id="${l.Id}">
          <div>
            <div>${escapeHtml(l.Name || '(unnamed location)')}</div>
            <div class="meta">${escapeHtml(l['Location Type'] || '')}</div>
          </div>
          <span class="chev">&rsaquo;</span>
        </div>
      `).join('')
      : `<div class="empty">No locations match.</div>`;
    listEl.querySelectorAll('.list-item').forEach((el) => {
      el.addEventListener('click', () => go('assets', {
        locationId: el.dataset.id,
        locationName: locations.find((l) => String(l.Id) === el.dataset.id)?.Name || 'Assets',
      }));
    });
  }
  draw('');
  document.getElementById('locSearch').addEventListener('input', (e) => draw(e.target.value));
}

// ---------- Assets ----------
async function renderAssets({ locationId, locationName }) {
  setChrome({ title: locationName || 'Assets', showBack: true, showLogout: true });
  const { assets } = await api(`/api/locations/${locationId}/assets`);
  app.innerHTML = assets.length
    ? assets.map((a) => `
      <div class="list-item" data-id="${a.Id}">
        <div>
          <div>${escapeHtml(a.Name)}</div>
          <div class="meta">${escapeHtml(a['Asset type'] || '')}${a.Condition ? ' · ' + escapeHtml(a.Condition) : ''}</div>
        </div>
        <span class="chev">&rsaquo;</span>
      </div>
    `).join('')
    : `<div class="empty">No assets at this location yet.</div>`;
  app.querySelectorAll('.list-item').forEach((el) => {
    el.addEventListener('click', () => go('assetDetail', {
      assetId: el.dataset.id,
      assetName: assets.find((a) => String(a.Id) === el.dataset.id)?.Name,
    }));
  });
}

// ---------- Asset detail hub ----------

async function renderAssetDetail({ assetId, assetName }) {
  setChrome({ title: assetName || 'Asset', showBack: true, showLogout: true });
  const { asset, components, workOrders, conditionFindings } = await api(`/api/assets/${assetId}`);

  const currentEntries = Object.entries(components.current);
  const currentHtml = currentEntries.length
    ? `<div class="section-title">Current Components</div><div class="card">${currentEntries.map(([type, s]) => `
        <div class="meta"><strong>${escapeHtml(type)}</strong>: ${escapeHtml(s.condition || 'unknown')}${s.material ? ' · ' + escapeHtml(s.material) : ''}${s.estReplacementYear ? ` · replace ~${s.estReplacementYear}` : ''}</div>
      `).join('')}</div>`
    : '';

  const woHtml = workOrders.length
    ? workOrders.map((w) => `
      <div class="list-item" data-wo-id="${w.Id}">
        <div><div>${escapeHtml(w.Title)}</div><div class="meta">${escapeHtml(w.Priority || '')}</div></div>
        <span class="badge ${w.Status === 'Done' ? 'done' : 'open'}">${escapeHtml(w.Status || '')}</span>
      </div>
    `).join('')
    : `<div class="empty">No Work Orders for this asset yet.</div>`;

  const cfHtml = conditionFindings.length
    ? conditionFindings.map((f) => `
      <div class="list-item" data-cf-id="${f.Id}">
        <div><div>${escapeHtml(f.Title || 'Finding')}</div><div class="meta">${escapeHtml(f.Severity || '')}</div></div>
        <span class="badge ${f.Status === 'Resolved' ? 'done' : 'open'}">${escapeHtml(f.Status || '')}</span>
      </div>
    `).join('')
    : `<div class="empty">No Condition Findings for this asset yet.</div>`;

  app.innerHTML = `
    <div class="card">
      <strong>${escapeHtml(asset.Name)}</strong>
      <div class="meta">${escapeHtml(asset['Asset type'] || '')}${asset.Condition ? ' · ' + escapeHtml(asset.Condition) : ''}</div>
    </div>
    ${currentHtml}
    <button class="btn btn-primary" id="startAuditBtn">Start / Continue Audit</button>
    <button class="btn btn-secondary" id="assetHistoryBtn">View History</button>
    <button class="btn btn-secondary" id="assetNewWoBtn">Create Work Order</button>
    <div class="section-title">Work Orders</div>
    ${woHtml}
    <div class="section-title">Condition Findings</div>
    ${cfHtml}
  `;

  document.getElementById('startAuditBtn').addEventListener('click', () => go('audit', { assetId, assetName }));
  document.getElementById('assetHistoryBtn').addEventListener('click', () => go('assetHistory', { assetId, assetName }));
  document.getElementById('assetNewWoBtn').addEventListener('click', () => go('newWorkOrder', { assetId, assetName }));
  app.querySelectorAll('[data-wo-id]').forEach((el) => {
    el.addEventListener('click', () => go('workOrderDetail', { woId: el.dataset.woId }));
  });
  app.querySelectorAll('[data-cf-id]').forEach((el) => {
    el.addEventListener('click', () => go('manageRecord', { tableKey: 'conditionFindings', tableTitle: 'Condition Findings', recordId: el.dataset.cfId }));
  });
}

// ---------- Audit ----------
function fieldVisible(field, dependencies, answers) {
  const dep = dependencies.find((d) => d.reveals.includes(field.title));
  if (!dep) return true;
  const controllerValue = answers[dep.field];
  if (controllerValue == null) return false;
  const values = Array.isArray(controllerValue) ? controllerValue : [controllerValue];
  return values.some((v) => dep.showWhen.includes(v));
}

function componentSectionVisible(schema, answers) {
  const dep = schema.promptWhen;
  if (!dep) return false;
  return dep.showWhen.includes(answers[dep.field]);
}

async function renderAudit({ assetId, assetName }) {
  setChrome({ title: assetName || 'Audit', showBack: true, showLogout: true });
  const [{ asset, properties, components }, options] = await Promise.all([
    api(`/api/assets/${assetId}`),
    getOptions(),
  ]);

  const answers = {};
  properties.fields.forEach((f) => {
    if (f.currentValue == null) return;
    answers[f.title] = f.multi ? String(f.currentValue).split(',').filter(Boolean) : f.currentValue;
  });

  let findingOpen = false;
  const finding = { severity: '', description: '', title: '' };

  // One panel per audited component type (Roof/Siding/Foundation), prefilled from
  // current state where it exists. Panels start closed — logging an event is an
  // explicit action, not implied by just viewing the audit screen.
  const componentPanels = {};
  components.schema.promptTypes.forEach((type) => {
    const cur = components.current[type];
    componentPanels[type] = {
      open: false,
      eventType: 'Inspected',
      material: cur?.material || '',
      condition: cur?.condition || '',
      estLifeYears: '',
      estReplacementCost: '',
      notes: '',
    };
  });

  function fieldHtml(f) {
    if (!fieldVisible(f, properties.dependencies, answers)) return '';
    if (f.options) {
      const selected = f.multi ? (answers[f.title] || []) : [answers[f.title]];
      const opts = f.options.map((o) => `
        <button type="button" class="option-btn ${selected.includes(o) ? 'selected' : ''}" data-field="${escapeHtml(f.title)}" data-value="${escapeHtml(o)}" data-multi="${f.multi}">${escapeHtml(o)}</button>
      `).join('');
      return `<div class="field-group"><label>${escapeHtml(f.title)}</label><div class="option-row">${opts}</div></div>`;
    }
    return `
      <div class="field-group">
        <label>${escapeHtml(f.title)}</label>
        <input type="text" data-text-field="${escapeHtml(f.title)}" value="${escapeHtml(answers[f.title] || '')}" />
      </div>
    `;
  }

  function componentPanelHtml(type) {
    const cur = components.current[type];
    const panel = componentPanels[type];
    const summary = cur
      ? `Current: ${escapeHtml(cur.material || 'unknown material')}, ${escapeHtml(cur.condition || 'unknown condition')}${cur.installedDate ? ` (installed ${escapeHtml(cur.installedDate)})` : ''}${cur.estReplacementYear ? ` · est. replacement ${cur.estReplacementYear}` : ''}`
      : 'No history yet for this component.';

    if (!panel.open) {
      return `
        <div class="field-group">
          <button type="button" class="finding-toggle" data-open-component="${escapeHtml(type)}">+ Log ${escapeHtml(type)} Update</button>
          <div class="meta">${summary}</div>
        </div>
      `;
    }

    const eventOpts = components.schema.eventTypeOptions.map((o) => `<option value="${escapeHtml(o)}" ${panel.eventType === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
    const condOpts = components.schema.conditionOptions.map((o) => `<option value="${escapeHtml(o)}" ${panel.condition === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
    return `
      <div class="section-title">${escapeHtml(type)}</div>
      <div class="card" data-component-panel="${escapeHtml(type)}">
        <div class="meta">${summary}</div>
        <label>Event Type</label>
        <select data-comp-field="eventType">${eventOpts}</select>
        <label>Condition</label>
        <select data-comp-field="condition"><option value="">Select…</option>${condOpts}</select>
        <label>Material</label>
        <input type="text" data-comp-field="material" value="${escapeHtml(panel.material)}" />
        <label>Est Life (years)</label>
        <input type="number" data-comp-field="estLifeYears" value="${escapeHtml(panel.estLifeYears)}" />
        <label>Est Replacement Cost</label>
        <input type="number" data-comp-field="estReplacementCost" value="${escapeHtml(panel.estReplacementCost)}" />
        <label>Notes</label>
        <textarea data-comp-field="notes">${escapeHtml(panel.notes)}</textarea>
        <button type="button" class="btn btn-secondary" data-close-component="${escapeHtml(type)}">Remove</button>
      </div>
    `;
  }

  function findingHtml() {
    if (!findingOpen) {
      return `<button type="button" class="finding-toggle" id="openFinding">+ Report a Finding</button>`;
    }
    const sevOpts = options.findingSeverity.map((s) => `<option value="${escapeHtml(s)}" ${finding.severity === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');
    return `
      <div class="section-title">Condition Finding</div>
      <div class="card">
        <label>Severity</label>
        <select id="findSeverity"><option value="">Select…</option>${sevOpts}</select>
        <label>Description</label>
        <textarea id="findDescription" placeholder="What's wrong?">${escapeHtml(finding.description)}</textarea>
        <button type="button" class="btn btn-secondary" id="removeFinding">Remove Finding</button>
      </div>
    `;
  }

  function draw() {
    const showComponents = componentSectionVisible(components.schema, answers);
    app.innerHTML = `
      <div class="card">
        <strong>${escapeHtml(asset.Name)}</strong>
        <div class="meta">${escapeHtml(asset['Asset type'] || '')}</div>
      </div>
      ${properties.fields.length === 0 ? `<div class="empty">No audit questions are configured yet — tag Assets columns with <code>@asset-property</code> in NocoDB.</div>` : ''}
      <div id="fields">${properties.fields.map(fieldHtml).join('')}</div>
      ${showComponents ? `<div class="section-title">Components</div>${components.schema.promptTypes.map(componentPanelHtml).join('')}` : ''}
      <div id="findingArea">${findingHtml()}</div>
      <div id="submitError"></div>
      <button class="btn btn-primary" id="submitBtn">Save Audit</button>
      <button class="btn btn-secondary" id="historyBtn">View History</button>
      <button class="btn btn-secondary" id="newWoBtn">Create Work Order for this Asset</button>
    `;

    app.querySelectorAll('.option-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field;
        const value = btn.dataset.value;
        const multi = btn.dataset.multi === 'true';
        if (multi) {
          const cur = new Set(answers[field] || []);
          if (cur.has(value)) cur.delete(value); else cur.add(value);
          answers[field] = Array.from(cur);
        } else {
          answers[field] = answers[field] === value ? undefined : value;
        }
        draw();
      });
    });
    app.querySelectorAll('[data-text-field]').forEach((el) => {
      el.addEventListener('change', () => { answers[el.dataset.textField] = el.value; });
    });

    app.querySelectorAll('[data-open-component]').forEach((el) => {
      el.addEventListener('click', () => { componentPanels[el.dataset.openComponent].open = true; draw(); });
    });
    app.querySelectorAll('[data-close-component]').forEach((el) => {
      el.addEventListener('click', () => { componentPanels[el.dataset.closeComponent].open = false; draw(); });
    });
    app.querySelectorAll('[data-component-panel]').forEach((panelEl) => {
      const type = panelEl.dataset.componentPanel;
      panelEl.querySelectorAll('[data-comp-field]').forEach((el) => {
        el.addEventListener('change', () => { componentPanels[type][el.dataset.compField] = el.value; });
      });
    });

    const openBtn = document.getElementById('openFinding');
    if (openBtn) openBtn.addEventListener('click', () => { findingOpen = true; draw(); });
    const removeBtn = document.getElementById('removeFinding');
    if (removeBtn) removeBtn.addEventListener('click', () => { findingOpen = false; finding.severity = ''; finding.description = ''; draw(); });
    const sevEl = document.getElementById('findSeverity');
    if (sevEl) sevEl.addEventListener('change', () => { finding.severity = sevEl.value; });
    const descEl = document.getElementById('findDescription');
    if (descEl) descEl.addEventListener('change', () => { finding.description = descEl.value; });

    document.getElementById('submitBtn').addEventListener('click', () => submit());
    document.getElementById('historyBtn').addEventListener('click', () => go('assetHistory', { assetId, assetName: asset.Name }));
    document.getElementById('newWoBtn').addEventListener('click', () => go('newWorkOrder', { assetId, assetName: asset.Name }));
  }

  async function submit() {
    const errEl = document.getElementById('submitError');
    errEl.innerHTML = '';
    if (findingOpen && (!finding.severity || !finding.description)) {
      errEl.innerHTML = `<div class="error-box">Severity and description are required to save a finding.</div>`;
      return;
    }
    const openPanels = Object.entries(componentPanels).filter(([, p]) => p.open);
    const missingCondition = openPanels.find(([, p]) => !p.condition);
    if (missingCondition) {
      errEl.innerHTML = `<div class="error-box">Pick a Condition for ${escapeHtml(missingCondition[0])}, or tap Remove to skip it.</div>`;
      return;
    }

    const visibleProps = {};
    properties.fields.forEach((f) => {
      if (fieldVisible(f, properties.dependencies, answers) && answers[f.title] !== undefined) {
        visibleProps[f.title] = answers[f.title];
      }
    });

    const componentEvents = openPanels.map(([type, p]) => ({
      componentType: type,
      eventType: p.eventType,
      condition: p.condition,
      material: p.material || undefined,
      estLifeYears: p.estLifeYears ? Number(p.estLifeYears) : undefined,
      estReplacementCost: p.estReplacementCost ? Number(p.estReplacementCost) : undefined,
      notes: p.notes || undefined,
    }));

    const payload = {
      properties: visibleProps,
      componentEvents,
      finding: findingOpen ? { severity: finding.severity, description: finding.description, title: finding.title || undefined } : null,
    };
    try {
      document.getElementById('submitBtn').textContent = 'Saving…';
      await api(`/api/assets/${assetId}/audit`, { method: 'POST', body: JSON.stringify(payload) });
      toast('Audit saved');
      goBack();
    } catch (e) {
      errEl.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`;
      document.getElementById('submitBtn').textContent = 'Save Audit';
    }
  }

  draw();
}

// ---------- Options cache ----------
async function getOptions() {
  if (state.options) return state.options;
  const opts = await api('/api/options');
  state.options = opts;
  return opts;
}

// ---------- Work Orders ----------
async function renderWorkOrders() {
  setChrome({ title: 'Work Orders', showBack: true, showLogout: true });
  const { workOrders } = await api('/api/work-orders');
  app.innerHTML = `
    <button class="btn btn-primary" id="newWoTopBtn">+ New Work Order</button>
    ${workOrders.length
      ? workOrders.map((w) => `
        <div class="list-item" data-id="${w.Id}">
          <div>
            <div>${escapeHtml(w.Title)}</div>
            <div class="meta">${escapeHtml(w.Asset?.Name || '')}${w.Priority ? ' · ' + escapeHtml(w.Priority) : ''}</div>
          </div>
          <span class="badge ${w.Status === 'Done' ? 'done' : 'open'}">${escapeHtml(w.Status || '')}</span>
        </div>
      `).join('')
      : `<div class="empty">No Work Orders yet.</div>`}
  `;
  document.getElementById('newWoTopBtn').addEventListener('click', () => go('newWorkOrder', {}));
  app.querySelectorAll('.list-item').forEach((el) => {
    el.addEventListener('click', () => go('workOrderDetail', { woId: el.dataset.id }));
  });
}

async function renderWorkOrderDetail({ woId }) {
  setChrome({ title: 'Work Order', showBack: true, showLogout: true });
  const [options, allVolunteers, allVendors] = await Promise.all([
    getOptions(),
    api('/api/manage/volunteers/records'),
    api('/api/manage/vendors/records'),
  ]);
  let data;
  let jobLineOpen = false;
  let volunteerPickerOpen = false;
  let vendorPickerOpen = false;

  async function reload() {
    data = await api(`/api/work-orders/${woId}`);
    draw();
  }

  function detailsCardHtml() {
    const wo = data.workOrder;
    const opt = (list, current) => list.map((v) => `<option value="${escapeHtml(v)}" ${current === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
    return `
      <div class="card">
        <label>Title</label>
        <input type="text" data-wo-field="title" value="${escapeHtml(wo.Title || '')}" />
        <div class="au-row">
          <div style="flex:1">
            <label>Status</label>
            <select data-wo-field="status">${opt(options.workOrderStatus, wo.Status)}</select>
          </div>
          <div style="flex:1">
            <label>Priority</label>
            <select data-wo-field="priority">${opt(options.workOrderPriority, wo.Priority)}</select>
          </div>
        </div>
        <label>Description</label>
        <textarea data-wo-field="description">${escapeHtml(wo.Description || '')}</textarea>
        <div class="au-row">
          <div style="flex:1"><label>Date Reported</label><input type="date" data-wo-field="dateReported" value="${escapeHtml(wo['Date Reported'] || '')}" /></div>
          <div style="flex:1"><label>Date Completed</label><input type="date" data-wo-field="dateCompleted" value="${escapeHtml(wo['Date Completed'] || '')}" /></div>
        </div>
        <div class="au-row">
          <div style="flex:1"><label>Est. Hours</label><input type="number" step="1" data-wo-field="estimatedHours" value="${escapeHtml(wo['Estimated Hours'] ?? '')}" /></div>
          <div style="flex:1"><label>Actual Hours</label><input type="number" step="1" data-wo-field="actualHours" value="${escapeHtml(wo['Actual Hours'] ?? '')}" /></div>
        </div>
        <div class="au-row">
          <div style="flex:1"><label>Est. Cost</label><input type="number" data-wo-field="estimatedCost" value="${escapeHtml(wo['Estimated Cost'] ?? '')}" /></div>
          <div style="flex:1"><label>Actual Cost</label><input type="number" data-wo-field="actualCost" value="${escapeHtml(wo['Actual Cost'] ?? '')}" /></div>
        </div>
        <button class="btn btn-primary" id="saveWoBtn">Save Changes</button>
      </div>
    `;
  }

  function jobLinesHtml() {
    const list = data.assetUpdates.length
      ? data.assetUpdates.map((u) => `
        <div class="card">
          ${escapeHtml(u['Target Field'])} &rarr; ${escapeHtml(u['New Value'])}
          <span class="badge ${u.Applied ? 'done' : 'open'}">${u.Applied ? 'Applied' : 'Pending'}</span>
          ${!u.Applied ? `<button type="button" class="remove-row" data-remove-jobline="${u.Id}">&times;</button>` : ''}
        </div>
      `).join('')
      : `<div class="empty">No job lines yet.</div>`;
    const addForm = jobLineOpen ? `
      <div class="au-row">
        <select id="jlField"><option value="">Field…</option>${options.workOrderTargetFields.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('')}</select>
        <input type="text" id="jlValue" placeholder="New value" />
        <button type="button" class="btn btn-primary btn-small" id="jlAddBtn">Add</button>
      </div>
    ` : `<button type="button" class="finding-toggle" id="jlOpenBtn">+ Add Job Line</button>`;
    return `<div class="section-title">Job Lines</div>${list}${addForm}`;
  }

  function peopleHtml() {
    const volChips = data.volunteers.length
      ? data.volunteers.map((v) => `<div class="list-item" style="cursor:default"><div>${escapeHtml(v.Name)}</div><button type="button" class="remove-row" data-unassign-vol="${v.Id}">&times;</button></div>`).join('')
      : `<div class="empty">No volunteers assigned.</div>`;
    const unassignedVols = allVolunteers.records.filter((v) => !data.volunteers.some((dv) => dv.Id === v.Id));
    const volAdd = volunteerPickerOpen ? `
      <div class="au-row">
        <select id="volPick">${unassignedVols.map((v) => `<option value="${v.Id}">${escapeHtml(v.Name)}</option>`).join('') || '<option value="">No volunteers available</option>'}</select>
        <button type="button" class="btn btn-primary btn-small" id="volAddBtn">Assign</button>
      </div>
    ` : `<button type="button" class="finding-toggle" id="volOpenBtn">+ Assign Volunteer</button>`;

    const venChips = data.vendors.length
      ? data.vendors.map((v) => `<div class="list-item" style="cursor:default"><div>${escapeHtml(v.Name)}</div><button type="button" class="remove-row" data-unassign-ven="${v.Id}">&times;</button></div>`).join('')
      : `<div class="empty">No vendors assigned.</div>`;
    const unassignedVens = allVendors.records.filter((v) => !data.vendors.some((dv) => dv.Id === v.Id));
    const venAdd = vendorPickerOpen ? `
      <div class="au-row">
        <select id="venPick">${unassignedVens.map((v) => `<option value="${v.Id}">${escapeHtml(v.Name)}</option>`).join('') || '<option value="">No vendors available</option>'}</select>
        <button type="button" class="btn btn-primary btn-small" id="venAddBtn">Assign</button>
      </div>
    ` : `<button type="button" class="finding-toggle" id="venOpenBtn">+ Assign Vendor</button>`;

    return `
      <div class="section-title">Volunteers</div>${volChips}${volAdd}
      <div class="section-title">Vendors</div>${venChips}${venAdd}
    `;
  }

  function photosHtml() {
    const grid = data.photos.length
      ? `<div class="photo-grid">${data.photos.map((p) => `
        <div class="photo-thumb">
          <img src="${p.url}" alt="${escapeHtml(p.title || 'photo')}" />
          <button type="button" class="photo-remove" data-remove-photo="${p.id}">&times;</button>
        </div>
      `).join('')}</div>`
      : `<div class="empty">No photos yet.</div>`;
    return `
      <div class="section-title">Photos</div>
      ${grid}
      <input type="file" id="photoInput" accept="image/*" hidden />
      <button type="button" class="btn btn-secondary" id="addPhotoBtn">+ Add Photo</button>
    `;
  }

  function draw() {
    const wo = data.workOrder;
    app.innerHTML = `
      ${detailsCardHtml()}
      ${jobLinesHtml()}
      ${peopleHtml()}
      ${photosHtml()}
      ${wo.Status !== 'Done' ? `<button class="btn btn-primary" id="completeBtn">Mark Complete &amp; Apply Changes</button>` : ''}
    `;

    document.getElementById('saveWoBtn').addEventListener('click', async () => {
      const get = (f) => document.querySelector(`[data-wo-field="${f}"]`).value;
      try {
        await api(`/api/work-orders/${woId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: get('title'),
            status: get('status'),
            priority: get('priority'),
            description: get('description'),
            dateReported: get('dateReported'),
            dateCompleted: get('dateCompleted'),
            estimatedHours: get('estimatedHours'),
            actualHours: get('actualHours'),
            estimatedCost: get('estimatedCost'),
            actualCost: get('actualCost'),
          }),
        });
        toast('Saved');
        reload();
      } catch (e) { toast(e.message); }
    });

    const jlOpenBtn = document.getElementById('jlOpenBtn');
    if (jlOpenBtn) jlOpenBtn.addEventListener('click', () => { jobLineOpen = true; draw(); });
    const jlAddBtn = document.getElementById('jlAddBtn');
    if (jlAddBtn) jlAddBtn.addEventListener('click', async () => {
      const targetField = document.getElementById('jlField').value;
      const newValue = document.getElementById('jlValue').value;
      if (!targetField || !newValue) { toast('Pick a field and a value'); return; }
      try {
        await api(`/api/work-orders/${woId}/asset-updates`, { method: 'POST', body: JSON.stringify({ targetField, newValue }) });
        jobLineOpen = false;
        reload();
      } catch (e) { toast(e.message); }
    });
    app.querySelectorAll('[data-remove-jobline]').forEach((el) => {
      el.addEventListener('click', async () => {
        try { await api(`/api/work-orders/${woId}/asset-updates/${el.dataset.removeJobline}`, { method: 'DELETE' }); reload(); }
        catch (e) { toast(e.message); }
      });
    });

    const volOpenBtn = document.getElementById('volOpenBtn');
    if (volOpenBtn) volOpenBtn.addEventListener('click', () => { volunteerPickerOpen = true; draw(); });
    const volAddBtn = document.getElementById('volAddBtn');
    if (volAddBtn) volAddBtn.addEventListener('click', async () => {
      const volunteerId = document.getElementById('volPick').value;
      if (!volunteerId) return;
      try { await api(`/api/work-orders/${woId}/volunteers`, { method: 'POST', body: JSON.stringify({ volunteerId }) }); volunteerPickerOpen = false; reload(); }
      catch (e) { toast(e.message); }
    });
    app.querySelectorAll('[data-unassign-vol]').forEach((el) => {
      el.addEventListener('click', async () => {
        try { await api(`/api/work-orders/${woId}/volunteers/${el.dataset.unassignVol}`, { method: 'DELETE' }); reload(); }
        catch (e) { toast(e.message); }
      });
    });

    const venOpenBtn = document.getElementById('venOpenBtn');
    if (venOpenBtn) venOpenBtn.addEventListener('click', () => { vendorPickerOpen = true; draw(); });
    const venAddBtn = document.getElementById('venAddBtn');
    if (venAddBtn) venAddBtn.addEventListener('click', async () => {
      const vendorId = document.getElementById('venPick').value;
      if (!vendorId) return;
      try { await api(`/api/work-orders/${woId}/vendors`, { method: 'POST', body: JSON.stringify({ vendorId }) }); vendorPickerOpen = false; reload(); }
      catch (e) { toast(e.message); }
    });
    app.querySelectorAll('[data-unassign-ven]').forEach((el) => {
      el.addEventListener('click', async () => {
        try { await api(`/api/work-orders/${woId}/vendors/${el.dataset.unassignVen}`, { method: 'DELETE' }); reload(); }
        catch (e) { toast(e.message); }
      });
    });

    const addPhotoBtn = document.getElementById('addPhotoBtn');
    const photoInput = document.getElementById('photoInput');
    if (addPhotoBtn) addPhotoBtn.addEventListener('click', () => photoInput.click());
    if (photoInput) photoInput.addEventListener('change', async () => {
      const file = photoInput.files[0];
      if (!file) return;
      const form = new FormData();
      form.append('photo', file);
      addPhotoBtn.textContent = 'Uploading…';
      try {
        const res = await fetch(`/api/work-orders/${woId}/photos`, { method: 'POST', body: form });
        if (res.status === 401) { render('login'); return; }
        const body = await res.json();
        if (!res.ok || body.ok === false) throw new Error(body.error || 'Upload failed');
        toast('Photo added');
        reload();
      } catch (e) {
        toast(e.message);
        addPhotoBtn.textContent = '+ Add Photo';
      }
    });
    app.querySelectorAll('[data-remove-photo]').forEach((el) => {
      el.addEventListener('click', async () => {
        try { await api(`/api/work-orders/${woId}/photos/${el.dataset.removePhoto}`, { method: 'DELETE' }); reload(); }
        catch (e) { toast(e.message); }
      });
    });

    const completeBtn = document.getElementById('completeBtn');
    if (completeBtn) {
      completeBtn.addEventListener('click', async () => {
        completeBtn.textContent = 'Applying…';
        try {
          await api(`/api/work-orders/${woId}/complete`, { method: 'POST' });
          toast('Work Order completed');
          reload();
        } catch (e) {
          toast(e.message);
          completeBtn.textContent = 'Mark Complete & Apply Changes';
        }
      });
    }
  }

  await reload();
}

async function renderNewWorkOrder({ assetId, assetName }) {
  setChrome({ title: 'New Work Order', showBack: true, showLogout: true });
  const options = await getOptions();
  const rows = [];
  const selected = { id: assetId || null, name: assetName || null };

  function rowHtml(row, i) {
    const fieldOpts = options.workOrderTargetFields.map((f) => `<option value="${escapeHtml(f)}" ${row.targetField === f ? 'selected' : ''}>${escapeHtml(f)}</option>`).join('');
    return `
      <div class="au-row" data-i="${i}">
        <select data-au-field="${i}"><option value="">Field…</option>${fieldOpts}</select>
        <input type="text" placeholder="New value" data-au-value="${i}" value="${escapeHtml(row.newValue || '')}" />
        <button type="button" class="remove-row" data-remove="${i}">&times;</button>
      </div>
    `;
  }

  function assetPickerHtml() {
    if (selected.id) {
      return `
        <div class="field-group">
          <label>Asset</label>
          <div class="list-item" style="cursor:default">
            <div>${escapeHtml(selected.name || `#${selected.id}`)}</div>
            <button type="button" class="btn btn-secondary btn-small" id="changeAssetBtn">Change</button>
          </div>
        </div>
      `;
    }
    return `
      <div class="field-group">
        <label>Asset</label>
        <input type="text" id="assetPickerInput" placeholder="Search assets…" autocomplete="off" />
        <div id="assetPickerResults"></div>
      </div>
    `;
  }

  function draw() {
    const prioOpts = options.workOrderPriority.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    app.innerHTML = `
      <div class="card">
        ${assetPickerHtml()}
        <label>Title</label>
        <input type="text" id="woTitle" value="${selected.name ? 'Fix: ' + escapeHtml(selected.name) : ''}" />
        <label>Priority</label>
        <select id="woPriority">${prioOpts}</select>
        <label>Description</label>
        <textarea id="woDescription"></textarea>
      </div>
      <div class="section-title">Asset Field Changes (optional)</div>
      <div id="auRows">${rows.map(rowHtml).join('')}</div>
      <button type="button" class="btn btn-secondary" id="addRow">+ Add Field Change</button>
      <div id="woError"></div>
      <button class="btn btn-primary" id="createWoBtn">Create Work Order</button>
    `;
    document.getElementById('addRow').addEventListener('click', () => { rows.push({ targetField: '', newValue: '' }); draw(); });
    app.querySelectorAll('[data-au-field]').forEach((el) => {
      el.addEventListener('change', () => { rows[Number(el.dataset.auField)].targetField = el.value; });
    });
    app.querySelectorAll('[data-au-value]').forEach((el) => {
      el.addEventListener('change', () => { rows[Number(el.dataset.auValue)].newValue = el.value; });
    });
    app.querySelectorAll('[data-remove]').forEach((el) => {
      el.addEventListener('click', () => { rows.splice(Number(el.dataset.remove), 1); draw(); });
    });
    document.getElementById('createWoBtn').addEventListener('click', submit);

    const changeBtn = document.getElementById('changeAssetBtn');
    if (changeBtn) changeBtn.addEventListener('click', () => { selected.id = null; selected.name = null; draw(); });

    const pickerInput = document.getElementById('assetPickerInput');
    if (pickerInput) {
      let debounce;
      pickerInput.addEventListener('input', () => {
        clearTimeout(debounce);
        const q = pickerInput.value.trim();
        const resultsEl = document.getElementById('assetPickerResults');
        if (!q) { resultsEl.innerHTML = ''; return; }
        debounce = setTimeout(async () => {
          const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
          resultsEl.innerHTML = data.assets.length
            ? data.assets.map((a) => `
              <div class="list-item" data-pick-id="${a.Id}" data-pick-name="${escapeHtml(a.Name)}">
                <div>${escapeHtml(a.Name)}<div class="meta">${escapeHtml(a.locationName || '')}</div></div>
              </div>
            `).join('')
            : `<div class="empty">No assets match.</div>`;
          resultsEl.querySelectorAll('[data-pick-id]').forEach((el) => {
            el.addEventListener('click', () => {
              selected.id = el.dataset.pickId;
              selected.name = el.dataset.pickName;
              draw();
            });
          });
        }, 200);
      });
    }
  }

  async function submit() {
    const errEl = document.getElementById('woError');
    errEl.innerHTML = '';
    if (!selected.id) { errEl.innerHTML = `<div class="error-box">Pick an asset first.</div>`; return; }
    const title = document.getElementById('woTitle').value.trim();
    if (!title) { errEl.innerHTML = `<div class="error-box">Title is required.</div>`; return; }
    const payload = {
      title,
      assetId: selected.id,
      priority: document.getElementById('woPriority').value,
      description: document.getElementById('woDescription').value,
      assetUpdates: rows.filter((r) => r.targetField && r.newValue),
    };
    try {
      document.getElementById('createWoBtn').textContent = 'Creating…';
      const res = await api('/api/work-orders', { method: 'POST', body: JSON.stringify(payload) });
      toast('Work Order created');
      go('workOrderDetail', { woId: res.workOrder.Id }, { replace: true });
    } catch (e) {
      errEl.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`;
      document.getElementById('createWoBtn').textContent = 'Create Work Order';
    }
  }

  draw();
}

// ---------- Reports ----------
function historyRowHtml(e) {
  const clickable = e.Asset?.Id ? `data-asset-id="${e.Asset.Id}" data-asset-name="${escapeHtml(e.Asset.Name)}"` : '';
  return `
    <div class="card ${e.Asset?.Id ? 'clickable-card' : ''}" ${clickable}>
      <strong>${escapeHtml(e['Observed/Installed Date'] || '(no date)')}</strong> —
      ${escapeHtml(e['Component Type'] || '')} · ${escapeHtml(e['Event Type'] || '')}
      ${e.Asset?.Name ? `<div class="meta">${escapeHtml(e.Asset.Name)}</div>` : ''}
      <div class="meta">${escapeHtml(e.Material || '')}${e.Material && e.Condition ? ' · ' : ''}${escapeHtml(e.Condition || '')}</div>
      ${e['Est Replacement Cost'] != null ? `<div class="meta">Cost: $${escapeHtml(e['Est Replacement Cost'])}</div>` : ''}
      ${e.Notes ? `<p>${escapeHtml(e.Notes)}</p>` : ''}
    </div>
  `;
}

function wireHistoryRowClicks(container) {
  container.querySelectorAll('[data-asset-id]').forEach((el) => {
    el.addEventListener('click', () => go('assetHistory', { assetId: el.dataset.assetId, assetName: el.dataset.assetName }));
  });
}

async function renderAssetHistory({ assetId, assetName }) {
  setChrome({ title: assetName ? `${assetName} History` : 'History', showBack: true, showLogout: true });
  const { history } = await api(`/api/assets/${assetId}/history`);
  app.innerHTML = history.length
    ? history.map(historyRowHtml).join('')
    : `<div class="empty">No component history logged for this asset yet.</div>`;
}

async function renderMaintenanceLog() {
  setChrome({ title: 'Maintenance Log', showBack: true, showLogout: true });
  const options = await getOptions();
  const filters = { componentType: '', eventType: '' };

  async function draw() {
    const qs = new URLSearchParams();
    if (filters.componentType) qs.set('componentType', filters.componentType);
    if (filters.eventType) qs.set('eventType', filters.eventType);
    const { entries } = await api(`/api/maintenance-log${qs.toString() ? `?${qs}` : ''}`);

    const typeOpts = options.componentTypeOptions.map((t) => `<option value="${escapeHtml(t)}" ${filters.componentType === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
    const eventOpts = options.eventTypeOptions.map((t) => `<option value="${escapeHtml(t)}" ${filters.eventType === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');

    app.innerHTML = `
      <div class="au-row">
        <select id="filterType"><option value="">All Component Types</option>${typeOpts}</select>
        <select id="filterEvent"><option value="">All Event Types</option>${eventOpts}</select>
      </div>
      <div id="logEntries">${entries.length ? entries.map(historyRowHtml).join('') : `<div class="empty">No maintenance log entries match.</div>`}</div>
    `;
    document.getElementById('filterType').addEventListener('change', (e) => { filters.componentType = e.target.value; draw(); });
    document.getElementById('filterEvent').addEventListener('change', (e) => { filters.eventType = e.target.value; draw(); });
    wireHistoryRowClicks(app);
  }

  draw();
}

async function renderCapitalPlan() {
  setChrome({ title: 'Capital Plan', showBack: true, showLogout: true });
  const options = await getOptions();
  const filters = { componentType: '', condition: '' };

  async function draw() {
    const qs = new URLSearchParams();
    if (filters.componentType) qs.set('componentType', filters.componentType);
    if (filters.condition) qs.set('condition', filters.condition);
    const { rows, summary } = await api(`/api/capital-plan${qs.toString() ? `?${qs}` : ''}`);

    const summaryHtml = summary.map((s) => `
      <div class="card">
        <strong>${escapeHtml(s.bucket)}</strong>
        <div class="meta">${s.count} component${s.count === 1 ? '' : 's'}${s.totalCost ? ` · $${s.totalCost.toLocaleString()}` : ''}</div>
      </div>
    `).join('');

    const typeOpts = options.componentTypeOptions.map((t) => `<option value="${escapeHtml(t)}" ${filters.componentType === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
    const condOpts = options.conditionOptions.map((c) => `<option value="${escapeHtml(c)}" ${filters.condition === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');

    const rowsHtml = rows.length
      ? rows.map((r) => `
        <div class="list-item" data-asset-id="${r.assetId}" data-asset-name="${escapeHtml(r.assetName)}">
          <div>
            <div><strong>${escapeHtml(r.componentType)}</strong> — ${escapeHtml(r.assetName)}</div>
            <div class="meta">${escapeHtml(r.locationName || '')}${r.locationName ? ' · ' : ''}${escapeHtml(r.condition || 'no condition logged')}${r.material ? ' · ' + escapeHtml(r.material) : ''}</div>
            <div class="meta">Est. replacement: ${r.estReplacementYear || '—'}${r.estReplacementCost != null ? ` · $${r.estReplacementCost.toLocaleString()}` : ''} <span class="badge">${escapeHtml(r.bucket)}</span></div>
          </div>
          <span class="chev">&rsaquo;</span>
        </div>
      `).join('')
      : `<div class="empty">No component data yet. Log some via the audit flow.</div>`;

    app.innerHTML = `
      <div class="section-title">Funding Forecast</div>
      ${summaryHtml}
      <div class="section-title">Components (soonest replacement first)</div>
      <div class="au-row">
        <select id="filterType"><option value="">All Component Types</option>${typeOpts}</select>
        <select id="filterCondition"><option value="">All Conditions</option>${condOpts}</select>
      </div>
      <div id="planRows">${rowsHtml}</div>
    `;

    document.getElementById('filterType').addEventListener('change', (e) => { filters.componentType = e.target.value; draw(); });
    document.getElementById('filterCondition').addEventListener('change', (e) => { filters.condition = e.target.value; draw(); });
    app.querySelectorAll('[data-asset-id]').forEach((el) => {
      el.addEventListener('click', () => go('assetHistory', { assetId: el.dataset.assetId, assetName: el.dataset.assetName }));
    });
  }

  draw();
}

// ---------- Reports (generate, preview, print/download, email) ----------

function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const REPORT_TYPES = [
  { value: 'summary', label: 'Activity Summary' },
  { value: 'detailed', label: 'Detailed Activity Log' },
  { value: 'capital', label: 'Capital Plan' },
];

async function renderReports() {
  setChrome({ title: 'Reports', showBack: true, showLogout: true });
  const todayStr = new Date().toISOString().slice(0, 10);
  const monthAgoStr = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const form = { type: 'summary', from: monthAgoStr, to: todayStr };
  let report = null;

  function draw() {
    const isDated = form.type !== 'capital';
    app.innerHTML = `
      <div class="card">
        <label>Report Type</label>
        <select id="repType">${REPORT_TYPES.map((t) => `<option value="${t.value}" ${form.type === t.value ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}</select>
        ${isDated ? `
          <div class="au-row">
            <div style="flex:1"><label>From</label><input type="date" id="repFrom" value="${form.from}" /></div>
            <div style="flex:1"><label>To</label><input type="date" id="repTo" value="${form.to}" /></div>
          </div>
        ` : `<div class="meta" style="margin-top:10px;">Capital Plan is a current-state snapshot — no date range.</div>`}
        <button class="btn btn-primary" id="genBtn">Generate</button>
      </div>
      <div id="reportArea"></div>
    `;
    document.getElementById('repType').addEventListener('change', (e) => { form.type = e.target.value; draw(); });
    document.getElementById('genBtn').addEventListener('click', generate);
    if (report) drawReportArea();
  }

  async function generate() {
    const fromEl = document.getElementById('repFrom');
    const toEl = document.getElementById('repTo');
    if (fromEl) form.from = fromEl.value;
    if (toEl) form.to = toEl.value;
    const genBtn = document.getElementById('genBtn');
    genBtn.textContent = 'Generating…';
    try {
      const qs = new URLSearchParams({ type: form.type });
      if (form.type !== 'capital') {
        if (form.from) qs.set('from', form.from);
        if (form.to) qs.set('to', form.to);
      }
      report = await api(`/api/reports/preview?${qs}`);
      drawReportArea();
    } catch (e) {
      toast(e.message);
    } finally {
      genBtn.textContent = 'Generate';
    }
  }

  function drawReportArea() {
    const areaEl = document.getElementById('reportArea');
    areaEl.innerHTML = `
      <div class="section-title">${escapeHtml(report.title)}</div>
      <iframe id="reportFrame" style="width:100%;height:420px;border:1px solid var(--border);border-radius:var(--radius);background:#fff;"></iframe>
      <button class="btn btn-secondary" id="printBtn">Print / Save as PDF</button>
      <button class="btn btn-secondary" id="dlHtmlBtn">Download HTML</button>
      <button class="btn btn-secondary" id="dlTextBtn">Download Text</button>
      <div class="section-title">Email It</div>
      <div class="card">
        <label>Recipient</label>
        <input type="text" id="repRecipient" value="ben@fracturedrv.com" />
        <label>Subject</label>
        <input type="text" id="repSubject" value="Camp Sychar — ${escapeHtml(report.title)}" />
        <div id="repEmailError"></div>
        <button class="btn btn-primary" id="sendBtn">Send Email</button>
      </div>
    `;
    const frame = document.getElementById('reportFrame');
    frame.srcdoc = report.html;

    document.getElementById('printBtn').addEventListener('click', () => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    });
    document.getElementById('dlHtmlBtn').addEventListener('click', () => downloadBlob(report.html, `${slugify(report.title)}.html`, 'text/html'));
    document.getElementById('dlTextBtn').addEventListener('click', () => downloadBlob(report.text, `${slugify(report.title)}.txt`, 'text/plain'));
    document.getElementById('sendBtn').addEventListener('click', async () => {
      const errEl = document.getElementById('repEmailError');
      errEl.innerHTML = '';
      const recipient = document.getElementById('repRecipient').value.trim();
      const subject = document.getElementById('repSubject').value.trim();
      if (!recipient) { errEl.innerHTML = `<div class="error-box">Enter a recipient email.</div>`; return; }
      const sendBtn = document.getElementById('sendBtn');
      sendBtn.textContent = 'Sending…';
      try {
        await api('/api/reports/send', {
          method: 'POST',
          body: JSON.stringify({ type: form.type, from: form.from, to: form.to, recipient, subject }),
        });
        toast('Report emailed');
      } catch (e) {
        errEl.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`;
      } finally {
        sendBtn.textContent = 'Send Email';
      }
    });
  }

  draw();
}

// ---------- Manage (generic schema-driven CRUD across all tables) ----------

async function renderManageTables() {
  setChrome({ title: 'Manage Data', showBack: true, showLogout: true });
  const { tables } = await api('/api/manage/tables');
  app.innerHTML = tables.map((t) => `
    <div class="list-item" data-key="${escapeHtml(t.key)}" data-title="${escapeHtml(t.title)}">
      <div>${escapeHtml(t.title)}</div>
      <span class="chev">&rsaquo;</span>
    </div>
  `).join('');
  app.querySelectorAll('.list-item').forEach((el) => {
    el.addEventListener('click', () => go('manageList', { tableKey: el.dataset.key, tableTitle: el.dataset.title }));
  });
}

async function renderManageList({ tableKey, tableTitle }) {
  setChrome({ title: tableTitle, showBack: true, showLogout: true });
  const { records, primaryField } = await api(`/api/manage/${tableKey}/records`);
  app.innerHTML = `
    <input type="text" id="mgSearch" class="search-box" placeholder="Search ${escapeHtml(tableTitle)}…" />
    <button class="btn btn-primary" id="mgNewBtn">+ New ${escapeHtml(tableTitle)}</button>
    <div id="mgList"></div>
  `;
  const listEl = document.getElementById('mgList');
  function draw(filter) {
    const f = (filter || '').toLowerCase();
    const filtered = records.filter((r) => String(r[primaryField] || '').toLowerCase().includes(f));
    listEl.innerHTML = filtered.length
      ? filtered.map((r) => `
        <div class="list-item" data-id="${r.Id}">
          <div>${escapeHtml(r[primaryField] || `#${r.Id}`)}</div>
          <span class="chev">&rsaquo;</span>
        </div>
      `).join('')
      : `<div class="empty">No records match.</div>`;
    listEl.querySelectorAll('.list-item').forEach((el) => {
      el.addEventListener('click', () => go('manageRecord', { tableKey, tableTitle, recordId: el.dataset.id }));
    });
  }
  draw('');
  document.getElementById('mgSearch').addEventListener('input', (e) => draw(e.target.value));
  document.getElementById('mgNewBtn').addEventListener('click', () => go('manageRecord', { tableKey, tableTitle, recordId: null }));
}

async function renderManageRecord({ tableKey, tableTitle, recordId }) {
  const isNew = recordId == null;
  setChrome({ title: isNew ? `New ${tableTitle}` : `Edit ${tableTitle}`, showBack: true, showLogout: true });

  const [schema, recordResp] = await Promise.all([
    api(`/api/manage/${tableKey}/schema`),
    isNew ? Promise.resolve({ record: {} }) : api(`/api/manage/${tableKey}/records/${recordId}`),
  ]);
  const record = recordResp.record;

  // Prefetch picker options for every editable link field, from the related table.
  const linkFields = schema.fields.filter((f) => f.kind === 'link' && f.editable);
  const pickerData = {};
  await Promise.all(linkFields.map(async (f) => {
    pickerData[f.title] = await api(`/api/manage/${f.relatedTableKey}/records`);
  }));

  const values = {};
  schema.fields.forEach((f) => {
    if (f.kind === 'link') {
      values[f.title] = f.editable ? (record[f.title]?.Id ?? '') : null;
    } else if (f.kind === 'multiselect') {
      values[f.title] = record[f.title] ? String(record[f.title]).split(',').filter(Boolean) : [];
    } else if (f.kind === 'checkbox') {
      values[f.title] = !!record[f.title];
    } else {
      values[f.title] = record[f.title] ?? '';
    }
  });

  function fieldHtml(f) {
    if (f.kind === 'readonly') {
      const raw = record[f.title];
      const display = raw && typeof raw === 'object' ? (raw.Name ?? JSON.stringify(raw)) : raw;
      if (isNew || display == null || display === '') return '';
      return `<div class="field-group"><label>${escapeHtml(f.title)}</label><div class="meta">${escapeHtml(display)}</div></div>`;
    }
    if (f.kind === 'attachment') {
      return `<div class="field-group"><label>${escapeHtml(f.title)}</label><div class="meta">${escapeHtml(f.note)}</div></div>`;
    }
    if (f.kind === 'link' && !f.editable) {
      if (isNew) return '';
      const raw = record[f.title];
      const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      const names = items.map((i) => escapeHtml(i.Name ?? i.Title ?? `#${i.Id}`)).join(', ') || '—';
      return `<div class="field-group"><label>${escapeHtml(f.title)}</label><div class="meta">${names} (set from the ${escapeHtml(f.relatedTableTitle || 'related')} record instead)</div></div>`;
    }
    if (f.kind === 'link' && f.editable) {
      const { records: related, primaryField: relatedPrimary } = pickerData[f.title];
      const opts = related.map((r) => `<option value="${r.Id}" ${String(values[f.title]) === String(r.Id) ? 'selected' : ''}>${escapeHtml(r[relatedPrimary] || `#${r.Id}`)}</option>`).join('');
      return `<div class="field-group"><label>${escapeHtml(f.title)}</label><select data-field="${escapeHtml(f.title)}"><option value="">— none —</option>${opts}</select></div>`;
    }
    if (f.kind === 'select') {
      const opts = f.options.map((o) => `<option value="${escapeHtml(o)}" ${values[f.title] === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
      return `<div class="field-group"><label>${escapeHtml(f.title)}</label><select data-field="${escapeHtml(f.title)}"><option value="">— none —</option>${opts}</select></div>`;
    }
    if (f.kind === 'multiselect') {
      const opts = f.options.map((o) => `
        <button type="button" class="option-btn ${values[f.title].includes(o) ? 'selected' : ''}" data-msfield="${escapeHtml(f.title)}" data-value="${escapeHtml(o)}">${escapeHtml(o)}</button>
      `).join('');
      return `<div class="field-group"><label>${escapeHtml(f.title)}</label><div class="option-row">${opts}</div></div>`;
    }
    if (f.kind === 'checkbox') {
      return `<div class="field-group"><label><input type="checkbox" data-field="${escapeHtml(f.title)}" ${values[f.title] ? 'checked' : ''} /> ${escapeHtml(f.title)}</label></div>`;
    }
    if (f.kind === 'longtext') {
      return `<div class="field-group"><label>${escapeHtml(f.title)}</label><textarea data-field="${escapeHtml(f.title)}">${escapeHtml(values[f.title])}</textarea></div>`;
    }
    const inputType = f.kind === 'number' || f.kind === 'currency' ? 'number' : f.kind === 'date' ? 'date' : 'text';
    return `<div class="field-group"><label>${escapeHtml(f.title)}</label><input type="${inputType}" data-field="${escapeHtml(f.title)}" value="${escapeHtml(values[f.title])}" /></div>`;
  }

  app.innerHTML = `
    <div id="mgFields">${schema.fields.map(fieldHtml).join('')}</div>
    <div id="mgError"></div>
    <button class="btn btn-primary" id="mgSaveBtn">${isNew ? 'Create' : 'Save Changes'}</button>
    ${!isNew ? `<button class="btn btn-danger" id="mgDeleteBtn">Delete</button>` : ''}
  `;

  app.querySelectorAll('[data-msfield]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.msfield;
      const value = btn.dataset.value;
      const cur = new Set(values[field]);
      if (cur.has(value)) cur.delete(value); else cur.add(value);
      values[field] = Array.from(cur);
      btn.classList.toggle('selected');
    });
  });

  function collectPayload() {
    const fields = {};
    const links = {};
    schema.fields.forEach((f) => {
      if (!f.editable) return;
      if (f.kind === 'link') {
        const el = document.querySelector(`[data-field="${CSS.escape(f.title)}"]`);
        links[f.title] = el && el.value ? Number(el.value) : null;
      } else if (f.kind === 'multiselect') {
        fields[f.title] = values[f.title];
      } else if (f.kind === 'checkbox') {
        const el = document.querySelector(`[data-field="${CSS.escape(f.title)}"]`);
        fields[f.title] = el ? el.checked : false;
      } else {
        const el = document.querySelector(`[data-field="${CSS.escape(f.title)}"]`);
        if (!el) return;
        fields[f.title] = f.kind === 'number' || f.kind === 'currency'
          ? (el.value === '' ? null : Number(el.value))
          : (el.value || null);
      }
    });
    return { fields, links };
  }

  document.getElementById('mgSaveBtn').addEventListener('click', async () => {
    const errEl = document.getElementById('mgError');
    errEl.innerHTML = '';
    const payload = collectPayload();
    try {
      document.getElementById('mgSaveBtn').textContent = 'Saving…';
      if (isNew) {
        await api(`/api/manage/${tableKey}/records`, { method: 'POST', body: JSON.stringify(payload) });
      } else {
        await api(`/api/manage/${tableKey}/records/${recordId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      }
      toast(isNew ? `${tableTitle} created` : 'Saved');
      go('manageList', { tableKey, tableTitle }, { replace: true });
    } catch (e) {
      errEl.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`;
      document.getElementById('mgSaveBtn').textContent = isNew ? 'Create' : 'Save Changes';
    }
  });

  const deleteBtn = document.getElementById('mgDeleteBtn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete this ${tableTitle} record? This can't be undone.`)) return;
      try {
        await api(`/api/manage/${tableKey}/records/${recordId}`, { method: 'DELETE' });
        toast('Deleted');
        go('manageList', { tableKey, tableTitle }, { replace: true });
      } catch (e) {
        toast(e.message);
      }
    });
  }
}

// ---------- Boot ----------
(async function init() {
  try {
    const res = await fetch('/api/options');
    if (res.status === 401) { render('login'); return; }
    state.user = true;
    go('dashboard');
  } catch {
    render('login');
  }
})();
