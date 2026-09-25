# Brief — Text Intake (Quo), People & Groups, Visitor Log

Standing rules apply: fetch and confirm the checkout is current first; real data; additive
migrations; log questions in docs/open-questions.md as "decided, pending Ben's review" and
keep going; deploy when done.

**No AI anywhere in this feature.** No language-model calls, no external parsing services,
no subscriptions beyond Quo. Plain, predictable code. I fill in details myself when
confirming.

**Build order:** §0 investigation → §1 People & Groups → §2 Visitor log (incl. calendar
confirmations) → §3–§7 text intake and Incoming → §8–§9.

---

## 0. Investigate first (docs/text-intake-analysis.md)

1. **Existing visitor data:** the board report's "Visitor Activity" section (Cabin Holders /
   Other Visitors). Where does the data come from, which tables/fields, how is it entered
   today? Extend it; don't build a parallel visitor store.
2. **Existing people-like records:** `cabin_holders` (174 rows, FK from assets, used by the
   funding picker), and any volunteer/crew/contact tables. Report what exists and what
   references each.
3. **Existing email intake:** how receipt and work-photo emails are ingested and where each
   lands. Text intake feeds the **same** destinations.
4. **Calendar visit events:** is there a visit-type calendar event type today?

If a finding forces a real choice, log it with your lean and proceed.

## 1. People & Groups

### People
- **One People list** built on the existing `cabin_holders` records. Don't create a separate
  person table and migrate everything into it unless §0.2 shows that's clearly simpler; the
  likely shape is extending `cabin_holders` into the people table (or renaming the concept in
  the UI) so existing FKs (assets, funding) keep working untouched.
- **Couples stay one record.** A cabin holder record like "John & Mary Smith" is one person
  entry. No splitting.
- **Roles are multi-select checkboxes** on each person: **Cabin holder, Volunteer, Camp
  attendee, Vendor contact** (list admin-editable so more can be added later).
- **Conditional fields by role:**
  - Cabin holder → linked cabin(s)/asset(s) (uses the existing FK relationship).
  - Volunteer → optional skills/notes.
  - Vendor contact → linked vendor (vendors stay as organizations, not people).
  - Camp attendee → no extra fields for now.
- Basic fields: name, phone, email, notes.
- If §0.2 finds separate volunteer/crew records that represent the same people, report it and
  propose how to fold them in rather than doing it silently.

### Groups
- New small **Groups** list: group name ("Grace Church Youth"), type (youth group, church
  group, work team, other; admin-editable), optional contact person (from People), notes.

### Adding a new person or group inline
- Everywhere a person/group is picked (visitor log, Incoming confirm, etc.), use the
  searchable combobox with substring matching. If not found: **"Add new person"** / **"Add new
  group"** right there, like adding an asset from a WO.
- **Duplicate check before creating** (plain string matching, no AI): case-insensitive,
  ignoring punctuation and "&/and," matching first/last name parts. Show "Did you mean John
  Smith (Cabin 42)?" with Use existing / Create new anyway.
- Admin **merge** tool for duplicates that slip through: pick two people (or groups), keep
  one, repoint everything referencing the other, record the merge.

### Profiles
- **Person profile:** name, roles, linked cabin(s), contact info, notes, **visit history**
  (count, last visit, list), and anything else already tied to them (funding, work).
