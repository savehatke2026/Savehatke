// Payment lifecycle regression suite (no network, no Sheets, no real refunds).
// Run: node server/tests/paymentLifecycle.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const w = require(path.join(__dirname, '..', 'services', 'paymentWindow.js'));

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (e) {
    failed += 1;
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

const MIN = 60 * 1000;
const START = Date.parse('2026-10-10T10:00:00Z');
const EXPIRES = START + 10 * MIN;              // customer timer ends
const DEADLINE = START + 20 * MIN;             // backend verification deadline
const AFTER_EXPIRY = EXPIRES + 1;              // just past the customer timer

(async () => {
  console.log('Session timing');

  await check('deadline is exactly 10 minutes after customer expiry', () => {
    assert.equal(w.verificationDeadlineFor(new Date(EXPIRES).toISOString()), new Date(DEADLINE).toISOString());
  });

  await check('customer timer boundary: before expiry is customer phase', () => {
    const p = w.phaseAt({ paymentExpiresAt: new Date(EXPIRES).toISOString(), verificationDeadline: new Date(DEADLINE).toISOString() }, EXPIRES - 1);
    assert.notEqual(p, 'verification_expired');
  });

  await check('verification boundary: exactly at deadline is still inside the window', () => {
    assert.equal(
      w.classifyTransactionTime({ transactionAt: new Date(DEADLINE).toISOString(), sessionStartedAt: new Date(START).toISOString(), verificationDeadline: new Date(DEADLINE).toISOString() }),
      'within'
    );
  });

  console.log('Decision: payment before and after the deadline');

  await check('payment inside the customer window settles', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(START + 5 * MIN).toISOString(),
      sessionStatus: 'PENDING', sessionCreatedAt: new Date(START).toISOString(),
      verificationDeadline: new Date(DEADLINE).toISOString(), payerNameMatches: true, nowMs: START + 30 * MIN,
    });
    assert.equal(d.action, 'settle');
  });

  await check('payment during the verification window (after customer expiry) settles', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(EXPIRES + 5 * MIN).toISOString(),
      sessionStatus: 'PENDING', sessionCreatedAt: new Date(START).toISOString(),
      verificationDeadline: new Date(DEADLINE).toISOString(), payerNameMatches: true, nowMs: START + 30 * MIN,
    });
    assert.equal(d.action, 'settle');
  });

  await check('payment after the deadline on an expired session → late_refund', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(DEADLINE + 2 * MIN).toISOString(),
      sessionStatus: 'EXPIRED', sessionCreatedAt: new Date(START).toISOString(),
      verificationDeadline: new Date(DEADLINE).toISOString(), payerNameMatches: true, nowMs: DEADLINE + 10 * MIN,
    });
    assert.equal(d.action, 'late_refund');
  });

  await check('late classification uses the transaction time, not arrival (late email, in-window txn → settle)', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(START + 12 * MIN).toISOString(),
      sessionStatus: 'PENDING', sessionCreatedAt: new Date(START).toISOString(),
      verificationDeadline: new Date(DEADLINE).toISOString(), payerNameMatches: true, nowMs: DEADLINE + 30 * MIN,
    });
    assert.equal(d.action, 'settle');
  });

  console.log('Decision: ambiguity and safety');

  await check('unreadable transaction time → review, never a refund', () => {
    const d = w.decideIncomingCredit({
      transactionAt: null, sessionStatus: 'PENDING', sessionCreatedAt: new Date(START).toISOString(),
      verificationDeadline: new Date(DEADLINE).toISOString(), payerNameMatches: true, nowMs: DEADLINE + MIN,
    });
    assert.equal(d.action, 'review');
  });

  await check('unreadable session timing → review', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(DEADLINE + MIN).toISOString(), sessionStatus: 'EXPIRED', sessionCreatedAt: '',
      verificationDeadline: '', payerNameMatches: true, nowMs: DEADLINE + 5 * MIN,
    });
    assert.equal(d.action, 'review');
  });

  await check('payer name mismatch never refunds or settles', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(DEADLINE + 2 * MIN).toISOString(), sessionStatus: 'EXPIRED',
      sessionCreatedAt: new Date(START).toISOString(), verificationDeadline: new Date(DEADLINE).toISOString(),
      payerNameMatches: false, nowMs: DEADLINE + 10 * MIN,
    });
    assert.equal(d.action, 'review');
  });

  await check('already fulfilled session: a second late payment goes to review, not a refund', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(DEADLINE + 2 * MIN).toISOString(), sessionStatus: 'PAID',
      sessionCreatedAt: new Date(START).toISOString(), verificationDeadline: new Date(DEADLINE).toISOString(),
      payerNameMatches: true, nowMs: DEADLINE + 10 * MIN,
    });
    assert.equal(d.action, 'review');
  });

  await check('transaction before the order was created is ignored', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(START - 30 * MIN).toISOString(), sessionStatus: 'PENDING',
      sessionCreatedAt: new Date(START).toISOString(), verificationDeadline: new Date(DEADLINE).toISOString(),
      payerNameMatches: true, nowMs: DEADLINE + MIN,
    });
    assert.equal(d.action, 'ignore');
  });

  await check('in-window transaction on a closed (cancelled) session → review, not coupon delivery', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(START + 12 * MIN).toISOString(), sessionStatus: 'CANCELLED',
      sessionCreatedAt: new Date(START).toISOString(), verificationDeadline: new Date(DEADLINE).toISOString(),
      payerNameMatches: true, nowMs: START + 30 * MIN,
    });
    assert.equal(d.action, 'review');
  });

  await check('server clock before deadline cannot prove a late payment', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(DEADLINE + 2 * MIN).toISOString(), sessionStatus: 'EXPIRED',
      sessionCreatedAt: new Date(START).toISOString(), verificationDeadline: new Date(DEADLINE).toISOString(),
      payerNameMatches: true, nowMs: DEADLINE - MIN,
    });
    assert.equal(d.action, 'review');
  });

  console.log('Refund completion gate and late task');

  // Load refunds with its Sheets/Supabase dependencies stubbed by the require cache,
  // so no real refund is written.
  const refundsPath = path.join(__dirname, '..', 'services', 'refunds.js');
  const sheetsPath = path.join(__dirname, '..', 'services', 'googleSheets.js');
  const supabasePath = path.join(__dirname, '..', 'services', 'supabase.js');
  let store = [];
  let appendCalls = 0;
  let updateCalls = 0;
  require.cache[sheetsPath] = {
    id: sheetsPath, filename: sheetsPath, loaded: true,
    exports: {
      SHEETS: { REFUNDS: 'Refunds' },
      getRows: async () => store.slice(),
      appendRow: async (_sheet, row) => { appendCalls++; store.push({ ...row }); return row; },
      updateRow: async (_sheet, _k, id, patch) => {
        updateCalls++;
        const i = store.findIndex((r) => String(r.id) === String(id));
        if (i < 0) throw new Error('row not found');
        store[i] = { ...store[i], ...patch };
        return store[i];
      },
    },
  };
  require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { isConfigured: () => false, getClient: () => null },
  };
  delete require.cache[refundsPath];
  const refunds = require(refundsPath);

  const lateInput = {
    paymentId: 'pay_late_1', userId: 'user_1', userEmail: 'b@example.com', couponId: 'c1',
    orderCode: 'ORD1', receivedAmount: 17, transactionId: 'FMPIB6760738566',
    verificationDeadline: new Date(DEADLINE).toISOString(), transactionAt: new Date(DEADLINE + 2 * MIN).toISOString(),
    payerName: 'Parly Das',
  };

  await check('late task is created once for the full verified amount, status pending', async () => {
    store = []; appendCalls = 0;
    const r = await refunds.createLateRefundTask(lateInput);
    assert.equal(r.ok, true);
    assert.equal(r.created, true);
    assert.equal(r.refund.refundAmount, '17.00');
    assert.equal(r.refund.mismatchType, 'late_payment');
    assert.equal(r.refund.status, 'pending');
    assert.equal(appendCalls, 1);
  });

  await check('duplicate late-task call returns the existing task, writes nothing', async () => {
    const before = store.length;
    const r = await refunds.createLateRefundTask(lateInput);
    assert.equal(r.ok, true);
    assert.equal(r.created, false);
    assert.equal(store.length, before);
    assert.equal(appendCalls, 1);
  });

  await check('late task rejects a non-positive amount', async () => {
    const r = await refunds.createLateRefundTask({ ...lateInput, paymentId: 'pay_late_2', receivedAmount: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_INPUT');
  });

  // The Sheets mirror keys the refund on its `id` column (see toSheetsRow).
  const refundId = store[0].id;

  await check('entering a UTR alone never completes a refund', async () => {
    const r = await refunds.updateRefundStatus(refundId, { status: 'refunded', refundReference: 'UTR9988776655', processedBy: 'admin@x', confirmSent: false });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFIRMATION_REQUIRED');
    assert.equal(store[0].status, 'pending');
  });

  await check('confirmation without a valid UTR is refused', async () => {
    const r = await refunds.updateRefundStatus(refundId, { status: 'refunded', refundReference: 'x', processedBy: 'admin@x', confirmSent: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UTR_REQUIRED');
  });

  await check('UTR + explicit confirmation completes the refund with audit fields', async () => {
    const r = await refunds.updateRefundStatus(refundId, { status: 'refunded', refundReference: 'UTR9988776655', processedBy: 'admin@x', confirmSent: true });
    assert.equal(r.ok, true);
    assert.equal(r.refund.status, 'refunded');
    assert.equal(r.refund.refundReference, 'UTR9988776655');
    assert.equal(r.refund.processedBy, 'admin@x');
    assert.ok(r.refund.processedAt);
  });

  await check('a finalised refund cannot be changed again', async () => {
    const r = await refunds.updateRefundStatus(refundId, { status: 'rejected', processedBy: 'admin@x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REFUND_FINALISED');
  });

  // Restore the real modules for later tests in this process.
  delete require.cache[refundsPath];
  delete require.cache[sheetsPath];
  delete require.cache[supabasePath];

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
