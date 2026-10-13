// FamApp Gmail-only verification — mocked, offline suite.
// No Gmail, Google Sheets, Supabase or real payment is touched. The payment
// store functions are replaced with in-memory fakes for the duration of the run.
// Run: node server/tests/famappGmailVerification.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const store = require(path.join(__dirname, '..', 'services', 'paymentStore'));
const verifier = require(path.join(__dirname, '..', 'services', 'paymentVerifier'));
const sheetsDb = require(path.join(__dirname, '..', 'services', 'googleSheets'));

// Silence the verifier's console output during the run.
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

// ── Fake store ──────────────────────────────────────────────────────────────
const originals = {};
const PATCHED = [
  'recordNotification', 'updateNotification', 'findPendingPaymentsForAmount',
  'finalizePayment', 'findPendingPaymentByOrderCode', 'isTransactionUsed',
  'findPaymentByTransaction',
];

let state;
function resetState(payments = []) {
  state = {
    notifications: new Map(), // fingerprint -> notification
    payments,                 // array of payment rows (mocked)
    finalizeCalls: [],
    sheetsCalls: 0,
  };
}

function installFakes() {
  for (const k of PATCHED) originals[k] = store[k];
  store.recordNotification = async ({ fingerprint, ...rest }) => {
    if (state.notifications.has(fingerprint)) {
      return { duplicate: true, notification: state.notifications.get(fingerprint) };
    }
    const n = { id: 'n' + (state.notifications.size + 1), fingerprint, status: 'RECEIVED', ...rest };
    state.notifications.set(fingerprint, n);
    return { duplicate: false, notification: n };
  };
  store.updateNotification = async (id, patch) => {
    for (const n of state.notifications.values()) if (n.id === id) Object.assign(n, patch);
    return true;
  };
  store.findPendingPaymentsForAmount = async () => state.payments.filter((p) => p.status === 'PENDING');
  store.findPendingPaymentByOrderCode = async () => null;
  store.isTransactionUsed = async () => false;
  store.findPaymentByTransaction = async (txn, utr = '') =>
    state.payments.find((p) => p.status === 'PAID' &&
      ((txn && p.verifiedTransactionId === txn) || (utr && p.verifiedUtr === utr))) || null;
  store.finalizePayment = async (args) => {
    state.finalizeCalls.push(args);
    const p = state.payments.find((x) => x.paymentId === args.paymentId);
    if (!p) return { ok: false, code: 'PAYMENT_NOT_FOUND' };
    if (p.status === 'PAID') return { ok: true, code: 'ALREADY_PAID', idempotent: true };
    if (p.status !== 'PENDING') return { ok: false, code: 'PAYMENT_NOT_PENDING' };
    // Mirror the real store's replay guard: either reference already on a PAID row refuses.
    const clash = state.payments.find((x) => x.paymentId !== p.paymentId && x.status === 'PAID' &&
      ((args.transactionId && x.verifiedTransactionId === args.transactionId) ||
       (args.utr && x.verifiedUtr === args.utr)));
    if (clash) return { ok: false, code: 'REPLAY_DETECTED' };
    p.status = 'PAID';
    p.verifiedTransactionId = args.transactionId || '';
    p.verifiedUtr = args.utr || '';
    return { ok: true, code: 'OK' };
  };
}

function restoreFakes() {
  for (const k of PATCHED) store[k] = originals[k];
}

