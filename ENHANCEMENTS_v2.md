# Camp Sychar CMMS — Build Brief v2 Enhancement Summary

**What this document is:** a summary of everything built under
`toClaudeCode/BUILD_BRIEF_v2_joblines_lifecycle_attachments.md`, for anyone
picking up this project who wasn't in the room for the work itself. For
day-to-day usage instructions, see `USER_GUIDE.md`. For the file-by-file
"what touches what" detail, see `update-for-claude.md` — this document is
the birds-eye view; that one is the ground-level reference.

**Status:** All 7 phases of the brief are complete, deployed to production
(audit.fracturedrv.com), and committed to `main`. Migrations 0030–0051.

---

## The one-sentence summary

The job line — not the work order — is now the unit of work (hours, cost,
funding, responsibility, status, scope, and attachments all live there);
work orders, job lines, and findings all have real lifecycles instead of
booleans; nine scattered photo columns became one polymorphic attachment
system with an email-fed triage inbox; work orders can split into siblings
without losing the family total; and reports, quotes, and audit-to-WO
creation all read from that same job-line-centric model instead of
duplicating logic.

## Why this mattered (the original problem)

Before this build, `work_orders` carried a single status, a single done/not
boolean per task, and one bag of hours/cost/funding for the whole job. That
made it structurally impossible to answer questions like:

- "How much of this roof-and-deck job came from the capital campaign vs. the
  cabin holder?" — a WO could only have one funding source.
- "Is this job actually blocked, or just not started yet?" — status and
  "blocked" were the same field.
- "What got done this spring, even though half the big jobs are still
  open?" — completion was tracked at the WO level, not per line of work.
- "What condition is the property actually in?" — findings had no
  lifecycle; `Open` meant both "urgent, nobody's looked at it" and
  "reviewed, we're deliberately waiting five years."

Every phase below exists to make a specific board-facing report possible,
per the brief's own framing: when a choice made the code cleaner but the
reporting worse, the reporting won.

---

## Phase 1 — Job lines become the unit of work

`work_order_tasks` was renamed to `job_lines` and became real: hours, cost,
funding source/reference, responsibility (self/volunteer/vendor/cabin-holder),
scheduling, and crew assignment all moved off the work order onto the line.
A work order's totals are now **derived rollups**, computed live from its
lines — never stored, never able to drift out of sync.

- One WO can now legitimately have lines against three different funding
  sources (roof from the capital campaign, deck from a cabin holder, windows
  from operating budget) — this was structurally impossible before.
- Complaint / cause / correction fields, with cause pulled from an
  admin-editable catalog (never freetext promoted into it — the dropdown is
  what gets counted, the note is what gets read).
- The calendar renders job lines, not work orders, so a vendor coming Tuesday
  and volunteers coming Saturday on the same WO both show correctly.

## Phase 2 — Lifecycle & status

`work_orders.status` and job lines' old `done` boolean both became
admin-editable status catalogs. Every status change — on either table —
writes a log entry automatically, with zero exceptions. A job-line status
that requires an explanation (like "Waiting on Parts") blocks the save
without one. Deferring a WO requires both a reason and a revisit date,
enforced server-side, not just in the UI.

- **Close gate**: a WO can close once no line is in a non-terminal status —
  not "all lines Done" (a line correctly marked "Not Needed" still counts).
  Closing is a review prompt, never automatic.
- **Blocked** lives on the job line, not as a WO status — a half-finished
  roof waiting on materials is genuinely both "In Progress" and "blocked" at
  once.
- Grid rows show a cost-weighted progress bar by default (configurable to
  count-weighted) — "67% of lines done" and "20% of the money spent" are
  very different sentences, and the board sees the honest one.

## Phase 3 — Findings lifecycle

`condition_findings.status` went from a single hardcoded `'Open'` with no
path out, to a real lifecycle: **Open** → **Scheduled** (automatic, the
instant a job line links to it) → **Resolved** (automatic, the instant that
line's work is actually done) or **Deferred**/**Dismissed** (manual, both
requiring an explanation, both attributable to whoever made the call).

- The dashboard now tracks Open findings (should trend toward zero) and
  findings not yet on any work order (the data-quality signal).
- Deferred findings, grouped by severity with dollar totals, are the
  Deferred Maintenance Backlog report (Phase 6) — likely the single most
  useful document this system produces for a capital campaign.

## Phase 4 — Unified attachments

