// Screenshot every screen at several widths, in WebKit (the Safari engine), and collect
// console errors per screen. Dev-only: playwright is a devDependency and the production
// image is built with `npm ci --omit=dev`, so none of this ships.
//
//   BASE=https://audit.fracturedrv.com USER=mobaudit PASS=… node scripts/screens.mjs before
//
// Emulation is not a real iPhone. Anything depending on the real Safari toolbar
// collapsing, momentum scrolling, or the on-screen keyboard has to be checked by hand —
// those are called out in docs/mobile-audit.md.
import { webkit } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = process.env.BASE || 'https://audit.fracturedrv.com';
const USER = process.env.USER_NAME || 'mobaudit';
const PASS = process.env.PASS;
const PHASE = process.argv[2] || 'before';
const OUT = path.join('docs', 'mobile-screens', PHASE);

if (!PASS) { console.error('PASS is required'); process.exit(1); }

// 393x852 is the iPhone 14 Pro. The others bracket it: a small Android, a narrowed
// desktop window, and full desktop.
const VIEWPORTS = [
  { name: '393-iphone14pro', width: 393, height: 852, mobile: true },
  { name: '360-android',     width: 360, height: 800, mobile: true },
  { name: '760-narrow',      width: 760, height: 1000, mobile: false },
  { name: '1440-desktop',    width: 1440, height: 900, mobile: false },
];

// Every screen reachable by a view name, plus the overlays that have to be opened by
// clicking something. `open` runs after the view renders.
const SCREENS = [
  { id: 'dashboard',        view: 'dashboard' },
  { id: 'work-orders',      view: 'workOrders' },
  { id: 'wo-detail',        view: 'workOrders', open: async (p) => { await p.locator('.list-item, tr[data-id]').first().click({ timeout: 4000 }); } },
  { id: 'locations',        view: 'locations' },
  { id: 'asset-profile',    view: 'locations', open: async (p) => {
      await p.locator('.list-item').first().click({ timeout: 4000 });
      await p.waitForTimeout(600);
      await p.locator('.list-item').first().click({ timeout: 4000 });
    } },
  { id: 'calendar',         view: 'calendar' },
  { id: 'inbox',            view: 'inbox' },
  { id: 'admin-tasks',      view: 'adminTasks' },
  { id: 'audit-picker',     view: 'auditPicker' },
  { id: 'audit-rounds',     view: 'auditRounds' },
  { id: 'audit-new-round',  view: 'auditRounds', open: async (p) => { await p.locator('#newRoundBtn').click({ timeout: 4000 }); } },
  { id: 'audit-form-builder', view: 'auditRounds', open: async (p) => { await p.locator('.edit-form').first().click({ timeout: 4000 }); } },
  { id: 'map',              view: 'map' },
  { id: 'notes',            view: 'notes' },
  { id: 'expenses',         view: 'expenses' },
  { id: 'expense-detail',   view: 'expenses', open: async (p) => { await p.locator('.list-item').first().click({ timeout: 4000 }); } },
  { id: 'materials',        view: 'materials' },
  { id: 'capital-plan',     view: 'capitalPlan' },
  { id: 'requests',         view: 'requests' },
  { id: 'crew',             view: 'crew' },
  { id: 'crew-hours',       view: 'crewHours' },
  { id: 'maintenance-log',  view: 'maintenanceLog' },
  { id: 'activity-log',     view: 'activityLog' },
  { id: 'admin-hub',        view: 'admin' },
  { id: 'reports-board',    view: 'reports', params: { mode: 'board' } },
  { id: 'reports-add-item', view: 'reports', params: { mode: 'board' }, open: async (p) => { await p.locator('#brAddItem').click({ timeout: 6000 }); await p.waitForTimeout(800); } },
  { id: 'reports-explorer', view: 'reports', params: { mode: 'explorer' } },
  { id: 'reports-work-performed', view: 'reports', params: { mode: 'workPerformed' } },
  { id: 'reports-deferred', view: 'reports', params: { mode: 'deferredBacklog' } },
  { id: 'reports-visitor',  view: 'reports', params: { mode: 'visitorActivity' } },
  { id: 'reports-audit-data', view: 'reports', params: { mode: 'auditData' } },
];

