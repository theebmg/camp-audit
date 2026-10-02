# Funding attribution — investigation and proposal

**Nothing has been changed.** Investigation only, per Ben's instruction.

---

## 1. Does the report read funding only from expenses?

**Yes. The job line's own Funding Source field is never read by the board report.**

There are **two separate funding vocabularies** in this system, and they have never been
connected:

| | Where it lives | Vocabulary | Who reads it |
|---|---|---|---|
| **Budget funding** | `job_lines.funding_source` + `funding_ref_id` | `operating_budget`, `capital_campaign`, `cabin_holder`, `other`, `fund` | The work order screen, the job-line queue, the funding rollup on the WO page |
| **Receipt funding** | `expenses.funding_source_id` → `funding_sources` | Camp funds, Personal (Ben), Donor / designated gift, In-kind | **The board report, and only this** |

The report's funding comes from `expense_allocations` joined to `expenses`. Line 71 has:

```
job_lines.funding_source = 'cabin_holder'
job_lines.funding_ref_id = 27          ->  cabin_holders.name = 'Greenawalt, Ben'
job_lines.actual_cost    = 800
expense_allocations      = (none — cash payment, no receipt)
```

So the report finds no allocations, computes no funding, and prints no tag. **Ben entered it
correctly.** The report is looking somewhere else.

`funding_ref_id` is a soft reference: it points at one of five different tables depending on
`funding_source`, with no foreign key (migration 0016 explains why). `getFundingRefLabel()`
already resolves it.

## 2. Did the last round ship?

**Yes, all of it.** It is live and working — on the wrong input.

- `board_reports.show_funding` exists; **report 1 is set to `non_camp`**, the default.
- Line tags, the work order roll-up, the three-way setting and the Contributed tile are all
  deployed and covered by tests; the rendered sample shows them working.
- The Contributed tile is hidden because its figure is **$0** — every expense still has
  `funding_source_id = NULL`, and there are **no expense allocations at all**.

Nothing needs rebuilding. It needs a second input.

## 3. How should the two relate?

**Ben's proposed precedence is right, and is what I would build:**

> A line's cost uses the funding source of its linked expenses; if it has no linked expense, it
> uses the job line's own Funding Source. If a line has both and they disagree, flag it.

Receipts win because they are evidence — a receipt records money that actually moved, where the
budget field records intent. The budget field is the fallback for exactly the case Ben hit: real
money, no paperwork.

### The piece that has to be decided: which budget sources are camp money?

The receipt vocabulary carries `counts_as_camp_spend`. The budget vocabulary carries nothing of
the kind — it is five bare strings. A mapping is needed, and it should be **admin-editable**
like every other vocabulary here, not hardcoded.

Proposed new table `job_line_funding_kinds`, seeded:

| source | label | counts as camp spend |
|---|---|---|
| `operating_budget` | Operating Budget | **yes** |
| `capital_campaign` | Capital Campaign | **yes** |
| `fund` | Fund | **yes** |
| `other` | Other | **yes** |
| `cabin_holder` | Cabin-Holder | **no** |

Unknown defaults to **camp**, matching the rule already used for receipts: *"an expense with no
funding source set counts as camp spend, because showing it as neither would quietly drop real
money out of the total."* Over-counting contributions would understate what camp spent, which is
the more misleading error for a board.

`other` and `fund` are genuine judgement calls — a designated fund might well be non-camp. They
are admin-editable precisely so Ben can change them without a deploy.

### What the tag would say

For `cabin_holder`, the label comes from the holder, not from a generic word:

```
Have wall removed between kitchen and dining room…  ·  $800  ·  Funded by Ben Greenawalt
```

`cabin_holders.name` is stored surname-first (`Greenawalt, Ben`), so the tag flips it to
`Ben Greenawalt`, falling back to the stored form if it does not split. Other sources use the
label from the table above.

### Flagging a disagreement

A line with both an allocation and its own funding source, classified differently, is a real
contradiction — someone has been paid twice over, or the record is wrong. Proposed handling:

- The **report screen** shows it on the row: *"Receipts say Camp funds, the line says
  Cabin-Holder — the receipts are being used."*
- `scripts/september-reconcile.mjs` lists them.
- **It never appears in the board email.** The board does not need our bookkeeping arguments.

There are **no such lines today** — `expense_allocations` is empty.

## 4. Cabin-holder funding as non-camp money

Agreed, with one honest caveat.

- **On the line:** tagged, and visible in the `non_camp` setting, which is the default.
- **On the work order row:** rolled into the split, so WO 54 would read
  `$800 spent of ~$1,540 est. · Funded by Ben Greenawalt`.
- **In the Contributed tile:** included.

**The caveat.** The tile currently sums *receipts*. Adding job-line costs mixes two measurement
bases in one figure: money evidenced by a receipt, and money typed in as an actual cost with
nothing behind it. The number is still correct — real money really was contributed — but the two
halves are not equally auditable.

Two options, Ben's call:

1. **One tile, mixed basis** — `Contributed this period: $800`. Simplest, and what he asked for.
2. **One tile, relabelled** — `Contributed this period (incl. work paid directly): $800`, so the
   basis is stated rather than assumed.

I would take **2**: same figure, same prominence, and the footnote costs nothing. Camp spend
stays receipts-only either way, and the two are never summed.

---

## What this would change on the September report

Only line 71 carries non-camp budget funding today. With the fix, and nothing else entered:

| | now | after |
|---|---|---|
| Line 71 | `$800` | `$800 · Funded by Ben Greenawalt` |
| WO 54 row | `$800 spent of ~$1,540 est.` | `… · Funded by Ben Greenawalt` |
| Contributed tile | hidden ($0) | **$800** |
| Camp funds spent | $978.07 | **$978.07, unchanged** |
| Recorded cost total | unchanged | unchanged |

The other 14 job lines are `operating_budget`, which is camp money and so correctly untagged in
the default `non_camp` setting.

## Work involved

One migration (the mapping table, seeded), a resolver that applies the precedence per line, the
roll-up and tile reading through it, the tag label flip, and the disagreement flag on the report
screen. Tests for precedence, for the camp/non-camp split, and for the flag. **No change to any
existing record** — this is all read-path.

**Waiting on Ben for:** the `other` / `fund` classifications, and tile option 1 or 2.
