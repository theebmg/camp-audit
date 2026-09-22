# Board Report — Current-State Analysis

Written 2026-09-22, before any code, against the live schema and database.
Step 1 of the Board Report Rework brief.

## Headline

**The brief's core premise doesn't match the code.** It assumes an auto-rule and a
manual board-report flag are two paths into one report, to be unified. In fact:

- The Board Report **never reads `work_orders.board_focus`.** Not once.
- `board_focus` feeds a *different* report — **Forward Focus**.
- The only manual flag the Board Report honors is on admin tasks, and it is
  **opt-out** (default true), not opt-in.

So there is no duplicate-path problem to solve for work orders. There is a
*missing* path: WOs cannot be manually included or excluded at all today.

## 1. What auto-includes WOs today

`getBoardReportRawData()` — `src/db.js:2360`. Five queries, none referencing any flag.
The one that produces per-WO rows:

```sql
SELECT w.id, w.title, w.date_completed, a.name AS asset_name,
       jl.estimated_cost, jl.actual_cost, jl.funding_sources
FROM work_orders w
JOIN work_order_statuses ws ON ws.id = w.status_id
LEFT JOIN assets a ON a.id = w.asset_id
LEFT JOIN (JOB_LINE_ROLLUP_SQL) jl ON jl.work_order_id = w.id
WHERE ws.name = 'Done' AND w.date_completed BETWEEN $1 AND $2
```

**The rule is: WO status is `Done` and `date_completed` falls inside the chosen
period.** That is the behavior observed as "appears when job lines are done" — it
keys on the *work order's* status and completion date, not on job lines directly,
though in practice a WO reaches Done as its lines complete.

It is not a trigger and not a flag-setting code path. Nothing is written anywhere.
It is a `WHERE` clause evaluated fresh on every Generate.

The other four queries are aggregates over **all** non-terminal WOs, unfiltered by
period or flag:

| Query | Rule |
|---|---|
| `openStatusRes` | one row per WO where `NOT ws.is_terminal` — status/priority counts |
| `openFundingRes` | one row per job line on non-terminal WOs — funding totals |
| `upcomingRes` | job lines, `NOT is_terminal AND scheduled_date >= today` |
| `overdueRes` | job lines, `NOT is_terminal AND scheduled_date < today` |

Note: **upcoming and overdue are already job-line level.** The brief's
"move to job-line granularity" is already true for two of the six sections; the
completed section is the one that actually changes.

## 2. What the manual flags do, and at what levels

Three flags exist. They do not feed the same report.

| Column | Migration | Default | Feeds |
|---|---|---|---|
| `work_orders.board_focus` | 0026 | false | **Forward Focus report** (`getBoardFocusItems`, `/reports/forward-focus/preview`) |
| `condition_findings.board_focus` | 0026 | false | **Forward Focus report** — a third level the brief does not mention |
| `admin_tasks.include_in_board_report` | 0069 | **true** | **Board Report**, Administrative Work section |

`getAdminTasksBoardReportRawData` (`db.js:6023`):
```sql
WHERE s.counts_as_work_performed AND t.include_in_board_report AND t.task_date BETWEEN $1 AND $2
```

**Can the same item reach the report via both paths? No.** Work orders have exactly
one path (the period rule) and their flag goes to a different report. Admin tasks
have exactly one path. There are no duplicates today because there are no parallel
lists today.

0069's own comment records why admin tasks are opt-out: *"Ben couldn't name a task
he'd keep off the report, so the checkbox is an opt-out rather than the WO's opt-in."*

### Naming collision worth knowing
`attachments.include_in_report` and `attachment_roles.default_include_in_report`
(0045/0046) are about **which photos appear in reports**. `resolveIncludeInReport()`
in db.js is attachment logic, unrelated to board membership. A future reader will
assume otherwise.

## 3. Stored entity or live query?

**Entirely live. There is no report entity, no period entity, no snapshot, nothing
persisted.**

- `GET /reports/board/preview?periodStart&periodEnd` → `buildBoardReportPg()` →
  `renderBoardReportHtml()` / `renderBoardReportText()`. Returns HTML and text.
- `POST /reports/board/send` rebuilds the same data and emails it.
- The period is two query params. The frontend (`renderBoardReport`) defaults them to
  month-start → today and re-fetches on **Generate**.
- Nothing is written to the database at any point in generating or sending a report.

**Consequence:** every past report already shifts as work continues. Regenerating
last month's report today can produce different numbers — the open-WO counts,
funding totals, upcoming and overdue sections are all "as of now," not "as of the
period." Only the completed section is period-bounded. The brief's publish-snapshot
requirement is therefore a genuine fix, not a nicety.

`report_favorites` exists but belongs to Reports v1 (saved filter sets), not here.

## 4. What is rendered per item

