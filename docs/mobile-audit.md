# Mobile-Friendliness Audit

**Verified with a real browser engine, not by reading code.** `scripts/screens.mjs`
drives **WebKit** (the engine Safari uses) at four widths, screenshots every screen, and
measures page-body overflow, sub-44px tap targets, sub-16px input fonts and console
errors. 124 captures per run.

```
BASE=https://audit.fracturedrv.com USER_NAME=mobaudit PASS=… node scripts/screens.mjs before|after
```

Screenshots: `docs/mobile-screens/{before,after}/<viewport>/<screen>.png` — **53 MB, so
gitignored**, local to this checkout. 31 screens × 4 widths per phase.

## Results

| Width | Body overflow before → after | Sub-16px input fonts |
|---|---|---|
| 393 (iPhone 14 Pro) | **10 screens → 0** | 878 → 37 |
| 360 (small Android) | **10 screens → 0** | — |
| 760 (narrow desktop) | 1 → 0 | — |
| 1440 (desktop) | 0 → 0 | 886 (desktop, intentional) |

Console errors: **2 pre-existing, 0 introduced.** I did introduce one (`filterToggle` null
→ hard pageerror on the Add item panel) and the screenshot run caught it; fixed before
this was written.

## Caveats — emulation is not a real iPhone

Worth checking by hand on the actual device, because emulation can't reproduce them:

- **Collapsing Safari toolbar.** I moved everything to `100dvh`, but whether pinned
  footers truly clear the toolbar only shows on hardware.
- **On-screen keyboard.** Whether a focused field stays visible with the keyboard up, and
  whether pinned footers cover the input. `visualViewport` handling is **not** implemented
  yet — see Not yet done.
- **Notch and home indicator.** `env(safe-area-inset-*)` is now applied but reports 0 in
  emulation, so the padding is untested in effect.
- **Momentum scrolling** inside the nested panel scrollers.
- **Landscape** on the runner and WO card view — not captured this pass.

## Screen inventory

| Screen | 393px | Notes |
|---|---|---|
| dashboard | OK | overdue strip fits; tiles wrap |
| work-orders | OK | |
| wo-detail (card view) | OK | checklist, notes, photos reachable |
| locations | OK | |
| asset-profile | OK | header, condition, history |
| calendar | fixed | overflowed 4px at 360 via a button |
| inbox | OK | |
| admin-tasks | OK | |
| audit-picker | OK | |
| audit-rounds | OK | |
| audit-new-round | OK | 404 console error, pre-existing — see below |
| audit-form-builder | **fixed** | was **+2333px**, the worst in the app |
| map | OK | |
| notes | OK | |
| expenses | OK | |
| expense-detail | fixed | was +90px (393) / +123px (360) |
| materials | OK | `no;` viewport warning, pre-existing |
| capital-plan | fixed | was +41px — a card wider than the viewport |
| requests / crew / crew-hours | OK | |
| maintenance-log / activity-log | OK | |
| admin-hub | OK | |
| reports-board | fixed | tab strip overflow |
| **reports-add-item** | **fixed** | the trigger — see below |
| reports-explorer | fixed | was +283px |
| reports-work-performed / deferred / visitor / audit-data | fixed | all tab strip |

Overlays reached during the run: Add item panel, new-round scope picker, form builder.
**Not yet captured:** audit runner section screens, review screen, Flag something else,
split editor, leftover prompts, reorder sheet, reopen prompt — these need fixture data or
multi-step navigation the script doesn't do yet. **That is the biggest gap in this pass.**

## What was wrong, and what changed

**Viewport meta** — `maximum-scale=1` blocked pinch-zoom for no benefit, and
`viewport-fit=cover` was absent so safe-area insets could never resolve. Now
`width=device-width, initial-scale=1, viewport-fit=cover`.

**`100vh` → `100dvh`** (4 places). iOS Safari's collapsing toolbar makes `100vh` taller
than the visible area, which pushes a pinned footer under the chrome.

**Safe areas were absent from the entire app** — `env(safe-area-inset-*)` appeared **zero
times**, including on `.reorder-sheet`, the one full-screen surface. So a pinned header
sat under the notch and a footer under the home indicator. Added to the sheet, full-screen
modals and toasts.

**The report tab strip was the single most common fault** — 7 screens at phone width. A
row of fixed-padding buttons is simply wider than 393px. It scrolls inside its own
container now instead of taking the page body with it.

**The form builder was the worst single screen at +2333px** — a long prompt and a
`white-space: nowrap` action block on one line. Both wrap; nested follow-ups indent less
per level so deep chains stay on screen.

**Add item panel (the trigger)** — type and status chips now collapse behind a
**`Filters · N`** control that carries the active count, so the list keeps the height and a
collapsed filter is never a hidden one. The text box and *Show already used* stay visible.
The panel is full-screen under 760px with its own internal scroll (the generic
full-screen rule would otherwise have given it a second, competing scroller).

**Phone rules added globally:** tables and `pre` scroll in their own container; images
capped at 100%; long text wraps with `overflow-wrap: anywhere`; 44px minimum tap targets
with clearance between adjacent ↑/↓ and × buttons; 16px inputs so iOS stops zooming on
focus; keyboard shortcut legends hidden.

