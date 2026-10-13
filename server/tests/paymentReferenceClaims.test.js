// Duplicate-reference claims wired into the REAL finalizePayment.
// MOCKED: Google Sheets (googleSheets) and the Supabase client. The fake
// payment_reference_claims table enforces the SAME unique constraints as the
// live table (unique on (ref_type, ref_value) and on (payment_id, ref_type)),
// so a duplicate claim fails the way Postgres 23505 does.
// This suite does NOT touch the live database. Real constraint tests against
// the live table were run once, separately, with prefixed rows that were removed.
// Run: node server/tests/paymentReferenceClaims.test.js
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
let claimsTable;
let flags;

function reset() {
  sheet = { [db.SHEETS.PAYMENTS]: [], [db.SHEETS.ORDERS]: [] };
  coupons = new Map();
  claimsTable = [];
  flags = { sheetsWriteFails: false, unlockFails: false, claimInsertFails: false, unlockFailsAfterSale: false };
}

// Postgres-like unique enforcement for the claims table.
function insertClaimRow(row) {
  if (flags.claimInsertFails) throw Object.assign(new Error('boom'), { code: 'XX000' });
  const dupRef = claimsTable.find((r) => r.ref_type === row.ref_type && r.ref_value === row.ref_value);
  if (dupRef) return { error: { code: '23505', message: 'duplicate key' } };
  const dupPay = claimsTable.find((r) => r.payment_id === row.payment_id && r.ref_type === row.ref_type);
  if (dupPay) return { error: { code: '23505', message: 'duplicate key' } };
  claimsTable.push({ ...row });
  return { error: null };
}

function installFakes() {
  db.getRowsFresh = async (name) => {
    if (flags.sheetsWriteFails && name === db.SHEETS.PAYMENTS) throw new Error('Sheets read timeout');
    return (sheet[name] || []).map((r) => ({ ...r }));
  };
  db.getRows = db.getRowsFresh;
  db.findRowsFresh = async (name, field, value) => {
    await db.getRowsFresh(name);
    return (sheet[name] || []).filter((r) => String(r[field]) === String(value)).map((r) => ({ ...r }));
  };
  db.updateRow = async (name, keyField, keyValue, patch) => {
    if (flags.sheetsWriteFails && name === db.SHEETS.PAYMENTS) throw new Error('Sheets write failed');
    const row = (sheet[name] || []).find((r) => String(r[keyField]) === String(keyValue));
    if (!row) return false;
    Object.assign(row, patch);
    return true;
  };
  db.appendRow = async (name, row) => {
    (sheet[name] = sheet[name] || []).push({ ...row });
    return true;
  };

  supabase.isConfigured = () => true;
  supabase.getClient = () => ({
    from: (table) => {
      if (table === 'payment_reference_claims') return claimsQuery();
      return couponsQuery();
    },
  });
}

function claimsQuery() {
  const q = { op: 'select', row: null, filters: {}, selectCols: null };
  const api = {
    insert(row) { q.op = 'insert'; q.row = row; return api; },
    delete() { q.op = 'delete'; return api; },
    select() { return api; },
    eq(col, val) { q.filters[col] = String(val); return api; },
    maybeSingle: async () => {
      const m = claimsTable.find((r) => Object.keys(q.filters).every((k) => String(r[k]) === q.filters[k]));
      return { data: m ? { payment_id: m.payment_id } : null, error: null };
    },
    then(resolve) {
      if (q.op === 'insert') return resolve(insertClaimRow(q.row));
      if (q.op === 'delete') {
        claimsTable = claimsTable.filter((r) => !Object.keys(q.filters).every((k) => String(r[k]) === q.filters[k]));
        return resolve({ error: null });
      }
      return resolve({ data: [], error: null });
    },
  };
  return api;
}

function couponsQuery() {
  const q = { op: 'select', patch: null, filters: {} };
  const api = {
    update(patch) { q.op = 'update'; q.patch = patch; return api; },
    select() { return api; },
    eq(col, val) { q.filters[col] = String(val); return api; },
    maybeSingle: async () => {
      const c = coupons.get(q.filters.id);
      return { data: c ? { ...c } : null, error: null };
    },
    then(resolve) {
      if (flags.unlockFails) return resolve({ data: null, error: { message: 'boom' } });
      if (q.op === 'update') {
        const c = coupons.get(q.filters.id);
        if (c && c.status === q.filters.status) {
          Object.assign(c, q.patch);
          if (flags.unlockFailsAfterSale) return resolve({ data: null, error: { message: 'boom' } });
          return resolve({ data: [{ ...c }], error: null });
        }
        return resolve({ data: [], error: null });
      }
      return resolve({ data: [], error: null });
    },
  };
  return api;
}