From `reportDataPg.js` / `reportRender.js`:

| Section | Level | Fields |
|---|---|---|
| Open by status/priority | aggregate | counts only |
| Outstanding by funding source | aggregate | `count`, `totalCost` per source |
| Completed (period) | **work order** | id, title, asset name, date completed, cost, funding source |
| Upcoming | **job line** | job line id + title, scheduled date, parent WO id + title, priority, asset name |
| Overdue | **job line** | same as upcoming |
| Administrative Work | admin task | task list, count, total hours |
| Deferred Maintenance Backlog | aggregate | bucket rollups |
| Visitor Activity / Cabin Holders | aggregate | counts |

Output is print-ready HTML plus a plain-text alternative, delivered on screen or by
email.

## Live data

```
work_orders 6 · board_focus=true 1
condition_findings board_focus=true 0
admin_tasks 3 · include_in_board_report=true 3 (all — it's the default)
job_lines 13
```

Migration volume is trivial. The design questions are not.

## Findings that force a choice — see the decision request

1. **Forward Focus owns `board_focus`.** Repointing it at board-report membership
   changes or breaks a different, working report.
2. **Admin tasks are opt-out; an explicit checked set is opt-in.** All 3 existing
   tasks are included by default today, including any created in future.
3. **Over half the report is aggregates, not items.** Status counts, funding totals,
   deferred backlog, visitor activity have nothing to check or uncheck.
4. **`condition_findings.board_focus`** is a third flag level the brief omits.
5. **Sending.** `/reports/board/send` emails a freshly-built report. Draft/publish has
   to decide what "send" means.

---

# Phase 1 Investigation — Purchases, Savings, Event Types, Forward Focus, Projection

Added 2026-09-22 for the Unified Board Report / Purchases brief (§1).

## 1.1 Expenses — schema and UI

`expenses` (0053), soft-deleted via `deleted_at`:

| Field | Note |
|---|---|
| `vendor`, `amount`, `purchase_date` | the receipt basics |
| `tax_amount`, `tax_charged_in_error` | camp is tax-exempt; flags when charged anyway |
| `category_id` → expense_categories, `fund_id` → funds | accounting attribution |
| `work_order_id`, `job_line_id`, `asset_id` | **already attributable to a job line** |
| `triage_status` | `inbox \| triaged \| void` — an actual inbox workflow |
| `batch_id` → attachment_batches, `source` (`manual \| email`), `parsed_confidence` | **email ingestion pipeline** |
| `notes`, `created_by`, `created_at` | |

Receipts are attachments: `attachment_links.entity_type = 'expense'`, role `Receipt`. No second file store.
Cost rolls into job lines through `JOB_LINE_EXPENSE_COST_SQL`, joined per line in the WO and board queries.
UI: `renderExpenses`, `renderExpenseDetail`, `renderAllExpensesTab`, plus `src/routes/receipt-inbound.js`.

**Live data — this is the decisive part:**

```
expenses 11 (0 deleted) · from email 10 · manual 1
with work_order_id 0 · with job_line_id 0 · triage inbox 0
```

Ten of eleven expenses arrived by **email**. Zero are attached to a work order or job line.

## 1.2 Savings

One column: `admin_tasks.recurring_monthly_savings numeric(12,2)` (0066). 1 row populated.

- Stored **monthly**, not annually.
- There is **no one-time savings concept anywhere**.
- No savings on expenses, WOs, or job lines.

Rendered in exactly one place: `adminWorkSectionHtml` / `adminWorkSectionText` in `reportRender.js`,
fed by `reportDataPg.js:134-142` which computes `monthlySavings`, `annualizedSavings`,
`savingsTaskCount`. Already displays both "$X/month · $Y/year", so the brief's annualized
presentation is a formatting change, not a data change.

## 1.3 Calendar event types — they exist

`calendar_event_types` (0061): `id`, `name`, `sort_order`, `gcal_color_id`, `active`.
Seeded: Constituent Visitation, Volunteer Workday, Group Rental, Board Meeting, Camp Session, Other.
`calendar_events.type_id` is **NOT NULL** — every event already has a real type.

**§5 needs one additive column** (`show_on_board_report boolean NOT NULL DEFAULT false`).
No new table, no backfill.

## 1.4 Forward Focus — smaller than expected

`getBoardFocusItems()` → two queries, `work_orders.board_focus = true` and
`condition_findings.board_focus = true`. **No other inclusion rule.** No sections.

Rendered as one flat table: Type / Item / Asset / Est. Cost.
Routes `/reports/forward-focus/preview` and `/send`; reachable as a tab via `REPORT_TABS`.

**One behavior worth preserving on merge:** cost falls back to `historicalAvgActualCost(templateId)`
for PM-recurring WOs, labeled "(hist. avg)". A forward-looking cost grounded in what the job has
actually cost before, rather than a stale estimate. Coming Up should keep this.

