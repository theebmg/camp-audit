# Audit Engine — Browser Test Checklist

Everything below is **deployed and live**. The data layer was exercised against the real
database (including a full generation run, since cleaned up), but **no screen has been
driven by a human**.

## Seed form — check the fixtures first

The flags and remedies are **placeholders**, listed in `docs/audit-engine-decisions.md`.

- [ ] Nav → 📋 **Audit Rounds** → **Start a round**. The form "Building Audit" is offered.
- [ ] Find them: `SELECT q.question_key, o.label FROM audit_question_options o JOIN audit_questions q ON q.id=o.question_id WHERE o.is_fixture;`
- [ ] Decide whether Fair/Poor/Failed flagging on **every** rating question is right, or
      only some. It's currently all 11.

## Starting a round

- [ ] Filter by location, by type, search. Filters pick what to tick; they are not saved
      as the scope.
- [ ] "Select all shown" then narrow the filter — the selection survives.
- [ ] Create a round over 3–4 cabins. It opens on the round screen.
- [ ] Buildings are grouped by location, each with its photo or type icon.

## Walking a building

- [ ] Tap a building. Section 1/3 with a progress bar.
- [ ] Answer **Has Key = Yes** → **Key Fits Lock** appears. Change to **No** → it hides.
- [ ] Answer roof **Poor** → the ⚑ shows and "flagged — a finding will be raised".
- [ ] **+ note** on an answer → asks where it should also go. Pick "Also a note on this
      building".
- [ ] Turn airplane mode on, answer two more questions → **"2 unsaved — retrying…"** appears.
      Turn it back on → it clears to "All saved". ← the one most worth testing
- [ ] **＋ Flag something else** → description, then optionally a fix with hours and cost.
- [ ] Leave mid-audit and come back — you land where you left off with answers intact.
- [ ] Standing notes on a building appear **before** the questions on section 1.

## Review and generation

- [ ] **Finish** → review lists each flagged answer as a chain ("Roof condition: Poor").
- [ ] Lines show their snapshotted estimates and are individually uncheckable.
- [ ] Uncheck a line → it isn't created, but its **finding still is**.
- [ ] **Create work order** → toast names the WO; the round screen shows ✓ and the WO link.
- [ ] Open the work order: one job line per kept remedy, each linked to its finding.
- [ ] Open the building: the routed note is there, marked "From \<round name\>".
- [ ] The component condition wrote an **Inspected** row in the asset's history.
- [ ] A building with nothing flagged → "No issues found", **no work order**, instance ✓.
- [ ] A job-routed note on a building that ends with no WO → review asks what to do with
      it and will not let it be silently dropped.

## Known gaps — not bugs

- **Form builder (Phase 4)** not built. Flags, remedies and questions are editable only
  in SQL until it exists.
- **Scheduler (Phase 5)**: rounds are created by hand. The `campaign_form` target and the
  daily materialization job aren't built. Overdue is computed for the board report but
  there's no dashboard strip.
- **Query surfaces (Phase 6)**: no asset condition-history tab, no audit data screen, no
  round report. The data is there and relational — the screens are not.
- **Addendum §5b/5c/5d**: the asset profile layout, notes-on-profile and the computed
  condition status are not built. §5a (icons and photos) is.
- **Photos per answer** aren't wired into the runner yet; `allows_photo` is stored and
  the attachments pipeline exists.

---

# Phases 4–6 and the addendum — added 2026-09-23, all deployed

## Form builder (Phase 4) — do this before a real round

- [ ] Audit Rounds → **Edit "Building Audit"**.
- [ ] The **⚠ placeholder warning** lists everything still marked as a fixture (33
      options + 3 fixes at the time of writing).
- [ ] Untick "problem" on an answer you disagree with → the warning count drops.
      Editing clears the fixture mark, so the list shrinks as real decisions replace mine.
- [ ] **"severe"** only enables once "problem" is ticked — severe drives the building's
      condition to Poor, and a non-problem can't be severe.
- [ ] **+ fix** on an answer → title, hours, cost. `{asset}` is replaced with the
      building name at generation.
- [ ] **+ follow-up** on an answer → a question that only appears when that answer is
      given, rendered indented underneath it.
- [ ] Edit a question's wording → the key underneath it **does not change** (that key is
      what joins its answers across years).
- [ ] Delete a question with answers → it says **archive**, not delete, and greys out.

## Query surfaces (Phase 6)

- [ ] Reports → **Audit Data**. Pick a question, type an answer (`Poor`), see every
      building that matches, with counts per answer.
