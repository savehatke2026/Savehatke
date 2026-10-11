// Missing payout-method reminder: dedupe, sheet verification, recheck, provider
// failure and retry. Everything external is stubbed — no sheet, Supabase or SMTP.
// Run: node server/tests/payoutMethodReminder.test.js
const assert = require('node:assert/strict');
const path = require('node:path');
const base = path.join(__dirname, '..', 'services');

const db = require(path.join(base, 'googleSheets'));
const supabase = require(path.join(base, 'supabase'));
const emailService = require(path.join(base, 'emailService'));
const reminder = require(path.join(base, 'payoutMethodReminder'));

// ── Fake Supabase table with a unique primary key on seller_email ──
function fakeSupabase() {
  const rows = new Map();
  const builder = (table) => {
    const state = { op: null, values: null, filters: {} , selectCols: null};
    const api = {
      insert(values) { state.op = 'insert'; state.values = values; return api; },
      update(values) { state.op = 'update'; state.values = values; return api; },
      select() { if (!state.op) state.op = 'select'; return api; },
      eq(col, val) { state.filters[col] = val; return api; },
      maybeSingle() { return exec(); },
      then(res, rej) { return exec().then(res, rej); },
    };
    const exec = async () => {
      if (state.op === 'insert') {
        const key = state.values.seller_email;
        if (rows.has(key)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        rows.set(key, { ...state.values });
        return { data: { seller_email: key }, error: null };
      }
      if (state.op === 'select') {
        const r = rows.get(state.filters.seller_email);
        return { data: r ? { ...r } : null, error: null };
      }
      if (state.op === 'update') {
        const key = state.filters.seller_email;
        const r = rows.get(key);
        const ok = r && Object.entries(state.filters).every(([c, v]) => c === 'seller_email' || r[c] === v);
        if (!ok) return { data: null, error: null };
        Object.assign(r, state.values);
        return { data: { seller_email: key }, error: null };
      }
      return { data: null, error: null };
    };
    return api;
  };
  return { rows, client: { from: (table) => builder(table) } };
}

let sheetRows = [];
let sheetFails = false;
let sendResult = { success: true, messageId: 'msg-1' };
let sendCalls = [];
let fake;

function reset({ rows = [], fails = false, send = { success: true, messageId: 'msg-1' } } = {}) {
  sheetRows = rows;
  sheetFails = fails;
  sendResult = send;
  sendCalls = [];
  fake = fakeSupabase();
}

db.getRowsFresh = async () => {
  if (sheetFails) throw new Error('Google Sheets read failed');
  return sheetRows.map((r) => ({ ...r }));
};
db.SHEETS = { SELLER_PAYOUT_DETAILS: 'SellerPayoutDetails' };
supabase.getClient = () => fake.client;
supabase.isConfigured = () => true;
emailService.sendPayoutMethodReminderEmail = async (p) => {
  sendCalls.push(p);
  return sendResult;
};

const UPI_ROW = { sellerEmail: 'seller@example.com', method: 'UPI', upiId: 'seller@upi' };
const QR_ROW = { sellerEmail: 'seller@example.com', method: 'QR', qrFileId: 'drive-file-123' };
const EMPTY_UPI = { sellerEmail: 'seller@example.com', method: 'UPI', upiId: '' };
const SELLER = { sellerEmail: 'Seller@Example.com', sellerName: 'Seller' };

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('missing payout row -> email sent once and row marked sent', async () => {
  reset();
  const out = await reminder.maybeSendMissingPayoutMethodEmail(SELLER);
  assert.equal(out, 'sent');
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].to, 'seller@example.com');
  assert.equal(fake.rows.get('seller@example.com').status, 'sent');
});

test('saved UPI method -> no email, no claim row', async () => {
  reset({ rows: [UPI_ROW] });
  assert.equal(await reminder.maybeSendMissingPayoutMethodEmail(SELLER), 'skipped:payout-method-present');
  assert.equal(sendCalls.length, 0);
  assert.equal(fake.rows.size, 0);
});

test('saved QR method -> no email', async () => {
  reset({ rows: [QR_ROW] });
  assert.equal(await reminder.maybeSendMissingPayoutMethodEmail(SELLER), 'skipped:payout-method-present');
  assert.equal(sendCalls.length, 0);
});

