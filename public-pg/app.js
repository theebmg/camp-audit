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

// Postgres date/timestamp columns arrive as raw ISO strings (e.g.
// "2026-08-28T00:00:00.000Z") — this renders them as "Aug 28, 2026" instead.
function formatDateNice(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('default', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
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
function setApp(html, container = app) {
  container.innerHTML = html;
  container.classList.remove('view-fade');
  void container.offsetWidth; // force reflow so the animation replays
  container.classList.add('view-fade');
}

const LOADING_HTML = '<div class="loading-wrap"><div class="spinner"></div><span>Loading…</span></div>';

// Finder-style drill-down (Locations -> Assets in Location -> Asset Detail),
// active only when there's enough width for it to look like anything but
// three cramped columns. Narrow screens keep the existing one-view-at-a-time
// behavior untouched — renderLocations/renderAssetsInLocation/renderAssetDetail
// all still work exactly as before when called with no container override.
// 3-pane views (Locations, Admin) need real headroom above each pane's
// 380px floor before a location/tool name reliably fits without ellipsis —
// measured against real data, 1750 is where that's true for all but the
// rare outlier name. Below it, the single-view + breadcrumb-trail
// navigation (see renderBreadcrumbs) handles it instead, which is the
// better experience on a laptop-width window anyway rather than 3 cramped
// columns.
const DRILLDOWN_MIN_WIDTH = 1750;
const DRILLDOWN_VIEWS = new Set(['locations', 'workOrders', 'admin']); // views with a pane variant to swap to/from on resize

// ---- Theme (Light/Dark/System) + accent color — persisted per-browser.
// ACCENT_PRESETS is set by an early inline <script> in index.html (applied
// before first paint, to avoid a flash of the wrong colors); this is the
// same object, just referenced here for the interactive picker.
function getThemeChoice() {
  const saved = localStorage.getItem('campAuditTheme');
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}
function getEffectiveTheme() {
  const choice = getThemeChoice();
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyAccent(key) {
  const preset = window.ACCENT_PRESETS[key];
  if (!preset) return;
  const v = preset[getEffectiveTheme()];
  const root = document.documentElement.style;
  root.setProperty('--accent', v[0]); root.setProperty('--accent-dark', v[1]);
  root.setProperty('--accent-soft', v[2]); root.setProperty('--accent-text', v[3]);
}
function applyTheme(choice) {
  if (choice === 'system') { document.documentElement.removeAttribute('data-theme'); localStorage.removeItem('campAuditTheme'); }
  else { document.documentElement.setAttribute('data-theme', choice); localStorage.setItem('campAuditTheme', choice); }
  const accentKey = localStorage.getItem('campAuditAccent');
  if (accentKey) applyAccent(accentKey); // re-resolve for the new effective theme
}
function renderThemePicker() {
  const el = document.getElementById('themePicker');
  if (!el) return;
  const choice = getThemeChoice();
  const accentKey = localStorage.getItem('campAuditAccent') || 'green';
  el.innerHTML = `
    <div class="view-toggle">
      ${['system', 'light', 'dark'].map((c) => `<button type="button" class="view-toggle-btn theme-choice-btn ${choice === c ? 'active' : ''}" data-choice="${c}">${c === 'system' ? '🖥️ System' : c === 'light' ? '☀️ Light' : '🌙 Dark'}</button>`).join('')}
    </div>
    <div class="accent-swatches">
      ${Object.entries(window.ACCENT_PRESETS).map(([key, preset]) => `<button type="button" class="accent-swatch ${accentKey === key ? 'active' : ''}" data-accent="${key}" style="background:${preset.light[0]}" title="${key}"></button>`).join('')}
    </div>`;
  el.querySelectorAll('.theme-choice-btn').forEach((btn) => btn.addEventListener('click', () => {
    applyTheme(btn.dataset.choice);
    renderThemePicker();
  }));
  el.querySelectorAll('.accent-swatch').forEach((btn) => btn.addEventListener('click', () => {
    localStorage.setItem('campAuditAccent', btn.dataset.accent);
    applyAccent(btn.dataset.accent);
    renderThemePicker();
  }));
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (getThemeChoice() === 'system') { const k = localStorage.getItem('campAuditAccent'); if (k) applyAccent(k); }
});

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
  { icon: '📝', label: 'Start Audit', view: 'auditPicker' },
  { icon: '📍', label: 'Locations', view: 'locations' },
  { icon: '🛠️', label: 'Work Orders', view: 'workOrders' },
  { icon: '🧰', label: 'Requests', view: 'requests' },
  { icon: '📅', label: 'Calendar', view: 'calendar' },
  { icon: '👷', label: 'Crew', view: 'crew' },
  { icon: '🕒', label: 'Hours', view: 'crewHours' },
  { icon: '📋', label: 'Maintenance Log', view: 'maintenanceLog' },
  { icon: '💰', label: 'Capital Plan', view: 'capitalPlan' },
  { icon: '📊', label: 'Reports', view: 'reports' },
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

// Crossing the drill-down width threshold mid-session (window resize) should
// swap between the single-view and pane layouts, not leave the wrong one on
// screen. Only re-renders when the current view actually has a pane variant.
let resizeReflowTimer;
let lastAboveDrilldownWidth = window.innerWidth >= DRILLDOWN_MIN_WIDTH;
window.addEventListener('resize', () => {
  clearTimeout(resizeReflowTimer);
  resizeReflowTimer = setTimeout(() => {
    const nowAbove = window.innerWidth >= DRILLDOWN_MIN_WIDTH;
    if (nowAbove === lastAboveDrilldownWidth) return;
    lastAboveDrilldownWidth = nowAbove;
    const top = state.stack[state.stack.length - 1];
    if (top && DRILLDOWN_VIEWS.has(top.view)) render(top.view, top.params);
  }, 200);
});

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

// Below the drill-down width, panes collapse to one full-page view at a
// time (see DRILLDOWN_VIEWS) — the only way back is the single "back" arrow,
// one hop per tap. On a phone, a location -> asset -> asset detail chain is
// three taps to get back to the top; a breadcrumb trail lets you jump to any
// ancestor directly instead. Wide screens don't need this (the panes are all
// visible at once), so it's narrow-only.
function breadcrumbLabel({ view, params }) {
  if (view === 'assetsInLocation') return params.name || 'Assets';
  if (view === 'assetDetail') return params.name || 'Asset';
  if (view === 'workOrderDetail') return params.title || 'Work Order';
  if (view === 'requestDetail') return params.label || 'Request';
  if (view === 'adminCategory') return ADMIN_CATEGORIES[params.category]?.title || 'Category';
  if (ADMIN_TOOL_LABELS[view]) return ADMIN_TOOL_LABELS[view];
  return NAV_ITEMS.find((n) => n.view === view)?.label || view;
}
function renderBreadcrumbs() {
  if (window.innerWidth >= DRILLDOWN_MIN_WIDTH || state.stack.length < 2) { breadcrumbsEl.hidden = true; return; }
  breadcrumbsEl.hidden = false;
  breadcrumbsEl.innerHTML = state.stack.map((entry, i) => {
    const label = escapeHtml(breadcrumbLabel(entry));
    return (i > 0 ? '<span class="crumb-sep">›</span>' : '') + (i === state.stack.length - 1
      ? `<span class="crumb-current">${label}</span>`
      : `<a href="#" class="crumb-link" data-idx="${i}">${label}</a>`);
  }).join('');
  breadcrumbsEl.querySelectorAll('.crumb-link').forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    const idx = Number(el.dataset.idx);
    const target = state.stack[idx];
    state.stack = state.stack.slice(0, idx + 1);
    render(target.view, target.params);
  }));
}

