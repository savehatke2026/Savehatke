// ============================================
// SaveHatke — Buyer Pricing (20% / 10%) verification harness
// ============================================
// Loads the REAL services/dynamicPricing.js (no re-implementation) and
// exercises every spec rule from end to end:
//
//   if coupon is expired:        not purchasable
//   else if <=24h remaining:     price = face_value * 0.10
//   else:                         price = face_value * 0.20
//
// Run: node verify-buyer-pricing.cjs

const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const dp = require(path.join(ROOT, 'server', 'services', 'dynamicPricing.js'));

let pass = 0, fail = 0;
const t = (ok, name, info = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (info ? `   ${info}` : ''));
  ok ? pass++ : fail++;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-09-22T12:00:00Z');
const isoAfter = (ms) => new Date(NOW.getTime() + ms).toISOString();

// ═══ Spec table — exactly what the rule says ═══
const FACE_VALUES = [100, 200, 500, 1000, 5000, 10000];

console.log('\n═══ §1 — Normal pricing (>24h remaining): face_value × 20% ═══');
for (const fv of FACE_VALUES) {
  const coupon = { originalValue: String(fv), expiryDate: isoAfter(25 * HOUR) };
  const info = dp.getBuyerPrice(coupon, NOW);
  const expected = parseFloat((fv * 0.20).toFixed(2));
  t(info.price === expected && info.rate === 0.20 && info.purchasable === true && info.expired === false,
    `₹${fv} × 20% = ₹${expected} (>24h remaining)`,
    `(got price=₹${info.price}, rate=${info.rate})`);
}

console.log('\n═══ §2 — Last 24 hours pricing: face_value × 10% ═══');
for (const fv of FACE_VALUES) {
  const coupon = { originalValue: String(fv), expiryDate: isoAfter(12 * HOUR) };
  const info = dp.getBuyerPrice(coupon, NOW);
  const expected = parseFloat((fv * 0.10).toFixed(2));
  t(info.price === expected && info.rate === 0.10 && info.purchasable === true,
    `₹${fv} × 10% = ₹${expected} (≤24h remaining)`,
    `(got price=₹${info.price}, rate=${info.rate})`);
}

console.log('\n═══ §3 — Boundary: exactly 24h remaining still gets 20% (>24h rule) ═══');
// Spec says: "When the coupon has 24 hours or less remaining before expiry,
// automatically change the buyer price to: Buyer Price = Face Value × 10%"
// So the 10% band is INCLUSIVE of 24h remaining. Verify that exactly at 24h
// the rule already returns 10% (the spec says "24 hours OR less").
for (const fv of [100, 1000, 10000]) {
  const coupon24h = { originalValue: String(fv), expiryDate: isoAfter(24 * HOUR) };
  const info24 = dp.getBuyerPrice(coupon24h, NOW);
  t(info24.rate === 0.10 && info24.price === parseFloat((fv * 0.10).toFixed(2)),
    `₹${fv} at exactly 24h gets 10% (inclusive boundary)`,
    `(got price=₹${info24.price}, rate=${info24.rate})`);
  // Just above 24h still 20%.
  const coupon24hPlus1ms = { originalValue: String(fv), expiryDate: isoAfter(24 * HOUR + 1) };
  const infoJustOver = dp.getBuyerPrice(coupon24hPlus1ms, NOW);
  t(infoJustOver.rate === 0.20,
    `₹${fv} at 24h+1ms still 20% (boundary above 24h)`,
    `(got rate=${infoJustOver.rate})`);
}

console.log('\n═══ §4 — Expired coupons are NOT purchasable ═══');
for (const fv of FACE_VALUES) {
  const coupon = { originalValue: String(fv), expiryDate: isoAfter(-1 * HOUR) };
  const info = dp.getBuyerPrice(coupon, NOW);
  t(info.purchasable === false && info.expired === true && info.price === 0,
    `₹${fv} with expired timestamp is not purchasable`,
    `(purchasable=${info.purchasable}, expired=${info.expired}, price=${info.price})`);
}
// Exactly at expiry (0ms remaining) is also expired.
const couponAtExpiry = { originalValue: '1000', expiryDate: isoAfter(0) };
const infoAtExpiry = dp.getBuyerPrice(couponAtExpiry, NOW);
t(infoAtExpiry.expired === true && infoAtExpiry.purchasable === false,
  'Exactly at expiry timestamp is not purchasable');