## Console errors

| Error | Screens | Status |
|---|---|---|
| `404` on a resource | audit-new-round | **Pre-existing, not fixed** — needs tracing to the failing request |
| `Viewport argument key "no;" not recognized` | materials, expense-detail | **Pre-existing, not fixed** — a malformed viewport directive injected by one of these screens, not the index meta (which is now clean) |
| `filterToggle.addEventListener` null | reports-add-item | **Introduced by me, fixed** |

## Table classification (Q7) — for review

The rule: tables I act on from the phone become stacked label:value cards; report and
data tables keep horizontal scroll inside their own container. Implemented as one
attribute — `data-card="1"` on the table — plus two CSS blocks in the `max-width:760px`
media query. `applyCardTableLabels()` runs inside `setApp()` and stamps each body cell's
`data-label` from that table's own `<thead>`, so no screen has to remember to do it and a
new column can never ship an unlabelled cell. A header cell that is empty (an action or
icon column) produces no label, because "​: ✎ ✕" is noise.

Every `<table>` in the app, with its call: 14 in total.

### Cards below 760px (`data-card="1"`)

| Table | app.js | Why |
|---|---|---|
| Work order list | `renderWorkOrders` :9060 | The list you work from in the field. |
| Expenses / receipt inbox | `renderAllExpensesTab` :4281 | Receipts get split and assigned on the phone. |
| Admin tasks | `renderAdminTasks` :4632 | Checked off away from a desk. |
| Asset list | `renderLocations` :1704 | The way into everything else on site. |

### Horizontal scroll, inside the table's own box

| Table | app.js | Why |
|---|---|---|
| Capital planning | `renderCapitalPlan` :3670 | Read across years; comparing columns is the point. Already has its own cards/table toggle — left in place, so the user can still opt into cards. |
| Maintenance log | `renderMaintenanceLog` :4791 | Data table. Same pre-existing cards/table toggle, left in place. |
| Audit data (reports explorer) | `renderReportsExplorer` :5076 | Arbitrary user-chosen columns; there is no stable label set to stack. |
| Activity log | `renderActivityLog` :6278 | Chronological data table, read not acted on. |
| Applicability matrix | `renderAdminApplicability` :7045 | A matrix. Stacking it destroys the grid that carries the meaning. |
| Crew hours | `renderCrewHours` :13052 | Data table. |
| Crew | `renderCrew` :13192 | **Judgment call — flagging it.** It has row actions, so by the letter of the rule it could be a card list, but adding and deactivating crew is office work, not field work. Left as scroll. Say the word and it's a one-attribute change. |

### Neither

| Table | app.js | Why |
|---|---|---|
| Job line grid | `mountJobLineGrid` :11112 | Desktop-only by design, gated at 900px (Q8). Never rendered on a phone. |

### Named in the brief but not tables at all

Four of the surfaces the brief listed as tables are already `div`-based list rows, so they
stack natively and needed nothing:

- **Findings** — `.list-item` rows.
- **Materials on hand** — `renderMaterialsOnHand` :9292, `.mat-row` list items.
- **Audit round building list** — `.round-row` / `.inst-row` list items.
- **Board report** — `renderBoardReport` :5238, `.list-item.br-row` flex rows.
- **Round report** — `renderAuditRoundReport` :9771, `.list-item` rows.

They do get the Q6 44px treatment, which is where they actually needed work.

## Work order screen on a phone (Q8)

The 900px gate stays. Below it:

- **Lines show as cards.** `jobLineCardHtml` :12244 renders every line as a
  `<details class="card jl-card">` — status, notes and photos inside. This is the only
  rendering below 900px; the grid is a separate, additive surface.
- **One line can be added.** The `#addJlForm` "+ Add Job Line" form is in the WO detail
  markup at every width.
- **One line can be edited.** Each card's own controls; no grid needed.
- **Grid button is hidden**, not merely disabled, below 900px (:12462).
- **New:** a one-line note under the button row, shown only below 900px, saying each line
  opens below and that editing several at once is easier in the grid on a desktop. Without
  it the absence of the button reads as a missing feature rather than a deliberate split.

## Not yet done — needs another pass

- **Runner, review, Flag something else, split editor, materials prompts, reorder sheet,
  reopen prompt** — not captured; the script can't reach them without fixtures.
- **`visualViewport` keyboard handling** — pinned footers may still cover a focused input
  with the keyboard open. Not implemented.
- **Combobox dropdown** — not verified against the viewport top or with a keyboard open.
- **Landscape.**
- **Tables → stacked cards.** Tables currently scroll horizontally inside their container,
  which stops the page overflowing but is not the "stacked cards preferred for anything I
  act on" the brief asks for. **Needs your call on which tables.**
- **2,352 sub-44px tap targets remain at 393px.** The count is dominated by inline `<a>`
  links inside text, which arguably shouldn't be 44px tall. Raising every one would change
  the look of every screen. **Needs your call:** buttons and row actions only, or links too?
- **Job-line grid on a phone** — untouched this pass. It no longer overflows the page, but
  I have not confirmed whether it's genuinely usable or whether it should fall back to
  cards. Not yet decided.
