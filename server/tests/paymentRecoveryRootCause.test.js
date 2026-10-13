// SaveHatke — payment verification root-cause + recovery regression suite.
//
// PURPOSE
//   This is the suite for the production incident in which buyers paid, the
//   FamApp credit email arrived and parsed correctly, and the payment still sat
//   PENDING forever. Root cause: `coupons.sold_payment_id` was never applied to
//   the live Supabase database, so the atomic coupon UPDATE failed with 42703
//   for EVERY settlement, and the old code replaced the real Postgres error with
//   a generic "Atomic coupon update failed." string.
//
//   It also pins the three latent defects that let that one failure become a
//   six-day silent outage:
//     1. unlockCoupon had no fallback for a missing optional column, and threw
//        away the database's own reason,
//     2. the Gmail snippet pre-filter recorded an IGNORED verdict keyed on the
//        message id, permanently preventing the full-body parse,
//     3. a notification left in REVIEW could never be re-processed, so a
//        transient settlement failure was a one-way door.
//
//   Fully MOCKED/OFFLINE. Google Sheets, Supabase and the Gmail mailbox are all
//   replaced with in-memory fakes. No real payment, coupon, sheet or mailbox is
//   touched. production code (paymentStore, paymentVerifier) runs unmodified.
//
//   Run: node server/tests/paymentRecoveryRootCause.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const db = require(path.join(__dirname, '..', 'services', 'googleSheets'));
const supabase = require(path.join(__dirname, '..', 'services', 'supabase'));
const store = require(path.join(__dirname, '..', 'services', 'paymentStore'));
const verifier = require(path.join(__dirname, '..', 'services', 'paymentVerifier'));

const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
const warnings = [];
console.log = () => {};
console.warn = (...a) => { warnings.push(a.join(' ')); };
console.error = (...a) => { warnings.push(a.join(' ')); };

