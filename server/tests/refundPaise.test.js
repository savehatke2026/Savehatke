// Refund amount rules in integer paise. Pure logic: no database or Sheets.
const assert = require('assert');
const { computeRefund } = require('../services/refunds');

const cases = [
  // [label, required, received, expectedType, expectedRefund]
  ['underpayment: pays ₹80 of ₹100 -> full ₹80 refund', 100, 80, 'underpayment', 80],
  ['overpayment: pays ₹120 of ₹100 -> ₹20 excess refund', 100, 120, 'overpayment', 20],
  ['exact payment -> no refund', 100, 100, null, 0],
  ['pence overpayment: ₹100.20 of ₹100.10 -> ₹0.10', 100.10, 100.20, 'overpayment', 0.10],
  ['pence underpayment: ₹99.99 of ₹100 -> ₹99.99 refund', 100, 99.99, 'underpayment', 99.99],
  ['float drift: 0.1+0.2 vs 0.3 is exact, no refund', 0.3, 0.1 + 0.2, null, 0],
  // 1.005 is a sub-paise value; it rounds to 100 paise, so it is an exact match.
  ['sub-paise input: 1.005 rounds to 100 paise -> exact, no refund', 1.00, 1.005, null, 0],
  ['zero received -> full (zero) refund, underpayment', 100, 0, 'underpayment', 0],
];

let pass = 0;
for (const [label, required, received, type, refund] of cases) {
  const out = computeRefund({ required, received });
  assert.strictEqual(out.mismatchType, type, `${label}: type ${out.mismatchType}`);
  assert.strictEqual(Math.round(out.refundAmount * 100), Math.round(refund * 100), `${label}: refund ${out.refundAmount}`);
  // A refund is never negative and never exceeds what was received on underpayment.
  assert.ok(out.refundAmount >= 0, `${label}: negative refund`);
  if (type === 'underpayment') {
    assert.ok(out.refundAmount <= received + 1e-9, `${label}: refund exceeds received`);
  }
  console.log(`  ok  ${label}`);
  pass++;
}

console.log(`\nrefundPaise: ${pass} passed, 0 failed`);
process.exit(0);
