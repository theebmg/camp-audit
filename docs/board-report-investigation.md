# Board Report — Investigation (Oct 2026)

Findings only. **No calculation has been changed.** Every figure below was read from the live
database and the current code; where I have a recommendation it is marked as one and is
waiting on Ben's confirmation.

The report under investigation is **id 1, "September 2026"**, status `draft`, period
`2026-09-01 → 2026-09-23`, forward to `2026-10-15`, created `2026-09-23 17:57`.

---

## 1. Spent total mismatch — the two numbers measure different things

| Where | Figure | What it actually is |
|---|---|---|
| Header, "Spent this period" | **$935.47** | `SUM(expenses.amount)` for receipts dated in the period |
| Header, "Spent year to date" | **$935.47** | the same sum from Jan 1 — identical because every receipt this year falls in September |
| Footer, "Total" | **$1,885.18** | `SUM(snap_cost)` over every **included report item** |

**These were never the same quantity.** The header is *money that left the bank* — seven real
receipts. The footer is *cost recorded on job lines*, which is a different thing: an estimate
or a committed figure attached to a line of work, which may be unpaid, may be paid across
several receipts, or may never become a receipt at all.

The seven receipts behind $935.47:

| Vendor | Amount | Date |
|---|---|---|
| Amazon | $55.64 | 09-10 |
| Amazon | $119.99 | 09-10 |
| Amazon | $47.16 | 09-10 |
| Rural King | $29.39 | 09-10 |
| Lowe's | $299.40 | 09-14 |
| Lowe's | $349.00 | 09-17 |
| Amazon | $34.89 | 09-18 |
| | **$935.47** | |

The $1,885.18 is the sum of `snap_cost` across all 21 included items — which, as §2 shows, is
mostly rows the report does not display.

**So even after the double-count in §2 is fixed, these two numbers will not match, and should
not.** One is spend, the other is the value of work recorded. If you want them to relate, that
is a separate decision about what the footer is *for*.

> **Needs your call.** Three options, and I have not implemented any of them:
> 1. Footer totals only what is **visible** (recommended — see §2), and is relabelled
>    "Work shown" so it is not read as spend.
> 2. Footer shows **spend attributable to the shown items**, by following expense allocations
>    to those job lines. Truthful, but will usually read $0 — almost nothing is split yet.
> 3. Drop the footer money column entirely and let the header be the only money figure.

---

## 2. Item count mismatch — a real bug, and the clearest one

**21 counted, 6 rendered. The 15 missing are job lines hidden by their work order's display
mode.**

A work order on the report can be shown as `summary` (one row for the whole WO) or `itemized`
(a row per job line). All three work orders here are set to **summary**, so their job lines are
deliberately not rendered.

`sectionHtml()` gets this right — it builds a `visible` list, and its per-section subtotal uses
it (`src/reportRender.js:317-333`):

```js
const visible = rows.filter((i) => !(i.ItemType === 'job_line' && summaryWoIds.has(i.ParentWorkOrderId)));
const hours = visible.reduce(...);   //  correct
const cost  = visible.reduce(...);   //  correct
```

The grand footer does not (`src/reportRender.js:337-339`):

```js
const included = items.filter((i) => i.Included);   // <- every job line is still in here
const grandHours = included.reduce(...);
const grandCost  = included.reduce(...);
```

So the footer counts and totals **15 rows the reader cannot see**, including $86.18 + $800 +
$440 + $379 + $180 = $1,885.18 of job-line costs:

| Hidden line | Parent WO | Cost |
|---|---|---|
| Replace hinges on gate. Reset gate | 47 Front Gate Repair | $86.18 |
| Have wall removed … beam put up … | 54 Caretaker's Renovations | $800.00 |
| Drywall total cost | 54 | $440.00 |
| Replace Sump Pump | 60 Sump Pump Replacement | $379.00 |
| Install Dehumidifier | 60 | $180.00 |
| 10 further lines on WO 54 | 54 | $0 / null |

Checked directly against the database:

