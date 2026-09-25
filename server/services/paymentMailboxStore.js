// ============================================
// SaveHatke — Payment Mailbox Credential Store (thin wrapper)
// ============================================
// Backwards-compatible facade over services/securityCredentialsStore.js, bound
// to service = 'payment_gmail'. The payment code (routes/paymentMailbox.js,
// services/paymentMailbox.js, services/paymentVerifier.js, the migrate script)
// keeps calling THIS module with the same function signatures it always had;
// all storage now flows through the shared multi-service store so the Payment
// Gmail row and the Google Drive row coexist safely in one table
// (public.security_credentials) without ever colliding.
//
// Payment Gmail specifics preserved here:
//   * email = rupayandas2025@gmail.com (passed by the caller),
//   * Google "Testing" refresh-token window (~7 days) → estimated_expires_at,
//     which drives the 2-day reconnect warning in the admin panel.

const core = require('./securityCredentialsStore');

const SERVICE = core.SERVICES.PAYMENT_GMAIL; // 'payment_gmail'
const TABLE = core.PREFERRED_TABLE;

// Google Testing-mode refresh tokens expire ~7 days after issue. Overridable.
const TESTING_TTL_DAYS = (() => {
  const n = Number(process.env.PAYMENT_GMAIL_TESTING_TOKEN_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
})();
const TTL_MS = TESTING_TTL_DAYS * 24 * 60 * 60 * 1000;

function isReady() {
  return core.isReady();
}

/** Safe (no-token) active payment-mailbox row. */
function getActiveCredential(email) {
  return core.getCredential(SERVICE, email);
}

/** Decrypted refresh token for the payment mailbox, or null. */
function getDecryptedRefreshToken(email) {
  return core.getDecryptedRefreshToken(SERVICE, email);
}

/**
 * Upsert the payment-mailbox credential from a fresh refresh token. Stamps the
 * Testing-mode estimated expiry so the admin panel can warn 2 days out.
 */
function upsertCredential({ email, refresh_token }) {
  const nowIso = new Date().toISOString();
  const estimatedExpiresAt = new Date(Date.now() + TTL_MS).toISOString();
  return core.upsertCredential({
    service: SERVICE,
    email,
    refresh_token,
    authorizedAt: nowIso,
    estimatedExpiresAt,
  });
}

function markUsed(email) { return core.markUsed(SERVICE, email); }
function markVerified(email) { return core.markVerified(SERVICE, email); }
function markReauthRequired(email, safeMessage) {
  return core.markReauthRequired(SERVICE, email, safeMessage || 'Payment Gmail authorization expired or was revoked. Reconnect Gmail.');
}
function markError(email, safeMessage) {
  return core.markError(SERVICE, email, safeMessage || 'Payment Gmail error.');
}
function markDisconnected(email) { return core.markDisconnected(SERVICE, email); }

const computeWarning = core.computeWarning;

/** Safe status object for the admin panel — NEVER includes the token. */
async function getSafeStatus(email) {
  const safe = await core.getSafeStatus(SERVICE, email);
  // Preserve the historical shape: when nothing exists, return {connected,exists}.
  if (!safe || !safe.exists) {
    return { connected: false, exists: false, warning: safe ? safe.warning : computeWarning({ status: 'disconnected' }) };
  }
  return safe;
}

module.exports = {
  TABLE,
  PREFERRED_TABLE: core.PREFERRED_TABLE,
  LEGACY_TABLE: core.LEGACY_TABLE,
  SERVICE,
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
