# Open Questions

## Q6 — Tap targets: buttons only, or inline links too?

2,352 elements at 393px are under 44px tall after the mobile pass. The count is dominated
by **inline `<a>` links inside sentences** ("edit", "remove", "+ note"), which a 44px
minimum would space out dramatically and change the density of every screen.

**Options:** (a) buttons, row actions and chips only — done, which is where it stands
now; (b) also pad inline action links, accepting looser text; (c) convert inline action
links into small buttons. **My lean: (a), plus (c) for the handful that are genuinely
primary actions** — the × remove and ↑↓ arrows already got 44px.

## Q7 — Which tables should become stacked cards on a phone?

The brief prefers stacked cards "for anything I act on". Right now every table scrolls
horizontally inside its own container, which fixes the page overflow but keeps the
side-scroll. Converting is per-table work and changes how each screen reads.

**Needs your list**, or say "all of them" and I'll convert the lot. Candidates: work
order lists, expenses, locations grid, crew hours, maintenance log, activity log.

## Q8 — Job-line grid on a phone

Untouched this pass. It no longer overflows the page body, but I have not verified it's
usable at 393px. The brief allows falling back to cards with a note that bulk editing is
easier on desktop. **I have not decided this** — it needs a real look at the grid on a
phone first, which the screenshot script can't reach without a work order that has lines
and a width above `GRID_MIN_WIDTH` (900px), the gate that currently hides it on phones
anyway.


## Q5 — Reopen keeps `date_completed`. Confirm that's what you want.

Decided 2026-09-23 while building reopen; logged rather than asked, since either
behaviour is defensible and the work didn't depend on it.

**What it does:** reopening a work order moves it to Review and **leaves
`date_completed` alone**. The original date is also written into the WO's log.

**Why:** clearing it would mean a re-close stamps *today* onto work that happened weeks
ago — the exact misdating §3 of this brief exists to prevent. `changeWorkOrderStatus`
uses `COALESCE(date_completed, CURRENT_DATE)`, so keeping it means a re-close preserves
the real completion date. The board report's Done rule keys on **status as well as
date**, so a reopened WO drops out of Done on status alone while the true date survives.

**The cost:** an open work order carries a completion date, which reads oddly if you
look at the raw column. Nothing consumes it that way today.

**The alternative:** clear it on reopen and let a re-close stamp the new date. Simpler
to explain, but it silently rewrites when the work happened. Say the word and it's a
one-line change.


## Q4 — RESOLVED 2026-09-23: yes, and the prompt chain became a real form

Photos on ad-hoc flags shipped. The prompt sequence was replaced with a single form —
description, photo picker (multiple, no `capture`), an optional fix (title,
responsibility, funding, hours, cost) behind a disclosure, and the §4 note-routing
choice. Files are held in the dialog until save, because a photo needs an answer row to
attach to and that row doesn't exist until the flag is created.

The original question follows.

### Original question

Raised 2026-09-23 while wiring photos per answer.

