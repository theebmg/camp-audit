// Does a search input resist font-size for the same reason a select resists min-height —
// WebKit enforcing a native control's metrics? Test before changing anything. Throwaway.
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
await page.waitForTimeout(1800);
await page.evaluate(() => window.go('reports', { mode: 'board' }, { reset: true }));
await page.waitForTimeout(1800);
await page.locator('#brAddItem').click({ timeout: 6000 });
await page.waitForTimeout(1200);

const out = await page.evaluate(() => {
  const el = document.querySelector('.addpanel-q');
  const read = () => ({ fontSize: getComputedStyle(el).fontSize, appearance: getComputedStyle(el).webkitAppearance });
  const before = read();
  el.style.webkitAppearance = 'none';
  el.style.appearance = 'none';
  const afterAppearance = read();
  // And the ✕ in the grid, for the other half.
  const x = document.querySelector('.jlg-remove');
  return { before, afterAppearance, jlgRemovePresent: !!x };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