async function render(view, params = {}) {
  try {
    if (view === 'login') { await renderLogin(); return fadeInApp(); }
    if (!state.user) { await renderLogin(); return fadeInApp(); }
    if (!state.options) state.options = await api('/api/pg/options');
    renderSidebar(view);
    setChrome({ title: '', showBack: state.stack.length > 1, showLogout: true });
    renderBreadcrumbs();
    const handlers = {
      dashboard: () => renderDashboard(),
      auditPicker: () => renderAuditPicker(),
      locations: () => (window.innerWidth >= DRILLDOWN_MIN_WIDTH ? renderLocationsDrilldown() : renderLocations()),
      assetsInLocation: () => renderAssetsInLocation(params),
      assetDetail: () => renderAssetDetail(params),
      audit: () => renderAudit(params),
      assetHistory: () => renderAssetHistory(params),
      capitalPlan: () => renderCapitalPlan(),
      maintenanceLog: () => renderMaintenanceLog(),
      reports: () => renderReports(params),
      editAsset: () => renderEditAsset(params),
      admin: () => (window.innerWidth >= DRILLDOWN_MIN_WIDTH ? renderAdminDrilldown() : renderAdminHub()),
      adminCategory: () => renderAdminCategory(params),
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
      workOrders: () => (window.innerWidth >= DRILLDOWN_MIN_WIDTH ? renderWorkOrdersDrilldown(params) : renderWorkOrders(params)),
      workOrderDetail: () => renderWorkOrderDetail(params),
      newWorkOrder: () => renderNewWorkOrder(params),
      crew: () => renderCrew(),
      crewHours: () => renderCrewHours(),
      adminUsers: () => renderAdminUsers(),
      activityLog: () => renderActivityLog(),
      requests: () => renderRequests(params),
      requestDetail: () => renderRequestDetail(params),
      adminRequestFields: () => renderAdminRequestFields(),
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

const DASHBOARD_WIDGET_DEFAULTS = { woOverview: true, calendar: true, activity: true };
function getDashboardWidgetPrefs() {
  try {
    const raw = localStorage.getItem('campAuditDashboardWidgets');
    return raw ? { ...DASHBOARD_WIDGET_DEFAULTS, ...JSON.parse(raw) } : { ...DASHBOARD_WIDGET_DEFAULTS };
  } catch { return { ...DASHBOARD_WIDGET_DEFAULTS }; }
}

function startOfWeek(d) { const s = new Date(d); s.setDate(s.getDate() - s.getDay()); return s; }
// Local calendar-date key (YYYY-MM-DD) — NOT toISOString(), which converts to
// UTC first and silently shifts the date by a day in any timezone west of
// UTC (most of the US) whenever the local time-of-day pushes across the UTC
// day boundary. Matches how the Calendar month view already builds its date
// strings, and how the server's plain `date` columns compare.
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function renderDashboard() {
  setChrome({ title: 'Dashboard', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const prefs = getDashboardWidgetPrefs();
  const currentUser = state.options?.currentUser || {};
  const isAdmin = currentUser.role === 'admin';

  const today = new Date();
  const weekStart = startOfWeek(today);
  const weekDays = Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); return d; });
  const weekEnd = weekDays[6];

  let selectedWeekDate = isoDate(today);
  const weekOccByDay = new Map();

  const [woSummary, calRes, scheduledWoRes, activityRes] = await Promise.all([
    prefs.woOverview ? api('/api/pg/dashboard/wo-summary') : Promise.resolve(null),
    prefs.calendar ? api(`/api/pg/calendar-events?from=${isoDate(weekStart)}&to=${isoDate(weekEnd)}`) : Promise.resolve(null),
    prefs.calendar ? api('/api/pg/work-orders') : Promise.resolve(null),
    prefs.activity ? api(`/api/pg/activity-log?limit=12${isAdmin ? '' : `&username=${encodeURIComponent(currentUser.username || '')}`}`) : Promise.resolve(null),
  ]);

  function statTile(n, label, colorClass, filterParams) {
    return `<div class="bucket-tile tile-${colorClass}${filterParams ? ' clickable-tile wo-filter-tile' : ''}" ${filterParams ? `data-filter='${JSON.stringify(filterParams)}'` : ''}>
      <div class="n">${n}</div><div class="muted">${escapeHtml(label)}</div>
    </div>`;
  }

  function woOverviewHtml() {
    if (!woSummary) return '';
    const s = woSummary;
    return `<div class="card">
      <h3>Work Orders</h3>
      <p class="muted" style="margin-top:-6px">By status</p>
      <div class="summary-buckets">
        ${statTile(s.Open, 'Open', 'neutral', { status: 'Open' })}
        ${statTile(s.InProgress, 'In Progress', 'pop', { status: 'In Progress' })}
        ${statTile(s.OnHold, 'On Hold', 'warn', { status: 'On Hold' })}
        ${statTile(s.Urgent, 'Urgent', 'bad', { status: 'Urgent' })}
        ${statTile(s.Done, 'Done', 'good', { status: 'Done' })}
      </div>
      <p class="muted">By schedule (open WOs only)</p>
      <div class="summary-buckets">
        ${statTile(s.PastDue, 'Past Due', 'bad', { schedule: 'pastDue' })}
        ${statTile(s.DueToday, 'Due Today', 'pop', { schedule: 'dueToday' })}
        ${statTile(s.DueFuture, 'Due Later', 'good', { schedule: 'dueFuture' })}
        ${statTile(s.Unscheduled, 'Unscheduled', 'neutral', { schedule: 'unscheduled' })}
      </div>
    </div>`;
  }

  function calendarStripHtml() {
    if (!calRes) return '';
    weekOccByDay.clear();
    for (const occ of calRes.occurrences) {
      const key = occ.OccurrenceDate;
      if (!weekOccByDay.has(key)) weekOccByDay.set(key, []);
      weekOccByDay.get(key).push({ type: 'event', ...occ });
    }
    // Work orders with a Scheduled Date show on the full Calendar page too —
    // this widget was only pulling standalone calendar_events and silently
    // omitting the far more common case of a WO scheduled for a date.
    const weekStartStr = isoDate(weekStart);
    const weekEndStr = isoDate(weekEnd);
    for (const w of (scheduledWoRes?.workOrders || [])) {
      const sd = w['Scheduled Date'] ? w['Scheduled Date'].slice(0, 10) : null;
      if (!sd || sd < weekStartStr || sd > weekEndStr) continue;
      if (!weekOccByDay.has(sd)) weekOccByDay.set(sd, []);
      weekOccByDay.get(sd).push({ type: 'wo', ...w });
    }
    const todayStr = isoDate(today);
    const cells = weekDays.map((d) => {
      const key = isoDate(d);
      const dayEvents = weekOccByDay.get(key) || [];
      return `<div class="cal-strip-day ${key === todayStr ? 'cal-strip-today' : ''} ${key === selectedWeekDate ? 'cal-strip-selected' : ''}" data-date="${key}">
        <div class="cal-strip-dow">${d.toLocaleDateString('default', { weekday: 'short' })}</div>
        <div class="cal-strip-num">${d.getDate()}</div>
        ${dayEvents.slice(0, 2).map((e) => `<div class="cal-strip-event">${e.type === 'wo' ? '🛠️ ' : '📅 '}${escapeHtml(e.Title)}</div>`).join('')}
        ${dayEvents.length > 2 ? `<div class="muted" style="font-size:0.75rem">+${dayEvents.length - 2} more</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="card">
      <h3>This Week</h3>
      <div class="field-row" style="margin-bottom:10px"><select id="weekDaySelect">
        ${weekDays.map((d) => `<option value="${isoDate(d)}" ${isoDate(d) === selectedWeekDate ? 'selected' : ''}>${d.toLocaleDateString('default', { weekday: 'long', month: 'short', day: 'numeric' })}${isoDate(d) === todayStr ? ' (Today)' : ''}</option>`).join('')}
      </select></div>
      <div class="cal-strip">${cells}</div>
      <div id="weekDaySummary" style="margin-top:14px">${weekDaySummaryHtml(selectedWeekDate)}</div>
    </div>`;
  }

  function weekDaySummaryHtml(dateKey) {
    const dayEvents = weekOccByDay.get(dateKey) || [];
    const label = new Date(`${dateKey}T00:00:00`).toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric' });
    if (!dayEvents.length) return `<p class="muted">No events scheduled for ${escapeHtml(label)}.</p>`;
    return `<p class="muted" style="margin-bottom:6px">${escapeHtml(label)}</p>` + dayEvents.map((e) => e.type === 'wo'
      ? `<div class="list-item cal-strip-wo-link" style="cursor:pointer" data-wo-id="${e.Id}">
          <span>🛠️ ${escapeHtml(e.Asset?.Name || '')}${e.Asset ? ': ' : ''}${escapeHtml(e.Title)}</span>
          <span class="pill ${woStatusPillClass(e.Status)}">${escapeHtml(e.Status || '')}</span>
        </div>`
      : `<div class="list-item cal-strip-event-link" style="cursor:pointer" data-event-id="${e.Id}">
          <span>📅 ${escapeHtml(e.Title)}${e.RecurrenceType !== 'none' ? ' 🔁' : ''}</span>
          ${e.WorkOrderId ? `<span class="pill">linked WO</span>` : ''}
        </div>`).join('');
  }

  function activityHtml() {
    if (!activityRes) return '';
    // The dashboard is a "what's been accomplished" glance, not an audit
    // trail — deletions (and routine toggles) stay out of it but are still
    // fully visible in Admin > Activity Log for the "what got deleted" case.
    const entries = activityRes.entries.filter((e) => e.Action !== 'toggled' && e.Action !== 'deleted');
    return `<div class="card">
      <h3>${isAdmin ? 'Recent Activity (everyone)' : 'Your Recent Activity'}</h3>
      ${entries.length ? entries.map((e) => `
        <div class="list-item" style="cursor:default">
          <span>${escapeHtml(activityNarrative(e))}</span>
          <span class="muted">${new Date(e.OccurredAt).toLocaleString()}${isAdmin ? ` · ${escapeHtml(e.Username || '')}` : ''}</span>
        </div>`).join('') : '<p class="muted">Nothing yet.</p>'}
      <div class="btn-row"><button class="btn btn-secondary" id="viewFullLogBtn">View Full Activity Log</button></div>
    </div>`;
  }

  function draw() {
    setApp(`
      <div class="card">
        <h3>Welcome${state.user ? `, ${escapeHtml(state.user)}` : ''}</h3>
        <p class="muted" style="margin-top:-4px">${today.toLocaleDateString('default', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
        <div class="btn-row" style="margin-top:10px">
          <div class="list-item" data-view="locations" style="flex:1;min-width:140px">📍 Browse Locations</div>
          <div class="list-item" data-view="maintenanceLog" style="flex:1;min-width:140px">📋 Maintenance Log</div>
          <div class="list-item" data-view="capitalPlan" style="flex:1;min-width:140px">💰 Capital Plan</div>
        </div>
        <details style="margin-top:10px">
          <summary class="muted" style="cursor:pointer">Customize dashboard</summary>
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:10px">
            <label style="display:flex;align-items:center;gap:6px;font-weight:400"><input type="checkbox" class="widget-toggle" data-widget="woOverview" ${prefs.woOverview ? 'checked' : ''} style="width:auto" /> Work Order overview</label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400"><input type="checkbox" class="widget-toggle" data-widget="calendar" ${prefs.calendar ? 'checked' : ''} style="width:auto" /> This week's calendar</label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400"><input type="checkbox" class="widget-toggle" data-widget="activity" ${prefs.activity ? 'checked' : ''} style="width:auto" /> Recent activity</label>
          </div>
        </details>
      </div>
      ${woOverviewHtml()}
      ${calendarStripHtml()}
      ${activityHtml()}
    `);
    app.querySelectorAll('[data-view]').forEach((el) => el.addEventListener('click', () => go(el.dataset.view, {})));
    app.querySelectorAll('.wo-filter-tile').forEach((el) => el.addEventListener('click', () => go('workOrders', JSON.parse(el.dataset.filter))));

    function wireWeekSummaryLinks(root) {
      root.querySelectorAll('.cal-strip-event-link').forEach((el) => el.addEventListener('click', () => go('calendarEventDetail', { id: el.dataset.eventId })));
      root.querySelectorAll('.cal-strip-wo-link').forEach((el) => el.addEventListener('click', () => go('workOrderDetail', { id: el.dataset.woId })));
    }
    function selectWeekDate(dateKey) {
      selectedWeekDate = dateKey;
      document.getElementById('weekDaySelect').value = dateKey;
      app.querySelectorAll('.cal-strip-day').forEach((el) => el.classList.toggle('cal-strip-selected', el.dataset.date === dateKey));
      const summaryEl = document.getElementById('weekDaySummary');
      summaryEl.innerHTML = weekDaySummaryHtml(dateKey);
      wireWeekSummaryLinks(summaryEl);
    }
    app.querySelectorAll('.cal-strip-day').forEach((el) => el.addEventListener('click', () => selectWeekDate(el.dataset.date)));
    document.getElementById('weekDaySelect')?.addEventListener('change', (e) => selectWeekDate(e.target.value));
    const initialSummaryEl = document.getElementById('weekDaySummary');
    if (initialSummaryEl) wireWeekSummaryLinks(initialSummaryEl);
    document.getElementById('viewFullLogBtn')?.addEventListener('click', () => go('activityLog', {}));
    app.querySelectorAll('.widget-toggle').forEach((cb) => cb.addEventListener('change', () => {
      const newPrefs = { ...prefs, [cb.dataset.widget]: cb.checked };
      localStorage.setItem('campAuditDashboardWidgets', JSON.stringify(newPrefs));
      renderDashboard();
    }));
  }

  draw();
}

async function renderLocationsDrilldown() {
  setChrome({ title: 'Locations', showBack: false, showLogout: true });
  setApp(`
    <div class="pane-row">
      <div class="pane pane-locations" id="paneLocations"></div>
      <div class="pane pane-assets" id="paneAssets"><p class="muted">Select a location to see its assets.</p></div>
      <div class="pane pane-detail" id="paneDetail"><p class="muted">Select an asset to see its details.</p></div>
    </div>`);
  const paneLocations = document.getElementById('paneLocations');
  const paneAssets = document.getElementById('paneAssets');
  const paneDetail = document.getElementById('paneDetail');

  await renderLocations(paneLocations, {
    onOpenLocation: async (id, name) => {
      paneDetail.innerHTML = '<p class="muted">Select an asset to see its details.</p>';
      await renderAssetsInLocation({ id, name }, paneAssets, {
        onOpenAsset: async (assetId) => {
          await renderAssetDetail({ id: assetId }, paneDetail);
        },
      });
    },
  });
}

async function renderWorkOrdersDrilldown(params = {}) {
  setChrome({ title: 'Work Orders', showBack: false, showLogout: true });
  setApp(`
    <div class="pane-row">
      <div class="pane pane-wo-list" id="paneWoList"></div>
      <div class="pane pane-detail" id="paneWoDetail"><p class="muted">Select a work order to see its details.</p></div>
    </div>`);
  const paneWoList = document.getElementById('paneWoList');
  const paneWoDetail = document.getElementById('paneWoDetail');

  await renderWorkOrders(params, paneWoList, {
    onOpenWorkOrder: async (id) => {
      await renderWorkOrderDetail({ id }, paneWoDetail);
    },
  });
}

// Dispatch table for Admin's leaf tool views — every one of them now accepts
// (params, container) so this works uniformly regardless of which tool the
// category list linked to.
const ADMIN_LEAF_RENDERERS = {
  adminAddFieldChoice: (params, container, cb) => renderAdminAddFieldChoice(params, container, cb),
  adminPropertyFields: (params, container) => renderAdminPropertyFields(params, container),
  adminComponentTypes: (params, container) => renderAdminComponentTypes(params, container),
  adminBuildingTypes: (params, container) => renderAdminBuildingTypes(container),
  adminApplicability: (params, container) => renderAdminApplicability(container),
  adminSubAreas: (params, container) => renderAdminSubAreas(container),
  adminWoTemplates: (params, container) => renderAdminWoTemplates(container),
  adminChecklistTemplates: (params, container) => renderAdminChecklistTemplates(container),
  adminUsers: (params, container) => renderAdminUsers(container),
  activityLog: (params, container) => renderActivityLog(container),
};

async function renderAdminDrilldown() {
  setChrome({ title: 'Admin', showBack: false, showLogout: true });
  setApp(`
    <div class="pane-row">
      <div class="pane pane-locations" id="paneAdminHub"></div>
      <div class="pane pane-assets" id="paneAdminCategory"><p class="muted">Select a category to see its tools.</p></div>
      <div class="pane pane-detail" id="paneAdminTool"><p class="muted">Select a tool to configure it.</p></div>
    </div>`);
  const paneHub = document.getElementById('paneAdminHub');
  const paneCategory = document.getElementById('paneAdminCategory');
  const paneTool = document.getElementById('paneAdminTool');

  function openTool(view, params) {
    paneTool.innerHTML = LOADING_HTML;
    const renderer = ADMIN_LEAF_RENDERERS[view];
    if (!renderer) { paneTool.innerHTML = '<p class="muted">Unknown tool.</p>'; return; }
    return renderer(params, paneTool, { onOpenTool: openTool });
  }

  await renderAdminHub(paneHub, {
    onOpenCategory: async (key) => {
      paneTool.innerHTML = '<p class="muted">Select a tool to configure it.</p>';
      await renderAdminCategory({ category: key }, paneCategory, { onOpenTool: openTool });
    },
  });
}

async function renderLocations(container = app, { onOpenLocation } = {}) {
  if (container === app) setChrome({ title: 'Locations', showBack: false, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { locations } = await api('/api/pg/locations');
  let editing = null; // 'new' | { id } | null
  let typeFilter = null; // set by clicking a type pill — filters the list to that type
  let selectedLocationId = null; // pane mode only — highlights the open location

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
    // A narrow browse pane can't fit the table layout sensibly — force cards
    // there regardless of the global table/cards preference.
    const mode = onOpenLocation ? 'cards' : getTableViewMode();
    const visible = typeFilter ? locations.filter((l) => l['Location Type'] === typeFilter) : locations;
    const emptyMsg = typeFilter ? `No locations of type "${escapeHtml(typeFilter)}".` : 'No locations yet.';
    setApp(`
      <button class="btn btn-primary ${onOpenLocation ? '' : 'fab'}" id="addLocationBtn" title="Add Location">+ Add Location</button>
      ${onOpenLocation ? '' : tableViewToggleHtml(mode)}
      ${typeFilter ? `<div class="btn-row" style="margin:-6px 0 16px"><button class="btn btn-secondary" id="clearTypeFilter">✕ Filtered by type: ${escapeHtml(typeFilter)}</button></div>` : ''}
      ${mode === 'table' ? locationGridHtml(visible, emptyMsg) : (visible.map((l) => `
        <div class="list-item loc-row ${onOpenLocation && selectedLocationId === l.Id ? 'cal-strip-selected' : ''}">
          <span class="loc-open" data-id="${l.Id}" data-name="${escapeHtml(l.Name)}">📍 ${escapeHtml(l.Name)}</span>
          ${l['Location Type'] ? `<span class="pill type-filter-chip" data-type="${escapeHtml(l['Location Type'])}">${escapeHtml(l['Location Type'])}</span>` : '<span class="pill"></span>'}
          <button class="btn btn-secondary edit-location" data-id="${l.Id}">Edit</button>
        </div>`).join('') || `<p class="muted">${emptyMsg}</p>`)}
      ${editing === 'new' ? editFormHtml(null) : ''}
      ${editing?.id ? editFormHtml(locations.find((l) => l.Id === editing.id)) : ''}
    `, container);
    wire();
  }

  function wire() {
    wireTableViewToggle(draw);
    container.querySelectorAll('.type-filter-chip').forEach((chip) => chip.addEventListener('click', (e) => {
      e.preventDefault();
      typeFilter = chip.dataset.type;
      draw();
    }));
    container.querySelector('#clearTypeFilter')?.addEventListener('click', () => { typeFilter = null; draw(); });
    container.querySelectorAll('.loc-open').forEach((el) => el.addEventListener('click', (e) => {
      e.preventDefault();
      if (onOpenLocation) { selectedLocationId = Number(el.dataset.id); draw(); onOpenLocation(el.dataset.id, el.dataset.name); }
      else go('assetsInLocation', { id: el.dataset.id, name: el.dataset.name });
    }));
    container.querySelector('#addLocationBtn')?.addEventListener('click', () => { editing = 'new'; draw(); });
    container.querySelectorAll('.edit-location').forEach((btn) => btn.addEventListener('click', () => {
      editing = { id: Number(btn.dataset.id) };
      draw();
    }));
    container.querySelectorAll('.loc-cancel').forEach((btn) => btn.addEventListener('click', () => { editing = null; draw(); }));
    container.querySelectorAll('.loc-save').forEach((btn) => btn.addEventListener('click', async () => {
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
        renderLocations(container, { onOpenLocation });
      } catch (err) { toast(err.message); }
    }));
  }

  draw();
}

async function renderAssetsInLocation({ id, name }, container = app, { onOpenAsset } = {}) {
  if (container === app) setChrome({ title: name || 'Assets', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { assets } = await api(`/api/pg/locations/${id}/assets`);
  let selectedAssetId = null;
  const draw = () => {
    container.innerHTML = assets.length ? assets.map((a) => `
      <div class="list-item ${onOpenAsset && selectedAssetId === a.Id ? 'cal-strip-selected' : ''}" data-id="${a.Id}" data-name="${escapeHtml(a.Name)}">
        <span>🏚️ ${escapeHtml(a.Name)}</span>
        <span class="pill">${escapeHtml(a['Asset type'] || '')}</span>
      </div>`).join('') : '<p class="muted">No assets in this location.</p>';
    container.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => {
      if (onOpenAsset) { selectedAssetId = Number(el.dataset.id); draw(); onOpenAsset(el.dataset.id); }
      else go('assetDetail', { id: el.dataset.id, name: el.dataset.name });
    }));
  };
  draw();
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

async function renderAssetDetail({ id }, container = app) {
  if (container === app) setChrome({ title: 'Asset', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
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

  container.innerHTML = `
    <div class="card">
      <h3>${escapeHtml(asset.Name)}</h3>
      <div class="muted">${escapeHtml(asset['Asset type'] || '')} · Condition: ${escapeHtml(asset.Condition || 'Unknown')}</div>
      ${asset['Lodge Holder'] ? `<div class="muted">🏠 Cabin/Lodge Holder: ${escapeHtml(asset['Lodge Holder'])}</div>` : ''}
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
      ${conditionFindings.map((f) => `
        <div class="list-item" style="cursor:default">
          <span>${escapeHtml(f.Title || '')}</span>
          <span style="display:flex;align-items:center;gap:8px">
            <span class="pill">${escapeHtml(f.Severity || '')}</span>
            <button type="button" class="btn btn-secondary toggle-board-focus" data-id="${f.Id}" data-next="${!f.BoardFocus}" style="padding:2px 8px;font-size:0.75rem;${f.BoardFocus ? 'background:#f0f2fb' : ''}">${f.BoardFocus ? '★ Board Focus' : '☆ Flag for Board'}</button>
          </span>
        </div>`).join('') || '<p class="muted">None yet.</p>'}
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

  container.querySelector('#startAuditBtn').addEventListener('click', () => go('audit', { id }));
  container.querySelector('#viewHistoryBtn').addEventListener('click', () => go('assetHistory', { id }));
  container.querySelector('#editAssetBtn').addEventListener('click', () => go('editAsset', { id }));
  container.querySelector('#newWoBtn').addEventListener('click', () => go('newWorkOrder', { assetId: id, assetName: asset.Name }));
  container.querySelectorAll('[data-wo-id]').forEach((el) => el.addEventListener('click', () => go('workOrderDetail', { id: el.dataset.woId })));
  container.querySelector('#buildingTypeSelect').addEventListener('change', async (e) => {
    const label = e.target.options[e.target.selectedIndex].text;
    if (!await confirmDialog(`Change building type to "${label}"? This affects which questions apply to this asset.`)) {
      e.target.value = asset.buildingTypeId ?? '';
      return;
    }
    await api(`/api/pg/assets/${id}/building-type`, { method: 'PATCH', body: JSON.stringify({ buildingTypeId: e.target.value ? Number(e.target.value) : null }) });
    toast('Building type updated');
  });
  container.querySelector('#noteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const note = fd.get('note');
    const file = fd.get('photo');
    try {
      let photoUrl = null;
      if (file && file.size) photoUrl = await uploadPhotoFile(file, 'notes', id);
      await api(`/api/pg/assets/${id}/notes`, { method: 'POST', body: JSON.stringify({ note, photoUrl }) });
      toast('Note added');
      renderAssetDetail({ id }, container);
    } catch (err) { toast(err.message); }
  });
  container.querySelectorAll('.resolve-note').forEach((el) => el.addEventListener('click', async (e) => {
    e.preventDefault();
    await api(`/api/pg/notes/${el.dataset.id}/resolve`, { method: 'PATCH', body: JSON.stringify({ resolved: el.dataset.next === 'true' }) });
    renderAssetDetail({ id }, container);
  }));
  container.querySelectorAll('.toggle-board-focus').forEach((el) => el.addEventListener('click', async () => {
    await api(`/api/pg/condition-findings/${el.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ boardFocus: el.dataset.next === 'true' }) });
    renderAssetDetail({ id }, container);
  }));
}

// A direct entry point for the "audit every building" workflow — skips the
// Locations -> asset -> Asset Detail -> Start Audit detour when you already
// know (or want to search for) the asset by name. Picking one hands straight
// off to the same renderAudit used from Asset Detail; nothing about the audit
// form itself changes.
async function renderAuditPicker() {
  setChrome({ title: 'Start Audit', showBack: false, showLogout: true });
  app.innerHTML = `
    <div class="card">
      <h3>Start an Audit</h3>
      <p class="muted">Search for the asset you want to audit — its current property answers, component conditions, and cabin/lodge holder will load automatically.</p>
      <div id="auditAssetPicker"></div>
    </div>`;
  mountAssetCombobox(document.getElementById('auditAssetPicker'), {
    // onSelect also fires with null on every keystroke (clearing a prior
    // selection) — only navigate once an asset is actually chosen.
    onSelect: (asset) => { if (asset) go('audit', { id: asset.Id }); },
  });
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
      <label class="flag-check"><input type="checkbox" class="flag-toggle" data-flag-for="${f.fieldKey}" /> 🚩 Flag for follow-up</label>
      <div class="flag-note-wrap" hidden><input type="text" class="flag-note" data-flag-note-for="${f.fieldKey}" placeholder="Optional note" /></div>
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
          <div class="field-row"><label>Photo (optional)</label><input type="file" class="comp-photo" accept="image/*" capture="environment" /></div>
          <label class="flag-check"><input type="checkbox" class="comp-flag-toggle" /> 🚩 Flag for follow-up</label>
          <div class="flag-note-wrap" hidden><input type="text" class="comp-flag-note" placeholder="Optional note" /></div>
        </div>`).join('')}
    </div>` : '';

  app.innerHTML = `
    <div class="card">
      <h3>Auditing: ${escapeHtml(asset.Name)}</h3>
      ${asset['Lodge Holder'] ? `<p class="muted">🏠 Cabin/Lodge Holder: ${escapeHtml(asset['Lodge Holder'])}</p>` : ''}
      <form id="auditForm">
        ${topFieldsHtml}
        ${dependencyBlocks}
        ${componentBlock}
        <div class="card">
          <h3>Audit Photos (optional)</h3>
          <div class="field-row"><label>General condition photos</label><input type="file" name="generalPhotos" accept="image/*" capture="environment" multiple /></div>
        </div>
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

  // Every property field and component card gets a "🚩 Flag for follow-up"
  // checkbox that reveals an optional note — same toggle behavior either way.
  document.querySelectorAll('.flag-toggle, .comp-flag-toggle').forEach((cb) => {
    cb.addEventListener('change', () => {
      const scope = cb.closest('.field-row, .card');
      const wrap = scope?.querySelector('.flag-note-wrap');
      if (wrap) wrap.hidden = !cb.checked;
      cb.closest('.flag-check')?.classList.toggle('flagged', cb.checked);
    });
  });

  document.getElementById('cancelAuditBtn').addEventListener('click', goBack);
  document.getElementById('auditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const propertiesOut = {};
    properties.fields.forEach((f) => {
      const v = fd.get(`prop_${f.fieldKey}`);
      if (!v) return;
      const flagged = !!document.querySelector(`.flag-toggle[data-flag-for="${f.fieldKey}"]`)?.checked;
      const flagNote = flagged ? (document.querySelector(`.flag-note[data-flag-note-for="${f.fieldKey}"]`)?.value.trim() || null) : null;
      propertiesOut[f.fieldKey] = { value: v, flagged, flagNote };
    });

    const componentEvents = [];
    for (const card of document.querySelectorAll('#componentPromptBlock [data-component]')) {
      const condition = card.querySelector('.comp-condition').value;
      const eventType = card.querySelector('.comp-event').value;
      const material = card.querySelector('.comp-material').value;
      const notes = card.querySelector('.comp-notes').value;
      const flagged = !!card.querySelector('.comp-flag-toggle')?.checked;
      const flagNote = flagged ? (card.querySelector('.comp-flag-note')?.value.trim() || null) : null;
      const photoFile = card.querySelector('.comp-photo')?.files?.[0];
      if (!condition && !material && !notes && !flagged && !photoFile) continue; // skip untouched component cards
      const photoUrl = photoFile && photoFile.size ? await uploadPhotoFile(photoFile, 'components', id) : null;
      componentEvents.push({ componentType: card.dataset.component, eventType, condition, material, notes, flagged, flagNote, photoUrl });
    }

    const severity = fd.get('findingSeverity');
    const description = fd.get('findingDescription');
    const findingPhotos = fd.getAll('findingPhoto').filter((f) => f && f.size);
    const generalPhotoFiles = fd.getAll('generalPhotos').filter((f) => f && f.size);

    try {
      let finding = null;
      if (severity && description) {
        const photoUrls = [];
        for (const file of findingPhotos) photoUrls.push(await uploadPhotoFile(file, 'findings', id));
        finding = { severity, description, photoUrls };
      }
      const generalPhotos = [];
      for (const file of generalPhotoFiles) generalPhotos.push(await uploadPhotoFile(file, 'asset-photos', id));
      await api(`/api/pg/assets/${id}/audit`, { method: 'POST', body: JSON.stringify({ properties: propertiesOut, componentEvents, finding, generalPhotos }) });
      toast('Audit submitted');
      state.stack.pop(); // drop this audit entry
      go('assetDetail', { id }, { replace: true });
    } catch (err) { toast(err.message); }
  });
}

async function renderAssetHistory({ id }) {
  setChrome({ title: 'History', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const { asset, history, propertyHistory } = await api(`/api/pg/assets/${id}/history`);
  // Component events and property-field changes are two different record
  // shapes (and property changes have no natural "sort date" beyond when they
  // were made) — tag each with a common Date/kind pair so they can merge into
  // one newest-first timeline instead of two separate lists.
  const merged = [
    ...history.map((h) => ({ kind: 'component', date: h['Observed/Installed Date'] || null, sortKey: h['Observed/Installed Date'] || '', h })),
    ...propertyHistory.map((h) => ({ kind: 'property', date: h.ChangedAt, sortKey: h.ChangedAt, h })),
  ].sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));

  app.innerHTML = `<div class="card"><h3>${escapeHtml(asset.Name)} — History</h3></div>` +
    (merged.length ? merged.map(({ kind, h }) => kind === 'component' ? `
      <div class="card">
        <div><strong>${escapeHtml(h['Component Type'])}</strong> — ${escapeHtml(h['Event Type'] || '')}
          <span class="pill ${conditionPillClass(h.Condition)}">${escapeHtml(h.Condition || '')}</span></div>
        <div class="muted">${escapeHtml(formatDateNice(h['Observed/Installed Date']))} · ${escapeHtml(h.Material || '')}</div>
        ${h.Notes ? `<div>${escapeHtml(h.Notes)}</div>` : ''}
        ${h['Photo URL'] ? `<a href="${escapeHtml(h['Photo URL'])}" target="_blank" rel="noopener"><img src="${escapeHtml(h['Photo URL'])}" alt="" style="max-width:120px;border-radius:8px;margin-top:6px;display:block" /></a>` : ''}
      </div>` : `
      <div class="card">
        <div><strong>${escapeHtml(h.Label)}</strong> changed</div>
        <div class="muted">${escapeHtml(h['Old Value'] ?? '—')} → <strong>${escapeHtml(h['New Value'] ?? '—')}</strong></div>
        <div class="muted">${new Date(h.ChangedAt).toLocaleString()}${h.ChangedBy ? ` · ${escapeHtml(h.ChangedBy)}` : ''}</div>
      </div>`).join('') : '<p class="muted">No history yet.</p>');
}

function moneyFmt(n) { return '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }); }

// Shared hover/focus tooltip for any [data-tooltip] element inside root — one
// floating tooltip element reused across charts. Label text is untrusted
// (comes from user-entered names), so it goes in via textContent, never HTML.
function wireVizTooltips(root) {
  let tipEl = document.getElementById('vizTooltip');
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'viz-tooltip';
    tipEl.id = 'vizTooltip';
    document.body.appendChild(tipEl);
  }
  function show(el, x, y) {
    tipEl.textContent = el.dataset.tooltip;
    tipEl.style.left = `${x + 14}px`;
    tipEl.style.top = `${y + 14}px`;
    tipEl.classList.add('visible');
  }
  function hide() { tipEl.classList.remove('visible'); }
  root.querySelectorAll('[data-tooltip]').forEach((el) => {
    el.addEventListener('pointermove', (e) => show(el, e.clientX, e.clientY));
    el.addEventListener('pointerenter', (e) => show(el, e.clientX, e.clientY));
    el.addEventListener('pointerleave', hide);
    el.addEventListener('focus', () => { const r = el.getBoundingClientRect(); show(el, r.left, r.bottom); });
    el.addEventListener('blur', hide);
  });
}

// "A single ratio against a limit" -> a meter, fill colored by severity
// (good -> warning -> serious -> critical) against how many years of the
// operating budget the pending work would consume.
function statusColorForRatio(ratio) {
  if (ratio == null || ratio < 0.5) return 'var(--viz-status-good)';
  if (ratio < 1) return 'var(--viz-status-warning)';
  if (ratio < 2) return 'var(--viz-status-serious)';
  return 'var(--viz-status-critical)';
}
function operatingBudgetMeterHtml(ob) {
  const ratio = ob.AnnualOperatingBudget > 0 ? ob.PendingCost / ob.AnnualOperatingBudget : null;
  const pct = ratio != null ? Math.min(ratio * 100, 100) : 0;
  const color = statusColorForRatio(ratio);
  const tooltip = `Pending ${moneyFmt(ob.PendingCost)} of ${moneyFmt(ob.AnnualOperatingBudget)} annual budget${ratio != null ? ` (${Math.round(ratio * 100)}%)` : ''}`;
  return `<div class="viz-root" style="margin-top:14px">
    <div class="viz-meter-track" tabindex="0" data-tooltip="${escapeHtml(tooltip)}">
      <div class="viz-meter-fill ${pct >= 100 ? 'viz-meter-full' : ''}" style="width:${pct}%;background:${color}"></div>
    </div>
    <div class="viz-meter-caption">
      <span>${moneyFmt(ob.PendingCost)} pending</span>
      <span>${moneyFmt(ob.AnnualOperatingBudget)} annual budget</span>
    </div>
  </div>`;
}

// Three named funding pools ARE the subject here (identity, not magnitude
// alone) -> categorical color, first three slots (all-pairs validated).
function fundingComparisonChartHtml(budgetOverview) {
  const items = [
    { key: 'campaign', label: 'Capital Campaign', total: budgetOverview.CapitalCampaignTotal, color: 'var(--viz-series-1)' },
    { key: 'cabin', label: 'Cabin-Holder', total: budgetOverview.CabinHolderTotal, color: 'var(--viz-series-2)' },
    { key: 'other', label: 'Other', total: budgetOverview.OtherTotal, color: 'var(--viz-series-3)' },
  ];
  if (items.every((i) => i.total === 0)) return '<p class="muted">No capital campaign, cabin-holder, or other-category costs tagged to work orders yet.</p>';
  const max = Math.max(...items.map((i) => i.total), 1);
  return `<div class="viz-root">
    <div class="viz-legend">${items.map((i) => `<span class="viz-legend-key"><span class="viz-legend-swatch" style="background:${i.color}"></span>${escapeHtml(i.label)}</span>`).join('')}</div>
    ${items.map((i) => {
      const pct = Math.max((i.total / max) * 100, i.total > 0 ? 2 : 0);
      return `<div class="viz-bar-row">
        <div class="viz-bar-label">${escapeHtml(i.label)}</div>
        <div class="viz-bar-track">
          <div class="viz-bar-fill scroll-to-fund-card ${pct >= 99 ? 'viz-bar-full' : ''}" data-kind="${i.key}" tabindex="0"
            style="width:${pct}%;background:${i.color}" data-tooltip="${escapeHtml(i.label)}: ${moneyFmt(i.total)}"></div>
        </div>
        <span class="viz-bar-value">${moneyFmt(i.total)}</span>
      </div>`;
    }).join('')}
  </div>`;
}

const FUNDING_GROUP_META = {
  campaign: { title: 'Capital Campaign Projects', icon: '🏗️', endpoint: 'budget/capital-campaign-projects', singular: 'Project' },
  other: { title: 'Other', icon: '🗂️', endpoint: 'budget/other-categories', singular: 'Category' },
  cabin: { title: 'Cabin-Holder Ledger', icon: '🏘️', endpoint: 'budget/cabin-holders', singular: 'Cabin-Holder' },
};

async function renderCapitalPlan() {
  setChrome({ title: 'Capital Plan', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const [{ rows, summary }, budgetOverview] = await Promise.all([
    api('/api/pg/capital-plan'), api('/api/pg/budget/overview'),
  ]);
  let activeBucket = null;
  let editingBudget = false;
  let addingKind = null; // 'campaign' | 'other' | 'cabin' | null

  function budgetSectionHtml() {
    const ob = budgetOverview.OperatingBudget;
    return `<div class="card">
      <h3>💰 Operating Budget</h3>
      <p class="muted">Money sourced from the camp's annual operating budget — separate from capital campaigns, cabin-holder-funded work, and other categories below.</p>
      ${editingBudget ? `
        <div class="field-row"><label>Annual Operating Budget</label><input id="annualBudgetInput" type="number" step="100" value="${ob.AnnualOperatingBudget}" /></div>
        <div class="btn-row"><button class="btn btn-primary" id="saveBudgetBtn">Save</button><button class="btn btn-secondary" id="cancelBudgetBtn">Cancel</button></div>
      ` : `
        <p>Annual Operating Budget: <strong>${moneyFmt(ob.AnnualOperatingBudget)}</strong>
          <button class="btn btn-secondary" id="editBudgetBtn" style="margin-left:8px">Edit</button></p>
        <p class="muted">Pending operating-budget work (not yet Done) totals <strong>${moneyFmt(ob.PendingCost)}</strong>${
          ob.YearsToCover != null ? ` — <strong>${ob.YearsToCover.toFixed(1)} years</strong> of the current operating budget.` : ' (set an annual operating budget above to see years-to-cover)'
        }</p>
        ${operatingBudgetMeterHtml(ob)}
      `}
    </div>
    <div class="card"><h3>📊 Capital Campaign / Cabin-Holder / Other — cost comparison</h3>${fundingComparisonChartHtml(budgetOverview)}</div>`;
  }

  function fundingEntityRowHtml(kind, g) {
    return `<details class="reveal" style="margin-bottom:8px">
      <summary style="cursor:pointer;display:flex;justify-content:space-between;gap:10px;padding:8px 0">
        <span>${escapeHtml(g.Name)}${g.LinkedAssets?.length ? ` <span class="muted">— ${g.LinkedAssets.map((a) => escapeHtml(a.Name)).join(', ')}</span>` : ''}</span><strong>${moneyFmt(g.Total)}</strong>
      </summary>
      <div style="padding:4px 0 8px 16px">
        ${g.Description ? `<p class="muted">${escapeHtml(g.Description)}</p>` : ''}
        ${g.LinkedAssets?.length ? `<p class="muted">Linked asset${g.LinkedAssets.length > 1 ? 's' : ''}: ${g.LinkedAssets.map((a) => `<a href="#" class="budget-asset-link" data-asset-id="${a.Id}">${escapeHtml(a.Name)}</a>`).join(', ')}</p>` : ''}
        ${g.Items.length ? g.Items.map((it) => `<div class="list-item budget-wo-link" data-wo-id="${it.WorkOrderId}">
          <span>${escapeHtml(it.Title)}</span>
          <span class="pill ${woStatusPillClass(it.Status)}">${escapeHtml(it.Status)} · ${moneyFmt(it.Cost)}</span>
        </div>`).join('') : '<p class="muted">No work orders tagged to this yet.</p>'}
        <div class="btn-row"><button class="btn btn-secondary delete-fund-entity" data-kind="${kind}" data-id="${g.Id}" data-name="${escapeHtml(g.Name)}">Delete</button></div>
      </div>
    </details>`;
  }

  function fundingGroupHtml(kind, groups) {
    const meta = FUNDING_GROUP_META[kind];
    const total = groups.reduce((s, g) => s + g.Total, 0);
    const withCost = groups.filter((g) => g.Total > 0);
    const zeroCost = groups.filter((g) => g.Total === 0);
    return `<div class="card" id="fundingCard-${kind}">
      <h3>${meta.icon} ${meta.title}${groups.length ? ` — ${moneyFmt(total)} total` : ''}</h3>
      <div class="funding-scroll">
        ${withCost.length ? withCost.map((g) => fundingEntityRowHtml(kind, g)).join('') : (groups.length ? '' : `<p class="muted">None yet.</p>`)}
        ${zeroCost.length ? `
          <details style="margin-top:4px">
            <summary class="muted" style="cursor:pointer">Show ${zeroCost.length} more with $0 total</summary>
            <div style="margin-top:6px">${zeroCost.map((g) => fundingEntityRowHtml(kind, g)).join('')}</div>
          </details>` : ''}
      </div>
      ${addingKind === kind ? `
        <div class="field-row"><label>${meta.singular} Name</label><input id="newFundEntityName" required /></div>
        <div class="field-row"><label>Description (optional)</label><textarea id="newFundEntityDesc"></textarea></div>
        <div class="btn-row">
          <button class="btn btn-primary save-fund-entity" data-kind="${kind}">Save</button>
          <button class="btn btn-secondary" id="cancelFundEntityBtn">Cancel</button>
        </div>` : `<div class="btn-row"><button class="btn btn-secondary add-fund-entity" data-kind="${kind}">+ Add ${meta.singular}</button></div>`}
    </div>`;
  }

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
      <div class="budget-grid">
        ${budgetSectionHtml()}
        ${fundingGroupHtml('campaign', budgetOverview.CapitalCampaignProjects)}
        ${fundingGroupHtml('cabin', budgetOverview.CabinHolders)}
        ${fundingGroupHtml('other', budgetOverview.OtherCategories)}
      </div>

      <div class="card"><h3>📐 Component Replacement Forecast</h3><p class="muted">Upcoming component replacements by urgency — independent of funding source above.</p></div>
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
    wireVizTooltips(app);
    app.querySelectorAll('.viz-bar-fill.scroll-to-fund-card').forEach((el) => el.addEventListener('click', () => {
      document.getElementById(`fundingCard-${el.dataset.kind}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    document.getElementById('editBudgetBtn')?.addEventListener('click', () => { editingBudget = true; draw(); });
    document.getElementById('cancelBudgetBtn')?.addEventListener('click', () => { editingBudget = false; draw(); });
    document.getElementById('saveBudgetBtn')?.addEventListener('click', async () => {
      const val = Number(document.getElementById('annualBudgetInput').value);
      if (Number.isNaN(val) || val < 0) { toast('Enter a valid amount'); return; }
      try {
        await api('/api/pg/budget/settings', { method: 'PUT', body: JSON.stringify({ annualOperatingBudget: val }) });
        toast('Operating budget updated');
        renderCapitalPlan();
      } catch (err) { toast(err.message); }
    });

    app.querySelectorAll('.add-fund-entity').forEach((btn) => btn.addEventListener('click', () => { addingKind = btn.dataset.kind; draw(); }));
    document.getElementById('cancelFundEntityBtn')?.addEventListener('click', () => { addingKind = null; draw(); });
    app.querySelectorAll('.save-fund-entity').forEach((btn) => btn.addEventListener('click', async () => {
      const name = document.getElementById('newFundEntityName').value.trim();
      if (!name) { toast('Name is required'); return; }
      const description = document.getElementById('newFundEntityDesc').value.trim();
      const endpoint = FUNDING_GROUP_META[btn.dataset.kind].endpoint;
      try {
        await api(`/api/pg/${endpoint}`, { method: 'POST', body: JSON.stringify({ name, description, notes: description }) });
        toast(`${FUNDING_GROUP_META[btn.dataset.kind].singular} added`);
        addingKind = null;
        renderCapitalPlan();
      } catch (err) { toast(err.message); }
    }));
    app.querySelectorAll('.delete-fund-entity').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog(`Delete "${btn.dataset.name}"? Work orders tagged to it must be reassigned first.`)) return;
      const endpoint = FUNDING_GROUP_META[btn.dataset.kind].endpoint;
      try {
        await api(`/api/pg/${endpoint}/${btn.dataset.id}`, { method: 'DELETE' });
        toast('Deleted');
        renderCapitalPlan();
      } catch (err) { toast(err.message); }
    }));
    app.querySelectorAll('.budget-wo-link').forEach((el) => el.addEventListener('click', () => go('workOrderDetail', { id: el.dataset.woId })));
    app.querySelectorAll('.budget-asset-link').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); go('assetDetail', { id: el.dataset.assetId }); }));

    app.querySelectorAll('.bucket-tile').forEach((tile) => tile.addEventListener('click', () => {
      activeBucket = activeBucket === tile.dataset.bucket ? null : tile.dataset.bucket;
      draw();
    }));
    document.getElementById('clearBucketFilter')?.addEventListener('click', () => { activeBucket = null; draw(); });
    app.querySelectorAll('tr.clickable-row').forEach((tr) => tr.addEventListener('click', () => go('assetDetail', { id: tr.dataset.assetId })));
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
              <td data-label="Date">${escapeHtml(formatDateNice(e['Observed/Installed Date']))}</td>
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

// ---------- Reports v1: filterable/exportable Assets + Work Orders ----------
// Deliberately NOT the full custom report builder (arbitrary fields/
// functions) discussed with the user — that's explicitly deferred. This is
// the scoped-down "pick a table, filter it, export it" version: faceted
// filters (checking multiple values within one field is OR, different
// fields AND together), every filter pre-populated from real data so nothing
// can typo its way to zero results, and a CSV export of whatever's on screen.

const REPORT_ENTITIES = [
  { key: 'assets', label: 'Assets' },
  { key: 'workOrders', label: 'Work Orders' },
  { key: 'workOrderLog', label: 'Progress Log' },
  { key: 'crewSessions', label: 'Crew Sessions' },
];

// One-click canned filter combinations for the most common "which report do
// you mean" asks (new work orders, progress made, completed work) — sits on
// top of the same faceted filters, just pre-applying a combination instead of
// rebuilding it by hand every visit. Each `apply` returns a selectedFilters-
// shaped object: Set for a categorical column, { from, to } for a date one.
function reportPresets(entity) {
  const todayStr = isoDate(new Date());
  const daysAgoStr = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return isoDate(d); };
  const startOfMonthStr = () => { const d = new Date(); return isoDate(new Date(d.getFullYear(), d.getMonth(), 1)); };
  if (entity === 'workOrders') {
    return [
      { label: 'New This Week', apply: () => ({ 'Date Reported': { from: daysAgoStr(7), to: todayStr } }) },
      { label: 'Completed This Month', apply: () => ({ Status: new Set(['Done']), 'Date Completed': { from: startOfMonthStr(), to: todayStr } }) },
      { label: 'Open & Urgent', apply: () => ({ Priority: new Set(['Urgent']) }) },
    ];
  }
  if (entity === 'workOrderLog') {
    return [{ label: 'Progress This Week', apply: () => ({ 'Logged At': { from: daysAgoStr(7), to: todayStr } }) }];
  }
  if (entity === 'assets') {
    return [{ label: 'Flagged Items', apply: () => ({ Flagged: new Set(['Yes']) }) }];
  }
  return [];
}

async function renderReports(params = {}) {
  setChrome({ title: 'Reports', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;

  let entity = REPORT_ENTITIES.some((e) => e.key === params.entity) ? params.entity : 'assets';
  let columns = [];
  let selectedFilters = {}; // { [columnKey]: Set<string> | { from?: string, to?: string } }
  let visibleColumns = new Set();
  let openGroups = new Set();
  let columnsPickerOpen = false;
  let rows = [];
  let sortKey = null;
  let sortDir = 'asc';
  let favorites = [];
  let savingFavorite = false;

  async function loadSchema() {
    const { columns: cols } = await api(`/api/pg/reports/schema?entity=${entity}`);
    columns = cols;
    selectedFilters = {};
    visibleColumns = new Set(columns.filter((c) => c.default).map((c) => c.key));
    openGroups = new Set(columns[0] ? [columns[0].group] : []);
    sortKey = null;
    sortDir = 'asc';
    savingFavorite = false;
  }

  async function loadFavorites() {
    const { favorites: f } = await api(`/api/pg/reports/favorites?entity=${entity}`);
    favorites = f;
  }

  function filtersPayload() {
    const filters = {};
    for (const [k, v] of Object.entries(selectedFilters)) {
      if (v instanceof Set) { if (v.size) filters[k] = [...v]; }
      else if (v && (v.from || v.to)) filters[k] = v;
    }
    return filters;
  }

  // The inverse of filtersPayload() — turns a saved favorite's plain-JSON
  // filters back into the Set/range shapes selectedFilters actually uses.
  function filtersFromSaved(saved) {
    const result = {};
    for (const [k, v] of Object.entries(saved || {})) result[k] = Array.isArray(v) ? new Set(v) : v;
    return result;
  }

  // Two saved views are "the same" once each column's selected values are
  // sorted (order doesn't matter) and columns are in a stable order — an
  // instant client-side check before round-tripping to the server, which
  // enforces the same rule (mirrored in reports.js's canonicalFiltersKey).
  function canonicalFiltersKey(filters) {
    const norm = {};
    for (const [k, v] of Object.entries(filters || {})) {
      if (Array.isArray(v)) { if (v.length) norm[k] = [...v].sort(); }
      else if (v && (v.from || v.to)) norm[k] = { from: v.from || null, to: v.to || null };
    }
    return JSON.stringify(Object.keys(norm).sort().map((k) => [k, norm[k]]));
  }

  // Null/empty values always sort to the bottom regardless of direction —
  // reads more like "unanswered" being set aside than "less than everything."
  // Numeric-looking values compare as numbers so e.g. Window Count sorts
  // 2, 4, 10 instead of 10, 2, 4.
  function sortedRows() {
    if (!sortKey) return rows;
    const dir = sortDir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const aEmpty = av == null || av === '';
      const bEmpty = bv == null || bv === '';
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      const an = Number(av);
      const bn = Number(bv);
      if (!Number.isNaN(an) && !Number.isNaN(bn) && av !== '' && bv !== '') return (an - bn) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  async function loadData() {
    const res = await api(`/api/pg/reports/data?entity=${entity}&filters=${encodeURIComponent(JSON.stringify(filtersPayload()))}`);
    rows = res.rows;
  }

  function groupedColumns() {
    const groups = new Map();
    for (const c of columns) {
      if (!groups.has(c.group)) groups.set(c.group, []);
      groups.get(c.group).push(c);
    }
    return groups;
  }

  function exportUrl() {
    const cols = columns.filter((c) => visibleColumns.has(c.key)).map((c) => c.key);
    return `/api/pg/reports/export?entity=${entity}&filters=${encodeURIComponent(JSON.stringify(filtersPayload()))}&columns=${encodeURIComponent(JSON.stringify(cols))}`;
  }

  function filterBadge(c) {
    const v = selectedFilters[c.key];
    if (!v) return '';
    if (c.type === 'date') return (v.from || v.to) ? ' <span class="pill">range</span>' : '';
    return v.size ? ` <span class="pill">${v.size}</span>` : '';
  }

  function draw() {
    const groups = groupedColumns();
    const visibleCols = columns.filter((c) => visibleColumns.has(c.key));
    const presets = reportPresets(entity);
    const hasActiveFilters = Object.keys(selectedFilters).length > 0;
    setApp(`
      <div class="card">
        <div class="view-toggle">
          ${REPORT_ENTITIES.map((e) => `<button type="button" class="view-toggle-btn entity-switch ${entity === e.key ? 'active' : ''}" data-entity="${e.key}">${escapeHtml(e.label)}</button>`).join('')}
        </div>
        <p class="muted" style="margin-top:10px;margin-bottom:0">A full custom report builder is planned for later — this covers filtering and exporting what's already here.</p>
        <div class="btn-row" style="margin-top:10px;align-items:center">
          ${presets.map((p, i) => `<button type="button" class="btn btn-secondary report-preset-btn" data-preset-idx="${i}">${escapeHtml(p.label)}</button>`).join('')}
          ${favorites.map((f) => `
            <span class="report-fav-chip">
              <button type="button" class="btn btn-secondary report-fav-btn" data-fav-id="${f.Id}">★ ${escapeHtml(f.Label)}</button>
              <button type="button" class="report-fav-delete" data-fav-id="${f.Id}" title="Delete this favorite">✕</button>
            </span>`).join('')}
          ${hasActiveFilters ? `<button type="button" class="btn btn-secondary" id="clearFiltersBtn">✕ Clear Filters</button>` : ''}
          ${!savingFavorite && hasActiveFilters ? `<button type="button" class="btn btn-secondary" id="saveFavoriteBtn">☆ Save as Favorite…</button>` : ''}
        </div>
        ${savingFavorite ? `
          <div class="btn-row" style="margin-top:8px">
            <input type="text" id="favLabelInput" class="report-fav-input" placeholder="Name this view — e.g. &quot;Open &amp; Urgent&quot;…" autofocus />
            <button type="button" class="btn btn-primary" id="confirmSaveFavoriteBtn">Save</button>
            <button type="button" class="btn btn-secondary" id="cancelSaveFavoriteBtn">Cancel</button>
          </div>` : ''}
      </div>
      <div class="reports-layout">
        <div class="card reports-filters">
          <h3>Filters</h3>
          ${[...groups.entries()].map(([group, cols]) => `
            <details class="report-filter-group" data-group="${escapeHtml(group)}" ${openGroups.has(group) ? 'open' : ''}>
              <summary>${escapeHtml(group)}</summary>
              ${cols.map((c) => c.type === 'date' ? `
                <div class="report-filter-field">
                  <div class="report-filter-label">${escapeHtml(c.label)}${filterBadge(c)}</div>
                  <div class="report-date-range">
                    <input type="date" class="report-filter-date" data-filter-key="${escapeHtml(c.key)}" data-bound="from" value="${selectedFilters[c.key]?.from || ''}" />
                    <span class="muted">to</span>
                    <input type="date" class="report-filter-date" data-filter-key="${escapeHtml(c.key)}" data-bound="to" value="${selectedFilters[c.key]?.to || ''}" />
                  </div>
                </div>` : `
                <div class="report-filter-field">
                  <div class="report-filter-label">${escapeHtml(c.label)}${filterBadge(c)}</div>
                  <div class="report-filter-options">
                    ${c.options.length ? c.options.map((o) => `
                      <label class="report-chip"><input type="checkbox" class="report-filter-cb" data-filter-key="${escapeHtml(c.key)}" value="${escapeHtml(String(o))}" ${selectedFilters[c.key]?.has(String(o)) ? 'checked' : ''} /> ${escapeHtml(String(o))}</label>
                    `).join('') : '<span class="muted" style="font-size:0.8rem">No values yet</span>'}
                  </div>
                </div>`).join('')}
            </details>`).join('')}
        </div>
        <div class="reports-main">
          <div class="card">
            <div class="btn-row" style="justify-content:space-between;align-items:center;flex-wrap:wrap">
              <span class="muted">${rows.length} result${rows.length === 1 ? '' : 's'}</span>
              <div class="btn-row" style="margin:0">
                <details class="report-columns-picker" ${columnsPickerOpen ? 'open' : ''}>
                  <summary class="btn btn-secondary">Columns</summary>
                  <div class="report-columns-menu">
                    ${[...groups.entries()].map(([group, cols]) => `
                      <div class="report-columns-group-label">${escapeHtml(group)}</div>
                      ${cols.map((c) => `<label class="report-chip"><input type="checkbox" class="report-col-toggle" data-col-key="${escapeHtml(c.key)}" ${visibleColumns.has(c.key) ? 'checked' : ''} /> ${escapeHtml(c.label)}</label>`).join('')}
                    `).join('')}
                  </div>
                </details>
                <a class="btn btn-primary" href="${exportUrl()}" target="_blank" rel="noopener">Export CSV</a>
              </div>
            </div>
          </div>
          <div class="card" style="overflow-x:auto">
            <table class="report-table">
              <thead><tr>${visibleCols.map((c) => `<th class="sortable-col ${sortKey === c.key ? 'sorted' : ''}" data-sort-key="${escapeHtml(c.key)}">${escapeHtml(c.label)}<span class="sort-arrow">${sortKey === c.key ? (sortDir === 'desc' ? '▼' : '▲') : ''}</span></th>`).join('')}</tr></thead>
              <tbody>${rows.length ? sortedRows().map((r) => `
                <tr class="clickable-row" data-id="${r._id}" data-entity="${r._entity}">
                  ${visibleCols.map((c) => `<td data-label="${escapeHtml(c.label)}">${escapeHtml(r[c.key] == null ? '—' : String(r[c.key]))}</td>`).join('')}
                </tr>`).join('') : `<tr><td colspan="${visibleCols.length || 1}" class="muted">No matching records.</td></tr>`}</tbody>
            </table>
          </div>
        </div>
      </div>`);
    wire();
  }

  function wire() {
    app.querySelectorAll('.entity-switch').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.entity === entity) return;
        entity = btn.dataset.entity;
        columnsPickerOpen = false;
        app.innerHTML = LOADING_HTML;
        await loadSchema();
        await Promise.all([loadData(), loadFavorites()]);
        draw();
      });
    });
    app.querySelectorAll('.report-filter-group').forEach((d) => d.addEventListener('toggle', () => {
      if (d.open) openGroups.add(d.dataset.group); else openGroups.delete(d.dataset.group);
    }));
    const colsPicker = app.querySelector('.report-columns-picker');
    colsPicker?.addEventListener('toggle', () => { columnsPickerOpen = colsPicker.open; });
    app.querySelectorAll('.report-col-toggle').forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) visibleColumns.add(cb.dataset.colKey); else visibleColumns.delete(cb.dataset.colKey);
      draw();
    }));
    app.querySelectorAll('.report-filter-cb').forEach((cb) => cb.addEventListener('change', async () => {
      const key = cb.dataset.filterKey;
      if (!selectedFilters[key]) selectedFilters[key] = new Set();
      if (cb.checked) selectedFilters[key].add(cb.value); else selectedFilters[key].delete(cb.value);
      await loadData();
      draw();
    }));
    app.querySelectorAll('.report-filter-date').forEach((inp) => inp.addEventListener('change', async () => {
      const key = inp.dataset.filterKey;
      if (!selectedFilters[key] || selectedFilters[key] instanceof Set) selectedFilters[key] = {};
      selectedFilters[key][inp.dataset.bound] = inp.value || undefined;
      if (!selectedFilters[key].from && !selectedFilters[key].to) delete selectedFilters[key];
      await loadData();
      draw();
    }));
    app.querySelectorAll('.report-preset-btn').forEach((btn) => btn.addEventListener('click', async () => {
      selectedFilters = reportPresets(entity)[Number(btn.dataset.presetIdx)].apply();
      await loadData();
      draw();
    }));
    document.getElementById('clearFiltersBtn')?.addEventListener('click', async () => {
      selectedFilters = {};
      await loadData();
      draw();
    });
    document.getElementById('saveFavoriteBtn')?.addEventListener('click', () => { savingFavorite = true; draw(); });
    document.getElementById('cancelSaveFavoriteBtn')?.addEventListener('click', () => { savingFavorite = false; draw(); });
    document.getElementById('favLabelInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('confirmSaveFavoriteBtn').click();
    });
    document.getElementById('confirmSaveFavoriteBtn')?.addEventListener('click', async () => {
      const label = document.getElementById('favLabelInput').value.trim();
      if (!label) { toast('Name this view first'); return; }
      const payload = filtersPayload();
      const key = canonicalFiltersKey(payload);
      const dupe = favorites.find((f) => canonicalFiltersKey(f.Filters) === key);
      if (dupe) { toast(`You already have a favorite with these exact filters: "${dupe.Label}"`); return; }
      try {
        await api('/api/pg/reports/favorites', { method: 'POST', body: JSON.stringify({
          entity, label, filters: payload, visibleColumns: [...visibleColumns], sortKey, sortDir,
        }) });
        savingFavorite = false;
        await loadFavorites();
        toast(`Saved "${label}"`);
        draw();
      } catch (err) { toast(err.message); }
    });
    app.querySelectorAll('.report-fav-btn').forEach((btn) => btn.addEventListener('click', async () => {
      const fav = favorites.find((f) => f.Id === Number(btn.dataset.favId));
      if (!fav) return;
      selectedFilters = filtersFromSaved(fav.Filters);
      if (fav.VisibleColumns?.length) visibleColumns = new Set(fav.VisibleColumns);
      sortKey = fav.SortKey || null;
      sortDir = fav.SortDir || 'asc';
      await loadData();
      draw();
    }));
    app.querySelectorAll('.report-fav-delete').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/pg/reports/favorites/${btn.dataset.favId}`, { method: 'DELETE' });
      await loadFavorites();
      draw();
    }));
    app.querySelectorAll('.sortable-col').forEach((th) => th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortKey = key; sortDir = 'asc'; }
      draw();
    }));
    app.querySelectorAll('tr.clickable-row[data-id]').forEach((tr) => tr.addEventListener('click', () => {
      if (tr.dataset.entity === 'asset') go('assetDetail', { id: tr.dataset.id });
      else go('workOrderDetail', { id: tr.dataset.id });
    }));
  }

  await loadSchema();
  await Promise.all([loadData(), loadFavorites()]);
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

const ADMIN_CATEGORIES = {
  assets: {
    icon: '🏚️', title: 'Assets & Schema', description: 'Fields, components, building types — no deploy needed',
    items: [
      { view: 'adminAddFieldChoice', icon: '➕', label: 'Add New Field' },
      { view: 'adminPropertyFields', icon: '🏷️', label: 'Property Fields' },
      { view: 'adminComponentTypes', icon: '🧩', label: 'Component Types' },
      { view: 'adminBuildingTypes', icon: '🏛️', label: 'Building Types' },
      { view: 'adminApplicability', icon: '✅', label: 'Applicability Matrix' },
      { view: 'adminSubAreas', icon: '📐', label: 'Component Sub-Areas' },
    ],
  },
  workOrders: {
    icon: '🧾', title: 'Work Orders', description: 'Templates and checklists for repeatable work',
    items: [
      { view: 'adminWoTemplates', icon: '🧾', label: 'Work Order Templates' },
      { view: 'adminChecklistTemplates', icon: '✅', label: 'Checklist Templates' },
    ],
  },
  requests: {
    icon: '🧰', title: 'Maintenance Requests', description: 'What shows on the public request form, and what\'s required',
    items: [
      { view: 'adminRequestFields', icon: '🏷️', label: 'Request Form Fields' },
    ],
  },
  accounts: {
    icon: '👤', title: 'Accounts', description: 'Who can log in, and what they can see',
    items: [
      { view: 'adminUsers', icon: '👤', label: 'Users' },
    ],
  },
  system: {
    icon: '🕘', title: 'System', description: 'What has been done across the app',
    items: [
      { view: 'activityLog', icon: '🕘', label: 'Activity Log' },
    ],
  },
};
// Flat view -> label lookup for the breadcrumb trail (see renderBreadcrumbs) —
// every leaf tool across every category, in one map.
const ADMIN_TOOL_LABELS = Object.fromEntries(
  Object.values(ADMIN_CATEGORIES).flatMap((cat) => cat.items.map((item) => [item.view, item.label])),
);

async function renderAdminHub(container = app, { onOpenCategory } = {}) {
  if (container === app) setChrome({ title: 'Admin', showBack: false, showLogout: true });
  container.innerHTML = `
    <div class="admin-category-grid">
      ${Object.entries(ADMIN_CATEGORIES).map(([key, cat]) => `
        <div class="admin-category-card" data-category="${key}">
          <div class="admin-category-icon">${cat.icon}</div>
          <h3>${escapeHtml(cat.title)}</h3>
          <p class="muted">${escapeHtml(cat.description)}</p>
          <p class="muted" style="font-size:0.78rem">${cat.items.length} item${cat.items.length === 1 ? '' : 's'}</p>
        </div>`).join('')}
    </div>`;
  container.querySelectorAll('.admin-category-card').forEach((el) => el.addEventListener('click', () => {
    if (onOpenCategory) onOpenCategory(el.dataset.category);
    else go('adminCategory', { category: el.dataset.category });
  }));
}

async function renderAdminCategory({ category }, container = app, { onOpenTool } = {}) {
  const cat = ADMIN_CATEGORIES[category];
  if (container === app) setChrome({ title: cat?.title || 'Admin', showBack: true, showLogout: true });
  if (!cat) { container.innerHTML = '<p class="muted">Unknown category.</p>'; return; }
  container.innerHTML = `
    <div class="card"><p class="muted">${escapeHtml(cat.description)}</p></div>
    ${cat.items.map((item) => `<div class="list-item" data-view="${item.view}">${item.icon} ${escapeHtml(item.label)}</div>`).join('')}`;
  container.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => {
    if (onOpenTool) onOpenTool(el.dataset.view, {});
    else go(el.dataset.view, {});
  }));
}

const ACTIVITY_ACTION_PILL = {
  created: 'good', deleted: 'bad', deactivated: 'bad', updated: '', completed: 'good', reactivated: 'good',
};
// Plain-English phrasing for the Dashboard's Recent Activity feed — "Work
// order created: X" / "Progress logged on X" instead of a raw action+type
// pill, since this widget is meant to read like a log of what got done.
function activityNarrative(e) {
  const typeLabel = e.EntityType.replace(/_/g, ' ');
  const typeLabelCap = typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1);
  if (e.EntityType === 'work_order_log_entry') return `Progress logged on "${e.EntityLabel}"${e.Details ? ` (${e.Details})` : ''}`;
  if (e.EntityType === 'work_order' && e.Action === 'completed') return `Work order completed: ${e.EntityLabel}`;
  if (e.Action === 'created') return `${typeLabelCap} created: ${e.EntityLabel}`;
  if (e.Action === 'updated') return `${typeLabelCap} updated: ${e.EntityLabel}`;
  return `${typeLabelCap} ${e.Action}: ${e.EntityLabel}`;
}
// "Routine toggles" (checking a task/checklist step, flipping an
// applicability-matrix cell, ...) are logged with action 'toggled' — high
// frequency, low stakes. Whether to show them by default is remembered per
// browser, same persisted-preference pattern as getTableViewMode().
function getShowToggleActivity() {
  return localStorage.getItem('campAuditShowToggleActivity') === 'true';
}
async function renderActivityLog(container = app) {
  if (container === app) setChrome({ title: 'Activity Log', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { entries } = await api('/api/pg/activity-log?limit=300');
  let actionFilter = null;
  let typeFilter = null;
  let showToggles = getShowToggleActivity();

  function draw() {
    const base = showToggles ? entries : entries.filter((e) => e.Action !== 'toggled');
    const actions = [...new Set(base.map((e) => e.Action))].sort();
    const types = [...new Set(base.map((e) => e.EntityType))].sort();
    const visible = base.filter((e) => (!actionFilter || e.Action === actionFilter) && (!typeFilter || e.EntityType === typeFilter));
    const hiddenCount = entries.length - base.length;
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
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;align-items:center">
          <select id="actionFilter"><option value="">All actions</option>${actions.map((a) => `<option value="${a}" ${actionFilter === a ? 'selected' : ''}>${a}</option>`).join('')}</select>
          <select id="typeFilter"><option value="">All types</option>${types.map((t) => `<option value="${t}" ${typeFilter === t ? 'selected' : ''}>${t.replace(/_/g, ' ')}</option>`).join('')}</select>
          <label style="display:flex;align-items:center;gap:6px;font-weight:400">
            <input type="checkbox" id="showTogglesChk" ${showToggles ? 'checked' : ''} style="width:auto" />
            Show routine toggles${!showToggles && hiddenCount ? ` (${hiddenCount} hidden)` : ''}
          </label>
        </div>
      </div>
      <div class="card" style="overflow-x:auto">
        <table class="report-table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Type</th><th>What</th><th>Details</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="muted">No activity recorded yet.</td></tr>'}</tbody>
        </table>
      </div>`, container);
    container.querySelector('#actionFilter').addEventListener('change', (e) => { actionFilter = e.target.value || null; draw(); });
    container.querySelector('#typeFilter').addEventListener('change', (e) => { typeFilter = e.target.value || null; draw(); });
    container.querySelector('#showTogglesChk').addEventListener('change', (e) => {
      showToggles = e.target.checked;
      localStorage.setItem('campAuditShowToggleActivity', String(showToggles));
      actionFilter = null; typeFilter = null; // avoid landing on a filter value that just disappeared
      draw();
    });
  }

  draw();
}

async function renderAdminUsers(container = app) {
  if (container === app) setChrome({ title: 'Users', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { users } = await api('/api/pg/users');
  let editing = null; // 'new' | { id } | null

  function editFormHtml(u) {
    return `<div class="card">
      <h3>${u ? `Edit "${escapeHtml(u.Username)}"` : 'Add User'}</h3>
      ${u ? '' : `<div class="field-row"><label>Username</label><input class="u-username" required /></div>`}
      <div class="field-row"><label>Email (optional)</label><input class="u-email" type="email" value="${escapeHtml(u?.Email || '')}" /></div>
      <div class="field-row"><label>${u ? 'New Password (leave blank to keep current)' : 'Password'}</label><input class="u-password" type="password" ${u ? '' : 'required'} /></div>
      <div class="field-row"><label>Role</label>
        <select class="u-role">
          <option value="standard" ${(!u || u.Role === 'standard') ? 'selected' : ''}>Standard — sees only their own Dashboard activity</option>
          <option value="admin" ${u?.Role === 'admin' ? 'selected' : ''}>Admin — sees everyone's Dashboard activity</option>
        </select>
      </div>
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
          <div><strong>${escapeHtml(u.Username)}</strong> <span class="pill ${u.Role === 'admin' ? 'good' : ''}">${escapeHtml(u.Role)}</span>${!u.Active ? ' <span class="pill">inactive</span>' : ''}
            <div class="muted">${escapeHtml(u.Email || 'no email on file')}</div></div>
          <div class="btn-row" style="margin-top:0">
            <button class="btn btn-secondary edit-user" data-id="${u.Id}">Edit</button>
            <button class="btn btn-secondary delete-user" data-id="${u.Id}" data-name="${escapeHtml(u.Username)}">Delete</button>
          </div>
        </div>`).join('') || '<p class="muted">No accounts yet.</p>'}
      ${editing === 'new' ? editFormHtml(null) : `<div class="btn-row" style="margin-top:10px"><button class="btn btn-secondary" id="addUserBtn">+ Add User</button></div>`}
      ${editing?.id ? editFormHtml(users.find((u) => u.Id === editing.id)) : ''}
    `, container);
    wire();
  }

  function wire() {
    container.querySelector('#addUserBtn')?.addEventListener('click', () => { editing = 'new'; draw(); });
    container.querySelectorAll('.edit-user').forEach((btn) => btn.addEventListener('click', () => { editing = { id: Number(btn.dataset.id) }; draw(); }));
    container.querySelectorAll('.u-cancel').forEach((btn) => btn.addEventListener('click', () => { editing = null; draw(); }));
    container.querySelectorAll('.u-save').forEach((btn) => btn.addEventListener('click', async () => {
      const card = btn.closest('.card');
      const id = btn.dataset.id;
      const isNew = !id;
      const password = card.querySelector('.u-password').value;
      const email = card.querySelector('.u-email').value.trim();
      const role = card.querySelector('.u-role').value;
      try {
        if (isNew) {
          const username = card.querySelector('.u-username').value.trim();
          if (!username) { toast('Username is required'); return; }
          if (password.length < 6) { toast('Password must be at least 6 characters'); return; }
          await api('/api/pg/users', { method: 'POST', body: JSON.stringify({ username, password, email, role }) });
          toast('User added');
        } else {
          if (password && password.length < 6) { toast('Password must be at least 6 characters'); return; }
          const active = card.querySelector('.u-active').checked;
          await api(`/api/pg/users/${id}`, { method: 'PATCH', body: JSON.stringify({ email, password: password || undefined, active, role }) });
          toast('User saved');
        }
        renderAdminUsers(container);
      } catch (err) { toast(err.message); }
    }));
    container.querySelectorAll('.delete-user').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog(`Permanently delete the account "${btn.dataset.name}"? This cannot be undone.`)) return;
      try {
        await api(`/api/pg/users/${btn.dataset.id}`, { method: 'DELETE' });
        toast('User deleted');
        renderAdminUsers(container);
      } catch (err) { toast(err.message); }
    }));
  }

  draw();
}

