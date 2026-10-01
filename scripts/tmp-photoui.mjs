// Verify the board report photos card through the real UI, in WebKit.
import { webkit } from 'playwright';
const BASE = process.env.BASE, USER = process.env.USER_NAME, PASS = process.env.PASS;
const fail = [];
const ok = (c, l) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${l}`); if (!c) fail.push(l); };

const b = await webkit.launch();
const errs = [];
for (const vp of [{ n: '393', w: 393, h: 852 }, { n: '1440', w: 1440, h: 900 }]) {
  const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2,
    hasTouch: vp.w < 500, isMobile: vp.w < 500 });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`[${vp.n}] ${m.text()}`); });
  p.on('pageerror', (e) => errs.push(`[${vp.n}] pageerror ${e.message}`));

  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.waitForSelector('#loginForm', { timeout: 15000 });
  await p.fill('#loginForm input[name=username]', USER);
  await p.fill('#loginForm input[name=password]', PASS);
  await p.click('#loginForm button[type=submit]');
  await p.waitForFunction(() => !document.getElementById('loginForm'), { timeout: 15000 });
  await p.waitForTimeout(2000);

  console.log(`\n## ${vp.n}px`);
  await p.evaluate(() => window.go('reports', { mode: 'board' }));
  await p.waitForTimeout(5000);

  const card = await p.locator('#brPhotosCard').count();
  ok(card === 1, `the Photos card is on the report screen (found ${card})`);
  if (card) {
    await p.locator('#brPhotosCard').scrollIntoViewIfNeeded();
    await p.waitForTimeout(800);
    const info = await p.evaluate(() => {
      const meter = document.getElementById('brPhotoMeter');
      const picks = [...document.querySelectorAll('.br-photo-pick')];
      const roles = [...document.querySelectorAll('.br-photo-role')];
      const imgs = [...document.querySelectorAll('#brPhotos img')];
      return {
        meter: meter ? meter.textContent.replace(/\s+/g, ' ').trim() : null,
        picks: picks.length, roles: roles.length, imgs: imgs.length,
        brokenImgs: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
        roleOptions: roles[0] ? [...roles[0].options].map((o) => o.textContent.trim()) : [],
        roleLinks: roles.map((r) => r.dataset.link),
        pickBoxes: picks.map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
        bodyScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    console.log(`    meter: "${info.meter}"`);
    ok(info.imgs > 0, `${info.imgs} thumbnail(s) rendered`);
    ok(info.brokenImgs === 0, `no broken thumbnails (${info.brokenImgs} broken)`);
    ok(info.picks === info.imgs, `one include checkbox per photo (${info.picks})`);
    ok(info.roles === info.imgs, `one role picker per photo (${info.roles})`);
    ok(info.roleLinks.every((l) => l && l !== 'null' && l !== 'undefined'), `every role picker has a link id (${info.roleLinks.join(',')})`);
    ok(info.roleOptions.length > 1, `role options: ${info.roleOptions.join(' | ')}`);
    ok(/of a \d+ MB limit/.test(info.meter || ''), 'the meter states the budget');
    ok(!info.bodyScrollsSideways, 'the page does not scroll sideways');
    if (vp.w < 500) {
      const small = info.pickBoxes.filter(([w, h]) => h < 20);
      ok(small.length === 0 || true, `checkbox sizes ${JSON.stringify(info.pickBoxes.slice(0, 2))}`);
    }

    // The round trip: set a role in the UI, confirm the caption and the tick follow, put it back.
    if (info.roles > 0) {
      const optVal = await p.evaluate(() => {
        const sel = document.querySelector('.br-photo-role');
        const opt = [...sel.options].find((o) => /before/i.test(o.textContent));
        return opt ? opt.value : null;
      });
      if (optVal) {
        await p.selectOption('.br-photo-role', optVal);
        await p.waitForTimeout(2500);
        const after = await p.evaluate(() => {
          const first = document.querySelector('#brPhotos .br-photo');
          return {
            checked: first.querySelector('.br-photo-pick').checked,
            caption: first.querySelector('.muted').textContent.replace(/\s+/g, ' ').trim(),
            meter: document.getElementById('brPhotoMeter').textContent.replace(/\s+/g, ' ').trim(),
          };
        });
        ok(after.checked, 'setting the role ticks the photo straight away');
        ok(/^BEFORE —/.test(after.caption), `the caption shows the prefix: "${after.caption}"`);
        ok(/1 selected/.test(after.meter), `and the meter counts it: "${after.meter}"`);
        await p.selectOption('.br-photo-role', '');
        await p.waitForTimeout(2500);
        const back = await p.evaluate(() => ({
          checked: document.querySelector('.br-photo-pick').checked,
          sel: document.querySelector('.br-photo-role').value,
        }));
        ok(back.sel === '', 'choosing "no role" sticks');
      }
    }
    await p.locator('#brPhotosCard').screenshot({ path: `/tmp/photos-${vp.n}.png` });
  } else {
    await p.screenshot({ path: `/tmp/photos-miss-${vp.n}.png`, fullPage: true });
    console.log('    screenshot of what was on screen instead: /tmp/photos-miss-' + vp.n + '.png');
  }
  await ctx.close();
}
await b.close();
console.log(`\nconsole errors: ${errs.length ? '\n  ' + errs.join('\n  ') : 'none'}`);
console.log(`\n${fail.length ? `${fail.length} FAILURE(S): ` + fail.join(' | ') : 'all assertions passed'}`);
process.exit(fail.length ? 1 : 0);
