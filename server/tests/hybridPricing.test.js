// Hybrid automatic + manual pricing: the scenarios from the brief.
// Run: node server/tests/hybridPricing.test.js
'use strict';

const assert = require('node:assert/strict');
const dyn = require('../services/dynamicPricing');
const cfg = require('../services/pricingConfig');

const DEF = cfg.DEFAULT_CONFIG;
const EXP = '2026-10-30';
const FAR = Date.parse('2026-10-01T10:00:00+05:30'); // >24h before EXP
// EXP ends 2026-10-30 23:59:59.999 IST, so 2026-10-30 06:00 IST is ~18h before.
const NEAR = Date.parse('2026-10-30T06:00:00+05:30');
const EXPIRED_NOW = Date.parse('2026-10-31T10:00:00+05:30');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok   ' + name); }

// 1. Face value ₹1,000 automatic → ₹200 normal, ₹100 final day
test('face ₹1,000 automatic: ₹200 normal, ₹100 in last 24h', () => {
  const far = dyn.getBuyerPrice({ originalValue: '1000', expiryDate: EXP, pricingMode: 'automatic' }, FAR, DEF);
  const near = dyn.getBuyerPrice({ originalValue: '1000', expiryDate: EXP, pricingMode: 'automatic' }, NEAR, DEF);
  assert.equal(far.price, 200);
  assert.equal(far.normalPrice, 200);
  assert.equal(near.price, 100);
  assert.equal(near.finalPrice, 100);
});

// 2. Max discount ₹500, no face value → ₹30 normal, ₹15 final (default tiers)
test('max discount ₹500 (no face value): ₹30 normal, ₹15 final', () => {
  const far = dyn.getBuyerPrice({ originalValue: '500', valueType: 'maximum_discount', expiryDate: EXP }, FAR, DEF);
  const near = dyn.getBuyerPrice({ originalValue: '500', valueType: 'maximum_discount', expiryDate: EXP }, NEAR, DEF);
  assert.equal(far.price, 30);
  assert.equal(near.price, 15);
});

test('max discount tier boundaries are inclusive and open-ended above ₹1,000', () => {
  const t = (v) => dyn.getBuyerPrice({ originalValue: v, valueType: 'maximum_discount', expiryDate: EXP }, FAR, DEF).price;
  assert.equal(t('100'), 10);
  assert.equal(t('101'), 20);
  assert.equal(t('300'), 20);
  assert.equal(t('301'), 30);
  assert.equal(t('1000'), 50);
  assert.equal(t('1001'), 100);
  assert.equal(t('5000'), 100);
});

// 3. No face value and no max discount → unavailable
test('no face value and no max discount: pricing unavailable, not purchasable', () => {
  const r = dyn.getBuyerPrice({ expiryDate: EXP, pricingMode: 'automatic' }, FAR, DEF);
  assert.equal(r.purchasable, false);
  assert.equal(r.pricingError, 'PRICING_UNAVAILABLE');
});

test('a face value of zero is never treated as a price', () => {
  const r = dyn.getBuyerPrice({ originalValue: '0', expiryDate: EXP }, FAR, DEF);
  assert.equal(r.purchasable, false);
});

// 4. Manual ₹20 → ₹20 normal, ₹10 final by default 50%
test('manual ₹20: ₹20 normal, ₹10 final with default 50%', () => {
  const far = dyn.getBuyerPrice({ pricingMode: 'manual', manualPrice: '20', expiryDate: EXP }, FAR, DEF);
  const near = dyn.getBuyerPrice({ pricingMode: 'manual', manualPrice: '20', expiryDate: EXP }, NEAR, DEF);
  assert.equal(far.price, 20);
  assert.equal(near.price, 10);
});

// 5. Manual custom final-day price preserved
test('manual custom final price is preserved exactly', () => {
  const near = dyn.getBuyerPrice({ pricingMode: 'manual', manualPrice: '20', manualFinalPrice: '7.5', expiryDate: EXP }, NEAR, DEF);
  assert.equal(near.price, 7.5);
  assert.equal(near.normalPrice, 20);
});