async function renderAdminWoTemplates(container = app) {
  if (container === app) setChrome({ title: 'Work Order Templates', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
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
    `, container);
    wire();
  }

  function wire() {
    container.querySelector('#newTplBtn')?.addEventListener('click', () => { editingId = 'new'; draw(); });
    container.querySelectorAll('.tpl-edit').forEach((btn) => btn.addEventListener('click', () => { editingId = Number(btn.dataset.id); draw(); }));
    container.querySelectorAll('.tf-cancel').forEach((btn) => btn.addEventListener('click', () => { editingId = null; draw(); }));
    container.querySelectorAll('.tf-add-task').forEach((btn) => btn.addEventListener('click', () => {
      btn.previousElementSibling.insertAdjacentHTML('beforeend', taskRowHtml());
      wireRemoveButtons();
    }));
    container.querySelectorAll('.tf-add-line').forEach((btn) => btn.addEventListener('click', () => {
      btn.previousElementSibling.insertAdjacentHTML('beforeend', jobLineRowHtml());
      wireRemoveButtons();
    }));
    wireRemoveButtons();

    container.querySelectorAll('.tpl-delete').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog(`Delete template "${btn.dataset.name}"? This won't affect any work orders already created from it.`)) return;
      await api(`/api/pg/work-order-templates/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Template deleted');
      renderAdminWoTemplates(container);
    }));

    container.querySelectorAll('.tf-save').forEach((btn) => btn.addEventListener('click', async () => {
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
        renderAdminWoTemplates(container);
      } catch (err) { toast(err.message); }
    }));
  }

  function wireRemoveButtons() {
    container.querySelectorAll('.row-remove').forEach((btn) => { btn.onclick = () => btn.closest('.inline-add-row').remove(); });
  }

  draw();
}

function renderAdminAddFieldChoice(params = {}, container = app, { onOpenTool } = {}) {
  if (container === app) setChrome({ title: 'Add New Field', showBack: true, showLogout: true });
  container.innerHTML = `
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
  container.querySelector('#choicePropertyBtn').addEventListener('click', () => {
    if (onOpenTool) onOpenTool('adminPropertyFields', { openAdd: true });
    else go('adminPropertyFields', { openAdd: true });
  });
  container.querySelector('#choiceComponentBtn').addEventListener('click', () => {
    if (onOpenTool) onOpenTool('adminComponentTypes', { openAdd: true });
    else go('adminComponentTypes', { openAdd: true });
  });
}

async function renderAdminPropertyFields({ openAdd } = {}, container = app) {
  if (container === app) setChrome({ title: 'Property Fields', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { fields } = await api('/api/pg/admin/property-fields');
  const rows = fields.map((f) => `
    <div class="list-item" style="cursor:default">
      <span><strong>${escapeHtml(f.label)}</strong> <span class="muted">(${escapeHtml(f.field_key)}) — ${escapeHtml(f.input_type)}${f.options?.length ? ': ' + f.options.map(escapeHtml).join(', ') : ''}</span></span>
      <button class="btn btn-secondary toggle-active" data-id="${f.id}" data-next="${!f.active}">${f.active ? 'Deactivate' : 'Activate'}</button>
    </div>`).join('') || '<p class="muted">No property fields yet.</p>';

  container.innerHTML = `
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

  container.querySelector('#addFieldForm [name="label"]').addEventListener('input', (e) => {
    const keyInput = container.querySelector('#addFieldForm [name="fieldKey"]');
    if (!keyInput.dataset.touched) keyInput.value = e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  });
  container.querySelector('#addFieldForm [name="fieldKey"]').addEventListener('input', (e) => { e.target.dataset.touched = 'true'; });

  container.querySelectorAll('.toggle-active').forEach((btn) => btn.addEventListener('click', async () => {
    const action = btn.dataset.next === 'true' ? 'Reactivate' : 'Deactivate';
    if (!await confirmDialog(`${action} this field? ${action === 'Deactivate' ? 'It will stop appearing in the audit form and Edit Asset screen (existing data is kept).' : 'It will reappear in the audit form.'}`)) return;
    await api(`/api/pg/admin/property-fields/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.next === 'true' }) });
    renderAdminPropertyFields({}, container);
  }));

  container.querySelector('#addFieldForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const inputType = fd.get('inputType');
    const options = fd.get('options').split(',').map((s) => s.trim()).filter(Boolean);
    try {
      await api('/api/pg/admin/property-fields', { method: 'POST', body: JSON.stringify({ fieldKey: fd.get('fieldKey'), label: fd.get('label'), inputType, options }) });
      toast('Field created — available immediately in the audit form');
      state.options = null; // force refresh of cached options (building types etc. unaffected, but keep it simple)
      renderAdminPropertyFields({}, container);
    } catch (err) { toast(err.message); }
  });
}