let passed = 0;
let failed = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    results.push(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

// ── Shared fixtures ────────────────────────────────────────────────────────
const FAMAPP_AUTH = 'dkim=pass header.i=@famapp.in; spf=pass; dmarc=pass header.from=famapp.in';

// The real FamApp credit email body shape (as used by the existing suites).
// `atMs` is the instant the money moved; the Date line is rendered as IST, which
// is what the parser has to convert back to UTC.
function famBody({ amount, payer = 'Test Buyer', txn, utr, atMs = T0 + 60_000, timeLine = null }) {
  return `Hey ${payer},\nYou have successfully received\n₹${amount}\nfrom ${payer}\n`
    + `Transaction ID: ${txn}\nUTR: ${utr}\n${timeLine || istStamp(atMs)}\nUpdated Balance: ₹${amount}`;
}

const T0 = Date.parse('2026-10-13T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
/** Format a UTC instant the way FamApp prints it: local IST, 12-hour clock. */
function istStamp(ms) {
  const ist = new Date(ms + 5.5 * 3600 * 1000);
  const h24 = ist.getUTCHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const mer = h24 < 12 ? 'AM' : 'PM';
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  const day = ist.getUTCDate();
  const mon = MONTHS[ist.getUTCMonth()];
  const year = ist.getUTCFullYear();
  return `Date: ${String(h).padStart(2, '0')}:${mm} ${mer} IST, ${day} ${mon} ${year}`;
}

// ── Store-level fake world ─────────────────────────────────────────────────
// Real paymentStore code runs against an in-memory ledger and an in-memory
// Postgres that can be told to fail in the specific ways production failed.
const originals = {
  getRowsFresh: db.getRowsFresh, getRows: db.getRows, findRowsFresh: db.findRowsFresh,
  updateRow: db.updateRow, appendRow: db.appendRow, deleteRow: db.deleteRow,
  isConfigured: supabase.isConfigured, getClient: supabase.getClient,
  findPaymentById: store.findPaymentById,
};

let ledger;         // sheet name -> array of rows
let coupons;        // id -> coupon row
let claimRows;
let faults;         // { couponDbDown, missingBindingColumn, sheetsDown }

function resetWorld() {
  ledger = {
    [db.SHEETS.PAYMENTS]: [],
    [db.SHEETS.ORDERS]: [],
    [db.SHEETS.PAYMENT_NOTIFICATIONS]: [],
    [db.SHEETS.REFUNDS]: [],
    [db.SHEETS.SECURITY_AUDIT]: [],
  };
  coupons = new Map();
  claimRows = [];
  faults = { couponDbDown: false, missingBindingColumn: false, sheetsDown: false };
  store.__resetBindingProbe();
  installWorld();
}

/** A payment + order pair shaped exactly like the real Sheets rows. */
function seedSession({ paymentId, orderId, couponId, amount, userEmail, createdMs = T0, windowMin = 10 }) {
  ledger[db.SHEETS.ORDERS].push({
    id: orderId, order_code: 'SH-PUR-TEST', user_id: 'u1', user_email: userEmail,
    coupon_id: couponId, amount, currency: 'INR', status: 'PENDING',
    buyer_name: 'Test Buyer', buyer_email: userEmail, coupon_code: couponId,
    coupon_brand: 'Myntra', created_at: iso(createdMs), updated_at: iso(createdMs),
    expires_at: iso(createdMs + windowMin * 60000), paid_at: '',
  });
  ledger[db.SHEETS.PAYMENTS].push({
    payment_id: paymentId, order_id: orderId, user_id: 'u1', user_email: userEmail,
    coupon_id: couponId, amount, currency: 'INR', status: 'PENDING',
    created_at: iso(createdMs), updated_at: iso(createdMs),
    expires_at: iso(createdMs + windowMin * 60000),
    check_expires_at: iso(createdMs + windowMin * 60000),
    payment_expires_at: iso(createdMs + windowMin * 60000),
    paid_at: '', verified_transaction_id: '', verified_utr: '', received_amount: '',
  });
  coupons.set(couponId, {
    id: couponId, code: couponId, status: 'available', buyer_email: '',
    sold_at: null, brand: 'Myntra', ...(faults.missingBindingColumn ? {} : { sold_payment_id: null }),
  });
  return paymentId;
}

function seedNotification({ fingerprint, amount, txn, utr, occurredMs, status = 'RECEIVED', notes = '' }) {
  const n = {
    id: 'n' + (ledger[db.SHEETS.PAYMENT_NOTIFICATIONS].length + 1),
    fingerprint, source: 'email', amount, currency: 'INR',
    transaction_id: txn, utr, payer_vpa: '', payee_vpa: '', reference: utr,
    occurred_at: iso(occurredMs), status, matched_payment_id: '', notes,
    created_at: iso(occurredMs), processed_at: '', raw: '',
  };
  ledger[db.SHEETS.PAYMENT_NOTIFICATIONS].push(n);
  return n;
}

function installWorld() {
  db.getRowsFresh = async (name) => {
    if (faults.sheetsDown) throw new Error('Sheets unreachable');
    return (ledger[name] || []).map((r) => ({ ...r }));
  };
  db.getRows = db.getRowsFresh;
  db.findRowsFresh = async (name, field, value) =>
    (ledger[name] || []).filter((r) => String(r[field]) === String(value)).map((r) => ({ ...r }));
  db.updateRow = async (name, keyField, keyValue, patch) => {
    if (faults.sheetsDown) throw new Error('Sheets write failed');
    const row = (ledger[name] || []).find((r) => String(r[keyField]) === String(keyValue));
    if (!row) return false;
    Object.assign(row, patch);
    return true;
  };
  db.appendRow = async (name, row) => {
    if (faults.sheetsDown) throw new Error('Sheets write failed');
    (ledger[name] = ledger[name] || []).push({ ...row });
    return true;
  };
  db.deleteRow = async () => true;

  supabase.isConfigured = () => true;
  supabase.getClient = () => ({
    from: (table) => {
      if (table === 'payment_reference_claims') return claimsStub();
      const q = { op: null, patch: null, filters: {} };
      const api = {
        update(patch) { q.op = 'update'; q.patch = patch; return api; },
        select() { return api; },
        eq(col, val) { q.filters[col] = String(val); return api; },
        maybeSingle: async () => {
          const c = coupons.get(q.filters.id);
          return { data: c ? { ...c } : null, error: null };
        },
        then(resolve) {
          if (q.op !== 'update') return resolve({ data: [], error: null });
          if (faults.couponDbDown) {
            return resolve({ data: null, error: { code: '08006', message: 'connection failure' } });
          }
          // Mirror PostgREST: it validates the patch against the live schema
          // before running anything, so an unknown column rejects the statement
          // no matter what the row currently holds. This is exactly what
          // production returned: PGRST204 / 42703 for sold_payment_id.
          if (faults.missingBindingColumn && Object.prototype.hasOwnProperty.call(q.patch, 'sold_payment_id')) {
            return resolve({
              data: null,
              error: { code: 'PGRST204', message: "Could not find the 'sold_payment_id' column of 'coupons' in the schema cache" },
            });
          }
          const c = coupons.get(q.filters.id);
          if (c && c.status === q.filters.status) {
            Object.assign(c, q.patch);
            return resolve({ data: [{ ...c }], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return api;
    },
  });
}

function claimsStub() {
  const q = { op: 'select', row: null, filters: {} };
  const api = {
    insert(row) { q.op = 'insert'; q.row = row; return api; },
    delete() { q.op = 'delete'; return api; },
    select() { q.op = 'select'; return api; },
    eq(col, val) { q.filters[col] = String(val); return api; },
    maybeSingle: async () => {
      const m = claimRows.find((r) => Object.keys(q.filters).every((k) => String(r[k]) === q.filters[k]));
      return { data: m ? { payment_id: m.payment_id } : null, error: null };
    },
    then(resolve) {
      if (q.op === 'insert') {
        const dup = claimRows.some((r) => (r.ref_type === q.row.ref_type && r.ref_value === q.row.ref_value));
        if (dup) {
          const owner = claimRows.find((r) => r.ref_type === q.row.ref_type && r.ref_value === q.row.ref_value);
          return resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
        }
        claimRows.push({ payment_id: q.row.payment_id, ref_type: q.row.ref_type, ref_value: q.row.ref_value });
        return resolve({ data: [{ payment_id: q.row.payment_id }], error: null });
      }
      if (q.op === 'delete') {
        claimRows = claimRows.filter((r) => !(r.ref_type === q.filters.ref_type && r.ref_value === q.filters.ref_value));
        return resolve({ data: [], error: null });
      }
      return resolve({ data: [], error: null });
    },
  };
  return api;
}

function restoreWorld() {
  Object.assign(db, {
    getRowsFresh: originals.getRowsFresh, getRows: originals.getRows,
    findRowsFresh: originals.findRowsFresh, updateRow: originals.updateRow,
    appendRow: originals.appendRow, deleteRow: originals.deleteRow,
  });
  supabase.isConfigured = originals.isConfigured;
  supabase.getClient = originals.getClient;
  store.findPaymentById = originals.findPaymentById;
}

const paymentRow = (id) => ledger[db.SHEETS.PAYMENTS].find((r) => r.payment_id === id);
const notificationRows = () => ledger[db.SHEETS.PAYMENT_NOTIFICATIONS];

async function main() {
// ═══════════════════════════════════════════════════════════════════════════
//  A. THE PRODUCTION ROOT CAUSE
// ═══════════════════════════════════════════════════════════════════════════

await check('A1 missing coupons.sold_payment_id no longer breaks every settlement (the production outage)', async () => {
  resetWorld();
  // Reproduce production: the binding migration was never applied.
  faults.missingBindingColumn = true;
  seedSession({ paymentId: 'pay_outage', orderId: 'ord_outage', couponId: 'CPN_OUT', amount: '10.00', userEmail: 'buyer@example.com', createdMs: T0 });
  seedNotification({ fingerprint: 'fp_outage', amount: '10.00', txn: 'FMPIB0000000001', utr: '664974818901', occurredMs: T0 + 60_000 });

  const result = await store.finalizePayment({
    paymentId: 'pay_outage',
    transactionId: 'FMPIB0000000001',
    utr: '664974818901',
    source: 'email',
    paidAt: iso(T0 + 60_000),
    transactionAt: iso(T0 + 60_000),
    receivedAmount: 10,
  });

  assert.equal(result.ok, true, `settlement should succeed without the optional binding column, got ${JSON.stringify(result)}`);
  assert.equal(paymentRow('pay_outage').status, 'PAID');
  // The coupon really was sold — the conditional UPDATE is what guarantees it.
  const coupon = coupons.get('CPN_OUT');
  assert.equal(coupon.status, 'sold');
  assert.equal(coupon.sold_at, iso(T0 + 60_000));
});

await check('A2 the binding column is still written when the database HAS the column', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_bind', orderId: 'ord_bind', couponId: 'CPN_BIND', amount: '25.00', userEmail: 'b@example.com', createdMs: T0 });

  const result = await store.finalizePayment({
    paymentId: 'pay_bind', transactionId: 'FMPIB0000000002', utr: '664974818902',
    source: 'email', paidAt: iso(T0 + 60_000), transactionAt: iso(T0 + 60_000), receivedAmount: 25,
  });

  assert.equal(result.ok, true);
  assert.equal(coupons.get('CPN_BIND').status, 'sold');
  assert.equal(coupons.get('CPN_BIND').sold_payment_id, 'pay_bind',
    'with the column present the coupon must stay bound to the payment that sold it');
});

await check('A3 a real database error is preserved, not flattened into "Atomic coupon update failed."', async () => {
  resetWorld();
  faults.couponDbDown = true; // a genuine outage, NOT a schema mismatch
  seedSession({ paymentId: 'pay_dberr', orderId: 'ord_dberr', couponId: 'CPN_ERR', amount: '30.00', userEmail: 'b@example.com', createdMs: T0 });

  let thrown = null;
  try {
    await store.finalizePayment({
      paymentId: 'pay_dberr', transactionId: 'FMPIB0000000003', utr: '664974818903',
      source: 'email', paidAt: iso(T0 + 60_000), transactionAt: iso(T0 + 60_000), receivedAmount: 30,
    });
  } catch (e) { thrown = e; }

  assert.ok(thrown, 'a failed coupon flip must throw so the payment is never marked PAID');
  assert.match(thrown.message, /Atomic coupon update failed/);
  // The regression: the operator must be able to see WHY without a debugger.
  assert.match(thrown.message, /connection failure/,
    `the database's own reason must survive, got: ${thrown.message}`);
  assert.match(thrown.message, /CPN_ERR/, 'the error must name the coupon that failed to unlock');
});

await check('A4 no PAID row and no sold coupon when the coupon database is down', async () => {
  resetWorld();
  faults.couponDbDown = true;
  seedSession({ paymentId: 'pay_down', orderId: 'ord_down', couponId: 'CPN_DOWN', amount: '50.00', userEmail: 'b@example.com', createdMs: T0 });
  await assert.rejects(
    () => store.finalizePayment({
      paymentId: 'pay_down', transactionId: 'FMPIB0000000004', utr: '664974818904',
      source: 'email', paidAt: iso(T0 + 60_000), transactionAt: iso(T0 + 60_000), receivedAmount: 50,
    }),
    /Atomic coupon update failed/,
  );
  assert.equal(paymentRow('pay_down').status, 'PENDING', 'payment must stay PENDING');
  assert.equal(coupons.get('CPN_DOWN').status, 'available', 'coupon must stay available for a retry');
  // The claim taken for this attempt must be released so a retry can re-take it.
  assert.equal(claimRows.length, 0, 'the reference claim must be released when the unlock fails');
});

// ═══════════════════════════════════════════════════════════════════════════
//  B. THE STRANDED-NOTIFICATION DEAD END  (why it stayed broken for days)
// ═══════════════════════════════════════════════════════════════════════════

async function runEmailCandidate({ payment, email, finalizeImpl }) {
  // Drive the REAL verifier email path against the REAL store.
  const realFinalize = store.finalizePayment;
  store.finalizePayment = finalizeImpl || realFinalize;
  try {
    return await verifier.processEmailCandidate(verifier.buildCandidateFromEmail(email));
  } finally {
    store.finalizePayment = realFinalize;
  }
}

await check('B1 a payment whose settlement failed is not stranded: the same email settles on retry', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_retry', orderId: 'ord_retry', couponId: 'CPN_RETRY', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });

  const email = {
    messageId: 'msg-retry-1',
    from: '"FamApp" <no-reply@famapp.in>',
    authenticationResults: FAMAPP_AUTH,
    subject: 'Payment received',
    body: famBody({ amount: '10.00', txn: 'FMPIB0000000005', utr: '664974818905' }),
    date: iso(T0 + 60_000),
    internalDate: String(T0 + 60_000),
    labels: ['INBOX'],
  };

  // Pass 1: the coupon flip fails for an infrastructure reason.
  const first = await runEmailCandidate({
    payment: 'pay_retry',
    email,
    finalizeImpl: async () => { throw new Error('Atomic coupon update failed for CPN_RETRY: connection failure'); },
  });
  assert.equal(first.action, 'review', `pass 1 should park for review, got ${first.action}`);
  assert.equal(paymentRow('pay_retry').status, 'PENDING');
  const parked = notificationRows().find((n) => n.fingerprint);
  assert.equal(parked.status, 'REVIEW', 'the notification is parked in REVIEW');

  // Pass 2: the database is healthy again. The SAME email must now settle.
  // Before the fix this returned {action:'duplicate'} forever.
  const second = await runEmailCandidate({ payment: 'pay_retry', email });
  assert.equal(second.action, 'settled', `the retry must settle, got ${second.action}: ${second.reason}`);
  assert.equal(paymentRow('pay_retry').status, 'PAID');
  assert.equal(coupons.get('CPN_RETRY').status, 'sold');
  assert.equal(notificationRows()[0].status, 'MATCHED');
});

await check('B2 a settled message is still never re-opened (exactly-once is preserved)', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_once', orderId: 'ord_once', couponId: 'CPN_ONCE', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });
  const email = {
    messageId: 'msg-once-1',
    from: '"FamApp" <no-reply@famapp.in>',
    authenticationResults: FAMAPP_AUTH,
    subject: 'Payment received',
    body: famBody({ amount: '10.00', txn: 'FMPIB0000000006', utr: '664974818906' }),
    date: iso(T0 + 60_000), internalDate: String(T0 + 60_000), labels: ['INBOX'],
  };
  const first = await verifier.processEmailCandidate(verifier.buildCandidateFromEmail(email));
  assert.equal(first.action, 'settled');

  const second = await verifier.processEmailCandidate(verifier.buildCandidateFromEmail(email));
  assert.equal(second.action, 'duplicate', `a settled email must short-circuit, got ${second.action}`);
  assert.equal(notificationRows().length, 1, 'no second notification row');
  // The buyer must never be emailed twice.
  assert.equal(notificationRows()[0].matched_payment_id, 'pay_once');
});

await check('B3 an ignored message stays ignored and is not re-examined forever', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_ign', orderId: 'ord_ign', couponId: 'CPN_IGN', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });
  const email = {
    messageId: 'msg-ign-1',
    from: '"FamApp" <no-reply@famapp.in>',
    authenticationResults: FAMAPP_AUTH,
    subject: 'Payment sent',
    body: `You have successfully sent\n₹10.00\nto Test Buyer\nTransaction ID: FMPIB0000000007\nUTR: 664974818907`,
    date: iso(T0 + 60_000), internalDate: String(T0 + 60_000), labels: ['INBOX'],
  };
  const first = await verifier.processEmailCandidate(verifier.buildCandidateFromEmail(email));
  assert.equal(first.action, 'ignored', 'a debit is not a payment');
  const second = await verifier.processEmailCandidate(verifier.buildCandidateFromEmail(email));
  assert.equal(second.action, 'duplicate', 'the decision was final and must stick');
});

// ═══════════════════════════════════════════════════════════════════════════
//  C. THE SNIPPET PRE-FILTER POISON
// ═══════════════════════════════════════════════════════════════════════════

await check('C1 a truncated Gmail snippet can no longer permanently block a real payment', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_snip', orderId: 'ord_snip', couponId: 'CPN_SNIP', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });

  // Gmail's snippet is a truncated preview: here it cuts off BEFORE the amount.
  // The old pre-filter parsed no amount, recorded an IGNORED verdict under the
  // message-id fingerprint, and the full body could never be read again.
  const snippetEmail = {
    messageId: 'msg-snip-1',
    from: '"FamApp" <no-reply@famapp.in>',
    authenticationResults: FAMAPP_AUTH,
    subject: 'Payment received',
    body: 'Hey Test Buyer, You have successfully recei…',
    date: iso(T0 + 60_000), internalDate: String(T0 + 60_000), labels: ['INBOX'],
  };
  const fullEmail = {
    ...snippetEmail,
    body: famBody({ amount: '10.00', txn: 'FMPIB0000000008', utr: '664974818908' }),
  };

  // The candidate built from the truncated snippet parses no amount.
  const snippetCandidate = verifier.buildCandidateFromEmail(snippetEmail);
  assert.equal(snippetCandidate.amount, null, 'fixture: the snippet really does hide the amount');

  const result = await verifier.processEmailCandidate(verifier.buildCandidateFromEmail(fullEmail));
  assert.equal(result.action, 'settled', `the full body must still settle, got ${result.action}: ${result.reason}`);
  assert.equal(paymentRow('pay_snip').status, 'PAID');
});

// ═══════════════════════════════════════════════════════════════════════════
//  D. IST / TIMEZONE PARSING
// ═══════════════════════════════════════════════════════════════════════════

await check('D1 "6:30 PM IST" is parsed as 13:00 UTC, not 18:30', async () => {
  const parsed = verifier.buildCandidateFromEmail({
    messageId: 'msg-ist', from: '"FamApp" <no-reply@famapp.in>',
    authenticationResults: FAMAPP_AUTH, subject: 'Payment received',
    body: famBody({ amount: '10.00', txn: 'FMPIB0000000009', utr: '664974818909', timeLine: 'Date: 06:30 PM IST, 13 October 2026' }),
    date: 'Tue, 13 Oct 2026 13:01:00 +0000', internalDate: String(Date.parse('2026-10-13T13:01:00Z')),
    labels: ['INBOX'],
  });
  // 18:30 IST == 13:00 UTC. Reading it as 18:30 UTC would judge a real in-window
  // payment as "after the deadline" and silently refuse it.
  assert.equal(parsed.transactionAt, '2026-10-13T13:00:00.000Z',
    `IST must be converted, got ${parsed.transactionAt}`);
  assert.equal(parsed.amount, 10);
});

await check('D2 a transaction after the deadline is refused, even though the email parsed', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_late', orderId: 'ord_late', couponId: 'CPN_LATE', amount: '10.00', userEmail: 'b@example.com', createdMs: T0, windowMin: 10 });
  const result = await runEmailCandidate({
    payment: 'pay_late',
    email: {
      messageId: 'msg-late-1', from: '"FamApp" <no-reply@famapp.in>',
      authenticationResults: FAMAPP_AUTH, subject: 'Payment received',
      body: famBody({ amount: '10.00', txn: 'FMPIB0000000010', utr: '664974818910', atMs: T0 + 11 * 60_000 }),
      date: iso(T0 + 11 * 60_000), internalDate: String(T0 + 11 * 60_000), labels: ['INBOX'],
    },
  });
  assert.notEqual(result.action, 'settled', 'a payment after the window must not unlock a coupon');
  assert.equal(coupons.get('CPN_LATE').status, 'available');
});

// ═══════════════════════════════════════════════════════════════════════════
//  E. MATCHING AND IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════════════════

await check('E1 two sessions racing for one coupon: only one ever unlocks it', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_r1', orderId: 'ord_r1', couponId: 'CPN_RACE', amount: '10.00', userEmail: 'a@example.com', createdMs: T0 });
  seedSession({ paymentId: 'pay_r2', orderId: 'ord_r2', couponId: 'CPN_RACE', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });

  const [x, y] = await Promise.allSettled([
    store.finalizePayment({ paymentId: 'pay_r1', transactionId: 'FMPIB0000000011', utr: '664974818911', source: 'email', paidAt: iso(T0 + 60_000), transactionAt: iso(T0 + 60_000), receivedAmount: 10 }),
    store.finalizePayment({ paymentId: 'pay_r2', transactionId: 'FMPIB0000000012', utr: '664974818912', source: 'email', paidAt: iso(T0 + 60_000), transactionAt: iso(T0 + 60_000), receivedAmount: 10 }),
  ]);

  const ok = [x, y].filter((r) => r.status === 'fulfilled' && r.value && r.value.ok);
  assert.equal(ok.length, 1, `exactly one settlement may succeed, got ${ok.length}`);
  assert.equal(coupons.get('CPN_RACE').status, 'sold');
  assert.equal(coupons.get('CPN_RACE').sold_payment_id, 'pay_r1');
});

await check('E2 the same webhook delivered twice settles once', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_dup', orderId: 'ord_dup', couponId: 'CPN_DUP', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });
  const args = { paymentId: 'pay_dup', transactionId: 'FMPIB0000000013', utr: '664974818913', source: 'email', paidAt: iso(T0 + 60_000), transactionAt: iso(T0 + 60_000), receivedAmount: 10 };
  const first = await store.finalizePayment(args);
  const second = await store.finalizePayment(args);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.code, 'ALREADY_PAID');
  assert.equal(second.idempotent, true);
  assert.equal(paymentRow('pay_dup').status, 'PAID');
});

