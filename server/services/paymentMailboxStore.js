// ============================================
// SaveHatke — Security Credentials Store (Supabase-backed)
// ============================================
// Supabase is the SOURCE OF TRUTH for the dedicated payment mailbox
// (rupayandas2024@gmail.com) Gmail OAuth connection:
//   * the payment Gmail address,
//   * the AES-256-GCM ENCRYPTED refresh token,
//   * the connection status (active / reauthorization_required / error /
//     disconnected),
//   * the authorize / estimated-expiry / connect / verify / use / error stamps.
//
// Security invariants enforced here:
//   * The refresh token is only ever stored encrypted (encryptPaymentSecret).
//   * The plaintext token is decrypted ONLY inside getDecryptedRefreshToken()
//     and is NEVER logged, never returned to a browser, never put in an error.
//   * getSafeStatus() returns ONLY non-secret fields for the admin panel.
//   * All access uses the service-role Supabase client (bypasses RLS); the
//     table has RLS enabled with no permissive policy, so no browser client can
//     read it.
//
// Table: public.security_credentials
//   (renamed from public.payment_mailbox_credentials — see
//    supabase/migrations/20260924_rename_payment_mailbox_to_security_credentials.sql)
//
// TABLE-NAME RESILIENCE: during a rollout the SQL rename may not yet have been
// applied. Every query prefers `security_credentials` and transparently falls
// back to the legacy `payment_mailbox_credentials` (and to base columns when
// the new expiry columns are missing), so the running deployment never breaks
// while the migration is applied. The resolved name is cached after first use.

const { getClient } = require('./supabase');
const { encryptPaymentSecret, decryptPaymentSecret } = require('./gmailCrypto');

const PREFERRED_TABLE = 'security_credentials';
const LEGACY_TABLE = 'payment_mailbox_credentials';
const TABLE = PREFERRED_TABLE;