test('incomplete details (UPI method, empty upiId) -> treated as missing', async () => {
  reset({ rows: [EMPTY_UPI] });
  assert.equal(await reminder.maybeSendMissingPayoutMethodEmail(SELLER), 'sent');
  assert.equal(sendCalls.length, 1);
});

test('sheet read error -> no email and no claim (never assume missing)', async () => {
  reset({ fails: true });
  assert.equal(await reminder.maybeSendMissingPayoutMethodEmail(SELLER), 'deferred:sheets-unavailable');
  assert.equal(sendCalls.length, 0);
  assert.equal(fake.rows.size, 0);
});

test('repeat trigger after success -> no second email', async () => {
  reset();
  await reminder.maybeSendMissingPayoutMethodEmail(SELLER);
  assert.equal(await reminder.maybeSendMissingPayoutMethodEmail(SELLER), 'skipped:already-notified');
  assert.equal(sendCalls.length, 1);
});

test('concurrent triggers -> exactly one email', async () => {
  reset();
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => reminder.maybeSendMissingPayoutMethodEmail(SELLER)));
  assert.equal(results.filter((r) => r === 'sent').length, 1);
  assert.equal(sendCalls.length, 1);
});

test('seller adds details before send -> send cancelled', async () => {
  reset();
  // First sheet read: missing. Second (recheck, after claim): saved.
  let reads = 0;
  db.getRowsFresh = async () => {
    reads += 1;
    return (reads === 1 ? [] : [UPI_ROW]).map((r) => ({ ...r }));
  };
  const out = await reminder.maybeSendMissingPayoutMethodEmail(SELLER);
  assert.equal(out, 'cancelled:payout-method-added');
  assert.equal(sendCalls.length, 0);
  db.getRowsFresh = async () => {
    if (sheetFails) throw new Error('Google Sheets read failed');
    return sheetRows.map((r) => ({ ...r }));
  };
});

test('provider failure -> row failed, then retry sends and marks sent', async () => {
  reset({ send: { success: false, error: 'SMTP timeout' } });
  assert.equal(await reminder.maybeSendMissingPayoutMethodEmail(SELLER), 'failed:provider');
  assert.equal(fake.rows.get('seller@example.com').status, 'failed');
  assert.equal(fake.rows.get('seller@example.com').last_error, 'SMTP timeout');

  sendResult = { success: true, messageId: 'msg-2' };
  assert.equal(await reminder.maybeSendMissingPayoutMethodEmail(SELLER), 'sent');
  assert.equal(sendCalls.length, 2);
  assert.equal(fake.rows.get('seller@example.com').status, 'sent');
  assert.equal(fake.rows.get('seller@example.com').attempts, 2);
});

test('previously delivered notification processed again -> not resent', async () => {
  reset();
  await reminder.maybeSendMissingPayoutMethodEmail(SELLER);
  await reminder.maybeSendMissingPayoutMethodEmail(SELLER);
  await reminder.maybeSendMissingPayoutMethodEmail(SELLER);
  assert.equal(sendCalls.length, 1);
});

test('retry budget exhausted -> stops after MAX attempts', async () => {
  reset({ send: { success: false, error: 'down' } });
  for (let i = 0; i < 10; i += 1) await reminder.maybeSendMissingPayoutMethodEmail(SELLER);
  assert.equal(sendCalls.length, 5);
  assert.equal(fake.rows.get('seller@example.com').attempts, 5);
});

test('no Supabase claim store -> no email sent (cannot guarantee dedupe)', async () => {
  reset();
  supabase.isConfigured = () => false;
  assert.equal(await reminder.maybeSendMissingPayoutMethodEmail(SELLER), 'skipped:no-claim-store');
  assert.equal(sendCalls.length, 0);
  supabase.isConfigured = () => true;
});

test('service passes only recipient and name to the mailer (no payout details)', async () => {
  reset({ rows: [] });
  await reminder.maybeSendMissingPayoutMethodEmail({ sellerEmail: 'seller@example.com', sellerName: 'Asha' });
  assert.deepEqual(Object.keys(sendCalls[0]).sort(), ['sellerName', 'to']);
});

(async () => {
  let failures = 0;
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log('  ok   ' + name);
    } catch (e) {
      failures += 1;
      console.error('  FAIL ' + name + '\n       ' + e.message);
    }
  }
  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  process.exit(failures ? 1 : 0);
})();
