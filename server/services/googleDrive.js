// ============================================
// SaveHatke — Google Drive Service
// ============================================
// Reuses the same service account as Google Sheets to upload proof
// screenshots. Files are kept private (owned by the service account)
// and only viewable through our server proxy.
//
// Env variables (server/.env):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  — already used by Sheets
//   GOOGLE_PRIVATE_KEY            — already used by Sheets
//   GOOGLE_DRIVE_FOLDER_ID        — Drive folder ID for screenshots
//   GOOGLE_DRIVE_VISIBILITY       — "private" (default) | "public"
//
// Setup checklist (one-time):
//   1. Create a folder in Google Drive for "SaveHatke Coupon Proofs".
//   2. Share that folder with GOOGLE_SERVICE_ACCOUNT_EMAIL as Editor.
//   3. Copy the folder ID from the URL
//      (https://drive.google.com/drive/folders/<THIS_PART>)
//      and set it as GOOGLE_DRIVE_FOLDER_ID in .env.
//   4. Restart the server.
//
// When GOOGLE_DRIVE_FOLDER_ID is empty, isConfigured() returns false and
// callers should fall back to a non-Drive storage backend.
// ============================================

const { google } = require('googleapis');

// Lazy singleton state
let _drive = null;
let _initialized = false;

function getCreds() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
  const privateKey = process.env.GOOGLE_PRIVATE_KEY || '';
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || '';
  const visibility =
    (process.env.GOOGLE_DRIVE_VISIBILITY || 'private').toLowerCase() === 'public'
      ? 'public'
      : 'private';
  const configured =
    !!email &&
    !!privateKey &&
    !!folderId &&
    !email.includes('YOUR_') &&
    !privateKey.includes('YOUR_') &&
    !folderId.includes('YOUR_');
  return { email, privateKey, folderId, visibility, configured };
}

function isConfigured() {
  return getCreds().configured;
}

function getDriveClient() {
  if (_drive !== null) return _drive;
  const { configured, email, privateKey } = getCreds();
  if (!configured) {
    _drive = false; // sentinel
    return _drive;
  }
  try {
    const cleanKey = String(privateKey).replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
    const auth = new google.auth.JWT(email, null, cleanKey, [
      'https://www.googleapis.com/auth/drive.file', // per-file access; least-privilege
    ]);
    _drive = google.drive({ version: 'v3', auth });
  } catch (e) {
    console.error('[googleDrive] Failed to build Drive client:', e.message);
    _drive = false;
  }
  return _drive;
}

/**
 * Upload a binary buffer to the configured Drive folder.
 * @param {{ buffer: Buffer, filename: string, mimeType: string, sellerEmail?: string }} input
 * @returns {Promise<{ fileId: string, url: string, webViewLink: string, name: string }>}
 */
async function uploadProofScreenshot(input) {
  const { buffer, filename, mimeType, sellerEmail } = input || {};
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Empty file buffer.');
  }
  if (!filename) throw new Error('Missing filename.');

  const drive = getDriveClient();
  const { configured, folderId, visibility } = getCreds();
  if (!configured || !drive) {
    const err = new Error('Google Drive is not configured on the server.');
    err.code = 'DRIVE_NOT_CONFIGURED';
    throw err;
  }

  // Sanitize filename for Drive
  const safeName = String(filename)
    .replace(/[^a-zA-Z0-9._\- ]/g, '_')
    .slice(0, 80) || 'proof';

  // Drive requires a multipart/related body when supplying metadata + file.
  // googleapis's { requestBody, media } shorthand handles the multipart
  // upload for us — no need to build the body by hand.
  const metadata = {
    name: safeName,
    parents: [folderId],
    description: sellerEmail
      ? `SaveHatke coupon proof uploaded by ${sellerEmail} on ${new Date().toISOString()}`
      : `SaveHatke coupon proof uploaded on ${new Date().toISOString()}`,
  };

  const createRes = await drive.files.create({
    requestBody: metadata,
    media: {
      mimeType: mimeType || 'application/octet-stream',
      body: buffer, // googleapis streams this as a multipart upload
    },
    fields: 'id, name, mimeType, size, webViewLink',
    supportsAllDrives: true,
  });

  const file = createRes.data;
  if (!file || !file.id) {
    throw new Error('Drive did not return a file id.');
  }

  // Visibility: keep the file private by default (service-account-owned). For
  // 'public' mode we also publish it so anyone with the link can view.
  if (visibility === 'public') {
    try {
      await drive.permissions.create({
        fileId: file.id,
        requestBody: { role: 'reader', type: 'anyone' },
        fields: 'id',
      });
    } catch (e) {
      console.warn('[googleDrive] failed to set public permission:', e.message);
    }
  }

  // Save a `proofUrl` token we can identify later. We deliberately do NOT use
  // a public webContentLink here — even in 'public' mode, webContentLink can
  // be flaky. The proxy endpoint handles access control for both modes.
  const proofUrl = 'drive:' + file.id;

  return {
    fileId: file.id,
    url: proofUrl,
    webViewLink: file.webViewLink || '',
    name: file.name || safeName,
    mimeType: file.mimeType || mimeType,
    size: file.size ? Number(file.size) : buffer.length,
  };
}

/**
 * Stream a Drive file's binary content. Returns the response stream from
 * the Drive API (consumable via pipe()). The caller is responsible for
 * setting the appropriate Content-Type / Content-Disposition headers and
 * closing the stream on errors.
 */
async function downloadFile(fileId) {
  const drive = getDriveClient();
  if (!drive) {
    const err = new Error('Google Drive is not configured on the server.');
    err.code = 'DRIVE_NOT_CONFIGURED';
    throw err;
  }
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  return res.data; // a Node readable stream
}

/**
 * Fetch just the metadata for a Drive file.
 */
async function getFileMeta(fileId) {
  const drive = getDriveClient();
  if (!drive) {
    const err = new Error('Google Drive is not configured on the server.');
    err.code = 'DRIVE_NOT_CONFIGURED';
    throw err;
  }
  const res = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, webViewLink, createdTime',
    supportsAllDrives: true,
  });
  return res.data;
}

module.exports = {
  isConfigured,
  uploadProofScreenshot,
  downloadFile,
  getFileMeta,
  // Exposed for diagnostics
  _getCreds: getCreds,
};