// Sheets is a store-level dependency; any call to it is a failure of the rule.
const realFindRow = sheetsDb.findRow;
const realGetRows = sheetsDb.getRows;
function trapSheets() {
  // Coupon mirror reads (findRow on COUPONS) are out of scope. Only payment
  // ledger reads and writes count as the Sheets payment fallback.
  sheetsDb.findRow = async (sheet, ...rest) => {
    if (sheet === sheetsDb.SHEETS.PAYMENTS || sheet === sheetsDb.SHEETS.PAYMENT_NOTIFICATIONS) { state.sheetsCalls += 1; throw new Error('Sheets payment fallback must not be called'); }
    return realFindRow(sheet, ...rest);
  };
  sheetsDb.getRows = async (sheet, ...rest) => {
    if (sheet === sheetsDb.SHEETS.PAYMENTS || sheet === sheetsDb.SHEETS.PAYMENT_NOTIFICATIONS) { state.sheetsCalls += 1; throw new Error('Sheets payment fallback must not be called'); }
    return realGetRows(sheet, ...rest);
  };
}
function untrapSheets() {
  sheetsDb.findRow = realFindRow;
  sheetsDb.getRows = realGetRows;
}

// ── Sample emails (mocked; sample payer and transaction ID are not reused) ──
const FAMAPP_HEADERS = 'dkim=pass header.i=@famapp.in; spf=pass; dmarc=pass header.from=famapp.in';
function famEmail({ amount = '1.00', payer = 'Jaggik', sender = 'no-reply@famapp.in', txn = 'FMPIB0000000001', utr = null, at = '2026-10-11T15:08:00Z', internalDate = Date.parse('2026-10-11T15:08:30Z') } = {}) {
  // Each sample gets a distinct 12-digit UTR derived from its txn unless one is given.
  const utrValue = utr || ('9' + String(txn).replace(/\D/g, '').padStart(11, '0').slice(-11));
  return {
    messageId: 'msg-' + txn,
    from: `"FamApp" <${sender}>`,
    authenticationResults: FAMAPP_HEADERS,
    subject: 'Payment received',
    body: `Hey Test Buyer,\nYou have successfully received\n₹${amount}\nfrom ${payer}\nTransaction ID: ${txn}\nUTR: ${utrValue}\nDate: 08:38 PM IST, 11 October 2026\nUpdated Balance: ₹${amount}`,
    date: new Date(internalDate).toUTCString(),
    internalDate: String(internalDate),
    labels: ['INBOX', 'UNREAD'],
    _at: at,
  };
}

function session({ id = 'pay-1', amount = 1, createdAt = '2026-10-11T15:00:00Z', status = 'PENDING' } = {}) {
  return { paymentId: id, orderId: 'ord-' + id, orderCode: 'SH-' + id, amount, createdAt, expiresAt: '2026-10-11T15:10:00Z', checkExpiresAt: '2026-10-11T15:20:00Z', status, userEmail: 'buyer@example.com', buyerName: 'Test Buyer', couponId: 'c-1' };
}

async function classify(email, pending) {
  const cand = verifier.buildCandidateFromEmail(email);
  return verifier.processEmailCandidate(cand, { pendingPayments: pending });
}

