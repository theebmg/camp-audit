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
