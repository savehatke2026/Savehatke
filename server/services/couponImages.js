// ============================================
// SaveHatke — Coupon Image Uploads (Google Drive asset folders)
// ============================================
// Brand-logo and coupon-card-background images uploaded from the Coupon
// Management edit form go into the EXISTING SaveHatke Drive asset folders —
// the same two folders that already hold every brand-level logo/background:
//
//     SaveHatke Assets/
//     ├── Brand Logos/          ← per-coupon logo uploads land here
//     └── Coupon Backgrounds/   ← per-coupon background uploads land here
//
// This module REUSES the project's existing Google Drive integration
// (services/googleDrive.js — OAuth refresh token from Supabase
// security_credentials, env fallback, or the Workspace service account) and
// the existing brand-assets folder resolution (services/brandAssets.js). No
// new storage provider, no new credentials, no Supabase Storage, and no
// base64 image data is ever written to Supabase — the coupon row stores only
// a short image REFERENCE:
//
//     /api/brand-assets/file/<driveFileId>
//
// That is the same reference shape the brand-level resolution already
// returns, so every consumer (admin cards, reviews table, marketplace card,
// checkout hero, edit-form preview) renders it with zero changes. The files
// stay PRIVATE in Drive and are served only through the scoped
// /api/brand-assets/file/:fileId proxy, which authorizes a file by checking
// it lives in one of the two asset folders (brandAssets.isKnownAssetFile) —
// controlled access without public Drive links and without exposing any
// service credentials.
//
// Naming: per-coupon uploads are prefixed "coupon-" so the brand-asset
// resolver (which treats a file's stem as the brand key) can never mistake
// a per-coupon image for a brand-level asset ("amazon.png" would hijack the
// Amazon brand logo; "coupon-logo-<id>-....png" normalizes to a key no real
// brand uses).
//
// Replaced images: the previous Drive file is intentionally left in place.
// Deleting it could destroy a still-referenced asset (rows are not the only
// way a file is used), and Drive image storage of small logos/backgrounds
// is effectively free. Orphans are the safe direction.
// ============================================

const crypto = require('crypto');
const googleDrive = require('./googleDrive');
const brandAssets = require('./brandAssets');

const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3 MB decoded — well under the route's 4.25mb JSON cap

// kind → which existing asset folder the upload lands in.
const KINDS = { brandLogo: 'logos', backgroundImage: 'backgrounds' };

// Accepted formats. Sniffed from magic bytes — the declared filename/content
// type is never trusted on its own.
const MIME_BY_SIGNATURE = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/webp', ext: 'webp',
    test: (b) => b.length > 12
      && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

function isConfigured() {
  return googleDrive.isConfigured();
}

/**
 * Validate + decode one upload. Accepts a bare base64 string or a data URL.
 * Throws a user-facing message for anything that is not a supported image.
 * @returns {{ buffer: Buffer, ext: string, contentType: string }}
 */
function validateImageUpload({ dataBase64, contentType }) {
  const raw = String(dataBase64 || '');
  const b64 = raw.includes(',') && /^data:/i.test(raw) ? raw.slice(raw.indexOf(',') + 1) : raw;
  if (!b64 || b64.length < 24) {
    throw new Error('The selected file could not be read. Please choose the image again.');
  }

  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch (e) {
    throw new Error('The selected file could not be decoded. Please choose the image again.');
  }
  if (!buffer || buffer.length === 0) {
    throw new Error('The selected file is empty.');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large. The maximum size is ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`);
  }

  // Content sniffing decides — a renamed .exe or .svg script is refused even
  // if the browser reported an image type.
  const sig = MIME_BY_SIGNATURE.find((s) => s.test(buffer));
  if (!sig) {
    throw new Error('Unsupported image format. Please upload a PNG, JPG, JPEG or WebP file.');
  }
  // A browser-reported type that disagrees with the bytes is not fatal (some
  // browsers are loose), but a CONFLICTING concrete claim is refused.
  const claimed = String(contentType || '').toLowerCase();
  if (claimed && /^image\//.test(claimed) && claimed !== sig.mime) {
    throw new Error('The file content does not match its image type. Please re-export the image and try again.');
  }

  return { buffer, ext: sig.ext, contentType: sig.mime };
}

/**
 * Upload one validated image for a coupon into the matching EXISTING Drive
 * asset folder.
 * @returns {{ fileId: string, url: string }} url is the image reference the
 *   caller stores on the coupon row (/api/brand-assets/file/<fileId>).
 */
async function uploadCouponImage({ couponId, kind, brand, buffer, ext, contentType }) {
  if (!KINDS[kind]) throw new Error('Unknown image field.');
  const drive = await googleDrive.getDriveClient();
  if (!drive) {
    const err = new Error('Google Drive is not configured on the server.');
    err.code = 'DRIVE_NOT_CONFIGURED';
    throw err;
  }

  const folderIds = await brandAssets._getAssetFolderIds();
  const folderId = folderIds && folderIds[KINDS[kind]];
  if (!folderId) {
    const err = new Error(
      kind === 'brandLogo'
        ? 'The "Brand Logos" Drive folder could not be found. Verify the SaveHatke Assets folders in Google Drive.'
        : 'The "Coupon Backgrounds" Drive folder could not be found. Verify the SaveHatke Assets folders in Google Drive.',
    );
    err.code = 'DRIVE_FOLDER_NOT_FOUND';
    throw err;
  }

  // "coupon-" prefix keeps per-coupon files out of the brand-key namespace.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const unique = crypto.randomUUID();
  const who = String(brand || couponId || 'coupon')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || 'coupon';
  const filename = `coupon-${kind === 'brandLogo' ? 'logo' : 'bg'}-${who}-${stamp}-${unique}.${ext}`;

  const uploaded = await googleDrive.uploadProofScreenshot({
    buffer,
    filename,
    mimeType: contentType,
    folderId,
    description: `SaveHatke per-coupon ${kind === 'brandLogo' ? 'brand logo' : 'card background'} for coupon ${couponId || 'n/a'} uploaded on ${new Date().toISOString()}`,
    forcePrivate: true, // display goes through the authorized brand-assets proxy only
  });

  return { fileId: uploaded.fileId, url: brandAssets.fileUrl(uploaded.fileId) };
}

module.exports = {
  KINDS,
  MAX_IMAGE_BYTES,
  isConfigured,
  validateImageUpload,
  uploadCouponImage,
};
