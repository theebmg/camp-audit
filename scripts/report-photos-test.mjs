// Board report photos, end to end, against the REAL report (Oct 2026 brief, Part 2A-2C).
//
//   docker exec camp-audit node scripts/report-photos-test.mjs [reportId]
//
// Touches real rows — the roles on two photos and the selection table — and puts every one of
// them back in a finally block, asserting afterwards that they really did go back. An earlier
// version reported its own restore as successful while leaving two September photos roled
// Before/After, because updateAttachmentLink could not clear a role; hence the last two
// assertions, which check the restore rather than trusting it.
import * as db from '/app/src/db.js';
import { buildPhotoLabel, buildEmailCopy, estimateEmailBytes, formatBytes } from '/app/src/reportPhotos.js';
import { renderBoardReportFromItems } from '/app/src/reportDataPg.js';

const fail = [];
const ok = (c, l) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${l}`); if (!c) fail.push(l); };

const REPORT = Number(process.argv[2]) || (await db.getOrCreateDraftBoardReport()).Id;
// Snapshot what we are about to touch, so it can all go back.
const beforeRows = (await db.pool.query('SELECT * FROM board_report_photos WHERE report_id=$1', [REPORT])).rows;
const cand0 = await db.listBoardReportPhotoCandidates(REPORT);
const photos = cand0.flatMap((g) => g.Photos.map((p) => ({ ...p, ItemId: g.ItemId, ItemTitle: g.Title })));
if (photos.length < 2) {
  // Not a pass. Everything already published is not proposed onto a new draft, so a fresh
  // report can have no photos at all — say so rather than exiting green.
  console.log(`SKIPPED — report ${REPORT} has ${photos.length} photo(s); needs 2.`);
  console.log('Run against a report that has them:  node scripts/report-photos-test.mjs <reportId>');
  process.exit(0);
}
const [pA, pB] = photos;
const origRoles = (await db.pool.query(
  'SELECT id, role_id, include_in_report FROM attachment_links WHERE id = ANY($1) ORDER BY id',
  [[pA.LinkId, pB.LinkId]])).rows;
console.log(`baseline: roles ${JSON.stringify(origRoles)}, ${beforeRows.length} selection row(s)`);

const roles = await db.listAttachmentRoles();
const before = roles.find((r) => r.DefaultIncludeInReport && /before/i.test(r.Name)) || roles.find((r) => r.DefaultIncludeInReport);
const after = roles.find((r) => r.DefaultIncludeInReport && r.Id !== before.Id);
console.log(`using roles: "${before?.Name}" and "${after?.Name}"`);

try {
  console.log('\n## a role marked for the report pre-ticks the photo');
  await db.updateAttachmentLink(pA.LinkId, { roleId: before.Id });
  await db.updateAttachmentLink(pB.LinkId, { roleId: after.Id });
  await db.seedDefaultReportPhotos(REPORT);
  let cand = await db.listBoardReportPhotoCandidates(REPORT);
  let all = cand.flatMap((g) => g.Photos);
  const a1 = all.find((p) => p.AttachmentId === pA.AttachmentId);
  const b1 = all.find((p) => p.AttachmentId === pB.AttachmentId);
  ok(a1.Selected && b1.Selected, 'both newly-roled photos are ticked without Ben touching anything');
  ok(a1.RolePrefix != null, `and carry a caption prefix (${a1.RolePrefix} / ${b1.RolePrefix})`);

  console.log('\n## the screen and the send path agree');
  let sel = await db.listSelectedReportPhotos(REPORT);
  const uiIds = all.filter((p) => p.Selected).map((p) => p.AttachmentId).sort((x, y) => x - y);
  const sendIds = [...new Set(sel.map((p) => p.AttachmentId))].sort((x, y) => x - y);
  ok(JSON.stringify(uiIds) === JSON.stringify(sendIds), `${uiIds.join(',')} on screen == ${sendIds.join(',')} in the email`);
  ok(sel.every((p) => p.RolePrefix), 'every selected photo keeps its role through the send-path query');

  console.log('\n## unticking one really removes it from the email');
  await db.setBoardReportPhoto(REPORT, pB.AttachmentId, { itemId: pB.ItemId, included: false });
  sel = await db.listSelectedReportPhotos(REPORT);
  ok(!sel.some((p) => p.AttachmentId === pB.AttachmentId), 'the unticked photo is gone from the send path');
  await db.seedDefaultReportPhotos(REPORT);
  sel = await db.listSelectedReportPhotos(REPORT);
  ok(!sel.some((p) => p.AttachmentId === pB.AttachmentId), 'and seeding again does NOT tick it back on');
  await db.setBoardReportPhoto(REPORT, pB.AttachmentId, { itemId: pB.ItemId, included: true });

  console.log('\n## the caption');
  sel = await db.listSelectedReportPhotos(REPORT);
  for (const p of sel) {
    console.log(`    "${buildPhotoLabel({ rolePrefix: p.RolePrefix, description: p.Description })}"`);
  }
  const labels = sel.map((p) => buildPhotoLabel({ rolePrefix: p.RolePrefix, description: p.Description }));
  ok(labels.every((l) => l.length > 0), 'none is empty');
  // Only the two photos THIS test roled are under test. Real photos already on the report may
  // legitimately share a caption — ten shots of one job all roled Before all read the same, and
  // that is a data-entry matter for Ben, not a failure of the renderer.
  const labelOf = (id) => {
    const p = sel.find((x) => x.AttachmentId === id);
    return p ? buildPhotoLabel({ rolePrefix: p.RolePrefix, description: p.Description }) : null;
  };
  ok(labelOf(pA.AttachmentId) !== labelOf(pB.AttachmentId),
    `the before and the after read differently: "${labelOf(pA.AttachmentId)}" vs "${labelOf(pB.AttachmentId)}"`);

  console.log('\n## an email copy is built, captioned, and smaller');
  const one = sel[0];
  const copy = await buildEmailCopy(one.Url, buildPhotoLabel({ rolePrefix: one.RolePrefix, description: one.Description }));
  ok(!!copy, 'a copy was produced');
  if (copy) {
    ok(copy.bytes <= one.FileSize * 1.1, `${formatBytes(one.FileSize)} stored -> ${formatBytes(copy.bytes)} for email`);
    ok(copy.width <= 1600 && copy.height <= 1600, `fits the email long edge (${copy.width}x${copy.height})`);
  }
  const fresh = (await db.pool.query('SELECT file_size, width FROM attachments WHERE id=$1', [one.AttachmentId])).rows[0];
  ok(Number(fresh.file_size) === one.FileSize && fresh.width === one.Width, 'THE ORIGINAL ROW IS UNCHANGED');

  console.log('\n## a role can be taken back off');
  await db.updateAttachmentLink(pA.LinkId, { roleId: null });
  const cleared = (await db.pool.query('SELECT role_id, include_in_report FROM attachment_links WHERE id=$1', [pA.LinkId])).rows[0];
  ok(cleared.role_id === null, 'choosing "no role" really clears it, rather than keeping the old one');
  ok(cleared.include_in_report === false, 'and it stops being marked for the report');
  await db.updateAttachmentLink(pA.LinkId, { roleId: before.Id });
  const reset = (await db.pool.query('SELECT role_id FROM attachment_links WHERE id=$1', [pA.LinkId])).rows[0];
  ok(reset.role_id === before.Id, 'and setting one again still works');

  console.log('\n## the rendered report carries the photos');
  const rendered = await renderBoardReportFromItems(REPORT, { withPhotos: true });
  ok((rendered.inlineAttachments || []).length === sel.length,
    `${rendered.inlineAttachments?.length} inline attachment(s) for ${sel.length} selected photo(s)`);
  for (const att of rendered.inlineAttachments || []) {
    ok(rendered.html.includes(`cid:${att.cid}`), `the HTML references cid:${att.cid}`);
  }
  const bytes = (rendered.inlineAttachments || []).reduce((t, a) => t + (a.content?.length || 0), 0);
  const est = sel.reduce((t, p) => t + estimateEmailBytes(p.FileSize, p.Width), 0);
  console.log(`    real ${formatBytes(bytes)} vs the meter's estimate ${formatBytes(est)}`);
  ok(est >= bytes * 0.5, 'the meter is in the right ballpark and errs high, so it warns early not late');
} finally {
  console.log('\n## restoring the real report exactly as it was');
  // Raw SQL on purpose. Restoring through updateAttachmentLink is what let an earlier run
  // report success while leaving real photos roled: the function under test cannot be trusted
  // to undo the test.
  for (const r of origRoles) {
    await db.pool.query('UPDATE attachment_links SET role_id = $2, include_in_report = $3 WHERE id = $1',
      [r.id, r.role_id, r.include_in_report]);
  }
  await db.pool.query('DELETE FROM board_report_photos WHERE report_id=$1', [REPORT]);
  for (const r of beforeRows) {
    await db.pool.query(
      `INSERT INTO board_report_photos (id, report_id, attachment_id, item_id, included, sort_order, snap_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [r.id, r.report_id, r.attachment_id, r.item_id, r.included, r.sort_order, r.snap_label]);
  }
  const nowRoles = (await db.pool.query(
    'SELECT id, role_id, include_in_report FROM attachment_links WHERE id = ANY($1) ORDER BY id',
    [[pA.LinkId, pB.LinkId]])).rows;
  ok(JSON.stringify(nowRoles) === JSON.stringify(origRoles), 'photo roles are back as Ben had them');
  const nowRows = (await db.pool.query('SELECT * FROM board_report_photos WHERE report_id=$1', [REPORT])).rows;
  ok(nowRows.length === beforeRows.length, `${nowRows.length} selection row(s), was ${beforeRows.length}`);
}

console.log(`\n${fail.length ? `${fail.length} FAILURE(S): ` + fail.join(' | ') : 'all assertions passed'}`);
process.exit(fail.length ? 1 : 0);