- [ ] **Export CSV** downloads the same rows.
- [ ] A round screen → **Round report**: completion, flags by question, and the work
      orders generated with total hours and cost.
- [ ] An audited building's page shows **Condition history** — the same question across
      rounds as one line, with the WO it produced.

## Asset condition (§5d)

- [ ] An asset with nothing open reads **Good**.
- [ ] One with an open finding reads **Needs attention**, with the reason listed.
- [ ] One with an overdue WO, or an unresolved severe flag in its latest audit, reads
      **Poor** — always with reasons, never a bare score.
- [ ] A never-audited building says **"not yet audited"** rather than passing as Good.
- [ ] Complete the work → the status changes on its own. It is computed, never stored.

## Scheduler and overdue (Phase 5)

- [ ] Boot log says `scheduler: daily materialization armed`.
- [ ] Attach an audit form and a building scope to a recurring calendar event, then
      `POST /api/pg/audit-rounds/materialize` — a round appears with its instances.
- [ ] Run it twice — **no duplicate round**. The guard table is keyed on (event, occurrence).
- [ ] Give a round a past due date with work outstanding → the **⚠ Overdue** strip
      appears at the top of the dashboard with its progress.
- [ ] Complete the round → the strip entry disappears by itself.
- [ ] With nothing late, the dashboard shows **no strip at all** — a permanent empty
      banner trains you to ignore the spot where the real warning appears.

## Still not built

- **Photos per answer** in the runner. `allows_photo` is stored and the attachments
  pipeline exists, but the capture button isn't wired into the runner yet.
- **Checklist editor on WO templates** (board-report brief §7) — the checklist tables
  gained a `section` column but there is no editing screen.
- Drag reordering in the builder (arrows/drag); ordering is by `sort_index` today.

---

# Final three pieces + the iPhone photo fix — 2026-09-23, deployed

## iPhone photo picker (test this first, on the phone)

`capture="environment"` was telling iOS to open the camera and skip its menu entirely,
so there was no way to attach a photo already in the library. Removed from **all six**
image inputs; `accept="image/*"` and `multiple` kept.

- [ ] On the iPhone, tap **any** photo button. iOS shows **Photo Library / Take Photo /
      Choose File** — not the camera straight away.
- [ ] Pick two photos at once from the library; both attach.
- [ ] Check all six places: an asset's photos, a component photo during an audit,
      general condition photos, a finding photo, the shared attachment control on a work
      order, and the public maintenance-request form at `/request`.

## Photos per answer in the runner

- [ ] Start an audit, reach a **condition question** (roof, siding, foundation — these
      are the ones with `allows_photo`).
- [ ] Tap **📷 photo** → the iOS menu appears → pick from the library.
- [ ] The thumbnail appears under that question.
- [ ] Take a photo **before** answering the question — it still attaches (the answer row
      is created empty and the value arrives later).
- [ ] Leave and come back; the photo is still there.

## Checklist sections

- [ ] Admin → **Checklist Templates** → add a step. Each step now has a **Section** field
      suggesting "Tools & Materials" plus any section already used in that template.
- [ ] Attach the checklist to a work order → the card groups steps under their section
      headings, in the order the sections first appear.
- [ ] A checklist with no sections renders exactly as it did before — flat, ungrouped.

## Builder reordering

- [ ] Audit Rounds → Edit form. Each top-level question has **↑ ↓** buttons.
- [ ] Tap ↓ — the question moves and the order survives a reload. **This is the phone
      story:** HTML5 drag events don't fire on touch at all.
- [ ] On a desktop, drag a question by its row — it drops where you leave it.
- [ ] Follow-up questions have no arrows and don't drag; they travel with the answer
      that reveals them.

## Ad-hoc flags — now a real form (Q4 resolved)

- [ ] In the runner, tap **＋ Flag something else**. One form, not a chain of prompts.
- [ ] **📷 Add photos** → the iOS menu appears → pick two from the library. Both thumbnails
      show, each with an × to remove before saving.
- [ ] Type a description, add a note, set **Where should the note go?** to "Also a note on
      this building".
- [ ] Open **Add a fix**, fill in a title, pick Volunteer and a funding source, add hours
      and cost. Save.
- [ ] The flag now appears **in that section** with its note and photo thumbnails, so you
      can see it registered rather than wondering.
- [ ] Save a flag with **no** fix — it still creates a finding, just no job line.
- [ ] Finish the audit: the flag appears on the review screen, the fix appears as a job
      line, and the routed note lands on the building.
