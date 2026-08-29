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

// In-page replacement for the browser's window.confirm — a floating modal
// instead of native browser chrome. Resolves true/false the same way, so
// every call site just becomes `await confirmDialog(...)`.
function confirmDialog(message, { confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" role="alertdialog" aria-modal="true">
        <p class="modal-message">${escapeHtml(message)}</p>
        <div class="btn-row" style="justify-content:flex-end;margin-top:18px">
          <button type="button" class="btn btn-secondary modal-cancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} modal-confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    function close(result) {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(result);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') close(true);
    }
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    overlay.querySelector('.modal-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.modal-confirm').addEventListener('click', () => close(true));
    document.addEventListener('keydown', onKeydown);
    overlay.querySelector('.modal-confirm').focus();
  });
}

// Sets #app's content and replays the fade-in — every view render should go
// through this instead of `app.innerHTML =` directly, so view swaps feel like
// transitions rather than instant flashes.
function setApp(html) {
  app.innerHTML = html;
  app.classList.remove('view-fade');
  void app.offsetWidth; // force reflow so the animation replays
  app.classList.add('view-fade');
}

const LOADING_HTML = '<div class="loading-wrap"><div class="spinner"></div><span>Loading…</span></div>';

// ---- Table/Cards view toggle (Maintenance Log & Capital Plan) — persists
// per-browser via localStorage; defaults by screen width on first visit.
function getTableViewMode() {
  const saved = localStorage.getItem('campAuditTableView');
  if (saved === 'cards' || saved === 'table') return saved;
  return window.matchMedia('(max-width: 640px)').matches ? 'cards' : 'table';
}
function tableViewToggleHtml(mode) {
  return `<div class="view-toggle">
    <button type="button" class="view-toggle-btn ${mode === 'table' ? 'active' : ''}" data-mode="table">☰ Table</button>
    <button type="button" class="view-toggle-btn ${mode === 'cards' ? 'active' : ''}" data-mode="cards">▦ Cards</button>
  </div>`;
}
function wireTableViewToggle(onChange) {
  document.querySelectorAll('.view-toggle-btn').forEach((btn) => btn.addEventListener('click', () => {
    localStorage.setItem('campAuditTableView', btn.dataset.mode);
    onChange();
  }));
}

// Ordinal urgency → status color, reused for the Capital Plan bucket tiles
// AND the bucket pill on each row, so the color means the same thing in both
// places. Uses the same 4 semantic tokens as conditionPillClass below.
function bucketColorKey(bucket) {
  if (bucket === 'Overdue') return 'bad';
  if (bucket === '0–2 yrs') return 'pop';
  if (bucket === '3–5 yrs') return 'warn';
  if (bucket === '5+ yrs') return 'good';
  return 'neutral';
}

// Reusable searchable/creatable asset picker. Mounts into `container` (an
// empty element you provide), always searches the live DB (never a cached
// list — see the migration brief's "dynamic assets" requirement), and offers
// "+ Add new asset" when nothing matches. Call this once per container;
// returns { getSelected() } so the caller can read the chosen asset on submit.
function mountAssetCombobox(container, { initialAsset = null, onSelect = () => {} } = {}) {
  let selected = initialAsset;
  let searchTimer;
  container.classList.add('ac-wrap');
  container.innerHTML = `
    <input type="text" class="ac-input" autocomplete="off" placeholder="Type to search assets…"
      value="${initialAsset ? escapeHtml(initialAsset.Name) : ''}" />
    <div class="ac-results" hidden></div>`;
  const input = container.querySelector('.ac-input');
  const resultsEl = container.querySelector('.ac-results');

  function renderResults(items, query) {
    const rows = items.map((a) => `
      <div class="ac-item" data-id="${a.Id}" data-name="${escapeHtml(a.Name)}">
        ${escapeHtml(a.Name)}${a.locationName ? ` <span class="muted">— ${escapeHtml(a.locationName)}</span>` : ''}
      </div>`).join('');
    const addRow = query ? `<div class="ac-item ac-add" data-add-name="${escapeHtml(query)}">➕ Add new asset "${escapeHtml(query)}"…</div>` : '';
    resultsEl.innerHTML = rows + addRow;
    resultsEl.hidden = false;
    resultsEl.querySelectorAll('.ac-item[data-id]').forEach((el) => el.addEventListener('click', () => {
      selected = { Id: Number(el.dataset.id), Name: el.dataset.name };
      input.value = el.dataset.name;
      resultsEl.hidden = true;
      onSelect(selected);
    }));
    resultsEl.querySelector('.ac-add')?.addEventListener('click', () => showQuickCreateForm(resultsEl.querySelector('.ac-add').dataset.addName));
  }

  // A location matters for reporting, so the quick-add flow asks for it (and
  // asset type) inline rather than creating a bare, unlocated asset — the
  // rest of an asset's properties still go through Edit Asset afterward,
  // matching the "deliberate action" spirit for anything beyond the basics.
  async function showQuickCreateForm(name) {
    resultsEl.innerHTML = `<div class="ac-item" style="cursor:default">
      <div class="field-row" style="margin-bottom:8px"><label>New asset name</label><input class="ac-new-name" value="${escapeHtml(name)}" /></div>
      <div class="field-row" style="margin-bottom:8px"><label>Location</label><select class="ac-new-location"><option value="">— unset —</option></select></div>
      <div class="field-row" style="margin-bottom:8px"><label>Asset Type</label><input class="ac-new-type" placeholder="e.g. Full Cabin" /></div>
      <div class="btn-row" style="margin-top:0">
        <button type="button" class="btn btn-primary ac-create-confirm">Create Asset</button>
        <button type="button" class="btn btn-secondary ac-create-cancel">Cancel</button>
      </div>
    </div>`;
    const locSelect = resultsEl.querySelector('.ac-new-location');
    api('/api/pg/locations').then(({ locations }) => {
      locSelect.insertAdjacentHTML('beforeend', locations.map((l) => `<option value="${l.Id}">${escapeHtml(l.Name)}</option>`).join(''));
    });
    resultsEl.querySelector('.ac-create-cancel').addEventListener('click', () => { resultsEl.hidden = true; });
    resultsEl.querySelector('.ac-create-confirm').addEventListener('click', async () => {
      const finalName = resultsEl.querySelector('.ac-new-name').value.trim();
      if (!finalName) { toast('Name is required'); return; }
      try {
        const { asset } = await api('/api/pg/assets', { method: 'POST', body: JSON.stringify({
          name: finalName, locationId: locSelect.value || undefined, assetType: resultsEl.querySelector('.ac-new-type').value.trim() || undefined,
        }) });
        selected = asset;
        input.value = asset.Name;
        resultsEl.hidden = true;
        toast(`Created asset "${asset.Name}"`);
        onSelect(selected);
      } catch (err) { toast(err.message); }
    });
  }

  input.addEventListener('input', () => {
    selected = null;
    onSelect(null);
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) { resultsEl.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      const { assets } = await api(`/api/pg/assets-search?q=${encodeURIComponent(q)}`);
      renderResults(assets, q);
    }, 250);
  });
  input.addEventListener('focus', () => { if (input.value.trim() && resultsEl.innerHTML) resultsEl.hidden = false; });
  document.addEventListener('click', (e) => { if (!container.contains(e.target)) resultsEl.hidden = true; });

  return { getSelected: () => selected };
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
  { icon: '📅', label: 'Calendar', view: 'calendar' },
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

// Every view function still sets app.innerHTML itself (loading, then real
// content) — this dispatcher just triggers the fade-in ONCE, after whichever
// handler finishes, so view swaps transition instead of flashing. Single
// choke point: no need to touch each render function's internals.
function fadeInApp() {
  app.classList.remove('view-fade');
  void app.offsetWidth;
  app.classList.add('view-fade');
}

