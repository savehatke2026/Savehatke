// ============================================
// SaveHatke — Support Mailbox Token Store
// ============================================
// The Support Mailbox is a SINGLE shared mailbox (support.savehatke@gmail.com),
// not a per-admin connection, so it does not need a per-user database model.
//
// The only thing that must persist is the Gmail OAuth **refresh token**.
// It is resolved in this order:
//
//   1. Supabase security_credentials, service='support_gmail' (AES-256-GCM
//      encrypted, via services/supportMailboxStore) ← permanent source of truth
//   2. process.env.GMAIL_REFRESH_TOKEN   ← DEPRECATED migration fallback
//   3. local token file (see tokenFilePath) ← written by the OAuth callback in dev
//   4. in-memory cache                    ← survives only until the process restarts
//
// Email bodies are NEVER stored anywhere; they are always fetched live from the
// Gmail API. The refresh token is stored AES-256-GCM encrypted — in Supabase
// (supportMailboxStore) and in the local token file (gmailCrypto). In the env
// var it may be either the raw Google token ("1//...") or an encrypted
// "v1.<iv>.<tag>.<data>" blob.
//
// Sync metadata that is NOT a credential (history_id, watch_expiration,
// watch_push_token, access_token_expires_at) stays in the in-memory store and
// the local token file — it is ephemeral sync state, never a secret.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { encryptSecret, decryptSecret } = require('./gmailCrypto');
const store = require('./supportMailboxStore');

// ── In-memory state (single shared mailbox) ─────────────────────────────────
let memory = {
  refresh_token: '',
  gmail_email: '',
  connected_at: null,
  history_id: '',
  watch_expiration: null,
  watch_push_token: '',
  access_token_expires_at: null,
};

let fileCache = null;      // parsed token-file contents
let fileCacheRead = false; // avoid re-reading a missing file on every request
let warnedEnvFallback = false;

// ── Token file location ────────────────────────────────────────────────────
function candidatePaths() {
  const list = [];
  if (process.env.GMAIL_TOKEN_FILE) list.push(process.env.GMAIL_TOKEN_FILE);
  // Default: alongside the server code (dev / self-hosted).
  list.push(path.join(__dirname, '..', '.gmail-token.json'));
  // Serverless fallback: only /tmp is writable on Vercel. Ephemeral, but it
  // keeps the mailbox usable until the token is stored in Supabase.
  list.push(path.join(os.tmpdir(), 'savehatke-gmail-token.json'));
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
      console.warn('Gmail token file read notice:', e.message);
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
      // Read-only filesystem (serverless) — try the next candidate.
      continue;
    }
  }
  return null;
}

function removeTokenFile() {
  let removed = false;
  for (const p of candidatePaths()) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed = true;
      }
    } catch (e) {
      console.warn('Gmail token file remove notice:', e.message);
    }
  }
  fileCache = null;
  fileCacheRead = true;
  return removed;
}

// ── Deprecated env fallback ────────────────────────────────────────────────
function envRefreshToken() {
  const raw = String(process.env.GMAIL_REFRESH_TOKEN || '').trim();
  if (!raw) return '';
  // Accept both an encrypted blob and the raw Google refresh token.
  if (raw.startsWith('v1.')) return decryptSecret(raw) || '';
  return raw;
}

function envMailbox() {
  return String(
    process.env.GMAIL_SUPPORT_EMAIL || process.env.SUPPORT_EMAIL || ''
  ).trim().toLowerCase();
}

// Merge the ephemeral sync metadata (history/watch state) onto any resolved
// connection. Metadata is never a credential and never leaves the server.
function withMeta(conn) {
  return {
    ...conn,
    history_id: memory.history_id || conn.history_id || '',
    watch_expiration: memory.watch_expiration || conn.watch_expiration || null,
    watch_push_token: memory.watch_push_token || conn.watch_push_token || '',
    access_token_expires_at: memory.access_token_expires_at || conn.access_token_expires_at || null,
  };
}

