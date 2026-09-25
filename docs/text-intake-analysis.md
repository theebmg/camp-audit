# §0 Investigation — Text Intake, People & Groups, Visitor Log

Everything below is read off the live database and the current `main`, not inferred. Where a
finding contradicts the brief, that is called out plainly, because three of the brief's
premises turn out to be different in fact and two of them change what should be built.

---

## 0.1 Existing visitor data

**There is no visitor store. A "visit" is a calendar event with a `visitor_name`.**

`calendar_events` carries five visitor columns — `visitor_name`, `cabin_holder_id`,
`asset_id`, `visit_purpose`, `visitor_contact` — and the board report's Visitor Activity
section is built by `getVisitorActivityRawData({from, to})` (db.js:8154), which is three
lines: expand every calendar occurrence in range, keep the ones with a `visitor_name`, sort
by date. Type is deliberately ignored, per its own comment: a Volunteer Workday logged
against a specific visitor and cabin is still a visit.

How much data is actually there:

| | count |
|---|---|
| `calendar_events` rows, all time | **5** |
| …with `visitor_name` | **1** |
| …with `cabin_holder_id` | 1 |
| …with `asset_id` | 0 |
| …with `visit_purpose` or `visitor_contact` | 0 |
| recurring visitor events | 0 |

The single visitor event is a Constituent Visitation on 2026-09-17.

**So "extend it, don't build a parallel visitor store" cannot be followed literally**, because
what exists is not a visitor store — it is five calendar columns feeding a report, holding one
row. A visit log needs headcount, duration, arrival time, photos, a status of
expected/confirmed/no-show, a source of text/manual/calendar, and confirmed-by/at. Those are
not calendar-event properties, and the brief's own §2 describes visits that never have a
calendar event at all (a text that arrives after the fact, a manual quick entry).

**Decision, logged in open-questions.md: add a `visits` table and make it the one visit
store.** Calendar visit events become a *source* that creates an `expected` visit — which is
exactly what §2 already specifies — and Visitor Activity is repointed to read `visits`
instead of calendar occurrences. Nothing is parallel: after this there is one place a visit
lives, and the calendar keeps its role as the thing that schedules one. The one existing
visitor event gets an `expected` visit row so nothing is lost; with `n = 1` there is no
migration risk worth discussing.

## 0.2 Existing people-like records

### `cabin_holders` — 173 rows (not 174)

The 174 in the brief is the number of **assets** that point at a holder, not the number of
holders: 174 of 340 assets have a `cabin_holder_id`. There are 173 holder rows.

Columns, in full:

| column | type | null |
|---|---|---|
| `id` | integer | no |
| `name` | text | no |
| `notes` | text | yes |
| `created_at` | timestamptz | no |

**There is no phone and no email column.** §1's "basic fields: name, phone, email, notes"
means two additive columns.

The names are not uniformly people. A sample of the first eight: `Ben Greenawalt`,
`Lindsay O'Hare`, `Whittney Priest`, `Clark, Kim & Jason`, `Starbuck`, `Storage`,
`Full Cabin - Boyette`, `Lapp, Jen`. So the list mixes:

- ordinary single names,
- `Last, First` order (`Lapp, Jen`),
- couples and families (`Clark, Kim & Jason`) — 8 rows contain `&` or ` and `,
- surname-only labels (`Starbuck`),
- things that are not people at all (`Storage`, `Full Cabin - Boyette`).

This matters for two parts of the brief. The **duplicate check** has to cope with
`Lapp, Jen` vs `Jen Lapp` being the same person, which plain first/last part matching does
handle if the comparison splits on commas and ampersands as well as spaces. And **roles**
will leave rows like `Storage` with no sensible role — they are cabin labels, not people.
Flagged in open-questions.md; my lean is to leave them alone rather than invent a cleanup,
because they are load-bearing for the assets that point at them.

### What references `cabin_holders`

Real foreign keys (`ON DELETE NO ACTION` on both):

| table | column |
|---|---|
| `assets` | `cabin_holder_id` |
| `calendar_events` | `cabin_holder_id` |

**And one soft reference with no foreign key at all**, which the merge tool in §1 must know
about: `job_lines.funding_source = 'cabin_holder'` with `funding_ref_id` holding a
`cabin_holders.id` (db.js:1259, 1579). `funding_ref_id` is a bare `integer` on six tables —
`work_orders`, `job_lines`, `work_order_template_lines`, `audit_remedies`,
`expense_allocations`, and the ad-hoc flag table from 0086 — and none of them constrain it.

**Consequence: a merge tool that walks foreign keys will silently miss funding.** Repointing
has to be explicit for every `(table, funding_ref_id)` pair where `funding_source =
'cabin_holder'`. This is the same shape of trap as the fixture cleanup last week, and the
opposite lesson: there, following the keys was right because everything was a key; here,
following the keys alone would lose data.

### `volunteers` and `vendors` — 1 row each

Both have `name`, `phone`, `email`, `address`. Referenced by:

