// Real finalizePayment timing + settlement tests.
// MOCKED: Google Sheets (googleSheets.getRowsFresh / updateRow / appendRow)
// and the Supabase client are replaced with in-memory fakes. finalizePayment,
// the window rule and the deadline check are the REAL production code.
// Run: node server/tests/paymentSettlementTiming.test.js
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

// ── Fakes ──────────────────────────────────────────────────────────────────
const originals = {
  getRowsFresh: db.getRowsFresh,
  updateRow: db.updateRow,
  appendRow: db.appendRow,
  getRows: db.getRows,
  findRowsFresh: db.findRowsFresh,
  isConfigured: supabase.isConfigured,
  getClient: supabase.getClient,
};

let sheet;
let coupons;
let unlockFails;
let sheetFails;
function resetFakes() {
  claimRows = [];
  sheet = { [db.SHEETS.PAYMENTS]: [], [db.SHEETS.ORDERS]: [] };
  coupons = new Map();
  unlockFails = false;
  sheetFails = false;
}

function installFakes() {
  db.getRowsFresh = async (name) => {
    if (sheetFails) throw new Error('Sheets timeout');
    return (sheet[name] || []).map((r) => ({ ...r }));
  };
  db.getRows = db.getRowsFresh;
  db.findRowsFresh = async (name, field, value) => {
    await db.getRowsFresh(name);
    return (sheet[name] || []).filter((r) => String(r[field]) === String(value)).map((r) => ({ ...r }));
  };
  db.updateRow = async (name, keyField, keyValue, patch) => {
    if (sheetFails) throw new Error('Sheets write failed');
    const row = (sheet[name] || []).find((r) => String(r[keyField]) === String(keyValue));
    if (!row) return false;
    Object.assign(row, patch);
    return true;
  };
  db.appendRow = async (name, row) => {
    if (sheetFails) throw new Error('Sheets write failed');
    (sheet[name] = sheet[name] || []).push({ ...row });
    return true;
  };
  supabase.isConfigured = () => true;
  supabase.getClient = () => ({
    from: (table) => {
      if (table === 'payment_reference_claims') return claimsStub();
      const q = { _op: null, _patch: null, _filters: {} };
      const api = {
        update(patch) { q._op = 'update'; q._patch = patch; return api; },
        select() { return api; },
        eq(col, val) { q._filters[col] = String(val); return api; },
        maybeSingle: async () => {
          const c = coupons.get(q._filters.id);
          return { data: c ? { ...c } : null, error: null };
        },
        then(resolve) {
          // Only the conditional update path reaches here.
          if (unlockFails) return resolve({ data: null, error: { message: 'boom' } });
          const c = coupons.get(q._filters.id);
          if (q._op === 'update' && c && c.status === q._filters.status) {
            Object.assign(c, q._patch);
            return resolve({ data: [{ ...c }], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return api;
    },
  });
}

// Claims table stub: enforce the same unique constraints as the live table.
let claimRows = [];
function claimsStub() {
  const q = { op: 'select', row: null, filters: {} };
  const api = {
    insert(row) { q.op = 'insert'; q.row = row; return api; },
    delete() { q.op = 'delete'; return api; },
    select() { return api; },
    eq(col, val) { q.filters[col] = String(val); return api; },
    maybeSingle: async () => {
      const m = claimRows.find((r) => Object.keys(q.filters).every((k) => String(r[k]) === q.filters[k]));
      return { data: m ? { payment_id: m.payment_id } : null, error: null };
    },
    then(resolve) {
      if (q.op === 'insert') {
        const dup = claimRows.find((r) => (r.ref_type === q.row.ref_type && r.ref_value === q.row.ref_value) || (r.payment_id === q.row.payment_id && r.ref_type === q.row.ref_type));
        if (dup) return resolve({ error: { code: '23505', message: 'duplicate key' } });
        claimRows.push({ ...q.row });
        return resolve({ error: null });
      }
      if (q.op === 'delete') {
        claimRows = claimRows.filter((r) => !Object.keys(q.filters).every((k) => String(r[k]) === q.filters[k]));
        return resolve({ error: null });
      }
      return resolve({ data: [], error: null });
    },
  };
  return api;
}

function restoreFakes() {
  db.getRowsFresh = originals.getRowsFresh;
  db.getRows = originals.getRows;
  db.findRowsFresh = originals.findRowsFresh;
  db.updateRow = originals.updateRow;
  db.appendRow = originals.appendRow;
  supabase.isConfigured = originals.isConfigured;
  supabase.getClient = originals.getClient;
}

// A payment session created at `createdMs`, 10-minute deadline.
function seedPayment({ id = 'pay1', createdMs, couponId = 'c1', userEmail = 'a@x.com', userId = 'u1', status = 'PENDING' } = {}) {
  const created = new Date(createdMs).toISOString();
  const expires = new Date(createdMs + 10 * 60 * 1000).toISOString();
  sheet[db.SHEETS.PAYMENTS].push({
    payment_id: id, order_id: 'o_' + id, user_id: userId, user_email: userEmail,
    coupon_id: couponId, amount: 49, currency: 'INR', status,
    created_at: created, updated_at: created, expires_at: expires,
    payment_expires_at: expires, verified_transaction_id: '', verified_utr: '',
  });
  sheet[db.SHEETS.ORDERS].push({ id: 'o_' + id, status: 'PENDING', user_id: 'u1', user_email: userEmail, coupon_id: couponId, amount: 49, created_at: created });
  coupons.set(String(couponId), { id: String(couponId), code: 'CODE' + couponId, status: 'available', buyer_email: '', sold_payment_id: '' });
}

const T0 = Date.parse('2026-10-10T10:00:00.000Z');
const at = (ms) => new Date(ms).toISOString();
const paymentRow = (id) => sheet[db.SHEETS.PAYMENTS].find((r) => r.payment_id === id);

async function settle(id, transactionAt, extra = {}) {
  return store.finalizePayment({
    paymentId: id, transactionId: 'TXN' + id, utr: 'UTR' + id,
    source: 'test', notes: '', paidAt: null, raw: null, receivedAmount: 49,
    transactionAt, ...extra,
  });
}

(async () => {
  installFakes();
  try {
    await check('timely txn (T+5m) with Gmail arriving after expiry (T+25m) still settles', async () => {
      resetFakes(); installFakes();
      seedPayment({ createdMs: T0 });
      // The server clock is now T+25m, past the deadline. Only the transaction instant matters.
      const realNow = Date.now;
      Date.now = () => T0 + 25 * 60 * 1000;
      try {
        const r = await settle('pay1', at(T0 + 5 * 60 * 1000));
        assert.equal(r.ok, true, 'expected settlement, got ' + r.code);
        assert.equal(r.code, 'OK');
        assert.equal(paymentRow('pay1').status, 'PAID');
        assert.equal(coupons.get('c1').status, 'sold');
      } finally { Date.now = realNow; }
    });

    await check('transaction actually after expiry (T+10m30s) is refused, no coupon unlock', async () => {
      resetFakes(); installFakes();
      seedPayment({ createdMs: T0 });
      const r = await settle('pay1', at(T0 + 10 * 60 * 1000 + 30 * 1000));
      assert.equal(r.ok, false);
      assert.equal(r.code, 'OUTSIDE_WINDOW');
      assert.equal(coupons.get('c1').status, 'available');
      assert.equal(paymentRow('pay1').status, 'PENDING');
    });

    await check('transaction exactly at deadline is refused (deadline is exclusive)', async () => {
      resetFakes(); installFakes();
      seedPayment({ createdMs: T0 });
      const r = await settle('pay1', at(T0 + 10 * 60 * 1000));
      assert.equal(r.code, 'OUTSIDE_WINDOW');
    });

    await check('transaction 5+ minutes before session creation is refused', async () => {
      resetFakes(); installFakes();
      seedPayment({ createdMs: T0 });
      const r = await settle('pay1', at(T0 - 6 * 60 * 1000));
      assert.equal(r.code, 'OUTSIDE_WINDOW');
      assert.equal(coupons.get('c1').status, 'available');
    });

    await check('invalid transactionAt is never guessed; falls to refusal, not success', async () => {
      resetFakes(); installFakes();
      seedPayment({ createdMs: T0 });
      const r = await settle('pay1', 'not-a-date');
      assert.equal(r.ok, false);
      assert.equal(r.code, 'OUTSIDE_WINDOW');
      assert.equal(coupons.get('c1').status, 'available');
    });

    await check('missing transactionAt on a late server clock is refused (no grace guess)', async () => {
      resetFakes(); installFakes();
      seedPayment({ createdMs: T0 });
      const realNow = Date.now;
      Date.now = () => T0 + 25 * 60 * 1000;
      try {
        const r = await settle('pay1', null);
        assert.equal(r.code, 'OUTSIDE_WINDOW');
        assert.equal(coupons.get('c1').status, 'available');
      } finally { Date.now = realNow; }
    });

    await check('deadline is never extended: a second in-window txn after expiry is still refused', async () => {
      resetFakes(); installFakes();
      seedPayment({ createdMs: T0 });
      const r = await settle('pay1', at(T0 + 11 * 60 * 1000), { transactionId: 'LATE' });
      assert.equal(r.code, 'OUTSIDE_WINDOW');
      assert.equal(paymentRow('pay1').payment_expires_at, at(T0 + 10 * 60 * 1000));
    });

    await check('Sheets write failure during markPaid throws (no false success)', async () => {
      resetFakes(); installFakes();
      seedPayment({ createdMs: T0 });
      // Fail Sheets only after the coupon flip has happened inside unlockCoupon.
      const origUpdate = db.updateRow;
      db.updateRow = async (...a) => {
        if (a[0] === db.SHEETS.PAYMENTS) throw new Error('Sheets write failed');
        return origUpdate(...a);
      };
      try {
        await assert.rejects(() => settle('pay1', at(T0 + 60 * 1000)));
        assert.notEqual(paymentRow('pay1').status, 'PAID');
      } finally { db.updateRow = origUpdate; }
    });

    await check('Supabase coupon-unlock failure leaves payment PENDING and coupon available', async () => {
      resetFakes(); installFakes();
      seedPayment({ createdMs: T0 });
      unlockFails = true;
      await assert.rejects(() => settle('pay1', at(T0 + 60 * 1000)), /Atomic coupon update failed/);
      assert.equal(paymentRow('pay1').status, 'PENDING');
      assert.equal(coupons.get('c1').status, 'available');
    });

    await check('repeated settlement of the same payment is idempotent (one unlock)', async () => {
      resetFakes(); installFakes();
      seedPayment({ createdMs: T0 });
      const first = await settle('pay1', at(T0 + 60 * 1000));
      const second = await settle('pay1', at(T0 + 60 * 1000));
      assert.equal(first.code, 'OK');
      assert.equal(second.code, 'ALREADY_PAID');
      assert.equal(second.idempotent, true);
    });

    await check('two payments racing for the same coupon: only one unlocks', async () => {
      resetFakes(); installFakes();
      seedPayment({ id: 'pA', createdMs: T0, userEmail: 'a@x.com' });
      seedPayment({ id: 'pB', createdMs: T0, userEmail: 'b@x.com', userId: 'u2' });
      // Second seed overwrote coupon c1 as available again; that is the same coupon for both.
      const [ra, rb] = await Promise.all([
        settle('pA', at(T0 + 60 * 1000)),
        settle('pB', at(T0 + 61 * 1000)),
      ]);
      const oks = [ra, rb].filter((r) => r.ok).length;
      assert.equal(oks, 1, 'exactly one settlement must succeed');
      assert.equal(coupons.get('c1').status, 'sold');
    });

    await check('Payment Successful is backed by PAID row + sold coupon (no PAID without unlock)', async () => {
      resetFakes(); installFakes();
      seedPayment({ createdMs: T0 });
      const r = await settle('pay1', at(T0 + 60 * 1000));
      assert.equal(r.ok, true);
      assert.equal(paymentRow('pay1').status, 'PAID');
      assert.equal(coupons.get('c1').sold_payment_id, 'pay1');
      assert.equal(coupons.get('c1').status, 'sold');
    });
  } finally {
    restoreFakes();
  }

  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
  console.log(results.join('\n'));
  console.log(`\npaymentSettlementTiming: ${passed} passed, ${failed} failed`);
})();