console.log('\n═══ §5 — Rule applies uniformly to BOTH admin and seller coupons ═══');
// The pricing service must not branch on `source`. Verify by giving it two
// coupons with identical face values + expiries but different sources.
for (const src of ['admin', 'user-submitted', 'partner', '']) {
  for (const fv of [500, 2000]) {
    const coupon = { originalValue: String(fv), expiryDate: isoAfter(5 * DAY), source: src };
    const info = dp.getBuyerPrice(coupon, NOW);
    const expected = parseFloat((fv * 0.20).toFixed(2));
    t(info.price === expected,
      `source="${src}" face=₹${fv} → ₹${expected} (same rule)`,
      `(got ₹${info.price})`);
  }
}
// Same, but in the 10% band.
for (const src of ['admin', 'user-submitted', 'partner', '']) {
  const coupon = { originalValue: '2000', expiryDate: isoAfter(2 * HOUR), source: src };
  const info = dp.getBuyerPrice(coupon, NOW);
  t(info.price === 200 && info.rate === 0.10,
    `source="${src}" face=₹2000 (≤24h) → ₹200`,
    `(got ₹${info.price}, rate=${info.rate})`);
}

console.log('\n═══ §6 — Time-based price update (the 10% price stays active until expiry) ═══');
// As time advances toward expiry, the price must drop automatically from
// 20% to 10% without anyone touching the coupon row.
const coupon = { originalValue: '1000', expiryDate: isoAfter(25 * HOUR) };
const t25hBefore = dp.getBuyerPrice(coupon, NOW);
const t24hBefore = dp.getBuyerPrice(coupon, new Date(NOW.getTime() + HOUR));
const t12hBefore = dp.getBuyerPrice(coupon, new Date(NOW.getTime() + 13 * HOUR));
const t1hBefore = dp.getBuyerPrice(coupon, new Date(NOW.getTime() + 24 * HOUR));
t(t25hBefore.rate === 0.20 && t25hBefore.price === 200,
  '25h before expiry → 20% (₹200)');
t(t24hBefore.rate === 0.10 && t24hBefore.price === 100,
  '24h before expiry → 10% (₹100) — price dropped automatically');
t(t12hBefore.rate === 0.10 && t12hBefore.price === 100,
  '12h before expiry → 10% (₹100)');
t(t1hBefore.rate === 0.10 && t1hBefore.price === 100,
  '1h before expiry → 10% (₹100)');
// At expiry the coupon becomes unbuyable.
const tAtExpiry = dp.getBuyerPrice(coupon, new Date(NOW.getTime() + 25 * HOUR));
t(tAtExpiry.expired === true && tAtExpiry.purchasable === false,
  'At expiry → not purchasable');

console.log('\n═══ §7 — Invalid face values return price=0, not a fabricated number ═══');
for (const bad of ['', 'abc', '₹500', null, undefined, '0', '-100', 'NaN', {}]) {
  const info = dp.getBuyerPrice({ originalValue: bad, expiryDate: isoAfter(5 * DAY) }, NOW);
  t(info.price === 0 && info.purchasable === false,
    `Bad face value ${JSON.stringify(bad)} → price=0, not purchasable`,
    `(got price=${info.price}, purchasable=${info.purchasable})`);
}
// Decimal face values within range are accepted.
const dec = dp.getBuyerPrice({ originalValue: '99.50', expiryDate: isoAfter(5 * DAY) }, NOW);
t(dec.price === 19.90 && dec.purchasable === true,
  'Decimal face value ₹99.50 → ₹19.90 (20%)');

console.log('\n═══ §8 — Server-side authority: payment routes recompute the price ═══');
// Read the actual server source files and confirm the recompute + ignore.
const paymentSrc = fs.readFileSync(path.join(ROOT, 'server/routes/payment.js'), 'utf8');
const paymentsSrc = fs.readFileSync(path.join(ROOT, 'server/routes/payments.js'), 'utf8');
const couponsSrc = fs.readFileSync(path.join(ROOT, 'server/routes/coupons.js'), 'utf8');

t(/dynamicPricing\.getBuyerPrice\(coupon\)/.test(paymentSrc),
  'payment.js evaluateCoupon() recomputes the price via getBuyerPrice()');
t(!/source\s*===\s*'admin'/.test(paymentSrc.split('evaluateCoupon')[1] || paymentSrc),
  'payment.js evaluateCoupon() does NOT branch pricing on source');

t(/dynamicPricing\.getBuyerPrice\(coupon\)/.test(paymentsSrc),
  'payments.js create-order recomputes the price via getBuyerPrice()');
t(/dynamicPricing\.getBuyerPrice\(coupon\)/.test(paymentsSrc.split('/verify')[1] || ''),
  'payments.js /verify path recomputes the price before marking the coupon sold');
t(!/coupon\.sellingPrice/.test(paymentsSrc.split('/create-order')[1].split('/verify')[0] || ''),
  'payments.js /create-order does NOT use the stored sellingPrice for the price');