const REQUEST_FIELD_TYPE_LABELS = { text: 'Free text', textarea: 'Long text', select: 'Single choice', multiselect: 'Multiple choice', number: 'Number', date: 'Date', checkbox: 'Yes/No' };

async function renderAdminRequestFields(container = app) {
  if (container === app) setChrome({ title: 'Request Form Fields', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { fields } = await api('/api/pg/admin/request-fields');
  const rows = fields.map((f) => `
    <div class="list-item" style="cursor:default;flex-wrap:wrap">
      <span><strong>${escapeHtml(f.label)}</strong> <span class="muted">(${escapeHtml(f.field_key)}) — ${escapeHtml(REQUEST_FIELD_TYPE_LABELS[f.input_type] || f.input_type)}${f.options?.length ? ': ' + f.options.map(escapeHtml).join(', ') : ''}${f.column_name ? ' · built-in' : ''}</span></span>
      <span class="btn-row" style="margin:0">
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:0.85rem">
          <input type="checkbox" class="toggle-required" data-id="${f.id}" ${f.required ? 'checked' : ''} style="width:auto" /> Required
        </label>
        <button class="btn btn-secondary toggle-active" data-id="${f.id}" data-next="${!f.active}">${f.active ? 'Hide' : 'Show'}</button>
      </span>
    </div>`).join('') || '<p class="muted">No request fields yet.</p>';

  container.innerHTML = `
    <div class="card"><h3>Request Form Fields</h3><p class="muted">Controls what appears on the public maintenance request form (audit.fracturedrv.com/request), in this order, and whether each is required. "Built-in" fields (name, email, location, description) can be hidden or made optional but not deleted — everything else is a field you added.</p></div>
    ${rows}
    <div class="card">
      <h3>Add Another Field</h3>
      <form id="addReqFieldForm">
        <div class="field-row"><label>Label</label><input name="label" placeholder="e.g. Best time to reach you" required /></div>
        <div class="field-row"><label>Field Key (lowercase, no spaces)</label><input name="fieldKey" placeholder="e.g. best_time" pattern="[a-z][a-z0-9_]*" required /></div>
        <div class="field-row"><label>Type</label>
          <select name="inputType">
            <option value="text">Free text</option>
            <option value="textarea">Long text</option>
            <option value="select">Single choice (select)</option>
            <option value="multiselect">Multiple choice (multiselect)</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="checkbox">Yes/No (checkbox)</option>
          </select>
        </div>
        <div class="field-row"><label>Options (comma-separated, if applicable)</label><input name="options" placeholder="e.g. Morning, Afternoon, Evening" /></div>
        <div class="field-row"><label style="display:flex;align-items:center;gap:8px;font-weight:400"><input type="checkbox" name="required" style="width:auto" /> Required</label></div>
        <button class="btn btn-primary" type="submit">Create Field</button>
      </form>
    </div>`;

  container.querySelector('#addReqFieldForm [name="label"]').addEventListener('input', (e) => {
    const keyInput = container.querySelector('#addReqFieldForm [name="fieldKey"]');
    if (!keyInput.dataset.touched) keyInput.value = e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  });
  container.querySelector('#addReqFieldForm [name="fieldKey"]').addEventListener('input', (e) => { e.target.dataset.touched = 'true'; });

  container.querySelectorAll('.toggle-active').forEach((btn) => btn.addEventListener('click', async () => {
    const action = btn.dataset.next === 'true' ? 'Show' : 'Hide';
    if (!await confirmDialog(`${action} this field on the public request form?`, { danger: false })) return;
    await api(`/api/pg/admin/request-fields/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.next === 'true' }) });
    renderAdminRequestFields(container);
  }));

  container.querySelectorAll('.toggle-required').forEach((cb) => cb.addEventListener('change', async () => {
    try {
      await api(`/api/pg/admin/request-fields/${cb.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ required: cb.checked }) });
      toast(cb.checked ? 'Field is now required' : 'Field is now optional');
    } catch (err) { toast(err.message); cb.checked = !cb.checked; }
  }));

  container.querySelector('#addReqFieldForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const inputType = fd.get('inputType');
    const options = fd.get('options').split(',').map((s) => s.trim()).filter(Boolean);
    try {
      await api('/api/pg/admin/request-fields', { method: 'POST', body: JSON.stringify({
        fieldKey: fd.get('fieldKey'), label: fd.get('label'), inputType, options, required: fd.get('required') === 'on',
      }) });
      toast('Field created — available immediately on the public request form');
      renderAdminRequestFields(container);
    } catch (err) { toast(err.message); }
  });
}

