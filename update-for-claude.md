# Runbook: Adding a New Asset Property

*(e.g. "Window Type", "HVAC Type", "Flooring") — Camp Sychar CMMS on NocoDB*

This is the checklist for adding a new **asset property** — a stable fact about
an asset that you track and keep current (like Roof Material or Has Key), and
that a Work Order can change on completion.

Keep this current. Every time the system grows, the number of places a change
touches grows too; this file is what stops you chasing your tail later.

---

## Definitions (so you put things in the right place)

- **Asset property** → a stable fact about the asset. Lives as a column on the
  **Assets** table. Examples: Roof Material, Has Key, Window Type.
- **Finding** → something observed during an inspection. Lives on **Condition
  Findings**. Not this runbook.
- **A change a Work Order makes** → recorded as an **Asset Updates** row linked
  to that WO. The completion logic writes it into the asset property.

If the new thing is a *stable fact about the asset*, it's an asset property and
this runbook applies.

---

## The manual checklist (works today)

To add one new asset property — call it **Window Type** as the running example —
touch these places, in order:

### 1. Assets table — add the column
- Assets table → **+ New field**
- Name: `Window Type`
- Type: **Single select** (use single-select for a fixed set of values; use
  text only if truly freeform)
- Options: e.g. `Single-Pane / Double-Pane / Storm / None / Unknown`
- Always include **Unknown** (and **N/A** where "doesn't apply" is real), so you
  can save without guessing and later filter for what's still unaudited.

### 2. Asset Updates table — add it as a Target Field option
- Asset Updates table → open the **Target Field** single-select field → **add
  the option** `Window Type`
- **The option label MUST exactly match the Assets column name** (`Window Type`
  = `Window Type`). The write-back matches by name; a mismatch means the update
  silently writes nothing.

### 3. The audit form (if you capture this field during walkthroughs)
- If you want to record Window Type during a building walkthrough, add the field
  to the relevant **form view** and set any conditional-display rule (e.g. show
  only when Free-Standing Building = Yes).
- Skip if it's not something you capture in the field.

### 4. The WO interface (when it exists)
- **If the interface hard-codes the list of asset fields anywhere**, add
  `Window Type` there too.
- **If the interface reads fields dynamically** (see next section), you touch
  NOTHING here — this is the whole point of building it that way.

### 5. Dashboards / views (optional)
- If you want to group or report by the new property, add it to the relevant
  grid/dashboard views. Optional, do it when you actually need the report.

---

## The chase-your-tail failure modes (what this runbook prevents)

- **Added the Assets column but not the Asset Updates option** → WOs can't
  declare a change to it; write-back never fires for that field.
- **Names don't match exactly** → the write-back matches Target Field label to
  Assets column name. `Window Type` vs `Windows` = silent no-op. Match them
  character-for-character.
- **Hard-coded the field list in the interface** → every new property needs a
  code change. Avoid by reading the schema dynamically (below).

---

## The goal: a schema-driven interface (less chasing, build toward this)

Your instinct — "an interface that just knows what to update based on what I'm
adding" — is the right architecture. The idea: instead of hard-coding
`["Roof Material", "Has Key", ...]` in your app, the app **asks NocoDB what
fields the Assets table has** at runtime, and builds its dropdowns from that.

### How it works
NocoDB's meta API returns a table's full field list. Fetch the Assets table's
fields, filter to the ones you consider "editable asset properties," and use
that list to populate:
- the **Target Field** dropdown when creating an Asset Update
- any field pickers in the WO or audit interface

Then **adding a column to Assets automatically makes it available everywhere** —
step 1 of the manual checklist becomes the ONLY step. Steps 2 and 4 disappear.

### The meta endpoint
```
GET https://nocodb.fracturedrv.com/api/v2/meta/tables/{ASSETS_TABLE_ID}
  header: xc-token: <your token>
```
Returns JSON including a `columns` array — each with `title`, `uidt` (field
type, e.g. `SingleSelect`), and for selects the available options under
`colOptions`. Your app reads this to know both *which* fields exist and *what
values* each accepts.

### How to mark which columns are "asset properties"
Not every Assets column is an editable property (Name, Location, rollups
aren't). Two clean ways to let the app know which to include:
- **Naming/description convention** — put a marker in each property field's
  *description* (NocoDB fields have descriptions), e.g. `@asset-property`, and
  have the app include only fields whose description contains it. Most flexible.
- **A hardcoded exclude list** — simpler: include all single-selects except a
  known set (Name, Asset Type, Condition if you treat it specially, etc.). Less
  precise but easy.

The description-marker approach means: to add a new editable property, you add
the column AND put `@asset-property` in its description — and the whole system
picks it up. That's as close to "it just knows" as it gets.

### Validating the New Value against allowed options
Because the meta response includes each select's options, the interface can
validate that a New Value is actually one of the target field's allowed values
BEFORE saving the Asset Update — catching typos at entry instead of at
write-back. This is the payoff of reading options dynamically.

---

## Where the reference IDs live
Base and table IDs (for API calls) are recorded in your memory / project notes:
- Base: `p0rfnut85c1hmpa`
- Assets table: `mcwn0dntwh9sani`
- Work Orders: `m828b9fafbkim2k`
- Condition Findings: `mwjnwa9me35w92i`
- (Asset Updates: get its table ID from the meta `/tables` list once created)

---

## TL;DR

- **Adding a property today (manual):** Assets column → matching Asset Updates
  Target Field option → (form if captured) → (interface if hard-coded) →
  (views if reported on). Names must match exactly.
- **The fix for the chasing:** build the interface to read the Assets schema
  from the meta API and mark editable properties with an `@asset-property`
  description tag. Then adding a property = add the column, done.