/**
 * Current mailbox connection, or null when the mailbox is not connected yet.
 * Supabase is the source of truth; env/file/memory are fallbacks.
 * `source` tells the admin panel how durable the token is:
 *   'supabase'       — permanent (encrypted in Supabase, survives redeploys)
 *   'env-deprecated' — legacy env var; migrate to Supabase
 *   'file'           — persisted on this server's disk
 *   'memory'         — this process only; must be stored in Supabase
 */
async function getConnection() {
  // 1) Supabase — source of truth.
  try {
    if (store.isReady()) {
      const creds = await store.getDecryptedRefreshToken(envMailbox() || undefined);
      if (creds && creds.refresh_token) {
        return withMeta({
          source: 'supabase',
          refresh_token: creds.refresh_token,
          gmail_email: String(creds.email || '').toLowerCase() || memory.gmail_email || envMailbox(),
          status: creds.status || 'active',
          connected_at: creds.connectedAt || memory.connected_at,
          durable: true,
        });
      }
    }
  } catch (e) {
    console.warn('[gmailTokenStore] Supabase credential lookup notice:', e.message);
  }

  // 2) DEPRECATED env fallback — kept for a temporary migration only. Logged
  //    loudly (never silent) so an operator knows to migrate to Supabase.
  const fromEnv = envRefreshToken();
  if (fromEnv) {
    if (!warnedEnvFallback) {
      warnedEnvFallback = true;
      console.warn(
        '[gmailTokenStore] DEPRECATED: using GMAIL_REFRESH_TOKEN from the environment. ' +
        'Migrate it into Supabase with `node server/scripts/migrate-support-gmail-to-supabase.js`, ' +
        'then remove GMAIL_REFRESH_TOKEN from the environment.'
      );
    }
    return withMeta({
      source: 'env-deprecated',
      refresh_token: fromEnv,
      gmail_email: memory.gmail_email || envMailbox(),
      connected_at: memory.connected_at,
      durable: true,
    });
  }

  // 3) Local dev token file.
  const file = readTokenFile();
  if (file) {
    const token = decryptSecret(file.encrypted_refresh_token);
    if (token) {
      return withMeta({
        source: 'file',
        refresh_token: token,
        gmail_email: String(file.gmail_email || '').toLowerCase(),
        connected_at: file.connected_at || null,
        durable: !String(file.__path || '').startsWith(os.tmpdir()),
        path: file.__path,
      });
    }
  }

  // 4) In-memory (this process only).
  if (memory.refresh_token) {
    return withMeta({
      source: 'memory',
      refresh_token: memory.refresh_token,
      gmail_email: memory.gmail_email,
      connected_at: memory.connected_at,
      durable: false,
    });
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
 * dev flow still works. Returns { source, email, durable } describing where it
 * actually landed.
 */
async function saveConnection({ refresh_token, gmail_email, history_id }) {
  const token = String(refresh_token || '');
  if (!token) throw new Error('A Gmail refresh token is required.');
  const email = String(gmail_email || '').toLowerCase() || envMailbox();

  memory = {
    ...memory,
    refresh_token: token,
    gmail_email: email || memory.gmail_email,
    connected_at: new Date().toISOString(),
    history_id: String(history_id || memory.history_id || ''),
  };

  // Preferred: Supabase (encrypted at rest, survives redeploys).
  if (store.isReady()) {
    try {
      await store.saveSupportMailboxRefreshToken({ email, refresh_token: token });
      return { source: 'supabase', email, durable: true };
    } catch (e) {
      // Never include the token in the error surfaced or logged.
      console.warn('[gmailTokenStore] Supabase upsert failed, falling back to token file:', e.message);
    }
  }

  // Fallback: encrypted local token file (dev / Supabase-less deploy).
  // encryptSecret throws when GMAIL_TOKEN_ENCRYPTION_KEY is missing — in that
  // case keep it in memory only rather than writing a plaintext token to disk.
  let writtenPath = null;
  try {
    writtenPath = writeTokenFile({
      v: 1,
      gmail_email: memory.gmail_email,
      encrypted_refresh_token: encryptSecret(token),
      connected_at: memory.connected_at,
      history_id: memory.history_id,
    });
  } catch (e) {
    console.warn('Gmail token file write notice:', e.message);
  }

  if (writtenPath) {
    return {
      source: 'file',
      email,
      path: writtenPath,
      durable: !writtenPath.startsWith(os.tmpdir()),
    };
  }
  return { source: 'memory', email, durable: false };
}

function updateMeta(patchObj = {}) {
  const allowed = ['history_id', 'watch_expiration', 'watch_push_token', 'access_token_expires_at', 'gmail_email'];
  for (const key of allowed) {
    if (patchObj[key] !== undefined) memory[key] = patchObj[key];
  }
  // Keep the token file's sync metadata roughly in step (best-effort only).
  const file = readTokenFile();
  if (file && file.__path) {
    try {
      const next = { ...file };
      delete next.__path;
      for (const key of allowed) {
        if (patchObj[key] !== undefined) next[key] = patchObj[key];
      }
      fs.writeFileSync(file.__path, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      fileCache = { ...next, __path: file.__path };
    } catch (e) { /* read-only FS — memory copy is enough */ }
  }
  return memory;
}

/**
 * Rotate the stored refresh token (Google occasionally issues a new one during
 * a token refresh — never on a plain access-token refresh). Supabase is updated
 * in place; the env var cannot be rewritten at runtime, so that case only
 * updates memory and asks the operator to migrate.
 */
async function rotateRefreshToken(newToken) {
  if (!newToken) return;
  let current = null;
  try { current = await getConnection(); } catch (e) { /* resolve best-effort */ }

  if (current && current.source === 'supabase') {
    try {
      await store.saveSupportMailboxRefreshToken({
        email: current.gmail_email,
        refresh_token: newToken,
      });
      return;
    } catch (e) {
      console.warn('[gmailTokenStore] Supabase refresh-token rotation notice:', e.message);
    }
  }

  if (current && current.source === 'env-deprecated') {
    // Cannot rewrite an env var at runtime — surface it so the admin can migrate.
    console.warn('Gmail issued a rotated refresh token. Migrate the connection to Supabase (node server/scripts/migrate-support-gmail-to-supabase.js) to persist it.');
    memory.refresh_token = String(newToken);
    return;
  }

  try {
    await saveConnection({
      refresh_token: newToken,
      gmail_email: current?.gmail_email || memory.gmail_email,
      history_id: current?.history_id || memory.history_id,
    });
  } catch (e) {
    console.warn('[gmailTokenStore] refresh-token rotation notice:', e.message);
  }
}

/** Flag the stored credential as needing re-auth (safe message only). */
function markReauthRequired(safeMessage) {
  const email = memory.gmail_email || envMailbox();
  if (!email || !store.isReady()) return Promise.resolve(false);
  return store.markReauthRequired(
    email,
    safeMessage || 'Support Mailbox Google refresh token is invalid or revoked. Reconnect Gmail.'
  ).catch(() => false);
}

async function clearConnection() {
  // Best-effort: mark the Supabase credential disconnected (the encrypted row
  // stays until the next reconnect overwrites it — the old token is useless
  // once Google revoked it).
  const email = memory.gmail_email || envMailbox();
  if (email && store.isReady()) {
    try { await store.markDisconnected(email); } catch (e) { /* best effort */ }
  }

  memory = {
    refresh_token: '',
    gmail_email: '',
    connected_at: null,
    history_id: '',
    watch_expiration: null,
    watch_push_token: '',
    access_token_expires_at: null,
  };
  const removedFile = removeTokenFile();
  return {
    removedFile,
    envStillSet: Boolean(String(process.env.GMAIL_REFRESH_TOKEN || '').trim()),
  };
}

module.exports = {
  getConnection,
  isConnected,
  saveConnection,
  updateMeta,
  rotateRefreshToken,
  markReauthRequired,
  clearConnection,
  envMailbox,
  candidatePaths,
};
