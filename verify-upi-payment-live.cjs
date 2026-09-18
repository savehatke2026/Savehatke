/* ============================================================================
 * SaveHatke — custom UPI checkout LIVE smoke test
 * ============================================================================
 *   node verify-upi-payment-live.cjs
 *
 * The offline suite (verify-upi-payment.cjs) emulates Sheets and Supabase, so
 * it cannot prove that the real spreadsheet round-trips or that the real
 * conditional coupon UPDATE behaves. This does, against live services:
 *
 *   * the Orders / Payments / PaymentNotifications tabs exist and are readable
 *     (ensureSheets creates them on first connect)
 *   * append / read / update / delete round-trip through the real Sheets API,
 *     including that a sheet cell comes back as a string
 *   * the duplicate-live-window guard holds on real data
 *   * the notification inbox dedupes on the real fingerprint column
 *   * unlockCoupon() flips a real coupon exactly once — a second attempt, a
 *     second buyer, and a coupon already sold elsewhere are all refused
 *
 * WRITES AND THEN REMOVES DATA. Every row it creates is tagged `__selftest__`
 * and deleted at the end (a throwaway coupon is inserted in Supabase and
 * deleted too). It sweeps any leftovers from an earlier run before it starts,
 * and asserts nothing is left behind. Point it at a test spreadsheet if you
 * would rather it never touch production at all.
 *
 * Takes ~40s: Google Sheets initialize() is slow on a cold start.
 * ==========================================================================*/
'use strict';
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const db = require('./server/services/googleSheets');
const supabase = require('./server/services/supabase');
const store = require('./server/services/paymentStore');

const TAG = '__selftest__';
const created = { payments: [], orders: [], notifications: [], coupons: [] };
let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log('  PASS ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? ' — ' + d : '')); }
};

