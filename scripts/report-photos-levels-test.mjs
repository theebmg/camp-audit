// Photos at both levels, plus photos on the report itself (Oct 2026 addition to Part 2A).
//
//   docker exec camp-audit node scripts/report-photos-levels-test.mjs
//
// Creates its own scratch attachment rows pointing at an image that already exists in storage —
// no upload, no new file, and the original attachment is never touched. Everything scratch is
// deleted at the end and the deletion is asserted.
import * as db from '/app/src/db.js';
import { buildPhotoLabel } from '/app/src/reportPhotos.js';
import { renderBoardReportFromItems } from '/app/src/reportDataPg.js';

const REPORT = 1;
const TAG = 'ZZ-LEVELS';
const fail = [];
const ok = (c, l) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${l}`); if (!c) fail.push(l); };

const made = { attachments: [], links: [], jobLines: [], items: [] };
async function purge() {
  await db.pool.query(`DELETE FROM board_report_photos WHERE attachment_id IN
    (SELECT id FROM attachments WHERE original_filename LIKE $1)`, [`${TAG}%`]);
  await db.pool.query(`DELETE FROM attachment_links WHERE attachment_id IN
    (SELECT id FROM attachments WHERE original_filename LIKE $1)`, [`${TAG}%`]);
  await db.pool.query('DELETE FROM attachments WHERE original_filename LIKE $1', [`${TAG}%`]);
  await db.pool.query('DELETE FROM job_lines WHERE title LIKE $1', [`${TAG}%`]);
}
await purge();
const photosBefore = (await db.pool.query('SELECT * FROM board_report_photos WHERE report_id=$1', [REPORT])).rows;

// An image that really resolves, reused by reference so nothing is uploaded or copied.
const src = (await db.pool.query(
  'SELECT url, thumb_url, width, height, file_size, mime_type FROM attachments WHERE kind=$1 AND deleted_at IS NULL ORDER BY id LIMIT 1', ['image'])).rows[0];
const mkAttachment = async (name) => (await db.pool.query(
  `INSERT INTO attachments (url, thumb_url, kind, mime_type, width, height, file_size, original_filename, source)
   VALUES ($1,$2,'image',$3,$4,$5,$6,$7,'upload') RETURNING id`,
  [src.url, src.thumb_url, src.mime_type, src.width, src.height, src.file_size, `${TAG}-${name}.jpg`])).rows[0].id;

const roles = await db.listAttachmentRoles();
const before = roles.find((r) => /before/i.test(r.Name));
const after = roles.find((r) => /after/i.test(r.Name));

// Find a work-order item already on the report, and give it a job line of our own.
const woItem = (await db.pool.query(
  `SELECT id, item_id, snap_title FROM board_report_items
   WHERE report_id=$1 AND item_type='work_order' AND included ORDER BY id LIMIT 1`, [REPORT])).rows[0];
if (!woItem) { console.log('no work-order item on report 1 — nothing to test'); process.exit(0); }
console.log(`using item "${woItem.snap_title}" (work order ${woItem.item_id})`);

try {
  const jl = await db.createJobLine(woItem.item_id, { title: `${TAG} the line's own work` });
  const aWo = await mkAttachment('wo');
  const aJl = await mkAttachment('jl');
  const aRpt = await mkAttachment('rpt');
  await db.linkAttachment(aWo, { entityType: 'work_order', entityId: woItem.item_id, roleId: before.Id });
  await db.linkAttachment(aJl, { entityType: 'job_line', entityId: jl.Id, roleId: after.Id });

  console.log('\n## a photo can hang off the work order as well as off a job line');
  await db.seedDefaultReportPhotos(REPORT);
  let groups = await db.listBoardReportPhotoCandidates(REPORT);
  const g = groups.find((x) => x.ItemId === woItem.id);
  const ids = g.Photos.map((p) => p.AttachmentId);
  ok(ids.includes(aWo), 'the work-order photo is offered under the item');
  ok(ids.includes(aJl), 'the job-line photo is offered under the same item');
  ok(ids.indexOf(aWo) < ids.indexOf(aJl), 'and the whole-job photo comes FIRST');

  console.log('\n## each is labelled from the right thing (§2C)');
  let sel = await db.listSelectedReportPhotos(REPORT);
  const woPhoto = sel.find((p) => p.AttachmentId === aWo);
  const jlPhoto = sel.find((p) => p.AttachmentId === aJl);
  ok(!!woPhoto && !!jlPhoto, 'both were pre-selected by their roles');
  const woLabel = buildPhotoLabel({ rolePrefix: woPhoto.RolePrefix, description: woPhoto.Description });
  const jlLabel = buildPhotoLabel({ rolePrefix: jlPhoto.RolePrefix, description: jlPhoto.Description });
  console.log(`    work order: "${woLabel}"`);
  console.log(`    job line  : "${jlLabel}"`);
  ok(/^BEFORE —/.test(woLabel), 'the whole-job photo is captioned BEFORE');
  ok(woLabel.includes(woItem.snap_title.slice(0, 12)), 'and named by the work order');
  ok(jlLabel.includes(TAG), 'the job-line photo is named by the line, not the work order');
  ok(sel.findIndex((p) => p.AttachmentId === aWo) < sel.findIndex((p) => p.AttachmentId === aJl),
    'the send path keeps the whole-job photo first too');

  console.log('\n## a photo can be put straight on the report');
  await db.linkAttachment(aRpt, { entityType: 'board_report', entityId: REPORT });
  await db.pool.query('UPDATE attachments SET caption=$2 WHERE id=$1', [aRpt, `${TAG} camp in the snow`]);
  await db.seedDefaultReportPhotos(REPORT);
  groups = await db.listBoardReportPhotoCandidates(REPORT);
  const loose = groups.find((x) => x.ItemId === null);
  ok(!!loose, `it appears in its own group ("${loose?.Title}")`);
  ok(loose?.Photos.some((p) => p.AttachmentId === aRpt), 'and the photo is in it');
  ok(loose?.Photos.find((p) => p.AttachmentId === aRpt)?.Selected === true,
    'included by default — putting it here IS the decision to show it');
  ok(groups[groups.length - 1] === loose, 'and it is the last group, after the jobs');

  sel = await db.listSelectedReportPhotos(REPORT);
  const rp = sel.find((p) => p.AttachmentId === aRpt);
  ok(rp?.Description === `${TAG} camp in the snow`, `captioned with what was typed: "${rp?.Description}"`);
  ok(sel[sel.length - 1].AttachmentId === aRpt, 'and it prints last of all');

  console.log('\n## the email');
  const rendered = await renderBoardReportFromItems(REPORT, { withPhotos: true });
  ok(rendered.html.includes('Other photos this month'), 'the report-level section is headed "Other photos this month"');
  const iOther = rendered.html.indexOf('Other photos this month');
  const iWo = rendered.html.indexOf(`cid:photo${woPhoto.Id}@sychar`);
  ok(iWo > 0 && iWo < iOther, 'per-item photos print before that section');
  ok((rendered.photoFailures || []).length === 0, `no photo failed to build (${rendered.photoFailures?.length})`);
} finally {
  console.log('\n## cleanup');
  await purge();
  await db.pool.query('DELETE FROM board_report_photos WHERE report_id=$1', [REPORT]);
  for (const r of photosBefore) {
    await db.pool.query(
      `INSERT INTO board_report_photos (id, report_id, attachment_id, item_id, included, sort_order, snap_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [r.id, r.report_id, r.attachment_id, r.item_id, r.included, r.sort_order, r.snap_label]);
  }
  const left = (await db.pool.query(
    `SELECT (SELECT count(*)::int FROM attachments WHERE original_filename LIKE $1) a,
            (SELECT count(*)::int FROM job_lines WHERE title LIKE $1) j,
            (SELECT count(*)::int FROM attachment_links WHERE entity_type='board_report') l`, [`${TAG}%`])).rows[0];
  ok(left.a + left.j + left.l === 0, `scratch rows deleted (${JSON.stringify(left)})`);
  const now = (await db.pool.query('SELECT count(*)::int n FROM board_report_photos WHERE report_id=$1', [REPORT])).rows[0].n;
  ok(now === photosBefore.length, `${now} selection row(s), was ${photosBefore.length}`);
}

console.log(`\n${fail.length ? `${fail.length} FAILURE(S): ` + fail.join(' | ') : 'all assertions passed'}`);
process.exit(fail.length ? 1 : 0);