async function render(view, params = {}) {
  try {
    if (view === 'login') { await renderLogin(); return fadeInApp(); }
    if (!state.user) { await renderLogin(); return fadeInApp(); }
    if (!state.options) state.options = await api('/api/pg/options');
    renderSidebar(view);
    setChrome({ title: '', showBack: state.stack.length > 1, showLogout: true });
    breadcrumbsEl.hidden = true;
    const handlers = {
      dashboard: () => renderDashboard(),
      locations: () => renderLocations(),
      assetsInLocation: () => renderAssetsInLocation(params),
      assetDetail: () => renderAssetDetail(params),
      audit: () => renderAudit(params),
      assetHistory: () => renderAssetHistory(params),
      capitalPlan: () => renderCapitalPlan(),
      maintenanceLog: () => renderMaintenanceLog(),
      editAsset: () => renderEditAsset(params),
      admin: () => renderAdminHub(),
      adminAddFieldChoice: () => renderAdminAddFieldChoice(),
      adminPropertyFields: () => renderAdminPropertyFields(params),
      adminComponentTypes: () => renderAdminComponentTypes(params),
      adminBuildingTypes: () => renderAdminBuildingTypes(),
      adminApplicability: () => renderAdminApplicability(),
      adminSubAreas: () => renderAdminSubAreas(),
      adminWoTemplates: () => renderAdminWoTemplates(),
      calendar: () => renderCalendar(params),
      newCalendarEvent: () => renderNewCalendarEvent(params),
      calendarEventDetail: () => renderCalendarEventDetail(params),
      adminChecklistTemplates: () => renderAdminChecklistTemplates(),
      workOrders: () => renderWorkOrders(),
      workOrderDetail: () => renderWorkOrderDetail(params),
      newWorkOrder: () => renderNewWorkOrder(params),
      crew: () => renderCrew(),
      adminUsers: () => renderAdminUsers(),
      activityLog: () => renderActivityLog(),
    };
    if (handlers[view]) {
      await handlers[view]();
      fadeInApp();
    }
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
  app.innerHTML = LOADING_HTML;
  const { locations } = await api('/api/pg/locations');
  let editing = null; // 'new' | { id } | null
  let typeFilter = null; // set by clicking a type pill — filters the list to that type

  function locationGridHtml(list, emptyMsg) {
    const parentNameById = new Map(locations.map((l) => [l.Id, l.Name]));
    const rows = list.map((l) => `
      <tr>
        <td data-label="Name"><a href="#" class="loc-open" data-id="${l.Id}" data-name="${escapeHtml(l.Name)}">${escapeHtml(l.Name)}</a></td>
        <td data-label="Type">${l['Location Type'] ? `<span class="pill type-filter-chip" data-type="${escapeHtml(l['Location Type'])}">${escapeHtml(l['Location Type'])}</span>` : '—'}</td>
        <td data-label="Parent">${escapeHtml(parentNameById.get(l.ParentLocationId) || '—')}</td>
        <td data-label="Actions"><button class="btn btn-secondary edit-location" data-id="${l.Id}">Edit</button></td>
      </tr>`).join('');
    return `<div style="overflow-x:auto"><table class="report-table">
      <thead><tr><th>Name</th><th>Type</th><th>Parent</th><th>Actions</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="muted">${emptyMsg}</td></tr>`}</tbody>
    </table></div>`;
  }

  function editFormHtml(loc) {
    const existingTypes = [...new Set(locations.map((l) => l['Location Type']).filter(Boolean))].sort();
    const parentOptions = locations.filter((l) => l.Id !== loc?.Id).map((l) =>
      `<option value="${l.Id}" ${loc?.ParentLocationId === l.Id ? 'selected' : ''}>${escapeHtml(l.Name)}</option>`).join('');
    return `<div class="card">
      <h3>${loc ? `Edit ${escapeHtml(loc.Name)}` : 'Add Location'}</h3>
      <div class="field-row"><label>Name</label><input class="loc-name" value="${escapeHtml(loc?.Name || '')}" required /></div>
      <div class="field-row"><label>Parent Location</label>
        <select class="loc-parent"><option value="">— top-level —</option>${parentOptions}</select>
      </div>
      <div class="field-row"><label>Type</label>
        <input class="loc-type" list="locationTypeOptions" value="${escapeHtml(loc?.['Location Type'] || '')}" />
        <datalist id="locationTypeOptions">${existingTypes.map((t) => `<option value="${escapeHtml(t)}">`).join('')}</datalist>
      </div>
      <div class="field-row"><label>Notes</label><textarea class="loc-notes">${escapeHtml(loc?.Notes || '')}</textarea></div>
      <div class="btn-row">
        <button class="btn btn-primary loc-save" data-id="${loc?.Id ?? ''}">Save</button>
        <button class="btn btn-secondary loc-cancel">Cancel</button>
      </div>
    </div>`;
  }

  function draw() {
    const mode = getTableViewMode();
    const visible = typeFilter ? locations.filter((l) => l['Location Type'] === typeFilter) : locations;
    const emptyMsg = typeFilter ? `No locations of type "${escapeHtml(typeFilter)}".` : 'No locations yet.';
    setApp(`
      ${tableViewToggleHtml(mode)}
      ${typeFilter ? `<div class="btn-row" style="margin:-6px 0 16px"><button class="btn btn-secondary" id="clearTypeFilter">✕ Filtered by type: ${escapeHtml(typeFilter)}</button></div>` : ''}
      ${mode === 'table' ? locationGridHtml(visible, emptyMsg) : (visible.map((l) => `
        <div class="list-item loc-row">
          <span class="loc-open" data-id="${l.Id}" data-name="${escapeHtml(l.Name)}">📍 ${escapeHtml(l.Name)}</span>
          ${l['Location Type'] ? `<span class="pill type-filter-chip" data-type="${escapeHtml(l['Location Type'])}">${escapeHtml(l['Location Type'])}</span>` : '<span class="pill"></span>'}
          <button class="btn btn-secondary edit-location" data-id="${l.Id}">Edit</button>
        </div>`).join('') || `<p class="muted">${emptyMsg}</p>`)}
      ${editing === 'new' ? editFormHtml(null) : `<div class="btn-row" style="margin-top:10px"><button class="btn btn-secondary" id="addLocationBtn">+ Add Location</button></div>`}
      ${editing?.id ? editFormHtml(locations.find((l) => l.Id === editing.id)) : ''}
    `);
    wire();
  }

  function wire() {
    wireTableViewToggle(draw);
    app.querySelectorAll('.type-filter-chip').forEach((chip) => chip.addEventListener('click', (e) => {
      e.preventDefault();
      typeFilter = chip.dataset.type;
      draw();
    }));
    document.getElementById('clearTypeFilter')?.addEventListener('click', () => { typeFilter = null; draw(); });
    app.querySelectorAll('.loc-open').forEach((el) => el.addEventListener('click', (e) => {
      e.preventDefault();
      go('assetsInLocation', { id: el.dataset.id, name: el.dataset.name });
    }));
    document.getElementById('addLocationBtn')?.addEventListener('click', () => { editing = 'new'; draw(); });
    app.querySelectorAll('.edit-location').forEach((btn) => btn.addEventListener('click', () => {
      editing = { id: Number(btn.dataset.id) };
      draw();
    }));
    app.querySelectorAll('.loc-cancel').forEach((btn) => btn.addEventListener('click', () => { editing = null; draw(); }));
    app.querySelectorAll('.loc-save').forEach((btn) => btn.addEventListener('click', async () => {
      const card = btn.closest('.card');
      const id = btn.dataset.id;
      const fields = {
        name: card.querySelector('.loc-name').value.trim(),
        parentLocationId: card.querySelector('.loc-parent').value || undefined,
        locationType: card.querySelector('.loc-type').value.trim(),
        notes: card.querySelector('.loc-notes').value.trim(),
      };
      if (!fields.name) { toast('Name is required'); return; }
      const isNew = !id;
      try {
        await api(isNew ? '/api/pg/locations' : `/api/pg/locations/${id}`, { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify(fields) });
        toast(isNew ? 'Location added' : 'Location saved');
        renderLocations();
      } catch (err) { toast(err.message); }
    }));
  }

  draw();
}

async function renderAssetsInLocation({ id, name }) {
  setChrome({ title: name || 'Assets', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const { assets } = await api(`/api/pg/locations/${id}/assets`);
  app.innerHTML = assets.length ? assets.map((a) => `
    <div class="list-item" data-id="${a.Id}">
      <span>🏚️ ${escapeHtml(a.Name)}</span>
      <span class="pill">${escapeHtml(a['Asset type'] || '')}</span>
    </div>`).join('') : '<p class="muted">No assets in this location.</p>';
  app.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => go('assetDetail', { id: el.dataset.id })));
}

// Four visually distinct tiers, worst to best: bad (red) > pop (orange) >
// warn (amber) > good (green). Fair sits a full tier below Good/Excellent —
// previously it was lumped in with Good and looked identical.
function conditionPillClass(c) {
  if (['Good', 'Excellent'].includes(c)) return 'good';
  if (['Fair'].includes(c)) return 'warn';
  if (['Poor'].includes(c)) return 'pop';
  if (['Failed', 'Critical'].includes(c)) return 'bad';
  return '';
}

function woStatusPillClass(status) {
  if (status === 'Done') return 'good';
  if (status === 'Urgent') return 'bad';
  if (status === 'In Progress') return 'pop';
  if (status === 'On Hold') return 'warn';
  return ''; // Open = neutral
}

// A step with no dependency is always visible. Otherwise it's visible only
// once the step it depends on is checked/unchecked as configured — matches
// the same rule the PDF export route evaluates server-side.
function checklistStepVisible(step, stepById) {
  if (step.DependsOnInstanceStepId == null) return true;
  const dep = stepById.get(step.DependsOnInstanceStepId);
  return dep ? dep.Done === step.ShowWhenChecked : true;
}

function checklistHtmlFor(checklist, { forCard = true } = {}) {
  if (!checklist) return '';
  const stepById = new Map(checklist.Steps.map((s) => [s.Id, s]));
  const visibleSteps = checklist.Steps.filter((s) => checklistStepVisible(s, stepById));
  const hiddenCount = checklist.Steps.length - visibleSteps.length;
  return `
    <div class="card"><h3>Checklist: ${escapeHtml(checklist.Name)}</h3>
      ${visibleSteps.map((s) => `<div class="list-item" style="cursor:default">
        <label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer">
          <input type="checkbox" class="checklist-step-toggle" data-id="${s.Id}" ${s.Done ? 'checked' : ''} />
          <span style="${s.Done ? 'text-decoration:line-through;color:var(--muted)' : ''}">${escapeHtml(s.StepText)}</span>
        </label>
      </div>`).join('')}
      ${hiddenCount ? `<p class="muted">${hiddenCount} step${hiddenCount > 1 ? 's' : ''} hidden until their condition is met.</p>` : ''}
      <div class="btn-row">
        <a class="btn btn-secondary" href="/api/pg/checklist-instances/${checklist.Id}/pdf" target="_blank" rel="noopener">⬇ Export PDF</a>
        <button class="btn btn-secondary" id="removeChecklistBtn">Remove Checklist</button>
      </div>
    </div>`;
}

async function renderAssetDetail({ id }) {
  setChrome({ title: 'Asset', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
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
    if (!await confirmDialog(`Change building type to "${label}"? This affects which questions apply to this asset.`)) {
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
  app.innerHTML = LOADING_HTML;
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
  app.innerHTML = LOADING_HTML;
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
  app.innerHTML = LOADING_HTML;
  const { rows, summary } = await api('/api/pg/capital-plan');
  let activeBucket = null; // client-side filter — no re-fetch needed, data's already in hand

  function draw() {
    const mode = getTableViewMode();
    const buckets = summary.map((b) => `
      <div class="bucket-tile tile-${bucketColorKey(b.bucket)} ${activeBucket === b.bucket ? 'active' : ''}" data-bucket="${escapeHtml(b.bucket)}">
        <div class="n">${b.count}</div><div class="muted">${escapeHtml(b.bucket)}</div>
        <div class="muted">$${Number(b.totalCost || 0).toLocaleString()}</div>
      </div>`).join('');
    const visibleRows = activeBucket ? rows.filter((r) => r.bucket === activeBucket) : rows;
    const tableRows = visibleRows.map((r) => `
      <tr class="clickable-row" data-asset-id="${r.assetId}">
        <td data-label="Asset">${escapeHtml(r.assetName)}</td>
        <td data-label="Location">${escapeHtml(r.locationName || '')}</td>
        <td data-label="Component">${escapeHtml(r.componentType)}</td>
        <td data-label="Condition"><span class="pill ${conditionPillClass(r.condition)}">${escapeHtml(r.condition || '')}</span></td>
        <td data-label="Est. Year">${r.estReplacementYear ?? '—'}</td>
        <td data-label="Est. Cost">${r.estReplacementCost ? '$' + Number(r.estReplacementCost).toLocaleString() : '—'}</td>
        <td data-label="Bucket"><span class="pill ${bucketColorKey(r.bucket) === 'neutral' ? '' : bucketColorKey(r.bucket)}">${escapeHtml(r.bucket)}</span></td>
      </tr>`).join('');
    setApp(`
      <div class="summary-buckets">${buckets}</div>
      ${tableViewToggleHtml(mode)}
      ${activeBucket ? `<div style="margin-bottom:10px"><button class="btn btn-secondary" id="clearBucketFilter">✕ Clear filter: ${escapeHtml(activeBucket)}</button></div>` : ''}
      <div class="card" style="overflow-x:auto">
        <table class="report-table ${mode === 'cards' ? 'card-mode' : ''}">
          <thead><tr><th>Asset</th><th>Location</th><th>Component</th><th>Condition</th><th>Est. Year</th><th>Est. Cost</th><th>Bucket</th></tr></thead>
          <tbody>${tableRows || `<tr><td colspan="7" class="muted">${activeBucket ? 'Nothing in this bucket.' : '🗒️ No component data yet.'}</td></tr>`}</tbody>
        </table>
      </div>`);
    wire();
  }

  function wire() {
    app.querySelectorAll('.bucket-tile').forEach((tile) => tile.addEventListener('click', () => {
      activeBucket = activeBucket === tile.dataset.bucket ? null : tile.dataset.bucket;
      draw();
    }));
    document.getElementById('clearBucketFilter')?.addEventListener('click', () => { activeBucket = null; draw(); });
    app.querySelectorAll('.clickable-row').forEach((tr) => tr.addEventListener('click', () => go('assetDetail', { id: tr.dataset.assetId })));
    wireTableViewToggle(draw);
  }

  draw();
}

async function renderMaintenanceLog() {
  setChrome({ title: 'Maintenance Log', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const { entries } = await api('/api/pg/maintenance-log');

  function draw() {
    const mode = getTableViewMode();
    setApp(`
      ${tableViewToggleHtml(mode)}
      <div class="card" style="overflow-x:auto">
        <table class="report-table ${mode === 'cards' ? 'card-mode' : ''}">
          <thead><tr><th>Date</th><th>Asset</th><th>Component</th><th>Event</th><th>Condition</th><th>Material</th><th>Notes</th></tr></thead>
          <tbody>${entries.map((e) => `
            <tr class="clickable-row" data-asset-id="${e.Asset?.Id ?? ''}">
              <td data-label="Date">${escapeHtml(e['Observed/Installed Date'] || '')}</td>
              <td data-label="Asset">${escapeHtml(e.Asset?.Name || '')}</td>
              <td data-label="Component">${escapeHtml(e['Component Type'])}</td>
              <td data-label="Event">${escapeHtml(e['Event Type'] || '')}</td>
              <td data-label="Condition"><span class="pill ${conditionPillClass(e.Condition)}">${escapeHtml(e.Condition || '')}</span></td>
              <td data-label="Material">${escapeHtml(e.Material || '')}</td>
              <td data-label="Notes">${escapeHtml(e.Notes || '')}</td>
            </tr>`).join('') || '<tr><td colspan="7" class="muted">🗒️ No entries yet.</td></tr>'}</tbody>
        </table>
      </div>`);
    app.querySelectorAll('.clickable-row').forEach((tr) => {
      if (!tr.dataset.assetId) return;
      tr.addEventListener('click', () => go('assetDetail', { id: tr.dataset.assetId }));
    });
    wireTableViewToggle(draw);
  }

  draw();
}

// ---------- Edit Asset (full direct edit — core fields + every property field,
// no conditional hiding, distinct from the guided Audit walkthrough) ----------

async function renderEditAsset({ id }) {
  setChrome({ title: 'Edit Asset', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
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
    if (!await confirmDialog(`Save these changes to "${asset.Name}"?`)) return;
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
    <div class="list-item" data-view="adminSubAreas">📐 Component Sub-Areas</div>
    <div class="list-item" data-view="adminWoTemplates">🧾 Work Order Templates</div>
    <div class="list-item" data-view="adminChecklistTemplates">✅ Checklist Templates</div>
    <div class="card" style="margin-top:14px"><h3>Accounts</h3></div>
    <div class="list-item" data-view="adminUsers">👤 Users</div>
    <div class="list-item" data-view="activityLog">🕘 Activity Log</div>`;
  app.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => go(el.dataset.view, {})));
}