Photos now attach to any question with `allows_photo`. An **ad-hoc flag** ("Flag
something else") has no question behind it, so there is no `allows_photo` to consult —
and addendum §3 does say it captures "optional photo(s)".

The plumbing already works: an ad-hoc flag is an `audit_answers` row like any other, so
`entityType: 'audit_answer'` would attach to it unchanged. What's missing is only the
button in the ad-hoc dialog.

**Options:** always offer a photo on an ad-hoc flag (it's the case where a photo is most
useful — you're describing something the form never anticipated); or leave it text-only
to keep that dialog short. **My lean: always offer it.** Not built, because the ad-hoc
dialog is currently a sequence of prompts and adding a file picker mid-sequence needs a
real form rather than a fourth prompt.


## Status — 2026-09-23 (later: everything below is DEPLOYED)

### DEPLOYED to audit.fracturedrv.com

Migrations `0075`–`0088` are applied. Backup taken before the column drops
(`sychar-2026-09-23-1755.dump.gz`, copied to Dropbox).

Shipped and live: the whole board-report/purchases brief, asset type icons and profile
photos (§5a), the cabin-holder foreign key, the audit engine's seed form, and the audit
runner end to end — rounds, the walkthrough, review and generation.

Two bugs were found by deploying that rolled-back tests could not have caught:
report spend counted allocations so unsplit receipts read as $0, and audit-generated
work orders violated the `split_root_id` FK because `currval()` pointed at the wrong
number. Both fixed and redeployed.

Test checklists: `docs/board-report-test-checklist.md`, `docs/audit-engine-test-checklist.md`.

### Original status (superseded)

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

**Q1 (funding: stamped) and Q2 (cabin-holder key) are both resolved and deployed.**
Q3 is informational. The seed-form fixture question you answered is recorded in
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

## Q2 — RESOLVED 2026-09-23: replaced with a real foreign key

`assets.cabin_holder_id` (0085), backfilled 174 of 174 with **zero unmatched and no
duplicate holder names**. `syncCabinHoldersFromAssets` now maintains the key as well as
the roster, so a `lodge_holder` typed today gets its key on the next read. Every read
join moved onto the key and returns identical results (174 vs 174). `lodge_holder` is
kept as the display/legacy column and was not touched.

Backfill rule was exactly-one-match or nothing — an ambiguous name is left NULL and
reported rather than guessed. None occurred.

The investigation that led here follows.

### Original question

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

---

# Text intake / People / Visitor log — decided, pending Ben's review

Five decisions from the §0 investigation (`docs/text-intake-analysis.md`). All five are
decided and being built; each is here because it is a real choice, not a detail.

## Q4 — "Extend the existing visitor data" cannot be followed literally

**Finding:** there is no visitor store. A visit is a `calendar_events` row with a
`visitor_name`, and the Visitor Activity report is three lines that filter calendar
occurrences by that column. The whole table holds **5 events, 1 of them a visit**.

A visit log needs headcount, duration, arrival time, photos, expected/confirmed/no-show,
source, and confirmed-by/at. None of those are calendar-event properties, and §2 itself
describes visits with no calendar event at all — a text after the fact, a manual quick entry.

**Decided:** a `visits` table becomes the single visit store. Calendar visit events create an
`expected` visit, exactly as §2 specifies, and Visitor Activity is repointed to read `visits`.
This is not a parallel store — afterwards there is one place a visit lives, and the calendar
goes back to scheduling them. The one existing visitor event gets a row so nothing is lost.

**If Ben disagrees:** the alternative is putting all of it on `calendar_events`, which means a
row there for every visit that was never scheduled. Say so and it changes.

## Q5 — `cabin_holders` has no phone or email, and 173 rows not 174

**Finding:** the columns are `id, name, notes, created_at`. Nothing else. The 174 in the brief
is the count of assets pointing at a holder (174 of 340); there are 173 holders.

**Decided:** add `phone` and `email` as additive columns. Table keeps its name so both FKs and
the soft funding reference keep working; the UI calls it People.

## Q6 — Some "cabin holders" are not people

**Finding:** the list includes `Storage`, `Full Cabin - Boyette`, `Starbuck`, and
`Lapp, Jen` alongside ordinary names. 8 rows contain `&` or ` and `. These are cabin labels as
much as people, and they are load-bearing — assets point at them.

**Decided:** leave them alone. Roles are optional, so a label row simply has none. No cleanup
pass, no guessing which are people. The duplicate check splits on commas and ampersands as
well as spaces, so `Lapp, Jen` and `Jen Lapp` are recognised as the same person.

**If Ben wants them cleaned up:** that is a separate pass with his eyes on the list, not
something to infer.

## Q7 — The merge tool cannot rely on foreign keys

**Finding:** `job_lines.funding_source = 'cabin_holder'` puts a `cabin_holders.id` in
`funding_ref_id`, which is a bare `integer` with **no foreign key**, on six tables:
`work_orders`, `job_lines`, `work_order_template_lines`, `audit_remedies`,
`expense_allocations`, and the 0086 ad-hoc flag table.

**Decided:** merge repoints those explicitly, per table, filtered on
`funding_source = 'cabin_holder'`. A key walk alone would silently lose funding history —
the exact opposite of the fixture cleanup, where following keys was the right answer.

## Q8 — §8 needs a session store before a long session means anything

**Finding:** `express-session` with no `store` configured, so the default **MemoryStore**, and
`maxAge` of 12 hours. Every deploy recreates the container, so **every deploy signs everyone
out** — no cookie lifetime survives that.

**Decided:** `connect-pg-simple` against the existing Postgres (additive session table), plus
`rolling: true` and a 90-day `maxAge`. One npm dependency, no new service, which I read as
inside "no subscriptions beyond Quo".

**Flagged because it adds a dependency.** The alternative is signed stateless cookies, which
would mean rewriting auth rather than configuring it.

## Q9 — A merge has to defeat the sync, or it undoes itself

**Found while building §1, not during §0.** `cabin_holders` is a derived roster:
`syncCabinHoldersFromAssets()` runs before every list read and re-inserts a row for every
distinct `assets.lodge_holder` text. **All 173 holders are backed by that text; none are
hand-made.** So a merge that repointed only keys would be undone on the next page load.

**Decided:** a `cabin_holder_aliases` table. A merge records the removed name as an alias of
the kept person; the sync skips aliased names instead of recreating them, and resolves
`assets.cabin_holder_id` through aliases too. `assets.lodge_holder` keeps the text as it was
imported — it is source data — and a later import of the same variant now lands on the right
person by itself.

**Rejected:** rewriting `assets.lodge_holder` from the removed name to the kept one. It would
work, but it edits imported source text to fix a resolution problem, and loses the fact that
the asset was ever labelled that way.

## Q10 — Correction: five tables carry the polymorphic funding reference, not six

My §0 write-up said six, including `work_orders`. **`work_orders` has neither
`funding_source` nor `funding_ref_id`** in the live schema — 0016 added a `funding_ref_id`
there and it is gone, presumably dropped when funding moved to `job_lines` in 0031. The fifth
table is `audit_answer_remedies`, which I missed.

The authoritative five, from `information_schema`: `job_lines`,
`work_order_template_lines`, `audit_remedies`, `audit_answer_remedies`,
`expense_allocations`. **Zero rows in any of them are funded by a cabin holder today**, so the
merge risk is latent, not live — but it would be silent when it arrived.

---

# Redesign: people separate from holdings — decided, pending Ben's review

Q9 (alias table) and the `not_a_person` flag are **withdrawn**. Ben's redesign removes the
premise they were patching: `cabin_holders` is a list of cabin *holdings*, derived from
imported asset text, containing labels, roles, organizations and crews as well as humans.
People now live in their own table, linked to holdings by `cabin_holder_people`. The sync keeps
running untouched because it only manages holdings, so nothing needs defeating.

## Q11 — Variant pairings made during seeding

Two holdings pairs collapse to one person each, found by normalising both names — lowercase,
drop punctuation and anything parenthesised, split on comma / `&` / `and` / slash / plus, sort
the parts, compare:

| person | holdings | cabins |
|---|---|---|
| **Ben Greenawalt** | `Ben Greenawalt` + `Greenawalt, Ben` | Ebenezer 22, Peace 18 |
| **Jill Martin** | `Martin, Jill` + `Jill Martin` | Tabernacle 13, Weatherwax 30 Upstairs |

That is the complete list. 157 people from 159 non-label holdings.

### Near-misses deliberately NOT linked

The same pass surfaced three pairs that differ by one character. None were auto-linked,
because two of them are probably one person and one certainly is not — and guessing wrong
merges two real people:

| pair | reading |
|---|---|
| `Caylee Severence` (#86) / `Severance, Caylee` (#107) | **Almost certainly one person**, spelt two ways. Left separate for Ben to merge in the UI. |
| `Strine, Brett` (#26) / `Strike, Brett` (#160) | Could be a typo of one person, or two people. Different cabins (Olde Dorm 03, Annex 05). |
| `Spain, Sandy` (#63) / `Spain, Randy` (#64) | **Two different people.** Included only to show the detector is loose enough to surface real pairs and was right not to act on any of them. |

## Q12 — The 14 label holdings stay unlinked

Same 14 as before, now simply holdings with no person rather than flagged people: `Storage`,
`Blank Lot`, `Historical`, `Nurse's Cabin`, `Matron's Room`, `SongLeader`, `Youth Evangelist`,
`Children's Evangelists`, `Children's Ministry - Blaine`, `Keene Crew`, `Full Cabin - Boyette`,
`OMS`, `WGM Missions`, `Bethany Missions`.

Per Ben's instruction the ambiguous ones **do** get a person: `Starbuck`, `Hill Evangelist`,
`Rev. Greenawalt`, `Shiltz, George to Be Transitioned`, and every surname-only row (`Dearth`,
`Grissom`, `McCoy`, `Patricks`, `Wight`, `Green`, `Grecar`, `Hutson`, `McCollough`, `Juneman`,
`Desabato`, `Pecott`, `Kodie`).

## Q13 — Person names are seeded verbatim, not reformatted

A person seeded from the holding `Lapp, Jen` is named `Lapp, Jen`, not `Jen Lapp`. About 100 of
the 157 are in `Last, First` order, so a People list will read that way.

**Decided: leave them.** Reformatting 157 names is a judgement about how Ben wants his own
people list to read, and it is trivially done later with one UPDATE once he says so — whereas
un-reformatting a name that was actually `Last, First` for a reason is not. The two variant
pairs are the exception: they take the natural `First Last` spelling, because a name had to be
chosen between the two.

**If Ben wants them normalised:** say so and it is one migration. The duplicate check already
treats both orders as equal, so nothing depends on the stored order.

## Q14 — `people.name` is deliberately not unique

`cabin_holders.name` is `UNIQUE`; `people.name` is not. Two real people can share a name, and
§1's duplicate check ends in "create new anyway", which a unique constraint would refuse. The
check is a warning, not an enforcement.
