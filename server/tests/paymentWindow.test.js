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
const deadline = w.verificationDeadlineFor(expiry);
const at = (ms) => ({ paymentExpiresAt: expiry, verificationDeadline: deadline }, ms);

check('deadline is exactly 10 minutes after payment expiry', () => {
  assert.equal(Date.parse(deadline) - Date.parse(expiry), 10 * 60000);
});
check('customer phase before expiry (T+9m)', () => {
  assert.equal(w.phaseAt({ paymentExpiresAt: expiry, verificationDeadline: deadline }, T + 9 * 60000), 'customer');
});
check('verification phase starts exactly at expiry (T+10m)', () => {
  assert.equal(w.phaseAt({ paymentExpiresAt: expiry, verificationDeadline: deadline }, T + 10 * 60000), 'verification');
});
check('closed exactly at deadline (T+20m)', () => {
  assert.equal(w.phaseAt({ paymentExpiresAt: expiry, verificationDeadline: deadline }, T + 20 * 60000), 'closed');
});
check('missing timestamps fail closed (unknown)', () => {
  assert.equal(w.phaseAt({ paymentExpiresAt: '', verificationDeadline: '' }, T), 'unknown');
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
const dl = deadline;
check('transaction inside window → within', () => {
  assert.equal(w.classifyTransactionTime({ transactionAt: new Date(T + 15 * 60000).toISOString(), sessionStartedAt: start, verificationDeadline: dl }), 'within');
});
check('transaction after deadline → after (late, not arrival-based)', () => {
  assert.equal(w.classifyTransactionTime({ transactionAt: new Date(T + 25 * 60000).toISOString(), sessionStartedAt: start, verificationDeadline: dl }), 'after');
});
check('transaction exactly at deadline is still within', () => {
  assert.equal(w.classifyTransactionTime({ transactionAt: dl, sessionStartedAt: start, verificationDeadline: dl }), 'within');
});
check('transaction well before session start → before_start', () => {
  assert.equal(w.classifyTransactionTime({ transactionAt: new Date(T - 30 * 60000).toISOString(), sessionStartedAt: start, verificationDeadline: dl }), 'before_start');
});
check('unreadable transaction time → unknown (never refund or fulfil on a guess)', () => {
  assert.equal(w.classifyTransactionTime({ transactionAt: null, sessionStartedAt: start, verificationDeadline: dl }), 'unknown');
});
check('a late-arriving email for an in-window transaction stays within', () => {
  // Email arrived at T+40m, but the transaction itself happened at T+12m.
  assert.equal(w.classifyTransactionTime({ transactionAt: new Date(T + 12 * 60000).toISOString(), sessionStartedAt: start, verificationDeadline: dl }), 'within');
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
