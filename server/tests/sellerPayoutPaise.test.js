'use strict';
const assert = require('node:assert/strict');
const sp = require('../services/sellerPayout');

const cases = [
  [100, 7.00], [101, 7.07], [107, 7.49], [108, 7.56],
  [199, 13.93], [200, 14.00], [1000, 70.00], [10000, 700.00],
  ['100.50', 7.04], ['107.15', 7.50], ['9999.99', 700.00],
];
for (const [face, expected] of cases) {
  assert.equal(sp.calculateSellerPayout(face), expected, String(face));
}
assert.equal(sp.couponPayoutInfo({originalValue:'101',sellerPayout:7.07}).payoutVerified, true,
  'exact paise payout is valid');
assert.equal(sp.couponPayoutInfo({originalValue:'101',sellerPayout:7}).payoutVerified, false,
  'old whole-rupee payout is flagged for correction');
assert.equal(sp.couponPayoutInfo({originalValue:'101',sellerPayout:9}).payoutVerified, false,
  'tampered payout is invalid');
assert.equal(sp.moneyToPaise(sp.calculateSellerPayout('101.23')), 709,
  'calculated payout is stable at paise precision');
console.log('sellerPayoutPaise: 15 assertions passed');
