'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const paymentRoute = read('routes/payment.js');
const paymentStore = read('services/paymentStore.js');
const paymentDb = read('services/paymentLedgerDb.js');
const financeRoute = read('routes/personalFinance.js');
const payoutRoute = read('routes/payouts.js');
const payoutReservationMigration = read('../supabase/migrations/20261106_seller_payout_reservations.sql');
const sellerPayout = read('services/sellerPayout.js');

assert.match(paymentRoute, /paymentData:\s*\{/);
assert.match(paymentStore, /db\.createCheckout\(row, paymentRow\)/);
assert.match(paymentDb, /rpc\('savehatke_create_checkout'/);
assert.doesNotMatch(paymentRoute, /store\.createPayment\(/);

assert.match(financeRoute, /savehatke_personal_finance_import/);
assert.match(financeRoute, /savehatke_personal_finance_apply/);
assert.doesNotMatch(financeRoute, /writeBalance\(/);
assert.doesNotMatch(financeRoute, /db\.appendRow\(LEDGER_SHEET/);

assert.match(payoutRoute, /recalculate-legacy/);
assert.match(payoutRoute, /status.*pending/);
assert.match(payoutRoute, /status.*paid.*processing/);
assert.match(payoutRoute, /sellerPayout\.moneyToPaise/);
assert.match(payoutRoute, /recalculate-legacy/);
assert.match(sellerPayout, /paise \* 7 \+ 50/);
assert.match(payoutReservationMigration, /pg_advisory_xact_lock/);
assert.match(payoutReservationMigration, /claim_seller_payout_reservation/);
assert.match(payoutReservationMigration, /finish_seller_payout_reservation/);
console.log('atomicMoneyWiring: 17 assertions passed');
