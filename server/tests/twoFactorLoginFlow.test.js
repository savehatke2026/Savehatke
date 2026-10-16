// Sign-in completes with NO second factor.
//
// Two-factor authentication was disabled, so this file no longer exercises a
// challenge. It keeps the original rig — real HTTP, the real auth router, the
// real Google-callback handler, a stubbed OAuth client, in-memory Sheets and
// Supabase — and inverts the question the old suite asked:
//
//   old: "does an enrolled account get stopped at the second factor?"
//   now: "does sign-in finish on the first step, for every account?"
//
// The load-bearing case is the third one below: a STALE row left behind by the
// retired feature (enabled=true, secret present) must not be able to block
// sign-in, force a setup screen, or withhold a session. Obsolete configuration
// must never hold an account hostage.
//
// Nothing external is contacted: the Google token exchange is stubbed at the
// OAuth2Client prototype, Supabase is stubbed module-side, the Sheets store,
// device recognition and every mail sender are in-memory. No real account,
// session row or email is involved.
const assert = require('assert');
const http = require('http');

// ── Environment (fixed dummy values; must be set before the modules load) ──
process.env.JWT_SECRET = 'test-secret-no2fa-loginflow-0123456789abcdef';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://savehatke.test/api/auth/google-redirect';

const express = require('express');
const { OAuth2Client } = require('google-auth-library');

const db = require('../services/googleSheets');
const supabase = require('../services/supabase');
const emailService = require('../services/emailService');
const deviceRecognition = require('../services/deviceRecognition');

// ── Google token exchange ────────────────────────────────────────────────
// The only two calls that would touch the network. `identity` is swapped per
// scenario; the nonce is copied out of the state cookie the app just issued, so
// the real nonce/issuer/iat checks in the callback still run for real.
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
const ok = (label) => { pass++; console.log(`  ok  ${label}`); };

// ── Fixtures ─────────────────────────────────────────────────────────────
const USER = { id: 'u-login', email: 'login-test@example.com', sub: 'google-sub-user' };
const ADMIN = { id: 'adm-1', email: 'admin-test@example.com', sub: 'google-sub-admin' };
const UA = 'NoTwoFactorLoginFlow/1.0';

let createdSessions = [];
let healthy = true;
const sheets = new Map();
const row = (sheet) => sheets.get(sheet) || [];

db.SHEETS = db.SHEETS || {};
db.findRow = async (sheet, field, value) => {
  if (!healthy) throw new Error('Sheets API 503 UNAVAILABLE');
  const want = String(value == null ? '' : value).trim().toLowerCase();
  if (field === 'email') {
    return row(sheet).find((r) => String(r.email || '').trim().toLowerCase() === want) || null;
  }
  return row(sheet).find((r) => String(r[field] || '') === String(value)) || null;
};
db.findRows = async (sheet) => [...row(sheet)];
db.getRows = async (sheet) => [...row(sheet)];
db.appendRow = async (sheet, data) => {
  if (!healthy) throw new Error('Sheets API 503 UNAVAILABLE');
  if (!sheets.has(sheet)) sheets.set(sheet, []);
  sheets.get(sheet).push({ ...data });
  return data;
};
db.updateRow = async (sheet, field, value, updates) => {
  if (!healthy) throw new Error('Sheets API 503 UNAVAILABLE');
  const cur = await db.findRow(sheet, field, value);
  if (cur) Object.assign(cur, updates);
  return cur;
};

supabase.isConfigured = () => true;
supabase.getAdminAllowlist = async () => ([{ email: ADMIN.email, name: 'Admin Test', active: true, id: ADMIN.id }]);
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

// Mail must never leave this process. Only the senders the login path can
// actually reach are listed; a name that no longer exists must not be asserted
// on, so the final check enumerates what is really there.
const mail = [];
const NOTIFIERS = ['sendOTPEmail', 'sendSignInAlertEmail'];
for (const fn of NOTIFIERS) {
  if (typeof emailService[fn] !== 'function') continue;
  const stub = async (args) => { mail.push({ fn, to: (args || {}).to }); return { success: true, simulated: true }; };
  stub.__intercepted = true;
  emailService[fn] = stub;
}

// ── App + HTTP helper ────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);            // mirrors server.js:99
app.use(express.json());
// NOTE: no /api/auth/2fa mount — that is the point of this file.
app.use('/api/auth', authRouter);

