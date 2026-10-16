// The fail-closed 2FA gate is gone, and nothing may put one back.
//
// This file used to pin the OPPOSITE behaviour: "if the 2FA status store cannot
// be read, refuse the sign-in." That gate existed so a Sheets outage could never
// be mistaken for "2FA is off". With the feature disabled there is no status to
// read and no gate to fail, so the guarantee inverts:
//
//   a failure to read ANY two-factor state must no longer be able to block
//   sign-in, withhold a session, or push the user onto a setup screen.
//
// The behavioural proof is a store that throws on every read of the two-factor
// tab while everything else keeps working. Under the old gate that single
// failing read returned 503 and no cookie. Now the sign-in must simply work —
// which is the correct outcome when the feature does not exist.
//
// Nothing external is contacted: the Google token exchange is stubbed at the
// OAuth2Client prototype, Supabase and Sheets are in-memory, mail is stubbed.
const assert = require('assert');
const http = require('http');

process.env.JWT_SECRET = 'test-secret-no2fa-failclosed-0123456789abcdef';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://savehatke.test/api/auth/google-redirect';

const express = require('express');
const { OAuth2Client } = require('google-auth-library');

const db = require('../services/googleSheets');
const supabase = require('../services/supabase');
const emailService = require('../services/emailService');
const deviceRecognition = require('../services/deviceRecognition');

let identity = null;
OAuth2Client.prototype.getToken = async () => ({ tokens: { id_token: 'stub-id-token' } });
OAuth2Client.prototype.verifyIdToken = async () => ({
  getPayload: () => identity,
  getIssuer: () => identity.iss,
  getAudience: () => 'test-client-id.apps.googleusercontent.com',
});

const authRouter = require('../routes/auth');
const security = require('../config/security');

let pass = 0;
const ok = (label) => { pass++; console.log('  ok  ' + label); };

const USER = { id: 'u-fc', email: 'failclosed-test@example.com', sub: 'google-sub-fc' };
const UA = 'NoTwoFactorFailClosed/1.0';

// Sheets that behave normally, EXCEPT the two-factor tab, which always fails.
// `twoFactorReads` counts the attempts so the test can prove the failure path is
// genuinely exercised (a test that never triggers the fault proves nothing).
let twoFactorReads = 0;
const sheets = new Map();
const TWO_FACTOR_TAB = 'UserTwoFactor';
const isTwoFactorTab = (sheet) => String(sheet).toLowerCase().indexOf('twofactor') !== -1;
const row = (sheet) => sheets.get(sheet) || [];

db.SHEETS = db.SHEETS || {};
const guard = (sheet) => {
  if (isTwoFactorTab(sheet)) { twoFactorReads += 1; throw new Error('Sheets API 503 UNAVAILABLE'); }
  return sheet;
};
db.findRow = async (sheet, field, value) => {
  guard(sheet);
  const want = String(value == null ? '' : value).trim().toLowerCase();
  if (field === 'email') {
    return row(sheet).find((r) => String(r.email || '').trim().toLowerCase() === want) || null;
  }
  return row(sheet).find((r) => String(r[field] || '') === String(value)) || null;
};
db.findRows = async (sheet) => { guard(sheet); return [...row(sheet)]; };
db.getRows = async (sheet) => { guard(sheet); return [...row(sheet)]; };
db.appendRow = async (sheet, data) => {
  guard(sheet);
  if (!sheets.has(sheet)) sheets.set(sheet, []);
  sheets.get(sheet).push({ ...data });
  return data;
};
db.updateRow = async (sheet, field, value, updates) => {
  guard(sheet);
  const cur = await db.findRow(sheet, field, value);
  if (cur) Object.assign(cur, updates);
  return cur;
};

