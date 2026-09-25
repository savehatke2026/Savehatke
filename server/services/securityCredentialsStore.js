// ============================================
// SaveHatke — Security Credentials Store (generic, multi-service, Supabase)
// ============================================
// ONE table, public.security_credentials, holds every server-side OAuth
// credential, discriminated by `service`:
//   * service = 'payment_gmail'  → payment mailbox   (rupayandas2025@gmail.com)
//   * service = 'google_drive'   → Drive uploads acct (database.savehatke@gmail.com)
//
// Every lookup is scoped by (service, email) so a Google Drive error can never
// touch the Payment Gmail row and vice-versa. This module is the single source
// of truth for reading/writing the AES-256-GCM ENCRYPTED refresh tokens.
//
// Security invariants:
//   * The refresh token is only ever stored encrypted (encryptCredentialSecret).
//   * Plaintext is decrypted ONLY inside getDecryptedRefreshToken() and is
//     NEVER logged, returned to a browser, or put in an error.
//   * getSafeStatus()/listSafeAll() return ONLY non-secret fields.
//   * All access uses the service-role Supabase client (bypasses RLS); RLS is
//     enabled with no permissive policy so no browser client can read the table.
//
// RESILIENCE: queries prefer the new table name `security_credentials` and the
// new columns (`service`, `authorized_at`, `estimated_expires_at`), and
// transparently fall back to the legacy table name / missing columns so a
// running deployment never breaks while the SQL migrations are applied. When
// the `service` column is absent, isolation still holds because the two
// services use different email addresses and every lookup also filters by email.

const { getClient } = require('./supabase');
const { encryptCredentialSecret, decryptCredentialSecret } = require('./gmailCrypto');

const PREFERRED_TABLE = 'security_credentials';
const LEGACY_TABLE = 'payment_mailbox_credentials';

const SERVICES = Object.freeze({ PAYMENT_GMAIL: 'payment_gmail', GOOGLE_DRIVE: 'google_drive' });
const RECONNECT_SOON_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

const BASE_COLS = 'email, status, connected_at, last_verified_at, last_used_at, last_error, updated_at';
const SAFE_FULL = 'service, ' + BASE_COLS + ', authorized_at, estimated_expires_at';
const SAFE_MID = BASE_COLS + ', authorized_at, estimated_expires_at';
const TOKEN_FULL = 'service, email, encrypted_refresh_token, status, authorized_at, estimated_expires_at';
const TOKEN_MID = 'email, encrypted_refresh_token, status';

let activeTable = null;

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
function isOnConflictError(error) {
  if (!error) return false;
  if (error.code === '42P10' || error.code === 'PGRST200') return true;
  return /no unique or exclusion constraint matching the on ?conflict|on conflict/i.test(error.message || '');
}
function tableCandidates() {
  const base = [PREFERRED_TABLE, LEGACY_TABLE];
  if (activeTable) return [activeTable, ...base.filter((t) => t !== activeTable)];
  return base;
}

/**
 * Single-row read scoped by service + email, resilient to the legacy table name
 * and to the new columns not existing yet. Returns the row (safe columns unless
 * withToken) or null.
 */
async function readOne({ service, email, mostRecent = false, withToken = false }) {
  const client = getClient();
  if (!client) return null;
  const addr = normEmail(email);

  // [columns, useServiceFilter] attempts, best → most-degraded.
  const attempts = withToken
    ? [[TOKEN_FULL, true], [TOKEN_MID, false]]
    : [[SAFE_FULL, true], [SAFE_MID, false], [BASE_COLS, false]];

  for (const table of tableCandidates()) {
    let relationMissing = false;
    for (const [cols, useService] of attempts) {
      let q = client.from(table).select(cols);
      if (useService && service) q = q.eq('service', service);
      if (addr) q = q.eq('email', addr);
      else q = q.neq('status', 'disconnected').order('updated_at', { ascending: false });
      const { data, error } = await q.limit(1);
      if (!error) { activeTable = table; return data && data.length ? data[0] : null; }
      if (isMissingColumn(error)) continue;      // retry same table, degraded cols/no-service
      if (isMissingRelation(error)) { relationMissing = true; break; }
      console.warn('[securityCredentials] read warning:', error.message);
      return null;
    }
    if (!relationMissing) break;
  }
  return null;
}

/** Safe (no-token) row for a specific service+email. */
async function getCredential(service, email, opts = {}) {
  return readOne({ service, email, mostRecent: opts.mostRecent || false });
}

/**
 * Decrypted refresh token for service+email, or null. Plaintext never leaves
 * this function except as the return value to the server-side OAuth client.
 */
async function getDecryptedRefreshToken(service, email, opts = {}) {
  const row = await readOne({ service, email, mostRecent: opts.mostRecent || false, withToken: true });
  if (!row) return null;
  try {
    const token = decryptCredentialSecret(row.encrypted_refresh_token);
    if (!token) return null;
    return { service: row.service || service, email: row.email, refresh_token: token, status: row.status };
  } catch (e) {
    console.warn('[securityCredentials] token decrypt exception:', e.message);
    return null;
  }
}

function stripExpiry(row) {
  const { authorized_at, estimated_expires_at, ...rest } = row;
  return rest;
}
function stripService(row) {
  const { service, ...rest } = row;
  return rest;
}

/**
 * Create or replace the credential for (service, email) from a freshly minted
 * refresh token. Encrypts server-side, marks active, stamps timestamps. Never
 * stores plaintext. UPSERTs on the composite unique so the SAME row is updated
 * rather than duplicated.
 */
