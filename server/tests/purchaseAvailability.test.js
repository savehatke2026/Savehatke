// Purchase-time coupon availability (mocked, no network, no real payments).
// Run: node server/tests/purchaseAvailability.test.js
//
// Drives the REAL evaluateCoupon() gate that /api/payment uses before it
// creates an order. The gate reads a fresh coupon row (never a cached listing),
// so a sold-out, reserved, expired or own-listing coupon must be refused no
// matter what a stale listing said.

const assert = require('node:assert/strict');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');

// Stub the external services evaluateCoupon's module graph pulls in, so loading
// payment.js does not touch Supabase, Sheets or the network.
const stub = (mod, exp) => {
  const p = require.resolve(mod);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
};
stub(path.join(SERVER, 'services', 'supabase.js'), {
  isConfigured: () => false, findCouponById: async () => null, getMaintenanceMode: async () => ({ enabled: false }),
  getMaintenanceWhitelist: async () => [], getCoupons: async () => [],
});
stub(path.join(SERVER, 'services', 'googleSheets.js'), new Proxy({ SHEETS: { COUPONS: 'Coupons' } }, {
  get(t, p) { if (p in t) return t[p]; return async () => null; },
}));
stub(path.join(SERVER, 'services', 'paymentStore.js'), new Proxy({}, { get: () => async () => null }));
// validateAmount is the UPI ceiling check. Mirror its ok shape for normal
// amounts so the gate reaches the success verdict; a real over-limit amount
// would return ok:false, which the tests below do not exercise.
stub(path.join(SERVER, 'services', 'upi.js'), {
  validateAmount: (amount) => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, code: 'INVALID_AMOUNT' };
    if (n > 100000) return { ok: false, code: 'AMOUNT_TOO_LARGE', max: 100000 };
    return { ok: true, amount: n };
  },
});
stub(path.join(SERVER, 'services', 'paymentVerifier.js'), new Proxy({}, { get: () => async () => null }));
stub(path.join(SERVER, 'services', 'refunds.js'), new Proxy({}, { get: () => async () => null }));
stub(path.join(SERVER, 'middleware', 'auth.js'), {
  authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
  optionalAuth: (req, res, next) => next(),
});
stub(path.join(SERVER, 'utils', 'adminRateLimit.js'), { adminFinancialLimiter: (req, res, next) => next() });

const { evaluateCoupon } = require(path.join(SERVER, 'routes', 'payment.js'));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const FUTURE = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const PAST = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// A purchasable, unreserved, available coupon owned by someone else.
function base(over = {}) {
  return {
    id: 'c1',
    brand: 'Amazon',
    status: 'available',
    originalValue: '1000',
    expiryDate: FUTURE,
    sellerEmail: 'seller@example.com',
    sellerUserId: 'seller1',
    reservedUntil: null,
    reservedBy: null,
    ...over,
  };
}
const buyer = { userId: 'buyer1', userEmail: 'buyer@example.com' };

console.log('valid coupon');
check('available, unreserved, others\u2019 coupon: purchasable', () => {
  const v = evaluateCoupon(base(), buyer);
  assert.equal(v.ok, true, JSON.stringify(v));
});

console.log('sold-out / unavailable (stale listing must not win)');
for (const status of ['sold', 'reserved', 'pending', 'invalidated']) {
  check(`status=${status} is refused with 409 COUPON_UNAVAILABLE`, () => {
    const v = evaluateCoupon(base({ status }), buyer);
    assert.equal(v.ok, false);
    assert.equal(v.status, 409);
    assert.equal(v.code, 'COUPON_UNAVAILABLE');
  });
}
check('missing coupon is refused with 404 COUPON_NOT_FOUND', () => {
  const v = evaluateCoupon(null, buyer);
  assert.equal(v.status, 404);
  assert.equal(v.code, 'COUPON_NOT_FOUND');
});

console.log('reservations');
check('active reservation by another buyer is refused (409)', () => {
  const v = evaluateCoupon(base({
    reservedBy: 'other-buyer',
    reservedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  }), buyer);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'COUPON_UNAVAILABLE');
});
check('active reservation held by the same buyer is allowed (resume)', () => {
  const v = evaluateCoupon(base({
    reservedBy: 'buyer1',
    reservedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  }), buyer);
  assert.equal(v.ok, true, JSON.stringify(v));
});
check('lapsed reservation blocks nobody', () => {
  const v = evaluateCoupon(base({
    reservedBy: 'other-buyer',
    reservedUntil: new Date(Date.now() - 60 * 1000).toISOString(),
  }), buyer);
  assert.equal(v.ok, true, JSON.stringify(v));
});

console.log('price and expiry');
check('expired coupon is refused (409 COUPON_EXPIRED)', () => {
  const v = evaluateCoupon(base({ expiryDate: PAST }), buyer);
  assert.equal(v.ok, false);
  assert.equal(v.status, 409);
  assert.equal(v.code, 'COUPON_EXPIRED');
});
check('unparseable face value is refused (not purchasable)', () => {
  const v = evaluateCoupon(base({ originalValue: 'abc' }), buyer);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'COUPON_EXPIRED');
});

console.log('ownership');
check('seller cannot buy own listing by email (403 OWN_COUPON)', () => {
  const v = evaluateCoupon(base(), { userId: 'x', userEmail: 'SELLER@example.com' });
  assert.equal(v.status, 403);
  assert.equal(v.code, 'OWN_COUPON');
});
check('seller cannot buy own listing by user id (403 OWN_COUPON)', () => {
  const v = evaluateCoupon(base(), { userId: 'seller1', userEmail: 'other@example.com' });
  assert.equal(v.code, 'OWN_COUPON');
});

console.log('server-side price is authoritative');
check('verdict returns the server-computed amount, not a client-supplied one', () => {
  const v = evaluateCoupon(base(), buyer);
  assert.equal(v.ok, true);
  assert.ok(v.amount !== undefined, 'amount must come from the server');
  // The gate only ever reads the coupon row; there is no client price input.
  assert.ok(evaluateCoupon.length === 2, 'signature takes coupon + caller only');
});

console.log(`\npurchaseAvailability: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
