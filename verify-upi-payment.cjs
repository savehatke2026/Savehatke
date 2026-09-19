#!/usr/bin/env node
/* ============================================================================
 * SaveHatke — custom UPI checkout verification suite
 * ============================================================================
 * Re-runnable guard for the "Pay ₹X Securely" → /api/payment/* flow.
 *
 *   node verify-upi-payment.cjs
 *
 * WHAT IS REAL (the code under test)
 *   server/services/upi.js              UPI URI + real QR encoding
 *   server/services/paymentStore.js     every order/payment transition, the
 *                                       process lock, and the settlement
 *   server/services/paymentVerifier.js  the only component that may settle
 *   server/routes/payment.js            the HTTP surface
 *
 * WHAT IS EMULATED (and why)
 *   Google Sheets  an in-memory spreadsheet implementing exactly the API the
 *                  store uses (appendRow / updateRow / getRows / getRowsFresh
 *                  / findRowsFresh / isSheetsConnected). Cells are stored as
 *                  STRINGS, like a real sheet, so code that forgets to
 *                  normalise a numeric or date value fails here rather than
 *                  in production.
 *   Supabase       only the `coupons` table is needed now (payment records
 *                  moved to Sheets). The emulation supports the conditional
 *                  UPDATE the unlock depends on, so the
 *                  "unlock exactly once" guarantee is genuinely exercised.
 *   auth / gmail   thin stubs so the suite needs no session or mailbox.
 *
 * QR DECODING
 *   Encoded by `qrcode`, decoded back by `jsqr` — so the assertion is about
 *   what a phone camera would actually read, not about what we wrote.
 *   jsqr lives in the isolated runtime workspace:
 *     NODE_PATH=<managed-node-workspace>/node_modules node verify-upi-payment.cjs
 *   Without it the decode assertions are skipped (and reported as skipped).
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { PNG } = require('pngjs');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── Test harness ───────────────────────────────────────────────────────────
let pass = 0, fail = 0, skipped = 0;
const failures = [];
let section = '';

function head(title) {
  section = title;
  console.log('\n\x1b[1m' + title + '\x1b[0m');
}
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else {
    fail++; failures.push(section + ' :: ' + name + (detail ? ' — ' + detail : ''));
    console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? ' — ' + detail : ''));
  }
}
function skip(name, why) {
  skipped++;
  console.log('  \x1b[33mSKIP\x1b[0m ' + name + ' — ' + why);
}

const MIN = 60 * 1000;
const nowIso = () => new Date().toISOString();
const uuid = () => 'id-' + Math.random().toString(16).slice(2, 12);
const toTime = (v) => { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : 0; };

// ══════════════════════════════════════════════════════════════════════════
// In-memory Google Sheets
// ══════════════════════════════════════════════════════════════════════════
// A real sheet stores every cell as a string, so writes are stringified here.
// That is deliberate: it is what catches a store that treats a price as a
// number when the sheet hands back "37.00".

const SHEETS = {
  ORDERS: 'Orders',
  PAYMENTS: 'Payments',
  PAYMENT_NOTIFICATIONS: 'PaymentNotifications',
  COUPONS: 'Coupons',
};

function createSheets() {
  const state = {
    connected: true,
    tables: {
      [SHEETS.ORDERS]: [],
      [SHEETS.PAYMENTS]: [],
      [SHEETS.PAYMENT_NOTIFICATIONS]: [],
      [SHEETS.COUPONS]: [],
    },
  };

  const cell = (v) => (v === undefined || v === null ? '' : String(v));

  function stringify(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = cell(v);
    return out;
  }

  function table(sheet) {
    if (!state.tables[sheet]) state.tables[sheet] = [];
    return state.tables[sheet];
  }

  function assertConnected() {
    if (!state.connected) throw new Error('Google Sheets is not connected');
  }

  return {
    state,
    SHEETS,
    isSheetsConnected: () => state.connected,
    initialize: async () => state.connected,
    getStorageStatus: () => ({ connected: state.connected, mode: 'google-sheets' }),
    getWriteAvailabilityError: () => (state.connected ? null : 'Sheets not connected'),

    async getRows(sheet) { assertConnected(); return table(sheet).map((r) => ({ ...r })); },
    async getRowsFresh(sheet) { assertConnected(); return table(sheet).map((r) => ({ ...r })); },

    async appendRow(sheet, data) {
      assertConnected();
      const row = stringify(data);
      table(sheet).push(row);
      return row;
    },

    /** Mirrors googleSheets.updateRow: match, merge, return the merged row. */
    async updateRow(sheet, field, value, updatedData) {
      assertConnected();
      const rows = table(sheet);
      const idx = rows.findIndex((r) => String(r[field]) === String(value));
      if (idx === -1) return null;
      const merged = { ...rows[idx], ...stringify(updatedData) };
      rows[idx] = merged;
      return { ...merged };
    },

    async findRow(sheet, field, value) {
      assertConnected();
      return table(sheet).find((r) => String(r[field]) === String(value)) || null;
    },

    async findRowsFresh(sheet, field, value) {
      assertConnected();
      return table(sheet).filter((r) => String(r[field]) === String(value)).map((r) => ({ ...r }));
    },

    async countRows(sheet) { assertConnected(); return table(sheet).length; },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// In-memory Supabase — only the `coupons` table matters now
// ══════════════════════════════════════════════════════════════════════════

function createCouponDb() {
  const tables = { coupons: [] };

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.mode = 'select';
      this.payload = null;
      this._single = null;
      this._selectCols = null;
    }
    select(cols) { if (cols) this._selectCols = cols; return this; }
    update(p) { this.mode = 'update'; this.payload = p; return this; }
    insert(p) { this.mode = 'insert'; this.payload = p; return this; }
    eq(c, v) { this.filters.push((r) => String(r[c]) === String(v)); return this; }
    maybeSingle() { this._single = 'maybe'; return this; }
    single() { this._single = 'exact'; return this; }
    limit() { return this; }
    order() { return this; }

    _project(row) {
      if (!this._selectCols || this._selectCols === '*') return { ...row };
      const out = {};
      for (const c of this._selectCols.split(',').map((s) => s.trim())) out[c] = row[c];
      return out;
    }

    async _run() {
      const t = tables[this.table];
      if (!t) return { data: null, error: { code: 'PGRST205', message: 'missing table' } };
      let rows;
      if (this.mode === 'update') {
        rows = [];
        for (const row of t) {
          if (this.filters.every((f) => f(row))) { Object.assign(row, this.payload); rows.push(row); }
        }
      } else if (this.mode === 'insert') {
        const row = { ...this.payload };
        if (row.id === undefined) row.id = uuid();
        t.push(row);
        rows = [row];
      } else {
        rows = t.filter((row) => this.filters.every((f) => f(row)));
      }
      const projected = rows.map((r) => this._project(r));
      if (this._single === 'maybe') return { data: projected[0] ?? null, error: null };
      if (this._single === 'exact') {
        if (!projected.length) return { data: null, error: { code: 'PGRST116', message: 'No rows found' } };
        return { data: projected[0], error: null };
      }
      return { data: projected, error: null };
    }

    then(resolve, reject) { return this._run().then(resolve, reject); }
  }

  return { tables, from: (t) => new Query(t) };
}

// ══════════════════════════════════════════════════════════════════════════
// Module stubs, installed before anything requires them
// ══════════════════════════════════════════════════════════════════════════

const sheets = createSheets();
const couponDb = createCouponDb();

/**
 * Mirrors fromSupabaseCoupon() in server/services/supabase.js — the payment
 * flow reads camelCase fields (sellingPrice, expiryDate, sellerEmail), so the
 * stub must map the row exactly as the real service does.
 */
function mapCoupon(r) {
  if (!r) return null;
  return {
    id: r.id,
    code: r.code,
    title: r.title || '',
    brand: r.brand || '',
    discount: r.discount || '',
    sellingPrice: r.selling_price || '15',
    expiryDate: r.expiry_date || '',
    sellerEmail: r.seller_email || '',
    sellerUserId: r.seller_user_id || '',
    status: r.status || 'available',
    soldAt: r.sold_at || '',
    buyerEmail: r.buyer_email || '',
  };
}

const stubSupabase = {
  isConfigured: () => true,
  getClient: () => ({ from: (t) => couponDb.from(t) }),
  findCouponById: async (id) => mapCoupon(couponDb.tables.coupons.find((c) => String(c.id) === String(id))),
};

const stubGmail = { getAuthorizedClient: async () => null, listMessages: async () => ({ messages: [] }), getMessageFull: async () => null };

const USERS = {
  'Bearer tok-user-1': { userId: 'user-1', email: 'buyer1@example.com' },
  'Bearer tok-user-2': { userId: 'user-2', email: 'buyer2@example.com' },
};
const stubAuth = {
  authenticateToken: (req, res, next) => {
    const u = USERS[req.headers.authorization];
    if (!u) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' });
    req.user = u;
    next();
  },
};

