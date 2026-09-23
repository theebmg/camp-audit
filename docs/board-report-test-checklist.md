# Board Report Branch — Browser Test Checklist

Go through this before merging `board-report-purchases`. Everything below is untested in
a browser: the schema and queries were verified in rolled-back transactions, but no
screen has been driven by a human.

## Before you start

```bash
# On the droplet, in ~/camp-audit
git checkout board-report-purchases && git pull
cd /root/nocodb && docker compose build camp-audit && docker compose up -d camp-audit
docker exec camp-audit npm run migrate      # applies 0075–0083
```

**Migrations `0075`–`0083` have never been applied.** Two of them drop columns
(`admin_tasks.recurring_monthly_savings`, `expenses.work_order_id` / `job_line_id`), so
`main`'s code will not run against this schema. Merge and deploy together, and take a
database backup first — `~/backups` already has the nightly job.

---

## 1. Nothing that used to work broke

The highest-value tests, because these touch retired columns.

- [ ] **Admin task savings.** Open an admin task that has a recurring saving. The value
      still shows. Edit it, save, reopen — it persisted.
- [ ] Clear the savings field entirely, save, reopen — it's gone, not stuck at the old value.
- [ ] **Work Performed report** still shows its Administrative Work section with
      "Recurring savings: $X/month · $Y/year".
- [ ] Delete a scratch admin task that had a saving — no error, and it doesn't reappear.
- [ ] **Expenses.** Open an existing expense. Vendor, amount, date, tax, fund, category,
      receipt image all still render.