const ACTIVITY_ACTION_PILL = {
  created: 'good', deleted: 'bad', deactivated: 'bad', updated: '', completed: 'good', reactivated: 'good',
};
async function renderActivityLog() {
  setChrome({ title: 'Activity Log', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const { entries } = await api('/api/pg/activity-log?limit=300');
  let actionFilter = null;
  let typeFilter = null;

  function draw() {
    const actions = [...new Set(entries.map((e) => e.Action))].sort();
    const types = [...new Set(entries.map((e) => e.EntityType))].sort();
    const visible = entries.filter((e) => (!actionFilter || e.Action === actionFilter) && (!typeFilter || e.EntityType === typeFilter));
    const rows = visible.map((e) => `
      <tr>
        <td data-label="When">${new Date(e.OccurredAt).toLocaleString()}</td>
        <td data-label="Who">${escapeHtml(e.Username || '—')}</td>
        <td data-label="Action"><span class="pill ${ACTIVITY_ACTION_PILL[e.Action] || ''}">${escapeHtml(e.Action)}</span></td>
        <td data-label="Type">${escapeHtml(e.EntityType.replace(/_/g, ' '))}</td>
        <td data-label="What">${escapeHtml(e.EntityLabel || '—')}</td>
        <td data-label="Details">${escapeHtml(e.Details || '')}</td>
      </tr>`).join('');
    setApp(`
      <div class="card">
        <p class="muted">Most recent ${entries.length} events. Deleted records stay listed here even though the record itself is gone.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
          <select id="actionFilter"><option value="">All actions</option>${actions.map((a) => `<option value="${a}" ${actionFilter === a ? 'selected' : ''}>${a}</option>`).join('')}</select>
          <select id="typeFilter"><option value="">All types</option>${types.map((t) => `<option value="${t}" ${typeFilter === t ? 'selected' : ''}>${t.replace(/_/g, ' ')}</option>`).join('')}</select>
        </div>
      </div>
      <div class="card" style="overflow-x:auto">
        <table class="report-table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Type</th><th>What</th><th>Details</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="muted">No activity recorded yet.</td></tr>'}</tbody>
        </table>
      </div>`);
    document.getElementById('actionFilter').addEventListener('change', (e) => { actionFilter = e.target.value || null; draw(); });
    document.getElementById('typeFilter').addEventListener('change', (e) => { typeFilter = e.target.value || null; draw(); });
  }

  draw();
}

async function renderAdminUsers() {
  setChrome({ title: 'Users', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const { users } = await api('/api/pg/users');
  let editing = null; // 'new' | { id } | null

  function editFormHtml(u) {
    return `<div class="card">
      <h3>${u ? `Edit "${escapeHtml(u.Username)}"` : 'Add User'}</h3>
      ${u ? '' : `<div class="field-row"><label>Username</label><input class="u-username" required /></div>`}
      <div class="field-row"><label>Email (optional)</label><input class="u-email" type="email" value="${escapeHtml(u?.Email || '')}" /></div>
      <div class="field-row"><label>${u ? 'New Password (leave blank to keep current)' : 'Password'}</label><input class="u-password" type="password" ${u ? '' : 'required'} /></div>
      ${u ? `<div class="field-row"><label style="display:flex;align-items:center;gap:8px;font-weight:400"><input type="checkbox" class="u-active" ${u.Active ? 'checked' : ''} style="width:auto" /> Active (unchecked = can't log in)</label></div>` : ''}
      <div class="btn-row">
        <button class="btn btn-primary u-save" data-id="${u?.Id ?? ''}">Save</button>
        <button class="btn btn-secondary u-cancel">Cancel</button>
      </div>
    </div>`;
  }

  function draw() {
    setApp(`
      ${users.map((u) => `
        <div class="list-item" style="cursor:default">
          <div><strong>${escapeHtml(u.Username)}</strong>${!u.Active ? ' <span class="pill">inactive</span>' : ''}
            <div class="muted">${escapeHtml(u.Email || 'no email on file')}</div></div>
          <div class="btn-row" style="margin-top:0">
            <button class="btn btn-secondary edit-user" data-id="${u.Id}">Edit</button>
            <button class="btn btn-secondary delete-user" data-id="${u.Id}" data-name="${escapeHtml(u.Username)}">Delete</button>
          </div>
        </div>`).join('') || '<p class="muted">No accounts yet.</p>'}
      ${editing === 'new' ? editFormHtml(null) : `<div class="btn-row" style="margin-top:10px"><button class="btn btn-secondary" id="addUserBtn">+ Add User</button></div>`}
      ${editing?.id ? editFormHtml(users.find((u) => u.Id === editing.id)) : ''}
    `);
    wire();
  }

  function wire() {
    document.getElementById('addUserBtn')?.addEventListener('click', () => { editing = 'new'; draw(); });
    app.querySelectorAll('.edit-user').forEach((btn) => btn.addEventListener('click', () => { editing = { id: Number(btn.dataset.id) }; draw(); }));
    app.querySelectorAll('.u-cancel').forEach((btn) => btn.addEventListener('click', () => { editing = null; draw(); }));
    app.querySelectorAll('.u-save').forEach((btn) => btn.addEventListener('click', async () => {
      const card = btn.closest('.card');
      const id = btn.dataset.id;
      const isNew = !id;
      const password = card.querySelector('.u-password').value;
      const email = card.querySelector('.u-email').value.trim();
      try {
        if (isNew) {
          const username = card.querySelector('.u-username').value.trim();
          if (!username) { toast('Username is required'); return; }
          if (password.length < 6) { toast('Password must be at least 6 characters'); return; }
          await api('/api/pg/users', { method: 'POST', body: JSON.stringify({ username, password, email }) });
          toast('User added');
        } else {
          if (password && password.length < 6) { toast('Password must be at least 6 characters'); return; }
          const active = card.querySelector('.u-active').checked;
          await api(`/api/pg/users/${id}`, { method: 'PATCH', body: JSON.stringify({ email, password: password || undefined, active }) });
          toast('User saved');
        }
        renderAdminUsers();
      } catch (err) { toast(err.message); }
    }));
    app.querySelectorAll('.delete-user').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog(`Permanently delete the account "${btn.dataset.name}"? This cannot be undone.`)) return;
      try {
        await api(`/api/pg/users/${btn.dataset.id}`, { method: 'DELETE' });
        toast('User deleted');
        renderAdminUsers();
      } catch (err) { toast(err.message); }
    }));
  }

  draw();
}

async function renderAdminWoTemplates() {
  setChrome({ title: 'Work Order Templates', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const [tplRes, optsRes] = await Promise.all([api('/api/pg/work-order-templates'), Promise.resolve(state.options)]);
  const templates = tplRes.templates;
  const fieldTitles = optsRes.propertyFields.map((f) => f.title);
  let editingId = null; // null | 'new' | number

  const taskRowHtml = (text = '') => `<div class="inline-add-row task-row"><input class="task-text" value="${escapeHtml(text)}" placeholder="Task description…" /><button type="button" class="btn btn-secondary row-remove">✕</button></div>`;
  const jobLineRowHtml = (row = {}) => `<div class="inline-add-row jl-row" style="align-items:center">
      <select class="jl-field" style="flex:1">${fieldTitles.map((t) => `<option ${row.targetField === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>
      <input class="jl-value" placeholder="Value" value="${escapeHtml(row.newValue || '')}" style="flex:1" />
      <button type="button" class="btn btn-secondary row-remove">✕</button>
    </div>`;

  function formHtml(t) {
    const taskRows = (t?.TaskDefaults || []).map(taskRowHtml).join('');
    const jlRows = (t?.JobLineDefaults || []).map(jobLineRowHtml).join('');
    return `<div class="card">
      <h3>${t ? `Edit "${escapeHtml(t.Name)}"` : 'New Template'}</h3>
      <div class="field-row"><label>Template Name</label><input class="tf-name" value="${escapeHtml(t?.Name || '')}" placeholder="e.g. Winterization" required /></div>
      <div class="field-row"><label>Default Title</label><input class="tf-title" value="${escapeHtml(t?.DefaultTitle || '')}" placeholder="Fills in the WO title — you can still edit it per use" /></div>
      <div class="field-row"><label>Default Priority</label>
        <select class="tf-priority"><option value="">— none —</option>${['Low', 'Medium', 'High', 'Urgent'].map((p) => `<option ${t?.DefaultPriority === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
      </div>
      <div class="field-row"><label>Default Description</label><textarea class="tf-description">${escapeHtml(t?.DefaultDescription || '')}</textarea></div>
      <div class="field-row"><label>Default Tasks</label>
        <p class="muted" style="margin:2px 0 8px">Pre-fills these scope-of-work tasks on every WO created from this template.</p>
        <div class="tf-tasks">${taskRows}</div>
        <button type="button" class="btn btn-secondary tf-add-task" style="margin-top:6px">+ Add Task</button>
      </div>
      <details style="margin:12px 0">
        <summary style="cursor:pointer;font-weight:700">Also update asset fields (optional)</summary>
        <div class="tf-job-lines" style="margin-top:8px">${jlRows}</div>
        <button type="button" class="btn btn-secondary tf-add-line" style="margin-top:6px">+ Add Field Update</button>
      </details>
      <div class="btn-row">
        <button class="btn btn-primary tf-save" data-id="${t?.Id ?? ''}">Save Template</button>
        <button class="btn btn-secondary tf-cancel">Cancel</button>
      </div>
    </div>`;
  }

  function draw() {
    const list = templates.map((t) => `
      <div class="list-item" style="cursor:default;flex-wrap:wrap">
        <div>
          <strong>${escapeHtml(t.Name)}</strong>
          <div class="muted">${escapeHtml(t.DefaultTitle || '')}${t.DefaultPriority ? ' · ' + escapeHtml(t.DefaultPriority) : ''}</div>
          ${t.TaskDefaults?.length ? `<div class="muted">${t.TaskDefaults.length} default task${t.TaskDefaults.length > 1 ? 's' : ''}</div>` : ''}
        </div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn btn-secondary tpl-edit" data-id="${t.Id}">Edit</button>
          <button class="btn btn-secondary tpl-delete" data-id="${t.Id}" data-name="${escapeHtml(t.Name)}">Delete</button>
        </div>
      </div>`).join('') || '<p class="muted">🧾 No templates yet — save your repeatable tasks here.</p>';

    setApp(`
      <div class="card"><h3>Work Order Templates</h3>
        <p class="muted">Canned setups for repeatable tasks — pick one from "New Work Order" instead of retyping everything.</p>
      </div>
      ${list}
      ${editingId === 'new' ? formHtml(null) : `<div class="btn-row" style="margin:4px 0 16px"><button class="btn btn-secondary" id="newTplBtn">+ New Template</button></div>`}
      ${typeof editingId === 'number' ? formHtml(templates.find((t) => t.Id === editingId)) : ''}
    `);
    wire();
  }

  function wire() {
    document.getElementById('newTplBtn')?.addEventListener('click', () => { editingId = 'new'; draw(); });
    app.querySelectorAll('.tpl-edit').forEach((btn) => btn.addEventListener('click', () => { editingId = Number(btn.dataset.id); draw(); }));
    app.querySelectorAll('.tf-cancel').forEach((btn) => btn.addEventListener('click', () => { editingId = null; draw(); }));
    app.querySelectorAll('.tf-add-task').forEach((btn) => btn.addEventListener('click', () => {
      btn.previousElementSibling.insertAdjacentHTML('beforeend', taskRowHtml());
      wireRemoveButtons();
    }));
    app.querySelectorAll('.tf-add-line').forEach((btn) => btn.addEventListener('click', () => {
      btn.previousElementSibling.insertAdjacentHTML('beforeend', jobLineRowHtml());
      wireRemoveButtons();
    }));
    wireRemoveButtons();

    app.querySelectorAll('.tpl-delete').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog(`Delete template "${btn.dataset.name}"? This won't affect any work orders already created from it.`)) return;
      await api(`/api/pg/work-order-templates/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Template deleted');
      renderAdminWoTemplates();
    }));

    app.querySelectorAll('.tf-save').forEach((btn) => btn.addEventListener('click', async () => {
      const card = btn.closest('.card');
      const name = card.querySelector('.tf-name').value.trim();
      if (!name) { toast('Template name is required'); return; }
      const taskDefaults = [...card.querySelectorAll('.task-row .task-text')].map((el) => el.value.trim()).filter(Boolean);
      const jobLineDefaults = [...card.querySelectorAll('.jl-row')].map((row) => ({
        targetField: row.querySelector('.jl-field').value, newValue: row.querySelector('.jl-value').value,
      })).filter((r) => r.newValue.trim());
      const fields = {
        name, defaultTitle: card.querySelector('.tf-title').value.trim(),
        defaultPriority: card.querySelector('.tf-priority').value,
        defaultDescription: card.querySelector('.tf-description').value.trim(),
        taskDefaults, jobLineDefaults,
      };
      const id = btn.dataset.id;
      try {
        await api(id ? `/api/pg/work-order-templates/${id}` : '/api/pg/work-order-templates', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(fields) });
        toast(id ? 'Template updated' : 'Template created');
        renderAdminWoTemplates();
      } catch (err) { toast(err.message); }
    }));
  }

  function wireRemoveButtons() {
    app.querySelectorAll('.row-remove').forEach((btn) => { btn.onclick = () => btn.closest('.inline-add-row').remove(); });
  }

  draw();
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
  app.innerHTML = LOADING_HTML;
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
    if (!await confirmDialog(`${action} this field? ${action === 'Deactivate' ? 'It will stop appearing in the audit form and Edit Asset screen (existing data is kept).' : 'It will reappear in the audit form.'}`)) return;
    await api(`/api/pg/admin/property-fields/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.next === 'true' }) });
    renderAdminPropertyFields();
  }));

  document.getElementById('addFieldForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const inputType = fd.get('inputType');
    const options = fd.get('options').split(',').map((s) => s.trim()).filter(Boolean);
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
  app.innerHTML = LOADING_HTML;
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
    if (!await confirmDialog(`${cb.checked ? 'Start' : 'Stop'} prompting for "${cb.dataset.type}" during the audit walkthrough (when Free Standing Building = Yes)?`)) {
      cb.checked = !cb.checked;
      return;
    }
    await api(`/api/pg/admin/component-types/${encodeURIComponent(cb.dataset.type)}`, { method: 'PATCH', body: JSON.stringify({ promptedInAudit: cb.checked }) });
    toast('Updated');
  }));

  document.getElementById('addCompForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
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
  app.innerHTML = LOADING_HTML;
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
    if (!await confirmDialog('Delete this building type? Only works if no assets currently use it.')) return;
    try { await api(`/api/pg/admin/building-types/${btn.dataset.id}`, { method: 'DELETE' }); renderAdminBuildingTypes(); }
    catch (err) { toast(err.message); }
  }));
  document.getElementById('addBtForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name');
    try {
      await api('/api/pg/admin/building-types', { method: 'POST', body: JSON.stringify({ name }) });
      renderAdminBuildingTypes();
    } catch (err) { toast(err.message); }
  });
}

