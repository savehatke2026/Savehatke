// ============================================
// SaveHatke — One-time migration: GMAIL_REFRESH_TOKEN → Supabase
// ============================================
// Encrypts the EXISTING support-mailbox refresh token (currently in the
// GMAIL_REFRESH_TOKEN environment variable) and UPSERTs it into the Supabase
// `security_credentials` table as service='support_gmail' (the same store that
// already holds payment_gmail and google_drive). Run this ONCE after applying
// supabase/migrations/20261006_support_gmail_security_credentials.sql, verify
// the Support Mailbox still works, then remove GMAIL_REFRESH_TOKEN from the
// environment (local + Vercel).
//
// SECURITY:
//   * The refresh token is NEVER printed to stdout/stderr.
//   * It is stored only AES-256-GCM encrypted (SUPPORT_MAILBOX_TOKEN_ENCRYPTION_KEY,
//     falling back to GMAIL_TOKEN_ENCRYPTION_KEY).
//
// Usage (from the project root):
//   node server/scripts/migrate-support-gmail-to-supabase.js
//
// Requires in the environment:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   SUPPORT_MAILBOX_TOKEN_ENCRYPTION_KEY (or GMAIL_TOKEN_ENCRYPTION_KEY)
//   GMAIL_REFRESH_TOKEN                  (the token being migrated)
//   GMAIL_SUPPORT_EMAIL (or SUPPORT_EMAIL — the support mailbox address)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { decryptSecret, isSupportKeyConfigured } = require('../services/gmailCrypto');
const store = require('../services/supportMailboxStore');

function clean(v) {
  return String(v || '').trim().replace(/^["']|["']$/g, '');
}

function fail(msg) {
  console.error('\n[migrate-support-gmail-to-supabase] ' + msg + '\n');
  process.exit(1);
}

function resolveEnvToken() {
  const raw = clean(process.env.GMAIL_REFRESH_TOKEN);
  if (!raw) return '';
  // Accept both an encrypted "v1.<...>" blob (GMAIL_TOKEN_ENCRYPTION_KEY
  // encrypted, as the old token file flow produced) and the raw Google token.
  // We never print either form.
  if (raw.startsWith('v1.')) return decryptSecret(raw) || '';
  return raw;
}

(async () => {
  console.log('\n=== SaveHatke: migrate Support Mailbox token → Supabase ===');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    fail('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set. Cannot reach Supabase.');
  }
  if (!store.isReady()) {
    fail('Supabase client is not ready (check SUPABASE_URL / SUPABASE_SERVICE_KEY).');
  }
  if (!isSupportKeyConfigured()) {
    fail('SUPPORT_MAILBOX_TOKEN_ENCRYPTION_KEY (or GMAIL_TOKEN_ENCRYPTION_KEY) is not set. Refusing to store a token unencrypted.');
  }

  const token = resolveEnvToken();
  if (!token) {
    fail('GMAIL_REFRESH_TOKEN is empty or could not be decrypted. Nothing to migrate. ' +
      'If it is a "v1." blob, ensure GMAIL_TOKEN_ENCRYPTION_KEY matches the one used to encrypt it. ' +
      'Alternatively, reconnect the mailbox from Admin Panel → Support Mailbox (it stores the token in Supabase directly).');
  }

  const email = clean(process.env.GMAIL_SUPPORT_EMAIL || process.env.SUPPORT_EMAIL).toLowerCase();
  if (!email) {
    fail('The support mailbox address is unknown. Set GMAIL_SUPPORT_EMAIL (or SUPPORT_EMAIL) to the Gmail address of the support mailbox, then re-run.');
  }

  try {
    await store.saveSupportMailboxRefreshToken({ email, refresh_token: token });
  } catch (e) {
    // e.message is a Supabase/crypto error — it does not contain the token.
    fail('Upsert into Supabase failed: ' + e.message);
  }

  const status = await store.getSafeStatus(email);
  console.log('\n✅ Migrated. Supabase is now the source of truth for the Support Mailbox.');
  console.log('   Table        :', store.TABLE);
  console.log('   Email        :', status.email);
  console.log('   Status       :', status.status);
  console.log('   Connected at :', status.connectedAt);
  console.log('   (the refresh token itself was NOT printed and is stored encrypted).');
  console.log('\nNext steps:');
  console.log('  1. Verify the Support Mailbox works in the admin panel (read a message).');
  console.log('  2. Remove GMAIL_REFRESH_TOKEN from .env AND from Vercel → Settings → Environment Variables.');
  console.log('  3. Keep SUPPORT_MAILBOX_TOKEN_ENCRYPTION_KEY set on the server (never commit it).');
  console.log('  4. If the token was already rejected by Google (invalid_grant), reconnect from');
  console.log('     Admin Panel → Support Mailbox — the fresh token is stored in Supabase directly.\n');
  process.exit(0);
})().catch((e) => fail('Unexpected error: ' + e.message));
