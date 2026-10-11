// Face-value rules for the admin coupon save/approve path, exercised through the
// real admin router. Seller coupons must stay in ₹100–₹10,000; admin coupons are
// not held to that range. Run: node server/tests/faceValueRange.test.js
// Storage is stubbed; nothing touches Supabase, Sheets or the network.
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const SERVER = path.join(__dirname, '..');
let failures = 0;
let passed = 0;
const pending = [];
function check(name, fn) {
  const run = () => Promise.resolve().then(fn).then(
    () => { passed += 1; console.log('  ok   ' + name); },
    (e) => { failures += 1; console.error('  FAIL ' + name + '\n       ' + e.message); },
  );
  pending.push(run);
}

// ── Stubs ───────────────────────────────────────────────────────────────────
// The "store" is one in-memory row, so each test can set the coupon it saves.
let row = null;
let lastUpdate = null;
const stub = (mod, exp) => {
  const p = require.resolve(mod);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
};
const passthrough = (req, res, next) => { req.user = { id: 'admin1', email: 'admin@example.com', role: 'admin' }; next(); };
stub(path.join(SERVER, 'middleware', 'auth.js'), {
  authenticateToken: passthrough,
  requireAdmin: (req, res, next) => next(),
  optionalAuth: passthrough,
});
stub(path.join(SERVER, 'services', 'supabase.js'), {
  isConfigured: () => true,
  findCouponById: async (id) => (row && String(row.id) === String(id) ? { ...row } : null),
  updateCoupon: async (id, updates) => { lastUpdate = { id, ...updates }; return { id, ...row, ...updates }; },
  findCouponByCode: async () => null,
  getCoupons: async () => [],
  getMaintenanceWhitelist: async () => [],
});
stub(path.join(SERVER, 'services', 'googleSheets.js'), new Proxy({ SHEETS: { COUPONS: 'Coupons', PAYOUTS: 'Payouts' } }, {
  get(t, p) { if (p in t) return t[p]; return async () => (p === 'getRows' ? [] : null); },
}));
stub(path.join(SERVER, 'services', 'couponListCache.js'), {
  get: () => null, set: () => {}, invalidate: () => {}, getSnapshot: () => null, COUPON_LIST_CACHE_TTL_MS: 0,
});

const express = require(path.join(SERVER, '..', 'node_modules', 'express'));
const adminRouter = require(path.join(SERVER, 'routes', 'admin.js'));
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use('/api/admin', adminRouter);
const server = app.listen(0, '127.0.0.1');

function send(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: urlPath, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const ADMIN = { id: 'C-ADMIN', source: 'admin', sellerEmail: '', status: 'draft', originalValue: '50', title: 'Admin offer' };
const SELLER = { id: 'C-SELLER', source: 'user-submitted', sellerEmail: 'seller@example.com', status: 'pending', originalValue: '500', title: 'Seller offer' };

// ── Admin-created coupons must NOT get the seller range ──────────────────────
check('admin coupon with ₹50 face value saves as a draft', async () => {
  row = { ...ADMIN };
  lastUpdate = null;
  const r = await send('PUT', '/api/admin/coupons/C-ADMIN', { originalValue: '50', title: 'Admin offer' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(lastUpdate.originalValue, '50');
});

check('admin coupon with ₹50 face value can be published (status available)', async () => {
  row = { ...ADMIN };
  lastUpdate = null;
  const r = await send('PUT', '/api/admin/coupons/C-ADMIN', { originalValue: '50', status: 'available' });
  assert.equal(r.status, 200, 'admin Publish was blocked by the seller range: ' + JSON.stringify(r.body));
  assert.equal(lastUpdate.status, 'available');
});

// ── Seller coupons keep the range ────────────────────────────────────────────
check('seller coupon with ₹50 face value is refused on save', async () => {
  row = { ...SELLER, originalValue: '50' };
  const r = await send('PUT', '/api/admin/coupons/C-SELLER', { originalValue: '50' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_FACE_VALUE');
});

check('seller coupon with ₹500 face value saves', async () => {
  row = { ...SELLER };
  lastUpdate = null;
  const r = await send('PUT', '/api/admin/coupons/C-SELLER', { originalValue: '500', title: 'Seller offer' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(lastUpdate.originalValue, '500');
});

check('an empty face value is refused with a clear message, never replaced by ₹100', async () => {
  row = { ...SELLER };
  lastUpdate = null;
  const r = await send('PUT', '/api/admin/coupons/C-SELLER', { originalValue: '' });
  assert.equal(r.status, 400);
  assert.equal(lastUpdate, null, 'nothing must be written when the face value is empty');
});

check('a seller coupon with an out-of-range face value cannot be approved', async () => {
  row = { ...SELLER, originalValue: '50' };
  const r = await send('PUT', '/api/admin/coupons/C-SELLER', { status: 'available' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_FACE_VALUE');
});

// ── Admin edit with the form's unchanged face value still works ──────────────
check('admin coupon edit that does not touch the face value saves', async () => {
  row = { ...ADMIN, originalValue: '50' };
  lastUpdate = null;
  const r = await send('PUT', '/api/admin/coupons/C-ADMIN', { title: 'New title', originalValue: '50' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

check('a "user"-tagged row with a seller email is treated as a seller coupon', async () => {
  row = { id: 'C-USER', source: 'user', sellerEmail: 'seller@example.com', status: 'draft', originalValue: '50', title: 'x' };
  const r = await send('PUT', '/api/admin/coupons/C-USER', { originalValue: '50' });
  assert.equal(r.status, 400, 'a seller-email row must keep the seller range');
  assert.equal(r.body.code, 'INVALID_FACE_VALUE');
});

check('an admin row with a stray source tag but no seller email is NOT a seller coupon', async () => {
  row = { id: 'C-STRAY', source: 'user', sellerEmail: '', status: 'draft', originalValue: '50', title: 'x' };
  const r = await send('PUT', '/api/admin/coupons/C-STRAY', { originalValue: '50', status: 'available' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

setTimeout(async () => {
  for (const run of pending) await run();
  server.close();
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}, 0);
