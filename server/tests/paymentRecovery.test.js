// Reconciliation / recovery against the REAL expireIfDue + recoverSoldPayment.
// MOCKED: Google Sheets (googleSheets) and the Supabase client (coupons table).
// The payment store logic is real. Run: node server/tests/paymentRecovery.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const db = require(path.join(__dirname, '..', 'services', 'googleSheets'));
const supabase = require(path.join(__dirname, '..', 'services', 'supabase'));
const store = require(path.join(__dirname, '..', 'services', 'paymentStore'));

const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

let passed = 0;
let failed = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    results.push(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const originals = {
  getRowsFresh: db.getRowsFresh,
  getRows: db.getRows,
  findRowsFresh: db.findRowsFresh,
  updateRow: db.updateRow,
  appendRow: db.appendRow,
  isConfigured: supabase.isConfigured,
  getClient: supabase.getClient,
};

let sheet;
let coupons;
let flags;
function reset() {
  sheet = { [db.SHEETS.PAYMENTS]: [], [db.SHEETS.ORDERS]: [] };
  coupons = new Map();
  flags = { paidWriteFails: false };
}

function install() {
  db.getRowsFresh = async (name) => (sheet[name] || []).map((r) => ({ ...r }));
  db.getRows = db.getRowsFresh;
  db.findRowsFresh = async (name, field, value) =>
    (sheet[name] || []).filter((r) => String(r[field]) === String(value)).map((r) => ({ ...r }));
  db.updateRow = async (name, keyField, keyValue, patch) => {
    if (flags.paidWriteFails && name === db.SHEETS.PAYMENTS && patch.status === 'PAID') {
      throw new Error('Sheets write failed');
    }
    const row = (sheet[name] || []).find((r) => String(r[keyField]) === String(keyValue));
    if (!row) return false;
    Object.assign(row, patch);
    return true;
  };
  db.appendRow = async (name, row) => { (sheet[name] = sheet[name] || []).push({ ...row }); return true; };
  supabase.isConfigured = () => true;
  supabase.getClient = () => ({
    from: (table) => {
      if (table === 'payment_reference_claims') {
        // Recovery must not touch claims; fail loudly if it does.
        const bad = () => { throw new Error('recovery must not write claims'); };
        return { insert: bad, delete: bad, select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null, error: null }) };
      }
      return couponsApi();
    },
  });
}

function couponsApi() {
  const q = { filters: {} };
  return {
    select() { return this; },
    eq(c, v) { q.filters[c] = String(v); return this; },
    maybeSingle: async () => {
      const c = coupons.get(q.filters.id);
      return { data: c ? { ...c } : null, error: null };
    },
  };
}

function restore() {
  Object.assign(db, { getRowsFresh: originals.getRowsFresh, getRows: originals.getRows, findRowsFresh: originals.findRowsFresh, updateRow: originals.updateRow, appendRow: originals.appendRow });
  supabase.isConfigured = originals.isConfigured;
  supabase.getClient = originals.getClient;
}

const T0 = Date.parse('2026-10-10T10:00:00.000Z');
const at = (ms) => new Date(ms).toISOString();

function seed({ id, userEmail = 'a@x.com', couponId = 'c1', createdMs = T0, status = 'PENDING' }) {
  const created = at(createdMs);
  const expires = at(createdMs + 10 * 60 * 1000);
  sheet[db.SHEETS.PAYMENTS].push({
    payment_id: id, order_id: 'o_' + id, user_id: 'u1', user_email: userEmail,
    coupon_id: couponId, amount: 49, currency: 'INR', status,
    created_at: created, updated_at: created, expires_at: expires, payment_expires_at: expires,
    verified_transaction_id: '', verified_utr: '',
  });
  sheet[db.SHEETS.ORDERS].push({ id: 'o_' + id, status: 'PENDING', user_id: 'u1', user_email: userEmail, coupon_id: couponId, amount: 49, created_at: created });
}
const row = (id) => sheet[db.SHEETS.PAYMENTS].find((r) => r.payment_id === id);
const order = (id) => sheet[db.SHEETS.ORDERS].find((r) => r.id === 'o_' + id);

// A time after the 20-minute backend window, so expiry is due.
const LATE = T0 + 25 * 60 * 1000;