| | items | hours | cost |
|---|---|---|---|
| Footer maths as written | 21 | 3.5 | $1,885.18 |
| Visible maths | **6** | **3.5** | **$0.00** |

**Recommended fix:** the footer uses the same `visible` rule the sections already use. One
change, in one place, and the three numbers then agree by construction.

**But that alone makes the footer read `6 items · 3.5h · $0.00`,** which is worse, not better —
and that leads straight to §2b.

### 2b. The deeper problem: a summary work order carries no money

A WO shown in `summary` mode renders **one row with no cost, no hours and (mostly) no date**,
because `snap_cost`, `snap_hours` and `snap_date` on the work-order row are all null — the
money lives on the job lines, which summary mode hides.

That is exactly your §5 observation that "Work Completed items show no cost, hours, or date."
It is not a data-entry problem. It is that **summary mode hides the lines without rolling them
up**.

| Report row | snap_cost | snap_hours | snap_date |
|---|---|---|---|
| Sump Pump Replacement in Caretaker's | null | null | **null** |
| Caretaker's Renovations | null | null | **null** |
| Front Gate Repair | null | null | 2026-09-17 |

> **Needs your call.** My recommendation: a summary WO row should show the **sum of its own job
> lines** — cost, hours, and the latest line date — so Front Gate Repair reads `$86.18`, Sump
> Pump reads `$559.00`, and Caretaker's reads `$1,240.00`. The footer then totals the three
> visible WOs plus the three admin tasks and comes to **$1,885.18 · 3.5h · 6 items**, which
> reconciles with itself and still differs from the $935.47 of receipts for the honest reason
> in §1.
>
> This changes a displayed figure, so I have not done it.

---

## 3. Reporting period — ends on the day the draft was created

`period_end` is **2026-09-23**, which is the day the draft was created, not the end of the
month. From `defaultBoardReportPeriods()` (`src/db.js:6070-6077`):

```js
const start = rows[0]?.period_end || `${todayStr.slice(0, 7)}-01`;  // last report's end, else the 1st
return { periodStart: start, periodEnd: todayStr, ... };            // <- always "today"
```

So the period runs from the previous report's end to **the moment you opened the screen**. For
a monthly report that is never the right end date unless you happen to create it on the last of
the month.

The date is already editable on the report screen; the default is the problem.

Consequence for the figures: the period ends 09-23, so **8 receipts totalling $978.07 fall in
September but only 7 totalling $935.47 are counted.** One $42.60 receipt dated after the 23rd
is outside the window.

> **Needs your call.** Recommended: default to the **full calendar month that is ending** —
> `period_start` = the 1st, `period_end` = the last day of that month — and keep both editable.
> The forward window would follow from `period_end` rather than from today.

---

## 4. Recurring savings $3,240/year — the stored figure is $270/month, not $277

One row in `savings_entries`:

| id | kind | amount | period | source | occurred_on |
|---|---|---|---|---|---|
| 2 | recurring | **270.00** | monthly | admin_task 6 | 2026-09-22 |

`270 × 12 = 3,240`. The header is arithmetically correct for what is stored.

The **$277/month** in the Phone/Internet note is a different number from the one recorded as the
saving. $277 × 12 would be $3,324.

**Nothing changed, as instructed.** This is a data question: either the stored saving should be
277, or the note is describing something else (a bill amount rather than a saving, perhaps).
Tell me which and I will correct the record.

---

## 5. Duplicate / misfiled items — yours vs. mine