async function renderAdminComponentTypes({ openAdd } = {}, container = app) {
  if (container === app) setChrome({ title: 'Component Types', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { componentTypes } = await api('/api/pg/admin/component-types');
  const rows = componentTypes.map((c) => `
    <div class="list-item" style="cursor:default">
      <span><strong>${escapeHtml(c.component_type)}</strong> <span class="muted">events: ${c.event_type_options.map(escapeHtml).join(', ')} · conditions: ${c.condition_options.map(escapeHtml).join(', ')}</span></span>
      <label class="muted" style="display:flex;align-items:center;gap:6px"><input type="checkbox" class="prompt-toggle" data-type="${escapeHtml(c.component_type)}" ${c.prompted_in_audit ? 'checked' : ''}/> prompted in audit</label>
    </div>`).join('') || '<p class="muted">No component types yet.</p>';

  container.innerHTML = `
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

  container.querySelectorAll('.prompt-toggle').forEach((cb) => cb.addEventListener('change', async () => {
    if (!await confirmDialog(`${cb.checked ? 'Start' : 'Stop'} prompting for "${cb.dataset.type}" during the audit walkthrough (when Free Standing Building = Yes)?`)) {
      cb.checked = !cb.checked;
      return;
    }
    await api(`/api/pg/admin/component-types/${encodeURIComponent(cb.dataset.type)}`, { method: 'PATCH', body: JSON.stringify({ promptedInAudit: cb.checked }) });
    toast('Updated');
  }));

  container.querySelector('#addCompForm').addEventListener('submit', async (e) => {
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
      renderAdminComponentTypes({}, container);
    } catch (err) { toast(err.message); }
  });
}

async function renderAdminBuildingTypes(container = app) {
  if (container === app) setChrome({ title: 'Building Types', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { buildingTypes } = await api('/api/pg/admin/building-types');
  const rows = buildingTypes.map((b) => `
    <div class="list-item" style="cursor:default">
      <span>${escapeHtml(b.Name)}</span>
      <button class="btn btn-secondary delete-bt" data-id="${b.Id}">Delete</button>
    </div>`).join('');

  container.innerHTML = `
    <div class="card"><h3>Building Types</h3></div>
    ${rows}
    <div class="card">
      <h3>Add Building Type</h3>
      <form id="addBtForm">
        <div class="field-row"><label>Name</label><input name="name" required /></div>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>
    </div>`;

  container.querySelectorAll('.delete-bt').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog('Delete this building type? Only works if no assets currently use it.')) return;
    try { await api(`/api/pg/admin/building-types/${btn.dataset.id}`, { method: 'DELETE' }); renderAdminBuildingTypes(container); }
    catch (err) { toast(err.message); }
  }));
  container.querySelector('#addBtForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name');
    try {
      await api('/api/pg/admin/building-types', { method: 'POST', body: JSON.stringify({ name }) });
      renderAdminBuildingTypes(container);
    } catch (err) { toast(err.message); }
  });
}

async function renderAdminApplicability(container = app) {
  if (container === app) setChrome({ title: 'Applicability Matrix', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { buildingTypes, questionKeys, matrix } = await api('/api/pg/admin/applicability');
  const header = questionKeys.map((q) => `<th>${escapeHtml(q.label)}</th>`).join('');
  const rows = matrix.map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.buildingTypeName)}</strong></td>
      ${row.cells.map((c) => `<td style="text-align:center"><input type="checkbox" class="applies-cb" data-bt="${row.buildingTypeId}" data-qk="${escapeHtml(c.questionKey)}" ${c.applies ? 'checked' : ''}/></td>`).join('')}
    </tr>`).join('');

  container.innerHTML = `
    <div class="card"><h3>Applicability Matrix</h3>
      <p class="muted">Unchecked = that question/component is skipped for that building type during the audit. Checked (default) = it applies.</p>
    </div>
    <div class="card" style="overflow-x:auto">
      <table class="report-table matrix-table"><thead><tr><th>Building Type</th>${header}</tr></thead><tbody>${rows}</tbody></table>
    </div>`;

  container.querySelectorAll('.applies-cb').forEach((cb) => cb.addEventListener('change', async () => {
    try {
      await api('/api/pg/admin/applicability', { method: 'PUT', body: JSON.stringify({ buildingTypeId: Number(cb.dataset.bt), questionKey: cb.dataset.qk, applies: cb.checked }) });
    } catch (err) { toast(err.message); cb.checked = !cb.checked; }
  }));
}

async function renderAdminSubAreas(container = app) {
  if (container === app) setChrome({ title: 'Component Sub-Areas', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { subAreas } = await api('/api/pg/admin/sub-areas');
  const byType = new Map();
  subAreas.forEach((s) => { if (!byType.has(s.component_type)) byType.set(s.component_type, []); byType.get(s.component_type).push(s); });
  const groups = [...byType.entries()].map(([type, areas]) => `
    <div class="card"><h3>${escapeHtml(type)}</h3>
      ${areas.map((a) => `<div class="list-item" style="cursor:default"><span>${escapeHtml(a.sub_area)}</span><button class="btn btn-secondary delete-sa" data-id="${a.id}" data-name="${escapeHtml(a.sub_area)}" data-type="${escapeHtml(type)}">Delete</button></div>`).join('')}
    </div>`).join('') || '<p class="muted">No sub-areas defined yet.</p>';

  container.innerHTML = `
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

  container.querySelectorAll('.delete-sa').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete sub-area "${btn.dataset.name}" from ${btn.dataset.type}? This cannot be undone from the app — you'd need to re-add it manually.`)) return;
    await api(`/api/pg/admin/sub-areas/${btn.dataset.id}`, { method: 'DELETE' });
    toast('Sub-area deleted');
    renderAdminSubAreas(container);
  }));
  container.querySelector('#addSaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/pg/admin/sub-areas', { method: 'POST', body: JSON.stringify({ componentType: fd.get('componentType'), subArea: fd.get('subArea') }) });
      renderAdminSubAreas(container);
    } catch (err) { toast(err.message); }
  });
}

// ---------- Calendar / Scheduler ----------

