# Design Spec — Asset Components (event-log) Redesign

Camp Sychar CMMS / NocoDB. Companion to BUILD_BRIEF.md. Hand this to Claude Code
as the spec for the Components phase. Base id `p0rfnut85c1hmpa`.

---

## Why this exists

We need to track individual building components (roof, siding, foundation, and
later windows, doors, HVAC, flooring, plumbing…) with their **condition**,
**expected life**, and **replacement year**, AND keep the full **history** of
each component as it's maintained/replaced over time. This supports two goals:
1. "What's the current condition of X's roof?"
2. **Capital planning**: "Across all of camp, what needs replacing, when, and
   what will it cost?" — the board-facing report.

A flat column-per-(component×attribute) approach on Assets can't hold history and
gets unmanageably wide as component types grow. So components move to their own
table, modeled as an **event log**.

---

## The core model: event log, newest-wins for current state

**Asset Components** is an append-mostly log. Each row = one component of one
asset, as observed or installed at a point in time. A single component (Bethel 01's
roof) may have MULTIPLE rows over the years:

| Asset | Component Type | Material | Condition | Observed/Installed | Est Life (yr) | Est Replacement Yr |
|---|---|---|---|---|---|---|
| Bethel 01 | Roof | Shingle | Poor | 2008-06 | 15 | 2023 |
| Bethel 01 | Roof | Metal | Excellent | 2025-08 | 30 | 2055 |
| Bethel 01 | Siding | Vinyl | Fair | 2005 | 20 | 2025 |

- **Current state = the most recent row** for a given (Asset, Component Type),
  by Observed/Installed date. Older rows are retained as history, never deleted.