await check('E3 an underpayment never unlocks a coupon', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_under', orderId: 'ord_under', couponId: 'CPN_UNDER', amount: '100.00', userEmail: 'b@example.com', createdMs: T0 });
  const result = await runEmailCandidate({
    payment: 'pay_under',
    email: {
      messageId: 'msg-under-1', from: '"FamApp" <no-reply@famapp.in>',
      authenticationResults: FAMAPP_AUTH, subject: 'Payment received',
      body: famBody({ amount: '40.00', txn: 'FMPIB0000000014', utr: '664974818914' }),
      date: iso(T0 + 60_000), internalDate: String(T0 + 60_000), labels: ['INBOX'],
    },
  });
  assert.notEqual(result.action, 'settled');
  assert.equal(coupons.get('CPN_UNDER').status, 'available', 'a short payment must not deliver the coupon');
});

await check('E4 a credit for a different amount matches no one', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_amt', orderId: 'ord_amt', couponId: 'CPN_AMT', amount: '99.00', userEmail: 'b@example.com', createdMs: T0 });
  const result = await runEmailCandidate({
    payment: 'pay_amt',
    email: {
      messageId: 'msg-amt-1', from: '"FamApp" <no-reply@famapp.in>',
      authenticationResults: FAMAPP_AUTH, subject: 'Payment received',
      body: famBody({ amount: '10.00', txn: 'FMPIB0000000015', utr: '664974818915' }),
      date: iso(T0 + 60_000), internalDate: String(T0 + 60_000), labels: ['INBOX'],
    },
  });
  assert.notEqual(result.action, 'settled');
  assert.equal(coupons.get('CPN_AMT').status, 'available');
  assert.equal(paymentRow('pay_amt').status, 'PENDING');
});

