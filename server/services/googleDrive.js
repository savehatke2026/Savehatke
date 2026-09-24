// ============================================
// SaveHatke — Google Drive Service
// ============================================
// Uploads coupon proof / support / payout-QR screenshots to Google Drive.
// Files stay private and are only viewable through our server proxy
// (/api/proxy/drive/:fileId).
//
// SOURCE OF TRUTH for the Drive OAuth refresh token — Supabase
// (services/securityCredentialsStore.js), row:
//     service = 'google_drive'
//     email   = database.savehatke@gmail.com
// The token is AES-256-GCM ENCRYPTED at rest and decrypted only server-side.
// Resolution order:
//   1. Supabase security_credentials (encrypted)      ← source of truth
//   2. process.env.GOOGLE_DRIVE_REFRESH_TOKEN          ← DEPRECATED fallback
//        (kept only for a temporary migration; logged loudly, never silent)
//   3. Workspace service account (GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_PRIVATE_KEY)
//        — only works when GOOGLE_DRIVE_FOLDER_ID lives in a Shared Drive.
//
// Env variables (.env):
//   GOOGLE_DRIVE_FOLDER_ID        — Drive folder ID for screenshots
//   GOOGLE_DRIVE_REFRESH_TOKEN    — DEPRECATED: migrate into Supabase
//   GOOGLE_DRIVE_CLIENT_ID        — optional; defaults to GOOGLE_CLIENT_ID
//   GOOGLE_DRIVE_CLIENT_SECRET    — optional; defaults to GOOGLE_CLIENT_SECRET
//   GOOGLE_DRIVE_VISIBILITY       — "private" (default) | "public"
//   GOOGLE_DRIVE_EMAIL            — the connected Drive account (advisory)
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  — Shared Drive mode only
//   GOOGLE_PRIVATE_KEY            — Shared Drive mode only
//
// The upload / download / naming / folder / permission logic below is UNCHANGED
// from the env-token version — only where the refresh token comes from changed.
// ============================================

const { google } = require('googleapis');
const { Readable } = require('stream');
const crypto = require('crypto');

const store = require('./securityCredentialsStore');

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];
// Identity scopes added ONLY to the admin reconnect consent so the callback can
// confirm which Google account was authorized. Runtime uploads never need them.
const DRIVE_CONSENT_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
];

const DEFAULT_DRIVE_EMAIL = 'database.savehatke@gmail.com';

function clean(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}
function isPlaceholder(value) {
  return !value || value.includes('YOUR_');
}

/** The connected Drive account address (advisory, lower-cased). */
function driveEmail() {
  return (clean(process.env.GOOGLE_DRIVE_EMAIL) || DEFAULT_DRIVE_EMAIL).toLowerCase();
}

function getClientId() {
  return clean(process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID);
}
function getClientSecret() {
  return clean(process.env.GOOGLE_DRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET);
}

function getCreds() {
  const folderId = clean(process.env.GOOGLE_DRIVE_FOLDER_ID);
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const email = clean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const privateKey = process.env.GOOGLE_PRIVATE_KEY || '';
  const visibility =
    clean(process.env.GOOGLE_DRIVE_VISIBILITY).toLowerCase() === 'public' ? 'public' : 'private';

  const oauthClientReady = !isPlaceholder(clientId) && !isPlaceholder(clientSecret);
  const serviceReady = !isPlaceholder(email) && !isPlaceholder(privateKey);
  const envTokenPresent = !isPlaceholder(clean(process.env.GOOGLE_DRIVE_REFRESH_TOKEN));
  // "configured" means we can plausibly get a working client: an OAuth client
  // whose token lives in Supabase or the env, or a Shared-Drive service account.
  const tokenAvailable = envTokenPresent || store.isReady();
  const mode = oauthClientReady ? 'oauth' : serviceReady ? 'service-account' : 'none';
  const configured = !isPlaceholder(folderId) && ((oauthClientReady && tokenAvailable) || serviceReady);

  return { folderId, clientId, clientSecret, email, privateKey, visibility, mode, oauthClientReady, serviceReady, envTokenPresent, configured };
}