let server = null;
function raw(method, path, { body, cookie, ip, spoof, ua } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { 'User-Agent': ua || UA };
    if (ip) headers['X-Vercel-Forwarded-For'] = ip;
    if (spoof) headers['X-Forwarded-For'] = spoof;
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
        try { parsed = JSON.parse(out); } catch (e) { /* html handoff */ }
        resolve({ status: res.statusCode, body: parsed, raw: out, headers: res.headers, setCookie: res.headers['set-cookie'] || [] });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const cookieValue = (setCookie, name) => {
  for (const c of setCookie || []) {
    if (String(c).startsWith(`${name}=`)) return String(c).split(';')[0];
  }
  return '';
};
const sessionCookie = (r) => cookieValue(r.setCookie, 'sh_session');

/** Run a whole Google sign-in: start the flow, then return the callback result. */
async function googleLogin(as, opts = {}) {
  identity = null;
  const start = await raw('GET', '/api/auth/google-redirect', opts);
  const location = String(start.headers.location || '');
  const state = new URL(location).searchParams.get('state') || '';
  const stateCookie = cookieValue(start.setCookie, 'sh_oauth_state')
    || cookieValue(start.setCookie, 'sh_google_oauth_state')
    || (start.setCookie[0] || '').split(';')[0];

  identity = {
    sub: as.sub,
    email: as.email,
    email_verified: true,
    iss: 'accounts.google.com',
    iat: Math.floor(Date.now() / 1000),
    name: as.name || 'Test User',
    picture: '',
    nonce: JSON.parse(Buffer.from(String(stateCookie).split('=')[1].split('.')[0], 'base64url').toString()).nonce,
  };
  const res = await raw('GET', `/api/auth/google-redirect?code=stub-code&state=${encodeURIComponent(state)}`, {
    cookie: stateCookie, ...opts,
  });
  identity = null;
  return res;
}

/** Nothing on the sign-in path may hand the page a second-factor challenge. */
const challengeFrom = (res) => {
  const m = String(res.raw).match(/sh_2fa_challenge|challengeToken|twoFactorRequired/);
  return m ? m[0] : '';
};

(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await security.ensureAdminRosterReady();

  sheets.set(db.SHEETS.USERS, [{
    user_id: USER.id, id: USER.id, email: USER.email, name: 'Login Test',
    username: 'logintest', google_sub: USER.sub, status: 'active', preferred_name: 'Login Test',
  }]);

  // ── 1. An ordinary account signs in on the first step ───────────────────
  let before = createdSessions.length;
  let res = await googleLogin(USER);
  assert.strictEqual(res.status, 200, `login -> ${res.status}`);
  assert.ok(sessionCookie(res), 'sign-in must mint a real session cookie');
  assert.ok(!challengeFrom(res), 'sign-in must never be handed a second factor');
  assert.ok(res.raw.includes("localStorage.setItem('sh_authenticated'"), 'the handoff must mark the user signed in');
  assert.ok(res.raw.includes("localStorage.setItem('sh_user'"), 'the handoff must carry the user profile');
  assert.ok(res.raw.includes('"/index"'), 'a user login must land on /index');
  assert.strictEqual(createdSessions.length, before + 1, 'exactly one session row must be created');
  assert.strictEqual(createdSessions[createdSessions.length - 1].google_sub, USER.sub,
    'the session row must carry the verified Google subject');
  ok('1. an ordinary account signs in directly: session cookie + exactly one session row, no second factor');

  // ── 2. The second-factor endpoints are simply not there ────────────────
  for (const [method, path] of [
    ['POST', '/api/auth/2fa/login'],
    ['GET', '/api/auth/2fa/status'],
    ['POST', '/api/auth/2fa/setup/start'],
    ['POST', '/api/auth/2fa/disable'],
  ]) {
    const out = await raw(method, path, { body: method === 'POST' ? {} : undefined });
    assert.strictEqual(out.status, 404, `${method} ${path} must 404, got ${out.status}`);
    assert.ok(!sessionCookie(out), `${method} ${path} must not set a session cookie`);
  }
  ok('2. every /api/auth/2fa endpoint is gone (404) and mints nothing');

  // ── 3. A stale enrolled row from the retired feature cannot block login ─
  //    This is the regression that matters: accounts enrolled before 2FA was
  //    disabled still carry a row saying enabled=true with a secret on file.
  //    It must be inert — sign-in completes, no challenge, no setup screen.
  const TWO_FACTOR_SHEET = 'UserTwoFactor';
  sheets.set(TWO_FACTOR_SHEET, [{
    userId: USER.id,
    email: USER.email,
    enabled: 'true',
    // A value that is not a usable secret on its own: the feature is gone, so
    // nothing should ever be trying to decrypt or verify with it.
    secretEncrypted: 'v1:stale-ciphertext:0000000000000000',
    pendingSecretEncrypted: '',
    pendingCreatedAt: '',
    recoveryCodes: '["ABCD-EFGH","IJKL-MNOP"]',
    lastCounter: '12345',
    enabledAt: '2026-01-02T03:04:05.000Z',
    disabledAt: '',
    lastUsedAt: '2026-01-02T03:04:05.000Z',
  }]);
  before = createdSessions.length;
  res = await googleLogin(USER);
  assert.strictEqual(res.status, 200, `stale-enrolment login -> ${res.status}`);
  assert.ok(sessionCookie(res), 'a stale 2FA row must not withhold the session cookie');
  assert.ok(!challengeFrom(res), 'a stale 2FA row must not produce a challenge');
  assert.ok(!/two.?factor/i.test(res.raw),
    'a stale 2FA row must not surface a two-factor message in the handoff');
  assert.ok(!/two.?factor|challengeToken|sh_2fa_challenge|authenticator/i.test(res.raw),
    'a stale 2FA row must not surface a two-factor, challenge or authenticator message in the handoff');
  assert.strictEqual(createdSessions.length, before + 1, 'exactly one session row after a stale-enrolment login');
  assert.strictEqual(createdSessions[createdSessions.length - 1].google_sub, USER.sub,
    'the session must still carry the verified Google subject');
  ok('3. a stale "2FA enabled" row is inert: sign-in completes with no challenge and no setup screen');
  sheets.delete(TWO_FACTOR_SHEET);

  // ── 4. An admin signs in on the first step, and still lands on /vault ────
  before = createdSessions.length;
  res = await googleLogin(ADMIN);
  assert.strictEqual(res.status, 200, `admin login -> ${res.status}`);
  assert.ok(sessionCookie(res), 'the admin login must mint a session cookie');
  assert.ok(!challengeFrom(res), 'the admin login must never be handed a second factor');
  assert.ok(res.raw.includes('"/vault"'), 'an admin login must land on /vault');
  assert.ok(res.raw.includes("localStorage.setItem('sh_admin_user'"), 'the admin profile must be handed over');
  assert.strictEqual(createdSessions.length, before + 1, 'one session row for the admin');
  assert.ok(/Google Admin/i.test(createdSessions[createdSessions.length - 1].login_method),
    'the admin session row must record the admin login method');
  ok('4. the admin Google login completes without a second factor and still lands on /vault');

  // ── 5. The rest of sign-in is unchanged by the removal ─────────────────
  //    An invalid state is still refused, and a bad identity still fails —
  //    the checks that used to sit alongside the 2FA gate must remain.
  const start = await raw('GET', '/api/auth/google-redirect');
  const beforeForged = createdSessions.length;
  const badState = await raw('GET', '/api/auth/google-redirect?code=stub-code&state=forged-state', {
    cookie: cookieValue(start.setCookie, 'sh_oauth_state') || (start.setCookie[0] || '').split(';')[0],
  });
  // The callback rejects a forged state by bouncing back to /login.html rather
  // than by error status, so assert the security property: no session, and the
  // user is never marked authenticated.
  assert.ok(badState.status >= 300 && badState.status < 400,
    `a forged OAuth state must be bounced, got ${badState.status}`);
  assert.ok(!sessionCookie(badState), 'a forged OAuth state must not set a session cookie');
  assert.ok(!/localStorage\.setItem\('sh_authenticated'/.test(String(badState.raw)),
    'a forged OAuth state must not mark the user authenticated');
  assert.strictEqual(createdSessions.length, beforeForged, 'a forged OAuth state must not create a session row');
  ok('5. OAuth state validation still refuses a forged callback (bounced, no cookie, no session row)');

  // Every sender the login path can reach must be one of the stubs above, and
  // every recorded notice must be addressed to a reserved example.com address.
  assert.ok(NOTIFIERS.every((fn) => emailService[fn] && emailService[fn].__intercepted),
    'every mail sender on the login path must be intercepted');
  assert.ok(mail.every((m) => /^[^@]+@example\.com$/i.test(String(m.to))),
    `no notice may address a real account: ${JSON.stringify(mail)}`);
  console.log(`  (${mail.length} security notice(s) intercepted: ${[...new Set(mail.map((m) => m.fn))].join(', ') || 'none'})`);
  ok('no mail left this process — every sender on the login path was intercepted');

  server.close();
  console.log(`twoFactorLoginFlow (no 2FA): ${pass} passed, 0 failed`);
})().catch((e) => {
  console.error(`twoFactorLoginFlow (no 2FA): FAILED after ${pass} — ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
  try { if (server) server.close(); } catch (e2) { /* ignore */ }
  process.exitCode = 1;
});