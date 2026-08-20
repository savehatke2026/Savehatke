// ============================================
// SaveHatke — Gmail Token Encryption
// AES-256-GCM encryption for OAuth refresh tokens.
// Key is derived from GMAIL_TOKEN_ENCRYPTION_KEY.
// ============================================

const crypto = require('crypto');

function getEncryptionKey() {
  const raw = process.env.GMAIL_TOKEN_ENCRYPTION_KEY || '';
  if (!raw) return null;
  // Derive a fixed 32-byte key regardless of the configured secret length
  return crypto.createHash('sha256').update(String(raw)).digest();
}

/**
 * Encrypt a plaintext secret. Returns "v1.<iv>.<authTag>.<ciphertext>" (base64 parts).
 * Throws if no encryption key is configured — tokens must never be stored in plaintext.
 */
function encryptSecret(plaintext) {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY is not configured.');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join('.');
}

/**
 * Decrypt a value produced by encryptSecret(). Returns null on any failure.
 */
function decryptSecret(payload) {
  try {
    const key = getEncryptionKey();
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
 * Generate a strong random key for GMAIL_TOKEN_ENCRYPTION_KEY (setup helper).
 */
function generateKey() {
  return crypto.randomBytes(32).toString('base64');
}

module.exports = { encryptSecret, decryptSecret, generateKey };
