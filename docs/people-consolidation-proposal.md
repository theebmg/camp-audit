# One people list — proposal, not built

Supersedes the funder half of `docs/funding-unification-proposal.md`: **funders come from the
same list as visitors**, not a parallel one.

**Nothing in here is to be built before September is out.**

---

## What exists today

Four person-shaped stores, built at different times for different reasons.

| Store | Rows | What it really is | Keyed to a person? |
|---|---|---|---|
| **`people`** | **159** | the real person list — name, phone, email, volunteer skills, notes | — |
| **`cabin_holders`** | **173** | **not people: cabin HOLDINGS.** Derived rows, one per distinct `assets.lodge_holder` string, re-synced before every list read | only via `cabin_holder_people` (159 links, 157 people) |
| **`volunteers`** | **1** | a pre-Postgres leftover — name, phone, email, skills, address | no |
| **`vendors`** | **1** | companies, not people, but `people.vendor_id` links a person to one | n/a |

Plus `users` (2 login accounts) — a different thing again, and deliberately so.

### The good news: most of this is already done

The `people` layer built in September is already the right shape:

- `person_roles` is an **admin-editable vocabulary** (Volunteer, Camp attendee, Vendor contact)
  with `person_role_assignments` as a join — exactly "roles on a person", **already**.
- **Cabin holder is deliberately NOT a role**, because it is derived from the asset, not
  asserted about the person. That decision was right and should stand.
- `visits` already points at `people.id` (5 visits, all by person).
- `mergePeople()` already exists, with an explicit `PERSON_REFERENCES` list, a `record_merges`
  audit table, and an in-transaction zero-reference check.
- `findDuplicatePeople()` already matches on a normalised name key and surfaces holdings.
- `mountPersonPicker()` already offers type-to-filter **and** a `＋ Add new person "<typed>"`
  row that creates the person inline.

**So items 1 and 2 of your list are largely built.** What is missing is smaller and specific.

### What is actually wrong

1. **`volunteers` is a dead parallel list.** One row, "Chuck Smith", with skills and an address.
   `people` has `volunteer_skills` and `volunteer_notes` already. This table should go.
2. **The picker matches the whole label as one substring.** Names are stored
   `"Greenawalt, Ben"`, so typing `Ben` matches but **typing `Ben Greenawalt` does not.** That is
   your "first name, last name, partial matches" requirement, and it is a one-function fix.
3. **Volunteer hours are not attributable to a person at all.** `crew_sessions.username` is a
   **text login name**, not a `person_id`. A person's record cannot show hours until that is a
   reference.
4. **Nothing records contributions against a person.** Funding points at a `cabin_holder`
   holding id — which is a cabin, not a person — or at a `funding_sources` row whose "Personal
   (Ben)" is a hardcoded label.
5. **14 holdings have no person**, and 2 people hold no cabin. The names are label-ish
   (`"Smith Family"`, and similar), which is why they were deliberately left unlinked.

---

## Proposal

### 1. `people` becomes the only person list

- **Retire `volunteers`.** Move its one row into `people` (it is one row), keep the table until
  the next release, then drop it. Nothing reads it that `people` cannot serve.
- **Keep `cabin_holders`.** It is not a person list and should not be merged into one: it is the
  set of holdings derived from `assets.lodge_holder`, and the sync that maintains it is what
  keeps the asset record authoritative. `cabin_holder_people` stays as the bridge.
- **Keep `users` separate.** A login is not a person; conflating them is how systems end up
  unable to deactivate an account without erasing a visitor history. A nullable
  `users.person_id` is enough.
- **Keep `vendors` separate.** A vendor is a company. `people.vendor_id` already says who works
  there.

### 2. Funders become people

Replacing the funder half of the earlier proposal:

```
funding_sources
  kind          camp_general | camp_fund | person | donor_org | in_kind
  person_id     -> people.id        (when kind = 'person')
  fund_id       -> funds.id         (when kind = 'camp_fund')
```

So `Personal (Ben)` and `Cabin-Holder › Greenawalt, Ben` collapse into **one row pointing at one
person**, and a cabin holder who pays for work is the same record as the cabin holder who
visits in July.

**Cabin holder stays derived.** A person funds work *as themselves*; that they also hold a cabin
is a separate fact about them, already modelled.

### 3. The picker

One `mountPersonPicker` everywhere a person is chosen — receipts, job lines, visits, calendar,
funding. Three changes to what exists:

