# Sychar Operations — User Guide

This is a walkthrough of how to actually use the system day to day, written
for the person doing the work — not a technical document. Open the app at
**audit.fracturedrv.com**.

Everything on the left-side menu (tap the ☰ icon on a phone) is one of the
sections below.

---

## The big picture: how the pieces fit together

```
Locations → Assets → Audit (walkthrough) → Findings
                                               ↓
                                    Work Orders → Job Lines → Done
                                               ↓
                                            Reports
```

- **Locations** are buildings/areas (cabins, the lodge, the shop).
- **Assets** are the things inside or making up a location — a roof, a
  water heater, a whole cabin.
- **Auditing** an asset is a guided walkthrough that records its current
  condition and can flag problems.
- A flagged problem becomes a **Finding**.
- A finding turns into a **Work Order**, which is made of one or more
  **Job Lines** — the actual jobs to be done (a job line is where hours,
  cost, who's doing it, and photos all live).
- Finishing job lines is what shows up in **Reports** for the board.

You will spend most of your time in three places: **Locations** (walking
the property), **Work Orders** (getting jobs done), and the **Inbox**
(sorting photos that came in by email or upload).

---

## Doing a walkthrough (Audit)

1. Tap **Start Audit** in the menu, or open an asset from **Locations** and
   tap **Start Audit** on its page.
2. Answer whatever questions come up — the form only shows what's relevant
   to that type of building (a shed doesn't ask about plumbing).
3. Any answer can be flagged 🚩 with a note if something's off — this
   creates a lightweight finding automatically, without leaving the form.
4. If the walkthrough prompts you about specific components (roof,
   siding, foundation — whatever this building type tracks), fill in
   condition/material/notes and snap a photo if you want.
5. At the bottom, you can also add general photos of the whole asset and
   report one specific bigger Finding with its own severity and
   description — use this for something worth writing up properly, not
   every little thing.
6. Submit. That's it — no separate save step per section.

**When to use "Create Work Order from Findings" instead:** if you're
walking a whole building and flagging several things as you go, don't stop
to make a work order for each one. Finish the walkthrough(s), then from the
asset's page tap **+ Create Work Order from Findings** — every open finding
on that asset shows up with a checkbox and a suggested job title already
filled in. Uncheck anything you don't want on this particular work order,
edit any title that doesn't read right, and submit. One work order, one job
line per finding, done.

---

## Work Orders and Job Lines

A **Work Order** is the container — it has an asset, a status, a priority,
and photos/documents that apply to the whole job (a permit, an invoice).

A **Job Line** is the actual unit of work inside it. **This is where almost
everything happens**: hours, cost, who's funding it, who's doing it, the
schedule, the photos of the actual work, and its own status.

### Creating a work order
From an asset's page, tap **New Work Order**. Give it a title, then tap
**+ Add job line** for each piece of work — a roof repair and a deck repair
on the same cabin are two lines on one work order, not two work orders.
For each line, set:
- **Responsibility** — Self, Volunteer, Vendor, or Cabin-Holder
- **Funding source** — Operating Budget, Capital Campaign, Cabin-Holder,
  Fund, or Other (and which specific campaign/holder/fund/category)
- **Estimated hours/cost**, and a scheduled date (defaults to the work
  order's date, but you can move one line independently — the vendor comes
  Tuesday, the volunteers come Saturday)

**Actual Cost** on a job line is two things added together: whatever you
type into the field directly (for a vendor invoice paid straight by camp, or
anything else with no receipt), plus the total of any Expenses linked to
that line (see **Expenses** below) — the edit form shows both so you can
see which is which. Linking an expense to a line that's funded by a Fund
also defaults that expense's Fund for you.

### Working a job line
Open the work order, tap a job line to expand it. You can:
- Change its **status** (Not Started → In Progress → Done, or Waiting on
  Parts/Approval/Weather, or Not Needed/Cancelled). Some statuses ask a
  question when you pick them ("What are we waiting on?") — answer it, it's
  required.
- Fill in **Complaint / Cause / Correction** once work is actually happening
  or done — what was wrong, why (pick from the Cause dropdown — if you're
  not sure, pick **Unknown** rather than guessing; there's a separate
  freetext note for extra detail), and what fixed it.
- Assign a specific **volunteer or vendor** from the dropdown.
- Add **photos** — tap "+ Add" under Photos on the line. Just snap and go;
  you don't need to fill in what kind of photo it is right then (see
  "Photos and Attachments" below).
- Mark it **Blocked** with a reason if it's stuck on something — this
  doesn't change its status, it's a separate flag that shows up as a 🚧 on
  the work order.

### Closing a work order
A banner appears once every job line is finished (or marked Not Needed/
Cancelled) — that's your cue to review costs and hit **Complete Work
Order**. Closing is never automatic; you always press the button.

### Splitting a work order
If part of a job needs to go its own way — say, the roof needs a
specialist but the deck work can happen this weekend — check the box on
the line(s) that should split off and tap **Split Selected Lines Into New
WO**. You get a new work order numbered like "1000-2" off the original
"1000". Tap **Family** on either one to see the whole group together with a
combined total.

---

## Photos and Attachments

One system handles every photo and document in the app now — on assets,
findings, components, work orders, job lines, maintenance requests, and
notes.

- **Just snap and upload.** Don't stop to categorize anything in the field.
- **Later, at a desk**, tap any photo thumbnail to open it and set:
  - **Role** — what it IS (Before/Condition, After/Repair, Evidence,
    Documentation, Quote, Invoice, Permit, Warranty, Spec...)
  - **Include in board report** — whether this photo should show up in the
    Work Performed report. "After/Repair" photos default to yes.
  - A caption if useful.
- **Detach** removes a photo from just that one spot (the file itself is
  untouched — same photo can still be attached elsewhere).
- **Void** deletes it everywhere at once. This is deliberately a single
  tap with no "are you sure" — don't hesitate on junk, it's not gone
  forever, just hidden.

### Quotes
If you're comparing vendor quotes for a job, upload each quote as an
attachment on the job line, then tag its **Role as "Quote"** — extra fields
appear for the vendor, the amount, the date, and whether it's the one you
picked. This is how "who did we shop and what did they quote" gets tracked.

---

## The Inbox

Photos that arrive by email (send to **photos@cmms.fracturedrv.com**) or
that you upload directly without attaching them to anything specific land
here, grouped by batch (one email = one batch).

For each batch:
1. Check the photos you want to act on (or tap a suggested "cluster" if
   several were shot close together in time).
2. Pick an action: **Create WO**, **Add to Existing WO**, **Add to Job
   Line**, **New Finding**, **File to Asset** (just for reference, no work
   order needed), or **Void**.
3. The app will suggest which asset you probably mean, based on the email
   subject or the photo's location data if it has any — tap a suggestion to
   fill it in, or search for the right one yourself. It never guesses for
   you automatically.
4. Whatever you didn't select stays in the inbox — work through a batch a
   few photos at a time, it doesn't have to be all-or-nothing.

**Tip:** if you're emailing photos in for a specific work order you already
know the number of, put "WO 1000" (or whatever the number is) somewhere in
the subject line — those photos skip the inbox completely and attach
straight to that job.

---

## Expenses

Ben's own record of what he spends on the camp debit card — not a
replacement for camp accounting. He still separately emails every receipt
to the treasurer, same as always; this is just so he can see what a
purchase went to and how much of a fund is left.

**Receipts by email.** Forward or send a receipt to
**receipts@cmms.fracturedrv.com** — Amazon order confirmations, Home Depot/
Lowe's emailed receipts, anything. It lands in the Expenses inbox with
vendor, amount, and date pre-filled where the email could be parsed (marked
"Parsed from email — confirm"), plus the receipt image or PDF attached.
Nothing is ever saved from a parsed guess — you always confirm or correct
it before it counts.

**Triage a receipt:** open it from the inbox, check/fix Vendor, Amount,
Date, Tax Amount (and tick "charged in error" if sales tax was charged by
mistake — camp is tax-exempt), pick a Category and a Fund, optionally
attach it to a work order/job line/asset, then Save. **Void** if it's junk
(a newsletter, a shipping notice with no purchase) — one tap, no confirm,
the email itself is untouched and this can be undone.

**Add an expense manually** — the **+ Add Expense** button opens the same
form with everything blank, for a paper receipt you photograph later or a
purchase with no receipt at all.

**Funds** are money with a ceiling Ben is personally accountable for — right
now, the board's $5,000 Discretionary Audit Fund through the end of 2026.
The Expenses page and the Dashboard both show **$X of $Y remaining**. Going
over is expected and always allowed — the number just turns red as a
heads-up, it never blocks a save. The camp's regular operating budget is
**not** a fund; that stays with the treasurer.

**Linking to a job line** defaults the Fund automatically if that line is
funded from a fund — pick a different one, or none, any time.

---

## Reports

Menu → **Reports**. Along the top:

- **Data Explorer** — pick Assets, Work Orders, Job Lines, Findings,
  Progress Log, Crew Sessions, or Expenses, filter and sort however you
  want, export to CSV. Save a filter combination as a favorite if you run
  the same view often. For Expenses, filtering to one Fund is the board
  hand-off document; filtering Tax Charged In Error is the quarterly
  recovery list; leaving Fund or Category blank finds anything still
  unclassified.
- **Board Report** — a snapshot for a board meeting: open work orders by
  status/priority, outstanding cost by funding source, what got done this
  period, what's overdue, what's upcoming. Preview it, then send by email.
- **Forward Focus** — everything flagged ⭐ for board attention, sorted by
  cost.
- **Work Performed** — pick a date range; every job line finished in that
  window, grouped by building, with After photos included, even if the
  bigger work order it belongs to is still open. This is the "here's what
  we actually did" document.
- **Deferred Backlog** — every finding marked Deferred, grouped by
  severity, with dollar totals. This is the capital-campaign argument
  document.

Anything with a ⭐ **Flag for Board** button on a work order or finding
feeds Forward Focus. Anything with a checkbox to **Include in board
report** on a photo feeds the embedded images in Work Performed.

---

## Maintenance Requests

**audit.fracturedrv.com/request** is a public link (no login) anyone can
use to report a problem — share it with cabin holders, staff, whoever.
Submissions land under **Requests** in the menu for review: approve, deny,
or **Convert to Work Order** once you've decided it's real. This never
creates a work order automatically — someone always reviews it first.

---

## Admin

Most things that look like a fixed dropdown in this app are actually
editable — no developer needed to add a new one. Under **Admin**:

- **Work Order Statuses** / **Job Line Statuses** — the pipeline stages,
  colors, and which ones are "terminal" (no longer block anything).
- **Causes** — the dropdown for "why did this happen." Add new ones here;
  never let people type a new one into a freetext box.
- **Funds** — the pools of money Ben is accountable for, with a name,
  amount, and (optional) end date. **Expense Categories** — what kind of
  thing an expense was (Materials, Tools, Fuel, ...); same "never
  promoted from freetext" rule as Causes.
- **Attachment Roles** — the "what kind of photo is this" list.
- **Job Line Templates** — the suggested titles/defaults used by "Create
  Work Order from Findings" (e.g., "Roof repair — {asset}").
- **Work Order Templates** / **Checklist Templates** — for recurring
  maintenance that generates its own work orders on a schedule.
- **Component Types**, **Property Fields**, **Building Types** — what gets
  asked during an audit walkthrough, and for which kind of building.
- **Map GPS Calibration** — a one-time setup (3 reference points) that lets
  the Inbox suggest "which asset is this photo probably of" based on where
  it was taken.
- **Users** — who can log in and whether they're an admin.
- **Activity Log** — a running record of everything anyone's done.
