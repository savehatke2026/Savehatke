// Coupon countdown: server expiry parser, purchase gate boundaries, and the
// client countdown format + colour bands (loaded from the real marketplace.js).
// Run: node server/tests/couponCountdown.test.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCouponExpiry } = require('../utils/couponExpiry');
const dynamicPricing = require('../services/dynamicPricing');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  ok   ' + name);
}

// ── Server parser ──
test('date-only expiry ends at 23:59:59.999 IST of that day', () => {
  // 2026-10-11 23:59:59.999 IST = 2026-10-11 18:29:59.999 UTC
  assert.equal(parseCouponExpiry('2026-10-11'), Date.UTC(2026, 9, 11, 18, 29, 59, 999));
});
test('naive datetime is read as IST, not the server zone', () => {
  assert.equal(parseCouponExpiry('2026-10-11T18:30'), Date.UTC(2026, 9, 11, 13, 0, 0, 0));
  assert.equal(parseCouponExpiry('2026-10-11 18:30'), Date.UTC(2026, 9, 11, 13, 0, 0, 0));
});
test('explicit offset and Z are honoured as absolute', () => {
  assert.equal(parseCouponExpiry('2026-10-11T13:00:00Z'), Date.UTC(2026, 9, 11, 13, 0, 0, 0));
  assert.equal(parseCouponExpiry('2026-10-11T18:30:00+05:30'), Date.UTC(2026, 9, 11, 13, 0, 0, 0));
});
test('locale day-first and month-first dates parse', () => {
  assert.equal(parseCouponExpiry('30/09/2026'), parseCouponExpiry('2026-09-30'));
  assert.equal(parseCouponExpiry('09/30/2026'), parseCouponExpiry('2026-09-30'));
});
test('empty, garbage and impossible dates return null (never invented)', () => {
  assert.equal(parseCouponExpiry(''), null);
  assert.equal(parseCouponExpiry(null), null);
  assert.equal(parseCouponExpiry('not a date'), null);
  assert.equal(parseCouponExpiry('2026-02-31'), null);
});

// ── Purchase gate: must agree with the card at the boundaries ──
const FACE = '1000';
function gate(expiryDate, nowMs) {
  return dynamicPricing.getBuyerPrice({ originalValue: FACE, expiryDate }, nowMs);
}
test('expired coupon is refused (not purchasable, expired flag set)', () => {
  const now = Date.UTC(2026, 9, 11, 0, 0, 0, 0);
  const r = gate('2026-10-10', now);
  assert.equal(r.purchasable, false);
  assert.equal(r.expired, true);
});
test('locale-formatted past expiry is refused (used to be treated as never-expiring)', () => {
  const now = Date.UTC(2026, 9, 11, 0, 0, 0, 0);
  const r = gate('10/10/2026', now);
  assert.equal(r.purchasable, false);
  assert.equal(r.expired, true);
});
test('more than 24h left → 20% price', () => {
  const now = Date.UTC(2026, 9, 1, 0, 0, 0, 0);
  const r = gate('2026-10-03', now);
  assert.equal(r.purchasable, true);
  assert.equal(r.price, 200);
});
test('exactly 24h left → 10% price (inclusive boundary)', () => {
  // Expiry 2026-10-11 23:59:59.999 IST; 24h before that instant.
  const expiry = parseCouponExpiry('2026-10-11');
  const r = gate('2026-10-11', expiry - DAY);
  assert.equal(r.price, 100);
});
test('one ms more than 24h left → still 20%', () => {
  const expiry = parseCouponExpiry('2026-10-11');
  const r = gate('2026-10-11', expiry - DAY - 1);
  assert.equal(r.price, 200);
});

// ── Client format + bands: load the real functions from marketplace.js ──
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'marketplace.js'), 'utf8');
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
const fmtSrc = extract('formatClaimCountdown');
const bandSrc = extract('claimTimerBand');
const formatClaimCountdown = new Function(`${fmtSrc}; return formatClaimCountdown;`)();
const claimTimerBand = new Function(`${bandSrc}; return claimTimerBand;`)();

test('format > 24h: "DDd HHh MMm left" with no seconds', () => {
  assert.equal(formatClaimCountdown(90 * DAY + 12 * HOUR + 35 * 60000), '90d 12h 35m left');
  assert.equal(formatClaimCountdown(2 * DAY + 4 * HOUR + 10 * 60000), '2d 04h 10m left');
});
test('format ≤ 24h: "HH:MM:SS left"', () => {
  assert.equal(formatClaimCountdown(23 * HOUR + 59 * 60000 + 59000), '23:59:59 left');
  assert.equal(formatClaimCountdown(5 * HOUR + 10 * 60000 + 8000), '05:10:08 left');
  assert.equal(formatClaimCountdown(15 * 60000 + 30000), '00:15:30 left');
  assert.equal(formatClaimCountdown(5000), '00:00:05 left');
});
test('exactly 24h switches to HH:MM:SS, and one second more shows days', () => {
  assert.equal(formatClaimCountdown(DAY), '24:00:00 left');
  assert.equal(formatClaimCountdown(DAY + 1000), '1d 00h 00m left');
});
test('expired shows Expired', () => {
  assert.equal(formatClaimCountdown(0), 'Expired');
  assert.equal(formatClaimCountdown(-5), 'Expired');
});
test('bands: red ≤24h, yellow >24h to 7d, green >7d, expired at 0', () => {
  assert.equal(claimTimerBand(30 * DAY), 'green');
  assert.equal(claimTimerBand(7 * DAY + 1), 'green');
  assert.equal(claimTimerBand(7 * DAY), 'yellow');
  assert.equal(claimTimerBand(2 * DAY), 'yellow');
  assert.equal(claimTimerBand(DAY + 1), 'yellow');
  assert.equal(claimTimerBand(DAY), 'red final');
  assert.equal(claimTimerBand(DAY - 1), 'red final');
  assert.equal(claimTimerBand(0), 'expired');
  assert.equal(claimTimerBand(-5000), 'expired');
});

console.log(`\n${passed} passed, 0 failed`);
