// Screenshot every screen at several widths, in WebKit (the Safari engine), and collect
// console errors per screen. Dev-only: playwright is a devDependency and the production
// image is built with `npm ci --omit=dev`, so none of this ships.
//
//   BASE=https://audit.fracturedrv.com USER_NAME=mobaudit PASS=… node scripts/screens.mjs before
//
// Pass 2 adds the field screens — the runner, the WO card view, the split editor, the
// leftover prompt — which cannot be reached against an empty database. Make the data
// first, and take it away afterwards:
//
//   docker exec camp-audit node scripts/fixtures.mjs create
//   … run this …
//   docker exec camp-audit node scripts/fixtures.mjs delete
//
// The fixtures are found by name at runtime rather than by id, so no ids have to be
// carried between the two scripts.
//
// Emulation is not a real iPhone. Anything depending on the real Safari toolbar
// collapsing, momentum scrolling, or the on-screen keyboard has to be checked by hand —
// those are called out in docs/mobile-audit.md. The keyboard cases below reproduce the
// GEOMETRY a keyboard creates, which is what the layout code reacts to; they do not
// reproduce the keyboard.
import { webkit } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = process.env.BASE || 'https://audit.fracturedrv.com';
const USER = process.env.USER_NAME || 'mobaudit';
const PASS = process.env.PASS;
const PHASE = process.argv[2] || 'before';
const ONLY = process.argv[3] || null;      // optional screen-id substring filter
const OUT = path.join('docs', 'mobile-screens', PHASE);
const FIXTURE_TAG = '[FIXTURE]';

if (!PASS) { console.error('PASS is required'); process.exit(1); }

// 393x852 is the iPhone 14 Pro. The others bracket it: a small Android, a narrowed
// desktop window, and full desktop. `kbHeight` is how tall the visible band becomes on
// that device once the keyboard is up — used by the keyboard cases below.
const VIEWPORTS = [
  { name: '393-iphone14pro', width: 393, height: 852, mobile: true, kbHeight: 516 },
  { name: '360-android',     width: 360, height: 800, mobile: true, kbHeight: 480 },
  { name: '760-narrow',      width: 760, height: 1000, mobile: false },
  { name: '1440-desktop',    width: 1440, height: 900, mobile: false },
  // Landscape. A phone on its side is how a lot of field photography happens, and it is
  // where a runner section or a WO card view runs out of vertical room first.
  { name: '852-landscape',   width: 852, height: 393, mobile: true, landscape: true },
];

// ── helpers the screen definitions use ───────────────────────────────────
const tap = (p, sel, timeout = 5000) => p.locator(sel).first().click({ timeout });
const wait = (p, ms) => p.waitForTimeout(ms);

// Keyboard, part one — geometry. visualViewport cannot be faked from outside the page, so
// `keyboard: 'geometry'` shrinks the real viewport to the band a keyboard would leave.
// The layout code reads that band, so a combobox with nowhere to hang below really does
// have to flip above its input, and placeResults() is genuinely under test.
//
// Keyboard, part two — the --kb custom property that lifts bottom-pinned chrome. That one
// is ours, so `keyboard: 'inset'` drives it directly.
async function forceKeyboardInset(page, px) {
  await page.evaluate((n) => {
    document.documentElement.style.setProperty('--kb', `${n}px`);
    document.documentElement.classList.toggle('kb-open', n > 90);
  }, px);
  await wait(page, 200);
}
async function clearKeyboardInset(page) {
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--kb');
    document.documentElement.classList.remove('kb-open');
  });
}

