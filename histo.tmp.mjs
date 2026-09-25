// Why is the accent swatch still 22 wide when .accent-swatches > .accent-swatch says 44?
// Throwaway.
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
await page.waitForTimeout(2000);

const out = await page.evaluate(() => {
  const el = document.querySelector('.accent-swatch');
  if (!el) return { missing: true };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const parent = el.parentElement;
  // Does the rule exist in a stylesheet this document actually loaded, and does the
  // element match it?
  let ruleFound = null;
  for (const ss of document.styleSheets) {
    try {
      for (const rule of ss.cssRules) {
        const scan = (r2) => {
          if (r2.cssRules) { for (const inner of r2.cssRules) scan(inner); return; }
          if (r2.selectorText && r2.selectorText.includes('accent-swatch') && (r2.cssText || '').includes('44px')) {
            ruleFound = { selector: r2.selectorText, css: r2.cssText.slice(0, 160),
              matches: el.matches(r2.selectorText) };
          }
        };
        scan(rule);
      }
    } catch { /* cross-origin */ }
  }
  return {
    box: `${Math.round(r.width)}x${Math.round(r.height)}`,
    width: cs.width, height: cs.height, minWidth: cs.minWidth, minHeight: cs.minHeight,
    padding: cs.padding, flexBasis: cs.flexBasis, flexShrink: cs.flexShrink,
    boxSizing: cs.boxSizing,
    inlineStyle: el.getAttribute('style'),
    parentClass: parent.className,
    parentDisplay: getComputedStyle(parent).display,
    parentWidth: Math.round(parent.getBoundingClientRect().width),
    siblings: parent.children.length,
    ruleFound,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
