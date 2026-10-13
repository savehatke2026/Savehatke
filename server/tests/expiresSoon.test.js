// "Expires Soon" pricing exclusion. Run: node server/tests/expiresSoon.test.js
'use strict';

const assert = require('node:assert/strict');
const dyn = require('../services/dynamicPricing');
const cfg = require('../services/pricingConfig');

const DEF = cfg.DEFAULT_CONFIG;
const EXP = '2026-10-30';
const FAR = Date.parse('2026-10-01T10:00:00+05:30');  // >24h before EXP
const NEAR = Date.parse('2026-10-30T06:00:00+05:30'); // ~18h before EXP (final day)

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok   ' + name); }

const face1000 = { originalValue: '1000', expiryDate: EXP };

// 1. Ordinary coupon follows the existing pricing rules, unchanged.
test('ordinary coupon: 20% normal far out, 10% in the final 24h', () => {
  const far = dyn.getBuyerPrice(face1000, FAR, DEF);
  const near = dyn.getBuyerPrice(face1000, NEAR, DEF);
  assert.equal(far.price, 200);
  assert.equal(near.price, 100);
  assert.equal(far.expiresSoon, false);
});

// 2. Expires Soon does NOT receive the last-24h 10% calculation.
test('expiresSoon=true inside the final 24h keeps the normal 20% price', () => {
  const near = dyn.getBuyerPrice({ ...face1000, expiresSoon: true }, NEAR, DEF);
  assert.equal(near.price, 200);
  assert.equal(near.normalPrice, 200);
  assert.equal(near.expiresSoon, true);
});

test('expiresSoon=true outside the final 24h still shows the normal price', () => {
  const far = dyn.getBuyerPrice({ ...face1000, expiresSoon: true }, FAR, DEF);
  assert.equal(far.price, 200);
});

test('expiresSoon excludes manual coupons from their last-24h final price', () => {
  const manual = { pricingMode: 'manual', manualPrice: '20', expiryDate: EXP };
  assert.equal(dyn.getBuyerPrice({ ...manual }, NEAR, DEF).price, 10);
  assert.equal(dyn.getBuyerPrice({ ...manual, expiresSoon: true }, NEAR, DEF).price, 20);
});

test('expiresSoon excludes maximum-discount coupons from their last-24h tier', () => {
  const max = { originalValue: '500', valueType: 'maximum_discount', expiryDate: EXP };
  assert.equal(dyn.getBuyerPrice(max, NEAR, DEF).price, 15);
  assert.equal(dyn.getBuyerPrice({ ...max, expiresSoon: true }, NEAR, DEF).price, 30);
});

// 3. Disabling the setting restores the normal last-24h eligibility.
test('turning expiresSoon back off restores the 10% final-day price', () => {
  const on = dyn.getBuyerPrice({ ...face1000, expiresSoon: true }, NEAR, DEF);
  const off = dyn.getBuyerPrice({ ...face1000, expiresSoon: false }, NEAR, DEF);
  assert.equal(on.price, 200);
  assert.equal(off.price, 100);
});

// Stored normal price, expiry and face value are never changed by the flag.
test('expiresSoon never changes the face value, normal price or expiry', () => {
  const a = dyn.getBuyerPrice(face1000, NEAR, DEF);
  const b = dyn.getBuyerPrice({ ...face1000, expiresSoon: true }, NEAR, DEF);
  assert.equal(a.normalPrice, b.normalPrice);
  assert.equal(a.faceValue, b.faceValue);
  assert.equal(a.hoursRemaining, b.hoursRemaining);
});

// Expired stays expired regardless of the flag.
test('expired coupon stays unpurchasable even with expiresSoon set', () => {
  const r = dyn.getBuyerPrice({ ...face1000, expiresSoon: true }, Date.parse('2026-10-31T10:00:00+05:30'), DEF);
  assert.equal(r.purchasable, false);
  assert.equal(r.expired, true);
});

// Legacy / missing / odd values read as false, so no existing coupon changes.
test('missing, null or unrecognised expiresSoon behaves as false (legacy rows unchanged)', () => {
  const base = dyn.getBuyerPrice(face1000, NEAR, DEF).price;
  for (const v of [undefined, null, '', 'false', 0, 'no']) {
    assert.equal(dyn.getBuyerPrice({ ...face1000, expiresSoon: v }, NEAR, DEF).price, base, `value ${String(v)}`);
  }
});

test('string "true" from the admin form / Sheets mirror is honoured', () => {
  assert.equal(dyn.getBuyerPrice({ ...face1000, expiresSoon: 'true' }, NEAR, DEF).price, 200);
  assert.equal(dyn.isExpiresSoon('true'), true);
  assert.equal(dyn.isExpiresSoon(true), true);
  assert.equal(dyn.isExpiresSoon('false'), false);
});

// 5. Backend and checkout use the same function, so they agree by construction.
test('the same coupon gives the same price on repeated calls (checkout == listing)', () => {
  const coupon = { ...face1000, expiresSoon: true };
  const listing = dyn.getBuyerPrice(coupon, NEAR, DEF).price;
  const checkout = dyn.getBuyerPrice({ ...coupon }, NEAR, DEF).price;
  assert.equal(listing, checkout);
});

console.log(`\n${passed} passed, 0 failed`);