function isConfigured() {
  return getCreds().configured;
}

// ── Refresh-token resolution ─────────────────────────────────────────────────
let _warnedEnv = false;
let _lastSource = ''; // 'supabase' | 'env-deprecated' | 'service-account' | ''

function envRefreshToken() {
  const raw = clean(process.env.GOOGLE_DRIVE_REFRESH_TOKEN);
  return isPlaceholder(raw) ? '' : raw;
}

/**
 * Resolve the Drive refresh token: Supabase first, env fallback. Returns the
 * plaintext token (server-side only) or null. A row flagged
 * reauthorization_required returns null so a known-bad token is not replayed.
 */
async function resolveRefreshToken() {
  try {
    if (store.isReady()) {
      const creds = await store.getDecryptedRefreshToken(store.SERVICES.GOOGLE_DRIVE, driveEmail());
      if (creds) {
        if (creds.status === 'reauthorization_required') { _lastSource = 'supabase-reauth'; return null; }
        if (creds.refresh_token) { _lastSource = 'supabase'; return creds.refresh_token; }
      }
    }
  } catch (e) {
    console.warn('[googleDrive] Supabase credential lookup notice:', e.message);
  }
  const env = envRefreshToken();
  if (env) {
    if (!_warnedEnv) {
      _warnedEnv = true;
      console.warn(
        '[googleDrive] DEPRECATED: using GOOGLE_DRIVE_REFRESH_TOKEN from the environment. ' +
        'Migrate it into Supabase with `node server/scripts/migrate-google-drive-to-supabase.js`, ' +
        'then remove GOOGLE_DRIVE_REFRESH_TOKEN from the environment.'
      );
    }
    _lastSource = 'env-deprecated';
    return env;
  }
  return null;
}

/**
 * Build an authorized Drive v3 client, preferring OAuth (personal Drive with
 * quota) when a refresh token is resolvable, falling back to a Workspace
 * service account. Returns null when neither is usable. Async because the
 * OAuth token now comes from Supabase.
 */
async function getDriveClient() {
  const c = getCreds();

  if (c.oauthClientReady) {
    const token = await resolveRefreshToken();
    if (token) {
      const auth = new google.auth.OAuth2(c.clientId, c.clientSecret);
      auth.setCredentials({ refresh_token: token });
      // Best-effort activity stamp on the google_drive row.
      if (store.isReady() && _lastSource === 'supabase') {
        store.markUsed(store.SERVICES.GOOGLE_DRIVE, driveEmail()).catch(() => {});
      }
      return google.drive({ version: 'v3', auth });
    }
  }

  if (c.serviceReady) {
    try {
      const key = clean(c.privateKey).replace(/\\n/g, '\n');
      const auth = new google.auth.JWT(c.email, null, key, DRIVE_SCOPES);
      _lastSource = 'service-account';
      return google.drive({ version: 'v3', auth });
    } catch (e) {
      console.error('[googleDrive] Failed to build service-account client:', e.message);
    }
  }
  return null;
}

/** Build an OAuth Drive client from an explicit refresh token (used for the
 *  env-token fallback retry when the Supabase credential fails a live call). */
function buildClientFromToken(refreshToken) {
  const c = getCreds();
  const auth = new google.auth.OAuth2(c.clientId, c.clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth });
}
function isDriveAuthError(err) {
  const status = err?.response?.status || err?.code;
  const msg = String(
    err?.response?.data?.error_description ||
    err?.response?.data?.error ||
    err?.message ||
    ''
  ).toLowerCase();
  if (status === 401) return true;
  return /invalid_grant|token has been expired|token has been revoked|unauthorized|invalid_client|no refresh token/i.test(msg);
}

/**
 * Record a Drive failure against ONLY the google_drive row. An auth/revocation
 * error flags reauthorization_required (never retried blindly). This never
 * throws, never logs the token, and NEVER touches the payment_gmail row.
 */
