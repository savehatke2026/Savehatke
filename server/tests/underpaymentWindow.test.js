// Underpayment window figures: short = required - received, refund = received.
// Uses the same computeRefund() rule that writes the refund row.
const assert = require('assert');
const refunds = require('../services/refunds');

const cases = [
  { name: 'example from design: ₹15 required, ₹10 paid', required: 15, received: 10, short: 5, refund: 10 },
  { name: 'underpay by paise: ₹100 required, ₹99.99 paid', required: 100, received: 99.99, short: 0.01, refund: 99.99 },
  { name: 'exact payment is not an underpayment', required: 100, received: 100, type: null },
  { name: 'overpayment is not an underpayment', required: 100, received: 120, type: 'overpayment' },
];

for (const c of cases) {
  const r = refunds.computeRefund({ required: c.required, received: c.received });
  if (c.type !== undefined) {
    assert.strictEqual(r.mismatchType, c.type, c.name);
  } else {
    assert.strictEqual(r.mismatchType, 'underpayment', c.name);
    assert.strictEqual(Number(r.delta.toFixed(2)), c.short, c.name + ' short');
    assert.strictEqual(Number(r.refundAmount.toFixed(2)), c.refund, c.name + ' refund');
  }
  console.log('PASS  ' + c.name);
}
console.log('\nUnderpayment window figure checks passed.');
