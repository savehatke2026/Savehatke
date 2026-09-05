// ============================================
// SaveHatke — Google Drive Service
// ============================================
// Uploads coupon proof screenshots to a Google Drive folder. Files stay
// private and are only viewable through our server proxy
// (/api/proxy/drive/:fileId).
//
// Auth modes (in priority order):
//   1. OAuth user account (GOOGLE_DRIVE_REFRESH_TOKEN) — required for a
//      normal @gmail.com Drive. Service accounts have NO storage quota of
//      their own, so files must be owned by a real user.
//   2. Service account (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY)
//      — only works when GOOGLE_DRIVE_FOLDER_ID lives in a Workspace
//      Shared Drive, which supplies the quota.
//
// Env variables (.env):
//   GOOGLE_DRIVE_FOLDER_ID        — Drive folder ID for screenshots
//   GOOGLE_DRIVE_REFRESH_TOKEN    — from `node scripts/authorize-drive.js`
//   GOOGLE_DRIVE_CLIENT_ID        — optional; defaults to GOOGLE_CLIENT_ID
//   GOOGLE_DRIVE_CLIENT_SECRET    — optional; defaults to GOOGLE_CLIENT_SECRET
//   GOOGLE_DRIVE_VISIBILITY       — "private" (default) | "public"
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  — Shared Drive mode only
//   GOOGLE_PRIVATE_KEY            — Shared Drive mode only
//
// Setup checklist (one-time, OAuth mode):
//   1. Create a folder in your Drive, e.g. "SaveHatke Coupon Proofs", and
//      put its ID (from the URL) in GOOGLE_DRIVE_FOLDER_ID.
//   2. Run `node scripts/authorize-drive.js` and follow the printed steps.
//   3. Paste the returned GOOGLE_DRIVE_REFRESH_TOKEN into .env.
//   4. Restart the server.
//
// When neither mode is usable, isConfigured() returns false and callers
// fall back to Supabase Storage.
// ============================================

const { google } = require('googleapis');
const { Readable } = require('stream');
const crypto = require('crypto');

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

// Lazy singleton
let _drive = null;

function clean(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}

function isPlaceholder(value) {
  return !value || value.includes('YOUR_');
}

function getCreds() {
  const folderId = clean(process.env.GOOGLE_DRIVE_FOLDER_ID);
  const refreshToken = clean(process.env.GOOGLE_DRIVE_REFRESH_TOKEN);
  const clientId = clean(process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID);
  const clientSecret = clean(
    process.env.GOOGLE_DRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET
  );
  const email = clean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const privateKey = process.env.GOOGLE_PRIVATE_KEY || '';
  const visibility =
    clean(process.env.GOOGLE_DRIVE_VISIBILITY).toLowerCase() === 'public' ? 'public' : 'private';

  const oauthReady =
    !isPlaceholder(refreshToken) && !isPlaceholder(clientId) && !isPlaceholder(clientSecret);
  const serviceReady = !isPlaceholder(email) && !isPlaceholder(privateKey);

  const mode = oauthReady ? 'oauth' : serviceReady ? 'service-account' : 'none';
  const configured = !isPlaceholder(folderId) && mode !== 'none';

  return {
    folderId,
    refreshToken,
    clientId,
    clientSecret,
    email,
    privateKey,
    visibility,
    mode,
    configured,
  };
}

function isConfigured() {
  return getCreds().configured;
}

function getDriveClient() {
  if (_drive !== null) return _drive;
  const c = getCreds();
  if (!c.configured) {
    _drive = false; // sentinel
    return _drive;
  }
  try {
    let auth;
    if (c.mode === 'oauth') {
      auth = new google.auth.OAuth2(c.clientId, c.clientSecret);
      auth.setCredentials({ refresh_token: c.refreshToken });
    } else {
      const key = clean(c.privateKey).replace(/\\n/g, '\n');
      auth = new google.auth.JWT(c.email, null, key, DRIVE_SCOPES);
    }
    _drive = google.drive({ version: 'v3', auth });
    console.log(
      `[googleDrive] Client ready in ${c.mode} mode (folder ${c.folderId}, ${c.visibility}).` +
      (c.mode === 'service-account'
        ? ' NOTE: service accounts have no Drive quota — uploads into a personal folder will fail.' +
          ' Run `cd server && node scripts/authorize-drive.js` to switch to OAuth mode.'
        : '')
    );
  } catch (e) {
    console.error('[googleDrive] Failed to build Drive client:', e.message);
    _drive = false;
  }
  return _drive;
}

/**
 * Upload a binary buffer to a Drive folder.
 *
 * @param {{ buffer: Buffer, filename: string, mimeType: string, sellerEmail?: string,
 *           folderId?: string, description?: string, forcePrivate?: boolean }} input
 *        folderId     — overrides GOOGLE_DRIVE_FOLDER_ID for this upload.
 *        description  — replaces the default "coupon proof" description.
 *        forcePrivate — never publish the file, even when
 *                       GOOGLE_DRIVE_VISIBILITY=public. Support screenshots use
 *                       this: they are personal data and must only ever be
 *                       reachable through the authenticated proxy.
 * @returns {Promise<{ fileId: string, url: string, webViewLink: string, name: string }>}
 */
