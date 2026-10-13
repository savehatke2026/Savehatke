// Admin Transactions / Orders derivation. Pure logic only: no Sheets, Supabase
// or network access. Run: node server/tests/adminLedger.test.js
const assert = require('node:assert/strict');
const path = require('node:path');

const ledger = require(path.join(__dirname, '..', 'services', 'adminLedger'));
const { paymentIssues, reservationStatus, deliveryStatus, soldToBuyer, csvCell, toCsv, auditPaymentId, buildPaymentHistory } = ledger._internals;

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

// ── Payment issue flags ──────────────────────────────────────────────────────
check('exact PAID payment has no issues', () => {
  assert.deepEqual(paymentIssues({ status: 'PAID', expected: 100, received: null, notes: '', lateCount: 0 }), []);
});
check('received amount different from expected is a MISMATCH', () => {
  assert.ok(paymentIssues({ status: 'REVIEW', expected: 100, received: 80, notes: '', lateCount: 0 }).includes('MISMATCH'));
});
check('REVIEW / EXPIRED / CANCELLED each flagged', () => {
  assert.ok(paymentIssues({ status: 'REVIEW', expected: 1, received: null, notes: '', lateCount: 0 }).includes('REVIEW'));
  assert.ok(paymentIssues({ status: 'EXPIRED', expected: 1, received: null, notes: '', lateCount: 0 }).includes('EXPIRED'));
  assert.ok(paymentIssues({ status: 'CANCELLED', expected: 1, received: null, notes: '', lateCount: 0 }).includes('CANCELLED'));
});
check('late credit notification is a LATE_PAYMENT', () => {
  assert.ok(paymentIssues({ status: 'EXPIRED', expected: 1, received: null, notes: '', lateCount: 1 }).includes('LATE_PAYMENT'));
});
check('verification error flagged only on a non-PAID payment', () => {
  const notes = 'Mailbox check failed: could not read message';
  assert.ok(paymentIssues({ status: 'PENDING', expected: 1, received: null, notes, lateCount: 0 }).includes('VERIFICATION_ERROR'));
  assert.ok(!paymentIssues({ status: 'PAID', expected: 1, received: null, notes, lateCount: 0 }).includes('VERIFICATION_ERROR'));
});

// ── Coupon reservation / delivery (kept separate from payment status) ──────
check('reservation: no coupon row → unknown', () => {
  assert.equal(reservationStatus(null, new Set(), 0), 'unknown');
});
check('reservation: pre-migration coupon (no reserved columns) → unknown, not "none"', () => {
  assert.equal(reservationStatus({ id: 'c1' }, new Set(), 0), 'unknown');
});
check('reservation: held by one of this order\'s payments and unexpired → active', () => {
  const coupon = { reserved_payment_id: 'P1', reserved_until: new Date(Date.now() + 60000).toISOString() };
  assert.equal(reservationStatus(coupon, new Set(['P1']), Date.now()), 'active');
});
check('reservation: lapsed reservation → expired', () => {
  const coupon = { reserved_payment_id: 'P1', reserved_until: new Date(Date.now() - 60000).toISOString() };
  assert.equal(reservationStatus(coupon, new Set(['P1']), Date.now()), 'expired');
});
check('reservation: held by a payment outside this order → held_by_other', () => {
  const coupon = { reserved_payment_id: 'PX', reserved_until: new Date(Date.now() + 60000).toISOString() };
  assert.equal(reservationStatus(coupon, new Set(['P1']), Date.now()), 'held_by_other');
});
check('delivery: PAID + coupon sold to buyer → delivered', () => {
  assert.equal(deliveryStatus('PAID', true), 'delivered');
});
check('delivery: PAID but not sold → undelivered (fulfilment gap is visible)', () => {
  assert.equal(deliveryStatus('PAID', false), 'undelivered');
});
check('delivery: REVIEW / CANCELLED / PENDING map to their own states', () => {
  assert.equal(deliveryStatus('REVIEW', false), 'held_for_review');
  assert.equal(deliveryStatus('CANCELLED', false), 'not_delivered');
  assert.equal(deliveryStatus('PENDING', false), 'awaiting_payment');
});
check('sold-to-buyer matches on sold_payment_id of one of the order\'s payments', () => {
  const coupon = { status: 'sold', sold_payment_id: 'P1' };
  assert.equal(soldToBuyer(coupon, { buyer_email: 'a@x.com' }, new Set(['P1'])), true);
});
check('sold-to-buyer matches on buyer email when no payment id is recorded', () => {
  const coupon = { status: 'sold', buyer_email: 'Buyer@X.com' };
  assert.equal(soldToBuyer(coupon, { buyer_email: 'buyer@x.com' }, new Set()), true);
});
check('a coupon sold to someone else is not counted as this order\'s delivery', () => {
  const coupon = { status: 'sold', sold_payment_id: 'OTHER', buyer_email: 'other@x.com' };
  assert.equal(soldToBuyer(coupon, { buyer_email: 'a@x.com' }, new Set(['P1'])), false);
});

// ── Audit linkage ──────────────────────────────────────────────────────────
check('audit payment id parsed from the recovery/retry detail string', () => {
  assert.equal(auditPaymentId({ detail: 'payment=PAY-123 reason=ok' }), 'PAY-123');
});
check('audit payment id falls back to recordId JSON', () => {
  assert.equal(auditPaymentId({ detail: '{"recordId":"PAY-9","x":1}' }), 'PAY-9');
});

// ── Verification history ───────────────────────────────────────────────────
check('history is chronological and includes the verification trail', () => {
  const p = {
    created_at: '2026-10-10T10:00:00Z',
    paid_at: '2026-10-10T10:05:00Z',
    updated_at: '2026-10-10T10:05:00Z',
    status: 'PAID',
    verification_source: 'email',
    verification_notes: 'Settled',
  };
  const h = buildPaymentHistory(p, {
    notifications: [{ occurredAt: '2026-10-10T10:04:00Z', status: 'MATCHED', source: 'email', amount: 100, utr: 'U1', notes: '' }],
    audits: [{ createdAt: '2026-10-10T10:06:00Z', event: 'payment_retry_verification', actor: 'admin@x', outcome: 'NO_MATCH', detail: '' }],
    refunds: [],
  });
  const times = h.map((e) => e.at);
  assert.deepEqual(times, [...times].sort((a, b) => Date.parse(a) - Date.parse(b)));
  assert.ok(h.some((e) => /Credit notification/.test(e.event)));
  assert.ok(h.some((e) => /Admin action/.test(e.event)));
});

// ── CSV ─────────────────────────────────────────────────────────────────────
check('CSV cell quotes embedded quotes and commas', () => {
  assert.equal(csvCell('a "b", c'), '"a ""b"", c"');
});
check('CSV formula injection is neutralised for =,+,-,@ and tab', () => {
  assert.equal(csvCell('=HYPERLINK("x")').startsWith('"\'='), true);
  assert.equal(csvCell('+1').startsWith('"\'+'), true);
  assert.equal(csvCell('-2').startsWith('"\'-'), true);
  assert.equal(csvCell('@sum').startsWith('"\'@'), true);
});
check('CSV output has a UTF-8 BOM, CRLF rows and a header row', () => {
  const csv = toCsv([{ label: 'A', value: (r) => r.a }], [{ a: 1 }, { a: 2 }]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.ok(csv.includes('\r\n'));
  assert.equal(csv.split('\r\n')[0].replace('\uFEFF', ''), '"A"');
});

console.log = console.log; // keep output
console.log(lines.join('\n'));
console.log(`\nadminLedger: ${passed} passed, ${failed} failed`);
