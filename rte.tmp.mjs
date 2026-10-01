import { webkit } from 'playwright';
const b = await webkit.launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
await p.goto('https://audit.fracturedrv.com', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#loginForm');
await p.fill('#loginForm input[name=username]', process.env.USER_NAME);
await p.fill('#loginForm input[name=password]', process.env.PASS);
await p.click('#loginForm button[type=submit]');
await p.waitForFunction(() => !document.getElementById('loginForm'));
await p.evaluate(() => window.go('reports', { mode: 'board' }, { reset: true }));
await p.waitForTimeout(3000);
const r = await p.evaluate(() => {
  const body = document.getElementById('brNotes');
  return {
    editorPresent: !!body,
    editable: body?.getAttribute('contenteditable'),
    toolbarButtons: document.querySelectorAll('.rte-btn').length,
    // Ben's dashes should have become real bullets.
    listItems: body?.querySelectorAll('li').length ?? 0,
    nestedLists: body?.querySelectorAll('li ul').length ?? 0,
    paragraphs: body?.querySelectorAll('p').length ?? 0,
    firstBullet: body?.querySelector('li')?.textContent?.slice(0, 60) ?? null,
    stillHasLiteralDash: /^\s*-\s/m.test(body?.textContent || ''),
  };
});
console.log(JSON.stringify(r, null, 2));
console.log(errs.length ? 'PAGE ERRORS: ' + errs.join(' | ') : 'no page errors');
await b.close();
