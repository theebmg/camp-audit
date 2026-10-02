import { webkit } from 'playwright';
const BASE = process.env.BASE, USER = process.env.USER_NAME, PASS = process.env.PASS;
const b = await webkit.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto(BASE, { waitUntil: 'networkidle' });
await p.waitForSelector('#loginForm', { timeout: 15000 });
await p.fill('#loginForm input[name=username]', USER);
await p.fill('#loginForm input[name=password]', PASS);
await p.click('#loginForm button[type=submit]');
await p.waitForFunction(() => !document.getElementById('loginForm'), { timeout: 15000 });
await p.waitForTimeout(2000);

for (const [label, path, opts] of [
  ['GET  /gmail/status', '/api/pg/gmail/status', {}],
  ['GET  /gmail/oauth/start', '/api/pg/gmail/oauth/start', {}],
]) {
  const r = await p.evaluate(async ([pth, o]) => {
    const res = await fetch(pth, { credentials: 'same-origin', ...o });
    const txt = await res.text();
    return { status: res.status, body: txt.slice(0, 400) };
  }, [path, opts]);
  console.log(`\n${label}  -> ${r.status}`);
  console.log(`  ${r.body}`);
}
await ctx.close(); await b.close();
process.exit(0);