// ── Tests ──────────────────────────────────────────────────────────────────
(async () => {
  installFakes();
  trapSheets();
  try {
    await check('correct FamApp email + exact amount settles one session (mocked store)', async () => {
      resetState([session({ amount: 1 })]);
      const r = await classify(famEmail({ amount: '1.00' }), state.payments.slice());
      assert.equal(r.action, 'settled');
      assert.equal(state.finalizeCalls.length, 1);
      assert.equal(state.payments[0].status, 'PAID');
    });

    await check('wrong amount does not settle', async () => {
      resetState([session({ amount: 1 })]);
      const r = await classify(famEmail({ amount: '2.00' }), state.payments.slice());
      assert.notEqual(r.action, 'settled');
      assert.equal(state.finalizeCalls.length, 0);
    });

    await check('wrong sender (not no-reply@famapp.in) is ignored', async () => {
      resetState([session({ amount: 1 })]);
      const r = await classify(famEmail({ sender: 'alerts@other.example' }), state.payments.slice());
      assert.equal(r.action, 'ignored');
      assert.equal(state.finalizeCalls.length, 0);
    });

    await check('missing transaction ID is parked for review, never settled', async () => {
      resetState([session({ amount: 1 })]);
      const e = famEmail({ amount: '1.00' });
      e.body = e.body.replace(/Transaction ID: \S+\n?/, '');
      const r = await classify(e, state.payments.slice());
      assert.equal(r.action, 'review');
      assert.equal(state.finalizeCalls.length, 0);
      assert.equal(state.payments[0].status, 'PENDING');
    });

    await check('missing UTR is parked for review, never settled', async () => {
      resetState([session({ amount: 1 })]);
      const e = famEmail({ amount: '1.00', txn: 'FMPIB0000000102' });
      e.body = e.body.replace(/UTR: \S+\n?/, '');
      const r = await classify(e, state.payments.slice());
      assert.equal(r.action, 'review');
      assert.equal(state.finalizeCalls.length, 0);
      assert.equal(state.payments[0].status, 'PENDING');
    });

    await check('successful settlement persists both Transaction ID and UTR exactly once', async () => {
      resetState([session({ amount: 1 })]);
      const e = famEmail({ amount: '1.00', txn: 'FMPIB0000000103', utr: '664974818903' });
      const r = await classify(e, state.payments.slice());
      assert.equal(r.action, 'settled');
      assert.equal(state.finalizeCalls.length, 1);
      assert.equal(state.finalizeCalls[0].transactionId, 'FMPIB0000000103');
      assert.equal(state.finalizeCalls[0].utr, '664974818903');
      assert.equal(state.payments[0].verifiedUtr, '664974818903');
    });

    await check('same UTR in a different email cannot settle a second session', async () => {
      resetState([session({ id: 'a', amount: 1 }), session({ id: 'b', amount: 1, createdAt: '2026-10-11T15:01:00Z' })]);
      await classify(famEmail({ amount: '1.00', txn: 'FMPIB0000000104', utr: '664974818904' }), [state.payments[0]]);
      const second = famEmail({ amount: '1.00', txn: 'FMPIB0000000105', utr: '664974818904' });
      second.messageId = 'msg-second-utr';
      const r2 = await classify(second, [state.payments[1]]);
      assert.equal(r2.action, 'review');
      assert.equal(state.payments[1].status, 'PENDING');
      assert.equal(state.finalizeCalls.length, 1);
    });

    await check('ambiguous sessions with a valid email do not settle either one', async () => {
      resetState([session({ id: 'a', amount: 1 }), session({ id: 'b', amount: 1, createdAt: '2026-10-11T15:01:00Z' })]);
      const r = await classify(famEmail({ amount: '1.00', txn: 'FMPIB0000000106' }), state.payments.slice());
      assert.equal(r.action, 'review');
      assert.equal(state.finalizeCalls.length, 0);
      assert.ok(state.payments.every((p) => p.status === 'PENDING'));
    });

    await check('duplicate email (same Gmail message id) settles only once', async () => {
      resetState([session({ amount: 1 })]);
      const e = famEmail({ amount: '1.00', txn: 'FMPIB0000000002' });
      await classify(e, state.payments.slice());
      const r2 = await classify(e, state.payments.slice());
      assert.equal(r2.action, 'duplicate');
      assert.equal(state.finalizeCalls.length, 1);
    });

    await check('email received before the session window is rejected', async () => {
      resetState([session({ amount: 1, createdAt: '2026-10-11T15:00:00Z' })]);
      const old = famEmail({ amount: '1.00', txn: 'FMPIB0000000003', internalDate: Date.parse('2026-10-11T14:00:00Z') });
      const r = await classify(old, state.payments.slice());
      assert.notEqual(r.action, 'settled');
      assert.equal(state.finalizeCalls.length, 0);
    });

    await check('cancelled session is never settled', async () => {
      resetState([session({ amount: 1, status: 'CANCELLED' })]);
      const r = await classify(famEmail({ amount: '1.00', txn: 'FMPIB0000000004' }), state.payments.slice());
      assert.notEqual(r.action, 'settled');
      assert.equal(state.finalizeCalls.length, 0);
    });

    await check('expired session is never settled', async () => {
      resetState([session({ amount: 1, status: 'EXPIRED' })]);
      const r = await classify(famEmail({ amount: '1.00', txn: 'FMPIB0000000005' }), state.payments.slice());
      assert.notEqual(r.action, 'settled');
      assert.equal(state.finalizeCalls.length, 0);
    });

    await check('two live sessions for the same amount are parked for review, not guessed', async () => {
      resetState([session({ id: 'a', amount: 1 }), session({ id: 'b', amount: 1 })]);
      const r = await classify(famEmail({ amount: '1.00', txn: 'FMPIB0000000006' }), state.payments.slice());
      assert.equal(r.action, 'review');
      assert.equal(state.finalizeCalls.length, 0);
    });

    await check('valid email then successful settlement: second scan does not re-settle', async () => {
      resetState([session({ amount: 1 })]);
      const e = famEmail({ amount: '1.00', txn: 'FMPIB0000000007' });
      await classify(e, state.payments.slice());
      await classify({ ...e, messageId: 'other-msg' }, state.payments.slice());
      assert.equal(state.finalizeCalls.length, 1);
    });

    await check('transaction ID is extracted and passed to finalizePayment', async () => {
      resetState([session({ amount: 1 })]);
      await classify(famEmail({ amount: '1.00', txn: 'FMPIB6772399011' }), state.payments.slice());
      assert.equal(state.finalizeCalls.length, 1);
      assert.equal(state.finalizeCalls[0].transactionId, 'FMPIB6772399011');
    });

    await check('same transaction ID in two different emails cannot settle two sessions', async () => {
      resetState([session({ id: 'a', amount: 1 }), session({ id: 'b', amount: 1, createdAt: '2026-10-11T15:01:00Z' })]);
      // First email settles session a (amount 1) with txn X.
      await classify(famEmail({ amount: '1.00', txn: 'FMPIB0000000100' }), [state.payments[0]]);
      // A second, different Gmail message reuses txn X for session b.
      const second = famEmail({ amount: '1.00', txn: 'FMPIB0000000100' });
      second.messageId = 'msg-second-distinct-email';
      const r2 = await classify(second, [state.payments[1]]);
      assert.equal(r2.action, 'review');
      assert.equal(state.payments[1].status, 'PENDING');
      assert.equal(state.finalizeCalls.length, 1);
    });

    await check('a replayed transaction ID across two sessions is parked, never settled twice', async () => {
      resetState([session({ id: 'a', amount: 1 }), session({ id: 'b', amount: 1, createdAt: '2026-10-11T15:01:00Z' })]);
      await classify(famEmail({ amount: '1.00', txn: 'FMPIB0000000101', utr: '664974818901' }), [state.payments[0]]);
      const second = famEmail({ amount: '1.00', txn: 'FMPIB0000000101', utr: '664974818911' });
      second.messageId = 'msg-replay-txn';
      const r = await classify(second, [state.payments[1]]);
      assert.equal(r.action, 'review');
      assert.equal(state.payments[1].status, 'PENDING');
      assert.equal(state.finalizeCalls.length, 1);
    });

    await check('incorrect amount with a valid transaction and UTR still never settles', async () => {
      resetState([session({ amount: 5 })]);
      const r = await classify(famEmail({ amount: '1.00', txn: 'FMPIB0000000107' }), state.payments.slice());
      assert.notEqual(r.action, 'settled');
      assert.equal(state.finalizeCalls.length, 0);
    });

    await check('Google Sheets fallback is never called during verification', async () => {
      assert.equal(state.sheetsCalls, 0);
    });
  } finally {
    untrapSheets();
    restoreFakes();
  }

  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
  for (const line of results) console.log(line);
  console.log(`\n${passed} passed, ${failed} failed`);
  // The store/Sheets modules hold timers open; exit explicitly once reported.
  process.exit(failed ? 1 : 0);
})();
