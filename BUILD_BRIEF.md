# Build Brief — Camp Sychar CMMS Audit + Work-Order App

You (Claude Code) are picking up a partially-scaffolded Node/Express app. This
brief is the source of truth for what to build and why. A few backend files
already exist (see "Existing scaffold"). Read them, then continue.

**Do not re-litigate the architecture decisions below — they're settled.** Build
against them. If something here is technically impossible, stop and say so rather
than silently changing the design.

---

## What this app is

A mobile/iPad-friendly web app for one operator (soon maybe 1–2 volunteers) to
walk the camp property and, per asset:
1. **Audit** it — answer questions about keys and construction, which UPDATE the
   existing asset record.
2. **Report findings** — note deficiencies, which CREATE Condition Finding
   records linked to the asset.
3. Later (phase 2): create and complete **Work Orders**, where completing a WO
   writes changes back to the asset's fields.

The whole reason this is a custom app and not a NocoDB form: **NocoDB forms write
to ONE table and only CREATE records. This app must write across MULTIPLE tables
and UPDATE existing records in one submit.** That capability is the point.

---

## Backend it talks to: NocoDB (self-hosted)

- NocoDB is live at `https://nocodb.fracturedrv.com`, Data API v2.
- Auth to NocoDB is via an **API token** in the `xc-token` header.
- **The token is secret. It lives ONLY server-side, in a `.env` file (gitignored),
  read by the Express backend. The browser must NEVER see it.** All NocoDB calls
  go through our Express backend, which proxies to NocoDB. The frontend talks only
  to our backend.
- This app operates on ~337 real, already-cleaned asset records. Treat writes with
  care — this is live production data that took real effort to get correct. Prefer
  read-only testing until write paths are verified. Never bulk-delete or bulk-write
  as a test.

### Base + table IDs (base `p0rfnut85c1hmpa`)
| Table | ID |
|---|---|
| Locations | `mkyqlm9b3z9ua7h` |
| Volunteers | `mdug0yptbhp2yr1` |
| Projects | `maifuufxc1ei26s` |
| Assets | `mcwn0dntwh9sani` |
| Work Orders | `m828b9fafbkim2k` |
| Condition Findings | `mwjnwa9me35w92i` |
| Asset Updates | *(get ID at runtime from meta `/tables`; set NC_TBL_ASSET_UPDATES in .env)* |

### Key NocoDB Data API v2 endpoints
- Table meta (fields/schema): `GET /api/v2/meta/tables/{tableId}`
- List records: `GET /api/v2/tables/{tableId}/records?where=...&limit=...&fields=...`
- Get one: `GET /api/v2/tables/{tableId}/records/{recordId}`
- Create: `POST /api/v2/tables/{tableId}/records` (body = field map)
- Update: `PATCH /api/v2/tables/{tableId}/records` (body = `{ Id, ...fields }`)
- Link records: `POST /api/v2/tables/{tableId}/links/{linkFieldId}/records/{rowId}`
  (body = `[{ Id }]`)

**Verify these against the live instance early** — hit `GET meta/tables/{assets}`
and a `limit=1` records call before building on them. NocoDB's exact link-setting
semantics have quirks; confirm empirically. (This project has already been bitten
once by NocoDB's importer wedging on bulk link resolution — so for links, use the
Data API link endpoints, one record at a time, not bulk operations.)

---

## Schema-driven design (important — reduces future maintenance)

The Assets table gains new "properties" over time (Has Key, Roof Material, and
later things like Window Type). **Do NOT hard-code the asset-property field list.**

Instead: the backend reads the Assets table schema from `GET meta/tables/{assets}`
and derives which fields are editable "asset properties." Mark those fields by a
convention: a field is an editable asset property if its **description contains the
token `@asset-property`**. The audit UI builds its questions from that list, and
each single-select's options come from the meta response too (so answer choices
always match NocoDB exactly, and typos are impossible).

Result: to add a new audited property later, the operator adds the column in
NocoDB + tags its description `@asset-property` — and this app picks it up with no
code change. Build toward that from day one.

(There is a companion runbook, `camp-cmms-adding-asset-property.md`, describing
this from the NocoDB side. This app is the "interface" it refers to.)

---

## The current asset-property fields (already added in NocoDB)

All single-select. Tag each of these fields' descriptions with `@asset-property`
in NocoDB so the app discovers them (the operator will do this; app should handle
their presence/absence gracefully):

- **Has Key**: Yes / No / Unknown
- **Key Fits Lock**: Yes / No / Not Tested / N/A
- **Free-Standing Building**: Yes / No
- **Roof Material**: Asphalt Shingle / Metal / Membrane / Other / Unknown
- **Siding Material**: Wood / Vinyl / Metal / Brick / Log / Other / Unknown
- **Foundation Type**: Slab / Crawlspace / Basement / Pier & Beam / Other / Unknown

### Conditional question logic (audit flow)
- Ask **Has Key** first. Only if `Yes` → ask **Key Fits Lock**.
- Ask **Free-Standing Building** first. Only if `Yes` → ask **Roof Material**,
  **Siding Material**, **Foundation Type**.
