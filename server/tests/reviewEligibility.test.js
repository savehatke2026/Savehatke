// Review eligibility regression: a purchase whose live coupon row was removed
// from the Coupons sheet must still be reviewable by its buyer, using the same
// paid order + payment record that /my-purchases shows. Unrelated users,
// mismatched identifiers, missing purchases and storage failures must not pass.
// All data is in-memory fixtures; no Sheets or Supabase calls are made.
const assert = require('assert');
const path = require('path');

const dbPath = require.resolve(path.join(__dirname, '../services/googleSheets.js'));

const BUYER = { id: 'user-buyer', email: 'buyer@example.com' };
const OTHER = { id: 'user-other', email: 'other@example.com' };
const COUPON_ID = 'coupon-1';

let fixtures;
let failRead = false;

function installStubs() {
  // Replace the Sheets module with an in-memory stub before the route loads.
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      SHEETS: { COUPONS: 'Coupons', ORDERS: 'Orders', PAYMENTS: 'Payments', REVIEWS: 'Reviews' },
      async findRow(sheet, key, value) {
        if (failRead) throw new Error('sheets unavailable');
        return (fixtures[sheet] || []).find((r) => String(r[key]) === String(value)) || null;
      },
      async findRows(sheet, key, value) {
        if (failRead) throw new Error('sheets unavailable');
        return (fixtures[sheet] || []).filter((r) => String(r[key]) === String(value));
      },
      async getRowsFresh(sheet) {
        if (failRead) throw new Error('sheets unavailable');
        return fixtures[sheet] || [];
      },
      async appendRow(sheet, row) { (fixtures[sheet] = fixtures[sheet] || []).push(row); },
      async updateRow() {},
      async deleteRow() {},
    },
  };
  // Drop any previously loaded route so it picks up the stubbed Sheets module.
  delete require.cache[require.resolve(path.join(__dirname, '../routes/reviews.js'))];
}

function paidOrderFixtures() {
  return {
    Coupons: [], // live coupon row is gone (sold + removed from inventory)
    Orders: [{
      id: 'order-1', order_code: 'SH-PUR-1', user_id: BUYER.id, user_email: BUYER.email,
      buyer_email: BUYER.email, coupon_id: COUPON_ID, amount: '50', status: 'PAID',
      coupon_brand: 'Amazon', paid_at: '2026-10-01T10:00:00Z',
      coupon_snapshot: JSON.stringify({ brand: 'Amazon', title: '₹500 off', sellingPrice: 50, sellerEmail: 'seller@example.com' }),
    }],
    Payments: [{
      payment_id: 'pay-1', order_id: 'order-1', user_id: BUYER.id, user_email: BUYER.email,
      coupon_id: COUPON_ID, amount: '50', status: 'PAID', updated_at: '2026-10-01T10:00:00Z',
    }],
    Reviews: [],
  };
}

// Minimal Express-like response capture.
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function postReview(route, user, body) {
  const layer = route.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { user, body };
  const res = fakeRes();
  await handler(req, res);
  return res;
}

(async () => {
  installStubs();
  const route = require(path.join(__dirname, '../routes/reviews.js'));
  const check = (name, fn) => Promise.resolve(fn()).then(() => console.log('PASS  ' + name));
  const run = async () => {
    // 1. Purchased coupon still listed (live row present) — accepted.
    fixtures = paidOrderFixtures();
    fixtures.Coupons = [{ id: COUPON_ID, buyerEmail: BUYER.email, sellerEmail: 'seller@example.com', status: 'sold', soldAt: '2026-10-01T10:00:00Z', brand: 'Amazon', title: '₹500 off', sellingPrice: 50 }];
    let r = await postReview(route, BUYER, { couponId: COUPON_ID, rating: 5, reviewText: 'Great' });
    assert.strictEqual(r.statusCode, 201, 'live coupon review should be accepted');
    await check('1. purchased coupon still listed is reviewable', () => assert.strictEqual(r.body.review.couponId, COUPON_ID));

    // 2. Purchased coupon removed from the marketplace but in purchase history — accepted.
    fixtures = paidOrderFixtures();
    r = await postReview(route, BUYER, { couponId: COUPON_ID, rating: 4, reviewText: '' });
    assert.strictEqual(r.statusCode, 201, 'removed-but-purchased review should be accepted');
    await check('2. removed coupon with paid order is reviewable', () => assert.strictEqual(r.body.review.brand, 'Amazon'));

    // 3. Unrelated user cannot review someone else's purchase.
    fixtures = paidOrderFixtures();
    r = await postReview(route, OTHER, { couponId: COUPON_ID, rating: 5, reviewText: '' });
    assert.notStrictEqual(r.statusCode, 201);
    await check('3. unrelated user is rejected', () => assert.ok([403, 404].includes(r.statusCode)));

    // 4. Duplicate review is rejected.
    fixtures = paidOrderFixtures();
    fixtures.Reviews = [{ id: 'rev-1', couponId: COUPON_ID, buyerEmail: BUYER.email }];
    r = await postReview(route, BUYER, { couponId: COUPON_ID, rating: 5, reviewText: '' });
    assert.strictEqual(r.statusCode, 409, 'duplicate should be 409');
    await check('4. duplicate review returns 409', () => assert.strictEqual(r.statusCode, 409));

    // 5. Purchase missing or incomplete (order not PAID) is rejected.
    fixtures = paidOrderFixtures();
    fixtures.Orders[0].status = 'PENDING';
    r = await postReview(route, BUYER, { couponId: COUPON_ID, rating: 5, reviewText: '' });
    assert.strictEqual(r.statusCode, 404, 'unpaid order with no live coupon should be 404');
    await check('5. missing/incomplete purchase is rejected', () => assert.strictEqual(r.statusCode, 404));

    // 6. Mismatched identifiers: a purchase/order id is not a coupon id — rejected.
    fixtures = paidOrderFixtures();
    r = await postReview(route, BUYER, { couponId: 'order-1', rating: 5, reviewText: '' });
    assert.strictEqual(r.statusCode, 404, 'order id must not be accepted as a coupon id');
    await check('6. order id used as coupon id is rejected', () => assert.strictEqual(r.statusCode, 404));

    // 7. Database temporarily unavailable — temporary error, never "no longer exists".
    fixtures = paidOrderFixtures();
    failRead = true;
    r = await postReview(route, BUYER, { couponId: COUPON_ID, rating: 5, reviewText: '' });
    failRead = false;
    assert.strictEqual(r.statusCode, 500, 'storage failure should be 500');
    assert.notStrictEqual(r.body.error, 'That coupon no longer exists.');
    await check('7. storage outage gives a temporary error, not "no longer exists"', () => assert.strictEqual(r.statusCode, 500));
  };

  try {
    await run();
    console.log('\nreviewEligibility: all checks passed');
  } catch (err) {
    console.error('FAIL  ' + err.message);
    process.exitCode = 1;
  }
})();
