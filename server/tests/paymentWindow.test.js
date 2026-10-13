// Timer boundaries, IST parsing, and transaction-time classification.
// Run: node server/tests/paymentWindow.test.js
const assert = require('node:assert/strict');
const path = require('node:path');
const w = require(path.join(__dirname, '..', 'services', 'paymentWindow.js'));

let failures = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name); }
  catch (e) { failures += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const T = Date.parse('2026-10-10T03:00:00.000Z');
const expiry = new Date(T + 10 * 60000).toISOString();

check('payment_expires_at is exactly 10 minutes after creation', () => {
  assert.equal(Date.parse(expiry) - T, 10 * 60000);
  assert.equal(w.CUSTOMER_WINDOW_MS, 10 * 60000);
});
check('phase is open before expiry (T+9m)', () => {
  assert.equal(w.phaseAt({ paymentExpiresAt: expiry }, T + 9 * 60000), 'open');
});
check('phase is expired exactly at expiry (T+10m, no grace)', () => {
  assert.equal(w.phaseAt({ paymentExpiresAt: expiry }, T + 10 * 60000), 'expired');
});
check('missing expiry fails closed (unknown)', () => {
  assert.equal(w.phaseAt({ paymentExpiresAt: '' }, T), 'unknown');
});
check('IST 08:41 AM 10 Oct 2026 → 03:11 UTC', () => {
  assert.equal(
    w.parseFamAppTransactionTime('received ₹1.0 from A at 08:41 AM IST, 10 October 2026 with transaction id X'),
    '2026-10-10T03:11:00.000Z'
  );
});
check('12:05 AM IST is 00:05 of that day (previous UTC day)', () => {
  assert.equal(w.parseFamAppTransactionTime('12:05 AM IST, 1 January 2026'), '2025-12-31T18:35:00.000Z');
});
check('12:05 PM IST is 12:05 of that day', () => {
  assert.equal(w.parseFamAppTransactionTime('12:05 PM IST, 1 January 2026'), '2026-01-01T06:35:00.000Z');
});
check('impossible date (31 February) is rejected', () => {
  assert.equal(w.parseFamAppTransactionTime('10:00 AM IST, 31 February 2026'), null);
});
check('text without a transaction time returns null (never guessed)', () => {
  assert.equal(w.parseFamAppTransactionTime('no time here'), null);
});

const start = new Date(T).toISOString();
check('verified before expiry, transaction in window → settle', () => {
  assert.equal(w.decideIncomingCredit({ transactionAt: new Date(T + 5 * 60000).toISOString(), sessionStatus: 'PENDING', sessionCreatedAt: start, paymentExpiresAt: expiry, payerNameMatches: true, verifiedAtMs: T + 6 * 60000 }).action, 'settle');
});
check('transaction before expiry, first verified after expiry → settle (transaction time decides)', () => {
  assert.equal(w.decideIncomingCredit({ transactionAt: new Date(T + 9 * 60000).toISOString(), sessionStatus: 'PENDING', sessionCreatedAt: start, paymentExpiresAt: expiry, payerNameMatches: true, verifiedAtMs: T + 15 * 60000 }).action, 'settle');
});
check('transaction after expiry → expired_no_action (no unlock, no refund)', () => {
  assert.equal(w.decideIncomingCredit({ transactionAt: new Date(T + 11 * 60000).toISOString(), sessionStatus: 'PENDING', sessionCreatedAt: start, paymentExpiresAt: expiry, payerNameMatches: true, verifiedAtMs: T + 11 * 60000 }).action, 'expired_no_action');
});
check('unreadable transaction time → review', () => {
  assert.equal(w.decideIncomingCredit({ transactionAt: null, sessionStatus: 'PENDING', sessionCreatedAt: start, paymentExpiresAt: expiry, payerNameMatches: true, verifiedAtMs: T + 6 * 60000 }).action, 'review');
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