| Observation | Whose | Why |
|---|---|---|
| "Phone and Internet Plans" and "Internet Service Upgrade/Savings" are the same work twice | **Data (yours)** | Two separate rows: admin tasks **4** (09-16, 1.0h, Planning) and **6** (09-22, 1.0h, no category). Both have `include_in_board_report = true`. The report is faithfully showing two tasks because two exist. |
| "Fixed NVR Hard Drive" under Administrative | **Data (yours)** | It is admin task **5**, category "Other". Administrative is where admin tasks go. If it is maintenance it wants to be a work order, or we need a rule that moves some categories elsewhere — tell me which. |
| Work Completed shows no cost/hours/date | **Code (mine)** | §2b above. Summary mode hides the lines and does not roll them up. |
| Sump pump has no status or date at all | **Code (mine)**, mostly | WO 60 *is* `Done`, completed 2026-09-23 — the data is fine. The report row's `snap_date` is null because the work-order snapshot never captured `date_completed`. Same root cause as §2b. |
| "Caretaker's Renovations" shows status **Reported** | **Data (yours)** | WO 54's status genuinely is `Reported` and `date_completed` is null, while its lines are marked done. If the work is finished the WO wants closing. |
| "featured since September 2026" | **Code, working as designed** | Driven by `work_orders.board_focus = true` and `board_focus_set_at`. WO 54 was flagged 2026-09-23, WO 47 on 2026-09-24. The label is the featured-flag expiry feature from the earlier brief: it tells you how long something has been held up to the board, so a permanent fixture becomes obvious. Sump Pump (WO 60) is **not** flagged — it is on the report because its lines completed in the period. |

---

## 6. From the earlier board-report rework brief — what shipped

| Item | Status |
|---|---|
| Job-line-level flagging | **Shipped** — `board_report_items.item_type = 'job_line'` with `parent_work_order_id` |
| Draft → publish model | **Shipped** — `board_reports.status`, one draft at a time via a partial unique index |
| Per-item note field | **Shipped** — `report_note`, rendered under the item |
| Unflag from the report screen | **Shipped** — the include/exclude checkbox per row |
| Summary vs itemized display per WO | **Shipped** — and is the direct cause of §2 |
| Manually added items | **Shipped** — `manually_added` |

Nothing from that brief appears outstanding. The §2 bug is a gap *created* by the
summary/itemized feature: it was taught to the sections and not to the footer.

---

## Part 2 — investigation items answered before building

### B. Are images resized on ingest? **Yes — that shipped.**

`src/storage.js:36-38, 131-145`:

- Full copy: longest edge **2000px**, **JPEG quality 82**, EXIF stripped by the re-encode
- Thumbnail: longest edge **400px**
- Non-images (PDFs) pass through untouched with no thumbnail
- EXIF is read from the original *before* the resize, so date/GPS survive as columns

`attachments` stores `width`, `height`, `file_size`, so the size meter in B has real data to
add up without touching storage.

**So Part B's resize is mostly already done at 2000px.** What is missing is an *email-specific*
copy at ~1600px — which is the right thing to add, since the stored copy is the one the app
displays and should stay larger.

### C. Can a photo be linked to a job line? **Not today — and no schema change is needed.**

`attachment_links` is `(attachment_id, entity_type, entity_id, role_id, …)`. The `entity_type`
column is free text, gated in JS by `ATTACHMENT_ENTITY_TYPES`, which **already includes
`job_line`**. Current usage:

| entity_type | links |
|---|---|
| expense | 6 |
| work_order | 4 |
| incoming_item | 1 |

So the table supports it, the allowlist permits it, and nothing is using it yet. Linking a
photo to a job line needs **UI only** — no migration.

The role vocabulary for C's labels is `attachment_roles`, admin-editable as required:

| Role | Default in report |
|---|---|
| Before / Condition | **yes** |
| After / Repair | **yes** |
| During | no |
| Evidence, Reference, Documentation, Quote, Receipt, Invoice, Permit, Warranty, Spec | no |

Two roles already default to being included, which answers A's question: **pre-selecting photos
whose role defaults to `include_in_report` is simpler than special-casing "after"**, and it uses
the vocabulary rather than hardcoding a role name.

---

## 7. From the rendered draft — five more things

Reading the actual HTML (`toClaudeCode/DRAFT …September 2026.html`) confirms everything above
and surfaces five more.

### 7a. The root cause of the missing cost/hours/date, found exactly

There are **two different code paths that write a work-order row**, and they write different
amounts of detail.

**Path 1 — a WO appears because its job lines completed** (`src/db.js:5727`):