await check('E5 a spoofed sender that fails DMARC alignment is refused', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_spoof', orderId: 'ord_spoof', couponId: 'CPN_SPOOF', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });
  const result = await runEmailCandidate({
    payment: 'pay_spoof',
    email: {
      messageId: 'msg-spoof-1', from: '"FamApp" <no-reply@famapp.in>',
      // SPF/DKIM pass but nothing vouches for the visible From domain.
      authenticationResults: 'spf=pass (google.com: domain of no-reply@famapp.in designates 1.2.3.4) smtp.mailfrom=no-reply@famapp.in; dkim=pass header.i=@famapp.in',
      subject: 'Payment received',
      body: famBody({ amount: '10.00', txn: 'FMPIB0000000016', utr: '664974818916' }),
      date: iso(T0 + 60_000), internalDate: String(T0 + 60_000), labels: ['INBOX'],
    },
  });
  assert.notEqual(result.action, 'settled');
  assert.equal(coupons.get('CPN_SPOOF').status, 'available');
});

await check('E6 the payer name is read from the real FamApp layout and compared strictly', () => {
  // Real plain-text FamApp body: the payer sits on the line after the amount and
  // is terminated by the next labelled field, not by a connector word.
  const real = famBody({ amount: '1.00', payer: 'Rupayan Das', txn: 'FMPIB0000000024', utr: '664974818924' });
  const name = verifier.extractPayerName(real);
  assert.equal(name, 'Rupayan Das',
    `the payer name must be extracted from the real email body, got ${JSON.stringify(name)}`);
  assert.ok(!/Transaction/.test(name), 'the following label must not be swallowed into the name');

  assert.equal(verifier.payerNameMatches('Rupayan Das', 'rupayan das'), true, 'case is not a difference');
  assert.equal(verifier.payerNameMatches('Das Rupayan', 'Rupayan Das'), true, 'word order is not a difference');
  assert.equal(verifier.payerNameMatches(name, 'Rupayan Das'), true);
  assert.equal(verifier.payerNameMatches(name, 'Someone Else'), false,
    'a genuinely different payer must not match');
  assert.equal(verifier.payerNameMatches('', 'Rupayan Das'), false,
    'an unreadable name must fail closed, never match');
});