- Keep it short on screen; expand only relevant follow-ups.

This conditional logic can be driven by config the app holds (a small
"if field X = value, then show fields [...]" map), since pure schema-reading won't
know the dependencies. Keep that dependency map in ONE obvious place, easy to edit.

---

## Condition Findings (created, not updated)

When the operator notes a problem during the audit, CREATE a Condition Findings
record and link it to the current asset. Condition Findings fields (confirm names
against meta): Title, Asset (link, Many-to-One), Location, System (select),
Severity (select), Description, Recommended Repair, Estimated Hours (number),
Estimated Cost (currency), Status (select), Date Identified (date), Photos
(attachment), Work Order (link), Project (link).

For the audit tool, minimum to capture: Asset link, Severity, Description. The
rest optional. Photos would be great on mobile if feasible (NocoDB attachment
upload via API — verify how; nice-to-have, not blocker).

---

## Phase 2 — Work Orders + Asset Updates write-back (build AUDIT first)

Design is settled; implement after the audit flow works.

- **Asset Updates** table = child of Work Orders (Many-to-One link to Work Orders).
  Each row = one instruction: `{ Work Order (link), Target Field (single-select of
  asset field names), New Value (text), Applied (checkbox) }`.
- A Work Order can have MANY Asset Updates (one per field it changes). This is why
  it's a child table and not a couple of columns on Work Orders — one WO must be
  able to change any number of asset fields, each field/value pair intact.
- **Completing a WO** (in this app): PATCH the WO status → Done, then for each of
  its Asset Updates where `Applied = false`: PATCH the linked asset setting
  `[Target Field] = New Value`, then set that update's `Applied = true`.
- `Target Field` option labels MUST exactly match Assets column names, or the
  write-back silently no-ops. When building the WO UI, populate Target Field from
  the same schema-derived `@asset-property` list so they can't drift.

---

## App shape / stack (settled)

- **Node + Express backend** (ES modules, Node 22). Holds the token, proxies all
  NocoDB calls, exposes a small `/api/*` for the frontend.
- **Simple mobile-first frontend** — plain HTML/CSS/JS served static from
  `public/`. No heavy SPA framework needed; keep it light and fast on a phone.
  (If you have a strong reason for a small framework, propose it — but vanilla is
  the default and probably right.)
- **Auth**: simple session login, users configured via env (`APP_USERS`), so
  adding a volunteer later is a config change, not a rewrite. v1 can compare
  plaintext from env; leave a clear TODO to move to hashed passwords.
- **Deploy**: containerized, added to the existing `~/nocodb/docker-compose.yml`
  stack on the droplet, behind the existing Caddy. New subdomain
  **`audit.fracturedrv.com`** (flat, sibling to nocodb.). Operator will add the
  DNS A record + Caddyfile block; you produce the Dockerfile, compose service, and
  Caddy snippet.

---

## Existing scaffold (already written — read and continue)

- `package.json` — express, express-session, cookie-parser; `type: module`.
- `src/nocodb.js` — NocoDB client: token from env, `TABLES` map with the IDs above,
  functions `getTableMeta / listRecords / getRecord / createRecord / updateRecord
  (PATCH with Id in body) / linkRecords`. `BASE_URL` from `NC_URL`.
- `src/server.js` — Express entry: JSON, session, env-configured multi-user auth
  (`APP_USERS="user:pass,..."`), `/login` `/logout`, `requireAuth` middleware, an
  **unauthenticated `/health`** route that proves NocoDB is reachable (reads Assets
  meta + a sample record), `/api` protected router, static `public/`.
- **MISSING — build this next:** `src/routes/api.js` (imported by server.js but not
  yet created — the server won't boot until it exists). This is the protected API
  the frontend calls: list locations/assets, get one asset (+ its current property
  values and the schema-derived question set), submit an audit (PATCH asset fields +
  POST any findings), and later the WO endpoints.

---

## Suggested build order

1. Create `.env` (NC_URL, NC_TOKEN, SESSION_SECRET, APP_USERS) + `.gitignore` it.
   `npm install`. Get the server to boot and `GET /health` to return green against
   the live NocoDB. **This proves token + connectivity before anything else.**
2. Build `src/routes/api.js`: endpoints to list locations & their assets, and to
   fetch one asset with its schema-derived audit question set.
3. Build the audit frontend: pick location → pick asset → answer conditional
   questions → submit.
4. Wire submit: PATCH the asset's property fields; POST a Condition Finding if a
   problem was noted; all in one request handled server-side.
5. Test end-to-end against ONE real asset. Verify in NocoDB the asset updated and
   the finding was created and linked.
6. Dockerfile + compose service + Caddy block for `audit.fracturedrv.com`. Deploy.
7. **Phase 2:** Work Orders — create, list, and the complete-WO write-back loop
   through Asset Updates.

## Guardrails
- Token stays server-side. Never log it. `.env` is gitignored.
- Live data — verify read paths before write paths; test writes on one record.
- For links, use the Data API link endpoints one record at a time (no bulk).
- Confirm NocoDB v2 endpoint/response shapes empirically early; adjust the client
  if reality differs from this brief.

