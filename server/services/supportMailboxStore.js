// ============================================
// SaveHatke — Support Mailbox Credential Store (Supabase)
// ============================================
// Thin, support-mailbox-specific wrapper over services/securityCredentialsStore.js.
// The refresh token lives in the EXISTING public.security_credentials table as
//     service = 'support_gmail'
// alongside payment_gmail and google_drive — one server-only store for every
// OAuth credential (see supabase/migrations/20261006_support_gmail_security_credentials.sql,
// which only extends the service CHECK constraint).
//
// Security invariants (inherited from securityCredentialsStore):
//   * The refresh token is only ever stored encrypted (encryptCredentialSecret,
//     key = SUPPORT_MAILBOX_TOKEN_ENCRYPTION_KEY, falling back to
//     GMAIL_TOKEN_ENCRYPTION_KEY).
//   * Plaintext is decrypted ONLY inside getDecryptedRefreshToken() and is
//     NEVER logged, returned to a browser, or put in an error.
//   * getSafeStatus() returns ONLY non-secret fields.
//   * All access uses the service-role Supabase client (bypasses RLS); RLS is
//     enabled with no permissive policy, so no browser client can read the row.
//   * One mailbox → one row, UPSERTed on the (service, email) unique key.

const shared = require('./securityCredentialsStore');
const { computeWarning } = shared;

// The service discriminator for the support mailbox inside security_credentials.
const SERVICE = 'support_gmail';
const TABLE = shared.PREFERRED_TABLE; // 'security_credentials'

const isReady = shared.isReady;

/**
 * Decrypted refresh token for the support mailbox, or null.
 * When `email` is given the read is scoped to that address first; if no row
 * matches (e.g. the panel expects an alias while the OAuth row holds the real
 * Gmail address) it falls back to the most recent non-disconnected
 * support_gmail row. The plaintext token NEVER leaves this function except as
 * the return value to the server-side OAuth client.
 */
async function getDecryptedRefreshToken(email) {
  try {
    return await shared.getDecryptedRefreshToken(SERVICE, email);
  } catch (e) {
    console.warn('[supportMailboxStore] token read warning:', e.message);
    return null;
  }
}

/**
 * Secure server-side save: encrypt the new refresh token and UPSERT the
 * support_gmail credential (same row, updated_at auto-bumped by trigger).
 * Never stores plaintext, never logs the token.
 */
async function saveSupportMailboxRefreshToken({ email, refresh_token }) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) throw new Error('A support mailbox email is required.');
  if (!refresh_token) throw new Error('A refresh token is required.');
  // Delegates to securityCredentialsStore.upsertCredential — encrypts with the
  // SUPPORT mailbox key and UPSERTs on (service, email). Throws when the
  // encryption key is missing or Supabase rejects the write (errors never
  // contain the token).
  return shared.upsertCredential({ service: SERVICE, email: addr, refresh_token });
}

function markUsed(email) {
  return shared.markUsed(SERVICE, email);
}
function markVerified(email) {
  return shared.markVerified(SERVICE, email);
}
function markReauthRequired(email, safeMessage) {
  return shared.markReauthRequired(
    SERVICE,
    email,
    safeMessage || 'Support Mailbox Google refresh token is invalid or revoked. Reconnect Gmail.'
  );
}
function markError(email, safeMessage) {
  return shared.markError(SERVICE, email, safeMessage || 'Support Mailbox error.');
}
function markDisconnected(email) {
  return shared.markDisconnected(SERVICE, email);
}

/** Safe (no-token) status row for a specific email. */
async function getCredential(email) {
  try {
    return await shared.getCredential(SERVICE, email);
  } catch (e) {
    console.warn('[supportMailboxStore] read warning:', e.message);
    return null;
  }
}

/** Safe status object for the admin panel — NEVER includes the token. */
async function getSafeStatus(email) {
  return shared.getSafeStatus(SERVICE, email);
}

module.exports = {
  SERVICE,
  TABLE,
  isReady,
  getDecryptedRefreshToken,
  saveSupportMailboxRefreshToken,
  getCredential,
  markUsed,
  markVerified,
  markReauthRequired,
  markError,
  markDisconnected,
  getSafeStatus,
};
