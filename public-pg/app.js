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
        <input type="file" accept="${accept}" capture="environment" multiple style="display:none" class="attach-input" />
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
        <div class="field-row"><label>Vendor</label><select class="attach-vendor"><option value="">— unset —</option>${vendorsRes.vendors.map((v) => `<option value="${v.Id}" ${a.VendorId === v.Id ? 'selected' : ''}>${escapeHtml(v.Name)}</option>`).join('')}</select></div>
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
  panel.querySelector('.attach-save').addEventListener('click', async () => {
    try {
      await api(`/api/pg/attachment-links/${a.LinkId}`, { method: 'PATCH', body: JSON.stringify({
        roleId: panel.querySelector('.attach-role').value || null,
        caption: panel.querySelector('.attach-caption').value || null,
        includeInReport: panel.querySelector('.attach-include').checked,
        vendorId: panel.querySelector('.attach-vendor')?.value || null,
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

function go(view, params, opts = {}) {
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
  { icon: '🗺️', label: 'Map', view: 'map' },
  { icon: '🗒️', label: 'Notes', view: 'notes' },
  { icon: '🛠️', label: 'Work Orders', view: 'workOrders' },
  { icon: '📥', label: 'Inbox', view: 'inbox' },
  { icon: '💵', label: 'Expenses', view: 'expenses' },
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
    btn.addEventListener('click', () => { closeSidebar(); go(btn.dataset.view, {}, { reset: true }); });
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
      map: () => renderMap(),
      notes: () => renderNotes(),
      inbox: () => renderInbox(),
      expenses: () => renderExpenses(params),
      expenseDetail: () => renderExpenseDetail(params),
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
      adminMapCalibration: () => renderAdminMapCalibration(),
      adminJobLineTemplates: () => renderAdminJobLineTemplates(),
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
      go('dashboard', {}, { replace: true });
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

  const [woSummary, calRes, scheduledWoRes, activityRes, findingsSummary, inboxRes, expenseInboxRes, fundBalancesRes] = await Promise.all([
    prefs.woOverview ? api('/api/pg/dashboard/wo-summary') : Promise.resolve(null),
    prefs.calendar ? api(`/api/pg/calendar-events?from=${isoDate(weekStart)}&to=${isoDate(weekEnd)}`) : Promise.resolve(null),
    prefs.calendar ? api('/api/pg/work-orders') : Promise.resolve(null),
    prefs.activity ? api(`/api/pg/activity-log?limit=12${isAdmin ? '' : `&username=${encodeURIComponent(currentUser.username || '')}`}`) : Promise.resolve(null),
    prefs.findings ? api('/api/pg/findings-summary') : Promise.resolve(null),
    api('/api/pg/inbox/count'),
    api('/api/pg/expenses/inbox/count'),
    api('/api/pg/funds/balances'),
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

  function draw() {
    setApp(`
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
  adminMapCalibration: (params, container) => renderAdminMapCalibration(container),
  adminJobLineTemplates: (params, container) => renderAdminJobLineTemplates(container),
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
      <div class="list-item ${onOpenAsset && selectedAssetId === a.Id ? 'cal-strip-selected' : ''}" data-id="${a.Id}" data-name="${escapeHtml(a.Name)}">
        <span>🏚️ ${escapeHtml(a.Name)}</span>
        <span class="pill">${escapeHtml(a['Asset type'] || '')}</span>
      </div>`).join('') : '<p class="muted">No assets in this location yet — add one from the asset search box when starting an audit or creating a work order (type a new name and choose "Add new asset").</p>';
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
      ${(n.attachments || []).length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">${n.attachments.map((a) => `<a href="${escapeHtml(a.Url)}" target="_blank" rel="noopener"><img src="${escapeHtml(a.ThumbUrl || a.Url)}" alt="" style="width:60px;height:60px;object-fit:cover;border-radius:8px" /></a>`).join('')}</div>` : ''}
      <div class="muted">${new Date(n.created_at).toLocaleDateString()}${n.created_by ? ` · ${escapeHtml(n.created_by)}` : ''}
        <a href="#" class="resolve-note" data-id="${n.id}" data-next="${!n.resolved}">${n.resolved ? 'reopen' : 'mark resolved'}</a>
      </div>
    </div>`).join('') || '<p class="muted">No notes yet — add one below.</p>';

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
            <button type="button" class="btn btn-secondary toggle-board-focus" data-id="${f.Id}" data-next="${!f.BoardFocus}" style="padding:2px 8px;font-size:0.75rem;${f.BoardFocus ? 'background:#f0f2fb' : ''}">${f.BoardFocus ? '★ Board Focus' : '☆ Flag for Board'}</button>
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
        <div class="field-row"><label>Photo (optional)</label><input type="file" name="photo" accept="image/*" capture="environment" multiple /></div>
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
          <div class="field-row"><label>Photo (optional)</label><input type="file" class="comp-photo" accept="image/*" capture="environment" multiple /></div>
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
      const photoFiles = [...(card.querySelector('.comp-photo')?.files || [])].filter((f) => f && f.size);
      if (!condition && !material && !notes && !flagged && !photoFiles.length) continue; // skip untouched component cards
      const attachmentIds = [];
      for (const file of photoFiles) attachmentIds.push(await uploadAttachmentUnlinked(file, 'components', id));
      componentEvents.push({ componentType: card.dataset.component, eventType, condition, material, notes, flagged, flagNote, attachmentIds });
    }

    const severity = fd.get('findingSeverity');
    const description = fd.get('findingDescription');
    const findingPhotos = fd.getAll('findingPhoto').filter((f) => f && f.size);
    const generalPhotoFiles = fd.getAll('generalPhotos').filter((f) => f && f.size);

    try {
      let finding = null;
      if (severity && description) {
        const attachmentIds = [];
        for (const file of findingPhotos) attachmentIds.push(await uploadAttachmentUnlinked(file, 'findings', id));
        finding = { severity, description, attachmentIds };
      }
      const generalAttachmentIds = [];
      for (const file of generalPhotoFiles) generalAttachmentIds.push(await uploadAttachmentUnlinked(file, 'asset-photos', id));
      await api(`/api/pg/assets/${id}/audit`, { method: 'POST', body: JSON.stringify({ properties: propertiesOut, componentEvents, finding, generalAttachmentIds }) });
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
        ${p.boardFocus ? '<div class="map-info-row" style="color:#a4801a;font-size:0.8rem">🏳 Flagged for board report</div>' : ''}
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

async function renderExpenses() {
  setChrome({ title: 'Expenses', showBack: false, showLogout: true });
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
}

// The source email itself — subject/sender/date plus the full body text, so
// confirming a parsed amount/vendor/date never requires leaving the app to
// go check a phone's mail client or dig up the original Amazon order. Open
// by default: this is the primary thing being confirmed on a triage screen,
// not a detail to dig for. Plain-text body only (body-html isn't stored —
// see receipt-inbound.js), rendered with white-space:pre-wrap so quoted
// receipt formatting/line breaks stay readable.
function originalEmailHtml(expense) {
  return `<details class="card" open style="margin:10px 0;background:var(--card-bg,#f7f7fa)">
    <summary style="cursor:pointer;font-weight:600">
      Original Email${expense.Subject ? `: ${escapeHtml(expense.Subject)}` : ''}
    </summary>
    <p class="muted" style="margin:6px 0 2px">
      ${expense.SenderEmail ? `From ${escapeHtml(expense.SenderEmail)}` : ''}${expense.ReceivedAt ? `${expense.SenderEmail ? ' · ' : ''}${new Date(expense.ReceivedAt).toLocaleString()}` : ''}
    </p>
    ${expense.BodyText
      ? `<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:0.9rem;max-height:320px;overflow-y:auto;margin:8px 0 0;padding:10px;background:var(--bg,#fff);border-radius:8px;border:1px solid var(--border,#ddd)">${escapeHtml(expense.BodyText)}</pre>`
      : '<p class="muted">No body text captured for this message.</p>'}
  </details>`;
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
      ${expense?.Source === 'email' && (expense.Subject || expense.BodyText) ? originalEmailHtml(expense) : ''}
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
          ${id ? '<button type="button" class="btn btn-secondary" id="voidExpenseBtn">Void</button>' : ''}
        </div>
      </form>
    </div>`;

  if (id) {
    renderAttachmentSection('expense', id, document.getElementById('expenseReceiptSection'), {
      title: 'Receipt', defaultRoleName: 'Receipt', accept: 'image/*,application/pdf',
    });
  }

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

  document.getElementById('voidExpenseBtn')?.addEventListener('click', async () => {
    if (!await confirmDialog('Void this expense? The receipt file (if any) is untouched and this can be undone from the expense.')) return;
    try { await api(`/api/pg/expenses/${id}/void`, { method: 'POST' }); toast('Voided'); go('expenses', {}, { replace: true }); }
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
  { key: 'forwardFocus', label: 'Forward Focus' },
  { key: 'workPerformed', label: 'Work Performed' },
  { key: 'deferredBacklog', label: 'Deferred Backlog' },
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
  if (mode === 'forwardFocus') return renderForwardFocusReport();
  if (mode === 'workPerformed') return renderWorkPerformedReport();
  if (mode === 'deferredBacklog') return renderDeferredBacklogReport();
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

async function renderBoardReport() {
  setChrome({ title: 'Reports', showBack: false, showLogout: true });
  const todayStr = isoDate(new Date());
  const monthStartStr = isoDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  let periodStart = monthStartStr;
  let periodEnd = todayStr;
  let report = null;
  let generating = false;

  function draw() {
    setApp(`
      ${reportsTabsHtml('board')}
      <div class="card">
        <h3>Board Report</h3>
        <p class="muted">Open Work Orders by status/priority, outstanding cost by funding source, completed items for the period below, and what's overdue/upcoming right now.</p>
        <div class="field-row"><label>Period</label>
          <div class="report-date-range">
            <input type="date" id="boardFrom" value="${periodStart}" />
            <span class="muted">to</span>
            <input type="date" id="boardTo" value="${periodEnd}" />
          </div>
        </div>
        <div class="btn-row"><button type="button" class="btn btn-primary" id="boardGenBtn" ${generating ? 'disabled' : ''}>${generating ? 'Generating…' : 'Generate'}</button></div>
      </div>
      ${reportPreviewAreaHtml(report)}`);
    wireReportsTabs();
    document.getElementById('boardGenBtn').addEventListener('click', generate);
    wireReportPreviewArea(report, { sendPath: '/api/pg/reports/board/send', sendBody: () => ({ periodStart, periodEnd }) });
  }

  async function generate() {
    periodStart = document.getElementById('boardFrom').value || periodStart;
    periodEnd = document.getElementById('boardTo').value || periodEnd;
    generating = true; draw();
    try { report = await api(`/api/pg/reports/board/preview?periodStart=${periodStart}&periodEnd=${periodEnd}`); }
    catch (err) { toast(err.message); }
    generating = false; draw();
  }

  draw();
}

async function renderForwardFocusReport() {
  setChrome({ title: 'Reports', showBack: false, showLogout: true });
  let report = null;
  let generating = false;

  function draw() {
    setApp(`
      ${reportsTabsHtml('forwardFocus')}
      <div class="card">
        <h3>Forward Focus</h3>
        <p class="muted">Work Orders and Condition Findings flagged for board focus, sorted by cost — a recurring PM item shows the historical average actual cost of past instances instead of its estimate.</p>
        <div class="btn-row"><button type="button" class="btn btn-primary" id="ffGenBtn" ${generating ? 'disabled' : ''}>${generating ? 'Generating…' : 'Generate'}</button></div>
      </div>
      ${reportPreviewAreaHtml(report)}`);
    wireReportsTabs();
    document.getElementById('ffGenBtn').addEventListener('click', generate);
    wireReportPreviewArea(report, { sendPath: '/api/pg/reports/forward-focus/send', sendBody: () => ({}) });
  }

  async function generate() {
    generating = true; draw();
    try { report = await api('/api/pg/reports/forward-focus/preview'); }
    catch (err) { toast(err.message); }
    generating = false; draw();
  }

  draw();
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
        <p class="muted">Job lines completed in this range, grouped by building — proves activity even while a big multi-line job is still open. After photos embed (capped per work order in Admin → Work Order Statuses).</p>
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
    ],
  },
  expenses: {
    icon: '💵', title: 'Expenses & Funds', description: 'Funds Ben is accountable for, and what an expense can be categorized as',
    items: [
      { view: 'adminFunds', icon: '💰', label: 'Funds' },
      { view: 'adminExpenseCategories', icon: '🏷️', label: 'Expense Categories' },
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

  // job_line_defaults holds partial job-line objects (title + responsibility
  // class); asset_update_defaults is the separate, older "also change an
  // asset field" blueprint — the two got renamed apart in migration 0038/0039
  // specifically so "job line" stops meaning two different things.
  const jlDefaultRowHtml = (row = {}) => `<div class="inline-add-row jld-row" style="align-items:center">
    <input class="jld-title" value="${escapeHtml(row.title || '')}" placeholder="Job line title…" style="flex:1" />
    <select class="jld-resp">${Object.entries(RESPONSIBILITY_CLASS_LABELS).map(([k, v]) => `<option value="${k}" ${row.responsibilityClass === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <button type="button" class="btn btn-secondary row-remove">✕</button>
  </div>`;
  const auDefaultRowHtml = (row = {}) => `<div class="inline-add-row aud-row" style="align-items:center">
      <select class="aud-field" style="flex:1">${fieldTitles.map((t) => `<option ${row.targetField === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>
      <input class="aud-value" placeholder="Value" value="${escapeHtml(row.newValue || '')}" style="flex:1" />
      <button type="button" class="btn btn-secondary row-remove">✕</button>
    </div>`;

  function formHtml(t) {
    const jlRows = (t?.JobLineDefaults || []).map(jlDefaultRowHtml).join('');
    const auRows = (t?.AssetUpdateDefaults || []).map(auDefaultRowHtml).join('');
    return `<div class="card">
      <h3>${t ? `Edit "${escapeHtml(t.Name)}"` : 'New Template'}</h3>
      <div class="field-row"><label>Template Name</label><input class="tf-name" value="${escapeHtml(t?.Name || '')}" placeholder="e.g. Winterization" required /></div>
      <div class="field-row"><label>Default Title</label><input class="tf-title" value="${escapeHtml(t?.DefaultTitle || '')}" placeholder="Fills in the WO title — you can still edit it per use" /></div>
      <div class="field-row"><label>Default Priority</label>
        <select class="tf-priority"><option value="">— none —</option>${['Low', 'Medium', 'High', 'Urgent'].map((p) => `<option ${t?.DefaultPriority === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
      </div>
      <div class="field-row"><label>Default Description</label><textarea class="tf-description">${escapeHtml(t?.DefaultDescription || '')}</textarea></div>
      <div class="field-row"><label>Default Job Lines</label>
        <p class="muted" style="margin:2px 0 8px">Pre-fills these job lines (title + responsibility) on every WO created from this template. Funding/hours/cost are set per use.</p>
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
          ${t.JobLineDefaults?.length ? `<div class="muted">${t.JobLineDefaults.length} default job line${t.JobLineDefaults.length > 1 ? 's' : ''}</div>` : ''}
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
      wireRemoveButtons();
    }));
    container.querySelectorAll('.tf-add-au').forEach((btn) => btn.addEventListener('click', () => {
      btn.previousElementSibling.insertAdjacentHTML('beforeend', auDefaultRowHtml());
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
      const jobLineDefaults = [...card.querySelectorAll('.jld-row')].map((row) => ({
        title: row.querySelector('.jld-title').value.trim(), responsibilityClass: row.querySelector('.jld-resp').value,
      })).filter((r) => r.title);
      const assetUpdateDefaults = [...card.querySelectorAll('.aud-row')].map((row) => ({
        targetField: row.querySelector('.aud-field').value, newValue: row.querySelector('.aud-value').value,
      })).filter((r) => r.newValue.trim());
      const fields = {
        name, defaultTitle: card.querySelector('.tf-title').value.trim(),
        defaultPriority: card.querySelector('.tf-priority').value,
        defaultDescription: card.querySelector('.tf-description').value.trim(),
        jobLineDefaults, assetUpdateDefaults,
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
        ${s.IsTerminal ? '<span class="muted">terminal</span>' : ''}${!s.Active ? ' <span class="pill">inactive</span>' : ''}</span>
      <span class="btn-row" style="margin-top:0">
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
  container.querySelector('#reportImageCapInput').addEventListener('change', async (e) => {
    try {
      await api('/api/pg/display-settings', { method: 'PUT', body: JSON.stringify({ reportImageCap: Number(e.target.value) }) });
      toast('Saved');
      if (state.options) state.options.displaySettings = await api('/api/pg/display-settings');
    } catch (err) { toast(err.message); }
  });
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
      ${entries.length ? entries.map((e) => e.type === 'jobLine'
        ? `<div class="list-item day-panel-entry" data-wo-id="${e.WorkOrderId}"><span>🛠️ ${escapeHtml(e.Asset?.Name || '')}${e.Asset ? ': ' : ''}${escapeHtml(e.WorkOrderTitle)} — ${escapeHtml(e.JobLineTitle)}</span>${statusPillHtml(e.WorkOrderStatus, e.WorkOrderStatusColor)}</div>`
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

    // Job lines, not work orders, are what actually gets scheduled (1.4) — a
    // WO's lines can have divergent dates (vendor Tuesday, volunteers
    // Saturday, same WO), so the grid shows one entry per line. The "Scheduled
    // Date" on /work-orders is still there for the sidebar/unscheduled check
    // (it's the earliest-line rollup — see listWorkOrders in db.js).
    const [{ workOrders }, { occurrences }, { jobLines: scheduledJobLines }] = await Promise.all([
      api('/api/pg/work-orders'), api(`/api/pg/calendar-events?from=${fromStr}&to=${toStr}`),
      api(`/api/pg/job-lines/scheduled?from=${fromStr}&to=${toStr}`),
    ]);

    dayEntriesMap = new Map();
    for (const jl of scheduledJobLines) {
      const key = jl.ScheduledDate.slice(0, 10);
      if (!dayEntriesMap.has(key)) dayEntriesMap.set(key, []);
      dayEntriesMap.get(key).push({ type: 'jobLine', ...jl });
    }
    for (const occ of occurrences) {
      if (!dayEntriesMap.has(occ.OccurrenceDate)) dayEntriesMap.set(occ.OccurrenceDate, []);
      dayEntriesMap.get(occ.OccurrenceDate).push({ type: 'event', ...occ });
    }
    const allUnscheduled = workOrders.filter((w) => !w['Scheduled Date']);

    const entryHtml = (e) => e.type === 'jobLine'
      ? `<div class="cal-entry" data-wo-id="${e.WorkOrderId}"><span class="pill"${statusColorStyle(e.WorkOrderStatusColor)}>🛠️ ${escapeHtml(e.Asset?.Name || '')}${e.Asset ? ': ' : ''}${escapeHtml(e.WorkOrderTitle)} — ${escapeHtml(e.JobLineTitle)}</span></div>`
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
              ${statusPillHtml(w.Status, w.StatusColor)}
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
  const [{ workOrders }, { templates: workOrderTemplates }] = await Promise.all([
    api('/api/pg/work-orders'), api('/api/pg/work-order-templates'),
  ]);
  setApp(`
    <div class="card">
      <h3>New Calendar Event</h3>
      <form id="newEventForm">
        <div class="field-row"><label>Title</label><input name="title" required /></div>
        <div class="field-row"><label>Date</label><input name="eventDate" type="date" value="${params.date || ''}" required /></div>
        <div class="field-row"><label>Description</label><textarea name="description"></textarea></div>
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
        jobLineId: fd.get('jobLineId') || undefined,
        workOrderTemplateId: fd.get('workOrderTemplateId') || undefined,
      }) });
      toast('Event created');
      go('calendarEventDetail', { id: event.Id }, { replace: true });
    } catch (err) { toast(err.message); }
  });
}

async function renderCalendarEventDetail({ id }) {
  setChrome({ title: 'Calendar Event', showBack: true, showLogout: true });
  app.innerHTML = LOADING_HTML;
  const [detail, workOrdersRes, tplRes, woTplRes] = await Promise.all([
    api(`/api/pg/calendar-events/${id}`), api('/api/pg/work-orders'), api('/api/pg/checklist-templates'), api('/api/pg/work-order-templates'),
  ]);
  const { event: ev, checklist } = detail;
  const { workOrders } = workOrdersRes;
  const checklistTemplates = tplRes.templates;
  const workOrderTemplates = woTplRes.templates;
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
        ${recurrenceFieldsHtml(ev)}
        ${calendarLinkFieldsHtml({ workOrders, workOrderTemplates, initialJobLines, ev })}
        <button class="btn btn-secondary" type="submit">Save Changes</button>
      </form>
      ${ev.WorkOrderId ? `<div class="btn-row"><button class="btn btn-secondary" id="viewWoBtn">View Linked Work Order</button></div>` : ''}
      ${ev.JobLineTitle ? `<p class="muted">Linked to job line: "${escapeHtml(ev.JobLineTitle)}"</p>` : ''}
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
        jobLineId: fd.get('jobLineId') || '', workOrderTemplateId: fd.get('workOrderTemplateId') || '',
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
          <table class="report-table">
            <thead><tr><th>Title</th>${visibleCols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
            <tbody>${tableRows || `<tr><td colspan="${visibleCols.length + 1}" class="muted">${filterLabel ? 'Nothing matches this filter.' : 'No work orders yet — tap + New Work Order above to create one.'}</td></tr>`}</tbody>
          </table>
        </div>` : cardRows}
    `, container);

    container.querySelector('#newWoBtnTop').addEventListener('click', () => go('newWorkOrder', {}));
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
async function renderNewWorkOrder({ assetId, assetName }) {
  setChrome({ title: 'New Work Order', showBack: true, showLogout: true });
  const [{ templates }, campaignRes, cabinRes, otherRes, fundsRes] = await Promise.all([
    api('/api/pg/work-order-templates'),
    api('/api/pg/budget/capital-campaign-projects'), api('/api/pg/budget/cabin-holders'), api('/api/pg/budget/other-categories'),
    api('/api/pg/funds'),
  ]);
  const fundingEntities = { capital_campaign: campaignRes.items, cabin_holder: cabinRes.items, other: otherRes.items, fund: fundsRes.funds };
  const fieldTitles = state.options.propertyFields.map((f) => f.title);

  const fundingRefOptionsHtml = (source, selectedId) =>
    (fundingEntities[source] || []).map((e) => `<option value="${e.Id}" ${e.Id === selectedId ? 'selected' : ''}>${escapeHtml(e.Name)}</option>`).join('');

  const jobLineRowHtml = (row = {}) => {
    const fundingSource = row.fundingSource || 'operating_budget';
    return `<div class="card jl-row" style="margin-bottom:10px">
      <div class="field-row"><label>Title</label><input class="jl-title" value="${escapeHtml(row.title || '')}" placeholder="e.g. Roof repair" required /></div>
      <div class="field-row"><label>Responsibility</label>
        <select class="jl-resp">${Object.entries(RESPONSIBILITY_CLASS_LABELS).map(([k, v]) => `<option value="${k}" ${row.responsibilityClass === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </div>
      <div class="field-row"><label>Funding Source</label>
        <select class="jl-funding-source">${Object.entries(FUNDING_SOURCE_LABELS).map(([k, v]) => `<option value="${k}" ${fundingSource === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </div>
      <div class="field-row jl-funding-ref-row" ${fundingSource === 'operating_budget' ? 'hidden' : ''}>
        <label>${escapeHtml(FUNDING_SOURCE_LABELS[fundingSource] || '')}</label>
        <select class="jl-funding-ref">${fundingRefOptionsHtml(fundingSource, row.fundingRefId)}</select>
      </div>
      <div class="field-row"><label>Est. Hours</label><input class="jl-est-hours" type="number" min="0" value="${row.estimatedHours ?? ''}" /></div>
      <div class="field-row"><label>Est. Cost</label><input class="jl-est-cost" type="number" step="0.01" min="0" value="${row.estimatedCost ?? ''}" /></div>
      <div class="field-row"><label>Scheduled Date</label><input class="jl-scheduled-date" type="date" value="${row.scheduledDate || ''}" />
        <p class="muted" style="margin-top:2px;font-size:0.8rem">Defaults to the work order's date if left blank.</p>
      </div>
      <button type="button" class="btn btn-secondary row-remove">✕ Remove line</button>
    </div>`;
  };
  function wireJobLineRow(row) {
    const sourceSelect = row.querySelector('.jl-funding-source');
    const refRow = row.querySelector('.jl-funding-ref-row');
    const refLabel = refRow.querySelector('label');
    const refSelect = row.querySelector('.jl-funding-ref');
    sourceSelect.addEventListener('change', () => {
      const source = sourceSelect.value;
      if (source === 'operating_budget') { refRow.hidden = true; return; }
      refRow.hidden = false;
      refLabel.textContent = FUNDING_SOURCE_LABELS[source];
      refSelect.innerHTML = fundingRefOptionsHtml(source, null);
    });
    row.querySelector('.row-remove').onclick = () => row.remove();
  }

  const taskRowHtml = (text = '') => `<div class="inline-add-row task-row"><input class="task-text" value="${escapeHtml(text)}" placeholder="Task description…" /><button type="button" class="btn btn-secondary row-remove">✕</button></div>`;
  const assetUpdateRowHtml = (row = {}) => `<div class="inline-add-row au-row" style="align-items:center">
    <select class="au-field" style="flex:1">${fieldTitles.map((t) => `<option ${row.targetField === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>
    <input class="au-value" placeholder="Value" value="${escapeHtml(row.newValue || '')}" style="flex:1" />
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
        <div class="field-row"><label>Job Lines</label>
          <p class="muted" style="margin:2px 0 8px">Each line is its own hours, cost, funding, and responsibility — a vendor on the roof, volunteers on the deck, same work order.</p>
          <div class="jl-rows"></div>
          <button type="button" class="btn btn-secondary" id="addJlRowBtn" style="margin-top:6px">+ Add Job Line</button>
        </div>
        <details style="margin:16px 0">
          <summary style="cursor:pointer;font-weight:700">Also update asset fields (optional)</summary>
          <p class="muted" style="margin:8px 0">Only for the rare case this WO should change a stable asset fact — most work orders don't need this.</p>
          <div class="au-rows"></div>
          <button type="button" class="btn btn-secondary" id="addAuBtn" style="margin-top:6px">+ Add Field Update</button>
        </details>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Create Work Order</button>
          <button class="btn btn-secondary" type="button" id="cancelWoBtn">Cancel</button>
        </div>
      </form>
    </div>`);

  let assetPicker = null;
  if (!assetId) assetPicker = mountAssetCombobox(document.getElementById('woAssetPicker'));

  function wireRowRemove() { app.querySelectorAll('.au-row .row-remove, .task-row .row-remove').forEach((btn) => { btn.onclick = () => btn.closest('.inline-add-row').remove(); }); }
  function addJobLineRow(row) {
    document.querySelector('.jl-rows').insertAdjacentHTML('beforeend', jobLineRowHtml(row));
    wireJobLineRow(document.querySelector('.jl-rows').lastElementChild);
  }
  document.getElementById('addJlRowBtn').addEventListener('click', () => addJobLineRow());
  document.getElementById('addAuBtn').addEventListener('click', () => {
    document.querySelector('.au-rows').insertAdjacentHTML('beforeend', assetUpdateRowHtml());
    wireRowRemove();
  });
  addJobLineRow(); // start with one blank line — the common case is at least one

  document.getElementById('tplPicker')?.addEventListener('change', (e) => {
    const tpl = templates.find((t) => t.Id === Number(e.target.value));
    const form = document.getElementById('newWoForm');
    if (!tpl) return;
    if (tpl.DefaultTitle) form.title.value = tpl.DefaultTitle;
    if (tpl.DefaultPriority) form.priority.value = tpl.DefaultPriority;
    if (tpl.DefaultDescription) form.description.value = tpl.DefaultDescription;
    document.querySelector('.jl-rows').innerHTML = '';
    (tpl.JobLineDefaults || []).forEach((l) => addJobLineRow({ ...(typeof l === 'string' ? { title: l } : l), responsibilityClass: (typeof l === 'object' && l.responsibilityClass) || tpl.DefaultResponsibilityClass }));
    if (!(tpl.JobLineDefaults || []).length) addJobLineRow();
    document.querySelector('.au-rows').innerHTML = (tpl.AssetUpdateDefaults || []).map(assetUpdateRowHtml).join('');
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
    const jobLines = [...document.querySelectorAll('.jl-row')].map((row) => ({
      title: row.querySelector('.jl-title').value.trim(),
      responsibilityClass: row.querySelector('.jl-resp').value,
      fundingSource: row.querySelector('.jl-funding-source').value,
      fundingRefId: row.querySelector('.jl-funding-ref-row').hidden ? null : (row.querySelector('.jl-funding-ref').value || null),
      estimatedHours: row.querySelector('.jl-est-hours').value || null,
      estimatedCost: row.querySelector('.jl-est-cost').value || null,
      scheduledDate: row.querySelector('.jl-scheduled-date').value || null,
    })).filter((l) => l.title);
    const assetUpdates = [...document.querySelectorAll('.au-row')].map((row) => ({
      targetField: row.querySelector('.au-field').value, newValue: row.querySelector('.au-value').value,
    })).filter((r) => r.newValue.trim());
    try {
      const result = await api('/api/pg/work-orders', { method: 'POST', body: JSON.stringify({
        title, assetId: Number(finalAssetId), priority: fd.get('priority'), description: fd.get('description'),
        scheduledDate: fd.get('scheduledDate') || undefined, jobLines, assetUpdates,
      }) });
      toast('Work order created');
      go('workOrderDetail', { id: result.workOrderId }, { replace: true });
    } catch (err) { toast(err.message); }
  });
}

// 'fund' added Build Brief v3 Part 1 (see migration 0053's header comment).
const FUNDING_SOURCE_LABELS = {
  operating_budget: 'Operating Budget', capital_campaign: 'Capital Campaign', cabin_holder: 'Cabin-Holder', other: 'Other', fund: 'Fund',
};
// The old WO-level funding combobox (search/inline-create) was retired with
// Phase 1 — funding now lives per-line via a plain <select> populated from
// fundingEntities (see jobLineRowHtml/jobLineCardHtml). Creating a brand new
// Capital Campaign Project / Cabin-Holder / Other category happens on the
// Capital Plan page (renderCapitalPlan), which already has full CRUD for
// all three — a job line just picks from what exists there.

// One job line's full edit surface — title/responsibility/funding/hours/cost/
// schedule up top (the 1.7 creation fields, still editable after), then
// complaint/cause/correction (1.6 — filled in during/after the work) and
// blocked state (columns land in Phase 1; the WO-level derived badge and
// close-gate logic are Phase 2), then its own crew and photos. Collapsed by
// default (<details>) so N lines on one WO doesn't turn the page into an
// unreadable wall on a phone.
function jobLineCardHtml(jl, { fundingEntities, causesCatalog, jobLineStatuses }) {
  const fundingSource = jl.FundingSource || 'operating_budget';
  const fundingRefOptions = (fundingEntities[fundingSource] || []).map((e) => `<option value="${e.Id}" ${e.Id === jl.FundingRefId ? 'selected' : ''}>${escapeHtml(e.Name)}</option>`).join('');
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
        <select class="jl-e-funding-source">${Object.entries(FUNDING_SOURCE_LABELS).map(([k, v]) => `<option value="${k}" ${fundingSource === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </div>
      <div class="field-row jl-e-funding-ref-row" ${fundingSource === 'operating_budget' ? 'hidden' : ''}>
        <label>${escapeHtml(FUNDING_SOURCE_LABELS[fundingSource] || '')}</label>
        <select class="jl-e-funding-ref">${fundingRefOptions}</select>
      </div>
      <div class="field-row"><label>Estimated Hours</label><input class="jl-e-est-hours" type="number" min="0" value="${jl.EstimatedHours ?? ''}" /></div>
      <div class="field-row"><label>Actual Hours</label><input class="jl-e-act-hours" type="number" min="0" value="${jl.ActualHours ?? ''}" /></div>
      <div class="field-row"><label>Estimated Cost</label><input class="jl-e-est-cost" type="number" step="0.01" min="0" value="${jl.EstimatedCost ?? ''}" /></div>
      <div class="field-row"><label>Actual Cost</label><input class="jl-e-act-cost" type="number" step="0.01" min="0" value="${jl.ActualCost ?? ''}" />
        ${jl.LinkedExpenseCount ? `<p class="muted" style="margin-top:2px;font-size:0.8rem">+ $${jl.LinkedExpenseTotal.toLocaleString()} from ${jl.LinkedExpenseCount} linked expense${jl.LinkedExpenseCount === 1 ? '' : 's'} — this field is the manual/no-receipt amount only; totals elsewhere include both.</p>` : '<p class="muted" style="margin-top:2px;font-size:0.8rem">For costs with no receipt (invoice paid directly, donated materials). Link an expense instead when there is one.</p>'}
      </div>
      <div class="field-row"><label>Scheduled Date</label><input class="jl-e-scheduled-date" type="date" value="${(jl.ScheduledDate || '').slice(0, 10)}" /></div>
      <div class="field-row"><label>Complaint</label><textarea class="jl-e-complaint" placeholder="What's wrong?">${escapeHtml(jl.Complaint || '')}</textarea></div>
      <div class="field-row"><label>Cause</label>
        <div class="skill-chips">${causesCatalog.map((c) => `<label class="skill-chip ${selectedCauseIds.has(c.Id) ? 'selected' : ''}" style="cursor:pointer"><input type="checkbox" class="jl-e-cause" value="${c.Id}" style="margin-right:6px" ${selectedCauseIds.has(c.Id) ? 'checked' : ''} />${escapeHtml(c.Name)}</label>`).join('')}</div>
        <p class="muted" style="font-size:0.8rem;margin-top:4px">The dropdown is what gets counted. Add "Unknown" rather than guessing.</p>
      </div>
      <div class="field-row"><label>Cause Note</label><textarea class="jl-e-cause-note" placeholder="Freetext detail — never becomes a new cause option">${escapeHtml(jl.CauseNote || '')}</textarea></div>
      <div class="field-row"><label>Correction</label><textarea class="jl-e-correction" placeholder="What was done to fix it?">${escapeHtml(jl.Correction || '')}</textarea></div>
      <div class="field-row"><label>Blocked Reason</label><input class="jl-e-blocked-reason" value="${escapeHtml(jl.BlockedReason || '')}" placeholder="Leave blank if not blocked" /></div>
      <div class="field-row"><label>Blocked Since</label><input class="jl-e-blocked-since" type="date" value="${(jl.BlockedSince || '').slice(0, 10)}" /></div>
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
      <div class="field-row"><select class="jl-assign-picker"><option value="">— assign volunteer or vendor —</option>
        ${(state._allVolunteers || []).filter((v) => !(jl.volunteers || []).some((a) => a.Id === v.Id)).map((v) => `<option value="vol:${v.Id}">👷 ${escapeHtml(v.Name)}</option>`).join('')}
        ${(state._allVendors || []).filter((v) => !(jl.vendors || []).some((a) => a.Id === v.Id)).map((v) => `<option value="ven:${v.Id}">🔧 ${escapeHtml(v.Name)}</option>`).join('')}
      </select></div>
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
  const fundingEntities = { capital_campaign: campaignRes.items, cabin_holder: cabinRes.items, other: otherRes.items, fund: fundsRes.funds };
  const causesCatalog = causesRes.causes;
  const { workOrder: wo, rollup, crewRoster, closeGate, assetUpdates, jobLines, checklist, logEntries, crewSessions } = detail;
  const propertyFieldTitles = state.options.propertyFields.map((f) => f.title);
  // Job-line pickers (assign-crew, crew-session attendee union) read the full
  // roster off `state` rather than threading it through every helper — same
  // trick the rest of this file uses for state.options.
  state._allVolunteers = allVolunteers.volunteers;
  state._allVendors = allVendors.vendors;

  const jobLineRows = jobLines.map((jl) => jobLineCardHtml(jl, { fundingEntities, causesCatalog, jobLineStatuses })).join('')
    || '<p class="muted">No job lines yet — add the scope of work below.</p>';

  const workOrderStatuses = state.options.workOrderStatuses; // admin-editable (2.2) — never hardcode this list
  const jobLineStatuses = state.options.jobLineStatuses; // admin-editable (2.1)
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
        <div class="field-row"><label>Board Focus</label>
          <label class="skill-chip ${wo.BoardFocus ? 'selected' : ''}" style="cursor:pointer;display:inline-flex"><input type="checkbox" name="boardFocus" style="margin-right:6px" ${wo.BoardFocus ? 'checked' : ''} />Flag for board report</label>
        </div>
        <div class="field-row"><label>Description</label><textarea name="description">${escapeHtml(wo.Description || '')}</textarea></div>
        <button class="btn btn-secondary" type="submit">Save Changes</button>
      </form>
      <div class="btn-row">
        <button class="btn btn-primary" id="completeWoBtn" ${wo.StatusIsTerminal ? 'disabled' : ''}>${wo.StatusIsTerminal ? wo.Status : 'Complete Work Order'}</button>
        <a class="btn btn-secondary" href="/api/pg/work-orders/${id}/scope-pdf" target="_blank" rel="noopener" title="A printable job description to hand a vendor or volunteer — no cost figures included">🖨️ Scope of Work (PDF)</a>
        <button class="btn btn-secondary" id="duplicateWoBtn">Duplicate</button>
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
      ${!wo.StatusIsTerminal ? `<div class="btn-row"><button type="button" class="btn btn-secondary" id="splitLinesBtn">Split Selected Lines Into New WO</button></div>` : ''}
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
        <div class="field-row"><label>Hours (optional)</label><input name="hours" type="number" step="0.25" min="0" /></div>
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
        <div class="field-row"><label>Hours (optional)</label><input name="hours" type="number" step="0.25" min="0" /></div>
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
      await api(`/api/pg/work-orders/${id}`, { method: 'PATCH', body: JSON.stringify({
        assetId: newAsset ? newAsset.Id : (wo.Asset ? wo.Asset.Id : ''),
        statusId: Number(fd.get('statusId')), priority: fd.get('priority'), description: fd.get('description'),
        deferredReason: fd.get('deferredReason') || undefined, revisitDate: fd.get('revisitDate') || undefined,
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
    const d = new Date(rollup.EarliestScheduledDate);
    go('calendar', { month: d.getMonth(), year: d.getFullYear(), fromWorkOrderId: id, fromWorkOrderTitle: wo.Title });
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
      await api(`/api/pg/work-orders/${id}/job-lines`, { method: 'POST', body: JSON.stringify({
        title: fd.get('title'), responsibilityClass: fd.get('responsibilityClass'),
      }) });
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message); }
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

    const fundingSourceSelect = card.querySelector('.jl-e-funding-source');
    const fundingRefRow = card.querySelector('.jl-e-funding-ref-row');
    fundingSourceSelect.addEventListener('change', () => {
      const source = fundingSourceSelect.value;
      if (source === 'operating_budget') { fundingRefRow.hidden = true; return; }
      fundingRefRow.hidden = false;
      fundingRefRow.querySelector('label').textContent = FUNDING_SOURCE_LABELS[source];
      fundingRefRow.querySelector('select').innerHTML = (fundingEntities[source] || []).map((ent) => `<option value="${ent.Id}">${escapeHtml(ent.Name)}</option>`).join('');
    });

    card.querySelectorAll('.jl-e-cause').forEach((cb) => cb.addEventListener('change', () => {
      cb.closest('.skill-chip').classList.toggle('selected', cb.checked);
    }));

    card.querySelector('.jl-edit-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const causeIds = [...card.querySelectorAll('.jl-e-cause:checked')].map((cb) => Number(cb.value));
      try {
        await api(`/api/pg/job-lines/${jlId}`, { method: 'PATCH', body: JSON.stringify({
          title: card.querySelector('.jl-e-title').value.trim(),
          statusId: Number(statusSelect.value), statusNote: card.querySelector('.jl-e-status-note').value,
          responsibilityClass: card.querySelector('.jl-e-resp').value,
          fundingSource: fundingSourceSelect.value,
          fundingRefId: fundingRefRow.hidden ? '' : (fundingRefRow.querySelector('select').value || ''),
          estimatedHours: card.querySelector('.jl-e-est-hours').value,
          actualHours: card.querySelector('.jl-e-act-hours').value,
          estimatedCost: card.querySelector('.jl-e-est-cost').value,
          actualCost: card.querySelector('.jl-e-act-cost').value,
          scheduledDate: card.querySelector('.jl-e-scheduled-date').value,
          complaint: card.querySelector('.jl-e-complaint').value,
          causeNote: card.querySelector('.jl-e-cause-note').value,
          correction: card.querySelector('.jl-e-correction').value,
          blockedReason: card.querySelector('.jl-e-blocked-reason').value,
          blockedSince: card.querySelector('.jl-e-blocked-since').value,
          causeIds,
        }) });
        toast('Job line saved');
        renderWorkOrderDetail({ id }, container);
      } catch (err) { toast(err.message); }
    });
    card.querySelector('.jl-delete-btn').addEventListener('click', async () => {
      if (!await confirmDialog(`Delete job line "${card.querySelector('.jl-delete-btn').dataset.label}"? This removes its hours, cost, and crew assignments too.`)) return;
      try { await api(`/api/pg/job-lines/${jlId}`, { method: 'DELETE' }); renderWorkOrderDetail({ id }, container); }
      catch (err) { toast(err.message); }
    });

    card.querySelector('.jl-assign-picker').addEventListener('change', async (e) => {
      const [kind, entId] = e.target.value.split(':');
      if (!kind) return;
      try {
        if (kind === 'vol') await api(`/api/pg/job-lines/${jlId}/volunteers`, { method: 'POST', body: JSON.stringify({ volunteerId: Number(entId) }) });
        else await api(`/api/pg/job-lines/${jlId}/vendors`, { method: 'POST', body: JSON.stringify({ vendorId: Number(entId) }) });
        renderWorkOrderDetail({ id }, container);
      } catch (err) { toast(err.message); }
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

  container.querySelector('#completeWoBtn').addEventListener('click', async () => {
    if (!await confirmDialog(`Complete this Work Order? Any pending "asset field update" entries will be written to "${wo.Asset?.Name || 'the asset'}" immediately — this directly changes real asset data.`)) return;
    try {
      await api(`/api/pg/work-orders/${id}/complete`, { method: 'POST' });
      toast('Work order completed — asset updated');
      renderWorkOrderDetail({ id }, container);
    } catch (err) { toast(err.message); }
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