async function renderAdminApplicability() {
  setChrome({ title: 'Applicability Matrix', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
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
      <table class="report-table matrix-table"><thead><tr><th>Building Type</th>${header}</tr></thead><tbody>${rows}</tbody></table>
    </div>`;

  app.querySelectorAll('.applies-cb').forEach((cb) => cb.addEventListener('change', async () => {
    try {
      await api('/api/pg/admin/applicability', { method: 'PUT', body: JSON.stringify({ buildingTypeId: Number(cb.dataset.bt), questionKey: cb.dataset.qk, applies: cb.checked }) });
    } catch (err) { toast(err.message); cb.checked = !cb.checked; }
  }));
}

async function renderAdminSubAreas() {
  setChrome({ title: 'Component Sub-Areas', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
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
    if (!await confirmDialog(`Delete sub-area "${btn.dataset.name}" from ${btn.dataset.type}? This cannot be undone from the app — you'd need to re-add it manually.`)) return;
    await api(`/api/pg/admin/sub-areas/${btn.dataset.id}`, { method: 'DELETE' });
    toast('Sub-area deleted');
    renderAdminSubAreas();
  }));
  document.getElementById('addSaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/pg/admin/sub-areas', { method: 'POST', body: JSON.stringify({ componentType: fd.get('componentType'), subArea: fd.get('subArea') }) });
      renderAdminSubAreas();
    } catch (err) { toast(err.message); }
  });
}

// ---------- Calendar / Scheduler ----------

async function renderCalendar(params = {}) {
  setChrome({ title: 'Calendar', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const now = new Date();
  let viewMonth = params.month != null ? Number(params.month) : now.getMonth();
  let viewYear = params.year != null ? Number(params.year) : now.getFullYear();
  const todayKey = now.toISOString().slice(0, 10);

  async function draw() {
    app.innerHTML = LOADING_HTML;
    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const startWeekday = firstOfMonth.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const monthLabel = firstOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    const fromStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-01`;
    const toStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    const [{ workOrders }, { occurrences }] = await Promise.all([
      api('/api/pg/work-orders'), api(`/api/pg/calendar-events?from=${fromStr}&to=${toStr}`),
    ]);

    const byDate = new Map();
    const unscheduled = [];
    for (const w of workOrders) {
      const sd = w['Scheduled Date'];
      if (!sd) { unscheduled.push(w); continue; }
      const key = sd.slice(0, 10);
      if (key < fromStr || key > toStr) continue; // different month, don't clutter "Unscheduled"... but keep visible via nav
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push({ type: 'wo', ...w });
    }
    for (const occ of occurrences) {
      if (!byDate.has(occ.OccurrenceDate)) byDate.set(occ.OccurrenceDate, []);
      byDate.get(occ.OccurrenceDate).push({ type: 'event', ...occ });
    }
    // WOs scheduled outside this month (shouldn't normally happen since we filtered) — recompute unscheduled properly across ALL WOs regardless of month
    const allUnscheduled = workOrders.filter((w) => !w['Scheduled Date']);

    const entryHtml = (e) => e.type === 'wo'
      ? `<div class="cal-entry" data-wo-id="${e.Id}"><span class="pill ${woStatusPillClass(e.Status)}">🛠️ ${escapeHtml(e.Asset?.Name || '')}${e.Asset ? ': ' : ''}${escapeHtml(e.Title)} — ${escapeHtml(e.Status)}</span></div>`
      : `<div class="cal-entry" data-event-id="${e.Id}"><span class="pill pop">📅 ${escapeHtml(e.Title)}${e.RecurrenceType !== 'none' ? ' 🔁' : ''}</span></div>`;

    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push('<div class="cal-cell cal-empty"></div>');
    for (let d = 1; d <= daysInMonth; d++) {
      const dateKey = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const entries = byDate.get(dateKey) || [];
      cells.push(`<div class="cal-cell ${dateKey === todayKey ? 'cal-today' : ''}">
        <div class="cal-daynum">${d}</div>
        ${entries.map(entryHtml).join('')}
      </div>`);
    }

    setApp(`
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <button class="btn btn-secondary" id="prevMonthBtn">← Prev</button>
        <h3 style="margin:0">${monthLabel}</h3>
        <button class="btn btn-secondary" id="nextMonthBtn">Next →</button>
      </div>
      <div class="btn-row" style="margin-bottom:12px"><button class="btn btn-primary" id="addEventBtn">+ Add Event</button></div>
      <div class="cal-scroll"><div class="cal-grid">
        ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-head">${d}</div>`).join('')}
        ${cells.join('')}
      </div></div>
      ${allUnscheduled.length ? `<div class="card"><h3>Unscheduled Work Orders (${allUnscheduled.length})</h3>
        <p class="muted">Set a Scheduled Date on a work order to place it on the calendar.</p>
        ${allUnscheduled.map((w) => `<div class="list-item" data-wo-id="${w.Id}">
          <span>${escapeHtml(w.Title)}${w.Asset ? ` — ${escapeHtml(w.Asset.Name)}` : ''}</span>
          <span class="pill ${woStatusPillClass(w.Status)}">${escapeHtml(w.Status)}</span>
        </div>`).join('')}
      </div>` : ''}`);
    wire();
  }

  function wire() {
    document.getElementById('prevMonthBtn').addEventListener('click', () => {
      viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } draw();
    });
    document.getElementById('nextMonthBtn').addEventListener('click', () => {
      viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } draw();
    });
    document.getElementById('addEventBtn').addEventListener('click', () => go('newCalendarEvent', {}));
    app.querySelectorAll('[data-wo-id]').forEach((el) => el.addEventListener('click', () => go('workOrderDetail', { id: el.dataset.woId })));
    app.querySelectorAll('[data-event-id]').forEach((el) => el.addEventListener('click', () => go('calendarEventDetail', { id: el.dataset.eventId })));
  }

  draw();
}

const RECURRENCE_LABELS = { none: 'Does not repeat', daily: 'Day(s)', weekly: 'Week(s)', monthly: 'Month(s)', yearly: 'Year(s)' };

function recurrenceFieldsHtml(ev = {}) {
  return `
    <div class="field-row"><label>Repeats</label>
      <select name="recurrenceType" id="recurrenceType">
        ${Object.entries(RECURRENCE_LABELS).map(([k, v]) => `<option value="${k}" ${(ev.RecurrenceType || 'none') === k ? 'selected' : ''}>${k === 'none' ? v : `Every N ${v}`}</option>`).join('')}
      </select>
    </div>
    <div class="field-row" id="recurrenceIntervalRow" ${(!ev.RecurrenceType || ev.RecurrenceType === 'none') ? 'hidden' : ''}>
      <label>Every</label>
      <input name="recurrenceInterval" type="number" min="1" value="${ev.RecurrenceInterval || 1}" style="max-width:100px" />
    </div>
    <div class="field-row" id="recurrenceEndRow" ${(!ev.RecurrenceType || ev.RecurrenceType === 'none') ? 'hidden' : ''}>
      <label>Stop Repeating After (optional)</label>
      <input name="recurrenceEndDate" type="date" value="${(ev.RecurrenceEndDate || '').slice(0, 10)}" />
    </div>`;
}
function wireRecurrenceToggle(root) {
  root.querySelector('#recurrenceType').addEventListener('change', (e) => {
    const on = e.target.value !== 'none';
    root.querySelector('#recurrenceIntervalRow').hidden = !on;
    root.querySelector('#recurrenceEndRow').hidden = !on;
  });
}

// Link-to-Work-Order(-Task) fields shared by New/Edit Calendar Event. Picking a
// Work Order auto-fills Title/Description/Date from it and reveals a Task
// dropdown scoped to that WO's tasks; picking a task narrows Title further to
// the task's own text. This only fires on user-driven changes — initial render
// for an existing event never overwrites its saved fields.
function calendarLinkFieldsHtml({ workOrders, initialTasks = [], ev = {} }) {
  const hasWo = !!ev.WorkOrderId;
  return `
    <div class="field-row"><label>Link to Work Order (optional)</label>
      <select name="workOrderId" id="linkWorkOrderId">
        <option value="">— none —</option>
        ${workOrders.map((w) => `<option value="${w.Id}" ${ev.WorkOrderId === w.Id ? 'selected' : ''}>${escapeHtml(w.Title)}${w.Asset ? ` — ${escapeHtml(w.Asset.Name)}` : ''}</option>`).join('')}
      </select>
    </div>
    <div class="field-row" id="linkTaskRow" ${hasWo ? '' : 'hidden'}>
      <label>Link to Task (optional)</label>
      <select name="workOrderTaskId" id="linkTaskId">
        <option value="">— whole work order —</option>
        ${initialTasks.map((t) => `<option value="${t.Id}" ${ev.WorkOrderTaskId === t.Id ? 'selected' : ''}>${escapeHtml(t.Description)}${t.Done ? ' (done)' : ''}</option>`).join('')}
      </select>
    </div>`;
}
function wireCalendarLinkFields(root) {
  const woSelect = root.querySelector('#linkWorkOrderId');
  const taskRow = root.querySelector('#linkTaskRow');
  const taskSelect = root.querySelector('#linkTaskId');
  const titleInput = root.querySelector('[name="title"]');
  const descInput = root.querySelector('[name="description"]');
  const dateInput = root.querySelector('[name="eventDate"]');
  let currentTasks = [];

  woSelect.addEventListener('change', async () => {
    const woId = woSelect.value;
    taskSelect.innerHTML = '<option value="">— whole work order —</option>';
    currentTasks = [];
    if (!woId) { taskRow.hidden = true; return; }
    taskRow.hidden = false;
    const { workOrder, tasks } = await api(`/api/pg/work-orders/${woId}`);
    currentTasks = tasks;
    taskSelect.innerHTML += tasks.map((t) => `<option value="${t.Id}">${escapeHtml(t.Description)}${t.Done ? ' (done)' : ''}</option>`).join('');
    titleInput.value = workOrder.Title;
    descInput.value = workOrder.Description || '';
    if (workOrder['Scheduled Date']) dateInput.value = workOrder['Scheduled Date'].slice(0, 10);
  });

  taskSelect.addEventListener('change', () => {
    const taskId = taskSelect.value;
    if (!taskId) return;
    const task = currentTasks.find((t) => String(t.Id) === taskId);
    const woLabel = woSelect.selectedOptions[0]?.textContent || '';
    if (task) {
      titleInput.value = task.Description;
      descInput.value = `Task from Work Order: ${woLabel}`;
    }
  });
}

async function renderNewCalendarEvent(params = {}) {
  setChrome({ title: 'New Calendar Event', showBack: true, showLogout: true });
  const { workOrders } = await api('/api/pg/work-orders');
  setApp(`
    <div class="card">
      <h3>New Calendar Event</h3>
      <form id="newEventForm">
        <div class="field-row"><label>Title</label><input name="title" required /></div>
        <div class="field-row"><label>Date</label><input name="eventDate" type="date" value="${params.date || ''}" required /></div>
        <div class="field-row"><label>Description</label><textarea name="description"></textarea></div>
        ${recurrenceFieldsHtml()}
        ${calendarLinkFieldsHtml({ workOrders })}
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Create Event</button>
          <button class="btn btn-secondary" type="button" id="cancelEventBtn">Cancel</button>
        </div>
      </form>
    </div>`);
  wireRecurrenceToggle(document.getElementById('newEventForm'));
  wireCalendarLinkFields(document.getElementById('newEventForm'));
  document.getElementById('cancelEventBtn').addEventListener('click', goBack);
  document.getElementById('newEventForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { event } = await api('/api/pg/calendar-events', { method: 'POST', body: JSON.stringify({
        title: fd.get('title'), eventDate: fd.get('eventDate'), description: fd.get('description'),
        recurrenceType: fd.get('recurrenceType'), recurrenceInterval: Number(fd.get('recurrenceInterval')) || 1,
        recurrenceEndDate: fd.get('recurrenceEndDate') || undefined,
        workOrderId: fd.get('workOrderId') || undefined,
        workOrderTaskId: fd.get('workOrderTaskId') || undefined,
      }) });
      toast('Event created');
      go('calendarEventDetail', { id: event.Id }, { replace: true });
    } catch (err) { toast(err.message); }
  });
}

async function renderCalendarEventDetail({ id }) {
  setChrome({ title: 'Calendar Event', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const [detail, workOrdersRes, tplRes] = await Promise.all([
    api(`/api/pg/calendar-events/${id}`), api('/api/pg/work-orders'), api('/api/pg/checklist-templates'),
  ]);
  const { event: ev, checklist } = detail;
  const { workOrders } = workOrdersRes;
  const checklistTemplates = tplRes.templates;
  const initialTasks = ev.WorkOrderId ? (await api(`/api/pg/work-orders/${ev.WorkOrderId}`)).tasks : [];

  const checklistHtml = checklist ? checklistHtmlFor(checklist)
    : (checklistTemplates.length ? `
    <div class="card"><h3>Checklist</h3>
      <div class="field-row"><select id="checklistTplPicker"><option value="">— choose a checklist —</option>${checklistTemplates.map((t) => `<option value="${t.Id}">${escapeHtml(t.Name)} (${t.Steps.length} steps)</option>`).join('')}</select></div>
      <button class="btn btn-secondary" id="attachChecklistBtn">Attach Checklist</button>
    </div>` : '');

  setApp(`
    <div class="card">
      <h3>${escapeHtml(ev.Title)}</h3>
      <form id="eventForm">
        <div class="field-row"><label>Title</label><input name="title" value="${escapeHtml(ev.Title)}" required /></div>
        <div class="field-row"><label>Date</label><input name="eventDate" type="date" value="${(ev.EventDate || '').slice(0, 10)}" required /></div>
        <div class="field-row"><label>Description</label><textarea name="description">${escapeHtml(ev.Description || '')}</textarea></div>
        ${recurrenceFieldsHtml(ev)}
        ${calendarLinkFieldsHtml({ workOrders, initialTasks, ev })}
        <button class="btn btn-secondary" type="submit">Save Changes</button>
      </form>
      ${ev.WorkOrderId ? `<div class="btn-row"><button class="btn btn-secondary" id="viewWoBtn">View Linked Work Order</button></div>` : ''}
      ${ev.TaskDescription ? `<p class="muted">Linked to task: "${escapeHtml(ev.TaskDescription)}"</p>` : ''}
      <div class="btn-row"><button class="btn btn-secondary" id="deleteEventBtn">Delete Event</button></div>
    </div>
    ${checklistHtml}`);

  wireRecurrenceToggle(document.getElementById('eventForm'));
  wireCalendarLinkFields(document.getElementById('eventForm'));

  document.getElementById('viewWoBtn')?.addEventListener('click', () => go('workOrderDetail', { id: ev.WorkOrderId }));
  document.getElementById('eventForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!await confirmDialog('Save changes to this event?')) return;
    const fd = new FormData(e.target);
    try {
      await api(`/api/pg/calendar-events/${id}`, { method: 'PATCH', body: JSON.stringify({
        title: fd.get('title'), eventDate: fd.get('eventDate'), description: fd.get('description'),
        recurrenceType: fd.get('recurrenceType'), recurrenceInterval: Number(fd.get('recurrenceInterval')) || 1,
        recurrenceEndDate: fd.get('recurrenceEndDate') || '', workOrderId: fd.get('workOrderId') || '',
        workOrderTaskId: fd.get('workOrderTaskId') || '',
      }) });
      toast('Event updated');
      renderCalendarEventDetail({ id });
    } catch (err) { toast(err.message); }
  });
  document.getElementById('deleteEventBtn').addEventListener('click', async () => {
    if (!await confirmDialog(`Delete "${ev.Title}"? This removes all its recurrences from the calendar.`)) return;
    try { await api(`/api/pg/calendar-events/${id}`, { method: 'DELETE' }); toast('Event deleted'); go('calendar', {}, { replace: true }); }
    catch (err) { toast(err.message); }
  });
  document.getElementById('attachChecklistBtn')?.addEventListener('click', async () => {
    const templateId = document.getElementById('checklistTplPicker').value;
    if (!templateId) { toast('Choose a checklist first'); return; }
    try { await api(`/api/pg/calendar-events/${id}/checklist`, { method: 'POST', body: JSON.stringify({ templateId: Number(templateId) }) }); renderCalendarEventDetail({ id }); }
    catch (err) { toast(err.message); }
  });
  document.getElementById('removeChecklistBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog('Remove this checklist? Progress will be lost.')) return;
    try { await api(`/api/pg/checklist-instances/${checklist.Id}`, { method: 'DELETE' }); renderCalendarEventDetail({ id }); }
    catch (err) { toast(err.message); }
  });
  app.querySelectorAll('.checklist-step-toggle').forEach((cb) => cb.addEventListener('change', async () => {
    try { await api(`/api/pg/checklist-steps/${cb.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ done: cb.checked }) }); renderCalendarEventDetail({ id }); }
    catch (err) { toast(err.message); }
  }));
}

