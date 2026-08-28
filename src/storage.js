// DigitalOcean Spaces (S3-compatible) client for photo uploads.
//
// Portability boundary: this is the ONLY module that knows about Spaces/S3 —
// same discipline as db.js/nocodb.js. Callers get back a plain https URL; the
// database only ever stores that URL string, never binary data.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

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

// Uploads a photo, returns its public URL. `category`/`ownerId` just namespace
// the object key for readability in the bucket (e.g. "notes/74/<uuid>.jpg").
export async function uploadPhoto(buffer, { filename, mimetype, category = 'misc', ownerId = 'unknown' }) {
  const ext = (filename?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const key = `${category}/${ownerId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: mimetype || 'application/octet-stream',
    ACL: 'public-read',
  }));
  return `${publicBaseUrl()}/${key}`;
}
