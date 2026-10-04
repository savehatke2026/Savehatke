/**
 * SaveHatke — fail-closed financial write verifier
 * ===============================================
 * Loads the real Sheets and payment-store modules with the Google Sheets
 * transport stubbed to fail, and proves the guarantees that keep a payment from
 * being settled against a ledger that is not there:
 *
 *   1. a STRICT append refuses to pretend the write landed;
 *   2. a NON-strict append still falls back to memory — the exact behaviour the
 *      fix removes from every money path, which shows the strict flag (and not
 *      the stub) is what changes the outcome;
 *   3. a STRICT update refuses;
 *   4. a STRICT read refuses to fall back to the in-memory mirror;
 *   5. non-strict reads still work, so non-financial callers are unaffected;
 *   6. paymentStore's settlement pre-flight throws instead of proceeding, so the
 *      Postgres coupon flip — the one write that cannot be rolled back — is
 *      never reached while the ledger is unreachable;
 *   7. the availability probe now reports the outage, where before it could not
 *      fail at all.
 *
 * Why it matters: before this, a Sheets outage made every one of those writes
 * "succeed" into a single instance's memory. The coupon still flipped to sold in
 * Postgres, the buyer was emailed a receipt, and the PAID row vanished on the
 * next deploy.
 *
 * Usage:  node verify-fail-closed.cjs
 *         npm run verify:fail-closed
 */

'use strict';

const path = require('path');
const Module = require('module');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── Stub the Sheets transport before anything requires googleapis ───────────
const OUTAGE = () => { throw new Error('SIMULATED_SHEETS_OUTAGE'); };
// Header reads (…!1:1) keep working — a real outage usually leaves the metadata
// and header rows readable while data ranges fail. That keeps the client built
// ("booted fine, then the spreadsheet went away"), which is the scenario that
// used to let a PAID write succeed in memory only.
const failingValues = {
  get: async ({ range }) => {
    if (/!1:1$/.test(String(range || ''))) return { data: { values: [['id', 'status', 'updated_at']] } };
    return OUTAGE();
  },
  append: OUTAGE,
  update: OUTAGE,
  batchUpdate: OUTAGE,
};
const fakeGoogle = {
  auth: { JWT: function JWT() { return {}; } },
  sheets: () => ({
    spreadsheets: {
      get: async () => ({ data: { sheets: [], spreadsheetId: 'test-spreadsheet-id' } }),
      values: failingValues,
      batchUpdate: OUTAGE,
    },
  }),
};

const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'googleapis') return fakeGoogle;
  return origLoad.apply(this, arguments);
};

// Credentials must look complete, or initialize() short-circuits before ever
// touching the transport and the test would prove nothing.
process.env.GOOGLE_SHEETS_SPREADSHEET_ID = 'test-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test@test.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----\\n';
require('dotenv').config({ path: path.join(__dirname, '.env') });
process.env.GOOGLE_SHEETS_SPREADSHEET_ID = 'test-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test@test.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----\\n';

async function main() {
  console.log('Fail-closed financial write verification\n');

  const db = require('./server/services/googleSheets');
  const connected = await db.initialize();
  // Whether the stubbed client survives initialize() depends on internals of
  // ensureSheets and is not what this test is about: every strict call below
  // fails the transport either way, which is the condition under test.
  console.log(`  INFO  sheets client connected after init: ${db.isSheetsConnected()} (initialize -> ${connected})`);

  // 1. Strict append must throw rather than silently mirror the row in memory.
  let strictAppendThrew = false;
  try {
    await db.appendRow(db.SHEETS.ORDERS, { id: 'test-order-1', status: 'PENDING' }, { strict: true });
  } catch (e) { strictAppendThrew = true; }
  check('strict appendRow throws when the spreadsheet is unreachable', strictAppendThrew);

  // 2. The same call without `strict` still swallows — the old behaviour.
  let nonStrictSwallowed = false;
  try {
    await db.appendRow(db.SHEETS.ORDERS, { id: 'test-order-2', status: 'PENDING' });
    nonStrictSwallowed = true;
  } catch (e) { nonStrictSwallowed = false; }
  check('non-strict appendRow still falls back to memory (non-financial callers unaffected)',
    nonStrictSwallowed);

  // A strict append must NOT have left the row in the memory mirror either.
  const rowsAfterStrict = await db.getRows(db.SHEETS.ORDERS);
  check('the refused strict append did not appear in the in-memory mirror',
    !rowsAfterStrict.some((r) => String(r.id) === 'test-order-1'));

  // 3. Strict update must throw.
  let strictUpdateThrew = false;
  try {
    await db.updateRow(db.SHEETS.PAYMENTS, 'payment_id', 'pay_x', { status: 'PAID' }, { strict: true });
  } catch (e) { strictUpdateThrew = true; }
  check('strict updateRow throws when the spreadsheet is unreachable', strictUpdateThrew);

  // 4. Strict read must throw instead of returning the memory mirror.
  let strictReadThrew = false;
  try {
    await db.getRowsFresh(db.SHEETS.PAYMENTS, { strict: true });
  } catch (e) { strictReadThrew = true; }
  check('strict getRowsFresh throws instead of falling back to memory', strictReadThrew);

  // 5. Non-strict read still returns, so the rest of the app keeps working.
  let nonStrictReadOk = false;
  try {
    await db.getRows(db.SHEETS.COUPONS);
    nonStrictReadOk = true;
  } catch (e) { nonStrictReadOk = false; }
  check('non-strict getRows still returns for non-financial callers', nonStrictReadOk);

  // 6. paymentStore settlement pre-flight must refuse. This is the guarantee
  //    that matters: the coupon flip is irreversible, so nothing may reach it
  //    while the ledger is unreachable.
  const store = require('./server/services/paymentStore');
  let preflightThrew = false;
  try {
    await store.finalizePayment({ paymentId: 'pay_does_not_exist' });
  } catch (e) { preflightThrew = true; }
  check('finalizePayment refuses before touching the coupon when the ledger is down',
    preflightThrew);

  // 7. And the availability probe now reports the outage instead of always
  //    claiming success (it could not fail before this fix).
  const ready = await store.ensureReady({ force: true });
  check('ensureReady now reports the outage (previously could never fail)',
    ready && ready.ok === false, `ok=${ready && ready.ok}`);

  console.log(`\nPASSED: ${pass}   FAILED: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e && e.stack || e); process.exit(2); });
