// Coupon submission rate limits: budget values, route classification, and the
// 5-coupon batch rule exercised through the real coupons router.
// Run: node server/tests/submitRateLimit.test.js
// Live Redis checks (concurrency, persistence across instances) need a real
// Upstash database and are NOT covered here.
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const SERVER = path.join(__dirname, '..');
const rl = require(path.join(SERVER, 'services', 'rateLimitService.js'));

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

const fakeReq = (url, method = 'POST') => ({ originalUrl: url, url, method, headers: {} });

check('hourly account budget is 10 requests per rolling hour', () => {
  const s = rl.LIMITS['coupon-submit-hour-account'];
  assert.deepEqual({ limit: s.limit, window: s.window, fail: s.fail }, { limit: 10, window: '1 h', fail: 'closed' });
});

check('hourly IP budget is 20 requests per rolling hour', () => {
  const s = rl.LIMITS['coupon-submit-hour-ip'];
  assert.deepEqual({ limit: s.limit, window: s.window, fail: s.fail }, { limit: 20, window: '1 h', fail: 'closed' });
});

check('/api/coupons/sell is classified to both hourly budgets', () => {
  const d = rl.classify(fakeReq('/api/coupons/sell'));
  assert.equal(d.set.account, 'coupon-submit-hour-account');
  assert.equal(d.set.ip, 'coupon-submit-hour-ip');
  assert.equal(d.requireAccount, true);
});

check('/api/coupons/submit is classified to both hourly budgets', () => {
  const d = rl.classify(fakeReq('/api/coupons/submit'));
  assert.equal(d.set.account, 'coupon-submit-hour-account');
  assert.equal(d.set.ip, 'coupon-submit-hour-ip');
});

check('/api/coupons/proof keeps its own per-minute account budget', () => {
  const d = rl.classify(fakeReq('/api/coupons/proof'));
  assert.equal(d.set.account, 'coupon-submit-account');
  assert.equal(d.set.ip, undefined);
});

check('a trailing slash and query string do not bypass classification', () => {
  const d = rl.classify(fakeReq('/api/coupons/submit/?x=1'));
  assert.equal(d.set.account, 'coupon-submit-hour-account');
});

check('the payment webhook stays exempt from the submission limit', () => {
  assert.equal(rl.classify(fakeReq('/api/payment/webhook')).skip, true);
});

// ── Real router: batch rule ─────────────────────────────────────────────────
// Stub the four modules the coupons router loads so the real handler runs
// without Supabase, Sheets, Turnstile or a session. Storage calls are counted;
// an oversized batch must be refused before any of them happen.
let storageWrites = 0;
const stub = (mod, exp) => {
  const p = require.resolve(mod);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
};
// role 'admin' passes the sell gate without a purchase or whitelist lookup, so
// the request reaches the batch rule. This is a test stub only.
const passthrough = (req, res, next) => { req.user = { id: 'u1', email: 'seller@example.com', role: 'admin' }; next(); };
stub(path.join(SERVER, 'middleware', 'auth.js'), {
  authenticateToken: passthrough,
  optionalAuth: passthrough,
});
stub(path.join(SERVER, 'utils', 'turnstile.js'), {
  verifyTurnstile: async () => ({ ok: true }),
});
const sheetsStub = new Proxy({ SHEETS: {} }, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return async (...args) => { storageWrites += 1; return args.length ? null : []; };
  },
});
stub(path.join(SERVER, 'services', 'googleSheets.js'), sheetsStub);
stub(path.join(SERVER, 'services', 'supabase.js'), new Proxy({ isConfigured: () => false, getMaintenanceWhitelist: async () => [] }, {
  get(t, p) { if (p in t) return t[p]; return async () => { storageWrites += 1; return null; }; },
}));

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
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

function coupon(i) {
  return { code: 'TEST' + i, brand: 'Amazon', category: 'Shopping', title: 'Offer ' + i,
    description: 'Offer ' + i, discount: '10% OFF', faceValue: 500, expiryDate: '2099-01-01', proofUrl: '' };
}

const exp = require(path.join(SERVER, 'routes', 'coupons.js'));
const express = require(path.join(SERVER, '..', 'node_modules', 'express'));
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use('/api/coupons', exp);

const server = app.listen(0, '127.0.0.1');

check('a batch of 6 coupons is refused whole with the exact spec message', async () => {
  const port = server.address().port;
  const before = storageWrites;
  const r = await postJson(port, '/api/coupons/submit', { coupons: [1, 2, 3, 4, 5, 6].map(coupon) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Submission Limit Exceeded');
  assert.equal(
    r.body.message,
    'You can submit a maximum of 5 coupons in a single request. Please reduce the number of coupons and try again.',
  );
  assert.equal(storageWrites, before, 'no storage call may happen for an oversized batch');
});

check('a batch of 5 coupons is not refused by the batch rule', async () => {
  const port = server.address().port;
  const r = await postJson(port, '/api/coupons/submit', { coupons: [1, 2, 3, 4, 5].map(coupon) });
  assert.notEqual(r.body && r.body.error, 'Submission Limit Exceeded');
});

// Sequential on purpose: the storage counter is shared, so concurrent route
// checks would count each other's writes.
(async () => {
  for (const run of pending) await run();
})().then(() => {
  server.close();
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
});