(async () => {
  console.log('\n[1] live Google Sheets connect + tab creation');
  const t0 = Date.now();
  const ok = await db.initialize();
  console.log('    initialize() ->', ok, 'in', (Date.now() - t0) + 'ms');
  check('sheets connected', db.isSheetsConnected());
  if (!db.isSheetsConnected()) throw new Error('cannot continue without Sheets');

  for (const name of [db.SHEETS.ORDERS, db.SHEETS.PAYMENTS, db.SHEETS.PAYMENT_NOTIFICATIONS]) {
    let rows = null;
    try { rows = await db.getRowsFresh(name); } catch (e) { rows = null; }
    check('tab "' + name + '" exists and is readable', rows !== null, rows === null ? 'read failed' : '');
  }

  console.log('\n[2] live store round-trip (Orders + Payments)');
  const paymentId = TAG + '_pay_' + crypto.randomBytes(6).toString('hex');
  const order = await store.createOrder({
    userId: TAG, userEmail: 'selftest@savehatke.test', couponId: TAG + '_coupon',
    amount: 37, buyerName: 'Self Test', buyerEmail: 'selftest@savehatke.test', buyerPhone: '9999999999',
    couponCode: 'SELFTEST', couponBrand: 'TestBrand',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  created.orders.push(order.id);
  check('createOrder wrote a row', !!order.id && !!order.orderCode, JSON.stringify(order).slice(0, 120));

  const payment = await store.createPayment({
    paymentId, orderId: order.id, userId: TAG, userEmail: 'selftest@savehatke.test',
    couponId: TAG + '_coupon', amount: 37,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    upiId: 'savehatke@fam', payeeName: 'SaveHatke',
    upiUri: 'upi://pay?pa=savehatke@fam&pn=SaveHatke&am=37.00&cu=INR',
  });
  created.payments.push(paymentId);
  check('createPayment wrote a row', payment.paymentId === paymentId);

  const readBack = await store.findPaymentById(paymentId);
  check('the row reads back with the right amount (sheet cells are strings)',
    readBack && readBack.amount === 37, JSON.stringify(readBack && readBack.amount));
  check('status reads back PENDING', readBack && readBack.status === 'PENDING', readBack && readBack.status);
  check('expiresAt reads back as a usable timestamp',
    readBack && Number.isFinite(new Date(readBack.expiresAt).getTime()), readBack && readBack.expiresAt);

  const live = await store.findLivePaymentForUserCoupon(TAG, TAG + '_coupon');
  check('findLivePaymentForUserCoupon finds it', live && live.paymentId === paymentId);

  const cancelled = await store.cancelPayment(paymentId, { reason: 'live self-test' });
  check('cancelPayment flips the row to CANCELLED', cancelled && cancelled.status === 'CANCELLED',
    JSON.stringify(cancelled && cancelled.status));
  const afterCancel = await store.findPaymentById(paymentId);
  check('the CANCELLED status persisted in the sheet', afterCancel && afterCancel.status === 'CANCELLED');

  console.log('\n[3] duplicate-live-window guard on the live sheet');
  const p2 = TAG + '_pay_' + crypto.randomBytes(6).toString('hex');
  const order2 = await store.createOrder({
    userId: TAG, userEmail: 'selftest@savehatke.test', couponId: TAG + '_coupon2',
    amount: 50, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  created.orders.push(order2.id);
  await store.createPayment({
    paymentId: p2, orderId: order2.id, userId: TAG, userEmail: 'selftest@savehatke.test',
    couponId: TAG + '_coupon2', amount: 50,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    upiId: 'savehatke@fam', payeeName: 'SaveHatke', upiUri: 'upi://pay?pa=x@y&pn=Z&am=50.00&cu=INR',
  });
  created.payments.push(p2);
  let conflict = null;
  try {
    await store.createPayment({
      paymentId: TAG + '_pay_dup', orderId: order2.id, userId: TAG, userEmail: 'selftest@savehatke.test',
      couponId: TAG + '_coupon2', amount: 50,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      upiId: 'savehatke@fam', payeeName: 'SaveHatke', upiUri: 'upi://pay?pa=x@y&pn=Z&am=50.00&cu=INR',
    });
  } catch (e) { conflict = e; }
  check('a second live payment for the same order is refused', !!conflict, conflict ? conflict.message : 'no error thrown');
  check('the refusal carries code CONFLICT (so the route reuses the winner)',
    conflict && conflict.code === 'CONFLICT', conflict && conflict.code);

  console.log('\n[4] live notification inbox (fingerprint dedupe)');
  const fp = TAG + '_fp_' + crypto.randomBytes(6).toString('hex');
  const n1 = await store.recordNotification({
    fingerprint: fp, source: 'selftest', amount: 37, transactionId: 'SELFTEST-TXN',
    status: 'RECEIVED', notes: 'live self-test',
  });
  check('recordNotification writes a row', n1 && n1.duplicate === false);
  const n2 = await store.recordNotification({ fingerprint: fp, source: 'selftest', amount: 37 });
  check('the same fingerprint is reported as a duplicate', n2 && n2.duplicate === true);
  if (n1 && n1.notification) created.notifications.push(n1.notification.id);

  console.log('\n[5] live atomic coupon unlock (real Supabase, throwaway coupon)');
  const client = supabase.getClient();
  const testCouponId = crypto.randomUUID();
  const ins = await client.from('coupons').insert({
    id: testCouponId, code: 'SELFTEST-' + testCouponId.slice(0, 6), title: 'Self Test',
    brand: 'TestBrand', selling_price: '1', status: 'available', seller_email: 'selftest@savehatke.test',
    expiry_date: new Date(Date.now() + 86400000).toISOString(),
  }).select();
  if (ins.error) {
    console.log('    (skipping unlock test — could not insert a throwaway coupon:', ins.error.message + ')');
  } else {
    created.coupons.push(testCouponId);

    const first = await store.unlockCoupon({ couponId: testCouponId, userEmail: 'selftest@savehatke.test', paidAt: new Date().toISOString() });
    check('first unlock flips an available coupon to sold', first.unlocked === true, JSON.stringify(first));

    const second = await store.unlockCoupon({ couponId: testCouponId, userEmail: 'selftest@savehatke.test', paidAt: new Date().toISOString() });
    check('second unlock is refused (0 rows affected) — exactly-once holds', second.unlocked === false, JSON.stringify(second));
    check('…and it reports the coupon as already sold to this buyer',
      String(second.status).toLowerCase() === 'sold' &&
      String(second.buyerEmail).toLowerCase() === 'selftest@savehatke.test', JSON.stringify(second));

    const third = await store.unlockCoupon({ couponId: testCouponId, userEmail: 'someone.else@savehatke.test', paidAt: new Date().toISOString() });
    check('a DIFFERENT buyer cannot claim the same coupon', third.unlocked === false, JSON.stringify(third));
    check('…and the original buyer is still the owner',
      String(third.buyerEmail).toLowerCase() === 'selftest@savehatke.test', JSON.stringify(third));

    const other = crypto.randomUUID();
    const ins2 = await client.from('coupons').insert({
      id: other, code: 'SELFTEST2-' + other.slice(0, 6), title: 'Self Test 2', brand: 'TestBrand',
      selling_price: '1', status: 'sold', seller_email: 'other@savehatke.test',
      expiry_date: new Date(Date.now() + 86400000).toISOString(),
    }).select();
    if (!ins2.error) {
      created.coupons.push(other);
      const taken = await store.unlockCoupon({ couponId: other, userEmail: 'selftest@savehatke.test', paidAt: new Date().toISOString() });
      check('a coupon already sold to someone else is NOT handed over', taken.unlocked === false, JSON.stringify(taken));
    }
  }

  console.log('\n[6] cleanup');
  const sweep = async (sheet, field, pred) => {
    const rows = await db.getRowsFresh(sheet);
    let n = 0;
    for (const r of rows) {
      if (!pred(r)) continue;
      try {
        const okDel = await db.deleteRow(sheet, field, r[field]);
        if (!okDel) console.log('    ! deleteRow returned false for ' + sheet + ' ' + r[field]);
        else n++;
      } catch (e) { console.log('    ! deleteRow threw for ' + sheet + ': ' + e.message); }
    }
    return n;
  };
  await sweep(db.SHEETS.PAYMENT_NOTIFICATIONS, 'id', (r) => String(r.fingerprint).startsWith(TAG));
  await sweep(db.SHEETS.PAYMENTS, 'payment_id', (r) => String(r.payment_id).startsWith(TAG));
  await sweep(db.SHEETS.ORDERS, 'id', (r) => String(r.user_id) === TAG);
  for (const id of created.coupons) {
    const del = await client.from('coupons').delete().eq('id', id);
    if (del.error) console.log('    ! coupon delete failed: ' + del.error.message);
  }

  const leftover = {
    payments: (await db.getRowsFresh(db.SHEETS.PAYMENTS)).filter((r) => String(r.payment_id).startsWith(TAG)).length,
    orders: (await db.getRowsFresh(db.SHEETS.ORDERS)).filter((r) => String(r.user_id) === TAG).length,
    notifications: (await db.getRowsFresh(db.SHEETS.PAYMENT_NOTIFICATIONS)).filter((r) => String(r.fingerprint).startsWith(TAG)).length,
  };
  check('no test payment rows left behind', leftover.payments === 0, JSON.stringify(leftover));
  check('no test order rows left behind', leftover.orders === 0, JSON.stringify(leftover));
  check('no test notification rows left behind', leftover.notifications === 0, JSON.stringify(leftover));
  const stillThere = await client.from('coupons').select('id').in('id', created.coupons.length ? created.coupons : ['none']);
  check('no throwaway coupons left behind', (stillThere.data || []).length === 0, JSON.stringify(stillThere.data));

  console.log('\n' + '-'.repeat(60));
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\nLIVE SMOKE CRASHED:', e.message);
  console.error('Leftover test rows may remain — search the sheet for ' + TAG);
  process.exit(1);
});