- [ ] Create a new expense and attach it to a work order. Save, reopen — the work order
      is still there. (It's an allocation now, not a column.)
- [ ] That work order's cost rollup includes the expense.
- [ ] **Expense inbox** still works: an emailed receipt lands, can be triaged and voided.
- [ ] **Dashboard fund tile** still shows "$X of $Y remaining" and the number looks right.

## 2. Splitting a receipt

- [ ] Open an expense → **Split this receipt…**. The everyday form is unchanged until
      you press it.
- [ ] A receipt with no line items can still be split by dollars.
- [ ] Split one receipt across **two different job lines**. Both show, amounts add up,
      "Still unassigned" falls to $0.00.
- [ ] Split only part of it — the unassigned remainder is stated, and the fund tile still
      accounts for the unsplit part.
- [ ] Add a **regular price** higher than the amount. Each split shows its share of the
      saving, and the shares add back to the discount.
- [ ] Split a share to **Leftover stock** — it demands a material, and refuses without one.
- [ ] Remove a split. Amounts and savings recalculate.
- [ ] Two splits funded differently (one cabin-holder job, one operating budget) both
      keep their own funding.

## 3. Materials and leftovers

- [ ] Nav → **📦 Materials**. Empty at first; "Add material" takes a name and unit.
- [ ] Buy a material on a receipt (line item + material), split some to a job and some to
      **Leftover stock**.
- [ ] The material now shows a balance on Materials on hand.
- [ ] Tap it — the movement history explains the balance.
- [ ] **Correct the count** with a negative number. The correction appears as its own row
      and the balance moves; the original movement is still there.
- [ ] **Tossed / damaged** reduces the balance and is refused if you try to make it add.
- [ ] Pick that material again in a split editor — you get
      **"You should have N … left"**. Using it reduces the balance and reports the cost.
- [ ] **Close a work order that bought tracked materials** — "Any materials left over?"
      appears *before* the WO closes. Entering a quantity adds it to stock; leaving blank
      adds nothing.
- [ ] Close a work order with **no** tracked materials — no prompt at all.

## 4. The board report

- [ ] Reports → **Board Report** opens a draft and fills it with suggestions. The old
      any-date-range generator is gone.
- [ ] Sections appear: Work Completed, Coming Up, Overdue, Administrative Work.
- [ ] A work order expands (▸) to show its job lines, each with its own checkbox.
- [ ] Checking/unchecking the work order carries all its lines. Partial shows "N of M".
- [ ] **Summary / Itemized** per work order; summary is the default on every one.
- [ ] **+ add note** on an item — it appears on the item and in the preview. Confirm a
      work order's *internal* notes never appear in the report.
- [ ] **Summary** box at the top saves as you type (navigate away and back).
- [ ] **Money header**: spent this period, spent YTD, recurring savings shown per-year,
      one-time savings separate. They're never added together.
- [ ] Change the period. Suggestions refresh, and you're told "N item(s) no longer match".
- [ ] **Items you unchecked or annotated survive that period change.** Untouched ones
      that fell out of range are gone. ← the one most likely to be wrong
- [ ] Admin tasks flagged `include_in_board_report` arrive checked; unflagged ones arrive
      **unchecked but visible**.
- [ ] Flag a job line "Feature on board report" — it appears in Coming Up regardless of date.

## 5. Publishing and copies

- [ ] **Preview** renders the report as the board sees it, reflecting exactly what's checked.
- [ ] **Save a copy** records one without publishing; the draft stays editable.
- [ ] **Download** saves a file *and* records it in History.
- [ ] **Email** on a draft warns it's a draft first; the subject arrives prefixed `DRAFT —`.
- [ ] **Publish** asks for confirmation, drops unchecked items, and the report becomes read-only.
- [ ] Open a past copy from History — it renders exactly as it went out, **not** a re-render.
- [ ] After publishing, opening Board Report starts a **new** draft, and its period begins
      where the published one ended.
- [ ] Publish, then complete more work, then reopen the published report — **its numbers
      have not moved.** ← the whole point of publishing

## 6. Retired things stay gone

- [ ] Reports has **no Forward Focus tab**.
- [ ] `/api/pg/reports/forward-focus/preview` and `/api/pg/reports/board/preview` 404.
- [ ] The board_focus flag on a work order now reads "Feature on board report".

---

## Known gaps — not bugs

- **Addendum §5a** (asset type icons, profile photos) is not built; it's on its own branch.
- The **audit engine** resumes after this merges; its tables are live but empty.
- **`docs/open-questions.md` Q2 and Q3** are still open (cabin-holder foreign key,
  `expenses.asset_id`). Neither blocks this branch.

---

# Reopen, featured-flag expiry, arrears — 2026-09-23, deployed

## Reopen a work order

- [ ] Open a **completed** WO → a **Reopen** button sits next to the status. It only
      appears on terminal work orders.
- [ ] Reopen with a reason → it lands in **Review**, not back in the open queue.
- [ ] **Job line statuses are untouched** — a Done line is still Done.
- [ ] The WO history shows the reopen, its reason, and the date it had been completed.
- [ ] Set a line back to an unresolved status → its linked condition finding reopens.
- [ ] Edit, then complete again. **Leftovers must not double:** the prompt is pre-filled
      with what the last close banked, and changing 4 to 3 files a **correction of −1**,
      not a second entry. Check Materials → the material's history shows one `wo_close`
      and one `correction`.
- [ ] A **published** board report containing that WO is unchanged. The current draft
      reflects the new state.
- [ ] The WO does not reappear as a new scheduler occurrence.

## Featured-flag expiry

- [ ] Feature a WO or job line ("Feature on board report") → on the draft report it shows
      **"featured since \<month\>"**.
- [ ] Complete it → the flag clears **by itself**, and the WO history records the
      auto-clear. It now appears in **Done** through the ordinary rule.
- [ ] **Reopen it → the flag stays off.** You re-check it if you want it.
- [ ] Uncheck a featured item on a draft → it leaves **that draft only**. The flag is
      still set, and the next draft proposes it again.

## Arrears — completion date left blank

- [ ] Mark a job line done, then clear its completion date.
- [ ] It still appears in the current draft's **Done** section, marked
      **"date not recorded"** — the fallback is the moment it was marked complete, and it
      is never passed off as the work date.
- [ ] Enter a real completion date → the marker disappears and the real date is used.

## "Add item" on the draft

- [ ] **＋ Add item** → search. Results span work orders, job lines, findings and admin
      tasks, **any status and any date** — including things far outside the period.
- [ ] Add one → it appears in the draft marked **"added by hand"**.
- [ ] It is toggleable, takes a note, and respects summary/itemized like any other item.
- [ ] **Refresh suggestions → it survives.** A suggestion rule can never remove it.

---

# "Already reported" — what stops an item being suggested again

**Note:** before this change there was no never-suggest-again rule at all — every
matching item was re-proposed on every draft, forever. This is the whole rule, not a
tweak to an existing one.

An item counts as reported **only if it was included (checked) in a report that was
PUBLISHED.** That falls out of publishing already deleting unchecked rows, so whatever
is still attached to a published report is exactly what the board saw.

## The four cases

- [ ] **Checked + published → gone.** On a draft, check item **A**. Publish. Start the
      next draft — **A is not suggested**.
- [ ] **Unchecked at publish → comes back.** On that same draft, uncheck item **B** before
      publishing. On the next draft, **B is suggested again** under the normal rules.
      (Unchecking means "not ready to show", not "never show me again".)
- [ ] **Drafts never count.** Put item **C** on a draft, then **Save a copy** *and*
      **Email** it — but do **not** publish. Start a fresh draft: **C is still suggested.**
      Neither saved copies nor emailed drafts mark anything as reported.
- [ ] **Hand-added follows the same rule.** Use **＋ Add item** to add **D**, then uncheck
      it and publish. On the next draft, **D is suggested.** Add it, leave it checked,
      publish — and it is not.

## Related behaviour

- [ ] A reported item that is later **reopened stays excluded**. Use **＋ Add item** to
      put it back on a report.
- [ ] A work order whose **header** was reported but which has **new lines this period**
      still gets its grouping row — the header is only skipped when the header itself was
      reported, not because some of its lines were.
- [ ] A **published** report's items can no longer be checked or unchecked at all. The
      route returns 409. That matters more now: editing a published report would rewrite
      what the board saw *and* silently change what is eligible in future.