| table | via |
|---|---|
| `crew_session_volunteers`, `job_line_volunteers` | `volunteer_id` |
| `crew_session_vendors`, `job_line_vendors`, `attachment_links` | `vendor_id` |

**No volunteer name matches any cabin holder name.** With one volunteer and one vendor in the
whole system, §1's worry — "if separate volunteer/crew records represent the same people,
propose how to fold them in" — has nothing to act on yet. My proposal is therefore to do
nothing to them now: give People a `Volunteer` role as specified, leave the `volunteers`
table where it is serving crew assignment, and revisit only if the two lists ever describe the
same person. Vendors stay organizations, as the brief says, and `Vendor contact` on a person
links to one.

There is no `people`, `groups`, `visitors`, `visits`, or `person_roles` table. `crew_sessions`
is timesheet data, not people.

## 0.3 Existing email intake

**Mailgun, not Postmark.** One inbound route, because the free plan allows only one:

```
Mailgun → POST /mail/inbound  (src/routes/mail-dispatch.js)
            ├─ verifySignatureDetailed(body)          ← once
            ├─ findAttachmentBatchByMessageId(msgId)  ← idempotency, once
            └─ dispatch by recipient:
                 photos@cmms.fracturedrv.com   → ingestPhotoMail    (mail-inbound.js)
                 receipts@cmms.fracturedrv.com → ingestReceiptMail  (receipt-inbound.js)
```

`src/mailIngestShared.js` already exports everything the Quo webhook needs in §3:
`verifySignatureDetailed`, `logInboundHit`, `REPLAY_WINDOW_SECONDS` (24h), `isJunkImage`,
`mailParsers`, `extractHeader`, `extractEmailAddress`. Text intake should reuse this module
rather than grow a second copy of the same care.

Where each kind lands, which is what §5 has to match:

- **Work photos** → `createMailInboundBatch` writes an `attachment_batches` row (`source`,
  `subject`, `body_text`, `sender_email`, `message_id`, `received_at`, `spf_result`,
  `dkim_result`) and links attachments through `attachment_links`. A subject containing
  `WO 1000` or `WO 1000-2` skips the inbox and attaches straight to that work order.
- **Receipts** → `createReceiptInboundBatch` → an `expenses` row with `triage_status` and
  `source`, which is the receipt triage inbox. Current sources in the data: 11 attachments
  from `email`, 1 from `upload`.

Idempotency is keyed on `attachment_batches.message_id`. §3's `webhook-id` header fits the
same shape, but a text has no Message-Id, so it needs its own unique key — noted below.

## 0.4 Calendar visit event types

**Yes.** `calendar_event_types` already has six, all with `show_on_board_report = false`:

| id | name |
|---|---|
| 1 | Constituent Visitation |
| 2 | Volunteer Workday |
| 3 | Group Rental |
| 4 | Board Meeting |
| 5 | Camp Session |
| 6 | Other |

So §2 needs no new type: **Constituent Visitation** is the person visit and **Group Rental**
is the natural group visit. Both are already hidden from the board report, which is what the
brief asks for. What they lack is a group link — the visitor columns only offer
`cabin_holder_id` — so a `group_id` needs to join them.

---

## Two things the brief did not ask about, which block parts of it

### §8 cannot work as written: sessions are in memory

`src/server.js:22`:

```js
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-env',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
}));
```

No `store`, so this is `express-session`'s default **MemoryStore**. Two problems for "stay
signed in for 90 days":

1. `maxAge` is 12 hours, and it is not sliding.
2. **Every deploy signs everyone out.** We deploy by recreating the container, and MemoryStore
   lives in the process. No cookie lifetime can survive that.

So §8 needs a persistent session store before a long lifetime means anything. My lean:
`connect-pg-simple` against the existing Postgres (a session table is additive), plus
`rolling: true` and a 90-day `maxAge` for the sliding behaviour. That is one npm dependency
and no new service, which I read as within "no subscriptions beyond Quo". Logged for review
because adding a dependency is a decision, not a detail.

### The settings pattern to follow

`display_settings` is a single-row table (`id = 1`) mixing typed columns and `jsonb`:
`wo_progress_weighting`, `report_image_cap`, `nav_layout`, `cascade_defaults`. `budget_settings`
is the same idea. §3's sender allowlist and §7's confirmation-reply toggle should follow it
rather than invent a key/value store.

---

## What this means for the build order

Unchanged, with these adjustments:

1. **§1 People** — extend `cabin_holders` in place, as the brief expects: add `phone`,
   `email`, and a roles join table. No rename of the table itself; both FKs and the soft
   funding reference keep working untouched. The UI calls them People.
2. **§1 Groups** — new table, no existing data.
3. **§1 Merge** — must repoint the soft `funding_ref_id` references explicitly, not just FKs.
4. **§2 Visits** — new `visits` table as the single visit store; repoint Visitor Activity to
   it; add `group_id` to the calendar visitor columns; backfill the one existing visitor
   event.
5. **§3–§7** — reuse `mailIngestShared.js`; new idempotency key for `webhook-id`; settings in
   a single-row table.
6. **§8** — persistent session store first, then the long sliding lifetime.