- Re-roofing a cabin = ADD a new Roof row (don't edit the old one). The old
  shingle row stays as the historical record; the new metal row becomes current.

This is exactly the "more recent supersedes older" behavior — but supersede means
"is the newest for current-state views," NOT "overwrites/deletes." History stays.

---

## Table: Asset Components

| Field | Type | Notes |
|---|---|---|
| Title | Text (primary) | Auto-style label, e.g. "Bethel 01 — Roof — 2025". Can be set by the app on create. |
| Asset | Link → Assets, **Many to One** | The asset this component belongs to. |
| Component Type | Single select | Roof / Siding / Foundation / Windows / Doors / HVAC / Flooring / Plumbing / Electrical / Other. Extensible. |
| Event Type | Single select | **Installed / Replaced / Inspected / Repaired / Retired.** What KIND of event this row records. Installed/Replaced = a new component (resets the lifespan clock). Inspected = state observed, nothing physically changed (updates condition, does NOT reset the clock). Repaired = fixed in place. Retired = removed/decommissioned. This field is what turns the log into a real maintenance history — put it in from the start; retrofitting after rows exist is painful. |
| Material | Single line text | Options vary too much by type to enumerate cleanly; free text (or per-type selects later). |
| Condition | Single select | Excellent / Good / Fair / Poor / Failed / Unknown. |
| Observed/Installed Date | Date | **Drives newest-wins.** Date the component was installed or last observed in this state. |
| Est Life (years) | Number | Expected lifespan from install. |
| Est Replacement Year | Formula (preferred) or Number | If Observed/Installed Date + Est Life are present, compute year(Observed/Installed Date) + Est Life. Else manual. This is the capital-planning driver. |
| Est Replacement Cost | Currency | Optional; rough cost to replace. Feeds budget forecasting. |
| Notes | Long text | Optional context. |
| Work Order | Link → Work Orders (Many to One) | Optional — the WO that installed/updated this component. |
| Superseded | Checkbox (optional) | Optional convenience flag; NOT the source of truth. Current-state is derived by newest date, not this flag. Only use if a denormalized "is current" helps views. |

### "Current component" derivation (the important logic)
To get an asset's current components:
1. Fetch all Asset Components where Asset = X.
2. Group by Component Type.
3. Within each group, take the row with the MAX Observed/Installed Date =
   current CONDITION and current identity of that component.
4. **Lifespan clock nuance:** the replacement-year calc runs from the most recent
   **Installed/Replaced** event, NOT from a later Inspected event. An inspection
   updates condition but doesn't reset the clock. So:
   - current condition = newest row of any Event Type for that component
   - replacement year = (year of newest Installed/Replaced row) + its Est Life
   In practice, carry Est Life + install date on Installed/Replaced rows; Inspected
   rows mainly carry an updated Condition (+ notes). The app should compute current
   state from both: newest-overall for condition, newest-install/replace for the clock.

That set is "the current state of X's components." Everything older is history.
Put the current-state derivation in ONE shared helper so every screen defines
"current" identically. In NocoDB a sort-by-date-desc grouped view approximates it
for eyeballing.

---

## What moves, what stays (avoid three-way conflict over the same truth)

Three mechanisms touch asset state. Keep them in their lanes:

- **Assets flat fields** — whole-asset, single-value, no history needed. KEEP:
  Has Key, Key Fits Lock, Free-Standing Building. These are genuinely
  asset-level and fine as flat single-selects.
- **Asset Components (new)** — anything component-shaped with condition/life/history.
  **MOVE HERE and REMOVE from Assets flat fields:** Roof Material, Siding Material,
  Foundation Type — plus the recently-added Roof Condition, Siding Condition, Roof
  Est Life etc. (those were the flat experiment; they become Component rows). Do
  this now while there's little/no data in them.
- **Condition Findings** — point-in-time deficiencies ("roof leaking NE corner").
  Unchanged. A finding MAY optionally link to a component later, but not required.

### Migration of existing flat data
If any Roof/Siding/Foundation flat fields already hold values for some assets:
seed a Components row per asset per populated component (Observed date = today or
best-known), then remove the flat fields from Assets. Almost no data exists yet,
so this is small — do it as part of the redesign, don't leave both in place.

---

## How Asset Updates (WO write-back) changes

Previously: completing a WO PATCHed asset flat fields via Asset Updates rows.
Now, for component-shaped changes, completing a WO should **CREATE a new Asset
Components row** (a new event) rather than patching a flat field. So:

- Keep **Asset Updates** for the remaining flat asset fields (Has Key etc.).
- For component changes, the WO carries enough to create a Component row on
  completion: Component Type, Material, Condition, Est Life, (Observed Date =
  completion date). Simplest: a WO that replaces a component creates the new
  Components row when marked Done, stamped with the completion date — which
  automatically becomes the current state via newest-wins.

Decide during build whether component-creation-on-WO-completion is driven by the
same Asset Updates table (add Component-oriented fields) or a small dedicated
mechanism. Either is fine; keep it in one obvious place.

---

## Maintenance-history report (falls out of the same log — no extra storage)

Because rows are never deleted, the same table IS the maintenance history. Current
state and history are two reads of one log:
- **Current state** = log filtered to newest-per-component (see above).
- **Maintenance history** = log UNFILTERED, sorted by date.

### Per-asset history report
For one asset, list all its Asset Components rows sorted by Observed/Installed Date,
showing Date, Component Type, Event Type, Material, Condition, Notes, and (via the
Work Order link) the WO's cost/contractor/completion info. Reads as a timeline:

| Date | Component | Event | Detail | Condition | WO / Cost |
|---|---|---|---|---|---|
| 2008-06 | Roof | Installed | Shingle | — | — |
| 2019-03 | Roof | Inspected | granule loss | Poor | — |
| 2025-08 | Roof | Replaced | Metal, full tear-off | Excellent | WO #142 / $8,400 |

### Camp-wide maintenance log
The same read across ALL assets = the institutional maintenance record: every
install, inspection, repair, replacement, chronological. Filterable by asset,
component type, event type, or date range ("all roof replacements last 5 years").

### Why this matters beyond self-tracking
This documented history is board-, insurer-, and grant-grade evidence that the
property is being maintained. Pairing each Replaced/Repaired row with its Work
Order (cost, date, who did it) makes it audit-ready. This is institutional record
the camp likely never had — a real deliverable, not just internal bookkeeping.

### Build implication
The history report needs the **Event Type** field (above) to be meaningful, and
benefits from the **Work Order link** being populated on install/replace/repair
rows. Both are in the table design. No separate history storage is created —
history is just the log read without the newest-only filter.

---

## Capital-planning view (the payoff)

Once Components exist, the board report is a view over current-per-component rows:
- Filter to current rows (newest per Asset+Component Type).
- Sort by **Est Replacement Year** ascending.
- Show Asset, Component Type, Condition, Est Replacement Year, Est Replacement Cost.
- Group by year or by 0–2 / 3–5 / 5+ year buckets for a capital plan.
- Sum Est Replacement Cost per bucket = rough funding forecast.

This is the thing Atlas couldn't give cleanly and the reason for the whole build.

---

## App impact (what Claude Code needs to change)

1. **Schema:** create the Asset Components table (fields above). Remove the flat
   Roof/Siding/Foundation component fields from Assets after migrating any values.
2. **Audit flow:** when auditing a building's components, the app CREATES Component
   rows (append), and when showing "current" state, it fetches components and picks
   newest-per-type. The conditional flow (Free-Standing → ask about roof/siding/
   foundation) now produces Component rows instead of PATCHing flat fields.
3. **Current-state read:** implement the group-by-type-take-newest logic in one
   helper so every screen uses the same definition of "current."
4. **WO completion:** for component replacements, create a new Component row stamped
   with the completion date (becomes current automatically).
5. **Keep** the flat-field path (Asset Updates) for the non-component asset fields
   that remain (Has Key, Key Fits Lock, Free-Standing Building).

## Guardrails (unchanged)
- Token stays server-side in gitignored .env.
- Live data — verify reads before writes, test on one asset.
- Links via Data API link endpoints one at a time, not bulk (NocoDB importer
  wedges on bulk link resolution — learned the hard way).
- After any direct DB write (if ever used), restart the nocodb container.


---

# ADDENDUM — Keep the data layer swappable (portability principle)

**Principle:** ALL NocoDB-specific logic stays isolated in ONE module
(`src/nocodb.js`). The rest of the app (routes, audit flow, WO logic, reporting)
talks only to that module's functions — never to NocoDB URLs, headers, or
response shapes directly.

**Why:** NocoDB sits on top of Postgres and serves as a free admin UI + API layer.
It's the right choice now (instant spreadsheet view of 337 assets, hand-editing,
no CRUD screens to build). But if the app ever outgrows NocoDB, the escape hatch
is to swap this one module for a direct-Postgres client — and if the boundary is
clean, nothing else in the app has to change. This costs nothing to preserve now
and removes lock-in.

**Rules for Claude Code:**
- Every NocoDB call goes through `src/nocodb.js`. No `fetch()` to NocoDB and no
  `xc-token` header anywhere else in the codebase.
- Route/business logic receives and returns plain JS objects, not raw NocoDB
  response envelopes. If NocoDB wraps records in `{ list: [...] }` or attaches
  link metadata, normalize it INSIDE `nocodb.js` so callers see clean shapes.
- The "current component" derivation, newest-wins logic, and any reporting queries
  are app-level logic operating on normalized objects — keep them independent of
  how the data was fetched, so they'd work identically over a Postgres client.
- Table IDs and endpoint paths live only in `nocodb.js` (already the case via the
  TABLES map). Don't scatter them.

**Net:** the app is built ON NocoDB but not welded TO it. Staying on NocoDB is the
plan; this just keeps the door open at zero cost.
