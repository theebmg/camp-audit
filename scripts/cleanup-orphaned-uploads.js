// Routes attachments that an abandoned form left behind into the triage
// inbox — the audit walkthrough, asset notes, and the public maintenance-
// request portal all upload photos before the row they belong to exists
// (see createAttachment's comment in db.js) and link them a moment later,
// inside the same transaction that creates the parent row. If that
// transaction never happens — a dropped connection, a closed tab, a reload
// before submit — the upload is stranded: already in Spaces, already a row
// in `attachments`, source='upload', zero links, invisible to every screen
// in the app.
//
// Recovered here, not deleted (Ben, 2026-09-13): these are photos taken
// standing in a building during the walkthrough month, and re-shooting one
// means driving back out there — silent deletion is the wrong default for
// something this expensive to replace. An orphan past the age floor is
// functionally the same as a photo emailed in with no job attached yet, so
// it gets the same treatment: one attachment_batches row (source='upload')
// per distinguishable origin, triage_status flipped to 'inbox', landing on
// the exact inbox screen Mailgun's photos land on, with the same "file to
// asset / create WO / void" actions. (This originally hard-deleted; see git
// history on this file for that version and why it changed.)
//
// The 48-hour age floor (findOrphanedUploadAttachments in db.js) is what
// keeps this safe to run frequently: a normal submission links its uploads
// within seconds, so nothing genuinely in-flight can ever be this old.
//
// Run nightly via cron, same pattern as backup.sh — see the crontab entry
// this was installed alongside. Safe to run by hand any time:
//   node scripts/cleanup-orphaned-uploads.js
import { findOrphanedUploadAttachments, getAssetNamesByIds, createInboxBatchForAttachments, pool } from '../src/db.js';
import { parseCategoryOwnerFromUrl } from '../src/storage.js';

// Storage keys are `category/ownerId/filename` (storage.js's keyFor); these
// are the categories the audit form and asset-notes screen upload under,
// where ownerId is always the asset id — see uploadAttachmentUnlinked's call
// sites in app.js. Any other category (e.g. 'requests', the public portal's
// ownerId='public') can't be traced back to an asset and falls into the
// generic "unknown source" batch below.
const ASSET_CATEGORY_LABELS = {
  components: 'a component-event photo',
  findings: 'a finding photo',
  'asset-photos': 'a general asset reference photo',
  notes: 'an asset-note photo',
};

function groupKeyFor(orphan) {
  const parsed = parseCategoryOwnerFromUrl(orphan.Url);
  if (parsed && ASSET_CATEGORY_LABELS[parsed.category] && /^\d+$/.test(parsed.ownerId)) {
    return `${parsed.category}:${parsed.ownerId}`;
  }
  return 'unknown';
}

async function main() {
  const orphans = await findOrphanedUploadAttachments({ olderThanHours: 48 });
  if (!orphans.length) {
    console.log('cleanup-orphaned-uploads: nothing to clean up');
    return;
  }

  const groups = new Map(); // groupKey -> orphans[]
  for (const a of orphans) {
    const key = groupKeyFor(a);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  const assetIds = [...groups.keys()].filter((k) => k !== 'unknown').map((k) => Number(k.split(':')[1]));
  const assetNames = await getAssetNamesByIds(assetIds);

  let batchCount = 0;
  for (const [key, group] of groups) {
    const n = group.length;
    const plural = n === 1 ? '' : 's';
    const was = n === 1 ? 'was' : 'were';
    let subject, note;
    if (key === 'unknown') {
      subject = 'Recovered from an abandoned upload';
      note = `${n} photo${plural} ${was} uploaded but never attached to anything, and the form that would have linked them was abandoned. Routed here automatically 48h+ after upload.`;
    } else {
      const [category, ownerIdStr] = key.split(':');
      const assetId = Number(ownerIdStr);
      const assetName = assetNames.get(assetId) || `asset #${assetId} (asset since deleted)`;
      subject = `Recovered from an abandoned audit — ${assetName}`;
      note = `${n} photo${plural} (${ASSET_CATEGORY_LABELS[category]}) ${was} uploaded during an audit walkthrough for "${assetName}" but the walkthrough was never submitted. Routed here automatically 48h+ after upload.`;
    }
    await createInboxBatchForAttachments({ subject, note, attachmentIds: group.map((a) => a.Id) });
    batchCount += 1;
  }

  console.log(
    `cleanup-orphaned-uploads: routed ${orphans.length} orphaned attachment(s) into the triage inbox as ${batchCount} batch(es):`
  );
  for (const a of orphans) {
    console.log(`  #${a.Id} ${a.OriginalFilename || '(no filename)'} — uploaded ${a.CreatedAt.toISOString()}`);
  }
}

main()
  .catch((e) => { console.error('cleanup-orphaned-uploads: FAILED', e); process.exitCode = 1; })
  .finally(() => pool.end());
