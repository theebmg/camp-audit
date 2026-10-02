import { webkit } from 'playwright';
const BASE = process.env.BASE, USER = process.env.USER_NAME, PASS = process.env.PASS;
const b = await webkit.launch();
for (const vp of [{ n: 'desktop', w: 1440, h: 900 }, { n: 'phone', w: 393, h: 852 }]) {
  const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.w < 500, isMobile: vp.w < 500 });
  const p = await ctx.newPage();
  const logs = [];
  p.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  p.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.waitForSelector('#loginForm', { timeout: 15000 });
  await p.fill('#loginForm input[name=username]', USER);
  await p.fill('#loginForm input[name=password]', PASS);
  await p.click('#loginForm button[type=submit]');
  await p.waitForFunction(() => !document.getElementById('loginForm'), { timeout: 15000 });
  await p.waitForTimeout(2000);
  await p.evaluate(() => window.go('reports', { mode: 'board' }));
  await p.waitForTimeout(5000);

  console.log(`\n=== ${vp.n} (${vp.w}px) ===`);
  const btn = p.locator('.br-open-report').first();
  const n = await p.locator('.br-open-report').count();
  console.log(`  Past Reports buttons: ${n}`);
  if (!n) { console.log('  (no past reports listed)'); await ctx.close(); continue; }

  const box = await btn.boundingBox();
  console.log(`  button box: ${box ? `x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)}` : 'NOT RENDERED'}`);
  console.log(`  viewport width ${vp.w} — button right edge at ${box ? Math.round(box.x + box.width) : '?'}`);
  console.log(`  OFF SCREEN: ${box ? (box.x + box.width > vp.w || box.x < 0) : 'n/a'}`);
  const rowOverflow = await p.evaluate(() => {
    const el = document.querySelector('.br-open-report');
    if (!el) return null;
    const row = el.closest('.list-item');
    return { rowScrollW: row.scrollWidth, rowClientW: row.clientWidth, bodyScroll: document.documentElement.scrollWidth, win: window.innerWidth };
  });
  console.log(`  row overflow: ${JSON.stringify(rowOverflow)}`);

  const titleBefore = await p.textContent('h3');
  await btn.click({ force: true });
  await p.waitForTimeout(5000);
  const after = await p.textContent('body');
  console.log(`  after click — read-only banner present: ${/read-only/i.test(after)}`);
  console.log(`  heading before: "${titleBefore.trim().slice(0, 40)}"`);
  console.log(`  heading after : "${(await p.textContent('h3')).trim().slice(0, 40)}"`);
  const errs = logs.filter((l) => /error|PAGEERROR/i.test(l));
  console.log(`  console errors: ${errs.length ? errs.join(' | ') : 'none'}`);
  await ctx.close();
}
await b.close();
process.exit(0);
