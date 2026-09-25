// Hypothesis: WebKit ignores author padding/min-height on a <select> while it keeps
// -webkit-appearance: menulist, which is why every select in the app renders as a compact
// 24px native control instead of the 46px box style.css describes. Test it. Throwaway.
import { webkit } from 'playwright';

const BASE = process.env.BASE || 'https://audit.fracturedrv.com';
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
await page.evaluate(() => window.go('reports', { mode: 'board' }, { reset: true }));
await page.waitForTimeout(2000);

const out = await page.evaluate(() => {
  const el = document.querySelector('.br-mode');
  const box = () => { const r = el.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; };
  const before = { box: box(), appearance: getComputedStyle(el).webkitAppearance, minHeight: getComputedStyle(el).minHeight, padding: getComputedStyle(el).padding };
  el.style.webkitAppearance = 'none';
  el.style.appearance = 'none';
  const after = { box: box(), minHeight: getComputedStyle(el).minHeight, padding: getComputedStyle(el).padding };
  return { before, after };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