// Google "Testing" publishing-status refresh tokens expire ~7 days after they
// are issued. This drives estimated_expires_at and the admin expiry warnings.
// Overridable via env for a published (non-testing) app.
const TESTING_TTL_DAYS = (() => {
  const n = Number(process.env.PAYMENT_GMAIL_TESTING_TOKEN_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
})();
const TTL_MS = TESTING_TTL_DAYS * 24 * 60 * 60 * 1000;
const RECONNECT_SOON_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

// Only the safe, non-secret columns are ever selected for status/read paths.
// encrypted_refresh_token is fetched separately and only when a token is needed.
const BASE_COLUMNS =
  'email, status, connected_at, last_verified_at, last_used_at, last_error, updated_at';
const SAFE_COLUMNS = BASE_COLUMNS + ', authorized_at, estimated_expires_at';
const TOKEN_COLUMNS_FULL = 'email, encrypted_refresh_token, status, authorized_at, estimated_expires_at';
const TOKEN_COLUMNS_BASE = 'email, encrypted_refresh_token, status';

let activeTable = null; // cached once a query succeeds

/** True when Supabase is configured (service-role client available). */
function isReady() {
  return Boolean(getClient());
}

function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isMissingRelation(error) {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /does not exist|could not find the table|schema cache/i.test(error.message || '');
}

function isMissingColumn(error) {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  return /column .* does not exist|could not find the .* column/i.test(error.message || '');
}

function tableCandidates() {
  // Always try both names (cached one first). This keeps the running server
  // correct across the rename: if the cached table later disappears because
  // the SQL migration was applied mid-process, the other name is still tried
  // and the cache re-resolves — no restart required.
  const base = [PREFERRED_TABLE, LEGACY_TABLE];
  if (activeTable) return [activeTable, ...base.filter((t) => t !== activeTable)];
  return base;
}

/**
 * Run a single-row read, trying the preferred table then the legacy table, and
 * the full column set then the base set (when the new expiry columns are not
 * present yet). `applyFilter(query)` receives a fresh PostgREST builder each
 * attempt and must return it. Returns the row object (safe columns) or null.
 */
async function readOne(applyFilter, { withToken = false } = {}) {
  const client = getClient();
  if (!client) return null;
  const colSets = withToken
    ? [TOKEN_COLUMNS_FULL, TOKEN_COLUMNS_BASE]
    : [SAFE_COLUMNS, BASE_COLUMNS];

  for (const table of tableCandidates()) {
    let relationMissing = false;
    for (const cols of colSets) {
      let query = client.from(table).select(cols);
      query = applyFilter(query).limit(1);
      const { data, error } = await query;
      if (!error) {
        activeTable = table;
        return data && data.length ? data[0] : null;
      }
      if (isMissingColumn(error)) continue;          // retry same table, base cols
      if (isMissingRelation(error)) { relationMissing = true; break; } // try next table
      console.warn('[securityCredentials] read warning:', error.message);
      return null;
    }
    if (!relationMissing) break;
  }
  return null;
}

/**
 * Fetch the active payment-mailbox row. When `email` is provided the lookup is
 * scoped to that address; otherwise the most recently updated non-disconnected
 * row is returned. Returns SAFE fields only (no token).
 */
async function getActiveCredential(email) {
  const target = normEmail(email);
  return readOne((q) =>
    target
      ? q.eq('email', target)
      : q.neq('status', 'disconnected').order('updated_at', { ascending: false })
  );
}

/**
 * Return the DECRYPTED refresh token for the given (or single active) mailbox,
 * or null when unavailable / undecryptable. The plaintext never leaves this
 * function except as the return value to the server-side OAuth client.
 */
async function getDecryptedRefreshToken(email) {
  const target = normEmail(email);
  const row = await readOne(
    (q) =>
      target
        ? q.eq('email', target)
        : q.neq('status', 'disconnected').order('updated_at', { ascending: false }),
    { withToken: true }
  );
  if (!row) return null;
  try {
    const token = decryptPaymentSecret(row.encrypted_refresh_token);
    if (!token) return null;
    return { email: row.email, refresh_token: token, status: row.status };
  } catch (e) {
    // Never include the token or the encrypted blob in the message.
    console.warn('[securityCredentials] token decrypt exception:', e.message);
    return null;
  }
}

/** Write `row` to whichever table currently exists, honouring onConflict. */
async function writeUpsert(row) {
  const client = getClient();
  if (!client) throw new Error('Supabase is not configured.');

  // Attempt with the new expiry columns; if they don't exist yet (rename SQL
  // not applied), retry without them so the running deployment still works.
  const attempts = [row, stripExpiryFields(row)];
  for (const table of tableCandidates()) {
    let relationMissing = false;
    for (const payload of attempts) {
      const { error } = await client.from(table).upsert(payload, { onConflict: 'email' });
      if (!error) { activeTable = table; return; }
      if (isMissingColumn(error)) continue;
      if (isMissingRelation(error)) { relationMissing = true; break; }
      throw new Error(error.message);
    }
    if (!relationMissing) break;
  }
  throw new Error('security_credentials table not found.');
}

function stripExpiryFields(row) {
  const { authorized_at, estimated_expires_at, ...rest } = row;
  return rest;
}

/**
 * Upsert (create or replace) the payment-mailbox credential from a freshly
 * minted refresh token. Encrypts server-side, marks the connection active, and
 * stamps connected_at + authorized_at + estimated_expires_at + last_verified_at.
 * Never stores plaintext. UPSERT on the UNIQUE(email) constraint updates the
 * existing row instead of creating a duplicate.
 * @returns {Promise<{ok:boolean, email:string, estimatedExpiresAt:string}>}
 */
async function upsertCredential({ email, refresh_token }) {
  const addr = normEmail(email);
  if (!addr) throw new Error('A payment mailbox email is required.');
  if (!refresh_token) throw new Error('A payment mailbox refresh token is required.');

  const encrypted = encryptPaymentSecret(refresh_token); // throws if key missing
  const now = new Date();
  const nowIso = now.toISOString();
  const estimatedExpiresAt = new Date(now.getTime() + TTL_MS).toISOString();

  const row = {
    email: addr,
    encrypted_refresh_token: encrypted,
    status: 'active',
    connected_at: nowIso,
    authorized_at: nowIso,
    estimated_expires_at: estimatedExpiresAt,
    last_verified_at: nowIso,
    last_error: null,
    updated_at: nowIso,
  };

  await writeUpsert(row);
  return { ok: true, email: addr, estimatedExpiresAt };
}

/** Update selected metadata columns for a mailbox. Internal helper. */
async function patch(email, fields) {
  const client = getClient();
  if (!client) return false;
  const addr = normEmail(email);
  const attempts = [
    { ...fields, updated_at: new Date().toISOString() },
    stripExpiryFields({ ...fields, updated_at: new Date().toISOString() }),
  ];
  for (const table of tableCandidates()) {
    let relationMissing = false;
    for (const payload of attempts) {
      let query = client.from(table).update(payload);
      query = addr ? query.eq('email', addr) : query.neq('status', 'disconnected');
      const { error } = await query;
      if (!error) { activeTable = table; return true; }
      if (isMissingColumn(error)) continue;
      if (isMissingRelation(error)) { relationMissing = true; break; }
      console.warn('[securityCredentials] patch warning:', error.message);
      return false;
    }
    if (!relationMissing) break;
  }
  return false;
}

/** Stamp last_used_at when the verifier opens the mailbox. */
function markUsed(email) {
  return patch(email, { last_used_at: new Date().toISOString() });
}

/** Stamp last_verified_at (and clear a stale error) after a proven-good access. */
function markVerified(email) {
  return patch(email, {
    status: 'active',
    last_verified_at: new Date().toISOString(),
    last_error: null,
  });
}

/**
 * Flag the connection as needing re-authorization (Google invalid_grant /
 * revoked token / testing-mode expiry). `safeMessage` MUST already be a
 * sanitized, credential-free string.
 */
function markReauthRequired(email, safeMessage) {
  return patch(email, {
    status: 'reauthorization_required',
    last_error: String(safeMessage || 'Payment Gmail authorization expired. Reconnect Gmail.').slice(0, 300),
  });
}

/** Record a non-auth error without changing a working connection to reauth. */
function markError(email, safeMessage) {
  return patch(email, {
    status: 'error',
    last_error: String(safeMessage || 'Payment Gmail error.').slice(0, 300),
  });
}

/** Intentionally disconnect (keeps the row for history; token left encrypted). */
function markDisconnected(email) {
  return patch(email, { status: 'disconnected' });
}

// ── Expiry-warning computation ───────────────────────────────────────────────
/**
 * Compute the admin-panel warning state from the stored status + estimated
 * expiry. Pure & side-effect free. Levels map to the admin states:
 *   connected      → 🟢 State A (>2 days, or unknown expiry but active)
 *   reconnect_soon → 🟡 State B (≤2 days remaining)
 *   expired        → 🔴 State C (estimated_expires_at ≤ now)
 *   reauth         → 🔴 State C (Google invalid_grant / revoked)
 *   error          → 🔴 non-auth error recorded
 *   not_connected  → ⚪ State D (no row / intentionally disconnected)
 */
function computeWarning({ status, estimatedExpiresAt, lastError } = {}, nowMs = Date.now()) {
  const expMs = estimatedExpiresAt ? Date.parse(estimatedExpiresAt) : NaN;
  const remainingMs = Number.isFinite(expMs) ? expMs - nowMs : null;

  if (status === 'reauthorization_required') {
    return {
      level: 'reauth', color: 'red', remainingMs,
      message: 'Payment Gmail authorization has expired or was revoked. Reconnect Gmail to resume payment email verification.',
    };
  }
  if (status === 'disconnected') {
    return { level: 'not_connected', color: 'grey', remainingMs: null,
      message: 'No payment Gmail account is connected.' };
  }
  if (status === 'error') {
    return { level: 'error', color: 'red', remainingMs,
      message: lastError || 'Payment Gmail reported an error. Reconnect Gmail if verification stops.' };
  }

  // status === 'active' (or unknown-but-present): decide by estimated expiry.
  if (remainingMs != null) {
    if (remainingMs <= 0) {
      return { level: 'expired', color: 'red', remainingMs,
        message: 'Payment Gmail authorization has expired. Reconnect Gmail to resume payment email verification.' };
    }
    if (remainingMs <= RECONNECT_SOON_MS) {
      return { level: 'reconnect_soon', color: 'yellow', remainingMs,
        message: 'Payment Gmail authorization will expire soon. Reconnect Gmail to keep payment email verification active.' };
    }
  }
  return { level: 'connected', color: 'green', remainingMs,
    message: 'Authorization active.' };
}

/**
 * Safe status object for the admin panel — NEVER includes the token.
 */
async function getSafeStatus(email) {
  const row = await getActiveCredential(email);
  if (!row) return { connected: false, exists: false, warning: computeWarning({ status: 'disconnected' }) };
  const warning = computeWarning({
    status: row.status,
    estimatedExpiresAt: row.estimated_expires_at || null,
    lastError: row.last_error || null,
  });
  return {
    connected: row.status === 'active' && warning.level !== 'expired',
    exists: true,
    email: row.email,
    status: row.status,
    connectedAt: row.connected_at,
    authorizedAt: row.authorized_at || null,
    estimatedExpiresAt: row.estimated_expires_at || null,
    lastVerifiedAt: row.last_verified_at,
    lastUsedAt: row.last_used_at,
    lastError: row.last_error || null,
    updatedAt: row.updated_at,
    warning,
  };
}

module.exports = {
  TABLE,
  PREFERRED_TABLE,
  LEGACY_TABLE,
  TESTING_TTL_DAYS,
  isReady,
  getActiveCredential,
  getDecryptedRefreshToken,
  upsertCredential,
  markUsed,
  markVerified,
  markReauthRequired,
  markError,
  markDisconnected,
  computeWarning,
  getSafeStatus,
};