function restoreFakes() {
  Object.assign(db, { getRowsFresh: originals.getRowsFresh, getRows: originals.getRows, findRowsFresh: originals.findRowsFresh, updateRow: originals.updateRow, appendRow: originals.appendRow });
  supabase.isConfigured = originals.isConfigured;
  supabase.getClient = originals.getClient;
}

const T0 = Date.parse('2026-10-10T10:00:00.000Z');
const at = (ms) => new Date(ms).toISOString();

function seed({ id, userId = 'u1', userEmail = 'a@x.com', couponId = 'c1', createdMs = T0 }) {
  const created = at(createdMs);
  const expires = at(createdMs + 10 * 60 * 1000);
  sheet[db.SHEETS.PAYMENTS].push({
    payment_id: id, order_id: 'o_' + id, user_id: userId, user_email: userEmail,
    coupon_id: couponId, amount: 49, currency: 'INR', status: 'PENDING',
    created_at: created, updated_at: created, expires_at: expires, payment_expires_at: expires,
    verified_transaction_id: '', verified_utr: '',
  });
  sheet[db.SHEETS.ORDERS].push({ id: 'o_' + id, status: 'PENDING', user_id: userId, user_email: userEmail, coupon_id: couponId, amount: 49, created_at: created });
  if (!coupons.has(String(couponId))) {
    coupons.set(String(couponId), { id: String(couponId), code: 'CODE' + couponId, status: 'available', buyer_email: '', sold_payment_id: '' });
  }
}

const row = (id) => sheet[db.SHEETS.PAYMENTS].find((r) => r.payment_id === id);
const claimsFor = (id) => claimsTable.filter((r) => r.payment_id === id).map((r) => r.ref_type).sort();

function settle(id, { txn = 'TXN1', utr = 'UTR1', transactionAt = at(T0 + 60 * 1000) } = {}) {
  return store.finalizePayment({
    paymentId: id, transactionId: txn, utr, source: 'test', notes: '',
    paidAt: null, raw: null, receivedAmount: 49, transactionAt,
  });
}

