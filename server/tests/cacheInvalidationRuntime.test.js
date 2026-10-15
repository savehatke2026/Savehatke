// Runtime cache-invalidation checks through the real admin router.
// Run: node server/tests/cacheInvalidationRuntime.test.js
// Storage, auth and the coupon-list cache are stubbed; nothing touches Supabase,
// Sheets or the network. The invalidator is a spy, so the test observes whether
// a handler dropped the public listing cache, instead of reading source text.
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
let row = null;
let writeError = null;     // when set, updateCoupon throws (simulated storage failure)
let siteSettingError = null;
let invalidations = 0;
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
  updateCoupon: async (id, updates) => {
    if (writeError) throw writeError;
    return { id, ...row, ...updates };
  },
  findCouponByCode: async () => null,
  getCoupons: async () => [],
  getMaintenanceWhitelist: async () => [],
  getSiteSetting: async () => null,
  setSiteSetting: async (key, value) => {
    if (siteSettingError) throw siteSettingError;
    return { key, value };
  },
});
stub(path.join(SERVER, 'services', 'googleSheets.js'), new Proxy({ SHEETS: { COUPONS: 'Coupons', PAYOUTS: 'Payouts' } }, {
  get(t, p) { if (p in t) return t[p]; return async () => (p === 'getRows' ? [] : null); },
}));
stub(path.join(SERVER, 'services', 'couponListCache.js'), {
  get: () => null,
  set: () => {},
  invalidate: () => { invalidations += 1; },
  getSnapshot: async (loader) => loader(),
  COUPON_LIST_CACHE_TTL_MS: 0,
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

function reset() {
  invalidations = 0;
  writeError = null;
  siteSettingError = null;
}

// ── Coupon writes ───────────────────────────────────────────────────────────
check('successful coupon edit invalidates the coupon listing', async () => {
  reset();
  row = { ...ADMIN };
  const r = await send('PUT', '/api/admin/coupons/C-ADMIN', { title: 'New title' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(invalidations, 1, 'a saved coupon must drop the cached listing');
});

check('coupon edit refused by validation (400) does NOT invalidate', async () => {
  reset();
  row = { ...SELLER };
  const r = await send('PUT', '/api/admin/coupons/C-SELLER', { originalValue: '50' });
  assert.equal(r.status, 400);
  assert.equal(invalidations, 0, 'a rejected write must not touch the cache');
});

check('coupon edit that fails in storage (500) does NOT invalidate', async () => {
  reset();
  row = { ...ADMIN };
  writeError = new Error('simulated supabase outage');
  const r = await send('PUT', '/api/admin/coupons/C-ADMIN', { title: 'New title' });
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.equal(invalidations, 0, 'a failed write must not drop or repopulate the cache');
});

check('unknown coupon id (404) does NOT invalidate', async () => {
  reset();
  row = null;
  const r = await send('PUT', '/api/admin/coupons/NOPE', { title: 'x' });
  assert.equal(r.status, 404);
  assert.equal(invalidations, 0);
});

// ── Pricing config ──────────────────────────────────────────────────────────
check('successful pricing-config save invalidates the coupon listing', async () => {
  reset();
  const r = await send('PUT', '/api/admin/pricing-config', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(invalidations, 1, 'a price change must not wait for the TTL');
});

check('invalid pricing-config save (400) does NOT invalidate', async () => {
  reset();
  // Out-of-range percent and a bounded last tier: normaliseConfig rejects both.
  const r = await send('PUT', '/api/admin/pricing-config', {
    manualFinalPercentOff: -5,
    maximumDiscountTiers: [{ maxRupees: -1, normal: 500, final: 900 }],
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'PRICING_CONFIG_INVALID');
  assert.equal(invalidations, 0, 'a rejected pricing save must not touch the cache');
});

check('pricing-config storage failure (500) does NOT invalidate', async () => {
  reset();
  siteSettingError = new Error('simulated supabase outage');
  const r = await send('PUT', '/api/admin/pricing-config', {});
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.equal(invalidations, 0, 'a failed pricing save must not drop the cache');
});

setTimeout(async () => {
  for (const run of pending) await run();
  server.close();
  console.log(`\ncacheInvalidationRuntime: ${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}, 0);