// Page-body horizontal overflow is the single most useful automated signal: if the body
// scrolls sideways, something is wider than the screen and a human will feel it.
async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const overflow = de.scrollWidth - de.clientWidth;
    const offenders = [];
    if (overflow > 1) {
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > de.clientWidth + 1) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 40),
            right: Math.round(r.right),
            width: Math.round(r.width),
          });
        }
      }
    }
    // Tap targets below 44px, and inputs whose font-size would make iOS zoom.
    const small = [];
    const smallFont = [];
    for (const el of document.querySelectorAll('button, a, input, select, textarea, label, [role=button]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 44 || r.width < 24) {
        small.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 30),
          text: (el.textContent || '').trim().slice(0, 18), h: Math.round(r.height), w: Math.round(r.width) });
      }
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs && fs < 16) smallFont.push({ tag: el.tagName.toLowerCase(), fontSize: fs, cls: (el.className || '').toString().slice(0, 30) });
      }
    }
    return {
      overflow, offenders: offenders.slice(0, 8),
      smallTargets: small.length, smallTargetSample: small.slice(0, 6),
      smallFonts: smallFont.length, smallFontSample: smallFont.slice(0, 4),
      bodyFontSize: parseFloat(getComputedStyle(document.body).fontSize),
    };
  });
}

const report = [];

for (const vp of VIEWPORTS) {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    userAgent: vp.mobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined,
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 200)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // Scope to the login form: a bare input[type=text] also matches the global search box
  // in the chrome, which is present but hidden before sign-in.
  await page.waitForSelector('#loginForm', { timeout: 15000 });
  await page.fill('#loginForm input[name=username]', USER);
  await page.fill('#loginForm input[name=password]', PASS);
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('loginForm'), { timeout: 15000 });
  await page.waitForTimeout(1500);

  fs.mkdirSync(path.join(OUT, vp.name), { recursive: true });

  for (const s of SCREENS) {
    const before = consoleErrors.length;
    try {
      await page.evaluate(([view, params]) => window.go(view, params || {}, { reset: true }), [s.view, s.params || {}]);
      await page.waitForTimeout(1400);
      if (s.open) { try { await s.open(page); await page.waitForTimeout(1200); } catch { /* control absent at this width */ } }
      const m = await measure(page);
      await page.screenshot({ path: path.join(OUT, vp.name, `${s.id}.png`), fullPage: false });
      report.push({ viewport: vp.name, screen: s.id, ...m, newConsoleErrors: consoleErrors.slice(before) });
      const flag = m.overflow > 1 ? `OVERFLOW +${m.overflow}px` : 'ok';
      console.log(`  ${vp.name.padEnd(18)} ${s.id.padEnd(24)} ${flag.padEnd(18)} targets<44:${String(m.smallTargets).padStart(3)} fonts<16:${String(m.smallFonts).padStart(2)}`);
      // Close any overlay so the next screen starts clean.
      await page.evaluate(() => document.querySelectorAll('.modal-overlay, .reorder-sheet').forEach((e) => e.remove()));
    } catch (e) {
      report.push({ viewport: vp.name, screen: s.id, error: String(e.message).split('\n')[0].slice(0, 120) });
      console.log(`  ${vp.name.padEnd(18)} ${s.id.padEnd(24)} ERROR ${String(e.message).split('\n')[0].slice(0, 60)}`);
    }
  }
  await browser.close();
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const overflowing = report.filter((r) => r.overflow > 1);
const errs = report.filter((r) => r.newConsoleErrors?.length);
console.log(`\n  ${report.length} captures. ${overflowing.length} with body overflow. ${errs.length} with console errors.`);
console.log(`  -> ${OUT}/report.json`);
