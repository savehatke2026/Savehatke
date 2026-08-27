// ============================================
// SaveHatke — one-time Google Drive authorization
// ============================================
// Mints GOOGLE_DRIVE_REFRESH_TOKEN so coupon proof screenshots are uploaded
// into YOUR Drive (service accounts have no storage quota of their own).
//
// Usage:
//   cd server
//   node scripts/authorize-drive.js
//
// Requires in .env: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (or the
// GOOGLE_DRIVE_* variants) and a redirect URI registered in Google Cloud
// Console. Uses GOOGLE_REDIRECT_URI when set.
// ============================================

const path = require('path');
const http = require('http');
const readline = require('readline');
const { URL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { google } = require('googleapis');

// Full `drive` scope is needed because GOOGLE_DRIVE_FOLDER_ID points at a
// folder created by hand in the browser. The narrower `drive.file` scope only
// grants access to files/folders this app created itself, so uploading into an
// existing folder would fail with "File not found: <folderId>".
const SCOPES = ['https://www.googleapis.com/auth/drive'];

function clean(v) {
  return String(v || '').trim().replace(/^["']|["']$/g, '');
}

const CLIENT_ID = clean(process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID);
const CLIENT_SECRET = clean(
  process.env.GOOGLE_DRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET
);
const REDIRECT_URI =
  clean(process.env.GOOGLE_REDIRECT_URI) || 'http://localhost:3000/api/admin/gmail/callback';
const FOLDER_ID = clean(process.env.GOOGLE_DRIVE_FOLDER_ID);

function fail(msg) {
  console.error('\n[authorize-drive] ' + msg + '\n');
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  fail('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing from .env');
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
  include_granted_scopes: false,
});

// Extract code from either a raw code or a full redirect URL pasted by the user.
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

// Try to auto-capture the code by briefly listening on the redirect's port.
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
          ? '<h2>SaveHatke Drive authorized</h2><p>You can close this tab and return to the terminal.</p>'
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
  console.log('\n=== SaveHatke Google Drive authorization ===');
  console.log('Redirect URI :', REDIRECT_URI);
  console.log('Scope        :', SCOPES.join(' '));
  console.log('Folder ID    :', FOLDER_ID || '(not set — add GOOGLE_DRIVE_FOLDER_ID to .env)');
  console.log('\n1. Make sure the redirect URI above is registered in Google Cloud Console');
  console.log('   (APIs & Services > Credentials > your OAuth client > Authorized redirect URIs).');
  console.log('2. Open this URL in a browser and sign in with the account that owns the folder:\n');
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
      'Google did not return a refresh token. Revoke the app at ' +
        'https://myaccount.google.com/permissions and run this script again.'
    );
  }

  // Sanity check: can this account see the target folder?
  oauth2.setCredentials(tokens);
  if (FOLDER_ID) {
    try {
      const drive = google.drive({ version: 'v3', auth: oauth2 });
      const meta = await drive.files.get({ fileId: FOLDER_ID, fields: 'id, name, mimeType' });
      console.log(`\nFolder check OK: "${meta.data.name}" (${meta.data.mimeType})`);
    } catch (e) {
      console.warn(
        '\nFolder check skipped/failed: ' +
          e.message +
          '\n(With the drive.file scope this is expected until the app creates a file there.)'
      );
    }
  }

  console.log('\nAdd this line to your .env (root of the project):\n');
  console.log('GOOGLE_DRIVE_REFRESH_TOKEN=' + tokens.refresh_token);
  console.log('\nThen restart the server. Done.\n');
})();
