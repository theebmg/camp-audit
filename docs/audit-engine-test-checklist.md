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
