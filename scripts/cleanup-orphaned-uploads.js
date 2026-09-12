// Deletes attachments that an abandoned form left behind — the audit
// walkthrough, asset notes, and the public maintenance-request portal all
// upload photos before the row they belong to exists (see
// createAttachment's comment in db.js) and link them a moment later, inside
// the same transaction that creates the parent row. If that transaction
// never happens — a dropped connection, a closed tab, a reload before
// submit — the upload is stranded: already in Spaces, already a row in
// `attachments`, source='upload', zero links, invisible to every screen in
// the app. Part A's stance on storage ("pennies," no reaper for
// deliberately-voided content) doesn't apply here — that principle is about
// not second-guessing an explicit void; this is cleanup of rows nobody ever
// saw and nothing will ever reference.
//
// The 48-hour age floor (findOrphanedUploadAttachments in db.js) is what
// keeps this safe to run frequently: a normal submission links its uploads
// within seconds, so nothing genuinely in-flight can ever be this old.
//
// Run nightly via cron, same pattern as backup.sh — see the crontab entry
// this was installed alongside. Safe to run by hand any time:
//   node scripts/cleanup-orphaned-uploads.js
import { findOrphanedUploadAttachments, deleteAttachmentsByIds, pool } from '../src/db.js';
import { deleteObjectsByUrls } from '../src/storage.js';

async function main() {
  const orphans = await findOrphanedUploadAttachments({ olderThanHours: 48 });
  if (!orphans.length) {
    console.log('cleanup-orphaned-uploads: nothing to clean up');
    return;
  }

  const urls = orphans.flatMap((a) => [a.Url, a.ThumbUrl]);
  const { deleted: objectsDeleted } = await deleteObjectsByUrls(urls);
  const rowsDeleted = await deleteAttachmentsByIds(orphans.map((a) => a.Id));

  console.log(
    `cleanup-orphaned-uploads: removed ${rowsDeleted} orphaned attachment row(s) ` +
    `(${objectsDeleted} Spaces object(s)) older than 48h:`
  );
  for (const a of orphans) {
    console.log(`  #${a.Id} ${a.OriginalFilename || '(no filename)'} — uploaded ${a.CreatedAt.toISOString()}`);
  }
}

main()
  .catch((e) => { console.error('cleanup-orphaned-uploads: FAILED', e); process.exitCode = 1; })
  .finally(() => pool.end());