async function reportDriveError(err) {
  if (!store.isReady() || _lastSource !== 'supabase') return;
  try {
    if (isDriveAuthError(err)) {
      await store.markReauthRequired(
        store.SERVICES.GOOGLE_DRIVE, driveEmail(),
        'Google Drive authorization expired or was revoked. Reconnect Google Drive.'
      );
    } else {
      const safe = String(err?.message || 'Google Drive request failed')
        .replace(/[A-Za-z0-9._-]{24,}/g, '[redacted]').slice(0, 200);
      await store.markError(store.SERVICES.GOOGLE_DRIVE, driveEmail(), safe);
    }
  } catch (e) {
    console.warn('[googleDrive] could not record Drive error:', e.message);
  }
}

/** Mark the Drive connection proven-good (clears a stale error). Best-effort. */
async function reportVerified() {
  if (store.isReady() && _lastSource === 'supabase') {
    try { await store.markVerified(store.SERVICES.GOOGLE_DRIVE, driveEmail()); } catch (e) { /* best effort */ }
  }
}

/**
 * Upload a binary buffer to a Drive folder.
 * (Naming / folder / visibility / permission behavior is UNCHANGED.)
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

  const drive = await getDriveClient();
  const { configured, folderId: defaultFolderId, visibility } = getCreds();
  const folderId = clean(folderOverride) || defaultFolderId;
  if (!configured || !drive) {
    const err = new Error('Google Drive is not configured on the server.');
    err.code = 'DRIVE_NOT_CONFIGURED';
    throw err;
  }
  const primarySource = _lastSource;

  const safeName = String(filename)
    .replace(/[^a-zA-Z0-9._\- ]/g, '_')
    .slice(0, 80) || 'proof';

  const metadata = {
    name: safeName,
    parents: [folderId],
    description: descriptionOverride || (sellerEmail
      ? `SaveHatke coupon proof uploaded by ${sellerEmail} on ${new Date().toISOString()}`
      : `SaveHatke coupon proof uploaded on ${new Date().toISOString()}`),
  };

  const doCreate = (driveClient) => driveClient.files.create({
    requestBody: metadata,
    media: {
      mimeType: mimeType || 'application/octet-stream',
      body: Readable.from(buffer),
    },
    fields: 'id, name, mimeType, size, webViewLink',
    supportsAllDrives: true,
  });

  // Translate the two failures that actually happen in practice into something
  // the operator can act on, instead of a bare API message the caller swallows.
  const translate = (e) => {
    const reason = (e.errors && e.errors[0] && e.errors[0].reason) || '';
    const mode = getCreds().mode;
    if (reason === 'storageQuotaExceeded' || /storage quota/i.test(e.message || '')) {
      const err = new Error(
        'Google Drive rejected the upload: a service account has no storage quota of its own, so it ' +
        'cannot write into a personal Drive folder. Reconnect Google Drive from the admin Security ' +
        'section (or move GOOGLE_DRIVE_FOLDER_ID into a Workspace Shared Drive).'
      );
      err.code = 'DRIVE_NO_QUOTA';
      return err;
    }
    if (e.code === 404 || /File not found/i.test(e.message || '')) {
      const err = new Error(
        `Google Drive folder ${folderId} is not visible to the authenticated account (${mode} mode). ` +
        'Check GOOGLE_DRIVE_FOLDER_ID and make sure that account can edit the folder.'
      );
      err.code = 'DRIVE_FOLDER_NOT_FOUND';
      return err;
    }
    return e;
  };

  // A create failure is "recoverable" via the legacy env token when it looks
  // like the Supabase credential is bad (revoked/expired) OR authorized the
  // wrong Google account (folder invisible / no permission). This keeps uploads
  // working even if an admin reconnect stored a bad Drive credential — the
  // known-good GOOGLE_DRIVE_REFRESH_TOKEN (while still present) is used as a
  // one-time fallback, and the google_drive row is flagged for attention.
  const isRecoverable = (e) => {
    const msg = String(e && e.message || '').toLowerCase();
    return isDriveAuthError(e) || e?.code === 404 || /file not found|insufficient permission|permission|storagequota/i.test(msg);
  };

  let createRes;
  try {
    createRes = await doCreate(drive);
  } catch (e) {
    const envTok = envRefreshToken();
    if (primarySource === 'supabase' && envTok && isRecoverable(e)) {
      // Flag the Supabase row so the admin sees it needs a (correct) reconnect.
      try { await reportDriveError(e); } catch (_) {}
      try {
        console.warn('[googleDrive] Supabase Drive credential failed the upload; falling back to GOOGLE_DRIVE_REFRESH_TOKEN for this request.');
        const envDrive = buildClientFromToken(envTok);
        _lastSource = 'env-deprecated';
        createRes = await doCreate(envDrive);
      } catch (e2) {
        throw translate(e2);
      }
    } else {
      if (isDriveAuthError(e)) { try { await reportDriveError(e); } catch (_) {} }
      throw translate(e);
    }
  }

  const file = createRes.data;
  if (!file || !file.id) {
    throw new Error('Drive did not return a file id.');
  }

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

  // A successful write proves the token is good — clear any stale error flag.
  reportVerified().catch(() => {});

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

async function downloadFile(fileId) {
  const drive = await getDriveClient();
  if (!drive) {
    const err = new Error('Google Drive is not configured on the server.');
    err.code = 'DRIVE_NOT_CONFIGURED';
    throw err;
  }
  try {
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    return res.data;
  } catch (e) {
    if (isDriveAuthError(e)) { try { await reportDriveError(e); } catch (_) {} }
    throw e;
  }
}

async function getFileMeta(fileId) {
  const drive = await getDriveClient();
  if (!drive) {
    const err = new Error('Google Drive is not configured on the server.');
    err.code = 'DRIVE_NOT_CONFIGURED';
    throw err;
  }
  try {
    const res = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, size, webViewLink, createdTime',
      supportsAllDrives: true,
    });
    return res.data;
  } catch (e) {
    if (isDriveAuthError(e)) { try { await reportDriveError(e); } catch (_) {} }
    throw e;
  }
}

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

const DEFAULT_QR_FOLDER_ID = '1qykqVyUtk4OFRVuoTum4_t-1ZHkhx-02';

async function uploadPayoutQrImage(input) {
  const { buffer, ext, mimeType, sellerEmail } = input || {};
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const unique = crypto.randomUUID();
  const safeExt = /^\.(png|jpg|jpeg|webp)$/i.test(String(ext || '')) ? String(ext).toLowerCase() : '.png';
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

const DEFAULT_COUPON_PROOF_FOLDER_ID = '1mjodbeSPtbzZHUxr6o9w2m6H95aSIyyH';

async function uploadCouponProofScreenshot(input) {
  const { buffer, ext, mimeType, sellerEmail } = input || {};
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const unique = crypto.randomUUID();
  const safeExt = /^\.(png|jpg|jpeg|webp)$/i.test(String(ext || '')) ? String(ext).toLowerCase() : '.png';
  const who = String(sellerEmail || 'seller').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);

  return uploadProofScreenshot({
    buffer,
    filename: `coupon-proof-${who}-${stamp}-${unique}${safeExt}`,
    mimeType,
    folderId: clean(process.env.GOOGLE_DRIVE_COUPON_PROOF_FOLDER_ID) || DEFAULT_COUPON_PROOF_FOLDER_ID,
    description: `SaveHatke coupon proof${sellerEmail ? ` from ${sellerEmail}` : ''} on ${new Date().toISOString()}`,
    forcePrivate: true,
  });
}

/**
 * Refresh the OAuth access token purely to keep the refresh token alive (Google
 * invalidates a refresh token unused for six months). Now sources the token
 * from Supabase (env fallback). Touches no file.
 */