// ── screens ──────────────────────────────────────────────────────────────
// `ids` carries the fixture record ids discovered after login. A screen that needs one
// and does not get it is skipped and reported as such, rather than silently passing.
function screensFor(ids) {
  return [
    // ---- pass 1: every screen reachable by view name ----
    { id: 'dashboard',        view: 'dashboard' },
    { id: 'work-orders',      view: 'workOrders' },
    { id: 'wo-detail',        view: 'workOrders', open: async (p) => { await tap(p, '.list-item, tr[data-id]'); } },
    { id: 'locations',        view: 'locations' },
    { id: 'asset-profile',    view: 'locations', open: async (p) => {
        await tap(p, '.list-item'); await wait(p, 600); await tap(p, '.list-item');
      } },
    { id: 'calendar',         view: 'calendar' },
    { id: 'inbox',            view: 'inbox' },
    { id: 'admin-tasks',      view: 'adminTasks' },
    { id: 'audit-picker',     view: 'auditPicker' },
    { id: 'audit-rounds',     view: 'auditRounds' },
    { id: 'audit-new-round',  view: 'auditRounds', open: async (p) => { await tap(p, '#newRoundBtn'); } },
    { id: 'audit-form-builder', view: 'auditRounds', open: async (p) => { await tap(p, '.edit-form'); } },
    // The map, with an explicit check that it still renders cabins and their holders exactly
    // as before — People did not move cabin_holders, and this is the proof rather than the
    // claim. Ben asked for it by name.
    { id: 'map',              view: 'map',
      extra: async (p) => p.evaluate(async () => {
        // The map draws into an inline <svg id="mapSvg"> via createElementNS — there is no
        // .map-pin class and no <img>. An earlier version of this check looked for both and
        // reported an empty map that was in fact fine.
        const svg = document.getElementById('mapSvg');
        const api = async (u) => { try { const r = await fetch(u); return r.ok ? r.json() : null; } catch { return null; } };
        const pins = await api('/api/pg/map/pins');
        // listMapPins returns holderName (camelCase, from assets.lodge_holder) — not a
        // PascalCase key like most row shapes here, which is why this took two tries.
        const withHolder = (pins?.pins || []).filter((x) => x.holderName);
        return {
          svgPresent: !!svg,
          baseImagePresent: !!svg?.querySelector('image'),
          svgShapes: svg ? svg.querySelectorAll('circle, path, polygon, rect, text').length : 0,
          apiPinCount: (pins?.pins || []).length,
          apiPinsWithHolder: withHolder.length,
        };
      }) },

    // ---- People & Groups (§1) ----
    { id: 'people',           view: 'people',
      extra: async (p) => p.evaluate(() => ({
        rows: document.querySelectorAll('table[data-card="1"] tbody tr').length,
        unlinkedBannerShown: /Unlinked holdings/i.test(document.body.textContent),
        cabinHolderPills: [...document.querySelectorAll('.pill')].filter((e) => /cabin holder/i.test(e.textContent)).length,
      })) },
    { id: 'person-profile',   view: 'people',
      open: async (p) => { await tap(p, 'table[data-card="1"] tbody tr', 5000); await wait(p, 900); },
      extra: async (p) => p.evaluate(() => ({
        hasCabinsSection: /Cabins/i.test(document.body.textContent),
        hasVisitsSection: /Visits/i.test(document.body.textContent),
        hasMergeButton: !!document.getElementById('mergeBtn'),
      })) },
    { id: 'person-edit',      view: 'people',
      open: async (p) => {
        await tap(p, 'table[data-card="1"] tbody tr', 5000); await wait(p, 900);
        await tap(p, '#editBtn', 4000); await wait(p, 700);
      },
      extra: async (p) => p.evaluate(() => ({
        roleCheckboxes: document.querySelectorAll('.p-role').length,
        // The derived role must NOT be offered as a checkbox.
        offersCabinHolderCheckbox: [...document.querySelectorAll('.skill-chip')].some((l) => /cabin holder/i.test(l.textContent)),
        volunteerFieldsHiddenByDefault: document.getElementById('volWrap')?.hidden ?? null,
      })),
      after: async (p) => { await tap(p, '.modal-cancel', 1500).catch(() => {}); } },
    { id: 'person-merge',     view: 'people',
      open: async (p) => {
        await tap(p, 'table[data-card="1"] tbody tr', 5000); await wait(p, 900);
        await tap(p, '#mergeBtn', 4000); await wait(p, 900);
      },
      after: async (p) => { await tap(p, '.modal-cancel', 1500).catch(() => {}); } },
    { id: 'holdings',         view: 'holdings',
      extra: async (p) => p.evaluate(() => ({
        unlinkedCount: (document.body.textContent.match(/Unlinked \((\d+)\)/) || [])[1] || null,
        allCount: (document.body.textContent.match(/All \((\d+)\)/) || [])[1] || null,
      })) },
    { id: 'groups',           view: 'groups' },
    { id: 'group-new',        view: 'groups',
      open: async (p) => { await tap(p, '#addGroupBtn', 4000); await wait(p, 700); },
      after: async (p) => { await tap(p, '.modal-cancel', 1500).catch(() => {}); } },

    { id: 'notes',            view: 'notes' },
    { id: 'expenses',         view: 'expenses' },
    { id: 'expense-detail',   view: 'expenses', open: async (p) => { await tap(p, '.list-item'); } },
    { id: 'materials',        view: 'materials' },
    { id: 'capital-plan',     view: 'capitalPlan' },
    { id: 'requests',         view: 'requests' },
    { id: 'crew',             view: 'crew' },
    { id: 'crew-hours',       view: 'crewHours' },
    { id: 'maintenance-log',  view: 'maintenanceLog' },
    { id: 'activity-log',     view: 'activityLog' },
    { id: 'admin-hub',        view: 'admin' },
    { id: 'reports-board',    view: 'reports', params: { mode: 'board' } },
    { id: 'reports-add-item', view: 'reports', params: { mode: 'board' }, open: async (p) => { await tap(p, '#brAddItem', 6000); await wait(p, 800); } },
    { id: 'reports-explorer', view: 'reports', params: { mode: 'explorer' } },
    { id: 'reports-work-performed', view: 'reports', params: { mode: 'workPerformed' } },
    { id: 'reports-deferred', view: 'reports', params: { mode: 'deferredBacklog' } },
    { id: 'reports-visitor',  view: 'reports', params: { mode: 'visitorActivity' } },
    { id: 'reports-audit-data', view: 'reports', params: { mode: 'auditData' } },

    // ---- pass 2, priority 1: the audit runner ----
    // Every section in turn. The runner numbers its sections, so walk them by index
    // rather than by name — a reworded section must not silently drop out of the audit.
    { id: 'round-detail',     view: 'auditRound', params: { id: ids.roundId }, needs: 'roundId' },
    { id: 'runner-s1',        view: 'auditRunner', params: { id: ids.instanceId }, needs: 'instanceId' },
    // Exactly as many section captures as the form has — discovered, not guessed. Guessing
    // six against a three-section form quietly photographed section 3 four times, because
    // #nextSec is simply absent on the last one.
    ...Array.from({ length: Math.max(0, (ids.sectionCount || 1) - 1) }, (_, i) => i + 2).map((n) => ({
      id: `runner-s${n}`, view: 'auditRunner', params: { id: ids.instanceId }, needs: 'instanceId',
      open: async (p) => {
        for (let i = 1; i < n; i++) { await tap(p, '#nextSec', 3000); await wait(p, 700); }
      },
    })),
    // A follow-up question only exists once its parent answer is chosen. Every option is
    // an .opt-btn; tapping the first one on section 1 is the shortest route to one.
    { id: 'runner-followup',  view: 'auditRunner', params: { id: ids.instanceId }, needs: 'instanceId',
      open: async (p) => { await tap(p, '.opt-btn', 4000); await wait(p, 1100); } },
    // Photo capture is not a click test: clicking a file input opens the OS chooser, which
    // proves nothing about the app. What matters is how the input is declared — no
    // `capture`, so the photo library is offered and not just the camera, and `multiple`
    // where more than one photo makes sense. That is assertable, so assert it.
    //
    // It has to be asserted on the section that HAS photos. In the seed form that is the
    // last one (Condition); the first two sections are identification and access and carry
    // none, so asserting on section 1 reported "0 image inputs" and looked like a bug.
    { id: 'runner-photo',     view: 'auditRunner', params: { id: ids.instanceId }, needs: 'instanceId',
      open: async (p, ids2) => {
        for (let i = 1; i < (ids2.sectionCount || 1); i++) { await tap(p, '#nextSec', 3000).catch(() => {}); await wait(p, 600); }
        await tap(p, '.opt-btn', 4000).catch(() => {});
        await wait(p, 700);
      },
      extra: async (p) => p.evaluate(() => {
        const inputs = [...document.querySelectorAll('input[type=file]')]
          .filter((el) => (el.getAttribute('accept') || '').includes('image'));
        return {
          imageInputs: inputs.length,
          withCaptureAttr: inputs.filter((el) => el.hasAttribute('capture')).length,
          withMultiple: inputs.filter((el) => el.hasAttribute('multiple')).length,
          // The label wrapping a hidden file input is the real tap target.
          labelHeights: inputs.map((el) => {
            const lab = el.closest('label');
            return lab ? Math.round(lab.getBoundingClientRect().height) : 0;
          }),
        };
      }) },
    { id: 'runner-flag-other', view: 'auditRunner', params: { id: ids.instanceId }, needs: 'instanceId',
      open: async (p) => { await tap(p, '#adhocBtn', 4000); await wait(p, 900); } },
    { id: 'runner-review',    view: 'auditReview', params: { id: ids.instanceId }, needs: 'instanceId' },
    // Generation: #completeBtn is "Create work order" when the review is dirty and "Mark
    // complete" when it is clean. Screenshot the button and whatever confirm it raises —
    // never press through, so the fixture round stays re-runnable.
    { id: 'runner-generate',  view: 'auditReview', params: { id: ids.instanceId }, needs: 'instanceId',
      open: async (p) => { await tap(p, '#completeBtn', 4000); await wait(p, 900); },
      after: async (p) => { await tap(p, '.modal-cancel', 1500).catch(() => {}); } },
    { id: 'round-report',     view: 'auditRoundReport', params: { id: ids.roundId }, needs: 'roundId' },

    // ---- priority 2: the work order in the field ----
    { id: 'wo-card-view',     view: 'workOrderDetail', params: { id: ids.workOrderId }, needs: 'workOrderId' },
    { id: 'wo-line-open',     view: 'workOrderDetail', params: { id: ids.workOrderId }, needs: 'workOrderId',
      open: async (p) => { await tap(p, '.jl-card summary', 4000); await wait(p, 600); } },
    // Adding one line on the phone (Q8). The form is in the markup at every width; what
    // is being checked is that it is reachable and usable without the grid.
    { id: 'wo-add-line',      view: 'workOrderDetail', params: { id: ids.workOrderId }, needs: 'workOrderId',
      open: async (p) => { await p.locator('#addJlForm').scrollIntoViewIfNeeded({ timeout: 4000 }); await wait(p, 500); },
      extra: async (p) => p.evaluate(() => {
        const form = document.getElementById('addJlForm');
        const grid = document.getElementById('editLinesBtn');
        return {
          addLineFormPresent: !!form,
          gridButtonHidden: grid ? grid.hidden : null,
          // The Q8 note only appears below the 900px gate.
          desktopNoteShown: /easier in the grid/i.test(document.body.textContent),
          lineCards: document.querySelectorAll('.jl-card').length,
        };
      }) },
    { id: 'wo-checklist',     view: 'workOrderDetail', params: { id: ids.workOrderId }, needs: 'workOrderId',
      open: async (p) => { await tap(p, '#attachChecklistBtn, #checklistSections summary', 4000); await wait(p, 700); } },
    { id: 'wo-log',           view: 'workOrderDetail', params: { id: ids.workOrderId }, needs: 'workOrderId',
      open: async (p) => { await p.locator('#addLogEntryForm').scrollIntoViewIfNeeded({ timeout: 4000 }); await wait(p, 500); } },
    { id: 'wo-reorder-sheet', view: 'workOrderDetail', params: { id: ids.workOrderId }, needs: 'workOrderId',
      open: async (p) => { await tap(p, '#reorderLinesBtn', 4000); await wait(p, 800); } },
    // Reopen prompt: it is raised by adding or resolving a line on a DONE work order. The
    // fixture WO is open, so rather than closing it — which would consume the fixture and
    // change what every later screen sees — the prompt is reached by completing the WO,
    // screenshotting, and cancelling out.
    // The confirm that closing a WO raises. Cancelled, so the WO stays open for every
    // screen after this one; the leftover prompt that comes AFTER confirming is captured
    // once, at the very end (see 'wo-leftover-prompt').
    { id: 'wo-close-prompt',  view: 'workOrderDetail', params: { id: ids.workOrderId }, needs: 'workOrderId',
      open: async (p) => { await tap(p, '#completeWoBtn', 4000); await wait(p, 1200); },
      extra: async (p) => p.evaluate(() => {
        const box = document.querySelector('.modal-box');
        return {
          promptShown: !!box,
          promptFitsScreen: box ? Math.round(box.getBoundingClientRect().height) <= window.innerHeight : null,
        };
      }),
      after: async (p) => { await tap(p, '.modal-cancel', 1500).catch(() => {}); } },

    // ---- priority 3: money in the field ----
    { id: 'receipt-detail',   view: 'expenseDetail', params: { id: ids.receiptId }, needs: 'receiptId' },
    { id: 'split-editor',     view: 'expenseDetail', params: { id: ids.receiptId }, needs: 'receiptId',
      open: async (p) => { await tap(p, '#splitExpenseBtn', 4000); await wait(p, 1000); } },
    // The same editor against a receipt with NO line items — the whole-receipt,
    // split-by-dollar-amount case, which is how emailed receipts actually arrive.
    { id: 'split-flat-receipt', view: 'expenseDetail', params: { id: ids.flatReceiptId }, needs: 'flatReceiptId',
      open: async (p) => { await tap(p, '#splitExpenseBtn', 4000); await wait(p, 1000); } },

    // ---- priority 4: materials ----
    { id: 'materials-on-hand', view: 'materials' },
    { id: 'material-detail',  view: 'materials',
      open: async (p) => { await tap(p, '.mat-row, .list-item', 4000); await wait(p, 700); } },
    { id: 'count-correction', view: 'materials',
      open: async (p) => {
        await tap(p, '.mat-row, .list-item', 4000); await wait(p, 700);
        await tap(p, '#matCorrect', 4000); await wait(p, 800);
      },
      after: async (p) => { await tap(p, '.modal-cancel', 1500).catch(() => {}); } },
    // The point-of-use reminder ("you should have 2 each of X left — use it on this job?")
    // fires from remindMaterialOnHand, which is wired to ONE place: the material picker on
    // a receipt line inside the split editor. Not to opening a job line, which is where the
    // brief's wording pointed and where this screen first looked for it.
    { id: 'point-of-use',     view: 'expenseDetail', params: { id: ids.receiptId }, needs: 'receiptId',
      open: async (p) => {
        await tap(p, '#splitExpenseBtn', 4000); await wait(p, 1000);
        await tap(p, '#liMaterialPicker .cbx-input, #liMaterialPicker input', 4000);
        await wait(p, 700);
        // Pick the first tracked material; the fixture put all three in stock.
        await tap(p, '#liMaterialPicker .cbx-item', 3000).catch(() => {});
        await wait(p, 1200);
      },
      extra: async (p) => p.evaluate(() => ({
        reminderShown: /should have .* left/i.test(document.body.textContent),
        dialogShown: !!document.querySelector('.modal-box'),
      })),
      after: async (p) => { await tap(p, '.modal-cancel', 1500).catch(() => {}); } },

    // ---- priority 5: the keyboard ----
    // Geometry first: the visible band really is short, so a combobox has to flip above
    // its input instead of hanging under the keyboard.
    { id: 'kb-combobox-flip', view: 'newWorkOrder', keyboard: 'geometry',
      open: async (p) => {
        await tap(p, '.cbx-input, .ac-input', 5000);
        await wait(p, 800);
      },
      extra: async (p) => p.evaluate(() => {
        const r = document.querySelector('.ac-results:not([hidden])');
        if (!r) return { comboboxOpen: false };
        const input = r.parentElement.querySelector('.ac-input, .cbx-input');
        const ir = input.getBoundingClientRect(); const rr = r.getBoundingClientRect();
        return {
          comboboxOpen: true,
          flippedAbove: r.classList.contains('cbx-above'),
          listBottom: Math.round(rr.bottom), listTop: Math.round(rr.top),
          inputTop: Math.round(ir.top),
          insideViewport: rr.top >= -1 && rr.bottom <= window.innerHeight + 1,
        };
      }) },
    // Then the inset: a sticky Save row and a toast have to ride above the keyboard.
    { id: 'kb-bottom-chrome', view: 'reports', params: { mode: 'board' }, keyboard: 'inset',
      open: async (p) => {
        // The add-item panel is the screen with filters above a list and a footer below —
        // exactly the shape the keyboard interferes with.
        await tap(p, '#brAddItem', 5000).catch(() => {});
        await wait(p, 800);
        await tap(p, '.addpanel-filtertoggle', 2500).catch(() => {});
      },
      extra: async (p) => p.evaluate(() => {
        const kb = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--kb'), 10) || 0;
        const toast = document.querySelector('.toast');
        return {
          kbVar: kb,
          kbOpenClass: document.documentElement.classList.contains('kb-open'),
          toastBottom: toast ? Math.round(getComputedStyle(toast).bottom) : null,
        };
      }) },
    // And the runner itself with the keyboard up: a note field must stay visible.
    { id: 'kb-runner-note',   view: 'auditRunner', params: { id: ids.instanceId }, needs: 'instanceId',
      keyboard: 'geometry',
      open: async (p) => { await tap(p, 'textarea, .q-note', 4000).catch(() => {}); await wait(p, 600); } },

    // ---- last, because it consumes the fixture ----
    // The leftover-materials prompt only appears AFTER the close is confirmed, so this one
    // presses through. That closes the fixture work order, which is why it runs once, on
    // the primary phone viewport, at the very end — every screen before it still sees an
    // open WO, and the fixture is deleted afterwards anyway.
    { id: 'wo-leftover-prompt', view: 'workOrderDetail', params: { id: ids.workOrderId }, needs: 'workOrderId',
      once: true,
      open: async (p) => {
        // Three steps, not one: confirm the close (it writes pending asset updates), then
        // confirm settling the still-open lines, and only then does promptLeftoversOnClose
        // run. Pressing once landed on the open-lines confirm and reported "no leftover
        // prompt", which was the harness stopping early, not the app.
        await tap(p, '#completeWoBtn', 4000); await wait(p, 1200);
        for (let i = 0; i < 2; i++) {
          await tap(p, '.modal-confirm', 3000).catch(() => {});
          await wait(p, 1500);
          if (await p.locator('.modal-box:has(.leftover-qty)').count()) break;
        }
        await wait(p, 600);
      },
      extra: async (p) => p.evaluate(() => {
        const box = document.querySelector('.modal-box');
        const text = box ? box.textContent : document.body.textContent;
        return {
          promptShown: !!box,
          // The leftover prompt is the one with a quantity field per material — that is a
          // fact about the DOM, not a guess from the wording.
          isLeftoverPrompt: !!document.querySelector('.leftover-qty'),
          materialRows: document.querySelectorAll('.leftover-qty').length,
          mentionsLeftover: /left ?over|left on|remaining|in stock|on hand/i.test(text),
          promptFitsScreen: box ? Math.round(box.getBoundingClientRect().height) <= window.innerHeight : null,
        };
      }) },
  ];
}

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
    // Tap targets below 44px, and inputs whose font-size would make iOS zoom. Only the
    // controls Q6 covers count — a link inside prose is deliberately left alone, so
    // counting it here would report a problem that is not one.
    const CONTROL = 'button, .btn, select, [role=button], input[type=checkbox], input[type=radio],'
      + ' .view-toggle-btn, label.skill-chip, .chip-row > label, .q-note, .o-remedy, .o-follow,'
      + ' .rm-edit, .rm-del, .q-edit, .q-del, .br-note, .list-item[data-view], .list-item[data-id],'
      + ' .round-row, .inst-row, .mat-row, .add-cand, .br-open-output, .edit-form, .pf-pick';
    const small = [];
    const smallFont = [];
    // What you aim at is not always the element itself. A checkbox's drawn box stays 22px
    // on purpose — a 44px checkbox looks like a bug — and the LABEL around it carries the
    // 44px; a hidden file input's label IS the button. Measuring the input in those cases
    // reports a problem that was deliberately solved, which is how 644 "offenders" showed
    // up unchanged after the rule that fixed them shipped.
    const hitTarget = (el) => (/^(checkbox|radio|file)$/.test(el.type || '')
      ? (el.closest('label') || el) : el);
    for (const el of document.querySelectorAll(CONTROL)) {
      const target = hitTarget(el);
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 44 || r.width < 24) {
        small.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 30),
          via: target === el ? 'self' : 'label',
          text: (target.textContent || '').trim().slice(0, 18), h: Math.round(r.height), w: Math.round(r.width) });
      }
    }
    for (const el of document.querySelectorAll('input, select, textarea')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs && fs < 16) smallFont.push({ tag: el.tagName.toLowerCase(), fontSize: fs, cls: (el.className || '').toString().slice(0, 30) });
    }
    // Any element that overflows its own box horizontally — a table scrolling inside its
    // container is correct and must not be reported as a page problem.
    const scrollers = [...document.querySelectorAll('table, .jlg-scroll, [style*="overflow-x"]')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => ({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 30),
        card: el.getAttribute('data-card') === '1' }));
    return {
      overflow, offenders: offenders.slice(0, 8),
      smallTargets: small.length, smallTargetSample: small.slice(0, 6),
      smallFonts: smallFont.length, smallFontSample: smallFont.slice(0, 4),
      cardTables: document.querySelectorAll('table[data-card="1"]').length,
      scrollTables: scrollers.filter((s) => s.tag === 'table' && !s.card).length,
      bodyFontSize: parseFloat(getComputedStyle(document.body).fontSize),
    };
  });
}