(async () => {
  installFakes();
  try {
    await check('first settlement claims both references and unlocks the coupon', async () => {
      reset(); installFakes(); seed({ id: 'pA' });
      const r = await settle('pA');
      assert.equal(r.ok, true, r.code);
      assert.deepEqual(claimsFor('pA'), ['transaction_id', 'utr']);
      assert.equal(coupons.get('c1').status, 'sold');
      assert.equal(row('pA').status, 'PAID');
    });

    await check('duplicate Transaction ID from another payment is refused, no coupon unlock', async () => {
      reset(); installFakes(); seed({ id: 'pA' }); seed({ id: 'pB', userId: 'u2', userEmail: 'b@x.com', couponId: 'c2' });
      assert.equal((await settle('pA')).ok, true);
      const r = await settle('pB', { txn: 'TXN1', utr: 'UTR-NEW' });
      assert.ok(['REPLAY_DETECTED','REFERENCE_CLAIMED'].includes(r.code), r.code);
      assert.equal(coupons.get('c2').status, 'available');
      assert.equal(row('pB').status, 'PENDING');
      assert.deepEqual(claimsFor('pB'), []);
    });

    await check('duplicate UTR from another payment is refused, transaction claim rolled back', async () => {
      reset(); installFakes(); seed({ id: 'pA' }); seed({ id: 'pB', userId: 'u2', userEmail: 'b@x.com', couponId: 'c2' });
      assert.equal((await settle('pA')).ok, true);
      const r = await settle('pB', { txn: 'TXN-NEW', utr: 'UTR1' });
      assert.ok(['REPLAY_DETECTED','REFERENCE_CLAIMED'].includes(r.code), r.code);
      assert.deepEqual(claimsFor('pB'), [], 'no leftover claim for the refused payment');
      assert.equal(claimsTable.filter((r2) => r2.ref_value === 'TXN-NEW').length, 0);
      assert.equal(coupons.get('c2').status, 'available');
    });

    await check('two concurrent settlements of the same payment: one unlock, one claim set', async () => {
      reset(); installFakes(); seed({ id: 'pA' });
      const [r1, r2] = await Promise.all([settle('pA'), settle('pA')]);
      const oks = [r1, r2].filter((r) => r.ok).length;
      assert.ok(oks >= 1, 'at least one must succeed');
      assert.equal(claimsTable.filter((r) => r.payment_id === 'pA').length, 2);
      assert.equal(coupons.get('c1').status, 'sold');
    });

    await check('two different payments racing on the same Transaction ID: exactly one settles', async () => {
      reset(); installFakes(); seed({ id: 'pA' }); seed({ id: 'pB', userId: 'u2', userEmail: 'b@x.com', couponId: 'c2' });
      const [ra, rb] = await Promise.all([settle('pA', { txn: 'TXN-RACE' }), settle('pB', { txn: 'TXN-RACE', utr: 'UTR-B' })]);
      assert.equal([ra, rb].filter((r) => r.ok).length, 1);
      assert.equal(claimsTable.filter((r) => r.ref_value === 'TXN-RACE').length, 1);
    });

    await check('retry after a Supabase unlock failure releases the claim so a later retry can settle', async () => {
      reset(); installFakes(); seed({ id: 'pA' });
      flags.unlockFails = true;
      await assert.rejects(() => settle('pA'));
      assert.deepEqual(claimsFor('pA'), [], 'claim released; nothing was sold');
      assert.equal(row('pA').status, 'PENDING');
      flags.unlockFails = false;
      const r = await settle('pA');
      assert.equal(r.ok, true, r.code);
      assert.equal(coupons.get('c1').status, 'sold');
    });

    await check('failure after the claim but before the sale does not block a legitimate payment forever', async () => {
      reset(); installFakes(); seed({ id: 'pA' });
      flags.claimInsertFails = true;
      const r = await settle('pA');
      assert.equal(r.ok, false);
      assert.equal(r.code, 'CLAIM_UNAVAILABLE');
      assert.equal(coupons.get('c1').status, 'available', 'no coupon flip without a claim');
      flags.claimInsertFails = false;
      const r2 = await settle('pA');
      assert.equal(r2.ok, true, r2.code);
    });

    await check('Google Sheets write failure after the coupon is sold keeps the claim (no reuse of the reference)', async () => {
      reset(); installFakes(); seed({ id: 'pA' });
      const origUpdate = db.updateRow;
      db.updateRow = async (name, ...rest) => {
        if (name === db.SHEETS.PAYMENTS) throw new Error('Sheets write failed');
        return origUpdate(name, ...rest);
      };
      try {
        await assert.rejects(() => settle('pA'));
      } finally {
        db.updateRow = origUpdate;
      }
      assert.equal(coupons.get('c1').status, 'sold', 'coupon was sold to this payment');
      assert.deepEqual(claimsFor('pA'), ['transaction_id', 'utr'], 'claims kept while the sale exists');
      // A different payment cannot reuse the reference.
      seed({ id: 'pB', userId: 'u2', userEmail: 'b@x.com', couponId: 'c2' });
      const r = await settle('pB');
      assert.equal(r.code, 'REFERENCE_CLAIMED');
    });

    await check('Sheets read failure before any claim: no claim, no unlock', async () => {
      reset(); installFakes(); seed({ id: 'pA' });
      flags.sheetsWriteFails = true;
      await assert.rejects(() => settle('pA'));
      flags.sheetsWriteFails = false;
      assert.deepEqual(claimsFor('pA'), []);
      assert.equal(coupons.get('c1').status, 'available');
    });

    await check('a claimed reference with no valid timestamp is refused before any claim is taken', async () => {
      reset(); installFakes(); seed({ id: 'pA' });
      const r = await settle('pA', { transactionAt: 'garbage' });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'OUTSIDE_WINDOW');
      assert.deepEqual(claimsFor('pA'), []);
    });

    await check('Supabase unavailable: settlement refuses rather than settling without claims', async () => {
      reset(); installFakes(); seed({ id: 'pA' });
      supabase.isConfigured = () => false;
      try {
        // Claims need Supabase, so settlement must refuse, never settle.
        const r = await settle('pA');
        assert.equal(r.ok, false);
        assert.equal(r.code, 'CLAIM_UNAVAILABLE');
      } finally {
        supabase.isConfigured = () => true;
      }
      assert.equal(row('pA').status, 'PENDING');
      assert.equal(coupons.get('c1').status, 'available');
    });
  } finally {
    restoreFakes();
  }

  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
  console.log(results.join('\n'));
  console.log(`\npaymentReferenceClaims: ${passed} passed, ${failed} failed`);
})();
