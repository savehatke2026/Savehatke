// ============================================
// SaveHatke — Payment Mailbox: exchange an OAuth code for a refresh token
// ============================================
// Companion to authorize-payment-gmail.js for environments where the localhost
// auto-capture listener cannot stay up (e.g. a non-interactive shell). You open
// the consent URL, approve, then pass the FULL redirect URL (or just the code)
// as an argument. This exchanges it, verifies the account, and writes
// PAYMENT_GMAIL_REFRESH_TOKEN directly into the project-root .env — the token is
// NEVER printed to stdout.
//
// Usage:
//   cd server
//   node scripts/exchange-payment-code.js "http://localhost:3000/api/admin/gmail/callback?code=..."
//   node scripts/exchange-payment-code.js "4/0Ab..."   (the bare code also works)
// ============================================

const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const ROOT_ENV = path.join(__dirname, '..', '..', '.env');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: ROOT_ENV });

const { google } = require('googleapis');

function clean(v) {
  return String(v || '').trim().replace(/^["']|["']$/g, '');
}

const CLIENT_ID = clean(
  process.env.PAYMENT_GMAIL_CLIENT_ID || process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID
);
const CLIENT_SECRET = clean(
  process.env.PAYMENT_GMAIL_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET
);
const REDIRECT_URI =
  clean(process.env.PAYMENT_GMAIL_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI) ||
  'http://localhost:3000/api/admin/gmail/callback';
const EXPECTED = clean(process.env.PAYMENT_MAILBOX_EMAIL || process.env.PAYMENT_GMAIL_EMAIL).toLowerCase();

function fail(msg) {
  console.error('\n[exchange-payment-code] ' + msg + '\n');
  process.exit(1);
}

function parseCode(raw) {
  const input = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!input) return '';
  if (input.startsWith('http://') || input.startsWith('https://')) {
    try {
      return new URL(input).searchParams.get('code') || '';
    } catch {
      return '';
    }
  }
  return input;
}

/** Set-or-insert KEY=VALUE in the .env text, preserving everything else. */
function upsertEnv(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  const sep = text.endsWith('\n') || text.length === 0 ? '' : '\n';
  return text + sep + line + '\n';
}

(async () => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    fail('PAYMENT_GMAIL_CLIENT_ID / PAYMENT_GMAIL_CLIENT_SECRET (or GMAIL_* / GOOGLE_* fallbacks) missing from .env');
  }

  const code = parseCode(process.argv[2]);
  if (!code) {
    fail('Pass the redirect URL (or the bare ?code= value) as the first argument, in quotes.');
  }

  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  let tokens;
  try {
    ({ tokens } = await oauth2.getToken(code));
  } catch (e) {
    fail(
      'Code exchange failed: ' +
        (e.response?.data?.error_description || e.message) +
        '\n   Auth codes are single-use and expire quickly — re-open the consent URL and try again with a FRESH code.'
    );
  }

  if (!tokens.refresh_token) {
    fail(
      'Google did not return a refresh token. Remove SaveHatke at ' +
        'https://myaccount.google.com/permissions and re-run the consent with prompt=consent.'
    );
  }

  // Confirm which mailbox was actually authorized.
  oauth2.setCredentials(tokens);
  let address = '';
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    address = String(profile.data.emailAddress || '').toLowerCase();
    console.log(`Authorized mailbox : ${address} (${profile.data.messagesTotal} messages)`);
  } catch (e) {
    console.warn('Could not read the Gmail profile: ' + e.message);
  }

  if (EXPECTED && address && address !== EXPECTED) {
    fail(
      `You authorized ${address}, but PAYMENT_MAILBOX_EMAIL is ${EXPECTED}. ` +
        'Not writing the token. Re-run the consent and sign in with the payment account.'
    );
  }

  // Write the token into the project-root .env without touching anything else.
  let envText = '';
  try {
    envText = fs.existsSync(ROOT_ENV) ? fs.readFileSync(ROOT_ENV, 'utf8') : '';
  } catch (e) {
    fail('Could not read .env: ' + e.message);
  }

  let next = upsertEnv(envText, 'PAYMENT_GMAIL_REFRESH_TOKEN', tokens.refresh_token);
  if (address && !EXPECTED) {
    next = upsertEnv(next, 'PAYMENT_MAILBOX_EMAIL', address);
  }

  try {
    fs.writeFileSync(ROOT_ENV, next, { encoding: 'utf8' });
  } catch (e) {
    fail('Could not write .env: ' + e.message);
  }

  console.log('\n✅ PAYMENT_GMAIL_REFRESH_TOKEN written to ' + ROOT_ENV);
  console.log('   (the token value itself was not printed).');
  console.log('\nNext: add the same PAYMENT_GMAIL_REFRESH_TOKEN to the Vercel project env, then restart / redeploy.\n');
})();