```js
await upsertBoardReportItem(reportId, { passId,
  itemType: 'work_order', itemId: r.work_order_id, section: 'done', sortIndex: i,
  snapTitle: r.wo_title, snapAssetName: r.asset_name,     // <- that is all
});
```

No status, no date, no hours, no cost. The comment says it plainly: the row exists so "a work
order with new lines this period still needs its header."

**Path 2 — a WO appears because it is board-featured** (`src/db.js:5895`):

```js
snapTitle: r.title, snapAssetName: r.place, snapStatus: r.status,
snapDate: r.completed_date,
snapSubtitle: !r.is_terminal && r.board_focus_set_at ? `featured since ${monthOf(...)}` : null,
```

Status and date included.

That is the whole explanation, and it matches the draft row for row:

| Row | Featured? | What it shows | Why |
|---|---|---|---|
| Sump Pump Replacement | **no** | title + asset only | Path 1 — on the report because its lines completed |
| Caretaker's Renovations | yes | `Caretaker's Residence · Reported` + "featured since September 2026" | Path 2, open, so the featured-since label shows |
| Front Gate Repair | yes | `Red Gate · Done · 2026-09-17` | Path 2, closed |

So "the sump pump has no status or date at all" is not data entry and not a stale snapshot —
it is the path that created the row never capturing them.

**The snapshot upsert would accept them.** Every field uses
`COALESCE(EXCLUDED.x, board_report_items.x)`, so a later pass supplying a date would fill it in.
Path 1 simply never supplies one.

### 7b. The money header table is ragged

`moneyHeaderHtml` (`src/reportRender.js:293-297`) emits one `<tr>` per group with no colspan:

```js
<tr>${money.map(cell).join('')}</tr>       <!-- 2 cells -->
<tr>${savings.map(cell).join('')}</tr>     <!-- 3 cells -->
```

The table is therefore three columns wide with a two-cell first row. Browsers stretch it
acceptably; Outlook is less forgiving. Low severity, trivial to fix with a colspan on the
shorter row.

### 7c. Three different savings numbers appear in one report

| Where | Figure |
|---|---|
| Header | **$3,240/yr** (the stored $270/month × 12) |
| Your summary prose | "saving about **$3,300** a year" |
| Internet item note | "**$277/month**" = $3,324/yr |

Whatever the true figure is, the report currently states it three ways. Worth settling as part
of §4.

### 7d. Small rendering redundancies

- **Front Gate Repair** renders as `Front Gate Repair — Red Gate` and then `Red Gate · Done ·
  2026-09-17` directly beneath. The asset name is printed twice because `snapSubtitle` and
  `snapAssetName` both carry it on this row.
- **Fixed NVR Hard Drive — Other** puts the admin-task *category* in the em-dash slot, so an
  uncategorised task reads as "— Other". For a board audience that is noise.

### 7e. The summary renders literal dashes — confirming Part 2D

The summary block is `white-space:pre-wrap` with `escapeHtml()`, so your `-` bullets appear as
hyphens rather than a list. That is exactly the workaround Part 2D describes, and it confirms
the conversion rule you asked for (lines starting `- ` become real bullets) has real content
waiting for it in this very draft.

---

## What I need from you before changing any figure

1. **§2 footer** — total only what is visible? (recommended)
2. **§2b summary rows** — roll a WO's job lines up into its row? (recommended; this is what
   makes the report read correctly)
3. **§1 footer meaning** — relabel it "Work shown" so it is not mistaken for spend?
4. **§3 period** — default to the full calendar month?
5. **§4 savings** — is the correct recurring saving $270/month or $277/month?
6. **§5** — "Fixed NVR Hard Drive": leave as an admin task, or should it be a work order?
7. **§7a** — should Path 1 capture status/date/cost like Path 2 does, so a work order on the
   report always carries its own figures regardless of why it got there? (recommended, and it
   is the smaller half of the §2b fix)
8. **§7d** — drop the duplicated asset name, and stop printing the admin category in the title
   line? (cosmetic, say the word)