- **Group profile:** name, type, contact, visit history with headcounts ("3 visits this year,
  usually ~15").
- Cabin asset profiles get a **Visits** section.

## 2. Visitor log

Extend the existing visitor data per §0.1. A visit is **either a person or a group**.

Fields:
- **Who:** person (People) **or** group (Groups). Required, never free text.
- **Headcount** (groups; optional for a person with guests).
- **Where:** cabin/asset or area (combobox).
- **Date**, **arrival time** (optional; "not stated" allowed), **duration** (optional).
- **Reason** (short text), **Called ahead** (yes/no), **Notes**, **Photos**.
- **Status:** expected / confirmed / no-show.
- **Source:** text / manual / calendar. **Confirmed by / at.**

### Calendar visits
- A **visit** calendar event type (create or confirm per §0.4; hidden from the board report as
  before). Visit events pick a person or group, not free text.
- Each visit event automatically creates an **expected** visitor entry, **called ahead = yes**.
- **Once the event's date passes**, the entry appears in a **"Did they show up?"** queue at the
  top of the visitor log (and counted in the nav badge): "Did Chuck Davis show up on Thu Oct
  30?"
  - **Yes** → confirm with arrival time, duration, notes, photos → status confirmed.
  - **No** → status no-show (kept; no-shows are part of the pattern).
  - **Different day** → confirm with the corrected date.
- A visit logged from a text or manually that has **no matching expected visit** defaults to
  **called ahead = no** (editable). If a matching expected visit exists (same person/group,
  within a day or two), offer to confirm that one instead of creating a second entry.

### Visitor log screen
- Newest first; the "Did they show up?" queue pinned at top.
- Filters: person, group, role, cabin/area, date range, called ahead, status, source. CSV
  export.
- **Manual quick entry** for when I'm already in the app: one screen, date/time pre-filled to
  now.

## 3. Quo webhook

- I'll create a Quo API key and give it to you directly. Create the webhook via the Quo API
  for **`message.received`** only, pinned to the current API version. Signing secret and API
  key stored as **environment variables**, never in source or docs.
- **Verify every delivery's signature** against the raw request body before parsing; reject
  unsigned/invalid.
- **Idempotency** on the `webhook-id` header; retries never duplicate.
- **Sender allowlist:** only messages **from my cell number** (in settings, editable) are
  processed. Everything else is ignored by this system and works normally in Quo. Log a count
  of ignored senders for debugging; don't store their content.
- **Attachments:** download media promptly (URLs may expire), store via the existing
  attachments pipeline (resize on ingest), link to the Incoming item.
- Verify with Quo's test-event endpoint, then have me send a real test text.

## 4. Timestamps

- Convert the received timestamp to **America/New_York** before any use. A 9 PM text never
  lands on the next day.
- **Pre-fill date and time from the received timestamp only.** No parsing dates from the
  message body. I correct the date myself when confirming.
- Show the original message text beside the form while confirming.

## 5. Incoming inbox

- New **Incoming** screen, same style as the receipt/photo inboxes. Every processed text lands
  here: text, photos, received date/time, status (new / filed / dismissed).
- **Optional first-word hint** pre-selects a category (case-insensitive, stripped from the
  text): `visitor`, `receipt`, `fix`, `note`. No hint = I pick.
- **Nothing files automatically.** Every item is confirmed by me.
- Confirm per category, pre-filled with timestamp and attachments:
  - **Visitor** → visitor log entry (§2), with the person/group combobox and inline add. If an
    expected visit matches, offer to confirm it.
  - **Receipt** → an expense in the existing receipt triage inbox, exactly as an emailed
    receipt (source = text), photo as receipt attachment.
  - **Fix** → wherever emailed work photos go today (§0.3), photos attached.
  - **Note** → a dated note on an asset or WO I pick.
- **Batch confirm** for several items of the same category.
- **Dismiss** keeps the item, marked dismissed.

## 6. Move to…

- Every Incoming item, visitor entry, text-sourced receipt, and text-sourced work photo gets
  **"Move to…"** to re-file as another category, carrying the original message and all
  attachments.
- Removes it cleanly from the old destination and records the move in history. If removal is
  unsafe (e.g. an expense already split across WOs), say so in the UI rather than breaking it.

## 7. Confirmation reply (setting, default on)

After a text is stored, reply from the camp line to my number only: "Got it — in Incoming."
Setting to turn off.

## 8. Stay signed in on my phone

- Long sliding session lifetime (e.g. 90 days of inactivity). Logout and existing security
  checks intact.
- Web app manifest / apple-touch-icon for a clean home-screen icon; Incoming and Visitor log
  one tap from the nav, with a badge count (new Incoming items + "did they show up?" items).

## 9. Email unchanged

Existing receipt and work-photo email addresses keep working exactly as they do.

## 10. Test checklist (docs/text-intake-test-checklist.md)

- Add a person from the visitor form → duplicate check suggests an existing close match →
  choosing existing links to it; "create anyway" makes a new one.
- Merge two duplicate people → all visits and links move to the kept record.
- Person with Cabin holder + Volunteer roles → both role fields shown; profile shows cabin and
  visit history.
- Group visit with headcount → appears on the group profile with count.
- Calendar visit for tomorrow → expected entry, called ahead = yes → after the date passes,
  appears in "Did they show up?" → Yes / No / different day each behave correctly.
- Text "visitor Chuck Davis came Thursday to clean out his cabin, no call" sent Friday →
  Incoming, Visitor pre-selected, date Friday → I change to Thursday, pick Chuck Davis →
  logged, called ahead = no → shows on his profile and his cabin's profile.
- Text with no hint → Incoming, no category, correct Eastern date/time.
- Text "receipt" with a photo → lands in receipt triage like an emailed receipt.
- Text "fix" with two photos → both land in the work-photo destination.
- Text from a number that isn't mine → ignored.
- Retried delivery → no duplicate.
- Move a work photo to Receipt → text and photo move; history shows it.
- 9 PM text → same day, not next.
- Phone stays signed in across days; home-screen icon works; badge counts are right.