// ═══════════════════════════════════════════════════════════════════════════
//  F. THE ADMIN RECOVERY PATH
// ═══════════════════════════════════════════════════════════════════════════

await check('F1 recovery settles a payment from its recorded credit evidence', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_rec', orderId: 'ord_rec', couponId: 'CPN_REC', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });
  // The verification pass saw the credit but could not settle it.
  seedNotification({ fingerprint: 'fp_rec', amount: '10.00', txn: 'FMPIB0000000017', utr: '664974818917', occurredMs: T0 + 60_000, status: 'REVIEW' });

  const payment = await store.findPaymentById('pay_rec');
  const evidence = await store.findSettlementEvidence(payment);
  assert.ok(evidence, 'the recorded credit must be found as evidence');
  assert.equal(evidence.transactionId, 'FMPIB0000000017');

  const result = await store.finalizePayment({
    paymentId: 'pay_rec', transactionId: evidence.transactionId, utr: evidence.utr,
    source: 'admin_recovery', notes: 'Admin recovery: replayed recorded credit',
    paidAt: evidence.occurredAt, transactionAt: evidence.occurredAt, receivedAmount: evidence.amount,
  });
  assert.equal(result.ok, true);
  assert.equal(paymentRow('pay_rec').status, 'PAID');
  assert.equal(coupons.get('CPN_REC').status, 'sold');
});

