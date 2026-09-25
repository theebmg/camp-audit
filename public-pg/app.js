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

// A Google Calendar revisit-prompt event links back here (src/gcalSync.js's
// buildRevisitEventBody) via ?openWorkOrder=<id>/?openAsset=<id> — the one
// other query-string entry point besides the OAuth redirect below. Captured
// once at boot (before the session check strips it) so it survives a
// still-logged-out visit and gets applied right after login instead of
// silently landing on the dashboard.
let pendingDeepLink = null;
function captureDeepLinkParams() {
  const params = new URLSearchParams(window.location.search);
  const woId = params.get('openWorkOrder');
  const assetId = params.get('openAsset');
  if (!woId && !assetId) return null;
  window.history.replaceState({}, '', window.location.pathname);
  return woId ? { view: 'workOrderDetail', params: { id: woId } } : { view: 'assetDetail', params: { id: assetId } };
}

function toast(msg, ms = 2500) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, ms);
}

// Postgres date/timestamp columns arrive as raw ISO strings (e.g.
// "2026-08-28T00:00:00.000Z") — this renders them as "Aug 28, 2026" instead.
function formatDateNice(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('default', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Postgres `time` columns arrive as "HH:MM:SS" — renders as "9:00 AM"
// (Build Brief v4 Part 1: job line / calendar event start & end times).
function formatTimeShort(value) {
  if (!value) return '';
  const [h, m] = value.split(':');
  const d = new Date(2000, 0, 1, Number(h), Number(m));
  return d.toLocaleTimeString('default', { hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Password visibility toggle ----------
// Every <input type="password"> in the app gets its own eye button, applied
// automatically by the observer below — views build their forms via
// innerHTML, so wiring each form by hand would miss the next one someone
// adds. Always starts hidden (a freshly rendered input is type=password), and
// flips back to hidden when its form submits so the browser never sees a
// visible password on submit/save-password.
const PW_EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const PW_EYE_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-6.5 0-10-7-10-7a18.5 18.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
function enhancePasswordInput(input) {
  if (input.dataset.pwToggle) return;
  input.dataset.pwToggle = '1';
  const wrap = document.createElement('span');
  wrap.className = 'pw-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pw-toggle';
  if (input.id) btn.setAttribute('aria-controls', input.id);
  wrap.appendChild(btn);
  const setVisible = (visible) => {
    input.type = visible ? 'text' : 'password';
    btn.innerHTML = visible ? PW_EYE_OFF_SVG : PW_EYE_SVG;
    btn.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    btn.setAttribute('aria-pressed', String(visible));
  };
  setVisible(false);
  // Don't steal focus from the input on mouse/touch — keeps the phone keyboard
  // up and the caret where it was. Keyboard activation still works normally.
  btn.addEventListener('pointerdown', (e) => { if (document.activeElement === input) e.preventDefault(); });
  btn.addEventListener('click', () => {
    const hadFocus = document.activeElement === input;
    const { selectionStart, selectionEnd } = input;
    setVisible(input.type === 'password');
    if (hadFocus) {
      input.focus();
      try { input.setSelectionRange(selectionStart, selectionEnd); } catch { /* type swap unsupported */ }
    }
  });
  input.form?.addEventListener('submit', () => setVisible(false), true);
}
function enhancePasswordInputs(root) {
  if (root.nodeType !== 1) return;
  if (root.matches('input[type="password"]')) enhancePasswordInput(root);
  root.querySelectorAll('input[type="password"]:not([data-pw-toggle])').forEach(enhancePasswordInput);
}
new MutationObserver((mutations) => {
  for (const m of mutations) m.addedNodes.forEach(enhancePasswordInputs);
}).observe(document.body, { childList: true, subtree: true });
enhancePasswordInputs(document.body);

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

// In-page replacement for the browser's window.confirm — a floating modal
// instead of native browser chrome. Resolves true/false the same way, so
// every call site just becomes `await confirmDialog(...)`.
// Text-input sibling of confirmDialog, same shape and styling. Native prompt() is the
// only other way to ask for a string, and it looks nothing like the rest of this app —
// and is suppressed outright in some embedded browsers.
function promptDialog(message, { value = '', confirmLabel = 'Save', cancelLabel = 'Cancel', placeholder = '', multiline = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true">
        <p class="modal-message">${escapeHtml(message)}</p>
        ${multiline
          ? `<textarea class="modal-input" rows="3" placeholder="${escapeHtml(placeholder)}"></textarea>`
          : `<input type="text" class="modal-input" placeholder="${escapeHtml(placeholder)}" />`}
        <div class="btn-row" style="justify-content:flex-end;margin-top:18px">
          <button type="button" class="btn btn-secondary modal-cancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="btn btn-primary modal-ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.modal-input');
    input.value = value || '';
    input.style.width = '100%';
    setTimeout(() => input.focus(), 0);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('.modal-cancel').addEventListener('click', () => done(null));
    overlay.querySelector('.modal-ok').addEventListener('click', () => done(input.value));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value); });
  });
}

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

// Pick one row from a list, in the same floating modal confirmDialog uses.
// Resolves the chosen value, or null on cancel.
function pickFromListDialog(title, items, { cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true">
        <h3 style="margin-top:0">${escapeHtml(title)}</h3>
        <div style="max-height:50vh;overflow-y:auto">
          ${items.map((i) => `<div class="list-item pick-row" data-value="${escapeHtml(i.value)}">
            <span>${escapeHtml(i.label)}${i.sublabel ? `<div class="muted">${escapeHtml(i.sublabel)}</div>` : ''}</span>
          </div>`).join('')}
        </div>
        <div class="btn-row" style="justify-content:flex-end;margin-top:14px">
          <button type="button" class="btn btn-secondary modal-cancel">${escapeHtml(cancelLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    function close(result) { document.removeEventListener('keydown', onKeydown); overlay.remove(); resolve(result); }
    function onKeydown(e) { if (e.key === 'Escape') close(null); }
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    overlay.querySelector('.modal-cancel').addEventListener('click', () => close(null));
    overlay.querySelectorAll('.pick-row').forEach((el) => el.addEventListener('click', () => close(el.dataset.value)));
    document.addEventListener('keydown', onKeydown);
  });
}

// Sets #app's content and replays the fade-in — every view render should go
// through this instead of `app.innerHTML =` directly, so view swaps feel like
// transitions rather than instant flashes.
function setApp(html, container = app) {
  container.innerHTML = html;
  // Card tables need a label per cell; taken from each table's own thead so no screen
  // has to remember to ask (mobile audit, Q7).
  try { applyCardTableLabels(container); } catch { /* labels are cosmetic */ }
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
// Below this the job line grid isn't a sensible editing surface — the phone
// stays on the card view for reading, status changes, notes/photos and the
// reorder sheet (§7). Not a media-query breakpoint; it only gates the entry
// point into the grid.
const GRID_MIN_WIDTH = 900;
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
      ${Object.entries(window.ACCENT_PRESETS).map(([key, preset]) => `<button type="button" class="accent-swatch ${accentKey === key ? 'active' : ''}" data-accent="${key}" title="${key}"><span class="accent-dot" style="background:${preset.light[0]}"></span></button>`).join('')}
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
// Asset picker (§9). Built on the shared combobox, so it gets substring
// matching and full keyboard operation for free; what's specific to assets is
// the quick-create flow below, which lets a WO for a brand-new spot be raised
// without leaving the form.
//
// The roster (~340 rows) is fetched once per page and filtered in the
// browser. The old implementation fired a debounced /assets-search request on
// every keystroke, which also meant a prefix-ish server LIKE rather than the
// match-anywhere behaviour the brief asks for.
let allAssetsPromise = null;
function loadAllAssets() {
  if (!allAssetsPromise) allAssetsPromise = api('/api/pg/assets-all').then((r) => r.assets).catch(() => []);
  return allAssetsPromise;
}
const assetOptionOf = (a) => ({ value: a.Id, label: a.Name, sublabel: a.locationName || null });

function mountAssetCombobox(container, { initialAsset = null, onSelect = () => {} } = {}) {
  let selected = initialAsset;
  let assets = initialAsset ? [initialAsset] : [];

  const wrap = document.createElement('div');
  const panel = document.createElement('div');
  panel.className = 'ac-quickcreate';
  panel.hidden = true;
  container.innerHTML = '';
  container.append(wrap, panel);

  const cbx = mountCombobox(wrap, {
    options: assets.map(assetOptionOf),
    value: initialAsset ? initialAsset.Id : null,
    placeholder: 'Type to search assets…',
    emptyText: 'No asset matches',
    extraRowHtml: (query) => (query ? `<div class="ac-item ac-add" data-add-name="${escapeHtml(query)}">➕ Add new asset "${escapeHtml(query)}"…</div>` : ''),
    onExtraRow: (resultsEl, query) => {
      resultsEl.querySelector('.ac-add')?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        showQuickCreate(query);
        cbx.input.blur(); // closes the dropdown; the typed name is already in the panel
      });
    },
    onSelect: (opt) => {
      selected = opt ? assets.find((a) => String(a.Id) === String(opt.value)) || null : null;
      onSelect(selected);
    },
  });

  loadAllAssets().then((list) => {
    assets = list;
    cbx.setOptions(list.map(assetOptionOf));
  });

  function adopt(asset) {
    if (!assets.some((a) => a.Id === asset.Id)) assets = [...assets, asset];
    cbx.setOptions(assets.map(assetOptionOf));
    selected = asset;
    cbx.setValue(asset.Id);
  }

  // A location matters for reporting, so the quick-add flow asks for it (and
  // asset type) inline rather than creating a bare, unlocated asset — the
  // rest of an asset's properties still go through Edit Asset afterward,
  // matching the "deliberate action" spirit for anything beyond the basics.
  // It lives in its own panel below the field, not inside the dropdown, so
  // clicking into its inputs can't dismiss it.
  function showQuickCreate(name) {
    panel.hidden = false;
    panel.innerHTML = `<div class="card" style="margin-top:8px">
      <div class="field-row" style="margin-bottom:8px"><label>New asset name</label><input class="ac-new-name" value="${escapeHtml(name)}" /></div>
      <div class="field-row" style="margin-bottom:8px"><label>Location</label><select class="ac-new-location"><option value="">— unset —</option><option value="__new__">➕ New location…</option></select></div>
      <div class="ac-new-loc-fields" hidden>
        <div class="field-row" style="margin-bottom:8px"><label>New location name</label><input class="ac-new-loc-name" placeholder="e.g. North Cabin Row" /></div>
        <div class="field-row" style="margin-bottom:8px"><label>Parent location</label><select class="ac-new-loc-parent"><option value="">— top-level —</option></select></div>
        <div class="field-row" style="margin-bottom:8px"><label>Location type</label><input class="ac-new-loc-type" /></div>
      </div>
      <div class="field-row" style="margin-bottom:8px"><label>Asset Type</label><input class="ac-new-type" placeholder="e.g. Full Cabin" /></div>
      <div class="btn-row" style="margin-top:0">
        <button type="button" class="btn btn-primary ac-create-confirm">Create Asset</button>
        <button type="button" class="btn btn-secondary ac-create-cancel">Cancel</button>
      </div>
    </div>`;
    const locSelect = panel.querySelector('.ac-new-location');
    const newLocFields = panel.querySelector('.ac-new-loc-fields');
    api('/api/pg/locations').then(({ locations }) => {
      const opts = locations.map((l) => `<option value="${l.Id}">${escapeHtml(l.Name)}</option>`).join('');
      locSelect.insertAdjacentHTML('beforeend', opts);
      panel.querySelector('.ac-new-loc-parent').insertAdjacentHTML('beforeend', opts);
    });
    // A location that doesn't exist yet can be created in the same step, so
    // a WO for a brand-new spot doesn't mean leaving the form for Locations.
    locSelect.addEventListener('change', () => {
      newLocFields.hidden = locSelect.value !== '__new__';
      if (!newLocFields.hidden) panel.querySelector('.ac-new-loc-name').focus();
    });
    panel.querySelector('.ac-create-cancel').addEventListener('click', () => { panel.hidden = true; panel.innerHTML = ''; });
    panel.querySelector('.ac-create-confirm').addEventListener('click', async () => {
      const finalName = panel.querySelector('.ac-new-name').value.trim();
      if (!finalName) { toast('Name is required'); return; }
      let locationId = locSelect.value || undefined;
      const newLocName = panel.querySelector('.ac-new-loc-name').value.trim();
      if (locationId === '__new__' && !newLocName) { toast('New location name is required'); return; }
      try {
        if (locationId === '__new__') {
          const { location } = await api('/api/pg/locations', { method: 'POST', body: JSON.stringify({
            name: newLocName,
            parentLocationId: panel.querySelector('.ac-new-loc-parent').value || undefined,
            locationType: panel.querySelector('.ac-new-loc-type').value.trim() || undefined,
          }) });
          locationId = location.Id;
          // Swap the placeholder for the real row so a failed asset create
          // retried from here doesn't make a duplicate location.
          locSelect.insertAdjacentHTML('beforeend', `<option value="${location.Id}">${escapeHtml(location.Name)}</option>`);
          locSelect.value = String(location.Id);
          newLocFields.hidden = true;
          toast(`Created location "${location.Name}"`);
        }
        const { asset } = await api('/api/pg/assets', { method: 'POST', body: JSON.stringify({
          name: finalName, locationId, assetType: panel.querySelector('.ac-new-type').value.trim() || undefined,
        }) });
        panel.hidden = true; panel.innerHTML = '';
        adopt(asset);
        toast(`Created asset "${asset.Name}"`);
        onSelect(selected);
      } catch (err) { toast(err.message); }
    });
  }

  return {
    getSelected: () => selected,
    // Programmatic pick (e.g. a cabin holder's cabin defaulting a visit's
    // asset) — same end state as clicking a result, onSelect included.
    setSelected: (asset) => {
      if (asset) adopt(asset); else { selected = null; cbx.setValue(null); }
      onSelect(selected);
    },
  };
}

// Cabin-holder search field. The only way a record gets a cabin_holder_id:
// typing narrows the roster, and nothing is linked until a row is chosen —
// clearing the text afterward drops the link again rather than guessing which
// holder the new text means. The roster is ~300 names, fetched once and
// filtered client-side (listCabinHolders also syncs from assets.lodge_holder
// on read, so it's always current).
let cabinHolderPromise = null;
function loadCabinHolders() {
  if (!cabinHolderPromise) cabinHolderPromise = api('/api/pg/budget/cabin-holders').then((r) => r.items).catch(() => []);
  return cabinHolderPromise;
}
function mountCabinHolderCombobox(container, { initialHolder = null, onSelect = () => {} } = {}) {
  let selected = initialHolder;
  let roster = initialHolder ? [initialHolder] : [];
  const holderOption = (h) => ({ value: h.Id, label: h.Name, sublabel: h.LinkedAssets?.length ? h.LinkedAssets.map((a) => a.Name).join(', ') : null });

  const cbx = mountCombobox(container, {
    options: roster.map(holderOption),
    value: initialHolder ? initialHolder.Id : null,
    placeholder: 'Type to search cabin holders…',
    emptyText: 'No cabin holder matches — leave this blank for a one-off visitor.',
    onSelect: (opt) => {
      selected = opt ? roster.find((h) => String(h.Id) === String(opt.value)) || null : null;
      onSelect(selected);
    },
  });
  loadCabinHolders().then((list) => { roster = list; cbx.setOptions(list.map(holderOption)); });

  return {
    getSelected: () => selected,
    clear: () => { selected = null; cbx.setValue(null); onSelect(null); },
  };
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401) {
    state.user = null; state.stack = [];
    render('login');
    throw new Error('Not authenticated');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    // A refusal the caller is meant to act on carries a code and the facts behind it —
    // e.g. open_job_lines, with the lines blocking a work order from going terminal.
    // Without these the caller would be reduced to matching on the message text.
    err.status = res.status;
    if (body.code) err.code = body.code;
    if (body.details) err.details = body.details;
    throw err;
  }
  // Any successful write is a save. Clearing here means a save handler that
  // navigates on success (the common shape in this app) doesn't get asked
  // "you have unsaved changes" about the very thing it just persisted —
  // without every one of those handlers having to remember to say so.
  if (opts.method && opts.method.toUpperCase() !== 'GET') formDirty = false;
  return body;
}

// ---------- Attachments (Build Brief v2 Phase 4) ----------
// One shared system for every photo/document attach point in the app — WO
// and job-line photos, asset reference photos, component-event photos,
// finding photos, maintenance-request photos, asset-note photos. Capture is
// zero-decision (snap and upload); role/classification/caption are set later
// "at a desk" via the thumbnail's tap-to-edit panel, never prompted for at
// capture time (see the brief's "Why" section).

// Uploads one file directly onto an existing entity — upload + link in one
// request. Use uploadAttachmentUnlinked instead when the entity doesn't
// exist yet (a form that creates its parent row on submit).
async function uploadAttachment(file, entityType, entityId, { roleId, classification, caption, category, ownerId } = {}) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('entityType', entityType);
  fd.append('entityId', String(entityId));
  fd.append('category', category || entityType);
  fd.append('ownerId', String(ownerId ?? entityId));
  if (roleId) fd.append('roleId', String(roleId));
  if (classification) fd.append('classification', classification);
  if (caption) fd.append('caption', caption);
  const res = await fetch('/api/pg/attachments', { method: 'POST', body: fd });
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error || 'Upload failed');
  return body.attachment;
}

// Uploads without linking — for the audit form and the public
// maintenance-request portal, where photos are captured before the row they
// belong to (a finding, a component event, the request itself) is created.
// Returns the attachment id to submit alongside the rest of the form; the
// server links it once the parent row exists.
async function uploadAttachmentUnlinked(file, category, ownerId) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('category', category);
  fd.append('ownerId', String(ownerId));
  const res = await fetch('/api/pg/attachments', { method: 'POST', body: fd });
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error || 'Upload failed');
  return body.attachment.Id;
}

// A stable-enough identity for "is this the same File I already uploaded" —
// File objects don't carry a real id, but name+size+lastModified collide
// only in practice-never cases for camera photos. Scoped by section (e.g.
// "component:Roof" vs "finding") so the same filename in two different
// sections is never treated as the same upload.
function fileIdentity(sectionKey, file) {
  return `${sectionKey}::${file.name}::${file.size}::${file.lastModified}`;
}

// Uploads whichever of `files` don't already have a recorded success in
// `tracker` (B4 fix #2, 2026-09-12) — a per-file try/catch means one bad
// upload no longer aborts the rest of the batch, and a file that already
// has a recorded attachmentId is never re-uploaded, so calling this again
// after a partial failure (the caller's "retry") only touches the files
// that actually failed last time. `tracker` is a Map the caller owns and
// keeps alive across submit attempts within the same page load — that's
// what makes retry-without-duplication possible; it does not survive a
// reload (see the audit-draft comment for why that's a separate, harder
// problem for the File objects themselves).
async function uploadSectionResumable(files, category, ownerId, sectionKey, tracker) {
  const attachmentIds = [];
  const failures = [];
  for (const file of files) {
    const key = fileIdentity(sectionKey, file);
    if (tracker.has(key)) { attachmentIds.push(tracker.get(key)); continue; }
    try {
      const attachmentId = await uploadAttachmentUnlinked(file, category, ownerId);
      tracker.set(key, attachmentId);
      attachmentIds.push(attachmentId);
    } catch (err) {
      failures.push({ name: file.name, error: err.message });
    }
  }
  return { attachmentIds, failures };
}

function attachmentThumbHtml(a) {
  if (a.Kind === 'image') {
    return `<img src="${escapeHtml(a.ThumbUrl || a.Url)}" alt="" style="width:84px;height:84px;object-fit:cover;border-radius:8px;display:block" />`;
  }
  const icon = a.Kind === 'document' ? '📄' : a.Kind === 'audio' ? '🎵' : '📎';
  return `<div style="width:84px;height:84px;border-radius:8px;background:#f0f2fb;display:flex;align-items:center;justify-content:center;font-size:28px">${icon}</div>`;
}

// Renders a thumbnail grid + "+ Add" capture control into `container`, wired
// to attach/detach/void/edit against (entityType, entityId). Re-renders
// itself in place after any change — callers don't need to manage state.
//   opts: { title, defaultRoleName, inheritedClassification, accept }
async function renderAttachmentSection(entityType, entityId, container, opts = {}) {
  const { title = 'Photos', defaultRoleName = null, inheritedClassification = null, accept = 'image/*,application/pdf' } = opts;
  const roles = state.options.attachmentRoles || [];
  const defaultRole = defaultRoleName ? roles.find((r) => r.Name === defaultRoleName) : null;
  const { attachments } = await api(`/api/pg/attachments?entityType=${entityType}&entityId=${entityId}`);

  const grid = attachments.length
    ? `<div class="attach-grid" style="display:flex;flex-wrap:wrap;gap:8px">${attachments.map((a) => `
        <div class="attach-thumb" data-link-id="${a.LinkId}" title="${escapeHtml(a.RoleName || '')}">${attachmentThumbHtml(a)}</div>`).join('')}</div>`
    : '<p class="muted">None yet.</p>';

  container.innerHTML = `
    <h4 style="margin:14px 0 6px">${escapeHtml(title)}</h4>
    ${grid}
    <div class="btn-row" style="margin-top:8px">
      <label class="btn btn-secondary" style="cursor:pointer;margin:0">
        + Add
        <input type="file" accept="${accept}" multiple style="display:none" class="attach-input" />
      </label>
    </div>
    <div class="attach-edit-panel" hidden></div>`;

  container.querySelector('.attach-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    try {
      for (const file of files) {
        await uploadAttachment(file, entityType, entityId, { roleId: defaultRole?.Id, classification: inheritedClassification });
      }
      renderAttachmentSection(entityType, entityId, container, opts);
    } catch (err) { toast(err.message); }
  });

  container.querySelectorAll('.attach-thumb').forEach((el) => el.addEventListener('click', () => {
    const a = attachments.find((x) => String(x.LinkId) === el.dataset.linkId);
    renderAttachmentEditPanel(a, roles, entityType, entityId, container, opts);
  }));
}

async function renderAttachmentEditPanel(a, roles, entityType, entityId, container, opts) {
  const panel = container.querySelector('.attach-edit-panel');
  const roleOptions = roles.map((r) => `<option value="${r.Id}" ${a.RoleId === r.Id ? 'selected' : ''}>${escapeHtml(r.Name)}</option>`).join('');
  const quoteRoleId = roles.find((r) => r.Name === 'Quote')?.Id;
  // Quotes attach to the job line (§6.4, "you shop the roof, not the whole
  // cabin") — vendor/amount/date/selected only make sense there, and only
  // once the Quote role is picked (role answers "what is this," these
  // fields answer "whose quote and how much").
  const vendorsRes = entityType === 'job_line' ? await api('/api/pg/vendors') : { vendors: [] };
  panel.hidden = false;
  panel.innerHTML = `
    <div class="card" style="margin-top:8px">
      <a href="${escapeHtml(a.Url)}" target="_blank" rel="noopener">${a.Kind === 'image'
        ? `<img src="${escapeHtml(a.Url)}" alt="" style="max-width:100%;border-radius:8px;display:block" />`
        : `Open file (${escapeHtml(a.OriginalFilename || a.Kind)})`}</a>
      <div class="field-row"><label>Role</label><select class="attach-role"><option value="">— unset —</option>${roleOptions}</select></div>
      <div class="field-row"><label>Caption</label><input class="attach-caption" value="${escapeHtml(a.Caption || '')}" /></div>
      <label style="display:flex;align-items:center;gap:8px;font-weight:400;margin:8px 0"><input type="checkbox" class="attach-include" ${a.IncludeInReport ? 'checked' : ''} /> Include in board report</label>
      ${entityType === 'job_line' ? `
      <div class="quote-fields" ${a.RoleName === 'Quote' ? '' : 'hidden'}>
        <div class="field-row"><label>Vendor</label><div class="attach-vendor"></div></div>
        <div class="field-row"><label>Amount</label><input class="attach-amount" type="number" step="0.01" value="${a.QuotedAmount ?? ''}" /></div>
        <div class="field-row"><label>Date</label><input class="attach-quote-date" type="date" value="${(a.QuoteDate || '').slice(0, 10)}" /></div>
        <label style="display:flex;align-items:center;gap:8px;font-weight:400;margin:8px 0"><input type="checkbox" class="attach-selected-quote" ${a.IsSelectedQuote ? 'checked' : ''} /> This is the selected quote</label>
      </div>` : ''}
      <div class="btn-row">
        <button type="button" class="btn btn-primary attach-save">Save</button>
        <button type="button" class="btn btn-secondary attach-detach">Detach</button>
        <button type="button" class="btn btn-secondary attach-void">Void</button>
        <button type="button" class="btn btn-secondary attach-cancel">Close</button>
      </div>
    </div>`;
  panel.querySelector('.attach-role')?.addEventListener('change', (e) => {
    const qf = panel.querySelector('.quote-fields');
    if (qf) qf.hidden = Number(e.target.value) !== quoteRoleId;
  });
  // §9: the vendor list is long enough to be worth searching rather than
  // scrolling, so it uses the shared combobox like every other long list.
  const vendorMount = panel.querySelector('.attach-vendor');
  const vendorCbx = vendorMount ? mountCombobox(vendorMount, {
    options: vendorsRes.vendors.map((v) => ({ value: v.Id, label: v.Name })),
    value: a.VendorId ?? null,
    placeholder: '— unset —',
    emptyText: 'No vendor matches',
  }) : null;
  panel.querySelector('.attach-save').addEventListener('click', async () => {
    try {
      await api(`/api/pg/attachment-links/${a.LinkId}`, { method: 'PATCH', body: JSON.stringify({
        roleId: panel.querySelector('.attach-role').value || null,
        caption: panel.querySelector('.attach-caption').value || null,
        includeInReport: panel.querySelector('.attach-include').checked,
        vendorId: vendorCbx ? vendorCbx.getValue() : null,
        quotedAmount: panel.querySelector('.attach-amount')?.value || null,
        quoteDate: panel.querySelector('.attach-quote-date')?.value || null,
        isSelectedQuote: panel.querySelector('.attach-selected-quote')?.checked || false,
      }) });
      renderAttachmentSection(entityType, entityId, container, opts);
    } catch (err) { toast(err.message); }
  });
  panel.querySelector('.attach-detach').addEventListener('click', async () => {
    if (!await confirmDialog('Detach this file from here? The file itself is not deleted.')) return;
    await api(`/api/pg/attachment-links/${a.LinkId}`, { method: 'DELETE' });
    renderAttachmentSection(entityType, entityId, container, opts);
  });
  // One tap, no confirm — junk arrives via email in the inbox (Phase 5) and
  // hesitation is the enemy. The file survives in Spaces either way.
  panel.querySelector('.attach-void').addEventListener('click', async () => {
    await api(`/api/pg/attachments/${a.Id}/void`, { method: 'POST' });
    renderAttachmentSection(entityType, entityId, container, opts);
  });
  panel.querySelector('.attach-cancel').addEventListener('click', () => { panel.hidden = true; panel.innerHTML = ''; });
}

function setChrome({ title, showBack, showLogout }) {
  pageTitle.textContent = title;
  backBtn.hidden = !showBack;
  logoutBtn.hidden = !showLogout;
  menuBtn.hidden = !showLogout;
  globalSearchWrap.hidden = !showLogout;
}

// beforeunload only fires on a real page unload (tab close, reload, external
// link). An SPA view swap is not an unload, so a per-screen beforeunload guard
// can never catch "clicked another nav item with unsaved work" — that path is
// here. Every navigation funnels through go()/goBack(), so this is the one
// place it needs to live.
//
// formDirty is set by genuine user interaction only: programmatic assignment
// (el.value = x) fires neither input nor change, so screens that populate
// themselves from an async fetch after render never trip it. That property is
// why this tracks events rather than diffing a snapshot of the DOM.
let formDirty = false;

// A field counts as real work if it lives inside a <form>, or is a textarea
// (typed prose is the most painful thing to lose). Search boxes, filter
// selects and sort controls all sit outside <form> in this app, so they are
// excluded structurally rather than by maintaining a list of ids. Anything
// that needs to opt out explicitly can carry data-no-guard.
function isGuardedField(el) {
  if (!el || !el.matches) return false;
  if (!el.matches('input, textarea, select')) return false;
  if (el.type === 'hidden' || el.type === 'search' || el.disabled) return false;
  if (el.closest('[data-no-guard]')) return false;
  return !!el.closest('form') || el.tagName === 'TEXTAREA' || !!el.closest('[data-guard]');
}

app.addEventListener('input', (e) => { if (isGuardedField(e.target)) formDirty = true; }, true);
app.addEventListener('change', (e) => { if (isGuardedField(e.target)) formDirty = true; }, true);

// The grid registers its own beforeunload while dirty; this covers the other
// 35 forms, so closing the tab or hitting reload with unsaved work warns too.
// Browsers show their own generic wording here and ignore ours — the in-app
// dialog above is the one that can actually explain what's at stake.
window.addEventListener('beforeunload', (e) => {
  if (!formDirty || !app.querySelector('form, textarea')) return;
  e.preventDefault();
  e.returnValue = '';
});

async function confirmLeaveUnsaved() {
  const grid = activeJobLineGrid;
  if (grid && grid.isDirty()) {
    const n = grid.lineCount();
    return confirmDialog(
      `You have ${n} unsaved job line${n === 1 ? '' : 's'}. Leaving keeps them as a draft you can restore, but they won't be attached to the work order until you save.`,
      { confirmLabel: 'Leave', cancelLabel: 'Stay on this page', danger: true }
    );
  }
  // If nothing editable is left on screen, whatever was typed was in a form the
  // user already dismissed (an inline Add row removed, a panel closed). Don't
  // ask about work that no longer exists.
  if (formDirty && app.querySelector('form, textarea')) {
    return confirmDialog(
      'You have unsaved changes on this screen. Leaving will discard them.',
      { confirmLabel: 'Leave', cancelLabel: 'Stay on this page', danger: true }
    );
  }
  return true;
}

async function go(view, params, opts = {}) {
  // opts.skipGuard: goBack() has already asked, so don't ask twice.
  if (!opts.skipGuard && !(await confirmLeaveUnsaved())) return;
  // opts.reset: jumping to a top-level section (sidebar nav, a dashboard
  // quick-link, an admin tool list) starts a fresh breadcrumb trail rather
  // than extending whatever drill-down path was already on the stack —
  // otherwise switching between nav items, or re-clicking the one you're
  // already on, just keeps appending forever (bug: breadcrumb bar growing
  // unbounded, eventually off-screen, from ordinary nav clicks).
  if (opts.reset) state.stack = [];
  if (!opts.replace) {
    const top = state.stack[state.stack.length - 1];
    // Belt-and-suspenders dedup: even a plain repeat of the exact same
    // view+params (clicking the same tab twice, or a stray double-click)
    // never pushes a second identical entry.
    const isDuplicate = top && top.view === view && JSON.stringify(top.params) === JSON.stringify(params);
    if (!isDuplicate) state.stack.push({ view, params });
  }
  render(view, params, { guarded: true });
}
async function goBack() {
  // Confirm before popping: bailing out after the pops would leave the
  // breadcrumb stack one entry short of where the user actually still is.
  if (!(await confirmLeaveUnsaved())) return;
  state.stack.pop();
  const prev = state.stack.pop();
  if (prev) go(prev.view, prev.params, { skipGuard: true });
  else go('dashboard', {}, { replace: true, skipGuard: true });
}

backBtn.addEventListener('click', goBack);
logoutBtn.addEventListener('click', async () => {
  // Ask before the fetch — once the session is gone, staying isn't an option.
  if (!(await confirmLeaveUnsaved())) return;
  await fetch('/logout', { method: 'POST' });
  state.user = null; state.stack = [];
  render('login');
});

const NAV_ITEMS = [
  { icon: '🏠', label: 'Dashboard', view: 'dashboard' },
  { icon: '🛠️', label: 'Work Orders', view: 'workOrders' },
  { icon: '📅', label: 'Calendar', view: 'calendar' },
  { icon: '📥', label: 'Inbox', view: 'inbox' },
  { icon: '🗂️', label: 'Admin Tasks', view: 'adminTasks' },
  { icon: '📝', label: 'Start Audit', view: 'auditPicker' },
  { icon: '📋', label: 'Audit Rounds', view: 'auditRounds' },
  { icon: '🗺️', label: 'Map', view: 'map' },
  { icon: '📍', label: 'Locations', view: 'locations' },
  { icon: '🗒️', label: 'Notes', view: 'notes' },
  { icon: '💵', label: 'Expenses', view: 'expenses' },
  { icon: '📦', label: 'Materials', view: 'materials' },
  { icon: '💰', label: 'Capital Plan', view: 'capitalPlan' },
  { icon: '🧰', label: 'Requests', view: 'requests' },
  { icon: '👷', label: 'Crew', view: 'crew' },
  { icon: '🕒', label: 'Hours', view: 'crewHours' },
  { icon: '📋', label: 'Maintenance Log', view: 'maintenanceLog' },
  { icon: '📊', label: 'Reports', view: 'reports' },
  { icon: '⚙️', label: 'Admin', view: 'admin' },
];
const NAV_ITEM_BY_VIEW = Object.fromEntries(NAV_ITEMS.map((n) => [n.view, n]));

// Default grouping. Headers are fixed; items move freely between sections in
// the sidebar's reorder mode, and the result is saved to display_settings
// (nav_layout). The trailing null-header section renders without a label.
const DEFAULT_NAV_LAYOUT = [
  { header: 'Daily', items: ['dashboard', 'workOrders', 'calendar', 'inbox', 'adminTasks'] },
  { header: 'Field', items: ['auditPicker', 'map', 'locations', 'notes'] },
  { header: 'Money', items: ['expenses', 'capitalPlan'] },
  { header: 'Records', items: ['requests', 'crew', 'crewHours', 'maintenanceLog'] },
  { header: null, items: ['reports', 'admin'] },
];

// A saved layout can go stale as the app changes: sections get renamed/added
// and nav items come and go. Keep the default's section list, place each saved
// item under its saved header when that header still exists, drop views that
// no longer exist, and slot any never-placed view into its default section.
function reconcileNavLayout(saved) {
  const layout = DEFAULT_NAV_LAYOUT.map((sec) => ({ header: sec.header, items: [] }));
  const placed = new Set();
  if (Array.isArray(saved)) {
    for (const sec of saved) {
      const target = layout.find((l) => l.header === (sec?.header ?? null));
      if (!target || !Array.isArray(sec.items)) continue;
      for (const view of sec.items) {
        if (!NAV_ITEM_BY_VIEW[view] || placed.has(view)) continue;
        target.items.push(view); placed.add(view);
      }
    }
  }
  DEFAULT_NAV_LAYOUT.forEach((sec, i) => sec.items.forEach((view) => {
    if (!placed.has(view)) { layout[i].items.push(view); placed.add(view); }
  }));
  return layout;
}

let navEditMode = false;
let navLayoutSaveTimer = null;
let navLayoutPending = undefined; // layout (or null = reset) not yet PUT

function currentNavLayout() {
  return reconcileNavLayout(state.options?.displaySettings?.NavLayout);
}
function setNavLayout(layout) {
  if (state.options) state.options.displaySettings = { ...(state.options.displaySettings || {}), NavLayout: layout };
  navLayoutPending = layout;
  clearTimeout(navLayoutSaveTimer);
  // Debounced so tapping ▼ five times in a row is one request, not five.
  navLayoutSaveTimer = setTimeout(flushNavLayoutSave, 600);
}
async function flushNavLayoutSave() {
  clearTimeout(navLayoutSaveTimer);
  if (navLayoutPending === undefined) return;
  const navLayout = navLayoutPending;
  navLayoutPending = undefined;
  try { await api('/api/pg/display-settings', { method: 'PUT', body: JSON.stringify({ navLayout }) }); }
  catch (err) { if (err.message !== 'Not authenticated') toast(`Couldn't save menu order: ${err.message}`); }
}

// Move one item a step. Stepping past either end of a section carries the
// item into the neighboring section (end of the one above / start of the one
// below), which is how items change sections without drag on a phone.
function moveNavItem(view, dir) {
  const layout = currentNavLayout();
  const si = layout.findIndex((sec) => sec.items.includes(view));
  if (si < 0) return;
  const items = layout[si].items;
  const i = items.indexOf(view);
  if (dir < 0) {
    if (i > 0) [items[i - 1], items[i]] = [items[i], items[i - 1]];
    else if (si > 0) { items.splice(i, 1); layout[si - 1].items.push(view); }
    else return;
  } else {
    if (i < items.length - 1) [items[i], items[i + 1]] = [items[i + 1], items[i]];
    else if (si < layout.length - 1) { items.splice(i, 1); layout[si + 1].items.unshift(view); }
    else return;
  }
  setNavLayout(layout);
}
// Drag-drop placement: before `beforeView` in section `si`, or at the end of
// that section when beforeView is null.
function placeNavItem(view, si, beforeView) {
  if (view === beforeView) return;
  const layout = currentNavLayout();
  layout.forEach((sec) => { sec.items = sec.items.filter((v) => v !== view); });
  const items = layout[si].items;
  const at = beforeView ? items.indexOf(beforeView) : -1;
  if (at < 0) items.push(view); else items.splice(at, 0, view);
  setNavLayout(layout);
}

function renderSidebar(activeView) {
  const layout = currentNavLayout();
  const flat = layout.flatMap((sec) => sec.items);
  const first = flat[0], last = flat[flat.length - 1];
  const sectionHtml = layout.map((sec, si) => {
    // Outside edit mode an emptied section just disappears; in edit mode it
    // stays visible so there's somewhere to move items back into.
    if (!sec.items.length && !navEditMode) return '';
    const header = sec.header
      ? `<div class="nav-section-header">${escapeHtml(sec.header)}</div>`
      : (navEditMode ? '<div class="nav-section-header nav-section-unlabeled">No header</div>' : '<div class="nav-section-divider"></div>');
    const items = sec.items.map((view) => {
      const item = NAV_ITEM_BY_VIEW[view];
      const label = escapeHtml(item.label);
      if (!navEditMode) {
        return `<button class="nav-item ${view === activeView ? 'active' : ''}" data-view="${view}">
          <span class="nav-icon">${item.icon}</span><span>${label}</span>
        </button>`;
      }
      return `<div class="nav-item nav-item-editing" data-view="${view}" draggable="true">
          <span class="nav-drag-handle" aria-hidden="true">⠿</span>
          <span class="nav-icon">${item.icon}</span><span class="nav-label">${label}</span>
          <button type="button" class="nav-move" data-view="${view}" data-dir="-1" aria-label="Move ${label} up" ${view === first ? 'disabled' : ''}>▲</button>
          <button type="button" class="nav-move" data-view="${view}" data-dir="1" aria-label="Move ${label} down" ${view === last ? 'disabled' : ''}>▼</button>
        </div>`;
    }).join('');
    return `<div class="nav-section" data-section="${si}">${header}${items}</div>`;
  }).join('');

  const editBar = navEditMode
    ? `<div class="nav-edit-bar">
        <button type="button" class="btn btn-primary nav-edit-done">Done</button>
        <button type="button" class="btn btn-secondary nav-edit-reset">Reset to default</button>
      </div>
      <p class="nav-edit-hint">Use ▲ ▼ (or drag) to reorder. Moving past the top or bottom of a section moves the item into the next one. Menu order is shared by everyone.</p>`
    : '';
  sidebarNavEl.classList.toggle('editing', navEditMode);
  sidebar.classList.toggle('nav-editing', navEditMode); // widens the drawer so labels fit beside the arrows
  sidebarNavEl.innerHTML = editBar + sectionHtml
    + (navEditMode ? '' : '<button type="button" class="nav-edit-toggle">↕ Reorder menu</button>');

  if (!navEditMode) {
    sidebarNavEl.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => { closeSidebar(); go(btn.dataset.view, {}, { reset: true }); });
    });
    sidebarNavEl.querySelector('.nav-edit-toggle').addEventListener('click', () => {
      navEditMode = true; renderSidebar(activeView);
      sidebarNavEl.querySelector('.nav-edit-done')?.focus();
    });
  } else {
    sidebarNavEl.querySelector('.nav-edit-done').addEventListener('click', () => {
      navEditMode = false; flushNavLayoutSave(); renderSidebar(activeView);
      sidebarNavEl.querySelector('.nav-edit-toggle')?.focus();
    });
    sidebarNavEl.querySelector('.nav-edit-reset').addEventListener('click', () => {
      if (!confirm('Reset the menu to the default order and sections?')) return;
      setNavLayout(null); flushNavLayoutSave(); renderSidebar(activeView);
    });
    sidebarNavEl.querySelectorAll('.nav-move').forEach((btn) => btn.addEventListener('click', () => {
      const { view, dir } = btn.dataset;
      moveNavItem(view, Number(dir));
      renderSidebar(activeView);
      // Keep focus on the same arrow of the moved item so repeated taps /
      // Enter presses keep moving it; fall back to the other arrow at an end.
      const sel = (d) => sidebarNavEl.querySelector(`.nav-move[data-view="${view}"][data-dir="${d}"]`);
      const again = sel(dir);
      (again && !again.disabled ? again : sel(-Number(dir)))?.focus();
      again?.closest('.nav-item')?.scrollIntoView({ block: 'nearest' });
    }));

    // Pointer drag (desktop). Touch devices use the arrows.
    let dragView = null;
    const clearMarks = () => sidebarNavEl.querySelectorAll('.drop-before, .drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-into'));
    sidebarNavEl.querySelectorAll('.nav-item-editing').forEach((row) => {
      row.addEventListener('dragstart', (e) => {
        dragView = row.dataset.view;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragView);
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => { dragView = null; row.classList.remove('dragging'); clearMarks(); });
    });
    sidebarNavEl.querySelectorAll('.nav-section').forEach((secEl) => {
      const si = Number(secEl.dataset.section);
      // Drop target = the row the pointer is over (insert before it, or after
      // it when in its lower half); over the header / empty space = section end
      // or start.
      const targetFor = (e) => {
        const row = e.target.closest('.nav-item-editing');
        if (row) {
          const r = row.getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) return { before: row.dataset.view, markEl: row };
          const next = row.nextElementSibling;
          return next ? { before: next.dataset.view, markEl: next } : { before: null, markEl: secEl };
        }
        if (e.target.closest('.nav-section-header')) {
          const firstRow = secEl.querySelector('.nav-item-editing');
          return firstRow ? { before: firstRow.dataset.view, markEl: firstRow } : { before: null, markEl: secEl };
        }
        return { before: null, markEl: secEl };
      };
      secEl.addEventListener('dragover', (e) => {
        if (!dragView) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const { markEl } = targetFor(e);
        clearMarks();
        markEl.classList.add(markEl === secEl ? 'drop-into' : 'drop-before');
      });
      secEl.addEventListener('drop', (e) => {
        if (!dragView) return;
        e.preventDefault();
        const { before } = targetFor(e);
        placeNavItem(dragView, si, before);
        dragView = null;
        renderSidebar(activeView);
      });
    });
  }
  sidebarUserEl.textContent = state.user ? `Signed in as ${state.user}` : '';
}
function openSidebar() { sidebar.classList.add('open'); sidebarOverlay.hidden = false; }
function closeSidebar() { sidebar.classList.remove('open'); sidebarOverlay.hidden = true; flushNavLayoutSave(); }
window.addEventListener('pagehide', flushNavLayoutSave);
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
  if (view === 'adminTaskDetail') return params.title || (params.id ? 'Task' : 'New Task');
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

let currentView = null;

async function render(view, params = {}, opts = {}) {
  // Guarding go()/goBack() alone missed anything that calls render() directly
  // — breadcrumb links do, and so would any future caller. render() is the one
  // funnel every view change passes through, so the backstop lives here.
  // Skipped when: go()/goBack() already asked (opts.guarded), the view isn't
  // actually changing (a resize re-render or a post-save refresh of the same
  // screen), or we're being thrown to login by a 401, where there's nothing to
  // stay on.
  if (!opts.guarded && view !== 'login' && view !== currentView) {
    if (!(await confirmLeaveUnsaved())) return;
  }
  try {
    // #app is replaced wholesale on every view swap, so anything holding a
    // window-level listener (the grid's unsaved-changes guard, its autosave
    // timer) has to be torn down here rather than waiting to be garbage.
    destroyActiveJobLineGrid();
    formDirty = false;   // new screen, nothing typed on it yet
    currentView = view;
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
      map: () => renderMap(),
      notes: () => renderNotes(),
      inbox: () => renderInbox(),
      expenses: () => renderExpenses(params),
      expenseDetail: () => renderExpenseDetail(params),
      adminTasks: () => renderAdminTasks(),
      adminTaskDetail: () => renderAdminTaskDetail(params),
      adminTaskCategories: () => renderAdminTaskCategories(),
      adminTaskStatuses: () => renderAdminTaskStatuses(),
      adminFunds: () => renderAdminFunds(),
      adminExpenseCategories: () => renderAdminExpenseCategories(),
      createWoFromFindings: () => renderCreateWoFromFindings(params),
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
      adminCauses: () => renderAdminCauses(),
      adminWorkOrderStatuses: () => renderAdminWorkOrderStatuses(),
      adminJobLineStatuses: () => renderAdminJobLineStatuses(),
      adminAttachmentRoles: () => renderAdminAttachmentRoles(),
      adminAssetTypeIcons: () => renderAdminAssetTypeIcons(),
      adminMapCalibration: () => renderAdminMapCalibration(),
      adminJobLineTemplates: () => renderAdminJobLineTemplates(),
      calendar: () => renderCalendar(params),
      newCalendarEvent: () => renderNewCalendarEvent(params),
      calendarEventDetail: () => renderCalendarEventDetail(params),
      adminChecklistTemplates: () => renderAdminChecklistTemplates(),
      workOrders: () => (window.innerWidth >= DRILLDOWN_MIN_WIDTH ? renderWorkOrdersDrilldown(params) : renderWorkOrders(params)),
      workOrderDetail: () => renderWorkOrderDetail(params),
      newWorkOrder: () => renderNewWorkOrder(params),
      editWorkOrderLines: () => renderEditWorkOrderLines(params),
      materials: () => renderMaterialsOnHand(),
      auditRounds: () => renderAuditRounds(),
      auditRound: () => renderAuditRound(params),
      auditRunner: () => renderAuditRunner(params),
      auditReview: () => renderAuditReview(params),
      auditFormBuilder: () => renderAuditFormBuilder(params),
      auditData: () => renderAuditData(),
      auditRoundReport: () => renderAuditRoundReport(params),
      crew: () => renderCrew(),
      crewHours: () => renderCrewHours(),
      adminUsers: () => renderAdminUsers(),
      activityLog: () => renderActivityLog(),
      requests: () => renderRequests(params),
      requestDetail: () => renderRequestDetail(params),
      adminRequestFields: () => renderAdminRequestFields(),
      adminGcal: () => renderAdminGcal(),
      adminCalendarEventTypes: () => renderAdminCalendarEventTypes(),
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
  setChrome({ title: 'Sychar Operations — Sign In', showBack: false, showLogout: false });
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
      if (pendingDeepLink) {
        const dl = pendingDeepLink; pendingDeepLink = null;
        go(dl.view, dl.params, { replace: true, reset: true });
      } else {
        go('dashboard', {}, { replace: true });
      }
    } catch (err) { toast(err.message); }
  });
}

const DASHBOARD_WIDGET_DEFAULTS = { woOverview: true, calendar: true, activity: true, findings: true };
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

const SUBSYSTEM_LABELS = { backup: 'Backup', gcal_sync: 'Calendar sync', mail_ingest: 'Mail ingest' };

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

  const [woSummary, calRes, scheduledWoRes, activityRes, findingsSummary, inboxRes, expenseInboxRes, fundBalancesRes, systemHealthRes] = await Promise.all([
    prefs.woOverview ? api('/api/pg/dashboard/wo-summary') : Promise.resolve(null),
    prefs.calendar ? api(`/api/pg/calendar-events?from=${isoDate(weekStart)}&to=${isoDate(weekEnd)}`) : Promise.resolve(null),
    prefs.calendar ? api('/api/pg/work-orders') : Promise.resolve(null),
    prefs.activity ? api(`/api/pg/activity-log?limit=12${isAdmin ? '' : `&username=${encodeURIComponent(currentUser.username || '')}`}`) : Promise.resolve(null),
    prefs.findings ? api('/api/pg/findings-summary') : Promise.resolve(null),
    api('/api/pg/inbox/count'),
    api('/api/pg/expenses/inbox/count'),
    api('/api/pg/funds/balances'),
    api('/api/pg/system-health').catch(() => null), // never let a health-check hiccup block the rest of the dashboard from loading
  ]);

  // Build Brief v3 §3.4 — per active fund, "$X of $Y remaining · N days
  // left." Over-spend renders in a warning color with the overage shown;
  // nothing is ever blocked, this is a reference line only.
  function fundBalancesHtml() {
    const activeFunds = (fundBalancesRes.funds || []).filter((f) => f.Active);
    if (!activeFunds.length) return '';
    return `<div class="card">
      <h3>Funds</h3>
      <div class="summary-buckets">
        ${activeFunds.map((f) => {
          const over = f.OverBudget;
          return `<div class="bucket-tile clickable-tile" data-view="expenses" style="cursor:pointer${over ? ';border-color:#c0392b66;background:#c0392b1a' : ''}">
            <div class="n" style="${over ? 'color:#c0392b' : ''}">${over ? `+$${Math.abs(f.Remaining).toLocaleString()}` : `$${f.Remaining.toLocaleString()}`}</div>
            <div class="muted">${escapeHtml(f.Name)}${over ? ' over' : ' left'}${f.DaysLeft != null && f.DaysLeft >= 0 ? ` · ${f.DaysLeft}d` : ''}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // Open should trend to zero (3) — every finding is meant to end up with a
  // decision made on it. The second number is the data-quality check: things
  // nobody has even put on a work order yet.
  function findingsSummaryHtml() {
    if (!findingsSummary) return '';
    return `<div class="card">
      <h3>Findings</h3>
      <div class="summary-buckets">
        <div class="bucket-tile clickable-tile" data-view="reports" style="cursor:pointer"><div class="n">${findingsSummary.OpenCount}</div><div class="muted">Open (trending to zero)</div></div>
        <div class="bucket-tile"><div class="n">${findingsSummary.NotOnAnyWorkOrderCount}</div><div class="muted">Not on any Work Order</div></div>
      </div>
    </div>`;
  }

  // colorClass is a fixed severity word (neutral/pop/warn/bad/good) for the
  // schedule buckets, which aren't admin-editable data; statusColor is a
  // literal hex from work_order_statuses for the by-status tiles, which are.
  function statTile(n, label, colorClass, filterParams, statusColor) {
    const style = statusColor ? ` style="background:${statusColor}1a;border-color:${statusColor}66"` : '';
    return `<div class="bucket-tile ${statusColor ? '' : `tile-${colorClass}`}${filterParams ? ' clickable-tile wo-filter-tile' : ''}"${style} ${filterParams ? `data-filter='${JSON.stringify(filterParams)}'` : ''}>
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
        ${s.ByStatus.map((st) => statTile(st.Count, st.Name, null, { status: st.Name }, st.Color)).join('')}
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
          ${statusPillHtml(e.Status, e.StatusColor)}
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

  // System health (Build Brief v4 Part 2, generalizing the B6 backup-only
  // check, 2026-09-12): "last success" and "did the most recent attempt
  // fail" are shown separately for every subsystem — a run can fail tonight
  // while last night's was still fine, and collapsing that into one
  // bad/good signal would hide which situation you're actually in.
  //
  // Backup keeps its own quiet line (no card chrome) when healthy — it's
  // the one subsystem with a "last success" timestamp worth showing even
  // when nothing is wrong. Any subsystem actually reporting `failed` (gcal
  // sync, mail ingest, backup, or whatever gets added after those) gets the
  // same warning-card treatment automatically — no per-integration
  // dashboard work needed when the other two start reporting for real.
  function systemHealthHtml() {
    if (!systemHealthRes) return ''; // request failed — don't let a broken health check itself cry wolf
    const subsystems = systemHealthRes.subsystems || [];
    const backup = subsystems.find((s) => s.Subsystem === 'backup');
    const others = subsystems.filter((s) => s.Subsystem !== 'backup' && s.State === 'failed');

    let html = '';
    if (backup) {
      const bad = backup.State === 'failed' || backup.Stale;
      const whenText = backup.LastSuccess ? new Date(backup.LastSuccess).toLocaleString() : 'never';
      html += !bad
        ? `<p class="muted" style="margin:-4px 0 0">💾 Last backup: ${escapeHtml(whenText)}</p>`
        : `<div class="card" style="border-left:4px solid #c0392b;background:#c0392b0d">
            <h3 style="color:#c0392b">⚠️ Backup needs attention</h3>
            <p class="muted" style="margin-top:-4px">Last successful backup: ${escapeHtml(whenText)}</p>
            ${backup.State === 'failed' ? `<p style="margin-top:6px">Most recent run failed${backup.LastMessage ? `: ${escapeHtml(backup.LastMessage)}` : ''}.</p>` : ''}
            ${backup.State !== 'failed' && backup.Stale ? `<p style="margin-top:6px">No successful backup in over 48 hours.</p>` : ''}
          </div>`;
    }
    html += others.map((s) => `
      <div class="card" style="border-left:4px solid #c0392b;background:#c0392b0d">
        <h3 style="color:#c0392b">⚠️ ${escapeHtml(SUBSYSTEM_LABELS[s.Subsystem] || s.Subsystem)} needs attention</h3>
        ${s.LastMessage ? `<p style="margin-top:-4px">${escapeHtml(s.LastMessage)}</p>` : ''}
      </div>`).join('');
    return html;
  }

  // Fetched once per dashboard load; renders nothing when nothing is late.
  let overdueHtml = '';
  try { overdueHtml = await overdueStripHtml(); } catch { /* dashboard still works */ }

  function draw() {
    setApp(`
      ${overdueHtml}
      <div class="card">
        <h3>Welcome${state.user ? `, ${escapeHtml(state.user)}` : ''}</h3>
        <p class="muted" style="margin-top:-4px">${today.toLocaleDateString('default', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
        <div class="btn-row" style="margin-top:10px">
          <div class="list-item" data-view="locations" style="flex:1;min-width:140px">📍 Browse Locations</div>
          <div class="list-item" data-view="maintenanceLog" style="flex:1;min-width:140px">📋 Maintenance Log</div>
          <div class="list-item" data-view="capitalPlan" style="flex:1;min-width:140px">💰 Capital Plan</div>
          <div class="list-item" data-view="inbox" style="flex:1;min-width:140px${inboxRes.count > 0 ? ';font-weight:600' : ''}">📥 Inbox${inboxRes.count > 0 ? ` <span class="pill">${inboxRes.count}</span>` : ''}</div>
          <div class="list-item" data-view="expenses" style="flex:1;min-width:140px${expenseInboxRes.count > 0 ? ';font-weight:600' : ''}">💵 Expenses${expenseInboxRes.count > 0 ? ` <span class="pill">${expenseInboxRes.count}</span>` : ''}</div>
        </div>
        <details style="margin-top:10px">
          <summary class="muted" style="cursor:pointer">Customize dashboard</summary>
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:10px">
            <label style="display:flex;align-items:center;gap:6px;font-weight:400"><input type="checkbox" class="widget-toggle" data-widget="woOverview" ${prefs.woOverview ? 'checked' : ''} style="width:auto" /> Work Order overview</label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400"><input type="checkbox" class="widget-toggle" data-widget="calendar" ${prefs.calendar ? 'checked' : ''} style="width:auto" /> This week's calendar</label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400"><input type="checkbox" class="widget-toggle" data-widget="activity" ${prefs.activity ? 'checked' : ''} style="width:auto" /> Recent activity</label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400"><input type="checkbox" class="widget-toggle" data-widget="findings" ${prefs.findings ? 'checked' : ''} style="width:auto" /> Findings</label>
          </div>
        </details>
      </div>
      ${systemHealthHtml()}
      ${fundBalancesHtml()}
      ${woOverviewHtml()}
      ${findingsSummaryHtml()}
      ${calendarStripHtml()}
      ${activityHtml()}
    `);
    app.querySelectorAll('[data-view]').forEach((el) => el.addEventListener('click', () => go(el.dataset.view, {}, { reset: true })));
    app.querySelectorAll('.wo-filter-tile').forEach((el) => el.addEventListener('click', () => go('workOrders', JSON.parse(el.dataset.filter))));

    function wireWeekSummaryLinks(root) {
      root.querySelectorAll('.cal-strip-event-link').forEach((el) => el.addEventListener('click', () => go('calendarEventDetail', { id: el.dataset.eventId })));
      root.querySelectorAll('.cal-strip-wo-link').forEach((el) => el.addEventListener('click', () => go('workOrderDetail', { id: el.dataset.woId })));
      wireOverdueStrip();
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
  adminCauses: (params, container) => renderAdminCauses(container),
  adminWorkOrderStatuses: (params, container) => renderAdminWorkOrderStatuses(container),
  adminJobLineStatuses: (params, container) => renderAdminJobLineStatuses(container),
  adminAttachmentRoles: (params, container) => renderAdminAttachmentRoles(container),
  adminAssetTypeIcons: (params, container) => renderAdminAssetTypeIcons(container),
  adminMapCalibration: (params, container) => renderAdminMapCalibration(container),
  adminJobLineTemplates: (params, container) => renderAdminJobLineTemplates(container),
  adminChecklistTemplates: (params, container) => renderAdminChecklistTemplates(container),
  adminUsers: (params, container) => renderAdminUsers(container),
  activityLog: (params, container) => renderActivityLog(container),
  adminGcal: (params, container) => renderAdminGcal(container),
  adminCalendarEventTypes: (params, container) => renderAdminCalendarEventTypes(container),
  adminTaskCategories: (params, container) => renderAdminTaskCategories(container),
  adminTaskStatuses: (params, container) => renderAdminTaskStatuses(container),
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
    return `<div style="overflow-x:auto"><table class="report-table" data-card="1">
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
    const emptyMsg = typeFilter ? `No locations of type "${escapeHtml(typeFilter)}" — clear the filter to see all locations.` : 'No locations yet — tap + Add Location above to create the first one.';
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
      <div class="list-item ${onOpenAsset && selectedAssetId === a.Id ? 'cal-strip-selected' : ''}" data-id="${a.Id}" data-name="${escapeHtml(a.Name)}" style="display:flex;align-items:center;gap:11px">
        ${assetFaceHtml(a.Face, 34)}
        <div style="flex:1;min-width:0">
        <span>🏚️ ${escapeHtml(a.Name)}</span>
        <span class="pill">${escapeHtml(a['Asset type'] || '')}</span>
      </div></div>`).join('') : '<p class="muted">No assets in this location yet — add one from the asset search box when starting an audit or creating a work order (type a new name and choose "Add new asset").</p>';
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

// Work order / job line statuses are admin-editable tables now (Phase 2) —
// no hardcoded name->class mapping. Pills render with the status's own
// `color` field; callers without a color on hand (a bare status name with
// no row context) get a neutral pill instead of guessing.
function statusColorStyle(color) {
  return color ? ` style="background:${color}1a;color:${color};border:1px solid ${color}66"` : '';
}
function statusPillHtml(name, color) {
  return name ? `<span class="pill"${statusColorStyle(color)}>${escapeHtml(name)}</span>` : '';
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
      ${(() => {
        // Grouped by section, in the order the sections first appear, so the checklist
        // reads the way it was written. Ungrouped steps keep rendering flat — an
        // existing checklist with no sections looks exactly as it did.
        const stepHtml = (s) => `<div class="list-item" style="cursor:default">
          <label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer">
            <input type="checkbox" class="checklist-step-toggle" data-id="${s.Id}" ${s.Done ? 'checked' : ''} />
            <span style="${s.Done ? 'text-decoration:line-through;color:var(--muted)' : ''}">${escapeHtml(s.StepText)}</span>
          </label>
        </div>`;
        const groups = [];
        for (const st of visibleSteps) {
          const key = st.Section || '';
          const last = groups[groups.length - 1];
          if (last && last.key === key) last.steps.push(st);
          else groups.push({ key, steps: [st] });
        }
        return groups.map((g) => (g.key
          ? `<div style="margin-top:10px"><div class="muted" style="font-size:0.78rem;text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(g.key)}</div>${g.steps.map(stepHtml).join('')}</div>`
          : g.steps.map(stepHtml).join(''))).join('');
      })()}
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
      ${(n.attachments || []).length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">${n.attachments.map((a) => `<a href="${escapeHtml(a.Url)}" target="_blank" rel="noopener"><img src="${escapeHtml(a.ThumbUrl || a.Url)}" alt="" style="width:60px;height:60px;object-fit:cover;border-radius:8px" /></a>`).join('')}</div>` : ''}
      <div class="muted">${new Date(n.created_at).toLocaleDateString()}${n.created_by ? ` · ${escapeHtml(n.created_by)}` : ''}
        <a href="#" class="resolve-note" data-id="${n.id}" data-next="${!n.resolved}">${n.resolved ? 'reopen' : 'mark resolved'}</a>
      </div>
    </div>`).join('') || '<p class="muted">No notes yet — add one below.</p>';

  // The face is fetched alongside the asset so the header never flashes an icon and
  // then swaps to the photo a moment later.
  let assetFace = null;
  try { assetFace = (await api(`/api/pg/assets/${id}/face`)).face; } catch { /* icon fallback */ }

  // Condition status and history, fetched with the asset so the header doesn't render
  // a status and then change it (Addendum §5b/§5d).
  let cond = null; let condHistory = [];
  try {
    const ch = await api(`/api/pg/assets/${id}/condition-history`);
    cond = ch.status; condHistory = ch.history || [];
  } catch { /* the rest of the page still works */ }

  const CONDITION_COLOR = { Good: '#2e8b57', 'Needs attention': '#b4690e', Poor: '#c92a2a' };
  const conditionHtml = cond ? `
    <div class="card">
      <h3 style="font-size:1rem;margin:0 0 4px">Condition —
        <span style="color:${CONDITION_COLOR[cond.Status] || '#6b7086'}">${escapeHtml(cond.Status)}</span>
        ${cond.NeverAudited ? '<span class="muted" style="font-weight:400;font-size:0.85rem"> · not yet audited</span>' : ''}
      </h3>
      ${cond.Reasons.length
        ? `<div class="muted" style="font-size:0.88rem">${cond.Reasons.map(escapeHtml).join(' · ')}</div>`
        : '<div class="muted" style="font-size:0.88rem">Nothing open against this building.</div>'}
    </div>` : '';

  // "Roof: Fair (2026) → Poor (2027)" — the same question across rounds, read as one line.
  const historyHtml = condHistory.length ? `
    <div class="card">
      <h3 style="font-size:1rem">Condition history</h3>
      ${condHistory.map((h) => `
        <div class="list-item">
          <div><strong>${escapeHtml(h.Prompt)}</strong></div>
          <div class="muted" style="font-size:0.85rem">${h.Entries.map((e) => `${escapeHtml(e.Value ?? '—')}${e.Flagged ? ' ⚑' : ''} <span style="font-size:0.78rem">(${escapeHtml(e.RoundName)})</span>${e.WorkOrderId ? ` → WO ${e.WorkOrderId}` : ''}`).join(' → ')}</div>
        </div>`).join('')}
    </div>` : '';

  container.innerHTML = `
    <div class="card">
      <div style="display:flex;gap:14px;align-items:flex-start">
        <button type="button" id="assetFaceBtn" title="Set profile photo"
                style="border:none;background:none;padding:0;cursor:pointer">${assetFaceHtml(assetFace, 64)}</button>
        <div style="flex:1;min-width:0">
          <h3 style="margin:0">${escapeHtml(asset.Name)}</h3>
          <div class="muted">${escapeHtml(asset['Asset type'] || '')} · Condition: ${escapeHtml(asset.Condition || 'Unknown')}</div>
          ${asset['Lodge Holder'] ? `<div class="muted">🏠 Cabin/Lodge Holder: ${escapeHtml(asset['Lodge Holder'])}</div>` : ''}
        </div>
      </div>
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

    ${conditionHtml}
    ${historyHtml}
    <div class="card"><h3>Components</h3>${componentRows}</div>

    <div class="card" id="assetPhotosCard"></div>

    <div class="card"><h3>Work Orders (${workOrders.length})</h3>
      ${workOrders.map((w) => `<div class="list-item" data-wo-id="${w.Id}"><span>${escapeHtml(w.Title)}</span>${statusPillHtml(w.Status, w.StatusColor)}</div>`).join('') || '<p class="muted">None yet.</p>'}
    </div>

    <div class="card"><h3>Findings (${conditionFindings.length})</h3>
      ${conditionFindings.some((f) => f.Status === 'Open') ? `<div class="btn-row" style="margin-bottom:10px"><button type="button" class="btn btn-primary" id="createWoFromFindingsBtn">+ Create Work Order from Findings</button></div>` : ''}
      ${conditionFindings.map((f) => {
        const decided = f.Status === 'Deferred' || f.Status === 'Dismissed';
        return `
        <div class="list-item" style="cursor:default;flex-wrap:wrap">
          <span>${escapeHtml(f.Title || '')}</span>
          <span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="pill">${escapeHtml(f.Severity || '')}</span>
            <span class="pill">${escapeHtml(f.Status || 'Open')}</span>
            <button type="button" class="btn btn-secondary toggle-board-focus" data-id="${f.Id}" data-next="${!f.BoardFocus}" title="Put this on the next board report draft, whatever the dates say" style="padding:2px 8px;font-size:0.75rem;${f.BoardFocus ? 'background:#f0f2fb' : ''}">${f.BoardFocus ? '★ On board report' : '☆ Include on board report'}</button>
            ${!decided ? `<button type="button" class="btn btn-secondary finding-defer-toggle" data-id="${f.Id}" style="padding:2px 8px;font-size:0.75rem">Defer</button>
            <button type="button" class="btn btn-secondary finding-dismiss-toggle" data-id="${f.Id}" style="padding:2px 8px;font-size:0.75rem">Dismiss</button>` : ''}
          </span>
          ${f.Status === 'Deferred' ? `<p class="muted" style="flex-basis:100%;margin:4px 0 0">Deferred: ${escapeHtml(f.DeferredReason || '')}${f.RevisitDate ? ` — revisit ${formatDateNice(f.RevisitDate)}` : ''}</p>` : ''}
          ${f.Status === 'Dismissed' ? `<p class="muted" style="flex-basis:100%;margin:4px 0 0">Dismissed: ${escapeHtml(f.DismissNote || '')}</p>` : ''}
          ${!decided ? `
          <div class="finding-defer-box" data-id="${f.Id}" hidden style="flex-basis:100%;margin-top:6px">
            <div class="field-row"><label>Reason</label><input class="finding-defer-reason" /></div>
            <div class="field-row"><label>Revisit Date</label><input class="finding-defer-date" type="date" /></div>
            <button type="button" class="btn btn-primary finding-defer-save" data-id="${f.Id}">Save</button>
          </div>
          <div class="finding-dismiss-box" data-id="${f.Id}" hidden style="flex-basis:100%;margin-top:6px">
            <div class="field-row"><label>Why dismissed?</label><input class="finding-dismiss-note" /></div>
            <button type="button" class="btn btn-primary finding-dismiss-save" data-id="${f.Id}">Save</button>
          </div>` : ''}
          <div class="card" id="findingPhotos-${f.Id}" style="flex-basis:100%;margin-top:8px"></div>
        </div>`;
      }).join('') || '<p class="muted">None yet.</p>'}
    </div>

    <div class="card">
      <h3>Field Notes</h3>
      <div id="noteList">${noteRows}</div>
      <form id="noteForm" style="margin-top:10px">
        <div class="field-row"><textarea name="note" placeholder="Quick note or follow-up for this asset…" required></textarea></div>
        <div class="field-row"><label>Photo (optional)</label><input type="file" name="photo" accept="image/*" multiple /></div>
        <button class="btn btn-secondary" type="submit">Add Note</button>
      </form>
    </div>`;

  conditionFindings.forEach((f) => renderAttachmentSection('condition_finding', f.Id, container.querySelector(`#findingPhotos-${f.Id}`), { title: 'Photos', defaultRoleName: 'Evidence' }));
  renderAttachmentSection('asset', id, container.querySelector('#assetPhotosCard'), { title: 'Reference Photos', defaultRoleName: 'Reference' });

  container.querySelector('#startAuditBtn').addEventListener('click', () => go('audit', { id }));
  container.querySelector('#createWoFromFindingsBtn')?.addEventListener('click', () => go('createWoFromFindings', { assetId: id, assetName: asset.Name }));
  container.querySelector('#viewHistoryBtn').addEventListener('click', () => go('assetHistory', { id }));
  container.querySelector('#editAssetBtn').addEventListener('click', () => go('editAsset', { id }));
  container.querySelector('#newWoBtn').addEventListener('click', () => go('newWorkOrder', { assetId: id, assetName: asset.Name }));
  container.querySelectorAll('[data-wo-id]').forEach((el) => el.addEventListener('click', () => go('workOrderDetail', { id: el.dataset.woId })));
  container.querySelector('#assetFaceBtn')?.addEventListener('click', async () => {
    // Uses whatever is already attached to this asset; the API refuses anything else.
    let atts = [];
    try { atts = (await api(`/api/pg/attachments?entityType=asset&entityId=${id}`)).attachments || []; } catch { /* none */ }
    openProfilePhotoPicker(id, atts, { onDone: () => renderAssetDetail({ id }, container) });
  });

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
    const files = fd.getAll('photo').filter((f) => f && f.size);
    try {
      const attachmentIds = [];
      for (const file of files) attachmentIds.push(await uploadAttachmentUnlinked(file, 'notes', id));
      await api(`/api/pg/assets/${id}/notes`, { method: 'POST', body: JSON.stringify({ note, attachmentIds }) });
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
  container.querySelectorAll('.finding-defer-toggle').forEach((el) => el.addEventListener('click', () => {
    container.querySelector(`.finding-defer-box[data-id="${el.dataset.id}"]`).hidden = false;
  }));
  container.querySelectorAll('.finding-dismiss-toggle').forEach((el) => el.addEventListener('click', () => {
    container.querySelector(`.finding-dismiss-box[data-id="${el.dataset.id}"]`).hidden = false;
  }));
  container.querySelectorAll('.finding-defer-save').forEach((btn) => btn.addEventListener('click', async () => {
    const box = container.querySelector(`.finding-defer-box[data-id="${btn.dataset.id}"]`);
    try {
      await api(`/api/pg/condition-findings/${btn.dataset.id}/defer`, { method: 'POST', body: JSON.stringify({
        reason: box.querySelector('.finding-defer-reason').value, revisitDate: box.querySelector('.finding-defer-date').value,
      }) });
      toast('Finding deferred');
      renderAssetDetail({ id }, container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelectorAll('.finding-dismiss-save').forEach((btn) => btn.addEventListener('click', async () => {
    const box = container.querySelector(`.finding-dismiss-box[data-id="${btn.dataset.id}"]`);
    try {
      await api(`/api/pg/condition-findings/${btn.dataset.id}/dismiss`, { method: 'POST', body: JSON.stringify({ note: box.querySelector('.finding-dismiss-note').value }) });
      toast('Finding dismissed');
      renderAssetDetail({ id }, container);
    } catch (err) { toast(err.message); }
  }));
}

// A direct entry point for the "audit every building" workflow — skips the
// Locations -> asset -> Asset Detail -> Start Audit detour when you already
// know (or want to search for) the asset by name. Picking one hands straight
// off to the same renderAudit used from Asset Detail; nothing about the audit
// form itself changes.
// Build Brief v2 Phase 7 (§7.2) — the end-of-walkthrough screen: every open
// finding for this asset, listed with a checkbox and a pre-filled line
// title from its template. Untick anything not going on this WO. One button
// creates the WO with one job line per checked finding, each carrying its
// condition_finding_id so Phase 3's auto-schedule fires for free.
async function renderCreateWoFromFindings({ assetId, assetName }) {
  setChrome({ title: 'Create WO from Findings', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const { findings } = await api(`/api/pg/assets/${assetId}/open-findings-for-wo`);

  if (!findings.length) {
    app.innerHTML = `<div class="card"><h3>Create Work Order from Findings</h3><p class="muted">No open findings for ${escapeHtml(assetName)}.</p></div>`;
    return;
  }

  app.innerHTML = `
    <div class="card">
      <h3>Create Work Order from Findings — ${escapeHtml(assetName)}</h3>
      <p class="muted">Every open finding for this asset, pre-filled from its template where one matches. Untick anything not going on this WO — funding and responsibility get fine-tuned afterward on the WO screen, where there's a keyboard.</p>
      <form id="cwfForm">
        ${findings.map((f) => `
          <div class="card" style="background:transparent;border:1px solid var(--border,#ccc)">
            <label style="display:flex;align-items:flex-start;gap:8px;font-weight:400;cursor:pointer">
              <input type="checkbox" class="cwf-check" data-id="${f.Id}" checked style="margin-top:4px;width:18px;height:18px;flex-shrink:0" />
              <span style="flex:1">
                <div class="muted" style="font-size:0.8rem">${escapeHtml(f.Severity || '')}${f.Description ? ` · ${escapeHtml(f.Description)}` : ''}</div>
                <input class="cwf-title" data-id="${f.Id}" value="${escapeHtml(f.SuggestedTitle)}" style="margin-top:6px" />
              </span>
            </label>
          </div>`).join('')}
        <button class="btn btn-primary" type="submit" style="margin-top:12px">Create Work Order</button>
      </form>
    </div>`;

  const findingById = new Map(findings.map((f) => [f.Id, f]));
  app.querySelector('#cwfForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const selections = [...app.querySelectorAll('.cwf-check:checked')].map((cb) => {
      const id = Number(cb.dataset.id);
      const f = findingById.get(id);
      const title = app.querySelector(`.cwf-title[data-id="${id}"]`).value.trim() || f.SuggestedTitle;
      return { findingId: id, title, responsibilityClass: f.SuggestedResponsibilityClass, fundingSource: f.SuggestedFundingSource, estimatedCost: f.EstimatedCost };
    });
    if (!selections.length) { toast('Check at least one finding'); return; }
    try {
      const { workOrderId } = await api(`/api/pg/assets/${assetId}/create-wo-from-findings`, { method: 'POST', body: JSON.stringify({ findings: selections }) });
      toast('Work order created');
      go('workOrderDetail', { id: workOrderId }, { replace: true });
    } catch (err) { toast(err.message); }
  });
}

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

// Audit-draft persistence (B4 fix, 2026-09-12): the walkthrough form used to
// live only in JS memory — a dropped connection, an accidental nav-away, or
// a reload lost everything typed. Keyed per asset (not one global slot) so
// two buildings in progress never collide. File objects genuinely cannot
// survive localStorage or a reload (the platform won't let a file input be
// repopulated programmatically, for security reasons) — so a draft restores
// every typed/selected field, but staged photos can only be restored as a
// filename list the user is told to re-add, not as the files themselves.
function auditDraftKey(assetId) { return `campAuditDraft:${assetId}`; }

function saveAuditDraft(assetId, assetName) {
  try {
    localStorage.setItem(auditDraftKey(assetId), JSON.stringify({ assetName, savedAt: Date.now(), ...collectAuditDraftState() }));
  } catch { /* storage unavailable/full — draft silently doesn't persist, not fatal */ }
}
function loadAuditDraft(assetId) {
  try { const raw = localStorage.getItem(auditDraftKey(assetId)); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function clearAuditDraft(assetId) {
  try { localStorage.removeItem(auditDraftKey(assetId)); } catch { /* nothing to clean up */ }
}

// Mirrors the shape the submit handler already builds (properties keyed by
// fieldKey -> {value,flagged,flagNote}) so applying a draft back and reading
// it for real submission share the same structure.
function collectAuditDraftState() {
  const properties = {};
  document.querySelectorAll('#auditForm [name^="prop_"]').forEach((el) => {
    const key = el.name.slice(5);
    const flagged = !!document.querySelector(`.flag-toggle[data-flag-for="${key}"]`)?.checked;
    const flagNote = document.querySelector(`.flag-note[data-flag-note-for="${key}"]`)?.value || '';
    properties[key] = { value: el.value, flagged, flagNote };
  });

  const componentEvents = [];
  document.querySelectorAll('#componentPromptBlock [data-component]').forEach((card) => {
    componentEvents.push({
      componentType: card.dataset.component,
      eventType: card.querySelector('.comp-event')?.value || '',
      condition: card.querySelector('.comp-condition')?.value || '',
      material: card.querySelector('.comp-material')?.value || '',
      notes: card.querySelector('.comp-notes')?.value || '',
      flagged: !!card.querySelector('.comp-flag-toggle')?.checked,
      flagNote: card.querySelector('.comp-flag-note')?.value || '',
      stagedPhotoNames: [...(card.querySelector('.comp-photo')?.files || [])].map((f) => f.name),
    });
  });

  return {
    properties,
    componentEvents,
    findingSeverity: document.querySelector('[name="findingSeverity"]')?.value || '',
    findingDescription: document.querySelector('[name="findingDescription"]')?.value || '',
    findingStagedPhotoNames: [...(document.querySelector('[name="findingPhoto"]')?.files || [])].map((f) => f.name),
    generalStagedPhotoNames: [...(document.querySelector('[name="generalPhotos"]')?.files || [])].map((f) => f.name),
  };
}

// Whether a draft has anything in it worth prompting to resume, or worth
// confirming before discarding — an untouched form (every component card at
// its default "Inspected"/blank state, nothing flagged, nothing typed)
// shouldn't trigger a resume prompt or a discard confirmation.
function auditDraftHasContent(d) {
  if (!d) return false;
  if (Object.values(d.properties || {}).some((e) => e?.value || e?.flagged)) return true;
  if ((d.componentEvents || []).some((ev) => ev.condition || ev.material || ev.notes || ev.flagged || ev.stagedPhotoNames?.length)) return true;
  if (d.findingSeverity || d.findingDescription) return true;
  if (d.generalStagedPhotoNames?.length || d.findingStagedPhotoNames?.length) return true;
  return false;
}

function applyAuditDraft(draft) {
  Object.entries(draft.properties || {}).forEach(([key, entry]) => {
    const el = document.querySelector(`#auditForm [name="prop_${key}"]`);
    if (el && entry.value) el.value = entry.value;
    if (entry.flagged) {
      const cb = document.querySelector(`.flag-toggle[data-flag-for="${key}"]`);
      if (cb) cb.checked = true;
      const noteEl = document.querySelector(`.flag-note[data-flag-note-for="${key}"]`);
      if (noteEl && entry.flagNote) noteEl.value = entry.flagNote;
    }
  });
  (draft.componentEvents || []).forEach((ev) => {
    const card = document.querySelector(`#componentPromptBlock [data-component="${CSS.escape(ev.componentType)}"]`);
    if (!card) return;
    if (ev.eventType) card.querySelector('.comp-event').value = ev.eventType;
    if (ev.condition) card.querySelector('.comp-condition').value = ev.condition;
    if (ev.material) card.querySelector('.comp-material').value = ev.material;
    if (ev.notes) card.querySelector('.comp-notes').value = ev.notes;
    if (ev.flagged) {
      const cb = card.querySelector('.comp-flag-toggle');
      if (cb) cb.checked = true;
      const noteEl = card.querySelector('.comp-flag-note');
      if (noteEl && ev.flagNote) noteEl.value = ev.flagNote;
    }
  });
  if (draft.findingSeverity) { const el = document.querySelector('[name="findingSeverity"]'); if (el) el.value = draft.findingSeverity; }
  if (draft.findingDescription) { const el = document.querySelector('[name="findingDescription"]'); if (el) el.value = draft.findingDescription; }

  // Flag-toggle checkboxes and conditional-reveal selects were set via
  // .checked/.value directly, which fires no 'change' event — re-dispatch so
  // the flag-note-wrap visibility and the property-dependency reveals (incl.
  // the component-prompt block itself) recompute against the restored state.
  document.querySelectorAll('#auditForm .flag-toggle, #auditForm .comp-flag-toggle').forEach((cb) => cb.dispatchEvent(new Event('change')));
  document.querySelectorAll('#auditForm select[name^="prop_"]').forEach((el) => el.dispatchEvent(new Event('change')));

  const staged = [
    ...(draft.generalStagedPhotoNames || []),
    ...(draft.findingStagedPhotoNames || []),
    ...(draft.componentEvents || []).flatMap((ev) => ev.stagedPhotoNames || []),
  ];
  if (staged.length) {
    toast(`Restored your answers. ${staged.length} staged photo${staged.length === 1 ? '' : 's'} couldn't survive the reload (${staged.join(', ')}) — please re-add them.`, 8000);
  } else {
    toast('Resumed your in-progress audit.');
  }
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
          <div class="field-row"><label>Photo (optional)</label><input type="file" class="comp-photo" accept="image/*" multiple /></div>
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
          <div class="field-row"><label>General condition photos</label><input type="file" name="generalPhotos" accept="image/*" multiple /></div>
        </div>
        <div class="card">
          <h3>Report a Finding (optional)</h3>
          <div class="field-row"><label>Severity</label>
            <select name="findingSeverity"><option value="">— none —</option>${(state.options.findingSeverity || []).map((s) => `<option>${escapeHtml(s)}</option>`).join('')}</select>
          </div>
          <div class="field-row"><label>Description</label><textarea name="findingDescription"></textarea></div>
          <div class="field-row"><label>Photo (optional)</label><input type="file" name="findingPhoto" accept="image/*" multiple /></div>
        </div>
        <div class="card" id="auditUploadStatus" hidden style="border-left:4px solid #c0392b;background:#c0392b0d"></div>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit" id="auditSubmitBtn">Submit Audit</button>
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

  // Resume-or-discard: check for a draft from an earlier interrupted attempt
  // at this SAME asset before wiring autosave, so applying it doesn't count
  // as new user input. An empty/untouched draft (e.g. one saved the instant
  // the page loaded, before anything was typed) is discarded silently —
  // nothing to ask about.
  const existingDraft = loadAuditDraft(id);
  if (auditDraftHasContent(existingDraft)) {
    const when = new Date(existingDraft.savedAt).toLocaleString();
    const resume = await confirmDialog(
      `Resume in-progress audit for "${asset.Name}"? You have unsaved answers from ${when}.`,
      { confirmLabel: 'Resume', cancelLabel: 'Discard', danger: false }
    );
    if (resume) applyAuditDraft(existingDraft);
    else clearAuditDraft(id);
  } else if (existingDraft) {
    clearAuditDraft(id); // stale empty draft — clean it up rather than leave it
  }

  // Autosave — debounced so a fast typist doesn't write to localStorage on
  // every keystroke. Wired after the resume/discard decision above so
  // restoring a draft doesn't immediately re-save over itself mid-decision.
  let draftSaveTimer;
  document.getElementById('auditForm').addEventListener('input', () => {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => saveAuditDraft(id, asset.Name), 400);
  });
  document.getElementById('auditForm').addEventListener('change', () => {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => saveAuditDraft(id, asset.Name), 400);
  });

  document.getElementById('cancelAuditBtn').addEventListener('click', async () => {
    if (auditDraftHasContent(collectAuditDraftState())) {
      const discard = await confirmDialog('Discard this in-progress audit? Your answers and staged photos will be lost.', { confirmLabel: 'Discard', cancelLabel: 'Keep editing' });
      if (!discard) return;
    }
    clearAuditDraft(id);
    goBack();
  });

  // uploadTracker lives for the lifetime of this render — survives repeated
  // submit clicks within the same page load (a failed submit followed by
  // clicking Submit again, i.e. "retry") but not a reload, same scope as the
  // File objects it's keyed against (see uploadSectionResumable's comment).
  const uploadTracker = new Map();
  const uploadStatusEl = document.getElementById('auditUploadStatus');
  const submitBtn = document.getElementById('auditSubmitBtn');
  function showUploadFailures(failureLines, succeededSoFar) {
    uploadStatusEl.hidden = false;
    uploadStatusEl.innerHTML = `
      <strong>${failureLines.length} photo${failureLines.length === 1 ? '' : 's'} failed to upload:</strong>
      <ul style="margin:6px 0 0;padding-left:20px">${failureLines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
      <p class="muted" style="margin-top:8px">${succeededSoFar} photo${succeededSoFar === 1 ? '' : 's'} already uploaded successfully and won't be re-sent. Everything else on this form is unaffected — fix your connection if needed, then tap Retry.</p>`;
    submitBtn.textContent = `Retry failed uploads (${failureLines.length})`;
  }
  function clearUploadFailures() {
    uploadStatusEl.hidden = true;
    uploadStatusEl.innerHTML = '';
    submitBtn.textContent = 'Submit Audit';
  }

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

    // Gather what's touched first, upload second — deciding which component
    // cards even count never depends on whether their photos happen to
    // upload cleanly.
    const touchedCards = [];
    for (const card of document.querySelectorAll('#componentPromptBlock [data-component]')) {
      const condition = card.querySelector('.comp-condition').value;
      const eventType = card.querySelector('.comp-event').value;
      const material = card.querySelector('.comp-material').value;
      const notes = card.querySelector('.comp-notes').value;
      const flagged = !!card.querySelector('.comp-flag-toggle')?.checked;
      const flagNote = flagged ? (card.querySelector('.comp-flag-note')?.value.trim() || null) : null;
      const photoFiles = [...(card.querySelector('.comp-photo')?.files || [])].filter((f) => f && f.size);
      if (!condition && !material && !notes && !flagged && !photoFiles.length) continue; // skip untouched component cards
      touchedCards.push({ componentType: card.dataset.component, eventType, condition, material, notes, flagged, flagNote, photoFiles });
    }

    const severity = fd.get('findingSeverity');
    const description = fd.get('findingDescription');
    const wantsFinding = !!(severity && description);
    const findingPhotos = fd.getAll('findingPhoto').filter((f) => f && f.size);
    const generalPhotoFiles = fd.getAll('generalPhotos').filter((f) => f && f.size);

    submitBtn.disabled = true;
    try {
      // Upload phase — every section attempted, failures collected rather
      // than thrown, so one bad file never blocks the rest of the batch and
      // never discards the ones that already succeeded (uploadTracker).
      const failureLines = [];
      const componentEvents = [];
      for (const c of touchedCards) {
        const { attachmentIds, failures } = await uploadSectionResumable(c.photoFiles, 'components', id, `component:${c.componentType}`, uploadTracker);
        failures.forEach((f) => failureLines.push(`${c.componentType} — ${f.name}`));
        componentEvents.push({ componentType: c.componentType, eventType: c.eventType, condition: c.condition, material: c.material, notes: c.notes, flagged: c.flagged, flagNote: c.flagNote, attachmentIds });
      }
      let finding = null;
      if (wantsFinding) {
        const { attachmentIds, failures } = await uploadSectionResumable(findingPhotos, 'findings', id, 'finding', uploadTracker);
        failures.forEach((f) => failureLines.push(`Finding photo — ${f.name}`));
        finding = { severity, description, attachmentIds };
      }
      const { attachmentIds: generalAttachmentIds, failures: generalFailures } = await uploadSectionResumable(generalPhotoFiles, 'asset-photos', id, 'general', uploadTracker);
      generalFailures.forEach((f) => failureLines.push(`General photo — ${f.name}`));

      if (failureLines.length) {
        showUploadFailures(failureLines, uploadTracker.size);
        return; // nothing submitted yet — successful uploads are kept in uploadTracker for the next attempt
      }
      clearUploadFailures();

      await api(`/api/pg/assets/${id}/audit`, { method: 'POST', body: JSON.stringify({ properties: propertiesOut, componentEvents, finding, generalAttachmentIds }) });
      clearAuditDraft(id);
      toast('Audit submitted');
      state.stack.pop(); // drop this audit entry
      go('assetDetail', { id }, { replace: true });
    } catch (err) { toast(err.message); }
    finally { submitBtn.disabled = false; }
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
        <div id="compPhotos-${h.Id}" style="margin-top:6px"></div>
      </div>` : `
      <div class="card">
        <div><strong>${escapeHtml(h.Label)}</strong> changed</div>
        <div class="muted">${escapeHtml(h['Old Value'] ?? '—')} → <strong>${escapeHtml(h['New Value'] ?? '—')}</strong></div>
        <div class="muted">${new Date(h.ChangedAt).toLocaleString()}${h.ChangedBy ? ` · ${escapeHtml(h.ChangedBy)}` : ''}</div>
      </div>`).join('') : '<p class="muted">No history yet.</p>');

  history.forEach((h) => renderAttachmentSection('asset_component', h.Id, app.querySelector(`#compPhotos-${h.Id}`), { title: 'Photos', defaultRoleName: 'Evidence', inheritedClassification: h['Component Type'] }));
}

// ---------- Interactive Map ----------
// Pins are assets with map_x/map_y set (image-pixel coords on the base map
// image below, top-left origin — never lat/lng). Every point/line/zone
// dropped on the map — Electrical, Trash, Water valves, Sewer, or anything
// invented later — belongs to a map_layer (name/color/icon/z-order/
// visibility/condition-coloring): layers are DATA managed entirely from
// this UI, never hardcoded here. A marker's color is a flat layer color
// unless its layer has "color by condition" on AND it's linked to a real
// asset, in which case it's derived live from that asset's worst open
// condition_findings.severity — never stored. Every edit (drag, reshape,
// add, delete, layer CRUD) writes straight through to the API on its own —
// there's no separate "Save" step to remember.
//
// Base map image — the ONE place this is configured (viewBox, the <image>
// element, and the "Fit map" reset all read from this, not their own copies)
// so swapping the image file is a one-line change here plus dropping the new
// file in this directory. Width/height MUST match the file's actual pixel
// dimensions or the SVG <image> element stretches it to fit, distorting the
// image. Swapping the file does NOT move any existing map_x/map_y pin, map
// feature, or GPS calibration point — those are pixel coordinates against
// whatever image was loaded when they were placed, so a new image with a
// different frame/scale/orientation leaves them all pointing at the wrong
// spot until someone repositions them by hand.
const CAMP_MAP_IMAGE = { href: 'camp-map-2026-09.png', width: 3000, height: 1808 };
const MAP_SWATCHES = ['#2b6cb0', '#8a6d3b', '#5c8a4e', '#c0433a', '#d0902a', '#6b4fa0', '#4b6b5c', '#8a8272'];
const MAP_SEVERITY_COLORS = { none: '#0ca30c', warn: '#fab219', serious: '#ec835a', critical: '#d03b3b' };
const MAP_GEOM_LABEL = { point: 'points', line: 'lines', zone: 'zones', mixed: 'mixed' };

async function renderMap() {
  setChrome({ title: 'Interactive Map', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const [{ pins }, { features }, { layers }] = await Promise.all([
    api('/api/pg/map/pins'),
    api('/api/pg/map-features'),
    api('/api/pg/map/layers'),
  ]);

  app.innerHTML = `
    <div class="map-view">
      <aside class="map-side">
        <div class="map-grp">
          <h2>Tools</h2>
          <div class="map-tools" id="mapTools"></div>
          <div class="map-hint" id="mapHint"><b>Edit:</b> drag a marker or shape to move it. Drag a shape's dots to reshape; click a faint midpoint to add a point; double-click a point to remove it. Scroll to zoom, drag empty space to pan.</div>
        </div>
        <div class="map-grp" id="mapAssetPicker" hidden>
          <h2>Place an asset</h2>
          <input type="text" class="map-search" id="mapAssetSearch" placeholder="Search assets by name…" autocomplete="off">
          <div id="mapAssetResults"></div>
        </div>
        <div class="map-grp">
          <h2>Base</h2>
          <label class="map-lyr"><input type="checkbox" id="mapBaseToggle" checked> Base map</label>
          <div class="map-row2"><span class="muted" style="font-size:11px">Dim</span><input type="range" id="mapDim" min="0" max="100" value="0"></div>
          <label class="map-lyr"><input type="checkbox" id="mapLabelsToggle" checked> Labels</label>
        </div>
        <div class="map-grp">
          <h2>Pin labels</h2>
          <div class="map-tools" id="mapLabelMode">
            <button type="button" class="map-tool" data-label-mode="asset">Asset name</button>
            <button type="button" class="map-tool" data-label-mode="holder">Cabin holder</button>
          </div>
        </div>
        <div class="map-grp" id="mapLayersGrp">
          <button type="button" class="map-layers-toggle" id="mapLayersBtn">
            <span>Layers</span>
            <span class="map-layers-count muted" id="mapLayersCount"></span>
            <span class="map-layers-chevron">▾</span>
          </button>
        </div>
        <div class="map-grp">
          <h2>Legend</h2>
          <div class="map-legend-item"><span class="map-legend-dot" style="background:${MAP_SEVERITY_COLORS.none}"></span>No open findings</div>
          <div class="map-legend-item"><span class="map-legend-dot" style="background:${MAP_SEVERITY_COLORS.warn}"></span>Minor / monitor</div>
          <div class="map-legend-item"><span class="map-legend-dot" style="background:${MAP_SEVERITY_COLORS.serious}"></span>Moderate / major</div>
          <div class="map-legend-item"><span class="map-legend-dot" style="background:${MAP_SEVERITY_COLORS.critical}"></span>Safety-critical</div>
          <div class="map-legend-item"><span class="map-legend-dot" style="background:#fff;border:2px solid #d4af37"></span>Flagged for board</div>
          <div class="muted" style="font-size:11px;margin-top:4px">Condition colors apply on layers with "color by condition" on, for markers linked to an asset.</div>
        </div>
        <div class="map-grp" id="mapInfo"><h2>Selected</h2><div class="muted">Click a marker or shape to select it.</div></div>
      </aside>
      <div class="map-layers-popover" id="mapLayersPopover" hidden>
        <div class="map-layers-popover-head">
          <h2>Layers</h2>
          <button type="button" class="map-layers-close" id="mapLayersClose" aria-label="Close">✕</button>
        </div>
        <div id="mapLayerRows"></div>
        <div class="map-add-layer" id="mapAddLayerForm" hidden>
          <input type="text" class="map-search" id="newLayerName" placeholder="Layer name" style="margin-bottom:6px">
          <div class="map-info-row">
            <select class="map-search" id="newLayerGeom" style="flex:1">
              <option value="point">Points</option>
              <option value="line">Lines</option>
              <option value="zone">Zones</option>
              <option value="mixed">Mixed</option>
            </select>
            <input type="text" class="map-search" id="newLayerIcon" placeholder="🔧" maxlength="2" style="width:52px">
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px" id="newLayerSwatches">
            ${MAP_SWATCHES.map((c) => `<button type="button" class="map-swatch" data-color="${c}" style="background:${c}"></button>`).join('')}
          </div>
          <label class="map-lyr" style="margin-bottom:8px"><input type="checkbox" id="newLayerCond"> Color by condition (asset-linked)</label>
          <button type="button" class="btn btn-primary" id="newLayerCreate" style="width:100%">Create layer</button>
        </div>
        <button type="button" class="btn btn-secondary" id="mapAddLayerBtn" style="width:100%;margin-top:8px">+ Add layer</button>
      </div>
      <div class="map-stage">
        <svg id="mapSvg" viewBox="0 0 ${CAMP_MAP_IMAGE.width} ${CAMP_MAP_IMAGE.height}" preserveAspectRatio="xMidYMid meet"></svg>
        <button type="button" id="mapFinish" class="btn btn-primary map-finish">Finish shape (Enter)</button>
        <div class="map-zoom">
          <button type="button" id="mapZin" title="Zoom in">+</button>
          <button type="button" id="mapZout" title="Zoom out">–</button>
          <button type="button" id="mapFit" title="Fit map">⤢</button>
        </div>
      </div>
    </div>`;

  initMapEditor({ pins, features, layers });
}

function initMapEditor({ pins, features, layers }) {
  const svg = document.getElementById('mapSvg');
  const NS = 'http://www.w3.org/2000/svg';
  const E = (t, a, p) => { const n = document.createElementNS(NS, t); for (const k in a) n.setAttribute(k, a[k]); if (p) p.appendChild(n); return n; };

  const gBase = E('g', {}, svg);
  const baseImg = E('image', { href: CAMP_MAP_IMAGE.href, x: 0, y: 0, width: CAMP_MAP_IMAGE.width, height: CAMP_MAP_IMAGE.height }, gBase);
  const gLabels = E('g', {}, svg);
  const gHandles = E('g', {}, svg);

  // Local mirror of server state — every mutation below writes through to
  // the API immediately (drag-end, finish-shape, delete, layer edits, ...);
  // these arrays just let the SVG re-render instantly without waiting on
  // the round trip.
  function normalizeFeature(f) {
    return {
      id: f.Id, kind: f.Kind, label: f.Label, points: f.Points, assetId: f.AssetId, layerId: f.LayerId,
      style: f.Style || {}, assetName: f.AssetName, holderName: f.HolderName,
      openFindingCount: Number(f.OpenFindingCount) || 0, maxSeverity: f.MaxSeverity, boardFocus: f.BoardFocus,
    };
  }
  let mapPins = pins.map((p) => ({ ...p }));
  let mapFeatures = features.map(normalizeFeature);
  let mapLayers = layers.map((l) => ({ ...l }));

  let layerGroups = {}; // layerId -> <g>, kept in z-order between gBase and gLabels
  let orphanGroup = null; // features whose layer was deleted
  let buildingsFallbackGroup = null; // building pins if the "Buildings" layer was deleted

  let selected = null; // { type: 'pin'|'feature', ref }
  let mode = 'edit';
  let pending = null; // { kind, layerId, pts: [[x,y],...] } while drawing a new line/zone
  let placingAsset = null; // asset chosen from the picker, waiting for a map click
  let labelMode = (() => { try { return localStorage.getItem('campMapLabelMode') === 'holder' ? 'holder' : 'asset'; } catch { return 'asset'; } })();

  function layerById(id) { return mapLayers.find((l) => l.Id === id); }

  function bucketOf(sev) {
    if (sev == null) return 'none';
    if (sev <= 2) return 'warn';
    if (sev <= 4) return 'serious';
    return 'critical';
  }
  function pinColor(pin) {
    const layer = layerById(pin.layerId);
    if (layer && !layer.ColorByCondition) return layer.Color;
    return MAP_SEVERITY_COLORS[bucketOf(pin.maxSeverity)];
  }
  function featureColor(f) {
    const layer = layerById(f.layerId);
    if (!layer) return '#5c8a4e';
    if (layer.ColorByCondition && f.assetId) return MAP_SEVERITY_COLORS[bucketOf(f.maxSeverity)];
    return layer.Color;
  }
  function featureWeight(f) { return f.kind === 'zone' ? 2 : 4; }
  function labelOf(pin) { return labelMode === 'holder' ? (pin.holderName || pin.name) : pin.name; }
  // Labels live in one shared gLabels group (so they always paint above
  // every shape/marker, regardless of layer z-order) — which means hiding a
  // layer only hides its own group, not the labels drawn alongside it. Skip
  // adding a label at all for anything on a hidden layer, or it's left
  // floating on the map with no marker under it.
  function layerVisible(layerId) {
    if (!layerId) return true;
    const l = layerById(layerId);
    return !l || l.DefaultVisible !== false;
  }
  function dOf(pts, closed) { return 'M' + pts.map((p) => p.join(',')).join(' L ') + (closed ? ' Z' : ''); }
  // Whenever the stage's aspect ratio doesn't exactly match CAMP_MAP_IMAGE's,
  // preserveAspectRatio="xMidYMid meet" letterboxes it — the SVG element's
  // own bounding box is wider (or taller) than the image actually rendered
  // inside it. Screen<->map conversions have to go through the fitted rect
  // (the box the image is actually drawn into), not the raw element bounding
  // box, or every click/drag lands off by the letterbox margin.
  function fittedRect() {
    const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    const fscale = Math.min((r.width || 1) / vb.width, (r.height || 1) / vb.height) || 1;
    const w = vb.width * fscale, h = vb.height * fscale;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, scale: fscale };
  }
  function scale() { return 1 / fittedRect().scale; } // map units per rendered screen px

  // Layer groups are rebuilt (removed + recreated in z-order) only when the
  // layer set itself changes (add/delete/reorder) — render() just clears
  // and repopulates their children, so drags/pans stay cheap.
  function rebuildLayerGroups() {
    Object.values(layerGroups).forEach((g) => g.remove());
    if (orphanGroup) orphanGroup.remove();
    if (buildingsFallbackGroup) buildingsFallbackGroup.remove();
    layerGroups = {};
    orphanGroup = E('g', {}, svg);
    svg.insertBefore(orphanGroup, gLabels);
    [...mapLayers].sort((a, b) => a.ZIndex - b.ZIndex).forEach((l) => {
      const g = E('g', { 'data-layer-id': l.Id }, svg);
      svg.insertBefore(g, gLabels);
      layerGroups[l.Id] = g;
    });
    buildingsFallbackGroup = E('g', {}, svg);
    svg.insertBefore(buildingsFallbackGroup, gLabels);
  }

  function render() {
    const s = scale();
    Object.values(layerGroups).forEach((g) => { g.innerHTML = ''; });
    orphanGroup.innerHTML = ''; buildingsFallbackGroup.innerHTML = '';
    gLabels.innerHTML = ''; gHandles.innerHTML = '';

    mapFeatures.forEach((f) => {
      const grp = (f.layerId && layerGroups[f.layerId]) || orphanGroup;
      const g = E('g', { class: 'feat', 'data-kind': 'feature', 'data-id': f.id }, grp);
      const isSel = selected && selected.type === 'feature' && selected.ref.id === f.id;
      const color = featureColor(f);
      const showLabel = layerVisible(f.layerId);
      if (f.kind === 'zone') {
        E('path', { d: dOf(f.points, true), fill: color + '3d', stroke: color, 'stroke-width': (isSel ? featureWeight(f) + 1.5 : featureWeight(f)) * s }, g);
        if (f.label && showLabel) {
          const mid = f.points[Math.floor(f.points.length / 2)];
          const lab = E('text', { x: mid[0], y: mid[1] - 8 * s, fill: '#20321f', 'font-size': 13 * s, 'text-anchor': 'middle', 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 3 * s }, gLabels);
          lab.textContent = f.label;
        }
      } else if (f.kind === 'line') {
        E('path', { d: dOf(f.points, false), fill: 'none', stroke: color, 'stroke-width': (isSel ? featureWeight(f) + 1.5 : featureWeight(f)) * s, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
        if (f.label && showLabel) {
          const mid = f.points[Math.floor(f.points.length / 2)];
          const lab = E('text', { x: mid[0], y: mid[1] - 8 * s, fill: '#20321f', 'font-size': 13 * s, 'text-anchor': 'middle', 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 3 * s }, gLabels);
          lab.textContent = f.label;
        }
      } else {
        const p = f.points[0] || [0, 0];
        const r = 13 * s;
        const layer = layerById(f.layerId);
        E('circle', { cx: p[0], cy: p[1], r, fill: color, stroke: isSel ? '#ffe08a' : '#fff', 'stroke-width': (isSel ? 4 : 2.5) * s }, g);
        if (layer?.Icon) {
          const t = E('text', { x: p[0], y: p[1], 'font-size': 14 * s, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
          t.textContent = layer.Icon;
        }
        if (showLabel) {
          const lab = E('text', { x: p[0] + r + 4 * s, y: p[1] + 5 * s, fill: '#20321f', 'font-size': 13 * s, 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 3 * s }, gLabels);
          lab.textContent = (labelMode === 'holder' ? f.holderName : null) || f.label || '';
        }
      }
    });

    mapPins.forEach((pin) => {
      const grp = (pin.layerId && layerGroups[pin.layerId]) || buildingsFallbackGroup;
      const g = E('g', { class: 'feat', 'data-kind': 'pin', 'data-id': pin.id }, grp);
      const isSel = selected && selected.type === 'pin' && selected.ref.id === pin.id;
      const r = 15 * s;
      if (pin.boardFocus) E('circle', { cx: pin.mapX, cy: pin.mapY, r: r + 5 * s, fill: 'none', stroke: '#d4af37', 'stroke-width': 2.5 * s, 'stroke-dasharray': `${4 * s},${3 * s}` }, g);
      E('circle', { cx: pin.mapX, cy: pin.mapY, r, fill: pinColor(pin), stroke: isSel ? '#ffe08a' : '#fff', 'stroke-width': (isSel ? 4 : 2.5) * s }, g);
      if (pin.openFindingCount) {
        const t = E('text', { x: pin.mapX, y: pin.mapY, fill: '#fff', 'font-weight': '700', 'font-size': 13 * s, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
        t.textContent = String(pin.openFindingCount);
      }
      if (layerVisible(pin.layerId)) {
        const lab = E('text', { x: pin.mapX + r + 4 * s, y: pin.mapY + 5 * s, fill: '#20321f', 'font-size': 14 * s, 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 3 * s }, gLabels);
        lab.textContent = labelOf(pin);
      }
    });

    if (pending) {
      const layer = layerById(pending.layerId);
      const color = layer?.Color || '#5c8a4e';
      const closed = pending.kind === 'zone';
      const grp = (pending.layerId && layerGroups[pending.layerId]) || orphanGroup;
      E('path', { d: 'M' + pending.pts.map((p) => p.join(',')).join(' L ') + (closed ? ' Z' : ''), fill: closed ? color + '33' : 'none', stroke: color, 'stroke-width': 4 * s, 'stroke-dasharray': `${8 * s} ${6 * s}` }, grp);
      pending.pts.forEach((p) => E('circle', { cx: p[0], cy: p[1], r: 5 * s, fill: color }, gHandles));
    }

    drawHandles(s);
    applyVisibility();
  }

  function drawHandles(s) {
    if (!selected || selected.type !== 'feature' || selected.ref.kind === 'point') return;
    const pts = selected.ref.points, n = pts.length;
    const closed = selected.ref.kind === 'zone';
    const segCount = closed ? n : n - 1;
    const color = featureColor(selected.ref);
    for (let i = 0; i < segCount; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      E('circle', { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, r: 6 * s, class: 'handle', fill: color, opacity: 0.55, 'data-mid': i }, gHandles);
    }
    pts.forEach((p, i) => E('circle', { cx: p[0], cy: p[1], r: 8 * s, class: 'handle', fill: '#fff', stroke: color, 'stroke-width': 2.5 * s, 'data-vtx': i }, gHandles));
  }

  function applyVisibility() {
    mapLayers.forEach((l) => { const g = layerGroups[l.Id]; if (g) g.style.display = l.DefaultVisible ? '' : 'none'; });
    gBase.style.display = document.getElementById('mapBaseToggle')?.checked === false ? 'none' : '';
    gLabels.style.display = document.getElementById('mapLabelsToggle')?.checked === false ? 'none' : '';
  }

  function toMap(e) {
    const f = fittedRect(), vb = svg.viewBox.baseVal;
    return { x: vb.x + (e.clientX - f.left) / f.scale, y: vb.y + (e.clientY - f.top) / f.scale };
  }

  // ---- pointer interaction ----
  let pan = null, drag = null;
  svg.addEventListener('pointerdown', (e) => {
    // A click that lands on a marker/label sets pointer capture below, which
    // retargets the follow-up 'click' event away from its real target — the
    // document-level outside-click listener for the layers popover can't
    // reliably see those, so close it straight from here instead.
    const layersPopover = document.getElementById('mapLayersPopover');
    if (layersPopover && !layersPopover.hidden) toggleLayersPopover(false);
    const m = toMap(e);
    if (mode === 'add-asset') { if (placingAsset) placeAssetAt(m); return; }
    if (mode.startsWith('add-layer:')) {
      const [, layerIdStr, geom] = mode.split(':');
      const layer = layerById(Number(layerIdStr));
      if (!layer) { setMode('edit'); return; }
      if (geom === 'point') { placeLayerPointAt(m, layer); return; }
      addPointToPending(m, layer, geom);
      return;
    }
    const h = e.target.closest('.handle');
    if (h && selected && selected.type === 'feature') {
      svg.setPointerCapture(e.pointerId);
      const pts = selected.ref.points;
      if (h.dataset.mid != null) {
        const i = +h.dataset.mid;
        pts.splice(i + 1, 0, [Math.round(m.x), Math.round(m.y)]);
        drag = { k: 'vtx', i: i + 1, kind: 'feature' };
        render();
      } else {
        drag = { k: 'vtx', i: +h.dataset.vtx, kind: 'feature' };
      }
      return;
    }
    const fe = e.target.closest('.feat');
    if (fe) {
      const kind = fe.dataset.kind, id = fe.dataset.id;
      if (kind === 'pin') {
        const pin = mapPins.find((p) => String(p.id) === id);
        select({ type: 'pin', ref: pin });
        svg.setPointerCapture(e.pointerId);
        drag = { k: 'body', kind: 'pin', start: m, snap: { x: pin.mapX, y: pin.mapY } };
      } else {
        const f = mapFeatures.find((x) => String(x.id) === id);
        select({ type: 'feature', ref: f });
        svg.setPointerCapture(e.pointerId);
        drag = { k: 'body', kind: 'feature', start: m, snap: f.points.map((p) => p.slice()) };
      }
      return;
    }
    select(null);
    // SVGRect's x/y/width/height are prototype accessors, not own enumerable
    // properties, so a plain object spread ({...baseVal}) silently drops
    // them — snapshot explicitly or the pan below writes NaN into the
    // viewBox the moment a move event fires.
    const vb0 = svg.viewBox.baseVal;
    pan = { x: e.clientX, y: e.clientY, vb: { x: vb0.x, y: vb0.y, width: vb0.width, height: vb0.height } };
    svg.classList.add('panning');
  });

  svg.addEventListener('pointermove', (e) => {
    if (drag) {
      const m = toMap(e);
      if (drag.kind === 'pin') {
        const pin = selected.ref;
        if (drag.k === 'vtx') { pin.mapX = Math.round(m.x); pin.mapY = Math.round(m.y); }
        else { const dx = m.x - drag.start.x, dy = m.y - drag.start.y; pin.mapX = Math.round(drag.snap.x + dx); pin.mapY = Math.round(drag.snap.y + dy); }
      } else {
        const f = selected.ref;
        if (drag.k === 'vtx') { f.points[drag.i] = [Math.round(m.x), Math.round(m.y)]; }
        else { const dx = m.x - drag.start.x, dy = m.y - drag.start.y; f.points = drag.snap.map((p) => [Math.round(p[0] + dx), Math.round(p[1] + dy)]); }
      }
      render();
      return;
    }
    if (pan) {
      // Mutating the viewBox alone repaints the pan natively — no need to
      // rebuild every element on each move (panning never changes vb.width/
      // height, so scale()/render() output wouldn't change anyway).
      const f = fittedRect(), vb = svg.viewBox.baseVal;
      vb.x = pan.vb.x - (e.clientX - pan.x) / f.scale;
      vb.y = pan.vb.y - (e.clientY - pan.y) / f.scale;
    }
  });

  async function endDrag() {
    if (!drag) return;
    const wasKind = drag.kind, ref = selected?.ref;
    drag = null;
    if (ref && wasKind === 'pin') {
      try { await api(`/api/pg/map/pins/${ref.id}`, { method: 'PATCH', body: JSON.stringify({ mapX: ref.mapX, mapY: ref.mapY }) }); toast('Pin moved'); }
      catch (err) { toast(err.message); }
    } else if (ref && wasKind === 'feature') {
      try { await api(`/api/pg/map-features/${ref.id}`, { method: 'PATCH', body: JSON.stringify({ points: ref.points }) }); toast('Shape updated'); }
      catch (err) { toast(err.message); }
    }
    if (selected) openInfo();
  }
  svg.addEventListener('pointerup', () => { const had = !!drag; pan = null; svg.classList.remove('panning'); if (had) endDrag(); });
  svg.addEventListener('pointercancel', () => { drag = null; pan = null; svg.classList.remove('panning'); });

  svg.addEventListener('dblclick', async (e) => {
    const h = e.target.closest('.handle');
    if (h && h.dataset.vtx != null && selected && selected.type === 'feature' && selected.ref.points.length > 2) {
      selected.ref.points.splice(+h.dataset.vtx, 1);
      render();
      try { await api(`/api/pg/map-features/${selected.ref.id}`, { method: 'PATCH', body: JSON.stringify({ points: selected.ref.points }) }); }
      catch (err) { toast(err.message); }
      return;
    }
    if (pending && pending.pts.length > 1) finishPending();
  });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const vb = svg.viewBox.baseVal;
    const { x: mx, y: my } = toMap(e);
    const f = e.deltaY > 0 ? 1.12 : 0.89;
    vb.x = mx - (mx - vb.x) * f; vb.y = my - (my - vb.y) * f;
    vb.width *= f; vb.height *= f;
    render();
  }, { passive: false });

  function addPointToPending(m, layer, geom) {
    const x = Math.round(m.x), y = Math.round(m.y);
    if (!pending) pending = { kind: geom, layerId: layer.Id, pts: [] };
    pending.pts.push([x, y]);
    document.getElementById('mapFinish').style.display = 'block';
    render();
  }
  async function finishPending() {
    if (!pending) return;
    const { kind, layerId, pts } = pending;
    const layer = layerById(layerId);
    try {
      const { feature } = await api('/api/pg/map-features', { method: 'POST', body: JSON.stringify({ kind, label: layer?.Name || kind, points: pts, layerId }) });
      pending = null;
      document.getElementById('mapFinish').style.display = 'none';
      setMode('edit');
      mapFeatures.push(normalizeFeature(feature));
      select({ type: 'feature', ref: mapFeatures[mapFeatures.length - 1] });
      toast('Shape saved — rename it at left if you like');
    } catch (err) { toast(err.message); }
  }
  document.getElementById('mapFinish').addEventListener('click', finishPending);

  async function placeLayerPointAt(m, layer) {
    const x = Math.round(m.x), y = Math.round(m.y);
    try {
      const { feature } = await api('/api/pg/map-features', { method: 'POST', body: JSON.stringify({ kind: 'point', label: layer.Name, points: [[x, y]], layerId: layer.Id }) });
      mapFeatures.push(normalizeFeature(feature));
      setMode('edit');
      select({ type: 'feature', ref: mapFeatures[mapFeatures.length - 1] });
      toast(`${layer.Name} marker added — rename it at left if you like`);
    } catch (err) { toast(err.message); }
  }

  async function placeAssetAt(m) {
    const asset = placingAsset;
    const x = Math.round(m.x), y = Math.round(m.y);
    try {
      const { pin: updated } = await api(`/api/pg/map/pins/${asset.Id}`, { method: 'PATCH', body: JSON.stringify({ mapX: x, mapY: y }) });
      let pin = mapPins.find((p) => p.id === asset.Id);
      if (pin) { pin.mapX = x; pin.mapY = y; pin.layerId = updated.LayerId; }
      else {
        mapPins.push({ ref: 'asset', id: asset.Id, name: asset.Name, category: asset.assetType, mapX: x, mapY: y, layerId: updated.LayerId, locationId: asset.locationId, locationName: asset.locationName, holderName: asset.holderName || null, openFindingCount: 0, maxSeverity: null, boardFocus: false });
        pin = mapPins[mapPins.length - 1];
      }
      placingAsset = null;
      document.getElementById('mapAssetPicker').hidden = true;
      document.getElementById('mapAssetSearch').value = '';
      document.getElementById('mapAssetResults').innerHTML = '';
      setMode('edit');
      select({ type: 'pin', ref: pin });
      toast(`${asset.Name} placed on the map`);
    } catch (err) { toast(err.message); }
  }

  // ---- selection / info panel ----
  function select(sel) { selected = sel; render(); openInfo(); }
  function openInfo() {
    const box = document.getElementById('mapInfo');
    if (!selected) { box.innerHTML = '<h2>Selected</h2><div class="muted">Click a marker or shape to select it.</div>'; return; }
    if (selected.type === 'pin') {
      const p = selected.ref;
      const bucket = bucketOf(p.maxSeverity);
      const sevLabel = { none: 'No open findings', warn: 'Minor / monitor', serious: 'Moderate / major', critical: 'Safety-critical' }[bucket];
      box.innerHTML = `<h2>Selected</h2>
        <div style="font-weight:700;font-size:0.95rem;margin-bottom:2px">${escapeHtml(p.name)}</div>
        <div class="muted" style="margin-bottom:10px">${escapeHtml(p.category || 'Asset')}${p.locationName ? ' · ' + escapeHtml(p.locationName) : ''}</div>
        <div class="map-info-row"><span class="map-legend-dot" style="background:${MAP_SEVERITY_COLORS[bucket]}"></span><span style="font-size:0.82rem">${escapeHtml(sevLabel)}${p.openFindingCount ? ` (${p.openFindingCount} open)` : ''}</span></div>
        ${p.boardFocus ? '<div class="map-info-row" style="color:#a4801a;font-size:0.8rem">🏳 Included on board report</div>' : ''}
        ${p.holderName ? `<div class="map-info-row" style="font-size:0.8rem">🏠 Held by ${escapeHtml(p.holderName)}</div>` : ''}
        <button type="button" class="btn btn-secondary" id="mapGoAsset" style="width:100%;margin-top:6px">View asset →</button>
        <button type="button" class="btn btn-danger" id="mapRemovePin" style="width:100%;margin-top:8px">Remove from map</button>`;
      document.getElementById('mapGoAsset').addEventListener('click', () => go('assetDetail', { id: p.id }));
      document.getElementById('mapRemovePin').addEventListener('click', () => removeSelectedPin());
      return;
    }
    const f = selected.ref;
    const layer = layerById(f.layerId);
    const eligibleLayers = mapLayers.filter((l) => l.Geometry === f.kind || l.Geometry === 'mixed');
    box.innerHTML = `<h2>Selected</h2>
      <input class="map-info-name" id="mapFeatLabel" value="${escapeHtml(f.label || '')}" placeholder="Label">
      <div style="font-size:11px;color:var(--muted);margin:2px 0 6px">Layer</div>
      <select class="map-search" id="mapFeatLayer" style="width:100%;margin-bottom:10px">
        <option value="">— none —</option>
        ${eligibleLayers.map((l) => `<option value="${l.Id}" ${f.layerId === l.Id ? 'selected' : ''}>${l.Icon ? l.Icon + ' ' : ''}${escapeHtml(l.Name)}</option>`).join('')}
      </select>
      ${layer?.ColorByCondition ? `
        <div style="font-size:11px;color:var(--muted);margin:2px 0 6px">Linked asset (drives its color)</div>
        ${f.assetId ? `
          <div class="map-asset-result" style="margin-bottom:6px">
            <div>${escapeHtml(f.assetName || 'Asset #' + f.assetId)}</div>
            <div class="muted">${f.openFindingCount ? `${f.openFindingCount} open finding(s)` : 'No open findings'}</div>
          </div>
          <button type="button" class="btn btn-secondary" id="mapUnlinkAsset" style="width:100%;margin-bottom:10px">Unlink asset</button>
        ` : `
          <input type="text" class="map-search" id="mapFeatAssetSearch" placeholder="Search assets to link…" autocomplete="off" style="margin-bottom:6px">
          <div id="mapFeatAssetResults" style="margin-bottom:10px"></div>
        `}
      ` : ''}
      <button type="button" class="btn btn-danger" id="mapDelFeature" style="width:100%">Delete shape</button>`;
    let labelTimer;
    document.getElementById('mapFeatLabel').addEventListener('input', (e) => {
      f.label = e.target.value;
      render();
      clearTimeout(labelTimer);
      labelTimer = setTimeout(async () => {
        try { await api(`/api/pg/map-features/${f.id}`, { method: 'PATCH', body: JSON.stringify({ label: f.label }) }); }
        catch (err) { toast(err.message); }
      }, 500);
    });
    document.getElementById('mapFeatLayer').addEventListener('change', async (e) => {
      f.layerId = e.target.value ? Number(e.target.value) : null;
      render(); openInfo();
      try { await api(`/api/pg/map-features/${f.id}`, { method: 'PATCH', body: JSON.stringify({ layerId: f.layerId }) }); }
      catch (err) { toast(err.message); }
    });
    const unlinkBtn = document.getElementById('mapUnlinkAsset');
    if (unlinkBtn) unlinkBtn.addEventListener('click', async () => {
      f.assetId = null; f.assetName = null; f.holderName = null; f.maxSeverity = null; f.openFindingCount = 0; f.boardFocus = false;
      render(); openInfo();
      try { await api(`/api/pg/map-features/${f.id}`, { method: 'PATCH', body: JSON.stringify({ assetId: null }) }); }
      catch (err) { toast(err.message); }
    });
    const featAssetSearch = document.getElementById('mapFeatAssetSearch');
    if (featAssetSearch) {
      let searchTimer, lastResults = [];
      featAssetSearch.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        const q = e.target.value.trim();
        const box2 = document.getElementById('mapFeatAssetResults');
        if (!q) { box2.innerHTML = ''; return; }
        searchTimer = setTimeout(async () => {
          const { assets } = await api(`/api/pg/assets-search?q=${encodeURIComponent(q)}`);
          lastResults = assets;
          box2.innerHTML = assets.map((a) => `
            <div class="map-asset-result" data-id="${a.Id}">
              <div>${escapeHtml(a.Name)}</div>
              <div class="muted">${escapeHtml(a.assetType || '')}${a.locationName ? ' · ' + escapeHtml(a.locationName) : ''}</div>
            </div>`).join('') || '<div class="muted" style="padding:6px 0">No matches</div>';
          box2.querySelectorAll('.map-asset-result').forEach((el) => el.addEventListener('click', async () => {
            const asset = lastResults.find((a) => String(a.Id) === el.dataset.id);
            if (!asset) return;
            try {
              const { feature: full } = await api(`/api/pg/map-features/${f.id}`, { method: 'PATCH', body: JSON.stringify({ assetId: asset.Id }) });
              Object.assign(f, normalizeFeature(full));
              render(); openInfo();
              toast(`Linked to ${asset.Name}`);
            } catch (err) { toast(err.message); }
          }));
        }, 250);
      });
    }
    document.getElementById('mapDelFeature').addEventListener('click', () => deleteSelectedFeature());
  }

  // Shared by the panel buttons and the Delete/Backspace key — both paths
  // confirm first since either can fire on a misclick.
  async function removeSelectedPin() {
    if (!selected || selected.type !== 'pin') return;
    const p = selected.ref;
    if (!await confirmDialog(`Remove ${p.name} from the map? Its findings and history are unaffected — you can re-place it any time.`)) return;
    try {
      await api(`/api/pg/map/pins/${p.id}`, { method: 'PATCH', body: JSON.stringify({ mapX: null, mapY: null }) });
      mapPins = mapPins.filter((x) => x.id !== p.id);
      select(null);
      toast('Removed from map');
    } catch (err) { toast(err.message); }
  }
  async function deleteSelectedFeature() {
    if (!selected || selected.type !== 'feature') return;
    const f = selected.ref;
    if (!await confirmDialog(`Delete ${f.label || 'this shape'}? This can't be undone.`)) return;
    try {
      await api(`/api/pg/map-features/${f.id}`, { method: 'DELETE' });
      mapFeatures = mapFeatures.filter((x) => x.id !== f.id);
      select(null);
      toast('Shape deleted');
    } catch (err) { toast(err.message); }
  }

  // ---- tools / mode ----
  function renderToolbar() {
    const box = document.getElementById('mapTools');
    let html = `<button type="button" class="map-tool ${mode === 'edit' ? 'on' : ''}" data-tool="edit">Edit</button>
      <button type="button" class="map-tool ${mode === 'add-asset' ? 'on' : ''}" data-tool="add-asset">+ Asset</button>`;
    [...mapLayers].sort((a, b) => a.ZIndex - b.ZIndex).forEach((l) => {
      if (l.Name === 'Buildings') return;
      const icon = l.Icon ? l.Icon + ' ' : '';
      if (l.Geometry === 'mixed') {
        html += '<span class="map-tool-group">' + ['point', 'line', 'zone'].map((g) => {
          const suffix = { point: '●', line: '—', zone: '▭' }[g];
          const tool = `add-layer:${l.Id}:${g}`;
          return `<button type="button" class="map-tool ${mode === tool ? 'on' : ''}" data-tool="${tool}" title="${escapeHtml(l.Name)} (${g})">${icon}${suffix}</button>`;
        }).join('') + '</span>';
      } else {
        const tool = `add-layer:${l.Id}:${l.Geometry}`;
        html += `<button type="button" class="map-tool ${mode === tool ? 'on' : ''}" data-tool="${tool}">+ ${icon}${escapeHtml(l.Name)}</button>`;
      }
    });
    box.innerHTML = html;
  }
  function setMode(m) {
    mode = m;
    renderToolbar();
    svg.classList.toggle('placing', m.startsWith('add-'));
    if (m !== 'add-asset') { placingAsset = null; const picker = document.getElementById('mapAssetPicker'); if (picker) picker.hidden = true; }
    if (!m.startsWith('add-') && pending) { pending = null; document.getElementById('mapFinish').style.display = 'none'; render(); }
  }
  document.getElementById('mapTools').addEventListener('click', (e) => {
    const b = e.target.closest('.map-tool');
    if (!b) return;
    const tool = b.dataset.tool;
    setMode(tool);
    if (tool === 'add-asset') { document.getElementById('mapAssetPicker').hidden = false; document.getElementById('mapAssetSearch').focus(); }
  });

  // ---- asset search/picker (+ Asset tool) ----
  let assetSearchTimer;
  document.getElementById('mapAssetSearch').addEventListener('input', (e) => {
    clearTimeout(assetSearchTimer);
    const q = e.target.value.trim();
    const resultsBox = document.getElementById('mapAssetResults');
    if (!q) { resultsBox.innerHTML = ''; return; }
    assetSearchTimer = setTimeout(async () => {
      const { assets } = await api(`/api/pg/assets-search?q=${encodeURIComponent(q)}`);
      resultsBox.innerHTML = assets.map((a) => `
        <div class="map-asset-result" data-id="${a.Id}">
          <div>${escapeHtml(a.Name)}${a.onMap ? ' <span class="muted">(on map — click to move)</span>' : ''}</div>
          <div class="muted">${escapeHtml(a.assetType || '')}${a.locationName ? ' · ' + escapeHtml(a.locationName) : ''}</div>
        </div>`).join('') || '<div class="muted" style="padding:6px 0">No matches</div>';
      resultsBox.querySelectorAll('.map-asset-result').forEach((el) => el.addEventListener('click', () => {
        placingAsset = assets.find((a) => String(a.Id) === el.dataset.id);
        toast(`Click on the map to place ${placingAsset.Name}`);
      }));
    }, 250);
  });

  // ---- layer panel (list, add, recolor, rename, reorder, delete) ----
  function renderLayerRows() {
    const box = document.getElementById('mapLayerRows');
    const countEl = document.getElementById('mapLayersCount');
    if (countEl) countEl.textContent = mapLayers.length ? `${mapLayers.filter((l) => l.DefaultVisible).length}/${mapLayers.length}` : '';
    const sorted = [...mapLayers].sort((a, b) => b.ZIndex - a.ZIndex);
    box.innerHTML = sorted.map((l, i) => `
      <div class="map-layer-row" data-id="${l.Id}">
        <button type="button" class="map-layer-swatch" data-id="${l.Id}" style="background:${l.Color}" title="Change color"></button>
        <input type="text" class="map-layer-name" data-id="${l.Id}" value="${escapeHtml(l.Name)}">
        <label class="map-layer-vis" title="Visible on map"><input type="checkbox" class="map-layer-vis-cb" data-id="${l.Id}" ${l.DefaultVisible ? 'checked' : ''}></label>
        <div class="map-layer-swatch-picker" hidden data-id="${l.Id}">
          ${MAP_SWATCHES.map((c) => `<button type="button" class="map-swatch" data-id="${l.Id}" data-color="${c}" style="background:${c}"></button>`).join('')}
        </div>
      </div>
      <div class="map-layer-row2">
        <input type="text" class="map-layer-icon" data-id="${l.Id}" value="${l.Icon || ''}" maxlength="2" placeholder="—" title="Icon">
        <span class="muted" style="font-size:10.5px;flex:1">${MAP_GEOM_LABEL[l.Geometry] || l.Geometry}</span>
        <label class="map-layer-cond-lbl" title="Color by condition for asset-linked markers"><input type="checkbox" class="map-layer-cond-cb" data-id="${l.Id}" ${l.ColorByCondition ? 'checked' : ''}> cond.</label>
        <button type="button" class="map-layer-btn" data-id="${l.Id}" data-act="up" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button type="button" class="map-layer-btn" data-id="${l.Id}" data-act="down" ${i === sorted.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
        <button type="button" class="map-layer-btn" data-id="${l.Id}" data-act="del" title="Delete layer">🗑</button>
      </div>
    `).join('') || '<div class="muted">No layers yet.</div>';

    box.querySelectorAll('.map-layer-swatch').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const picker = box.querySelector(`.map-layer-swatch-picker[data-id="${btn.dataset.id}"]`);
      box.querySelectorAll('.map-layer-swatch-picker').forEach((p) => { if (p !== picker) p.hidden = true; });
      if (picker) picker.hidden = !picker.hidden;
    }));
    box.querySelectorAll('.map-layer-swatch-picker .map-swatch').forEach((sw) => sw.addEventListener('click', async () => {
      const l = layerById(Number(sw.dataset.id));
      if (!l) return;
      l.Color = sw.dataset.color;
      renderLayerRows(); render();
      try { await api(`/api/pg/map/layers/${l.Id}`, { method: 'PATCH', body: JSON.stringify({ color: l.Color }) }); }
      catch (err) { toast(err.message); }
    }));
    box.querySelectorAll('.map-layer-name').forEach((inp) => {
      let t;
      inp.addEventListener('input', () => {
        const l = layerById(Number(inp.dataset.id));
        if (!l) return;
        l.Name = inp.value;
        clearTimeout(t);
        t = setTimeout(async () => {
          try { await api(`/api/pg/map/layers/${l.Id}`, { method: 'PATCH', body: JSON.stringify({ name: l.Name }) }); renderToolbar(); }
          catch (err) { toast(err.message); }
        }, 500);
      });
    });
    box.querySelectorAll('.map-layer-icon').forEach((inp) => {
      let t;
      inp.addEventListener('input', () => {
        const l = layerById(Number(inp.dataset.id));
        if (!l) return;
        l.Icon = inp.value;
        clearTimeout(t);
        t = setTimeout(async () => {
          render(); renderToolbar();
          try { await api(`/api/pg/map/layers/${l.Id}`, { method: 'PATCH', body: JSON.stringify({ icon: l.Icon }) }); }
          catch (err) { toast(err.message); }
        }, 500);
      });
    });
    box.querySelectorAll('.map-layer-vis-cb').forEach((cb) => cb.addEventListener('change', async () => {
      const l = layerById(Number(cb.dataset.id));
      if (!l) return;
      l.DefaultVisible = cb.checked;
      render(); // not just applyVisibility() — labels are only added to gLabels at render time, so hiding a layer without a re-render leaves its labels orphaned on screen
      try { await api(`/api/pg/map/layers/${l.Id}`, { method: 'PATCH', body: JSON.stringify({ defaultVisible: l.DefaultVisible }) }); }
      catch (err) { toast(err.message); }
    }));
    box.querySelectorAll('.map-layer-cond-cb').forEach((cb) => cb.addEventListener('change', async () => {
      const l = layerById(Number(cb.dataset.id));
      if (!l) return;
      l.ColorByCondition = cb.checked;
      render();
      if (selected && selected.type === 'feature' && selected.ref.layerId === l.Id) openInfo();
      try { await api(`/api/pg/map/layers/${l.Id}`, { method: 'PATCH', body: JSON.stringify({ colorByCondition: l.ColorByCondition }) }); }
      catch (err) { toast(err.message); }
    }));
    box.querySelectorAll('.map-layer-btn').forEach((btn) => btn.addEventListener('click', async () => {
      const l = layerById(Number(btn.dataset.id));
      if (!l) return;
      if (btn.dataset.act === 'del') { await deleteLayer(l); return; }
      await moveLayer(l, btn.dataset.act === 'up' ? -1 : 1);
    }));
  }

  async function moveLayer(layer, dir) {
    const sorted = [...mapLayers].sort((a, b) => b.ZIndex - a.ZIndex);
    const idx = sorted.findIndex((l) => l.Id === layer.Id);
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const a = sorted[idx], b = sorted[swapIdx];
    const az = a.ZIndex, bz = b.ZIndex;
    a.ZIndex = bz; b.ZIndex = az;
    rebuildLayerGroups(); renderLayerRows(); renderToolbar(); render();
    try {
      await Promise.all([
        api(`/api/pg/map/layers/${a.Id}`, { method: 'PATCH', body: JSON.stringify({ zIndex: a.ZIndex }) }),
        api(`/api/pg/map/layers/${b.Id}`, { method: 'PATCH', body: JSON.stringify({ zIndex: b.ZIndex }) }),
      ]);
    } catch (err) { toast(err.message); }
  }

  async function deleteLayer(layer) {
    if (!await confirmDialog(`Delete the "${layer.Name}" layer? Its markers/shapes stay on the map but lose this layer's color/icon/visibility until reassigned.`)) return;
    try {
      await api(`/api/pg/map/layers/${layer.Id}`, { method: 'DELETE' });
      mapLayers = mapLayers.filter((l) => l.Id !== layer.Id);
      mapFeatures.forEach((f) => { if (f.layerId === layer.Id) f.layerId = null; });
      mapPins.forEach((p) => { if (p.layerId === layer.Id) p.layerId = null; });
      if (selected && ((selected.type === 'feature' && selected.ref.layerId === null) || (selected.type === 'pin' && selected.ref.layerId === null))) openInfo();
      rebuildLayerGroups(); renderLayerRows(); renderToolbar(); render();
      toast('Layer deleted');
    } catch (err) { toast(err.message); }
  }

  // Layers popover: keeps per-layer editing (rename/recolor/reorder/etc) out
  // of the sidebar's default scroll — it's fixed-positioned off the toggle
  // button so it isn't clipped by the sidebar's own overflow-y:auto.
  function toggleLayersPopover(forceOpen) {
    const pop = document.getElementById('mapLayersPopover');
    const btn = document.getElementById('mapLayersBtn');
    const open = forceOpen !== undefined ? forceOpen : pop.hidden;
    if (!open) {
      pop.hidden = true;
      btn.classList.remove('on');
      document.getElementById('mapAddLayerForm').hidden = true;
      return;
    }
    pop.hidden = false;
    btn.classList.add('on');
    const r = btn.getBoundingClientRect();
    const margin = 12;
    let left = r.left;
    left = Math.min(left, window.innerWidth - pop.offsetWidth - margin);
    left = Math.max(margin, left);
    pop.style.left = `${left}px`;
    // Size-aware placement: cap the popover's height to whichever side (below
    // or above the button) has more room, so a tall layer list can never grow
    // over the toggle button itself and swallow its own close click.
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    if (spaceBelow >= 200 || spaceBelow >= spaceAbove) {
      pop.style.maxHeight = `${Math.max(160, spaceBelow - 6)}px`;
      pop.style.top = `${r.bottom + 6}px`;
    } else {
      const maxHeight = Math.max(160, spaceAbove - 6);
      pop.style.maxHeight = `${maxHeight}px`;
      pop.style.top = `${Math.max(margin, r.top - 6 - Math.min(pop.scrollHeight, maxHeight))}px`;
    }
  }
  document.getElementById('mapLayersBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleLayersPopover(); });
  document.getElementById('mapLayersClose').addEventListener('click', () => toggleLayersPopover(false));
  function outsideClickCloseLayersPopover(e) {
    const pop = document.getElementById('mapLayersPopover');
    if (!pop) { document.removeEventListener('click', outsideClickCloseLayersPopover); return; }
    if (pop.hidden || pop.contains(e.target) || e.target.closest('#mapLayersBtn')) return;
    toggleLayersPopover(false);
  }
  document.addEventListener('click', outsideClickCloseLayersPopover);

  document.getElementById('mapAddLayerBtn').addEventListener('click', () => {
    const form = document.getElementById('mapAddLayerForm');
    form.hidden = !form.hidden;
    if (!form.hidden) document.getElementById('newLayerName').focus();
  });
  let newLayerColor = MAP_SWATCHES[0];
  document.getElementById('newLayerSwatches').addEventListener('click', (e) => {
    const btn = e.target.closest('.map-swatch');
    if (!btn) return;
    newLayerColor = btn.dataset.color;
    document.querySelectorAll('#newLayerSwatches .map-swatch').forEach((b) => b.classList.toggle('on', b === btn));
  });
  document.getElementById('newLayerCreate').addEventListener('click', async () => {
    const name = document.getElementById('newLayerName').value.trim();
    if (!name) { toast('Give the layer a name'); return; }
    const geometry = document.getElementById('newLayerGeom').value;
    const icon = document.getElementById('newLayerIcon').value.trim();
    const colorByCondition = document.getElementById('newLayerCond').checked;
    try {
      const { layer } = await api('/api/pg/map/layers', { method: 'POST', body: JSON.stringify({ name, geometry, color: newLayerColor, icon: icon || null, colorByCondition }) });
      mapLayers.push(layer);
      document.getElementById('newLayerName').value = '';
      document.getElementById('newLayerIcon').value = '';
      document.getElementById('newLayerCond').checked = false;
      document.getElementById('mapAddLayerForm').hidden = true;
      rebuildLayerGroups(); renderLayerRows(); renderToolbar(); render();
      toast(`"${layer.Name}" layer created`);
    } catch (err) { toast(err.message); }
  });

  // ---- pin label mode (asset name <-> cabin holder), remembered per browser ----
  function renderLabelModeButtons() {
    document.querySelectorAll('#mapLabelMode .map-tool').forEach((b) => b.classList.toggle('on', b.dataset.labelMode === labelMode));
  }
  document.getElementById('mapLabelMode').addEventListener('click', (e) => {
    const b = e.target.closest('.map-tool');
    if (!b) return;
    labelMode = b.dataset.labelMode;
    try { localStorage.setItem('campMapLabelMode', labelMode); } catch { /* private browsing, etc. */ }
    renderLabelModeButtons();
    render();
  });

  // ---- base map, zoom, keys ----
  document.getElementById('mapBaseToggle').addEventListener('change', applyVisibility);
  document.getElementById('mapLabelsToggle').addEventListener('change', applyVisibility);
  document.getElementById('mapDim').addEventListener('input', (e) => { baseImg.setAttribute('opacity', 1 - e.target.value / 100); });
  document.getElementById('mapZin').addEventListener('click', () => zoom(0.8));
  document.getElementById('mapZout').addEventListener('click', () => zoom(1.25));
  document.getElementById('mapFit').addEventListener('click', () => { svg.setAttribute('viewBox', `0 0 ${CAMP_MAP_IMAGE.width} ${CAMP_MAP_IMAGE.height}`); render(); });
  function zoom(f) {
    const vb = svg.viewBox.baseVal, cx = vb.x + vb.width / 2, cy = vb.y + vb.height / 2;
    vb.width *= f; vb.height *= f; vb.x = cx - vb.width / 2; vb.y = cy - vb.height / 2;
    render();
  }

  function mapKeydown(e) {
    if (!document.getElementById('mapSvg')) { document.removeEventListener('keydown', mapKeydown); return; }
    if (e.key === 'Escape' && !document.getElementById('mapLayersPopover').hidden) { toggleLayersPopover(false); return; }
    if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (e.key === 'Escape') { pending = null; document.getElementById('mapFinish').style.display = 'none'; setMode('edit'); }
    if (e.key === 'Enter' && pending && pending.pts.length > 1) finishPending();
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      if (selected.type === 'pin') removeSelectedPin(); else deleteSelectedFeature();
    }
  }
  document.addEventListener('keydown', mapKeydown);

  // ---- sizing: fill the space below the topbar/banner exactly, whatever
  // their heights happen to be, instead of guessing at a vh calc() ----
  function sizeStage() {
    const view = document.querySelector('.map-view');
    if (!view) { window.removeEventListener('resize', sizeStage); return; }
    view.style.height = Math.max(360, window.innerHeight - view.getBoundingClientRect().top - 12) + 'px';
    render();
  }
  window.addEventListener('resize', sizeStage);

  rebuildLayerGroups();
  renderToolbar();
  renderLayerRows();
  renderLabelModeButtons();
  sizeStage();
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
          <span class="pill">${escapeHtml(it.Status)} · ${moneyFmt(it.Cost)}</span>
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

// ---------- Notes scratchpad ----------
// Freeform notes ("a program I want to implement soon") with a user-typed
// category — no fixed category list, just whatever's already been used
// offered back as suggestions, same free-tagging approach as map layers.

async function renderNotes() {
  setChrome({ title: 'Notes', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;
  let notes = (await api('/api/pg/notes')).notes;
  let categoryFilter = null;
  let adding = false;
  let editingId = null;
  let showDone = false;

  function categories() {
    return [...new Set(notes.map((n) => n.category || 'General'))].sort();
  }

  function noteFormHtml(note) {
    return `<div class="card">
      <h3>${note ? 'Edit Note' : 'New Note'}</h3>
      <div class="field-row"><label>Title</label><input class="nf-title" value="${escapeHtml(note?.title || '')}" required /></div>
      <div class="field-row"><label>Category</label>
        <input class="nf-category" list="noteCategoryOptions" value="${escapeHtml(note?.category || categoryFilter || 'General')}" />
        <datalist id="noteCategoryOptions">${categories().map((c) => `<option value="${escapeHtml(c)}">`).join('')}</datalist>
      </div>
      <div class="field-row"><label>Details</label><textarea class="nf-body" placeholder="Optional details…">${escapeHtml(note?.body || '')}</textarea></div>
      <div class="btn-row">
        <button class="btn btn-primary nf-save" data-id="${note?.id ?? ''}">Save</button>
        <button class="btn btn-secondary nf-cancel">Cancel</button>
      </div>
    </div>`;
  }

  function noteCardHtml(n) {
    return `<div class="list-item" style="align-items:flex-start;flex-wrap:wrap;gap:10px;${n.done ? 'opacity:0.6' : ''}">
      <input type="checkbox" class="note-done" data-id="${n.id}" ${n.done ? 'checked' : ''} style="margin-top:4px" />
      <div style="flex:1;min-width:180px">
        <div><strong style="${n.done ? 'text-decoration:line-through' : ''}">${escapeHtml(n.title)}</strong> <span class="pill">${escapeHtml(n.category || 'General')}</span></div>
        ${n.body ? `<div class="muted" style="white-space:pre-wrap">${escapeHtml(n.body)}</div>` : ''}
        <div class="muted" style="font-size:12px">${n.created_by ? escapeHtml(n.created_by) + ' · ' : ''}${formatDateNice(n.updated_at)}</div>
      </div>
      <div class="btn-row" style="margin-top:0">
        <button class="btn btn-secondary note-edit" data-id="${n.id}">Edit</button>
        <button class="btn btn-secondary note-delete" data-id="${n.id}" data-title="${escapeHtml(n.title)}">Delete</button>
      </div>
    </div>`;
  }

  function draw() {
    const cats = categories();
    const visible = notes
      .filter((n) => showDone || !n.done)
      .filter((n) => !categoryFilter || (n.category || 'General') === categoryFilter);
    setApp(`
      ${cats.length ? `<div class="card">
        <div class="view-toggle">
          <button type="button" class="view-toggle-btn note-cat-btn ${!categoryFilter ? 'active' : ''}" data-cat="">All</button>
          ${cats.map((c) => `<button type="button" class="view-toggle-btn note-cat-btn ${categoryFilter === c ? 'active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}
        </div>
      </div>` : ''}
      <div class="btn-row" style="margin:-6px 0 16px">
        <button class="btn btn-secondary" id="addNoteBtn">+ Add Note</button>
        <label style="display:flex;align-items:center;gap:6px;margin-left:auto">
          <input type="checkbox" id="showDoneToggle" ${showDone ? 'checked' : ''} /> Show done
        </label>
      </div>
      ${adding ? noteFormHtml(null) : ''}
      ${editingId ? noteFormHtml(notes.find((n) => n.id === editingId)) : ''}
      <div class="card">
        ${visible.map(noteCardHtml).join('') || '<p class="muted">🗒️ No notes yet — tap + Add Note above to create one.</p>'}
      </div>
    `);
    wire();
  }

  function wire() {
    app.querySelectorAll('.note-cat-btn').forEach((btn) => btn.addEventListener('click', () => {
      categoryFilter = btn.dataset.cat || null;
      draw();
    }));
    document.getElementById('showDoneToggle')?.addEventListener('change', (e) => { showDone = e.target.checked; draw(); });
    document.getElementById('addNoteBtn')?.addEventListener('click', () => { adding = true; editingId = null; draw(); });
    app.querySelectorAll('.note-edit').forEach((btn) => btn.addEventListener('click', () => {
      editingId = Number(btn.dataset.id); adding = false; draw();
    }));
    app.querySelectorAll('.nf-cancel').forEach((btn) => btn.addEventListener('click', () => { adding = false; editingId = null; draw(); }));

    app.querySelectorAll('.nf-save').forEach((btn) => btn.addEventListener('click', async () => {
      const card = btn.closest('.card');
      const title = card.querySelector('.nf-title').value.trim();
      const category = card.querySelector('.nf-category').value.trim() || 'General';
      const body = card.querySelector('.nf-body').value.trim();
      if (!title) { toast('Title is required'); return; }
      const id = btn.dataset.id;
      try {
        if (id) {
          const { note } = await api(`/api/pg/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ title, category, body }) });
          notes = notes.map((n) => (n.id === note.id ? note : n));
        } else {
          const { note } = await api('/api/pg/notes', { method: 'POST', body: JSON.stringify({ title, category, body }) });
          notes = [note, ...notes];
        }
        toast('Saved');
        adding = false; editingId = null;
        draw();
      } catch (err) { toast(err.message); }
    }));

    app.querySelectorAll('.note-done').forEach((cb) => cb.addEventListener('change', async () => {
      const id = Number(cb.dataset.id);
      try {
        const { note } = await api(`/api/pg/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ done: cb.checked }) });
        notes = notes.map((n) => (n.id === note.id ? note : n));
        draw();
      } catch (err) { toast(err.message); }
    }));

    app.querySelectorAll('.note-delete').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog(`Delete note "${btn.dataset.title}"?`)) return;
      const id = Number(btn.dataset.id);
      try {
        await api(`/api/pg/notes/${id}`, { method: 'DELETE' });
        notes = notes.filter((n) => n.id !== id);
        toast('Deleted');
        draw();
      } catch (err) { toast(err.message); }
    }));
  }

  draw();
}

// ---------- Triage Inbox (Build Brief v2 Phase 5) ----------
// Grid of thumbnails, newest batch first, grouped by batch. A batch is a
// suggestion, not a commitment — acting on some of its photos leaves the
// rest in the inbox, so one email can become several work orders. Selection
// and the action bar are scoped per batch, matching "repeat until empty."

// Groups a batch's photos by EXIF taken_at proximity (within 5 min) — "these
// were shot in one pass" — so one tap selects the cluster instead of
// hand-picking each thumbnail. GPS-distance refinement is a documented
// follow-up (see update-for-claude.md); time alone is what's implemented.
function clusterInboxAttachments(attachments) {
  const withTime = attachments.filter((a) => a.TakenAt).sort((a, b) => new Date(a.TakenAt) - new Date(b.TakenAt));
  if (withTime.length < 2) return [];
  const clusters = [];
  let current = [withTime[0]];
  for (let i = 1; i < withTime.length; i++) {
    const gapMs = new Date(withTime[i].TakenAt) - new Date(withTime[i - 1].TakenAt);
    if (gapMs <= 5 * 60 * 1000) current.push(withTime[i]);
    else { clusters.push(current); current = [withTime[i]]; }
  }
  clusters.push(current);
  return clusters.filter((c) => c.length > 1);
}

async function renderInbox() {
  setChrome({ title: 'Inbox', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const { batches } = await api('/api/pg/inbox');

  if (!batches.length) {
    app.innerHTML = `<div class="card"><h3>Inbox</h3><p class="muted">No photos waiting. Send photos to photos@cmms.fracturedrv.com, or use "Attach file" directly on an asset/work order/job line to skip the inbox entirely.</p></div>`;
    return;
  }

  app.innerHTML = batches.map((b) => {
    const clusters = clusterInboxAttachments(b.Attachments);
    return `
    <div class="card inbox-batch" data-batch-id="${b.Id}">
      <h3>${escapeHtml(b.Subject || '(no subject)')}</h3>
      <p class="muted">${b.SenderEmail ? escapeHtml(b.SenderEmail) + ' · ' : ''}${new Date(b.ReceivedAt).toLocaleString()} · ${b.Attachments.length} photo${b.Attachments.length === 1 ? '' : 's'}</p>
      ${b.Note ? `<p class="muted" style="font-size:0.85rem">${escapeHtml(b.Note)}</p>` : ''}
      ${clusters.length ? `<div class="btn-row" style="margin-bottom:8px">${clusters.map((c, i) => `<button type="button" class="btn btn-secondary cluster-select" data-ids="${c.map((a) => a.Id).join(',')}">Select cluster ${i + 1} (${c.length}, ~${Math.round((new Date(c[c.length - 1].TakenAt) - new Date(c[0].TakenAt)) / 60000)}min)</button>`).join('')}</div>` : ''}
      <div class="attach-grid" style="display:flex;flex-wrap:wrap;gap:8px">
        ${b.Attachments.map((a) => `
          <label class="inbox-thumb" style="position:relative;cursor:pointer;display:block">
            <input type="checkbox" class="inbox-select" value="${a.Id}" style="position:absolute;top:2px;left:2px;z-index:1;width:20px;height:20px" />
            ${a.Kind === 'image'
              ? `<img src="${escapeHtml(a.ThumbUrl || a.Url)}" alt="" style="width:84px;height:84px;object-fit:cover;border-radius:8px;display:block" />`
              : `<div style="width:84px;height:84px;border-radius:8px;background:#f0f2fb;display:flex;align-items:center;justify-content:center;font-size:28px">📄</div>`}
          </label>`).join('')}
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button type="button" class="btn btn-secondary batch-select-all">Select All</button>
        <button type="button" class="btn btn-primary batch-action" data-action="createWo">Create WO</button>
        <button type="button" class="btn btn-secondary batch-action" data-action="addToWo">Add to Existing WO</button>
        <button type="button" class="btn btn-secondary batch-action" data-action="addToLine">Add to Job Line</button>
        <button type="button" class="btn btn-secondary batch-action" data-action="newFinding">New Finding</button>
        <button type="button" class="btn btn-secondary batch-action" data-action="fileAsset">File to Asset (reference)</button>
        <button type="button" class="btn btn-secondary batch-action" data-action="void">Void</button>
      </div>
      <div class="batch-action-panel" hidden></div>
    </div>`;
  }).join('');

  batches.forEach((b) => wireInboxBatch(b));
}

function wireInboxBatch(batch) {
  const card = app.querySelector(`.inbox-batch[data-batch-id="${batch.Id}"]`);
  if (!card) return;
  const panel = card.querySelector('.batch-action-panel');

  const selectedIds = () => [...card.querySelectorAll('.inbox-select:checked')].map((el) => Number(el.value));

  card.querySelector('.batch-select-all').addEventListener('click', () => {
    card.querySelectorAll('.inbox-select').forEach((el) => { el.checked = true; });
  });
  card.querySelectorAll('.cluster-select').forEach((btn) => btn.addEventListener('click', () => {
    const ids = new Set(btn.dataset.ids.split(',').map(Number));
    card.querySelectorAll('.inbox-select').forEach((el) => { el.checked = ids.has(Number(el.value)); });
  }));

  async function afterAction() {
    toast('Done');
    renderInbox();
  }

  // Nearest-asset-from-GPS + fuzzy subject-match suggestions (§5.3/§5.2) —
  // "confirm or correct" instead of a blind search. Never auto-assigns.
  async function suggestionsHtml() {
    const ids = selectedIds();
    const withGps = batch.Attachments.find((a) => ids.includes(a.Id) && a.GpsLat != null);
    const [textSugg, gpsSugg] = await Promise.all([
      api(`/api/pg/inbox/suggest-assets?text=${encodeURIComponent(batch.Subject || '')}`),
      withGps ? api(`/api/pg/inbox/suggest-assets?lat=${withGps.GpsLat}&lng=${withGps.GpsLng}`) : Promise.resolve({ suggestions: [] }),
    ]);
    const all = [...gpsSugg.suggestions, ...textSugg.suggestions].filter((s, i, arr) => arr.findIndex((x) => x.Id === s.Id) === i).slice(0, 3);
    if (!all.length) return '';
    return `<div class="btn-row" style="margin-bottom:8px">${all.map((s) => `<button type="button" class="btn btn-secondary suggest-asset-btn" data-id="${s.Id}" data-name="${escapeHtml(s.Name)}">📍 ${escapeHtml(s.Name)}</button>`).join('')}</div>`;
  }

  card.querySelectorAll('.batch-action').forEach((btn) => btn.addEventListener('click', async () => {
    const ids = selectedIds();
    if (!ids.length) { toast('Select at least one photo first'); return; }
    const action = btn.dataset.action;

    if (action === 'void') {
      try { await api('/api/pg/inbox/void', { method: 'POST', body: JSON.stringify({ attachmentIds: ids }) }); await afterAction(); }
      catch (err) { toast(err.message); }
      return;
    }

    panel.hidden = false;
    const suggHtml = await suggestionsHtml();

    if (action === 'createWo') {
      panel.innerHTML = `<div class="card" style="margin-top:8px">
        ${suggHtml}
        <div class="field-row"><label>Asset</label><div class="asset-picker"></div></div>
        <label style="display:flex;align-items:center;gap:8px;font-weight:400;margin:8px 0"><input type="checkbox" class="use-subject-title" checked /> Use subject as work order title</label>
        <div class="field-row title-row" hidden><label>Title</label><input class="wo-title" value="${escapeHtml(batch.Subject || '')}" /></div>
        <div class="btn-row"><button type="button" class="btn btn-primary panel-confirm">Create Work Order</button><button type="button" class="btn btn-secondary panel-cancel">Cancel</button></div>
      </div>`;
      let asset = null;
      mountAssetCombobox(panel.querySelector('.asset-picker'), { onSelect: (a) => { asset = a; } });
      panel.querySelectorAll('.suggest-asset-btn').forEach((sb) => sb.addEventListener('click', () => {
        asset = { Id: Number(sb.dataset.id), Name: sb.dataset.name };
        panel.querySelector('.ac-input').value = sb.dataset.name;
      }));
      panel.querySelector('.use-subject-title').addEventListener('change', (e) => { panel.querySelector('.title-row').hidden = e.target.checked; });
      panel.querySelector('.panel-cancel').addEventListener('click', () => { panel.hidden = true; });
      panel.querySelector('.panel-confirm').addEventListener('click', async () => {
        const title = panel.querySelector('.use-subject-title').checked ? (batch.Subject || 'Work Order') : panel.querySelector('.wo-title').value.trim();
        if (!title) { toast('Title is required'); return; }
        try {
          const { workOrderId } = await api('/api/pg/inbox/create-work-order', { method: 'POST', body: JSON.stringify({ attachmentIds: ids, assetId: asset?.Id || null, title }) });
          toast('Work order created');
          go('workOrderDetail', { id: workOrderId });
        } catch (err) { toast(err.message); }
      });
    } else if (action === 'fileAsset') {
      panel.innerHTML = `<div class="card" style="margin-top:8px">
        ${suggHtml}
        <div class="field-row"><label>Asset</label><div class="asset-picker"></div></div>
        <div class="btn-row"><button type="button" class="btn btn-primary panel-confirm">File Photos</button><button type="button" class="btn btn-secondary panel-cancel">Cancel</button></div>
      </div>`;
      let asset = null;
      mountAssetCombobox(panel.querySelector('.asset-picker'), { onSelect: (a) => { asset = a; } });
      panel.querySelectorAll('.suggest-asset-btn').forEach((sb) => sb.addEventListener('click', () => {
        asset = { Id: Number(sb.dataset.id), Name: sb.dataset.name };
        panel.querySelector('.ac-input').value = sb.dataset.name;
      }));
      panel.querySelector('.panel-cancel').addEventListener('click', () => { panel.hidden = true; });
      panel.querySelector('.panel-confirm').addEventListener('click', async () => {
        if (!asset) { toast('Pick an asset first'); return; }
        try {
          await api('/api/pg/inbox/attach', { method: 'POST', body: JSON.stringify({ attachmentIds: ids, entityType: 'asset', entityId: asset.Id }) });
          await afterAction();
        } catch (err) { toast(err.message); }
      });
    } else if (action === 'newFinding') {
      panel.innerHTML = `<div class="card" style="margin-top:8px">
        ${suggHtml}
        <div class="field-row"><label>Asset</label><div class="asset-picker"></div></div>
        <div class="field-row"><label>Severity</label><select class="finding-severity">${(state.options.findingSeverity || []).map((s) => `<option>${escapeHtml(s)}</option>`).join('')}</select></div>
        <div class="field-row"><label>Description</label><textarea class="finding-description"></textarea></div>
        <div class="btn-row"><button type="button" class="btn btn-primary panel-confirm">Create Finding</button><button type="button" class="btn btn-secondary panel-cancel">Cancel</button></div>
      </div>`;
      let asset = null;
      mountAssetCombobox(panel.querySelector('.asset-picker'), { onSelect: (a) => { asset = a; } });
      panel.querySelectorAll('.suggest-asset-btn').forEach((sb) => sb.addEventListener('click', () => {
        asset = { Id: Number(sb.dataset.id), Name: sb.dataset.name };
        panel.querySelector('.ac-input').value = sb.dataset.name;
      }));
      panel.querySelector('.panel-cancel').addEventListener('click', () => { panel.hidden = true; });
      panel.querySelector('.panel-confirm').addEventListener('click', async () => {
        const description = panel.querySelector('.finding-description').value.trim();
        if (!asset || !description) { toast('Asset and description are required'); return; }
        try {
          await api('/api/pg/inbox/create-finding', { method: 'POST', body: JSON.stringify({
            attachmentIds: ids, assetId: asset.Id, severity: panel.querySelector('.finding-severity').value, description,
          }) });
          await afterAction();
        } catch (err) { toast(err.message); }
      });
    } else if (action === 'addToWo' || action === 'addToLine') {
      panel.innerHTML = `<div class="card" style="margin-top:8px">
        ${suggHtml}
        <div class="field-row"><label>Asset</label><div class="asset-picker"></div></div>
        <div class="field-row wo-row" hidden><label>Work Order</label><select class="wo-picker"></select></div>
        ${action === 'addToLine' ? '<div class="field-row line-row" hidden><label>Job Line</label><select class="line-picker"></select></div>' : ''}
        <div class="btn-row"><button type="button" class="btn btn-primary panel-confirm">Attach</button><button type="button" class="btn btn-secondary panel-cancel">Cancel</button></div>
      </div>`;
      let asset = null;
      const woRow = panel.querySelector('.wo-row');
      const woPicker = panel.querySelector('.wo-picker');
      const lineRow = panel.querySelector('.line-row');
      const linePicker = panel.querySelector('.line-picker');
      async function loadWos(a) {
        const detail = await api(`/api/pg/assets/${a.Id}`);
        woRow.hidden = false;
        woPicker.innerHTML = detail.workOrders.map((w) => `<option value="${w.Id}">${escapeHtml(w.Title)} (${escapeHtml(w.Status)})</option>`).join('') || '<option value="">— none —</option>';
        if (action === 'addToLine' && detail.workOrders.length) await loadLines(detail.workOrders[0].Id);
      }
      async function loadLines(woId) {
        if (!linePicker) return;
        const wo = await api(`/api/pg/work-orders/${woId}`);
        lineRow.hidden = false;
        linePicker.innerHTML = (wo.jobLines || []).map((jl) => `<option value="${jl.Id}">${escapeHtml(jl.Title)}</option>`).join('') || '<option value="">— none —</option>';
      }
      mountAssetCombobox(panel.querySelector('.asset-picker'), { onSelect: (a) => { asset = a; if (a) loadWos(a); } });
      panel.querySelectorAll('.suggest-asset-btn').forEach((sb) => sb.addEventListener('click', () => {
        asset = { Id: Number(sb.dataset.id), Name: sb.dataset.name };
        panel.querySelector('.ac-input').value = sb.dataset.name;
        loadWos(asset);
      }));
      woPicker.addEventListener('change', () => { if (action === 'addToLine') loadLines(woPicker.value); });
      panel.querySelector('.panel-cancel').addEventListener('click', () => { panel.hidden = true; });
      panel.querySelector('.panel-confirm').addEventListener('click', async () => {
        const woId = woPicker.value;
        if (!woId) { toast('Pick a work order first'); return; }
        const entityType = action === 'addToLine' ? 'job_line' : 'work_order';
        const entityId = action === 'addToLine' ? linePicker.value : woId;
        if (action === 'addToLine' && !entityId) { toast('Pick a job line first'); return; }
        try {
          await api('/api/pg/inbox/attach', { method: 'POST', body: JSON.stringify({ attachmentIds: ids, entityType, entityId: Number(entityId) }) });
          await afterAction();
        } catch (err) { toast(err.message); }
      });
    }
  }));
}

// ── Expenses (Build Brief v3 Part 3) — a separate nav item from the photo
// Inbox on purpose ("photos and receipts must be visually distinct; they get
// triaged differently and mixing them will cause mistakes" — brief §3.1). A
// receipt needs vendor/amount/date/category/fund; a photo needs role/
// classification. Two lists, two triage screens, no shared card markup. ────

function expenseParsedBadge(e) {
  if (!e || e.Source !== 'email' || !e.ParsedConfidence || e.ParsedConfidence === 'none') return '';
  const label = e.ParsedConfidence === 'parsed' ? 'Parsed from email — confirm' : 'Partially parsed — confirm';
  return ` <span class="pill">${label}</span>`;
}
function fundPickerOptionsHtml(funds, selectedId) {
  return '<option value="">— none —</option>' + (funds || []).map((f) =>
    `<option value="${f.Id}" ${f.Id === selectedId ? 'selected' : ''}>${escapeHtml(f.Name)}${f.Expired ? ' (expired)' : ''}${f.Active === false ? ' (inactive)' : ''}</option>`
  ).join('');
}
function categoryPickerOptionsHtml(categories, selectedId) {
  return '<option value="">— none —</option>' + (categories || []).map((c) =>
    `<option value="${c.Id}" ${c.Id === selectedId ? 'selected' : ''}>${escapeHtml(c.Name)}</option>`
  ).join('');
}

// .btn defaults to width:100% (it's meant to stack full-width, one per row —
// see login/save/etc throughout the app). That's wrong for a button sharing
// a row with other content: it fights the flex:1 text div for space instead
// of sizing to its label, which is what made Void render huge and
// overlapping. Fix: pull it out of the thumb+text row entirely into its own
// .btn-row underneath (same "actions below content" shape every other card
// in this app already uses) and size it with .btn-small so it isn't a giant
// bar under a small card. Never competes for horizontal space, so there's
// nothing narrow-screen-specific to add — it degrades the same way at any width.
function expenseInboxCardHtml(e) {
  const thumb = (e.Attachments || [])[0];
  return `<div class="card expense-card" data-id="${e.Id}" style="cursor:pointer;border-left:4px solid #d98c00;margin-bottom:8px">
    <div style="display:flex;gap:10px;align-items:flex-start">
      ${thumb ? attachmentThumbHtml(thumb) : '<div style="width:84px;height:84px;border-radius:8px;background:#fff3e0;display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0">🧾</div>'}
      <div style="flex:1;min-width:0">
        <strong>${escapeHtml(e.Vendor || e.Subject || '(unidentified receipt)')}</strong>${expenseParsedBadge(e)}
        <div class="muted" style="font-size:0.85rem">${e.Amount != null ? `$${Number(e.Amount).toLocaleString()}` : 'amount unknown'}${e.PurchaseDate ? ` · ${formatDateNice(e.PurchaseDate)}` : ''}</div>
        ${e.SenderEmail ? `<div class="muted" style="font-size:0.8rem">${escapeHtml(e.SenderEmail)}</div>` : ''}
      </div>
    </div>
    <div class="btn-row" style="margin-top:8px;justify-content:flex-end">
      <button type="button" class="btn btn-secondary btn-small expense-void-btn" data-id="${e.Id}">Void</button>
    </div>
  </div>`;
}

// Overview (funds + receipt inbox + a Recent Expenses taste) is the page
// Ben already knows and likes — kept exactly as-is, not replaced. "All
// Expenses" is a second tab next to it: the full list, searchable/
// filterable/sortable, for "what have I entered" — deliberately simpler
// than the Reports data explorer (no grouping/export/charts, see
// renderAllExpensesTab's comment), which stays reachable via the "See all,
// with filters, in Reports" link either tab keeps in place.
const EXPENSE_TABS = [{ key: 'overview', label: 'Overview' }, { key: 'all', label: 'All Expenses' }];
function expenseTabsHtml(tab) {
  return `<div class="card">
    <div class="view-toggle">
      ${EXPENSE_TABS.map((t) => `<button type="button" class="view-toggle-btn expenses-tab-btn ${tab === t.key ? 'active' : ''}" data-tab="${t.key}">${escapeHtml(t.label)}</button>`).join('')}
    </div>
  </div>`;
}
function wireExpenseTabs(container = app) {
  container.querySelectorAll('.expenses-tab-btn').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) return;
    go('expenses', { tab: btn.dataset.tab }, { replace: true });
  }));
}

async function renderExpenses(params = {}) {
  const tab = EXPENSE_TABS.some((t) => t.key === params.tab) ? params.tab : 'overview';
  setChrome({ title: 'Expenses', showBack: false, showLogout: true });
  if (tab === 'all') return renderAllExpensesTab();

  app.innerHTML = LOADING_HTML;
  const [{ expenses: inbox }, { funds: fundBalances }, { expenses: recent }] = await Promise.all([
    api('/api/pg/expenses/inbox'),
    api('/api/pg/funds/balances'),
    api('/api/pg/expenses'),
  ]);

  function fundTileHtml(f) {
    const over = f.OverBudget;
    const pct = f.Amount > 0 ? Math.min(100, Math.round((f.Spent / f.Amount) * 100)) : 0;
    const color = over ? '#c0392b' : '#2e8b57';
    return `<div class="card" style="border-left:4px solid ${color}">
      <strong>${escapeHtml(f.Name)}</strong>
      <p style="margin:4px 0${over ? ';color:' + color + ';font-weight:600' : ''}">
        ${over ? `$${Math.abs(f.Remaining).toLocaleString()} OVER the $${f.Amount.toLocaleString()} line` : `$${f.Spent.toLocaleString()} of $${f.Amount.toLocaleString()} remaining: $${f.Remaining.toLocaleString()}`}
        ${f.DaysLeft != null ? ` · ${f.DaysLeft >= 0 ? `${f.DaysLeft} days left` : 'ended'}` : ''}
      </p>
      <div style="background:#e5e5ea;border-radius:4px;height:6px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${color}"></div></div>
    </div>`;
  }

  app.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h3 style="margin:0">Expenses</h3>
        <button class="btn btn-primary" id="addExpenseBtn" style="width:auto;margin-top:0">+ Add Expense</button>
      </div>
      <p class="muted">Camp debit card spending — Ben's own record, separate from what he emails the treasurer directly. Receipts forward to receipts@cmms.fracturedrv.com.</p>
    </div>
    ${expenseTabsHtml(tab)}
    ${fundBalances.filter((f) => f.Active).map(fundTileHtml).join('')}
    <div class="card"><h3>Receipt Inbox${inbox.length ? ` <span class="pill">${inbox.length}</span>` : ''}</h3>
      ${!inbox.length ? '<p class="muted">Nothing waiting.</p>' : ''}
      <div id="expenseInboxList"></div>
    </div>
    <div class="card"><h3>Recent Expenses</h3>
      <div id="expenseRecentList"></div>
      <p class="muted" style="margin-top:8px"><a href="#" id="viewExpenseReportLink">See all, with filters, in Reports →</a></p>
    </div>`;

  const inboxListEl = document.getElementById('expenseInboxList');
  inboxListEl.innerHTML = inbox.map(expenseInboxCardHtml).join('');
  inboxListEl.querySelectorAll('.expense-card').forEach((el) => el.addEventListener('click', (evt) => {
    if (evt.target.closest('button')) return;
    go('expenseDetail', { id: el.dataset.id });
  }));
  inboxListEl.querySelectorAll('.expense-void-btn').forEach((btn) => btn.addEventListener('click', async (evt) => {
    evt.stopPropagation();
    try { await api(`/api/pg/expenses/${btn.dataset.id}/void`, { method: 'POST' }); toast('Voided'); renderExpenses(); }
    catch (err) { toast(err.message); }
  }));

  const recentListEl = document.getElementById('expenseRecentList');
  recentListEl.innerHTML = recent.slice(0, 15).map((e) => `
    <div class="list-item" data-id="${e.Id}">
      <span>${escapeHtml(e.Vendor || '(no vendor)')}${e.CategoryName ? ` · ${escapeHtml(e.CategoryName)}` : ''}</span>
      <span class="muted">${e.Amount != null ? `$${Number(e.Amount).toLocaleString()}` : '—'}${e.PurchaseDate ? ` · ${formatDateNice(e.PurchaseDate)}` : ''}</span>
    </div>`).join('') || '<p class="muted">No expenses yet.</p>';
  recentListEl.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => go('expenseDetail', { id: el.dataset.id })));

  document.getElementById('viewExpenseReportLink').addEventListener('click', (e) => { e.preventDefault(); go('reports', { entity: 'expenses' }); });
  document.getElementById('addExpenseBtn').addEventListener('click', () => go('expenseDetail', {}));
  wireExpenseTabs();
}

// "All Expenses" — the full list, plain and browsable: search by vendor,
// filter by fund/category, sort by date or amount, click a row to edit.
// Deliberately NOT the Reports data explorer — no grouping, no export, no
// charts, no saved favorites; this answers "what have I entered," the
// explorer answers "what does my spending look like." Server-side search/
// filter/sort/pagination (listExpenses in db.js) rather than fetching
// everything client-side, so this stays fast as the expense count grows.
const ALL_EXPENSES_PAGE_SIZE = 50;
async function renderAllExpensesTab() {
  app.innerHTML = LOADING_HTML;
  const funds = state.options.funds || [];
  const expenseCategories = state.options.expenseCategories || [];

  app.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h3 style="margin:0">Expenses</h3>
        <button class="btn btn-primary" id="addExpenseBtn" style="width:auto;margin-top:0">+ Add Expense</button>
      </div>
    </div>
    ${expenseTabsHtml('all')}
    <div class="card">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px">
        <div class="field-row" style="flex:2;min-width:160px;margin:0"><label>Search vendor</label><input type="text" id="allExpSearch" placeholder="e.g. Amazon" /></div>
        <div class="field-row" style="flex:1;min-width:140px;margin:0"><label>Fund</label><select id="allExpFund">
          <option value="">All funds</option>
          ${funds.map((f) => `<option value="${f.Id}">${escapeHtml(f.Name)}</option>`).join('')}
        </select></div>
        <div class="field-row" style="flex:1;min-width:140px;margin:0"><label>Category</label><select id="allExpCategory">
          <option value="">All categories</option>
          ${expenseCategories.map((c) => `<option value="${c.Id}">${escapeHtml(c.Name)}</option>`).join('')}
        </select></div>
        <div class="field-row" style="flex:1;min-width:160px;margin:0"><label>Sort</label>
          <select id="allExpSort">
            <option value="date:desc">Date (newest first)</option>
            <option value="date:asc">Date (oldest first)</option>
            <option value="amount:desc">Amount (high to low)</option>
            <option value="amount:asc">Amount (low to high)</option>
          </select>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="report-table" data-card="1">
          <thead><tr>
            <th>Date</th>
            <th>Vendor</th>
            <th>Category</th>
            <th>Fund</th>
            <th style="text-align:right">Amount</th>
          </tr></thead>
          <tbody id="allExpTableBody"></tbody>
        </table>
      </div>
      <p class="muted" id="allExpEmpty" hidden style="margin:10px 0">No expenses match these filters.</p>
      <div class="btn-row" style="margin-top:10px">
        <button type="button" class="btn btn-secondary" id="allExpLoadMore" style="width:auto" hidden>Load more</button>
      </div>
      <p class="muted" id="allExpCount" style="margin-top:6px;font-size:0.85rem"></p>
      <p class="muted" style="margin-top:8px"><a href="#" id="viewExpenseReportLink">See all, with filters, in Reports →</a></p>
    </div>`;

  document.getElementById('addExpenseBtn').addEventListener('click', () => go('expenseDetail', {}));
  document.getElementById('viewExpenseReportLink').addEventListener('click', (e) => { e.preventDefault(); go('reports', { entity: 'expenses' }); });
  wireExpenseTabs();

  const tbody = document.getElementById('allExpTableBody');
  const emptyMsg = document.getElementById('allExpEmpty');
  const loadMoreBtn = document.getElementById('allExpLoadMore');
  const countLabel = document.getElementById('allExpCount');
  const searchInput = document.getElementById('allExpSearch');
  const fundSelect = document.getElementById('allExpFund');
  const categorySelect = document.getElementById('allExpCategory');
  const sortSelect = document.getElementById('allExpSort');

  let offset = 0;
  let total = 0;
  let loaded = 0;
  let requestSeq = 0; // guards against a slow earlier fetch clobbering a newer filter change

  function rowHtml(e) {
    return `<tr class="all-exp-row clickable-row" data-id="${e.Id}">
      <td>${e.PurchaseDate ? formatDateNice(e.PurchaseDate) : '—'}</td>
      <td>${escapeHtml(e.Vendor || '(no vendor)')}</td>
      <td>${escapeHtml(e.CategoryName || '—')}</td>
      <td>${escapeHtml(e.FundName || '—')}</td>
      <td style="text-align:right">${e.Amount != null ? `$${Number(e.Amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</td>
    </tr>`;
  }

  async function loadPage({ reset }) {
    const seq = ++requestSeq;
    if (reset) { offset = 0; tbody.innerHTML = ''; loaded = 0; }
    const [sortBy, sortDir] = sortSelect.value.split(':');
    const qs = new URLSearchParams({
      sortBy, sortDir, limit: String(ALL_EXPENSES_PAGE_SIZE), offset: String(offset),
    });
    if (searchInput.value.trim()) qs.set('vendor', searchInput.value.trim());
    if (fundSelect.value) qs.set('fundId', fundSelect.value);
    if (categorySelect.value) qs.set('categoryId', categorySelect.value);

    const { expenses, total: newTotal } = await api(`/api/pg/expenses?${qs.toString()}`);
    if (seq !== requestSeq) return; // a newer request already landed

    total = newTotal;
    tbody.insertAdjacentHTML('beforeend', expenses.map(rowHtml).join(''));
    tbody.querySelectorAll('.all-exp-row').forEach((tr) => {
      if (tr.dataset.wired) return;
      tr.dataset.wired = '1';
      tr.addEventListener('click', () => go('expenseDetail', { id: tr.dataset.id }));
    });
    offset += expenses.length;
    loaded += expenses.length;

    emptyMsg.hidden = loaded !== 0;
    loadMoreBtn.hidden = loaded >= total;
    countLabel.textContent = total ? `Showing ${loaded} of ${total}` : '';
  }

  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadPage({ reset: true }), 300);
  });
  fundSelect.addEventListener('change', () => loadPage({ reset: true }));
  categorySelect.addEventListener('change', () => loadPage({ reset: true }));
  sortSelect.addEventListener('change', () => loadPage({ reset: true }));
  loadMoreBtn.addEventListener('click', () => loadPage({ reset: false }));

  await loadPage({ reset: true });
}

// Blanks remote images (and CSS background-image urls) in a vendor email's
// HTML before it ever reaches the iframe, so a tracking pixel never even
// attempts the network request just because the details panel was open —
// the sandboxed iframe (sandbox attribute, no scripts/no same-origin/no
// forms — see originalEmailHtml) is the real security boundary, this is
// belt-and-suspenders for privacy, not for safety. Runs via DOMParser
// (never innerHTML on the live document) so the vendor markup is parsed
// inert the whole time; <script> is stripped outright regardless of the
// images toggle since the sandbox already blocks it and there's no reason
// to ship it into the iframe at all.
function sanitizeEmailHtml(html, { showImages }) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script').forEach((el) => el.remove());
  if (!showImages) {
    doc.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src');
      if (src) img.setAttribute('data-blocked-src', src);
      img.removeAttribute('src');
      img.removeAttribute('srcset');
    });
    doc.querySelectorAll('[style]').forEach((el) => {
      const style = el.getAttribute('style') || '';
      if (/url\(/i.test(style)) el.setAttribute('style', style.replace(/url\([^)]*\)/gi, 'none'));
    });
  }
  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

// The source email itself — subject/sender/date plus the full body, so
// confirming a parsed amount/vendor/date never requires leaving the app to
// go check a phone's mail client or dig up the original Amazon order. Open
// by default: this is the primary thing being confirmed on a triage screen,
// not a detail to dig for.
//
// HTML is the default view when Mailgun sent one (body-html, stored since
// migration 0055) — vendor receipt emails are designed for HTML rendering
// and the plain-text alternate part is frequently mangled (see
// expenseParsing.js's CURRENCY_RE comment: Amazon drops decimal points out
// of prices in its plain-text part). Rendered in a sandboxed iframe with an
// empty `sandbox` attribute — no scripts, no same-origin, no forms, nothing
// — with remote images blocked by default (vendor emails carry tracking
// pixels) behind a "Load images" toggle. Plain text stays one click away as
// a fallback for messages where the HTML looks broken or wasn't captured.
// The actual <iframe>/<pre> content is filled in by initOriginalEmailViewer
// after this markup is in the DOM (srcdoc needs JS, not an HTML string).
function originalEmailHtml(expense) {
  const hasHtml = !!expense.BodyHtml;
  const hasText = !!expense.BodyText;
  const metaHtml = `<p class="muted" style="margin:6px 0 2px">
      ${expense.SenderEmail ? `From ${escapeHtml(expense.SenderEmail)}` : ''}${expense.ReceivedAt ? `${expense.SenderEmail ? ' · ' : ''}${new Date(expense.ReceivedAt).toLocaleString()}` : ''}
    </p>`;
  if (!hasHtml && !hasText) {
    return `<details class="card" open style="margin:10px 0;background:var(--card-bg,#f7f7fa)">
      <summary style="cursor:pointer;font-weight:600">Original Email${expense.Subject ? `: ${escapeHtml(expense.Subject)}` : ''}</summary>
      ${metaHtml}
      <p class="muted">No body captured for this message.</p>
    </details>`;
  }
  return `<details class="card" open style="margin:10px 0;background:var(--card-bg,#f7f7fa)">
    <summary style="cursor:pointer;font-weight:600">Original Email${expense.Subject ? `: ${escapeHtml(expense.Subject)}` : ''}</summary>
    ${metaHtml}
    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:4px 0 8px;font-size:0.85rem">
      ${hasHtml ? `<label style="display:flex;align-items:center;gap:5px;font-weight:400;cursor:pointer"><input type="checkbox" id="emailViewPlainToggle" style="width:auto" /> View as plain text</label>` : ''}
      ${hasHtml ? `<label id="emailLoadImagesRow" style="display:flex;align-items:center;gap:5px;font-weight:400;cursor:pointer"><input type="checkbox" id="emailLoadImagesToggle" style="width:auto" /> Load images (vendor emails often carry tracking pixels)</label>` : ''}
    </div>
    <iframe id="emailHtmlFrame" sandbox="" title="Original email" ${hasHtml ? '' : 'hidden'} style="width:100%;min-height:320px;border:1px solid var(--border,#ddd);border-radius:8px;background:#fff"></iframe>
    <pre id="emailPlainText" ${hasHtml ? 'hidden' : ''} style="white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:0.9rem;max-height:320px;overflow-y:auto;margin:8px 0 0;padding:10px;background:var(--bg,#fff);border-radius:8px;border:1px solid var(--border,#ddd)">${escapeHtml(expense.BodyText || '(no plain-text body captured)')}</pre>
  </details>`;
}

// Wires up the toggles for the panel originalEmailHtml() just rendered —
// separate from that function because an iframe's content has to be set via
// srcdoc in JS, never inlined as an HTML string (that's exactly the
// unsanitized-string-into-markup pattern the sandboxed iframe + DOMParser
// sanitizer above both exist to avoid).
function initOriginalEmailViewer(expense) {
  const frame = document.getElementById('emailHtmlFrame');
  if (!frame) return; // neither BodyHtml nor BodyText — nothing interactive to wire up
  const plainToggle = document.getElementById('emailViewPlainToggle');
  const imagesToggle = document.getElementById('emailLoadImagesToggle');
  const imagesRow = document.getElementById('emailLoadImagesRow');
  const plainPre = document.getElementById('emailPlainText');

  function renderFrame() {
    if (expense.BodyHtml) frame.srcdoc = sanitizeEmailHtml(expense.BodyHtml, { showImages: !!imagesToggle?.checked });
  }
  function applyMode() {
    const showPlain = !!plainToggle?.checked;
    frame.hidden = showPlain || !expense.BodyHtml;
    plainPre.hidden = !showPlain && !!expense.BodyHtml;
    if (imagesRow) imagesRow.hidden = showPlain;
  }
  renderFrame();
  applyMode();
  plainToggle?.addEventListener('change', applyMode);
  imagesToggle?.addEventListener('change', renderFrame);
}

// Create/edit/triage — one form for all three (brief §3.2: "Add expense"
// opens the same form with empty fields). A manual "Add" POSTs immediately
// (triage_status='triaged' from the start — there's nothing to triage about
// an entry Ben is typing himself) then lands here again in edit mode so a
// receipt photo can still be attached. An inbox row PATCHes, which flips
// triage_status from 'inbox' to 'triaged' as a side effect of any save.
async function renderExpenseDetail({ id } = {}) {
  setChrome({ title: id ? 'Edit Expense' : 'Add Expense', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const expense = id ? (await api(`/api/pg/expenses/${id}`)).expense : null;
  if (id && !expense) { app.innerHTML = '<div class="card"><p class="muted">Expense not found.</p></div>'; return; }
  const funds = state.options.funds || [];
  const expenseCategories = state.options.expenseCategories || [];

  app.innerHTML = `
    <div class="card">
      <h3>${id ? 'Edit Expense' : 'Add Expense'}</h3>
      ${expense?.Source === 'email' && (expense.Subject || expense.BodyText || expense.BodyHtml) ? originalEmailHtml(expense) : ''}
      ${id ? '<div id="expenseReceiptSection"></div>' : '<p class="muted">You can attach a receipt photo once this is saved.</p>'}
      <form id="expenseForm" style="margin-top:12px">
        <div class="field-row"><label>Vendor${expenseParsedBadge(expense)}</label><input name="vendor" value="${escapeHtml(expense?.Vendor || '')}" placeholder="e.g. Ace Hardware" /></div>
        <div class="field-row"><label>Amount</label><input name="amount" type="number" step="0.01" min="0" value="${expense?.Amount ?? ''}" /></div>
        <div class="field-row"><label>Purchase Date</label><input name="purchaseDate" type="date" value="${(expense?.PurchaseDate || '').slice(0, 10)}" /></div>
        <div class="field-row"><label>Tax Amount</label><input name="taxAmount" type="number" step="0.01" min="0" value="${expense?.TaxAmount ?? ''}" /></div>
        <label style="display:flex;align-items:center;gap:8px;font-weight:400;margin:8px 0">
          <input type="checkbox" name="taxChargedInError" ${expense?.TaxChargedInError ? 'checked' : ''} style="width:auto" />
          Tax charged in error (camp is tax-exempt — flags this for the quarterly recovery list)
        </label>
        <div class="field-row"><label>Category</label><select name="categoryId">${categoryPickerOptionsHtml(expenseCategories, expense?.CategoryId)}</select></div>
        <div class="field-row"><label>Fund</label><select name="fundId">${fundPickerOptionsHtml(funds, expense?.FundId)}</select>
          <p class="muted" style="margin-top:2px;font-size:0.8rem">A reference line, not a cap — going over always saves, it just shows as a warning on the Expenses page.</p>
        </div>
        <div class="field-row"><label>Work Order (optional)</label><select id="expenseWoPicker"><option value="">— none —</option></select></div>
        <div class="field-row" id="expenseLineRow" hidden><label>Job Line (optional)</label><select id="expenseLinePicker"><option value="">— none —</option></select>
          <p class="muted" style="margin-top:2px;font-size:0.8rem">Picking a line funded by a fund defaults Fund above, if you haven't already chosen one yourself.</p>
        </div>
        <div class="field-row"><label>Asset (optional)</label><div class="asset-picker" id="expenseAssetPicker"></div></div>
        <div class="field-row"><label>Notes</label><textarea name="notes">${escapeHtml(expense?.Notes || '')}</textarea></div>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Save</button>
          ${id ? '<button type="button" class="btn btn-secondary" id="splitExpenseBtn">Split this receipt…</button>' : ''}
          ${id ? '<button type="button" class="btn btn-secondary" id="voidExpenseBtn">Void</button>' : ''}
        </div>
      </form>
    </div>`;

  if (id) {
    renderAttachmentSection('expense', id, document.getElementById('expenseReceiptSection'), {
      title: 'Receipt', defaultRoleName: 'Receipt', accept: 'image/*,application/pdf',
    });
  }
  if (expense?.Source === 'email' && (expense.Subject || expense.BodyText || expense.BodyHtml)) initOriginalEmailViewer(expense);

  let selectedAsset = expense?.AssetId ? { Id: expense.AssetId, Name: expense.AssetName } : null;
  mountAssetCombobox(document.getElementById('expenseAssetPicker'), {
    initialAsset: selectedAsset, onSelect: (a) => { selectedAsset = a; },
  });

  const form = document.getElementById('expenseForm');
  const woPicker = document.getElementById('expenseWoPicker');
  const lineRow = document.getElementById('expenseLineRow');
  const linePicker = document.getElementById('expenseLinePicker');

  const { workOrders } = await api('/api/pg/work-orders');
  woPicker.innerHTML = '<option value="">— none —</option>' + workOrders.map((w) =>
    `<option value="${w.Id}" ${w.Id === expense?.WorkOrderId ? 'selected' : ''}>${escapeHtml(w.Title)}${w.WoNumber ? ` (WO ${w.WoNumber})` : ''}</option>`
  ).join('');

  async function loadJobLinesFor(woId, selectedLineId) {
    if (!woId) { lineRow.hidden = true; linePicker.innerHTML = '<option value="">— none —</option>'; return; }
    const wo = await api(`/api/pg/work-orders/${woId}`);
    lineRow.hidden = false;
    linePicker.innerHTML = '<option value="">— none —</option>' + (wo.jobLines || []).map((jl) =>
      `<option value="${jl.Id}" ${jl.Id === selectedLineId ? 'selected' : ''}>${escapeHtml(jl.Title)}</option>`
    ).join('');
  }
  if (expense?.WorkOrderId) await loadJobLinesFor(expense.WorkOrderId, expense.JobLineId);
  woPicker.addEventListener('change', () => loadJobLinesFor(woPicker.value ? Number(woPicker.value) : null, null));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      vendor: fd.get('vendor') || null,
      amount: fd.get('amount') || null,
      purchaseDate: fd.get('purchaseDate') || null,
      taxAmount: fd.get('taxAmount') || null,
      taxChargedInError: fd.has('taxChargedInError'),
      categoryId: fd.get('categoryId') || null,
      fundId: fd.get('fundId') || null,
      jobLineId: linePicker.value || null,
      workOrderId: woPicker.value || null,
      assetId: selectedAsset?.Id || null,
      notes: fd.get('notes') || null,
    };
    try {
      if (id) {
        await api(`/api/pg/expenses/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        toast('Expense saved');
        go('expenses', {}, { replace: true });
      } else {
        const { expense: created } = await api('/api/pg/expenses', { method: 'POST', body: JSON.stringify(payload) });
        toast('Expense added — attach a receipt below if you have one');
        go('expenseDetail', { id: created.Id }, { replace: true });
      }
    } catch (err) { toast(err.message); }
  });

  // Opens only when asked. Saving the expense normally still writes its single
  // destination behind the scenes, so nothing about the fast path changed.
  document.getElementById('splitExpenseBtn')?.addEventListener('click', () => {
    openSplitEditor(id, { onClose: () => go('expenseDetail', { id }, { replace: true }) });
  });

  document.getElementById('voidExpenseBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog('Void this expense? The receipt file (if any) is untouched and this can be undone from the expense.')) return;
    try { await api(`/api/pg/expenses/${id}/void`, { method: 'POST' }); toast('Voided'); go('expenses', {}, { replace: true }); }
    catch (err) { toast(err.message); }
  });
}

// ── Administrative tasks — work that isn't tied to an asset or a work order
//    (vendor calls, account cleanup, insurance paperwork). Documentation, not
//    accounting: no asset, fund, job lines or cost on purpose. Shows in the
//    Work Performed report's Administrative Work section. ─────────────────
function fmtSavings(n) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function renderAdminTasks() {
  setChrome({ title: 'Admin Tasks', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const [{ statuses }, { categories }] = await Promise.all([
    api('/api/pg/admin-task-statuses'), api('/api/pg/admin-task-categories'),
  ]);

  app.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h3 style="margin:0">Administrative Tasks</h3>
        <button class="btn btn-primary" id="addAdminTaskBtn" style="width:auto;margin-top:0">+ Add Task</button>
      </div>
      <p class="muted">Work that isn't tied to a building or a work order — vendor calls, account cleanup, insurance paperwork. Shows in Reports → Work Performed alongside the buildings.</p>
    </div>
    <div class="card">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px">
        <div class="field-row" style="flex:2;min-width:160px;margin:0"><label>Search</label><input type="text" id="atSearch" placeholder="Title or description" /></div>
        <div class="field-row" style="flex:1;min-width:140px;margin:0"><label>Status</label><select id="atStatus">
          <option value="">All statuses</option>
          ${statuses.map((st) => `<option value="${st.Id}">${escapeHtml(st.Name)}${st.Active ? '' : ' (inactive)'}</option>`).join('')}
        </select></div>
        <div class="field-row" style="flex:1;min-width:140px;margin:0"><label>Category</label><select id="atCategory">
          <option value="">All categories</option>
          ${categories.map((c) => `<option value="${c.Id}">${escapeHtml(c.Name)}${c.Active ? '' : ' (inactive)'}</option>`).join('')}
        </select></div>
        <div class="field-row" style="flex:2;min-width:220px;margin:0"><label>Date range</label>
          <div class="report-date-range">
            <input type="date" id="atFrom" />
            <span class="muted">to</span>
            <input type="date" id="atTo" />
          </div>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="report-table" data-card="1">
          <thead><tr>
            <th>Date</th><th>Title</th><th>Category</th><th>Status</th>
            <th style="text-align:right">Hours</th><th style="text-align:right">Savings / mo</th>
          </tr></thead>
          <tbody id="atTableBody"></tbody>
        </table>
      </div>
      <p class="muted" id="atEmpty" hidden style="margin:10px 0">No tasks match these filters.</p>
      <p class="muted" id="atSummary" style="margin-top:6px;font-size:0.85rem"></p>
    </div>`;

  document.getElementById('addAdminTaskBtn').addEventListener('click', () => go('adminTaskDetail', {}));
  const tbody = document.getElementById('atTableBody');
  const emptyMsg = document.getElementById('atEmpty');
  const summary = document.getElementById('atSummary');
  let requestSeq = 0; // a slow earlier fetch must not overwrite a newer filter's results

  async function load() {
    const seq = ++requestSeq;
    const qs = new URLSearchParams();
    const val = (id) => document.getElementById(id).value.trim();
    if (val('atSearch')) qs.set('q', val('atSearch'));
    if (val('atStatus')) qs.set('statusId', val('atStatus'));
    if (val('atCategory')) qs.set('categoryId', val('atCategory'));
    if (val('atFrom')) qs.set('dateFrom', val('atFrom'));
    if (val('atTo')) qs.set('dateTo', val('atTo'));
    let tasks;
    try { ({ tasks } = await api(`/api/pg/admin-tasks?${qs}`)); }
    catch (err) { toast(err.message); return; }
    if (seq !== requestSeq) return;
    tbody.innerHTML = tasks.map((t) => `
      <tr class="clickable-row" data-id="${t.Id}" style="cursor:pointer">
        <td style="white-space:nowrap">${escapeHtml(formatDateNice(t.TaskDate))}</td>
        <td>${escapeHtml(t.Title)}${t.AttachmentCount ? ` <span class="muted" title="${t.AttachmentCount} attachment(s)">📎${t.AttachmentCount}</span>` : ''}</td>
        <td>${escapeHtml(t.CategoryName || '—')}</td>
        <td>${escapeHtml(t.StatusName)}</td>
        <td style="text-align:right">${t.Hours != null ? t.Hours : '—'}</td>
        <td style="text-align:right">${t.RecurringMonthlySavings != null ? fmtSavings(t.RecurringMonthlySavings) : ''}</td>
      </tr>`).join('');
    emptyMsg.hidden = tasks.length > 0;
    const hours = tasks.reduce((sum, t) => sum + (t.Hours || 0), 0);
    const savings = tasks.reduce((sum, t) => sum + (t.RecurringMonthlySavings || 0), 0);
    summary.textContent = tasks.length
      ? `${tasks.length} task(s) · ${Math.round(hours * 100) / 100}h${savings ? ` · ${fmtSavings(savings)}/mo in recurring savings (${fmtSavings(savings * 12)}/yr)` : ''}`
      : '';
    tbody.querySelectorAll('tr[data-id]').forEach((row) => row.addEventListener('click', () => {
      const t = tasks.find((x) => String(x.Id) === row.dataset.id);
      go('adminTaskDetail', { id: row.dataset.id, title: t?.Title });
    }));
  }

  let searchTimer;
  document.getElementById('atSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 250); });
  ['atStatus', 'atCategory', 'atFrom', 'atTo'].forEach((id) => document.getElementById(id).addEventListener('change', load));
  await load();
}

async function renderAdminTaskDetail({ id } = {}) {
  setChrome({ title: id ? 'Admin Task' : 'New Admin Task', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const [taskRes, { statuses }, { categories }] = await Promise.all([
    id ? api(`/api/pg/admin-tasks/${id}`) : Promise.resolve({ task: null }),
    api('/api/pg/admin-task-statuses'), api('/api/pg/admin-task-categories'),
  ]);
  const task = taskRes.task;
  if (id && !task) { app.innerHTML = '<div class="card"><p class="muted">Task not found.</p></div>'; return; }

  // Inactive entries stay hidden from new picks but still show when a task
  // already uses one, so editing an old task never silently changes it.
  const statusChoices = statuses.filter((st) => st.Active || st.Id === task?.StatusId);
  const categoryChoices = categories.filter((c) => c.Active || c.Id === task?.CategoryId);
  const defaultStatus = task?.StatusId
    ?? (statusChoices.find((st) => st.Name === 'Done') || statusChoices.find((st) => st.CountsAsWorkPerformed) || statusChoices[0])?.Id;

  app.innerHTML = `
    <div class="card">
      <h3>${id ? 'Edit Task' : 'New Task'}</h3>
      <form id="adminTaskForm">
        <div class="field-row"><label>Title</label><input name="title" required value="${escapeHtml(task?.Title || '')}" placeholder="e.g. Cancelled unused Verizon line" /></div>
        <div class="field-row"><label>Description</label><textarea name="description" rows="4">${escapeHtml(task?.Description || '')}</textarea></div>
        <div class="field-row"><label>Date</label><input name="taskDate" type="date" required value="${escapeHtml(task?.TaskDate || isoDate(new Date()))}" /></div>
        <div class="field-row"><label>Hours</label><input name="hours" type="number" step="any" min="0" value="${task?.Hours ?? ''}" /></div>
        <div class="field-row"><label>Status</label><select name="statusId" required>
          ${statusChoices.map((st) => `<option value="${st.Id}" ${st.Id === defaultStatus ? 'selected' : ''}>${escapeHtml(st.Name)}${st.Active ? '' : ' (inactive)'}</option>`).join('')}
        </select>
          <p class="muted" style="margin-top:2px;font-size:0.8rem">Statuses marked "counts as work performed" in Admin put the task in the Work Performed report.</p>
        </div>
        <div class="field-row"><label>Category (optional)</label><select name="categoryId">${categoryPickerOptionsHtml(categoryChoices, task?.CategoryId)}</select></div>
        <div class="field-row"><label>Recurring monthly savings (optional)</label>
          <input name="recurringMonthlySavings" type="number" step="0.01" min="0" value="${task?.RecurringMonthlySavings ?? ''}" placeholder="Leave blank unless this cut a recurring cost" />
          <p class="muted" style="margin-top:2px;font-size:0.8rem">Only when the task eliminated or reduced a recurring cost — e.g. a cancelled $45/month subscription. The report totals it monthly and annualized.</p>
        </div>
        <div class="field-row">
          <label class="skill-chip ${task?.IncludeInBoardReport !== false ? 'selected' : ''}" style="cursor:pointer;display:inline-flex"><input type="checkbox" name="includeInBoardReport" style="margin-right:6px" ${task?.IncludeInBoardReport !== false ? 'checked' : ''} />Include on board report</label>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Save</button>
          ${id ? '<button type="button" class="btn btn-secondary" id="deleteAdminTaskBtn">Delete</button>' : ''}
        </div>
      </form>
      ${id ? '<div id="adminTaskAttachments"></div>' : '<p class="muted" style="margin-top:10px">You can attach documents once this is saved.</p>'}
      ${task ? `<p class="muted" style="margin-top:10px;font-size:0.8rem">Added${task.CreatedBy ? ` by ${escapeHtml(task.CreatedBy)}` : ''} ${escapeHtml(formatDateNice(task.CreatedAt))}</p>` : ''}
    </div>`;

  const boardReportCheckbox = document.querySelector('#adminTaskForm input[name="includeInBoardReport"]');
  boardReportCheckbox.addEventListener('change', () => {
    boardReportCheckbox.closest('.skill-chip').classList.toggle('selected', boardReportCheckbox.checked);
  });

  if (id) {
    renderAttachmentSection('admin_task', id, document.getElementById('adminTaskAttachments'), {
      title: 'Attachments', defaultRoleName: 'Documentation', accept: 'image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt',
    });
  }

  document.getElementById('adminTaskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      title: fd.get('title'),
      description: fd.get('description') || null,
      taskDate: fd.get('taskDate'),
      hours: fd.get('hours') === '' ? null : fd.get('hours'),
      statusId: fd.get('statusId'),
      categoryId: fd.get('categoryId') || null,
      recurringMonthlySavings: fd.get('recurringMonthlySavings') === '' ? null : fd.get('recurringMonthlySavings'),
      includeInBoardReport: fd.has('includeInBoardReport'),
    };
    try {
      if (id) {
        await api(`/api/pg/admin-tasks/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        toast('Task saved');
        go('adminTasks', {}, { replace: true });
      } else {
        const { task: created } = await api('/api/pg/admin-tasks', { method: 'POST', body: JSON.stringify(payload) });
        toast('Task added — attach documents below if you have any');
        go('adminTaskDetail', { id: created.Id, title: created.Title }, { replace: true });
      }
    } catch (err) { toast(err.message); }
  });

  document.getElementById('deleteAdminTaskBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog('Delete this task? Attached files are unlinked from it but not deleted.', { confirmLabel: 'Delete' })) return;
    try { await api(`/api/pg/admin-tasks/${id}`, { method: 'DELETE' }); toast('Task deleted'); go('adminTasks', {}, { replace: true }); }
    catch (err) { toast(err.message); }
  });
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
  { key: 'jobLines', label: 'Job Lines' },
  { key: 'findings', label: 'Findings' },
  { key: 'workOrderLog', label: 'Progress Log' },
  { key: 'crewSessions', label: 'Crew Sessions' },
  { key: 'expenses', label: 'Expenses' },
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

// Reports has three tools sharing one nav entry (data explorer + the two
// board-facing snapshot reports) — a shared tab bar switches between them via
// a `mode` param, each tool otherwise fully independent.
const REPORT_TABS = [
  { key: 'explorer', label: 'Data Explorer' },
  { key: 'board', label: 'Board Report' },
  { key: 'workPerformed', label: 'Work Performed' },
  { key: 'deferredBacklog', label: 'Deferred Backlog' },
  { key: 'visitorActivity', label: 'Visitor Activity' },
  { key: 'auditData', label: 'Audit Data' },
];
function reportsTabsHtml(mode) {
  return `<div class="card">
    <div class="view-toggle">
      ${REPORT_TABS.map((t) => `<button type="button" class="view-toggle-btn reports-tab-btn ${mode === t.key ? 'active' : ''}" data-mode="${t.key}">${escapeHtml(t.label)}</button>`).join('')}
    </div>
  </div>`;
}
function wireReportsTabs(container = app) {
  container.querySelectorAll('.reports-tab-btn').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) return;
    go('reports', { mode: btn.dataset.mode }, { replace: true });
  }));
}

async function renderReports(params = {}) {
  const mode = REPORT_TABS.some((t) => t.key === params.mode) ? params.mode : 'explorer';
  if (mode === 'board') return renderBoardReport();
  if (mode === 'workPerformed') return renderWorkPerformedReport();
  if (mode === 'deferredBacklog') return renderDeferredBacklogReport();
  if (mode === 'visitorActivity') return renderVisitorActivityReport();
  if (mode === 'auditData') return renderAuditData();
  return renderReportsExplorer(params);
}

async function renderReportsExplorer(params = {}) {
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
      ${reportsTabsHtml('explorer')}
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
    wireReportsTabs();
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

// ---------- Board / Forward Focus reports: generate → preview iframe →
// print/download/email, mirroring the legacy Activity/Capital report UI in
// public/app.js but hitting the pg-api board/forward-focus endpoints. ----------

function reportPreviewAreaHtml(report) {
  if (!report) return '';
  return `
    <div class="card">
      <h3>${escapeHtml(report.title)}</h3>
      <iframe id="reportFrame" style="width:100%;height:480px;border:1px solid var(--border);border-radius:var(--radius);background:#fff"></iframe>
      <div class="btn-row" style="margin-top:10px">
        <button type="button" class="btn btn-secondary" id="reportPrintBtn">Print / Save as PDF</button>
        <button type="button" class="btn btn-secondary" id="reportDlHtmlBtn">Download HTML</button>
        <button type="button" class="btn btn-secondary" id="reportDlTextBtn">Download Text</button>
      </div>
    </div>
    <div class="card">
      <h3>Email It</h3>
      <div class="field-row"><label>Recipient</label><input type="email" id="reportRecipient" placeholder="someone@example.com" /></div>
      <div class="field-row"><label>Subject</label><input type="text" id="reportSubject" value="Camp Sychar — ${escapeHtml(report.title)}" /></div>
      <div class="btn-row"><button type="button" class="btn btn-primary" id="reportSendBtn">Send Email</button></div>
    </div>`;
}
function wireReportPreviewArea(report, { sendPath, sendBody }) {
  if (!report) return;
  const frame = document.getElementById('reportFrame');
  frame.srcdoc = report.html;
  document.getElementById('reportPrintBtn').addEventListener('click', () => { frame.contentWindow.focus(); frame.contentWindow.print(); });
  document.getElementById('reportDlHtmlBtn').addEventListener('click', () => downloadBlob(report.html, `${slugify(report.title)}.html`, 'text/html'));
  document.getElementById('reportDlTextBtn').addEventListener('click', () => downloadBlob(report.text, `${slugify(report.title)}.txt`, 'text/plain'));
  document.getElementById('reportSendBtn').addEventListener('click', async () => {
    const recipient = document.getElementById('reportRecipient').value.trim();
    const subject = document.getElementById('reportSubject').value.trim();
    if (!recipient) { toast('Enter a recipient email'); return; }
    const btn = document.getElementById('reportSendBtn');
    btn.textContent = 'Sending…'; btn.disabled = true;
    try {
      await api(sendPath, { method: 'POST', body: JSON.stringify({ ...sendBody(), recipient, subject }) });
      toast('Report emailed');
    } catch (err) { toast(err.message); }
    finally { btn.textContent = 'Send Email'; btn.disabled = false; }
  });
}

// Board Report draft editor (Build Brief §6/§7). Replaces the old ad-hoc range picker:
// there is one report now, it is an entity, and everything on it is a decision you can
// see and change. Suggestions arrive pre-checked; nothing is ever force-included.
async function renderBoardReport() {
  setChrome({ title: 'Reports', showBack: false, showLogout: true });
  let report = null; let items = []; let aggregates = []; let outputs = [];
  let busy = false;
  const expanded = new Set();   // which work orders are showing their lines

  async function load() {
    const d = await api('/api/pg/board-reports/draft');
    report = d.report; items = d.items || []; aggregates = d.aggregates || [];
    const hist = await api('/api/pg/board-reports');
    outputs = hist.outputs || [];
  }

  const linesOf = (woId) => items.filter((i) => i.ItemType === 'job_line' && i.ParentWorkOrderId === woId);

  // Tri-state: all / some / none of a work order's lines are in (§6).
  function woState(woId) {
    const lines = linesOf(woId);
    if (!lines.length) return 'none';
    const on = lines.filter((l) => l.Included).length;
    return on === lines.length ? 'all' : (on ? 'some' : 'none');
  }

  function itemRowHtml(it, indent = false) {
    const bits = [it.SnapAssetName, it.SnapDate, it.SnapCost != null ? `$${Number(it.SnapCost).toLocaleString()}` : null]
      .filter(Boolean).join(' · ');
    return `
      <div class="list-item br-row" data-item="${it.Id}" style="${indent ? 'padding-left:30px;' : ''}display:flex;align-items:flex-start;gap:10px">
        <label class="br-check-wrap" style="flex:0 0 auto;margin:0"><input type="checkbox" class="br-check" data-item="${it.Id}" ${it.Included ? 'checked' : ''} /></label>
        <div style="flex:1;min-width:0">
          <div><strong>${escapeHtml(it.SnapTitle || '(untitled)')}</strong>${it.SnapSubtitle ? ` <span class="muted">— ${escapeHtml(it.SnapSubtitle)}</span>` : ''}${it.ManuallyAdded ? ' <span class="muted" style="font-size:0.75rem">· added by hand</span>' : ''}</div>
          ${bits ? `<div class="muted" style="font-size:0.85rem">${escapeHtml(bits)}</div>` : ''}
          ${it.ReportNote
            ? `<div style="font-size:0.9rem;margin-top:3px">${escapeHtml(it.ReportNote)} <a href="#" class="br-note" data-item="${it.Id}">edit</a></div>`
            : `<a href="#" class="br-note muted" data-item="${it.Id}" style="font-size:0.82rem">+ add note</a>`}
        </div>
      </div>`;
  }

  function woRowHtml(it) {
    const state = woState(it.ItemId);
    const lines = linesOf(it.ItemId);
    const open = expanded.has(it.ItemId);
    return `
      <div class="list-item br-row" data-item="${it.Id}" style="display:flex;align-items:flex-start;gap:10px">
        <button type="button" class="btn-icon br-expand" data-wo="${it.ItemId}" style="background:none;border:none;cursor:pointer;padding:0 2px">${open ? '▾' : '▸'}</button>
        <label class="br-check-wrap" style="flex:0 0 auto;margin:0"><input type="checkbox" class="br-check" data-item="${it.Id}" ${it.Included ? 'checked' : ''} /></label>
        <div style="flex:1;min-width:0">
          <div><strong>${escapeHtml(it.SnapTitle || '(untitled)')}</strong>
            ${lines.length ? `<span class="muted" style="font-size:0.82rem"> — ${lines.filter((l) => l.Included).length} of ${lines.length} line(s)${state === 'some' ? ', partial' : ''}</span>` : ''}
          </div>
          ${it.SnapAssetName ? `<div class="muted" style="font-size:0.85rem">${escapeHtml(it.SnapAssetName)}</div>` : ''}
          <div style="margin-top:3px;font-size:0.82rem">
            <label class="muted">Show as
              <select class="br-mode" data-item="${it.Id}">
                <option value="summary" ${it.DisplayMode === 'summary' ? 'selected' : ''}>Summary</option>
                <option value="itemized" ${it.DisplayMode === 'itemized' ? 'selected' : ''}>Itemized</option>
              </select>
            </label>
            ${it.ReportNote ? '' : `<a href="#" class="br-note muted" data-item="${it.Id}" style="margin-left:8px">+ add note</a>`}
          </div>
          ${it.ReportNote ? `<div style="font-size:0.9rem;margin-top:3px">${escapeHtml(it.ReportNote)} <a href="#" class="br-note" data-item="${it.Id}">edit</a></div>` : ''}
        </div>
      </div>
      ${open ? lines.map((l) => itemRowHtml(l, true)).join('') : ''}`;
  }

  function sectionHtml(key, label) {
    const rows = items.filter((i) => i.Section === key);
    if (!rows.length) return '';
    const wos = rows.filter((i) => i.ItemType === 'work_order');
    const woIds = new Set(wos.map((w) => w.ItemId));
    // Lines whose work order is in this section render underneath it, not twice.
    const loose = rows.filter((i) => i.ItemType !== 'work_order'
      && !(i.ItemType === 'job_line' && woIds.has(i.ParentWorkOrderId)));
    const on = rows.filter((i) => i.Included).length;
    return `
      <div class="card">
        <h3>${escapeHtml(label)} <span class="muted" style="font-weight:400;font-size:0.85rem">— ${on} of ${rows.length} included</span></h3>
        ${wos.map(woRowHtml).join('')}
        ${loose.map((i) => itemRowHtml(i)).join('')}
      </div>`;
  }

  function moneyHtml() {
    const g = (k) => aggregates.filter((a) => a.GroupKey === k);
    if (!g('money').length && !g('savings').length) return '';
    const tile = (a) => `
      <div style="flex:1;min-width:150px">
        <div class="muted" style="font-size:0.75rem;text-transform:uppercase">${escapeHtml(a.Label)}</div>
        <div style="font-size:1.1rem;font-weight:700">${a.ValueNumeric != null ? `$${Number(a.ValueNumeric).toLocaleString()}` : escapeHtml(a.ValueText || '—')}</div>
      </div>`;
    return `
      <div class="card">
        <div style="display:flex;flex-wrap:wrap;gap:16px">${g('money').map(tile).join('')}</div>
        ${g('savings').length ? `<div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:12px;padding-top:12px;border-top:1px solid #eef0f6">${g('savings').map(tile).join('')}</div>` : ''}
        <p class="muted" style="margin:10px 0 0;font-size:0.78rem">Figures reflect maintenance/operations tracking, not the camp's official books.</p>
      </div>`;
  }

  function draw() {
    const published = report.Status === 'published';
    setApp(`
      ${reportsTabsHtml('board')}
      <div class="card">
        <h3>Board Report — ${escapeHtml(report.Title)} ${published ? '<span class="muted">(published)</span>' : '<span class="muted">(draft)</span>'}</h3>
        <div class="field-row"><label>Period covered</label>
          <div class="report-date-range">
            <input type="date" id="brFrom" value="${report.PeriodStart}" ${published ? 'disabled' : ''} />
            <span class="muted">to</span>
            <input type="date" id="brTo" value="${report.PeriodEnd}" ${published ? 'disabled' : ''} />
          </div>
        </div>
        <div class="field-row"><label>Looking ahead</label>
          <div class="report-date-range">
            <input type="date" id="brFwdFrom" value="${report.ForwardStart}" ${published ? 'disabled' : ''} />
            <span class="muted">to</span>
            <input type="date" id="brFwdTo" value="${report.ForwardEnd}" ${published ? 'disabled' : ''} />
          </div>
          <p class="muted" style="margin-top:2px;font-size:0.8rem">Defaults to the same length as the period covered.</p>
        </div>
        ${published ? '' : `<div class="btn-row">
          <button type="button" class="btn btn-secondary" id="brRefresh" ${busy ? 'disabled' : ''}>${busy ? 'Working…' : 'Refresh suggestions'}</button>
          <button type="button" class="btn btn-secondary" id="brAddItem">＋ Add item</button>
        </div>
        <p class="muted" style="margin:6px 0 0;font-size:0.82rem">Add anything the rules didn't propose — any status, any date.</p>`}
      </div>

      ${moneyHtml()}

      <div class="card">
        <h3>Summary</h3>
        <p class="muted">The narrative the board reads first. Saved as you type.</p>
        <textarea id="brNotes" rows="5" ${published ? 'disabled' : ''} placeholder="What the board should know about this period…">${escapeHtml(report.SummaryNotes || '')}</textarea>
      </div>

      ${sectionHtml('done', 'Work Completed')}
      ${sectionHtml('coming_up', 'Coming Up')}
      ${sectionHtml('overdue', 'Overdue')}
      ${sectionHtml('admin_work', 'Administrative Work')}

      <div class="card">
        <div class="btn-row">
          <button type="button" class="btn btn-secondary" id="brPreview">Preview</button>
          <button type="button" class="btn btn-secondary" id="brSave">Save a copy</button>
          <button type="button" class="btn btn-secondary" id="brDownload">Download</button>
          <button type="button" class="btn btn-secondary" id="brEmail">Email…</button>
          ${published ? '' : '<button type="button" class="btn btn-primary" id="brPublish">Publish</button>'}
        </div>
        <p class="muted" style="margin:8px 0 0;font-size:0.82rem">Every copy that leaves the app is saved below, exactly as it went out.</p>
      </div>

      ${outputs.length ? `<div class="card">
        <h3>History</h3>
        ${outputs.map((o) => `<div class="list-item" style="display:flex;justify-content:space-between;gap:10px">
          <div><strong>${escapeHtml(o.ReportTitle)}</strong> <span class="muted">— ${escapeHtml(o.Kind)}${o.WasDraft ? ' (draft)' : ''}${o.Recipients ? ` → ${escapeHtml(o.Recipients)}` : ''}</span></div>
          <a href="#" class="br-open-output" data-id="${o.Id}">view</a>
        </div>`).join('')}
      </div>` : ''}
    `);
    wireReportsTabs();
    wire(published);
  }

  async function patchReport(fields) {
    await api(`/api/pg/board-reports/${report.Id}`, { method: 'PATCH', body: JSON.stringify(fields) });
  }

  async function refresh() {
    busy = true; draw();
    try {
      const before = items.length;
      const r = await api(`/api/pg/board-reports/${report.Id}/refresh`, { method: 'POST' });
      items = r.items || [];
      // The refresh recomputes the aggregates itself now, so they come back with the
      // items rather than needing a second request for a table nothing had rewritten.
      aggregates = r.aggregates || aggregates;
      // Always say something. A refresh that changes nothing is a real, common and
      // perfectly good outcome — but silence makes it indistinguishable from a broken
      // button, which is exactly how the unwired button read for so long.
      const added = items.length - before + (r.prunedCount || 0);
      const bits = [];
      if (added > 0) bits.push(`${added} added`);
      if (r.prunedCount) bits.push(`${r.prunedCount} no longer match this period`);
      toast(bits.length ? `Suggestions refreshed — ${bits.join(', ')}` : 'Suggestions refreshed — nothing changed');
    } catch (e) { toast(e.message, 5000); }
    busy = false; draw();
  }

  async function output(kind, extra = {}) {
    try {
      const res = await api(`/api/pg/board-reports/${report.Id}/output`, {
        method: 'POST', body: JSON.stringify({ kind, ...extra }),
      });
      return res;
    } catch (e) {
      // 409 = this is still a draft; ask once, then repeat with the confirmation.
      if (/still a draft/i.test(e.message)) {
        if (await confirmDialog('This report is still a draft. Send it anyway? It will be clearly marked DRAFT.',
          { confirmLabel: 'Yes, mark it DRAFT', cancelLabel: 'Cancel', danger: false })) {
          return output(kind, { ...extra, confirmDraft: true });
        }
        return null;
      }
      toast(e.message, 5000); return null;
    }
  }

  function wire(published) {
    // Wired here and nowhere else. The button existed from the first version of this
    // screen but was never bound to anything: refresh() was only ever reached by
    // changing one of the four dates, so clicking Refresh genuinely did nothing —
    // no request, no error, nothing in the console to explain it (0094).
    document.getElementById('brRefresh')?.addEventListener('click', refresh);
    document.getElementById('brAddItem')?.addEventListener('click', () => openAddReportItem(report.Id, async () => {
      const d = await api(`/api/pg/board-reports/${report.Id}`);
      items = d.items; aggregates = d.aggregates; draw();
    }));
    document.getElementById('brPreview').addEventListener('click', async () => {
      const res = await output('manual', {});   // previewing pins nothing extra beyond the copy
      if (res) showHtmlModal(res.html);
    });
    document.getElementById('brSave').addEventListener('click', async () => {
      const res = await output('manual', {});
      if (res) { toast('Copy saved'); await load(); draw(); }
    });
    document.getElementById('brDownload').addEventListener('click', async () => {
      const res = await output('download', {});
      if (!res) return;
      // Saves the exact bytes that were recorded, not a re-render.
      const blob = new Blob([res.html], { type: 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${res.subject.replace(/[^\w -]/g, '')}.html`;
      document.body.appendChild(a); a.click(); a.remove();
      toast('Downloaded and saved to history'); await load(); draw();
    });
    document.getElementById('brEmail').addEventListener('click', async () => {
      const recipient = await promptDialog('Email the board report to:', { confirmLabel: 'Send', placeholder: 'name@example.org' });
      if (!recipient || !recipient.trim()) return;
      const res = await output('email', { recipient });
      if (res) { toast(`Sent to ${recipient}`); await load(); draw(); }
    });
    const pub = document.getElementById('brPublish');
    if (pub) pub.addEventListener('click', async () => {
      const on = items.filter((i) => i.Included).length;
      if (!await confirmDialog(`Publish this report with ${on} item(s)? Unchecked items are dropped and the report becomes read-only.`,
        { confirmLabel: 'Publish', cancelLabel: 'Keep editing', danger: false })) return;
      await api(`/api/pg/board-reports/${report.Id}/publish`, { method: 'POST' });
      toast('Published'); await load(); draw();
    });
    app.querySelectorAll('.br-open-output').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault();
      const d = await api(`/api/pg/board-report-outputs/${el.dataset.id}`);
      showHtmlModal(d.output.SnapshotHtml);
    }));

    if (published) return;

    for (const [id, field] of [['brFrom', 'periodStart'], ['brTo', 'periodEnd'], ['brFwdFrom', 'forwardStart'], ['brFwdTo', 'forwardEnd']]) {
      document.getElementById(id).addEventListener('change', async (e) => {
        await patchReport({ [field]: e.target.value });
        await refresh();
      });
    }
    let notesTimer;
    document.getElementById('brNotes').addEventListener('input', (e) => {
      clearTimeout(notesTimer);
      notesTimer = setTimeout(() => patchReport({ summaryNotes: e.target.value }), 700);
    });
    app.querySelectorAll('.br-expand').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.wo);
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      draw();
    }));
    app.querySelectorAll('.br-check').forEach((cb) => cb.addEventListener('change', async () => {
      const r = await api(`/api/pg/board-reports/${report.Id}/items/${cb.dataset.item}`, {
        method: 'PATCH', body: JSON.stringify({ included: cb.checked }),
      });
      items = r.items; draw();
    }));
    app.querySelectorAll('.br-mode').forEach((sel) => sel.addEventListener('change', async () => {
      const r = await api(`/api/pg/board-reports/${report.Id}/items/${sel.dataset.item}`, {
        method: 'PATCH', body: JSON.stringify({ displayMode: sel.value }),
      });
      items = r.items; draw();
    }));
    app.querySelectorAll('.br-note').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault();
      const it = items.find((x) => String(x.Id) === el.dataset.item);
      const note = await promptDialog('Board-facing note for this item (leave blank to remove):', {
        value: it?.ReportNote || '', multiline: true,
        placeholder: 'Shown to the board — separate from the work order\'s own notes',
      });
      if (note === null) return;
      const r = await api(`/api/pg/board-reports/${report.Id}/items/${el.dataset.item}`, {
        method: 'PATCH', body: JSON.stringify({ reportNote: note }),
      });
      items = r.items; draw();
    }));
  }

  await load();
  // First open of a fresh draft has nothing in it yet; fill it before drawing so the
  // screen never appears empty for no reason.
  if (!items.length && report.Status === 'draft') {
    try {
      const r = await api(`/api/pg/board-reports/${report.Id}/refresh`, { method: 'POST' });
      items = r.items || []; aggregates = r.aggregates || [];
    } catch { /* draw empty */ }
  }
  draw();
}

// Add anything to the draft, whatever its status or date (§3). The suggestion rules
// decide what gets PROPOSED; this is the escape hatch that stops a rule from keeping
// something off a report that belongs on it.
//
// A panel, not a search box: it opens on the whole list, because "what is there?" is
// the question being asked and a box you have to type into can't answer it. The list
// is fetched once and narrowed in the browser, so typing costs nothing and never races
// a response. By default it shows only what hasn't been used — everything else is one
// toggle away, labelled with where it went.
async function openAddReportItem(reportId, onDone) {
  const TYPES = [
    { key: 'work_order', label: 'Work orders', short: 'WO' },
    { key: 'job_line', label: 'Job lines', short: 'Line' },
    { key: 'condition_finding', label: 'Findings', short: 'Finding' },
    { key: 'admin_task', label: 'Admin tasks', short: 'Task' },
  ];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box addpanel" role="dialog" aria-modal="true" aria-label="Add to this report">
    <div class="addpanel-head">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div>
          <h3 style="margin:0">Add to this report</h3>
          <p class="muted" style="margin:4px 0 0;font-size:0.85rem">Everything on the books — work orders, job lines, findings and admin tasks, at any status and any date.</p>
        </div>
        <button type="button" class="btn btn-secondary addpanel-close">Close</button>
      </div>
      <input type="search" class="addpanel-q" placeholder="Filter — title, WO number, asset, status or date" autocomplete="off" />
      <button type="button" class="btn btn-secondary addpanel-filtertoggle">Filters</button>
      <div class="addpanel-filterwrap">
        <div class="addpanel-filters chip-row">
          <span class="addpanel-filter-label">Type</span>
          <button type="button" class="btn btn-secondary addpanel-type selected" data-type="all">All</button>
          ${TYPES.map((t) => `<button type="button" class="btn btn-secondary addpanel-type" data-type="${t.key}">${t.label}</button>`).join('')}
        </div>
        <div class="addpanel-filters addpanel-statuses chip-row">
          <span class="addpanel-filter-label">Status</span>
        </div>
      </div>
      <div class="addpanel-filters">
        <label class="skill-chip" style="cursor:pointer;display:inline-flex;align-items:center">
          <input type="checkbox" class="addpanel-showused" style="margin-right:6px" />Show already used
        </label>
      </div>
    </div>
    <div class="addpanel-body"><p class="muted" style="padding:18px 0">Loading…</p></div>
    <div class="addpanel-foot">
      <button type="button" class="btn btn-primary addpanel-add" disabled>Add selected</button>
      <span class="muted addpanel-count"></span>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const $ = (sel) => overlay.querySelector(sel);
  const body = $('.addpanel-body');
  const addBtn = $('.addpanel-add');
  const countEl = $('.addpanel-count');

  let all = [];
  let statuses = [];
  let typeFilter = 'all';
  // Multi-select and empty-means-all: an empty set reads as "any status", which is what
  // an untouched filter should mean. Statuses are shared across types by NAME — a "Done"
  // work order and a "Done" job line answer the same chip — because the question being
  // asked is about the work, not about which table it lives in.
  const statusFilter = new Set();
  let showAllStatuses = false;
  let showUsed = false;
  let query = '';
  const selected = new Map();   // key -> the candidate object, so "Add selected" needs no re-lookup

  const keyOf = (c) => `${c.ItemType}:${c.ItemId}`;
  const usedLabel = (c) => (c.OnThisReport ? 'on this report' : (c.ReportedOn ? `reported ${c.ReportedOn}` : null));

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (onDone) onDone();
  };
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  // Type and status chips collapse behind one control on narrow screens so the results
  // list keeps the height. The control always carries the active count, so collapsed
  // never means a filter is silently narrowing the list.
  const filterWrap = $('.addpanel-filterwrap');
  const filterToggle = $('.addpanel-filtertoggle');
  // Defensive: this went null once when a markup edit was lost, and a hard pageerror
  // took the whole panel down rather than just losing the toggle.
  if (!filterWrap || !filterToggle) console.warn('add-item filter toggle markup missing');
  const PHONE_PANEL = 760;
  let filtersOpen = window.innerWidth > PHONE_PANEL;
  function activeFilterCount() {
    let n = 0;
    const type = overlay.querySelector('.addpanel-type.selected');
    if (type && type.dataset.type !== 'all') n += 1;
    n += overlay.querySelectorAll('.addpanel-status.selected').length;
    return n;
  }
  function syncFilterToggle() {
    if (!filterToggle || !filterWrap) return;
    const n = activeFilterCount();
    filterToggle.textContent = n ? `Filters · ${n}` : 'Filters';
    filterToggle.classList.toggle('selected', n > 0);
    filterWrap.hidden = window.innerWidth <= PHONE_PANEL && !filtersOpen;
  }
  if (filterToggle) filterToggle.addEventListener('click', () => { filtersOpen = !filtersOpen; syncFilterToggle(); });
  window.addEventListener('resize', syncFilterToggle);
  // Chip clicks are handled by the panel's own listeners; resync after they run.
  overlay.addEventListener('click', (e) => {
    if (e.target.closest('.addpanel-type, .addpanel-status')) setTimeout(syncFilterToggle, 0);
  });
  syncFilterToggle();

  $('.addpanel-close').addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

  function visible() {
    return all.filter((c) => {
      if (typeFilter !== 'all' && c.ItemType !== typeFilter) return false;
      if (statusFilter.size && !statusFilter.has(c.Status)) return false;
      if (!showUsed && c.Used) return false;
      // Substring, anywhere, case-insensitive — against the same fields the columns
      // show. haystack is built once per row at load, so a keystroke is a scan of
      // strings already in memory rather than a request.
      return !query || c.haystack.includes(query);
    });
  }

  function rowHtml(c) {
    const k = keyOf(c);
    const badge = usedLabel(c);
    // Already on this draft: nothing to add, so the row is shown (when "show already
    // used" is on) but not selectable. Reported in a past month IS selectable — putting
    // something in front of the board a second time is a legitimate choice.
    const locked = c.OnThisReport;
    return `
      <label class="addrow addrow-pick ${c.Used ? 'addrow-used' : ''}" data-key="${escapeHtml(k)}">
        <input type="checkbox" class="addrow-check" data-key="${escapeHtml(k)}" ${selected.has(k) ? 'checked' : ''} ${locked ? 'disabled' : ''} />
        <span class="addcell">
          <strong>${escapeHtml(c.Title || '(untitled)')}</strong>${badge ? `<span class="addpanel-badge">${escapeHtml(badge)}</span>` : ''}
          ${c.ParentTitle ? `<span class="addcell-parent">on WO ${escapeHtml(c.ParentWoNumber || '?')} — ${escapeHtml(c.ParentTitle)}</span>` : ''}
        </span>
        <span class="addcell addcell-meta" data-label="WO">${escapeHtml(c.WoNumber || '')}</span>
        <span class="addcell addcell-meta" data-label="Where">${escapeHtml(c.Place || '')}</span>
        <span class="addcell addcell-meta" data-label="Status">${escapeHtml(c.Status || '')}</span>
        <span class="addcell addcell-meta" data-label="Completed">${c.CompletedDate ? escapeHtml(formatDateNice(c.CompletedDate)) : ''}</span>
      </label>`;
  }

  function render() {
    const rows = visible();
    if (!all.length) { body.innerHTML = '<p class="muted" style="padding:18px 0">Nothing on the books yet.</p>'; return; }
    if (!rows.length) {
      body.innerHTML = `<p class="muted" style="padding:18px 0">Nothing matches${!showUsed && all.some((c) => c.Used) ? ' — everything that does is already on a report. Turn on "Show already used" to see it.' : '.'}</p>`;
      return;
    }
    const header = `<div class="addrow addrow-head">
      <span></span><span>Title</span><span>WO</span><span>Asset / location</span><span>Status</span><span>Completed</span>
    </div>`;
    // Grouped by type as well as filterable by it, so "all" is still readable.
    const groups = TYPES.map((t) => {
      const mine = rows.filter((c) => c.ItemType === t.key);
      if (!mine.length) return '';
      return `<div class="addpanel-group">
        <p class="addpanel-group-title">${t.label} (${mine.length})</p>
        ${mine.map(rowHtml).join('')}
      </div>`;
    }).join('');
    body.innerHTML = header + groups;
  }

  // Built from the STATUS CONFIG — every active status across work orders, job lines,
  // admin tasks and the finding lifecycle — in each table's own sort_order, so the row
  // reads Not Started, In Progress, Done rather than alphabetically and doesn't shift
  // as the data changes. Counts respect the type and text filters, so the chips
  // describe the list in front of you; a status with nothing under it right now shows
  // a 0 and dims rather than disappearing, which keeps the vocabulary visible.
  function renderStatusChips() {
    const row = $('.addpanel-statuses');
    const names = statuses.map((s) => s.name);
    const pool = all.filter((c) => (typeFilter === 'all' || c.ItemType === typeFilter)
      && (showUsed || !c.Used) && (!query || c.haystack.includes(query)));
    const chip = (n, hits) => `<button type="button" class="btn btn-secondary addpanel-status ${statusFilter.has(n) ? 'selected' : ''} ${hits ? '' : 'addpanel-status-empty'}" data-status="${escapeHtml(n)}">${escapeHtml(n)} <span class="addpanel-chip-count">${hits}</span></button>`;
    const counts = new Map(names.map((n) => [n, pool.filter((c) => c.Status === n).length]));
    // The whole configured vocabulary is eighteen statuses, and most of them have
    // nothing under them on any given day. Showing all eighteen buries the list it is
    // meant to filter — worse on a phone, where they wrap to four rows. Empty ones
    // (unless currently selected) fold behind one toggle: still there, not in the way.
    const live = names.filter((n) => counts.get(n) || statusFilter.has(n));
    const empty = names.filter((n) => !counts.get(n) && !statusFilter.has(n));
    row.innerHTML = '<span class="addpanel-filter-label">Status</span>'
      + `<button type="button" class="btn btn-secondary addpanel-status ${statusFilter.size ? '' : 'selected'}" data-status="">Any</button>`
      + live.map((n) => chip(n, counts.get(n))).join('')
      + (showAllStatuses ? empty.map((n) => chip(n, 0)).join('') : '')
      + (empty.length
        ? `<button type="button" class="btn btn-secondary addpanel-morestatus">${showAllStatuses ? '− fewer' : `+${empty.length} with none`}</button>`
        : '');
    row.querySelectorAll('.addpanel-status').forEach((b) => b.addEventListener('click', () => {
      const name = b.dataset.status;
      if (!name) statusFilter.clear();
      else if (statusFilter.has(name)) statusFilter.delete(name);
      else statusFilter.add(name);
      renderStatusChips(); render(); syncFooter();
    }));
    row.querySelector('.addpanel-morestatus')?.addEventListener('click', () => {
      showAllStatuses = !showAllStatuses;
      renderStatusChips();
    });
  }

  function syncFooter() {
    const n = selected.size;
    addBtn.disabled = !n;
    addBtn.textContent = n ? `Add selected (${n})` : 'Add selected';
    const shown = visible().length;
    countEl.textContent = `${shown} of ${all.length} shown${showUsed ? '' : ' · already-used items hidden'}`;
  }

  // One checkbox listener on the body rather than one per row: the list re-renders on
  // every keystroke, and re-binding hundreds of handlers each time is what would make
  // typing feel slow.
  body.addEventListener('change', (e) => {
    const cb = e.target.closest('.addrow-check');
    if (!cb) return;
    const k = cb.dataset.key;
    if (cb.checked) selected.set(k, all.find((c) => keyOf(c) === k));
    else selected.delete(k);
    syncFooter();
  });

  $('.addpanel-q').addEventListener('input', (e) => {
    query = e.target.value.trim().toLowerCase();
    renderStatusChips(); render(); syncFooter();
  });
  overlay.querySelectorAll('.addpanel-type').forEach((b) => b.addEventListener('click', () => {
    typeFilter = b.dataset.type;
    overlay.querySelectorAll('.addpanel-type').forEach((x) => x.classList.toggle('selected', x === b));
    renderStatusChips(); render(); syncFooter();
  }));
  $('.addpanel-showused').addEventListener('change', (e) => {
    showUsed = e.target.checked;
    e.target.closest('.skill-chip').classList.toggle('selected', showUsed);
    renderStatusChips(); render(); syncFooter();
  });

  addBtn.addEventListener('click', async () => {
    const items = [...selected.values()];
    if (!items.length) return;
    addBtn.disabled = true; addBtn.textContent = 'Adding…';
    try {
      await api(`/api/pg/board-reports/${reportId}/items`, {
        method: 'POST', body: JSON.stringify({ items }),
      });
      // The panel stays open — adding one batch is rarely the whole job — but the rows
      // just added now read as used, so they can't be added twice by accident.
      for (const it of items) {
        const c = all.find((x) => keyOf(x) === keyOf(it));
        if (c) { c.OnThisReport = true; c.Used = true; }
      }
      selected.clear();
      toast(`Added ${items.length} item${items.length === 1 ? '' : 's'} to the draft`);
      render();
    } catch (e) {
      toast(e.message, 5000);
    }
    syncFooter();
  });

  try {
    const res = await api(`/api/pg/board-reports/candidates?reportId=${reportId}`);
    const candidates = res.candidates || [];
    statuses = res.statuses || [];
    all = candidates.map((c) => ({
      ...c,
      Used: !!(c.OnThisReport || c.ReportedOn),
      // Everything the columns show, flattened once, so filtering is a substring test.
      // The date is indexed both as stored and as displayed — "2026-09-17" and
      // "17 Sep 2026" are both reasonable things to type.
      haystack: [c.Title, c.WoNumber, c.Place, c.Status, c.Subtitle, c.CompletedDate, c.ParentTitle,
        c.CompletedDate ? formatDateNice(c.CompletedDate) : null,
        TYPES.find((t) => t.key === c.ItemType)?.label]
        .filter(Boolean).join(' ').toLowerCase(),
    }));
  } catch (e) {
    body.innerHTML = `<p class="muted" style="padding:18px 0">Couldn't load the list: ${escapeHtml(e.message)}</p>`;
    return;
  }
  renderStatusChips();
  render();
  syncFooter();
  setTimeout(() => $('.addpanel-q').focus(), 0);
}

// A work order must never be terminal while any of its lines is unresolved, so every
// route to a terminal status answers with a 409 carrying the lines that blocked it.
// One helper, so the fields form, "Complete Work Order" and the log entry's status
// shortcut all ask the same question and retry the same way — and so any path added
// later gets the behaviour by wrapping its request rather than reimplementing it.
//
// send(true) repeats the request with resolveOpenLines, which is what actually resolves
// the lines; cancelling returns null and the work order stays in its current status.
async function withOpenLinePrompt(send) {
  try {
    return await send(false);
  } catch (err) {
    if (err.code !== 'open_job_lines') throw err;
    const d = err.details || {};
    const n = d.count || 0;
    const lines = d.lines || [];
    const shown = lines.slice(0, 6).map((l) => `• ${l.Title} — ${l.StatusName}`).join('\n');
    const more = lines.length > 6 ? `\n…and ${lines.length - 6} more` : '';
    // "Mark them complete" only when the work order says work was done. A cancelled
    // work order cancels its lines, and the button says so rather than claiming
    // something was finished that wasn't.
    const done = d.resolveTo === 'Done';
    const verb = done ? 'complete' : d.resolveTo.toLowerCase();
    const ok = await confirmDialog(
      `${n} line${n === 1 ? ' is' : 's are'} still open. Mark ${n === 1 ? 'it' : 'them'} ${verb} too?\n\n${shown}${more}\n\n`
      + (done
        ? 'They will be marked Done and dated to this work order\u2019s completion date.'
        : `They will be marked ${d.resolveTo}.`),
      { confirmLabel: `Yes, mark ${n === 1 ? 'it' : 'them'} ${verb}`, cancelLabel: 'Cancel', danger: false },
    );
    if (!ok) return null;
    return send(true);
  }
}

// The other half of the invariant, from the browser's side. A closed work order is a
// record of what happened, so growing it a new line or putting a resolved line back
// into play goes through Review rather than happening quietly underneath it.
//
// send(null) tries the change as-is; send({reason}) repeats it with the reopen. The
// reason is optional — the same as the Reopen button asks for — and the reopen is
// logged either way.
async function withReopenPrompt(send) {
  try {
    return await send(null);
  } catch (err) {
    if (err.code !== 'work_order_closed') throw err;
    const d = err.details || {};
    const what = {
      add_line: 'Adding a job line changes what this work order says was done.',
      delete_line: 'Deleting a job line takes work out of what this work order says was done.',
      reopen_line: 'Reopening a line changes what this work order says was finished.',
    }[d.action] || 'This change edits what the work order says was done.';
    const ok = await confirmDialog(
      `This work order is closed. Reopen it to Review to make this change?\n\n${what}`,
      { confirmLabel: 'Reopen and continue', cancelLabel: 'Cancel', danger: false },
    );
    if (!ok) return null;
    const reason = await promptDialog('Why are you reopening it? (optional)', { multiline: true, confirmLabel: 'Reopen' });
    if (reason === null) return null;   // backed out at the second step — still no change
    return send({ reason: reason || null });
  }
}

// Shows rendered report HTML in an overlay. Used for Preview and for opening any past
// copy out of history — same viewer either way, so what you preview and what was sent
// look identical by construction.
function showHtmlModal(html) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:760px;width:94%;max-height:86vh;overflow:auto">
    <div style="display:flex;justify-content:flex-end"><button type="button" class="btn btn-secondary modal-cancel">Close</button></div>
    <iframe style="width:100%;height:70vh;border:1px solid #eef0f6;border-radius:8px;margin-top:10px"></iframe>
  </div>`;
  document.body.appendChild(overlay);
  const frame = overlay.querySelector('iframe');
  frame.srcdoc = html;
  const close = () => overlay.remove();
  overlay.querySelector('.modal-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

// "Work Performed in a Date Range" (§6.2.1) — the fall-to-spring board
// document: job lines completed in range, grouped by building, regardless
// of whether their parent WO is fully closed yet.
async function renderWorkPerformedReport() {
  setChrome({ title: 'Reports', showBack: false, showLogout: true });
  const todayStr = isoDate(new Date());
  const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  let from = isoDate(sixMonthsAgo);
  let to = todayStr;
  let report = null;
  let generating = false;

  function draw() {
    setApp(`
      ${reportsTabsHtml('workPerformed')}
      <div class="card">
        <h3>Work Performed</h3>
        <p class="muted">Job lines completed in this range, grouped by building — proves activity even while a big multi-line job is still open. After photos embed (capped per work order in Admin → Work Order Statuses). Administrative tasks dated in the range get their own section after the buildings, with any recurring savings totalled monthly and annualized.</p>
        <div class="field-row"><label>Range</label>
          <div class="report-date-range">
            <input type="date" id="wpFrom" value="${from}" />
            <span class="muted">to</span>
            <input type="date" id="wpTo" value="${to}" />
          </div>
        </div>
        <div class="btn-row"><button type="button" class="btn btn-primary" id="wpGenBtn" ${generating ? 'disabled' : ''}>${generating ? 'Generating…' : 'Generate'}</button></div>
      </div>
      ${reportPreviewAreaHtml(report)}`);
    wireReportsTabs();
    document.getElementById('wpGenBtn').addEventListener('click', generate);
    wireReportPreviewArea(report, { sendPath: '/api/pg/reports/work-performed/send', sendBody: () => ({ from, to }) });
  }

  async function generate() {
    from = document.getElementById('wpFrom').value || from;
    to = document.getElementById('wpTo').value || to;
    generating = true; draw();
    try { report = await api(`/api/pg/reports/work-performed/preview?from=${from}&to=${to}`); }
    catch (err) { toast(err.message); }
    generating = false; draw();
  }

  draw();
}

// Visitor Activity — who came to camp in a range, grouped by person, with
// cabin holders and one-off visitors in separate sections. Same range +
// preview/email shape as Work Performed.
async function renderVisitorActivityReport() {
  setChrome({ title: 'Reports', showBack: false, showLogout: true });
  const threeMonthsAgo = new Date(); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  let from = isoDate(threeMonthsAgo);
  let to = isoDate(new Date());
  let report = null;
  let generating = false;

  function draw() {
    setApp(`
      ${reportsTabsHtml('visitorActivity')}
      <div class="card">
        <h3>Visitor Activity</h3>
        <p class="muted">Calendar events with a visitor on them, grouped by person — visit count and which buildings. Visits linked to a cabin holder are listed separately from one-off visitors. A repeating visit counts once per occurrence.</p>
        <div class="field-row"><label>Range</label>
          <div class="report-date-range">
            <input type="date" id="vaFrom" value="${from}" />
            <span class="muted">to</span>
            <input type="date" id="vaTo" value="${to}" />
          </div>
        </div>
        <div class="btn-row"><button type="button" class="btn btn-primary" id="vaGenBtn" ${generating ? 'disabled' : ''}>${generating ? 'Generating…' : 'Generate'}</button></div>
      </div>
      ${reportPreviewAreaHtml(report)}`);
    wireReportsTabs();
    document.getElementById('vaGenBtn').addEventListener('click', generate);
    wireReportPreviewArea(report, { sendPath: '/api/pg/reports/visitor-activity/send', sendBody: () => ({ from, to }) });
  }

  async function generate() {
    from = document.getElementById('vaFrom').value || from;
    to = document.getElementById('vaTo').value || to;
    generating = true; draw();
    try { report = await api(`/api/pg/reports/visitor-activity/preview?from=${from}&to=${to}`); }
    catch (err) { toast(err.message); }
    generating = false; draw();
  }

  draw();
}

// "Deferred Maintenance Backlog" (§6.2.2) — the capital-campaign argument:
// every deferred finding, grouped by severity, with dollar totals.
async function renderDeferredBacklogReport() {
  setChrome({ title: 'Reports', showBack: false, showLogout: true });
  let report = null;
  let generating = false;

  function draw() {
    setApp(`
      ${reportsTabsHtml('deferredBacklog')}
      <div class="card">
        <h3>Deferred Maintenance Backlog</h3>
        <p class="muted">Every deferred finding, grouped by severity, with dollar totals — a standard capital-planning document.</p>
        <div class="btn-row"><button type="button" class="btn btn-primary" id="dbGenBtn" ${generating ? 'disabled' : ''}>${generating ? 'Generating…' : 'Generate'}</button></div>
      </div>
      ${reportPreviewAreaHtml(report)}`);
    wireReportsTabs();
    document.getElementById('dbGenBtn').addEventListener('click', generate);
    wireReportPreviewArea(report, { sendPath: '/api/pg/reports/deferred-backlog/send', sendBody: () => ({}) });
  }

  async function generate() {
    generating = true; draw();
    try { report = await api('/api/pg/reports/deferred-backlog/preview'); }
    catch (err) { toast(err.message); }
    generating = false; draw();
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
      { view: 'adminJobLineTemplates', icon: '🧩', label: 'Job Line Templates' },
      { view: 'adminChecklistTemplates', icon: '✅', label: 'Checklist Templates' },
      { view: 'adminCauses', icon: '🔍', label: 'Causes' },
      { view: 'adminWorkOrderStatuses', icon: '🚦', label: 'Work Order Statuses' },
      { view: 'adminJobLineStatuses', icon: '🚦', label: 'Job Line Statuses' },
      { view: 'adminAttachmentRoles', icon: '📎', label: 'Attachment Roles' },
      { view: 'adminAssetTypeIcons', icon: '🛖', label: 'Asset Type Icons' },
    ],
  },
  expenses: {
    icon: '💵', title: 'Expenses & Funds', description: 'Funds Ben is accountable for, and what an expense can be categorized as',
    items: [
      { view: 'adminFunds', icon: '💰', label: 'Funds' },
      { view: 'adminExpenseCategories', icon: '🏷️', label: 'Expense Categories' },
    ],
  },
  adminTasks: {
    icon: '🗂️', title: 'Administrative Tasks', description: 'Categories and statuses for work that isn\'t tied to an asset or work order',
    items: [
      { view: 'adminTaskCategories', icon: '🏷️', label: 'Admin Task Categories' },
      { view: 'adminTaskStatuses', icon: '🚦', label: 'Admin Task Statuses' },
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
      { view: 'adminMapCalibration', icon: '🧭', label: 'Map GPS Calibration' },
      { view: 'adminCalendarEventTypes', icon: '📅', label: 'Calendar Event Types' },
    ],
  },
  integrations: {
    icon: '🔗', title: 'Integrations', description: 'External services this system connects to',
    items: [
      { view: 'adminGcal', icon: '🗓️', label: 'Google Calendar Sync' },
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

// Google Calendar Sync admin screen (Build Brief v4 Part 1 step 2, step 3
// color-mapping/manual-sync controls added once the worker existed).
//
// Calendar choice is its own step after connecting (2026-09-14 revision),
// not automatic during OAuth — Ben may already have a calendar built for
// this (e.g. one made directly in the camp Google account and shared to his
// own) rather than always wanting a fresh auto-created "Camp Work" one.
async function renderAdminGcal(container = app) {
  if (container === app) setChrome({ title: 'Google Calendar Sync', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const [status, healthRes, colorsRes] = await Promise.all([
    api('/api/pg/gcal/status'),
    api('/api/pg/system-health').catch(() => null),
    api('/api/pg/gcal/event-colors').catch(() => null),
  ]);
  const gcalHealth = healthRes?.subsystems?.find((s) => s.Subsystem === 'gcal_sync');
  const jobLineColor = colorsRes?.colors?.find((c) => c.Kind === 'job_line') || null;
  const revisitColor = colorsRes?.colors?.find((c) => c.Kind === 'revisit') || null;
  let syncing = false;
  // Picker opens automatically the first time (connected, nothing chosen
  // yet) and can be reopened later via "Change calendar".
  let picking = status.Connected && !status.CalendarId;
  let calendars = null; // lazy-loaded only when the picker actually opens

  function calendarPickerHtml() {
    if (!calendars) return '<p class="muted" style="margin-top:14px">Loading calendars…</p>';
    return `
      <div class="field-row" style="margin-top:14px">
        <label>Sync to calendar</label>
        <select class="gcal-cal-select">
          <option value="__create_new__">+ Create a new "Camp Work" calendar</option>
          ${calendars.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.summary)}${c.primary ? ' (primary)' : ''}</option>`).join('')}
        </select>
        ${calendars.some((c) => c.primary) ? '<p class="muted" style="margin-top:4px;font-size:0.82rem">Picking your primary calendar mixes synced events in with your personal ones.</p>' : ''}
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="gcalSaveCalBtn">Save</button>
        ${status.CalendarId ? '<button class="btn btn-secondary" id="gcalCancelCalBtn">Cancel</button>' : ''}
      </div>`;
  }

  async function draw() {
    setApp(`
      <div class="card">
        <h3>Google Calendar Sync</h3>
        <p class="muted" style="margin-top:-4px">
          Mirrors scheduled job lines and calendar events, plus deferred work orders' and findings'
          revisit dates, onto a dedicated calendar on a connected Google account.
          <strong>The CMMS owns the data</strong> — an event moved or edited directly in Google is
          overwritten on the next sync. That's correct behavior, not a bug: this is a one-way mirror,
          not two-way sync.
        </p>
        ${status.Connected ? `
          <p style="margin-top:14px">✅ Connected as <strong>${escapeHtml(status.GoogleEmail)}</strong></p>
          <p class="muted" style="margin-top:-6px">${status.ConnectedAt ? `Connected ${new Date(status.ConnectedAt).toLocaleString()}${status.ConnectedBy ? ` by ${escapeHtml(status.ConnectedBy)}` : ''}` : ''}</p>
          ${!picking && status.CalendarId ? `
            <p style="margin-top:10px">Calendar: <strong>${escapeHtml(status.CalendarSummary || status.CalendarId)}</strong> <button id="gcalChangeCalBtn" style="background:none;border:none;padding:0;color:var(--accent-dark,#3b6fd6);text-decoration:underline;font-size:0.85rem;cursor:pointer">Change</button></p>
            <p class="muted" style="margin-top:6px">🗓️ Last successful sync: ${gcalHealth?.LastSuccess ? new Date(gcalHealth.LastSuccess).toLocaleString() : 'never yet'}${gcalHealth?.LastMessage && gcalHealth.State !== 'failed' ? ` — ${escapeHtml(gcalHealth.LastMessage)}` : ''}</p>
            ${gcalHealth?.State === 'failed' ? `<p style="margin-top:6px;color:#c0392b">⚠️ Most recent sync attempt failed${gcalHealth.LastMessage ? `: ${escapeHtml(gcalHealth.LastMessage)}` : ''}.</p>` : ''}
            <div class="btn-row" style="margin-top:10px">
              <button class="btn btn-secondary" id="gcalSyncNowBtn" ${syncing ? 'disabled' : ''}>${syncing ? 'Syncing…' : 'Sync now'}</button>
              <button class="btn btn-secondary" id="gcalResyncAllBtn" ${syncing ? 'disabled' : ''}>Regenerate all events</button>
            </div>
          ` : picking ? calendarPickerHtml() : `<p style="margin-top:14px" class="muted">No calendar chosen yet.</p>`}
          <div class="btn-row" style="margin-top:14px">
            <button class="btn btn-secondary" id="gcalDisconnectBtn">Disconnect</button>
          </div>
        ` : `
          <p style="margin-top:14px">Not connected.</p>
          <div class="btn-row" style="margin-top:10px">
            <a class="btn btn-primary" href="/api/pg/gcal/oauth/start">Connect Google Calendar</a>
          </div>
        `}
      </div>
      ${status.Connected && status.CalendarId && !picking ? `
        <div class="card">
          <h3>Event Color</h3>
          <p class="muted" style="margin-top:-4px">Calendar events get their color from their own Type (Admin > System > Calendar Event Types). Job lines synced from Work Orders all get one flat color here, so they read as "CMMS work" at a glance next to admin-typed events. Revisit prompts (deferred work orders/findings) get their own flat color too, distinct from both.</p>
          <div class="field-row" style="margin-top:10px">
            <label>Job line events</label>
            <select id="gcalJobLineColor">
              <option value="">— calendar's default color —</option>
              ${Object.entries(GOOGLE_EVENT_COLORS).map(([id, c]) => `<option value="${id}" ${jobLineColor?.GcalColorId === id ? 'selected' : ''}>${c.name}</option>`).join('')}
            </select>
            <button class="btn btn-primary" id="gcalSaveJobLineColorBtn" style="margin-top:8px">Save</button>
          </div>
          <div class="field-row" style="margin-top:14px">
            <label>Revisit prompts</label>
            <select id="gcalRevisitColor">
              <option value="">— calendar's default color —</option>
              ${Object.entries(GOOGLE_EVENT_COLORS).map(([id, c]) => `<option value="${id}" ${revisitColor?.GcalColorId === id ? 'selected' : ''}>${c.name}</option>`).join('')}
            </select>
            <button class="btn btn-primary" id="gcalSaveRevisitColorBtn" style="margin-top:8px">Save</button>
          </div>
        </div>
      ` : ''}
    `, container);

    if (picking && !calendars) {
      try {
        ({ calendars } = await api('/api/pg/gcal/calendars'));
      } catch (err) {
        toast(err.message);
        calendars = [];
      }
      draw();
      return;
    }

    container.querySelector('#gcalChangeCalBtn')?.addEventListener('click', () => { picking = true; calendars = null; draw(); });
    container.querySelector('#gcalCancelCalBtn')?.addEventListener('click', () => { picking = false; draw(); });
    container.querySelector('#gcalSaveCalBtn')?.addEventListener('click', async () => {
      const val = container.querySelector('.gcal-cal-select').value;
      try {
        const body = val === '__create_new__' ? { createNew: true } : { calendarId: val };
        const saved = await api('/api/pg/gcal/calendar', { method: 'POST', body: JSON.stringify(body) });
        status.CalendarId = saved.calendarId;
        status.CalendarSummary = saved.calendarSummary;
        picking = false;
        toast('Calendar saved');
        draw();
      } catch (err) { toast(err.message); }
    });
    container.querySelector('#gcalDisconnectBtn')?.addEventListener('click', async () => {
      if (!await confirmDialog('Disconnect Google Calendar? Nothing on the connected calendar in Google is deleted automatically — it just stops being updated.', { danger: false, confirmLabel: 'Disconnect' })) return;
      try {
        await api('/api/pg/gcal/disconnect', { method: 'POST' });
        toast('Disconnected');
        renderAdminGcal(container);
      } catch (err) { toast(err.message); }
    });
    container.querySelector('#gcalSyncNowBtn')?.addEventListener('click', async () => {
      syncing = true; draw();
      try {
        const { result } = await api('/api/pg/gcal/sync-now', { method: 'POST' });
        toast(result?.skipped ? `Sync skipped: ${result.skipped.replaceAll('_', ' ')}` : `Synced ${result.succeeded}/${result.syncs + result.deletes} item(s)`);
      } catch (err) { toast(err.message); }
      finally { syncing = false; renderAdminGcal(container); }
    });
    container.querySelector('#gcalResyncAllBtn')?.addEventListener('click', async () => {
      if (!await confirmDialog('Re-queue every scheduled job line and calendar event for a fresh sync? Useful after changing colors or reconnecting — not needed for normal day-to-day scheduling, which already syncs itself.', { danger: false, confirmLabel: 'Regenerate all' })) return;
      syncing = true; draw();
      try {
        const { result } = await api('/api/pg/gcal/resync-all', { method: 'POST' });
        toast(result?.skipped ? `Queued, but sync skipped: ${result.skipped.replaceAll('_', ' ')}` : `Synced ${result.succeeded}/${result.syncs + result.deletes} item(s) — remaining will catch up on the next scheduled run`);
      } catch (err) { toast(err.message); }
      finally { syncing = false; renderAdminGcal(container); }
    });
    container.querySelector('#gcalSaveJobLineColorBtn')?.addEventListener('click', async () => {
      const gcalColorId = container.querySelector('#gcalJobLineColor').value || null;
      try {
        await api('/api/pg/gcal/event-colors/job_line', { method: 'PATCH', body: JSON.stringify({ gcalColorId }) });
        toast('Saved — existing synced events keep their old color until next touched; use "Regenerate all events" to repaint everything now.');
      } catch (err) { toast(err.message); }
    });
    container.querySelector('#gcalSaveRevisitColorBtn')?.addEventListener('click', async () => {
      const gcalColorId = container.querySelector('#gcalRevisitColor').value || null;
      try {
        await api('/api/pg/gcal/event-colors/revisit', { method: 'PATCH', body: JSON.stringify({ gcalColorId }) });
        toast('Saved — existing synced events keep their old color until next touched; use "Regenerate all events" to repaint everything now.');
      } catch (err) { toast(err.message); }
    });
  }
  draw();
}

async function renderAdminWoTemplates(container = app) {
  if (container === app) setChrome({ title: 'Work Order Templates', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const [tplRes, gridCtx] = await Promise.all([api('/api/pg/work-order-templates'), loadGridContext()]);
  const optsRes = state.options;
  const templates = tplRes.templates;
  const { fundingOptions } = gridCtx;
  const fieldTitles = optsRes.propertyFields.map((f) => f.title);
  let editingId = null; // null | 'new' | number

  // job_line_defaults holds partial job-line objects (title + responsibility
  // class); asset_update_defaults is the separate, older "also change an
  // asset field" blueprint — the two got renamed apart in migration 0038/0039
  // specifically so "job line" stops meaning two different things.
  // One row per work_order_template_lines row (§8). Deliberately no date
  // field: a template says what work is done, never when.
  const jlDefaultRowHtml = (row = {}) => `<div class="inline-add-row jld-row" style="align-items:center;flex-wrap:wrap">
    <input class="jld-title" value="${escapeHtml(row.Title || '')}" placeholder="Job line title…" style="flex:2;min-width:160px" />
    <select class="jld-resp">
      <option value="">— responsibility unset —</option>
      ${Object.entries(RESPONSIBILITY_CLASS_LABELS).map(([k, v]) => `<option value="${k}" ${row.ResponsibilityClass === k ? 'selected' : ''}>${v}</option>`).join('')}
    </select>
    <div class="jld-funding" data-value="${row.FundingSource ? escapeHtml(fundingOptionValue(row.FundingSource, row.FundingRefId)) : ''}" style="flex:1;min-width:160px"></div>
    <input class="jld-hours" type="number" step="any" min="0" placeholder="Hrs" value="${row.EstimatedHours ?? ''}" style="width:80px" />
    <input class="jld-cost" type="number" step="0.01" min="0" placeholder="Cost" value="${row.EstimatedCost ?? ''}" style="width:100px" />
    <button type="button" class="btn btn-secondary row-remove">✕</button>
  </div>`;
  const auDefaultRowHtml = (row = {}) => `<div class="inline-add-row aud-row" style="align-items:center">
      <select class="aud-field" style="flex:1">${fieldTitles.map((t) => `<option ${row.targetField === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>
      <input class="aud-value" placeholder="Value" value="${escapeHtml(row.newValue || '')}" style="flex:1" />
      <button type="button" class="btn btn-secondary row-remove">✕</button>
    </div>`;

  function formHtml(t) {
    const jlRows = (t?.Lines || []).map(jlDefaultRowHtml).join('');
    const auRows = (t?.AssetUpdateDefaults || []).map(auDefaultRowHtml).join('');
    return `<div class="card">
      <h3>${t ? `Edit "${escapeHtml(t.Name)}"` : 'New Template'}</h3>
      <div class="field-row"><label>Template Name</label><input class="tf-name" value="${escapeHtml(t?.Name || '')}" placeholder="e.g. Winterization" required /></div>
      <div class="field-row"><label>Description</label><input class="tf-desc" value="${escapeHtml(t?.Description || '')}" placeholder="When to reach for this one" /></div>
      <div class="field-row"><label>Default Title</label><input class="tf-title" value="${escapeHtml(t?.DefaultTitle || '')}" placeholder="Fills in the WO title — you can still edit it per use" /></div>
      <div class="field-row"><label>Default Priority</label>
        <select class="tf-priority"><option value="">— none —</option>${['Low', 'Medium', 'High', 'Urgent'].map((p) => `<option ${t?.DefaultPriority === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
      </div>
      <div class="field-row"><label>Default Description</label><textarea class="tf-description">${escapeHtml(t?.DefaultDescription || '')}</textarea></div>
      <div class="field-row"><label>Default Job Lines</label>
        <p class="muted" style="margin:2px 0 8px">Pre-fills these lines on every WO created from this template. A field left blank here follows row 1 in the grid; one with a value arrives pinned. Dates are never stored on a template.</p>
        <div class="tf-job-lines">${jlRows}</div>
        <button type="button" class="btn btn-secondary tf-add-line" style="margin-top:6px">+ Add Job Line</button>
      </div>
      <details style="margin:12px 0">
        <summary style="cursor:pointer;font-weight:700">Also update asset fields (optional)</summary>
        <div class="tf-asset-updates" style="margin-top:8px">${auRows}</div>
        <button type="button" class="btn btn-secondary tf-add-au" style="margin-top:6px">+ Add Field Update</button>
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
          ${t.Description ? `<div class="muted">${escapeHtml(t.Description)}</div>` : ''}
          ${t.Lines?.length ? `<div class="muted">${t.Lines.length} job line${t.Lines.length > 1 ? 's' : ''}</div>` : ''}
        </div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn btn-secondary tpl-edit" data-id="${t.Id}">Edit</button>
          <button class="btn btn-secondary tpl-delete" data-id="${t.Id}" data-name="${escapeHtml(t.Name)}">Delete</button>
        </div>
      </div>`).join('') || '<p class="muted">🧾 No templates yet — save your repeatable job lines here.</p>';

    setApp(`
      <div class="card"><h3>Work Order Templates</h3>
        <p class="muted">Canned setups for repeatable jobs — pick one from "New Work Order" instead of retyping everything.</p>
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
    container.querySelectorAll('.tf-add-line').forEach((btn) => btn.addEventListener('click', () => {
      btn.previousElementSibling.insertAdjacentHTML('beforeend', jlDefaultRowHtml());
      mountTemplateFundingPickers();
      wireRemoveButtons();
    }));
    container.querySelectorAll('.tf-add-au').forEach((btn) => btn.addEventListener('click', () => {
      btn.previousElementSibling.insertAdjacentHTML('beforeend', auDefaultRowHtml());
      wireRemoveButtons();
    }));
    mountTemplateFundingPickers();
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
      const lines = [...card.querySelectorAll('.jld-row')].map((row) => {
        const funding = row.querySelector('.jld-funding')._cbx?.getValue();
        const parsed = funding ? parseFundingOptionValue(funding) : null;
        return {
          title: row.querySelector('.jld-title').value.trim(),
          responsibilityClass: row.querySelector('.jld-resp').value || null,
          fundingSource: parsed ? parsed.source : null,
          fundingRefId: parsed ? parsed.refId : null,
          estimatedHours: row.querySelector('.jld-hours').value || null,
          estimatedCost: row.querySelector('.jld-cost').value || null,
        };
      }).filter((r) => r.title);
      const assetUpdateDefaults = [...card.querySelectorAll('.aud-row')].map((row) => ({
        targetField: row.querySelector('.aud-field').value, newValue: row.querySelector('.aud-value').value,
      })).filter((r) => r.newValue.trim());
      const fields = {
        name, description: card.querySelector('.tf-desc').value.trim(),
        defaultTitle: card.querySelector('.tf-title').value.trim(),
        defaultPriority: card.querySelector('.tf-priority').value,
        defaultDescription: card.querySelector('.tf-description').value.trim(),
        lines, assetUpdateDefaults,
      };
      const id = btn.dataset.id;
      try {
        await api(id ? `/api/pg/work-order-templates/${id}` : '/api/pg/work-order-templates', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(fields) });
        toast(id ? 'Template updated' : 'Template created');
        renderAdminWoTemplates(container);
      } catch (err) { toast(err.message); }
    }));
  }

  // Blank means "this template doesn't decide the funding" — the line will
  // follow row 1 in the grid (§8), so the picker starts empty rather than
  // silently defaulting to Operating Budget.
  function mountTemplateFundingPickers() {
    container.querySelectorAll('.jld-funding').forEach((el) => {
      if (el._cbx) return;
      el._cbx = mountCombobox(el, {
        options: fundingOptions,
        value: el.dataset.value || null,
        placeholder: '— funding follows row 1 —',
        emptyText: 'No funding source matches',
      });
    });
  }

  function wireRemoveButtons() {
    container.querySelectorAll('.row-remove').forEach((btn) => { btn.onclick = () => btn.closest('.inline-add-row').remove(); });
  }

  draw();
}

// Build Brief v2 Phase 7 (§7.1) — wording/defaults for the "Create WO from
// Findings" screen, keyed loosely by building type + component type. Most
// specific match wins server-side (matchJobLineTemplate in db.js); this
// page is plain CRUD, same shape as Causes/Attachment Roles.
async function renderAdminJobLineTemplates(container = app) {
  if (container === app) setChrome({ title: 'Job Line Templates', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { templates } = await api('/api/pg/admin/job-line-templates');
  const buildingTypes = state.options.buildingTypes || [];
  const componentTypes = state.options.componentTypeOptions || [];
  const buildingTypeName = (id) => buildingTypes.find((b) => b.Id === id)?.Name;

  const rows = templates.map((t) => `
    <div class="list-item" style="cursor:default;flex-wrap:wrap">
      <span><strong>${escapeHtml(t.DefaultTitle)}</strong>
        <div class="muted" style="font-weight:400">${[buildingTypeName(t.BuildingTypeId), t.ComponentType].filter(Boolean).join(' · ') || 'Matches anything'}
          ${t.DefaultResponsibilityClass ? ` · ${escapeHtml(RESPONSIBILITY_CLASS_LABELS[t.DefaultResponsibilityClass] || t.DefaultResponsibilityClass)}` : ''}
          ${!t.Active ? ' · <span class="pill">inactive</span>' : ''}</div></span>
      <span class="btn-row" style="margin-top:0">
        <button class="btn btn-secondary jlt-toggle-active" data-id="${t.Id}" data-active="${t.Active}">${t.Active ? 'Deactivate' : 'Reactivate'}</button>
        <button class="btn btn-secondary jlt-delete" data-id="${t.Id}" data-name="${escapeHtml(t.DefaultTitle)}">Delete</button>
      </span>
    </div>`).join('') || '<p class="muted">No templates yet.</p>';

  container.innerHTML = `
    <div class="card"><h3>Job Line Templates</h3>
      <p class="muted">Wording and defaults only — never grouping. A finding on Roof for a Cabin seeds a line titled "Roof repair — {asset}" with class and funding pre-filled. Use <code>{asset}</code> in the title to substitute the asset's name. Leave Building Type and/or Component Type unset to match more broadly.</p>
    </div>
    <div class="card">${rows}</div>
    <div class="card">
      <h3>Add Template</h3>
      <form id="addJltForm">
        <div class="field-row"><label>Default Title</label><input name="defaultTitle" placeholder="e.g. Roof repair — {asset}" required /></div>
        <div class="field-row"><label>Building Type (optional)</label><select name="buildingTypeId"><option value="">— any —</option>${buildingTypes.map((b) => `<option value="${b.Id}">${escapeHtml(b.Name)}</option>`).join('')}</select></div>
        <div class="field-row"><label>Component Type (optional)</label><select name="componentType"><option value="">— any —</option>${componentTypes.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}</select></div>
        <div class="field-row"><label>Default Responsibility</label><select name="defaultResponsibilityClass"><option value="">— unset —</option>${Object.entries(RESPONSIBILITY_CLASS_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="field-row"><label>Default Funding Source</label><select name="defaultFundingSource"><option value="">— unset —</option>${Object.entries(FUNDING_SOURCE_LABELS).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}</select></div>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>
    </div>`;

  container.querySelectorAll('.jlt-toggle-active').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await api(`/api/pg/admin/job-line-templates/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.active !== 'true' }) });
      renderAdminJobLineTemplates(container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelectorAll('.jlt-delete').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete template "${btn.dataset.name}"?`)) return;
    try {
      await api(`/api/pg/admin/job-line-templates/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Template deleted');
      renderAdminJobLineTemplates(container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelector('#addJltForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/pg/admin/job-line-templates', { method: 'POST', body: JSON.stringify({
        defaultTitle: fd.get('defaultTitle'), buildingTypeId: fd.get('buildingTypeId') || null, componentType: fd.get('componentType') || null,
        defaultResponsibilityClass: fd.get('defaultResponsibilityClass') || null, defaultFundingSource: fd.get('defaultFundingSource') || null,
      }) });
      renderAdminJobLineTemplates(container);
    } catch (err) { toast(err.message); }
  });
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

// Causes catalog (1.6) — admin-editable dropdown a job line's Cause
// multi-select reads from. Deactivating (not deleting) is the default path
// once a cause is in use, same in-use-guard pattern as sub-areas/building
// types; deleting a never-used cause is still allowed.
// Work order statuses (2.2) — admin-editable, seeded with Reported/Assessed/
// Scheduled/In Progress/Done/Deferred/Cancelled. No "Urgent" or "On Hold"
// here on purpose: Urgent is a priority (see the priority column), and
// Blocked lives on the job line — see the Job Line Statuses page.
async function renderAdminWorkOrderStatuses(container = app) {
  if (container === app) setChrome({ title: 'Work Order Statuses', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const [{ statuses }, displaySettings] = await Promise.all([
    api('/api/pg/admin/work-order-statuses'), api('/api/pg/display-settings'),
  ]);

  const rows = statuses.map((s) => `
    <div class="list-item" style="cursor:default;flex-wrap:wrap">
      <span><span class="pill" style="background:${s.Color}1a;color:${s.Color};border:1px solid ${s.Color}66">${escapeHtml(s.Name)}</span>
        ${s.IsTerminal ? '<span class="muted">terminal</span>' : ''}${s.IsReview ? ' <span class="pill good">review</span>' : ''}${!s.Active ? ' <span class="pill">inactive</span>' : ''}</span>
      <span class="btn-row" style="margin-top:0">
        <button class="btn btn-secondary wos-toggle-review" data-id="${s.Id}" data-review="${s.IsReview}" title="The status the 'all lines resolved' prompt offers to move a work order to">${s.IsReview ? 'Unset review' : 'Mark as review'}</button>
        <button class="btn btn-secondary wos-toggle-active" data-id="${s.Id}" data-active="${s.Active}">${s.Active ? 'Deactivate' : 'Reactivate'}</button>
        <button class="btn btn-secondary wos-delete" data-id="${s.Id}" data-name="${escapeHtml(s.Name)}">Delete</button>
      </span>
    </div>`).join('') || '<p class="muted">No statuses defined.</p>';

  container.innerHTML = `
    <div class="card"><h3>Work Order Statuses</h3>
      <p class="muted">The pipeline a work order moves through. Terminal statuses (Done/Deferred/Cancelled) no longer block on the close gate.</p>
    </div>
    <div class="card">
      <h3>Grid progress bar weighting</h3>
      <p class="muted">Whether the work order grid's progress bar defaults to cost-weighted (recommended — the board sees money, not just line count) or line-count-weighted.</p>
      <select id="progressWeightingSelect">
        <option value="cost" ${displaySettings.WoProgressWeighting === 'cost' ? 'selected' : ''}>Cost-weighted</option>
        <option value="count" ${displaySettings.WoProgressWeighting === 'count' ? 'selected' : ''}>Line-count-weighted</option>
      </select>
    </div>
    <div class="card">
      <h3>Job line grid — cascade defaults</h3>
      <p class="muted">Which columns rows 2+ inherit from row 1 on a new work order, until someone types over them. Any single work order can override this from the grid's cascade popover; changing it here never alters lines already saved.</p>
      <div id="cascadeDefaults">
        ${JLG_CASCADE_COLUMNS.map((c) => `<label class="jlg-cascade-opt"><input type="checkbox" data-col="${c.key}" ${(displaySettings.CascadeDefaults || {})[c.key] !== false ? 'checked' : ''} /> ${escapeHtml(c.label)}</label>`).join('')}
      </div>
    </div>
    <div class="card">
      <h3>Report embedded-photo cap</h3>
      <p class="muted">Max images embedded per work order in the Work Performed report — the rest fall back to links. Forty embedded photos is a 60MB email that bounces off half the board's mail servers.</p>
      <input id="reportImageCapInput" type="number" min="1" max="20" value="${displaySettings.ReportImageCap}" style="max-width:100px" />
    </div>
    <div class="card">${rows}</div>
    <div class="card">
      <h3>Add Status</h3>
      <form id="addWosForm">
        <div class="field-row"><label>Name</label><input name="name" required /></div>
        <div class="field-row"><label>Color</label><input name="color" type="color" value="#888888" /></div>
        <div class="field-row"><label>Terminal</label>
          <label class="skill-chip" style="cursor:pointer;display:inline-flex"><input type="checkbox" name="isTerminal" style="margin-right:6px" />No longer blocks anything downstream</label>
        </div>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>
    </div>`;

  container.querySelector('#progressWeightingSelect').addEventListener('change', async (e) => {
    try {
      await api('/api/pg/display-settings', { method: 'PUT', body: JSON.stringify({ woProgressWeighting: e.target.value }) });
      toast('Saved');
      if (state.options) state.options.displaySettings = await api('/api/pg/display-settings');
    } catch (err) { toast(err.message); }
  });
  container.querySelectorAll('#cascadeDefaults input[data-col]').forEach((el) => el.addEventListener('change', async () => {
    try {
      await api('/api/pg/display-settings', { method: 'PUT', body: JSON.stringify({ cascadeDefaults: { [el.dataset.col]: el.checked } }) });
      toast('Saved');
    } catch (err) { toast(err.message); el.checked = !el.checked; }
  }));
  container.querySelector('#reportImageCapInput').addEventListener('change', async (e) => {
    try {
      await api('/api/pg/display-settings', { method: 'PUT', body: JSON.stringify({ reportImageCap: Number(e.target.value) }) });
      toast('Saved');
      if (state.options) state.options.displaySettings = await api('/api/pg/display-settings');
    } catch (err) { toast(err.message); }
  });
  // §10: the review prompt targets whichever status carries this flag, so
  // renaming or reordering "Review" never silently breaks it. Only one status
  // can hold it at a time — setting it here clears it elsewhere.
  container.querySelectorAll('.wos-toggle-review').forEach((btn) => btn.addEventListener('click', async () => {
    const turningOn = btn.dataset.review !== 'true';
    try {
      if (turningOn) {
        for (const other of statuses.filter((st) => st.IsReview && String(st.Id) !== btn.dataset.id)) {
          await api(`/api/pg/admin/work-order-statuses/${other.Id}`, { method: 'PATCH', body: JSON.stringify({ isReview: false }) });
        }
      }
      await api(`/api/pg/admin/work-order-statuses/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ isReview: turningOn }) });
      renderAdminWorkOrderStatuses(container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelectorAll('.wos-toggle-active').forEach((btn) => btn.addEventListener('click', async () => {
    try { await api(`/api/pg/admin/work-order-statuses/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.active !== 'true' }) }); renderAdminWorkOrderStatuses(container); }
    catch (err) { toast(err.message); }
  }));
  container.querySelectorAll('.wos-delete').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete status "${btn.dataset.name}"? Only possible if no work order uses it — deactivate instead if it's in use.`)) return;
    try { await api(`/api/pg/admin/work-order-statuses/${btn.dataset.id}`, { method: 'DELETE' }); toast('Deleted'); renderAdminWorkOrderStatuses(container); }
    catch (err) { toast(err.message); }
  }));
  container.querySelector('#addWosForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/pg/admin/work-order-statuses', { method: 'POST', body: JSON.stringify({ name: fd.get('name'), color: fd.get('color'), isTerminal: fd.has('isTerminal') }) });
      renderAdminWorkOrderStatuses(container);
    } catch (err) { toast(err.message); }
  });
}

// Job line statuses (2.1) — is_terminal and counts_as_work_performed are
// separate flags on purpose: "Not Needed" is terminal but isn't work
// performed, which is what makes "12 completed, 3 not needed" an honest
// board sentence instead of "15 closed."
async function renderAdminJobLineStatuses(container = app) {
  if (container === app) setChrome({ title: 'Job Line Statuses', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { statuses } = await api('/api/pg/admin/job-line-statuses');

  const rows = statuses.map((s) => `
    <div class="list-item" style="cursor:default;flex-wrap:wrap">
      <span><span class="pill" style="background:${s.Color}1a;color:${s.Color};border:1px solid ${s.Color}66">${escapeHtml(s.Name)}</span>
        ${s.IsTerminal ? '<span class="muted">terminal</span>' : ''}${s.CountsAsWorkPerformed ? '<span class="muted">counts as work performed</span>' : ''}${s.RequiresNote ? `<span class="muted">requires note: "${escapeHtml(s.NoteLabel || '')}"</span>` : ''}${!s.Active ? ' <span class="pill">inactive</span>' : ''}</span>
      <span class="btn-row" style="margin-top:0">
        <button class="btn btn-secondary jls-toggle-active" data-id="${s.Id}" data-active="${s.Active}">${s.Active ? 'Deactivate' : 'Reactivate'}</button>
        <button class="btn btn-secondary jls-delete" data-id="${s.Id}" data-name="${escapeHtml(s.Name)}">Delete</button>
      </span>
    </div>`).join('') || '<p class="muted">No statuses defined.</p>';

  container.innerHTML = `
    <div class="card"><h3>Job Line Statuses</h3>
      <p class="muted">What a job line's own progress dropdown offers. Blocked is not a status — see blocked_reason on the job line itself.</p>
    </div>
    <div class="card">${rows}</div>
    <div class="card">
      <h3>Add Status</h3>
      <form id="addJlsForm">
        <div class="field-row"><label>Name</label><input name="name" required /></div>
        <div class="field-row"><label>Color</label><input name="color" type="color" value="#888888" /></div>
        <div class="field-row"><label>Terminal</label>
          <label class="skill-chip" style="cursor:pointer;display:inline-flex"><input type="checkbox" name="isTerminal" style="margin-right:6px" />No longer blocks the WO from closing</label>
        </div>
        <div class="field-row"><label>Counts as Work Performed</label>
          <label class="skill-chip" style="cursor:pointer;display:inline-flex"><input type="checkbox" name="countsAsWorkPerformed" style="margin-right:6px" />Real work happened (not just "decided not needed")</label>
        </div>
        <div class="field-row"><label>Requires Note</label>
          <label class="skill-chip" style="cursor:pointer;display:inline-flex"><input type="checkbox" name="requiresNote" style="margin-right:6px" />Won't save without an answer</label>
        </div>
        <div class="field-row"><label>Note Prompt</label><input name="noteLabel" placeholder="e.g. Why was this not needed?" /></div>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>
    </div>`;

  container.querySelectorAll('.jls-toggle-active').forEach((btn) => btn.addEventListener('click', async () => {
    try { await api(`/api/pg/admin/job-line-statuses/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.active !== 'true' }) }); renderAdminJobLineStatuses(container); }
    catch (err) { toast(err.message); }
  }));
  container.querySelectorAll('.jls-delete').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete status "${btn.dataset.name}"? Only possible if no job line uses it — deactivate instead if it's in use.`)) return;
    try { await api(`/api/pg/admin/job-line-statuses/${btn.dataset.id}`, { method: 'DELETE' }); toast('Deleted'); renderAdminJobLineStatuses(container); }
    catch (err) { toast(err.message); }
  }));
  container.querySelector('#addJlsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/pg/admin/job-line-statuses', { method: 'POST', body: JSON.stringify({
        name: fd.get('name'), color: fd.get('color'), isTerminal: fd.has('isTerminal'),
        countsAsWorkPerformed: fd.has('countsAsWorkPerformed'), requiresNote: fd.has('requiresNote'), noteLabel: fd.get('noteLabel') || null,
      }) });
      renderAdminJobLineStatuses(container);
    } catch (err) { toast(err.message); }
  });
}

// Build Brief v3 Part 1/3 — same freetext-never-promoted admin CRUD pattern
// as Causes below, for what kind of thing an expense was.
async function renderAdminExpenseCategories(container = app) {
  if (container === app) setChrome({ title: 'Expense Categories', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { categories } = await api('/api/pg/expense-categories');

  const rows = categories.map((c) => `
    <div class="list-item" style="cursor:default">
      <span>${escapeHtml(c.Name)}${!c.Active ? ' <span class="pill">inactive</span>' : ''}</span>
      <span class="btn-row" style="margin-top:0">
        <button class="btn btn-secondary ec-toggle-active" data-id="${c.Id}" data-active="${c.Active}">${c.Active ? 'Deactivate' : 'Reactivate'}</button>
        <button class="btn btn-secondary ec-delete" data-id="${c.Id}" data-name="${escapeHtml(c.Name)}">Delete</button>
      </span>
    </div>`).join('') || '<p class="muted">No expense categories defined yet.</p>';

  container.innerHTML = `
    <div class="card"><h3>Expense Categories</h3>
      <p class="muted">What kind of thing an expense was — independent of which fund it came from. Freetext never gets promoted into this list; adding one here is the only way it becomes selectable.</p>
    </div>
    <div class="card">${rows}</div>
    <div class="card">
      <h3>Add Category</h3>
      <form id="addExpenseCategoryForm">
        <div class="field-row"><label>Name</label><input name="name" placeholder="e.g. Materials" required /></div>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>
    </div>`;

  container.querySelectorAll('.ec-toggle-active').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await api(`/api/pg/admin/expense-categories/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.active !== 'true' }) });
      renderAdminExpenseCategories(container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelectorAll('.ec-delete').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete category "${btn.dataset.name}"? Only possible if no expense uses it — deactivate instead if it's in use.`)) return;
    try {
      await api(`/api/pg/admin/expense-categories/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Category deleted');
      renderAdminExpenseCategories(container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelector('#addExpenseCategoryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/pg/admin/expense-categories', { method: 'POST', body: JSON.stringify({ name: fd.get('name') }) });
      renderAdminExpenseCategories(container);
    } catch (err) { toast(err.message); }
  });
}

// Admin Task Categories — same name-only catalog shape as Expense
// Categories; in-use entries deactivate rather than delete.
async function renderAdminTaskCategories(container = app) {
  if (container === app) setChrome({ title: 'Admin Task Categories', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { categories } = await api('/api/pg/admin-task-categories');

  const rows = categories.map((c) => `
    <div class="list-item" style="cursor:default">
      <span>${escapeHtml(c.Name)}${!c.Active ? ' <span class="pill">inactive</span>' : ''}</span>
      <span class="btn-row" style="margin-top:0">
        <button class="btn btn-secondary atc-toggle-active" data-id="${c.Id}" data-active="${c.Active}">${c.Active ? 'Deactivate' : 'Reactivate'}</button>
        <button class="btn btn-secondary atc-delete" data-id="${c.Id}" data-name="${escapeHtml(c.Name)}">Delete</button>
      </span>
    </div>`).join('') || '<p class="muted">No categories defined yet.</p>';

  container.innerHTML = `
    <div class="card"><h3>Admin Task Categories</h3>
      <p class="muted">Optional grouping for administrative tasks. Deactivating hides a category from new tasks without changing tasks that already use it.</p>
    </div>
    <div class="card">${rows}</div>
    <div class="card">
      <h3>Add Category</h3>
      <form id="addAdminTaskCategoryForm">
        <div class="field-row"><label>Name</label><input name="name" placeholder="e.g. Fundraising" required /></div>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>
    </div>`;

  const patch = async (catId, body) => {
    try { await api(`/api/pg/admin/admin-task-categories/${catId}`, { method: 'PATCH', body: JSON.stringify(body) }); renderAdminTaskCategories(container); }
    catch (err) { toast(err.message); }
  };
  container.querySelectorAll('.atc-toggle-active').forEach((btn) => btn.addEventListener('click', () => patch(btn.dataset.id, { active: btn.dataset.active !== 'true' })));
  container.querySelectorAll('.atc-delete').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete category "${btn.dataset.name}"? Only possible if no task uses it — deactivate instead if it's in use.`)) return;
    try {
      await api(`/api/pg/admin/admin-task-categories/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Category deleted');
      renderAdminTaskCategories(container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelector('#addAdminTaskCategoryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/pg/admin/admin-task-categories', { method: 'POST', body: JSON.stringify({ name: fd.get('name') }) });
      renderAdminTaskCategories(container);
    } catch (err) { toast(err.message); }
  });
}

// Admin Task Statuses — "counts as work performed" decides whether a task
// in that status shows in the Work Performed report (and whether its
// recurring savings count toward the total there).
async function renderAdminTaskStatuses(container = app) {
  if (container === app) setChrome({ title: 'Admin Task Statuses', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { statuses } = await api('/api/pg/admin-task-statuses');

  const rows = statuses.map((st) => `
    <div class="list-item" style="cursor:default">
      <span>${escapeHtml(st.Name)}
        ${st.CountsAsWorkPerformed ? '<span class="muted">counts as work performed</span>' : ''}${!st.Active ? ' <span class="pill">inactive</span>' : ''}</span>
      <span class="btn-row" style="margin-top:0">
        <button class="btn btn-secondary ats-toggle-wp" data-id="${st.Id}" data-wp="${st.CountsAsWorkPerformed}">${st.CountsAsWorkPerformed ? 'Exclude from report' : 'Include in report'}</button>
        <button class="btn btn-secondary ats-toggle-active" data-id="${st.Id}" data-active="${st.Active}">${st.Active ? 'Deactivate' : 'Reactivate'}</button>
        <button class="btn btn-secondary ats-delete" data-id="${st.Id}" data-name="${escapeHtml(st.Name)}">Delete</button>
      </span>
    </div>`).join('') || '<p class="muted">No statuses defined yet.</p>';

  container.innerHTML = `
    <div class="card"><h3>Admin Task Statuses</h3>
      <p class="muted">Statuses that "count as work performed" put a task in the Work Performed report's Administrative Work section, and count its recurring savings. To Do and Cancelled don't by default.</p>
    </div>
    <div class="card">${rows}</div>
    <div class="card">
      <h3>Add Status</h3>
      <form id="addAdminTaskStatusForm">
        <div class="field-row"><label>Name</label><input name="name" placeholder="e.g. Scheduled" required /></div>
        <label class="skill-chip" style="cursor:pointer;display:inline-flex"><input type="checkbox" name="countsAsWorkPerformed" style="margin-right:6px" />Counts as work performed</label>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>
    </div>`;

  const patch = async (statusId, body) => {
    try { await api(`/api/pg/admin/admin-task-statuses/${statusId}`, { method: 'PATCH', body: JSON.stringify(body) }); renderAdminTaskStatuses(container); }
    catch (err) { toast(err.message); }
  };
  container.querySelectorAll('.ats-toggle-wp').forEach((btn) => btn.addEventListener('click', () => patch(btn.dataset.id, { countsAsWorkPerformed: btn.dataset.wp !== 'true' })));
  container.querySelectorAll('.ats-toggle-active').forEach((btn) => btn.addEventListener('click', () => patch(btn.dataset.id, { active: btn.dataset.active !== 'true' })));
  container.querySelectorAll('.ats-delete').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete status "${btn.dataset.name}"? Only possible if no task uses it — deactivate instead if it's in use.`)) return;
    try {
      await api(`/api/pg/admin/admin-task-statuses/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Status deleted');
      renderAdminTaskStatuses(container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelector('#addAdminTaskStatusForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/pg/admin/admin-task-statuses', { method: 'POST', body: JSON.stringify({ name: fd.get('name'), countsAsWorkPerformed: fd.has('countsAsWorkPerformed') }) });
      renderAdminTaskStatuses(container);
    } catch (err) { toast(err.message); }
  });
}

// Build Brief v3 Part 1/3 — funds are money with a ceiling Ben is personally
// accountable for, not a general ledger (the operating budget stays a label
// with no balance tracked). More fields than a plain name-only catalog, so
// this gets its own inline edit form rather than mirroring Causes exactly.
async function renderAdminFunds(container = app) {
  if (container === app) setChrome({ title: 'Funds', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { funds } = await api('/api/pg/funds');

  const fundRowHtml = (f) => `
    <div class="card fund-row" data-id="${f.Id}">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <strong style="flex:1">${escapeHtml(f.Name)}</strong>
        ${!f.Active ? '<span class="pill">inactive</span>' : ''}
        ${f.Expired ? '<span class="pill">expired</span>' : ''}
        <button type="button" class="btn btn-secondary fund-edit-toggle">Edit</button>
      </div>
      <p class="muted" style="margin:4px 0 0">$${Number(f.Amount).toLocaleString()}${f.EndDate ? ` through ${formatDateNice(f.EndDate)}` : ''}${f.AuthorizedBy ? ` · authorized by ${escapeHtml(f.AuthorizedBy)}` : ''}</p>
      <form class="fund-edit-form" hidden style="margin-top:10px">
        <div class="field-row"><label>Name</label><input class="f-name" value="${escapeHtml(f.Name)}" required /></div>
        <div class="field-row"><label>Amount</label><input class="f-amount" type="number" step="0.01" min="0" value="${f.Amount}" required /></div>
        <div class="field-row"><label>Start Date</label><input class="f-start" type="date" value="${(f.StartDate || '').slice(0, 10)}" /></div>
        <div class="field-row"><label>End Date</label><input class="f-end" type="date" value="${(f.EndDate || '').slice(0, 10)}" />
          <p class="muted" style="margin-top:2px;font-size:0.8rem">Past this date the fund drops out of the default picker but stays selectable for backdated entry.</p>
        </div>
        <div class="field-row"><label>Authorized By</label><input class="f-authorized" value="${escapeHtml(f.AuthorizedBy || '')}" /></div>
        <div class="field-row"><label>Notes</label><textarea class="f-notes">${escapeHtml(f.Notes || '')}</textarea></div>
        <div class="btn-row">
          <button class="btn btn-primary fund-save" type="submit">Save</button>
          <button class="btn btn-secondary fund-toggle-active" type="button" data-active="${f.Active}">${f.Active ? 'Deactivate' : 'Reactivate'}</button>
          <button class="btn btn-secondary fund-delete" type="button" data-name="${escapeHtml(f.Name)}">Delete</button>
        </div>
      </form>
    </div>`;

  container.innerHTML = `
    <div class="card"><h3>Funds</h3>
      <p class="muted">Money with a ceiling Ben is personally accountable for — a reference line, not an enforcement mechanism. Spending past Amount always warns, never blocks. The camp's operating budget is NOT a fund; it stays a label with no balance tracked here.</p>
    </div>
    ${funds.map(fundRowHtml).join('') || '<p class="muted">No funds defined yet.</p>'}
    <div class="card">
      <h3>Add Fund</h3>
      <form id="addFundForm">
        <div class="field-row"><label>Name</label><input name="name" placeholder="e.g. Discretionary Audit Fund" required /></div>
        <div class="field-row"><label>Amount</label><input name="amount" type="number" step="0.01" min="0" required /></div>
        <div class="field-row"><label>Start Date</label><input name="startDate" type="date" /></div>
        <div class="field-row"><label>End Date</label><input name="endDate" type="date" /></div>
        <div class="field-row"><label>Authorized By</label><input name="authorizedBy" placeholder="e.g. Camp Sychar board" /></div>
        <div class="field-row"><label>Notes</label><textarea name="notes"></textarea></div>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>
    </div>`;

  container.querySelectorAll('.fund-row').forEach((row) => {
    const id = row.dataset.id;
    const form = row.querySelector('.fund-edit-form');
    row.querySelector('.fund-edit-toggle').addEventListener('click', () => { form.hidden = !form.hidden; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/api/pg/admin/funds/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: form.querySelector('.f-name').value.trim(),
            amount: Number(form.querySelector('.f-amount').value),
            startDate: form.querySelector('.f-start').value || null,
            endDate: form.querySelector('.f-end').value || null,
            authorizedBy: form.querySelector('.f-authorized').value || null,
            notes: form.querySelector('.f-notes').value || null,
          }),
        });
        toast('Fund saved');
        renderAdminFunds(container);
      } catch (err) { toast(err.message); }
    });
    form.querySelector('.fund-toggle-active').addEventListener('click', async () => {
      const btn = form.querySelector('.fund-toggle-active');
      try {
        await api(`/api/pg/admin/funds/${id}`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.active !== 'true' }) });
        renderAdminFunds(container);
      } catch (err) { toast(err.message); }
    });
    form.querySelector('.fund-delete').addEventListener('click', async () => {
      const btn = form.querySelector('.fund-delete');
      if (!await confirmDialog(`Delete fund "${btn.dataset.name}"? Only possible if no expense or job line uses it — deactivate instead if it's in use.`)) return;
      try {
        await api(`/api/pg/admin/funds/${id}`, { method: 'DELETE' });
        toast('Fund deleted');
        renderAdminFunds(container);
      } catch (err) { toast(err.message); }
    });
  });

  container.querySelector('#addFundForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/pg/admin/funds', {
        method: 'POST',
        body: JSON.stringify({
          name: fd.get('name'), amount: Number(fd.get('amount')), startDate: fd.get('startDate') || null,
          endDate: fd.get('endDate') || null, authorizedBy: fd.get('authorizedBy') || null, notes: fd.get('notes') || null,
        }),
      });
      toast('Fund added');
      renderAdminFunds(container);
    } catch (err) { toast(err.message); }
  });
}

async function renderAdminCauses(container = app) {
  if (container === app) setChrome({ title: 'Causes', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { causes } = await api('/api/pg/causes');

  const rows = causes.map((c) => `
    <div class="list-item" style="cursor:default">
      <span>${escapeHtml(c.Name)}${!c.Active ? ' <span class="pill">inactive</span>' : ''}</span>
      <span class="btn-row" style="margin-top:0">
        <button class="btn btn-secondary cause-toggle-active" data-id="${c.Id}" data-active="${c.Active}">${c.Active ? 'Deactivate' : 'Reactivate'}</button>
        <button class="btn btn-secondary cause-delete" data-id="${c.Id}" data-name="${escapeHtml(c.Name)}">Delete</button>
      </span>
    </div>`).join('') || '<p class="muted">No causes defined yet.</p>';

  container.innerHTML = `
    <div class="card"><h3>Causes</h3>
      <p class="muted">What a job line's problem is attributed to — the dropdown that gets counted (see Cause Note on the job line for freetext detail). Adding one here is the only way it becomes selectable; freetext never gets promoted into this list.</p>
    </div>
    <div class="card">${rows}</div>
    <div class="card">
      <h3>Add Cause</h3>
      <form id="addCauseForm">
        <div class="field-row"><label>Name</label><input name="name" placeholder="e.g. Rot" required /></div>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>
    </div>`;

  container.querySelectorAll('.cause-toggle-active').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await api(`/api/pg/admin/causes/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.active !== 'true' }) });
      renderAdminCauses(container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelectorAll('.cause-delete').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete cause "${btn.dataset.name}"? Only possible if no job line uses it — deactivate instead if it's in use.`)) return;
    try {
      await api(`/api/pg/admin/causes/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Cause deleted');
      renderAdminCauses(container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelector('#addCauseForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/pg/admin/causes', { method: 'POST', body: JSON.stringify({ name: fd.get('name') }) });
      renderAdminCauses(container);
    } catch (err) { toast(err.message); }
  });
}

// Build Brief v2 Phase 4 (§4.3): what an attachment IS relative to whatever
// it's linked to — Before/After/Evidence/Quote/etc. "Default include in
// report" pre-ticks the report checkbox for that role (still overridable per
// link) — tagging something "After / Repair" is already saying "this is the
// proof."
async function renderAdminAttachmentRoles(container = app) {
  if (container === app) setChrome({ title: 'Attachment Roles', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { roles } = await api('/api/pg/attachment-roles');

  const rows = roles.map((r) => `
    <div class="list-item" style="cursor:default">
      <span>${escapeHtml(r.Name)}${r.DefaultIncludeInReport ? ' <span class="pill">in report by default</span>' : ''}${!r.Active ? ' <span class="pill">inactive</span>' : ''}</span>
      <span class="btn-row" style="margin-top:0">
        <button class="btn btn-secondary role-toggle-report" data-id="${r.Id}" data-next="${!r.DefaultIncludeInReport}">${r.DefaultIncludeInReport ? 'Unset' : 'Set'} report default</button>
        <button class="btn btn-secondary role-toggle-active" data-id="${r.Id}" data-active="${r.Active}">${r.Active ? 'Deactivate' : 'Reactivate'}</button>
        <button class="btn btn-secondary role-delete" data-id="${r.Id}" data-name="${escapeHtml(r.Name)}">Delete</button>
      </span>
    </div>`).join('') || '<p class="muted">No attachment roles defined yet.</p>';

  container.innerHTML = `
    <div class="card"><h3>Attachment Roles</h3>
      <p class="muted">What a photo or document IS relative to the record it's attached to — Before/After/Evidence/Quote/etc. Lives on the link, not the file, so the same photo can be "After / Repair" on a job line and "Reference" on the asset at once.</p>
    </div>
    <div class="card">${rows}</div>
    <div class="card">
      <h3>Add Role</h3>
      <form id="addRoleForm">
        <div class="field-row"><label>Name</label><input name="name" placeholder="e.g. Warranty" required /></div>
        <button class="btn btn-primary" type="submit">Add</button>
      </form>
    </div>`;

  container.querySelectorAll('.role-toggle-report').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await api(`/api/pg/admin/attachment-roles/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ defaultIncludeInReport: btn.dataset.next === 'true' }) });
      renderAdminAttachmentRoles(container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelectorAll('.role-toggle-active').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await api(`/api/pg/admin/attachment-roles/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.active !== 'true' }) });
      renderAdminAttachmentRoles(container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelectorAll('.role-delete').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete role "${btn.dataset.name}"? Only possible if no attachment uses it — deactivate instead if it's in use.`)) return;
    try {
      await api(`/api/pg/admin/attachment-roles/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Role deleted');
      renderAdminAttachmentRoles(container);
    } catch (err) { toast(err.message); }
  }));
  container.querySelector('#addRoleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/pg/admin/attachment-roles', { method: 'POST', body: JSON.stringify({ name: fd.get('name') }) });
      renderAdminAttachmentRoles(container);
    } catch (err) { toast(err.message); }
  });
}

// Calendar Event Types (Build Brief v4 Part 1, admin-editable per Decision
// 7) — name, sort order, and the Google event colorId this type maps to.
// Color drives both the synced Google event's color and its title prefix
// (step 3's job); this screen only manages the mapping.
async function renderAdminCalendarEventTypes(container = app) {
  if (container === app) setChrome({ title: 'Calendar Event Types', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { types } = await api('/api/pg/calendar-event-types');
  let editing = null; // 'new' | { id } | null

  function colorSelectHtml(selectedId) {
    return `<select class="cet-color">
      <option value="">— calendar's default color —</option>
      ${Object.entries(GOOGLE_EVENT_COLORS).map(([id, c]) => `<option value="${id}" ${selectedId === id ? 'selected' : ''}>${c.name}</option>`).join('')}
    </select>`;
  }

  function formHtml(t) {
    return `<div class="card">
      <h3>${t ? `Edit "${escapeHtml(t.Name)}"` : 'Add Type'}</h3>
      <div class="field-row"><label>Name</label><input class="cet-name" value="${escapeHtml(t?.Name || '')}" required /></div>
      <div class="field-row"><label>Sort Order</label><input class="cet-sort" type="number" value="${t?.SortOrder ?? 100}" style="max-width:120px" /></div>
      <div class="field-row"><label>Google Calendar Color</label>${colorSelectHtml(t?.GcalColorId || '')}</div>
      <div class="btn-row">
        <button class="btn btn-primary cet-save" data-id="${t?.Id ?? ''}">Save</button>
        <button class="btn btn-secondary cet-cancel">Cancel</button>
      </div>
    </div>`;
  }

  function draw() {
    const rows = types.map((t) => `
      <div class="list-item" style="cursor:default">
        <span>${googleColorDotHtml(t.GcalColorId)}${escapeHtml(t.Name)}${!t.Active ? ' <span class="pill">inactive</span>' : ''}</span>
        <div class="btn-row" style="margin-top:0">
          <button class="btn btn-secondary cet-edit" data-id="${t.Id}">Edit</button>
          <button class="btn btn-secondary cet-toggle-active" data-id="${t.Id}" data-active="${t.Active}">${t.Active ? 'Deactivate' : 'Reactivate'}</button>
          <button class="btn btn-secondary cet-delete" data-id="${t.Id}" data-name="${escapeHtml(t.Name)}">Delete</button>
        </div>
      </div>`).join('') || '<p class="muted">No types defined yet.</p>';

    setApp(`
      <div class="card"><h3>Calendar Event Types</h3>
        <p class="muted">What a calendar event IS — drives its Google Calendar color and title prefix once sync is built. "Other" is the seeded catch-all; every event always has a type.</p>
      </div>
      <div class="card">${rows}</div>
      ${editing === 'new' ? formHtml(null) : `<div class="btn-row" style="margin-top:10px"><button class="btn btn-secondary" id="addTypeBtn">+ Add Type</button></div>`}
      ${editing?.id ? formHtml(types.find((t) => t.Id === editing.id)) : ''}
    `, container);
    wire();
  }

  function wire() {
    container.querySelector('#addTypeBtn')?.addEventListener('click', () => { editing = 'new'; draw(); });
    container.querySelectorAll('.cet-edit').forEach((btn) => btn.addEventListener('click', () => { editing = { id: Number(btn.dataset.id) }; draw(); }));
    container.querySelectorAll('.cet-cancel').forEach((btn) => btn.addEventListener('click', () => { editing = null; draw(); }));
    container.querySelectorAll('.cet-save').forEach((btn) => btn.addEventListener('click', async () => {
      const card = btn.closest('.card');
      const id = btn.dataset.id;
      const name = card.querySelector('.cet-name').value.trim();
      const sortOrder = Number(card.querySelector('.cet-sort').value) || 100;
      const gcalColorId = card.querySelector('.cet-color').value || null;
      if (!name) { toast('Name is required'); return; }
      try {
        if (id) await api(`/api/pg/admin/calendar-event-types/${id}`, { method: 'PATCH', body: JSON.stringify({ name, sortOrder, gcalColorId }) });
        else await api('/api/pg/admin/calendar-event-types', { method: 'POST', body: JSON.stringify({ name, sortOrder, gcalColorId }) });
        toast('Saved');
        editing = null;
        renderAdminCalendarEventTypes(container);
      } catch (err) { toast(err.message); }
    }));
    container.querySelectorAll('.cet-toggle-active').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        await api(`/api/pg/admin/calendar-event-types/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.active !== 'true' }) });
        renderAdminCalendarEventTypes(container);
      } catch (err) { toast(err.message); }
    }));
    container.querySelectorAll('.cet-delete').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog(`Delete type "${btn.dataset.name}"? Only possible if no calendar event uses it — deactivate instead if it's in use.`)) return;
      try {
        await api(`/api/pg/admin/calendar-event-types/${btn.dataset.id}`, { method: 'DELETE' });
        toast('Type deleted');
        renderAdminCalendarEventTypes(container);
      } catch (err) { toast(err.message); }
    }));
  }
  draw();
}

// Build Brief v2 Phase 5 (§5.3): the one-time affine calibration that makes
// "nearest-asset suggestion from GPS" possible in the inbox. Needs exactly 3
// non-collinear reference points — pick 3 assets whose real-world GPS
// coordinates you know AND whose map_x/map_y are already set on the
// interactive Map (open the Map, click the asset's pin, its coordinates are
// shown there), then enter both here for each.
async function renderAdminMapCalibration(container = app) {
  if (container === app) setChrome({ title: 'Map GPS Calibration', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { points } = await api('/api/pg/admin/map-calibration');

  const rows = points.map((p) => `
    <div class="list-item" style="cursor:default;flex-wrap:wrap">
      <span><strong>${escapeHtml(p.Label)}</strong><div class="muted" style="font-weight:400">GPS ${p.Lat}, ${p.Lng} → map ${p.MapX}, ${p.MapY}</div></span>
      <button class="btn btn-secondary calib-delete" data-id="${p.Id}" data-name="${escapeHtml(p.Label)}">Delete</button>
    </div>`).join('') || '<p class="muted">No calibration points yet — GPS-based inbox suggestions are disabled until 3 are added.</p>';

  container.innerHTML = `
    <div class="card"><h3>Map GPS Calibration</h3>
      <p class="muted">Exactly 3 non-collinear points, real-world GPS → base map pixel coordinates. Powers "nearest asset" suggestions in the Inbox when a photo carries EXIF GPS. Pick 3 assets you're sure of — open the Map, tap the asset's pin to read its map_x/map_y, and pair that with its actual GPS coordinates (from your phone, standing at the asset). If the base map image has ever been swapped, these points need to be re-picked against the current image — they're pixel coordinates against whatever image was loaded when they were set.</p>
      <p class="muted">${points.length}/3 points set${points.length >= 3 ? ' — calibrated.' : '.'}</p>
    </div>
    <div class="card">${rows}</div>
    ${points.length < 3 ? `
    <div class="card">
      <h3>Add Point</h3>
      <form id="addCalibForm">
        <div class="field-row"><label>Label</label><input name="label" placeholder="e.g. Main Lodge" required /></div>
        <div class="field-row"><label>GPS Latitude</label><input name="lat" type="number" step="any" required /></div>
        <div class="field-row"><label>GPS Longitude</label><input name="lng" type="number" step="any" required /></div>
        <div class="field-row"><label>Map X (pixels)</label><input name="mapX" type="number" step="any" required /></div>
        <div class="field-row"><label>Map Y (pixels)</label><input name="mapY" type="number" step="any" required /></div>
        <button class="btn btn-primary" type="submit">Add Point</button>
      </form>
    </div>` : ''}`;

  container.querySelectorAll('.calib-delete').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog(`Delete calibration point "${btn.dataset.name}"?`)) return;
    await api(`/api/pg/admin/map-calibration/${btn.dataset.id}`, { method: 'DELETE' });
    renderAdminMapCalibration(container);
  }));
  container.querySelector('#addCalibForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/pg/admin/map-calibration', { method: 'POST', body: JSON.stringify({
        label: fd.get('label'), lat: fd.get('lat'), lng: fd.get('lng'), mapX: fd.get('mapX'), mapY: fd.get('mapY'),
      }) });
      renderAdminMapCalibration(container);
    } catch (err) { toast(err.message); }
  });
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

// Inclusive list of YYYY-MM-DD date-key strings from startStr to endStr —
// used to place a multi-day calendar event (Build Brief v4 Part 1, e.g. a
// Group Rental running Friday to Sunday) on every day it spans, not just
// its start day.
function datesBetween(startStr, endStr) {
  const out = [];
  let d = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  let guard = 0;
  while (d <= end && guard < 60) { // 60-day cap — plenty for any real camp rental/session, guards a bad date pair
    out.push(isoDate(d));
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    guard++;
  }
  return out;
}
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function weekStartOf(d) { return addDays(d, -d.getDay()); } // Sunday of that week — matches the month grid's Sun-start

// Icon + optional time + label for one calendar-grid entry (job line,
// calendar event, or deferred revisit date) — shared by every calendar
// surface (month grid, week/day grid, the day panel) so this logic lives in
// one place. Calendar events get a Google-color dot and their Type name
// prefixed (unless it's the "Other" catch-all) — this mirrors, in the app's
// own UI, the same title-prefix idea step 3 applies to the synced Google
// event itself.
function calendarEntryText(e) {
  if (e.type === 'jobLine') {
    const time = e.ScheduledStartTime ? `${formatTimeShort(e.ScheduledStartTime)} ` : '';
    return `🛠️ ${time}${escapeHtml(e.Asset?.Name || '')}${e.Asset ? ': ' : ''}${escapeHtml(e.WorkOrderTitle)} — ${escapeHtml(e.JobLineTitle)}`;
  }
  if (e.type === 'revisit') {
    return `📌 Revisit: ${e.Asset ? `${escapeHtml(e.Asset.Name)} — ` : ''}${escapeHtml(e.Title)}`;
  }
  const time = e.StartTime ? `${formatTimeShort(e.StartTime)} ` : '';
  const repeat = e.RecurrenceType !== 'none' ? ' 🔁' : '';
  // A visit reads as who · where — purpose, in place of the event's title
  // (usually just "Visit — Name" anyway) and type prefix: the 🧳 already
  // says "visit", and these three are what matters at a glance.
  if (e.VisitorName) {
    return `${googleColorDotHtml(e.TypeGcalColorId)}🧳 ${time}${escapeHtml(e.VisitorName)}${e.AssetName ? ` · ${escapeHtml(e.AssetName)}` : ''}${e.VisitPurpose ? ` — ${escapeHtml(e.VisitPurpose)}` : ''}${repeat}`;
  }
  const typePrefix = e.TypeName && e.TypeName !== 'Other' ? `${escapeHtml(e.TypeName)}: ` : '';
  return `${googleColorDotHtml(e.TypeGcalColorId)}📅 ${time}${typePrefix}${escapeHtml(e.Title)}${repeat}`;
}

// Plain-text hover tooltip for a calendar entry — Month/Week chips truncate
// to one line, so a visit's full purpose/contact would otherwise be hidden.
function calendarEntryTooltip(e) {
  if (e.type !== 'event' || !e.VisitorName) return '';
  return [
    `${e.VisitorName}${e.CabinHolderId ? ' (cabin holder)' : ''}`,
    e.AssetName ? `At: ${e.AssetName}` : null,
    e.VisitPurpose ? `Purpose: ${e.VisitPurpose}` : null,
    e.VisitorContact ? `Contact: ${e.VisitorContact}` : null,
  ].filter(Boolean).join('\n');
}

// Whether an entry is placed in the timed grid or the all-day band. A job
// line with no start time is untimed; a revisit date never has a time; a
// multi-day calendar event goes all-day regardless of its own start time —
// same rule the month grid already uses to span it across days.
function calendarEntryIsAllDay(e) {
  if (e.type === 'jobLine') return !e.ScheduledStartTime;
  if (e.type === 'revisit') return true;
  return !e.StartTime || e.OccurrenceDate !== e.OccurrenceEndDate;
}

// Whether an entry can be dragged to reschedule (Build Brief v4 Part 1
// amendment). A terminal-status job line (Done/Not Needed/Cancelled) is a
// closed decision — its work order can stay open with other lines still
// going, but this one is done moving. A revisit date is a commitment
// already made for a stated reason, not an open slot. A recurring or
// multi-day event's semantics on drag are genuinely ambiguous (move just
// this occurrence, or the whole series? shift the whole span, or just the
// start?) — deliberately out of scope, so both render fixed too.
function calendarEntryIsDraggable(e) {
  if (e.type === 'jobLine') return !e.StatusIsTerminal;
  if (e.type === 'event') return e.RecurrenceType === 'none' && e.OccurrenceDate === e.OccurrenceEndDate;
  return false;
}

// Slide-out panel from the right, listing one day's scheduled WOs/events —
// still used by Month view (clicking a day cell's background); Week and Day
// views show this same detail inline instead, so they don't need it.
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
      ${entries.length ? entries.map((e) => e.type === 'jobLine'
        ? `<div class="list-item day-panel-entry" data-wo-id="${e.WorkOrderId}"><span>${calendarEntryText(e)}</span>${statusPillHtml(e.WorkOrderStatus, e.WorkOrderStatusColor)}</div>`
        : e.type === 'revisit'
        ? `<div class="list-item day-panel-entry" ${e.WorkOrderId ? `data-wo-id="${e.WorkOrderId}"` : e.Asset ? `data-asset-id="${e.Asset.Id}"` : ''}><span>${calendarEntryText(e)}</span></div>`
        : `<div class="list-item day-panel-entry" data-event-id="${e.Id}"><span>${calendarEntryText(e)}</span></div>`
      ).join('') : '<p class="muted">Nothing scheduled this day.</p>'}
      <div class="btn-row"><button class="btn btn-primary" id="dayPanelAddEventBtn">+ Add Event This Day</button></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeDayPanel(); });
  document.getElementById('closeDayPanelBtn').addEventListener('click', closeDayPanel);
  document.getElementById('dayPanelAddEventBtn').addEventListener('click', () => { closeDayPanel(); go('newCalendarEvent', { date: dateKey }); });
  overlay.querySelectorAll('[data-wo-id]').forEach((el) => el.addEventListener('click', () => { closeDayPanel(); go('workOrderDetail', { id: el.dataset.woId }); }));
  overlay.querySelectorAll('[data-event-id]').forEach((el) => el.addEventListener('click', () => { closeDayPanel(); go('calendarEventDetail', { id: el.dataset.eventId }); }));
  overlay.querySelectorAll('[data-asset-id]:not([data-wo-id])').forEach((el) => el.addEventListener('click', () => { closeDayPanel(); go('assetDetail', { id: el.dataset.assetId }); }));
}
function closeDayPanel() { document.getElementById('dayPanelOverlay')?.remove(); }

// ---- Calendar view-mode toggle (Month/Week/Day) — same per-browser
// localStorage pattern as getTableViewMode/tableViewToggleHtml, including
// the same screen-width default: a whole month (or even a week) of tiny
// pills doesn't work on a phone, one day's plan does.
function getCalendarViewMode() {
  const saved = localStorage.getItem('campAuditCalendarView');
  if (saved === 'month' || saved === 'week' || saved === 'day') return saved;
  return window.matchMedia('(max-width: 640px)').matches ? 'day' : 'month';
}
function calendarViewToggleHtml(mode) {
  return `<div class="view-toggle">
    ${['month', 'week', 'day'].map((m) => `<button type="button" class="view-toggle-btn cal-mode-btn ${mode === m ? 'active' : ''}" data-mode="${m}">${m[0].toUpperCase()}${m.slice(1)}</button>`).join('')}
  </div>`;
}

// A working-hours window, not a full 24h Google-style day — this is a
// scheduling tool for camp maintenance/events, not a general calendar (see
// the brief's "scope to scheduling" note).
const CAL_HOUR_START = 6, CAL_HOUR_END = 21; // 6 AM – 9 PM
function calHourLabel(h) { return new Date(2000, 0, 1, h, 0).toLocaleTimeString('default', { hour: 'numeric' }); }
function calStartHour(timeStr) { return Math.min(CAL_HOUR_END, Math.max(CAL_HOUR_START, Number(timeStr.slice(0, 2)))); }
function calMinutesOfTime(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function calTimeFromMinutes(mins) {
  const wrapped = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

// Fetches everything the Calendar can show for [fromStr, toStr] and buckets
// it by day — one map shared by Month/Week/Day so they never disagree about
// what's scheduled. Job lines, not work orders, are what actually gets
// scheduled (1.4) — a WO's lines can have divergent dates (vendor Tuesday,
// volunteers Saturday, same WO), so each line is its own entry.
async function loadCalendarRangeData(fromStr, toStr) {
  const [{ occurrences }, { jobLines: scheduledJobLines }, { revisitDates }] = await Promise.all([
    api(`/api/pg/calendar-events?from=${fromStr}&to=${toStr}`),
    api(`/api/pg/job-lines/scheduled?from=${fromStr}&to=${toStr}`),
    api(`/api/pg/revisit-dates?from=${fromStr}&to=${toStr}`),
  ]);
  const dayEntriesMap = new Map();
  const push = (key, entry) => { if (!dayEntriesMap.has(key)) dayEntriesMap.set(key, []); dayEntriesMap.get(key).push(entry); };
  for (const jl of scheduledJobLines) push(jl.ScheduledDate.slice(0, 10), { type: 'jobLine', ...jl });
  for (const occ of occurrences) {
    // Multi-day span (e.g. a Group Rental running Friday to Sunday) — place
    // the same occurrence on every day it covers, not just its start day.
    for (const key of datesBetween(occ.OccurrenceDate, occ.OccurrenceEndDate || occ.OccurrenceDate)) {
      push(key, { type: 'event', ...occ });
    }
  }
  for (const rv of revisitDates) push(rv.RevisitDate.slice(0, 10), { type: 'revisit', ...rv });
  return dayEntriesMap;
}

// ---------- Drag-to-reschedule (Build Brief v4 Part 1 amendment) ----------
// Pointer Events, not the HTML5 drag-and-drop API — HTML5 DnD has no real
// touch support, and a phone is a first-class target here (Day view's whole
// reason to exist is scheduling from one). A movement threshold keeps a
// plain tap free to still open the entry instead of always starting a drag.
const CAL_DRAG_THRESHOLD = 8;
let calDragSuppressClick = false; // set right after a real drag-drop, so the click that always follows a pointerup doesn't also navigate
let calRefreshCurrentView = null; // set by renderCalendar; drop handling lives outside its closure

function calWireDraggable(el, getPayload) {
  el.classList.add('cal-draggable');
  el.addEventListener('pointerdown', (downEv) => {
    if (downEv.pointerType === 'mouse' && downEv.button !== 0) return;
    const startX = downEv.clientX, startY = downEv.clientY;
    let dragging = false, ghost = null, lastZone = null;
    function onMove(e) {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < CAL_DRAG_THRESHOLD) return;
        dragging = true;
        document.body.classList.add('cal-drag-active');
        el.classList.add('cal-dragging-source');
        ghost = el.cloneNode(true);
        ghost.classList.add('cal-drag-ghost');
        ghost.style.width = `${Math.min(el.offsetWidth, 260)}px`;
        document.body.appendChild(ghost);
      }
      e.preventDefault();
      if (ghost) { ghost.style.left = `${e.clientX + 14}px`; ghost.style.top = `${e.clientY + 14}px`; }
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const zone = under?.closest('[data-drop-date], [data-drop-queue]') || null;
      if (zone !== lastZone) {
        lastZone?.classList.remove('cal-drop-target');
        zone?.classList.add('cal-drop-target');
        lastZone = zone;
      }
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.body.classList.remove('cal-drag-active');
      el.classList.remove('cal-dragging-source');
      ghost?.remove();
      lastZone?.classList.remove('cal-drop-target');
      if (dragging && lastZone) {
        calDragSuppressClick = true;
        onCalendarDrop(getPayload(), lastZone.dataset);
      }
    }
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp, { once: true });
  });
}
function calWireClick(el, onClick) {
  el.addEventListener('click', (e) => {
    if (calDragSuppressClick) { calDragSuppressClick = false; return; }
    onClick(e);
  });
}

// Visitor-overlap warning before a job line lands on a date (warn, never
// block — same contract as the linked-expense double-count confirm and fund
// overage). `checks` is [{ date, assetId } | { date, jobLineId }]; resolves
// true to go ahead (nothing overlaps, or the user chose to schedule anyway),
// false only if the user backed out. A failed lookup never stands in the
// way of scheduling — it just can't warn.
async function confirmVisitorConflicts(checks) {
  const seen = new Set();
  const conflicts = [];
  for (const c of checks) {
    if (!c.date || (!c.assetId && !c.jobLineId)) continue;
    const qs = `date=${encodeURIComponent(c.date)}${c.assetId ? `&assetId=${c.assetId}` : `&jobLineId=${c.jobLineId}`}`;
    try {
      const { conflicts: found } = await api(`/api/pg/visitor-conflicts?${qs}`);
      for (const f of found) {
        const key = `${f.EventId}:${f.OccurrenceDate}`;
        if (!seen.has(key)) { seen.add(key); conflicts.push(f); }
      }
    } catch { /* can't check — don't block scheduling over it */ }
  }
  if (!conflicts.length) return true;
  const lines = conflicts.map((f) => {
    const span = f.OccurrenceEndDate && f.OccurrenceEndDate !== f.OccurrenceDate
      ? `${formatDateNice(f.OccurrenceDate)}–${formatDateNice(f.OccurrenceEndDate)}` : formatDateNice(f.OccurrenceDate);
    const time = f.StartTime ? ` ${formatTimeShort(f.StartTime)}${f.EndTime ? `–${formatTimeShort(f.EndTime)}` : ''}` : '';
    return `• ${f.VisitorName} at ${f.AssetName} — ${span}${time}${f.VisitPurpose ? ` (${f.VisitPurpose})` : ''}`;
  });
  return confirmDialog(
    `A visitor is scheduled at this building then:\n${lines.join('\n')}\n\nSchedule the job line anyway?`,
    { confirmLabel: 'Schedule anyway', cancelLabel: 'Go back', danger: false },
  );
}

async function onCalendarDrop(payload, zoneData) {
  try {
    if (zoneData.dropQueue !== undefined) {
      // Dropping a scheduled line back onto the Queue clears its date (and
      // any time) — it's fully unscheduled again, not "scheduled for
      // nothing." Only job lines can go here; the queue is job-line-only.
      if (payload.dragType !== 'jobLine') return;
      await api(`/api/pg/job-lines/${payload.id}`, { method: 'PATCH', body: JSON.stringify({ scheduledDate: null, scheduledStartTime: null }) });
      toast('Moved back to the Scheduling Queue');
    } else if (payload.dragType === 'jobLine' || payload.dragType === 'queue') {
      if (!await confirmVisitorConflicts([{ date: zoneData.dropDate, jobLineId: payload.id }])) return;
      const body = { scheduledDate: zoneData.dropDate };
      // A timed slot sets the time; the all-day band explicitly clears it
      // (making a previously-timed line untimed); a bare date-only drop
      // (Month view has no time-of-day concept) leaves whatever time it had.
      if (zoneData.dropHour !== undefined) body.scheduledStartTime = `${String(zoneData.dropHour).padStart(2, '0')}:00`;
      else if (zoneData.dropAllday !== undefined) body.scheduledStartTime = null;
      await api(`/api/pg/job-lines/${payload.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      toast('Job line rescheduled');
    } else if (payload.dragType === 'event') {
      const body = { eventDate: zoneData.dropDate };
      if (zoneData.dropHour !== undefined) {
        const newStart = `${String(zoneData.dropHour).padStart(2, '0')}:00`;
        body.startTime = newStart;
        body.endTime = (payload.startTime && payload.endTime)
          ? calTimeFromMinutes(calMinutesOfTime(newStart) + (calMinutesOfTime(payload.endTime) - calMinutesOfTime(payload.startTime)))
          : null;
      } else if (zoneData.dropAllday !== undefined) {
        body.startTime = null; body.endTime = null;
      }
      await api(`/api/pg/calendar-events/${payload.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      toast('Event rescheduled');
    }
  } catch (err) {
    toast(err.message || 'Could not reschedule');
  } finally {
    try { await calRefreshCurrentView?.(); } catch { /* view navigated away mid-drop — nothing to refresh */ }
  }
}

const PRIORITY_RANK = { Urgent: 0, High: 1, Medium: 2, Low: 3 };

async function renderCalendar(params = {}) {
  setChrome({ title: 'Calendar', showBack: false, showLogout: true });
  app.innerHTML = LOADING_HTML;
  if (!state.options) state.options = await api('/api/pg/options');

  let mode = getCalendarViewMode();
  let anchor = params.date ? new Date(`${params.date}T00:00:00`)
    : params.month != null ? new Date(Number(params.year), Number(params.month), 1)
    : new Date();
  const todayKey = isoDate(new Date());

  let dayEntriesMap = new Map();
  let allUnscheduled = [];
  let queueFilters = { statusId: '', assetId: '', locationId: '', fundKey: '' };
  let queueFilterInitialized = false;

  async function loadQueue() {
    const { jobLines } = await api('/api/pg/job-lines/unscheduled');
    allUnscheduled = jobLines;
    // Default the queue's status filter to "Assessed" the first time it
    // loads (Build Brief v4 Part 1 amendment) — assessed-but-unscheduled is
    // exactly the backlog this panel is for. Once the user picks something
    // else, that choice sticks for the rest of this visit to the page.
    if (!queueFilterInitialized) {
      queueFilterInitialized = true;
      const assessed = (state.options?.workOrderStatuses || []).find((s) => s.Name === 'Assessed');
      if (assessed) queueFilters.statusId = String(assessed.Id);
    }
  }

  function rangeForMode() {
    if (mode === 'month') {
      const y = anchor.getFullYear(), m = anchor.getMonth();
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      return { from: `${y}-${String(m + 1).padStart(2, '0')}-01`, to: `${y}-${String(m + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}` };
    }
    if (mode === 'week') {
      const start = weekStartOf(anchor);
      return { from: isoDate(start), to: isoDate(addDays(start, 6)) };
    }
    return { from: isoDate(anchor), to: isoDate(anchor) };
  }

  async function refreshAll() {
    const { from, to } = rangeForMode();
    const [entriesMap] = await Promise.all([loadCalendarRangeData(from, to), loadQueue()]);
    dayEntriesMap = entriesMap;
    draw();
  }
  calRefreshCurrentView = refreshAll;

  function headerLabel() {
    if (mode === 'month') return anchor.toLocaleString('default', { month: 'long', year: 'numeric' });
    if (mode === 'week') {
      const start = weekStartOf(anchor), end = addDays(start, 6);
      const sameMonth = start.getMonth() === end.getMonth();
      const startLabel = start.toLocaleDateString('default', { month: 'short', day: 'numeric' });
      const endLabel = end.toLocaleDateString('default', sameMonth ? { day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
      return `${startLabel} – ${endLabel}`;
    }
    return anchor.toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
  function stepAnchor(dir) {
    if (mode === 'month') anchor = new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
    else if (mode === 'week') anchor = addDays(anchor, 7 * dir);
    else anchor = addDays(anchor, dir);
  }

  function fixedTitleAttr(draggable, msg) { return draggable ? '' : ` title="${msg}"`; }
  function entryHtmlMonth(e) {
    const draggable = calendarEntryIsDraggable(e);
    const fixedCls = draggable ? '' : ' cal-fixed';
    const dragAttr = draggable ? ' data-draggable="1"' : '';
    if (e.type === 'jobLine') return `<div class="cal-entry${fixedCls}" data-wo-id="${e.WorkOrderId}" data-jl-id="${e.JobLineId}"${dragAttr}${fixedTitleAttr(draggable, 'Fixed — a finished line can’t be rescheduled')}><span class="pill"${statusColorStyle(e.StatusColor)}>${calendarEntryText(e)}</span></div>`;
    if (e.type === 'revisit') return `<div class="cal-entry cal-fixed" ${e.WorkOrderId ? `data-wo-id="${e.WorkOrderId}"` : e.Asset ? `data-asset-id="${e.Asset.Id}"` : ''}${fixedTitleAttr(false, 'Fixed — a revisit date is a commitment, not an open slot')}><span class="pill pop">${calendarEntryText(e)}</span></div>`;
    const tip = calendarEntryTooltip(e);
    return `<div class="cal-entry${fixedCls}" data-event-id="${e.Id}"${dragAttr}${draggable ? ` data-start-time="${e.StartTime || ''}" data-end-time="${e.EndTime || ''}"` : ''}${tip ? ` title="${escapeHtml(tip)}"` : fixedTitleAttr(draggable, 'Fixed — a repeating or multi-day event isn’t draggable here')}><span class="pill pop">${calendarEntryText(e)}</span></div>`;
  }

  function drawMonth() {
    const y = anchor.getFullYear(), m = anchor.getMonth();
    const firstOfMonth = new Date(y, m, 1);
    const startWeekday = firstOfMonth.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push('<div class="cal-cell cal-empty"></div>');
    for (let d = 1; d <= daysInMonth; d++) {
      const dateKey = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const entries = dayEntriesMap.get(dateKey) || [];
      const shown = entries.slice(0, 3);
      const overflow = entries.length - shown.length;
      cells.push(`<div class="cal-cell ${dateKey === todayKey ? 'cal-today' : ''}" data-date="${dateKey}" data-drop-date="${dateKey}">
        <div class="cal-daynum">${d}</div>
        ${shown.map(entryHtmlMonth).join('')}
        ${overflow > 0 ? `<div class="muted" style="font-size:0.75rem">+${overflow} more</div>` : ''}
      </div>`);
    }
    return `<div class="cal-scroll"><div class="cal-grid">
      ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-head">${d}</div>`).join('')}
      ${cells.join('')}
    </div></div>`;
  }

  function entryChipHtml(e, detailed) {
    const draggable = calendarEntryIsDraggable(e);
    const cls = `cal-tg-entry${draggable ? '' : ' cal-fixed'}${detailed ? ' cal-tg-entry-detailed' : ''}`;
    const dragAttr = draggable ? ' data-draggable="1"' : '';
    const idAttr = e.type === 'jobLine' ? `data-wo-id="${e.WorkOrderId}" data-jl-id="${e.JobLineId}"`
      : e.type === 'revisit' ? (e.WorkOrderId ? `data-wo-id="${e.WorkOrderId}"` : e.Asset ? `data-asset-id="${e.Asset.Id}"` : '')
      : `data-event-id="${e.Id}"${draggable ? ` data-start-time="${e.StartTime || ''}" data-end-time="${e.EndTime || ''}"` : ''}`;
    const tip = calendarEntryTooltip(e);
    const titleAttr = tip ? ` title="${escapeHtml(tip)}"` : fixedTitleAttr(draggable, e.type === 'revisit' ? 'Fixed — a revisit date is a commitment, not an open slot' : e.type === 'jobLine' ? 'Fixed — a finished line can’t be rescheduled' : 'Fixed — a repeating or multi-day event isn’t draggable here');
    if (!detailed) return `<div class="${cls}" ${idAttr}${dragAttr}${titleAttr}>${calendarEntryText(e)}</div>`;
    const extra = e.type === 'jobLine'
      ? `${statusPillHtml(e.StatusName, e.StatusColor)}${e.Priority ? ` <span class="pill">${escapeHtml(e.Priority)}</span>` : ''}`
      : e.type === 'revisit' ? `<span class="pill warn">${escapeHtml(e.DeferredReason || 'Deferred')}</span>`
      : `${e.TypeName ? `<span class="pill">${escapeHtml(e.TypeName)}</span>` : ''}${e.VisitorName && e.CabinHolderId ? ' <span class="pill">Cabin holder</span>' : ''}`;
    // Day view has room for what Month/Week only show on hover.
    const visitDetail = e.type === 'event' && e.VisitorName && (e.VisitorContact || (e.Title && e.Title !== `Visit — ${e.VisitorName}`))
      ? `<div class="muted" style="font-size:0.8rem;margin-top:2px">${[e.Title && e.Title !== `Visit — ${e.VisitorName}` ? escapeHtml(e.Title) : null, e.VisitorContact ? `Contact: ${escapeHtml(e.VisitorContact)}` : null].filter(Boolean).join(' · ')}</div>`
      : '';
    return `<div class="${cls}" ${idAttr}${dragAttr}${titleAttr}>
      <div>${calendarEntryText(e)}</div>
      ${visitDetail}
      <div style="margin-top:4px">${extra}</div>
    </div>`;
  }

  function timeGridHtml(days, detailed) {
    const hours = [];
    for (let h = CAL_HOUR_START; h <= CAL_HOUR_END; h++) hours.push(h);
    let html = `<div class="cal-tg" style="grid-template-columns:56px repeat(${days.length}, minmax(${detailed ? 220 : 110}px, 1fr))">`;
    html += `<div class="cal-tg-corner"></div>`;
    for (const day of days) html += `<div class="cal-tg-daylabel ${day.key === todayKey ? 'cal-today' : ''}">${escapeHtml(day.label)}</div>`;
    html += `<div class="cal-tg-alldaylabel">All-day</div>`;
    for (const day of days) {
      const entries = (dayEntriesMap.get(day.key) || []).filter(calendarEntryIsAllDay);
      html += `<div class="cal-tg-allday" data-drop-date="${day.key}" data-drop-allday="1">${entries.map((e) => entryChipHtml(e, detailed)).join('')}</div>`;
    }
    for (const h of hours) {
      html += `<div class="cal-tg-hourlabel">${calHourLabel(h)}</div>`;
      for (const day of days) {
        const entries = (dayEntriesMap.get(day.key) || []).filter((e) => !calendarEntryIsAllDay(e) && calStartHour(e.type === 'jobLine' ? e.ScheduledStartTime : e.StartTime) === h);
        html += `<div class="cal-tg-hourcell" data-drop-date="${day.key}" data-drop-hour="${h}">${entries.map((e) => entryChipHtml(e, detailed)).join('')}</div>`;
      }
    }
    html += `</div>`;
    return html;
  }
  function drawWeek() {
    const start = weekStartOf(anchor);
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(start, i);
      return { key: isoDate(d), label: d.toLocaleDateString('default', { weekday: 'short', day: 'numeric' }) };
    });
    return `<div class="cal-scroll">${timeGridHtml(days, false)}</div>`;
  }
  function drawDay() {
    const days = [{ key: isoDate(anchor), label: anchor.toLocaleDateString('default', { weekday: 'short', day: 'numeric' }) }];
    return `<div class="cal-scroll">${timeGridHtml(days, true)}</div>`;
  }

  function distinctOptions(list, pick) {
    const seen = new Map();
    for (const item of list) {
      const v = pick(item);
      if (v && !seen.has(String(v.id))) seen.set(String(v.id), v.name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }
  function queueFilteredSorted() {
    return allUnscheduled
      .filter((jl) => !queueFilters.statusId || String(jl.WorkOrderStatusId) === queueFilters.statusId)
      .filter((jl) => !queueFilters.assetId || String(jl.Asset?.Id) === queueFilters.assetId)
      .filter((jl) => !queueFilters.locationId || String(jl.Location?.Id) === queueFilters.locationId)
      .filter((jl) => !queueFilters.fundKey || `${jl.FundingSource}:${jl.FundingRefId || ''}` === queueFilters.fundKey)
      .sort((a, b) => (PRIORITY_RANK[a.Priority] ?? 9) - (PRIORITY_RANK[b.Priority] ?? 9));
  }
  function queueHtml() {
    const items = queueFilteredSorted();
    const assetOptions = distinctOptions(allUnscheduled, (jl) => jl.Asset && { id: jl.Asset.Id, name: jl.Asset.Name });
    const locationOptions = distinctOptions(allUnscheduled, (jl) => jl.Location && { id: jl.Location.Id, name: jl.Location.Name });
    const fundOptions = distinctOptions(allUnscheduled, (jl) => ({ id: `${jl.FundingSource}:${jl.FundingRefId || ''}`, name: jl.FundingRefLabel || FUNDING_SOURCE_LABELS[jl.FundingSource] || jl.FundingSource }));
    return `
      <div class="card">
        <h3>Scheduling Queue${items.length ? ` (${items.length})` : ''}</h3>
        <p class="muted">Job lines not yet on the calendar — drag one onto a day (or a time slot in Week/Day view) to schedule it. Drag a scheduled line back here to unschedule it.</p>
        <div class="field-row"><label>Status</label>
          <select id="queueFilterStatus"><option value="">— any —</option>${(state.options?.workOrderStatuses || []).map((s) => `<option value="${s.Id}" ${queueFilters.statusId === String(s.Id) ? 'selected' : ''}>${escapeHtml(s.Name)}</option>`).join('')}</select>
        </div>
        <div class="field-row"><label>Asset</label>
          <select id="queueFilterAsset"><option value="">— any —</option>${assetOptions.map((o) => `<option value="${o.id}" ${queueFilters.assetId === String(o.id) ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}</select>
        </div>
        <div class="field-row"><label>Location</label>
          <select id="queueFilterLocation"><option value="">— any —</option>${locationOptions.map((o) => `<option value="${o.id}" ${queueFilters.locationId === String(o.id) ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}</select>
        </div>
        <div class="field-row"><label>Fund</label>
          <select id="queueFilterFund"><option value="">— any —</option>${fundOptions.map((o) => `<option value="${o.id}" ${queueFilters.fundKey === String(o.id) ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}</select>
        </div>
        <div id="schedQueueDropZone" class="cal-queue-drop" data-drop-queue="1">
          ${items.length ? items.map((jl) => `
            <div class="list-item cal-queue-item" data-jl-id="${jl.JobLineId}" data-wo-id="${jl.WorkOrderId}" data-draggable="1">
              <div style="flex:1;min-width:0">
                <div>${jl.Asset ? `${escapeHtml(jl.Asset.Name)}: ` : ''}${escapeHtml(jl.WorkOrderTitle)} — ${escapeHtml(jl.JobLineTitle)}</div>
                <div class="muted" style="font-size:0.78rem">${jl.EstimatedHours ? `${jl.EstimatedHours}h · ` : ''}${jl.EstimatedCost != null ? `$${jl.EstimatedCost.toLocaleString()} · ` : ''}${escapeHtml(jl.FundingRefLabel || FUNDING_SOURCE_LABELS[jl.FundingSource] || '')}</div>
              </div>
              ${statusPillHtml(jl.WorkOrderStatus, jl.WorkOrderStatusColor)}
            </div>`).join('') : '<p class="muted">Nothing waiting — everything filtered in is scheduled. 🎉</p>'}
        </div>
      </div>`;
  }

  function draw() {
    closeDayPanel();
    setApp(`
      ${params.fromWorkOrderId ? `
        <div class="btn-row" style="margin-bottom:10px">
          <button class="btn btn-secondary" id="backToWoBtn">← Back to Work Order${params.fromWorkOrderTitle ? `: ${escapeHtml(params.fromWorkOrderTitle)}` : ''}</button>
        </div>` : ''}
      <div class="cal-header">
        <button class="btn btn-secondary" id="prevBtn">‹ Prev</button>
        <h3>${escapeHtml(headerLabel())}</h3>
        <button class="btn btn-secondary" id="nextBtn">Next ›</button>
      </div>
      <div class="btn-row" style="justify-content:space-between;margin-bottom:12px">
        ${calendarViewToggleHtml(mode)}
        <button class="btn btn-primary" id="addEventBtn">+ Add Event</button>
      </div>
      <div class="cal-layout">
        <div class="cal-main">${mode === 'month' ? drawMonth() : mode === 'week' ? drawWeek() : drawDay()}</div>
        <div class="cal-sidebar">${queueHtml()}</div>
      </div>`);
    wire();
  }

  function wireQueueInteractions() {
    app.querySelectorAll('#schedQueueDropZone .cal-queue-item').forEach((el) => {
      calWireDraggable(el, () => ({ dragType: 'queue', id: el.dataset.jlId }));
      calWireClick(el, () => go('workOrderDetail', { id: el.dataset.woId }));
    });
  }
  function wireQueueFilters() {
    document.getElementById('queueFilterStatus')?.addEventListener('change', (e) => { queueFilters.statusId = e.target.value; redrawQueueOnly(); });
    document.getElementById('queueFilterAsset')?.addEventListener('change', (e) => { queueFilters.assetId = e.target.value; redrawQueueOnly(); });
    document.getElementById('queueFilterLocation')?.addEventListener('change', (e) => { queueFilters.locationId = e.target.value; redrawQueueOnly(); });
    document.getElementById('queueFilterFund')?.addEventListener('change', (e) => { queueFilters.fundKey = e.target.value; redrawQueueOnly(); });
  }
  function redrawQueueOnly() {
    const sidebar = app.querySelector('.cal-sidebar');
    if (!sidebar) return;
    sidebar.innerHTML = queueHtml();
    wireQueueInteractions();
    wireQueueFilters();
  }

  function wireCalendarEntries() {
    app.querySelectorAll('.cal-entry, .cal-tg-entry').forEach((el) => {
      const jlId = el.dataset.jlId, woId = el.dataset.woId, eventId = el.dataset.eventId, assetId = el.dataset.assetId;
      const clickTarget = eventId ? () => go('calendarEventDetail', { id: eventId })
        : woId ? () => go('workOrderDetail', { id: woId })
        : assetId ? () => go('assetDetail', { id: assetId })
        : null;
      if (clickTarget) calWireClick(el, (e) => { e.stopPropagation(); clickTarget(); });
      if (el.dataset.draggable === '1') {
        if (jlId) calWireDraggable(el, () => ({ dragType: 'jobLine', id: jlId }));
        else if (eventId) calWireDraggable(el, () => ({ dragType: 'event', id: eventId, startTime: el.dataset.startTime || null, endTime: el.dataset.endTime || null }));
      }
    });
  }

  function wire() {
    document.getElementById('backToWoBtn')?.addEventListener('click', () => go('workOrderDetail', { id: params.fromWorkOrderId }));
    document.getElementById('prevBtn').addEventListener('click', async () => { stepAnchor(-1); await refreshAll(); });
    document.getElementById('nextBtn').addEventListener('click', async () => { stepAnchor(1); await refreshAll(); });
    document.getElementById('addEventBtn').addEventListener('click', () => go('newCalendarEvent', {}));
    app.querySelectorAll('.cal-mode-btn').forEach((btn) => btn.addEventListener('click', async () => {
      mode = btn.dataset.mode;
      localStorage.setItem('campAuditCalendarView', mode);
      await refreshAll();
    }));
    // Month cells: clicking the background (not an entry) opens the day
    // panel; entries themselves navigate straight through (wired below).
    app.querySelectorAll('.cal-cell[data-date]').forEach((cell) => cell.addEventListener('click', (e) => {
      if (calDragSuppressClick) { calDragSuppressClick = false; return; }
      if (e.target.closest('.cal-entry')) return;
      openDayPanel(cell.dataset.date, dayEntriesMap.get(cell.dataset.date) || []);
    }));
    wireCalendarEntries();
    wireQueueInteractions();
    wireQueueFilters();
  }

  await refreshAll();
}

// Google Calendar's event colorId palette (Build Brief v4 Part 1) — a fixed,
// Google-documented set of 11 IDs (distinct from the larger calendar-level
// colorId space gcal.js uses when creating a calendar). This is a stable
// external platform constant, not app vocabulary, so unlike causes/statuses/
// roles it's fine to hardcode rather than make admin-editable — the thing
// that IS admin-editable is which of these 11 each calendar_event_type maps
// to (calendar_event_types.gcal_color_id).
const GOOGLE_EVENT_COLORS = {
  '1': { name: 'Lavender', hex: '#7986cb' }, '2': { name: 'Sage', hex: '#33b679' },
  '3': { name: 'Grape', hex: '#8e24aa' }, '4': { name: 'Flamingo', hex: '#e67c73' },
  '5': { name: 'Banana', hex: '#f6c026' }, '6': { name: 'Tangerine', hex: '#f5511d' },
  '7': { name: 'Peacock', hex: '#039be5' }, '8': { name: 'Graphite', hex: '#616161' },
  '9': { name: 'Blueberry', hex: '#3f51b5' }, '10': { name: 'Basil', hex: '#0b8043' },
  '11': { name: 'Tomato', hex: '#d60000' },
};
function googleColorDotHtml(colorId) {
  const c = GOOGLE_EVENT_COLORS[colorId];
  if (!c) return '';
  return `<span title="${escapeHtml(c.name)}" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${c.hex};margin-right:5px;vertical-align:middle"></span>`;
}

// Type + end date (multi-day) + start/end time — shared by New/Edit Calendar
// Event (Build Brief v4 Part 1). No blank option on Type: every event is
// always categorized (Decision 7 — "Other" is the seeded catch-all, same
// role as "Unknown" on causes, so nobody leaves it unset or guesses wrong).
function typeAndScheduleFieldsHtml(ev = {}, types = []) {
  return `
    <div class="field-row"><label>Type</label>
      <select name="typeId">
        ${types.map((t) => `<option value="${t.Id}" ${(ev.TypeId ?? types.find((x) => x.Name === 'Other')?.Id) === t.Id ? 'selected' : ''}>${escapeHtml(t.Name)}</option>`).join('')}
      </select>
    </div>
    <div class="field-row"><label>End Date (optional — for a multi-day event, e.g. a rental Friday–Sunday)</label>
      <input name="endDate" type="date" value="${(ev.EndDate || '').slice(0, 10)}" />
    </div>
    <div class="field-row">
      <label>Start / End Time (optional)</label>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <input name="startTime" type="time" value="${ev.StartTime ? ev.StartTime.slice(0, 5) : ''}" style="max-width:140px" />
        <input name="endTime" type="time" value="${ev.EndTime ? ev.EndTime.slice(0, 5) : ''}" style="max-width:140px" />
      </div>
      <p class="muted" style="font-size:0.8rem;margin-top:4px">Leave both blank for an all-day event.</p>
    </div>`;
}

// Visitor fields — shared by New/Edit Calendar Event. A visit is just a
// calendar event with a visitor on it (usually typed Constituent
// Visitation), so these sit on every event form rather than behind a
// separate "new visit" flow. Leaving Visitor Name blank means it's not a
// visit, whatever else is filled in.
function visitorFieldsHtml(ev = {}) {
  return `
    <h4 style="margin:16px 0 4px">Visitor (optional)</h4>
    <p class="muted" style="font-size:0.82rem;margin:0 0 8px">For someone coming to camp — who, which building, and why. Scheduling a job line on that building while they're here will warn you.</p>
    <div class="field-row"><label>Cabin Holder</label>
      <div class="asset-picker" id="visitHolderPicker"></div>
      <p class="muted" style="font-size:0.8rem;margin-top:4px">Pick from the roster to link this visit to a cabin holder — fills in name and cabin, both still editable. Leave blank for anyone else.</p>
      <div id="visitHolderAssetChoices" class="btn-row" style="margin-top:6px;flex-wrap:wrap" hidden></div>
    </div>
    <div class="field-row"><label>Visitor Name</label><input name="visitorName" value="${escapeHtml(ev.VisitorName || '')}" placeholder="Anyone — holder or not" /></div>
    <div class="field-row"><label>Building / Asset</label><div class="asset-picker" id="visitAssetPicker"></div></div>
    <div class="field-row"><label>Purpose</label><input name="visitPurpose" value="${escapeHtml(ev.VisitPurpose || '')}" placeholder="e.g. Moving belongings out of the missionary cottage" /></div>
    <div class="field-row"><label>Contact (optional)</label><input name="visitorContact" value="${escapeHtml(ev.VisitorContact || '')}" placeholder="Phone or email" /></div>`;
}
function wireVisitorFields(root, ev = {}, { isNew = false, types = [] } = {}) {
  const nameInput = root.querySelector('[name="visitorName"]');
  const titleInput = root.querySelector('[name="title"]');
  const typeSelect = root.querySelector('[name="typeId"]');
  const choicesEl = root.querySelector('#visitHolderAssetChoices');
  const visitationType = types.find((t) => t.Name === 'Constituent Visitation');
  let typeTouched = !isNew;
  typeSelect?.addEventListener('change', () => { typeTouched = true; });
  let autoTitle = null;

  // New events only: a visitor name is a strong enough signal to pre-pick
  // the Constituent Visitation type and a "Visit — Name" title, as long as
  // neither has been set by hand. An existing event is never rewritten.
  function applyVisitDefaults() {
    if (!isNew) return;
    const name = nameInput.value.trim();
    if (!name) return;
    if (!typeTouched && visitationType && typeSelect) typeSelect.value = String(visitationType.Id);
    if (titleInput && (!titleInput.value.trim() || titleInput.value === autoTitle)) {
      autoTitle = `Visit — ${name}`;
      titleInput.value = autoTitle;
    }
  }
  nameInput.addEventListener('input', applyVisitDefaults);

  let asset = ev.AssetId ? { Id: ev.AssetId, Name: ev.AssetName } : null;
  const assetPicker = mountAssetCombobox(root.querySelector('#visitAssetPicker'), { initialAsset: asset, onSelect: (a) => { asset = a; } });

  const holderPicker = mountCabinHolderCombobox(root.querySelector('#visitHolderPicker'), {
    initialHolder: ev.CabinHolderId ? { Id: ev.CabinHolderId, Name: ev.CabinHolderName || ev.VisitorName } : null,
    onSelect: (holder) => {
      choicesEl.hidden = true;
      choicesEl.innerHTML = '';
      // Unlinking leaves name/asset as they are — they may well still be
      // right, and clearing typed-in data on a mis-click would be worse.
      if (!holder) return;
      nameInput.value = holder.Name;
      const cabins = holder.LinkedAssets || [];
      if (cabins.length === 1) assetPicker.setSelected(cabins[0]);
      else if (cabins.length > 1) {
        choicesEl.innerHTML = `<span class="muted" style="font-size:0.82rem;align-self:center">${escapeHtml(holder.Name)} holds ${cabins.length} cabins — which one?</span>`
          + cabins.map((c) => `<button type="button" class="btn btn-secondary btn-small visit-cabin-choice" data-id="${c.Id}" data-name="${escapeHtml(c.Name)}">${escapeHtml(c.Name)}</button>`).join('');
        choicesEl.hidden = false;
        choicesEl.querySelectorAll('.visit-cabin-choice').forEach((btn) => btn.addEventListener('click', () => {
          assetPicker.setSelected({ Id: Number(btn.dataset.id), Name: btn.dataset.name });
          choicesEl.hidden = true;
        }));
      }
      applyVisitDefaults();
    },
  });

  return {
    values: () => ({
      visitorName: nameInput.value.trim(),
      cabinHolderId: holderPicker.getSelected()?.Id || '',
      assetId: asset?.Id || '',
      visitPurpose: root.querySelector('[name="visitPurpose"]').value.trim(),
      visitorContact: root.querySelector('[name="visitorContact"]').value.trim(),
    }),
  };
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

// Link-to-Work-Order(-Job-Line) fields shared by New/Edit Calendar Event.
// Picking a Work Order auto-fills Title/Description from it and reveals a Job
// Line dropdown scoped to that WO's lines; picking a line narrows Title
// further to the line's own text and fills the date from the line's own
// scheduled_date (a WO has no single date of its own since Phase 1 — see
// 1.2/1.4). This only fires on user-driven changes — initial render for an
// existing event never overwrites its saved fields.
function calendarLinkFieldsHtml({ workOrders, workOrderTemplates = [], initialJobLines = [], ev = {} }) {
  const hasWo = !!ev.WorkOrderId;
  return `
    <div class="field-row"><label>Link to Work Order (optional)</label>
      <select name="workOrderId" id="linkWorkOrderId">
        <option value="">— none —</option>
        ${workOrders.map((w) => `<option value="${w.Id}" ${ev.WorkOrderId === w.Id ? 'selected' : ''}>${escapeHtml(w.Title)}${w.Asset ? ` — ${escapeHtml(w.Asset.Name)}` : ''}</option>`).join('')}
      </select>
    </div>
    <div class="field-row" id="linkTaskRow" ${hasWo ? '' : 'hidden'}>
      <label>Link to Job Line (optional)</label>
      <select name="jobLineId" id="linkTaskId">
        <option value="">— whole work order —</option>
        ${initialJobLines.map((l) => `<option value="${l.Id}" ${ev.JobLineId === l.Id ? 'selected' : ''}>${escapeHtml(l.Title)}${l.Done ? ' (done)' : ''}</option>`).join('')}
      </select>
    </div>
    <div class="field-row"><label>Auto-generate from PM Template (optional)</label>
      <select name="workOrderTemplateId" id="linkWoTemplateId">
        <option value="">— none —</option>
        ${workOrderTemplates.map((t) => `<option value="${t.Id}" ${ev.WorkOrderTemplateId === t.Id ? 'selected' : ''}>${escapeHtml(t.Name)}</option>`).join('')}
      </select>
      <p class="muted" style="font-size:0.82rem;margin:4px 0 0">Each due occurrence auto-generates a real Work Order from this template — use this instead of "Link to Work Order" for recurring PM (set Repeats above too).</p>
    </div>`;
}
function wireCalendarLinkFields(root) {
  const woSelect = root.querySelector('#linkWorkOrderId');
  const taskRow = root.querySelector('#linkTaskRow');
  const taskSelect = root.querySelector('#linkTaskId');
  const tplSelect = root.querySelector('#linkWoTemplateId');
  const titleInput = root.querySelector('[name="title"]');
  const descInput = root.querySelector('[name="description"]');
  const dateInput = root.querySelector('[name="eventDate"]');
  let currentJobLines = [];

  woSelect.addEventListener('change', async () => {
    const woId = woSelect.value;
    taskSelect.innerHTML = '<option value="">— whole work order —</option>';
    currentJobLines = [];
    if (!woId) { taskRow.hidden = true; return; }
    taskRow.hidden = false;
    tplSelect.value = '';
    const { workOrder, jobLines } = await api(`/api/pg/work-orders/${woId}`);
    currentJobLines = jobLines;
    taskSelect.innerHTML += jobLines.map((l) => `<option value="${l.Id}">${escapeHtml(l.Title)}${l.Done ? ' (done)' : ''}</option>`).join('');
    titleInput.value = workOrder.Title;
    descInput.value = workOrder.Description || '';
  });

  taskSelect.addEventListener('change', () => {
    const jobLineId = taskSelect.value;
    if (!jobLineId) return;
    const jobLine = currentJobLines.find((l) => String(l.Id) === jobLineId);
    const woLabel = woSelect.selectedOptions[0]?.textContent || '';
    if (jobLine) {
      titleInput.value = jobLine.Title;
      descInput.value = `Job line from Work Order: ${woLabel}`;
      if (jobLine.ScheduledDate) dateInput.value = jobLine.ScheduledDate.slice(0, 10);
    }
  });

  tplSelect.addEventListener('change', () => {
    if (!tplSelect.value) return;
    woSelect.value = '';
    taskRow.hidden = true;
    taskSelect.innerHTML = '<option value="">— whole work order —</option>';
  });
}

async function renderNewCalendarEvent(params = {}) {
  setChrome({ title: 'New Calendar Event', showBack: true, showLogout: true });
  const [{ workOrders }, { templates: workOrderTemplates }, { types }] = await Promise.all([
    api('/api/pg/work-orders'), api('/api/pg/work-order-templates'), api('/api/pg/calendar-event-types'),
  ]);
  setApp(`
    <div class="card">
      <h3>New Calendar Event</h3>
      <form id="newEventForm">
        <div class="field-row"><label>Title</label><input name="title" required /></div>
        <div class="field-row"><label>Date</label><input name="eventDate" type="date" value="${params.date || ''}" required /></div>
        <div class="field-row"><label>Description</label><textarea name="description"></textarea></div>
        ${typeAndScheduleFieldsHtml({}, types)}
        ${visitorFieldsHtml()}
        ${recurrenceFieldsHtml()}
        ${calendarLinkFieldsHtml({ workOrders, workOrderTemplates })}
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Create Event</button>
          <button class="btn btn-secondary" type="button" id="cancelEventBtn">Cancel</button>
        </div>
      </form>
    </div>`);
  wireRecurrenceToggle(document.getElementById('newEventForm'));
  wireCalendarLinkFields(document.getElementById('newEventForm'));
  const visitorFields = wireVisitorFields(document.getElementById('newEventForm'), {}, { isNew: true, types });
  document.getElementById('cancelEventBtn').addEventListener('click', goBack);
  document.getElementById('newEventForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const visitor = visitorFields.values();
    if (!visitor.visitorName && (visitor.cabinHolderId || visitor.visitPurpose || visitor.visitorContact)) {
      toast('Add a visitor name — the rest of the visitor fields only mean something with one');
      return;
    }
    try {
      const { event } = await api('/api/pg/calendar-events', { method: 'POST', body: JSON.stringify({
        title: fd.get('title'), eventDate: fd.get('eventDate'), description: fd.get('description'),
        typeId: fd.get('typeId'), endDate: fd.get('endDate') || undefined,
        startTime: fd.get('startTime') || undefined, endTime: fd.get('endTime') || undefined,
        recurrenceType: fd.get('recurrenceType'), recurrenceInterval: Number(fd.get('recurrenceInterval')) || 1,
        recurrenceEndDate: fd.get('recurrenceEndDate') || undefined,
        workOrderId: fd.get('workOrderId') || undefined,
        jobLineId: fd.get('jobLineId') || undefined,
        workOrderTemplateId: fd.get('workOrderTemplateId') || undefined,
        ...visitor,
      }) });
      toast('Event created');
      go('calendarEventDetail', { id: event.Id }, { replace: true });
    } catch (err) { toast(err.message); }
  });
}

async function renderCalendarEventDetail({ id }) {
  setChrome({ title: 'Calendar Event', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const [detail, workOrdersRes, tplRes, woTplRes, typesRes] = await Promise.all([
    api(`/api/pg/calendar-events/${id}`), api('/api/pg/work-orders'), api('/api/pg/checklist-templates'), api('/api/pg/work-order-templates'), api('/api/pg/calendar-event-types'),
  ]);
  const { event: ev, checklist } = detail;
  const { workOrders } = workOrdersRes;
  const checklistTemplates = tplRes.templates;
  const workOrderTemplates = woTplRes.templates;
  const { types } = typesRes;
  const initialJobLines = ev.WorkOrderId ? (await api(`/api/pg/work-orders/${ev.WorkOrderId}`)).jobLines : [];

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
        ${typeAndScheduleFieldsHtml(ev, types)}
        ${visitorFieldsHtml(ev)}
        ${recurrenceFieldsHtml(ev)}
        ${calendarLinkFieldsHtml({ workOrders, workOrderTemplates, initialJobLines, ev })}
        <button class="btn btn-secondary" type="submit">Save Changes</button>
      </form>
      ${ev.WorkOrderId ? `<div class="btn-row"><button class="btn btn-secondary" id="viewWoBtn">View Linked Work Order</button></div>` : ''}
      ${ev.AssetId ? `<div class="btn-row"><button class="btn btn-secondary" id="viewEventAssetBtn">View ${escapeHtml(ev.AssetName)}</button></div>` : ''}
      ${ev.JobLineTitle ? `<p class="muted">Linked to job line: "${escapeHtml(ev.JobLineTitle)}"</p>` : ''}
      <div class="btn-row"><button class="btn btn-secondary" id="deleteEventBtn">Delete Event</button></div>
    </div>
    ${checklistHtml}`);

  wireRecurrenceToggle(document.getElementById('eventForm'));
  wireCalendarLinkFields(document.getElementById('eventForm'));
  const visitorFields = wireVisitorFields(document.getElementById('eventForm'), ev, { types });

  document.getElementById('viewWoBtn')?.addEventListener('click', () => go('workOrderDetail', { id: ev.WorkOrderId }));
  document.getElementById('viewEventAssetBtn')?.addEventListener('click', () => go('assetDetail', { id: ev.AssetId }));
  document.getElementById('eventForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const visitor = visitorFields.values();
    if (!visitor.visitorName && (visitor.cabinHolderId || visitor.visitPurpose || visitor.visitorContact)) {
      toast('Add a visitor name — the rest of the visitor fields only mean something with one');
      return;
    }
    if (!await confirmDialog('Save changes to this event?')) return;
    const fd = new FormData(e.target);
    try {
      await api(`/api/pg/calendar-events/${id}`, { method: 'PATCH', body: JSON.stringify({
        title: fd.get('title'), eventDate: fd.get('eventDate'), description: fd.get('description'),
        typeId: fd.get('typeId'), endDate: fd.get('endDate') || '',
        startTime: fd.get('startTime') || '', endTime: fd.get('endTime') || '',
        recurrenceType: fd.get('recurrenceType'), recurrenceInterval: Number(fd.get('recurrenceInterval')) || 1,
        recurrenceEndDate: fd.get('recurrenceEndDate') || '', workOrderId: fd.get('workOrderId') || '',
        jobLineId: fd.get('jobLineId') || '', workOrderTemplateId: fd.get('workOrderTemplateId') || '',
        ...visitor,
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
      <div class="field-row" style="margin:8px 0 0"><label style="font-size:0.82rem">Section (optional — groups steps on the work order)</label>
        <input class="step-section" list="checklistSections" value="${escapeHtml(typeof step === 'string' ? '' : (step.Section || ''))}" placeholder="Tools &amp; Materials" />
      </div>
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
        <datalist id="checklistSections">
          <option value="Tools &amp; Materials"></option>
          ${[...new Set((t?.Steps || []).map((x) => x.Section).filter(Boolean))].map((sec) => `<option value="${escapeHtml(sec)}"></option>`).join('')}
        </datalist>
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
          section: row.querySelector('.step-section')?.value.trim() || null,
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
  if (w.StatusIsTerminal) return false;
  const sd = w['Scheduled Date'] ? w['Scheduled Date'].slice(0, 10) : null;
  const todayStr = isoDate(new Date());
  if (key === 'unscheduled') return !sd;
  if (!sd) return false;
  if (key === 'pastDue') return sd < todayStr;
  if (key === 'dueToday') return sd === todayStr;
  if (key === 'dueFuture') return sd > todayStr;
  return true;
}

// Segmented progress bar (2.6) — one segment per job-line status present,
// sized by the admin's chosen weighting (cost-weighted by default: finishing
// two of three lines while the roof — most of the money — sits untouched
// should not read as "mostly done"). Falls back to line-count share when
// nothing has a cost yet, so a freshly-scoped WO doesn't render an empty bar.
function woProgressBarHtml(w) {
  if (!w.LineCount || !w.StatusBreakdown?.length) return '';
  const weighting = state.options?.displaySettings?.WoProgressWeighting || 'cost';
  const totalCost = w.StatusBreakdown.reduce((s, x) => s + Number(x.cost || 0), 0);
  const segments = w.StatusBreakdown.map((s) => {
    const share = (weighting === 'cost' && totalCost > 0)
      ? Number(s.cost || 0) / totalCost
      : Number(s.lineCount || 0) / w.LineCount;
    return `<div style="flex:${Math.max(share, 0.03)};background:${s.color}" title="${escapeHtml(s.name)}"></div>`;
  }).join('');
  const costPart = w['Estimated Cost'] ? `${moneyFmt(w['Actual Cost'] || 0)} of ${moneyFmt(w['Estimated Cost'])}` : null;
  const hoursPart = w['Estimated Hours'] ? `${w['Actual Hours'] || 0} of ${w['Estimated Hours']} hrs` : null;
  return `
    <div style="display:flex;height:6px;border-radius:3px;overflow:hidden;background:rgba(128,128,128,0.2);margin:4px 0">${segments}</div>
    <div class="muted" style="font-size:0.78rem">${w.TerminalLineCount}/${w.LineCount} lines${costPart ? ` · ${costPart}` : ''}${hoursPart ? ` · ${hoursPart}` : ''}</div>`;
}

async function renderWorkOrders(params = {}, container = app, { onOpenWorkOrder } = {}) {
  if (container === app) setChrome({ title: 'Work Orders', showBack: false, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const { workOrders } = await api('/api/pg/work-orders');
  let cols = getWoColumnPrefs();
  let statusFilter = params.status || null;
  let scheduleFilter = params.schedule || null;
  let selectedWoId = null;
  // Grid defaults to split roots only, one row per family, with a "+N
  // splits" chip; clicking it expands the children nested inline (§5.4
  // Display). A filter toggle shows every split flat when wanted.
  let showAllSplits = false;
  const expandedRoots = new Set();

  function buildDisplayList(list) {
    if (showAllSplits) return list.map((w) => ({ w, indent: w.SplitRootId !== w.Id, splitCount: 0 }));
    const byRoot = new Map();
    for (const w of list) {
      if (!byRoot.has(w.SplitRootId)) byRoot.set(w.SplitRootId, []);
      byRoot.get(w.SplitRootId).push(w);
    }
    const out = [];
    for (const members of byRoot.values()) {
      const root = members.find((m) => m.Id === m.SplitRootId) || [...members].sort((a, b) => a.Id - b.Id)[0];
      const children = members.filter((m) => m.Id !== root.Id).sort((a, b) => a.Id - b.Id);
      out.push({ w: root, indent: false, splitCount: children.length });
      if (expandedRoots.has(root.Id)) children.forEach((c) => out.push({ w: c, indent: true, splitCount: 0 }));
    }
    return out;
  }

  function draw() {
    const mode = onOpenWorkOrder ? 'cards' : getTableViewMode();
    const visibleWOs = workOrders.filter((w) =>
      (!statusFilter || w.Status === statusFilter) && (!scheduleFilter || matchesScheduleFilter(w, scheduleFilter)));
    const displayList = buildDisplayList(visibleWOs);
    const splitChipHtml = (item) => item.splitCount > 0
      ? ` <button type="button" class="split-expand-chip pill" data-id="${item.w.Id}" style="cursor:pointer;border:none">${expandedRoots.has(item.w.Id) ? '▾' : '▸'} +${item.splitCount} split${item.splitCount === 1 ? '' : 's'}</button>` : '';
    const cardRows = displayList.map(({ w, indent, splitCount }, idx) => {
      const days = daysSince(w['Date Reported']);
      const bits = [];
      if (cols.asset && w.Asset) bits.push(escapeHtml(w.Asset.Name));
      if (cols.priority) bits.push(escapeHtml(w.Priority || ''));
      if (cols.daysSinceCreated && days != null) bits.push(`${days}d old`);
      if (cols.scheduledDate && w['Scheduled Date']) bits.push(`Sched. ${formatDateNice(w['Scheduled Date'])}`);
      if (cols.dateCreated && w['Date Reported']) bits.push(`Created ${formatDateNice(w['Date Reported'])}`);
      if (cols.estHours && w['Estimated Hours'] != null) bits.push(`${w['Estimated Hours']}h est.`);
      if (cols.estCost && w['Estimated Cost'] != null) bits.push(`$${Number(w['Estimated Cost']).toLocaleString()} est.`);
      return `<div class="list-item ${onOpenWorkOrder && selectedWoId === w.Id ? 'cal-strip-selected' : ''}" style="flex-wrap:wrap${indent ? ';margin-left:20px;border-left:2px solid var(--border,#ccc)' : ''}" data-id="${w.Id}">
        <span>WO ${escapeHtml(w.WoNumber || w.Id)} — ${escapeHtml(w.Title)}${w.IsBlocked ? ' 🚧' : ''}${splitChipHtml({ w, splitCount })}${bits.length ? `<div class="muted" style="font-weight:400">${bits.join(' · ')}</div>` : ''}${woProgressBarHtml(w)}</span>
        ${cols.status ? statusPillHtml(w.Status, w.StatusColor) : ''}
      </div>`;
    }).join('') || `<p class="muted">${(statusFilter || scheduleFilter) ? 'Nothing matches this filter.' : 'No work orders yet — tap + New Work Order above to create one.'}</p>`;

    const tableRows = displayList.map(({ w, indent, splitCount }) => {
      const days = daysSince(w['Date Reported']);
      return `<tr class="clickable-row" data-id="${w.Id}">
        <td data-label="Title"${indent ? ' style="padding-left:24px"' : ''}>WO ${escapeHtml(w.WoNumber || w.Id)} — ${escapeHtml(w.Title)}${w.IsBlocked ? ' 🚧' : ''}${splitChipHtml({ w, splitCount })}${woProgressBarHtml(w)}</td>
        ${cols.asset ? `<td data-label="Asset">${escapeHtml(w.Asset?.Name || '—')}</td>` : ''}
        ${cols.status ? `<td data-label="Status">${statusPillHtml(w.Status, w.StatusColor)}</td>` : ''}
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
        <button class="btn btn-secondary" id="newWoFromTplBtn">+ From Template</button>
        <label style="display:flex;align-items:center;gap:6px;font-weight:400"><input type="checkbox" id="showAllSplitsToggle" ${showAllSplits ? 'checked' : ''} style="width:auto" /> Show all splits flat</label>
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
          <table class="report-table" data-card="1">
            <thead><tr><th>Title</th>${visibleCols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
            <tbody>${tableRows || `<tr><td colspan="${visibleCols.length + 1}" class="muted">${filterLabel ? 'Nothing matches this filter.' : 'No work orders yet — tap + New Work Order above to create one.'}</td></tr>`}</tbody>
          </table>
        </div>` : cardRows}
    `, container);

    container.querySelector('#newWoBtnTop').addEventListener('click', () => go('newWorkOrder', {}));
    // §8: templates are picked on the New Work Order screen, which is where
    // the grid lives — this is a shortcut into that picker, not a second flow.
    container.querySelector('#newWoFromTplBtn').addEventListener('click', async () => {
      const { templates } = await api('/api/pg/work-order-templates');
      if (!templates.length) { toast('No templates yet — save one from a work order first'); return; }
      const picked = await pickFromListDialog('New work order from template', templates.map((t) => ({
        value: t.Id, label: t.Name, sublabel: t.Description || (t.Lines?.length ? `${t.Lines.length} job lines` : ''),
      })));
      if (picked != null) go('newWorkOrder', { templateId: picked });
    });
    container.querySelector('#clearWoFilter')?.addEventListener('click', () => { statusFilter = null; scheduleFilter = null; draw(); });
    container.querySelector('#showAllSplitsToggle')?.addEventListener('change', (e) => { showAllSplits = e.target.checked; draw(); });
    container.querySelectorAll('.split-expand-chip').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(el.dataset.id);
      if (expandedRoots.has(id)) expandedRoots.delete(id); else expandedRoots.add(id);
      draw();
    }));
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
      </div>`).join('') || `<p class="muted">${statusFilter ? 'Nothing matches this filter.' : 'No requests yet — they\'ll show up here once someone submits the form at /request.'}</p>`;

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
      <div id="requestPhotosCard"></div>
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

  renderAttachmentSection('maintenance_request', id, container.querySelector('#requestPhotosCard'), { title: 'Photos', defaultRoleName: 'Evidence' });

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

const RESPONSIBILITY_CLASS_LABELS = { self: 'Self', volunteer: 'Volunteer', vendor: 'Vendor', cabin_holder: 'Cabin-Holder' };

// Job line creation flow (Build Brief v2, 1.7): each "+ Add job line" row
// captures title, responsibility class, funding source + ref, estimated
// hours/cost, and a scheduled date that defaults to the WO's own date.
// Which SPECIFIC volunteer/vendor does the work is deferred to the WO detail
// page after creation — same precedent this form already used for
// responsibleSelf/crew before Phase 1, and the same "capture must be
// zero-decision, classify later" principle the brief opens with.

// ---------- Searchable combobox (§9) ----------
// One component for every long list in the app — funding source / cabin
// holder (~300 entries), the asset picker (~340), vendors. Options are loaded
// once by the caller and filtered here, in the browser: no per-keystroke
// server round-trip, and a substring match ANYWHERE in the name, so "green"
// and "walt" both find "Greenawalt, Ben" (a prefix-only match finds neither
// when the roster is stored surname-first).
//
// options: [{ value, label, sublabel? }] — `value` is compared with String().
// Returns { getValue, setValue, setOptions, focus, input }.
// ── Materials on hand (Build Brief §10) ──────────────────────────────────
// The ONLY materials screen. Not an inventory system: no counts to reconcile, no
// reorder points, no locations. A list of what's left over and where each balance came
// from, because the balance is only trustworthy if you can see the movements behind it.
async function renderMaterialsOnHand() {
  setChrome({ title: 'Materials on hand', showBack: true, showLogout: true });
  let materials = [];
  let showAll = false;

  async function load() {
    const d = await api(`/api/pg/materials${showAll ? '' : '?onHand=true'}`);
    materials = d.materials || [];
  }

  function draw() {
    setApp(`
      <div class="card">
        <h3>Materials on hand</h3>
        <p class="muted">What's left over from finished jobs, at the price actually paid. Drawing from stock moves that cost onto the new job — it isn't counted as a saving, because the saving was already counted when it was bought.</p>
        <div class="btn-row">
          <button type="button" class="btn btn-secondary" id="matToggle">${showAll ? 'Only show what\'s in stock' : 'Show everything, including empty'}</button>
          <button type="button" class="btn btn-primary" id="matAdd">Add material</button>
        </div>
      </div>
      <div class="card">
        ${materials.length ? materials.map((m) => `
          <div class="list-item mat-row" data-id="${m.Id}" style="display:flex;justify-content:space-between;align-items:center;gap:10px;cursor:pointer">
            <div>
              <div><strong>${escapeHtml(m.Name)}</strong> <span class="muted">(${escapeHtml(m.Unit)})</span></div>
              <div class="muted" style="font-size:0.82rem">${m.LastUnitPrice != null ? `$${Number(m.LastUnitPrice).toFixed(2)} per ${escapeHtml(m.Unit)}` : 'no price recorded'}${m.LastMovedAt ? ` · last moved ${String(m.LastMovedAt).slice(0, 10)}` : ''}</div>
            </div>
            <div style="text-align:right">
              <div style="font-weight:700;font-size:1.05rem">${m.Balance}</div>
              <div class="muted" style="font-size:0.75rem">${escapeHtml(m.Unit)}</div>
            </div>
          </div>`).join('') : `<p class="muted">${showAll ? 'No materials yet.' : 'Nothing in stock right now.'}</p>`}
      </div>`);
    document.getElementById('matToggle').addEventListener('click', async () => { showAll = !showAll; await load(); draw(); });
    document.getElementById('matAdd').addEventListener('click', async () => {
      const name = await promptDialog('Material name', { placeholder: 'Drywall ½ 4×8' });
      if (!name || !name.trim()) return;
      const unit = await promptDialog(`Unit for "${name.trim()}"`, { placeholder: 'sheets', confirmLabel: 'Add' });
      if (!unit || !unit.trim()) return;
      try { await api('/api/pg/materials', { method: 'POST', body: JSON.stringify({ name, unit }) });
        toast('Material added'); await load(); draw();
      } catch (e) { toast(e.message, 5000); }
    });
    app.querySelectorAll('.mat-row').forEach((el) => el.addEventListener('click', () => openMaterialHistory(el.dataset.id, { onClose: async () => { await load(); draw(); } })));
  }

  await load();
  draw();
}

// Balance = sum of movements, so the history IS the explanation. Corrections show up
// here as their own rows rather than quietly changing a number.
async function openMaterialHistory(materialId, { onClose } = {}) {
  const d = await api(`/api/pg/materials/${materialId}`);
  const m = d.material;
  const KINDS = { wo_close: 'Left over at WO close', to_job: 'Used on a job', correction: 'Correction', tossed: 'Tossed / damaged' };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:560px;width:95%;max-height:86vh;overflow:auto">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0">${escapeHtml(m.Name)} <span class="muted" style="font-weight:400">(${escapeHtml(m.Unit)})</span></h3>
      <button type="button" class="btn btn-secondary modal-cancel">Done</button>
    </div>
    <p style="margin:10px 0"><strong style="font-size:1.2rem">${m.Balance}</strong> <span class="muted">${escapeHtml(m.Unit)} on hand</span></p>
    <div class="btn-row">
      <button type="button" class="btn btn-secondary" id="matCorrect">Correct the count</button>
      <button type="button" class="btn btn-secondary" id="matToss">Tossed / damaged</button>
    </div>
    <h4 style="margin:16px 0 6px">Movements</h4>
    ${(d.movements || []).length ? d.movements.map((mv) => `
      <div class="list-item">
        <div><strong>${mv.Quantity > 0 ? '+' : ''}${mv.Quantity}</strong> — ${escapeHtml(KINDS[mv.Kind] || mv.Kind)}</div>
        <div class="muted" style="font-size:0.82rem">${String(mv.CreatedAt).slice(0, 10)}${mv.WorkOrderTitle ? ` · ${escapeHtml(mv.WorkOrderTitle)}` : ''}${mv.JobLineTitle ? ` · ${escapeHtml(mv.JobLineTitle)}` : ''}${mv.Note ? ` · ${escapeHtml(mv.Note)}` : ''}</div>
      </div>`).join('') : '<p class="muted">No movements yet.</p>'}
  </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); if (onClose) onClose(); };
  overlay.querySelector('.modal-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  async function record(kind, quantity, note) {
    try {
      await api(`/api/pg/materials/${materialId}/movements`, {
        method: 'POST', body: JSON.stringify({ kind, quantity, note: note || null }),
      });
      toast('Recorded'); overlay.remove(); openMaterialHistory(materialId, { onClose });
    } catch (e) { toast(e.message, 5000); }
  }

  // Ask for the count, not the change. Nobody standing in a shed works out "that's
  // minus one" — they can see there are three. The system does the subtraction and
  // stores the difference, so the movement log still adds up to the balance.
  overlay.querySelector('#matCorrect').addEventListener('click', async () => {
    const countStr = await promptDialog(
      `${m.Name}: the system says ${m.Balance} ${m.Unit}. How many do you actually have?`,
      { value: String(m.Balance), placeholder: String(m.Balance), confirmLabel: 'Next' }
    );
    if (countStr === null || !countStr.trim()) return;
    const actual = Number(countStr);
    if (!Number.isFinite(actual) || actual < 0) return toast('Enter a count', 4000);
    const delta = Math.round((actual - Number(m.Balance)) * 100) / 100;
    if (delta === 0) return toast('That matches what was recorded — nothing to correct');
    const note = await promptDialog(
      `Recording ${delta > 0 ? '+' : ''}${delta} ${m.Unit} to make the balance ${actual}. Why? (optional)`,
      { confirmLabel: 'Record correction', multiline: true, placeholder: 'e.g. two sheets were damaged in storage' }
    );
    if (note === null) return;   // cancelled at the note step
    await record('correction', delta, note);
  });

  // Its own action, and still a quantity: "how many are unusable" is the thing being
  // counted, not a new total.
  overlay.querySelector('#matToss').addEventListener('click', async () => {
    const qtyStr = await promptDialog(`How many ${m.Unit} of ${m.Name} are unusable?`, { confirmLabel: 'Next' });
    if (qtyStr === null || !qtyStr.trim()) return;
    const quantity = Number(qtyStr);
    if (!Number.isFinite(quantity) || quantity <= 0) return toast('Enter a quantity', 4000);
    if (quantity > Number(m.Balance)) return toast(`Only ${m.Balance} ${m.Unit} on hand`, 4000);
    const note = await promptDialog('What happened? (optional)', { confirmLabel: 'Record', multiline: true });
    if (note === null) return;
    await record('tossed', quantity, note);
  });
}

// Prompt at work-order close (§10). Skipped entirely when the WO bought no tracked
// materials, so closing an ordinary job is unchanged. Blank means none — the fast path
// is closing without typing anything.
async function promptLeftoversOnClose(workOrderId) {
  let used = [];
  let recorded = [];
  try { const d = await api(`/api/pg/work-orders/${workOrderId}/materials-used`); used = d.materials || []; }
  catch { return true; }
  // What a previous close already banked. On a re-close the prompt starts from those
  // numbers and files the DIFFERENCE, so stock is adjusted rather than doubled (§1).
  try { const r = await api(`/api/pg/work-orders/${workOrderId}/recorded-leftovers`); recorded = r.leftovers || []; }
  catch { /* first close */ }
  const priorBy = new Map(recorded.map((r) => [r.MaterialId, r]));
  if (!used.length) return true;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-box" style="max-width:520px;width:95%">
      <h3 style="margin:0 0 4px">Any materials left over?</h3>
      <p class="muted" style="margin:0 0 12px">Leave blank for anything fully used. What you enter goes to stock at the price this job paid.</p>
      ${used.map((u) => {
        const prior = priorBy.get(u.MaterialId);
        return `<div class="field-row"><label>${escapeHtml(u.Name)} <span class="muted">(${escapeHtml(u.Unit)}${u.UnitPrice != null ? ` · $${u.UnitPrice.toFixed(2)} each` : ''})</span></label>
          <input type="number" step="0.01" min="0" class="leftover-qty" data-material="${u.MaterialId}" data-price="${u.UnitPrice ?? ''}" value="${prior ? prior.Recorded : ''}" placeholder="used ${u.QuantityUsed}" />
          ${prior ? `<p class="muted" style="margin-top:2px;font-size:0.8rem">${prior.Recorded} recorded at the last close — change this and the difference is logged as a correction.</p>` : ''}
        </div>`;
      }).join('')}
      <div class="btn-row" style="justify-content:flex-end;margin-top:14px">
        <button type="button" class="btn btn-secondary modal-skip">Nothing left over</button>
        <button type="button" class="btn btn-primary modal-ok">Save</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const finish = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('.modal-skip').addEventListener('click', () => finish(true));
    overlay.querySelector('.modal-ok').addEventListener('click', async () => {
      const leftovers = [...overlay.querySelectorAll('.leftover-qty')]
        .map((i) => ({ materialId: Number(i.dataset.material), quantity: Number(i.value), unitPrice: i.dataset.price === '' ? null : Number(i.dataset.price) }))
        .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0);
      try {
        if (recorded.length) {
          // Re-close: reconcile against what was already banked.
          const r = await api(`/api/pg/work-orders/${workOrderId}/leftovers/reconcile`, {
            method: 'POST', body: JSON.stringify({ leftovers }),
          });
          if (r.changes.length) toast(`${r.changes.length} leftover(s) adjusted`);
        } else if (leftovers.length) {
          const r = await api(`/api/pg/work-orders/${workOrderId}/leftovers`, { method: 'POST', body: JSON.stringify({ leftovers }) });
          toast(`${r.recorded} material(s) added to stock`);
        }
        finish(true);
      } catch (e) { toast(e.message, 5000); finish(false); }
    });
  });
}

// Point-of-use reminder (§10). Returns the quantity drawn from stock, or 0. Says
// nothing at all when there's no balance, which is why the endpoint answers with null
// rather than a zero.
async function remindMaterialOnHand(materialId, { jobLineId = null, workOrderId = null } = {}) {
  let onHand = null;
  try { const d = await api(`/api/pg/materials/${materialId}/on-hand`); onHand = d.onHand; } catch { return 0; }
  if (!onHand) return 0;
  const use = await confirmDialog(
    `You should have ${onHand.Balance} ${onHand.Unit} of ${onHand.Name} left. Use it on this job?`,
    { confirmLabel: 'Use from stock', cancelLabel: 'Not now', danger: false }
  );
  if (!use) return 0;
  const qtyStr = await promptDialog(`How many ${onHand.Unit}?`, { value: String(onHand.Balance), confirmLabel: 'Use' });
  if (qtyStr === null) return 0;
  const quantity = Number(qtyStr);
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  try {
    const r = await api(`/api/pg/materials/${materialId}/use-from-stock`, {
      method: 'POST', body: JSON.stringify({ quantity, jobLineId, workOrderId }),
    });
    toast(`Used ${r.QuantityUsed} ${onHand.Unit} from stock${r.Cost != null ? ` — $${r.Cost.toFixed(2)}` : ''}`);
    return r.QuantityUsed;
  } catch (e) { toast(e.message, 5000); return 0; }
}

// Split editor (Build Brief §9). Opened deliberately from an expense — the ordinary
// form still writes one destination behind the scenes, so the everyday path never sees
// any of this and stays exactly as fast as it was.
//
// Line items are OPTIONAL. An emailed receipt nobody itemized can still be split whole,
// by dollars; itemizing is extra detail, never a precondition.
async function openSplitEditor(expenseId, { onClose } = {}) {
  let data = null;
  let materials = [];
  let woOptions = [];
  let taskOptions = [];

  async function load() {
    data = await api(`/api/pg/expenses/${expenseId}/split`);
    const [m, wo, at] = await Promise.all([
      api('/api/pg/materials').catch(() => ({ materials: [] })),
      api('/api/pg/work-orders?limit=200').catch(() => ({ workOrders: [] })),
      api('/api/pg/admin-tasks').catch(() => ({ tasks: [] })),
    ]);
    materials = m.materials || [];
    woOptions = (wo.workOrders || wo.items || []).map((w) => ({ value: `work_order:${w.Id}`, label: `WO — ${w.Title}` }));
    taskOptions = (at.tasks || []).map((t) => ({ value: `admin_task:${t.Id}`, label: `Task — ${t.Title}` }));
  }

  const money = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  function destOptions() {
    const lines = [];
    for (const w of (data.jobLines || [])) lines.push({ value: `job_line:${w.Id}`, label: `Line — ${w.Title}` });
    return [...lines, ...woOptions, ...taskOptions,
      ...materials.map((m) => ({ value: `leftover:${m.Id}`, label: `Leftover stock — ${m.Name} (${m.Unit})` }))];
  }

  function draw(overlay) {
    const s = data.summary;
    const allocs = data.allocations || [];
    const lis = data.lineItems || [];
    overlay.querySelector('.split-body').innerHTML = `
      <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:12px">
        <div><div class="muted" style="font-size:0.75rem;text-transform:uppercase">Receipt total</div><div style="font-weight:700">${money(s.Total)}</div></div>
        <div><div class="muted" style="font-size:0.75rem;text-transform:uppercase">Allocated</div><div style="font-weight:700">${money(s.Allocated)}</div></div>
        <div><div class="muted" style="font-size:0.75rem;text-transform:uppercase">Still unassigned</div>
          <div style="font-weight:700;color:${s.Unallocated > 0.005 ? '#b4690e' : '#2e8b57'}">${money(s.Unallocated)}</div></div>
      </div>
      ${s.Unallocated > 0.005 ? `<p class="muted" style="margin:0 0 10px">The unassigned part still draws on this receipt's fund — splitting the rest doesn't have to happen now.</p>` : ''}

      <h4 style="margin:14px 0 6px">Where the money went</h4>
      ${allocs.length ? allocs.map((a) => `
        <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div>
            <div><strong>${escapeHtml(a.DestLabel || a.DestType)}</strong> — ${money(a.Amount)}${a.Quantity != null ? ` <span class="muted">(${a.Quantity})</span>` : ''}</div>
            <div class="muted" style="font-size:0.8rem">${escapeHtml(a.FundingSource || 'operating_budget')}${a.SavingsAmount ? ` · saved ${money(a.SavingsAmount)}` : ''}${a.LineItemId ? ' · from a line item' : ''}</div>
          </div>
          <button type="button" class="btn btn-secondary split-del-alloc" data-id="${a.Id}">Remove</button>
        </div>`).join('') : '<p class="muted">Nothing split yet.</p>'}

      <div class="card" style="margin-top:10px;background:#fbfbfe">
        <div class="field-row"><label>Add a destination</label><div id="splitDestPicker"></div></div>
        <div class="field-row"><label>Amount</label><input type="number" step="0.01" min="0" id="splitAmount" placeholder="${s.Unallocated > 0 ? s.Unallocated : ''}" /></div>
        <div class="field-row"><label>Quantity (optional)</label><input type="number" step="0.01" min="0" id="splitQty" /></div>
        <div class="btn-row"><button type="button" class="btn btn-primary" id="splitAddAlloc">Add split</button></div>
      </div>

      <h4 style="margin:18px 0 6px">Line items <span class="muted" style="font-weight:400;font-size:0.85rem">— optional detail</span></h4>
      ${lis.length ? lis.map((l) => `
        <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div><strong>${escapeHtml(l.Description)}</strong>${l.Quantity != null ? ` <span class="muted">— ${l.Quantity} ${escapeHtml(l.Unit || '')}</span>` : ''}${l.MaterialName ? ` <span class="muted">· ${escapeHtml(l.MaterialName)}</span>` : ''}
            ${l.PaidAmount != null ? `<div class="muted" style="font-size:0.8rem">${money(l.PaidAmount)}${l.RegularPrice != null ? ` (reg. ${money(l.RegularPrice)})` : ''}</div>` : ''}
          </div>
          <button type="button" class="btn btn-secondary split-del-li" data-id="${l.Id}">Remove</button>
        </div>`).join('') : '<p class="muted">None — the receipt can still be split whole, by dollars.</p>'}
      <div class="card" style="margin-top:10px;background:#fbfbfe">
        <div class="field-row"><label>Description</label><input type="text" id="liDesc" placeholder="Drywall ½ 4×8" /></div>
        <div class="field-row"><label>Material (optional)</label><div id="liMaterialPicker"></div></div>
        <div class="field-row"><label>Qty / unit</label>
          <div style="display:flex;gap:8px"><input type="number" step="0.01" id="liQty" style="flex:1" /><input type="text" id="liUnit" placeholder="sheets" style="flex:1" /></div>
        </div>
        <div class="field-row"><label>Paid / regular price</label>
          <div style="display:flex;gap:8px"><input type="number" step="0.01" id="liPaid" style="flex:1" /><input type="number" step="0.01" id="liReg" placeholder="without the deal" style="flex:1" /></div>
        </div>
        <div class="btn-row"><button type="button" class="btn btn-secondary" id="liAdd">Add line item</button></div>
      </div>`;

    let dest = null;
    mountCombobox(overlay.querySelector('#splitDestPicker'), {
      options: destOptions(), placeholder: 'Work order, job line, task, or leftover stock…',
      onSelect: (o) => { dest = o ? o.value : null; },
      onClear: () => { dest = null; },
    });
    let liMaterial = null;
    mountCombobox(overlay.querySelector('#liMaterialPicker'), {
      options: materials.map((m) => ({ value: m.Id, label: `${m.Name} (${m.Unit})` })),
      placeholder: 'Only if this is a tracked material…',
      onSelect: async (o) => {
        liMaterial = o ? o.value : null;
        // "You should have 4 sheets left" — says nothing when there's no balance.
        if (liMaterial) await remindMaterialOnHand(liMaterial, {});
      },
      onClear: () => { liMaterial = null; },
    });

    overlay.querySelector('#splitAddAlloc').addEventListener('click', async () => {
      if (!dest) return toast('Pick where this share went', 4000);
      const [destType, destId] = String(dest).split(':');
      const amount = Number(overlay.querySelector('#splitAmount').value || 0);
      if (!(amount > 0)) return toast('Enter an amount', 4000);
      try {
        const r = await api(`/api/pg/expenses/${expenseId}/allocations`, {
          method: 'POST',
          body: JSON.stringify({
            destType: destType === 'leftover' ? 'leftover' : destType,
            destId: destType === 'leftover' ? null : Number(destId),
            materialId: destType === 'leftover' ? Number(destId) : null,
            amount, quantity: overlay.querySelector('#splitQty').value || null,
          }),
        });
        data.allocations = r.allocations; data.summary = r.summary;
        draw(overlay);
      } catch (e) { toast(e.message, 5000); }
    });
    overlay.querySelectorAll('.split-del-alloc').forEach((b) => b.addEventListener('click', async () => {
      const r = await api(`/api/pg/expenses/${expenseId}/allocations/${b.dataset.id}`, { method: 'DELETE' });
      data.allocations = r.allocations; data.summary = r.summary; draw(overlay);
    }));
    overlay.querySelector('#liAdd').addEventListener('click', async () => {
      const description = overlay.querySelector('#liDesc').value.trim();
      if (!description) return toast('Describe the line item', 4000);
      try {
        const r = await api(`/api/pg/expenses/${expenseId}/line-items`, {
          method: 'POST',
          body: JSON.stringify({
            description, materialId: liMaterial,
            quantity: overlay.querySelector('#liQty').value || null,
            unit: overlay.querySelector('#liUnit').value || null,
            paidAmount: overlay.querySelector('#liPaid').value || null,
            regularPrice: overlay.querySelector('#liReg').value || null,
          }),
        });
        data.lineItems = r.lineItems; draw(overlay);
      } catch (e) { toast(e.message, 5000); }
    });
    overlay.querySelectorAll('.split-del-li').forEach((b) => b.addEventListener('click', async () => {
      const r = await api(`/api/pg/expenses/${expenseId}/line-items/${b.dataset.id}`, { method: 'DELETE' });
      data.lineItems = r.lineItems; data.allocations = r.allocations; data.summary = r.summary; draw(overlay);
    }));
  }

  await load();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:640px;width:95%;max-height:88vh;overflow:auto">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0">Split this receipt</h3>
      <button type="button" class="btn btn-secondary modal-cancel">Done</button>
    </div>
    <div class="split-body" style="margin-top:12px"></div>
  </div>`;
  document.body.appendChild(overlay);
  draw(overlay);
  const close = () => { overlay.remove(); if (onClose) onClose(); };
  overlay.querySelector('.modal-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

// Overdue strip (Build Brief §6). Sits at the top of the dashboard and says nothing at
// all when nothing is late — a permanent empty banner trains people to ignore the spot
// where the real warning will appear.
async function overdueStripHtml() {
  let d;
  try { d = await api('/api/pg/overdue'); } catch { return ''; }
  const items = [
    ...d.WorkOrders.map((w) => ({ label: `${w.Title} (${w.DaysOver}d)`, view: 'workOrderDetail', id: w.Id })),
    ...d.Rounds.map((r) => ({ label: `${r.Name} ${r.Percent}% done (${r.DaysOver}d)`, view: 'auditRound', id: r.Id })),
    ...d.DeferredRevisits.map((f) => ({ label: `Revisit: ${f.Title} (${f.DaysOver}d)`, view: null, id: f.Id })),
  ];
  if (!items.length) return '';
  return `
    <div class="card" style="background:#fff5f5;border-color:#f0c8c8">
      <div style="font-weight:700;margin-bottom:4px">⚠ Overdue</div>
      <div style="display:flex;flex-direction:column;gap:3px">
        ${items.slice(0, 8).map((i) => i.view
          ? `<a href="#" class="overdue-link" data-view="${i.view}" data-id="${i.id}" style="font-size:0.9rem">${escapeHtml(i.label)}</a>`
          : `<span style="font-size:0.9rem">${escapeHtml(i.label)}</span>`).join('')}
        ${items.length > 8 ? `<span class="muted" style="font-size:0.82rem">…and ${items.length - 8} more</span>` : ''}
      </div>
    </div>`;
}

function wireOverdueStrip(container = app) {
  container.querySelectorAll('.overdue-link').forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    go(el.dataset.view, { id: el.dataset.id });
  }));
}

// ── Audit data screen (Build Brief §8) ───────────────────────────────────
// Pick a question, see every building's answer, with counts and a CSV export. This is
// the screen that proves the answers aren't locked in a blob.
async function renderAuditData() {
  setChrome({ title: 'Audit Data', showBack: true, showLogout: true });
  const [{ forms }, { rounds }] = await Promise.all([api('/api/pg/audit-forms'), api('/api/pg/audit-rounds')]);
  let formId = forms[0]?.Id || null;
  let keys = [];
  let questionKey = '';
  let value = '';
  let roundId = '';
  let result = { Rows: [], Counts: [] };

  async function loadKeys() { keys = (await api(`/api/pg/audit-question-keys?formId=${formId || ''}`)).keys || []; }
  async function run() {
    const qs = new URLSearchParams();
    if (formId) qs.set('formId', formId);
    if (questionKey) qs.set('questionKey', questionKey);
    if (value) qs.set('value', value);
    if (roundId) qs.set('roundId', roundId);
    result = await api(`/api/pg/audit-data?${qs}`);
    draw();
  }

  function draw() {
    setApp(`
      ${reportsTabsHtml('auditData')}
      <div class="card">
        <h3>Audit Data</h3>
        <p class="muted">Every answer ever recorded, filterable. "All buildings where the roof is Poor" is a filter, not a support request.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="adForm" style="flex:1;min-width:150px">${forms.map((f) => `<option value="${f.Id}" ${String(formId) === String(f.Id) ? 'selected' : ''}>${escapeHtml(f.Name)}</option>`).join('')}</select>
          <select id="adKey" style="flex:1;min-width:170px"><option value="">Any question</option>${keys.map((k) => `<option value="${escapeHtml(k.QuestionKey)}" ${questionKey === k.QuestionKey ? 'selected' : ''}>${escapeHtml(k.Prompt)}</option>`).join('')}</select>
          <input type="text" id="adVal" placeholder="Answer, e.g. Poor" value="${escapeHtml(value)}" style="flex:1;min-width:130px" />
          <select id="adRound" style="flex:1;min-width:150px"><option value="">Any round</option>${rounds.map((r) => `<option value="${r.Id}" ${String(roundId) === String(r.Id) ? 'selected' : ''}>${escapeHtml(r.Name)}</option>`).join('')}</select>
        </div>
        <div class="btn-row" style="margin-top:10px">
          <button type="button" class="btn btn-primary" id="adRun">Show</button>
          <a class="btn btn-secondary" id="adCsv" href="#">Export CSV</a>
        </div>
      </div>
      ${result.Counts.length ? `<div class="card">
        <h3 style="font-size:1rem">Counts</h3>
        <div style="display:flex;flex-wrap:wrap;gap:14px">
          ${result.Counts.map((c) => `<div><strong>${escapeHtml(c.Value ?? '—')}</strong> <span class="muted">${c.Count}</span></div>`).join('')}
        </div>
      </div>` : ''}
      <div class="card">
        <h3 style="font-size:1rem">${result.Rows.length} row(s)</h3>
        ${result.Rows.length ? result.Rows.map((r) => `
          <div class="list-item" style="display:flex;justify-content:space-between;gap:10px">
            <div>
              <div><strong>${escapeHtml(r.AssetName)}</strong> <span class="muted">${escapeHtml(r.LocationName || '')}</span></div>
              <div class="muted" style="font-size:0.82rem">${escapeHtml(r.QuestionKey)} = ${escapeHtml(r.Value ?? '')}${r.Flagged ? ' ⚑' : ''}${r.Note ? ` · ${escapeHtml(r.Note)}` : ''}</div>
            </div>
            <div class="muted" style="font-size:0.8rem;text-align:right">${escapeHtml(r.RoundName)}${r.WorkOrderId ? `<br>WO ${r.WorkOrderId}` : ''}</div>
          </div>`).join('') : '<p class="muted">Nothing matches — or no audits have been completed yet.</p>'}
      </div>`);
    wireReportsTabs();
    document.getElementById('adForm').addEventListener('change', async (e) => { formId = e.target.value; questionKey = ''; await loadKeys(); run(); });
    document.getElementById('adKey').addEventListener('change', (e) => { questionKey = e.target.value; run(); });
    document.getElementById('adVal').addEventListener('change', (e) => { value = e.target.value; run(); });
    document.getElementById('adRound').addEventListener('change', (e) => { roundId = e.target.value; run(); });
    document.getElementById('adRun').addEventListener('click', run);
    const qs = new URLSearchParams({ format: 'csv' });
    if (formId) qs.set('formId', formId);
    if (questionKey) qs.set('questionKey', questionKey);
    if (value) qs.set('value', value);
    if (roundId) qs.set('roundId', roundId);
    document.getElementById('adCsv').href = `/api/pg/audit-data?${qs}`;
  }

  await loadKeys();
  await run();
}

// Round report (§8): completion, what got flagged, and the work it generated with total
// hours and cost — the budget-ask artifact.
async function renderAuditRoundReport({ id }) {
  setChrome({ title: 'Round Report', showBack: true, showLogout: true });
  const r = await api(`/api/pg/audit-rounds/${id}/report`);
  setApp(`
    <div class="card">
      <h3>${escapeHtml(r.Round.Name)}</h3>
      <div class="muted">${escapeHtml(r.Round.FormName)}</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:12px">
        <div><div class="muted" style="font-size:0.75rem;text-transform:uppercase">Complete</div><div style="font-size:1.1rem;font-weight:700">${r.Complete}/${r.Total} · ${r.Percent}%</div></div>
        <div><div class="muted" style="font-size:0.75rem;text-transform:uppercase">Buildings with work</div><div style="font-size:1.1rem;font-weight:700">${r.WithWorkOrder}</div></div>
        <div><div class="muted" style="font-size:0.75rem;text-transform:uppercase">Estimated hours</div><div style="font-size:1.1rem;font-weight:700">${r.TotalHours}</div></div>
        <div><div class="muted" style="font-size:0.75rem;text-transform:uppercase">Estimated cost</div><div style="font-size:1.1rem;font-weight:700">$${r.TotalCost.toLocaleString()}</div></div>
      </div>
    </div>
    <div class="card">
      <h3 style="font-size:1rem">What got flagged</h3>
      ${r.FlagsByQuestion.length ? r.FlagsByQuestion.map((f) => `
        <div class="list-item" style="display:flex;justify-content:space-between">
          <div>${escapeHtml(f.Prompt)} <span class="muted">— ${escapeHtml(f.Value ?? '')}</span></div>
          <div><strong>${f.Count}</strong></div>
        </div>`).join('') : '<p class="muted">Nothing flagged.</p>'}
    </div>
    <div class="card">
      <h3 style="font-size:1rem">Work orders generated (${r.WorkOrders.length})</h3>
      ${r.WorkOrders.length ? r.WorkOrders.map((w) => `
        <div class="list-item wo-row" data-id="${w.Id}" style="display:flex;justify-content:space-between;cursor:pointer">
          <div><strong>${escapeHtml(w.AssetName)}</strong> <span class="muted">WO ${w.Id}</span></div>
          <div class="muted">${w.Hours ? `${w.Hours}h · ` : ''}$${w.Cost.toLocaleString()}</div>
        </div>`).join('') : '<p class="muted">None yet.</p>'}
    </div>`);
  app.querySelectorAll('.wo-row').forEach((el) => el.addEventListener('click', () => go('workOrderDetail', { id: el.dataset.id })));
}

// ── Form builder (Build Brief §7) ────────────────────────────────────────
// Plain and functional — one author. Follow-ups render indented under the option that
// triggers them, so the tree IS the documentation and there's no separate logic screen.
async function renderAuditFormBuilder({ id }) {
  setChrome({ title: 'Audit Form', showBack: true, showLogout: true });
  let d = await api(`/api/pg/audit-forms/${id}/full`);

  const reload = async () => { d = await api(`/api/pg/audit-forms/${id}/full`); draw(); };
  const optById = () => {
    const m = new Map();
    for (const q of d.Questions) for (const o of q.Options) m.set(o.Id, { o, q });
    return m;
  };

  // A question gated on exactly one option renders under it. Anything with a more
  // complex condition stays at the top level with its rule spelled out, rather than
  // being drawn somewhere that implies a simpler rule than it has.
  function gateOf(q) {
    if (!q.ShowIf || !Array.isArray(q.ShowIf) || q.ShowIf.length !== 1) return null;
    const c = q.ShowIf[0];
    if (!c.option_ids || c.option_ids.length !== 1) return null;
    return Number(c.option_ids[0]);
  }

  function remedyHtml(o) {
    return o.Remedies.map((r) => `
      <div class="list-item" style="padding:5px 0 5px 12px;border-left:2px solid #e5e7f0">
        <div style="font-size:0.88rem">🔧 ${escapeHtml(r.TitleTemplate)}${r.IsFixture ? ' <span style="color:#b4690e">fixture</span>' : ''}</div>
        <div class="muted" style="font-size:0.78rem">${escapeHtml(r.Responsibility || 'self')} · ${escapeHtml(r.FundingSource || 'operating_budget')}${r.EstHours ? ` · ${r.EstHours}h` : ''}${r.EstCost ? ` · $${r.EstCost}` : ''}
          <a href="#" class="rm-edit" data-id="${r.Id}">edit</a> ·
          <a href="#" class="rm-del" data-id="${r.Id}">remove</a></div>
      </div>`).join('');
  }

  function optionHtml(o, followUps) {
    return `
      <div style="padding:4px 0 4px 10px;min-width:0">
        <label style="display:flex;align-items:center;gap:8px;font-size:0.9rem;flex-wrap:wrap">
          <span style="flex:1 1 140px;min-width:0;overflow-wrap:anywhere">${escapeHtml(o.Label)}${o.IsFixture ? ' <span style="color:#b4690e;font-size:0.78rem">fixture</span>' : ''}</span>
          <label class="muted" style="font-size:0.78rem"><input type="checkbox" class="o-flag" data-id="${o.Id}" ${o.Flag ? 'checked' : ''} /> problem</label>
          <label class="muted" style="font-size:0.78rem"><input type="checkbox" class="o-sev" data-id="${o.Id}" ${o.Severe ? 'checked' : ''} ${o.Flag ? '' : 'disabled'} /> severe</label>
          <a href="#" class="o-remedy muted" data-id="${o.Id}" style="font-size:0.78rem">+ fix</a>
          <a href="#" class="o-follow muted" data-id="${o.Id}" style="font-size:0.78rem">+ follow-up</a>
        </label>
        ${remedyHtml(o)}
        ${followUps.map((fq) => questionHtml(fq, true)).join('')}
      </div>`;
  }

  function questionHtml(q, nested = false) {
    const byOpt = new Map();
    for (const other of d.Questions) {
      const g = gateOf(other);
      if (g != null) { if (!byOpt.has(g)) byOpt.set(g, []); byOpt.get(g).push(other); }
    }
    return `
      <div class="list-item q-row" data-qid="${q.Id}" ${nested ? '' : 'draggable="true"'} style="min-width:0;${nested ? 'margin-left:10px;border-left:2px solid #eef0f6;padding-left:8px;' : ''}${q.Archived ? 'opacity:0.5;' : ''}">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;flex-wrap:wrap">
          <div style="flex:1 1 200px;min-width:0;overflow-wrap:anywhere"><strong>${escapeHtml(q.Prompt)}</strong>
            <span class="muted" style="font-size:0.78rem">${escapeHtml(q.QuestionKey)} · ${escapeHtml(q.Type)}${q.Required ? ' · required' : ''}${q.AnswerCount ? ` · ${q.AnswerCount} answer(s)` : ''}${q.Archived ? ' · archived' : ''}</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex:0 0 auto">
            ${nested ? '' : `<button type="button" class="btn btn-secondary q-up" data-id="${q.Id}" title="Move up" style="padding:2px 10px">↑</button>
            <button type="button" class="btn btn-secondary q-down" data-id="${q.Id}" title="Move down" style="padding:2px 10px">↓</button>`}
            <a href="#" class="q-edit" data-id="${q.Id}">edit</a> ·
            <a href="#" class="q-del" data-id="${q.Id}">${q.AnswerCount ? 'archive' : 'delete'}</a>
          </div>
        </div>
        ${q.MapsTo ? `<div class="muted" style="font-size:0.78rem">↳ writes to ${escapeHtml(q.MapsTo.kind === 'component' ? `component: ${q.MapsTo.component_type}` : `asset field: ${q.MapsTo.field}`)}</div>` : ''}
        ${q.ShowIf && !gateOf(q) ? `<div class="muted" style="font-size:0.78rem">↳ shown only when ${q.ShowIf.length} condition(s) are met</div>` : ''}
        ${q.Options.map((o) => optionHtml(o, byOpt.get(o.Id) || [])).join('')}
        ${q.Options.length ? `<a href="#" class="q-addopt muted" data-id="${q.Id}" style="font-size:0.8rem;margin-left:10px">+ answer</a>` : ''}
      </div>`;
  }

  function draw() {
    const nested = new Set();
    for (const q of d.Questions) { const g = gateOf(q); if (g != null) nested.add(q.Id); }
    const fixCount = d.Fixtures.Options.length + d.Fixtures.Remedies.length;
    setApp(`
      <div class="card">
        <h3>${escapeHtml(d.Form.Name)}</h3>
        <p class="muted">${escapeHtml(d.Form.Description || '')}</p>
      </div>
      ${fixCount ? `<div class="card" style="background:#fffdf5;border-color:#f0e6c8">
        <h3 style="font-size:0.95rem;margin:0 0 6px">⚠ ${fixCount} placeholder(s) still in this form</h3>
        <p class="muted" style="margin:0 0 8px">These flags and fixes were seeded so the chain could be tested. Review them before running a real round — editing one clears its mark.</p>
        <div class="muted" style="font-size:0.82rem">
          ${d.Fixtures.Options.slice(0, 6).map((o) => `${escapeHtml(o.Prompt)} → ${escapeHtml(o.Label)}`).join('<br>')}
          ${d.Fixtures.Options.length > 6 ? `<br>…and ${d.Fixtures.Options.length - 6} more` : ''}
          ${d.Fixtures.Remedies.length ? `<br><strong>Fixes:</strong> ${d.Fixtures.Remedies.map((r) => escapeHtml(r.Title)).join(', ')}` : ''}
        </div>
      </div>` : ''}
      ${d.Sections.map((sec) => `
        <div class="card">
          <h3 style="font-size:1rem">${escapeHtml(sec.Name)}</h3>
          <div class="q-list" data-sec="${sec.Id}">${d.Questions.filter((q) => q.SectionId === sec.Id && !nested.has(q.Id)).map((q) => questionHtml(q)).join('')}</div>
          ${d.Questions.some((q) => q.SectionId === sec.Id && !nested.has(q.Id)) ? '' : '<p class="muted">No questions yet.</p>'}
          <div class="btn-row" style="margin-top:8px"><button type="button" class="btn btn-secondary add-q" data-sec="${sec.Id}">+ Question</button></div>
        </div>`).join('')}
      <div class="card"><div class="btn-row"><button type="button" class="btn btn-secondary" id="addSec">+ Section</button></div></div>`);
    wire();
  }

  // Order is sent as the whole list, not "this one moved" — the server rewrites every
  // sort_index, so what's on screen and what's stored can't drift apart.
  async function saveOrder(sectionId) {
    const ids = [...app.querySelectorAll(`.q-list[data-sec="${sectionId}"] > .q-row`)].map((el) => Number(el.dataset.qid));
    // Nested follow-ups aren't in this list; they travel with their gate option.
    const all = d.Questions.filter((q) => q.SectionId !== sectionId).map((q) => q.Id);
    await api(`/api/pg/audit-forms/${d.Form.Id}/question-order`, {
      method: 'PUT', body: JSON.stringify({ questionIds: [...ids, ...all] }),
    });
    reload();
  }

  function move(qid, dir) {
    const q = d.Questions.find((x) => x.Id === Number(qid));
    const row = app.querySelector(`.q-row[data-qid="${qid}"]`);
    const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!sib || !sib.classList.contains('q-row')) return;
    if (dir < 0) row.parentNode.insertBefore(row, sib);
    else row.parentNode.insertBefore(sib, row);
    saveOrder(q.SectionId);
  }

  function wire() {
    app.querySelectorAll('.q-up').forEach((b) => b.addEventListener('click', () => move(b.dataset.id, -1)));
    app.querySelectorAll('.q-down').forEach((b) => b.addEventListener('click', () => move(b.dataset.id, 1)));

    // Drag is the desktop convenience; the arrows above are what make this usable on a
    // phone, where HTML5 drag events don't fire at all.
    let dragged = null;
    app.querySelectorAll('.q-row[draggable="true"]').forEach((row) => {
      row.addEventListener('dragstart', (e) => { dragged = row; row.style.opacity = '0.4'; e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragend', () => { row.style.opacity = ''; dragged = null; });
      row.addEventListener('dragover', (e) => {
        if (!dragged || dragged === row || dragged.parentNode !== row.parentNode) return;
        e.preventDefault();
        const box = row.getBoundingClientRect();
        const after = (e.clientY - box.top) > box.height / 2;
        row.parentNode.insertBefore(dragged, after ? row.nextSibling : row);
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const sec = row.closest('.q-list')?.dataset.sec;
        if (sec) saveOrder(Number(sec));
      });
    });

    app.querySelectorAll('.o-flag').forEach((cb) => cb.addEventListener('change', async () => {
      await api(`/api/pg/audit-options/${cb.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ flag: cb.checked, severe: cb.checked ? undefined : false }) });
      reload();
    }));
    app.querySelectorAll('.o-sev').forEach((cb) => cb.addEventListener('change', async () => {
      await api(`/api/pg/audit-options/${cb.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ severe: cb.checked }) });
      reload();
    }));
    app.querySelectorAll('.o-remedy').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault();
      const title = await promptDialog('What does this answer mean needs doing?', { placeholder: 'Repair roof — {asset}', confirmLabel: 'Next' });
      if (!title) return;
      const hours = await promptDialog('Estimated hours (optional)', { confirmLabel: 'Next' });
      const cost = await promptDialog('Estimated cost (optional)', { confirmLabel: 'Save' });
      await api(`/api/pg/audit-options/${el.dataset.id}/remedies`, {
        method: 'POST',
        body: JSON.stringify({ titleTemplate: title, estHours: hours ? Number(hours) : null, estCost: cost ? Number(cost) : null }),
      });
      toast('Fix added'); reload();
    }));
    app.querySelectorAll('.rm-edit').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault();
      const title = await promptDialog('Fix title ({asset} is replaced with the building)', { confirmLabel: 'Next' });
      if (title === null) return;
      const hours = await promptDialog('Estimated hours', { confirmLabel: 'Next' });
      const cost = await promptDialog('Estimated cost', { confirmLabel: 'Save' });
      await api(`/api/pg/audit-remedies/${el.dataset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ titleTemplate: title || undefined, estHours: hours ? Number(hours) : undefined, estCost: cost ? Number(cost) : undefined }),
      });
      toast('Saved'); reload();
    }));
    app.querySelectorAll('.rm-del').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!await confirmDialog('Remove this fix? Work orders already generated from it are untouched.')) return;
      await api(`/api/pg/audit-remedies/${el.dataset.id}`, { method: 'DELETE' });
      reload();
    }));
    app.querySelectorAll('.o-follow').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault();
      const prompt = await promptDialog('Follow-up question, asked only when this answer is given', { confirmLabel: 'Next' });
      if (!prompt) return;
      const opts = await promptDialog('Answers, comma separated (blank for free text)', { placeholder: 'Partial, Full', confirmLabel: 'Create' });
      if (opts === null) return;
      const options = opts.split(',').map((x) => x.trim()).filter(Boolean).map((label) => ({ label }));
      await api(`/api/pg/audit-options/${el.dataset.id}/follow-up`, {
        method: 'POST',
        body: JSON.stringify({ formId: d.Form.Id, prompt, type: options.length ? 'select' : 'text', options }),
      });
      toast('Follow-up added'); reload();
    }));
    app.querySelectorAll('.q-addopt').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault();
      const label = await promptDialog('New answer', { confirmLabel: 'Add' });
      if (!label) return;
      await api(`/api/pg/audit-questions/${el.dataset.id}/options`, { method: 'POST', body: JSON.stringify({ label }) });
      reload();
    }));
    app.querySelectorAll('.q-edit').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault();
      const q = d.Questions.find((x) => String(x.Id) === el.dataset.id);
      const prompt = await promptDialog('Question wording (the key stays the same, so history still joins up)', { value: q.Prompt, confirmLabel: 'Save' });
      if (prompt === null) return;
      await api(`/api/pg/audit-questions/${q.Id}`, { method: 'PATCH', body: JSON.stringify({ prompt }) });
      reload();
    }));
    app.querySelectorAll('.q-del').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault();
      const q = d.Questions.find((x) => String(x.Id) === el.dataset.id);
      const msg = q.AnswerCount
        ? `This question has ${q.AnswerCount} answer(s), so it will be archived rather than deleted — the history stays readable.`
        : 'Delete this question? Nothing has answered it.';
      if (!await confirmDialog(msg, { confirmLabel: q.AnswerCount ? 'Archive' : 'Delete', danger: true })) return;
      await api(`/api/pg/audit-questions/${q.Id}`, { method: 'DELETE' });
      reload();
    }));
    app.querySelectorAll('.add-q').forEach((b) => b.addEventListener('click', async () => {
      const prompt = await promptDialog('New question', { confirmLabel: 'Next' });
      if (!prompt) return;
      const opts = await promptDialog('Answers, comma separated (blank for free text)', { placeholder: 'Excellent, Good, Fair, Poor', confirmLabel: 'Create' });
      if (opts === null) return;
      const options = opts.split(',').map((x) => x.trim()).filter(Boolean).map((label) => ({ label }));
      await api(`/api/pg/audit-forms/${d.Form.Id}/questions`, {
        method: 'POST',
        body: JSON.stringify({ sectionId: Number(b.dataset.sec), prompt, type: options.length ? 'select' : 'text', options }),
      });
      reload();
    }));
    document.getElementById('addSec').addEventListener('click', async () => {
      const name = await promptDialog('New section', { confirmLabel: 'Add' });
      if (!name) return;
      await api(`/api/pg/audit-forms/${d.Form.Id}/sections`, {
        method: 'POST', body: JSON.stringify({ name, sortIndex: (d.Sections.length + 1) * 10 }),
      });
      reload();
    });
  }

  draw();
}

// ── The runner (Build Brief §3) ──────────────────────────────────────────
// Phone-first, one section per screen. Every answer saves on its own, so a dropped
// connection costs one field rather than a building — and anything that fails to send
// goes on a visible retry queue instead of being silently lost.
async function renderAuditRunner({ id }) {
  setChrome({ title: 'Audit', showBack: true, showLogout: true });
  let data = await api(`/api/pg/audit-instances/${id}`);
  let sectionIdx = 0;
  const answers = new Map();           // questionId -> answer
  for (const a of data.Answers) if (a.QuestionId) answers.set(a.QuestionId, a);

  // ---- retry queue -------------------------------------------------------
  // Writes that failed to send. Kept in memory and retried on a timer and on
  // reconnect; the count is always on screen, because a silent queue is the same as
  // losing the data as far as the person walking the building is concerned.
  const queue = [];
  let flushing = false;
  async function send(body) {
    try {
      await api(`/api/pg/audit-instances/${id}/answers`, { method: 'PUT', body: JSON.stringify(body) });
      return true;
    } catch {
      queue.push(body);
      drawQueue();
      return false;
    }
  }
  async function flush() {
    if (flushing || !queue.length) return;
    flushing = true;
    while (queue.length) {
      const body = queue[0];
      try {
        await api(`/api/pg/audit-instances/${id}/answers`, { method: 'PUT', body: JSON.stringify(body) });
        queue.shift();
      } catch { break; }      // still down; leave the rest queued
    }
    flushing = false;
    drawQueue();
  }
  setInterval(flush, 8000);
  window.addEventListener('online', flush);
  function drawQueue() {
    const el = document.getElementById('runnerQueue');
    if (el) el.innerHTML = queue.length
      ? `<span style="color:#b4690e">${queue.length} unsaved — retrying…</span>`
      : '<span class="muted">All saved</span>';
  }

  // ---- show_if -----------------------------------------------------------
  // A question renders only when every condition is met. Hiding one keeps its stored
  // answer but marks it inactive, so it's excluded from generation and required-checks
  // and comes back untouched if the gate re-opens (§3).
  function visible(q) {
    if (!q.ShowIf || !Array.isArray(q.ShowIf) || !q.ShowIf.length) return true;
    return q.ShowIf.every((cond) => {
      const a = answers.get(cond.question_id);
      if (!a || !a.OptionId) return false;
      return (cond.option_ids || []).map(Number).includes(Number(a.OptionId));
    });
  }

  const sectionQuestions = (secId) => data.Questions.filter((q) => q.SectionId === secId);

  function draw() {
    const sec = data.Sections[sectionIdx];
    const qs = sectionQuestions(sec.Id).filter(visible);
    const answeredCount = data.Questions.filter((q) => visible(q) && answers.get(q.Id)?.Value).length;
    const totalVisible = data.Questions.filter(visible).length;

    setApp(`
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
          <div><strong>${escapeHtml(data.Instance.AssetName)}</strong> <span class="muted">${escapeHtml(data.Instance.LocationName || '')}</span></div>
          <div id="runnerQueue" class="muted" style="font-size:0.82rem"></div>
        </div>
        <div class="muted" style="margin-top:4px">Section ${sectionIdx + 1}/${data.Sections.length} · ${escapeHtml(sec.Name)} · ${answeredCount}/${totalVisible} answered</div>
        <div style="height:6px;background:#eef0f6;border-radius:3px;margin-top:8px;overflow:hidden">
          <div style="height:100%;width:${totalVisible ? Math.round((answeredCount / totalVisible) * 100) : 0}%;background:#3b5bdb"></div>
        </div>
      </div>

      ${data.AssetNotes.length && sectionIdx === 0 ? `<div class="card" style="background:#fffdf5;border-color:#f0e6c8">
        <h3 style="font-size:0.95rem;margin:0 0 6px">Before you start</h3>
        ${data.AssetNotes.map((n) => `<div class="list-item" style="padding:6px 0"><div>${escapeHtml(n.Note)}</div><div class="muted" style="font-size:0.78rem">${n.Source === 'audit' ? 'from an audit' : 'note'} · ${String(n.CreatedAt).slice(0, 10)}</div></div>`).join('')}
      </div>` : ''}

      <div class="card">
        ${qs.length ? qs.map(questionHtml).join('') : '<p class="muted">Nothing to answer in this section for this building.</p>'}
      </div>

      <div class="card">
        ${(() => {
          // What's already been flagged in THIS section, so you can see it rather than
          // wondering whether the tap registered.
          const flags = data.Answers.filter((a) => a.Kind === 'adhoc_flag' && String(a.SectionId) === String(sec.Id));
          if (!flags.length) return '';
          return `<div style="margin-bottom:10px">
            ${flags.map((f) => `<div class="list-item" style="padding:6px 0">
              <div>⚑ ${escapeHtml(f.Value || '')}</div>
              ${f.Note ? `<div class="muted" style="font-size:0.82rem">${escapeHtml(f.Note)}</div>` : ''}
              ${f.Photos?.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">${f.Photos.map((ph) => `<img src="${escapeHtml(ph.ThumbUrl || ph.Url)}" alt="" style="width:52px;height:52px;object-fit:cover;border-radius:6px" />`).join('')}</div>` : ''}
            </div>`).join('')}
          </div>`;
        })()}
        <button type="button" class="btn btn-secondary" id="adhocBtn" style="width:100%">＋ Flag something else</button>
        <p class="muted" style="margin:8px 0 0;font-size:0.82rem">Anything the form didn't ask about. It becomes a finding, and a job line if you add a fix.</p>
      </div>

      <div class="card">
        <div class="btn-row">
          ${sectionIdx > 0 ? '<button type="button" class="btn btn-secondary" id="prevSec">Back</button>' : ''}
          ${sectionIdx < data.Sections.length - 1
            ? '<button type="button" class="btn btn-primary" id="nextSec">Next section</button>'
            : '<button type="button" class="btn btn-primary" id="finishBtn">Finish</button>'}
        </div>
      </div>`);
    drawQueue();
    wire();
  }

  function questionHtml(q) {
    const a = answers.get(q.Id);
    const val = a?.Value ?? '';
    let input;
    if (q.Options.length) {
      input = `<div style="display:flex;flex-wrap:wrap;gap:8px">${q.Options.map((o) => `
        <button type="button" class="btn ${String(a?.OptionId) === String(o.Id) ? 'btn-primary' : 'btn-secondary'} opt-btn"
                data-q="${q.Id}" data-o="${o.Id}" data-v="${escapeHtml(o.Value)}"
                style="flex:0 0 auto">${escapeHtml(o.Label)}${o.Flag ? ' ⚑' : ''}</button>`).join('')}</div>`;
    } else if (q.Type === 'number') {
      input = `<input type="number" class="q-val" data-q="${q.Id}" value="${escapeHtml(val)}" />`;
    } else {
      input = `<textarea class="q-val" data-q="${q.Id}" rows="2">${escapeHtml(val)}</textarea>`;
    }
    const flagged = a?.OptionId && q.Options.find((o) => String(o.Id) === String(a.OptionId))?.Flag;
    return `
      <div class="field-row" data-question="${q.Id}">
        <label>${escapeHtml(q.Prompt)}${q.Required ? ' *' : ''}</label>
        ${input}
        <div style="margin-top:6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <a href="#" class="q-note muted" data-q="${q.Id}" style="font-size:0.82rem">${a?.Note ? 'edit note' : '+ note'}</a>
          ${q.AllowsPhoto ? `<label class="muted" style="font-size:0.82rem;cursor:pointer">📷 photo
            <input type="file" class="q-photo" data-q="${q.Id}" accept="image/*" multiple style="display:none" />
          </label>` : ''}
          ${flagged ? '<span style="color:#b4690e;font-size:0.82rem">flagged — a finding will be raised</span>' : ''}
        </div>
        ${a?.Photos?.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
          ${a.Photos.map((ph) => `<img src="${escapeHtml(ph.ThumbUrl || ph.Url)}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:6px" />`).join('')}
        </div>` : ''}
        ${a?.Note ? `<div style="font-size:0.88rem;margin-top:4px">${escapeHtml(a.Note)} <span class="muted">(${escapeHtml(a.NoteDestination || 'audit_only')})</span></div>` : ''}
      </div>`;
  }

  async function saveAnswer(q, { value, optionId }) {
    const prev = answers.get(q.Id) || {};
    const next = { ...prev, QuestionId: q.Id, Value: value, OptionId: optionId ?? null };
    answers.set(q.Id, next);
    // Hidden questions keep their answer but go inactive (§3).
    const body = {
      questionId: q.Id, questionKey: q.QuestionKey, value, optionId: optionId ?? null,
      note: next.Note ?? null, noteDestination: next.NoteDestination ?? null, active: true,
    };
    draw();
    await send(body);
    // Anything the change just hid is marked inactive so generation skips it.
    for (const other of data.Questions) {
      if (!visible(other) && answers.get(other.Id)?.Value) {
        const oa = answers.get(other.Id);
        await send({ questionId: other.Id, questionKey: other.QuestionKey, value: oa.Value,
          optionId: oa.OptionId ?? null, note: oa.Note ?? null, noteDestination: oa.NoteDestination ?? null, active: false });
      }
    }
  }

  function wire() {
    app.querySelectorAll('.opt-btn').forEach((b) => b.addEventListener('click', () => {
      const q = data.Questions.find((x) => String(x.Id) === b.dataset.q);
      saveAnswer(q, { value: b.dataset.v, optionId: Number(b.dataset.o) });
    }));
    app.querySelectorAll('.q-val').forEach((i) => i.addEventListener('change', () => {
      const q = data.Questions.find((x) => String(x.Id) === i.dataset.q);
      saveAnswer(q, { value: i.value, optionId: null });
    }));
    app.querySelectorAll('.q-note').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault();
      const q = data.Questions.find((x) => String(x.Id) === el.dataset.q);
      const a = answers.get(q.Id) || {};
      const note = await promptDialog(`Note for "${q.Prompt}"`, { value: a.Note || '', multiline: true, confirmLabel: 'Next' });
      if (note === null) return;
      const dest = await chooseNoteDestination(a.NoteDestination);
      if (dest === null) return;
      answers.set(q.Id, { ...a, QuestionId: q.Id, Note: note, NoteDestination: dest });
      const cur = answers.get(q.Id);
      await send({ questionId: q.Id, questionKey: q.QuestionKey, value: cur.Value ?? null,
        optionId: cur.OptionId ?? null, note, noteDestination: dest, active: true });
      draw();
    }));
    app.querySelectorAll('.q-photo').forEach((inp) => inp.addEventListener('change', async () => {
      const files = [...inp.files];
      if (!files.length) return;
      const q = data.Questions.find((x) => String(x.Id) === inp.dataset.q);
      toast(`Uploading ${files.length} photo(s)…`);
      try {
        // The answer row has to exist before a photo can hang off it — a photo is often
        // taken before the question is answered.
        const { answerId } = await api(`/api/pg/audit-instances/${id}/ensure-answer`, {
          method: 'POST', body: JSON.stringify({ questionId: q.Id, questionKey: q.QuestionKey }),
        });
        for (const file of files) {
          const fd = new FormData();
          fd.append('file', file);
          fd.append('entityType', 'audit_answer');
          fd.append('entityId', String(answerId));
          const res = await fetch('/api/pg/attachments', { method: 'POST', body: fd });
          if (!res.ok) throw new Error('Upload failed');
        }
        data = await api(`/api/pg/audit-instances/${id}`);
        for (const a of data.Answers) if (a.QuestionId) answers.set(a.QuestionId, a);
        toast('Photo saved'); draw();
      } catch (e) { toast(e.message, 5000); }
    }));
    document.getElementById('prevSec')?.addEventListener('click', () => { sectionIdx -= 1; draw(); });
    document.getElementById('nextSec')?.addEventListener('click', () => { sectionIdx += 1; draw(); });
    document.getElementById('adhocBtn')?.addEventListener('click', () => openAdhocFlag(id, data.Sections[sectionIdx].Id, async () => {
      data = await api(`/api/pg/audit-instances/${id}`);
      draw();
    }));
    document.getElementById('finishBtn')?.addEventListener('click', async () => {
      const missing = data.Questions.filter((q) => q.Required && visible(q) && !answers.get(q.Id)?.Value);
      if (missing.length) {
        return toast(`${missing.length} required question(s) still unanswered: ${missing.map((m) => m.Prompt).join(', ')}`, 6000);
      }
      await flush();
      if (queue.length) {
        if (!await confirmDialog(`${queue.length} answer(s) still haven't saved. Review anyway?`,
          { confirmLabel: 'Review anyway', cancelLabel: 'Wait', danger: true })) return;
      }
      go('auditReview', { id });
    });
  }

  draw();
}

// Where a note should ALSO go. The original always stays on the audit answer — this
// adds a linked copy, it never moves the record (§4).
function chooseNoteDestination(current = 'audit_only') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-box">
      <p class="modal-message">Where should this note go? It always stays on the audit either way.</p>
      <div class="btn-row" style="flex-direction:column;gap:8px">
        <button type="button" class="btn ${current === 'audit_only' ? 'btn-primary' : 'btn-secondary'}" data-d="audit_only">Audit only</button>
        <button type="button" class="btn ${current === 'asset' ? 'btn-primary' : 'btn-secondary'}" data-d="asset">Also a note on this building</button>
        <button type="button" class="btn ${current === 'job' ? 'btn-primary' : 'btn-secondary'}" data-d="job">Also on the work this creates</button>
      </div>
      <div class="btn-row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn btn-secondary modal-cancel">Cancel</button></div>
    </div>`;
    document.body.appendChild(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => done(b.dataset.d)));
    overlay.querySelector('.modal-cancel').addEventListener('click', () => done(null));
  });
}

// "Flag something else" (Addendum §3) — one form, not a chain of prompts. A photo is
// the whole point here: you're describing something the form never anticipated, so the
// picture carries more than the words do. The fix fields are optional; filling in a
// title is what turns this into a job line.
async function openAdhocFlag(instanceId, sectionId, onDone) {
  let fundingOptions = [];
  try { fundingOptions = (await loadGridContext()).fundingOptions || []; } catch { /* funding is optional */ }
  const files = [];

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:520px;width:95%;max-height:88vh;overflow:auto">
    <h3 style="margin:0 0 4px">Flag something else</h3>
    <p class="muted" style="margin:0 0 12px">Anything the form didn't ask about. It becomes a finding either way; add a fix and it also becomes a job line.</p>

    <div class="field-row"><label>What did you find? *</label>
      <textarea id="afDesc" rows="3" placeholder="Gutter hanging off the back corner"></textarea>
    </div>

    <div class="field-row"><label>Photos</label>
      <label class="btn btn-secondary" style="cursor:pointer;display:inline-block">📷 Add photos
        <input type="file" id="afPhotos" accept="image/*" multiple style="display:none" />
      </label>
      <div id="afThumbs" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"></div>
    </div>

    <div class="field-row"><label>Note (optional)</label>
      <textarea id="afNote" rows="2" placeholder="Anything worth recording that isn't the fix itself"></textarea>
    </div>
    <div class="field-row"><label>Where should the note go?</label>
      <select id="afNoteDest">
        <option value="audit_only">Audit only</option>
        <option value="asset">Also a note on this building</option>
        <option value="job">Also on the work this creates</option>
      </select>
      <p class="muted" style="margin-top:2px;font-size:0.8rem">The note always stays on the audit; this adds a copy.</p>
    </div>

    <details style="margin:14px 0">
      <summary style="cursor:pointer;font-weight:700">Add a fix (optional)</summary>
      <p class="muted" style="margin:8px 0">Fill in a title and this becomes a job line on the building's work order.</p>
      <div class="field-row"><label>What needs doing?</label><input type="text" id="afTitle" placeholder="Rehang gutter" /></div>
      <div class="field-row"><label>Who does it?</label>
        <select id="afResp">
          <option value="self">Self</option>
          <option value="volunteer">Volunteer</option>
          <option value="vendor">Vendor</option>
          <option value="cabin_holder">Cabin holder</option>
        </select>
      </div>
      <div class="field-row"><label>Funding</label><div id="afFunding"></div></div>
      <div class="field-row"><label>Hours / cost</label>
        <div style="display:flex;gap:8px">
          <input type="number" step="any" min="0" id="afHours" placeholder="Hrs" style="flex:1" />
          <input type="number" step="0.01" min="0" id="afCost" placeholder="Cost" style="flex:1" />
        </div>
      </div>
    </details>

    <div class="btn-row" style="justify-content:flex-end">
      <button type="button" class="btn btn-secondary modal-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="afSave">Save flag</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-cancel').addEventListener('click', close);

  const fundingEl = overlay.querySelector('#afFunding');
  const fundingCbx = mountCombobox(fundingEl, {
    options: fundingOptions, placeholder: '— operating budget —', emptyText: 'No funding source matches',
  });

  // Files are held until the flag is saved, because a photo needs an answer row to
  // attach to and that row doesn't exist yet.
  function drawThumbs() {
    overlay.querySelector('#afThumbs').innerHTML = files.map((f, i) => `
      <div style="position:relative">
        <img src="${URL.createObjectURL(f)}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:6px" />
        <button type="button" class="af-rm" data-i="${i}" style="position:absolute;top:-6px;right:-6px;border:none;background:#c92a2a;color:#fff;border-radius:50%;width:20px;height:20px;cursor:pointer;line-height:1">×</button>
      </div>`).join('');
    overlay.querySelectorAll('.af-rm').forEach((b) => b.addEventListener('click', () => {
      files.splice(Number(b.dataset.i), 1); drawThumbs();
    }));
  }
  overlay.querySelector('#afPhotos').addEventListener('change', (e) => {
    files.push(...e.target.files); e.target.value = ''; drawThumbs();
  });

  overlay.querySelector('#afSave').addEventListener('click', async () => {
    const description = overlay.querySelector('#afDesc').value.trim();
    if (!description) return toast('Describe what you found', 4000);
    const title = overlay.querySelector('#afTitle').value.trim();
    const parsed = fundingCbx.getValue ? parseFundingOptionValue(fundingCbx.getValue()) : null;
    const remedy = title ? {
      title,
      responsibility: overlay.querySelector('#afResp').value || null,
      fundingSource: parsed ? parsed.source : null,
      fundingRefId: parsed ? parsed.refId : null,
      estHours: overlay.querySelector('#afHours').value ? Number(overlay.querySelector('#afHours').value) : null,
      estCost: overlay.querySelector('#afCost').value ? Number(overlay.querySelector('#afCost').value) : null,
    } : null;
    const note = overlay.querySelector('#afNote').value.trim() || null;

    try {
      const res = await api(`/api/pg/audit-instances/${instanceId}/adhoc-flags`, {
        method: 'POST',
        body: JSON.stringify({
          sectionId, description, note,
          noteDestination: note ? overlay.querySelector('#afNoteDest').value : null,
          remedy,
        }),
      });
      // The answer row exists now, so the photos have something to attach to.
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('entityType', 'audit_answer');
        fd.append('entityId', String(res.answerId));
        const r = await fetch('/api/pg/attachments', { method: 'POST', body: fd });
        if (!r.ok) throw new Error('A photo failed to upload — the flag was still saved');
      }
      close();
      toast(files.length ? `Flagged with ${files.length} photo(s)` : 'Flagged');
      if (onDone) onDone();
    } catch (e) { toast(e.message, 6000); if (onDone) onDone(); }
  });
}

// Review: every flagged answer with its chain, the lines it will generate, and — when
// the building ends with no work order — the job notes that would otherwise be dropped.
async function renderAuditReview({ id }) {
  setChrome({ title: 'Review', showBack: true, showLogout: true });
  const review = await api(`/api/pg/audit-instances/${id}/review`);
  const strandedChoices = {};
  setApp(`
    <div class="card">
      <h3>${escapeHtml(review.Instance.AssetName)}</h3>
      <div class="muted">${escapeHtml(review.Instance.RoundName)}</div>
    </div>
    ${review.Clean ? `<div class="card">
      <h3>No issues found</h3>
      <p class="muted">Nothing was flagged, so no work order is created. The completed audit is the record.</p>
    </div>` : `
    <div class="card">
      <h3>Flagged (${review.Flagged.length})</h3>
      ${review.Flagged.map((f) => `
        <div class="list-item">
          <div><strong>${escapeHtml(f.Chain)}</strong>${f.Severe ? ' <span style="color:#c92a2a">severe</span>' : ''}</div>
          ${f.Note ? `<div class="muted" style="font-size:0.85rem">${escapeHtml(f.Note)}</div>` : ''}
          ${f.Remedies.length ? '' : '<div class="muted" style="font-size:0.82rem">no fix chosen — the finding is still raised</div>'}
        </div>`).join('')}
    </div>
    <div class="card">
      <h3>Work order lines (${review.ProposedLines.length})</h3>
      <p class="muted">Estimates are copied as they are now — editing a remedy later never changes this work order.</p>
      ${review.ProposedLines.map((l, i) => `
        <div class="list-item" style="display:flex;align-items:flex-start;gap:10px">
          <input type="checkbox" class="line-inc" data-i="${i}" checked style="margin-top:3px" />
          <div>
            <div><strong>${escapeHtml(l.Title)}</strong>${l.IsFixture ? ' <span class="muted">(fixture values)</span>' : ''}</div>
            <div class="muted" style="font-size:0.82rem">${escapeHtml(l.Responsibility || 'self')} · ${escapeHtml(l.FundingSource || 'operating_budget')}${l.EstHours ? ` · ${l.EstHours}h` : ''}${l.EstCost ? ` · $${l.EstCost}` : ''}</div>
          </div>
        </div>`).join('')}
    </div>`}
    ${review.StrandedJobNotes.length ? `<div class="card" style="background:#fffdf5;border-color:#f0e6c8">
      <h3>These notes have nowhere to go</h3>
      <p class="muted">They were marked for the work, but this building isn't producing a work order.</p>
      ${review.StrandedJobNotes.map((n) => `
        <div class="list-item">
          <div>${escapeHtml(n.Note)}</div>
          <div class="btn-row" style="margin-top:6px">
            <button type="button" class="btn btn-secondary str" data-a="${n.AnswerId}" data-c="asset">Keep on the building</button>
            <button type="button" class="btn btn-secondary str" data-a="${n.AnswerId}" data-c="audit_only">Audit only</button>
          </div>
        </div>`).join('')}
    </div>` : ''}
    <div class="card">
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="completeBtn">${review.Clean ? 'Mark complete' : 'Create work order'}</button>
      </div>
    </div>`);

  app.querySelectorAll('.str').forEach((b) => b.addEventListener('click', () => {
    strandedChoices[b.dataset.a] = b.dataset.c;
    b.closest('.list-item').querySelectorAll('.str').forEach((x) => x.classList.remove('btn-primary'));
    b.classList.add('btn-primary');
  }));
  document.getElementById('completeBtn').addEventListener('click', async () => {
    const keep = [...app.querySelectorAll('.line-inc')].map((c, i) => (c.checked ? review.ProposedLines[i] : null)).filter(Boolean);
    try {
      const r = await api(`/api/pg/audit-instances/${id}/complete`, {
        method: 'POST', body: JSON.stringify({ lines: keep, strandedNoteChoices: strandedChoices }),
      });
      toast(r.WorkOrderId ? `Work order ${r.WorkOrderId} created` : 'Marked complete');
      go('auditRound', { id: review.Instance.RoundId }, { replace: true });
    } catch (e) { toast(e.message, 5000); }
  });
}

// ── Audit rounds (Build Brief §5) ────────────────────────────────────────
async function renderAuditRounds() {
  setChrome({ title: 'Audit Rounds', showBack: false, showLogout: true });
  const [{ rounds }, { forms }] = await Promise.all([
    api('/api/pg/audit-rounds'), api('/api/pg/audit-forms'),
  ]);
  setApp(`
    <div class="card">
      <h3>Audit Rounds</h3>
      <p class="muted">A round runs one form over a set of buildings. Each building is walked once and ends either clean or with a work order.</p>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="newRoundBtn" ${forms.length ? '' : 'disabled'}>Start a round</button>
        ${forms.map((f) => `<button type="button" class="btn btn-secondary edit-form" data-id="${f.Id}">Edit “${escapeHtml(f.Name)}”</button>`).join('')}
      </div>
      ${forms.length ? '' : '<p class="muted">No audit form exists yet.</p>'}
    </div>
    <div class="card">
      ${rounds.length ? rounds.map((r) => `
        <div class="list-item round-row" data-id="${r.Id}" style="cursor:pointer">
          <div style="display:flex;justify-content:space-between;gap:10px">
            <div><strong>${escapeHtml(r.Name)}</strong> <span class="muted">— ${escapeHtml(r.FormName)}</span></div>
            <div class="muted">${r.Complete}/${r.Total} · ${r.Percent}%</div>
          </div>
          <div style="height:6px;background:#eef0f6;border-radius:3px;margin-top:6px;overflow:hidden">
            <div style="height:100%;width:${r.Percent}%;background:#3b5bdb"></div>
          </div>
          ${r.DueDate ? `<div class="muted" style="font-size:0.8rem;margin-top:4px">Due ${escapeHtml(r.DueDate)}</div>` : ''}
        </div>`).join('') : '<p class="muted">No rounds yet.</p>'}
    </div>`);
  app.querySelectorAll('.round-row').forEach((el) => el.addEventListener('click', () => go('auditRound', { id: el.dataset.id })));
  document.getElementById('newRoundBtn')?.addEventListener('click', () => openNewRoundDialog(forms));
  app.querySelectorAll('.edit-form').forEach((b) => b.addEventListener('click', () => go('auditFormBuilder', { id: b.dataset.id })));
}

// Scope is picked as an explicit list of buildings, filtered by location or type —
// those filters choose what to tick, they are not stored as the scope. The instances
// are the scope (§2), so a location gaining a building later doesn't silently join a
// round already under way.
async function openNewRoundDialog(forms) {
  const [{ locations }, assetsRes] = await Promise.all([
    api('/api/pg/locations').catch(() => ({ locations: [] })),
    api('/api/pg/assets?limit=1000').catch(() => ({ assets: [] })),
  ]);
  const allAssets = assetsRes.assets || [];
  let picked = new Set();
  let locFilter = '', typeFilter = '', q = '';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:600px;width:95%;max-height:88vh;overflow:auto">
    <h3 style="margin:0 0 10px">Start an audit round</h3>
    <div class="field-row"><label>Form</label><select id="roundForm">${forms.map((f) => `<option value="${f.Id}">${escapeHtml(f.Name)}</option>`).join('')}</select></div>
    <div class="field-row"><label>Name</label><input type="text" id="roundName" placeholder="Fall 2026 Cabin Audit" /></div>
    <div class="field-row"><label>Due date (optional)</label><input type="date" id="roundDue" /></div>
    <h4 style="margin:16px 0 6px">Buildings</h4>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      <select id="fLoc" style="flex:1;min-width:140px"><option value="">All locations</option>${(locations || []).map((l) => `<option value="${l.Id}">${escapeHtml(l.Name)}</option>`).join('')}</select>
      <select id="fType" style="flex:1;min-width:140px"><option value="">All types</option>${[...new Set(allAssets.map((a) => a.assetType || a.AssetType).filter(Boolean))].sort().map((t) => `<option>${escapeHtml(t)}</option>`).join('')}</select>
      <input type="search" id="fQ" placeholder="Search…" style="flex:1;min-width:140px" />
    </div>
    <div class="btn-row" style="margin-bottom:8px">
      <button type="button" class="btn btn-secondary" id="pickAll">Select all shown</button>
      <button type="button" class="btn btn-secondary" id="pickNone">Clear</button>
      <span class="muted" id="pickCount" style="align-self:center"></span>
    </div>
    <div id="assetList" style="max-height:34vh;overflow:auto;border:1px solid #eef0f6;border-radius:8px"></div>
    <div class="btn-row" style="justify-content:flex-end;margin-top:14px">
      <button type="button" class="btn btn-secondary modal-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="createRound">Create round</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-cancel').addEventListener('click', close);

  const shown = () => allAssets.filter((a) => {
    const t = a.assetType || a.AssetType || '';
    const lid = String(a.locationId || a.LocationId || '');
    const nm = (a.Name || a.name || '').toLowerCase();
    return (!locFilter || lid === locFilter) && (!typeFilter || t === typeFilter) && (!q || nm.includes(q.toLowerCase()));
  });
  function drawList() {
    const list = shown();
    overlay.querySelector('#assetList').innerHTML = list.length ? list.map((a) => `
      <label class="list-item" style="display:flex;align-items:center;gap:10px;cursor:pointer">
        <input type="checkbox" class="pickA" data-id="${a.Id}" ${picked.has(a.Id) ? 'checked' : ''} />
        <span>${escapeHtml(a.Name || a.name)} <span class="muted">${escapeHtml(a.assetType || a.AssetType || '')}</span></span>
      </label>`).join('') : '<p class="muted" style="padding:10px">Nothing matches.</p>';
    overlay.querySelector('#pickCount').textContent = `${picked.size} selected`;
    overlay.querySelectorAll('.pickA').forEach((cb) => cb.addEventListener('change', () => {
      const id = Number(cb.dataset.id);
      if (cb.checked) picked.add(id); else picked.delete(id);
      overlay.querySelector('#pickCount').textContent = `${picked.size} selected`;
    }));
  }
  drawList();
  overlay.querySelector('#fLoc').addEventListener('change', (e) => { locFilter = e.target.value; drawList(); });
  overlay.querySelector('#fType').addEventListener('change', (e) => { typeFilter = e.target.value; drawList(); });
  overlay.querySelector('#fQ').addEventListener('input', (e) => { q = e.target.value; drawList(); });
  overlay.querySelector('#pickAll').addEventListener('click', () => { shown().forEach((a) => picked.add(a.Id)); drawList(); });
  overlay.querySelector('#pickNone').addEventListener('click', () => { picked.clear(); drawList(); });
  overlay.querySelector('#createRound').addEventListener('click', async () => {
    const name = overlay.querySelector('#roundName').value.trim();
    if (!name) return toast('Give the round a name', 4000);
    if (!picked.size) return toast('Pick at least one building', 4000);
    try {
      const r = await api('/api/pg/audit-rounds', {
        method: 'POST',
        body: JSON.stringify({
          formId: Number(overlay.querySelector('#roundForm').value), name,
          dueDate: overlay.querySelector('#roundDue').value || null,
          assetIds: [...picked],
        }),
      });
      close(); toast('Round created'); go('auditRound', { id: r.round.Id }, { replace: true });
    } catch (e) { toast(e.message, 5000); }
  });
}

// The round screen: every building, its status, and what it produced.
async function renderAuditRound({ id }) {
  setChrome({ title: 'Audit Round', showBack: true, showLogout: true });
  const { round, instances } = await api(`/api/pg/audit-rounds/${id}`);
  const done = instances.filter((i) => i.Status === 'complete').length;
  const pct = instances.length ? Math.round((done / instances.length) * 100) : 0;
  const byLoc = new Map();
  for (const i of instances) {
    const k = i.LocationName || '—';
    if (!byLoc.has(k)) byLoc.set(k, []);
    byLoc.get(k).push(i);
  }
  const badge = (i) => {
    if (i.Status === 'complete') {
      return i.GeneratedWorkOrderId
        ? `<span class="muted">✓ WO ${i.GeneratedWorkOrderId}</span>`
        : '<span class="muted">✓ clean</span>';
    }
    if (i.Status === 'in_progress') return `<span class="muted">${i.Answered} answered</span>`;
    return '<span class="muted">not started</span>';
  };
  setApp(`
    <div class="card">
      <h3>${escapeHtml(round.Name)}</h3>
      <div class="muted">${escapeHtml(round.FormName)}${round.DueDate ? ` · due ${escapeHtml(round.DueDate)}` : ''}</div>
      <div style="height:8px;background:#eef0f6;border-radius:4px;margin-top:10px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:#3b5bdb"></div>
      </div>
      <div class="muted" style="margin-top:6px">${done}/${instances.length} · ${pct}%</div>
      <div class="btn-row" style="margin-top:10px"><button type="button" class="btn btn-secondary" id="roundReportBtn">Round report</button></div>
    </div>
    ${[...byLoc.entries()].map(([loc, list]) => `
      <div class="card">
        <h3 style="font-size:1rem">${escapeHtml(loc)}</h3>
        ${list.map((i) => `
          <div class="list-item inst-row" data-id="${i.Id}" style="display:flex;align-items:center;gap:11px;cursor:pointer">
            ${assetFaceHtml(i.Face, 34)}
            <div style="flex:1;min-width:0">
              <div><strong>${escapeHtml(i.AssetName)}</strong></div>
              <div style="font-size:0.82rem">${badge(i)}${i.Flagged ? ` <span style="color:#b4690e">· ${i.Flagged} flagged</span>` : ''}</div>
            </div>
          </div>`).join('')}
      </div>`).join('')}`);
  app.querySelectorAll('.inst-row').forEach((el) => el.addEventListener('click', () => go('auditRunner', { id: el.dataset.id })));
  document.getElementById('roundReportBtn')?.addEventListener('click', () => go('auditRoundReport', { id }));
}

// ── Phone card tables (mobile audit, Q7) ─────────────────────────────────
// Tables you ACT on from the phone become stacked "label: value" cards under 760px;
// data and report tables keep horizontal scroll inside their own container. The
// classification per table is listed in docs/mobile-audit.md.
//
// The card layout needs a label per cell. Rather than hand-writing data-label onto every
// <td> — dozens of edits that then drift when a column changes — each cell takes its
// label from its own table's <thead> by index, once, after render.
function applyCardTableLabels(root = app) {
  for (const table of root.querySelectorAll('table[data-card="1"]')) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    if (!heads.length) continue;
    for (const row of table.querySelectorAll('tbody tr')) {
      [...row.children].forEach((cell, i) => {
        if (cell.tagName !== 'TD') return;
        // An empty header means the column is an action or icon — no label wanted.
        if (heads[i] && !cell.hasAttribute('data-label')) cell.setAttribute('data-label', heads[i]);
      });
    }
  }
}

// ── The on-screen keyboard (mobile audit) ────────────────────────────────
// iOS does not resize the window when the keyboard comes up — it shrinks the VISUAL
// viewport and leaves `innerHeight` alone. Anything pinned to the bottom (a panel's Save
// row, a toast) therefore ends up underneath the keyboard, and 100dvh no longer describes
// what you can see. So publish the overlap once, as a custom property, and let CSS use it.
//
// --kb is how many pixels of the layout viewport the keyboard is covering.
// .kb-open is on <html> whenever that is more than a token amount.
const KB_MIN = 90;  // below this it is a toolbar appearing, not a keyboard

function trackKeyboardInset() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) { root.style.setProperty('--kb', '0px'); return; }
  const apply = () => {
    // offsetTop matters: when the page is scrolled inside the visual viewport, the
    // bottom of what you can see is offsetTop + height, not height.
    const overlap = Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)));
    root.style.setProperty('--kb', `${overlap}px`);
    root.classList.toggle('kb-open', overlap > KB_MIN);
    // The field the keyboard just covered is the whole reason the keyboard opened.
    const el = document.activeElement;
    if (overlap > KB_MIN && el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      const r = el.getBoundingClientRect();
      if (r.bottom > vv.offsetTop + vv.height - 8 || r.top < vv.offsetTop + 8) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}
trackKeyboardInset();

// How much of the layout viewport is actually visible right now — a combobox list or any
// other popover has to fit inside THIS, not inside innerHeight.
function visibleBand() {
  const vv = window.visualViewport;
  const top = vv ? vv.offsetTop : 0;
  return { top, bottom: top + (vv ? vv.height : window.innerHeight) };
}

// ── Asset face: photo, or the type's icon (Addendum §5a) ─────────────────
// One helper everywhere an asset appears, so the same building looks the same in the
// header, in a list and in search results.
function assetFaceHtml(face, size = 34) {
  if (!face) return '';
  const box = `width:${size}px;height:${size}px;border-radius:${Math.round(size / 5)}px;flex:0 0 ${size}px;`;
  return face.PhotoUrl
    ? `<img src="${escapeHtml(face.PhotoUrl)}" alt="" style="${box}object-fit:cover;background:#eef0f6" />`
    : `<div style="${box}display:flex;align-items:center;justify-content:center;background:#f2f3f8;font-size:${Math.round(size * 0.55)}px" aria-hidden="true">${face.Icon || '🏢'}</div>`;
}

// Settings screen for the icons (Addendum §5a). Lists every asset_type actually in use
// alongside any configured icon, so a type that appears later shows up here on its own
// rather than needing a migration.
async function renderAdminAssetTypeIcons(container = app) {
  let types = [];
  async function load() { types = (await api('/api/pg/asset-type-icons')).types || []; }
  function draw() {
    setApp(`
      <div class="card">
        <h3>Asset Type Icons</h3>
        <p class="muted">The fallback shown for any asset without its own photo. Paste any emoji. Types come from the assets themselves, so anything new appears here automatically.</p>
      </div>
      <div class="card">
        ${types.map((t) => `
          <div class="list-item" style="display:flex;align-items:center;gap:12px">
            <div style="width:34px;height:34px;border-radius:7px;display:flex;align-items:center;justify-content:center;background:#f2f3f8;font-size:19px">${t.Icon || '🏢'}</div>
            <div style="flex:1">
              <div><strong>${escapeHtml(t.AssetType || '(no type set)')}</strong></div>
              <div class="muted" style="font-size:0.82rem">${t.AssetCount} asset(s)${t.Icon ? '' : ' · using the default'}</div>
            </div>
            <input type="text" class="icon-input" data-type="${escapeHtml(t.AssetType || '')}" value="${escapeHtml(t.Icon || '')}" placeholder="🏢" style="width:64px;text-align:center;font-size:19px" ${t.AssetType ? '' : 'disabled'} />
          </div>`).join('')}
      </div>`, container);
    container.querySelectorAll('.icon-input').forEach((i) => i.addEventListener('change', async () => {
      try {
        await api('/api/pg/asset-type-icons', {
          method: 'PUT', body: JSON.stringify({ assetType: i.dataset.type, icon: i.value.trim() || null }),
        });
        toast('Saved'); await load(); draw();
      } catch (e) { toast(e.message, 5000); }
    }));
  }
  await load();
  draw();
}

// Lets an asset's existing photos be promoted to its face. Only offers photos already
// attached to this asset — the API refuses anything else, so the picker shouldn't
// pretend otherwise.
async function openProfilePhotoPicker(assetId, attachments = [], { onDone } = {}) {
  const photos = (attachments || []).filter((a) => (a.Kind || '').startsWith('image'));
  if (!photos.length) return toast('Attach a photo to this asset first', 4000);
  const face = (await api(`/api/pg/assets/${assetId}/face`)).face;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:520px;width:95%;max-height:84vh;overflow:auto">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0">Profile photo</h3>
      <button type="button" class="btn btn-secondary modal-cancel">Done</button>
    </div>
    <p class="muted" style="margin:10px 0">Pick the photo that best shows this building. It appears here and in every list.</p>
    <div style="display:flex;flex-wrap:wrap;gap:10px">
      ${photos.map((a) => `
        <button type="button" class="pf-pick" data-id="${a.Id}" style="border:${String(face?.ProfileAttachmentId) === String(a.Id) ? '3px solid #3b5bdb' : '1px solid #e5e7f0'};border-radius:10px;padding:0;background:none;cursor:pointer">
          <img src="${escapeHtml(a.ThumbUrl || a.Url)}" alt="" style="width:110px;height:110px;object-fit:cover;border-radius:8px;display:block" />
        </button>`).join('')}
    </div>
    ${face?.ProfileAttachmentId ? '<div class="btn-row" style="margin-top:12px"><button type="button" class="btn btn-secondary" id="pfClear">Use the type icon instead</button></div>' : ''}
  </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); if (onDone) onDone(); };
  overlay.querySelector('.modal-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const set = async (attachmentId) => {
    try {
      await api(`/api/pg/assets/${assetId}/profile-photo`, { method: 'PUT', body: JSON.stringify({ attachmentId }) });
      toast(attachmentId ? 'Profile photo set' : 'Back to the type icon'); close();
    } catch (e) { toast(e.message, 5000); }
  };
  overlay.querySelectorAll('.pf-pick').forEach((b) => b.addEventListener('click', () => set(Number(b.dataset.id))));
  overlay.querySelector('#pfClear')?.addEventListener('click', () => set(null));
}

function mountCombobox(container, {
  options = [], value = null, placeholder = 'Type to search…',
  emptyText = 'No matches', inputClass = '', extraRowHtml = null, onExtraRow = null,
  onSelect = () => {}, onClear = null,
} = {}) {
  let opts = options;
  let selected = value == null ? null : opts.find((o) => String(o.value) === String(value)) || null;
  let filtered = [];
  let highlight = -1;
  // Text this box is showing on someone else's behalf — a grid cell that is
  // FOLLOWING row 1 displays row 1's label without owning it (§3). Without
  // this, focusing such a cell and tabbing straight back out would revert the
  // box to `selected`, which is null, and blank a cell nobody edited.
  let displayOnly = null;

  container.classList.add('ac-wrap', 'cbx-wrap');
  container.innerHTML = `
    <input type="text" class="ac-input cbx-input ${inputClass}" autocomplete="off" role="combobox"
      aria-expanded="false" aria-autocomplete="list" placeholder="${escapeHtml(placeholder)}"
      value="${selected ? escapeHtml(selected.label) : ''}" />
    <div class="ac-results cbx-results" role="listbox" hidden></div>`;
  const input = container.querySelector('.cbx-input');
  const resultsEl = container.querySelector('.cbx-results');

  const labelFor = (v) => opts.find((o) => String(o.value) === String(v))?.label || '';

  function close() {
    resultsEl.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    highlight = -1;
  }

  function draw() {
    resultsEl.innerHTML = filtered.map((o, i) => `
      <div class="ac-item cbx-item${i === highlight ? ' cbx-active' : ''}" role="option" data-i="${i}"
        aria-selected="${i === highlight}">${escapeHtml(o.label)}${o.sublabel ? ` <span class="muted">— ${escapeHtml(o.sublabel)}</span>` : ''}</div>`).join('')
      + (filtered.length ? '' : `<div class="ac-item ac-empty">${escapeHtml(emptyText)}</div>`)
      + (extraRowHtml ? extraRowHtml(input.value.trim()) : '');
    resultsEl.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    resultsEl.querySelectorAll('.cbx-item').forEach((el) => {
      // mousedown, not click: blur fires first on click and would close the
      // list out from under the pointer.
      el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(filtered[Number(el.dataset.i)]); });
    });
    if (onExtraRow) onExtraRow(resultsEl, input.value.trim());
    placeResults();
    const active = resultsEl.querySelector('.cbx-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  // On a phone the keyboard covers the bottom half of the screen, and a list hanging below
  // the input lands squarely underneath it. Measure the band that is actually visible and,
  // if there is more room above the input than below, hang the list upwards instead. The
  // height is capped to whatever room that side has, so the list cannot run off the top
  // of the screen either.
  function placeResults() {
    const { top, bottom } = visibleBand();
    const r = input.getBoundingClientRect();
    const GAP = 8;
    const below = bottom - r.bottom - GAP;
    const above = r.top - top - GAP;
    resultsEl.style.maxHeight = 'none';
    const wanted = Math.min(resultsEl.scrollHeight || 240, 320);
    const up = below < Math.min(wanted, 180) && above > below;
    resultsEl.classList.toggle('cbx-above', up);
    resultsEl.style.maxHeight = `${Math.max(120, Math.min(wanted, up ? above : below))}px`;
  }

  function open(query = '') {
    const q = query.trim().toLowerCase();
    filtered = (q ? opts.filter((o) => o.label.toLowerCase().includes(q)) : opts).slice(0, 200);
    highlight = filtered.length ? 0 : -1;
    draw();
  }

  function pick(opt) {
    selected = opt || null;
    displayOnly = null;
    input.value = selected ? selected.label : '';
    close();
    onSelect(selected);
  }

  // The keyboard arrives a beat AFTER focus, so the first placement gets measured against
  // the full-height viewport. Re-measure whenever the visible band changes.
  if (window.visualViewport) {
    const reflow = () => { if (!resultsEl.hidden) placeResults(); };
    window.visualViewport.addEventListener('resize', reflow);
    window.visualViewport.addEventListener('scroll', reflow);
  }

  input.addEventListener('input', () => open(input.value));
  input.addEventListener('focus', () => { input.select(); open(''); });
  input.addEventListener('blur', () => {
    close();
    const typed = input.value.trim();
    if (!typed) {
      // Clearing the box is a real action (§3.2: it un-pins a cascade cell),
      // not a typo to be undone — so it commits rather than snapping back.
      if (selected || displayOnly || onClear) { selected = null; displayOnly = null; (onClear || onSelect)(null); }
      return;
    }
    // Anything else typed but not chosen reverts to what the box was showing:
    // a half-typed name must never be mistaken for a selection, and a cell
    // that was only displaying an inherited value keeps displaying it.
    input.value = selected ? selected.label : (displayOnly || '');
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (resultsEl.hidden) { open(input.value); return; }
      if (!filtered.length) return;
      highlight = (highlight + (e.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length;
      draw();
    } else if (e.key === 'Enter') {
      if (!resultsEl.hidden && highlight >= 0) { e.preventDefault(); e.stopPropagation(); pick(filtered[highlight]); }
    } else if (e.key === 'Escape') {
      if (!resultsEl.hidden) { e.preventDefault(); e.stopPropagation(); close(); input.value = selected ? selected.label : ''; }
    }
  });

  return {
    input,
    getValue: () => (selected ? selected.value : null),
    setValue: (v, { silent = true } = {}) => {
      selected = v == null ? null : opts.find((o) => String(o.value) === String(v)) || null;
      displayOnly = null;
      input.value = selected ? selected.label : '';
      if (!silent) onSelect(selected);
    },
    // Display-only text for a value this combobox doesn't own (a grid cell
    // showing what row 1 is currently set to, §3).
    setDisplay: (v) => { input.value = labelFor(v); selected = null; displayOnly = input.value; },
    setOptions: (next) => { opts = next; },
    focus: () => input.focus(),
  };
}

// The app's five funding sources flattened into one searchable list (§9).
// funding_source + funding_ref_id are two columns in Postgres but one
// decision to a person ("who's paying for this line?"), so the grid treats
// them as one cell with a composite "source::refId" value.
function fundingOptionValue(source, refId) { return `${source || 'operating_budget'}::${refId ?? ''}`; }
function parseFundingOptionValue(value) {
  const [source, ref] = String(value ?? '').split('::');
  return { source: source || 'operating_budget', refId: ref ? Number(ref) : null };
}
function buildFundingOptions(fundingEntities) {
  const out = [{ value: fundingOptionValue('operating_budget', null), label: FUNDING_SOURCE_LABELS.operating_budget }];
  for (const source of ['capital_campaign', 'cabin_holder', 'other', 'fund']) {
    for (const e of fundingEntities[source] || []) {
      out.push({ value: fundingOptionValue(source, e.Id), label: `${FUNDING_SOURCE_LABELS[source]} › ${e.Name}`, sublabel: null });
    }
  }
  return out;
}

// ---------- Job Line Grid (entry/edit surface for a WO's lines) ----------
//
// The grid replaces the stacked per-line form on New Work Order and on the
// "Edit lines" screen. A saved WO's detail page keeps its card view — cards
// are for READING (statuses, notes, split, attachments), the grid is for
// entering and editing. Nothing about cascade/pinning survives into the
// database as meaning: every line saves its fully resolved, displayed values
// (§3), and pinned_fields rides along purely so reopening the grid can redraw
// which cells were following.

const JLG_COLUMNS = [
  // Typed fields first, so Tab lands on them immediately (§2).
  { key: 'title', label: 'Title', kind: 'text' },
  { key: 'estHours', label: 'Est. Hours', kind: 'number' },
  { key: 'estCost', label: 'Est. Cost', kind: 'number' },
  { key: 'responsibility_class', label: 'Responsibility', kind: 'select', cascade: true },
  { key: 'funding_source', label: 'Funding Source', kind: 'combobox', cascade: true },
  { key: 'status_id', label: 'Status', kind: 'select', cascade: true },
  { key: 'scheduled_date', label: 'Scheduled Date', kind: 'date', cascade: true },
];
const JLG_CASCADE_COLUMNS = JLG_COLUMNS.filter((c) => c.cascade);
const JLG_CASCADE_DEFAULTS = { responsibility_class: true, funding_source: true, status_id: true, scheduled_date: true };
// Every shortcut that exists appears in the legend — the legend IS the
// documentation (§4).
const JLG_SHORTCUTS = [
  ['Enter', 'new line'], ['Ctrl+Shift+D', 'duplicate'], ['Alt+↑↓', 'move'],
  ['Ctrl/Cmd+V', 'paste from sheet'], ['Tab', 'next cell'],
];

let jlgUid = 0;
// One grid at a time; the SPA swaps #app wholesale, so render() tears the
// previous one down (its beforeunload guard and autosave timer with it).
let activeJobLineGrid = null;
function destroyActiveJobLineGrid() {
  if (activeJobLineGrid) { activeJobLineGrid.destroy(); activeJobLineGrid = null; }
}

// Editing an existing WO keeps one slot keyed to that WO — there's only one
// thing it can be a draft OF. New work orders are different: each attempt is a
// separate unfinished thing, so they get their own slot and accumulate until
// the user decides. 'wo-draft-new' (the old single slot) is still read so a
// draft saved by the previous build isn't stranded.
const WO_NEW_DRAFT_PREFIX = 'wo-draft-new:';
const WO_NEW_DRAFT_LEGACY = 'wo-draft-new';

function jlgDraftKey(woId) { return woId ? `wo-draft-${woId}` : newWoDraftKey(); }
function newWoDraftKey() {
  return `${WO_NEW_DRAFT_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Snapshot the key list before reading: discarding mutates localStorage, and
// index-based iteration over a collection you're editing skips entries.
function listNewWoDrafts() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === WO_NEW_DRAFT_LEGACY || (k && k.startsWith(WO_NEW_DRAFT_PREFIX))) keys.push(k);
    }
  } catch { return []; }
  return keys
    .map((key) => ({ key, draft: jlgReadDraft(key) }))
    .filter((d) => d.draft)
    .sort((a, b) => (b.draft.savedAt || 0) - (a.draft.savedAt || 0));
}

function draftLineTitles(draft) {
  return (draft.rows || []).map((r) => String(r.title || '').trim()).filter(Boolean);
}

function mountJobLineGrid(container, {
  woId = null,
  jobLineStatuses = [],
  fundingOptions = [],
  initialRows = null,
  cascadeConfig = null,          // per-WO override; null = follow the global default
  globalCascadeDefaults = JLG_CASCADE_DEFAULTS,
  onCascadeConfigChange = null,  // persists the per-WO override
  onDirtyChange = () => {},
  draftKey = null,
  draftExtra = () => null,       // extra state the screen wants stored with the draft
} = {}) {
  destroyActiveJobLineGrid();

  const statusById = new Map(jobLineStatuses.map((s) => [String(s.Id), s]));
  const firstOpenStatus = jobLineStatuses.find((s) => !s.IsTerminal) || jobLineStatuses[0];
  const key = draftKey || jlgDraftKey(woId);
  let perWoCascade = cascadeConfig ? { ...cascadeConfig } : null;
  let rows = [];
  let dirty = false;
  let saveTimer = null;
  let undoEntry = null;   // single-level row-delete undo (§6)
  let dragUid = null;

  const comboboxes = new Map();  // row uid -> funding combobox instance
  const rowEls = new Map();      // row uid -> <tr>

  const cascadeOn = (col) => {
    const cfg = perWoCascade || globalCascadeDefaults || JLG_CASCADE_DEFAULTS;
    return cfg[col] !== false;
  };

  const blankValues = () => ({
    responsibility_class: 'self',
    funding_source: fundingOptionValue('operating_budget', null),
    status_id: firstOpenStatus ? String(firstOpenStatus.Id) : '',
    scheduled_date: '',
  });

  function blankRow(seed = {}) {
    return {
      uid: ++jlgUid, id: seed.id ?? null,
      title: seed.title ?? '', estHours: seed.estHours ?? '', estCost: seed.estCost ?? '',
      values: { ...blankValues(), ...(seed.values || {}) },
      pinned: new Set(seed.pinned || []),
      touched: new Set(seed.touched || seed.pinned || []),
      errors: new Map(Object.entries(seed.errors || {})),
      originalStatusId: seed.originalStatusId ?? null,
      statusNote: null,
    };
  }

  // ---- cascade resolution (§3) ----
  // Row 1 is the template. There is no hidden template object: whatever row
  // is physically first supplies the value for every following cell below it.
  function displayed(idx, col) {
    const row = rows[idx];
    if (!row) return '';
    if (idx === 0 || !cascadeOn(col)) return row.values[col];
    return row.pinned.has(col) ? row.values[col] : rows[0].values[col];
  }
  const isFollowing = (idx, col) => idx > 0 && cascadeOn(col) && !rows[idx].pinned.has(col);

  function rowIsEmpty(row) {
    return !String(row.title).trim() && String(row.estHours) === '' && String(row.estCost) === ''
      && !row.pinned.size && !row.errors.size && row.id == null;
  }

  // ---- rendering ----
  function cellControlHtml(col, idx, row) {
    const value = displayed(idx, col.key);
    const follow = isFollowing(idx, col.key);
    const cls = `jlg-cell${follow ? ' jlg-follow' : ''}${row.errors.has(col.key) ? ' jlg-error' : ''}`;
    const errTitle = row.errors.has(col.key) ? ` title="Couldn't match &quot;${escapeHtml(row.errors.get(col.key))}&quot; — pick a value or clear the cell"` : '';
    const followOpt = idx > 0 && cascadeOn(col.key) ? '<option value="">— follow row 1 —</option>' : '';
    if (col.kind === 'select' && col.key === 'responsibility_class') {
      return `<select class="${cls}" data-col="${col.key}"${errTitle}>${followOpt}${
        Object.entries(RESPONSIBILITY_CLASS_LABELS).map(([k, v]) => `<option value="${k}" ${value === k ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}</select>`;
    }
    if (col.kind === 'select' && col.key === 'status_id') {
      return `<select class="${cls}" data-col="${col.key}"${errTitle}>${followOpt}${
        jobLineStatuses.map((s) => `<option value="${s.Id}" ${String(value) === String(s.Id) ? 'selected' : ''}>${escapeHtml(s.Name)}</option>`).join('')}</select>`;
    }
    if (col.kind === 'date') {
      return `<input type="date" class="${cls}" data-col="${col.key}" value="${escapeHtml(value || '')}"${errTitle} />`;
    }
    return `<div class="jlg-fund-mount ${cls}" data-col="${col.key}"${errTitle}></div>`;
  }

  function rowHtml(row, idx) {
    return `<tr class="jlg-row" data-uid="${row.uid}" data-idx="${idx}">
      <td class="jlg-c-idx"><span class="jlg-drag" draggable="true" title="Drag to reorder">⠿</span><span class="jlg-rownum">${idx + 1}</span></td>
      <td class="jlg-c-title">
        <textarea class="jlg-title" rows="1" spellcheck="false" placeholder="${idx === 0 ? 'What needs doing?' : ''}">${escapeHtml(row.title)}</textarea>
        <div class="jlg-title-display">${escapeHtml(row.title)}</div>
      </td>
      <td class="jlg-c-num"><input class="jlg-num${row.errors.has('estHours') ? ' jlg-error' : ''}" data-col="estHours" type="number" step="any" min="0" value="${escapeHtml(row.estHours)}" /></td>
      <td class="jlg-c-num"><input class="jlg-num${row.errors.has('estCost') ? ' jlg-error' : ''}" data-col="estCost" type="number" step="0.01" min="0" value="${escapeHtml(row.estCost)}" /></td>
      <td class="jlg-c-resp">${cellControlHtml(JLG_COLUMNS[3], idx, row)}</td>
      <td class="jlg-c-fund">${cellControlHtml(JLG_COLUMNS[4], idx, row)}</td>
      <td class="jlg-c-status">${cellControlHtml(JLG_COLUMNS[5], idx, row)}</td>
      <td class="jlg-c-date">${cellControlHtml(JLG_COLUMNS[6], idx, row)}</td>
      <td class="jlg-c-menu"><button type="button" class="jlg-remove" title="Remove this line" aria-label="Remove line ${idx + 1}">✕</button></td>
    </tr>`;
  }

  function shellHtml() {
    return `
      <div class="jlg-wrap">
        <div class="jlg-toolbar">
          <button type="button" class="btn btn-secondary btn-small jlg-import-btn">⬆ Import lines</button>
          <input type="file" class="jlg-file" accept=".csv,text/csv,text/plain" hidden />
          <button type="button" class="btn btn-secondary btn-small jlg-cascade-btn" aria-haspopup="dialog">⚙ Cascade settings</button>
          <span class="jlg-toolbar-hint muted">Row 1 sets the defaults — rows below follow it until you type over them.</span>
        </div>
        <div class="jlg-cascade-pop" hidden role="dialog" aria-label="Cascade settings"></div>
        <div class="jlg-scroll">
          <table class="jlg-table">
            <thead><tr>
              <th class="jlg-c-idx"></th>
              ${JLG_COLUMNS.map((c) => `<th class="jlg-th-${c.key}">${escapeHtml(c.label)}</th>`).join('')}
              <th class="jlg-c-menu"></th>
            </tr></thead>
            <tbody class="jlg-body"></tbody>
          </table>
        </div>
        <div class="jlg-footer" aria-live="polite"></div>
        <div class="jlg-legend">${JLG_SHORTCUTS.map(([k, v]) => `<span><kbd>${escapeHtml(k)}</kbd> ${escapeHtml(v)}</span>`).join('<span class="jlg-legend-sep">·</span>')}</div>
      </div>`;
  }

  container.innerHTML = shellHtml();
  const bodyEl = container.querySelector('.jlg-body');
  const footerEl = container.querySelector('.jlg-footer');
  const cascadePop = container.querySelector('.jlg-cascade-pop');

  // ---- structural changes ----
  // Row 1 IS the template (§3), so any change to which row is physically
  // first has to leave the screen saying what it said a moment ago: the row
  // arriving at the top stamps the values it was displaying, and the row
  // leaving the top pins the values it was supplying, rather than suddenly
  // starting to follow its replacement.
  function withTemplateStability(mutate) {
    const before = new Map(rows.map((r, i) => [r.uid, Object.fromEntries(JLG_CASCADE_COLUMNS.map((c) => [c.key, displayed(i, c.key)]))]));
    const prevFirst = rows[0];
    mutate();
    const newFirst = rows[0];
    if (!prevFirst || !newFirst || prevFirst === newFirst) return;
    if (rows.includes(prevFirst)) {
      for (const c of JLG_CASCADE_COLUMNS) { prevFirst.pinned.add(c.key); prevFirst.touched.add(c.key); }
    }
    const snap = before.get(newFirst.uid);
    if (snap) for (const c of JLG_CASCADE_COLUMNS) newFirst.values[c.key] = snap[c.key];
    newFirst.pinned.clear();
    newFirst.touched.clear();
  }

  // Every structural change goes through this: rebuild, guarantee the single
  // trailing blank row, renumber. Keeping them together is what stops a
  // "delete the last line" path from leaving the grid with nowhere to type.
  function redraw() { renderRows(); ensureTrailing(); reindexRows(); }

  function renderRows() {
    comboboxes.clear();
    rowEls.clear();
    bodyEl.innerHTML = rows.map((r, i) => rowHtml(r, i)).join('');
    [...bodyEl.querySelectorAll('.jlg-row')].forEach((tr, i) => wireRow(tr, rows[i]));
    syncFooter();
  }

  function appendRowDom(row) {
    bodyEl.insertAdjacentHTML('beforeend', rowHtml(row, rows.length - 1));
    wireRow(bodyEl.lastElementChild, row);
    syncFooter();
  }

  // §2: the grid always keeps exactly one empty row at the bottom, and typing
  // in it spawns the next one. Appending just that row's DOM (instead of
  // re-rendering) is what lets you keep typing without losing the caret.
  function ensureTrailing() {
    while (rows.length > 1 && rowIsEmpty(rows[rows.length - 1]) && rowIsEmpty(rows[rows.length - 2])) {
      const dropped = rows.pop();
      comboboxes.delete(dropped.uid);
      rowEls.delete(dropped.uid);
      bodyEl.lastElementChild?.remove();
    }
    if (!rows.length || !rowIsEmpty(rows[rows.length - 1])) {
      rows.push(blankRow());
      appendRowDom(rows[rows.length - 1]);
    }
  }

  function reindexRows() {
    [...bodyEl.querySelectorAll('.jlg-row')].forEach((tr, i) => {
      tr.dataset.idx = String(i);
      tr.querySelector('.jlg-rownum').textContent = String(i + 1);
    });
  }

  // ---- cascade propagation ----
  function refreshFollowers(col) {
    rows.forEach((row, i) => {
      if (!isFollowing(i, col)) return;
      const tr = rowEls.get(row.uid);
      if (!tr) return;
      const value = displayed(i, col);
      if (col === 'funding_source') comboboxes.get(row.uid)?.setDisplay(value);
      else {
        const el = tr.querySelector(`[data-col="${col}"]`);
        if (el) el.value = value ?? '';
      }
    });
    syncFooter();
  }

  function setCascadeValue(idx, col, rawValue) {
    const row = rows[idx];
    const clearing = rawValue === '' || rawValue == null;
    row.errors.delete(col);
    if (idx > 0 && cascadeOn(col) && clearing) {
      // §3.2: blank isn't a meaningful value in a cascade column, so clearing
      // a pinned cell means "go back to following row 1" — including for
      // `touched`, so a later toggle off/on doesn't resurrect the pin.
      row.pinned.delete(col);
      row.touched.delete(col);
      row.values[col] = rows[0].values[col];
    } else {
      row.values[col] = rawValue;
      if (idx > 0) { row.pinned.add(col); row.touched.add(col); }
    }
    const tr = rowEls.get(row.uid);
    if (tr) {
      const follow = isFollowing(idx, col);
      const el = col === 'funding_source' ? tr.querySelector('.jlg-fund-mount') : tr.querySelector(`[data-col="${col}"]`);
      if (el) {
        el.classList.toggle('jlg-follow', follow);
        el.classList.remove('jlg-error');
        el.removeAttribute('title');
      }
      const value = displayed(idx, col);
      if (col === 'funding_source') comboboxes.get(row.uid)?.[follow ? 'setDisplay' : 'setValue'](value);
      else if (el) el.value = value ?? '';
    }
    if (idx === 0) refreshFollowers(col);
    markDirty();
    syncFooter();
  }

  // ---- row wiring ----
  function wireRow(tr, row) {
    rowEls.set(row.uid, tr);
    const idxOf = () => rows.indexOf(row);

    const titleEl = tr.querySelector('.jlg-title');
    const titleDisplay = tr.querySelector('.jlg-title-display');
    const autosize = () => { titleEl.style.height = 'auto'; titleEl.style.height = `${Math.max(titleEl.scrollHeight, 32)}px`; };
    titleEl.addEventListener('focus', autosize);
    titleEl.addEventListener('blur', () => { titleEl.style.height = ''; });
    titleEl.addEventListener('input', () => {
      row.title = titleEl.value;
      titleDisplay.textContent = titleEl.value;
      autosize();
      markDirty(); ensureTrailing(); reindexRows(); syncFooter();
    });

    tr.querySelectorAll('.jlg-num').forEach((el) => el.addEventListener('input', () => {
      row[el.dataset.col] = el.value;
      markDirty(); ensureTrailing(); reindexRows(); syncFooter();
    }));

    tr.querySelectorAll('select.jlg-cell, input.jlg-cell').forEach((el) => {
      el.addEventListener('change', () => {
        const col = el.dataset.col;
        const idx = idxOf();
        // A SAVED line changing status is a lifecycle transition, so the
        // status config's note requirement applies (§2) — ask now rather than
        // failing the whole grid save later. Lines being created are arrears
        // entry and never prompt.
        if (col === 'status_id' && row.id != null && el.value && Number(el.value) !== row.originalStatusId) {
          const status = statusById.get(String(el.value));
          if (status?.RequiresNote) {
            const note = window.prompt(status.NoteLabel || `A note is required to mark this line "${status.Name}"`, row.statusNote || '');
            if (note == null || !note.trim()) { el.value = displayed(idx, col); toast('Status unchanged — that status needs a note'); return; }
            row.statusNote = note.trim();
          }
        }
        setCascadeValue(idx, col, el.value);
      });
    });

    const fundMount = tr.querySelector('.jlg-fund-mount');
    if (fundMount) {
      const idx = idxOf();
      const follow = isFollowing(idx, 'funding_source');
      const cbx = mountCombobox(fundMount, {
        options: fundingOptions,
        value: follow ? null : displayed(idx, 'funding_source'),
        placeholder: 'Operating Budget',
        emptyText: 'No funding source matches',
        onSelect: (opt) => setCascadeValue(idxOf(), 'funding_source', opt ? opt.value : ''),
        onClear: () => setCascadeValue(idxOf(), 'funding_source', ''),
      });
      if (follow) cbx.setDisplay(displayed(idx, 'funding_source'));
      comboboxes.set(row.uid, cbx);
    }

    tr.querySelector('.jlg-remove').addEventListener('click', () => removeRow(row));

    const handle = tr.querySelector('.jlg-drag');
    handle.addEventListener('dragstart', (e) => {
      dragUid = row.uid;
      tr.classList.add('jlg-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(row.uid));
    });
    handle.addEventListener('dragend', () => { dragUid = null; tr.classList.remove('jlg-dragging'); bodyEl.querySelectorAll('.jlg-drop-target').forEach((el) => el.classList.remove('jlg-drop-target')); });
    tr.addEventListener('dragover', (e) => {
      if (dragUid == null || dragUid === row.uid) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tr.classList.add('jlg-drop-target');
    });
    tr.addEventListener('dragleave', () => tr.classList.remove('jlg-drop-target'));
    tr.addEventListener('drop', (e) => {
      e.preventDefault();
      tr.classList.remove('jlg-drop-target');
      if (dragUid == null || dragUid === row.uid) return;
      const from = rows.findIndex((r) => r.uid === dragUid);
      const to = rows.indexOf(row);
      if (from < 0 || to < 0) return;
      withTemplateStability(() => { rows.splice(to, 0, rows.splice(from, 1)[0]); });
      dragUid = null;
      redraw(); markDirty();
    });
  }

  // ---- row operations ----
  function focusRow(row, selector = '.jlg-title') {
    const el = rowEls.get(row.uid)?.querySelector(selector);
    if (el) { el.focus(); if (el.select) el.select(); }
  }

  function insertRowBelow(row) {
    const at = rows.indexOf(row) + 1;
    const fresh = blankRow();
    withTemplateStability(() => { rows.splice(at, 0, fresh); });
    redraw();
    focusRow(fresh);
    markDirty();
    return fresh;
  }

  // §3.4: a duplicate copies values AND pin state — a cell that was following
  // in the source follows in the copy, rather than quietly becoming its own.
  function duplicateRow(row) {
    const at = rows.indexOf(row) + 1;
    const copy = blankRow({
      title: row.title, estHours: row.estHours, estCost: row.estCost,
      values: { ...row.values }, pinned: [...row.pinned], touched: [...row.touched],
    });
    withTemplateStability(() => { rows.splice(at, 0, copy); });
    redraw();
    focusRow(copy);
    markDirty();
  }

  function moveRow(row, delta) {
    const from = rows.indexOf(row);
    const to = from + delta;
    if (to < 0 || to >= rows.length) return;
    withTemplateStability(() => { rows.splice(to, 0, rows.splice(from, 1)[0]); });
    redraw();
    focusRow(row);
    markDirty();
  }

  async function removeRow(row) {
    const idx = rows.indexOf(row);
    if (idx < 0) return;
    if (rows.length === 1) { toast("That's the only line — clear it instead"); return; }
    if (idx === 0 && rows.length > 1) {
      // §3.5 — deleting the template is a decision, so it asks.
      if (!await confirmDialog('This row is the template for the lines below — delete it?', { confirmLabel: 'Delete row 1' })) return;
      withTemplateStability(() => { rows.splice(idx, 1); });
      redraw(); markDirty();
      return;
    }
    withTemplateStability(() => { rows.splice(idx, 1); });
    redraw(); markDirty();
    // §6: one level deep, rows only. Deleting another row replaces this.
    undoEntry = { row, idx };
    actionToast('Row deleted', 'Undo', () => {
      if (!undoEntry) return;
      const { row: restored, idx: at } = undoEntry;
      undoEntry = null;
      withTemplateStability(() => { rows.splice(Math.min(at, rows.length), 0, restored); });
      redraw(); markDirty();
      focusRow(restored);
    }, 8000);
  }

  // ---- footer (§2) ----
  function liveRows() { return rows.filter((r) => String(r.title).trim()); }
  function syncFooter() {
    const live = liveRows();
    const hours = live.reduce((s, r) => s + (Number(r.estHours) || 0), 0);
    const cost = live.reduce((s, r) => s + (Number(r.estCost) || 0), 0);
    const bySource = new Map();
    for (const r of live) {
      const value = displayed(rows.indexOf(r), 'funding_source');
      const label = fundingOptions.find((o) => String(o.value) === String(value))?.label || 'Unassigned';
      bySource.set(label, (bySource.get(label) || 0) + (Number(r.estCost) || 0));
    }
    const money = (n) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    const hrs = Number.isInteger(hours) ? hours : Number(hours.toFixed(2));
    // Grand total always; the per-source split only when the sources differ.
    const breakdown = bySource.size > 1
      ? `<div class="jlg-footer-breakdown muted">${[...bySource.entries()].map(([label, amount]) => `${escapeHtml(label)} ${money(amount)}`).join(' · ')}</div>`
      : '';
    const errors = rows.filter((r) => r.errors.size).length;
    footerEl.innerHTML = `
      <div class="jlg-footer-total"><strong>${live.length} line${live.length === 1 ? '' : 's'}</strong> · ${hrs} hrs · ${money(cost)}</div>
      ${breakdown}
      ${errors ? `<div class="jlg-footer-error">⚠ ${errors} row${errors === 1 ? '' : 's'} have a value that didn't match — fix the red cells before saving.</div>` : ''}`;
  }

  // ---- keyboard (§4) ----
  container.addEventListener('keydown', (e) => {
    const tr = e.target.closest?.('.jlg-row');
    if (!tr) return;
    const row = rows.find((r) => r.uid === Number(tr.dataset.uid));
    if (!row) return;
    // Enter must never reach the surrounding form — on this screen it means
    // "next line," not "create the work order."
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault(); e.stopPropagation();
      insertRowBelow(row);
      return;
    }
    // preventDefault so the browser's own Ctrl+Shift+D (bookmark-all-tabs)
    // never fires over the top of this.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault(); e.stopPropagation();
      duplicateRow(row);
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault(); e.stopPropagation();
      moveRow(row, e.key === 'ArrowUp' ? -1 : 1);
    }
  });

  // ---- import: CSV file + clipboard paste (§5) ----
  // Both paths land here, so a pasted Sheets range and an uploaded CSV can't
  // drift apart in behaviour. The grid IS the preview — nothing touches the
  // database until the screen's own Save.
  const JLG_HEADER_ALIASES = {
    title: 'title', name: 'title', 'job line': 'title', 'line': 'title',
    hours: 'estHours', 'est hours': 'estHours', 'est. hours': 'estHours', 'estimated hours': 'estHours', hrs: 'estHours',
    cost: 'estCost', 'est cost': 'estCost', 'est. cost': 'estCost', 'estimated cost': 'estCost',
    responsibility: 'responsibility_class', 'responsible': 'responsibility_class',
    funding: 'funding_source', 'funding source': 'funding_source', source: 'funding_source',
    status: 'status_id',
    date: 'scheduled_date', 'scheduled date': 'scheduled_date', scheduled: 'scheduled_date',
  };

  function detectHeader(cells) {
    const mapped = cells.map((c) => JLG_HEADER_ALIASES[String(c || '').trim().toLowerCase()] || null);
    // Treat it as a header only if most of the row is recognisable — one
    // stray cell called "Status" in a data row shouldn't eat that row.
    const hits = mapped.filter(Boolean).length;
    return hits >= Math.max(1, Math.ceil(cells.filter((c) => String(c || '').trim()).length * 0.6)) ? mapped : null;
  }

  function matchOptionText(colKey, text) {
    const q = text.trim().toLowerCase();
    if (colKey === 'responsibility_class') {
      const hit = Object.entries(RESPONSIBILITY_CLASS_LABELS).find(([k, v]) => k === q || v.toLowerCase() === q);
      return hit ? hit[0] : null;
    }
    if (colKey === 'status_id') {
      const hit = jobLineStatuses.find((s) => s.Name.toLowerCase() === q);
      return hit ? String(hit.Id) : null;
    }
    if (colKey === 'funding_source') {
      const byLabel = fundingOptions.find((o) => o.label.toLowerCase() === q);
      if (byLabel) return byLabel.value;
      // "Greenawalt, Ben" on its own should find the Cabin-Holder entry, and
      // "Operating" should find Operating Budget, without demanding the
      // full "Source › Name" spelling.
      const byEntity = fundingOptions.find((o) => (o.label.split('›')[1] || '').trim().toLowerCase() === q);
      if (byEntity) return byEntity.value;
      const bySource = Object.entries(FUNDING_SOURCE_LABELS).find(([k, v]) => k === q || v.toLowerCase() === q || v.toLowerCase().startsWith(q));
      if (bySource) {
        const plain = fundingOptions.find((o) => String(o.value) === fundingOptionValue(bySource[0], null));
        if (plain) return plain.value;
      }
      return null;
    }
    if (colKey === 'scheduled_date') return parseLooseDate(text);
    return null;
  }

  function applyImportedCell(idx, colKey, raw) {
    const row = rows[idx];
    const text = String(raw ?? '').trim();
    if (colKey === 'title') { row.title = text; return; }
    if (colKey === 'estHours' || colKey === 'estCost') {
      row.errors.delete(colKey);
      if (!text) { row[colKey] = ''; return; }
      const n = Number(text.replace(/[$,\s]/g, ''));
      if (Number.isFinite(n)) row[colKey] = String(n);
      else { row[colKey] = ''; row.errors.set(colKey, text); }
      return;
    }
    // §5's one cascade rule: a cell WITH data arrives pinned, a blank cell
    // (or an unmapped column) arrives following row 1. So a fully-populated
    // file behaves as if cascade were off, and a titles-only file picks up
    // row 1's defaults for everything else.
    if (!text) {
      row.errors.delete(colKey);
      if (idx > 0) { row.pinned.delete(colKey); row.touched.delete(colKey); }
      return;
    }
    const matched = matchOptionText(colKey, text);
    if (matched == null) {
      row.errors.set(colKey, text);
      if (idx > 0) { row.pinned.add(colKey); row.touched.add(colKey); }
      return;
    }
    row.errors.delete(colKey);
    row.values[colKey] = matched;
    if (idx > 0) { row.pinned.add(colKey); row.touched.add(colKey); }
  }

  function ingestMatrix(matrix, { anchorRowIdx = 0, anchorColIdx = 0 } = {}) {
    const clean = matrix.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
    if (!clean.length) return 0;
    const header = detectHeader(clean[0]);
    const data = header ? clean.slice(1) : clean;
    const colKeys = header || JLG_COLUMNS.slice(anchorColIdx).map((c) => c.key);
    if (!data.length) return 0;
    withTemplateStability(() => {
      data.forEach((cells, r) => {
        const idx = anchorRowIdx + r;
        while (rows.length <= idx) rows.push(blankRow());
        cells.forEach((cell, c) => {
          const colKey = colKeys[c];
          if (colKey) applyImportedCell(idx, colKey, cell);
        });
      });
    });
    redraw(); markDirty();
    return data.length;
  }

  container.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    const tr = e.target.closest?.('.jlg-row');
    if (!tr) return;
    const normalized = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const lines = normalized.split('\n');
    const hasTab = normalized.includes('\t');
    if (!hasTab && lines.length < 2) return; // an ordinary one-cell paste — leave it to the browser
    const anchorRowIdx = rows.findIndex((r) => r.uid === Number(tr.dataset.uid));
    if (anchorRowIdx < 0) return;
    const col = e.target.dataset?.col
      || (e.target.classList?.contains('jlg-title') ? 'title' : null)
      || (e.target.closest('.jlg-fund-mount') ? 'funding_source' : null);
    const anchorColIdx = Math.max(0, JLG_COLUMNS.findIndex((c) => c.key === col));
    e.preventDefault();
    // Plain multi-line text with no tabs, pasted into a Title cell, is a list
    // of titles — one line each, nothing else touched (§5).
    const matrix = hasTab ? lines.map((l) => l.split('\t')) : lines.map((l) => [l]);
    const count = ingestMatrix(matrix, { anchorRowIdx, anchorColIdx });
    if (count) toast(`Pasted ${count} row${count === 1 ? '' : 's'}`);
  });

  const fileInput = container.querySelector('.jlg-file');
  container.querySelector('.jlg-import-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const matrix = parseDelimitedText(await file.text());
      // Appends after whatever is already in the grid, so an import never
      // silently eats lines someone already typed.
      const firstEmpty = rows.findIndex((r) => rowIsEmpty(r));
      const count = ingestMatrix(matrix, { anchorRowIdx: firstEmpty >= 0 ? firstEmpty : rows.length, anchorColIdx: 0 });
      toast(count ? `Imported ${count} row${count === 1 ? '' : 's'} — review before saving` : 'Nothing to import from that file');
    } catch (err) { toast(`Couldn't read that file: ${err.message}`); }
  });

  // ---- cascade settings popover (§3.7) ----
  function effectiveCascade() {
    const base = { ...JLG_CASCADE_DEFAULTS, ...(globalCascadeDefaults || {}) };
    return perWoCascade ? { ...base, ...perWoCascade } : base;
  }

  function setCascade(col, on) {
    if (on === cascadeOn(col)) return;
    // §3.8: turning a column OFF freezes every cell at the value it is
    // currently showing — nothing on screen moves. Pin/touched state keeps
    // being tracked underneath regardless, so turning it back ON resumes
    // following only for cells that were never directly edited.
    if (!on) rows.forEach((r, i) => { if (i > 0) r.values[col] = displayed(i, col); });
    perWoCascade = { ...effectiveCascade(), [col]: on };
    if (on) rows.forEach((r, i) => { if (i > 0 && !r.touched.has(col)) r.pinned.delete(col); });
    redraw(); markDirty();
    drawCascadePop();
    if (onCascadeConfigChange) onCascadeConfigChange(perWoCascade);
  }

  function drawCascadePop() {
    const eff = effectiveCascade();
    cascadePop.innerHTML = `
      <h4>Cascade columns</h4>
      <p class="muted">Rows below row 1 inherit these until you type over them. This is set for <strong>this work order only</strong>${perWoCascade ? '' : ' (currently following the site default)'}.</p>
      ${JLG_CASCADE_COLUMNS.map((c) => `<label class="jlg-cascade-opt"><input type="checkbox" data-col="${c.key}" ${eff[c.key] ? 'checked' : ''} /> ${escapeHtml(c.label)}</label>`).join('')}
      <div class="btn-row">
        <button type="button" class="btn btn-secondary btn-small jlg-cascade-reset" ${perWoCascade ? '' : 'disabled'}>Use site default</button>
        <button type="button" class="btn btn-secondary btn-small jlg-cascade-close">Done</button>
      </div>`;
    cascadePop.querySelectorAll('input[data-col]').forEach((el) => el.addEventListener('change', () => setCascade(el.dataset.col, el.checked)));
    cascadePop.querySelector('.jlg-cascade-reset').addEventListener('click', () => {
      // Dropping the override has to leave the screen unchanged too, so the
      // same freeze rule applies to any column the default turns off.
      const base = { ...JLG_CASCADE_DEFAULTS, ...(globalCascadeDefaults || {}) };
      for (const c of JLG_CASCADE_COLUMNS) {
        if (cascadeOn(c.key) && base[c.key] === false) rows.forEach((r, i) => { if (i > 0) r.values[c.key] = displayed(i, c.key); });
      }
      perWoCascade = null;
      for (const c of JLG_CASCADE_COLUMNS) {
        if (base[c.key] !== false) rows.forEach((r, i) => { if (i > 0 && !r.touched.has(c.key)) r.pinned.delete(c.key); });
      }
      redraw(); markDirty(); drawCascadePop();
      if (onCascadeConfigChange) onCascadeConfigChange(null);
    });
    cascadePop.querySelector('.jlg-cascade-close').addEventListener('click', () => { cascadePop.hidden = true; });
  }

  container.querySelector('.jlg-cascade-btn').addEventListener('click', () => {
    cascadePop.hidden = !cascadePop.hidden;
    if (!cascadePop.hidden) drawCascadePop();
  });

  // ---- draft autosave (§6) ----
  function serializeDraft() {
    return {
      savedAt: Date.now(),
      extra: draftExtra(),
      cascadeConfig: perWoCascade,
      rows: rows.map((r) => ({
        id: r.id, title: r.title, estHours: r.estHours, estCost: r.estCost,
        values: r.values, pinned: [...r.pinned], touched: [...r.touched],
        errors: Object.fromEntries(r.errors), originalStatusId: r.originalStatusId,
      })),
    };
  }

  function writeDraft(force = false) {
    try {
      // Autosave drops an all-empty grid rather than leaving a useless slot.
      // An explicit Save draft click forces the write: the user may have filled
      // only the header so far and still wants it kept.
      if (!force && rows.every(rowIsEmpty)) { localStorage.removeItem(key); return; }
      localStorage.setItem(key, JSON.stringify(serializeDraft()));
    } catch { /* private mode / quota — the grid still works, it just won't survive a reload */ }
  }

  function beforeUnload(e) { e.preventDefault(); e.returnValue = ''; return ''; }

  function markDirty() {
    if (!dirty) { dirty = true; window.addEventListener('beforeunload', beforeUnload); onDirtyChange(true); }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeDraft, 2000);
  }

  function clearDraft() {
    clearTimeout(saveTimer);
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    if (dirty) { dirty = false; window.removeEventListener('beforeunload', beforeUnload); onDirtyChange(false); }
  }

  // ---- save payload (§3's save semantics) ----
  // Every line stamps its RESOLVED, displayed values. No nulls-meaning-
  // inherit, no runtime resolution against a parent — a report reading these
  // rows years from now never has to know cascade existed.
  function getSaveLines() {
    return rows.map((row, idx) => ({ row, idx }))
      .filter(({ row }) => String(row.title).trim())
      .map(({ row, idx }) => {
        const funding = parseFundingOptionValue(displayed(idx, 'funding_source'));
        return {
          id: row.id,
          title: String(row.title).trim(),
          responsibilityClass: displayed(idx, 'responsibility_class') || 'self',
          fundingSource: funding.source,
          fundingRefId: funding.refId,
          estimatedHours: row.estHours === '' ? null : Number(row.estHours),
          estimatedCost: row.estCost === '' ? null : Number(row.estCost),
          scheduledDate: displayed(idx, 'scheduled_date') || null,
          statusId: displayed(idx, 'status_id') ? Number(displayed(idx, 'status_id')) : null,
          statusNote: row.statusNote || undefined,
          pinnedFields: [...row.pinned],
        };
      });
  }

  function destroy() {
    // The debounced writeDraft may still be pending (markDirty schedules it
    // 2s out, and every keystroke pushes it back). Cancelling the timer
    // without flushing silently discarded everything typed since the last
    // idle pause — which is the whole session if you never paused. Flush
    // first, then tear down. clearDraft() already set dirty=false on a
    // successful save, so this never resurrects a draft that was just cleared.
    clearTimeout(saveTimer);
    if (dirty) writeDraft();
    window.removeEventListener('beforeunload', beforeUnload);
  }

  // ---- boot ----
  rows = (initialRows && initialRows.length ? initialRows : [{}]).map((seed) => blankRow(seed));
  const knownLineIds = rows.map((r) => r.id).filter((id) => id != null);
  redraw();

  const api = {
    container,
    getRows: () => rows,
    getSaveLines,
    knownLineIds,
    lineCount: () => liveRows().length,
    hasErrors: () => rows.some((r) => r.errors.size),
    isDirty: () => dirty,
    // Write now and go clean — the work is safely stored, so the leave-guard
    // has nothing left to warn about until the next edit. Unlike clearDraft(),
    // the stored draft stays put; that's the whole point of the button.
    saveDraftNow: () => {
      clearTimeout(saveTimer);
      writeDraft(true);
      if (dirty) { dirty = false; window.removeEventListener('beforeunload', beforeUnload); onDirtyChange(false); }
    },
    clearDraft,
    destroy,
    focusFirst: () => focusRow(rows[0]),
    getCascadeConfig: () => perWoCascade,
  };
  activeJobLineGrid = api;
  return api;
}

// ---------- Grid support helpers ----------

// Minimal RFC4180-ish reader: quoted fields, doubled quotes inside them,
// newlines inside quotes. Delimiter is sniffed from the first line so a
// pasted Sheets range (tabs) and a CSV (commas) both read correctly.
function parseDelimitedText(text, delimiter = null) {
  const src = String(text).replace(/\r\n?/g, '\n');
  const firstLine = src.split('\n')[0] || '';
  const delim = delimiter || ((firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',');
  const out = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  row.push(field);
  out.push(row);
  return out.filter((r) => r.length && !(r.length === 1 && r[0].trim() === ''));
}

// Accepts what a spreadsheet actually produces — 2026-09-21, 9/21/2026,
// 9/21/26, "Sep 21, 2026" — and returns the YYYY-MM-DD an <input type=date>
// needs, or null when it genuinely can't tell.
function parseLooseDate(text) {
  const t = String(text).trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  const d = new Date(`${t} UTC`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// A toast with one button on it — used for the row-delete undo (§6), where a
// plain message would be useless because the whole point is to click it.
let actionToastEl = null;
function actionToast(message, actionLabel, onAction, ms = 8000) {
  if (actionToastEl) actionToastEl.remove();
  const el = document.createElement('div');
  actionToastEl = el;
  el.className = 'toast action-toast';
  el.innerHTML = `<span>${escapeHtml(message)}</span><button type="button" class="action-toast-btn">${escapeHtml(actionLabel)}</button>`;
  document.body.appendChild(el);
  const dismiss = () => { clearTimeout(timer); if (actionToastEl === el) actionToastEl = null; el.remove(); };
  el.querySelector('.action-toast-btn').addEventListener('click', () => { dismiss(); onAction(); });
  const timer = setTimeout(dismiss, ms);
  return dismiss;
}

function jlgReadDraft(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    // A header with a title and no lines yet is still work worth offering back
    // — it's exactly what an explicit "Save draft" click produces.
    const hasLines = Array.isArray(draft?.rows) && draft.rows.some((r) => String(r.title || '').trim());
    const hasHeader = String(draft?.extra?.title || '').trim() !== '';
    return hasLines || hasHeader ? draft : null;
  } catch { return null; }
}
function jlgClearDraft(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }

// The grid seeds a row per saved job line, restoring pin/follow rendering
// from pinned_fields — the only thing that column is for (§3).
function jlgRowsFromJobLines(jobLines) {
  return jobLines.map((jl) => ({
    id: jl.Id,
    title: jl.Title || '',
    estHours: jl.EstimatedHours ?? '',
    estCost: jl.EstimatedCost ?? '',
    values: {
      responsibility_class: jl.ResponsibilityClass || 'self',
      funding_source: fundingOptionValue(jl.FundingSource, jl.FundingRefId),
      status_id: String(jl.StatusId ?? ''),
      scheduled_date: (jl.ScheduledDate || '').slice(0, 10),
    },
    pinned: jl.PinnedFields || [],
    originalStatusId: jl.StatusId ?? null,
  }));
}

// Loads everything the grid needs to turn ids into names without a
// round-trip per keystroke: the funding entities behind all five funding
// sources, flattened into the one searchable list the Funding Source column
// uses (§9).
async function loadGridContext() {
  const [campaignRes, cabinRes, otherRes, fundsRes, settings] = await Promise.all([
    api('/api/pg/budget/capital-campaign-projects'), api('/api/pg/budget/cabin-holders'),
    api('/api/pg/budget/other-categories'), api('/api/pg/funds'), api('/api/pg/display-settings'),
  ]);
  const fundingEntities = { capital_campaign: campaignRes.items, cabin_holder: cabinRes.items, other: otherRes.items, fund: fundsRes.funds };
  return {
    fundingEntities,
    fundingOptions: buildFundingOptions(fundingEntities),
    jobLineStatuses: state.options.jobLineStatuses,
    globalCascadeDefaults: settings.CascadeDefaults || JLG_CASCADE_DEFAULTS,
  };
}

// §10: offered after every save, whatever put the lines in a resolved status
// — manual, arrears entry, import, or template. Defaults to Yes but requires
// the click, and the WO never auto-closes; closing stays the manual action it
// has always been.
async function maybePromptReview(workOrderId, reviewPrompt) {
  if (!reviewPrompt?.ShouldPrompt || !reviewPrompt.ReviewStatus) return;
  const move = await confirmDialog(
    `All lines are resolved. Move this work order to ${reviewPrompt.ReviewStatus.Name}?`,
    { confirmLabel: `Move to ${reviewPrompt.ReviewStatus.Name}`, cancelLabel: 'Leave as is', danger: false }
  );
  if (!move) return;
  try {
    await api(`/api/pg/work-orders/${workOrderId}`, { method: 'PATCH', body: JSON.stringify({ statusId: reviewPrompt.ReviewStatus.Id }) });
    toast(`Moved to ${reviewPrompt.ReviewStatus.Name}`);
  } catch (err) { toast(err.message); }
}

async function renderNewWorkOrder({ assetId, assetName, templateId }) {
  setChrome({ title: 'New Work Order', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const [{ templates }, gridCtx] = await Promise.all([api('/api/pg/work-order-templates'), loadGridContext()]);
  const fieldTitles = state.options.propertyFields.map((f) => f.title);

  // Drafts are offered before the form is painted: if the user picks one up we
  // want to build the form already populated, not flash an empty one first.
  const savedDrafts = listNewWoDrafts();
  let chosenDraft = null;
  if (savedDrafts.length && !templateId) {
    const review = await confirmDialog(
      `${savedDrafts.length} saved draft${savedDrafts.length === 1 ? '' : 's'} found. Would you like to use one?`,
      { confirmLabel: 'Review drafts', cancelLabel: 'Create new work order', danger: false });
    if (review) chosenDraft = await pickWoDraft(savedDrafts);
  }

  const assetUpdateRowHtml = (row = {}) => `<div class="inline-add-row au-row" style="align-items:center">
    <select class="au-field" style="flex:1">${fieldTitles.map((t) => `<option ${row.targetField === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>
    <input class="au-value" placeholder="Value" value="${escapeHtml(row.newValue || '')}" style="flex:1" />
    <button type="button" class="btn btn-secondary row-remove">✕</button>
  </div>`;

  setApp(`
    <div class="card">
      <h3>New Work Order</h3>
      <form id="newWoForm">
        ${templates.length ? `<div class="field-row"><label>Start from Template (optional)</label>
          <select id="tplPicker"><option value="">— none —</option>${templates.map((t) => `<option value="${t.Id}" ${String(templateId) === String(t.Id) ? 'selected' : ''}>${escapeHtml(t.Name)}</option>`).join('')}</select>
        </div>` : ''}
        <div class="field-row"><label>Title</label><input name="title" required /></div>
        <div class="field-row"><label>Asset</label>
          ${assetId ? `<input value="${escapeHtml(assetName)}" disabled />` : `<div id="woAssetPicker"></div>`}
        </div>
        <div class="field-row"><label>Priority</label>
          <select name="priority"><option>Low</option><option selected>Medium</option><option>High</option><option>Urgent</option></select>
        </div>
        <div class="field-row"><label>Scheduled Date</label><input name="scheduledDate" type="date" />
          <p class="muted" style="margin-top:2px;font-size:0.8rem">Any line left without its own date uses this one.</p>
        </div>
        <div class="field-row"><label>Description</label><textarea name="description"></textarea></div>
        <div class="field-row"><label>Job Lines</label>
          <p class="muted" style="margin:2px 0 8px">One row per line — its own hours, cost, funding and responsibility. A vendor on the roof, volunteers on the deck, same work order.</p>
          <div id="woGrid"></div>
        </div>
        <details style="margin:16px 0">
          <summary style="cursor:pointer;font-weight:700">Also update asset fields (optional)</summary>
          <p class="muted" style="margin:8px 0">Only for the rare case this WO should change a stable asset fact — most work orders don't need this.</p>
          <div class="au-rows"></div>
          <button type="button" class="btn btn-secondary" id="addAuBtn" style="margin-top:6px">+ Add Field Update</button>
        </details>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Create Work Order</button>
          <button class="btn btn-secondary" type="button" id="saveWoDraftBtn">Save draft</button>
          <button class="btn btn-secondary" type="button" id="cancelWoBtn">Cancel</button>
        </div>
      </form>
    </div>`);

  const form = document.getElementById('newWoForm');
  let assetPicker = null;
  if (!assetId) assetPicker = mountAssetCombobox(document.getElementById('woAssetPicker'));

  // Resuming edits the slot it came from; starting fresh gets its own, so a new
  // attempt never overwrites a draft the user chose to leave alone.
  const draftKey = chosenDraft ? chosenDraft.key : newWoDraftKey();
  const gridHost = document.getElementById('woGrid');
  let grid = null;

  function headerState() {
    return {
      title: form.title.value, priority: form.priority.value,
      scheduledDate: form.scheduledDate.value, description: form.description.value,
    };
  }

  function buildGrid({ initialRows = null, cascadeConfig = null } = {}) {
    grid = mountJobLineGrid(gridHost, {
      woId: null,
      jobLineStatuses: gridCtx.jobLineStatuses,
      fundingOptions: gridCtx.fundingOptions,
      globalCascadeDefaults: gridCtx.globalCascadeDefaults,
      cascadeConfig,
      initialRows,
      draftKey,
      draftExtra: headerState,
    });
    return grid;
  }

  // §6: a draft found on arrival is offered, never silently applied — the
  // previous attempt might have been abandoned on purpose.
  // The choice was already made on the picker screen — just apply it.
  const draft = chosenDraft ? chosenDraft.draft : null;
  if (draft) {
    buildGrid({ initialRows: draft.rows, cascadeConfig: draft.cascadeConfig });
    if (draft.extra) {
      form.title.value = draft.extra.title || '';
      form.priority.value = draft.extra.priority || 'Medium';
      form.scheduledDate.value = draft.extra.scheduledDate || '';
      form.description.value = draft.extra.description || '';
    }
    toast('Draft restored');
  } else {
    buildGrid();
  }

  function wireRowRemove() { app.querySelectorAll('.au-row .row-remove').forEach((btn) => { btn.onclick = () => btn.closest('.inline-add-row').remove(); }); }
  document.getElementById('addAuBtn').addEventListener('click', () => {
    document.querySelector('.au-rows').insertAdjacentHTML('beforeend', assetUpdateRowHtml());
    wireRowRemove();
  });

  // §8: the same /from-template endpoint the scheduler will use — called with
  // dryRun, so picking a template prefills the grid without creating anything.
  async function applyTemplate(id) {
    if (!id) return;
    try {
      const result = await api('/api/pg/work-orders/from-template', { method: 'POST', body: JSON.stringify({ templateId: Number(id), dryRun: true }) });
      if (result.workOrder.title) form.title.value = result.workOrder.title;
      if (result.workOrder.priority) form.priority.value = result.workOrder.priority;
      if (result.workOrder.description) form.description.value = result.workOrder.description;
      buildGrid({
        initialRows: result.jobLines.map((l) => ({
          title: l.title, estHours: l.estimatedHours ?? '', estCost: l.estimatedCost ?? '',
          values: {
            responsibility_class: l.responsibilityClass,
            funding_source: fundingOptionValue(l.fundingSource, l.fundingRefId),
            scheduled_date: '',
          },
          pinned: l.pinnedFields,
        })),
      });
      document.querySelector('.au-rows').innerHTML = (result.template.AssetUpdateDefaults || []).map(assetUpdateRowHtml).join('');
      wireRowRemove();
      toast(`Prefilled from "${result.template.Name}" — review before creating`);
    } catch (err) { toast(err.message); }
  }
  document.getElementById('tplPicker')?.addEventListener('change', (e) => applyTemplate(e.target.value));
  if (templateId) await applyTemplate(templateId);

  document.getElementById('cancelWoBtn').addEventListener('click', goBack);

  // Explicit save, for when you know you're stopping. Autosave already runs on
  // a 2s debounce and flushes on the way out, so this is about certainty rather
  // than mechanism — it writes immediately and says so. headerState() rides
  // along via draftExtra, so a title with no lines yet still persists.
  document.getElementById('saveWoDraftBtn').addEventListener('click', () => {
    grid.saveDraftNow();
    // Saved is saved: don't warn about it on the way out.
    formDirty = false;
    toast('Draft saved — find it next time you open New Work Order');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const title = fd.get('title');
    const finalAssetId = assetId || assetPicker?.getSelected()?.Id;
    if (!finalAssetId) { toast('Pick an asset first (or add a new one)'); return; }
    if (grid.hasErrors()) { toast("Some imported cells didn't match — fix the red cells first"); return; }
    const jobLines = grid.getSaveLines();
    const woScheduledDate = fd.get('scheduledDate');
    const datesToCheck = [...new Set([woScheduledDate, ...jobLines.map((l) => l.scheduledDate)].filter(Boolean))];
    if (!await confirmVisitorConflicts(datesToCheck.map((date) => ({ date, assetId: finalAssetId })))) return;
    try {
      const result = await api('/api/pg/work-orders', { method: 'POST', body: JSON.stringify({
        title, assetId: Number(finalAssetId), priority: fd.get('priority'), description: fd.get('description'),
        scheduledDate: woScheduledDate || undefined, jobLines,
        assetUpdates: [...document.querySelectorAll('.au-row')].map((row) => ({
          targetField: row.querySelector('.au-field').value, newValue: row.querySelector('.au-value').value,
        })).filter((r) => r.newValue.trim()),
        cascadeConfig: grid.getCascadeConfig(),
      }) });
      grid.clearDraft();
      toast('Work order created');
      await maybePromptReview(result.workOrderId, result.reviewPrompt);
      go('workOrderDetail', { id: result.workOrderId }, { replace: true });
    } catch (err) { toast(err.message); }
  });
}

// Shows every saved new-WO draft with its job lines visible, so the choice is
// made by looking at the work rather than at a timestamp. Resolves with the
// chosen {key, draft}, or null for "start a fresh one". Drafts not acted on
// are left exactly where they are.
function pickWoDraft(initialDrafts) {
  return new Promise((resolve) => {
    let drafts = initialDrafts;

    const draftCard = ({ key, draft }) => {
      const lines = draftLineTitles(draft);
      const title = String(draft.extra?.title || '').trim();
      const shown = lines.slice(0, 12);
      return `
        <div class="card draft-card" data-key="${escapeHtml(key)}" style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
            <strong>${escapeHtml(title || '(no title yet)')}</strong>
            <span class="muted" style="font-size:0.85rem">saved ${escapeHtml(formatDraftAge(draft.savedAt))}</span>
          </div>
          ${draft.extra?.priority || draft.extra?.scheduledDate ? `<p class="muted" style="margin:4px 0 0;font-size:0.85rem">
            ${draft.extra?.priority ? `Priority: ${escapeHtml(draft.extra.priority)}` : ''}
            ${draft.extra?.scheduledDate ? ` · Scheduled: ${escapeHtml(draft.extra.scheduledDate)}` : ''}
          </p>` : ''}
          <p class="muted" style="margin:8px 0 4px">${lines.length} job line${lines.length === 1 ? '' : 's'}</p>
          ${lines.length ? `<ul style="margin:0 0 10px 18px;padding:0">
            ${shown.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}
            ${lines.length > shown.length ? `<li class="muted">…and ${lines.length - shown.length} more</li>` : ''}
          </ul>` : '<p class="muted" style="margin:0 0 10px">No job lines yet — header only.</p>'}
          <div class="btn-row">
            <button class="btn btn-primary draft-use" type="button">Use this draft</button>
            <button class="btn btn-secondary draft-discard" type="button">Discard</button>
          </div>
        </div>`;
    };

    const paint = () => {
      setApp(`
        <div class="screen">
          <h2>Saved drafts</h2>
          <p class="muted">${drafts.length} unfinished work order${drafts.length === 1 ? '' : 's'}. Pick one up, discard it, or start fresh — anything you leave alone stays here.</p>
          ${drafts.map(draftCard).join('')}
          <div class="btn-row" style="margin-top:16px">
            <button class="btn btn-primary" type="button" id="draftCreateNew">Create new work order</button>
          </div>
        </div>`);

      document.getElementById('draftCreateNew').addEventListener('click', () => resolve(null));

      app.querySelectorAll('.draft-card').forEach((card) => {
        const key = card.dataset.key;
        card.querySelector('.draft-use').addEventListener('click', () => {
          resolve(drafts.find((d) => d.key === key) || null);
        });
        card.querySelector('.draft-discard').addEventListener('click', async () => {
          const entry = drafts.find((d) => d.key === key);
          const n = entry ? draftLineTitles(entry.draft).length : 0;
          if (!await confirmDialog(
            `Discard this draft${n ? ` and its ${n} job line${n === 1 ? '' : 's'}` : ''}? This can't be undone.`,
            { confirmLabel: 'Discard draft', cancelLabel: 'Keep it', danger: true })) return;
          jlgClearDraft(key);
          drafts = drafts.filter((d) => d.key !== key);
          if (!drafts.length) { toast('Draft discarded'); resolve(null); return; }
          toast('Draft discarded');
          paint();
        });
      });
    };

    paint();
  });
}

function formatDraftAge(savedAt) {
  const mins = Math.round((Date.now() - (savedAt || 0)) / 60000);
  if (mins < 1) return 'moments ago';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return formatDateNice(new Date(savedAt).toISOString());
}

// The grid as an edit surface for a work order that already exists (§2). The
// WO's detail page keeps its card view for reading; this is where the whole
// line set gets reshaped at once.
async function renderEditWorkOrderLines({ id }) {
  setChrome({ title: 'Edit Job Lines', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const [detail, gridCtx] = await Promise.all([api(`/api/pg/work-orders/${id}`), loadGridContext()]);
  const wo = detail.workOrder;
  const jobLines = detail.jobLines;

  setApp(`
    <div class="card">
      <h3>WO ${escapeHtml(wo.WoNumber || wo.Id)} — ${escapeHtml(wo.Title)}</h3>
      <p class="muted">Edit every line at once. Lines you remove here are deleted when you save; the card view keeps notes, photos, crew and split.</p>
      <div id="woGrid"></div>
      <div class="btn-row">
        <button class="btn btn-primary" type="button" id="saveLinesBtn">Save Job Lines</button>
        <button class="btn btn-secondary" type="button" id="cancelLinesBtn">Cancel</button>
      </div>
    </div>`);

  const draftKey = jlgDraftKey(id);
  const gridHost = document.getElementById('woGrid');
  let grid = null;
  const build = (initialRows, cascadeConfig) => {
    grid = mountJobLineGrid(gridHost, {
      woId: id,
      jobLineStatuses: gridCtx.jobLineStatuses,
      fundingOptions: gridCtx.fundingOptions,
      globalCascadeDefaults: gridCtx.globalCascadeDefaults,
      cascadeConfig: cascadeConfig !== undefined ? cascadeConfig : wo.CascadeConfig,
      initialRows,
      draftKey,
      // The per-WO cascade override is a property of the work order, so it
      // persists the moment it's toggled rather than waiting for a save.
      onCascadeConfigChange: (cfg) => api(`/api/pg/work-orders/${id}/cascade-config`, {
        method: 'PATCH', body: JSON.stringify({ cascadeConfig: cfg }),
      }).catch((err) => toast(err.message)),
    });
  };

  const saved = jlgRowsFromJobLines(jobLines);
  const draft = jlgReadDraft(draftKey);
  if (draft && await confirmDialog(
    `You have unsaved changes to these job lines from ${formatDraftAge(draft.savedAt)}. Restore them?`,
    { confirmLabel: 'Restore draft', cancelLabel: 'Discard', danger: false })) {
    build(draft.rows, draft.cascadeConfig);
    toast('Draft restored');
  } else {
    if (draft) jlgClearDraft(draftKey);
    build(saved);
  }

  document.getElementById('cancelLinesBtn').addEventListener('click', () => {
    grid.clearDraft();
    go('workOrderDetail', { id }, { replace: true });
  });
  document.getElementById('saveLinesBtn').addEventListener('click', async () => {
    if (grid.hasErrors()) { toast("Some cells didn't match — fix the red cells first"); return; }
    const lines = grid.getSaveLines();
    const removed = grid.knownLineIds.filter((lineId) => !lines.some((l) => l.id === lineId));
    if (removed.length && !await confirmDialog(
      `${removed.length} job line${removed.length === 1 ? '' : 's'} will be deleted, along with their crew assignments and photos. Save anyway?`,
      { confirmLabel: 'Save and delete' })) return;
    const datesToCheck = [...new Set(lines.map((l) => l.scheduledDate).filter(Boolean))];
    if (wo.Asset?.Id && !await confirmVisitorConflicts(datesToCheck.map((date) => ({ date, assetId: wo.Asset.Id })))) return;
    try {
      const result = await withReopenPrompt((reopen) => api(`/api/pg/work-orders/${id}/job-lines`, {
        method: 'PUT',
        body: JSON.stringify({
          lines, knownLineIds: grid.knownLineIds,
          ...(reopen ? { reopenWorkOrder: true, reopenReason: reopen.reason } : {}),
        }),
      }));
      if (!result) { toast('Nothing saved — the work order is still closed'); return; }
      grid.clearDraft();
      toast(result.reopenedWorkOrder ? 'Reopened to Review, and job lines saved' : 'Job lines saved');
      await maybePromptReview(id, result.reviewPrompt);
      go('workOrderDetail', { id }, { replace: true });
    } catch (err) { toast(err.message, 5000); }
  });
}

// 'fund' added Build Brief v3 Part 1 (see migration 0053's header comment).
const FUNDING_SOURCE_LABELS = {
  operating_budget: 'Operating Budget', capital_campaign: 'Capital Campaign', cabin_holder: 'Cabin-Holder', other: 'Other', fund: 'Fund',
};
// Funding lives per-line. Source and ref are two columns in Postgres but one
// decision to a person, so both the grid's Funding Source column and the job
// line card present them as a single searchable list — buildFundingOptions
// flattens all five sources into it. Creating a brand new Capital Campaign
// Project / Cabin-Holder / Other category happens on the Capital Plan page
// (renderCapitalPlan), which already has full CRUD for all three — a job
// line just picks from what exists there.

// One job line's full edit surface — title/responsibility/funding/hours/cost/
// schedule up top (the 1.7 creation fields, still editable after), then
// complaint/cause/correction (1.6 — filled in during/after the work) and
// blocked state (columns land in Phase 1; the WO-level derived badge and
// close-gate logic are Phase 2), then its own crew and photos. Collapsed by
// default (<details>) so N lines on one WO doesn't turn the page into an
// unreadable wall on a phone.
function jobLineCardHtml(jl, { causesCatalog, jobLineStatuses }) {
  const selectedCauseIds = new Set((jl.Causes || []).map((c) => c.Id));
  const summaryBits = [
    RESPONSIBILITY_CLASS_LABELS[jl.ResponsibilityClass] || jl.ResponsibilityClass,
    jl.EstimatedCost != null ? `$${Number(jl.EstimatedCost).toLocaleString()} est.` : null,
    jl.EstimatedHours != null ? `${jl.EstimatedHours}h est.` : null,
    jl.ScheduledDate ? `Sched. ${formatDateNice(jl.ScheduledDate)}` : null,
    jl.BlockedReason ? '🚧 Blocked' : null,
  ].filter(Boolean).join(' · ');

  return `<details class="card jl-card" data-id="${jl.Id}">
    <summary style="cursor:pointer;display:flex;align-items:center;gap:10px;list-style:none">
      <input type="checkbox" class="jl-split-select" value="${jl.Id}" title="Select to split off into a new work order" onclick="event.stopPropagation()" style="width:18px;height:18px;flex-shrink:0" />
      ${statusPillHtml(jl.StatusName, jl.StatusColor)}
      <span style="flex:1;${jl.StatusIsTerminal ? 'text-decoration:line-through;color:var(--muted)' : ''}">
        <strong>${escapeHtml(jl.Title)}</strong>
        <div class="muted" style="font-weight:400;font-size:0.85rem">${summaryBits}</div>
      </span>
    </summary>
    <form class="jl-edit-form" style="margin-top:12px">
      <div class="field-row"><label>Status</label>
        <select class="jl-e-status">${jobLineStatuses.map((s) => `<option value="${s.Id}" data-requires-note="${s.RequiresNote}" data-note-label="${escapeHtml(s.NoteLabel || '')}" ${jl.StatusId === s.Id ? 'selected' : ''}>${escapeHtml(s.Name)}</option>`).join('')}</select>
      </div>
      <div class="field-row jl-e-status-note-row" hidden>
        <label class="jl-e-status-note-label">Note</label>
        <input class="jl-e-status-note" placeholder="Required for this status" />
      </div>
      <div class="field-row"><label>Title</label><input class="jl-e-title" value="${escapeHtml(jl.Title)}" required /></div>
      <div class="field-row"><label>Responsibility</label>
        <select class="jl-e-resp">${Object.entries(RESPONSIBILITY_CLASS_LABELS).map(([k, v]) => `<option value="${k}" ${jl.ResponsibilityClass === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </div>
      <div class="field-row"><label>Funding Source</label>
        <div class="jl-e-funding" data-value="${escapeHtml(fundingOptionValue(jl.FundingSource, jl.FundingRefId))}"></div>
      </div>
      <div class="field-row"><label>Estimated Hours</label><input class="jl-e-est-hours" type="number" step="any" min="0" value="${jl.EstimatedHours ?? ''}" /></div>
      <div class="field-row"><label>Actual Hours</label><input class="jl-e-act-hours" type="number" step="any" min="0" value="${jl.ActualHours ?? ''}" /></div>
      <div class="field-row"><label>Estimated Cost</label><input class="jl-e-est-cost" type="number" step="0.01" min="0" value="${jl.EstimatedCost ?? ''}" /></div>
      <div class="field-row"><label>Actual Cost</label><input class="jl-e-act-cost" type="number" step="0.01" min="0" value="${jl.ActualCost ?? ''}" />
        ${jl.LinkedExpenseCount ? `<p class="muted" style="margin-top:2px;font-size:0.8rem">+ $${jl.LinkedExpenseTotal.toLocaleString()} from ${jl.LinkedExpenseCount} linked expense${jl.LinkedExpenseCount === 1 ? '' : 's'} — this field is the manual/no-receipt amount only; totals elsewhere include both.</p>` : '<p class="muted" style="margin-top:2px;font-size:0.8rem">For costs with no receipt (invoice paid directly, donated materials). Link an expense instead when there is one.</p>'}
      </div>
      <div class="field-row"><label>Scheduled Date</label><input class="jl-e-scheduled-date" type="date" value="${(jl.ScheduledDate || '').slice(0, 10)}" /></div>
      <div class="field-row">
        <label>Start Time (optional)</label>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <input class="jl-e-start-time" type="time" value="${jl.ScheduledStartTime ? jl.ScheduledStartTime.slice(0, 5) : ''}" style="max-width:140px" />
          <input class="jl-e-duration-hours" type="number" min="0" step="any" placeholder="Duration (hrs)" value="${jl.ScheduledDurationHours ?? ''}" style="max-width:150px" />
        </div>
        <p class="muted" style="font-size:0.8rem;margin-top:4px">Leave both blank for an all-day calendar entry — plenty of work is genuinely "sometime Tuesday." Set both to sync a timed event.</p>
      </div>
      <div class="field-row"><label>Complaint</label><textarea class="jl-e-complaint" placeholder="What's wrong?">${escapeHtml(jl.Complaint || '')}</textarea></div>
      <div class="field-row"><label>Cause</label>
        <div class="skill-chips">${causesCatalog.map((c) => `<label class="skill-chip ${selectedCauseIds.has(c.Id) ? 'selected' : ''}" style="cursor:pointer"><input type="checkbox" class="jl-e-cause" value="${c.Id}" style="margin-right:6px" ${selectedCauseIds.has(c.Id) ? 'checked' : ''} />${escapeHtml(c.Name)}</label>`).join('')}</div>
        <p class="muted" style="font-size:0.8rem;margin-top:4px">The dropdown is what gets counted. Add "Unknown" rather than guessing.</p>
      </div>
      <div class="field-row"><label>Cause Note</label><textarea class="jl-e-cause-note" placeholder="Freetext detail — never becomes a new cause option">${escapeHtml(jl.CauseNote || '')}</textarea></div>
      <div class="field-row"><label>Correction</label><textarea class="jl-e-correction" placeholder="What was done to fix it?">${escapeHtml(jl.Correction || '')}</textarea></div>
      <div class="field-row"><label>Blocked Reason</label><input class="jl-e-blocked-reason" value="${escapeHtml(jl.BlockedReason || '')}" placeholder="Leave blank if not blocked" /></div>
      <div class="field-row"><label>Blocked Since</label><input class="jl-e-blocked-since" type="date" value="${(jl.BlockedSince || '').slice(0, 10)}" /></div>
      <div class="field-row"><label>Board Report</label>
        <label class="skill-chip ${jl.BoardFocus ? 'selected' : ''}" style="cursor:pointer;display:inline-flex"><input type="checkbox" class="jl-e-board-focus" style="margin-right:6px" ${jl.BoardFocus ? 'checked' : ''} />Include on board report</label>
        <p class="muted" style="margin:4px 0 0;font-size:0.8rem">Done if this line is finished, Coming Up if it isn't. Clears when a report carrying it is published.</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary jl-save-btn" type="submit">Save Line</button>
        <button class="btn btn-secondary jl-delete-btn" type="button" data-label="${escapeHtml(jl.Title)}">Delete Line</button>
      </div>
    </form>

    <div style="margin-top:14px">
      <h4 style="margin-bottom:6px">Assigned to this line</h4>
      ${(jl.volunteers || []).map((v) => `<div class="list-item" style="cursor:default"><span>👷 ${escapeHtml(v.Name)}</span><button class="btn btn-secondary jl-unassign-vol" data-id="${v.Id}" data-name="${escapeHtml(v.Name)}">Remove</button></div>`).join('')}
      ${(jl.vendors || []).map((v) => `<div class="list-item" style="cursor:default"><span>🔧 ${escapeHtml(v.Name)}</span><button class="btn btn-secondary jl-unassign-ven" data-id="${v.Id}" data-name="${escapeHtml(v.Name)}">Remove</button></div>`).join('')}
      ${!(jl.volunteers || []).length && !(jl.vendors || []).length ? '<p class="muted">None assigned.</p>' : ''}
      <div class="field-row"><div class="jl-assign-picker"
        data-exclude-vol="${(jl.volunteers || []).map((v) => v.Id).join(',')}"
        data-exclude-ven="${(jl.vendors || []).map((v) => v.Id).join(',')}"></div></div>
    </div>

    <div style="margin-top:14px" id="jlPhotos-${jl.Id}"></div>
  </details>`;
}

async function renderWorkOrderDetail({ id }, container = app) {
  if (container === app) setChrome({ title: 'Work Order', showBack: true, showLogout: true });
  container.innerHTML = LOADING_HTML;
  const [detail, allVolunteers, allVendors, skillsRes, tplRes, campaignRes, cabinRes, otherRes, causesRes, fundsRes] = await Promise.all([
    api(`/api/pg/work-orders/${id}`), api('/api/pg/volunteers'), api('/api/pg/vendors'), api('/api/pg/skills'),
    api('/api/pg/checklist-templates'),
    api('/api/pg/budget/capital-campaign-projects'), api('/api/pg/budget/cabin-holders'), api('/api/pg/budget/other-categories'),
    api('/api/pg/causes'), api('/api/pg/funds'),
  ]);
  const allSkills = skillsRes.skills.map((s) => s.Name);
  const checklistTemplates = tplRes.templates;
  const fundingOptions = buildFundingOptions({ capital_campaign: campaignRes.items, cabin_holder: cabinRes.items, other: otherRes.items, fund: fundsRes.funds });
  const causesCatalog = causesRes.causes;
  const { workOrder: wo, rollup, crewRoster, closeGate, assetUpdates, jobLines, checklist, logEntries, crewSessions } = detail;
  const propertyFieldTitles = state.options.propertyFields.map((f) => f.title);
  // Job-line pickers (assign-crew, crew-session attendee union) read the full
  // roster off `state` rather than threading it through every helper — same
  // trick the rest of this file uses for state.options.
  state._allVolunteers = allVolunteers.volunteers;
  state._allVendors = allVendors.vendors;

  const workOrderStatuses = state.options.workOrderStatuses; // admin-editable (2.2) — never hardcode this list
  const jobLineStatuses = state.options.jobLineStatuses; // admin-editable (2.1)

  // jobLineStatuses must be declared above this — jobLineCardHtml reads it
  // immediately, and .map()'s callback only skips evaluating it when
  // jobLines is empty, which is exactly why this latent TDZ bug (declared
  // below its use) stayed invisible until a work order actually had a job
  // line on it. Found live, 2026-09-14, while smoke-testing this file's own
  // schedule-time fields.
  const jobLineRows = jobLines.map((jl) => jobLineCardHtml(jl, { causesCatalog, jobLineStatuses })).join('')
    || '<p class="muted">No job lines yet — add the scope of work below.</p>';
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


  // Read-only rollup — hours/cost/funding/schedule now live on job lines
  // (Phase 1); this is workOrderRollup() surfaced, never editable directly.
  const rollupHtml = `
    <div class="card">
      <h4 style="margin-top:0">Rollup (from ${rollup.LineCount} job line${rollup.LineCount === 1 ? '' : 's'})</h4>
      <p class="muted" style="margin:-4px 0 8px">
        ${rollup.EstimatedCost ? `$${rollup.EstimatedCost.toLocaleString()} est.` : 'No cost estimated yet'}${rollup.ActualCost ? ` · $${rollup.ActualCost.toLocaleString()} actual` : ''}
        · ${rollup.EstimatedHours || 0}h est.${rollup.ActualHours ? ` · ${rollup.ActualHours}h actual` : ''}
      </p>
      ${rollup.FundingBreakdown.length ? `<div class="muted" style="font-size:0.85rem">
        ${rollup.FundingBreakdown.map((f) => `${FUNDING_SOURCE_LABELS[f.FundingSource] || f.FundingSource}${f.FundingRefLabel ? ` (${escapeHtml(f.FundingRefLabel)})` : ''}: $${f.Cost.toLocaleString()}`).join(' · ')}
      </div>` : ''}
      ${rollup.EarliestScheduledDate ? `<p class="muted" style="margin-bottom:0"><a href="#" id="viewOnCalendarLink">📅 Earliest scheduled line: ${formatDateNice(rollup.EarliestScheduledDate)}</a></p>` : ''}
    </div>`;

  container.innerHTML = `
    ${(closeGate.ReadyToClose && !wo.StatusIsTerminal) ? `
    <div class="card" style="border:1px solid #22c55e66;background:#22c55e0d">
      <strong>All job lines are finished.</strong>
      <p class="muted" style="margin:4px 0 8px">Review the costs above and use "Complete Work Order" below when ready — closing is never automatic.</p>
    </div>` : ''}
    <div class="card">
      <h3>WO ${escapeHtml(wo.WoNumber || wo.Id)} — ${escapeHtml(wo.Title)}</h3>
      <form id="woFieldsForm">
        <div class="field-row"><label>Asset</label><div id="woAssetPicker"></div></div>
        <div class="field-row"><label>Status</label>
          <select name="statusId" id="woStatusSelect">${workOrderStatuses.map((s) => `<option value="${s.Id}" ${wo.StatusId === s.Id ? 'selected' : ''}>${escapeHtml(s.Name)}</option>`).join('')}</select>
        </div>
        <div class="field-row" id="deferredFieldsRow" ${workOrderStatuses.find((s) => s.Id === wo.StatusId)?.Name === 'Deferred' ? '' : 'hidden'}>
          <label>Deferred Reason</label><input name="deferredReason" value="${escapeHtml(wo.DeferredReason || '')}" placeholder="Why is this being deferred?" />
          <label style="margin-top:8px">Revisit Date</label><input name="revisitDate" type="date" value="${(wo.RevisitDate || '').slice(0, 10)}" />
        </div>
        ${wo.IsBlocked ? `<p class="muted">🚧 Blocked — see the blocked job line below for the reason.</p>` : ''}
        <div class="field-row"><label>Priority</label>
          <select name="priority">${['Low', 'Medium', 'High', 'Urgent'].map((s) => `<option ${wo.Priority === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </div>
        <div class="field-row"><label>Board Report</label>
          <label class="skill-chip ${wo.BoardFocus ? 'selected' : ''}" style="cursor:pointer;display:inline-flex"><input type="checkbox" name="boardFocus" style="margin-right:6px" ${wo.BoardFocus ? 'checked' : ''} />Include on board report</label>
          <p class="muted" style="margin:4px 0 0;font-size:0.8rem">Puts this on the next draft whatever the dates say — in Done if it's finished, in Coming Up if it isn't. Clears when a report carrying it is published.</p>
        </div>
        <div class="field-row"><label>Description</label><textarea name="description">${escapeHtml(wo.Description || '')}</textarea></div>
        <button class="btn btn-secondary" type="submit">Save Changes</button>
      </form>
      <div class="btn-row">
        <button class="btn btn-primary" id="completeWoBtn" ${wo.StatusIsTerminal ? 'disabled' : ''}>${wo.StatusIsTerminal ? wo.Status : 'Complete Work Order'}</button>
        ${wo.StatusIsTerminal ? '<button class="btn btn-secondary" id="reopenWoBtn">Reopen</button>' : ''}
        <a class="btn btn-secondary" href="/api/pg/work-orders/${id}/scope-pdf" target="_blank" rel="noopener" title="A printable job description to hand a vendor or volunteer — no cost figures included">🖨️ Scope of Work (PDF)</a>
        <button class="btn btn-secondary" id="duplicateWoBtn">Duplicate</button>
        <button class="btn btn-secondary" id="saveAsTemplateBtn" title="Snapshot these job lines as a reusable template — no statuses, no dates">Save as Template</button>
        <button class="btn btn-secondary" id="familyBtn">Family</button>
      </div>
      <div id="familyPanel" hidden></div>
    </div>

    ${rollupHtml}

    <div class="card">
      <h3>Documents</h3>
      <p class="muted">Whole-job attachments not tied to one line — permits, invoices, warranty docs. Work photos belong on the job line they're proof of, below.</p>
      <div id="woPhotosCard"></div>
    </div>

    <div class="card">
      <h3>Job Lines</h3>
      <p class="muted">The unit of work — hours, cost, funding, responsibility, and scope all live on the line. A vendor on the roof, volunteers on the deck, one work order. Check lines above and use Split to move them into a new sibling work order (e.g. the roof needs a specialist, the deck doesn't).</p>
      <div class="btn-row">
        ${!wo.StatusIsTerminal ? `<button type="button" class="btn btn-secondary" id="editLinesBtn" ${window.innerWidth < GRID_MIN_WIDTH ? 'hidden' : ''}>✎ Edit lines in grid</button>` : ''}
        ${jobLines.length > 1 ? `<button type="button" class="btn btn-secondary" id="reorderLinesBtn">↕ Reorder</button>` : ''}
        ${!wo.StatusIsTerminal ? `<button type="button" class="btn btn-secondary" id="splitLinesBtn">Split Selected Lines Into New WO</button>` : ''}
      </div>
      ${window.innerWidth < GRID_MIN_WIDTH ? `<p class="muted" style="font-size:0.85rem;margin:2px 0 10px">
        Each line opens below for status, notes and photos. Editing several at once — costs,
        funding, dates across the whole job — is easier in the grid on a desktop.
      </p>` : ''}
      ${jobLineRows}
      <div class="card" style="margin-top:10px;background:transparent;border:1px dashed var(--border,#ccc)">
        <h4 style="margin-top:0">+ Add Job Line</h4>
        <form id="addJlForm">
          <div class="field-row"><label>Title</label><input name="title" placeholder="e.g. Roof repair" required /></div>
          <div class="field-row"><label>Responsibility</label>
            <select name="responsibilityClass">${Object.entries(RESPONSIBILITY_CLASS_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          </div>
          <button class="btn btn-primary" type="submit">Add Job Line</button>
        </form>
      </div>
    </div>

    <div class="card">
      <h3>Work Log</h3>
      <p class="muted">What's been done, hours worked, and status updates over the life of this work order.</p>
      ${logRows}
      <form id="addLogEntryForm" style="margin-top:10px">
        <div class="field-row"><label>Note</label><textarea name="note" required placeholder="What did you do?"></textarea></div>
        <div class="field-row"><label>Hours (optional)</label><input name="hours" type="number" step="any" min="0" /></div>
        <div class="field-row"><label>Update Status To (optional)</label>
          <select name="statusChange"><option value="" selected>— no change —</option>${workOrderStatuses.filter((s) => s.Name !== 'Deferred').map((s) => `<option>${escapeHtml(s.Name)}</option>`).join('')}</select>
          <p class="muted" style="font-size:0.8rem;margin-top:4px">Deferring requires a reason and revisit date — use the Status field above for that.</p>
        </div>
        <button class="btn btn-primary" type="submit">Add Log Entry</button>
      </form>
    </div>

    ${checklistHtml}

    <details class="card">
      <summary style="cursor:pointer;font-weight:700">Also update asset fields (optional)</summary>
      <p class="muted" style="margin-top:8px">Only for the rare case this WO should change a stable asset fact (e.g. Window Count after installing new windows) — most work orders don't need this.</p>
      ${fieldUpdateRows}
      <form id="addAssetUpdateForm" style="margin-top:10px">
        <div class="field-row"><label>Field</label><select name="targetField" required><option value="">— select —</option>${propertyFieldTitles.map((t) => `<option>${escapeHtml(t)}</option>`).join('')}</select></div>
        <div class="field-row"><label>New Value</label><input name="newValue" required /></div>
        <button class="btn btn-secondary" type="submit">Add Field Update</button>
      </form>
    </details>

    <div class="card">
      <h3>Crew Sessions</h3>
      <p class="muted">Attendance-based hours — who was here, and for how long, each time work happened on this job. Feeds the Hours report.</p>
      ${crewSessionRows}
      ${(crewRoster.volunteers.length || crewRoster.vendors.length) ? `
      <form id="addCrewSessionForm" style="margin-top:10px">
        <div class="field-row"><label>Date</label><input name="sessionDate" type="date" value="${isoDate(new Date())}" required /></div>
        <div class="field-row"><label>Hours (optional)</label><input name="hours" type="number" step="any" min="0" /></div>
        <div class="field-row"><label>Job Line (optional)</label>
          <select name="jobLineId"><option value="">— general WO time —</option>${jobLines.map((jl) => `<option value="${jl.Id}">${escapeHtml(jl.Title)}</option>`).join('')}</select>
        </div>
        <div class="field-row"><label>Who was here?</label>
          <div class="skill-chips" id="sessionAttendeeChips">
            ${crewRoster.volunteers.map((v) => `<span class="skill-chip crew-attendee-chip" data-kind="vol" data-id="${v.Id}">${escapeHtml(v.Name)}</span>`).join('')}
            ${crewRoster.vendors.map((v) => `<span class="skill-chip crew-attendee-chip" data-kind="ven" data-id="${v.Id}">${escapeHtml(v.Name)}</span>`).join('')}
          </div>
        </div>
        <div class="field-row"><label>Note (optional)</label><input name="note" placeholder="Anything worth noting" /></div>
        <button class="btn btn-primary" type="submit">Log Session</button>
      </form>` : '<p class="muted">Assign crew to a job line above before logging a session.</p>'}
    </div>`;

  const assetPicker = mountAssetCombobox(container.querySelector('#woAssetPicker'), { initialAsset: wo.Asset });

  const boardFocusCheckbox = container.querySelector('input[name="boardFocus"]');
  boardFocusCheckbox?.addEventListener('change', () => {
    boardFocusCheckbox.closest('.skill-chip').classList.toggle('selected', boardFocusCheckbox.checked);
  });

  container.querySelector('#woStatusSelect').addEventListener('change', (e) => {
    const statusName = workOrderStatuses.find((s) => s.Id === Number(e.target.value))?.Name;
    container.querySelector('#deferredFieldsRow').hidden = statusName !== 'Deferred';
  });

  container.querySelector('#woFieldsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!await confirmDialog('Save changes to this work order?')) return;
    const fd = new FormData(e.target);
    const newAsset = assetPicker.getSelected();
    try {
      const saved = await withOpenLinePrompt((resolveOpenLines) => api(`/api/pg/work-orders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          assetId: newAsset ? newAsset.Id : (wo.Asset ? wo.Asset.Id : ''),
          statusId: Number(fd.get('statusId')), priority: fd.get('priority'), description: fd.get('description'),
          deferredReason: fd.get('deferredReason') || undefined, revisitDate: fd.get('revisitDate') || undefined,
          boardFocus: fd.has('boardFocus'),
          ...(resolveOpenLines ? { resolveOpenLines: true } : {}),
        }),
      }));
      if (!saved) { toast('Left unchanged — the work order is still open'); return; }
      toast('Work order updated');
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message, 5000); }
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
    const d = new Date(rollup.EarliestScheduledDate);
    go('calendar', { month: d.getMonth(), year: d.getFullYear(), date: isoDate(d), fromWorkOrderId: id, fromWorkOrderTitle: wo.Title });
  });

  container.querySelector('#editLinesBtn')?.addEventListener('click', () => go('editWorkOrderLines', { id }));

  // §7's mobile reorder: titles only, one row each, big arrow buttons, no
  // touch drag — and one request on Done rather than a write per tap.
  container.querySelector('#reorderLinesBtn')?.addEventListener('click', () => {
    let order = jobLines.map((jl) => ({ Id: jl.Id, Title: jl.Title }));
    const sheet = document.createElement('div');
    sheet.className = 'reorder-sheet';
    const draw = () => {
      sheet.innerHTML = `
        <div class="reorder-head">
          <button type="button" class="reorder-cancel" aria-label="Cancel">✕</button>
          <h3>Reorder job lines</h3>
          <button type="button" class="btn btn-primary btn-small reorder-done">Done</button>
        </div>
        <div class="reorder-list">
          ${order.map((l, i) => `<div class="reorder-row">
            <span class="reorder-title">${escapeHtml(l.Title)}</span>
            <button type="button" class="reorder-move" data-dir="-1" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
            <button type="button" class="reorder-move" data-dir="1" data-i="${i}" ${i === order.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          </div>`).join('')}
        </div>`;
      sheet.querySelectorAll('.reorder-move').forEach((btn) => btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        const j = i + Number(btn.dataset.dir);
        if (j < 0 || j >= order.length) return;
        [order[i], order[j]] = [order[j], order[i]];
        draw();
      }));
      sheet.querySelector('.reorder-cancel').addEventListener('click', () => sheet.remove());
      sheet.querySelector('.reorder-done').addEventListener('click', async () => {
        try {
          await api(`/api/pg/work-orders/${id}/job-lines/reorder`, { method: 'POST', body: JSON.stringify({ orderedIds: order.map((l) => l.Id) }) });
          sheet.remove();
          toast('Order saved');
          renderWorkOrderDetail({ id }, container);
        } catch (err) { toast(err.message); }
      });
    };
    draw();
    document.body.appendChild(sheet);
  });

  container.querySelector('#saveAsTemplateBtn')?.addEventListener('click', async () => {
    const name = window.prompt('Name this template', wo.Title || '');
    if (name == null || !name.trim()) return;
    try {
      const { template } = await api(`/api/pg/work-orders/${id}/save-as-template`, { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      toast(`Saved template "${template.Name}" — ${template.Lines.length} line${template.Lines.length === 1 ? '' : 's'}`);
    } catch (err) { toast(err.message); }
  });

  container.querySelector('#splitLinesBtn')?.addEventListener('click', async () => {
    const jobLineIds = [...container.querySelectorAll('.jl-split-select:checked')].map((el) => Number(el.value));
    if (!jobLineIds.length) { toast('Check at least one job line first'); return; }
    if (!await confirmDialog(`Split ${jobLineIds.length} line(s) into a new sibling work order? Their hours, cost, crew, status, and photos move with them.`, { confirmLabel: 'Split' })) return;
    try {
      const result = await api(`/api/pg/work-orders/${id}/split`, { method: 'POST', body: JSON.stringify({ jobLineIds }) });
      toast(`Created WO ${result.woNumber}`);
      go('workOrderDetail', { id: result.workOrderId });
    } catch (err) { toast(err.message); }
  });

  container.querySelector('#familyBtn')?.addEventListener('click', async () => {
    const panel = container.querySelector('#familyPanel');
    if (!panel.hidden) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.innerHTML = LOADING_HTML;
    const family = await api(`/api/pg/work-orders/${id}/family`);
    if (family.Members.length < 2) {
      panel.innerHTML = '<p class="muted" style="margin-top:8px">This work order has never been split — it\'s its own family of one.</p>';
      return;
    }
    panel.innerHTML = `
      <div class="card" style="margin-top:8px;background:transparent">
        <p class="muted">Combined across the whole family: <strong>$${family.TotalCost.toLocaleString()}</strong> · <strong>${family.TotalHours}h</strong></p>
        ${family.Members.map((m) => `
          <div class="list-item family-member-link" data-id="${m.Id}" style="cursor:pointer">
            <span>WO ${escapeHtml(m.WoNumber)}${m.Id === Number(id) ? ' (this one)' : ''} — ${escapeHtml(m.Title)}</span>
            ${statusPillHtml(m.Status, m.StatusColor)}
          </div>`).join('')}
      </div>`;
    panel.querySelectorAll('.family-member-link').forEach((el) => el.addEventListener('click', () => go('workOrderDetail', { id: el.dataset.id })));
  });

  container.querySelector('#addJlForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const added = await withReopenPrompt((reopen) => api(`/api/pg/work-orders/${id}/job-lines`, {
        method: 'POST',
        body: JSON.stringify({
          title: fd.get('title'), responsibilityClass: fd.get('responsibilityClass'),
          ...(reopen ? { reopenWorkOrder: true, reopenReason: reopen.reason } : {}),
        }),
      }));
      if (!added) { toast('Nothing added — the work order is still closed'); return; }
      if (added.jobLine?.ReopenedWorkOrder) toast('Reopened to Review, and the line was added');
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message, 5000); }
  });

  container.querySelectorAll('.jl-card').forEach((card) => {
    const jlId = card.dataset.id;
    const jl = jobLines.find((l) => String(l.Id) === jlId);

    const statusSelect = card.querySelector('.jl-e-status');
    const statusNoteRow = card.querySelector('.jl-e-status-note-row');
    function syncStatusNoteVisibility() {
      const opt = statusSelect.selectedOptions[0];
      const requiresNote = opt?.dataset.requiresNote === 'true';
      statusNoteRow.hidden = !requiresNote;
      statusNoteRow.querySelector('.jl-e-status-note-label').textContent = opt?.dataset.noteLabel || 'Note';
      statusNoteRow.querySelector('.jl-e-status-note').placeholder = opt?.dataset.noteLabel || 'Required for this status';
    }
    statusSelect.addEventListener('change', syncStatusNoteVisibility);
    syncStatusNoteVisibility();

    // §9: one searchable list across all five funding sources, same component
    // and same option set the grid's Funding Source column uses — the two
    // stacked selects it replaces made picking one of ~300 cabin holders a
    // scroll rather than a search.
    const fundingMount = card.querySelector('.jl-e-funding');
    const fundingCbx = mountCombobox(fundingMount, {
      options: fundingOptions,
      value: fundingMount.dataset.value,
      placeholder: 'Operating Budget',
      emptyText: 'No funding source matches',
    });

    card.querySelectorAll('.jl-e-cause').forEach((cb) => cb.addEventListener('change', () => {
      cb.closest('.skill-chip').classList.toggle('selected', cb.checked);
    }));
    const jlFocusCb = card.querySelector('.jl-e-board-focus');
    jlFocusCb?.addEventListener('change', () => {
      jlFocusCb.closest('.skill-chip').classList.toggle('selected', jlFocusCb.checked);
    });

    card.querySelector('.jl-edit-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const newActualCost = card.querySelector('.jl-e-act-cost').value;
      const origActualCost = jl.ActualCost != null ? String(jl.ActualCost) : '';
      if (jl.LinkedExpenseCount && newActualCost.trim() !== '' && newActualCost !== origActualCost) {
        const ok = await confirmDialog(
          `This line already has ${jl.LinkedExpenseCount} linked expense${jl.LinkedExpenseCount === 1 ? '' : 's'} totaling $${jl.LinkedExpenseTotal.toLocaleString()} — manual cost is added on top, not instead. Continue?`,
          { confirmLabel: 'Continue', danger: false },
        );
        if (!ok) return;
      }
      const newScheduledDate = card.querySelector('.jl-e-scheduled-date').value;
      if (newScheduledDate && newScheduledDate !== (jl.ScheduledDate || '').slice(0, 10)
          && !await confirmVisitorConflicts([{ date: newScheduledDate, jobLineId: jlId }])) return;
      const causeIds = [...card.querySelectorAll('.jl-e-cause:checked')].map((cb) => Number(cb.value));
      try {
        const saved = await withReopenPrompt((reopen) => api(`/api/pg/job-lines/${jlId}`, { method: 'PATCH', body: JSON.stringify({
          ...(reopen ? { reopenWorkOrder: true, reopenReason: reopen.reason } : {}),
          title: card.querySelector('.jl-e-title').value.trim(),
          statusId: Number(statusSelect.value), statusNote: card.querySelector('.jl-e-status-note').value,
          responsibilityClass: card.querySelector('.jl-e-resp').value,
          fundingSource: parseFundingOptionValue(fundingCbx.getValue() || fundingMount.dataset.value).source,
          fundingRefId: parseFundingOptionValue(fundingCbx.getValue() || fundingMount.dataset.value).refId ?? '',
          estimatedHours: card.querySelector('.jl-e-est-hours').value,
          actualHours: card.querySelector('.jl-e-act-hours').value,
          estimatedCost: card.querySelector('.jl-e-est-cost').value,
          actualCost: card.querySelector('.jl-e-act-cost').value,
          scheduledDate: card.querySelector('.jl-e-scheduled-date').value,
          scheduledStartTime: card.querySelector('.jl-e-start-time').value,
          scheduledDurationHours: card.querySelector('.jl-e-duration-hours').value,
          complaint: card.querySelector('.jl-e-complaint').value,
          causeNote: card.querySelector('.jl-e-cause-note').value,
          correction: card.querySelector('.jl-e-correction').value,
          blockedReason: card.querySelector('.jl-e-blocked-reason').value,
          blockedSince: card.querySelector('.jl-e-blocked-since').value,
          boardFocus: card.querySelector('.jl-e-board-focus').checked,
          causeIds,
        }) }));
        if (!saved) { toast('Nothing saved — the work order is still closed'); return; }
        toast(saved.jobLine?.ReopenedWorkOrder ? 'Reopened to Review, and the line was saved' : 'Job line saved');
        renderWorkOrderDetail({ id }, container);
      } catch (err) { toast(err.message); }
    });
    card.querySelector('.jl-delete-btn').addEventListener('click', async () => {
      if (!await confirmDialog(`Delete job line "${card.querySelector('.jl-delete-btn').dataset.label}"? This removes its hours, cost, and crew assignments too.`)) return;
      try {
        const gone = await withReopenPrompt((reopen) => api(`/api/pg/job-lines/${jlId}`, {
          method: 'DELETE',
          body: JSON.stringify(reopen ? { reopenWorkOrder: true, reopenReason: reopen.reason } : {}),
        }));
        if (!gone) { toast('Nothing deleted — the work order is still closed'); return; }
        if (gone.reopenedWorkOrder) toast('Reopened to Review, and the line was deleted');
        renderWorkOrderDetail({ id }, container);
      }
      catch (err) { toast(err.message); }
    });

    const assignMount = card.querySelector('.jl-assign-picker');
    const excluded = (attr) => new Set(assignMount.dataset[attr].split(',').filter(Boolean));
    const excludedVol = excluded('excludeVol');
    const excludedVen = excluded('excludeVen');
    mountCombobox(assignMount, {
      options: [
        ...(state._allVolunteers || []).filter((v) => !excludedVol.has(String(v.Id))).map((v) => ({ value: `vol:${v.Id}`, label: `👷 ${v.Name}` })),
        ...(state._allVendors || []).filter((v) => !excludedVen.has(String(v.Id))).map((v) => ({ value: `ven:${v.Id}`, label: `🔧 ${v.Name}` })),
      ],
      placeholder: '— assign volunteer or vendor —',
      emptyText: 'Nobody matches',
      onSelect: async (opt) => {
        if (!opt) return;
        const [kind, entId] = String(opt.value).split(':');
        try {
          if (kind === 'vol') await api(`/api/pg/job-lines/${jlId}/volunteers`, { method: 'POST', body: JSON.stringify({ volunteerId: Number(entId) }) });
          else await api(`/api/pg/job-lines/${jlId}/vendors`, { method: 'POST', body: JSON.stringify({ vendorId: Number(entId) }) });
          renderWorkOrderDetail({ id }, container);
        } catch (err) { toast(err.message); }
      },
    });
    card.querySelectorAll('.jl-unassign-vol').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog(`Remove ${btn.dataset.name} from this line?`)) return;
      await api(`/api/pg/job-lines/${jlId}/volunteers/${btn.dataset.id}`, { method: 'DELETE' });
      renderWorkOrderDetail({ id }, container);
    }));
    card.querySelectorAll('.jl-unassign-ven').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await confirmDialog(`Remove ${btn.dataset.name} from this line?`)) return;
      await api(`/api/pg/job-lines/${jlId}/vendors/${btn.dataset.id}`, { method: 'DELETE' });
      renderWorkOrderDetail({ id }, container);
    }));

    renderAttachmentSection('job_line', jlId, card.querySelector(`#jlPhotos-${jlId}`), { title: 'Photos', defaultRoleName: 'During' });
  });

  renderAttachmentSection('work_order', id, container.querySelector('#woPhotosCard'), { title: 'Documents', defaultRoleName: 'Documentation', accept: 'image/*,application/pdf' });

  container.querySelector('#addLogEntryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const note = fd.get('note').trim();
    if (!note) return;
    try {
      const saved = await withOpenLinePrompt((resolveOpenLines) => api(`/api/pg/work-orders/${id}/log`, {
        method: 'POST',
        body: JSON.stringify({
          note, hours: fd.get('hours') || undefined, statusChange: fd.get('statusChange') || undefined,
          ...(resolveOpenLines ? { resolveOpenLines: true } : {}),
        }),
      }));
      if (!saved) { toast('Left unchanged — the work order is still open'); return; }
      toast('Log entry added');
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message, 5000); }
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
        workOrderId: Number(id), jobLineId: fd.get('jobLineId') || undefined,
        sessionDate: fd.get('sessionDate'), hours: fd.get('hours') || undefined, note: fd.get('note') || undefined,
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

  container.querySelector('#reopenWoBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog('Reopen this work order? It moves to Review so it can be edited. Job line statuses are left exactly as they are.',
      { confirmLabel: 'Reopen', cancelLabel: 'Cancel', danger: false })) return;
    const reason = await promptDialog('Why are you reopening it? (optional)', { multiline: true, confirmLabel: 'Reopen' });
    if (reason === null) return;
    try {
      await api(`/api/pg/work-orders/${id}/reopen`, { method: 'POST', body: JSON.stringify({ reason: reason || null }) });
      toast('Reopened — now in Review');
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message, 5000); }
  });

  container.querySelector('#completeWoBtn').addEventListener('click', async () => {
    if (!await confirmDialog(`Complete this Work Order? Any pending "asset field update" entries will be written to "${wo.Asset?.Name || 'the asset'}" immediately — this directly changes real asset data.`)) return;
    // Open lines are settled BEFORE the leftovers prompt: that prompt records real
    // stock movements, and it must not do so for a close the operator then cancels.
    // The server's 409 remains the authority — this only asks early enough to be
    // useful, using the lines already on screen.
    let resolveOpenLines = false;
    const open = jobLines.filter((l) => !l.StatusIsTerminal);
    if (open.length) {
      const shown = open.slice(0, 6).map((l) => `• ${l.Title} — ${l.StatusName}`).join('\n');
      const more = open.length > 6 ? `\n…and ${open.length - 6} more` : '';
      const ok = await confirmDialog(
        `${open.length} line${open.length === 1 ? ' is' : 's are'} still open. Mark ${open.length === 1 ? 'it' : 'them'} complete too?\n\n${shown}${more}\n\nThey will be marked Done and dated to this work order\u2019s completion date.`,
        { confirmLabel: `Yes, mark ${open.length === 1 ? 'it' : 'them'} complete`, cancelLabel: 'Cancel', danger: false },
      );
      if (!ok) { toast('Left unchanged — the work order is still open'); return; }
      resolveOpenLines = true;
    }
    // Asked before completing, not after: a closed work order with its leftovers
    // unrecorded is the state nobody goes back to fix. Returns true immediately when
    // this WO bought no tracked materials, so an ordinary close is unchanged.
    if (!await promptLeftoversOnClose(id)) return;
    try {
      const done = await withOpenLinePrompt((retryResolve) => api(`/api/pg/work-orders/${id}/complete`, {
        method: 'POST', body: JSON.stringify({ resolveOpenLines: resolveOpenLines || retryResolve }),
      }));
      if (!done) { toast('Left unchanged — the work order is still open'); return; }
      toast('Work order completed — asset updated');
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message, 5000); }
  });

  container.querySelector('#addAssetUpdateForm').addEventListener('submit', async (e) => {
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
          <div class="field-row"><label>Hours (optional)</label><input name="hours" type="number" step="any" min="0" /></div>
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

// One-time check for a redirect back from the Google Calendar OAuth flow
// (src/routes/gcal-oauth-callback.js). This app has no URL-based routing
// otherwise — go(view, params) never touches the browser URL — so this is
// the one place a query string is read, and it's stripped immediately after
// via replaceState so a page refresh never re-shows the toast.
function handleGcalOauthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get('gcalConnected');
  const error = params.get('gcalError');
  if (!connected && !error) return;
  window.history.replaceState({}, '', window.location.pathname);
  if (connected) toast(`Connected to Google Calendar as ${connected} — go to Admin > Integrations to choose a calendar`, 6000);
  else toast(`Google Calendar connection failed: ${error}`, 6000);
}

(async function boot() {
  const deepLink = captureDeepLinkParams();
  try {
    const res = await fetch('/api/pg/options');
    if (res.status === 401) { pendingDeepLink = deepLink; return render('login'); }
    // We don't know the username without a /whoami endpoint; the session cookie
    // is enough to proceed, this just skips the "Signed in as ..." label until
    // the next successful /login call populates it.
    state.user = state.user || 'you';
    if (deepLink) await go(deepLink.view, deepLink.params, { reset: true });
    else await go('dashboard', {});
    handleGcalOauthRedirect();
  } catch {
    pendingDeepLink = deepLink;
    render('login');
  }
})();
