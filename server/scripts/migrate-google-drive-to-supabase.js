// ============================================
// SaveHatke — One-time migration: GOOGLE_DRIVE_REFRESH_TOKEN → Supabase
// ============================================
// Encrypts the EXISTING Google Drive refresh token (currently in the
// GOOGLE_DRIVE_REFRESH_TOKEN environment variable) and UPSERTs it into
// public.security_credentials as:
//     service = 'google_drive'
//     email   = database.savehatke@gmail.com
// Run this ONCE after applying the SQL migrations, then (after verifying Drive
// works from Supabase) remove GOOGLE_DRIVE_REFRESH_TOKEN from the environment.
//
// SECURITY:
//   * The refresh token is NEVER printed to stdout/stderr.
//   * It is stored only AES-256-GCM encrypted (SECURITY_CREDENTIALS_ENCRYPTION_KEY,
//     falling back to PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY / GMAIL_TOKEN_ENCRYPTION_KEY).
//
// Usage (from the project root):
//   node server/scripts/migrate-google-drive-to-supabase.js
//
// Requires in the environment:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   SECURITY_CREDENTIALS_ENCRYPTION_KEY (or PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY / GMAIL_TOKEN_ENCRYPTION_KEY)
//   GOOGLE_DRIVE_REFRESH_TOKEN         (the token being migrated)
//   GOOGLE_DRIVE_EMAIL                 (optional; defaults to database.savehatke@gmail.com)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isCredentialKeyConfigured } = require('../services/gmailCrypto');
const store = require('../services/securityCredentialsStore');

const DEFAULT_EMAIL = 'database.savehatke@gmail.com';
const SERVICE = store.SERVICES.GOOGLE_DRIVE;

function clean(v) {
  return String(v || '').trim().replace(/^["']|["']$/g, '');
}
function fail(msg) {
  console.error('\n[migrate-google-drive-to-supabase] ' + msg + '\n');
  process.exit(1);
}

(async () => {
  console.log('\n=== SaveHatke: migrate Google Drive token → Supabase ===');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    fail('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set. Cannot reach Supabase.');
  }
  if (!store.isReady()) {
    fail('Supabase client is not ready (check SUPABASE_URL / SUPABASE_SERVICE_KEY).');
  }
  if (!isCredentialKeyConfigured()) {
    fail('No credential encryption key set (SECURITY_CREDENTIALS_ENCRYPTION_KEY or PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY / GMAIL_TOKEN_ENCRYPTION_KEY). Refusing to store a token unencrypted.');
  }

  const token = clean(process.env.GOOGLE_DRIVE_REFRESH_TOKEN);
  if (!token || token.includes('YOUR_')) {
    fail('GOOGLE_DRIVE_REFRESH_TOKEN is empty/placeholder. Nothing to migrate. ' +
      'Mint one with `cd server && node scripts/authorize-drive.js` first, or reconnect from the admin panel.');
  }

  const email = (clean(process.env.GOOGLE_DRIVE_EMAIL) || DEFAULT_EMAIL).toLowerCase();

  try {
    await store.upsertCredential({ service: SERVICE, email, refresh_token: token, estimatedExpiresAt: null });
  } catch (e) {
    // e.message is a Supabase/crypto error — it does not contain the token.
    fail('Upsert into Supabase failed: ' + e.message);
  }

  const status = await store.getSafeStatus(SERVICE, email);
  console.log('\n✅ Google Drive credential migrated successfully.');
  console.log('   Service      : ' + SERVICE);
  console.log('   Email        : ' + status.email);
  console.log('   Status       : ' + status.status);
  console.log('   Connected at : ' + status.connectedAt);
  console.log('   Token        : stored securely (AES-256-GCM encrypted)');
  console.log('\nNext steps:');
  console.log('  1. Verify the admin Security section shows Google Drive → Connected.');
  console.log('  2. Test a Drive upload (coupon proof / support screenshot) end-to-end.');
  console.log('  3. Only then remove GOOGLE_DRIVE_REFRESH_TOKEN from .env AND Vercel → Settings → Environment Variables.');
  console.log('  4. Keep SECURITY_CREDENTIALS_ENCRYPTION_KEY (or the existing key) set on the server (never commit it).\n');
  process.exit(0);
})().catch((e) => fail('Unexpected error: ' + e.message));