// Find the fixture records by name, from inside the page so the session cookie is used.
async function discoverFixtures(page) {
  return page.evaluate(async (TAG) => {
    const get = async (u) => { try { const r = await fetch(u); return r.ok ? r.json() : null; } catch { return null; } };
    const out = {};
    const rounds = await get('/api/pg/audit-rounds');
    const round = (rounds?.rounds || []).find((r) => (r.Name || '').startsWith(TAG));
    if (round) {
      out.roundId = round.Id;
      const d = await get(`/api/pg/audit-rounds/${round.Id}`);
      const inst = (d?.instances || [])[0];
      if (inst) {
        out.instanceId = inst.Id;
        // How many sections the form actually has, so the runner walk matches it instead
        // of guessing and re-photographing the last section.
        const full = await get(`/api/pg/audit-instances/${inst.Id}`);
        out.sectionCount = (full?.Sections || []).length || 1;
      }
    }
    const wos = await get('/api/pg/work-orders');
    const wo = (wos?.workOrders || []).find((w) => (w.Title || '').startsWith(TAG));
    if (wo) out.workOrderId = wo.Id;
    const exp = await get('/api/pg/expenses');
    const list = exp?.expenses || [];
    const withLines = list.find((e) => (e.Vendor || '').startsWith(`${TAG} Hardware`));
    const flat = list.find((e) => (e.Vendor || '').startsWith(`${TAG} Lumber`));
    if (withLines) out.receiptId = withLines.Id;
    if (flat) out.flatReceiptId = flat.Id;
    return out;
  }, FIXTURE_TAG);
}

