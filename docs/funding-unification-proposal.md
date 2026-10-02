# One funding list — proposal, not built

Covers two asks together, because they are the same problem: **unify the two funding
vocabularies**, and **report earmarked camp funds with their usage**.

**Nothing in here is built.** The camp/non-camp mapping and the Contributed tile shipped
separately; this is the larger change behind them.

---

## First: yes, funds already do what you need

**The `funds` table already supports named, approved, amount-limited funds — and yours is
already in it:**

| name | amount | authorized by | start | end |
|---|---|---|---|---|
| Discretionary Audit Fund | **$5,000** | Camp Sychar board | 2026-09-11 | 2026-12-31 |

- **Job lines can be assigned to it** — `funding_source = 'fund'`, `funding_ref_id = funds.id`.
  None are today.
- **Receipts can be assigned to it** — `expenses.fund_id`. **Six already are**, totalling
  **$586.47**.
- **Usage is already computed.** `getFundBalances()` sums both halves of the money — shares
  explicitly allocated to a fund, plus the unsplit remainder of any receipt charged to it — and
  the dashboard already shows "$X of $Y remaining · N days left".
- **Classed as camp spend:** yes, and now explicitly so. `fund` is seeded
  `counts_as_camp_spend = true` in the mapping just shipped, and those six receipts have
  `funding_source_id = NULL`, which the report already treats as camp. **Earmarked camp money is
  camp spend, not a contribution** — it is camp's own money with a label on it.

So nothing needs building for funds to work. What is missing is **the board seeing them.**

### Proposed: an approved-funds block on the report

Under the money header, only when a fund is active in the period:

```
APPROVED FUNDS
  Discretionary Audit Fund      $586 of $5,000 used · $4,414 left · 91 days remaining
     authorized by Camp Sychar board
```

- Reads from `getFundBalances()` — no new arithmetic, no new table.
- Stamped into `board_report_aggregates` at refresh like every other figure, so a published
  report keeps what it went out with.
- Hidden entirely when no fund is active, like the Contributed tile.
- **Over-spend is shown, never hidden:** `$5,240 of $5,000 · $240 over`, in the amber already
  used for "Still to do". A board finding out late is worse than a board finding out plainly.
- Governed by the existing `show_funding` setting: `off` hides it.

This alone is a small, self-contained change — **it does not need the unification below.** It
could ship on its own if you want the September report to show the fund.

---

## The unification

### The problem, concretely

`Personal (Ben)` and `Cabin-Holder › Greenawalt, Ben` are the same funder under two names, in
two tables, with two vocabularies, read by two different parts of the system:

| | `funding_sources` | `job_lines.funding_source` |
|---|---|---|
| Shape | a table of rows | five hardcoded strings + a soft ref to one of five tables |
| Members | Camp funds, Personal (Ben), Donor / designated gift, In-kind | operating_budget, capital_campaign, cabin_holder, other, fund |
| Attached to | `expenses.funding_source_id` | `job_lines.funding_source` + `funding_ref_id` |
| Knows camp vs non-camp | yes, `counts_as_camp_spend` | only since migration 0109, in a side table |
| Can name a *specific* funder | no — "Personal (Ben)" is a hardcoded person in a label | yes, via `funding_ref_id` |

Neither is a superset. Receipts can say *what kind* of money but not *whose*; job lines can say
*whose* but needed a side table to say what kind.

### Proposed shape: one table, typed, with an optional reference

```
funding_sources
  id
  name                    'Camp general', 'Discretionary Audit Fund', 'Ben Greenawalt', 'In-kind'
  short_label             'Camp', 'Audit Fund', 'Ben', 'In-kind'        (already exists)
  kind                    camp_general | camp_fund | cabin_holder | donor | in_kind
  counts_as_camp_spend                                                   (already exists)
  is_in_kind                                                             (already exists)
  ref_table, ref_id       -> funds.id, cabin_holders.id, people.id       (nullable)
  amount, start_date, end_date, authorized_by                            (for camp_fund)
  active, sort_order
```

`kind` is the five categories you listed: **camp general, earmarked camp funds, cabin-holders,
donors, in-kind.** `ref_id` is what makes "Ben Greenawalt" a row rather than a string in a label.

Both receipts and job lines then point at **one** column: `funding_source_id`.

### What the migration would touch

**Schema**

| Change | Risk |
|---|---|
| Add `kind`, `ref_table`, `ref_id`, `amount`, `start_date`, `end_date`, `authorized_by` to `funding_sources` | low — additive |
| Add `job_lines.funding_source_id` **alongside** the existing pair, not replacing it | low — additive |
| Backfill `funding_source_id` from `(funding_source, funding_ref_id)` | **this is the real work** |
| Create a `funding_sources` row per cabin holder that actually funds work, and per fund | medium — creates records |
| Keep `job_lines.funding_source` / `funding_ref_id` writing in parallel for one release | low, and the reason this is safe |

**Data.** Today that is: 1 cabin-holder line (Greenawalt, Ben), 14 operating-budget lines, 1
fund, 8 expenses. **Tiny.** It will not be tiny in a year, which is the argument for doing it
now rather than later.

**Code.** `funding_ref_id` is referenced in ~15 places: `getFundingRefLabel`, the WO funding
rollup, the job-line queue filter, `getFundBalances`, the capital-campaign and other-category
in-use checks, the job-line grid, the report resolver just built. All read sites. Each one gets
simpler, not harder — a join instead of a five-way CASE.

**UI.** One funding picker instead of two different ones. The job-line form's "Funding Source"
and the expense form's "Funding source" become the same control over the same list, grouped by
kind.

### How I would sequence it

1. **Additive migration only.** New columns, new rows, backfill. Nothing dropped, nothing
   rewritten. Both representations valid.
2. **Write both** for one release: setting funding on a job line writes the new column and the
   old pair. Reads prefer the new column.
3. **A reconciliation script** that proves the two representations agree on every row, run
   before and after.
4. **Only then**, and only once that script has been clean for a while, drop the old pair.

The system stays correct at every step, and step 4 is reversible right up until it happens.

### What it buys

- One list, one picker, one vocabulary. `Ben Greenawalt` is one funder whether he paid by
  receipt or in cash.
- **"Contributed by" becomes answerable per person** — "cabin holders contributed $4,200 of work
  this year" needs funders to be rows, not strings.
- Earmarked funds, cabin-holders and donors sit in one list with one `counts_as_camp_spend` rule,
  so `job_line_funding_kinds` (shipped today) disappears again.
- The report resolver loses its precedence special-casing: both sides carry the same id.

### What it costs, honestly

- A day or so, most of it the backfill and the reconciliation script.
- A migration that **creates records**, which is the first one in this project to do so. Every
  other has been additive-only. It needs your explicit go-ahead on that point specifically.
- A transition period where two representations exist. Mitigated by step 3, but it is real.

### My recommendation

**Do the approved-funds block now** — it is small, independent, and the $5,000 is live this
month. **Hold the unification** until the September report is out. It is the right change and the
data will never be smaller, but it is not blocking anything today, and shipping a board report is.

**Waiting on you for:** whether to ship the funds block for September, and whether a
record-creating migration is acceptable when the unification goes ahead.
