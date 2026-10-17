// Seller payout-details save: first save, unchanged resave, update, concurrent
// double-submit, and failed write preserving the previous record. Sheets, email
// and auth are stubbed; the real route handler is driven through a tiny express app.
// Run: node server/tests/payoutDetailsSave.test.js
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const base = path.join(__dirname, '..', 'services');

const db = require(path.join(base, 'googleSheets'));
const emailService = require(path.join(base, 'emailService'));
const authMod = require(path.join(__dirname, '..', 'middleware', 'auth'));

// Auth stub: every request is the seller identified by a header.
authMod.authenticateToken = (req, res, next) => {
  req.user = { email: String(req.headers['x-test-email'] || ''), id: 'user-1', name: 'Asha' };
  if (!req.user.email) return res.status(401).json({ error: 'no session' });
  next();
};
authMod.requireAdmin = (req, res, next) => next();

let store = [];
let failNextWrite = false;
let emailCalls = [];

db.SHEETS = { ...db.SHEETS, SELLER_PAYOUT_DETAILS: 'SellerPayoutDetails' };
db.getRows = async () => store.map((r) => ({ ...r }));
db.getRowsFresh = async () => store.map((r) => ({ ...r }));
db.appendRow = async (_sheet, row) => {
  await new Promise((r) => setTimeout(r, 5));
  if (failNextWrite) { failNextWrite = false; throw new Error('sheets write failed'); }
  store.push({ ...row });
};
db.updateRow = async (_sheet, field, value, data) => {
  await new Promise((r) => setTimeout(r, 5));
  if (failNextWrite) { failNextWrite = false; throw new Error('sheets write failed'); }
  const i = store.findIndex((r) => String(r[field]).toLowerCase() === String(value).toLowerCase());
  if (i < 0) return false;
  store[i] = { ...store[i], ...data };
  return true;
};
emailService.sendPaymentMethodEmail = async (kind, p) => {
  emailCalls.push({ kind, to: p.to });
  return { success: true, messageId: 'm' };
};

const router = require(path.join(__dirname, '..', 'routes', 'payouts.js'));
const express = require('express');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', router);

let server;
let port;
function request(method, url, email, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json', 'x-test-email': email || '' };
    if (data) headers['content-length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function reset() {
  store = [];
  failNextWrite = false;
  emailCalls = [];
}

async function run() {
  server = app.listen(0);
  port = server.address().port;
  const SELLER = 'seller@example.com';
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failures += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
  };

  await check('first save creates one row and sends "added" email', async () => {
    reset();
    const r = await request('PUT', '/api/payouts/details', SELLER, { method: 'upi', upiId: 'asha@upi' });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, true);
    assert.equal(store.length, 1);
    assert.equal(emailCalls.length, 1);
    assert.equal(emailCalls[0].kind, 'added');
    assert.equal(r.body.details.upiId.includes('asha@upi'), false, 'legacy UPI field must remain masked');
    assert.equal(r.body.details.upiIdFull, 'asha@upi', 'authenticated owner must receive their full UPI ID for display/edit');
  });

  await check('unchanged resave is a no-op: no duplicate row, no email', async () => {
    reset();
    await request('PUT', '/api/payouts/details', SELLER, { method: 'upi', upiId: 'asha@upi' });
    emailCalls = [];
    const r = await request('PUT', '/api/payouts/details', SELLER, { method: 'upi', upiId: 'asha@upi' });
    assert.equal(r.status, 200);
    assert.equal(store.length, 1);
    assert.equal(emailCalls.length, 0);
  });

  await check('changed UPI updates the existing row and sends "updated" email', async () => {
    reset();
    await request('PUT', '/api/payouts/details', SELLER, { method: 'upi', upiId: 'asha@upi' });
    emailCalls = [];
    const r = await request('PUT', '/api/payouts/details', SELLER, { method: 'upi', upiId: 'new@upi' });
    assert.equal(r.status, 200);
    assert.equal(store.length, 1, 'must update, not append');
    assert.equal(store[0].upiId, 'new@upi');
    assert.equal(emailCalls.length, 1);
    assert.equal(emailCalls[0].kind, 'updated');
  });

  await check('concurrent first saves produce exactly one row', async () => {
    reset();
    const results = await Promise.all([1, 2, 3].map(() =>
      request('PUT', '/api/payouts/details', SELLER, { method: 'upi', upiId: 'asha@upi' })));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(store.length, 1, `expected 1 row, got ${store.length}`);
  });

  await check('failed write returns error, keeps previous record, sends no success email', async () => {
    reset();
    await request('PUT', '/api/payouts/details', SELLER, { method: 'upi', upiId: 'asha@upi' });
    emailCalls = [];
    failNextWrite = true;
    const r = await request('PUT', '/api/payouts/details', SELLER, { method: 'upi', upiId: 'broken@upi' });
    assert.equal(r.status, 500);
    assert.equal(store[0].upiId, 'asha@upi', 'previous value must be preserved');
    assert.equal(emailCalls.length, 0);
  });

  await check('validation failure writes nothing and sends nothing', async () => {
    reset();
    const r = await request('PUT', '/api/payouts/details', SELLER, { method: 'upi', upiId: '' });
    assert.equal(r.status, 400);
    assert.equal(store.length, 0);
    assert.equal(emailCalls.length, 0);
  });

  await check('GET never returns another seller\'s row (identity from session only)', async () => {
    reset();
    await request('PUT', '/api/payouts/details', 'other@example.com', { method: 'upi', upiId: 'other@upi' });
    const r = await request('GET', '/api/payouts/details', SELLER);
    assert.equal(r.status, 200);
    assert.equal(r.body.details, null);
    assert.equal(r.body.complete, false);
  });

  server.close();
  console.log(failures ? `\n${failures} failed` : '\nAll payout-details save tests passed');
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