test('manual final price above normal is clamped to normal, and rejected by validation', () => {
  const v = dyn.validatePricing({ pricingMode: 'manual', manualPrice: '20', manualFinalPrice: '25' }, DEF);
  assert.equal(v.ok, false);
});

// 6/7. Expiry boundaries
test('expiry more than 24h away shows the normal price', () => {
  const r = dyn.getBuyerPrice({ originalValue: '1000', expiryDate: EXP }, FAR, DEF);
  assert.equal(r.price, r.normalPrice);
});

test('expiry within 24h shows the final-day price', () => {
  const r = dyn.getBuyerPrice({ originalValue: '1000', expiryDate: EXP }, NEAR, DEF);
  assert.equal(r.price, r.finalPrice);
});

// 8. Expired → not purchasable
test('expired coupon is not purchasable', () => {
  const r = dyn.getBuyerPrice({ originalValue: '1000', expiryDate: EXP }, EXPIRED_NOW, DEF);
  assert.equal(r.purchasable, false);
  assert.equal(r.expired, true);
});

// 9. Legacy: no mode stored → decided by manual price, prices unchanged
test('legacy coupon with no mode and no manual price stays automatic (today\'s price)', () => {
  const r = dyn.getBuyerPrice({ originalValue: '1000', expiryDate: EXP }, FAR, DEF);
  assert.equal(r.pricingSource, 'auto');
  assert.equal(r.price, 200);
});

test('legacy coupon with a stored manual price stays manual (today\'s price)', () => {
  const r = dyn.getBuyerPrice({ originalValue: '1000', manualPrice: '300', expiryDate: EXP }, FAR, DEF);
  assert.equal(r.pricingSource, 'manual');
  assert.equal(r.price, 300);
});

// Stored normal price is never rewritten at the final-day switch.
test('normal price stays the same across the final-day switch', () => {
  const far = dyn.getBuyerPrice({ pricingMode: 'manual', manualPrice: '20', expiryDate: EXP }, FAR, DEF);
  const near = dyn.getBuyerPrice({ pricingMode: 'manual', manualPrice: '20', expiryDate: EXP }, NEAR, DEF);
  assert.equal(far.normalPrice, near.normalPrice);
});

// Paise: no float drift on percentages.
test('paise math: 20% of ₹199.99 is exact to the paisa', () => {
  assert.equal(dyn.percentOfPaise(19999, 20), 4000);
  assert.equal(dyn.toPaise('199.99'), 19999);
  assert.equal(dyn.fromPaise(4000), '40');
});

// Validation: pricing mode requires a manual price; automatic requires data.
test('manual mode with blank manual price fails validation', () => {
  const v = dyn.validatePricing({ pricingMode: 'manual', manualPrice: '' }, DEF);
  assert.equal(v.ok, false);
});

test('automatic mode with no face value fails validation (manual entry required)', () => {
  const v = dyn.validatePricing({ pricingMode: 'automatic', originalValue: '' }, DEF);
  assert.equal(v.ok, false);
});

// Config: malformed tiers are refused; defaults are the brief's table.
test('config rejects a tier whose last-24h price exceeds its normal price', () => {
  const r = cfg.normaliseConfig({ maximumDiscountTiers: [{ maxRupees: null, normal: 10, final: 20 }] });
  assert.equal(r.ok, false);
});

test('config rejects a non-open-ended last tier', () => {
  const r = cfg.normaliseConfig({ maximumDiscountTiers: [{ maxRupees: 100, normal: 10, final: 5 }] });
  assert.equal(r.ok, false);
});

test('default manual final percent is 50', () => {
  assert.equal(DEF.manualFinalPercentOff, 50);
});

console.log(`\n${passed} passed, 0 failed`);