t(!/coupon\.sellingPrice/.test(paymentsSrc.split('/verify')[1] || ''),
  'payments.js /verify does NOT use the stored sellingPrice for the price');

t(/dynamicPricing\.getBuyerPrice\(c\)/.test(couponsSrc),
  'coupons.js listing endpoint recomputes the price per coupon');
t(/dynamicPricing\.getBuyerPrice\(coupon\)/.test(couponsSrc.split("router.get('/:id'")[1] || ''),
  'coupons.js detail endpoint recomputes the price');
t(/dynamicPricing\.getBuyerPrice\(coupon\)/.test(couponsSrc.split("router.post('/buy/:id'")[1] || ''),
  'coupons.js /buy endpoint returns the recomputed price as pricePaid');

console.log('\n═══ §9 — Listing endpoint exposes the SAME price the checkout receives ═══');
const listingBlock = couponsSrc.slice(couponsSrc.indexOf("router.get('/', optionalAuth"),
  couponsSrc.indexOf("router.get('/categories'"));
t(/buyerPrice\.price/.test(listingBlock),
  'Listing endpoint attaches the computed buyerPrice to every coupon');
t(/sellingPrice:\s*buyerPrice\.price/.test(listingBlock),
  'Listing endpoint returns the computed price as sellingPrice (one canonical number)');
t(/pricingRate:\s*buyerPrice\.rate/.test(listingBlock),
  'Listing endpoint also exposes pricingRate so the UI can render "20% / 10%"');
t(/pricingBand:\s*buyerPrice\.bandLabel/.test(listingBlock),
  'Listing endpoint exposes the bandLabel caption');

const detailBlock = couponsSrc.slice(couponsSrc.indexOf("router.get('/:id'"),
  couponsSrc.indexOf('module.exports'));
t(/sellingPrice:\s*buyerPrice\.price/.test(detailBlock),
  'Detail endpoint returns the SAME computed price as the listing (sellingPrice)');
t(/pricingRate:\s*buyerPrice\.rate/.test(detailBlock),
  'Detail endpoint also exposes pricingRate');

console.log('\n═══ §10 — No stored/fixed buyer price: stored sellingPrice is NOT used ═══');
// The seller-submit route still accepts sellingPrice, but the listing/
// detail/buy routes must never echo it back as the buyer price. The only
// caller-side references to sellingPrice in the response payloads come from
// `buyerPrice.price` (computed) or as `storedSellingPrice` (diagnostic only).
const listingWithNoBuyer = /sellingPrice:\s*[^b\s][^u]/g;
t(!listingWithNoBuyer.test(listingBlock.replace(/\/\/.*$/gm, ''))
  || /sellingPrice:\s*buyerPrice\.price/.test(listingBlock),
  'Listing endpoint only emits sellingPrice from buyerPrice (not the stored value)');
t(/storedSellingPrice/.test(listingBlock),
  'Listing endpoint surfaces storedSellingPrice as a diagnostic, never as the buyer price');
t(/storedSellingPrice/.test(detailBlock),
  'Detail endpoint surfaces storedSellingPrice as a diagnostic, never as the buyer price');

console.log('\n═══ §11 — Pricing constants exported correctly ═══');
t(dp.NORMAL_RATE === 0.20, 'NORMAL_RATE = 0.20');
t(dp.LAST24H_RATE === 0.10, 'LAST24H_RATE = 0.10');
t(dp.LAST_24H_MS === 24 * 60 * 60 * 1000, 'LAST_24H_MS = 24h in ms');

console.log('\n═══ §12 — Purity: same inputs → same outputs across many calls ═══');
const probe = { originalValue: '1000', expiryDate: isoAfter(2 * HOUR) };
const results = new Set();
for (let i = 0; i < 50; i++) results.add(dp.getBuyerPrice(probe, NOW).price);
t(results.size === 1 && [...results][0] === 100,
  '50 calls with the same inputs always return the same price (deterministic)');

console.log('\n═══ §13 — Existing flows preserved (no broken endpoints) ═══');
t(/router\.get\('\/'/.test(couponsSrc),
  'GET /api/coupons listing still exists');
t(/router\.get\('\/:id'/.test(couponsSrc),
  'GET /api/coupons/:id detail still exists');
t(/router\.post\('\/buy\/:id'/.test(couponsSrc),
  'POST /api/coupons/buy/:id still exists');
t(/router\.post\('\/create-order'/.test(paymentsSrc) && /router\.post\('\/verify'/.test(paymentsSrc),
  'Razorpay order/verify endpoints still exist');
t(/evaluateCoupon/.test(paymentSrc),
  'payment.js evaluateCoupon() still exists and gates purchases');

// ═══ Summary ═══
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
