// ============================================
// SaveHatke — Dedicated Payment Mailbox (Gmail)
// ============================================
// A SEPARATE inbox from the support mailbox (services/gmailService.js).
//
//   * Support mailbox  → support.savehatke@gmail.com   (GMAIL_REFRESH_TOKEN)
//   * Payment mailbox  → rupayandas2024@gmail.com        (PAYMENT_GMAIL_REFRESH_TOKEN)
//
// The payment verifier (services/paymentVerifier.js) reads THIS mailbox for
// UPI / bank credit notifications. Keeping it separate means:
//   - support agents never see (or accidentally trash) a payment email, and
//   - the payment inbox can be the account the bank/UPI actually notifies,
//     independent of who answers support mail.
//
// It reuses the read-only message helpers on gmailService (listMessages,
// getMessageFull) — those take a `gmail` client as their first argument, so no
// duplication is needed. Only the OAuth client + refresh-token resolution is
// payment-specific and lives here.
//
// The refresh token is resolved in the same order the support store uses:
//   1. process.env.PAYMENT_GMAIL_REFRESH_TOKEN  ← permanent / production
//   2. local token file (.payment-gmail-token.json, AES-256-GCM encrypted)
//   3. in-memory cache                          ← this process only
//
// Credentials never reach the browser. Email bodies are always fetched live and
// are never stored.
// ============================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { google } = require('googleapis');
const { encryptSecret, decryptSecret } = require('./gmailCrypto');

// Same scope set as the support mailbox: modify (read/labels/trash) + identity
// (only used to display / verify the connected account address).
const PAYMENT_GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
];

// ── OAuth client configuration ──────────────────────────────────────────────
// A payment-specific OAuth client is preferred, but the shared Gmail / Google
// client works too — the account that is authorized is what actually decides
// which inbox is read, not which OAuth client mints the token.
function getClientId() {
  return (
    process.env.PAYMENT_GMAIL_CLIENT_ID ||
    process.env.GMAIL_CLIENT_ID ||
    process.env.GOOGLE_CLIENT_ID
  );
}

function getClientSecret() {
  return (
    process.env.PAYMENT_GMAIL_CLIENT_SECRET ||
    process.env.GMAIL_CLIENT_SECRET ||
    process.env.GOOGLE_CLIENT_SECRET
  );
}

function isOAuthConfigured() {
  return !!(getClientId() && getClientSecret());
}

function getRedirectUri(requestBase) {
  const base = (requestBase || process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const override = String(
    process.env.PAYMENT_GMAIL_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI || ''
  ).trim();

  if (override) {
    if (!base) return override;
    try {
      if (new URL(override).origin === new URL(base).origin) return override;
    } catch (e) { /* malformed override — fall through */ }
  }
  return `${(base || 'http://localhost:3000')}/api/admin/payment-mailbox/callback`;
}

function getOAuth2Client(requestBase) {
  return new google.auth.OAuth2(getClientId(), getClientSecret(), getRedirectUri(requestBase));
}

function buildAuthUrl(state, requestBase) {
  const client = getOAuth2Client(requestBase);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token
    scope: PAYMENT_GMAIL_SCOPES,
    state,
    include_granted_scopes: false,
  });
}

async function exchangeCode(code, requestBase) {
  const client = getOAuth2Client(requestBase);
  const { tokens } = await client.getToken(code);
  return tokens;
}

// ── Token store (self-contained, mirrors gmailTokenStore) ───────────────────

let memory = { refresh_token: '', gmail_email: '', connected_at: null };
let fileCache = null;
let fileCacheRead = false;

function candidatePaths() {
  const list = [];
  if (process.env.PAYMENT_GMAIL_TOKEN_FILE) list.push(process.env.PAYMENT_GMAIL_TOKEN_FILE);
  list.push(path.join(__dirname, '..', '.payment-gmail-token.json'));
  list.push(path.join(os.tmpdir(), 'savehatke-payment-gmail-token.json'));
  return list;
}

function readTokenFile() {
  if (fileCacheRead) return fileCache;
  fileCacheRead = true;
  for (const p of candidatePaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && parsed.encrypted_refresh_token) {
        fileCache = { ...parsed, __path: p };
        return fileCache;
      }
    } catch (e) {
      console.warn('[paymentMailbox] token file read notice:', e.message);
    }
  }
  fileCache = null;
  return null;
}