async function keepAlive() {
  const c = getCreds();
  if (!c.configured) {
    return { ok: false, configured: false, mode: c.mode, reason: 'Google Drive is not configured — no refresh token to keep alive.' };
  }

  const token = c.oauthClientReady ? await resolveRefreshToken() : null;
  if (!token) {
    // Either service-account (no refresh token) or no resolvable OAuth token.
    if (c.serviceReady && !c.oauthClientReady) {
      return { ok: true, configured: true, mode: 'service-account', skipped: 'service-account' };
    }
    return { ok: false, configured: true, mode: c.mode, reason: 'No Drive refresh token available (reconnect Google Drive).', code: 'no_token' };
  }

  try {
    const auth = new google.auth.OAuth2(c.clientId, c.clientSecret);
    auth.setCredentials({ refresh_token: token });
    const res = await auth.getAccessToken();
    const accessToken = typeof res === 'string' ? res : res && res.token;
    if (!accessToken) {
      return { ok: false, configured: true, mode: 'oauth', reason: 'Google returned no access token.' };
    }
    reportVerified().catch(() => {});
    return { ok: true, configured: true, mode: 'oauth', refreshed: true };
  } catch (err) {
    if (isDriveAuthError(err)) { try { await reportDriveError(err); } catch (_) {} }
    const data = (err && err.response && err.response.data) || {};
    return {
      ok: false,
      configured: true,
      mode: 'oauth',
      reason: data.error_description || data.error || (err && err.message) || 'Token refresh failed.',
      code: data.error || (err && err.code) || '',
    };
  }
}

