#!/usr/bin/env node
/* ============================================================================
 * SaveHatke — live HTTP check of the UPI config surface
 * ============================================================================
 *   node verify-upi-http.cjs
 *
 * Boots the REAL /api/payment router against the REAL Google Sheets
 * connection and the REAL environment, then reads GET /api/payment/config.
 *
 * This closes the one gap the offline suite leaves open: `configured:true`
 * requires BOTH a valid UPI_ID (environment) AND a live spreadsheet
 * connection (store.isConfigured()). Each half is proven elsewhere; this
 * proves they hold together in a single real request.
 *
 * READ-ONLY. It never calls /create, so no order, payment or coupon row is
 * written. It only reports whether the flow would be live.
 * ==========================================================================*/

'use strict';

const path = require('path');
const express = require('express');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const db = require('./server/services/googleSheets');
const upi = require('./server/services/upi');
const store = require('./server/services/paymentStore');
const verifier = require('./server/services/paymentVerifier');

let pass = 0, fail = 0, advisory = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name + (detail ? ' — ' + detail : '')); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? ' — ' + detail : '')); }
};

/**
 * Something worth knowing that is NOT a defect in this codebase.
 *
 * The VPA advisory is the case that matters: the UPI ID is supplied by the
 * operator and is outside the repo's control, so a format observation about it
 * must be reported loudly without being counted as a failure of the payment
 * implementation. It is printed with the same prominence as a failure so it
 * cannot be missed.
 */
const advise = (name, detail = '') => {
  advisory++;
  console.log('  \x1b[33mADVISORY\x1b[0m ' + name + (detail ? ' — ' + detail : ''));
};

(async () => {
  console.log('\n\x1b[1mLive HTTP check — /api/payment/config against real infrastructure\x1b[0m');

  // ── Environment ─────────────────────────────────────────────────────────
  console.log('\n\x1b[1mEnvironment\x1b[0m');
  const payee = upi.getPayee();
  check('UPI_ID is set and well-formed', payee.configured, payee.upiId || '(empty)');
  if (payee.warning) {
    advise('UPI_ID format observation — ' + payee.warning.code, payee.warning.error);
  } else {
    check('UPI_ID has no format observation', true, 'clean');
  }
  check('UPI_PAYEE_NAME is set', !!payee.payeeName, payee.payeeName);
  check('PAYMENT_MAX_AMOUNT is set', Number(process.env.PAYMENT_MAX_AMOUNT) > 0, String(process.env.PAYMENT_MAX_AMOUNT));
  check('PAYMENT_WEBHOOK_SECRET is set', verifier.getWebhookSecret().length > 0,
    verifier.getWebhookSecret().length + ' chars');
  check('GOOGLE_SHEETS_SPREADSHEET_ID is set', !!process.env.GOOGLE_SHEETS_SPREADSHEET_ID);

  // ── Real spreadsheet connection ─────────────────────────────────────────
  console.log('\n\x1b[1mGoogle Sheets connection (real)\x1b[0m');
  const t0 = Date.now();
  const ok = await db.initialize();
  check('connected to the real spreadsheet', ok === true, (Date.now() - t0) + 'ms');
  check('store reports configured', store.isConfigured() === true);

  // ── The actual HTTP surface ─────────────────────────────────────────────
  console.log('\n\x1b[1mGET /api/payment/config (real request)\x1b[0m');
  const app = express();
  app.use(express.json());
  app.use('/api/payment', require('./server/routes/payment'));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    const res = await fetch(base + '/api/payment/config');
    const body = await res.json();

    check('responds 200', res.status === 200, String(res.status));
    check('configured === true (the checkout will use UPI, not Razorpay)', body.configured === true, JSON.stringify(body.configured));
    check('upiConfigured === true', body.upiConfigured === true);
    check('reports the configured payee name', body.payeeName === payee.payeeName, body.payeeName);
    check('reports the configured VPA', body.upiId === payee.upiId, body.upiId);
    check('reports a 10-minute window', body.windowMinutes === 10, String(body.windowMinutes));
    check('reports platform upi / currency INR', body.platform === 'upi' && body.currency === 'INR');
    check('never returns the webhook secret',
      !JSON.stringify(body).includes(verifier.getWebhookSecret()));

    // The config endpoint must always carry the advisory field, so an operator
    // can see a VPA that is structurally valid but will not resolve at the PSP
    // — the failure that otherwise only shows up as a buyer's "Couldn't verify
    // UPI ID". Asserting the *contract* rather than a specific warning keeps
    // this honest after the VPA is corrected.
    check('config carries the advisory upiIdWarning field (null when clean)',
      body.upiIdWarning === null || typeof body.upiIdWarning?.code === 'string',
      JSON.stringify(body.upiIdWarning));
    if (body.upiIdWarning) {
      console.log(`\n  ⚠  VPA advisory: [${body.upiIdWarning.code}] ${body.upiIdWarning.message}\n`);
    }

    // The URI the checkout would hand to a UPI app, built from live config.
    const uri = upi.buildUpiUri({ amount: 299 });
    console.log('\n  Payee sees: ' + uri);
    check('₹299 URI carries the configured VPA', uri.includes(encodeURIComponent(payee.upiId)));
    check('₹299 URI carries am=299.00', /[?&]am=299\.00(&|$)/.test(uri));
    check('₹299 URI carries cu=INR', /[?&]cu=INR/.test(uri));
  } finally {
    server.close();
  }

  console.log('\n' + '─'.repeat(64));
  console.log(pass + ' passed, ' + fail + ' failed' + (advisory ? ', ' + advisory + ' advisory' : ''));
  if (advisory) {
    console.log('\nAdvisories are observations about operator-supplied configuration, not');
    console.log('defects in this codebase. They do not fail the run — but read them.');
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n\x1b[31mFATAL\x1b[0m ' + e.message);
  process.exit(1);
});
