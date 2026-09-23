# Open Questions

## Status — 2026-09-23

### Done, on branch `board-report-purchases` (10 commits, nothing merged, nothing deployed)

All six build-brief phases have their **schema and backend** complete, plus the report
screen. Eight migrations, `0075`–`0082`, **none applied** — every one verified in a
rolled-back transaction against the live schema, 30+ assertions in total.

| Phase | State |
|---|---|
| 2 — purchases, splits, savings | Backend + routes ✅ · **split UI not built** |
| 3 — materials, leftovers | Backend + 9 routes ✅ · **materials screens not built** |
| 4 — report entities, publish, saved copies | Complete ✅ |
| 5 — suggestions, projections, Forward Focus retired | Complete ✅ |
| 6 — report screen, money header | Complete ✅ |

### What to test first, once it's merged and deployed

1. **Admin task savings still work.** `0076` drops `recurring_monthly_savings` and moves
   it to `savings_entries`. The row shape is unchanged, so the admin task form and the
   Work Performed report should behave exactly as before. If a saving vanished, that's
   the migration to look at.
2. **Expense destinations.** `0078` drops `expenses.work_order_id` / `job_line_id`;
   picking a work order on the expense form now writes an allocation behind the scenes.
   Check that a new expense still attaches, and that WO cost rollups still add up.
3. **The board report screen.** Open Reports → Board Report. It creates a draft, fills
   it with suggestions, and everything is toggleable. The old any-date-range generator
   is gone.
4. **Publish, then send.** Publish should freeze the report; re-opening it months later
   must render identically. Every email/download/save is recorded in History.

### Not built, and buildable without me

- The **split editor UI** (§9) — backend and routes exist; the screen does not.
- **Materials screens** (§10) — "Materials on hand", the WO-close leftover prompt, and
  the point-of-use reminder. All three have working endpoints behind them.
- Addendum **§5a** (asset type icons, profile photos) — not started, own branch.

### Waiting on you

**Q1 below (funding per allocation) is the only thing blocking further backend work.**
Q2 and Q3 are informational. The seed-form fixture question you answered is recorded in
`docs/audit-engine-decisions.md`; the audit engine resumes after this branch merges.

### One defect worth knowing about

I introduced it in Phase 4 and fixed it in Phase 6: the send route rendered from the old
*live* query, so sending would have ignored every toggle and a published report would
have re-rendered from current data — making the freeze cosmetic. It now renders the
report's own rows. Called out because it's the kind of bug that looks like it works.

---


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
