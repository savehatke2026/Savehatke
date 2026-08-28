// ============================================
// SaveHatke — Support Mailbox Token Store (NO DATABASE)
// ============================================
// The Support Mailbox is a SINGLE shared mailbox (support.savehatke@gmail.com),
// not a per-admin connection, so it does not need a database at all.
//
// The only thing that must persist is the Gmail OAuth **refresh token**.
// It is resolved in this order:
//
//   1. process.env.GMAIL_REFRESH_TOKEN   ← permanent / production (Vercel env var)
//   2. local token file (see tokenFilePath) ← written by the OAuth callback in dev
//   3. in-memory cache                    ← survives only until the process restarts
//
// Email bodies are NEVER stored anywhere; they are always fetched live from the
// Gmail API. The refresh token is stored AES-256-GCM encrypted (gmailCrypto) in
// the token file. In the env var it may be either the raw Google token
// ("1//...") or an encrypted "v1.<iv>.<tag>.<data>" blob.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { encryptSecret, decryptSecret } = require('./gmailCrypto');

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

// ── Token file location ────────────────────────────────────────────────────
function candidatePaths() {
  const list = [];
  if (process.env.GMAIL_TOKEN_FILE) list.push(process.env.GMAIL_TOKEN_FILE);
  // Default: alongside the server code (dev / self-hosted).
  list.push(path.join(__dirname, '..', '.gmail-token.json'));
  // Serverless fallback: only /tmp is writable on Vercel. Ephemeral, but it
  // keeps the mailbox usable until GMAIL_REFRESH_TOKEN is set permanently.
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

// ── Env token ──────────────────────────────────────────────────────────────
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

/**
 * Current mailbox connection, or null when the mailbox is not connected yet.
 * `source` tells the admin panel how durable the token is:
 *   'env'    — permanent (survives restarts / redeploys)
 *   'file'   — persisted on this server's disk
 *   'memory' — this process only; must be promoted to GMAIL_REFRESH_TOKEN
 */
function getConnection() {
  const fromEnv = envRefreshToken();
  if (fromEnv) {
    return {
      source: 'env',
      refresh_token: fromEnv,
      gmail_email: memory.gmail_email || envMailbox(),
      connected_at: memory.connected_at,
      history_id: memory.history_id || '',
      watch_expiration: memory.watch_expiration,
      watch_push_token: memory.watch_push_token || '',
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
        gmail_email: String(file.gmail_email || '').toLowerCase(),
        connected_at: file.connected_at || null,
        history_id: memory.history_id || file.history_id || '',
        watch_expiration: memory.watch_expiration || file.watch_expiration || null,
        watch_push_token: memory.watch_push_token || file.watch_push_token || '',
        durable: !String(file.__path || '').startsWith(os.tmpdir()),
        path: file.__path,
      };
    }
  }

  if (memory.refresh_token) {
    return {
      source: 'memory',
      refresh_token: memory.refresh_token,
      gmail_email: memory.gmail_email,
      connected_at: memory.connected_at,
      history_id: memory.history_id || '',
      watch_expiration: memory.watch_expiration,
      watch_push_token: memory.watch_push_token || '',
      durable: false,
    };
  }

  return null;
}

function isConnected() {
  return Boolean(getConnection());
}

/**
 * Persist a freshly minted refresh token.
 * Returns { source, path, durable } describing where it actually landed.
 */
function saveConnection({ refresh_token, gmail_email, history_id }) {
  const token = String(refresh_token || '');
  if (!token) throw new Error('A Gmail refresh token is required.');

  memory = {
    ...memory,
    refresh_token: token,
    gmail_email: String(gmail_email || '').toLowerCase(),
    connected_at: new Date().toISOString(),
    history_id: String(history_id || ''),
  };

  // Try to persist to disk. encryptSecret throws when
  // GMAIL_TOKEN_ENCRYPTION_KEY is missing — in that case keep it in memory
  // only rather than writing a plaintext token to disk.
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

  const envHasToken = Boolean(envRefreshToken());
  if (envHasToken) return { source: 'env', path: null, durable: true };
  if (writtenPath) {
    return {
      source: 'file',
      path: writtenPath,
      durable: !writtenPath.startsWith(os.tmpdir()),
    };
  }
  return { source: 'memory', path: null, durable: false };
}

function updateMeta(patch = {}) {
  const allowed = ['history_id', 'watch_expiration', 'watch_push_token', 'access_token_expires_at', 'gmail_email'];
  for (const key of allowed) {
    if (patch[key] !== undefined) memory[key] = patch[key];
  }
  // Keep the token file's sync metadata roughly in step (best-effort only).
  const file = readTokenFile();
  if (file && file.__path) {
    try {
      const next = { ...file };
      delete next.__path;
      for (const key of allowed) {
        if (patch[key] !== undefined) next[key] = patch[key];
      }
      fs.writeFileSync(file.__path, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      fileCache = { ...next, __path: file.__path };
    } catch (e) { /* read-only FS — memory copy is enough */ }
  }
  return memory;
}

/**
 * Rotate the stored refresh token (Google occasionally issues a new one).
 */
function rotateRefreshToken(newToken) {
  if (!newToken) return;
  const current = getConnection();
  if (current && current.source === 'env') {
    // Cannot rewrite an env var at runtime — surface it so the admin can update it.
    console.warn('Gmail issued a rotated refresh token. Update GMAIL_REFRESH_TOKEN to keep the mailbox connected.');
    memory.refresh_token = String(newToken);
    return;
  }
  saveConnection({
    refresh_token: newToken,
    gmail_email: current?.gmail_email || memory.gmail_email,
    history_id: current?.history_id || memory.history_id,
  });
}

function clearConnection() {
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
  clearConnection,
  envMailbox,
  candidatePaths,
};
