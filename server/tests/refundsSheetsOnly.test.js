// Regression: Google Sheets `Refunds` is the ONLY refund store.
// Supabase must never be read or written by the refund workflow, a Sheets
// outage must surface as an error (never a zero total), and a ₹20 refund must
// stay ₹20. Everything is mocked: no real Sheets, Supabase, refund or payout.
// Expected values are hardcoded from the business rule.
// Run: node server/tests/refundsSheetsOnly.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..', 'services');
const sheetsPath = path.join(root, 'googleSheets.js');
const supabasePath = path.join(root, 'supabase.js');
const refundsPath = path.join(root, 'refunds.js');

let passed = 0;
let failed = 0;
const lines = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    lines.push(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    lines.push(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

// ── Mock state ───────────────────────────────────────────────────────────
let store = [];
let sheetsDown = false;
let appendCalls = 0;
let updateCalls = 0;
const supabaseCalls = [];

function resetState() {
  store = [];
  sheetsDown = false;
  appendCalls = 0;
  updateCalls = 0;
  supabaseCalls.length = 0;
}

// Fake Sheets module. Strict reads throw when the store is down; non-strict
// reads are not allowed to hide an outage either, so they throw too.
const fakeSheets = {
  SHEETS: { REFUNDS: 'Refunds' },
  getRows: async (_sheet, options = {}) => {
    if (sheetsDown) {
      if (options.strict) throw new Error('Google Sheets is unavailable for a strict read of Refunds');
      throw new Error('Google Sheets is unavailable');
    }
    return store.map((r) => ({ ...r }));
  },
  appendRow: async (_sheet, row, options = {}) => {
    appendCalls += 1;
    if (sheetsDown) throw new Error('Google Sheets is unavailable for a financial write');
    store.push({ ...row });
    return row;
  },
  updateRow: async (_sheet, _key, id, patch, options = {}) => {
    updateCalls += 1;
    if (sheetsDown) throw new Error('Google Sheets is unavailable for a financial write');
    const i = store.findIndex((r) => String(r.id) === String(id));
    if (i < 0) throw new Error('Financial row was not found');
    store[i] = { ...store[i], ...patch };
    return store[i];
  },
};

// Fake Supabase module. Every method records a call so the tests can prove
// the refund workflow never touches it. A "configured" client is returned to
// make any accidental use visible rather than silently skipped.
const fakeSupabase = {
  isConfigured: () => true,
  getClient: () => ({
    from: (table) => {
      supabaseCalls.push(`from:${table}`);
      const chain = {
        select: () => chain,
        insert: () => { supabaseCalls.push(`insert:${table}`); return chain; },
        update: () => { supabaseCalls.push(`update:${table}`); return chain; },
        eq: () => chain,
        order: () => chain,
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  }),
};

require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fakeSupabase };

const refunds = require(refundsPath);

(async () => {
  console.log('Refunds: Google Sheets is the only refund store');

  await check('creating a refund writes to Google Sheets', async () => {
    resetState();
    const r = await refunds.createOrUpdateRefund({
      paymentId: 'pay_1', userId: 'u1', requiredAmount: 100, receivedAmount: 120,
    });
    assert.equal(r.ok, true);
    assert.equal(appendCalls, 1);
    assert.equal(store.length, 1);
    assert.equal(store[0].payment_id, 'pay_1');
  });

  await check('a refund read returns rows from the Sheets tab', async () => {
    resetState();
    store.push({ id: 'rfnd_a', payment_id: 'pay_9', user_id: 'u9', refund_amount: '20.00', status: 'refunded', mismatch_type: 'overpayment', created_at: '2026-10-10T10:00:00+05:30' });
    const list = await refunds.readAllRefunds();
    assert.equal(list.length, 1);
    assert.equal(list[0].refundId, 'rfnd_a');
  });

  await check('a status update is saved to Google Sheets', async () => {
    resetState();
    store.push({ id: 'rfnd_s', payment_id: 'pay_s', user_id: 'u1', refund_amount: '20.00', status: 'processing', mismatch_type: 'underpayment', created_at: '2026-10-10T10:00:00+05:30' });
    const r = await refunds.updateRefundStatus('rfnd_s', { status: 'rejected', adminNote: 'test', processedBy: 'admin@x' });
    assert.equal(r.ok, true);
    assert.equal(updateCalls, 1);
    assert.equal(store[0].status, 'rejected');
  });

  await check('a ₹20 refund stays ₹20 through create, read and summary', async () => {
    resetState();
    await refunds.createOrUpdateRefund({ paymentId: 'pay_20', userId: 'u1', requiredAmount: 100, receivedAmount: 120 });
    const list = await refunds.readAllRefunds();
    assert.equal(list[0].refundAmount, '20.00');
    const s = refunds.summarize(list);
    assert.equal(s.total, '20.00');
  });

  await check('duplicate create for the same payment does not add a second row', async () => {
    resetState();
    await refunds.createOrUpdateRefund({ paymentId: 'pay_d', userId: 'u1', requiredAmount: 100, receivedAmount: 120 });
    const again = await refunds.createOrUpdateRefund({ paymentId: 'pay_d', userId: 'u1', requiredAmount: 100, receivedAmount: 120 });
    assert.equal(again.ok, true);
    assert.equal(again.created, false);
    assert.equal(store.length, 1, 'exactly one refund row');
  });

  await check('duplicate late-payment task for the same payment is not created twice', async () => {
    resetState();
    const first = await refunds.createLateRefundTask({ paymentId: 'pay_L', userId: 'u1', receivedAmount: 50 });
    const second = await refunds.createLateRefundTask({ paymentId: 'pay_L', userId: 'u1', receivedAmount: 50 });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(store.length, 1);
  });

  await check('full refund (underpayment) and partial refund (overpayment) amounts are correct', async () => {
    resetState();
    await refunds.createOrUpdateRefund({ paymentId: 'pay_full', userId: 'u1', requiredAmount: 100, receivedAmount: 80 });
    await refunds.createOrUpdateRefund({ paymentId: 'pay_part', userId: 'u1', requiredAmount: 100, receivedAmount: 130.5 });
    const byPay = Object.fromEntries((await refunds.readAllRefunds()).map((r) => [r.paymentId, r]));
    assert.equal(byPay.pay_full.refundAmount, '80.00');
    assert.equal(byPay.pay_full.mismatchType, 'underpayment');
    assert.equal(byPay.pay_part.refundAmount, '30.50');
    assert.equal(byPay.pay_part.mismatchType, 'overpayment');
  });

  await check('pending refunds are not counted as refunded', async () => {
    resetState();
    store.push({ id: 'rfnd_p', payment_id: 'pay_p', user_id: 'u1', refund_amount: '20.00', status: 'pending', mismatch_type: 'overpayment', created_at: '2026-10-10T10:00:00+05:30' });
    const s = refunds.summarize(await refunds.readAllRefunds());
    assert.equal(s.refunded, '0.00');
    assert.equal(s.refundedCount, 0);
    assert.equal(s.pending, '20.00');
  });

  await check('Sheets outage on read throws, never a fake zero total', async () => {
    resetState();
    sheetsDown = true;
    await assert.rejects(
      () => refunds.readAllRefunds(),
      (e) => e.code === 'REFUND_STORE_UNAVAILABLE' && e instanceof refunds.RefundStoreUnavailableError,
    );
  });

  await check('Sheets outage on create fails closed without reporting success', async () => {
    resetState();
    sheetsDown = true;
    const r = await refunds.createOrUpdateRefund({ paymentId: 'pay_x', userId: 'u1', requiredAmount: 100, receivedAmount: 120 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'STORAGE_UNAVAILABLE');
    assert.equal(store.length, 0);
  });

  await check('Sheets outage on status update fails closed and changes nothing', async () => {
    resetState();
    store.push({ id: 'rfnd_o', payment_id: 'pay_o', user_id: 'u1', refund_amount: '20.00', status: 'processing', mismatch_type: 'underpayment', created_at: '2026-10-10T10:00:00+05:30' });
    sheetsDown = true;
    const r = await refunds.updateRefundStatus('rfnd_o', { status: 'rejected', processedBy: 'admin@x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'STORAGE_UNAVAILABLE');
    assert.equal(store[0].status, 'processing');
  });

  await check('active refund workflow never invokes Supabase', async () => {
    resetState();
    await refunds.createOrUpdateRefund({ paymentId: 'pay_n', userId: 'u1', requiredAmount: 100, receivedAmount: 120 });
    await refunds.createLateRefundTask({ paymentId: 'pay_late', userId: 'u1', receivedAmount: 40 });
    await refunds.readAllRefunds();
    await refunds.updateRefundStatus(store[0].id, { status: 'rejected', processedBy: 'admin@x' });
    assert.deepEqual(supabaseCalls, [], `Supabase was called: ${supabaseCalls.join(', ')}`);
  });

  await check('refunds service no longer exports any Supabase row helper', async () => {
    assert.equal(refunds.toSupabaseRow, undefined);
  });

  console.log(lines.join('\n'));
  console.log(`\nrefundsSheetsOnly: ${passed} passed, ${failed} failed`);
})();
