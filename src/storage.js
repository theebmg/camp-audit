// DigitalOcean Spaces (S3-compatible) client + attachment ingest processing.
//
// Portability boundary: this is the ONLY module that knows about Spaces/S3 —
// same discipline as db.js/nocodb.js. Callers get back a plain https URL (plus
// derived metadata); the database only ever stores that URL string and the
// metadata, never binary data.
//
// Build Brief v2 Phase 4 (§4.5): ingest processing also lives here, not just
// the S3 call — resize, thumbnail, and EXIF extraction are part of turning an
// uploaded buffer into a storable attachment, and nothing else in the
// codebase may know these details either.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import sharp from 'sharp';
import exifr from 'exifr';

const endpoint = process.env.SPACES_ENDPOINT;
const region = process.env.SPACES_REGION || 'nyc3';
const bucket = process.env.SPACES_BUCKET;
const accessKeyId = process.env.SPACES_ACCESS_KEY;
const secretAccessKey = process.env.SPACES_SECRET_KEY;

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  console.error('WARNING: SPACES_* env vars not fully set. Photo upload will fail until configured.');
}

const s3 = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: false, // Spaces uses virtual-hosted-style URLs: bucket.region.digitaloceanspaces.com
});

const publicBaseUrl = () => `https://${bucket}.${region}.digitaloceanspaces.com`;

const MAX_LONG_EDGE = 2000;
const JPEG_QUALITY = 82;
const THUMB_LONG_EDGE = 400;

const DOCUMENT_MIMES = new Set([
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
]);

function kindFor(mimetype) {
  if (!mimetype) return 'other';
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (DOCUMENT_MIMES.has(mimetype)) return 'document';
  return 'other';
}

function keyFor(category, ownerId, ext, suffix = '') {
  return `${category}/${ownerId}/${Date.now()}-${crypto.randomUUID()}${suffix}.${ext}`;
}

async function putObject(buffer, key, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream', // wrong ContentType (e.g. octet-stream for a PDF) makes Spaces force a download instead of previewing
    ACL: 'public-read',
  }));
  return `${publicBaseUrl()}/${key}`;
}

// Reads EXIF from the ORIGINAL buffer, before any resize strips it.
// taken_at is what photos sort by, not created_at — a week's worth uploaded
// on Sunday must still sort by when they were actually shot.
async function readExif(buffer) {
  try {
    const tags = await exifr.parse(buffer, { pick: ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLongitude'] });
    if (!tags) return { takenAt: null, gpsLat: null, gpsLng: null };
    const takenAt = tags.DateTimeOriginal || tags.CreateDate || null;
    return {
      takenAt: takenAt instanceof Date ? takenAt.toISOString() : null,
      gpsLat: typeof tags.GPSLatitude === 'number' ? tags.GPSLatitude : null,
      gpsLng: typeof tags.GPSLongitude === 'number' ? tags.GPSLongitude : null,
    };
  } catch {
    // Corrupt/absent EXIF is routine (screenshots, downloaded images) — never
    // fail the upload over it.
    return { takenAt: null, gpsLat: null, gpsLng: null };
  }
}

// Ingests one uploaded file: resizes/thumbnails images, reads EXIF, uploads
// to Spaces, and returns everything the `attachments` row needs. Documents
// and anything else pass through unresized with no thumbnail (the frontend
// shows a file-type icon instead).
export async function storeAttachment(buffer, { filename, mimetype, category = 'misc', ownerId = 'unknown' }) {
  const ext = (filename?.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const kind = kindFor(mimetype);

  if (kind !== 'image') {
    const key = keyFor(category, ownerId, ext);
    const url = await putObject(buffer, key, mimetype);
    return {
      url, thumbUrl: null, kind, mimeType: mimetype || null, fileSize: buffer.length,
      originalFilename: filename || null, width: null, height: null,
      takenAt: null, gpsLat: null, gpsLng: null,
    };
  }

  const [exif, image] = await Promise.all([readExif(buffer), Promise.resolve(sharp(buffer, { failOn: 'none' }))]);
  const meta = await image.metadata();

  const full = await sharp(buffer, { failOn: 'none' })
    .rotate() // apply EXIF orientation before it's discarded, so the stored copy displays upright everywhere
    .resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  const fullMeta = await sharp(full).metadata();

  const thumb = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: THUMB_LONG_EDGE, height: THUMB_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  const key = keyFor(category, ownerId, 'jpg');
  const thumbKey = keyFor(category, ownerId, 'jpg', '-thumb');
  const [url, thumbUrl] = await Promise.all([
    putObject(full, key, 'image/jpeg'),
    putObject(thumb, thumbKey, 'image/jpeg'),
  ]);

  return {
    url, thumbUrl, kind: 'image', mimeType: 'image/jpeg', fileSize: full.length,
    originalFilename: filename || null, width: fullMeta.width || meta.width || null, height: fullMeta.height || meta.height || null,
    takenAt: exif.takenAt, gpsLat: exif.gpsLat, gpsLng: exif.gpsLng,
  };
}