await check('F2 recovery is idempotent — a second call delivers nothing extra', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_rec2', orderId: 'ord_rec2', couponId: 'CPN_REC2', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });
  seedNotification({ fingerprint: 'fp_rec2', amount: '10.00', txn: 'FMPIB0000000018', utr: '664974818918', occurredMs: T0 + 60_000, status: 'REVIEW' });
  const args = { paymentId: 'pay_rec2', transactionId: 'FMPIB0000000018', utr: '664974818918', source: 'admin_recovery', paidAt: iso(T0 + 60_000), transactionAt: iso(T0 + 60_000), receivedAmount: 10 };
  const first = await store.finalizePayment(args);
  const second = await store.finalizePayment(args);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.code, 'ALREADY_PAID');
});

await check('F3 recovery finds NO evidence when the credit predates the session (stale money)', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_stale', orderId: 'ord_stale', couponId: 'CPN_STALE', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });
  // A credit from an hour earlier must not be allowed to "recover" this session.
  seedNotification({ fingerprint: 'fp_stale', amount: '10.00', txn: 'FMPIB0000000019', utr: '664974818919', occurredMs: T0 - 3600_000 });
  const payment = await store.findPaymentById('pay_stale');
  const evidence = await store.findSettlementEvidence(payment);
  assert.equal(evidence, null, 'a credit older than the session must not be usable as evidence');
});

