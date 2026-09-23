# Open Questions

Decisions needed from Ben. Each entry: the question, the options, and my lean.
Anything logged here was **skipped, not guessed at** — work that didn't depend on it
continued.

---

## Q1 — Funding per allocation: stamp, or resolve at read?

**Context.** Splitting a receipt across a cabin-holder job and an operating-budget job
means funding belongs to each split, not the whole receipt. Moving
`funding_source` + `funding_ref_id` onto `expense_allocations` is agreed; what isn't
settled is whether the value is copied or looked up.

**Options.**

- **Stamp (my lean).** Copy the destination's funding onto the allocation at split time
  and never touch it again. Matches the rule this codebase already follows everywhere —
  remedy estimates, job-line cascade values, board-report snapshots: *a report reading
  these rows years from now never has to know how they were derived*. Last year's spend
  never moves. Cost: "this line is cabin-holder funded" and "the money spent on it was
  charged to operating budget" can legitimately disagree, and the UI has to show that.
- **Resolve at read.** Join to the destination's current funding every time. Always
  agrees with the line; but re-funding a job line silently rewrites the history of what
  was already spent, including inside published board reports.

**Status.** `expenses.fund_id` deliberately left untouched — still written, still read,
still driving the dashboard fund tile. Everything else in phases 2–5 was built around
this. Full write-up in `docs/board-report-analysis.md`.

---

## Q2 — The cabin-holder ↔ cabin relationship is a string join

**Investigated** for addendum §5b, which asked me to report rather than invent.

**What exists.** `cabin_holders` (id, name, notes) has **no link to `assets`**. The
relationship is a case-insensitive text match on a free-text column:

```sql
LEFT JOIN assets a ON lower(trim(a.lodge_holder)) = lower(ch.name)
```

(`applyCabinHolderVisitDefaults`, db.js.) `assets.lodge_holder` holds the holder's name
as typed.

**How well it holds today.**

```
cabin_holders                                 173
assets with lodge_holder set                  174
...matching a cabin_holders row               174   (100%)
holders matching more than one asset            1
```

It works perfectly on current data. It is also one rename away from silently breaking,
and nothing enforces it.

**Options.**

- **Add `assets.cabin_holder_id`** (nullable FK), backfilled from the string match —
  100% today, so the backfill is lossless — keeping `lodge_holder` as a display/legacy
  column until the FK is trusted. *My lean.* Cheap, additive, and makes the header in
  §5b a join instead of a guess.
- **Leave the string join.** Zero work, keeps working until someone edits a name in one
  place and not the other.
- **Formalise as many-to-many.** One holder already maps to 2 assets, so a holder can
  hold more than one cabin. But asset → holder stays single-valued, which is all §5b's
  header needs, so this looks like more structure than the requirement justifies.

**Note:** the "1 holder → 2 assets" case does **not** block §5b. The header shows *the
asset's* holder, and that direction is unambiguous either way.

---

## Q3 — Should `expenses.asset_id` survive?

Minor. Raised while retiring `work_order_id` / `job_line_id` into allocations.

`asset_id` was kept, on the grounds that it is a reporting dimension of the receipt
("this receipt was about Cabin 12") rather than a destination — it is read by filters
and display joins, never by cost rollups. But **0 of 11 expenses use it**, and once
allocations point at job lines, the asset is reachable through the line's work order.

**Options:** keep it (status quo, costs nothing), or retire it in a later migration once
the split UI shows whether it ever gets used. **My lean: keep, revisit after the split
UI has been in use.** No work is blocked either way.