// Slide-out panel from the right, listing one day's scheduled WOs/events —
// opened by clicking a day cell's background (not one of its entry pills,
// which still navigate straight to that WO/event as before).
function openDayPanel(dateKey, entries) {
  closeDayPanel();
  const label = new Date(`${dateKey}T00:00:00`).toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const overlay = document.createElement('div');
  overlay.className = 'day-panel-overlay';
  overlay.id = 'dayPanelOverlay';
  overlay.innerHTML = `
    <div class="day-panel">
      <div class="btn-row" style="justify-content:space-between;align-items:center;margin-top:0">
        <h3 style="margin:0">${escapeHtml(label)}</h3>
        <button class="btn btn-secondary" id="closeDayPanelBtn">✕</button>
      </div>
      ${entries.length ? entries.map((e) => e.type === 'wo'
        ? `<div class="list-item day-panel-entry" data-wo-id="${e.Id}"><span>🛠️ ${escapeHtml(e.Asset?.Name || '')}${e.Asset ? ': ' : ''}${escapeHtml(e.Title)}</span><span class="pill ${woStatusPillClass(e.Status)}">${escapeHtml(e.Status)}</span></div>`
        : `<div class="list-item day-panel-entry" data-event-id="${e.Id}"><span>📅 ${escapeHtml(e.Title)}${e.RecurrenceType !== 'none' ? ' 🔁' : ''}</span></div>`
      ).join('') : '<p class="muted">Nothing scheduled this day.</p>'}
      <div class="btn-row"><button class="btn btn-primary" id="dayPanelAddEventBtn">+ Add Event This Day</button></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeDayPanel(); });
  document.getElementById('closeDayPanelBtn').addEventListener('click', closeDayPanel);
  document.getElementById('dayPanelAddEventBtn').addEventListener('click', () => { closeDayPanel(); go('newCalendarEvent', { date: dateKey }); });
  overlay.querySelectorAll('[data-wo-id]').forEach((el) => el.addEventListener('click', () => { closeDayPanel(); go('workOrderDetail', { id: el.dataset.woId }); }));
  overlay.querySelectorAll('[data-event-id]').forEach((el) => el.addEventListener('click', () => { closeDayPanel(); go('calendarEventDetail', { id: el.dataset.eventId }); }));
}
function closeDayPanel() { document.getElementById('dayPanelOverlay')?.remove(); }

async function renderCalendar(params = {}) {
  setChrome({ title: 'Calendar', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const now = new Date();
  let viewMonth = params.month != null ? Number(params.month) : now.getMonth();
  let viewYear = params.year != null ? Number(params.year) : now.getFullYear();
  const todayKey = isoDate(now);
  let dayEntriesMap = new Map(); // dateKey -> entries[], refreshed each draw(); read by the day-cell click handler

  async function draw() {
    closeDayPanel();
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

    dayEntriesMap = new Map();
    for (const w of workOrders) {
      const sd = w['Scheduled Date'];
      if (!sd) continue;
      const key = sd.slice(0, 10);
      if (key < fromStr || key > toStr) continue;
      if (!dayEntriesMap.has(key)) dayEntriesMap.set(key, []);
      dayEntriesMap.get(key).push({ type: 'wo', ...w });
    }
    for (const occ of occurrences) {
      if (!dayEntriesMap.has(occ.OccurrenceDate)) dayEntriesMap.set(occ.OccurrenceDate, []);
      dayEntriesMap.get(occ.OccurrenceDate).push({ type: 'event', ...occ });
    }
    const allUnscheduled = workOrders.filter((w) => !w['Scheduled Date']);

    const entryHtml = (e) => e.type === 'wo'
      ? `<div class="cal-entry" data-wo-id="${e.Id}"><span class="pill ${woStatusPillClass(e.Status)}">🛠️ ${escapeHtml(e.Asset?.Name || '')}${e.Asset ? ': ' : ''}${escapeHtml(e.Title)} — ${escapeHtml(e.Status)}</span></div>`
      : `<div class="cal-entry" data-event-id="${e.Id}"><span class="pill pop">📅 ${escapeHtml(e.Title)}${e.RecurrenceType !== 'none' ? ' 🔁' : ''}</span></div>`;

    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push('<div class="cal-cell cal-empty"></div>');
    for (let d = 1; d <= daysInMonth; d++) {
      const dateKey = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const entries = dayEntriesMap.get(dateKey) || [];
      const shown = entries.slice(0, 3);
      const overflow = entries.length - shown.length;
      cells.push(`<div class="cal-cell ${dateKey === todayKey ? 'cal-today' : ''}" data-date="${dateKey}">
        <div class="cal-daynum">${d}</div>
        ${shown.map(entryHtml).join('')}
        ${overflow > 0 ? `<div class="muted" style="font-size:0.75rem">+${overflow} more</div>` : ''}
      </div>`);
    }

    setApp(`
      ${params.fromWorkOrderId ? `
        <div class="btn-row" style="margin-bottom:10px">
          <button class="btn btn-secondary" id="backToWoBtn">← Back to Work Order${params.fromWorkOrderTitle ? `: ${escapeHtml(params.fromWorkOrderTitle)}` : ''}</button>
        </div>` : ''}
      <div class="cal-header">
        <button class="btn btn-secondary" id="prevMonthBtn">‹ Prev</button>
        <h3>${monthLabel}</h3>
        <button class="btn btn-secondary" id="nextMonthBtn">Next ›</button>
      </div>
      <div class="cal-layout">
        <div class="cal-main">
          <div class="btn-row" style="margin-bottom:12px"><button class="btn btn-primary" id="addEventBtn">+ Add Event</button></div>
          <div class="cal-scroll"><div class="cal-grid">
            ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-head">${d}</div>`).join('')}
            ${cells.join('')}
          </div></div>
        </div>
        <div class="cal-sidebar">
          <div class="card"><h3>Unscheduled Work Orders${allUnscheduled.length ? ` (${allUnscheduled.length})` : ''}</h3>
            <p class="muted">Set a Scheduled Date on a work order to place it on the calendar.</p>
            ${allUnscheduled.length ? allUnscheduled.map((w) => `<div class="list-item" data-wo-id="${w.Id}">
              <span>${escapeHtml(w.Title)}${w.Asset ? ` — ${escapeHtml(w.Asset.Name)}` : ''}</span>
              <span class="pill ${woStatusPillClass(w.Status)}">${escapeHtml(w.Status)}</span>
            </div>`).join('') : '<p class="muted">None — everything is scheduled. 🎉</p>'}
          </div>
        </div>
      </div>`);
    wire();
  }

  function wire() {
    document.getElementById('backToWoBtn')?.addEventListener('click', () => go('workOrderDetail', { id: params.fromWorkOrderId }));
    document.getElementById('prevMonthBtn').addEventListener('click', () => {
      viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } draw();
    });
    document.getElementById('nextMonthBtn').addEventListener('click', () => {
      viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } draw();
    });
    document.getElementById('addEventBtn').addEventListener('click', () => go('newCalendarEvent', {}));
    app.querySelectorAll('[data-wo-id]').forEach((el) => el.addEventListener('click', () => go('workOrderDetail', { id: el.dataset.woId })));
    app.querySelectorAll('.cal-entry[data-event-id]').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation(); go('calendarEventDetail', { id: el.dataset.eventId });
    }));
    app.querySelectorAll('.cal-cell[data-date]').forEach((cell) => cell.addEventListener('click', (e) => {
      if (e.target.closest('.cal-entry')) return; // entry clicks navigate directly, handled above
      openDayPanel(cell.dataset.date, dayEntriesMap.get(cell.dataset.date) || []);
    }));
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

async function renderAdminChecklistTemplates(container = app) {
  if (container === app) setChrome({ title: 'Checklist Templates', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
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
    `, container);
    wire();
  }

  function wire() {
    container.querySelector('#newChecklistBtn')?.addEventListener('click', () => { editingId = 'new'; draw(); });
    container.querySelectorAll('.cl-edit').forEach((btn) => btn.addEventListener('click', () => { editingId = Number(btn.dataset.id); draw(); }));
    container.querySelectorAll('.cf-cancel').forEach((btn) => btn.addEventListener('click', () => { editingId = null; draw(); }));
    const stepsContainer = container.querySelector('.cf-steps');
    if (stepsContainer) {
      container.querySelector('.cf-add-step').addEventListener('click', () => {
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

    container.querySelectorAll('.cl-delete').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog(`Delete checklist "${btn.dataset.name}"? Any WOs/events already using it keep their own copy of the steps.`)) return;
      await api(`/api/pg/checklist-templates/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Checklist deleted');
      renderAdminChecklistTemplates(container);
    }));

    container.querySelectorAll('.cf-save').forEach((btn) => btn.addEventListener('click', async () => {
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
        renderAdminChecklistTemplates(container);
      } catch (err) { toast(err.message); }
    }));
  }

  draw();
}

// ---------- Work Orders ----------

const WO_LIST_COLUMNS = [
  { key: 'asset', label: 'Asset', default: true },
  { key: 'status', label: 'Status', default: true },
  { key: 'priority', label: 'Priority', default: true },
  { key: 'daysSinceCreated', label: 'Days Since Created', default: true },
  { key: 'scheduledDate', label: 'Scheduled Date', default: true },
  { key: 'dateCreated', label: 'Date Created', default: false },
  { key: 'estHours', label: 'Est. Hours', default: false },
  { key: 'estCost', label: 'Est. Cost', default: false },
];
function getWoColumnPrefs() {
  const defaults = Object.fromEntries(WO_LIST_COLUMNS.map((c) => [c.key, c.default]));
  try {
    const raw = localStorage.getItem('campAuditWoColumns');
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch { return defaults; }
}
function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

const WO_SCHEDULE_FILTER_LABELS = { pastDue: 'Past Due', dueToday: 'Due Today', dueFuture: 'Due Later', unscheduled: 'Unscheduled' };
function matchesScheduleFilter(w, key) {
  if (w.Status === 'Done') return false;
  const sd = w['Scheduled Date'] ? w['Scheduled Date'].slice(0, 10) : null;
  const todayStr = isoDate(new Date());
  if (key === 'unscheduled') return !sd;
  if (!sd) return false;
  if (key === 'pastDue') return sd < todayStr;
  if (key === 'dueToday') return sd === todayStr;
  if (key === 'dueFuture') return sd > todayStr;
  return true;
}

async function renderWorkOrders(params = {}, container = app, { onOpenWorkOrder } = {}) {
  if (container === app) setChrome({ title: 'Work Orders', showBack: false, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { workOrders } = await api('/api/pg/work-orders');
  let cols = getWoColumnPrefs();
  let statusFilter = params.status || null;
  let scheduleFilter = params.schedule || null;
  let selectedWoId = null;

  function draw() {
    const mode = onOpenWorkOrder ? 'cards' : getTableViewMode();
    const visibleWOs = workOrders.filter((w) =>
      (!statusFilter || w.Status === statusFilter) && (!scheduleFilter || matchesScheduleFilter(w, scheduleFilter)));
    const cardRows = visibleWOs.map((w) => {
      const days = daysSince(w['Date Reported']);
      const bits = [];
      if (cols.asset && w.Asset) bits.push(escapeHtml(w.Asset.Name));
      if (cols.priority) bits.push(escapeHtml(w.Priority || ''));
      if (cols.daysSinceCreated && days != null) bits.push(`${days}d old`);
      if (cols.scheduledDate && w['Scheduled Date']) bits.push(`Sched. ${formatDateNice(w['Scheduled Date'])}`);
      if (cols.dateCreated && w['Date Reported']) bits.push(`Created ${formatDateNice(w['Date Reported'])}`);
      if (cols.estHours && w['Estimated Hours'] != null) bits.push(`${w['Estimated Hours']}h est.`);
      if (cols.estCost && w['Estimated Cost'] != null) bits.push(`$${Number(w['Estimated Cost']).toLocaleString()} est.`);
      return `<div class="list-item ${onOpenWorkOrder && selectedWoId === w.Id ? 'cal-strip-selected' : ''}" style="flex-wrap:wrap" data-id="${w.Id}">
        <span>${escapeHtml(w.Title)}${bits.length ? `<div class="muted" style="font-weight:400">${bits.join(' · ')}</div>` : ''}</span>
        ${cols.status ? `<span class="pill ${woStatusPillClass(w.Status)}">${escapeHtml(w.Status || '')}</span>` : ''}
      </div>`;
    }).join('') || `<p class="muted">${(statusFilter || scheduleFilter) ? 'Nothing matches this filter.' : 'No work orders yet.'}</p>`;

    const tableRows = visibleWOs.map((w) => {
      const days = daysSince(w['Date Reported']);
      return `<tr class="clickable-row" data-id="${w.Id}">
        <td data-label="Title">${escapeHtml(w.Title)}</td>
        ${cols.asset ? `<td data-label="Asset">${escapeHtml(w.Asset?.Name || '—')}</td>` : ''}
        ${cols.status ? `<td data-label="Status"><span class="pill ${woStatusPillClass(w.Status)}">${escapeHtml(w.Status || '')}</span></td>` : ''}
        ${cols.priority ? `<td data-label="Priority">${escapeHtml(w.Priority || '')}</td>` : ''}
        ${cols.daysSinceCreated ? `<td data-label="Days Since Created">${days != null ? days : '—'}</td>` : ''}
        ${cols.scheduledDate ? `<td data-label="Scheduled Date">${formatDateNice(w['Scheduled Date']) || '—'}</td>` : ''}
        ${cols.dateCreated ? `<td data-label="Date Created">${formatDateNice(w['Date Reported']) || '—'}</td>` : ''}
        ${cols.estHours ? `<td data-label="Est. Hours">${w['Estimated Hours'] ?? '—'}</td>` : ''}
        ${cols.estCost ? `<td data-label="Est. Cost">${w['Estimated Cost'] ? '$' + Number(w['Estimated Cost']).toLocaleString() : '—'}</td>` : ''}
      </tr>`;
    }).join('');
    const visibleCols = WO_LIST_COLUMNS.filter((c) => cols[c.key]);
    const filterLabel = statusFilter || (scheduleFilter ? WO_SCHEDULE_FILTER_LABELS[scheduleFilter] : null);

    setApp(`
      <div class="btn-row" style="margin-bottom:12px;justify-content:space-between">
        <button class="btn btn-primary" id="newWoBtnTop">+ New Work Order</button>
        ${onOpenWorkOrder ? '' : tableViewToggleHtml(mode)}
      </div>
      ${filterLabel ? `<div class="btn-row" style="margin:-6px 0 12px"><button class="btn btn-secondary" id="clearWoFilter">✕ Filtered: ${escapeHtml(filterLabel)}</button></div>` : ''}
      ${mode === 'table' ? `
        <details class="card" style="margin-bottom:12px">
          <summary style="cursor:pointer;font-weight:700">Columns</summary>
          <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:10px">
            ${WO_LIST_COLUMNS.map((c) => `<label style="display:flex;align-items:center;gap:6px;font-weight:400">
              <input type="checkbox" class="col-toggle" data-col="${c.key}" ${cols[c.key] ? 'checked' : ''} style="width:auto" /> ${escapeHtml(c.label)}
            </label>`).join('')}
          </div>
        </details>
        <div class="card" style="overflow-x:auto">
          <table class="report-table">
            <thead><tr><th>Title</th>${visibleCols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
            <tbody>${tableRows || `<tr><td colspan="${visibleCols.length + 1}" class="muted">${filterLabel ? 'Nothing matches this filter.' : 'No work orders yet.'}</td></tr>`}</tbody>
          </table>
        </div>` : cardRows}
    `, container);

    container.querySelector('#newWoBtnTop').addEventListener('click', () => go('newWorkOrder', {}));
    container.querySelector('#clearWoFilter')?.addEventListener('click', () => { statusFilter = null; scheduleFilter = null; draw(); });
    container.querySelectorAll('.list-item[data-id], tr.clickable-row').forEach((el) => el.addEventListener('click', () => {
      if (onOpenWorkOrder) { selectedWoId = Number(el.dataset.id); draw(); onOpenWorkOrder(el.dataset.id); }
      else go('workOrderDetail', { id: el.dataset.id });
    }));
    wireTableViewToggle(draw);
    container.querySelectorAll('.col-toggle').forEach((cb) => cb.addEventListener('click', (e) => e.stopPropagation()));
    container.querySelectorAll('.col-toggle').forEach((cb) => cb.addEventListener('change', () => {
      cols = { ...cols, [cb.dataset.col]: cb.checked };
      localStorage.setItem('campAuditWoColumns', JSON.stringify(cols));
      draw();
    }));
  }

  draw();
}

function requestStatusPillClass(status) {
  if (status === 'approved') return 'good';
  if (status === 'denied') return 'bad';
  if (status === 'converted') return 'pop';
  if (status === 'submitted') return 'warn';
  return ''; // closed = neutral
}

const REQUEST_STATUSES = ['submitted', 'approved', 'denied', 'converted', 'closed'];

async function renderRequests(params = {}, container = app) {
  if (container === app) setChrome({ title: 'Requests', showBack: false, showLogout: true });
  container.innerHTML = LOADING_HTML;
  let statusFilter = params.status || null;

  async function draw() {
    const { requests } = await api(`/api/pg/requests${statusFilter ? `?status=${statusFilter}` : ''}`);
    const rows = requests.map((r) => `
      <div class="list-item" style="flex-wrap:wrap" data-id="${r.Id}">
        <span>
          <strong>${escapeHtml(r.RequesterName || r.RequesterEmail || 'Unknown')}</strong>
          ${r.Description ? `<div class="muted" style="font-weight:400">${escapeHtml(r.Description.slice(0, 90))}${r.Description.length > 90 ? '…' : ''}</div>` : ''}
          <div class="muted" style="font-weight:400">${[r.LocationName, formatDateNice(r.CreatedAt)].filter(Boolean).join(' · ')}</div>
        </span>
        <span>
          ${r.Priority ? `<span class="pill">${escapeHtml(r.Priority)}</span>` : ''}
          <span class="pill ${requestStatusPillClass(r.Status)}">${escapeHtml(r.Status)}</span>
        </span>
      </div>`).join('') || `<p class="muted">${statusFilter ? 'Nothing matches this filter.' : 'No requests yet.'}</p>`;

    setApp(`
      <div class="card">
        <p class="muted">Submitted through the public form at <strong>/request</strong> — never automatically turned into a Work Order. Review each one below and, if warranted, convert it.</p>
      </div>
      <div class="btn-row" style="margin-bottom:12px;flex-wrap:wrap">
        <button class="btn ${!statusFilter ? 'btn-primary' : 'btn-secondary'}" data-status="">All</button>
        ${REQUEST_STATUSES.map((s) => `<button class="btn ${statusFilter === s ? 'btn-primary' : 'btn-secondary'}" data-status="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
      </div>
      ${rows}
    `, container);

    container.querySelectorAll('[data-status]').forEach((btn) => btn.addEventListener('click', () => { statusFilter = btn.dataset.status || null; draw(); }));
    container.querySelectorAll('.list-item[data-id]').forEach((el) => el.addEventListener('click', () =>
      go('requestDetail', { id: el.dataset.id, label: `Request #${el.dataset.id}` })));
  }

  draw();
}

async function renderRequestDetail({ id }, container = app) {
  if (container === app) setChrome({ title: 'Request', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const [{ request }, { messages }] = await Promise.all([
    api(`/api/pg/requests/${id}`), api(`/api/pg/requests/${id}/messages`),
  ]);

  const photosHtml = request.Photos.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:8px">${request.Photos.map((p) => `<a href="${escapeHtml(p.Url)}" target="_blank" rel="noopener"><img src="${escapeHtml(p.Url)}" alt="" style="width:100px;height:100px;object-fit:cover;border-radius:8px" /></a>`).join('')}</div>`
    : '<p class="muted">No photos attached.</p>';

  const customFieldsHtml = request.CustomFields.length
    ? request.CustomFields.map((f) => `<div class="list-item" style="cursor:default"><span>${escapeHtml(f.label)}</span><span>${escapeHtml(f.value)}</span></div>`).join('')
    : '';

  const messagesHtml = messages.length
    ? messages.map((m) => `
      <div class="list-item" style="cursor:default;flex-direction:column;align-items:flex-start;gap:4px">
        <div style="display:flex;justify-content:space-between;width:100%;gap:8px">
          <strong>${escapeHtml(m.Subject)}</strong>
          <span class="pill ${m.Status === 'failed' ? 'bad' : 'good'}">${m.Status === 'failed' ? 'Failed' : 'Sent'}</span>
        </div>
        <div class="muted">To ${escapeHtml(m.ToEmail)} · ${escapeHtml(m.SentBy)} · ${new Date(m.CreatedAt).toLocaleString()}</div>
        <div style="white-space:pre-wrap">${escapeHtml(m.Body)}</div>
        ${m.Error ? `<div class="muted" style="color:var(--danger)">${escapeHtml(m.Error)}</div>` : ''}
      </div>`).join('')
    : '<p class="muted">No messages sent yet.</p>';

  container.innerHTML = `
    <div class="card">
      <h3>${escapeHtml(request.RequesterName || request.RequesterEmail)}</h3>
      <p class="muted">${escapeHtml(request.RequesterEmail)}${request.RequesterPhone ? ' · ' + escapeHtml(request.RequesterPhone) : ''}</p>
      <div class="list-item" style="cursor:default"><span>Location</span><span>${escapeHtml(request.LocationName || '—')}</span></div>
      <div class="list-item" style="cursor:default"><span>Priority</span><span>${escapeHtml(request.Priority || '—')}</span></div>
      <div class="list-item" style="cursor:default"><span>Submitted</span><span>${new Date(request.CreatedAt).toLocaleString()}</span></div>
      <h4 style="margin:14px 0 6px">Description</h4>
      <p>${escapeHtml(request.Description || '—')}</p>
      ${customFieldsHtml ? `<h4 style="margin:14px 0 6px">Additional Details</h4>${customFieldsHtml}` : ''}
      <h4 style="margin:14px 0 6px">Photos</h4>
      ${photosHtml}
    </div>

    <div class="card">
      <h3>Review</h3>
      ${request.WorkOrderId ? `<p class="muted">Converted to <a href="#" id="viewWoLink">Work Order #${request.WorkOrderId}</a>${request.WorkOrderTitle ? ': ' + escapeHtml(request.WorkOrderTitle) : ''}.</p>` : ''}
      <form id="statusForm">
        <div class="field-row"><label>Status</label>
          <select name="status">${REQUEST_STATUSES.map((s) => `<option value="${s}" ${request.Status === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>
        </div>
        <div class="field-row"><label>Review Note (optional — included in the notification email)</label><textarea name="reviewNote">${escapeHtml(request.ReviewNote || '')}</textarea></div>
        <div class="field-row"><label style="display:flex;align-items:center;gap:8px;font-weight:400"><input type="checkbox" name="notify" checked style="width:auto" /> Email the requester about this change</label></div>
        <button class="btn btn-primary" type="submit">Save Status</button>
      </form>
      ${request.Status === 'approved' && !request.WorkOrderId ? `
        <div class="btn-row" style="margin-top:12px">
          <button class="btn btn-secondary" id="convertBtn">Convert to Work Order</button>
        </div>` : ''}
      ${request.ReviewedBy ? `<p class="muted" style="margin-top:10px">Last reviewed by ${escapeHtml(request.ReviewedBy)} on ${new Date(request.ReviewedAt).toLocaleString()}</p>` : ''}
    </div>

    <div class="card">
      <h3>Link to Asset (optional)</h3>
      <p class="muted">Not shown on the public form — link internally once you know which asset this is about, so a converted Work Order points at it.</p>
      <div id="assetPickerWrap"></div>
    </div>

    <div class="card">
      <h3>Email</h3>
      ${messagesHtml}
      <form id="sendMessageForm" style="margin-top:10px">
        <div class="field-row"><label>Subject</label><input name="subject" required value="Re: your maintenance request (Ref #${id})" /></div>
        <div class="field-row"><label>Message</label><textarea name="body" required placeholder="Write a message to ${escapeHtml(request.RequesterName || request.RequesterEmail)}…"></textarea></div>
        <button class="btn btn-primary" type="submit">Send Email</button>
      </form>
    </div>`;

  mountAssetCombobox(container.querySelector('#assetPickerWrap'), {
    initialAsset: request.AssetId ? { Id: request.AssetId, Name: request.AssetName } : null,
    onSelect: async (asset) => {
      try {
        await api(`/api/pg/requests/${id}/asset`, { method: 'PATCH', body: JSON.stringify({ assetId: asset?.Id || null }) });
        toast(asset ? `Linked to ${asset.Name}` : 'Asset link cleared');
      } catch (err) { toast(err.message); }
    },
  });

  container.querySelector('#viewWoLink')?.addEventListener('click', (e) => { e.preventDefault(); go('workOrderDetail', { id: request.WorkOrderId }); });

  container.querySelector('#statusForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/api/pg/requests/${id}/status`, { method: 'PATCH', body: JSON.stringify({
        status: fd.get('status'), reviewNote: fd.get('reviewNote'), notify: fd.get('notify') === 'on',
      }) });
      toast('Saved');
      renderRequestDetail({ id }, container);
    } catch (err) { toast(err.message); }
  });

  container.querySelector('#convertBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog('Create a Work Order from this request? This is separate from approving — it actually creates the job.', { danger: false, confirmLabel: 'Convert' })) return;
    try {
      const { workOrderId } = await api(`/api/pg/requests/${id}/convert`, { method: 'POST', body: JSON.stringify({}) });
      toast('Work Order created');
      go('workOrderDetail', { id: workOrderId }, { replace: true });
    } catch (err) { toast(err.message); }
  });

  container.querySelector('#sendMessageForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/api/pg/requests/${id}/messages`, { method: 'POST', body: JSON.stringify({ subject: fd.get('subject'), body: fd.get('body') }) });
      toast('Email sent');
      renderRequestDetail({ id }, container);
    } catch (err) { toast(err.message); }
  });
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
        <div class="field-row"><label>Responsible Party</label>
          <label class="skill-chip" style="cursor:pointer;display:inline-flex"><input type="checkbox" name="responsibleSelf" style="margin-right:6px" />Self</label>
          <p class="muted" style="margin-top:4px">Volunteers/Vendors are assigned after creation, from the work order's detail page.</p>
        </div>
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
        responsibleSelf: fd.has('responsibleSelf'),
      }) });
      toast('Work order created');
      go('workOrderDetail', { id: result.workOrderId }, { replace: true });
    } catch (err) { toast(err.message); }
  });
}