function writeTokenFile(record) {
  for (const p of candidatePaths()) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
      fileCache = { ...record, __path: p };
      fileCacheRead = true;
      return p;
    } catch (e) {
      continue; // read-only FS — try the next candidate
    }
  }
  return null;
}

function envRefreshToken() {
  const raw = String(process.env.PAYMENT_GMAIL_REFRESH_TOKEN || '').trim();
  if (!raw) return '';
  if (raw.startsWith('v1.')) return decryptSecret(raw) || '';
  return raw;
}

/** The expected/authorized payment inbox address (advisory, lower-cased). */
function expectedMailbox() {
  return String(
    process.env.PAYMENT_MAILBOX_EMAIL || process.env.PAYMENT_GMAIL_EMAIL || ''
  ).trim().toLowerCase();
}

/**
 * Current payment-mailbox connection, or null when it is not connected yet.
 * `source`: 'env' (durable) | 'file' | 'memory'.
 */
function getConnection() {
  const fromEnv = envRefreshToken();
  if (fromEnv) {
    return {
      source: 'env',
      refresh_token: fromEnv,
      gmail_email: memory.gmail_email || expectedMailbox(),
      connected_at: memory.connected_at,
      durable: true,
    };
  }

  const file = readTokenFile();
  if (file) {
    const token = decryptSecret(file.encrypted_refresh_token);
    if (token) {
      return {
        source: 'file',
        refresh_token: token,
        gmail_email: String(file.gmail_email || '').toLowerCase() || expectedMailbox(),
        connected_at: file.connected_at || null,
        durable: !String(file.__path || '').startsWith(os.tmpdir()),
        path: file.__path,
      };
    }
  }

  if (memory.refresh_token) {
    return {
      source: 'memory',
      refresh_token: memory.refresh_token,
      gmail_email: memory.gmail_email || expectedMailbox(),
      connected_at: memory.connected_at,
      durable: false,
    };
  }

  return null;
}

function isConnected() {
  return Boolean(getConnection());
}

/** Persist a freshly minted refresh token. */
function saveConnection({ refresh_token, gmail_email }) {
  const token = String(refresh_token || '');
  if (!token) throw new Error('A payment-mailbox refresh token is required.');

  memory = {
    refresh_token: token,
    gmail_email: String(gmail_email || '').toLowerCase(),
    connected_at: new Date().toISOString(),
  };

  let writtenPath = null;
  try {
    writtenPath = writeTokenFile({
      v: 1,
      gmail_email: memory.gmail_email,
      encrypted_refresh_token: encryptSecret(token),
      connected_at: memory.connected_at,
    });
  } catch (e) {
    console.warn('[paymentMailbox] token file write notice:', e.message);
  }

  if (envRefreshToken()) return { source: 'env', path: null, durable: true };
  if (writtenPath) {
    return { source: 'file', path: writtenPath, durable: !writtenPath.startsWith(os.tmpdir()) };
  }
  return { source: 'memory', path: null, durable: false };
}

function rotateRefreshToken(newToken) {
  if (!newToken) return;
  const current = getConnection();
  if (current && current.source === 'env') {
    console.warn(
      '[paymentMailbox] Google issued a rotated refresh token. Update PAYMENT_GMAIL_REFRESH_TOKEN to keep the payment mailbox connected.'
    );
    memory.refresh_token = String(newToken);
    return;
  }
  saveConnection({ refresh_token: newToken, gmail_email: current?.gmail_email || memory.gmail_email });
}

/**
 * Return an authorized Gmail API client for the dedicated payment mailbox, or
 * null when it has not been connected yet. Same return shape as
 * gmailService.getAuthorizedClient() so the verifier can use either.
 */
async function getAuthorizedClient() {
  const conn = getConnection();
  if (!conn || !conn.refresh_token) return null;

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({ refresh_token: conn.refresh_token });

  oauth2.on('tokens', (tokens) => {
    try {
      if (tokens.refresh_token && tokens.refresh_token !== conn.refresh_token) {
        rotateRefreshToken(tokens.refresh_token);
      }
    } catch (e) {
      console.warn('[paymentMailbox] token metadata update failed:', e.message);
    }
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  return { gmail, oauth2, conn };
}

module.exports = {
  PAYMENT_GMAIL_SCOPES,
  isOAuthConfigured,
  getRedirectUri,
  getOAuth2Client,
  buildAuthUrl,
  exchangeCode,
  getAuthorizedClient,
  getConnection,
  isConnected,
  saveConnection,
  rotateRefreshToken,
  expectedMailbox,
  candidatePaths,
};