async function uploadProofScreenshot(input) {
  const {
    buffer, filename, mimeType, sellerEmail,
    folderId: folderOverride, description: descriptionOverride, forcePrivate,
  } = input || {};
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Empty file buffer.');
  }
  if (!filename) throw new Error('Missing filename.');

  const drive = getDriveClient();
  const { configured, folderId: defaultFolderId, visibility } = getCreds();
  const folderId = clean(folderOverride) || defaultFolderId;
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
  // googleapis pipes `media.body`, so it must be a stream — a raw Buffer
  // throws "part.body.pipe is not a function".
  const metadata = {
    name: safeName,
    parents: [folderId],
    description: descriptionOverride || (sellerEmail
      ? `SaveHatke coupon proof uploaded by ${sellerEmail} on ${new Date().toISOString()}`
      : `SaveHatke coupon proof uploaded on ${new Date().toISOString()}`),
  };

  let createRes;
  try {
    createRes = await drive.files.create({
      requestBody: metadata,
      media: {
        mimeType: mimeType || 'application/octet-stream',
        body: Readable.from(buffer),
      },
      fields: 'id, name, mimeType, size, webViewLink',
      supportsAllDrives: true,
    });
  } catch (e) {
    // Translate the two failures that actually happen in practice into
    // something the operator can act on, instead of a bare API message that
    // gets swallowed by the caller's Supabase fallback.
    const reason = (e.errors && e.errors[0] && e.errors[0].reason) || '';
    const mode = getCreds().mode;
    if (reason === 'storageQuotaExceeded' || /storage quota/i.test(e.message || '')) {
      const err = new Error(
        'Google Drive rejected the upload: a service account has no storage quota of its own, so it ' +
        'cannot write into a personal Drive folder. Mint a user refresh token with ' +
        '`cd server && node scripts/authorize-drive.js`, put it in GOOGLE_DRIVE_REFRESH_TOKEN, and ' +
        'restart the server (or move GOOGLE_DRIVE_FOLDER_ID into a Workspace Shared Drive).'
      );
      err.code = 'DRIVE_NO_QUOTA';
      throw err;
    }
    if (e.code === 404 || /File not found/i.test(e.message || '')) {
      const err = new Error(
        `Google Drive folder ${folderId} is not visible to the authenticated account (${mode} mode). ` +
        'Check GOOGLE_DRIVE_FOLDER_ID and make sure that account can edit the folder.'
      );
      err.code = 'DRIVE_FOLDER_NOT_FOUND';
      throw err;
    }
    throw e;
  }

  const file = createRes.data;
  if (!file || !file.id) {
    throw new Error('Drive did not return a file id.');
  }

  // Visibility: keep the file private by default (service-account-owned). For
  // 'public' mode we also publish it so anyone with the link can view — unless
  // the caller forced private, which support screenshots always do.
  if (visibility === 'public' && !forcePrivate) {
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

/**
 * Upload a support-ticket screenshot.
 *
 * Always private, always into the support folder when one is configured, and
 * always named by the server: the browser's filename is recorded as metadata on
 * the ticket but never used as the Drive name, so a crafted name cannot travel
 * anywhere. The extension comes from the sniffed content type, not the upload.
 *
 * @param {{ buffer: Buffer, ext: string, mimeType: string, ticketRef?: string,
 *           uploaderEmail?: string }} input
 */
async function uploadSupportScreenshot(input) {
  const { buffer, ext, mimeType, ticketRef, uploaderEmail } = input || {};
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const unique = crypto.randomUUID();
  const safeExt = /^\.(png|jpg|jpeg|webp)$/i.test(String(ext || '')) ? String(ext).toLowerCase() : '.png';
  const ref = String(ticketRef || 'unlinked').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);

  return uploadProofScreenshot({
    buffer,
    filename: `support-${ref}-${stamp}-${unique}${safeExt}`,
    mimeType,
    folderId: clean(process.env.GOOGLE_DRIVE_SUPPORT_FOLDER_ID) || undefined,
    description: `SaveHatke support screenshot${uploaderEmail ? ` from ${uploaderEmail}` : ''} on ${new Date().toISOString()}`,
    forcePrivate: true,
  });
}

/**
 * A seller's payout QR code.
 *
 * Kept in its own folder ("QR Code Images") and always private: this is how the
 * platform pays a person, so it is filed with the same care as a support
 * screenshot and never made link-shareable. The folder id ships as a default
 * because it is a fixed destination in this Drive, and GOOGLE_DRIVE_QR_FOLDER_ID
 * overrides it for another environment.
 *
 * @param {{ buffer: Buffer, ext?: string, mimeType?: string,
 *           sellerEmail?: string }} input
 */
const DEFAULT_QR_FOLDER_ID = '1qykqVyUtk4OFRVuoTum4_t-1ZHkhx-02';

async function uploadPayoutQrImage(input) {
  const { buffer, ext, mimeType, sellerEmail } = input || {};
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const unique = crypto.randomUUID();
  const safeExt = /^\.(png|jpg|jpeg|webp)$/i.test(String(ext || '')) ? String(ext).toLowerCase() : '.png';
  // The filename carries who it belongs to, so a folder listing is readable
  // without opening every image.
  const who = String(sellerEmail || 'seller').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);

  return uploadProofScreenshot({
    buffer,
    filename: `payout-qr-${who}-${stamp}-${unique}${safeExt}`,
    mimeType,
    folderId: clean(process.env.GOOGLE_DRIVE_QR_FOLDER_ID) || DEFAULT_QR_FOLDER_ID,
    description: `SaveHatke payout QR code${sellerEmail ? ` for ${sellerEmail}` : ''} on ${new Date().toISOString()}`,
    forcePrivate: true,
  });
}

module.exports = {
  isConfigured,
  uploadProofScreenshot,
  uploadSupportScreenshot,
  uploadPayoutQrImage,
  downloadFile,
  getFileMeta,
  // Exposed for diagnostics
  _getCreds: getCreds,
};
