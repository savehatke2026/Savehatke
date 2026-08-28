// ============================================
// SaveHatke — one-time Support Mailbox (Gmail) authorization
// ============================================
// Mints GMAIL_REFRESH_TOKEN so the Admin Panel → Support Mailbox can read and
// send mail as the support account (support.savehatke@gmail.com) WITHOUT any
// database. The server only ever needs this one refresh token.
//
// Usage:
//   cd server
//   node scripts/authorize-gmail.js
//
// Requires in .env: GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET (or the shared
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) and a redirect URI registered in
// Google Cloud Console (APIs & Services → Credentials → your OAuth client).
//
// NOTE: stop the dev server first if it occupies the redirect port, otherwise
// this script cannot capture the code automatically and you'll have to paste
// the redirect URL by hand.
// ============================================

const path = require('path');
const http = require('http');
const readline = require('readline');
const { URL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { google } = require('googleapis');

// gmail.modify = read / send / labels / trash, without full-account access.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
];

function clean(v) {
  return String(v || '').trim().replace(/^["']|["']$/g, '');
}

const CLIENT_ID = clean(process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID);
const CLIENT_SECRET = clean(process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET);
const REDIRECT_URI =
  clean(process.env.GOOGLE_REDIRECT_URI) || 'http://localhost:3000/api/admin/gmail/callback';
const EXPECTED = clean(process.env.GMAIL_SUPPORT_EMAIL || process.env.SUPPORT_EMAIL).toLowerCase();

function fail(msg) {
  console.error('\n[authorize-gmail] ' + msg + '\n');
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  fail('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET (or GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) missing from .env');
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // always return a refresh token
  scope: SCOPES,
  include_granted_scopes: false,
});

// Accept either a bare code or the full redirect URL pasted from the browser.
function parseCode(raw) {
  const input = String(raw || '').trim();
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

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Briefly listen on the redirect's port to capture the code automatically.
function waitForCallback() {
  let target;
  try {
    target = new URL(REDIRECT_URI);
  } catch {
    return Promise.resolve(null);
  }
  if (!/^(localhost|127\.0\.0\.1)$/.test(target.hostname)) return Promise.resolve(null);

  const port = Number(target.port || 80);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const code = new URL(req.url, `http://${target.hostname}:${port}`).searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        code
          ? '<h2>SaveHatke support mailbox authorized</h2><p>You can close this tab and return to the terminal.</p>'
          : '<h2>No authorization code found</h2><p>Copy the full URL from the address bar into the terminal.</p>'
      );
      server.close();
      resolve(code || null);
    });
    server.on('error', () => resolve(null)); // port busy (dev server running)
    server.listen(port, () => {
      console.log(`Listening on ${target.origin} to capture the code automatically...`);
    });
  });
}

(async () => {
  console.log('\n=== SaveHatke Support Mailbox authorization (no database) ===');
  console.log('Redirect URI  :', REDIRECT_URI);
  console.log('Scopes        :', SCOPES.join(' '));
  console.log('Support inbox :', EXPECTED || '(SUPPORT_EMAIL not set — any Gmail account will be accepted)');
  console.log('\n1. Make sure the redirect URI above is registered in Google Cloud Console');
  console.log('   (APIs & Services > Credentials > your OAuth client > Authorized redirect URIs).');
  console.log('2. Open this URL and sign in with the SUPPORT mailbox account:\n');
  console.log(authUrl + '\n');
  console.log('3. After approving you land on the redirect URL. If it is not captured');
  console.log('   automatically, copy the FULL address-bar URL and paste it below.\n');

  const captured = await waitForCallback();
  const raw = captured || (await ask('Paste the redirect URL (or just the code): '));
  const code = parseCode(raw);
  if (!code) fail('No authorization code provided.');

  let tokens;
  try {
    ({ tokens } = await oauth2.getToken(code));
  } catch (e) {
    fail('Code exchange failed: ' + (e.response?.data?.error_description || e.message));
  }

  if (!tokens.refresh_token) {
    fail(
      'Google did not return a refresh token. Remove SaveHatke at ' +
        'https://myaccount.google.com/permissions and run this script again.'
    );
  }

  // Confirm which mailbox was actually authorized.
  oauth2.setCredentials(tokens);
  let address = '';
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    address = String(profile.data.emailAddress || '').toLowerCase();
    console.log(`\nAuthorized mailbox: ${address} (${profile.data.messagesTotal} messages)`);
  } catch (e) {
    console.warn('\nCould not read the Gmail profile: ' + e.message);
  }

  if (EXPECTED && address && address !== EXPECTED) {
    console.warn(
      `\n⚠️  WARNING: you authorized ${address} but SUPPORT_EMAIL is ${EXPECTED}.` +
        '\n   The Admin Panel would then manage the wrong mailbox. Re-run and pick the support account.'
    );
  }

  console.log('\nAdd this line to your .env (project root) and to Vercel →');
  console.log('Project → Settings → Environment Variables:\n');
  console.log('GMAIL_REFRESH_TOKEN=' + tokens.refresh_token);
  console.log('\nThen restart / redeploy the server. The Support Mailbox will be');
  console.log('connected on every boot — no database, no re-consent.\n');
})();