async function upsertCredential({ service, email, refresh_token, authorizedAt, estimatedExpiresAt }) {
  const client = getClient();
  if (!client) throw new Error('Supabase is not configured.');
  const addr = normEmail(email);
  if (!service) throw new Error('A service is required.');
  if (!addr) throw new Error('A credential email is required.');
  if (!refresh_token) throw new Error('A refresh token is required.');

  const encrypted = encryptCredentialSecret(refresh_token); // throws if key missing
  const nowIso = new Date().toISOString();

  const row = {
    service,
    email: addr,
    encrypted_refresh_token: encrypted,
    status: 'active',
    connected_at: nowIso,
    authorized_at: authorizedAt || nowIso,
    estimated_expires_at: estimatedExpiresAt || null,
    last_verified_at: nowIso,
    last_error: null,
    updated_at: nowIso,
  };

  // Try the fully-migrated shape first, then degrade for a not-yet-migrated DB.
  const combos = [
    [row, 'service,email'],
    [stripExpiry(row), 'service,email'],
    [stripService(row), 'email'],
    [stripService(stripExpiry(row)), 'email'],
  ];

  for (const table of tableCandidates()) {
    let relationMissing = false;
    for (const [payload, onConflict] of combos) {
      const { error } = await client.from(table).upsert(payload, { onConflict });
      if (!error) { activeTable = table; return { ok: true, service, email: addr, estimatedExpiresAt: payload.estimated_expires_at || null }; }
      if (isMissingColumn(error) || isOnConflictError(error)) continue;
      if (isMissingRelation(error)) { relationMissing = true; break; }
      throw new Error(error.message);
    }
    if (!relationMissing) break;
  }
  throw new Error('security_credentials table not found.');
}

/** Update selected metadata columns for a specific (service, email). */
async function patch(service, email, fields) {
  const client = getClient();
  if (!client) return false;
  const addr = normEmail(email);
  const payload = { ...fields, updated_at: new Date().toISOString() };

  for (const table of tableCandidates()) {
    let relationMissing = false;
    // [useServiceFilter] attempts.
    for (const useService of [true, false]) {
      let q = client.from(table).update(payload);
      if (useService && service) q = q.eq('service', service);
      if (addr) q = q.eq('email', addr);
      else q = q.neq('status', 'disconnected');
      const { error } = await q;
      if (!error) { activeTable = table; return true; }
      if (isMissingColumn(error)) continue; // service column absent → retry without it
      if (isMissingRelation(error)) { relationMissing = true; break; }
      console.warn('[securityCredentials] patch warning:', error.message);
      return false;
    }
    if (!relationMissing) break;
  }
  return false;
}

function markUsed(service, email) {
  return patch(service, email, { last_used_at: new Date().toISOString() });
}
function markVerified(service, email) {
  return patch(service, email, { status: 'active', last_verified_at: new Date().toISOString(), last_error: null });
}
function markReauthRequired(service, email, safeMessage) {
  return patch(service, email, {
    status: 'reauthorization_required',
    last_error: String(safeMessage || 'Authorization expired or was revoked. Reconnect required.').slice(0, 300),
  });
}
function markError(service, email, safeMessage) {
  return patch(service, email, {
    status: 'error',
    last_error: String(safeMessage || 'Credential error.').slice(0, 300),
  });
}
function markDisconnected(service, email) {
  return patch(service, email, { status: 'disconnected' });
}

/**
 * Compute the admin-panel warning state. Pure & side-effect free. A NULL
 * estimated_expires_at (e.g. Google Drive, which has no Testing-mode countdown)
 * yields 'connected' when active — no false countdown is ever shown.
 */
function computeWarning({ status, estimatedExpiresAt, lastError } = {}, nowMs = Date.now()) {
  const expMs = estimatedExpiresAt ? Date.parse(estimatedExpiresAt) : NaN;
  const remainingMs = Number.isFinite(expMs) ? expMs - nowMs : null;

  if (status === 'reauthorization_required') {
    return { level: 'reauth', color: 'red', remainingMs,
      message: 'Authorization has expired or was revoked. Reconnect to resume this integration.' };
  }
  if (status === 'disconnected') {
    return { level: 'not_connected', color: 'grey', remainingMs: null, message: 'Not connected.' };
  }
  if (status === 'error') {
    return { level: 'error', color: 'red', remainingMs, message: lastError || 'This integration reported an error.' };
  }
  if (remainingMs != null) {
    if (remainingMs <= 0) {
      return { level: 'expired', color: 'red', remainingMs, message: 'Authorization has expired. Reconnect to resume this integration.' };
    }
    if (remainingMs <= RECONNECT_SOON_MS) {
      return { level: 'reconnect_soon', color: 'yellow', remainingMs, message: 'Authorization will expire soon. Reconnect to keep this integration active.' };
    }
  }
  return { level: 'connected', color: 'green', remainingMs, message: 'Authorization active.' };
}

function toSafe(row, service) {
  if (!row) return null;
  const warning = computeWarning({
    status: row.status,
    estimatedExpiresAt: row.estimated_expires_at || null,
    lastError: row.last_error || null,
  });
  return {
    service: row.service || service || null,
    email: row.email,
    connected: row.status === 'active' && warning.level !== 'expired',
    exists: true,
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

/** Safe status object for one service+email — NEVER includes the token. */
async function getSafeStatus(service, email) {
  const row = await getCredential(service, email);
  if (!row) return { service: service || null, email: normEmail(email) || null, connected: false, exists: false, warning: computeWarning({ status: 'disconnected' }) };
  return toSafe(row, service);
}

module.exports = {
  PREFERRED_TABLE,
  LEGACY_TABLE,
  SERVICES,
  RECONNECT_SOON_MS,
  isReady,
  getCredential,
  getDecryptedRefreshToken,
  upsertCredential,
  patch,
  markUsed,
  markVerified,
  markReauthRequired,
  markError,
  markDisconnected,
  computeWarning,
  toSafe,
  getSafeStatus,
};