function install(relPath, exports) {
  const abs = require.resolve(path.join(__dirname, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
}

install('server/services/supabase', stubSupabase);
install('server/services/googleSheets', sheets);
install('server/services/gmailService', stubGmail);
install('server/middleware/auth', stubAuth);

// Real modules under test.
const upi = require('./server/services/upi');
const store = require('./server/services/paymentStore');
const verifier = require('./server/services/paymentVerifier');
const paymentRouter = require('./server/routes/payment');

// ── Fixtures ───────────────────────────────────────────────────────────────
const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
let couponSeq = 0;
function addCoupon({ price = '37', status = 'available', seller = 'someone@else.com', expiry = FUTURE, code } = {}) {
  couponSeq += 1;
  const c = {
    id: 'coupon-' + couponSeq,
    code: code || 'TEST' + couponSeq,
    title: 'Test Coupon ' + couponSeq,
    brand: 'TestBrand',
    discount: '10% OFF',
    selling_price: price,
    status,
    seller_email: seller,
    expiry_date: expiry,
    sold_at: null,
    buyer_email: '',
  };
  couponDb.tables.coupons.push(c);
  return c;
}

// Row accessors — payment records now live in the spreadsheet.
const payRows = () => sheets.state.tables[SHEETS.PAYMENTS];
const orderRows = () => sheets.state.tables[SHEETS.ORDERS];
const notifRows = () => sheets.state.tables[SHEETS.PAYMENT_NOTIFICATIONS];
const payRow = (id) => payRows().find((r) => String(r.payment_id) === String(id));
const couponById = (id) => couponDb.tables.coupons.find((c) => String(c.id) === String(id));
const orderForPayment = (paymentId) => {
  const p = payRow(paymentId);
  return p ? orderRows().find((o) => String(o.id) === String(p.order_id)) : null;
};

// ── App ────────────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  // Mirror server.js: capture the raw body for the webhook HMAC.
  app.use('/api/payment/webhook', express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }), paymentRouter.webhookHandler);
  app.use('/api/payment', express.json(), paymentRouter);
  return app;
}

let server, base;
async function start() {
  server = buildApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
}
function stop() { try { server.close(); } catch (e) {} }

async function api(method, url, { token, body, raw } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
    body: body === undefined ? undefined : (raw !== undefined ? raw : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, json, text, headers: res.headers };
}

// ── QR decode helper ───────────────────────────────────────────────────────
let jsqr = null;
try { jsqr = require('jsqr'); } catch (e) {
  try {
    const ws = process.env.WB_NODE_WORKSPACE || 'C:/Users/Rupayan/.workbuddy-ai/binaries/node/workspace';
    jsqr = require(path.join(ws, 'node_modules', 'jsqr'));
  } catch (e2) { jsqr = null; }
}

function decodeDataUrl(dataUrl) {
  if (!dataUrl) return null;
  const b64 = String(dataUrl).split(',')[1];
  if (!b64) return null;
  const png = PNG.sync.read(Buffer.from(b64, 'base64'));
  const res = jsqr.default
    ? jsqr.default(new Uint8ClampedArray(png.data), png.width, png.height)
    : jsqr(new Uint8ClampedArray(png.data), png.width, png.height);
  return res ? res.data : null;
}