// ---------- Admin: Checklist Templates ----------

async function renderAdminChecklistTemplates() {
  setChrome({ title: 'Checklist Templates', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const { templates } = await api('/api/pg/checklist-templates');
  let editingId = null;

  let uidCounter = 0;
  const stepRowHtml = (step = {}) => {
    const uid = `s${uidCounter++}`;
    const text = typeof step === 'string' ? step : (step.Text || '');
    return `<div class="card step-row" data-uid="${uid}" data-depends-uid="${step.dependsOnUid || ''}" style="padding:10px 12px;margin-bottom:8px">
      <div class="inline-add-row"><input class="step-text" value="${escapeHtml(text)}" placeholder="Step description…" /><button type="button" class="btn btn-secondary row-remove">✕</button></div>
      <div class="field-row" style="margin:8px 0 0"><label style="font-size:0.82rem">Only show this step when… (optional)</label>
        <div style="display:flex;gap:8px">
          <select class="step-depends-on" style="flex:2"></select>
          <select class="step-show-when" style="flex:1"><option value="true" ${step.ShowWhenChecked !== false ? 'selected' : ''}>is checked</option><option value="false" ${step.ShowWhenChecked === false ? 'selected' : ''}>is unchecked</option></select>
        </div>
      </div>
    </div>`;
  };

  function refreshDependencyOptions(container) {
    const rows = [...container.querySelectorAll('.step-row')];
    rows.forEach((row) => {
      const select = row.querySelector('.step-depends-on');
      const currentValue = select.value || row.dataset.dependsUid;
      const options = rows.filter((r) => r !== row).map((r) => {
        const label = r.querySelector('.step-text').value.trim() || '(untitled step)';
        return `<option value="${r.dataset.uid}">${escapeHtml(label)}</option>`;
      }).join('');
      select.innerHTML = `<option value="">— none, always show —</option>${options}`;
      if ([...select.options].some((o) => o.value === currentValue)) select.value = currentValue;
    });
  }

  function formHtml(t) {
    uidCounter = 0;
    // Resolve each step's DependsOnIndex to the uid it'll get when re-rendered (same order).
    const stepsWithUid = (t?.Steps || []).map((s, i, arr) => ({ ...s, dependsOnUid: s.DependsOnIndex != null ? `s${s.DependsOnIndex}` : '' }));
    const rows = stepsWithUid.map(stepRowHtml).join('');
    return `<div class="card">
      <h3>${t ? `Edit "${escapeHtml(t.Name)}"` : 'New Checklist'}</h3>
      <div class="field-row"><label>Name</label><input class="cf-name" value="${escapeHtml(t?.Name || '')}" placeholder="e.g. Winterization" required /></div>
      <div class="field-row"><label>Steps (in order)</label>
        <div class="cf-steps">${rows}</div>
        <button type="button" class="btn btn-secondary cf-add-step" style="margin-top:6px">+ Add Step</button>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary cf-save" data-id="${t?.Id ?? ''}">Save Checklist</button>
        <button class="btn btn-secondary cf-cancel">Cancel</button>
      </div>
    </div>`;
  }

  function draw() {
    const list = templates.map((t) => `
      <div class="list-item" style="cursor:default">
        <span><strong>${escapeHtml(t.Name)}</strong> <span class="muted">(${t.Steps.length} steps)</span></span>
        <div class="btn-row" style="margin-top:0">
          <button class="btn btn-secondary cl-edit" data-id="${t.Id}">Edit</button>
          <button class="btn btn-secondary cl-delete" data-id="${t.Id}" data-name="${escapeHtml(t.Name)}">Delete</button>
        </div>
      </div>`).join('') || '<p class="muted">✅ No checklists yet.</p>';

    setApp(`
      <div class="card"><h3>Checklist Templates</h3><p class="muted">Ordered step-by-step lists you can attach to a Work Order or a Calendar Event.</p></div>
      ${list}
      ${editingId === 'new' ? formHtml(null) : `<div class="btn-row" style="margin:4px 0 16px"><button class="btn btn-secondary" id="newChecklistBtn">+ New Checklist</button></div>`}
      ${typeof editingId === 'number' ? formHtml(templates.find((t) => t.Id === editingId)) : ''}
    `);
    wire();
  }

  function wire() {
    document.getElementById('newChecklistBtn')?.addEventListener('click', () => { editingId = 'new'; draw(); });
    app.querySelectorAll('.cl-edit').forEach((btn) => btn.addEventListener('click', () => { editingId = Number(btn.dataset.id); draw(); }));
    app.querySelectorAll('.cf-cancel').forEach((btn) => btn.addEventListener('click', () => { editingId = null; draw(); }));
    const stepsContainer = document.querySelector('.cf-steps');
    if (stepsContainer) {
      document.querySelector('.cf-add-step').addEventListener('click', () => {
        stepsContainer.insertAdjacentHTML('beforeend', stepRowHtml());
        wireStepRow();
      });
      wireStepRow();
      refreshDependencyOptions(stepsContainer);
    }

    function wireStepRow() {
      stepsContainer.querySelectorAll('.row-remove').forEach((btn) => {
        btn.onclick = () => { btn.closest('.step-row').remove(); refreshDependencyOptions(stepsContainer); };
      });
      stepsContainer.querySelectorAll('.step-text').forEach((input) => {
        input.oninput = () => refreshDependencyOptions(stepsContainer);
      });
    }

    app.querySelectorAll('.cl-delete').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog(`Delete checklist "${btn.dataset.name}"? Any WOs/events already using it keep their own copy of the steps.`)) return;
      await api(`/api/pg/checklist-templates/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Checklist deleted');
      renderAdminChecklistTemplates();
    }));

    app.querySelectorAll('.cf-save').forEach((btn) => btn.addEventListener('click', async () => {
      const card = btn.closest('.card');
      const name = card.querySelector('.cf-name').value.trim();
      if (!name) { toast('Name is required'); return; }
      const stepRows = [...card.querySelectorAll('.step-row')];
      const steps = stepRows.map((row) => {
        const dependsUid = row.querySelector('.step-depends-on').value;
        const dependsOnIndex = dependsUid ? stepRows.findIndex((r) => r.dataset.uid === dependsUid) : -1;
        return {
          text: row.querySelector('.step-text').value.trim(),
          dependsOnIndex: dependsOnIndex >= 0 ? dependsOnIndex : null,
          showWhenChecked: row.querySelector('.step-show-when').value === 'true',
        };
      }).filter((s) => s.text);
      const id = btn.dataset.id;
      try {
        await api(id ? `/api/pg/checklist-templates/${id}` : '/api/pg/checklist-templates', { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ name, steps }) });
        toast(id ? 'Checklist updated' : 'Checklist created');
        renderAdminChecklistTemplates();
      } catch (err) { toast(err.message); }
    }));
  }

  draw();
}

// ---------- Work Orders ----------

async function renderWorkOrders() {
  setChrome({ title: 'Work Orders', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;
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
  const { templates } = await api('/api/pg/work-order-templates');
  const fieldTitles = state.options.propertyFields.map((f) => f.title);
  const taskRowHtml = (text = '') => `<div class="inline-add-row task-row"><input class="task-text" value="${escapeHtml(text)}" placeholder="Task description…" /><button type="button" class="btn btn-secondary row-remove">✕</button></div>`;
  const jobLineRowHtml = (row = {}) => `<div class="inline-add-row jl-row" style="align-items:center">
    <select class="jl-field" style="flex:1">${fieldTitles.map((t) => `<option ${row.targetField === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>
    <input class="jl-value" placeholder="Value" value="${escapeHtml(row.newValue || '')}" style="flex:1" />
    <button type="button" class="btn btn-secondary row-remove">✕</button>
  </div>`;

  setApp(`
    <div class="card">
      <h3>New Work Order</h3>
      ${templates.length ? `<div class="field-row"><label>Start from Template (optional)</label>
        <select id="tplPicker"><option value="">— none —</option>${templates.map((t) => `<option value="${t.Id}">${escapeHtml(t.Name)}</option>`).join('')}</select>
      </div>` : ''}
      <form id="newWoForm">
        <div class="field-row"><label>Title</label><input name="title" required /></div>
        <div class="field-row"><label>Asset</label>
          ${assetId ? `<input value="${escapeHtml(assetName)}" disabled />` : `<div id="woAssetPicker"></div>`}
        </div>
        <div class="field-row"><label>Priority</label>
          <select name="priority"><option>Low</option><option selected>Medium</option><option>High</option><option>Urgent</option></select>
        </div>
        <div class="field-row"><label>Scheduled Date</label><input name="scheduledDate" type="date" /></div>
        <div class="field-row"><label>Description</label><textarea name="description"></textarea></div>
        <div class="field-row"><label>Tasks (scope of work)</label>
          <div class="task-rows"></div>
          <button type="button" class="btn btn-secondary" id="addTaskRowBtn" style="margin-top:6px">+ Add Task</button>
        </div>
        <details style="margin:16px 0">
          <summary style="cursor:pointer;font-weight:700">Also update asset fields (optional)</summary>
          <p class="muted" style="margin:8px 0">Only for the rare case this WO should change a stable asset fact — most work orders don't need this.</p>
          <div class="jl-rows"></div>
          <button type="button" class="btn btn-secondary" id="addJlBtn" style="margin-top:6px">+ Add Field Update</button>
        </details>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Create Work Order</button>
          <button class="btn btn-secondary" type="button" id="cancelWoBtn">Cancel</button>
        </div>
      </form>
    </div>`);

  let assetPicker = null;
  if (!assetId) assetPicker = mountAssetCombobox(document.getElementById('woAssetPicker'));

  function wireRowRemove() { app.querySelectorAll('.row-remove').forEach((btn) => { btn.onclick = () => btn.closest('.inline-add-row').remove(); }); }
  document.getElementById('addTaskRowBtn').addEventListener('click', () => {
    document.querySelector('.task-rows').insertAdjacentHTML('beforeend', taskRowHtml());
    wireRowRemove();
  });
  document.getElementById('addJlBtn').addEventListener('click', () => {
    document.querySelector('.jl-rows').insertAdjacentHTML('beforeend', jobLineRowHtml());
    wireRowRemove();
  });

  document.getElementById('tplPicker')?.addEventListener('change', (e) => {
    const tpl = templates.find((t) => t.Id === Number(e.target.value));
    const form = document.getElementById('newWoForm');
    if (!tpl) return;
    if (tpl.DefaultTitle) form.title.value = tpl.DefaultTitle;
    if (tpl.DefaultPriority) form.priority.value = tpl.DefaultPriority;
    if (tpl.DefaultDescription) form.description.value = tpl.DefaultDescription;
    document.querySelector('.task-rows').innerHTML = (tpl.TaskDefaults || []).map(taskRowHtml).join('');
    document.querySelector('.jl-rows').innerHTML = (tpl.JobLineDefaults || []).map(jobLineRowHtml).join('');
    wireRowRemove();
    toast(`Prefilled from "${tpl.Name}" — review before creating`);
  });

  document.getElementById('cancelWoBtn').addEventListener('click', goBack);
  document.getElementById('newWoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const title = fd.get('title');
    const finalAssetId = assetId || assetPicker?.getSelected()?.Id;
    if (!finalAssetId) { toast('Pick an asset first (or add a new one)'); return; }
    const tasks = [...document.querySelectorAll('.task-row .task-text')].map((el) => el.value.trim()).filter(Boolean);
    const assetUpdates = [...document.querySelectorAll('.jl-row')].map((row) => ({
      targetField: row.querySelector('.jl-field').value, newValue: row.querySelector('.jl-value').value,
    })).filter((r) => r.newValue.trim());
    try {
      const result = await api('/api/pg/work-orders', { method: 'POST', body: JSON.stringify({
        title, assetId: Number(finalAssetId), priority: fd.get('priority'), description: fd.get('description'),
        scheduledDate: fd.get('scheduledDate') || undefined, tasks, assetUpdates,
      }) });
      toast('Work order created');
      go('workOrderDetail', { id: result.workOrderId }, { replace: true });
    } catch (err) { toast(err.message); }
  });
}

async function renderWorkOrderDetail({ id }) {
  setChrome({ title: 'Work Order', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const [detail, allVolunteers, allVendors, skillsRes, tplRes] = await Promise.all([
    api(`/api/pg/work-orders/${id}`), api('/api/pg/volunteers'), api('/api/pg/vendors'), api('/api/pg/skills'),
    api('/api/pg/checklist-templates'),
  ]);
  const allSkills = skillsRes.skills.map((s) => s.Name);
  const checklistTemplates = tplRes.templates;
  const { workOrder: wo, assetUpdates, volunteers, vendors, tasks, checklist } = detail;
  const propertyFieldTitles = state.options.propertyFields.map((f) => f.title);

  const taskRows = tasks.map((t) => `
    <div class="list-item" style="cursor:default">
      <label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer">
        <input type="checkbox" class="task-toggle" data-id="${t.Id}" ${t.Done ? 'checked' : ''} />
        <span style="${t.Done ? 'text-decoration:line-through;color:var(--muted)' : ''}">${escapeHtml(t.Description)}</span>
      </label>
      <button class="btn btn-secondary delete-task" data-id="${t.Id}" data-label="${escapeHtml(t.Description)}">Delete</button>
    </div>`).join('') || '<p class="muted">No tasks yet — add the scope of work below.</p>';

  const fieldUpdateRows = assetUpdates.map((u) => `
    <div class="list-item" style="cursor:default">
      <span>${escapeHtml(u['Target Field'])} → <strong>${escapeHtml(u['New Value'])}</strong></span>
      <span>
        <span class="pill ${u.Applied ? 'good' : ''}">${u.Applied ? 'Applied' : 'Pending'}</span>
        ${!u.Applied ? `<button class="btn btn-secondary delete-au" data-id="${u.Id}" data-label="${escapeHtml(u['Target Field'])}" style="margin-left:8px">Delete</button>` : ''}
      </span>
    </div>`).join('') || '<p class="muted">None.</p>';

  const checklistHtml = checklist ? checklistHtmlFor(checklist)
    : (checklistTemplates.length ? `
    <div class="card"><h3>Checklist</h3>
      <p class="muted">Attach a step-by-step checklist to this work order.</p>
      <div class="field-row"><select id="checklistTplPicker"><option value="">— choose a checklist —</option>${checklistTemplates.map((t) => `<option value="${t.Id}">${escapeHtml(t.Name)} (${t.Steps.length} steps)</option>`).join('')}</select></div>
      <button class="btn btn-secondary" id="attachChecklistBtn">Attach Checklist</button>
    </div>` : '');

  const assignedVolIds = new Set(volunteers.map((v) => v.Id));
  const assignedVenIds = new Set(vendors.map((v) => v.Id));
  const availableVols = allVolunteers.volunteers.filter((v) => !assignedVolIds.has(v.Id));
  const availableVens = allVendors.vendors.filter((v) => !assignedVenIds.has(v.Id));

  app.innerHTML = `
    <div class="card">
      <h3>${escapeHtml(wo.Title)}</h3>
      ${wo['Scheduled Date'] ? `<p class="muted"><a href="#" id="viewOnCalendarLink">📅 View on Calendar (${new Date(wo['Scheduled Date']).toLocaleDateString('default', { month: 'long', year: 'numeric' })})</a></p>` : ''}
      <form id="woFieldsForm">
        <div class="field-row"><label>Asset</label><div id="woAssetPicker"></div></div>
        <div class="field-row"><label>Status</label>
          <select name="status">${['Open', 'In Progress', 'On Hold', 'Urgent', 'Done'].map((s) => `<option ${wo.Status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </div>
        <div class="field-row"><label>Priority</label>
          <select name="priority">${['Low', 'Medium', 'High', 'Urgent'].map((s) => `<option ${wo.Priority === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </div>
        <div class="field-row"><label>Scheduled Date</label><input name="scheduledDate" type="date" value="${(wo['Scheduled Date'] || '').slice(0, 10)}" /></div>
        <div class="field-row"><label>Description</label><textarea name="description">${escapeHtml(wo.Description || '')}</textarea></div>
        <div class="field-row"><label>Estimated Hours</label><input name="estimatedHours" type="number" value="${wo['Estimated Hours'] ?? ''}" /></div>
        <div class="field-row"><label>Actual Hours</label><input name="actualHours" type="number" value="${wo['Actual Hours'] ?? ''}" /></div>
        <div class="field-row"><label>Estimated Cost</label><input name="estimatedCost" type="number" step="0.01" value="${wo['Estimated Cost'] ?? ''}" /></div>
        <div class="field-row"><label>Actual Cost</label><input name="actualCost" type="number" step="0.01" value="${wo['Actual Cost'] ?? ''}" /></div>
        <button class="btn btn-secondary" type="submit">Save Changes</button>
      </form>
      <div class="btn-row">
        <button class="btn btn-primary" id="completeWoBtn" ${wo.Status === 'Done' ? 'disabled' : ''}>${wo.Status === 'Done' ? 'Completed' : 'Complete Work Order'}</button>
        <button class="btn btn-secondary" id="duplicateWoBtn">Duplicate</button>
      </div>
    </div>

    <div class="card">
      <h3>Tasks</h3>
      <p class="muted">The scope of work — plain checklist items, not tied to any audit field.</p>
      ${taskRows}
      <div class="inline-add-row"><input class="new-task-input" placeholder="Add a task…" /><button type="button" class="btn btn-secondary" id="addTaskBtn">+</button></div>
    </div>

    ${checklistHtml}

    <details class="card">
      <summary style="cursor:pointer;font-weight:700">Also update asset fields (optional)</summary>
      <p class="muted" style="margin-top:8px">Only for the rare case this WO should change a stable asset fact (e.g. Window Count after installing new windows) — most work orders don't need this.</p>
      ${fieldUpdateRows}
      <form id="addJobLineForm" style="margin-top:10px">
        <div class="field-row"><label>Field</label><select name="targetField" required><option value="">— select —</option>${propertyFieldTitles.map((t) => `<option>${escapeHtml(t)}</option>`).join('')}</select></div>
        <div class="field-row"><label>New Value</label><input name="newValue" required /></div>
        <button class="btn btn-secondary" type="submit">Add Field Update</button>
      </form>
    </details>

    <div class="card">
      <h3>Assigned Crew</h3>
      <h4 style="margin-bottom:6px">Volunteers</h4>
      ${volunteers.map((v) => `<div class="list-item" style="cursor:default"><span>${escapeHtml(v.Name)}</span><button class="btn btn-secondary unassign-vol" data-id="${v.Id}" data-name="${escapeHtml(v.Name)}">Remove</button></div>`).join('') || '<p class="muted">None assigned.</p>'}
      <form id="assignVolForm" style="margin-top:8px">
        <div class="field-row"><select name="volunteerId"><option value="">— add existing volunteer —</option>${availableVols.map((v) => `<option value="${v.Id}">${escapeHtml(v.Name)}</option>`).join('')}</select></div>
        <button class="btn btn-secondary" type="submit">Assign</button>
      </form>
      <button type="button" class="btn btn-secondary" id="newVolToggle" style="margin-top:6px">+ New Volunteer</button>
      <div id="newVolBox" hidden style="margin-top:10px">
        <div class="field-row"><label>Name</label><input id="newVolName" required /></div>
        <div class="field-row"><label>Phone</label><input id="newVolPhone" class="phone-input" type="tel" /></div>
        <div class="field-row"><label>Skills</label>
          <div class="skill-chips" id="newVolSkills">${skillChipsHtml(allSkills, [])}</div>
          <div class="inline-add-row"><input class="new-skill-input" placeholder="Add a new skill…" /><button type="button" class="btn btn-secondary add-skill-btn">+</button></div>
        </div>
        <button type="button" class="btn btn-primary" id="newVolSave">Add & Assign</button>
      </div>

      <h4 style="margin:16px 0 6px">Vendors</h4>
      ${vendors.map((v) => `<div class="list-item" style="cursor:default"><span>${escapeHtml(v.Name)}</span><button class="btn btn-secondary unassign-ven" data-id="${v.Id}" data-name="${escapeHtml(v.Name)}">Remove</button></div>`).join('') || '<p class="muted">None assigned.</p>'}
      <form id="assignVenForm" style="margin-top:8px">
        <div class="field-row"><select name="vendorId"><option value="">— add existing vendor —</option>${availableVens.map((v) => `<option value="${v.Id}">${escapeHtml(v.Name)}</option>`).join('')}</select></div>
        <button class="btn btn-secondary" type="submit">Assign</button>
      </form>
      <button type="button" class="btn btn-secondary" id="newVenToggle" style="margin-top:6px">+ New Vendor</button>
      <div id="newVenBox" hidden style="margin-top:10px">
        <div class="field-row"><label>Name</label><input id="newVenName" required /></div>
        <div class="field-row"><label>Phone</label><input id="newVenPhone" class="phone-input" type="tel" /></div>
        <div class="field-row"><label>Specialties</label>
          <div class="skill-chips" id="newVenSkills">${skillChipsHtml(allSkills, [])}</div>
          <div class="inline-add-row"><input class="new-skill-input" placeholder="Add a new specialty…" /><button type="button" class="btn btn-secondary add-skill-btn">+</button></div>
        </div>
        <button type="button" class="btn btn-primary" id="newVenSave">Add & Assign</button>
      </div>
    </div>`;

  const assetPicker = mountAssetCombobox(document.getElementById('woAssetPicker'), { initialAsset: wo.Asset });

  document.getElementById('woFieldsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!await confirmDialog('Save changes to this work order?')) return;
    const fd = new FormData(e.target);
    const newAsset = assetPicker.getSelected();
    try {
      await api(`/api/pg/work-orders/${id}`, { method: 'PATCH', body: JSON.stringify({
        assetId: newAsset ? newAsset.Id : (wo.Asset ? wo.Asset.Id : ''),
        status: fd.get('status'), priority: fd.get('priority'), description: fd.get('description'),
        scheduledDate: fd.get('scheduledDate') || '',
        estimatedHours: fd.get('estimatedHours'), actualHours: fd.get('actualHours'),
        estimatedCost: fd.get('estimatedCost'), actualCost: fd.get('actualCost'),
      }) });
      toast('Work order updated');
      renderWorkOrderDetail({ id });
    } catch (err) { toast(err.message); }
  });

  document.getElementById('duplicateWoBtn').addEventListener('click', async () => {
    try {
      const result = await api(`/api/pg/work-orders/${id}/duplicate`, { method: 'POST' });
      toast('Work order duplicated');
      go('workOrderDetail', { id: result.workOrderId });
    } catch (err) { toast(err.message); }
  });

  document.getElementById('viewOnCalendarLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    const d = new Date(wo['Scheduled Date']);
    go('calendar', { month: d.getMonth(), year: d.getFullYear() });
  });

  document.getElementById('addTaskBtn').addEventListener('click', async () => {
    const input = document.querySelector('.new-task-input');
    const description = input.value.trim();
    if (!description) return;
    try {
      await api(`/api/pg/work-orders/${id}/tasks`, { method: 'POST', body: JSON.stringify({ description }) });
      renderWorkOrderDetail({ id });
    } catch (err) { toast(err.message); }
  });
  app.querySelectorAll('.task-toggle').forEach((cb) => cb.addEventListener('change', async () => {
    try { await api(`/api/pg/work-order-tasks/${cb.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ done: cb.checked }) }); renderWorkOrderDetail({ id }); }
    catch (err) { toast(err.message); }
  }));
  app.querySelectorAll('.delete-task').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete task "${btn.dataset.label}"?`)) return;
    try { await api(`/api/pg/work-order-tasks/${btn.dataset.id}`, { method: 'DELETE' }); renderWorkOrderDetail({ id }); }
    catch (err) { toast(err.message); }
  }));

  document.getElementById('attachChecklistBtn')?.addEventListener('click', async () => {
    const templateId = document.getElementById('checklistTplPicker').value;
    if (!templateId) { toast('Choose a checklist first'); return; }
    try {
      await api(`/api/pg/work-orders/${id}/checklist`, { method: 'POST', body: JSON.stringify({ templateId: Number(templateId) }) });
      renderWorkOrderDetail({ id });
    } catch (err) { toast(err.message); }
  });
  document.getElementById('removeChecklistBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog('Remove this checklist from the work order? Progress will be lost.')) return;
    try { await api(`/api/pg/checklist-instances/${checklist.Id}`, { method: 'DELETE' }); renderWorkOrderDetail({ id }); }
    catch (err) { toast(err.message); }
  });
  app.querySelectorAll('.checklist-step-toggle').forEach((cb) => cb.addEventListener('change', async () => {
    try { await api(`/api/pg/checklist-steps/${cb.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ done: cb.checked }) }); renderWorkOrderDetail({ id }); }
    catch (err) { toast(err.message); }
  }));

  document.getElementById('completeWoBtn').addEventListener('click', async () => {
    if (!await confirmDialog(`Complete this Work Order? Any pending "asset field update" entries will be written to "${wo.Asset?.Name || 'the asset'}" immediately — this directly changes real asset data.`)) return;
    try {
      await api(`/api/pg/work-orders/${id}/complete`, { method: 'POST' });
      toast('Work order completed — asset updated');
      renderWorkOrderDetail({ id });
    } catch (err) { toast(err.message); }
  });

  document.getElementById('addJobLineForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/api/pg/work-orders/${id}/asset-updates`, { method: 'POST', body: JSON.stringify({ targetField: fd.get('targetField'), newValue: fd.get('newValue') }) });
      renderWorkOrderDetail({ id });
    } catch (err) { toast(err.message); }
  });

  app.querySelectorAll('.delete-au').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete the "${btn.dataset.label}" field update?`)) return;
    try { await api(`/api/pg/work-orders/${id}/asset-updates/${btn.dataset.id}`, { method: 'DELETE' }); renderWorkOrderDetail({ id }); }
    catch (err) { toast(err.message); }
  }));

  document.getElementById('assignVolForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const volunteerId = new FormData(e.target).get('volunteerId');
    if (!volunteerId) return;
    await api(`/api/pg/work-orders/${id}/volunteers`, { method: 'POST', body: JSON.stringify({ volunteerId: Number(volunteerId) }) });
    renderWorkOrderDetail({ id });
  });
  document.getElementById('assignVenForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const vendorId = new FormData(e.target).get('vendorId');
    if (!vendorId) return;
    await api(`/api/pg/work-orders/${id}/vendors`, { method: 'POST', body: JSON.stringify({ vendorId: Number(vendorId) }) });
    renderWorkOrderDetail({ id });
  });

  document.getElementById('newVolToggle').addEventListener('click', () => openCrewAddBox('newVolBox', 'newVenBox'));
  document.getElementById('newVenToggle').addEventListener('click', () => openCrewAddBox('newVenBox', 'newVolBox'));
  wireSkillChipToggle(document.getElementById('newVolSkills'));
  wireSkillChipToggle(document.getElementById('newVenSkills'));
  app.querySelectorAll('.add-skill-btn').forEach(wireAddSkillButton);
  wirePhoneFormatting(app);
  document.getElementById('newVolSave').addEventListener('click', async () => {
    const name = document.getElementById('newVolName').value.trim();
    if (!name) { toast('Name is required'); return; }
    try {
      const { volunteer } = await api('/api/pg/volunteers', { method: 'POST', body: JSON.stringify({
        name, phone: document.getElementById('newVolPhone').value.trim(),
        skill: selectedSkillsOf(document.getElementById('newVolSkills')),
      }) });
      await api(`/api/pg/work-orders/${id}/volunteers`, { method: 'POST', body: JSON.stringify({ volunteerId: volunteer.Id }) });
      toast('Volunteer added and assigned');
      renderWorkOrderDetail({ id });
    } catch (err) { toast(err.message); }
  });
  document.getElementById('newVenSave').addEventListener('click', async () => {
    const name = document.getElementById('newVenName').value.trim();
    if (!name) { toast('Name is required'); return; }
    try {
      const { vendor } = await api('/api/pg/vendors', { method: 'POST', body: JSON.stringify({
        name, phone: document.getElementById('newVenPhone').value.trim(),
        specialty: selectedSkillsOf(document.getElementById('newVenSkills')),
      }) });
      await api(`/api/pg/work-orders/${id}/vendors`, { method: 'POST', body: JSON.stringify({ vendorId: vendor.Id }) });
      toast('Vendor added and assigned');
      renderWorkOrderDetail({ id });
    } catch (err) { toast(err.message); }
  });
  app.querySelectorAll('.unassign-vol').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Remove ${btn.dataset.name} from this work order?`)) return;
    await api(`/api/pg/work-orders/${id}/volunteers/${btn.dataset.id}`, { method: 'DELETE' });
    renderWorkOrderDetail({ id });
  }));
  app.querySelectorAll('.unassign-ven').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Remove ${btn.dataset.name} from this work order?`)) return;
    await api(`/api/pg/work-orders/${id}/vendors/${btn.dataset.id}`, { method: 'DELETE' });
    renderWorkOrderDetail({ id });
  }));
}

// Shared "person" card — used for both Volunteers and Vendors, which are
// structurally identical (name/phone/email/address/skills/active). `kind` is
// 'vol' or 'ven'; skills come from the shared skill_catalog either way.
function personSkillsOf(p, kind) { return (kind === 'vol' ? p.Skill : p.Specialty) || []; }

function skillChipsHtml(allSkills, selected, extraClass = '') {
  return allSkills.map((s) => `<span class="skill-chip ${extraClass} ${selected.includes(s) ? 'selected' : ''}" data-skill="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join('');
}

function wireSkillChipToggle(container) {
  container.querySelectorAll('.skill-chip').forEach((chip) => chip.addEventListener('click', () => chip.classList.toggle('selected')));
}
function selectedSkillsOf(container) {
  return [...container.querySelectorAll('.skill-chip.selected')].map((c) => c.dataset.skill);
}

// The "+ New Volunteer" / "+ New Vendor" inline boxes on WO Detail are mutually
// exclusive — opening one while the other has unsaved text/skills prompts to
// discard rather than silently leaving both open (a prior bug).
function crewAddBoxHasData(boxId) {
  const box = document.getElementById(boxId);
  const hasText = [...box.querySelectorAll('input')].some((i) => i.value.trim());
  const hasSkills = box.querySelectorAll('.skill-chip.selected').length > 0;
  return hasText || hasSkills;
}
function resetCrewAddBox(boxId) {
  const box = document.getElementById(boxId);
  box.querySelectorAll('input').forEach((i) => { i.value = ''; });
  box.querySelectorAll('.skill-chip.selected').forEach((c) => c.classList.remove('selected'));
  box.hidden = true;
}
async function openCrewAddBox(openId, otherId) {
  const otherBox = document.getElementById(otherId);
  if (!otherBox.hidden) {
    if (crewAddBoxHasData(otherId)) {
      const label = otherId === 'newVolBox' ? 'volunteer' : 'vendor';
      if (!await confirmDialog(`You have unsaved new-${label} info entered. Discard it and continue?`)) return;
    }
    resetCrewAddBox(otherId);
  }
  document.getElementById(openId).hidden = false;
}

// US phone auto-format as you type: 5551234567 -> (555) 123-4567.
function formatPhoneValue(raw) {
  const digits = raw.replace(/\D/g, '').slice(0, 10);
  if (digits.length > 6) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length > 3) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  if (digits.length > 0) return `(${digits}`;
  return '';
}
function wirePhoneFormatting(root) {
  root.querySelectorAll('.phone-input').forEach((input) => {
    input.value = formatPhoneValue(input.value);
    input.addEventListener('input', () => {
      const pos = input.value.length;
      input.value = formatPhoneValue(input.value);
      // keep the cursor near the end rather than jumping to start on reformat
      if (pos === input.value.length) input.setSelectionRange(input.value.length, input.value.length);
    });
  });
}

// Reusable "add a new skill/specialty" inline control — used by the Crew edit
// forms AND the Work Order detail's inline quick-add. Creates it in the
// shared catalog and appends a selected chip, no page reload needed.
function wireAddSkillButton(button) {
  button.addEventListener('click', async () => {
    const row = button.closest('.inline-add-row');
    const input = row.querySelector('.new-skill-input');
    const name = input.value.trim();
    if (!name) return;
    try {
      await api('/api/pg/skills', { method: 'POST', body: JSON.stringify({ name }) });
      const chipsEl = row.previousElementSibling; // the .skill-chips div this row sits right after
      const chip = document.createElement('span');
      chip.className = 'skill-chip selected';
      chip.dataset.skill = name;
      chip.textContent = name;
      chip.addEventListener('click', () => chip.classList.toggle('selected'));
      chipsEl.appendChild(chip);
      input.value = '';
    } catch (err) { toast(err.message); }
  });
}

async function renderCrew() {
  setChrome({ title: 'Crew', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const [skillsRes, volsRes, vensRes] = await Promise.all([
    api('/api/pg/skills'), api('/api/pg/volunteers?all=1'), api('/api/pg/vendors?all=1'),
  ]);
  let allSkills = skillsRes.skills.map((s) => s.Name);
  const volunteers = volsRes.volunteers;
  const vendors = vensRes.vendors;
  let editing = null; // { kind: 'vol'|'ven', id } | 'new-vol' | 'new-ven' | null
  let skillFilter = null; // set by clicking a skill chip — filters both lists to that skill

  function personCard(p, kind) {
    const skills = personSkillsOf(p, kind);
    return `<div class="list-item" style="cursor:default;flex-wrap:wrap;align-items:flex-start;gap:10px">
      <div style="flex:1;min-width:180px">
        <div><strong>${escapeHtml(p.Name)}</strong>${!p.Active ? ' <span class="pill">inactive</span>' : ''}</div>
        <div class="muted">${escapeHtml(p['Phone Number'] || '—')}${p.Email ? ' · ' + escapeHtml(p.Email) : ''}</div>
        ${p.Address ? `<div class="muted">${escapeHtml(p.Address)}</div>` : ''}
        ${skills.length ? `<div class="skill-chips">${skills.map((s) => `<span class="skill-chip selected skill-filter-chip" data-skill="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="btn-row" style="margin-top:0">
        <button class="btn btn-secondary edit-person" data-kind="${kind}" data-id="${p.Id}">Edit</button>
        <button class="btn btn-secondary remove-person" data-kind="${kind}" data-id="${p.Id}" data-name="${escapeHtml(p.Name)}" data-active="${p.Active}">${p.Active ? 'Remove' : 'Delete permanently'}</button>
      </div>
    </div>`;
  }

  function personGridHtml(list, kind, emptyMsg) {
    const skillLabel = kind === 'vol' ? 'Skills' : 'Specialties';
    const rows = list.map((p) => `
      <tr>
        <td data-label="Name">${escapeHtml(p.Name)}${!p.Active ? ' <span class="pill">inactive</span>' : ''}</td>
        <td data-label="Phone">${escapeHtml(p['Phone Number'] || '—')}</td>
        <td data-label="Email">${escapeHtml(p.Email || '—')}</td>
        <td data-label="Address">${escapeHtml(p.Address || '—')}</td>
        <td data-label="${skillLabel}"><div class="skill-chips">${personSkillsOf(p, kind).map((s) => `<span class="skill-chip selected skill-filter-chip" data-skill="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join('') || '—'}</div></td>
        <td data-label="Actions"><div class="btn-row" style="margin-top:0">
          <button class="btn btn-secondary edit-person" data-kind="${kind}" data-id="${p.Id}">Edit</button>
          <button class="btn btn-secondary remove-person" data-kind="${kind}" data-id="${p.Id}" data-name="${escapeHtml(p.Name)}" data-active="${p.Active}">${p.Active ? 'Remove' : 'Delete permanently'}</button>
        </div></td>
      </tr>`).join('');
    return `<div style="overflow-x:auto"><table class="report-table">
      <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Address</th><th>${skillLabel}</th><th>Actions</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="muted">${emptyMsg}</td></tr>`}</tbody>
    </table></div>`;
  }

  function editFormHtml(kind, p) {
    const skills = p ? personSkillsOf(p, kind) : [];
    const label = kind === 'vol' ? 'Skills' : 'Specialties';
    return `<div class="card">
      <h3>${p ? `Edit ${escapeHtml(p.Name)}` : (kind === 'vol' ? 'Add Volunteer' : 'Add Vendor')}</h3>
      <div class="field-row"><label>Name</label><input class="ef-name" value="${escapeHtml(p?.Name || '')}" required /></div>
      <div class="field-row"><label>Phone</label><input class="ef-phone phone-input" type="tel" value="${escapeHtml(p?.['Phone Number'] || '')}" /></div>
      <div class="field-row"><label>Email</label><input class="ef-email" type="email" value="${escapeHtml(p?.Email || '')}" /></div>
      <div class="field-row"><label>Address</label><input class="ef-address" value="${escapeHtml(p?.Address || '')}" /></div>
      <div class="field-row"><label>${label}</label>
        <div class="skill-chips ef-skills">${skillChipsHtml(allSkills, skills)}</div>
        <div class="inline-add-row">
          <input class="new-skill-input" placeholder="Add a new ${kind === 'vol' ? 'skill' : 'specialty'}…" />
          <button type="button" class="btn btn-secondary add-skill-btn">+</button>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary ef-save" data-kind="${kind}" data-id="${p?.Id ?? ''}">Save</button>
        <button class="btn btn-secondary ef-cancel">Cancel</button>
      </div>
    </div>`;
  }

  function draw() {
    const mode = getTableViewMode();
    const visibleVols = skillFilter ? volunteers.filter((v) => personSkillsOf(v, 'vol').includes(skillFilter)) : volunteers;
    const visibleVens = skillFilter ? vendors.filter((v) => personSkillsOf(v, 'ven').includes(skillFilter)) : vendors;
    const emptyMsg = skillFilter ? `No one with the skill "${escapeHtml(skillFilter)}".` : '🤷 None yet.';
    setApp(`
      ${tableViewToggleHtml(mode)}
      ${skillFilter ? `<div class="btn-row" style="margin:-6px 0 16px"><button class="btn btn-secondary" id="clearSkillFilter">✕ Filtered by skill: ${escapeHtml(skillFilter)}</button></div>` : ''}

      <div class="card"><h3>Volunteers</h3>
        ${mode === 'table' ? personGridHtml(visibleVols, 'vol', emptyMsg) : (visibleVols.map((v) => personCard(v, 'vol')).join('') || `<p class="muted">${emptyMsg}</p>`)}
      </div>
      ${editing === 'new-vol' ? editFormHtml('vol', null) : `<div class="btn-row" style="margin:-6px 0 16px"><button class="btn btn-secondary" id="addVolBtn">+ Add Volunteer</button></div>`}
      ${editing?.kind === 'vol' ? editFormHtml('vol', volunteers.find((v) => v.Id === editing.id)) : ''}

      <div class="card"><h3>Vendors</h3>
        ${mode === 'table' ? personGridHtml(visibleVens, 'ven', emptyMsg) : (visibleVens.map((v) => personCard(v, 'ven')).join('') || `<p class="muted">${emptyMsg}</p>`)}
      </div>
      ${editing === 'new-ven' ? editFormHtml('ven', null) : `<div class="btn-row" style="margin:-6px 0 16px"><button class="btn btn-secondary" id="addVenBtn">+ Add Vendor</button></div>`}
      ${editing?.kind === 'ven' ? editFormHtml('ven', vendors.find((v) => v.Id === editing.id)) : ''}
    `);
    wire();
  }

  function wire() {
    wireTableViewToggle(draw);
    app.querySelectorAll('.skill-filter-chip').forEach((chip) => chip.addEventListener('click', () => {
      skillFilter = chip.dataset.skill;
      draw();
    }));
    document.getElementById('clearSkillFilter')?.addEventListener('click', () => { skillFilter = null; draw(); });
    document.getElementById('addVolBtn')?.addEventListener('click', () => { editing = 'new-vol'; draw(); });
    document.getElementById('addVenBtn')?.addEventListener('click', () => { editing = 'new-ven'; draw(); });
    app.querySelectorAll('.edit-person').forEach((btn) => btn.addEventListener('click', () => {
      editing = { kind: btn.dataset.kind, id: Number(btn.dataset.id) };
      draw();
    }));
    app.querySelectorAll('.ef-cancel').forEach((btn) => btn.addEventListener('click', () => { editing = null; draw(); }));
    app.querySelectorAll('.ef-skills').forEach(wireSkillChipToggle); // only the editable forms — not the read-only display chips on cards
    app.querySelectorAll('.add-skill-btn').forEach(wireAddSkillButton);
    wirePhoneFormatting(app);

    app.querySelectorAll('.ef-save').forEach((btn) => btn.addEventListener('click', async () => {
      const card = btn.closest('.card');
      const kind = btn.dataset.kind;
      const id = btn.dataset.id;
      const fields = {
        name: card.querySelector('.ef-name').value.trim(),
        phone: card.querySelector('.ef-phone').value.trim(),
        email: card.querySelector('.ef-email').value.trim(),
        address: card.querySelector('.ef-address').value.trim(),
        [kind === 'vol' ? 'skill' : 'specialty']: selectedSkillsOf(card),
      };
      if (!fields.name) { toast('Name is required'); return; }
      const isNew = !id;
      if (!isNew && !await confirmDialog(`Save changes to "${fields.name}"?`)) return;
      try {
        const base = kind === 'vol' ? '/api/pg/volunteers' : '/api/pg/vendors';
        await api(isNew ? base : `${base}/${id}`, { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify(fields) });
        toast(isNew ? 'Added' : 'Saved');
        renderCrew();
      } catch (err) { toast(err.message); }
    }));

    app.querySelectorAll('.remove-person').forEach((btn) => btn.addEventListener('click', async () => {
      const isActive = btn.dataset.active === 'true';
      const msg = isActive
        ? `Remove ${btn.dataset.name}? If they have work order history they'll be deactivated (kept for records, hidden from new assignments); otherwise deleted entirely.`
        : `Permanently delete ${btn.dataset.name}? This cannot be undone.`;
      if (!await confirmDialog(msg)) return;
      const base = btn.dataset.kind === 'vol' ? '/api/pg/volunteers' : '/api/pg/vendors';
      try {
        const result = await api(`${base}/${btn.dataset.id}`, { method: 'DELETE' });
        toast(result.deactivated ? 'Deactivated (had work order history)' : 'Deleted');
        renderCrew();
      } catch (err) { toast(err.message); }
    }));
  }

  draw();
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