// ── Admin reconnect OAuth helpers (reuse the shared registered callback) ─────
function isOAuthConfigured() {
  return !!(getClientId() && getClientSecret());
}
function getRedirectUri(requestBase) {
  const base = (requestBase || process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const override = clean(process.env.GOOGLE_DRIVE_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI || '');
  if (override) {
    if (!base) return override;
    try { if (new URL(override).origin === new URL(base).origin) return override; } catch (e) { /* fall through */ }
  }
  return `${(base || 'http://localhost:3000')}/api/admin/gmail/callback`;
}
function getOAuth2Client(requestBase) {
  return new google.auth.OAuth2(getClientId(), getClientSecret(), getRedirectUri(requestBase));
}
function buildAuthUrl(state, requestBase) {
  const client = getOAuth2Client(requestBase);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: DRIVE_CONSENT_SCOPES,
    state,
    include_granted_scopes: false,
  });
}
async function exchangeCode(code, requestBase) {
  const client = getOAuth2Client(requestBase);
  const { tokens } = await client.getToken(code);
  return tokens;
}
function expectedDriveEmail() {
  return driveEmail();
}
/**
 * Persist a fresh Drive refresh token to Supabase (service = google_drive).
 * estimated_expires_at is intentionally NULL — the Drive credential has no
 * Testing-mode countdown; it relies on real invalid_grant detection instead.
 */
async function saveConnection({ refresh_token, drive_email }) {
  const token = String(refresh_token || '');
  if (!token) throw new Error('A Google Drive refresh token is required.');
  const email = String(drive_email || '').toLowerCase() || driveEmail();
  await store.upsertCredential({
    service: store.SERVICES.GOOGLE_DRIVE,
    email,
    refresh_token: token,
    estimatedExpiresAt: null,
  });
  _lastSource = 'supabase';
  return { source: 'supabase', email };
}

module.exports = {
  isConfigured,
  uploadProofScreenshot,
  uploadSupportScreenshot,
  uploadCouponProofScreenshot,
  uploadPayoutQrImage,
  downloadFile,
  getFileMeta,
  keepAlive,
  // OAuth reconnect + credential helpers
  isOAuthConfigured,
  getOAuth2Client,
  getRedirectUri,
  buildAuthUrl,
  exchangeCode,
  saveConnection,
  expectedDriveEmail,
  reportDriveError,
  reportVerified,
  isDriveAuthError,
  DRIVE_SCOPES,
  DRIVE_CONSENT_SCOPES,
  // Exposed for diagnostics
  _getCreds: getCreds,
};
