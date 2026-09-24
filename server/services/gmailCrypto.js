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
  return getCredentialEncryptionKey();
}

// ── Generic security-credentials key ────────────────────────────────────────
// public.security_credentials now stores MORE than the payment mailbox (also
// the Google Drive OAuth credential), so the encryption key has a generic,
// non-payment-specific preferred name: SECURITY_CREDENTIALS_ENCRYPTION_KEY.
// For backward compatibility (and to avoid breaking a live deploy) it falls
// back to the existing PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY, then to the shared
// GMAIL_TOKEN_ENCRYPTION_KEY. All three derive the SAME 32-byte AES key from
// the same secret string, so a value set under any name decrypts the same data.
// The key lives ONLY in the server env — never in Supabase, the browser, or Git.
function getCredentialEncryptionKey() {
  return deriveKey(
    process.env.SECURITY_CREDENTIALS_ENCRYPTION_KEY ||
    process.env.PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY ||
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY
  );
}

// The three key names above are meant to be aliases for the SAME secret, and a
// value encrypted under one is supposed to decrypt under any. In practice a
// deployment may have set them to DIFFERENT secret strings and stored a token
// under one of them (e.g. the google_drive token encrypted with
// GMAIL_TOKEN_ENCRYPTION_KEY while PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY — which
// wins the precedence above — holds a different value). Encryption always uses
// the single preferred key, but DECRYPTION must try every configured key so an
// existing, still-valid token keeps round-tripping instead of silently
// returning null (which drops the whole integration to a broken fallback).
function getCredentialKeyCandidates() {
  const raws = [
    process.env.SECURITY_CREDENTIALS_ENCRYPTION_KEY,
    process.env.PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY,
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY,
  ];
  const seen = new Set();
  const keys = [];
  for (const raw of raws) {
    const s = String(raw || '');
    if (!s || seen.has(s)) continue; // skip empty and duplicate secrets
    seen.add(s);
    const key = deriveKey(s);
    if (key) keys.push(key);
  }
  return keys;
}

// Try each candidate key in turn; the AES-GCM auth tag guarantees only the
// correct key yields a value, so a wrong key just returns null and we move on.
function decryptWithAnyKey(keys, payload) {
  for (const key of keys) {
    const out = decryptWithKey(key, payload);
    if (out) return out;
  }
  return null;
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
 * Tries every configured credential key so a token encrypted under any accepted
 * alias still round-trips.
 */
function decryptPaymentSecret(payload) {
  return decryptWithAnyKey(getCredentialKeyCandidates(), payload);
}

/** True when the payment mailbox encryption key is configured. */
function isPaymentKeyConfigured() {
  return Boolean(getCredentialEncryptionKey());
}

// ── Generic security-credentials encrypt/decrypt ────────────────────────────
// Preferred names for the multi-service security_credentials table. They are
// exact aliases of encryptPaymentSecret/decryptPaymentSecret (same key, same
// AES-256-GCM format) so a value encrypted under either name round-trips.
function encryptCredentialSecret(plaintext) {
  const key = getCredentialEncryptionKey();
  if (!key) {
    throw new Error(
      'SECURITY_CREDENTIALS_ENCRYPTION_KEY (or PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY / GMAIL_TOKEN_ENCRYPTION_KEY) is not configured.'
    );
  }
  return encryptWithKey(key, plaintext);
}

function decryptCredentialSecret(payload) {
  return decryptWithAnyKey(getCredentialKeyCandidates(), payload);
}

/** True when the generic credential encryption key is configured. */
function isCredentialKeyConfigured() {
  return Boolean(getCredentialEncryptionKey());
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
  encryptCredentialSecret,
  decryptCredentialSecret,
  isCredentialKeyConfigured,
  generateKey,
};