const FUNDING_SOURCE_LABELS = {
  operating_budget: 'Operating Budget', capital_campaign: 'Capital Campaign', cabin_holder: 'Cabin-Holder', other: 'Other',
};
const FUNDING_SOURCE_ENDPOINT = {
  capital_campaign: 'budget/capital-campaign-projects', cabin_holder: 'budget/cabin-holders', other: 'budget/other-categories',
};
// Search-as-you-type combobox for linking a Capital Campaign Project /
// Cabin-Holder / Other category — same interaction pattern as
// mountAssetCombobox (type to search; if it doesn't exist, an inline
// "+ Add new" form creates it on the fly with its full fields).
function mountFundingCombobox(container, { kind, entities, initialEntity = null, onSelect = () => {} }) {
  let selected = initialEntity;
  container.classList.add('ac-wrap');
  container.innerHTML = `
    <input type="text" class="ac-input" autocomplete="off" placeholder="Search or create a ${escapeHtml(FUNDING_SOURCE_LABELS[kind])}…"
      value="${initialEntity ? escapeHtml(initialEntity.Name) : ''}" />
    <div class="ac-results" hidden></div>`;
  const input = container.querySelector('.ac-input');
  const resultsEl = container.querySelector('.ac-results');

  function renderResults(query) {
    const q = query.toLowerCase();
    const matches = entities.filter((ent) => ent.Name.toLowerCase().includes(q));
    const rows = matches.map((ent) => `
      <div class="ac-item" data-id="${ent.Id}" data-name="${escapeHtml(ent.Name)}">
        ${escapeHtml(ent.Name)}${ent.Description ? ` <span class="muted">— ${escapeHtml(ent.Description)}</span>` : ''}
      </div>`).join('');
    const addRow = query ? `<div class="ac-item ac-add" data-add-name="${escapeHtml(query)}">➕ Create new ${escapeHtml(FUNDING_SOURCE_LABELS[kind])} "${escapeHtml(query)}"…</div>` : '';
    resultsEl.innerHTML = rows + addRow;
    resultsEl.hidden = false;
    resultsEl.querySelectorAll('.ac-item[data-id]').forEach((el) => el.addEventListener('click', () => {
      selected = entities.find((ent) => ent.Id === Number(el.dataset.id));
      input.value = el.dataset.name;
      resultsEl.hidden = true;
      onSelect(selected);
    }));
    resultsEl.querySelector('.ac-add')?.addEventListener('click', () => showQuickCreateForm(resultsEl.querySelector('.ac-add').dataset.addName));
  }

  function showQuickCreateForm(name) {
    resultsEl.innerHTML = `<div class="ac-item" style="cursor:default">
      <div class="field-row" style="margin-bottom:8px"><label>Name</label><input class="ac-new-name" value="${escapeHtml(name)}" /></div>
      <div class="field-row" style="margin-bottom:8px"><label>Description (optional)</label><textarea class="ac-new-desc"></textarea></div>
      <div class="btn-row" style="margin-top:0">
        <button type="button" class="btn btn-primary ac-create-confirm">Create</button>
        <button type="button" class="btn btn-secondary ac-create-cancel">Cancel</button>
      </div>
    </div>`;
    resultsEl.querySelector('.ac-create-cancel').addEventListener('click', () => { resultsEl.hidden = true; });
    resultsEl.querySelector('.ac-create-confirm').addEventListener('click', async () => {
      const finalName = resultsEl.querySelector('.ac-new-name').value.trim();
      if (!finalName) { toast('Name is required'); return; }
      const description = resultsEl.querySelector('.ac-new-desc').value.trim();
      try {
        const { item } = await api(`/api/pg/${FUNDING_SOURCE_ENDPOINT[kind]}`, { method: 'POST', body: JSON.stringify({ name: finalName, description, notes: description }) });
        entities.push(item);
        selected = item;
        input.value = item.Name;
        resultsEl.hidden = true;
        toast(`${FUNDING_SOURCE_LABELS[kind]} "${item.Name}" created`);
        onSelect(selected);
      } catch (err) { toast(err.message); }
    });
  }

  input.addEventListener('input', () => {
    selected = null;
    onSelect(null);
    const q = input.value.trim();
    if (!q) { resultsEl.hidden = true; return; }
    renderResults(q);
  });
  input.addEventListener('focus', () => { if (input.value.trim()) renderResults(input.value.trim()); });
  document.addEventListener('click', (e) => { if (!container.contains(e.target)) resultsEl.hidden = true; });

  return {
    getSelected: () => selected,
    setSelected: (ent) => { selected = ent; input.value = ent ? ent.Name : ''; resultsEl.hidden = true; },
  };
}

function fundingFieldsHtml(wo) {
  const hasTarget = wo.FundingSource && wo.FundingSource !== 'operating_budget';
  return `
    <div class="field-row"><label>Funding Source</label>
      <select name="fundingSource" id="fundingSource">
        ${Object.entries(FUNDING_SOURCE_LABELS).map(([k, v]) => `<option value="${k}" ${wo.FundingSource === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>
    <div class="field-row" id="fundingRefRow" ${hasTarget ? '' : 'hidden'}>
      <label id="fundingRefLabel">${FUNDING_SOURCE_LABELS[wo.FundingSource] || ''}</label>
      <div id="fundingRefPicker"></div>
    </div>`;
}
function wireFundingFields(root, fundingEntities, wo, getCurrentAsset) {
  const sourceSelect = root.querySelector('#fundingSource');
  const refRow = root.querySelector('#fundingRefRow');
  const refLabel = root.querySelector('#fundingRefLabel');
  const pickerEl = root.querySelector('#fundingRefPicker');
  let picker = null;

  function mountPicker(kind, initialEntity) {
    picker = mountFundingCombobox(pickerEl, { kind, entities: fundingEntities[kind] || [], initialEntity });
  }
  if (sourceSelect.value !== 'operating_budget') {
    const known = fundingEntities[sourceSelect.value]?.find((e) => e.Id === wo.FundingRefId);
    const initial = known || (wo.FundingRefId ? { Id: wo.FundingRefId, Name: wo.FundingRefLabel } : null);
    mountPicker(sourceSelect.value, initial);
  }

  sourceSelect.addEventListener('change', () => {
    const source = sourceSelect.value;
    if (source === 'operating_budget') { refRow.hidden = true; return; }
    refRow.hidden = false;
    refLabel.textContent = FUNDING_SOURCE_LABELS[source];
    mountPicker(source, null);
    // Cabin-holder auto-link: if the WO's asset already has a lodge-holder
    // name on file, find (or create) the matching cabin-holder and select
    // it automatically — the whole point being one less manual step.
    if (source === 'cabin_holder') autoLinkCabinHolder();
  });

  async function autoLinkCabinHolder() {
    const asset = getCurrentAsset() || wo.Asset;
    const lodgeHolder = asset?.LodgeHolder?.trim();
    if (!lodgeHolder) return;
    const list = fundingEntities.cabin_holder || [];
    let match = list.find((c) => c.Name.toLowerCase() === lodgeHolder.toLowerCase());
    if (!match) {
      try {
        const { item } = await api('/api/pg/budget/cabin-holders', { method: 'POST', body: JSON.stringify({ name: lodgeHolder }) });
        list.push(item);
        match = item;
        toast(`Linked cabin-holder "${lodgeHolder}" (created from this asset's records)`);
      } catch (err) { toast(err.message); return; }
    } else {
      toast(`Linked cabin-holder "${match.Name}" (from this asset's records)`);
    }
    picker?.setSelected(match);
  }

  return { getPicker: () => picker };
}

