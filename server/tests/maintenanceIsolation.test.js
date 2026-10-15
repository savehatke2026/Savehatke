// Maintenance-mode response isolation (mocked, no network, no real data).
// Run: node server/tests/maintenanceIsolation.test.js
//
// Proves that the maintenance guard decides per caller, not per URL, so a
// response built for one caller can never be served to another:
//   - maintenance OFF  → everyone passes
//   - maintenance ON   → anonymous and normal users get 503 MAINTENANCE_MODE
//   - maintenance ON   → admin and whitelisted users pass
//   - the 503 and the 200 for the SAME URL differ, so a shared cache keyed on
//     URL alone would be unsafe. /api/coupons therefore stays uncached.

const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const SERVER = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(() => Promise.resolve().then(fn).then(
    () => { passed += 1; console.log('  ok   ' + name); },
    (e) => { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); },
  ));
}

// ── Stubs ────────────────────────────────────────────────────────────────────
// `state` is mutated per test. Session cookies map to users.
const state = { maintenance: { enabled: false, message: 'Back soon.' }, whitelist: [] };
const SESSIONS = {
  'tok-admin': { ok: true, user: { id: 'a1', email: 'admin@example.com', role: 'admin' } },
  'tok-user': { ok: true, user: { id: 'u1', email: 'user@example.com', role: 'user' } },
  'tok-white': { ok: true, user: { id: 'w1', email: 'vip@example.com', role: 'user' } },
};
const stub = (mod, exp) => {
  const p = require.resolve(mod);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
};
stub(path.join(SERVER, 'services', 'supabase.js'), {
  getMaintenanceMode: async () => state.maintenance,
  getMaintenanceWhitelist: async () => state.whitelist,
  isConfigured: () => true,
});
stub(path.join(SERVER, 'middleware', 'auth.js'), {
  SESSION_COOKIE_NAME: 'sh_session',
  validateSessionToken: async (tok) => SESSIONS[tok] || { ok: false },
  authenticateToken: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  optionalAuth: (req, res, next) => next(),
});
stub(path.join(SERVER, 'config', 'security.js'), {
  isAuthorizedAdminEmail: (e) => String(e || '').toLowerCase() === 'admin@example.com',
});

const maintenanceGuard = require(path.join(SERVER, 'middleware', 'maintenance.js'));
const express = require(path.join(SERVER, '..', 'node_modules', 'express'));

const app = express();
app.get('/api/coupons', maintenanceGuard, (req, res) => {
  // Stands in for the real listing: the body is the same for every caller
  // that gets past the guard, which is exactly why the 503 must not be cached
  // separately from it.
  res.json({ coupons: [{ id: 'c1' }], total: 1 });
});

const server = app.listen(0, '127.0.0.1');
let port = 0;
server.on('listening', () => { port = server.address().port; });

function get(urlPath, token) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Cookie = `sh_session=${token}`;
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || 'null'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const reset = () => {
  state.maintenance = { enabled: false, message: 'Back soon.' };
  state.whitelist = [];
};

check('maintenance OFF: anonymous gets 200', async () => {
  reset();
  const r = await get('/api/coupons');
  assert.equal(r.status, 200);
});

check('maintenance ON: anonymous gets 503 MAINTENANCE_MODE', async () => {
  reset();
  state.maintenance = { enabled: true, message: 'Back soon.' };
  const r = await get('/api/coupons');
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'MAINTENANCE_MODE');
});

check('maintenance ON: normal logged-in user gets 503', async () => {
  reset();
  state.maintenance = { enabled: true, message: 'Back soon.' };
  const r = await get('/api/coupons', 'tok-user');
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'MAINTENANCE_MODE');
});

check('maintenance ON: admin gets 200', async () => {
  reset();
  state.maintenance = { enabled: true, message: 'Back soon.' };
  const r = await get('/api/coupons', 'tok-admin');
  assert.equal(r.status, 200);
});

check('maintenance ON: whitelisted user gets 200', async () => {
  reset();
  state.maintenance = { enabled: true, message: 'Back soon.' };
  state.whitelist = ['vip@example.com'];
  const r = await get('/api/coupons', 'tok-white');
  assert.equal(r.status, 200);
});

check('isolation: same URL returns different results for admin vs anonymous', async () => {
  reset();
  state.maintenance = { enabled: true, message: 'Back soon.' };
  const admin = await get('/api/coupons', 'tok-admin');
  const anon = await get('/api/coupons');
  assert.notEqual(admin.status, anon.status, 'shared cache would leak a 200 to anonymous');
  assert.equal(anon.status, 503);
});

check('isolation: anonymous never receives the admin body during maintenance', async () => {
  reset();
  state.maintenance = { enabled: true, message: 'Back soon.' };
  await get('/api/coupons', 'tok-admin'); // warm the admin path first
  const anon = await get('/api/coupons');
  assert.equal(anon.status, 503);
  assert.equal(anon.body.coupons, undefined, 'listing body must not leak to anonymous');
});

check('isolation: a session cookie does not bypass the guard for an unknown token', async () => {
  reset();
  state.maintenance = { enabled: true, message: 'Back soon.' };
  const r = await get('/api/coupons', 'tok-forged');
  assert.equal(r.status, 503);
});

check('fail-open: a maintenance read error lets the request through (existing behaviour)', async () => {
  reset();
  // Swap in a throwing reader for this one case.
  const supa = require(path.join(SERVER, 'services', 'supabase.js'));
  const original = supa.getMaintenanceMode;
  supa.getMaintenanceMode = async () => { throw new Error('supabase down'); };
  try {
    const r = await get('/api/coupons');
    assert.equal(r.status, 200);
  } finally {
    supa.getMaintenanceMode = original;
  }
});

pending.reduce((p, run) => p.then(run), Promise.resolve()).then(() => {
  server.close();
  console.log(`\nmaintenanceIsolation: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