// ══════════════════════════════════════════════════════════════════════════
(async () => {
  process.env.UPI_ID = process.env.UPI_ID || 'savehatke@fam';
  process.env.UPI_PAYEE_NAME = process.env.UPI_PAYEE_NAME || 'SaveHatke';
  await start();

  const PAYEE = upi.getPayee();
  // The receiving VPA is configuration, not a constant. Fixtures quote it so
  // the suite exercises whatever UPI_ID is actually configured, instead of
  // failing the moment a real VPA replaces the placeholder.
  const VPA = PAYEE.upiId;

  // Captured BEFORE section 11 replaces the env var with a throwaway test
  // secret, so the leak checks below assert against the value that is really
  // configured. Held in memory only — never printed.
  const REAL_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || '';

  // ─────────────────────────────────────────────────────────────────────
  head('1. UPI URI construction (requirement 7)');
  const uri = upi.buildUpiUri({ amount: 37, orderCode: 'SH-ABC234', paymentId: 'pay_x' });
  check('starts with upi://pay?', uri.startsWith('upi://pay?'), uri);
  check('carries pa= (payee VPA)', uri.includes('pa=' + encodeURIComponent(PAYEE.upiId)), uri);
  check('carries pn= (payee name)', uri.includes('pn=' + encodeURIComponent(PAYEE.payeeName)), uri);
  check('carries am=37.00 exactly two decimals', /[?&]am=37\.00(&|$)/.test(uri), uri);
  check('carries cu=INR', /[?&]cu=INR/.test(uri), uri);
  check("VPA '@' is percent-encoded as %40", uri.includes('%40') && !/[?&]pa=[^&]*@/.test(uri), uri);
  check('no literal + for spaces', !uri.includes('+'), uri);
  check('amount is formatted, not raw: 37.5 -> 37.50',
    /[?&]am=37\.50(&|$)/.test(upi.buildUpiUri({ amount: 37.5, orderCode: 'SH-ABC234' })));

  // The spec says the QR must encode the four parameters ONLY. An order code
  // must therefore NOT leak into the link as tr/tn, even though one exists.
  const withOrder = upi.buildUpiUri({ amount: 37, orderCode: 'SH-ABC234', paymentId: 'pay_x' });
  check('an existing order code does NOT add tr= to the link',
    !/[?&]tr=/.test(withOrder), withOrder);
  check('an existing order code does NOT add tn= to the link',
    !/[?&]tn=/.test(withOrder), withOrder);
  check('the link carries exactly the four spec parameters and nothing else',
    /^upi:\/\/pay\?pa=[^&]+&pn=[^&]+&am=37\.00&cu=INR$/.test(withOrder), withOrder);

  // The correlator is still reachable, but only when a caller asks for it and
  // accepts that the payload is no longer the agreed four-parameter form.
  const withRef = upi.buildUpiUri({ amount: 37, orderCode: 'SH-ABC234', includeReference: true });
  check('includeReference:true restores the tr/tn correlator',
    /[?&]tr=SH-ABC234(&|$)/.test(withRef) && /[?&]tn=/.test(withRef), withRef);
  check('the correlator form still leads with the four spec parameters in order',
    /^upi:\/\/pay\?pa=[^&]+&pn=[^&]+&am=37\.00&cu=INR&tr=/.test(withRef), withRef);

  // The four base parameters are the WHOLE link when no order context exists.
  // This is the exact shape the spec asks for, with no extra parameters.
  const bare299 = upi.buildUpiUri({ amount: 299 });
  const expectedBare299 =
    'upi://pay?pa=' + encodeURIComponent(PAYEE.upiId) +
    '&pn=' + encodeURIComponent(PAYEE.payeeName) +
    '&am=299.00&cu=INR';
  check('₹299 with no order context is exactly the 4 spec parameters',
    bare299 === expectedBare299, bare299);

  if (PAYEE.upiId === '810054436@fam' && PAYEE.payeeName === 'Rupayan Das') {
    check('₹299 matches the literal string given in the spec',
      bare299 === 'upi://pay?pa=810054436%40fam&pn=Rupayan%20Das&am=299.00&cu=INR', bare299);
    check('₹99 matches the literal string given in the spec',
      upi.buildUpiUri({ amount: 99 }) === 'upi://pay?pa=810054436%40fam&pn=Rupayan%20Das&am=99.00&cu=INR',
      upi.buildUpiUri({ amount: 99 }));

    // The four worked examples the spec spells out character by character. Each
    // is asserted as an exact string, not a regex, because the whole point is
    // that the payload is byte-identical to the agreed one.
    const SPEC_EXAMPLES = [
      [15, 'upi://pay?pa=810054436%40fam&pn=Rupayan%20Das&am=15.00&cu=INR'],
      [10, 'upi://pay?pa=810054436%40fam&pn=Rupayan%20Das&am=10.00&cu=INR'],
      [37, 'upi://pay?pa=810054436%40fam&pn=Rupayan%20Das&am=37.00&cu=INR'],
      [100, 'upi://pay?pa=810054436%40fam&pn=Rupayan%20Das&am=100.00&cu=INR'],
    ];
    for (const [amt, expected] of SPEC_EXAMPLES) {
      const actual = upi.buildUpiUri({ amount: amt });
      check(`₹${amt} is byte-identical to the spec string`, actual === expected,
        `\n         expected = ${expected}\n         actual   = ${actual}`);
    }
  } else {
    skip('literal spec URI string', 'configured payee is ' + PAYEE.upiId + ' / ' + PAYEE.payeeName);
  }

  check('parseAmount rejects 0', upi.parseAmount(0) === null);
  check('parseAmount rejects negatives', upi.parseAmount(-5) === null);
  check('parseAmount rejects non-numeric', upi.parseAmount('abc') === null);
  check('parseAmount accepts "37.00"', upi.parseAmount('37.00') === 37);
  check('parseAmount accepts "250"', upi.parseAmount('250') === 250);
  check('isConfigured() true with a valid VPA', upi.isConfigured() === true);

  // ─────────────────────────────────────────────────────────────────────
  head('1b. Amount validation — the gate in front of every collect request');
  const MAX = Number(process.env.PAYMENT_MAX_AMOUNT || 100000);
  check('PAYMENT_MAX_AMOUNT is configured', Number.isFinite(MAX) && MAX > 0, String(MAX));

  for (const bad of [0, -5, -0.01, 'abc', '', null, undefined, true, false, {}, [], NaN]) {
    const r = upi.validateAmount(bad);
    // JSON.stringify(NaN) and JSON.stringify(undefined) are both "null" /
    // undefined, so label those two explicitly to keep the log unambiguous.
    const label = Number.isNaN(bad) ? 'NaN' : bad === undefined ? 'undefined' : JSON.stringify(bad);
    check('rejects ' + label + ' as INVALID_AMOUNT',
      r.ok === false && r.code === 'INVALID_AMOUNT', JSON.stringify(r));
  }
  check('rejects 0.001 (rounds below one paise)', upi.validateAmount(0.001).code === 'INVALID_AMOUNT');
  check('rejects MAX+0.01 as AMOUNT_TOO_LARGE',
    upi.validateAmount(MAX + 0.01).code === 'AMOUNT_TOO_LARGE');
  check('rejects an absurd amount as AMOUNT_TOO_LARGE',
    upi.validateAmount(1e9).code === 'AMOUNT_TOO_LARGE');
  check('the TOO_LARGE rejection reports the ceiling', upi.validateAmount(MAX + 1).max === MAX);
  check('accepts exactly MAX (boundary is inclusive)', upi.validateAmount(MAX).ok === true);
  check('accepts a numeric string', upi.validateAmount('299').ok === true);
  check('accepts a string with whitespace', upi.validateAmount('  12  ').amount === 12);
  check('accepts a fractional amount', upi.validateAmount(299.5).amount === 299.5);
  check('never returns a value above the ceiling',
    [MAX, MAX + 1, 1e9].every((v) => { const r = upi.validateAmount(v); return !r.ok || r.amount <= MAX; }));

  // ─────────────────────────────────────────────────────────────────────
  head('2. QR encodes the real amount — ₹1 … ₹999 (requirement 30)');
  // ₹1, ₹10, ₹15, ₹37, ₹100, ₹250 and ₹500 are the amounts the spec calls out
  // explicitly; the rest guard the edges around them.
  const AMOUNTS = [1, 10, 15, 37, 99, 100, 149, 250, 299, 499, 500, 999];
  for (const amount of AMOUNTS) {
    const built = upi.buildUpiUri({ amount, orderCode: 'SH-' + String(amount).padStart(3, '0') + '234', paymentId: 'pay_' + amount });
    let dataUrl;
    try {
      dataUrl = await upi.generateQrPngDataUrl(built);
    } catch (e) {
      check(`₹${amount}: QR generated`, false, e.message);
      continue;
    }
    check(`₹${amount}: real PNG QR generated (not an image asset)`, /^data:image\/png;base64,/.test(dataUrl), dataUrl.slice(0, 30));

    if (!jsqr) { skip(`₹${amount}: decoded QR amount`, 'jsqr not installed'); continue; }

    const decoded = decodeDataUrl(dataUrl);
    const expected = amount.toFixed(2);
    check(`₹${amount}: QR decodes back to the same UPI URI`, decoded === built, decoded ? 'decoded=' + decoded : 'decode failed');
    check(`₹${amount}: decoded QR carries am=${expected}`,
      decoded !== null && new RegExp('[?&]am=' + expected.replace('.', '\\.') + '(&|$)').test(decoded),
      decoded || 'decode failed');
  }

  if (jsqr) {
    const a = decodeDataUrl(await upi.generateQrPngDataUrl(upi.buildUpiUri({ amount: 1 })));
    const b = decodeDataUrl(await upi.generateQrPngDataUrl(upi.buildUpiUri({ amount: 10 })));
    check('QR for ₹1 and ₹10 are genuinely different payloads (amount is in the QR, not a constant)',
      a !== b && /am=1\.00/.test(a) && /am=10\.00/.test(b), `${a} vs ${b}`);
  }

  // The QR must be big enough to scan comfortably from a phone screen.
  const qrPng = PNG.sync.read(Buffer.from(
    (await upi.generateQrPngDataUrl(bare299)).split(',')[1], 'base64'));
  check('QR renders at least 1024px wide (high resolution)',
    qrPng.width >= 1024 && qrPng.height >= 1024, qrPng.width + 'x' + qrPng.height);

  // ─────────────────────────────────────────────────────────────────────
  head('3. POST /api/payment/create — auth, amount authority, duplicate clicks/tabs');
  const noAuth = await api('POST', '/api/payment/create', { body: { couponId: 'coupon-x' } });
  check('unauthenticated create is refused (401)', noAuth.status === 401, String(noAuth.status));

  const c37 = addCoupon({ price: '37' });
  const created = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: c37.id } });
  check('create succeeds (200)', created.status === 200, JSON.stringify(created.json).slice(0, 200));
  check('status is PENDING', created.json?.status === 'PENDING');
  check('amount comes from the coupon (₹37.00)', created.json?.amount === 37, String(created.json?.amount));
  check('a QR data URL is returned', /^data:image\/png;base64,/.test(created.json?.qr || ''));
  check('payment_id returned', typeof created.json?.payment_id === 'string' && created.json.payment_id.length > 8);
  check('order_id returned', !!created.json?.order_id);
  check('expires_at is ~10 minutes ahead',
    Math.abs(new Date(created.json.expires_at).getTime() - (Date.now() + 10 * MIN)) < 30 * 1000,
    created.json?.expires_at);
  check('coupon code is NOT revealed while PENDING', !created.json?.coupon_code, String(created.json?.coupon_code));
  check('server_now returned for clock-skew correction', !!created.json?.server_now);

  // The contract the frontend is allowed to depend on: the modal displays the
  // QR and payment facts the server returned, and builds nothing itself. Every
  // one of these must be present on a create response.
  for (const field of ['payment_id', 'order_id', 'amount', 'upi_id', 'upi_uri', 'qr', 'expires_at']) {
    check(`create response returns ${field}`, created.json?.[field] !== undefined && created.json[field] !== null,
      JSON.stringify(created.json?.[field]));
  }
  check('the returned upi_uri is a upi:// deep link',
    /^upi:\/\/pay\?/.test(created.json?.upi_uri || ''), created.json?.upi_uri);
  check('the returned upi_id is the configured VPA, unmodified',
    created.json?.upi_id === PAYEE.upiId, created.json?.upi_id);

  if (jsqr) {
    const decoded = decodeDataUrl(created.json?.qr);
    check('the QR in the create response carries am=37.00', /[?&]am=37\.00(&|$)/.test(decoded || ''), decoded || 'decode failed');
  }

  // ── The amount contract ────────────────────────────────────────────────
  // The checkout sends the amount it is displaying. It is validated as
  // untrusted input, and when a coupon is referenced that coupon's own price
  // is authoritative — a tampered amount is REFUSED, never silently honoured.
  const tamperCoupon = addCoupon({ price: '250' });
  const tampered = await api('POST', '/api/payment/create', {
    token: 'Bearer tok-user-2', body: { couponId: tamperCoupon.id, amount: 1 },
  });
  check('a TAMPERED amount (₹1 for a ₹250 coupon) is refused with 409 AMOUNT_MISMATCH',
    tampered.status === 409 && tampered.json?.code === 'AMOUNT_MISMATCH',
    String(tampered.status) + ' ' + JSON.stringify(tampered.json).slice(0, 140));
  check('the refusal reports the coupon\'s real price', tampered.json?.expected === 250,
    JSON.stringify(tampered.json?.expected));
  check('the tampered request created no payment',
    (await store.findLivePaymentForUserCoupon('user-2', tamperCoupon.id)) === null);
  check('the coupon is still available after the tampered attempt', tamperCoupon.status === 'available');

  const matching = await api('POST', '/api/payment/create', {
    token: 'Bearer tok-user-2', body: { couponId: tamperCoupon.id, amount: 250 },
  });
  check('a MATCHING amount is accepted', matching.status === 200 && matching.json?.amount === 250,
    String(matching.status) + ' ' + JSON.stringify(matching.json).slice(0, 140));
  check('the settled amount is the coupon price, never the body value',
    matching.json?.amount === 250 && /[?&]am=250\.00(&|$)/.test(matching.json?.upi_uri || ''),
    matching.json?.upi_uri);

  const tooBig = await api('POST', '/api/payment/create', {
    token: 'Bearer tok-user-2', body: { couponId: addCoupon({ price: '250' }).id, amount: MAX + 1 },
  });
  check('an amount above PAYMENT_MAX_AMOUNT is refused with 400 AMOUNT_TOO_LARGE',
    tooBig.status === 400 && tooBig.json?.code === 'AMOUNT_TOO_LARGE',
    String(tooBig.status) + ' ' + JSON.stringify(tooBig.json).slice(0, 140));

  const notNumeric = await api('POST', '/api/payment/create', {
    token: 'Bearer tok-user-2', body: { couponId: addCoupon({ price: '250' }).id, amount: 'abc' },
  });
  check('a non-numeric amount is refused with 400 INVALID_AMOUNT',
    notNumeric.status === 400 && notNumeric.json?.code === 'INVALID_AMOUNT',
    String(notNumeric.status) + ' ' + JSON.stringify(notNumeric.json).slice(0, 140));

  const negative = await api('POST', '/api/payment/create', {
    token: 'Bearer tok-user-2', body: { couponId: addCoupon({ price: '250' }).id, amount: -100 },
  });
  check('a negative amount is refused with 400 INVALID_AMOUNT',
    negative.status === 400 && negative.json?.code === 'INVALID_AMOUNT',
    String(negative.status) + ' ' + JSON.stringify(negative.json).slice(0, 140));

  // Coupon-less: the validated amount IS the whole request.
  const openAmount = await api('POST', '/api/payment/create', {
    token: 'Bearer tok-user-2', body: { amount: 299 },
  });
  check('a coupon-less { amount: 299 } request is accepted', openAmount.status === 200,
    String(openAmount.status) + ' ' + JSON.stringify(openAmount.json).slice(0, 140));
  check('the coupon-less payment carries the requested amount', openAmount.json?.amount === 299,
    JSON.stringify(openAmount.json?.amount));
  // The route emits the four spec parameters and nothing more. The order code
  // is NOT smuggled in as `tr`/`tn`: the spec fixes the payload, the minimal
  // form is the one every UPI app accepts, and dropping ~40 characters makes
  // the symbol noticeably easier to scan. Reconciliation falls back to
  // amount + pending-window matching, which is the verifier's primary path
  // anyway — see buildUpiUri() for the full trade-off.
  const openUri = openAmount.json?.upi_uri || '';
  check('the coupon-less UPI URI leads with exactly the 4 spec parameters in order',
    /^upi:\/\/pay\?pa=[^&]+&pn=[^&]+&am=299\.00&cu=INR(&|$)/.test(openUri), openUri);
  check('the coupon-less URI adds NOTHING beyond the 4 spec parameters',
    /^upi:\/\/pay\?pa=[^&]+&pn=[^&]+&am=299\.00&cu=INR$/.test(openUri), openUri);
  check('the coupon-less URI carries am=299.00 exactly', /[?&]am=299\.00(&|$)/.test(openUri), openUri);
  check('the coupon-less URI carries cu=INR', /[?&]cu=INR/.test(openUri), openUri);
  check('the coupon-less request returns a real QR',
    /^data:image\/png;base64,/.test(openAmount.json?.qr || ''));
  if (jsqr) {
    check('the coupon-less QR encodes ₹299',
      /[?&]am=299\.00(&|$)/.test(decodeDataUrl(openAmount.json?.qr) || ''),
      decodeDataUrl(openAmount.json?.qr) || 'decode failed');
  } else {
    skip('the coupon-less QR encodes ₹299', 'jsqr not installed');
  }

  const noAmountNoCoupon = await api('POST', '/api/payment/create', {
    token: 'Bearer tok-user-2', body: {},
  });
  check('neither amount nor couponId is refused with 400',
    noAmountNoCoupon.status === 400, String(noAmountNoCoupon.status));

  const click2 = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: c37.id } });
  check('duplicate click reuses the same payment', click2.json?.payment_id === created.json.payment_id);
  check('duplicate click does NOT restart the 10-minute timer',
    click2.json?.expires_at === created.json.expires_at,
    `${click2.json?.expires_at} vs ${created.json?.expires_at}`);
  check('duplicate click is flagged reused', click2.json?.reused === true);

  const tab2 = await api('GET', '/api/payment/active?coupon_id=' + c37.id, { token: 'Bearer tok-user-1' });
  check('a second tab (GET /active) gets the same payment id', tab2.json?.payment_id === created.json.payment_id);
  check('a second tab gets the same expires_at (one shared backend timer)',
    tab2.json?.expires_at === created.json.expires_at);

  check('exactly one PENDING row exists for that coupon',
    payRows().filter((p) => p.coupon_id === c37.id && p.status === 'PENDING').length === 1);
  check('the payment row is written to the spreadsheet with the server amount',
    payRow(created.json.payment_id)?.amount === '37.00', String(payRow(created.json.payment_id)?.amount));
  check('the order row is written to the spreadsheet',
    orderRows().some((o) => String(o.id) === String(created.json.order_id)), JSON.stringify(orderRows().length));

  // ─────────────────────────────────────────────────────────────────────
  head('4. create — refusal paths (requirement 4 / 24)');
  const sold = addCoupon({ price: '15', status: 'sold', code: 'SOLD01' });
  const soldRes = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: sold.id } });
  check('unavailable coupon → 409 COUPON_UNAVAILABLE',
    soldRes.status === 409 && soldRes.json?.code === 'COUPON_UNAVAILABLE', JSON.stringify(soldRes.json));

  const badPrice = addCoupon({ price: '0' });
  const badRes = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: badPrice.id } });
  check('invalid amount → 400 INVALID_AMOUNT',
    badRes.status === 400 && badRes.json?.code === 'INVALID_AMOUNT', JSON.stringify(badRes.json));

  const expired = addCoupon({ price: '20', expiry: new Date(Date.now() - 86400000).toISOString() });
  const expRes = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: expired.id } });
  check('expired offer → 409 COUPON_EXPIRED',
    expRes.status === 409 && expRes.json?.code === 'COUPON_EXPIRED', JSON.stringify(expRes.json));

  const mine = addCoupon({ price: '30', seller: 'buyer1@example.com' });
  const ownRes = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: mine.id } });
  check('own coupon → 403 OWN_COUPON',
    ownRes.status === 403 && ownRes.json?.code === 'OWN_COUPON', JSON.stringify(ownRes.json));

  const ghost = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: 'does-not-exist' } });
  check('unknown coupon → 404 COUPON_NOT_FOUND',
    ghost.status === 404 && ghost.json?.code === 'COUPON_NOT_FOUND', JSON.stringify(ghost.json));

  const noInput = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: {} });
  check('missing couponId → 400 INVALID_INPUT', noInput.status === 400 && noInput.json?.code === 'INVALID_INPUT');

  const prevUpi = process.env.UPI_ID;
  delete process.env.UPI_ID;
  const unconfigured = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: addCoupon({ price: '11' }).id } });
  check('UPI_ID unset → 503 UPI_NOT_CONFIGURED (fail closed, not a silent success)',
    unconfigured.status === 503 && unconfigured.json?.code === 'UPI_NOT_CONFIGURED', JSON.stringify(unconfigured.json));
  process.env.UPI_ID = prevUpi;

  // ─────────────────────────────────────────────────────────────────────
  head('5. IDOR — one buyer cannot touch another buyer\'s payment (requirement 25)');
  const other = await api('GET', '/api/payment/status?payment_id=' + created.json.payment_id, { token: 'Bearer tok-user-2' });
  check('reading another user\'s payment → 404 (existence not disclosed)', other.status === 404, String(other.status));

  const otherCancel = await api('POST', '/api/payment/cancel', { token: 'Bearer tok-user-2', body: { payment_id: created.json.payment_id } });
  check('cancelling another user\'s payment → 404', otherCancel.status === 404, String(otherCancel.status));

  const otherVerify = await api('POST', '/api/payment/verify', { token: 'Bearer tok-user-2', body: { payment_id: created.json.payment_id } });
  check('verifying another user\'s payment → 404', otherVerify.status === 404, String(otherVerify.status));

  const ownerStatus = await api('GET', '/api/payment/status?payment_id=' + created.json.payment_id, { token: 'Bearer tok-user-1' });
  check('the owner can read their own payment', ownerStatus.status === 200 && ownerStatus.json?.status === 'PENDING');

  // ─────────────────────────────────────────────────────────────────────
  head('6. Cancel (requirement 14) — coupon is never unlocked by cancelling');
  const cancelCoupon = addCoupon({ price: '45' });
  const toCancel = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-2', body: { couponId: cancelCoupon.id } });
  const cancelled = await api('POST', '/api/payment/cancel', { token: 'Bearer tok-user-2', body: { payment_id: toCancel.json.payment_id } });
  check('cancel returns CANCELLED', cancelled.json?.status === 'CANCELLED', JSON.stringify(cancelled.json));
  check('the cancelled payment row is CANCELLED in the spreadsheet',
    payRow(toCancel.json.payment_id)?.status === 'CANCELLED');
  check('the coupon is still available after cancelling (not unlocked)', cancelCoupon.status === 'available');

  const cancelAgain = await api('POST', '/api/payment/cancel', { token: 'Bearer tok-user-2', body: { payment_id: toCancel.json.payment_id } });
  check('cancelling an already-cancelled payment is idempotent (no error)',
    cancelAgain.status === 200 && cancelAgain.json?.status === 'CANCELLED', JSON.stringify(cancelAgain.json));

  const afterCancel = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-2', body: { couponId: cancelCoupon.id } });
  check('a new payment window can be started after a cancel',
    afterCancel.json?.status === 'PENDING' && afterCancel.json?.payment_id !== toCancel.json.payment_id);

  // ─────────────────────────────────────────────────────────────────────
  head('7. Expiry (requirement 13) — server is the source of truth, coupon stays locked');
  const expCoupon = addCoupon({ price: '60' });
  const expPay = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: expCoupon.id } });
  // Age the payment past its window, exactly as a 10-minute wait would.
  sheets.state.tables[SHEETS.PAYMENTS]
    .filter((p) => String(p.payment_id) === String(expPay.json.payment_id))
    .forEach((p) => { p.expires_at = new Date(Date.now() - 1000).toISOString(); });

  const expStatus = await api('GET', '/api/payment/status?payment_id=' + expPay.json.payment_id, { token: 'Bearer tok-user-1' });
  check('past expires_at → EXPIRED', expStatus.json?.status === 'EXPIRED', JSON.stringify(expStatus.json));
  check('the sheet row is EXPIRED', payRow(expPay.json.payment_id)?.status === 'EXPIRED');
  check('the coupon is NOT unlocked by expiry', expCoupon.status === 'available');
  check('the order is EXPIRED too', orderForPayment(expPay.json.payment_id)?.status === 'EXPIRED');

  const lateSettle = await store.finalizePayment({ paymentId: expPay.json.payment_id, transactionId: 'LATE-TXN-0001', utr: 'LATE-TXN-0001', source: 'test' });
  check('a late confirmation cannot settle an EXPIRED payment (PAYMENT_NOT_PENDING)',
    lateSettle.ok === false && lateSettle.code === 'PAYMENT_NOT_PENDING', JSON.stringify(lateSettle));
  check('coupon still locked after the late attempt', expCoupon.status === 'available');

  // ─────────────────────────────────────────────────────────────────────
  head('8. Verification policy — an email alone never unlocks (requirements 16-18, 26)');
  const payCoupon = addCoupon({ price: '37', code: 'PAYME37' });
  const payRes = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: payCoupon.id } });
  const payId = payRes.json.payment_id;
  const orderCode = orderForPayment(payId).order_code;

  const baseMail = { messageId: 'm-1', from: 'no-reply@famapp.in', subject: 'You have received ₹37.00', date: new Date().toISOString() };

  const noVpa = verifier.buildCandidateFromEmail({ ...baseMail, messageId: 'm-no-vpa', body: 'You have received ₹37.00 from Rahul. UTR 412345678901.' });
  const noVpaVerdict = await verifier.processCandidate(noVpa);
  check('email with the right amount but NO payee VPA → not settled', noVpaVerdict.action !== 'settled', JSON.stringify(noVpaVerdict.action));
  check('…and is parked for review', noVpaVerdict.action === 'review', JSON.stringify(noVpaVerdict).slice(0, 160));
  check('payment still PENDING', payRow(payId)?.status === 'PENDING');
  check('coupon still locked', payCoupon.status === 'available');

  // A credit for an amount nobody is waiting on. Note the subject AND body must
  // agree — parseMoney reads the first money string in "subject\nbody", so a
  // subject quoting the right figure would make this fixture self-defeating.
  const wrongAmount = verifier.buildCandidateFromEmail({
    ...baseMail, messageId: 'm-wrong-amt', subject: 'You have received ₹99.00',
    body: `You have received ₹99.00 to ${VPA}. UTR 412345678902. ${orderCode}`,
  });
  const wrongVerdict = await verifier.processCandidate(wrongAmount);
  check('email claiming the WRONG amount is ignored, not settled',
    wrongVerdict.action !== 'settled', JSON.stringify(wrongVerdict).slice(0, 160));
  check('the ₹99 claim is recorded as IGNORED', wrongVerdict.action === 'ignored', JSON.stringify(wrongVerdict.action));
  check('payment still PENDING after the wrong amount', payRow(payId)?.status === 'PENDING');
  check('coupon still locked after the wrong amount', payCoupon.status === 'available');

  const noCorrelator = verifier.buildCandidateFromEmail({
    ...baseMail, messageId: 'm-no-ref',
    body: 'You have received ₹37.00 to ' + VPA + ' from someone. Thanks.',
  });
  const noCorrVerdict = await verifier.processCandidate(noCorrelator);
  check('right amount + right payee but NO order reference / transaction id → review, not settled',
    noCorrVerdict.action === 'review', JSON.stringify(noCorrVerdict.action));

  const debit = verifier.buildCandidateFromEmail({
    ...baseMail, messageId: 'm-debit',
    body: `You paid ₹37.00 to ${VPA}. UTR 412345678903. ${orderCode}`,
  });
  const debitVerdict = await verifier.processCandidate(debit);
  check('an outgoing "You paid" notification is never treated as a credit',
    debitVerdict.action !== 'settled', JSON.stringify(debitVerdict.action));

  const badPayee = verifier.buildCandidateFromEmail({
    ...baseMail, messageId: 'm-bad-payee',
    body: `You have received ₹37.00 to someoneelse@otherbank. UTR 412345678904. ${orderCode}`,
  });
  const badPayeeVerdict = await verifier.processCandidate(badPayee);
  check('a credit to a DIFFERENT payee VPA is refused',
    badPayeeVerdict.action !== 'settled', JSON.stringify(badPayeeVerdict.action));

  // ─────────────────────────────────────────────────────────────────────
  head('9. Verified settlement (requirements 17, 19, 20, 21)');
  const good = verifier.buildCandidateFromEmail({
    ...baseMail, messageId: 'm-good',
    body: `You have received ₹37.00 to ${VPA} from rahul@okhdfcbank. UTR 412345678905. Ref ${orderCode}`,
  });
  const goodVerdict = await verifier.processCandidate(good);
  check('a fully matching credit notification settles the payment',
    goodVerdict.action === 'settled', JSON.stringify(goodVerdict).slice(0, 240));
  check('payment.status = PAID in the sheet', payRow(payId)?.status === 'PAID');
  check('order.status = PAID in the sheet', orderForPayment(payId)?.status === 'PAID');
  check('paid_at recorded on the payment', !!payRow(payId)?.paid_at);
  check('verified_transaction_id recorded', !!payRow(payId)?.verified_transaction_id);
  check('verified_utr recorded', !!payRow(payId)?.verified_utr);
  check('coupon unlocked only after settlement (status sold)', payCoupon.status === 'sold');
  check('coupon stamped with the buyer', String(payCoupon.buyer_email).toLowerCase() === 'buyer1@example.com');

  const replayEmail = await verifier.processCandidate(good);
  check('the same notification re-processed is a duplicate (not a second unlock)',
    replayEmail.action === 'duplicate', JSON.stringify(replayEmail.action));
  check('coupon unlocked exactly once (one coupon row, still sold)',
    couponDb.tables.coupons.filter((c) => c.id === payCoupon.id).length === 1 && payCoupon.status === 'sold');

  const finalizeAgain = await store.finalizePayment({ paymentId: payId, transactionId: '412345678905', utr: '412345678905', source: 'test-replay' });
  check('finalizePayment is idempotent for an already-PAID payment (ALREADY_PAID)',
    finalizeAgain.ok === true && finalizeAgain.idempotent === true, JSON.stringify(finalizeAgain));

  const couponCodeNow = await api('GET', '/api/payment/status?payment_id=' + payId, { token: 'Bearer tok-user-1' });
  check('the coupon code is revealed once PAID', couponCodeNow.json?.coupon_code === 'PAYME37', JSON.stringify(couponCodeNow.json?.coupon_code));

  const paidCancel = await api('POST', '/api/payment/cancel', { token: 'Bearer tok-user-1', body: { payment_id: payId } });
  check('a PAID payment cannot be cancelled (409 ALREADY_PAID)',
    paidCancel.status === 409 && paidCancel.json?.code === 'ALREADY_PAID', JSON.stringify(paidCancel.json));

  const paidCoupon = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: payCoupon.id } });
  check('re-buying an already-paid coupon reports already_paid instead of a dead end',
    paidCoupon.json?.already_paid === true && paidCoupon.json?.coupon_code === 'PAYME37', JSON.stringify(paidCoupon.json).slice(0, 200));

  // ─────────────────────────────────────────────────────────────────────
  head('10. Replay protection — one real payment cannot settle two orders (requirements 17, 25)');
  const r1 = addCoupon({ price: '37', code: 'REPLAY1' });
  const r2 = addCoupon({ price: '37', code: 'REPLAY2' });
  const p1 = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: r1.id } });
  const p2 = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-2', body: { couponId: r2.id } });
  const o1 = orderForPayment(p1.json.payment_id).order_code;

  const first = await verifier.processCandidate(verifier.buildCandidateFromEmail({
    messageId: 'm-replay-1', from: 'no-reply@famapp.in', subject: 'You have received ₹37.00', date: new Date().toISOString(),
    body: `You have received ₹37.00 to ${VPA} from rahul@okhdfcbank. UTR 555555555555. Ref ${o1}`,
  }));
  check('first settlement succeeds', first.action === 'settled', JSON.stringify(first).slice(0, 200));

  const replay = await verifier.processCandidate(verifier.buildCandidateFromEmail({
    messageId: 'm-replay-2', from: 'no-reply@famapp.in', subject: 'You have received ₹37.00', date: new Date().toISOString(),
    body: 'You have received ₹37.00 to ' + VPA + ' from rahul@okhdfcbank. UTR 555555555555. Ref ' +
      orderForPayment(p2.json.payment_id).order_code,
  }));
  check('the SAME UTR cannot settle a second order', replay.action !== 'settled', JSON.stringify(replay).slice(0, 240));
  check('the second coupon is still locked', r2.status === 'available');

  const directReplay = await store.finalizePayment({ paymentId: p2.json.payment_id, transactionId: '555555555555', utr: '555555555555', source: 'test' });
  check('finalizePayment refuses a replayed transaction (REPLAY_DETECTED)',
    directReplay.ok === false && directReplay.code === 'REPLAY_DETECTED', JSON.stringify(directReplay));
  check('second coupon STILL locked after the direct replay attempt', r2.status === 'available');

  // ─────────────────────────────────────────────────────────────────────
  head('11. Webhook — HMAC authenticated, no user session (requirement 26)');
  process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';
  const crypto = require('crypto');

  const noSecret = await api('POST', '/api/payment/webhook', { body: { status: 'success' } });
  check('webhook with no signature is rejected (401)', noSecret.status === 401, String(noSecret.status));

  const wCoupon = addCoupon({ price: '250', code: 'WIRE250' });
  const wPay = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: wCoupon.id } });
  const wOrder = orderForPayment(wPay.json.payment_id).order_code;

  const payload = {
    status: 'success', amount: 250, currency: 'INR',
    transactionId: 'WEBHOOK-TXN-9911', utr: 'WEBHOOK-TXN-9911',
    payeeVpa: VPA, reference: wOrder, occurredAt: new Date().toISOString(),
  };
  const rawBody = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', 'test-webhook-secret').update(rawBody).digest('hex');

  const badSig = await api('POST', '/api/payment/webhook', { raw: rawBody });
  check('webhook with a missing/wrong signature is refused', badSig.status === 401, String(badSig.status));

  const goodHook = await fetch(base + '/api/payment/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-payment-signature': sig }, body: rawBody,
  });
  const hookJson = await goodHook.json().catch(() => ({}));
  check('a correctly signed webhook settles the payment',
    hookJson.ok === true && hookJson.action === 'settled', JSON.stringify(hookJson));
  check('the webhook-settled coupon is unlocked', wCoupon.status === 'sold', wCoupon.status);
  check('verified_transaction_id is the webhook transaction id',
    payRow(wPay.json.payment_id)?.verified_transaction_id === 'WEBHOOK-TXN-9911');

  const goodHookAgain = await fetch(base + '/api/payment/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-payment-signature': sig }, body: rawBody,
  });
  const hookAgainJson = await goodHookAgain.json().catch(() => ({}));
  check('a redelivered webhook is a no-op (duplicate), not a second unlock',
    hookAgainJson.action === 'duplicate', JSON.stringify(hookAgainJson));

  const debitHook = { ...payload, status: 'failed', transactionId: 'WEBHOOK-TXN-9912', utr: 'WEBHOOK-TXN-9912' };
  const debitRaw = JSON.stringify(debitHook);
  const debitSig = crypto.createHmac('sha256', 'test-webhook-secret').update(debitRaw).digest('hex');
  const debitRes = await fetch(base + '/api/payment/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-payment-signature': debitSig }, body: debitRaw,
  });
  const debitJson = await debitRes.json().catch(() => ({}));
  check('a failure notification is acknowledged but settles nothing',
    debitJson.action === 'ignored', JSON.stringify(debitJson));

  // ─────────────────────────────────────────────────────────────────────
  head('12. /verify and /status degrade gracefully without a mailbox (requirement 24)');
  const vCoupon = addCoupon({ price: '100' });
  const vPay = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: vCoupon.id } });
  const vVerify = await api('POST', '/api/payment/verify', { token: 'Bearer tok-user-1', body: { payment_id: vPay.json.payment_id, utr: '999888777666' } });
  check('verify returns the current state even with no mailbox', vVerify.status === 200 && vVerify.json?.status === 'PENDING', JSON.stringify(vVerify.json).slice(0, 200));
  check('verify reports the mailbox was not usable', vVerify.json?.verification?.mailboxChecked === false);
  check('a buyer-supplied UTR does NOT settle the payment', payRow(vPay.json.payment_id)?.status === 'PENDING');
  check('the buyer claim is recorded for review',
    notifRows().some((n) => n.source === 'buyer_claim' && n.status === 'REVIEW'));

  const noId = await api('GET', '/api/payment/status', { token: 'Bearer tok-user-1' });
  check('status with no id → 400 INVALID_INPUT', noId.status === 400 && noId.json?.code === 'INVALID_INPUT');

  const noneLive = await api('GET', '/api/payment/status?coupon_id=no-such-coupon', { token: 'Bearer tok-user-1' });
  check('status with no live payment → status NONE (not an error)', noneLive.json?.status === 'NONE');

  const cfg = await api('GET', '/api/payment/config');
  check('/config reports configured:true with a VPA', cfg.json?.configured === true, JSON.stringify(cfg.json));
  check('/config never leaks the webhook secret',
    !JSON.stringify(cfg.json).includes('test-webhook-secret') && cfg.json?.windowMinutes === 10);

  // ─────────────────────────────────────────────────────────────────────
  head('12b. Currency gate, and the webhook secret never leaves the server');
  // Only rupees may settle a rupee order: ₹150 and 150 USD are not the same
  // amount of money, so a non-INR credit must never unlock anything.
  const fxCoupon = addCoupon({ price: '150' });
  const fxPay = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: fxCoupon.id } });
  const fxOrder = orderForPayment(fxPay.json.payment_id).order_code;
  const fxVerdict = await verifier.processCandidate(verifier.buildCandidateFromWebhook({
    status: 'success', amount: 150, currency: 'USD',
    transactionId: 'FX-TXN-0001', utr: 'FX-TXN-0001',
    payeeVpa: VPA, reference: fxOrder, occurredAt: new Date().toISOString(),
  }));
  check('a non-INR credit does not settle an INR order',
    fxVerdict.action !== 'settled', JSON.stringify(fxVerdict).slice(0, 200));
  check('the non-INR notification is recorded as IGNORED',
    fxVerdict.action === 'ignored', JSON.stringify(fxVerdict.action));
  check('the payment is still PENDING after the non-INR credit',
    payRow(fxPay.json.payment_id)?.status === 'PENDING');
  check('the coupon is still locked after the non-INR credit', fxCoupon.status === 'available');

  check('a webhook secret is configured', REAL_WEBHOOK_SECRET.length > 0,
    REAL_WEBHOOK_SECRET.length ? 'set (' + REAL_WEBHOOK_SECRET.length + ' chars)' : 'NOT SET');

  const secretProbeResponses = [
    await api('GET', '/api/payment/config'),
    await api('GET', '/api/payment/status?payment_id=' + fxPay.json.payment_id, { token: 'Bearer tok-user-1' }),
    await api('GET', '/api/payment/active?coupon_id=' + fxCoupon.id, { token: 'Bearer tok-user-1' }),
    await api('POST', '/api/payment/verify', { token: 'Bearer tok-user-1', body: { payment_id: fxPay.json.payment_id } }),
    fxPay,
  ];
  const secretLeaks = secretProbeResponses.filter(
    (r) => REAL_WEBHOOK_SECRET && JSON.stringify(r.json || {}).includes(REAL_WEBHOOK_SECRET)
  );
  check('the configured webhook secret is never echoed by any endpoint',
    secretLeaks.length === 0,
    secretLeaks.length ? 'leaked in ' + secretLeaks.length + ' response(s)' : '');
  check('no response names an env var that holds a secret',
    !secretProbeResponses.some((r) =>
      /PAYMENT_WEBHOOK_SECRET|PAYMENT_MAIL_|GMAIL_REFRESH|SERVICE_KEY/.test(JSON.stringify(r.json || {}))));
  check('the receiving VPA is exposed (it is printed in the QR anyway) but the secret is not',
    JSON.stringify(cfg.json || {}).includes(VPA));

  // ─────────────────────────────────────────────────────────────────────
  head('13. Realtime stream — every tab sees the same backend status (requirements 22, 23)');
  const sCoupon = addCoupon({ price: '500' });
  const sPay = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: sCoupon.id } });
  const streamBody = await new Promise((resolve) => {
    const http = require('http');
    const req = http.get(
      base + '/api/payment/stream?payment_id=' + sPay.json.payment_id,
      { headers: { Authorization: 'Bearer tok-user-1' } },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString();
          if (buf.includes('event: status')) { req.destroy(); resolve({ status: res.statusCode, ctype: res.headers['content-type'], buf }); }
        });
        res.on('end', () => resolve({ status: res.statusCode, ctype: res.headers['content-type'], buf }));
      }
    );
    req.on('error', () => resolve({ status: 0, ctype: '', buf: '' }));
    setTimeout(() => { try { req.destroy(); } catch (e) {} resolve({ status: 0, ctype: '', buf: '' }); }, 4000);
  });
  check('the stream answers as text/event-stream', /text\/event-stream/.test(streamBody.ctype || ''), String(streamBody.ctype));
  check('the stream pushes the current status immediately', /event: status/.test(streamBody.buf || ''), (streamBody.buf || '').slice(0, 120));
  check('the pushed payload carries the payment_id', (streamBody.buf || '').includes(sPay.json.payment_id));
  check('the pushed payload carries expires_at (so the countdown is server-driven)', /expires_at/.test(streamBody.buf || ''));
  check('the stream never carries the webhook secret',
    !REAL_WEBHOOK_SECRET || !(streamBody.buf || '').includes(REAL_WEBHOOK_SECRET));

  const streamNoAuth = await fetch(base + '/api/payment/stream?payment_id=' + sPay.json.payment_id);
  check('the stream refuses an unauthenticated subscriber', streamNoAuth.status === 404 || streamNoAuth.status === 401, String(streamNoAuth.status));

  // ─────────────────────────────────────────────────────────────────────
  head('14. QR generation failure is reported, never a fake success (requirement 24)');
  const qrCoupon = addCoupon({ price: '77' });
  const realQr = upi.generateQrPngDataUrl;
  upi.generateQrPngDataUrl = async () => { throw new Error('simulated encoder failure'); };
  const qrFail = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: qrCoupon.id } });
  upi.generateQrPngDataUrl = realQr;
  check('a QR encoder failure → 502 QR_GENERATION_FAILED',
    qrFail.status === 502 && qrFail.json?.code === 'QR_GENERATION_FAILED', JSON.stringify(qrFail.json).slice(0, 200));
  check('the pending payment is not orphaned — it still exists for a retry',
    payRows().some((p) => String(p.payment_id) === String(qrFail.json?.payment_id) && p.status === 'PENDING'));
  check('no coupon was unlocked by the failure', qrCoupon.status === 'available');
  const qrRetry = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: qrCoupon.id } });
  check('retrying after a QR failure reuses the same payment and now returns a QR',
    qrRetry.json?.payment_id === qrFail.json.payment_id && /^data:image\/png;base64,/.test(qrRetry.json?.qr || ''),
    JSON.stringify(qrRetry.json).slice(0, 160));

  // ─────────────────────────────────────────────────────────────────────
  head('15. Storage guard (requirement 24)');
  sheets.state.connected = false;
  await store.ensureReady({ force: true });
  const storageFail = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: addCoupon({ price: '12' }).id } });
  check('a disconnected spreadsheet → 503 STORAGE_UNAVAILABLE with an actionable reason',
    storageFail.status === 503 && storageFail.json?.code === 'STORAGE_UNAVAILABLE', JSON.stringify(storageFail.json).slice(0, 200));
  check('the reason names Google Sheets',
    /Google Sheets/.test(storageFail.json?.error || ''), storageFail.json?.error);
  sheets.state.connected = true;
  await store.ensureReady({ force: true });

  // ─────────────────────────────────────────────────────────────────────
  head('16. Concurrent create race — one live window per buyer per coupon (requirement 4)');
  // Two /create calls can both pass the pre-check and each allocate their own
  // order before either write lands. This models exactly that: the competing
  // request's payment is written first, so this request must detect it and
  // fall back to reusing the winner instead of minting a second window.
  const raceCoupon = addCoupon({ price: '88' });
  const realFindLive = store.findLivePaymentForUserCoupon;
  const realCreatePayment = store.createPayment;
  let preCheckMissed = false;
  let seeded = false;

  store.findLivePaymentForUserCoupon = async (u, c) => {
    if (!preCheckMissed) { preCheckMissed = true; return null; } // pre-check sees nothing yet
    return realFindLive(u, c);
  };
  store.createPayment = async (args) => {
    if (!seeded) {
      seeded = true;
      const winnerOrder = await store.createOrder({
        userId: args.userId, userEmail: args.userEmail, couponId: args.couponId,
        amount: args.amount, expiresAt: args.expiresAt,
      });
      await realCreatePayment({ ...args, orderId: winnerOrder.id, paymentId: 'pay_race_winner' });
    }
    return realCreatePayment(args);
  };

  let raceRes;
  try {
    raceRes = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: raceCoupon.id } });
  } finally {
    store.findLivePaymentForUserCoupon = realFindLive;
    store.createPayment = realCreatePayment;
  }

  check('the loser of the race is not a 500 — it reuses the winner',
    raceRes.status === 200 && raceRes.json?.payment_id === 'pay_race_winner', JSON.stringify(raceRes.json).slice(0, 200));
  check('the reused payment is flagged reused', raceRes.json?.reused === true);
  check('exactly ONE live payment exists for that buyer+coupon',
    payRows().filter((p) => p.user_id === 'user-1' && p.coupon_id === raceCoupon.id && p.status === 'PENDING').length === 1);
  check('the loser\'s orphaned order is retired, not left PENDING',
    orderRows().filter((o) => String(o.coupon_id) === String(raceCoupon.id) && o.status === 'PENDING').length === 1,
    JSON.stringify(orderRows().filter((o) => String(o.coupon_id) === String(raceCoupon.id)).map((o) => o.status)));

  // ─────────────────────────────────────────────────────────────────────
  head('17. Concurrent settlement — the coupon can only be unlocked once (requirements 20, 21)');
  const dupCoupon = addCoupon({ price: '150', code: 'DUPUNLOCK' });
  const dupPay = await api('POST', '/api/payment/create', { token: 'Bearer tok-user-1', body: { couponId: dupCoupon.id } });
  const dupId = dupPay.json.payment_id;

  // Fire two settlements of the same payment at the same instant, as a
  // redelivered webhook plus a mailbox poll would.
  const [a, b] = await Promise.all([
    store.finalizePayment({ paymentId: dupId, transactionId: 'RACE-UTR-1', utr: 'RACE-UTR-1', source: 'test-a' }),
    store.finalizePayment({ paymentId: dupId, transactionId: 'RACE-UTR-1', utr: 'RACE-UTR-1', source: 'test-b' }),
  ]);
  const settled = [a, b].filter((r) => r && r.ok);
  const idempotent = settled.filter((r) => r.idempotent);
  check('exactly one settlement actually settles', settled.length === 2 && idempotent.length === 1,
    JSON.stringify([a, b]).slice(0, 240));
  check('the coupon is sold, not double-stamped', dupCoupon.status === 'sold');
  check('exactly one coupon row exists for it', couponDb.tables.coupons.filter((c) => c.id === dupCoupon.id).length === 1);
  check('the payment row is PAID exactly once', payRows().filter((p) => String(p.payment_id) === String(dupId)).length === 1);
  check('the payment carries the verified UTR', payRow(dupId)?.verified_utr === 'RACE-UTR-1', String(payRow(dupId)?.verified_utr));

  // ─────────────────────────────────────────────────────────────────────
  head('18. Customer-facing amount display — whole rupees never show ".00" (requirement 23)');

  const checkoutHtml = fs.readFileSync(path.join(__dirname, 'public', 'checkout.html'), 'utf8');

  /**
   * Pull a single function out of the page's inline script by brace-matching,
   * so the suite tests the REAL shipped implementation rather than a copy of it
   * that could drift.
   */
  function extractFunction(source, name) {
    const start = source.indexOf('function ' + name + '(');
    if (start < 0) return null;
    const braceStart = source.indexOf('{', start);
    if (braceStart < 0) return null;
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
    }
    return null;
  }

  const fmtSrc = extractFunction(checkoutHtml, 'formatRupees');
  check('formatRupees() is present in the shipped page', !!fmtSrc);
  const fmt = fmtSrc ? new Function(fmtSrc + '; return formatRupees;')() : () => null;

  const wholeRupees = [1, 10, 15, 37, 100, 250, 500];
  for (const n of wholeRupees) {
    const shown = fmt(n);
    check(`₹${n} renders as "₹${n}" with no decimals`, shown === '₹' + n, String(shown));
  }
  check('a string amount renders without decimals too', fmt('15') === '₹15', String(fmt('15')));
  check('a float artefact still renders as ₹15', fmt(14.999999) === '₹15', String(fmt(14.999999)));
  check('genuine paise keep exactly two places', fmt(15.5) === '₹15.50', String(fmt(15.5)));
  check('a sub-rupee amount keeps two places', fmt(0.5) === '₹0.50', String(fmt(0.5)));
  check('a non-numeric amount renders as a dash', fmt('abc') === '—', String(fmt('abc')));
  check('undefined renders as a dash', fmt(undefined) === '—', String(fmt(undefined)));
  check('NO whole-rupee output contains ".00"',
    wholeRupees.every((n) => !String(fmt(n)).includes('.00')),
    wholeRupees.map((n) => fmt(n)).join(' '));

  // The display rule must not leak into the money format the server uses.
  check('the UPI URI still carries the full 2-decimal amount for ₹15',
    /[?&]am=15\.00(&|$)/.test(upi.buildUpiUri({ amount: 15 })),
    upi.buildUpiUri({ amount: 15 }));

  // A regression guard against reintroducing the old formatting anywhere.
  check('no customer-facing amount is built with toFixed(2)',
    !/textContent\s*=\s*'₹'\s*\+\s*Number\([^)]*\)\.toFixed\(2\)/.test(checkoutHtml));
  check('the Pay button label uses formatRupees',
    /'🔒 Pay ' \+ formatRupees\(totalPrice\)/.test(checkoutHtml));

  // ─────────────────────────────────────────────────────────────────────
  head('19. Payment modal — required content, in the required order (requirements 1-11, 22)');

  const boxStart = checkoutHtml.indexOf('id="upiPayBox"');
  const boxEnd = checkoutHtml.indexOf('<!-- SUCCESS OVERLAY -->');
  const box = boxStart >= 0 && boxEnd > boxStart ? checkoutHtml.slice(boxStart, boxEnd) : '';
  check('the payment box is present', box.length > 0);

  const required = [
    ['upmClose', 'the × close button'],
    ['upmTitle', '"Complete Payment" title'],
    ['upmPayAmt', 'the "Pay ₹X using any UPI app" amount'],
    ['upmTimer', 'the countdown timer'],
    ['upmWindowMin', 'the "within N minutes" caption'],
    ['upmQr', 'the QR area'],
    ['upm-scan', 'the scan instruction'],
    ['upm-apps', 'the four UPI app options'],
    ['upmVpa', 'the UPI ID row'],
    ['upmOpenApp', 'the "Open UPI App / Pay Now" button'],
    ['upmCheck', 'the "I\'ve paid — Check status" button'],
    ['upm-foot', 'the "Secured by SaveHatke" footer'],
  ];
  let cursor = -1;
  for (const [marker, label] of required) {
    const at = box.indexOf(marker);
    check(`${label} is present and in order`, at >= 0 && at > cursor, at < 0 ? 'missing' : 'at ' + at);
    if (at >= 0) cursor = at;
  }

  check('the title reads "Complete Payment" with "Payment" in the green accent',
    /upm-ttl"[^>]*>Complete <span class="upm-green">Payment<\/span>/.test(box));
  check('the subtitle reads "Pay ₹X using any UPI app"',
    /Pay <span class="upm-amt-inline" id="upmPayAmt">/.test(box) && /using any UPI app<\/div>/.test(box));
  check('the scan instruction reads "Scan the QR code with any UPI app"',
    /class="upm-scan">Scan the QR code with any UPI app</.test(box));
  check('the timer caption reads "Complete the payment within N minutes"',
    /Complete the payment within <span id="upmWindowMin">10<\/span> minutes/.test(box));
  check('the footer reads "Secured by SaveHatke" with SaveHatke in green',
    /upm-foot">Secured by <span class="upm-green">SaveHatke<\/span>/.test(box));

  for (const app of ['PhonePe', 'Google Pay', 'Paytm', 'BHIM']) {
    check(`the ${app} option is offered`, box.includes('>' + app + '</span>'));
  }

  check('the UPI ID row has a copy control',
    /id="upmCopyBtn"[^>]*onclick="copyUpiId\(\)"/.test(box));
  check('copyUpiId() is wired in the page', /function copyUpiId\(\)/.test(checkoutHtml));
  check('the UPI ID is painted from server config, not hard-coded in the markup',
    /function showUpiId\(vpa\)/.test(checkoutHtml) && !/810054436/.test(checkoutHtml));

  // "Open UPI App / Pay Now" must hand the device the SAME URI the QR encodes.
  // The only way to guarantee that is for both to read one server-supplied
  // string, so the page must never build a upi:// link of its own.
  check('the Open UPI App button navigates to the server-supplied URI',
    /window\.location\.href = upiState\.upiUri/.test(checkoutHtml));
  check('the button URI is fed from the server response field upi_uri',
    /updateOpenAppButton\([^)]*data\.upi_uri/.test(checkoutHtml));
  check('the page never constructs its own upi:// link (QR and button cannot drift)',
    !/['"`]upi:\/\/pay/.test(checkoutHtml));
  check('the QR is rendered from the server-supplied qr field',
    /renderUpiQr\(data\.qr\)/.test(checkoutHtml));

  // The QR must stay completely unobstructed — no logo, caption, icon, border
  // or amount text composited over the encoded modules. A logo punch-out is
  // exactly what turns a scannable QR into an intermittent one.
  check('nothing is painted over the QR (no ::before/::after on .upm-qr)',
    !/\.upm-qr[a-z-]*::(?:before|after)/.test(checkoutHtml));
  check('the QR plate contains only the image slot and its loading skeleton',
    /<div class="upm-qr" id="upmQr">\s*<div class="upm-qr-empty" id="upmQrEmpty"><div class="upm-qr-skel"><\/div><\/div>\s*<\/div>/.test(checkoutHtml));
  check('the QR image is swapped in as a single <img>, not an overlay stack',
    /host\.innerHTML = '<img alt="UPI payment QR code" src="' \+ dataUrl \+ '">'/.test(checkoutHtml));

  check('the cancel panel is labelled Cancel / Confirm',
    /upmKeepBtn[^>]*>Cancel</.test(box) && /upmConfirmBtn[^>]*>Confirm</.test(box));
  check('the cancel panel is inside the box (slides up, not a browser dialog)',
    box.includes('upmCancelPanel'));
  check('no browser alert/confirm/prompt is used for cancellation',
    !/\balert\s*\(|\bconfirm\s*\(|\bprompt\s*\(/.test(checkoutHtml));

  // Requirement 10: nothing but the footer below the action buttons.
  check('the old extra coupon paragraph is gone', !/upm-note/.test(box));
  check('no Order ID is shown in the box', !/upmOrderRef/.test(box));
  const afterCheck = box.slice(box.indexOf('id="upmCheckText"'));
  check('the only content after the action buttons is the footer',
    /<\/button>\s*<div class="upm-foot">/.test(afterCheck), afterCheck.slice(0, 120));

  // Requirement 22: responsive, and the QR must stay large enough to scan.
  const qrWide = Number((checkoutHtml.match(/\.upm-qr \{ width:(\d+)px/) || [])[1]);
  const qrNarrow = Number((checkoutHtml.match(/\.upm-qr \{ width:(\d+)px; height:\d+px; \}\s*\.upm-ttl/) || [])[1]);
  check('the QR is at least 180px on desktop', qrWide >= 180, String(qrWide));
  check('a narrow-screen media query exists for the modal', /@media \(max-width:420px\)/.test(checkoutHtml));
  check('a short-viewport guard exists for the modal', /@media \(max-height:700px\)/.test(checkoutHtml));
  check('the modal body scrolls instead of overflowing the screen',
    /\.upm-body \{ overflow-y:auto;/.test(checkoutHtml));
  check('the four app chips share the row evenly (no overflow)',
    /\.upm-apps \{ display:grid; grid-template-columns:repeat\(4,1fr\)/.test(checkoutHtml));

  // ─────────────────────────────────────────────────────────────────────
  stop();

  console.log('\n' + '─'.repeat(64));
  console.log(`\x1b[1m${pass} passed, ${fail} failed, ${skipped} skipped\x1b[0m`);
  if (fail) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  • ' + f);
  }
  if (!jsqr) {
    console.log('\nQR decode assertions were skipped. Enable them with:');
    console.log('  NODE_PATH=C:/Users/Rupayan/.workbuddy-ai/binaries/node/workspace/node_modules \\');
    console.log('    node verify-upi-payment.cjs');
  }
  console.log('\nNote: Google Sheets and Supabase are emulated in-process. Orders, payments');
  console.log('and notifications are recorded in the spreadsheet tabs Orders / Payments /');
  console.log('PaymentNotifications; the coupon unlock runs against the real Supabase');
  console.log('`coupons` table in production.');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n\x1b[31mSUITE CRASHED\x1b[0m', e);
  stop();
  process.exit(1);
});
