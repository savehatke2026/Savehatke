// ============================================
// SaveHatke — Dedicated Payment Mailbox (Gmail)
// ============================================
// A SEPARATE inbox from the support mailbox (services/gmailService.js).
//
//   * Support mailbox  → support.savehatke@gmail.com   (GMAIL_REFRESH_TOKEN env)
//   * Payment mailbox  → rupayandas2024@gmail.com        (Supabase-backed)
//
// The payment verifier (services/paymentVerifier.js) reads THIS mailbox for
// UPI / bank credit notifications. Keeping it separate means:
//   - support agents never see (or accidentally trash) a payment email, and
//   - the payment inbox can be the account the bank/UPI actually notifies,
//     independent of who answers support mail.
//
// SOURCE OF TRUTH — Supabase (services/paymentMailboxStore.js):
// the payment Gmail address, its AES-256-GCM ENCRYPTED refresh token, the
// connection status, and the connect/verify/use/error timestamps all live in
// the security_credentials table (renamed from payment_mailbox_credentials).
// The refresh token is resolved in this order:
//   1. Supabase security_credentials (encrypted)         ← source of truth
//   2. process.env.PAYMENT_GMAIL_REFRESH_TOKEN            ← DEPRECATED fallback
//        (kept only for a temporary migration; logged loudly, never silent)
//   3. local token file (.payment-gmail-token.json)      ← dev convenience
//   4. in-memory cache                                    ← this process only
//
// It reuses the read-only message helpers on gmailService (listMessages,
// getMessageFull). Credentials never reach the browser. Email bodies are always
// fetched live and are never stored.
// ============================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { google } = require('googleapis');
const { encryptSecret, decryptSecret } = require('./gmailCrypto');
const store = require('./paymentMailboxStore');

// The payment verifier ONLY reads incoming payment emails (paymentVerifier.js
// calls gmailService.listMessages + getMessageFull — both read-only, and it
// never labels, marks-read, or trashes a payment message). So the payment
// mailbox is granted the LEAST-PRIVILEGE read-only Gmail scope, plus identity
// (used only to display / verify the connected account address). This is
// narrower than the support mailbox, which keeps gmail.modify for its inbox UI.
const PAYMENT_GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
];

// ── OAuth client configuration ──────────────────────────────────────────────
// A payment-specific OAuth client is preferred, but the shared Gmail / Google
// client works too — the account that is authorized is what actually decides
// which inbox is read, not which OAuth client mints the token. No NEW Google
// OAuth client is created here.
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

// Reuse the SAME redirect URI the support mailbox already registers in Google
// Cloud Console — /api/admin/gmail/callback — so no new redirect URI has to be
// registered and no new OAuth client is needed. The payment flow is told apart
// from the support flow inside that callback by a `flow: 'payment'` claim in
// the signed OAuth state.
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
  return `${(base || 'http://localhost:3000')}/api/admin/gmail/callback`;
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

// ── Local dev token file + memory (fallback only) ───────────────────────────
let memory = { refresh_token: '', gmail_email: '', connected_at: null };
let fileCache = null;
let fileCacheRead = false;
let warnedEnvFallback = false;

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
 * Supabase is the source of truth; env/file/memory are fallbacks.
 * `source`: 'supabase' | 'env-deprecated' | 'file' | 'memory'.
 */
async function getConnection() {
  // 1) Supabase — source of truth.
  try {
    if (store.isReady()) {
      const creds = await store.getDecryptedRefreshToken(expectedMailbox() || undefined);
      if (creds && creds.refresh_token) {
        return {
          source: 'supabase',
          refresh_token: creds.refresh_token,
          gmail_email: String(creds.email || '').toLowerCase() || expectedMailbox(),
          status: creds.status || 'active',
          durable: true,
        };
      }
    }
  } catch (e) {
    console.warn('[paymentMailbox] Supabase credential lookup notice:', e.message);
  }

  // 2) DEPRECATED env fallback — kept for a temporary migration only. Logged
  //    loudly (never silent) so an operator knows to migrate to Supabase.
  const fromEnv = envRefreshToken();
  if (fromEnv) {
    if (!warnedEnvFallback) {
      warnedEnvFallback = true;
      console.warn(
        '[paymentMailbox] DEPRECATED: using PAYMENT_GMAIL_REFRESH_TOKEN from the environment. ' +
        'Migrate it into Supabase with `node server/scripts/migrate-payment-gmail-to-supabase.js`, ' +
        'then remove PAYMENT_GMAIL_REFRESH_TOKEN from the environment.'
      );
    }
    return {
      source: 'env-deprecated',
      refresh_token: fromEnv,
      gmail_email: memory.gmail_email || expectedMailbox(),
      status: 'active',
      durable: true,
    };
  }

  // 3) Local dev token file.
  const file = readTokenFile();
  if (file) {
    const token = decryptSecret(file.encrypted_refresh_token);
    if (token) {
      return {
        source: 'file',
        refresh_token: token,
        gmail_email: String(file.gmail_email || '').toLowerCase() || expectedMailbox(),
        status: 'active',
        durable: !String(file.__path || '').startsWith(os.tmpdir()),
        path: file.__path,
      };
    }
  }

  // 4) In-memory (this process only).
  if (memory.refresh_token) {
    return {
      source: 'memory',
      refresh_token: memory.refresh_token,
      gmail_email: memory.gmail_email || expectedMailbox(),
      status: 'active',
      durable: false,
    };
  }

  return null;
}