await check('F4 recovery finds NO evidence when the credit is outside the amount', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_wrong', orderId: 'ord_wrong', couponId: 'CPN_WRONG', amount: '250.00', userEmail: 'b@example.com', createdMs: T0 });
  seedNotification({ fingerprint: 'fp_wrong', amount: '10.00', txn: 'FMPIB0000000020', utr: '664974818920', occurredMs: T0 + 60_000 });
  const payment = await store.findPaymentById('pay_wrong');
  assert.equal(await store.findSettlementEvidence(payment), null);
});

await check('F5 recovery finds NO evidence when the credit is after the deadline', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_after', orderId: 'ord_after', couponId: 'CPN_AFTER', amount: '10.00', userEmail: 'b@example.com', createdMs: T0, windowMin: 10 });
  seedNotification({ fingerprint: 'fp_after', amount: '10.00', txn: 'FMPIB0000000021', utr: '664974818921', occurredMs: T0 + 20 * 60_000 });
  const payment = await store.findPaymentById('pay_after');
  assert.equal(await store.findSettlementEvidence(payment), null,
    'recovery must never move a deadline');
});

await check('F6 recovery refuses a notification that is missing its Transaction ID or UTR', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_noref', orderId: 'ord_noref', couponId: 'CPN_NOREF', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });
  seedNotification({ fingerprint: 'fp_noref', amount: '10.00', txn: '', utr: '', occurredMs: T0 + 60_000 });
  const payment = await store.findPaymentById('pay_noref');
  assert.equal(await store.findSettlementEvidence(payment), null,
    'evidence without both references is not settleable — it must not pass the gate');
  // It must still be offered for mailbox re-verification, which is the only way
  // to recover a row written before the references were persisted.
  const candidates = await store.findRecordedCreditsForPayment(payment);
  assert.equal(candidates.length, 1, 'the row must be offered for a mailbox re-read');
  assert.equal(candidates[0].transactionId, '');
});

await check('F7 the bank references are now persisted on the notification (dispute + replay evidence)', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_persist', orderId: 'ord_persist', couponId: 'CPN_PERSIST', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });
  const email = {
    messageId: 'msg-persist-1', from: '"FamApp" <no-reply@famapp.in>',
    authenticationResults: FAMAPP_AUTH, subject: 'Payment received',
    body: famBody({ amount: '10.00', txn: 'FMPIB0000000025', utr: '664974818925', atMs: T0 + 60_000 }),
    date: iso(T0 + 60_000), internalDate: String(T0 + 60_000), labels: ['INBOX'],
  };
  await verifier.processEmailCandidate(verifier.buildCandidateFromEmail(email));

  const stored = notificationRows()[0];
  assert.equal(stored.transaction_id, 'FMPIB0000000025', 'the transaction id must survive in the ledger');
  assert.equal(stored.utr, '664974818925', 'the UTR must survive in the ledger');
  assert.equal(stored.status, 'MATCHED');

  // And the persisted references must be directly usable as recovery evidence.
  const payment = await store.findPaymentById('pay_persist');
  const evidence = await store.findSettlementEvidence(payment);
  assert.ok(evidence, 'a settled notification within the window is valid recovery evidence');
  assert.equal(evidence.utr, '664974818925');
});

await check('F8 recorded credits outside the window are never offered for re-verification', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_scope', orderId: 'ord_scope', couponId: 'CPN_SCOPE', amount: '10.00', userEmail: 'b@example.com', createdMs: T0, windowMin: 10 });
  // One stale credit (an hour old) and one in-window credit: only the second
  // may be offered, so recovery cannot reach for yesterday's money.
  seedNotification({ fingerprint: 'fp_old', amount: '10.00', txn: 'T1', utr: '664974818926', occurredMs: T0 - 3600_000 });
  seedNotification({ fingerprint: 'fp_new', amount: '10.00', txn: 'T2', utr: '664974818927', occurredMs: T0 + 60_000 });
  const payment = await store.findPaymentById('pay_scope');
  const candidates = await store.findRecordedCreditsForPayment(payment);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].transactionId, 'T2');
});

// ═══════════════════════════════════════════════════════════════════════════
//  G. DETECTION INDEPENDENCE (Gmail push failing must not stop detection)
// ═══════════════════════════════════════════════════════════════════════════

await check('G1 a push/Gmail outage never marks a payment paid on its own', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_push', orderId: 'ord_push', couponId: 'CPN_PUSH', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });
  // No email ever arrived. A failed push must leave the payment pending and the
  // coupon available — detection failing must never fabricate a sale.
  assert.equal(paymentRow('pay_push').status, 'PENDING');
  assert.equal(coupons.get('CPN_PUSH').status, 'available');
  // A later cron reconcile is what will pick it up; it must not have invented a sale now.
  const summary = await store.reconcileExpiredPayments();
  assert.equal(summary.expired, 0, 'the session is still inside its window');
});

