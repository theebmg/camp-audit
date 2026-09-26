# Test checklist — Text Intake, People & Groups, Visitor Log

Your §10 list, plus what changed underneath it. Ticks mark what is already proven by an
automated test against the real database; the rest is for you, because it needs a phone, a real
text, or your judgement about your own data.

Run the automated ones yourself any time:

```
docker exec camp-audit node scripts/merge-test.mjs      # 22 assertions
docker exec camp-audit node scripts/visits-test.mjs     # 35 assertions
docker exec camp-audit node scripts/intake-test.mjs     # 41 assertions
```

All three create scratch records named `ZZ-…` and delete them at the end, and all three clear
any residue from a previous run before starting.

---

## People & Groups

| | Check | Status |
|---|---|---|
| ☑ | Add a person from the visitor form → duplicate check suggests a close match | **Automated.** `"Jen Lapp"` finds `"Lapp, Jen"`, scores it 100, and shows the cabin for "Did you mean…?" |
| ☑ | …choosing existing links to it; "create anyway" makes a new one | **Automated** at the layer; the dialog offers both. Worth one manual pass for feel. |
| ☑ | The check does NOT conflate different people | **Automated.** `Spain, Sandy` is not reported as `Spain, Randy`. |
| ☑ | Merge two duplicate people → all visits and links move to the kept record | **Automated.** Visits, calendar events, group contacts, roles and holdings all move; roles and holdings *union* rather than collide. |
| ☑ | Merge leaves zero references to the removed record | **Automated**, checked independently of the merge's own internal check, which also verifies inside the transaction and rolls back if anything remains. |
| ☑ | Every merge is logged | **Automated.** `record_merges` records who, what, and the per-table counts. |
| ☐ | **Merge `Caylee Severence` into `Severance, Caylee`** — the one you said you'd do yourself. People → open either → Merge… | Yours |
| ☐ | **Check `Strine, Brett` vs `Strike, Brett`** — Olde Dorm 03 and Annex 05. One person or two? | Yours |
| ☑ | Person with two roles → both role fields shown | **Verified in the browser.** Volunteer and Vendor-contact fields appear only when ticked; they start hidden. |
| ☑ | Profile shows cabin and visit history | **Verified in the browser** and by test. |
| ☑ | The editor does NOT offer a "Cabin holder" checkbox | **Verified in the browser** — it is derived from having a holding, and the form says so. |
| ☑ | Group visit with headcount → appears on the group profile with count | **Automated.** 1 visit, typical headcount 15. |
| ☐ | **Look at the People list and tell me if the `Last, First` ordering bothers you.** ~100 of 157 read that way. One UPDATE to change, and the duplicate check already treats both orders as equal. | Yours |
| ☐ | **Look at Holdings → Unlinked (14)** and confirm they should stay unlinked. | Yours |

## Visitor log

| | Check | Status |
|---|---|---|
| ☑ | Calendar visit for tomorrow → expected entry, called ahead = yes | **Automated.** Scheduling *is* calling ahead. |
| ☑ | …after the date passes, appears in "Did they show up?" | **Automated.** A future event correctly does *not* appear yet. |
| ☑ | **Yes** → confirmed, with arrival time and duration | **Automated.** |
| ☑ | **No** → no-show, kept, and not counted as a visit | **Automated.** |
| ☑ | **Different day** → confirmed with the corrected date | **Automated**, and re-running the calendar projection afterwards does **not** rewrite it. |
| ☑ | The projection is idempotent | **Automated.** Running it twice makes one visit, not two. |
| ☑ | An already-expected visit is offered instead of a duplicate | **Automated.** One day off matches; nine days off does not. |
| ☑ | Visitor Activity reads the visit log | **Automated.** Cabin holder under Cabin Holders, non-holder and group under Other Visitors, no-show excluded. |
| ☐ | **Open Reports → Visitor Activity** and confirm it reads the way you expect now that groups are in it. | Yours |
| ☐ | Manual quick entry on your phone, date/time pre-filled to now | Yours |
| ☐ | CSV export opens in whatever you use | Yours |

## Text intake — blocked until the Quo key

Everything below the line needs the key. See `docs/open-questions.md` for exactly what I need.

| | Check | Status |
|---|---|---|
| ☑ | 9 PM text → same day, not next | **Automated**, and across the DST boundary too. |
| ☑ | Text with no hint → no category, correct Eastern date/time | **Automated.** |
| ☑ | Hint words pre-select and are stripped for display | **Automated**, including `Receipt:` with a colon and `FIX` in caps, and that `visitors are here` is *not* a hint. |
| ☑ | Retried delivery → no duplicate | **Automated**, and the retry does not overwrite what was stored. |
| ☑ | Text from a number that isn't mine → ignored | **Automated.** Counted, never stored. An empty allowlist accepts nobody. |
| ☑ | Signature verification | **Automated.** Wrong secret, tampered body, no secret, unsigned, and an hour-old replay are all rejected. |
| ☑ | Text "receipt" with a photo → receipt triage like an emailed receipt | **Automated.** `source = text`, `triage_status = inbox`. |
| ☑ | Text "fix" → the work-photo destination | **Automated.** |
| ☑ | Move a work photo to Receipt → text and photo move; history shows it | **Automated**, both directions. |
| ☑ | Move refuses to break a split receipt | **Automated.** The move happens, the split expense is left intact, and the UI is told what was left behind. |
| ☑ | Dismiss keeps the item | **Automated.** |
| ☑ | The settings screen never leaks a secret | **Verified in the browser** — asserted against the rendered HTML. |
| ☐ | **Add the two environment variables** and recreate the container | Yours (or say the word) |
| ☐ | **Register the webhook** at `https://audit.fracturedrv.com/api/quo/inbound` | Yours |
| ☐ | **Put your number in Incoming → Text settings.** Nothing is processed until you do. | Yours |
| ☐ | **Send a real test text** — the part nothing else replaces | Yours |
| ☐ | Text "visitor Chuck Davis came Thursday…" sent Friday → date Friday, you change to Thursday, pick Chuck, called ahead = no | Yours, after the key |
| ☐ | Confirmation reply arrives | Yours, after the key |

## Sessions and the phone

| | Check | Status |
|---|---|---|
| ☑ | A deploy no longer signs you out | **Verified.** Signed in, force-recreated the container, still signed in with an authenticated API call returning 200. |
| ☑ | 90-day sliding cookie, secure and httpOnly | **Verified** through Caddy: 90 days, `secure`, `httpOnly`. |
| ☐ | **Stays signed in across days on your actual phone** | Yours — only time proves a sliding window. |
| ☐ | Home-screen icon: Add to Home Screen, check the icon and that it opens without Safari's chrome | Yours |
| ☐ | Badge counts look right | Yours. They count new Incoming items and visits awaiting an answer. |

## Regression — things that should NOT have changed

| | Check | Status |
|---|---|---|
| ☑ | The map renders cabins and holders exactly as before | **Verified.** 130 pins, 119 with holder names, base image and 264 shapes. Unchanged, because `cabin_holders` and `lodge_holder` were not touched. |
| ☑ | `cabin_holders` still has 173 rows; 174 assets still linked | **Verified** after every migration. |
| ☑ | `syncCabinHoldersFromAssets()` does not touch People | **Verified** by running it and re-counting: 173 / 157 / 159, unchanged. |
| ☑ | Funding through a cabin holder still works | Untouched by design — funding points at holdings, not people, and the merge test asserts the roster and asset links are unchanged. |
| ☐ | Open a few work orders, the calendar and Capital Plan and confirm nothing looks off | Yours |
