'use strict';
const assert = require('node:assert/strict');
const sp = require('../services/sellerPayout');
const cases = [[100,7],[101,7],[107,7],[108,8],[199,14],[200,14],[1000,70],[10000,700],['100.50',7],['107.14',8]];
for (const [face, expected] of cases) assert.equal(sp.calculateSellerPayout(face), expected, String(face));
assert.equal(sp.couponPayoutInfo({originalValue:'101',sellerPayout:7.07}).payoutVerified, true, 'legacy paise amount remains valid');
assert.equal(sp.couponPayoutInfo({originalValue:'101',sellerPayout:7}).payoutVerified, true, 'new whole-rupee amount is valid');
assert.equal(sp.couponPayoutInfo({originalValue:'101',sellerPayout:9}).payoutVerified, false, 'tampered amount is invalid');
console.log('sellerPayoutWholeRupees: 13 passed');
