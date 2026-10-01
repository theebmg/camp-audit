# Hosted photo page — proposal, not built

Ben's instruction: **"Propose the approach before building the hosted-link part. Optimization
and the size meter come first."** Optimization and the meter are done and deployed. This is the
proposal for the remaining piece. **Nothing in here is built.**

## What problem it actually solves

A board report email carries its photos inline as `cid:` attachments. That works and is what
ships today, but it has a hard ceiling: mail servers bounce large messages, so the send path
refuses anything over the limit (15 MB, admin-editable) rather than letting it bounce silently.

The ceiling is a long way off right now. The September photos are 480×360 and about 30 KB each —
**roughly 500 photos would fit in one email.** They are small because they arrived by text.
A report built from phone-camera photos (2000 px, ~400 KB each after the existing resize, ~250 KB
as an email copy) hits 15 MB at about **60 photos**.

So: the hosted page is not needed for September, and probably not for a long while. Worth saying
plainly before building anything.

## Where it would be worth building

Two situations, neither of them "the email is too big":

1. **The board wants to look closer.** The email carries 1600 px copies with captions burned in.
   A link to full-resolution originals is useful on its own terms.
2. **A report with a lot of photos.** A big project month — a roof, a rebuild — where 60+ photos
   is plausible and the email would genuinely have to refuse.

## The approach I would take

**A read-only public page per report, reached by an unguessable link.**

- **One new table**, `board_report_links`: `report_id`, `token` (32 random bytes, base64url),
  `created_at`, `expires_at` (nullable), `revoked_at` (nullable), `created_by`, plus a `hits`
  counter so Ben can see whether anyone opened it.
- **One new route**, `GET /r/:token`, mounted **outside** the authenticated API and outside the
  SPA, so no session is involved and nothing else is reachable from it. It renders a plain
  server-side HTML page: the report heading, and the selected photos at full size with their
  stamped captions. No app JavaScript, no navigation, no way to reach any other record.
- **The photos stay where they are.** The page serves the existing stored URLs. No copies, no
  new storage, nothing written back — same rule as the email copies.
- **Revocable.** A button on the report screen creates a link and another revokes it. A revoked
  or expired token renders "This link is no longer available", not a 404 that looks like a bug.
- **The email gains one line** under the photos: "More photos from this month: <link>" — only
  when a link exists.

### What I would deliberately not do

- **No login for board members.** Accounts for people who look at one page a month is a
  maintenance burden and a support burden. An unguessable, revocable link is the right weight.
- **No public index.** There is no page listing reports; a token reaches exactly one report.
- **No search engine exposure.** `X-Robots-Tag: noindex, nofollow` and a `robots.txt` deny on
  `/r/`.
- **Nothing written from the page.** It is read-only, so a leaked link cannot change anything.

### What Ben should weigh before saying yes

A link is a link: anyone who receives it can forward it, and it is readable without a password.
Board report photos are pictures of camp buildings, which is not sensitive, but it is **his call**
rather than mine, and it is the real decision here. If he would rather nothing about camp was
reachable without a login, the honest answer is to skip this feature entirely — the inline-photo
email already does the job, and the meter now stops it going wrong.

### Rough size

One migration, one route file (~120 lines), one render function, two buttons and a status line on
the report screen. Half a day, most of it the page itself.

## Recommendation

**Hold.** The size ceiling is 60+ photos away from being a problem, and the feature's only real
cost is the decision about a password-free link. Revisit when a report first approaches the
limit — the meter on the report screen will show it coming, and it refuses rather than bouncing.