## 1.5 Recurrence projection — yes, and it already solves the dedupe

`listCalendarEventOccurrences(fromDate, toDate)` is a **pure read**. It expands recurrence over any
range and LEFT-joins `calendar_event_generated_wo`, building `genByKey` so each occurrence knows
whether a real WO already exists for it.

The cap at today lives in `generateDueWorkOrdersForRange`, **not** in the lister. Asking for a future
range returns projected occurrences and writes nothing.

So §5's "projected occurrences that never duplicate once materialized" is close to free: render the
real WO where `gen` is present, a projection where it isn't.

Caveat: **0 calendar events currently recur** (`recurrence_type <> 'none'` → 0 rows), so this path has
no live data. Testing needs a fixture.

## Findings that force a choice

**`purchases` vs `expenses` — see the decision request.** The brief introduces a `purchases` entity
(vendor, date, total paid, regular price, receipt attachment, line items). `expenses` already *is*
that entity, plus tax handling, fund/category attribution, a triage inbox, and an email-ingestion
pipeline that produced 10 of the 11 rows in the system. Building `purchases` beside it would create
a second receipt table and a second ingestion story.

Secondary, non-blocking, logged here:

- **Savings unit.** Brief says "recurring (annual)"; the column is monthly. Recommend one
  `savings_entries` read model (kind `recurring | one_time`, amount, basis) with the admin-task
  column migrated in and the task form writing through it — keeping the column *and* adding a
  general table would be the dual-source pattern we've been removing.
- **"Migrate existing WO expenses" has nothing to migrate** — 0 expenses link to a WO or job line.
  The migration is real but empty; allocations should still prefer `job_line_id` over
  `work_order_id` when a future row has both.

---

# The five original leans, and how the brief resolved them

The Unified Board Report brief says it "supersedes docs/board-report-decisions.md."
That file never existed — these five points were raised in conversation on 2026-09-22
after the current-state analysis above, and answered by the brief. Recorded here so the
supersedes line points at something real.

| # | Question raised | My lean | How the brief resolved it |
|---|---|---|---|
| 1 | Forward Focus owns `board_focus`. Leave it alone, fold it in, or retire it? | Leave it alone — separate report, separate purpose | **Reversed.** Forward Focus merges into the Board Report's Coming Up section and is retired; `board_focus` is kept and relabeled "Feature on board report" (§2) |
| 2 | Admin tasks are opt-out (default true); an explicit checked set is opt-in. What happens to that semantic? | *No lean — flagged as the one I couldn't call* | Existing semantics preserved: admin tasks in the period pre-checked when `include_in_board_report` is true, unchecked when false (§5) |
| 3 | Over half the report is aggregates with nothing to toggle. Snapshot without making them toggleable? | Snapshot at publish, not toggleable | Confirmed: publish freezes all aggregates — counts, money, savings, backlog, visitor activity (§3); toggling applies to items (§5) |
| 4 | `condition_findings.board_focus` is a third flag level the brief omitted. In scope? | Leave to Forward Focus | **Reversed.** In scope — the findings flag pulls items into Coming Up, and the same flag is added at job-line level (§2) |
| 5 | `/reports/board/send` emails a freshly-built report. Does send work on drafts, published, or both? | Both, labeled | Confirmed and extended: every send is stored permanently with its exact content; draft sends require a confirm and are prefixed "DRAFT" (§3) |

Net: two reversed (1, 4), two confirmed (3, 5), one answered where I had no lean (2).

## Phase 2 decisions (from the reply to the §1 investigation)

- **Extend `expenses`; do not build `purchases`.** Add `regular_price`,
  `expense_line_items`, `expense_allocations`. Tax, funds, triage and email ingestion
  keep working exactly as they do. "Purchase" is the UI label for an expense that has
  line items.
- **Line items are optional.** An emailed receipt with no line items is still
  splittable as a whole, **by dollar amount**. Splitting never requires itemizing.
- **Drop the expense-migration step** — 0 expenses link to a WO or job line, so there
  is nothing to migrate.
- **One `savings_entries` table**, kind `recurring | one_time`.
  `admin_tasks.recurring_monthly_savings` moves into it and **the old column is
  retired** — not kept alongside. Recurring entries store amount and period; the report
  presents them annualized. Purchase discounts (regular − paid) write `one_time`
  entries when the expense is recorded.
- **Event types:** one additive `show_on_board_report` column, default off.
- **Projection:** use `listCalendarEventOccurrences`; real WO where one exists,
  projection where it doesn't. A recurring-event fixture is needed to test the path,
  since no live recurring events exist.
- **Keep the historical-average cost** for recurring WOs in Coming Up, labeled
  "(hist. avg)".