- **Token matching.** Split the query on whitespace; every token must match the start of some
  token in the name, in any order. `ben green`, `greenawalt`, `Ben Greenawalt` and `green b` all
  find `Greenawalt, Ben`. Match on a normalised form so punctuation and case do not matter.
- **Rank exact and prefix matches above mid-word ones**, so `Ben` offers `Greenawalt, Ben`
  before `Bennett, Carl`.
- **Keep the inline add** exactly as it is — it already creates a person from just a name.

The sublabel should say what distinguishes two people with the same name: their cabin, then
their phone. That is already what it does.

### 4. Merging duplicates

`mergePeople()` exists and works. Under this proposal its reference list grows, and that list is
the whole safety argument — it is explicit, not inferred from foreign keys, **because funding
uses an unconstrained pair that no key describes.**

| Reference | Mode | Status |
|---|---|---|
| `visits.person_id` | repoint | **built** |
| `calendar_events.person_id` | repoint | **built** |
| `groups.contact_person_id` | repoint | **built** |
| `person_role_assignments` | union | **built** |
| `cabin_holder_people` | union | **built** |
| `funding_sources.person_id` | repoint | new |
| `crew_sessions.person_id` | repoint | new (needs §5) |
| `users.person_id` | repoint | new |

Plus what is already there and should stay: the `record_merges` audit row recording who merged
what and how many references moved, and the **in-transaction check that the removed person has
zero references left before the row is deleted** — which is what makes the operation safe to
offer at all.

**The UI** already exists on the person profile (pick a person, confirm, merge). It needs: a
preview of what will move ("3 visits, 1 cabin, $800 contributed, 12 hours"), and
`findDuplicatePeople` surfacing likely matches up front rather than only on demand.

**Not reversible.** The audit row records it, but the merge itself is one-way. The confirm step
should say so plainly.

### 5. Volunteer hours become a person's hours

`crew_sessions.username` is a login string. Add `crew_sessions.person_id`, backfill where a
username maps to a person, and record new sessions against the person. Keep `username` as the
record of *who entered it*, which is a different fact and worth keeping.

**This is the only part with a real backfill problem:** a username that matches no person needs
one created, or the session stays unattributed. With 0 crew sessions today, **this is free right
now and will not be in a year.**

### 6. The person's record shows everything

One profile, assembled from what already exists plus the two new links:

```
Ben Greenawalt                                    [Merge] [Edit]
  Roles      Volunteer · Camp attendee
  Cabins     Cabin 14, Cabin 22              (derived — from the asset record)
  Visits     3 this year · last 14 Aug
  Funded     $800  ·  Caretaker's Renovations, wall removal
  Hours      12.5 across 4 sessions
  Contact    phone · email
```

Every block is a query that exists or becomes trivial once §2 and §5 land. Blocks with nothing
in them are hidden, not shown as zeroes.

---

## Migration shape

Same discipline as everything else here: **additive, reversible until the last step.**

1. Add columns: `funding_sources.person_id`, `crew_sessions.person_id`, `users.person_id`.
   Nothing dropped.
2. **Create people** for cabin holders who fund work and for usernames with crew sessions.
   *This creates records* — the first migration in this project to do so, and it needs your
   explicit go-ahead. Today that is **one person** (yourself) and **zero sessions**.
3. Backfill the new columns. Write both old and new representations for one release.
4. A reconciliation script proving old and new agree on every row.
5. Only then drop `volunteers` and the old funding pair.

**Touches:** the funding resolver just built, `getFundingRefLabel`, the WO funding rollup, the
job-line queue filter, `mergePeople`'s reference list, the person profile, the visit form, the
expense form, the job-line form. All of them get simpler.

**Does not touch:** `cabin_holders`, `assets.lodge_holder`, or the sync between them. Holdings
stay derived from the asset, which is what keeps the asset record the single source of truth
about who holds a cabin.

---

## Order I would take it in

| | | Why |
|---|---|---|
| 1 | **Picker token matching** | One function, no schema, fixes a thing that is wrong today |
| 2 | **Merge preview + duplicate surfacing** | No schema; makes the existing merge safe to actually use |
| 3 | `crew_sessions.person_id` | Free at zero rows, expensive later |
| 4 | Funders as people | The substantive change |
| 5 | Retire `volunteers` | Tidying, once nothing reads it |

**1 and 2 are independent of everything else and could ship any time.** 3 is nearly free and
only gets harder. 4 is the real work.

**Waiting on you for:** the go-ahead on a record-creating migration (step 2 above), and whether
you want 1 and 2 before the September report rather than after.