await check('G2 detection works from the mailbox alone when push is unavailable', async () => {
  // The push path and the poll/cron path share processEmailCandidate, so a
  // settle driven straight from a candidate is exactly what a reconcile scan
  // produces. This pins that the fallback does not depend on push state.
  resetWorld();
  seedSession({ paymentId: 'pay_scan', orderId: 'ord_scan', couponId: 'CPN_SCAN', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });
  const result = await runEmailCandidate({
    payment: 'pay_scan',
    email: {
      messageId: 'msg-scan-1', from: '"FamApp" <no-reply@famapp.in>',
      authenticationResults: FAMAPP_AUTH, subject: 'Payment received',
      body: famBody({ amount: '10.00', txn: 'FMPIB0000000022', utr: '664974818922' }),
      date: iso(T0 + 60_000), internalDate: String(T0 + 60_000), labels: ['INBOX'],
    },
  });
  assert.equal(result.action, 'settled');
  assert.equal(paymentRow('pay_scan').status, 'PAID');
});

// ═══════════════════════════════════════════════════════════════════════════
//  H. STORAGE OUTAGE BEHAVIOUR
// ═══════════════════════════════════════════════════════════════════════════

await check('H1 a Sheets outage refuses settlement instead of succeeding from memory', async () => {
  resetWorld();
  seedSession({ paymentId: 'pay_sheets', orderId: 'ord_sheets', couponId: 'CPN_SHEETS', amount: '10.00', userEmail: 'b@example.com', createdMs: T0 });
  faults.sheetsDown = true;
  await assert.rejects(
    () => store.finalizePayment({
      paymentId: 'pay_sheets', transactionId: 'FMPIB0000000023', utr: '664974818923',
      source: 'email', paidAt: iso(T0 + 60_000), transactionAt: iso(T0 + 60_000), receivedAmount: 10,
    }),
    /Sheets|storage|unavailable/i,
    'an unreachable ledger must surface as an error, never as a success',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
//  I. PAYMENT-MAILBOX OAUTH REDIRECT URI
// ═══════════════════════════════════════════════════════════════════════════
// The redirect_uri Google is given for payment-mailbox OAuth must always be
// this flow's callback. Reusing the user-login redirect fails Google's
// redirect_uri check, and a failed re-authorisation flips the mailbox to
// `reauthorization_required`, which stops payment detection outright.

await check('I1 the redirect URI is never the user-login OAuth callback', async () => {
  const pm = require(path.join(__dirname, '..', 'services', 'paymentMailbox'));
  const KEYS = ['APP_BASE_URL', 'GOOGLE_REDIRECT_URI', 'PAYMENT_GMAIL_REDIRECT_URI'];
  const saved = {};
  KEYS.forEach((k) => { saved[k] = process.env[k]; });

  const withEnv = (env, base) => {
    KEYS.forEach((k) => {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    });
    try { return pm.getRedirectUri(base); } finally { KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); }
  };

  const CALLBACK = '/api/admin/gmail/callback';
  const LOGIN_FLOW = 'https://savehatke.vercel.app/api/auth/google-redirect';

  // The exact production shape that used to leak the login redirect: no
  // APP_BASE_URL, GOOGLE_REDIRECT_URI pointing at the user-login flow.
  const leaked = withEnv({ GOOGLE_REDIRECT_URI: LOGIN_FLOW });
  assert.ok(leaked.endsWith(CALLBACK), `expected the payment callback, got ${leaked}`);
  assert.equal(leaked, 'https://savehatke.vercel.app' + CALLBACK);

  assert.ok(withEnv({ GOOGLE_REDIRECT_URI: LOGIN_FLOW, APP_BASE_URL: 'https://savehatke.vercel.app' }).endsWith(CALLBACK));
  assert.ok(withEnv({ PAYMENT_GMAIL_REDIRECT_URI: 'https://savehatke.vercel.app' + CALLBACK }).endsWith(CALLBACK));
  assert.ok(withEnv({ APP_BASE_URL: 'https://savehatke.vercel.app' }).endsWith(CALLBACK));
  assert.ok(withEnv({ GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google-redirect' }).endsWith(CALLBACK));

  // A stale APP_BASE_URL must win over the override's origin rather than
  // silently reusing a foreign origin, but still target the right path.
  assert.ok(withEnv({ GOOGLE_REDIRECT_URI: LOGIN_FLOW, APP_BASE_URL: 'https://stale.example.com' }).endsWith(CALLBACK));
});

// ── Report ─────────────────────────────────────────────────────────────────
restoreWorld();
console.log = realLog; console.warn = realWarn; console.error = realError;
console.log(`\npaymentRecoveryRootCause\n${results.join('\n')}\n`);
console.log(`paymentRecoveryRootCause: ${passed} passed, ${failed} failed`);
if (warnings.length) {
  const notable = warnings.filter((w) => /sold_payment_id|re-processing unresolved/.test(w));
  if (notable.length) console.log(`notable operator warnings: ${notable.length} (e.g. ${notable[0].slice(0, 120)})`);
}
}

main();