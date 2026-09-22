# Build Brief — Unified Board Report, Savings, Split Receipts & Leftover Materials

**App:** Sychar Operations (audit.fracturedrv.com) — Node/Express, Postgres, vanilla JS.
**Supersedes:** docs/board-report-decisions.md where they conflict. In particular, decisions #1 (leave Forward Focus alone) and #4 (findings' flag out of scope) are **reversed**: Forward Focus merges into the Board Report. Everything else in that doc stands unless changed below.

**Sequencing:** The audit engine is in flight. Don't entangle the two — finish and commit the current audit-engine phase, then work this on its own branch/sequence. Commit per phase (§12).

**Context for every decision:** this system is Ben's own operations tracking. The camp's official books live in a separate bookkeeping system kept by the treasurer. Report figures are labeled as operations tracking, not accounting. Year = calendar year (Jan–Dec).

## 0. Guardrails

- Real data in the DB. Additive migrations only; existing flags, expenses, admin tasks, and savings migrate and never vanish.
- Vanilla JS, existing conventions (snake_case DB, PascalCase row shapes, generic dirty-guard, combobox component, attachments pipeline).
- Everything stored must be visible and queryable in-app. No opaque blobs for anything a user would want to look at later (snapshot HTML is fine *in addition to* structured rows, not instead of them).

## 1. Investigate first

1. **Expenses:** current schema and UI for WO expenses — table(s), fields, attachments/receipts, how they roll into WO cost.
2. **Savings:** how admin-task savings are stored today (amount, recurring vs one-time, period), and every place they render.
3. **Calendar event types:** is there an event-type concept on calendar_events? If not, what distinguishes events today?
4. **Forward Focus:** full contents of the Forward Focus report — sections, inclusion rules beyond board_focus, where it's linked in the UI.
5. **Recurrence projection:** can the existing recurrence expansion (the machinery behind generateDueWorkOrdersForRange) return *future* occurrences read-only, without materializing?

If a finding contradicts this brief in a way that forces a real choice, stop and report. Otherwise log findings and proceed.

## 2. One report: Board Report absorbs Forward Focus

- Single report with two halves: **Done** (backward-looking) and **Coming Up** (forward-looking), plus the money/savings header and the narrative summary.
- The Forward Focus report is retired once its content lives in Coming Up. Remove its route/tab and its separate send path.
- `work_orders.board_focus` and `condition_findings.board_focus` are **kept** and relabeled in the UI as **"Feature on board report."** Meaning: include this item in the Coming Up section regardless of date window. Add the same flag at the **job-line** level.
- The existing **Work Performed** report stays as-is; it serves as the detailed variant for anyone who wants more.

## 3. Report entities, drafts, and saved sends

- Tables: `board_reports` (id, title/period label, status draft|published, period_start, period_end, forward_start, forward_end, summary_notes TEXT, created/published timestamps), `board_report_items` (report_id, item_type, item_id, section, included bool, display_mode, report_note TEXT, sort_index, snapshot fields), `board_report_sends` (id, report_id, sent_at, recipients, subject, was_draft bool, snapshot_html, snapshot_text).
- **One working draft at a time.** Editing happens on the draft; autosaved; generic dirty-guard applies.
- **Publish** freezes the report: all item snapshot fields, all aggregates (counts, money, savings, backlog, visitor activity), notes. Published reports are read-only and listed as history.
- **Every send is saved permanently**, draft or published: exactly what went out (rendered HTML + text), to whom, when. Sending a draft requires a confirm and prefixes the subject/body with "DRAFT". If a corrected version is sent later, both sends remain.
- Report history screen: list of published reports and all sends; open any to view exactly as sent.

## 4. Periods

- Default backward period: since the last published report's period_end (first-ever report: start of current month) through today.
- **Forward window defaults to the same length as the backward period.** Both independently adjustable on the report screen.

## 5. What gets suggested (pre-checked unless noted)

**Done section**
- **Job lines** resolved within the backward period — line-level, not WO-level. A WO with 2 of 5 lines done this period contributes those 2 lines.
- Admin tasks in the period whose status counts as work performed. Pre-checked if `include_in_board_report` is true (existing semantics), unchecked if false.

**Coming Up section**
- WOs/job lines with a scheduled date in the forward window.
- **Scheduler occurrences in the forward window, including ones not yet materialized** — projected read-only from the recurrence machinery. Once materialized, the real WO replaces the projection (no duplicates).
- **Calendar events whose event type is set to show on the board report.** Add a per-event-type setting `show_on_board_report` (default off). If event types don't exist yet, add a minimal event-type table and backfill.
- Items flagged **"Feature on board report"** (WO, job line, condition finding) regardless of date.
- **Overdue** items.

Everything above is a suggestion. **Every item in every section is toggleable.** Nothing is force-included.

## 6. The report screen (draft editor)

- A grid grouped by section (Done / Coming Up / Overdue / Admin Work).
- **WOs are expandable rows** (arrow) revealing their job lines, each with its own checkbox. WO checkbox is **tri-state**: all / some (indeterminate) / none. Checking a WO checks all its lines; unchecking clears all.
- **Display mode per WO: Summary (default for every WO) or Itemized.**
  - Summary renders one line: WO title, progress this period ("6 of 18 tasks complete this period"), cost this period, optional report note.
  - Itemized renders the included lines individually.
  - No size threshold — summary is the default for everything; itemize is a deliberate per-WO choice.
