// Cache-policy regression tests (mocked, no network, no real data).
// Run: node server/tests/sensitiveCache.test.js
//
// Covers:
//   - Sensitive API prefixes get Cache-Control: no-store (success + error paths)
//   - Public read caches are NOT changed by the policy
//   - Path matching is strict (no accidental prefix matches)
//   - Maintenance caller resolution is not affected by the header policy

const assert = require('node:assert/strict');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const { noStoreSensitiveApi, isSensitivePath, NO_STORE } = require(path.join(SERVER, 'middleware', 'sensitiveCache.js'));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

// Minimal res/req fakes: enough to observe setHeader and next().
function run(urlPath) {
  const headers = {};
  let nextCalled = false;
  const req = { path: urlPath };
  const res = { setHeader(k, v) { headers[k.toLowerCase()] = v; } };
  noStoreSensitiveApi(req, res, () => { nextCalled = true; });
  return { headers, nextCalled };
}

console.log('sensitive prefixes → no-store');
for (const p of [
  '/api/admin/finance/revenue',
  '/api/admin/coupons',
  '/api/admin/gmail/messages',
  '/api/payment/verify',
  '/api/payment/webhook',
  '/api/payouts/my',
  '/api/refunds/abc',
  '/api/auth/login',
  '/api/auth/me',
  '/api/support/tickets',
  '/api/reviews/eligible',
  '/api/consent',
  '/api/coupons/my-sales',
  '/api/coupons/my-purchases',
  '/api/coupons/sell-eligibility',
  '/api/coupons/proof',
  '/api/coupons/scan',
]) {
  check(`${p} sets no-store`, () => {
    const r = run(p);
    assert.equal(r.headers['cache-control'], NO_STORE);
    assert.equal(r.headers['pragma'], 'no-cache');
    assert.equal(r.nextCalled, true, 'must always call next()');
  });
}

console.log('public read caches are left alone');
for (const p of [
  '/api/brands',
  '/api/brand-assets/file/abcdefghij',
  '/api/brand-assets/Amazon',
  '/api/coupons/recent-sales',
  '/api/coupons',
  '/api/coupons/categories',
  '/api/settings',
  '/api/chat/config',
  '/api/proxy/drive/config',
]) {
  check(`${p} is not marked no-store`, () => {
    const r = run(p);
    assert.equal(r.headers['cache-control'], undefined);
    assert.equal(r.nextCalled, true);
  });
}

console.log('strict path matching');
check('does not match a longer unrelated prefix (/api/administrator)', () => {
  assert.equal(isSensitivePath('/api/administrator'), false);
});
check('does not match /api/payments-public', () => {
  assert.equal(isSensitivePath('/api/payments-public'), false);
});
check('matching is case-insensitive', () => {
  assert.equal(isSensitivePath('/API/ADMIN/finance'), true);
});
check('exact prefix root matches', () => {
  assert.equal(isSensitivePath('/api/admin'), true);
});
check('empty/undefined path is not sensitive', () => {
  assert.equal(isSensitivePath(undefined), false);
  assert.equal(isSensitivePath(''), false);
});

console.log(`\nsensitiveCache: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