let createdSessions = [];
supabase.isConfigured = () => true;
supabase.getAdminAllowlist = async () => ([]);
supabase.createSession = async (input) => {
  createdSessions.push(input);
  return {
    session_id: `sess-${createdSessions.length}`,
    session_token: input.session_token,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
};
supabase.createUser = async () => ({});
supabase.updateUser = async () => ({});
supabase.findSessionByToken = async () => null;
supabase.getAccountSessionHistory = async () => ([]);
supabase.endSessionByToken = async () => ({});

deviceRecognition.evaluateSignInDevice = async () => ({
  isNewDevice: false, evaluated: true, reason: 'known device', previousSessions: [],
});

const mail = [];
for (const fn of ['sendOTPEmail', 'sendSignInAlertEmail']) {
  if (typeof emailService[fn] !== 'function') continue;
  const stub = async (args) => { mail.push({ fn, to: (args || {}).to }); return { success: true, simulated: true }; };
  emailService[fn] = stub;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/auth', authRouter);

let server = null;
function raw(method, path, { body, cookie, ua } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { 'User-Agent': ua || UA };
    if (cookie) headers.Cookie = cookie;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let parsed = out;
        try { parsed = JSON.parse(out); } catch (e) { /* html */ }
        resolve({ status: res.statusCode, body: parsed, raw: out, headers: res.headers, setCookie: res.headers['set-cookie'] || [] });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const cookieValue = (setCookie, name) => {
  for (const c of setCookie || []) if (String(c).startsWith(`${name}=`)) return String(c).split(';')[0];
  return '';
};
const sessionCookie = (r) => cookieValue(r.setCookie, 'sh_session');

async function googleLogin(as) {
  identity = null;
  const start = await raw('GET', '/api/auth/google-redirect');
  const state = new URL(String(start.headers.location || '')).searchParams.get('state') || '';
  const stateCookie = cookieValue(start.setCookie, 'sh_oauth_state')
    || cookieValue(start.setCookie, 'sh_google_oauth_state')
    || (start.setCookie[0] || '').split(';')[0];
  identity = {
    sub: as.sub, email: as.email, email_verified: true, iss: 'accounts.google.com',
    iat: Math.floor(Date.now() / 1000), name: 'Fail Closed Test', picture: '',
    nonce: JSON.parse(Buffer.from(String(stateCookie).split('=')[1].split('.')[0], 'base64url').toString()).nonce,
  };
  const res = await raw('GET', `/api/auth/google-redirect?code=stub-code&state=${encodeURIComponent(state)}`, {
    cookie: stateCookie,
  });
  identity = null;
  return res;
}

(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await security.ensureAdminRosterReady();

  sheets.set(db.SHEETS.USERS, [{
    user_id: USER.id, id: USER.id, email: USER.email, name: 'Fail Closed Test',
    username: 'failclosedtest', google_sub: USER.sub, status: 'active', preferred_name: 'Fail Closed Test',
  }]);
  // A row that exists but can never be read: this is the fault the old gate
  // turned into a refused login.
  sheets.set(TWO_FACTOR_TAB, [{
    userId: USER.id, email: USER.email, enabled: 'true',
    secretEncrypted: 'v1:stale:0000', recoveryCodes: '[]', lastCounter: '',
  }]);

  // ── 1. A complete 2FA-store outage does not block sign-in ───────────────
  const before = createdSessions.length;
  let res = await googleLogin(USER);
  assert.strictEqual(res.status, 200,
    `sign-in must succeed while the 2FA store is unreadable, got ${res.status}: ${String(res.raw).slice(0, 200)}`);
  assert.ok(sessionCookie(res), 'an unreadable 2FA store must not withhold the session cookie');
  assert.ok(res.raw.includes("localStorage.setItem('sh_authenticated'"), 'the user must be marked signed in');
  assert.ok(!/two.?factor|challengeToken|twoFactorRequired/i.test(String(res.raw)),
    'no two-factor message may reach the page');
  assert.strictEqual(createdSessions.length, before + 1, 'exactly one session row must be created');
  assert.strictEqual(createdSessions[createdSessions.length - 1].google_sub, USER.sub,
    'the session row must carry the verified Google subject');
  ok('1. an unreadable 2FA store cannot fail a sign-in closed (200, cookie, one session row)');

  // ── 2. …and the gate is genuinely absent, not merely unused ────────────
  // Nothing on the login path may consult two-factor state at all. If the fault
  // were never read, the test above would pass for the wrong reason.
  assert.strictEqual(twoFactorReads, 0,
    `the sign-in path must not read two-factor state at all (saw ${twoFactorReads} read(s))`);
  ok('2. the sign-in path never reads two-factor state, so there is no gate left to fail');

  // ── 3. Repeated sign-ins are unaffected by the dead store ───────────────
  for (let i = 0; i < 3; i += 1) {
    const n = createdSessions.length;
    res = await googleLogin(USER);
    assert.strictEqual(res.status, 200, `retry ${i + 1} -> ${res.status}`);
    assert.ok(sessionCookie(res), `retry ${i + 1} must mint a session cookie`);
    assert.strictEqual(createdSessions.length, n + 1, `retry ${i + 1} must create exactly one session`);
  }
  assert.strictEqual(twoFactorReads, 0, 'no retry may read two-factor state either');
  ok('3. repeated sign-ins succeed identically — no retry, no lockout, no second factor');

  // ── 4. The endpoints that used to expose this all 404 ───────────────────
  for (const p of ['/api/auth/2fa/status', '/api/auth/2fa/login', '/api/auth/2fa/setup/start', '/api/auth/2fa/setup/enable']) {
    const out = await raw('POST', p, { body: {} });
    assert.strictEqual(out.status, 404, `${p} must 404, got ${out.status}`);
    assert.ok(!sessionCookie(out), `${p} must not set a session cookie`);
  }
  ok('4. every former 2FA endpoint is gone and mints nothing');

  assert.ok(mail.every((m) => /^[^@]+@example\.com$/i.test(String(m.to))),
    `no notice may address a real account: ${JSON.stringify(mail)}`);
  ok('no mail left this process');

  server.close();
  console.log(`\ntwoFactorFailClosed (no 2FA gate): ${pass} passed, 0 failed`);
})().catch((e) => {
  console.error(`twoFactorFailClosed (no 2FA gate): FAILED after ${pass} — ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
  try { if (server) server.close(); } catch (e2) { /* ignore */ }
  process.exitCode = 1;
});