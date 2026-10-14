// Regression: refund_amount is stored in RUPEES (services/refunds.js writes
// money2 → "20.00"). Earlier readers divided by 100 as if it were paise, so a
// ₹20 refund was counted as ₹0.20 on the Revenue dashboard and in the ledger.
// Expected values below are hardcoded from the business rule, not computed by
// the code under test. Pure logic: no Sheets, Supabase or network access.
// Run: node server/tests/refundUnits.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const finance = require(path.join(__dirname, '..', 'services', 'finance'));
const ledger = require(path.join(__dirname, '..', 'services', 'adminLedger'));

const { computeOverviewFromData, resolveWindow } = finance;

let passed = 0;
let failed = 0;
const lines = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    lines.push(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    lines.push(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

// A fixed "now" well inside a month so the 'all' window is unambiguous.
const NOW = Date.parse('2026-10-14T12:00:00+05:30');
const WIN = resolveWindow('all', { now: NOW });
const IN_WINDOW = '2026-10-10T10:00:00+05:30';

function refund(overrides = {}) {
  return {
    id: 'rfnd_1', payment_id: 'pay_1', status: 'refunded',
    refund_amount: '20.00', created_at: IN_WINDOW, ...overrides,
  };
}

check('refunded ₹20.00 row is counted as ₹20, not ₹0.20', () => {
  const o = computeOverviewFromData({ orders: [], coupons: [], refunds: [refund()], payouts: [], admins: [] }, WIN);
  assert.equal(o.refundedValue, 20);
  assert.equal(o.counts.refundsCompleted, 1);
});

check('multiple refunds sum in rupees (₹20.00 + ₹99.50 = ₹119.50)', () => {
  const o = computeOverviewFromData({
    orders: [], coupons: [], payouts: [], admins: [],
    refunds: [refund({ id: 'a', refund_amount: '20.00' }), refund({ id: 'b', payment_id: 'pay_2', refund_amount: '99.50' })],
  }, WIN);
  assert.equal(o.refundedValue, 119.5);
});

check('pending/processing refund does not reduce refundedValue', () => {
  const o = computeOverviewFromData({
    orders: [], coupons: [], payouts: [], admins: [],
    refunds: [refund({ status: 'pending' }), refund({ id: 'b', payment_id: 'pay_2', status: 'processing' })],
  }, WIN);
  assert.equal(o.refundedValue, 0);
  assert.equal(o.counts.refundsOpen, 2);
});

check('settled sales = gross − refunds, in rupees (₹100 paid, ₹20 refunded → ₹80)', () => {
  const orders = [{ id: 'o1', amount: '100', status: 'PAID', created_at: IN_WINDOW }];
  const o = computeOverviewFromData({ orders, coupons: [], refunds: [refund()], payouts: [], admins: [] }, WIN);
  assert.equal(o.grossSales, 100);
  assert.equal(o.refundedValue, 20);
  assert.equal(o.settledSales, 80);
});

// Waterfall: every order status lands in exactly one bucket, and REVIEW (an
// underpayment parked for admin action) is never counted as settled revenue.
check('REVIEW order is not counted as settled sales (₹100 PAID + ₹50 REVIEW → settled ₹100)', () => {
  const orders = [
    { id: 'a', amount: '100', status: 'PAID', created_at: IN_WINDOW },
    { id: 'b', amount: '50', status: 'REVIEW', created_at: IN_WINDOW },
  ];
  const o = computeOverviewFromData({ orders, coupons: [], refunds: [], payouts: [], admins: [] }, WIN);
  assert.equal(o.reviewValue, 50);
  assert.equal(o.settledSales, 100);
  assert.equal(o.counts.reviewOrders, 1);
});

check('waterfall buckets sum to gross: PAID 100 + PENDING 30 + CANCELLED 20 + REVIEW 50 = 200', () => {
  const orders = [
    { id: 'a', amount: '100', status: 'PAID', created_at: IN_WINDOW },
    { id: 'b', amount: '30', status: 'PENDING', created_at: IN_WINDOW },
    { id: 'c', amount: '20', status: 'EXPIRED', created_at: IN_WINDOW },
    { id: 'd', amount: '50', status: 'REVIEW', created_at: IN_WINDOW },
  ];
  const o = computeOverviewFromData({ orders, coupons: [], refunds: [], payouts: [], admins: [] }, WIN);
  assert.equal(o.grossSales, 200);
  assert.equal(o.paidValue + o.pendingValue + o.cancelledValue + o.reviewValue, 200);
  assert.equal(o.settledSales, 100);
});

check('ledger refundRow reports the rupee amount unchanged', () => {
  const r = ledger._internals.refundRow({ id: 'rfnd_1', refund_amount: '20.00', status: 'refunded' });
  assert.equal(r.amount, 20);
});

console.log(lines.join('\n'));
console.log(`\nrefundUnits: ${passed} passed, ${failed} failed`);