Nine separate photo-storage locations across the app (asset photos, work
order photos, job-line photos, finding photos, component photos,
maintenance-request photos, asset-note photos, plus dead legacy columns)
collapsed into two tables: `attachments` (the file + metadata) and
`attachment_links` (a many-to-many join to whatever it's attached to). One
photo of a leaking roof can now be simultaneously the evidence on the
finding, the before-shot on the job line, and the reference image on the
asset — uploaded once.

- Images are automatically resized (2000px, quality 82) with a thumbnail
  generated alongside; EXIF date/GPS are read before the resize strips them.
- Every attachment has a **role** (Before/After/Evidence/Quote/Documentation/
  etc., admin-editable) and a **classification** (what part of the building
  it depicts, reusing the same catalog that already drove component
  tracking — no duplicate vocabulary).
- **Detach** (remove one link, file untouched) and **Void** (soft-delete
  everywhere at once, one tap, no confirmation dialog by design) are
  distinct operations.
- Capture is zero-decision on purpose — snap a photo, it uploads. Role and
  classification get set later, at a desk, not while standing in a cabin.

## Phase 5 — Triage inbox, email ingest, work order splitting

- **Triage inbox**: photos land here from a direct "Attach file" upload or
  (once configured) an inbound email mailbox. Grouped by batch (one email =
  one batch), multi-select, act on a subset (Create WO / Add to Existing WO
  / Add to Job Line / New Finding / File to Asset for reference / Void) and
  the rest stays in the inbox — a 20-photo walkthrough email can become
  three separate work orders without losing track of what's left.
- **Email ingest** (`src/mailIngest.js`) polls an IMAP mailbox every 5
  minutes. A subject line like "WO 1000" skips the inbox entirely and
  attaches straight to that work order. Everything else gets fuzzy-matched
  against asset names and offered as suggestions — never auto-assigned.
  *This mailbox integration has not yet been exercised against a live
  server* — see the follow-ups section below.
- **GPS-based suggestions**: a one-time 3-point calibration maps real-world
  GPS to the campmap's pixel space, so a photo's EXIF location can suggest
  the nearest asset during triage.
- **Work order splitting**: a WO can split into a sibling ("1000" →
  "1000-2") when part of the job needs to move independently — a specialist
  for the roof, self-service for the deck. The two remain a "family" with a
  combined cost/hours rollup, so splitting never silently fragments a
  project total. The work order grid defaults to showing root jobs only,
  with a chip that expands to the splits.

## Phase 6 — Reports

Job lines are now a first-class reporting entity, filterable by status,
whether they represent real work performed, responsibility class, funding
source, cause, asset, location, project, date range, and crew — using the
same generic explorer as the existing Assets/Work Orders reports. Findings
got the same treatment.

Two new named reports:
- **Work Performed in a Date Range** — every job line completed in the
  range, regardless of whether its parent work order is fully closed yet,
  grouped by building, with After photos embedded. This is the document
  that proves six months of activity while the big multi-line jobs are
  still legitimately open.
- **Deferred Maintenance Backlog** — every deferred finding, grouped by
  severity, with dollar totals per group.

Quotes now attach directly to the job line (vendor, amount, date, which one
was selected) via the same attachment system, and the job-line report shows
a "Quotes Received" count — shopping discipline visible across every job at
once.

## Phase 7 — Audit → Work Order

The last mile: at the end of a walkthrough, every open finding on an asset
can become a work order in one action. A finding's suggested job-line title
comes from an admin-editable template (matched by building type and/or the
part of the building it concerns — "Roof repair — {asset name}"), editable
before saving. One submit creates the work order with one job line per
checked finding, each one linked back to its finding, so Phase 3's
auto-scheduling fires and every finding on that WO moves from Open to
Scheduled without any extra steps.

---

## Notable fixes made along the way

- **Pre-existing database ownership drift**: 10 tables were owned by the
  wrong Postgres role, silently blocking one queued migration from a prior
  session and would have blocked more. Fixed by an operator running a
  one-time `ALTER TABLE ... OWNER TO camp_app` — see `update-for-claude.md`
  for the exact commands, since the running container's image doesn't
  include the tooling to run this itself.
- **A map report bug predating this work**: the interactive map's
  "board-focus" filtering was comparing against work-order status names
  that never actually existed in this app (`'Completed'`/`'Cancelled'`
  instead of the real `'Done'`/`'Cancelled'`), so it was silently always-off
  before anyone touched it. Now reads the real status catalog.
- **A bug caught only because of live smoke-testing, not code review**: the
  migration that made `work_orders.wo_number` required would have broken
  *all* new work-order creation in production, because the three places
  that insert a work order hadn't been updated to set it. Found and fixed
  before this was ever pushed live, by actually creating a test work order
  against the real database and watching it fail.

## What's genuinely not built yet

- **Live email ingest is unverified.** The code is written and defensive
  (a bad poll logs and moves on, never crashes the app), but there were no
  real IMAP credentials to test against this session. Add
  `IMAP_HOST`/`IMAP_USER`/`IMAP_PASSWORD` (and optionally `IMAP_PORT`/
  `IMAP_MAILBOX`) to `.env`, redeploy, and watch the container logs on the
  first real poll.
- **Manual photo re-selection when a report has more images than the
  embed cap** — the report auto-picks the best photos by role priority
  instead of prompting the user to choose. Worth building once real
  multi-photo report volume exists to design the picker against.
- **EXIF photo clustering in the inbox** groups by time only, not
  time-and-GPS-distance together, for the same reason: no real GPS-tagged
  test photos existed this session to validate the fuller version against.
- **A hard-delete cleanup job** for voided attachments (they're soft-deleted
  immediately, and the underlying file is intentionally kept for a
  one-click undo, but nothing yet purges files older than 30 days). Marked
  low-priority in the brief itself.

Every one of these is called out with more detail, in the file(s) it
affects, in `update-for-claude.md`.