(async () => {
  install();
  try {
    await check('reconcile expires an untouched PENDING payment after its deadline (normal rule kept)', async () => {
      reset(); install(); seed({ id: 'pA' });
      coupons.set('c1', { id: 'c1', status: 'available', buyer_email: '', sold_payment_id: '' });
      const r = await store.expireIfDue('pA', { now: at(LATE) });
      assert.ok(r, 'expected expiry');
      assert.equal(row('pA').status, 'EXPIRED');
    });

    await check('valid sold-but-not-PAID payment is recovered to PAID, never expired', async () => {
      reset(); install(); seed({ id: 'pA' });
      coupons.set('c1', { id: 'c1', status: 'sold', buyer_email: 'a@x.com', sold_payment_id: 'pA' });
      const r = await store.expireIfDue('pA', { now: at(LATE) });
      assert.equal(r.status, 'PAID');
      assert.equal(r.recovered, true);
      assert.equal(row('pA').status, 'PAID');
      assert.equal(order('pA').status, 'PAID');
    });

    await check('recovery is idempotent: a second reconcile does not re-settle a PAID payment', async () => {
      reset(); install(); seed({ id: 'pA' });
      coupons.set('c1', { id: 'c1', status: 'sold', buyer_email: 'a@x.com', sold_payment_id: 'pA' });
      await store.expireIfDue('pA', { now: at(LATE) });
      const again = await store.expireIfDue('pA', { now: at(LATE) });
      assert.equal(again, null, 'PAID row is not PENDING, nothing to do');
      assert.equal(row('pA').status, 'PAID');
    });

    await check('coupon sold to a DIFFERENT payment: payment not expired, not overwritten', async () => {
      reset(); install(); seed({ id: 'pA' });
      coupons.set('c1', { id: 'c1', status: 'sold', buyer_email: 'a@x.com', sold_payment_id: 'pOTHER' });
      const r = await store.expireIfDue('pA', { now: at(LATE) });
      assert.equal(r, null);
      assert.equal(row('pA').status, 'PENDING');
    });

    await check('coupon sold to this payment but a different buyer: left for review, not expired', async () => {
      reset(); install(); seed({ id: 'pA', userEmail: 'a@x.com' });
      coupons.set('c1', { id: 'c1', status: 'sold', buyer_email: 'stranger@x.com', sold_payment_id: 'pA' });
      const r = await store.expireIfDue('pA', { now: at(LATE) });
      assert.equal(r, null);
      assert.equal(row('pA').status, 'PENDING');
    });

    await check('coupon unreadable: payment is not expired (fails safe)', async () => {
      reset(); install(); seed({ id: 'pA' });
      supabase.getClient = () => ({ from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => { throw new Error('Supabase down'); } }) });
      const r = await store.expireIfDue('pA', { now: at(LATE) });
      assert.equal(r, null);
      assert.equal(row('pA').status, 'PENDING');
    });

    await check('Sheets PAID write fails during recovery: payment stays PENDING and can be retried', async () => {
      reset(); install(); seed({ id: 'pA' });
      coupons.set('c1', { id: 'c1', status: 'sold', buyer_email: 'a@x.com', sold_payment_id: 'pA' });
      flags.paidWriteFails = true;
      await assert.rejects(() => store.expireIfDue('pA', { now: at(LATE) }));
      assert.equal(row('pA').status, 'PENDING', 'not expired, not falsely PAID');
      flags.paidWriteFails = false;
      const r = await store.expireIfDue('pA', { now: at(LATE) });
      assert.equal(r.status, 'PAID');
    });

    await check('deadline still respected: a PENDING payment before its backend deadline is not touched', async () => {
      reset(); install(); seed({ id: 'pA' });
      coupons.set('c1', { id: 'c1', status: 'sold', buyer_email: 'a@x.com', sold_payment_id: 'pA' });
      const r = await store.expireIfDue('pA', { now: at(T0 + 5 * 60 * 1000) });
      assert.equal(r, null);
      assert.equal(row('pA').status, 'PENDING');
    });

    await check('an expired session never produces a refund task or a coupon unlock', async () => {
      reset(); install(); seed({ id: 'pA' });
      coupons.set('c1', { id: 'c1', status: 'available', buyer_email: '', sold_payment_id: '' });
      await store.expireIfDue('pA', { now: at(LATE) });
      assert.equal(coupons.get('c1').status, 'available', 'coupon stays available');
      assert.equal(row('pA').status, 'EXPIRED');
    });
  } finally {
    restore();
  }

  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
  console.log(results.join('\n'));
  console.log(`\npaymentRecovery: ${passed} passed, ${failed} failed`);
})();
