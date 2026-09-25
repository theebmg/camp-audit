// What sub-44px controls and sub-16px fields are LEFT after the fixes, by selector.
// Throwaway.
import { webkit } from 'playwright';

const BASE = process.env.BASE || 'https://audit.fracturedrv.com';
const SCREENS = [
  ['dashboard', {}], ['workOrders', {}], ['auditRounds', {}],
  ['reports', { mode: 'explorer' }], ['reports', { mode: 'board' }],
];

const browser = await webkit.launch();
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#loginForm');
await page.fill('#loginForm input[name=username]', process.env.USER_NAME || 'mobaudit');
await page.fill('#loginForm input[name=password]', process.env.PASS);
await page.click('#loginForm button[type=submit]');
await page.waitForFunction(() => !document.getElementById('loginForm'));
await page.waitForTimeout(1500);

const HISTO = () => {
  const CONTROL = 'button, .btn, select, [role=button], input[type=checkbox], input[type=radio],'
    + ' .view-toggle-btn, label.skill-chip, .chip-row > label, .q-note, .o-remedy, .o-follow,'
    + ' .rm-edit, .rm-del, .q-edit, .q-del, .br-note, .list-item[data-view], .list-item[data-id],'
    + ' .round-row, .inst-row, .mat-row, .add-cand, .br-open-output, .edit-form, .pf-pick';
  const key = (el) => el.tagName.toLowerCase()
    + (el.className ? '.' + String(el.className).trim().split(/\s+/).slice(0, 2).join('.') : '')
    + (el.type ? `[${el.type}]` : '');
  const where = (el) => {
    // Which region of the page: the persistent chrome, or the view?
    let n = el;
    while (n && n !== document.body) {
      if (n.id === 'app') return 'view';
      if (/sidebar|topbar|nav|chrome|theme/i.test(String(n.className) + ' ' + n.id)) return 'chrome';
      n = n.parentElement;
    }
    return 'other';
  };
  const t = {}; const f = {};
  for (const el of document.querySelectorAll(CONTROL)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.height < 44 || r.width < 24) {
      const k = `[${where(el)}] ${key(el)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      t[k] = (t[k] || 0) + 1;
    }
  }
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs && fs < 16) f[`[${where(el)}] ${key(el)} ${fs}px`] = (f[`[${where(el)}] ${key(el)} ${fs}px`] || 0) + 1;
  }
  return { t, f };
};

const targets = new Map(); const fonts = new Map();
for (const [view, params] of SCREENS) {
  await page.evaluate(([v, p]) => window.go(v, p || {}, { reset: true }), [view, params]);
  await page.waitForTimeout(1800);
  const res = await page.evaluate(HISTO);
  for (const [k, v] of Object.entries(res.t)) targets.set(k, (targets.get(k) || 0) + v);
  for (const [k, v] of Object.entries(res.f)) fonts.set(k, (fonts.get(k) || 0) + v);
}

// The form builder separately — it was unchanged at 177.
await page.evaluate(() => window.go('auditRounds', {}, { reset: true }));
await page.waitForTimeout(1600);
await page.locator('.edit-form').first().click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(2000);
const fb = await page.evaluate(HISTO);

const show = (m, title) => {
  console.log(`\n${title}`);
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));
};
show(targets, 'REMAINING sub-44px controls (5 common screens)');
show(fonts, 'REMAINING sub-16px fields');
show(new Map(Object.entries(fb.t)), 'FORM BUILDER sub-44px controls');
show(new Map(Object.entries(fb.f)), 'FORM BUILDER sub-16px fields');
await browser.close();