// ── run ──────────────────────────────────────────────────────────────────
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

  // Did the stylesheet actually parse? A stray */ inside a comment silently drops the rule
  // after it, and the only symptom is a measurement that refuses to change — which cost
  // three rounds of "the fix is deployed but nothing moved" before it was found. Assert the
  // rules this pass depends on are in the CSSOM, not merely in the file.
  if (vp === VIEWPORTS[0]) {
    const css = await page.evaluate((needed) => {
      const seen = [];
      // Collect the selector AND recurse — not one or the other. Now that CSS Nesting has
      // shipped, a plain CSSStyleRule carries an empty `cssRules` list, which is truthy, so
      // an `if (r.cssRules) … else` walks into nothing and reads no selectors at all. That
      // made the check report every rule missing, including ones measured working.
      const scan = (list) => { for (const r of list) {
        if (r.selectorText) seen.push(r.selectorText);
        if (r.cssRules && r.cssRules.length) scan(r.cssRules);
      } };
      for (const ss of document.styleSheets) { try { scan(ss.cssRules); } catch { /* cross-origin */ } }
      const joined = seen.join(' | ');
      return needed.filter((n) => !joined.includes(n));
    }, ['.cbx-above', '.kb-open', '.accent-swatches > .accent-swatch',
        'label:has(> input[type="file"])', 'table[data-card="1"]']);
    if (css.length) console.log(`  !! STYLESHEET: these rules did not parse: ${css.join(', ')}`);
    else console.log('  stylesheet: all audit rules parsed');
  }

  const ids = await discoverFixtures(page);
  if (vp === VIEWPORTS[0]) {
    const found = Object.entries(ids).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
    console.log(`  fixtures: ${found}`);
    if (!ids.instanceId) console.log('  (no fixture round — run scripts/fixtures.mjs create for the field screens)');
  }

  const SCREENS = screensFor(ids).filter((s) => !ONLY || s.id.includes(ONLY));
  fs.mkdirSync(path.join(OUT, vp.name), { recursive: true });

  for (const s of SCREENS) {
    // A screen whose fixture is missing is reported as skipped. Silently passing it would
    // read as "the runner is fine on a phone" when the runner was never opened.
    if (s.needs && !ids[s.needs]) {
      report.push({ viewport: vp.name, screen: s.id, skipped: `no fixture ${s.needs}` });
      console.log(`  ${vp.name.padEnd(18)} ${s.id.padEnd(24)} SKIP (no ${s.needs})`);
      continue;
    }
    // Landscape only carries the screens where vertical room is the question.
    if (vp.landscape && !/^(runner-|wo-|kb-|round-detail)/.test(s.id)) continue;
    if (s.keyboard && !vp.kbHeight) continue;   // no keyboard on a desktop
    // A screen marked `once` changes state that later screens depend on, so it runs on the
    // primary phone viewport only.
    if (s.once && vp !== VIEWPORTS[0]) continue;

    const before = consoleErrors.length;
    try {
      if (s.keyboard === 'geometry') await page.setViewportSize({ width: vp.width, height: vp.kbHeight });
      await page.evaluate(([view, params]) => window.go(view, params || {}, { reset: true }), [s.view, s.params || {}]);
      await page.waitForTimeout(1400);
      if (s.keyboard === 'inset') await forceKeyboardInset(page, Math.round(vp.height - vp.kbHeight));
      if (s.open) { try { await s.open(page, ids); await page.waitForTimeout(1200); } catch { /* control absent at this width */ } }
      const m = await measure(page);
      const extra = s.extra ? await s.extra(page).catch(() => null) : null;
      await page.screenshot({ path: path.join(OUT, vp.name, `${s.id}.png`), fullPage: false });
      report.push({ viewport: vp.name, screen: s.id, touch: !!vp.mobile, ...m, ...(extra ? { extra } : {}), newConsoleErrors: consoleErrors.slice(before) });
      const flag = m.overflow > 1 ? `OVERFLOW +${m.overflow}px` : 'ok';
      const note = extra ? '  ' + JSON.stringify(extra) : '';
      // 44px targets and 16px fonts are TOUCH requirements — printing them for a desktop
      // viewport invites chasing numbers that were never a problem.
      const touchCols = vp.mobile
        ? `targets<44:${String(m.smallTargets).padStart(3)} fonts<16:${String(m.smallFonts).padStart(2)}`
        : 'targets<44:  - fonts<16: -';
      console.log(`  ${vp.name.padEnd(18)} ${s.id.padEnd(24)} ${flag.padEnd(18)} ${touchCols}${note}`);
      if (s.after) await s.after(page).catch(() => {});
    } catch (e) {
      report.push({ viewport: vp.name, screen: s.id, error: String(e.message).split('\n')[0].slice(0, 120) });
      console.log(`  ${vp.name.padEnd(18)} ${s.id.padEnd(24)} ERROR ${String(e.message).split('\n')[0].slice(0, 60)}`);
    } finally {
      // Leave the next screen a clean page: no overlay, no forced inset, real viewport.
      await page.evaluate(() => document.querySelectorAll('.modal-overlay, .reorder-sheet, .day-panel-overlay').forEach((e) => e.remove())).catch(() => {});
      await clearKeyboardInset(page).catch(() => {});
      if (s.keyboard === 'geometry') await page.setViewportSize({ width: vp.width, height: vp.height }).catch(() => {});
    }
  }
  await browser.close();
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const overflowing = report.filter((r) => r.overflow > 1);
const errs = report.filter((r) => r.newConsoleErrors?.length);
const skipped = report.filter((r) => r.skipped);
const touch = report.filter((r) => r.touch);
const badTargets = touch.filter((r) => r.smallTargets > 0);
const badFonts = touch.filter((r) => r.smallFonts > 0);
console.log(`\n  ${report.length} captures. ${overflowing.length} with body overflow. ${errs.length} with console errors. ${skipped.length} skipped for missing fixtures.`);
console.log(`  touch viewports: ${badTargets.length}/${touch.length} screens with a sub-44px control, ${badFonts.length}/${touch.length} with a sub-16px field.`);
console.log(`  -> ${OUT}/report.json`);
