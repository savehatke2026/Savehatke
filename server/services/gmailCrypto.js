// ============================================
// SaveHatke — Gmail Token Encryption
// AES-256-GCM encryption for OAuth refresh tokens.
// Key is derived from GMAIL_TOKEN_ENCRYPTION_KEY.
// ============================================

const crypto = require('crypto');

// Derive a fixed 32-byte AES key from an arbitrary-length secret string.
function deriveKey(rawSecret) {
  const raw = String(rawSecret || '');
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest();
}

// ── Support mailbox key (unchanged) ─────────────────────────────────────────
function getEncryptionKey() {
  return deriveKey(process.env.GMAIL_TOKEN_ENCRYPTION_KEY);
}

// ── Payment mailbox key ─────────────────────────────────────────────────────
// The dedicated payment mailbox uses its own encryption key so the payment
// credential can be rotated independently of the support mailbox. It falls back
// to GMAIL_TOKEN_ENCRYPTION_KEY so a deploy that only sets the shared key keeps
// working. The key lives ONLY in the server env — never in Supabase, the
// browser, or Git.
function getPaymentEncryptionKey() {
  return deriveKey(
    process.env.PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY || process.env.GMAIL_TOKEN_ENCRYPTION_KEY
  );
}

// Core AES-256-GCM primitives, parameterised by the derived key buffer.
function encryptWithKey(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join('.');
}

function decryptWithKey(key, payload) {
  try {
    if (!key || typeof payload !== 'string') return null;
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const iv = Buffer.from(parts[1], 'base64');
    const authTag = Buffer.from(parts[2], 'base64');
    const encrypted = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

/**
 * Encrypt a plaintext secret with the SUPPORT mailbox key.
 * Returns "v1.<iv>.<authTag>.<ciphertext>" (base64 parts).
 * Throws if no encryption key is configured — tokens must never be stored in plaintext.
 */
function encryptSecret(plaintext) {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY is not configured.');
  }
  return encryptWithKey(key, plaintext);
}

/**
 * Decrypt a value produced by encryptSecret() (support mailbox key). Returns null on failure.
 */
function decryptSecret(payload) {
  return decryptWithKey(getEncryptionKey(), payload);
}

/**
 * Encrypt a plaintext secret with the PAYMENT mailbox key. Throws if neither
 * PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY nor GMAIL_TOKEN_ENCRYPTION_KEY is set.
 */
function encryptPaymentSecret(plaintext) {
  const key = getPaymentEncryptionKey();
  if (!key) {
    throw new Error(
      'PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY (or GMAIL_TOKEN_ENCRYPTION_KEY) is not configured.'
    );
  }
  return encryptWithKey(key, plaintext);
}

/**
 * Decrypt a value produced by encryptPaymentSecret(). Returns null on failure.
 */
function decryptPaymentSecret(payload) {
  return decryptWithKey(getPaymentEncryptionKey(), payload);
}

/** True when the payment mailbox encryption key is configured. */
function isPaymentKeyConfigured() {
  return Boolean(getPaymentEncryptionKey());
}

/**
 * Generate a strong random key for GMAIL_TOKEN_ENCRYPTION_KEY /
 * PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY (setup helper).
 */
function generateKey() {
  return crypto.randomBytes(32).toString('base64');
}

module.exports = {
  encryptSecret,
  decryptSecret,
  encryptPaymentSecret,
  decryptPaymentSecret,
  isPaymentKeyConfigured,
  generateKey,
};