async function renderWorkOrderDetail({ id }, container = app) {
  if (container === app) setChrome({ title: 'Work Order', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const [detail, allVolunteers, allVendors, skillsRes, tplRes, campaignRes, cabinRes, otherRes] = await Promise.all([
    api(`/api/pg/work-orders/${id}`), api('/api/pg/volunteers'), api('/api/pg/vendors'), api('/api/pg/skills'),
    api('/api/pg/checklist-templates'),
    api('/api/pg/budget/capital-campaign-projects'), api('/api/pg/budget/cabin-holders'), api('/api/pg/budget/other-categories'),
  ]);
  const allSkills = skillsRes.skills.map((s) => s.Name);
  const checklistTemplates = tplRes.templates;
  const fundingEntities = { capital_campaign: campaignRes.items, cabin_holder: cabinRes.items, other: otherRes.items };
  const { workOrder: wo, assetUpdates, volunteers, vendors, tasks, checklist, logEntries, crewSessions, photos } = detail;
  const propertyFieldTitles = state.options.propertyFields.map((f) => f.title);

  // Small (56px) thumbnails, unbounded count — the schema doesn't cap how
  // many "solution" photos a task or WO can have; only the report/export
  // picker later limits how many actually go on the page.
  const taskPhotoThumbs = (taskId, taskPhotos = []) => `
    ${taskPhotos.map((p) => `
      <div class="photo-thumb" style="width:56px;height:56px">
        <img src="${p.Url}" alt="" />
        <button type="button" class="photo-remove delete-task-photo" data-id="${p.Id}">&times;</button>
      </div>`).join('')}
    <button type="button" class="btn btn-secondary add-task-photo-btn" data-task-id="${taskId}" style="padding:4px 8px;font-size:0.8rem">📷 Add Photo</button>
    <input type="file" class="task-photo-input" data-task-id="${taskId}" accept="image/*" capture="environment" multiple hidden />`;

  const taskRows = tasks.map((t) => `
    <div class="list-item" style="cursor:default;flex-wrap:wrap;align-items:flex-start">
      <label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer">
        <input type="checkbox" class="task-toggle" data-id="${t.Id}" ${t.Done ? 'checked' : ''} />
        <span style="${t.Done ? 'text-decoration:line-through;color:var(--muted)' : ''}">${escapeHtml(t.Description)}</span>
      </label>
      <button class="btn btn-secondary delete-task" data-id="${t.Id}" data-label="${escapeHtml(t.Description)}">Delete</button>
      <div style="flex-basis:100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px">
        ${taskPhotoThumbs(t.Id, t.Photos)}
      </div>
    </div>`).join('') || '<p class="muted">No tasks yet — add the scope of work below.</p>';

  const woPhotoRows = (photos || []).map((p) => `
    <div class="photo-thumb">
      <img src="${p.Url}" alt="${escapeHtml(p.Caption || '')}" />
      <button type="button" class="photo-remove delete-wo-photo" data-id="${p.Id}">&times;</button>
    </div>`).join('');

  const WO_STATUS_OPTIONS = ['Open', 'In Progress', 'On Hold', 'Urgent', 'Done'];
  const logRows = logEntries.map((e) => `
    <div class="list-item" style="cursor:default;flex-wrap:wrap;align-items:flex-start">
      <div style="flex:1;min-width:200px">
        <div>${escapeHtml(e.Note)}</div>
        <div class="muted">${new Date(e.CreatedAt).toLocaleString()}${e.Username ? ` · ${escapeHtml(e.Username)}` : ''}
          ${e.Hours != null ? ` · ${e.Hours}h` : ''}${e.StatusChange ? ` · status → ${escapeHtml(e.StatusChange)}` : ''}</div>
      </div>
      <button class="btn btn-secondary delete-log-entry" data-id="${e.Id}" data-label="${escapeHtml(e.Note)}">Delete</button>
    </div>`).join('') || '<p class="muted">No log entries yet.</p>';

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

  const crewSessionRows = crewSessions.map((s) => `
    <div class="list-item" style="cursor:default;flex-wrap:wrap;align-items:flex-start">
      <div style="flex:1;min-width:200px">
        <div>${new Date(s.Date).toLocaleDateString()}${s.Hours != null ? ` · ${s.Hours}h` : ''}</div>
        <div class="muted">${[...s.Volunteers, ...s.Vendors].map(escapeHtml).join(', ') || 'No attendees recorded'}</div>
        ${s.Note ? `<div class="muted">${escapeHtml(s.Note)}</div>` : ''}
      </div>
      <button class="btn btn-secondary delete-crew-session" data-id="${s.Id}" style="align-self:center">Delete</button>
    </div>`).join('') || '<p class="muted">No sessions logged yet.</p>';

  const assignedVolIds = new Set(volunteers.map((v) => v.Id));
  const assignedVenIds = new Set(vendors.map((v) => v.Id));
  const availableVols = allVolunteers.volunteers.filter((v) => !assignedVolIds.has(v.Id));
  const availableVens = allVendors.vendors.filter((v) => !assignedVenIds.has(v.Id));

  container.innerHTML = `
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
        <div class="field-row"><label>Responsible Party</label>
          <div class="skill-chips">
            <label class="skill-chip ${wo.ResponsibleSelf ? 'selected' : ''}" style="cursor:pointer"><input type="checkbox" name="responsibleSelf" style="margin-right:6px" ${wo.ResponsibleSelf ? 'checked' : ''} />Self</label>
            <span class="pill ${volunteers.length ? 'good' : ''}" title="Set in Assigned Crew below">Volunteer${volunteers.length ? '' : ' (none assigned)'}</span>
            <span class="pill ${vendors.length ? 'good' : ''}" title="Set in Assigned Crew below">Vendor${vendors.length ? '' : ' (none assigned)'}</span>
          </div>
        </div>
        <div class="field-row"><label>Scheduled Date</label><input name="scheduledDate" type="date" value="${(wo['Scheduled Date'] || '').slice(0, 10)}" /></div>
        <div class="field-row"><label>Board Focus</label>
          <label class="skill-chip ${wo.BoardFocus ? 'selected' : ''}" style="cursor:pointer;display:inline-flex"><input type="checkbox" name="boardFocus" style="margin-right:6px" ${wo.BoardFocus ? 'checked' : ''} />Flag for board report</label>
        </div>
        <div class="field-row"><label>Description</label><textarea name="description">${escapeHtml(wo.Description || '')}</textarea></div>
        <div class="field-row"><label>Estimated Hours</label><input name="estimatedHours" type="number" value="${wo['Estimated Hours'] ?? ''}" /></div>
        <div class="field-row"><label>Actual Hours</label><input name="actualHours" type="number" value="${wo['Actual Hours'] ?? ''}" /></div>
        <div class="field-row"><label>Estimated Cost</label><input name="estimatedCost" type="number" step="0.01" value="${wo['Estimated Cost'] ?? ''}" /></div>
        <div class="field-row"><label>Actual Cost</label><input name="actualCost" type="number" step="0.01" value="${wo['Actual Cost'] ?? ''}" /></div>
        ${fundingFieldsHtml(wo)}
        <button class="btn btn-secondary" type="submit">Save Changes</button>
      </form>
      <div class="btn-row">
        <button class="btn btn-primary" id="completeWoBtn" ${wo.Status === 'Done' ? 'disabled' : ''}>${wo.Status === 'Done' ? 'Completed' : 'Complete Work Order'}</button>
        <a class="btn btn-secondary" href="/api/pg/work-orders/${id}/scope-pdf" target="_blank" rel="noopener" title="A printable job description to hand a vendor or volunteer — no cost figures included">🖨️ Scope of Work (PDF)</a>
        <button class="btn btn-secondary" id="duplicateWoBtn">Duplicate</button>
      </div>
    </div>

    <div class="card">
      <h3>Photos</h3>
      <p class="muted">Finished-work photos for this job — "before/after/finished" shots, distinct from audit/condition photos. These are what a Reports export can attach.</p>
      ${photos?.length ? `<div class="photo-grid">${woPhotoRows}</div>` : '<p class="muted">No photos yet.</p>'}
      <input type="file" id="woPhotoInput" accept="image/*" capture="environment" multiple hidden />
      <button type="button" class="btn btn-secondary" id="addWoPhotoBtn">+ Add Photo</button>
    </div>

    <div class="card">
      <h3>Tasks</h3>
      <p class="muted">The scope of work — plain checklist items, not tied to any audit field. Each task can carry its own completion photos too.</p>
      ${taskRows}
      <div class="inline-add-row"><input class="new-task-input" placeholder="Add a task…" /><button type="button" class="btn btn-secondary" id="addTaskBtn">+</button></div>
    </div>

    <div class="card">
      <h3>Work Log</h3>
      <p class="muted">What's been done, hours worked, and status updates over the life of this work order.</p>
      ${logRows}
      <form id="addLogEntryForm" style="margin-top:10px">
        <div class="field-row"><label>Note</label><textarea name="note" required placeholder="What did you do?"></textarea></div>
        <div class="field-row"><label>Hours (optional)</label><input name="hours" type="number" step="0.25" min="0" /></div>
        <div class="field-row"><label>Update Status To (optional)</label>
          <select name="statusChange"><option value="" selected>— no change —</option>${WO_STATUS_OPTIONS.map((s) => `<option>${s}</option>`).join('')}</select>
        </div>
        <button class="btn btn-primary" type="submit">Add Log Entry</button>
      </form>
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
    </div>

    <div class="card">
      <h3>Crew Sessions</h3>
      <p class="muted">Attendance-based hours — who was here, and for how long, each time work happened on this job. Feeds the Hours report.</p>
      ${crewSessionRows}
      ${(volunteers.length || vendors.length) ? `
      <form id="addCrewSessionForm" style="margin-top:10px">
        <div class="field-row"><label>Date</label><input name="sessionDate" type="date" value="${isoDate(new Date())}" required /></div>
        <div class="field-row"><label>Hours (optional)</label><input name="hours" type="number" step="0.25" min="0" /></div>
        <div class="field-row"><label>Who was here?</label>
          <div class="skill-chips" id="sessionAttendeeChips">
            ${volunteers.map((v) => `<span class="skill-chip crew-attendee-chip" data-kind="vol" data-id="${v.Id}">${escapeHtml(v.Name)}</span>`).join('')}
            ${vendors.map((v) => `<span class="skill-chip crew-attendee-chip" data-kind="ven" data-id="${v.Id}">${escapeHtml(v.Name)}</span>`).join('')}
          </div>
        </div>
        <div class="field-row"><label>Note (optional)</label><input name="note" placeholder="Anything worth noting" /></div>
        <button class="btn btn-primary" type="submit">Log Session</button>
      </form>` : '<p class="muted">Assign crew above before logging a session.</p>'}
    </div>`;

  const assetPicker = mountAssetCombobox(container.querySelector('#woAssetPicker'), { initialAsset: wo.Asset });
  const fundingFieldsCtrl = wireFundingFields(container.querySelector('#woFieldsForm'), fundingEntities, wo, () => assetPicker.getSelected());

  const selfCheckbox = container.querySelector('input[name="responsibleSelf"]');
  selfCheckbox?.addEventListener('change', () => {
    selfCheckbox.closest('.skill-chip').classList.toggle('selected', selfCheckbox.checked);
  });
  const boardFocusCheckbox = container.querySelector('input[name="boardFocus"]');
  boardFocusCheckbox?.addEventListener('change', () => {
    boardFocusCheckbox.closest('.skill-chip').classList.toggle('selected', boardFocusCheckbox.checked);
  });

  container.querySelector('#woFieldsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!await confirmDialog('Save changes to this work order?')) return;
    const fd = new FormData(e.target);
    const newAsset = assetPicker.getSelected();
    const fundingSource = fd.get('fundingSource');
    const fundingRefEntity = fundingSource === 'operating_budget' ? null : fundingFieldsCtrl.getPicker()?.getSelected();
    const fundingRefId = fundingSource === 'operating_budget' ? '' : fundingRefEntity?.Id;
    if (fundingSource !== 'operating_budget' && !fundingRefId) {
      toast(`Choose a ${FUNDING_SOURCE_LABELS[fundingSource]} to link this to`); return;
    }
    try {
      await api(`/api/pg/work-orders/${id}`, { method: 'PATCH', body: JSON.stringify({
        assetId: newAsset ? newAsset.Id : (wo.Asset ? wo.Asset.Id : ''),
        status: fd.get('status'), priority: fd.get('priority'), description: fd.get('description'),
        scheduledDate: fd.get('scheduledDate') || '',
        estimatedHours: fd.get('estimatedHours'), actualHours: fd.get('actualHours'),
        estimatedCost: fd.get('estimatedCost'), actualCost: fd.get('actualCost'),
        fundingSource, fundingRefId,
        responsibleSelf: fd.has('responsibleSelf'),
        boardFocus: fd.has('boardFocus'),
      }) });
      toast('Work order updated');
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message); }
  });

  container.querySelector('#duplicateWoBtn').addEventListener('click', async () => {
    try {
      const result = await api(`/api/pg/work-orders/${id}/duplicate`, { method: 'POST' });
      toast('Work order duplicated');
      go('workOrderDetail', { id: result.workOrderId });
    } catch (err) { toast(err.message); }
  });

  container.querySelector('#viewOnCalendarLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    const d = new Date(wo['Scheduled Date']);
    go('calendar', { month: d.getMonth(), year: d.getFullYear(), fromWorkOrderId: id, fromWorkOrderTitle: wo.Title });
  });

  container.querySelector('#addTaskBtn').addEventListener('click', async () => {
    const input = container.querySelector('.new-task-input');
    const description = input.value.trim();
    if (!description) return;
    try {
      await api(`/api/pg/work-orders/${id}/tasks`, { method: 'POST', body: JSON.stringify({ description }) });
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message); }
  });
  container.querySelectorAll('.task-toggle').forEach((cb) => cb.addEventListener('change', async () => {
    try { await api(`/api/pg/work-order-tasks/${cb.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ done: cb.checked }) }); renderWorkOrderDetail({ id }, container); }
    catch (err) { toast(err.message); }
  }));
  container.querySelectorAll('.delete-task').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete task "${btn.dataset.label}"?`)) return;
    try { await api(`/api/pg/work-order-tasks/${btn.dataset.id}`, { method: 'DELETE' }); renderWorkOrderDetail({ id }, container); }
    catch (err) { toast(err.message); }
  }));

  container.querySelector('#addWoPhotoBtn')?.addEventListener('click', () => container.querySelector('#woPhotoInput').click());
  container.querySelector('#woPhotoInput')?.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    try {
      for (const file of files) {
        const url = await uploadPhotoFile(file, 'work-orders', id);
        await api(`/api/pg/work-orders/${id}/photos`, { method: 'POST', body: JSON.stringify({ photoUrl: url }) });
      }
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message); }
  });
  container.querySelectorAll('.delete-wo-photo').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog('Delete this photo?')) return;
    try { await api(`/api/pg/work-order-photos/${btn.dataset.id}`, { method: 'DELETE' }); renderWorkOrderDetail({ id }, container); }
    catch (err) { toast(err.message); }
  }));

  container.querySelectorAll('.add-task-photo-btn').forEach((btn) => btn.addEventListener('click', () => {
    container.querySelector(`.task-photo-input[data-task-id="${btn.dataset.taskId}"]`).click();
  }));
  container.querySelectorAll('.task-photo-input').forEach((input) => input.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const taskId = input.dataset.taskId;
    try {
      for (const file of files) {
        const url = await uploadPhotoFile(file, 'work-order-tasks', taskId);
        await api(`/api/pg/work-order-tasks/${taskId}/photos`, { method: 'POST', body: JSON.stringify({ photoUrl: url }) });
      }
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelectorAll('.delete-task-photo').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog('Delete this photo?')) return;
    try { await api(`/api/pg/work-order-task-photos/${btn.dataset.id}`, { method: 'DELETE' }); renderWorkOrderDetail({ id }, container); }
    catch (err) { toast(err.message); }
  }));

  container.querySelector('#addLogEntryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const note = fd.get('note').trim();
    if (!note) return;
    try {
      await api(`/api/pg/work-orders/${id}/log`, { method: 'POST', body: JSON.stringify({
        note, hours: fd.get('hours') || undefined, statusChange: fd.get('statusChange') || undefined,
      }) });
      toast('Log entry added');
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message); }
  });
  container.querySelectorAll('.delete-log-entry').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete this log entry? "${btn.dataset.label}"`)) return;
    try { await api(`/api/pg/work-order-log/${btn.dataset.id}`, { method: 'DELETE' }); renderWorkOrderDetail({ id }, container); }
    catch (err) { toast(err.message); }
  }));

  container.querySelectorAll('.crew-attendee-chip').forEach((chip) => chip.addEventListener('click', () => chip.classList.toggle('selected')));
  container.querySelector('#addCrewSessionForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const chips = [...container.querySelectorAll('.crew-attendee-chip.selected')];
    try {
      await api('/api/pg/crew-sessions', { method: 'POST', body: JSON.stringify({
        workOrderId: Number(id), sessionDate: fd.get('sessionDate'), hours: fd.get('hours') || undefined, note: fd.get('note') || undefined,
        volunteerIds: chips.filter((c) => c.dataset.kind === 'vol').map((c) => Number(c.dataset.id)),
        vendorIds: chips.filter((c) => c.dataset.kind === 'ven').map((c) => Number(c.dataset.id)),
      }) });
      toast('Session logged');
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message); }
  });
  container.querySelectorAll('.delete-crew-session').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog('Delete this session?')) return;
    try { await api(`/api/pg/crew-sessions/${btn.dataset.id}`, { method: 'DELETE' }); renderWorkOrderDetail({ id }, container); }
    catch (err) { toast(err.message); }
  }));

  container.querySelector('#attachChecklistBtn')?.addEventListener('click', async () => {
    const templateId = container.querySelector('#checklistTplPicker').value;
    if (!templateId) { toast('Choose a checklist first'); return; }
    try {
      await api(`/api/pg/work-orders/${id}/checklist`, { method: 'POST', body: JSON.stringify({ templateId: Number(templateId) }) });
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message); }
  });
  container.querySelector('#removeChecklistBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog('Remove this checklist from the work order? Progress will be lost.')) return;
    try { await api(`/api/pg/checklist-instances/${checklist.Id}`, { method: 'DELETE' }); renderWorkOrderDetail({ id }, container); }
    catch (err) { toast(err.message); }
  });
  container.querySelectorAll('.checklist-step-toggle').forEach((cb) => cb.addEventListener('change', async () => {
    try { await api(`/api/pg/checklist-steps/${cb.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ done: cb.checked }) }); renderWorkOrderDetail({ id }, container); }
    catch (err) { toast(err.message); }
  }));

  container.querySelector('#completeWoBtn').addEventListener('click', async () => {
    if (!await confirmDialog(`Complete this Work Order? Any pending "asset field update" entries will be written to "${wo.Asset?.Name || 'the asset'}" immediately — this directly changes real asset data.`)) return;
    try {
      await api(`/api/pg/work-orders/${id}/complete`, { method: 'POST' });
      toast('Work order completed — asset updated');
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message); }
  });

  container.querySelector('#addJobLineForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/api/pg/work-orders/${id}/asset-updates`, { method: 'POST', body: JSON.stringify({ targetField: fd.get('targetField'), newValue: fd.get('newValue') }) });
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message); }
  });

  container.querySelectorAll('.delete-au').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete the "${btn.dataset.label}" field update?`)) return;
    try { await api(`/api/pg/work-orders/${id}/asset-updates/${btn.dataset.id}`, { method: 'DELETE' }); renderWorkOrderDetail({ id }, container); }
    catch (err) { toast(err.message); }
  }));

  container.querySelector('#assignVolForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const volunteerId = new FormData(e.target).get('volunteerId');
    if (!volunteerId) return;
    await api(`/api/pg/work-orders/${id}/volunteers`, { method: 'POST', body: JSON.stringify({ volunteerId: Number(volunteerId) }) });
    renderWorkOrderDetail({ id }, container);
  });
  container.querySelector('#assignVenForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const vendorId = new FormData(e.target).get('vendorId');
    if (!vendorId) return;
    await api(`/api/pg/work-orders/${id}/vendors`, { method: 'POST', body: JSON.stringify({ vendorId: Number(vendorId) }) });
    renderWorkOrderDetail({ id }, container);
  });

  container.querySelector('#newVolToggle').addEventListener('click', () => openCrewAddBox('newVolBox', 'newVenBox'));
  container.querySelector('#newVenToggle').addEventListener('click', () => openCrewAddBox('newVenBox', 'newVolBox'));
  wireSkillChipToggle(container.querySelector('#newVolSkills'));
  wireSkillChipToggle(container.querySelector('#newVenSkills'));
  container.querySelectorAll('.add-skill-btn').forEach(wireAddSkillButton);
  wirePhoneFormatting(container);
  container.querySelector('#newVolSave').addEventListener('click', async () => {
    const name = container.querySelector('#newVolName').value.trim();
    if (!name) { toast('Name is required'); return; }
    try {
      const { volunteer } = await api('/api/pg/volunteers', { method: 'POST', body: JSON.stringify({
        name, phone: container.querySelector('#newVolPhone').value.trim(),
        skill: selectedSkillsOf(container.querySelector('#newVolSkills')),
      }) });
      await api(`/api/pg/work-orders/${id}/volunteers`, { method: 'POST', body: JSON.stringify({ volunteerId: volunteer.Id }) });
      toast('Volunteer added and assigned');
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message); }
  });
  container.querySelector('#newVenSave').addEventListener('click', async () => {
    const name = container.querySelector('#newVenName').value.trim();
    if (!name) { toast('Name is required'); return; }
    try {
      const { vendor } = await api('/api/pg/vendors', { method: 'POST', body: JSON.stringify({
        name, phone: container.querySelector('#newVenPhone').value.trim(),
        specialty: selectedSkillsOf(container.querySelector('#newVenSkills')),
      }) });
      await api(`/api/pg/work-orders/${id}/vendors`, { method: 'POST', body: JSON.stringify({ vendorId: vendor.Id }) });
      toast('Vendor added and assigned');
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message); }
  });
  container.querySelectorAll('.unassign-vol').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Remove ${btn.dataset.name} from this work order?`)) return;
    await api(`/api/pg/work-orders/${id}/volunteers/${btn.dataset.id}`, { method: 'DELETE' });
    renderWorkOrderDetail({ id }, container);
  }));
  container.querySelectorAll('.unassign-ven').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Remove ${btn.dataset.name} from this work order?`)) return;
    await api(`/api/pg/work-orders/${id}/vendors/${btn.dataset.id}`, { method: 'DELETE' });
    renderWorkOrderDetail({ id }, container);
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

// Sessions -> hours/jobs leaderboard, so "who's our most faithful volunteer"
// is a sort, not a spreadsheet. Period math always builds YYYY-MM-DD bounds
// with isoDate() (see its comment) — never .toISOString() — to avoid the
// same timezone bug fixed once already for the This Week dashboard widget.
const CREW_HOURS_PERIODS = [
  { key: 'month', label: 'This Month' },
  { key: 'year', label: 'This Year' },
  { key: 'all', label: 'All Time' },
  { key: 'custom', label: 'Custom Range' },
];
function crewHoursPeriodBounds(period, customFrom, customTo) {
  const now = new Date();
  if (period === 'month') return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDate(now) };
  if (period === 'year') return { from: isoDate(new Date(now.getFullYear(), 0, 1)), to: isoDate(now) };
  if (period === 'custom') return { from: customFrom || null, to: customTo || null };
  return { from: null, to: null };
}

function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function crewHoursCsv(rows) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = ['Name', 'Sessions', 'Jobs', 'Hours'].join(',');
  const lines = rows.map((r) => [r.Name, r.Sessions, r.Jobs, r.Hours].map(esc).join(','));
  return [header, ...lines].join('\r\n');
}

async function renderCrewHours() {
  setChrome({ title: 'Hours', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const [volsRes, vensRes] = await Promise.all([api('/api/pg/volunteers'), api('/api/pg/vendors')]);
  const volunteers = volsRes.volunteers;
  const vendors = vensRes.vendors;
  let period = 'year';
  let customFrom = '';
  let customTo = '';
  let sortDir = 'desc'; // Hours, descending — surfaces the most faithful volunteers first
  let summary = null;

  function personTableHtml(rows, emptyMsg) {
    const sorted = [...rows].sort((a, b) => (sortDir === 'desc' ? b.Hours - a.Hours : a.Hours - b.Hours));
    const trs = sorted.map((r) => `
      <tr>
        <td data-label="Name">${escapeHtml(r.Name)}${!r.Active ? ' <span class="pill">inactive</span>' : ''}</td>
        <td data-label="Sessions">${r.Sessions}</td>
        <td data-label="Jobs">${r.Jobs}</td>
        <td data-label="Hours">${r.Hours}</td>
      </tr>`).join('');
    return `<div style="overflow-x:auto"><table class="report-table">
      <thead><tr><th>Name</th><th>Sessions</th><th>Jobs</th><th class="sort-hours" style="cursor:pointer">Hours ${sortDir === 'desc' ? '▾' : '▴'}</th></tr></thead>
      <tbody>${trs || `<tr><td colspan="4" class="muted">${emptyMsg}</td></tr>`}</tbody>
    </table></div>`;
  }

  async function loadSummary() {
    const { from, to } = crewHoursPeriodBounds(period, customFrom, customTo);
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    summary = await api(`/api/pg/crew-hours/summary?${qs.toString()}`);
  }

  function draw() {
    setApp(`
      <div class="card">
        <h3>Log Activity</h3>
        <p class="muted">For work that never becomes a Work Order — mowing, grounds cleanup, a general workday. Time tied to a specific Work Order is logged from that Work Order's page instead.</p>
        <form id="logActivityForm">
          <div class="field-row"><label>Date</label><input name="sessionDate" type="date" value="${isoDate(new Date())}" required /></div>
          <div class="field-row"><label>Activity</label><input name="activity" required placeholder="e.g. Mowing, Grounds Cleanup" /></div>
          <div class="field-row"><label>Hours (optional)</label><input name="hours" type="number" step="0.25" min="0" /></div>
          <div class="field-row"><label>Who was here?</label>
            <div class="skill-chips" id="activityAttendeeChips">
              ${volunteers.map((v) => `<span class="skill-chip crew-attendee-chip" data-kind="vol" data-id="${v.Id}">${escapeHtml(v.Name)}</span>`).join('')}
              ${vendors.map((v) => `<span class="skill-chip crew-attendee-chip" data-kind="ven" data-id="${v.Id}">${escapeHtml(v.Name)}</span>`).join('')}
            </div>
          </div>
          <div class="field-row"><label>Note (optional)</label><input name="note" /></div>
          <button class="btn btn-primary" type="submit">Log Activity</button>
        </form>
      </div>

      <div class="card">
        <h3>Hours Summary</h3>
        <div class="btn-row" style="margin-top:0">
          ${CREW_HOURS_PERIODS.map((p) => `<button type="button" class="btn ${period === p.key ? 'btn-primary' : 'btn-secondary'} period-btn" data-period="${p.key}">${p.label}</button>`).join('')}
        </div>
        ${period === 'custom' ? `
        <div class="field-row"><label>From</label><input type="date" id="customFrom" value="${customFrom}" /></div>
        <div class="field-row"><label>To</label><input type="date" id="customTo" value="${customTo}" /></div>
        ` : ''}
        <div class="btn-row" style="margin:10px 0 0"><button type="button" class="btn btn-secondary" id="exportVolCsv">Export Volunteers CSV</button><button type="button" class="btn btn-secondary" id="exportVenCsv">Export Vendors CSV</button></div>

        <h4 style="margin:16px 0 6px">Volunteers</h4>
        ${personTableHtml(summary.volunteers, 'No volunteer activity in this period.')}

        <h4 style="margin:16px 0 6px">Vendors</h4>
        ${personTableHtml(summary.vendors, 'No vendor activity in this period.')}
      </div>
    `);
    wire();
  }

  function wire() {
    app.querySelectorAll('.period-btn').forEach((btn) => btn.addEventListener('click', async () => {
      period = btn.dataset.period;
      if (period !== 'custom') { app.innerHTML = LOADING_HTML; await loadSummary(); }
      draw();
    }));
    app.querySelector('#customFrom')?.addEventListener('change', async (e) => {
      customFrom = e.target.value; app.innerHTML = LOADING_HTML; await loadSummary(); draw();
    });
    app.querySelector('#customTo')?.addEventListener('change', async (e) => {
      customTo = e.target.value; app.innerHTML = LOADING_HTML; await loadSummary(); draw();
    });
    app.querySelectorAll('.sort-hours').forEach((th) => th.addEventListener('click', () => {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      draw();
    }));
    app.querySelectorAll('.crew-attendee-chip').forEach((chip) => chip.addEventListener('click', () => chip.classList.toggle('selected')));
    app.querySelector('#exportVolCsv')?.addEventListener('click', () => downloadCsv(crewHoursCsv(summary.volunteers), 'volunteer-hours.csv'));
    app.querySelector('#exportVenCsv')?.addEventListener('click', () => downloadCsv(crewHoursCsv(summary.vendors), 'vendor-hours.csv'));
    app.querySelector('#logActivityForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const activity = fd.get('activity').trim();
      if (!activity) return;
      const chips = [...app.querySelectorAll('.crew-attendee-chip.selected')];
      try {
        await api('/api/pg/crew-sessions', { method: 'POST', body: JSON.stringify({
          activity, sessionDate: fd.get('sessionDate'), hours: fd.get('hours') || undefined, note: fd.get('note') || undefined,
          volunteerIds: chips.filter((c) => c.dataset.kind === 'vol').map((c) => Number(c.dataset.id)),
          vendorIds: chips.filter((c) => c.dataset.kind === 'ven').map((c) => Number(c.dataset.id)),
        }) });
        toast('Activity logged');
        app.innerHTML = LOADING_HTML;
        await loadSummary();
        draw();
      } catch (err) { toast(err.message); }
    });
  }

  await loadSummary();
  draw();
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

renderThemePicker();

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
