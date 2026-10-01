// Email copies of report photos (Oct 2026 brief, Parts 2B and 2C).
//
// THE ORIGINAL IS NEVER MODIFIED. Everything here fetches the stored image, makes a new,
// smaller, labelled copy in memory, and throws it away once the email is built. Nothing is
// written back to storage.
//
// Stored images are already resized on ingest — 2000px long edge, JPEG q82 (src/storage.js) —
// so this is a second, smaller pass for email: 1600px and a lower quality, which lands a
// typical photo in the low hundreds of KB.
import sharp from 'sharp';

const EMAIL_LONG_EDGE = 1600;
const EMAIL_JPEG_QUALITY = 78;

// How much of the image height the caption band takes, and the floor so a small image still
// gets readable text.
const BAND_RATIO = 0.085;
const MIN_BAND_PX = 54;

export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// "BEFORE — Replace sump pump". The prefix comes from the role vocabulary, not from a
// hardcoded list, so renaming a role or adding one is an admin job (§2C). A role with no
// prefix — Reference, Spec — is captioned with its description alone.
export function buildPhotoLabel({ rolePrefix, description }, { maxLength = 72 } = {}) {
  const desc = String(description || '').replace(/\s+/g, ' ').trim();
  const prefix = rolePrefix ? String(rolePrefix).trim() : null;
  const budget = prefix ? maxLength - prefix.length - 3 : maxLength;
  let text = desc;
  if (text.length > budget) {
    // Cut at a word so a truncated label does not end mid-syllable.
    const cut = text.slice(0, Math.max(0, budget - 1));
    const lastSpace = cut.lastIndexOf(' ');
    text = `${(lastSpace > budget * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }
  if (!text) return prefix || '';
  return prefix ? `${prefix} — ${text}` : text;
}

// The caption is drawn as an SVG overlay rather than with a font library: a semi-transparent
// dark band along the bottom with light text, which stays legible on a snowy roof and on a
// dark basement alike (§2C).
function captionSvg(width, height, label) {
  const band = Math.max(MIN_BAND_PX, Math.round(height * BAND_RATIO));
  const fontSize = Math.round(band * 0.42);
  const padX = Math.round(band * 0.38);
  const baseline = Math.round(height - band / 2 + fontSize * 0.36);
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="${height - band}" width="${width}" height="${band}" fill="rgba(12,14,22,0.62)"/>
      <text x="${padX}" y="${baseline}"
            font-family="DejaVu Sans, Helvetica, Arial, sans-serif"
            font-size="${fontSize}" font-weight="700" fill="#ffffff"
            letter-spacing="0.3">${escapeXml(label)}</text>
    </svg>`);
}

// Fetch the stored image and return a labelled, email-sized copy. Returns null rather than
// throwing when an image cannot be fetched or decoded: one unavailable photo must not stop a
// board report going out.
export async function buildEmailCopy(url, label) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) { console.warn(`[report-photos] fetch ${res.status} for ${url.slice(0, 80)}`); return null; }
    const input = Buffer.from(await res.arrayBuffer());

    const resized = await sharp(input, { failOn: 'none' })
      .rotate()                                   // honour EXIF orientation before measuring
      .resize({ width: EMAIL_LONG_EDGE, height: EMAIL_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .toBuffer();
    const meta = await sharp(resized).metadata();

    const composed = label
      ? await sharp(resized)
        .composite([{ input: captionSvg(meta.width, meta.height, label), top: 0, left: 0 }])
        .jpeg({ quality: EMAIL_JPEG_QUALITY, mozjpeg: true })
        .toBuffer()
      : await sharp(resized).jpeg({ quality: EMAIL_JPEG_QUALITY, mozjpeg: true }).toBuffer();

    return { buffer: composed, bytes: composed.length, width: meta.width, height: meta.height };
  } catch (e) {
    console.warn('[report-photos] could not build an email copy:', e.message);
    return null;
  }
}

// An estimate of what the selected photos will weigh, for the meter on the report screen (§2B).
// Based on the stored file size rather than on building every copy, because the meter has to
// answer instantly while Ben is ticking boxes. The real copies come out smaller, so the meter
// errs on the side of warning early.
export function estimateEmailBytes(storedBytes, storedWidth) {
  const b = Number(storedBytes) || 0;
  if (!b) return 0;
  const w = Number(storedWidth) || EMAIL_LONG_EDGE;
  if (w <= EMAIL_LONG_EDGE) return Math.round(b * 0.8);   // re-encode at a lower quality
  // Bytes scale roughly with pixel count, and quality drops from 82 to 78.
  const scale = (EMAIL_LONG_EDGE / w) ** 2;
  return Math.round(b * scale * 0.9);
}

export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}
