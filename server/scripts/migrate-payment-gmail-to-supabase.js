// ============================================
// SaveHatke — One-time migration: PAYMENT_GMAIL_REFRESH_TOKEN → Supabase
// ============================================
// Encrypts the EXISTING payment-mailbox refresh token (currently in the
// PAYMENT_GMAIL_REFRESH_TOKEN environment variable) and UPSERTs it into the
// Supabase `security_credentials` table (renamed from
// `payment_mailbox_credentials`). Run this ONCE after applying the rename
// migration SQL, then remove PAYMENT_GMAIL_REFRESH_TOKEN from the environment
// (local + Vercel).
//
// SECURITY:
//   * The refresh token is NEVER printed to stdout/stderr.
//   * It is stored only AES-256-GCM encrypted (PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY,
//     falling back to GMAIL_TOKEN_ENCRYPTION_KEY).
//
// Usage (from the project root):
//   node server/scripts/migrate-payment-gmail-to-supabase.js
//
// Requires in the environment:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY (or GMAIL_TOKEN_ENCRYPTION_KEY)
//   PAYMENT_GMAIL_REFRESH_TOKEN        (the token being migrated)
//   PAYMENT_MAILBOX_EMAIL              (defaults to rupayandas2025@gmail.com)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { decryptSecret, isPaymentKeyConfigured } = require('../services/gmailCrypto');
const store = require('../services/paymentMailboxStore');

const DEFAULT_EMAIL = 'rupayandas2025@gmail.com';

function clean(v) {
  return String(v || '').trim().replace(/^["']|["']$/g, '');
}

function fail(msg) {
  console.error('\n[migrate-payment-gmail-to-supabase] ' + msg + '\n');
  process.exit(1);
}

function resolveEnvToken() {
  const raw = clean(process.env.PAYMENT_GMAIL_REFRESH_TOKEN);
  if (!raw) return '';
  // Accept both an encrypted "v1.<...>" blob (support-key encrypted) and the
  // raw Google refresh token. We never print either form.
  if (raw.startsWith('v1.')) return decryptSecret(raw) || '';
  return raw;
}

(async () => {
  console.log('\n=== SaveHatke: migrate payment Gmail token → Supabase ===');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    fail('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set. Cannot reach Supabase.');
  }
  if (!store.isReady()) {
    fail('Supabase client is not ready (check SUPABASE_URL / SUPABASE_SERVICE_KEY).');
  }
  if (!isPaymentKeyConfigured()) {
    fail('PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY (or GMAIL_TOKEN_ENCRYPTION_KEY) is not set. Refusing to store a token unencrypted.');
  }

  const token = resolveEnvToken();
  if (!token) {
    fail('PAYMENT_GMAIL_REFRESH_TOKEN is empty or could not be decrypted. Nothing to migrate. ' +
      'If it is a "v1." blob, ensure GMAIL_TOKEN_ENCRYPTION_KEY matches the one used to encrypt it.');
  }

  const email = (clean(process.env.PAYMENT_MAILBOX_EMAIL) || DEFAULT_EMAIL).toLowerCase();

  try {
    await store.upsertCredential({ email, refresh_token: token });
  } catch (e) {
    // e.message is a Supabase/crypto error — it does not contain the token.
    fail('Upsert into Supabase failed: ' + e.message);
  }

  const status = await store.getSafeStatus(email);
  console.log('\n✅ Migrated. Supabase is now the source of truth for the payment mailbox.');
  console.log('   Email        :', status.email);
  console.log('   Status       :', status.status);
  console.log('   Connected at :', status.connectedAt);
  console.log('   Authorized at:', status.authorizedAt);
  console.log('   Est. expiry  :', status.estimatedExpiresAt);
  console.log('   (the refresh token itself was NOT printed and is stored encrypted).');
  console.log('\nNext steps:');
  console.log('  1. Verify the admin panel shows "Connected" (Payment Gmail status).');
  console.log('  2. Remove PAYMENT_GMAIL_REFRESH_TOKEN from .env AND from Vercel → Settings → Environment Variables.');
  console.log('  3. Keep PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY set on the server (never commit it).\n');
  process.exit(0);
})().catch((e) => fail('Unexpected error: ' + e.message));