- **Notes:**
  - One **summary/overview** field at the top (paragraphs and line breaks at minimum).
  - An optional **per-item report note** (WO, line, task, event) via a small "add note" link; renders only if filled.
  - Report notes are **board-facing and separate from WO internal notes.** Never pull WO notes into the report automatically.
- Live preview pane or Preview button showing the rendered report as the board will see it.

## 7. Money header & rollups

- **Spent this period** and **Spent year-to-date** (calendar year) — from expenses/purchase allocations.
- **Savings:** shown separately as
  - **Recurring savings** (annualized rate, e.g. "$3,300/yr") — secured this period, plus running total secured to date.
  - **One-time savings this period** (bulk discounts, one-off deals).
  - Never summed into a single figure.
- Section subtotals (hours/cost); grand rollup at the bottom.
- Footer label: figures reflect maintenance/operations tracking, not the camp's official books.

## 8. Savings — one model, multiple sources

- Admin-task savings (existing) — keep, ensure each is tagged **recurring (annual)** or **one-time**.
- **Purchase savings**: regular price − paid price, one-time, recorded at purchase.
- The report's savings figures aggregate across sources by type. Queryable/exportable like other report data.

## 9. Purchases & split receipts

- A **purchase** = one receipt: vendor, date, total paid, optional **regular price**, receipt attachment, line items (material, qty, unit, paid, regular).
- **Splits:** a purchase (or each line item) is allocated across one or more destinations: WO, job line, admin task, or **Leftover/stock**. Allocations by quantity; cost and savings follow proportionally.
- A single-job purchase is just a one-way split — everyday entry must stay as fast as today's expense entry.
- **Savings are counted once, at purchase**, on the full quantity. Allocation distributes cost and savings shares; it never creates new savings.
- **Migrate existing WO expenses** into purchases with a single split to their WO, preserving amounts, dates, attachments.
- WO cost rollups read from allocations.

## 10. Materials & leftovers (explicitly NOT an inventory system)

- **Materials list:** named materials with unit (e.g. "Drywall ½" 4×8" — sheets). Searchable combobox with substring matching; "add new" inline. Line items and splits reference a material when applicable (optional).
- **Leftovers captured at exactly one moment: WO close.** When a WO moves to Review/closed and has material allocations, prompt: **"Any materials left over?"** — per material, quantity remaining (blank = none). Entered quantities go to the leftover balance at the per-unit price actually paid.
- **Reminder at point of use:** adding a material to a WO/job line, or logging a purchase of a material with a leftover balance, shows **"You should have 4 sheets of Drywall ½" 4×8 left."** Options: use them (allocates from leftovers at the original paid unit price, reducing balance) or **correct the count**.
- **Corrections are logged, never silent overwrites:** each balance change is a movement row (in from WO-close, out to a job, correction with optional note, tossed/damaged). Balance = sum of movements. History visible per material.
- **Tossed/damaged:** a movement type zeroing unusable leftovers; report may note the write-off cost.
- **Report reflects sourcing:** materials drawn from leftovers shown as "from on-hand stock" vs purchased new; leftover use moves cost at paid price and is **not** new savings.
- No counts, reorder points, stock dashboard, or locations. A single "Materials on hand" list is the only screen.

## 11. Out of scope

- Purchase *planning* across upcoming jobs (shopping lists) — future phase.
- Auto-emailing receipts to the treasurer — future.
- Budget-vs-actual (no budget figure in the system yet).
- Any integration with the camp's bookkeeping system.

## 12. Build phases

1. Investigation (§1), committed to the analysis doc.
2. Purchases + splits + regular price + expense migration (§9); savings generalization (§8).
3. Materials list + leftover prompt at WO close + point-of-use reminder + movements (§10).
4. Report entities, draft/publish, saved sends, history (§3), periods (§4).
5. Unified report: suggestion rules incl. scheduler projection and event-type setting (§5), Forward Focus retirement and flag relabel (§2).
6. Report screen grid: expandable/tri-state WOs, summary/itemized, notes, preview (§6); money header and rollups (§7).

## 13. Acceptance checklist

**Report**
- [ ] One report with Done + Coming Up; Forward Focus retired; "Feature on board report" flag on WOs, job lines, findings pulls items into Coming Up regardless of date.
- [ ] Done section is job-line level: 2 of 5 lines done this period → those 2 appear under the WO.
- [ ] Forward window defaults to backward length; both adjustable.
- [ ] Scheduler occurrences in the window appear before materialization, and never duplicate after.
- [ ] Event types have a show-on-board-report setting; excluded types never appear.
- [ ] Every item toggleable; tri-state WO checkbox works; summary is the default display for every WO; itemize per WO.
- [ ] Summary notes and optional per-item report notes; WO internal notes never leak in.
- [ ] Publish freezes everything including aggregates; published report renders identically months later.
- [ ] Every send (draft or published) stored with exact content, recipients, timestamp; draft sends confirmed and labeled DRAFT.
- [ ] Money header: spent this period, spent YTD; savings split recurring vs one-time, never combined; section subtotals and bottom rollup; operations-tracking label.

**Purchases & materials**
- [ ] One receipt splits across multiple WOs/tasks/leftovers by quantity; cost and savings follow proportionally; single-job entry as fast as before.
- [ ] Regular price produces one-time savings counted once at purchase.
- [ ] Existing WO expenses migrated with no loss.
- [ ] Closing a WO with material allocations prompts for leftovers; entered amounts become balances at paid unit price.
- [ ] Adding/purchasing a material with a balance shows the reminder; using leftovers allocates at original price and is not counted as savings.
- [ ] Corrections and tossed/damaged are logged movements with visible history; balance always equals the sum of movements.
