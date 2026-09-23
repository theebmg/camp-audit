# Brief — Reopen WOs, Featured-Flag Expiry, Arrears Dates

Three small fixes, one deploy.

## 1. Reopen completed/closed work orders

- A **Reopen** action on completed/closed WOs, with a confirm and an optional reason.
- Reopening moves the WO to **Review**, not back to open.
- **Job line statuses are unchanged** by a reopen. Changing a line back to an unresolved
  status reopens its linked condition finding accordingly.
- **Record every reopen** in the WO's history: date, and the reason if given.
- **Published board reports are unaffected** (snapshots). Drafts reflect current state.
- **Re-closing must not double-count leftovers.** The leftover prompt shows the
  quantities recorded at the previous close and lets them be adjusted. Changes are
  logged as correction movements, never a second "in" entry.
- The **scheduler guard** must not treat a reopened WO as a new occurrence. **Overdue**
  applies normally while it's open.
- Check everything else that reacts to a WO closing and make sure reopen → edit →
  re-close behaves correctly.

## 2. "Feature on board report" flag expiry

- The flag stays set while the item is unresolved and **clears automatically when the
  WO, job line, or finding is completed/resolved.** The item then appears in Done through
  the normal rule. Record the auto-clear in the item's history.
- If a completed item is **reopened**, the flag does **not** come back.
- Unchecking a featured item on a single draft **excludes it from that report only**. It
  does not clear the flag.
- On the report screen, featured items show **"Featured since [month]"**.

## 3. Arrears work with no completion date

- A job line completed with **no completion date** uses the **timestamp when it was
  marked complete** for the Done rule.
- Show a **"date not recorded"** marker on such lines (grid, WO, report). Entering a real
  date later replaces the fallback.
- **"Add item" on the draft report screen:** search across WOs, job lines, findings and
  admin tasks, any status or date, adding the selection to the current draft. Manually
  added items are marked as such and behave like any other included item. No suggestion
  rule should be able to keep something off the report that should be on it.