async function isConnected() {
  return Boolean(await getConnection());
}

/**
 * Persist a freshly minted refresh token. Supabase is the source of truth: the
 * token is encrypted and UPSERTed there. When Supabase is unavailable (e.g.
 * local dev without it) the encrypted token file is used as a fallback so the
 * dev flow still works. Returns { source, email } describing where it landed.
 */
async function saveConnection({ refresh_token, gmail_email }) {
  const token = String(refresh_token || '');
  if (!token) throw new Error('A payment-mailbox refresh token is required.');
  const email = String(gmail_email || '').toLowerCase() || expectedMailbox();

  memory = { refresh_token: token, gmail_email: email, connected_at: new Date().toISOString() };

  // Preferred: Supabase.
  if (store.isReady()) {
    try {
      await store.upsertCredential({ email, refresh_token: token });
      return { source: 'supabase', email };
    } catch (e) {
      // Never include the token in the error surfaced upward.
      console.warn('[paymentMailbox] Supabase upsert failed, falling back to token file:', e.message);
    }
  }

  // Fallback: encrypted local token file (dev / Supabase-less deploy).
  let writtenPath = null;
  try {
    writtenPath = writeTokenFile({
      v: 1,
      gmail_email: email,
      encrypted_refresh_token: encryptSecret(token),
      connected_at: memory.connected_at,
    });
  } catch (e) {
    console.warn('[paymentMailbox] token file write notice:', e.message);
  }
  if (writtenPath) {
    return { source: 'file', email, path: writtenPath, durable: !writtenPath.startsWith(os.tmpdir()) };
  }
  return { source: 'memory', email, durable: false };
}

/** Persist a rotated refresh token issued by Google during a refresh. */
async function rotateRefreshToken(newToken, email) {
  if (!newToken) return;
  try {
    await saveConnection({ refresh_token: newToken, gmail_email: email || memory.gmail_email });
  } catch (e) {
    console.warn('[paymentMailbox] refresh-token rotation notice:', e.message);
  }
}

// ── Error classification ────────────────────────────────────────────────────
/**
 * True when the error is a clear Google authorization/revocation failure
 * (invalid_grant, revoked token, unauthorized). These must stop Gmail-based
 * verification gracefully and flag the connection for re-authorization — they
 * must never be retried forever.
 */
function isAuthError(err) {
  const status = err?.response?.status || err?.code;
  const msg = String(
    err?.response?.data?.error_description ||
    err?.response?.data?.error ||
    err?.message ||
    ''
  ).toLowerCase();
  if (status === 401) return true;
  return /invalid_grant|token has been expired|token has been revoked|unauthorized|invalid_client|no refresh token|no access|reauth/i.test(msg);
}

/**
 * Record the outcome of a Gmail operation against the Supabase row.
 * On an auth error, flag the connection as reauthorization_required with a
 * SAFE, credential-free message. Other errors are recorded as 'error'. This
 * never throws and never logs the token.
 */
async function reportGmailError(err, email) {
  const addr = email || (await currentEmail());
  if (!store.isReady()) return;
  try {
    if (isAuthError(err)) {
      await store.markReauthRequired(
        addr,
        'Payment Gmail authorization expired or was revoked. Reconnect Gmail.'
      );
    } else {
      const safe = String(err?.message || 'Gmail request failed').replace(/[A-Za-z0-9._-]{24,}/g, '[redacted]').slice(0, 200);
      await store.markError(addr, safe);
    }
  } catch (e) {
    console.warn('[paymentMailbox] could not record Gmail error:', e.message);
  }
}

/** Mark the current connection as proven-good (clears a stale error). */
async function reportVerified(email) {
  const addr = email || (await currentEmail());
  if (store.isReady()) {
    try { await store.markVerified(addr); } catch (e) { /* best effort */ }
  }
}

/** Best-effort resolve of the connected mailbox address for status marking. */
async function currentEmail() {
  try {
    const conn = await getConnection();
    return conn?.gmail_email || expectedMailbox();
  } catch (e) {
    return expectedMailbox();
  }
}

/**
 * Return an authorized Gmail API client for the dedicated payment mailbox, or
 * null when it has not been connected yet. Same return shape as
 * gmailService.getAuthorizedClient() so the verifier can use either.
 */
async function getAuthorizedClient() {
  const conn = await getConnection();
  if (!conn || !conn.refresh_token) return null;

  // A connection explicitly flagged for re-authorization must not be used —
  // the token is known-bad, so opening it would just replay invalid_grant.
  if (conn.status === 'reauthorization_required') return null;

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({ refresh_token: conn.refresh_token });

  oauth2.on('tokens', (tokens) => {
    try {
      if (tokens.refresh_token && tokens.refresh_token !== conn.refresh_token) {
        rotateRefreshToken(tokens.refresh_token, conn.gmail_email);
      }
    } catch (e) {
      console.warn('[paymentMailbox] token metadata update failed:', e.message);
    }
  });

  // Stamp last_used_at (best-effort) so the admin panel shows recent activity.
  if (store.isReady() && conn.source === 'supabase') {
    store.markUsed(conn.gmail_email).catch(() => {});
  }

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
  isAuthError,
  reportGmailError,
  reportVerified,
  expectedMailbox,
  candidatePaths,
};
