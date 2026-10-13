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
const EXPIRES = START + 10 * MIN;              // the single authoritative deadline (payment_expires_at)
const AFTER_EXPIRY = EXPIRES + 1;              // just past the customer timer

(async () => {
  console.log('Session timing');

  await check('payment_expires_at is exactly 10 minutes after creation', () => {
    assert.equal(EXPIRES - START, 10 * MIN);
    assert.equal(w.CUSTOMER_WINDOW_MS, 10 * MIN);
  });

  await check('phase is open one millisecond before expiry', () => {
    assert.equal(w.phaseAt({ paymentExpiresAt: new Date(EXPIRES).toISOString() }, EXPIRES - 1), 'open');
  });

  await check('phase is expired exactly at expiry (no grace period)', () => {
    assert.equal(w.phaseAt({ paymentExpiresAt: new Date(EXPIRES).toISOString() }, EXPIRES), 'expired');
  });

  console.log('Decision: verification time, not transaction or arrival time');

  await check('verified before expiry on a PENDING session settles', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(START + 5 * MIN).toISOString(),
      sessionStatus: 'PENDING', sessionCreatedAt: new Date(START).toISOString(),
      paymentExpiresAt: new Date(EXPIRES).toISOString(), payerNameMatches: true, verifiedAtMs: START + 6 * MIN,
    });
    assert.equal(d.action, 'settle');
  });

  await check('transaction before expiry but first verified after expiry → settle (transaction time decides)', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(START + 9 * MIN).toISOString(),
      sessionStatus: 'PENDING', sessionCreatedAt: new Date(START).toISOString(),
      paymentExpiresAt: new Date(EXPIRES).toISOString(), payerNameMatches: true, verifiedAtMs: AFTER_EXPIRY + 5 * MIN,
    });
    assert.equal(d.action, 'settle');
  });

  await check('transaction after expiry on an EXPIRED session → expired_no_action (no refund)', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(START + 11 * MIN).toISOString(),
      sessionStatus: 'EXPIRED', sessionCreatedAt: new Date(START).toISOString(),
      paymentExpiresAt: new Date(EXPIRES).toISOString(), payerNameMatches: true, verifiedAtMs: AFTER_EXPIRY + 10 * MIN,
    });
    assert.equal(d.action, 'expired_no_action');
  });

  await check('transaction exactly at expiry counts as after the deadline → expired_no_action', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(EXPIRES).toISOString(),
      sessionStatus: 'PENDING', sessionCreatedAt: new Date(START).toISOString(),
      paymentExpiresAt: new Date(EXPIRES).toISOString(), payerNameMatches: true, verifiedAtMs: EXPIRES,
    });
    assert.equal(d.action, 'expired_no_action');
  });

  await check('late-arriving email for an in-window transaction, verified in time → settle', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(START + 2 * MIN).toISOString(),
      sessionStatus: 'PENDING', sessionCreatedAt: new Date(START).toISOString(),
      paymentExpiresAt: new Date(EXPIRES).toISOString(), payerNameMatches: true, verifiedAtMs: START + 8 * MIN,
    });
    assert.equal(d.action, 'settle');
  });

  console.log('Decision: ambiguity and safety');

  await check('unreadable transaction time → review, never a refund', () => {
    const d = w.decideIncomingCredit({
      transactionAt: null, sessionStatus: 'PENDING', sessionCreatedAt: new Date(START).toISOString(),
      paymentExpiresAt: new Date(EXPIRES).toISOString(), payerNameMatches: true, verifiedAtMs: AFTER_EXPIRY + MIN,
    });
    assert.equal(d.action, 'review');
  });

  await check('unreadable session timing → review', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(EXPIRES + MIN).toISOString(), sessionStatus: 'EXPIRED', sessionCreatedAt: '',
      paymentExpiresAt: '', payerNameMatches: true, verifiedAtMs: AFTER_EXPIRY + 5 * MIN,
    });
    assert.equal(d.action, 'review');
  });

  await check('payer name mismatch never refunds or settles', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(START + 2 * MIN).toISOString(), sessionStatus: 'EXPIRED',
      sessionCreatedAt: new Date(START).toISOString(), paymentExpiresAt: new Date(EXPIRES).toISOString(),
      payerNameMatches: false, verifiedAtMs: AFTER_EXPIRY + 10 * MIN,
    });
    assert.equal(d.action, 'review');
  });

  await check('already fulfilled session: a second late payment goes to review, not a refund', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(EXPIRES + MIN).toISOString(), sessionStatus: 'PAID',
      sessionCreatedAt: new Date(START).toISOString(), paymentExpiresAt: new Date(EXPIRES).toISOString(),
      payerNameMatches: true, verifiedAtMs: AFTER_EXPIRY + 10 * MIN,
    });
    assert.equal(d.action, 'review');
  });

  await check('transaction before the order was created is ignored', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(START - 30 * MIN).toISOString(), sessionStatus: 'PENDING',
      sessionCreatedAt: new Date(START).toISOString(), paymentExpiresAt: new Date(EXPIRES).toISOString(),
      payerNameMatches: true, verifiedAtMs: START + MIN,
    });
    assert.equal(d.action, 'ignore');
  });

  await check('in-window verification on a closed (cancelled) session → review, not coupon delivery', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(START + 3 * MIN).toISOString(), sessionStatus: 'CANCELLED',
      sessionCreatedAt: new Date(START).toISOString(), paymentExpiresAt: new Date(EXPIRES).toISOString(),
      payerNameMatches: true, verifiedAtMs: START + 4 * MIN,
    });
    assert.equal(d.action, 'review');
  });

  await check('in-window transaction on an already-EXPIRED session → review, never a coupon', () => {
    const d = w.decideIncomingCredit({
      transactionAt: new Date(START + 2 * MIN).toISOString(), sessionStatus: 'EXPIRED',
      sessionCreatedAt: new Date(START).toISOString(), paymentExpiresAt: new Date(EXPIRES).toISOString(),
      payerNameMatches: true, verifiedAtMs: EXPIRES - MIN,
    });
    assert.equal(d.action, 'review');
  });

  console.log('Refund completion gate and late task');

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
    paymentExpiresAt: new Date(EXPIRES).toISOString(), transactionAt: new Date(EXPIRES - MIN).toISOString(),
    payerName: 'Parly Das',
  };

  // The Sheets mirror keys the refund on its `id` column (see toSheetsRow).
  // Seed one administrator-managed mismatch refund to exercise the completion gate.
  store = []; appendCalls = 0;
  const seeded = await refunds.createOrUpdateRefund({
    paymentId: 'pay_mismatch_1', userId: 'user_1', userEmail: 'b@example.com', couponId: 'c1',
    orderCode: 'ORD1', requiredAmount: 10, receivedAmount: 17, currency: 'INR',
  });
  assert.equal(seeded.ok, true);
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
