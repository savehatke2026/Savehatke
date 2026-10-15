// Cache invalidation (mocked, no network). Run: node server/tests/cacheInvalidation.test.js
//
// Two halves:
//   1. Behaviour: couponListCache and brandAssets drop their entries on invalidate,
//      and a read after invalidate is a miss (fresh data), not the stale value.
//   2. Wiring: every admin write route that changes coupon data or price calls
//      invalidateCouponListCache(). A missing call would leave the public listing
//      stale until the TTL, so this is checked against the source.

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const SERVER = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('couponListCache behaviour');
const list = require(path.join(SERVER, 'services', 'couponListCache.js'));

check('set then get returns the cached payload', () => {
  list.invalidate();
  list.set('all|all|all', { coupons: [{ id: 'c1', price: 100 }] });
  assert.deepEqual(list.get('all|all|all'), { coupons: [{ id: 'c1', price: 100 }] });
});

check('invalidate() drops every entry, so the next read is a miss', () => {
  list.set('all|all|all', { coupons: [{ id: 'c1', price: 100 }] });
  list.set('available|all|all', { coupons: [] });
  list.invalidate();
  assert.equal(list.get('all|all|all'), null, 'stale price must not survive invalidation');
  assert.equal(list.get('available|all|all'), null);
});

check('invalidate() also clears the shared source snapshot', async () => {
  list.invalidate();
  let loads = 0;
  const loader = async () => { loads += 1; return { v: loads }; };
  const a = await list.getSnapshot(loader);
  const b = await list.getSnapshot(loader);
  assert.equal(loads, 1, 'second read inside TTL reuses the snapshot');
  assert.deepEqual(a, b);
  list.invalidate();
  const c = await list.getSnapshot(loader);
  assert.equal(loads, 2, 'after invalidate the snapshot is reloaded');
  assert.equal(c.v, 2, 'the reloaded value is fresh, not the old one');
});

check('a set after invalidate is readable again (no permanent poisoning)', () => {
  list.invalidate();
  list.set('k', { ok: 1 });
  assert.deepEqual(list.get('k'), { ok: 1 });
});

console.log('brand cache behaviour');
// brandAssets keeps module-level caches. Confirm its invalidator exists and is
// callable without throwing, since brand writes depend on it.
check('brandAssets.invalidateBrandCaches is exported and callable', () => {
  const brandAssets = require(path.join(SERVER, 'services', 'brandAssets.js'));
  assert.equal(typeof brandAssets.invalidateBrandCaches, 'function');
  brandAssets.invalidateBrandCaches();
});

console.log('admin write wiring (source)');
const adminSrc = fs.readFileSync(path.join(SERVER, 'routes', 'admin.js'), 'utf8');
const brandsSrc = fs.readFileSync(path.join(SERVER, 'routes', 'brands.js'), 'utf8');

// Route handler start lines, and the coupon/price write each one performs.
const COUPON_WRITES = [
  "router.post('/coupons',",
  "router.put('/coupons/:id',",
  "router.post('/coupons/:id/sell',",
  "router.delete('/coupons/:id',",
  "router.post('/coupons/:id/review-action',",
  "router.post('/seller-coupons/:id/publish',",
  "router.post('/coupons/:id/invalidate',",
  "router.post('/coupons/:id/notify-retry',",
  "router.put('/pricing-config',",
];

// Returns the source slice of one handler body, up to the next top-level route.
function handlerBody(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const next = src.indexOf('\nrouter.', start + marker.length);
  return src.slice(start, next < 0 ? src.length : next);
}

for (const marker of COUPON_WRITES) {
  check(`${marker.replace(/,$/, '')} invalidates the coupon list`, () => {
    const body = handlerBody(adminSrc, marker);
    assert.ok(body, `route not found: ${marker}`);
    assert.ok(/invalidateCouponListCache\(\)/.test(body),
      `${marker} changes coupon data/price but does not invalidate the listing`);
  });
}

check('public settings save invalidates the public settings cache', () => {
  assert.ok(/invalidatePublicSettings\(\)/.test(adminSrc),
    '/api/admin/settings must drop the publicSettings cache');
});

for (const marker of ["adminRouter.post('/', ", "adminRouter.put('/:id', ", "adminRouter.post('/:id/active', "]) {
  check(`brand write ${marker.replace(/', $/, '')} invalidates brand caches`, () => {
    const body = handlerBody(brandsSrc, marker);
    assert.ok(body, `brand route not found: ${marker}`);
    assert.ok(/invalidateBrandCaches\(\)/.test(body), `${marker} does not invalidate brand caches`);
  });
}

console.log(`\ncacheInvalidation: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
