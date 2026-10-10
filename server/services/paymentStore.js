// ============================================
// SaveHatke — Payment Store (Google Sheets)
// ============================================
// The only place orders and payments are read or written.
//
// WHERE THE DATA LIVES
//   Orders, payments and observed payment notifications are rows in the
//   existing SaveHatke spreadsheet — tabs `Orders`, `Payments` and
//   `PaymentNotifications` (declared in services/googleSheets.js, created
//   automatically by its ensureSheets()). Column names mirror the SQL these
//   tables replaced, so the field mapping below is a 1:1 rename and the sheet
//   stays readable on its own.
//
//   Coupons stay in Supabase, because they already live there.
//
// THE HONEST LIMITS OF SHEETS — read this before changing anything
//   A spreadsheet has no transactions, no row locks and no unique
//   constraints. So unlike a database, two concurrent writers are NOT
//   serialised for us. Three mitigations are layered here instead:
//
//   1. A per-process critical section (`withLock`). Every transition and the
//      whole settlement run one at a time, so within a single server instance
//      no two settlements can interleave.
//   2. Optimistic concurrency (compare-and-set). Each transition re-reads the
//      row immediately before writing, requires the status it expected, and
//      re-reads again afterwards to confirm the write landed. A caller that
//      loses the race gets `null` and reports the current truth instead of
//      claiming a change it did not make.
//   3. The coupon unlock is NOT done here. It is a single conditional UPDATE
//      against the Supabase `coupons` table (`WHERE id = ? AND status =
//      'available'`), which Postgres *does* serialise. That is what keeps
//      "unlock the coupon exactly once" true even if two instances race —
//      the loser affects 0 rows and the payment is parked in REVIEW rather
//      than unlocking a coupon nobody paid for.
//
//   Residual risk, stated plainly: mitigations 1 and 2 are per-process, so two
//   serverless instances racing on the SAME payment could in principle both
//   write. The coupon unlock (3) still cannot double-fire. If SaveHatke ever
//   runs at a scale where that matters, the Orders/Payments rows should move
//   back behind a transactional store.
// ============================================

const crypto = require('crypto');
const db = require('./googleSheets');
const supabase = require('./supabase');
const ids = require('../utils/identifiers');

const PAYMENT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes, per the checkout UI

// Backend checking deadline — how long a payment stays matchable/settleable
// AFTER it was created, independent of the 10-minute frontend window. The
// checkout shows its Expired state at 10 minutes; the server keeps verifying
// for the second half of the same 20-minute session (10–20 min) and stops
// permanently at backend_expiry_at. The coupon reservation lives exactly as
// long. Overridable via env.
const PAYMENT_CHECK_WINDOW_MS = (() => {
  const n = Number(process.env.PAYMENT_CHECK_WINDOW_MS);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60 * 1000; // 20 minutes total
})();

const ORDERS = db.SHEETS.ORDERS;
const PAYMENTS = db.SHEETS.PAYMENTS;
const NOTIFICATIONS = db.SHEETS.PAYMENT_NOTIFICATIONS;

// ── Value helpers ──────────────────────────────────────────────────────────
// Sheet cells come back as strings (and '' for blank), so every numeric and
// time value is normalised on read rather than trusted.

function toNumber(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

const money2 = (v) => toNumber(v).toFixed(2);

function toTime(v) {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Compare two money values exactly, at paise precision. */
function moneyEquals(a, b) {
  return Math.round(toNumber(a) * 100) === Math.round(toNumber(b) * 100);
}

/**
 * The moment a payment stops being matchable by the backend checker. Prefers
 * the explicit 20-minute `check_expires_at`; falls back to the 10-minute
 * `expires_at` for legacy rows written before that column existed, so their
 * behaviour is unchanged.
 */
function checkDeadline(row) {
  const raw = row && (row.check_expires_at || row.checkExpiresAt);
  if (raw) return toTime(raw);
  const legacy = row && (row.expires_at || row.expiresAt);
  return toTime(legacy);
}

// ── Mapping (sheet row → application shape) ────────────────────────────────

function fromOrder(r) {
  if (!r || !r.id) return null;
  return {
    id: String(r.id),
    orderCode: r.order_code || '',
    userId: r.user_id || '',
    userEmail: r.user_email || '',
    couponId: r.coupon_id || '',
    amount: toNumber(r.amount),
    currency: r.currency || 'INR',
    status: r.status || '',
    buyerName: r.buyer_name || '',
    buyerEmail: r.buyer_email || '',
    buyerPhone: r.buyer_phone || '',
    couponCode: r.coupon_code || '',
    couponBrand: r.coupon_brand || '',
    createdAt: r.created_at || '',
    updatedAt: r.updated_at || '',
    expiresAt: r.expires_at || '',
    paidAt: r.paid_at || '',
    // Canonical financial identifiers. Legacy rows read back blank; callers
    // fall back to orderCode for display and derive the type from context.
    transactionId: r.transaction_id || '',
    transactionType: r.transaction_type || (r.order_code ? 'PURCHASE' : ''),
    // Historical coupon snapshot (JSON string) — present only when the sold
    // coupon was removed from the inventory stores but its order remains.
    couponSnapshot: r.coupon_snapshot || '',
  };
}

function fromPayment(r) {
  if (!r || !r.payment_id) return null;
  return {
    paymentId: String(r.payment_id),
    orderId: r.order_id || '',
    userId: r.user_id || '',
    userEmail: r.user_email || '',
    couponId: r.coupon_id || '',
    amount: toNumber(r.amount),
    // The verified rupee total that actually arrived. Blank on a normal
    // exact-amount payment; set when the verifier recorded a mismatch
    // (over/underpayment). Kept null (not 0) when absent so callers can tell
    // "not recorded" apart from a genuine zero.
    receivedAmount:
      r.received_amount === '' || r.received_amount === undefined || r.received_amount === null
        ? null
        : toNumber(r.received_amount),
    currency: r.currency || 'INR',
    status: r.status || '',
    createdAt: r.created_at || '',
    updatedAt: r.updated_at || '',
    expiresAt: r.expires_at || '',
    // Backend checking deadline (20 min from creation). Empty on legacy rows;
    // callers fall back to expires_at via checkDeadline().
    checkExpiresAt: r.check_expires_at || '',
    // Two-timer verification fields. Blank until the customer timer ends.
    paymentExpiresAt: r.payment_expires_at || '',
    verificationStartedAt: r.verification_started_at || '',
    verificationDeadline: r.verification_deadline || '',
    lastCheckedAt: r.last_checked_at || '',
    paidAt: r.paid_at || '',
    upiId: r.upi_id || '',
    payeeName: r.payee_name || '',
    upiUri: r.upi_uri || '',
    verifiedTransactionId: r.verified_transaction_id || '',
    verifiedUtr: r.verified_utr || '',
    verificationSource: r.verification_source || '',
    verificationNotes: r.verification_notes || '',
  };
}

function fromNotification(r) {
  if (!r || !r.id) return null;
  let raw = null;
  if (r.raw) { try { raw = JSON.parse(r.raw); } catch (e) { raw = { text: String(r.raw) }; } }
  return {
    id: String(r.id),
    fingerprint: r.fingerprint || '',
    source: r.source || '',
    amount: r.amount === '' || r.amount === undefined || r.amount === null ? null : toNumber(r.amount),
    currency: r.currency || 'INR',
    transactionId: r.transaction_id || '',
    utr: r.utr || '',
    payerVpa: r.payer_vpa || '',
    payeeVpa: r.payee_vpa || '',
    reference: r.reference || '',
    occurredAt: r.occurred_at || '',
    status: r.status || '',
    matchedPaymentId: r.matched_payment_id || '',
    notes: r.notes || '',
    raw,
    createdAt: r.created_at || '',
    processedAt: r.processed_at || '',
  };
}

// ── Critical section ───────────────────────────────────────────────────────
// Serialises every state change inside this process. See the header for why
// this alone is not sufficient and what else backs it up.
//
// The lock is RE-ENTRANT: a function already running inside it (for example
// finalizePayment, which calls transitionPayment) runs inline instead of
// queueing behind itself. Without that, awaiting an inner locked helper from
// an outer locked helper would deadlock — the outer promise cannot settle
// until the inner one does, and the inner one is waiting for the outer to
// release. AsyncLocalStorage is what carries "I am already holding the lock"
// across the awaits.
const { AsyncLocalStorage } = require('async_hooks');

const _lockContext = new AsyncLocalStorage();
const LOCK_HELD = Symbol('savehatke.payment.lock');
let _lockChain = Promise.resolve();

function withLock(fn) {
  if (_lockContext.getStore() === LOCK_HELD) return fn(); // re-entrant

  const run = _lockChain.then(
    () => _lockContext.run(LOCK_HELD, fn),
    () => _lockContext.run(LOCK_HELD, fn)
  );
  // Keep the chain alive whether or not the caller's promise rejects.
  _lockChain = run.then(() => {}, () => {});
  return run;
}

// ── Availability ───────────────────────────────────────────────────────────

// Passed to the spreadsheet layer wherever money is at stake. A strict read
// asks the live sheet and throws on failure; a strict write is acknowledged by
// Sheets before this process believes it happened. Both refuse to fall back to
// the in-memory mirror, which is per-instance and disappears on restart.
const STRICT = { strict: true };

let _availability = null; // { ok, checkedAt, reason }

/**
 * Confirm the store is usable. Probed at most once a minute so a hot path
 * (/status, /stream) does not re-check on every request, and so the Sheets
 * client is only built once — initialize() re-creates the client and re-runs
 * ensureSheets() every call, which is far too expensive to do per request.
 */
async function ensureReady({ force = false } = {}) {
  if (!force && _availability && Date.now() - _availability.checkedAt < 60000) {
    return _availability;
  }

  if (!db.isSheetsConnected()) {
    try { await db.initialize(); } catch (e) { /* reported below */ }
  }

  if (!db.isSheetsConnected()) {
    _availability = {
      ok: false,
      checkedAt: Date.now(),
      reason:
        'Google Sheets is not connected, so payment records cannot be stored. Check GOOGLE_SHEETS_SPREADSHEET_ID and the service-account credentials.',
    };
    return _availability;
  }

  try {
    // A fresh read of the Payments tab proves both the connection and that the
    // tab exists (ensureSheets creates it on initialize).
    await db.getRowsFresh(PAYMENTS);
    _availability = { ok: true, checkedAt: Date.now(), reason: '' };
  } catch (err) {
    _availability = {
      ok: false,
      checkedAt: Date.now(),
      reason: 'The Payments tab could not be read from the spreadsheet. (' + err.message + ')',
    };
  }
  return _availability;
}

/** Credentials are present (static check — does not touch the network). */
function isConfigured() {
  return Boolean(process.env.GOOGLE_SHEETS_SPREADSHEET_ID);
}

/**
 * Fail-closed availability gate for a write that is about to become
 * irreversible (see finalizePayment).
 *
 * Deliberately NOT the cached ensureReady() probe: that one is allowed to fall
 * back to a previous verdict for a minute so a hot read path stays cheap, and
 * it must therefore never gate a settlement. This one always asks the live
 * spreadsheet and throws on any failure, so the caller refuses the settlement
 * instead of recording it in process memory only.
 *
 * Throws an Error with a caller-safe message; nothing internal is exposed.
 */
async function ensureReadyOrThrow() {
  if (!db.isSheetsConnected()) {
    try { await db.initialize(); } catch (e) { /* handled by the strict read */ }
  }
  // Strict + fresh: bypasses the read cache and refuses the in-memory fallback.
  await db.getRowsFresh(PAYMENTS, STRICT);
  // The Orders tab is the second half of every settlement write.
  await db.getRowsFresh(ORDERS, STRICT);
}

// ── Identifiers ────────────────────────────────────────────────────────────

// Ambiguous glyphs (0/O, 1/I/L) removed so an order code can be read aloud
// over support without a transcription mistake.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function shortCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function newOrderCode() {
  // Canonical Order ID for a purchase: SH-PUR-YYYYMMDD-XXXXXX.
  // (Uniqueness is enforced by the caller against the rows in the sheet.)
  return ids.makeOrderId('PURCHASE');
}

function newPaymentId() {
  return 'pay_' + crypto.randomBytes(16).toString('hex');
}

// ── Reads ──────────────────────────────────────────────────────────────────

const rowsFresh = (sheet, options) => db.getRowsFresh(sheet, options);
const rowsCached = (sheet) => db.getRows(sheet);

// Financial reads used for settlement decisions. Strict + fresh: they ask the
// live spreadsheet, bypass the read cache, and refuse the in-memory fallback,
// so a Sheets outage is an error rather than a plausible-looking empty ledger.
const rowsStrict = (sheet) => db.getRowsFresh(sheet, STRICT);

async function findOrderById(orderId) {
  const rows = await rowsCached(ORDERS);
  return fromOrder(rows.find((r) => String(r.id) === String(orderId)));
}

async function findOrderByCode(orderCode) {
  const rows = await rowsCached(ORDERS);
  return fromOrder(rows.find((r) => String(r.order_code).toUpperCase() === String(orderCode).toUpperCase()));
}

async function findPaymentById(paymentId) {
  const rows = await rowsCached(PAYMENTS);
  return fromPayment(rows.find((r) => String(r.payment_id) === String(paymentId)));
}

/** The current live (PENDING) payment for an order, if any. */
async function findLivePaymentForOrder(orderId) {
  const rows = await rowsCached(PAYMENTS);
  return fromPayment(rows.find((r) => String(r.order_id) === String(orderId) && r.status === 'PENDING'));
}

/** The most recent payment for an order regardless of status. */
async function findLatestPaymentForOrder(orderId) {
  const rows = await rowsCached(PAYMENTS);
  const mine = rows.filter((r) => String(r.order_id) === String(orderId));
  if (!mine.length) return null;
  mine.sort((a, b) => toTime(b.created_at) - toTime(a.created_at));
  return fromPayment(mine[0]);
}

/**
 * Another live payment owned by this user for this same coupon.
 * Stops one buyer from holding two 10-minute windows on one coupon (which
 * would double-book it if both were paid).
 */
async function findLivePaymentForUserCoupon(userId, couponId) {
  const rows = await rowsCached(PAYMENTS);
  const mine = rows.filter((r) =>
    r.status === 'PENDING' &&
    String(r.user_id) === String(userId) &&
    String(r.coupon_id) === String(couponId));
  if (!mine.length) return null;
  mine.sort((a, b) => toTime(b.created_at) - toTime(a.created_at));
  return fromPayment(mine[0]);
}

/**
 * A live payment owned by this user for the same amount and NO coupon.
 *
 * Coupon-less payments cannot reuse findLivePaymentForUserCoupon: an empty
 * coupon_id matches every other coupon-less row for that user, so two
 * unrelated "pay ₹X" intents would collapse into one. Matching on the amount
 * too keeps the reuse correct — a second click for the same amount resumes
 * the existing window instead of opening a competing one, while a different
 * amount gets its own.
 */
async function findLiveOpenPayment(userId, amount) {
  const rows = await rowsCached(PAYMENTS);
  const mine = rows.filter((r) =>
    r.status === 'PENDING' &&
    String(r.user_id) === String(userId) &&
    !String(r.coupon_id || '') &&
    moneyEquals(r.amount, amount));
  if (!mine.length) return null;
  mine.sort((a, b) => toTime(b.created_at) - toTime(a.created_at));
  return fromPayment(mine[0]);
}

/** True when this transaction id / UTR already settled some payment. */
async function isTransactionUsed({ transactionId = '', utr = '' } = {}) {
  if (!transactionId && !utr) return false;
  const rows = await rowsFresh(PAYMENTS);
  return rows.some((r) =>
    r.status === 'PAID' &&
    ((transactionId && r.verified_transaction_id === transactionId) ||
     (utr && r.verified_utr === utr)));
}

/** The PAID payment that carries this transaction id / UTR, if any. */
async function findPaymentByTransaction(transactionId, utr = '') {
  if (!transactionId && !utr) return null;
  const rows = await rowsFresh(PAYMENTS);
  return fromPayment(rows.find((r) =>
    r.status === 'PAID' &&
    ((transactionId && r.verified_transaction_id === transactionId) ||
     (utr && r.verified_utr === utr))));
}

/**
 * A PAID payment by this buyer for this coupon, if one exists.
 * Lets a refresh after a successful payment land on the success state instead
 * of a dead end, and lets /create report "already paid" rather than refusing.
 */
async function findPaidPaymentForBuyer({ userId = '', userEmail = '', couponId } = {}) {
  const rows = await rowsFresh(PAYMENTS);
  const mine = rows
    .filter((r) => r.status === 'PAID' && String(r.coupon_id) === String(couponId))
    .filter((r) =>
      (userId && String(r.user_id) === String(userId)) ||
      (userEmail && String(r.user_email || '').toLowerCase() === String(userEmail).toLowerCase()))
    .sort((a, b) => toTime(b.created_at) - toTime(a.created_at));
  return fromPayment(mine[0]);
}

/**
 * Live payments still inside their BACKEND checking window (check_expires_at,
 * 6h by default), joined with the order code the confirmation will quote back.
 * Pass an amount to narrow to that exact figure (the common case: we only care
 * about money we are currently waiting on).
 *
 * Note: this deliberately spans the 6-hour backend window, NOT the 10-minute
 * frontend timer — a buyer who pays shortly after the on-screen countdown hit
 * 0:00 is still matched and settled. Only a payment past the 6h deadline (or a
 * superseded/cancelled window) is excluded.
 */
async function findPendingPaymentsForAmount(amount = null, { limit = 200 } = {}) {
  const now = Date.now();
  const [payments, orders] = await Promise.all([rowsFresh(PAYMENTS), rowsCached(ORDERS)]);

  const orderById = new Map(orders.map((o) => [String(o.id), o]));

  return payments
    .filter((r) => r.status === 'PENDING' && checkDeadline(r) > now)
    .filter((r) => (amount === null || amount === undefined ? true : moneyEquals(r.amount, amount)))
    .sort((a, b) => toTime(b.created_at) - toTime(a.created_at))
    .slice(0, limit)
    .map((r) => {
      const p = fromPayment(r);
      const o = orderById.get(String(p.orderId)) || {};
      return {
        ...p,
        orderCode: o.order_code || '',
        buyerName: o.buyer_name || '',
        couponCode: o.coupon_code || '',
        couponBrand: o.coupon_brand || '',
      };
    });
}

/**
 * Look up one pending payment by the order code embedded in the UPI
 * transaction's `tr` field. This is the lookup the verifier uses when a
 * notification's verified amount does NOT equal the payment's required
 * amount — the order code is the only thing that ties the mismatch back
 * to the original payment. Returns the same row shape as
 * findPendingPaymentsForAmount (with orderCode / couponCode / couponBrand
 * attached), or null if no live payment matches.
 */
/**
 * Sessions a late FamApp credit could still belong to: the customer timer has
 * ended, the persisted verification deadline has NOT passed yet (so they are
 * "late-eligible" only after it passes), and the purchase was never fulfilled.
 * Returned rows carry their persisted deadlines; the decision uses those, not
 * the email arrival time.
 */
async function findLateCandidatePayments({ limit = 200 } = {}) {
  const [payments, orders] = await Promise.all([rowsFresh(PAYMENTS), rowsCached(ORDERS)]);
  const orderById = new Map(orders.map((o) => [String(o.id), o]));
  return payments
    .filter((r) => r.status === 'PENDING' || r.status === 'EXPIRED' || r.status === 'CANCELLED')
    .filter((r) => r.verification_deadline || r.payment_expires_at || r.expires_at)
    .slice(0, limit)
    .map((r) => {
      const p = fromPayment(r);
      const o = orderById.get(String(p.orderId)) || {};
      return {
        ...p,
        orderCode: o.order_code || '',
        buyerName: o.buyer_name || '',
        couponCode: o.coupon_code || '',
        couponBrand: o.coupon_brand || '',
      };
    });
}

/**
 * Stamp every PENDING session whose customer timer has ended, using only the
 * server clock and the persisted row. Idempotent: stampVerificationWindow never
 * moves an existing deadline. Safe to run after a restart because state lives
 * in Sheets, not memory.
 */
async function stampDueVerificationWindows(nowMs = Date.now()) {
  const rows = await rowsFresh(PAYMENTS);
  const due = rows.filter((r) => r.status === 'PENDING' && !r.payment_expires_at && r.expires_at && toTime(r.expires_at) <= nowMs);
  let stamped = 0;
  for (const row of due) {
    try {
      const out = await stampVerificationWindow(row.payment_id, nowMs);
      if (out) stamped++;
    } catch (e) {
      console.warn('[paymentStore] stamp failed for', row.payment_id, e.message);
    }
  }
  return { stamped, scanned: due.length };
}

async function findPendingPaymentByOrderCode(orderCode) {
  if (!orderCode) return null;
  const code = String(orderCode).toUpperCase();
  const candidates = await findPendingPaymentsForAmount(null, { limit: 500 });
  return candidates.find((p) => String(p.orderCode || '').toUpperCase() === code) || null;
}

// ── Writes ─────────────────────────────────────────────────────────────────

async function createOrder({
  userId,
  userEmail,
  couponId,
  amount,
  buyerName = '',
  buyerEmail = '',
  buyerPhone = '',
  couponCode = '',
  couponBrand = '',
  expiresAt = null,
}) {
  const now = new Date().toISOString();

  // Mint the canonical identifiers SERVER-SIDE and enforce uniqueness against
  // the codes actually in the sheet (Sheets has no unique constraint, so this
  // pre-check + the huge random space is the guarantee). The date part is
  // derived from `now` so the id's embedded date matches the row's created_at.
  //   order_code      SH-PUR-YYYYMMDD-XXXXXX  (the human Order ID)
  //   transaction_id  TXN-YYYYMMDD-XXXXXXXX   (separate financial-txn id)
  const existing = await rowsStrict(ORDERS);
  const takenCodes = new Set(existing.map((r) => String(r.order_code)));
  const takenTxns = new Set(existing.map((r) => String(r.transaction_id)).filter(Boolean));

  const orderCode = ids.generateUniqueOrderIdSync('PURCHASE', takenCodes, { date: now });
  const transactionId = ids.generateUniqueTransactionIdSync(takenTxns, { date: now });

  const row = {
    id: crypto.randomUUID(),
    order_code: orderCode,
    user_id: String(userId),
    user_email: userEmail,
    coupon_id: String(couponId),
    amount: money2(amount),
    currency: 'INR',
    status: 'PENDING',
    buyer_name: buyerName,
    buyer_email: buyerEmail,
    buyer_phone: buyerPhone,
    coupon_code: couponCode,
    coupon_brand: couponBrand,
    created_at: now,
    updated_at: now,
    expires_at: expiresAt || '',
    paid_at: '',
    transaction_id: transactionId,
    transaction_type: 'PURCHASE',
  };

  // Strict: an order that only exists in this instance's memory is not an
  // order. The buyer would be shown a UPI QR for something the ledger has
  // never heard of, and their payment could never be matched.
  await db.appendRow(ORDERS, row, STRICT);
  return fromOrder(row);
}

/**
 * Create a payment row.
 *
 * There is no unique index to lean on, so the "one live payment per order /
 * per buyer+coupon" rule is enforced by a fresh pre-check here plus a
 * post-write verification. A loser of the race gets an error carrying
 * `code: 'CONFLICT'` (mirroring the Postgres 23505 the callers used to see)
 * so the route reuses the winner instead of surfacing a failure.
 */
async function createPayment({
  orderId,
  userId,
  userEmail,
  couponId,
  amount,
  expiresAt,
  checkExpiresAt = '',
  upiId,
  payeeName,
  upiUri,
  paymentId,
}) {
  const id = paymentId || newPaymentId();
  const now = new Date().toISOString();

  const conflict = (constraint) => {
    const e = new Error(`A live payment already exists for this ${constraint}.`);
    e.code = 'CONFLICT';
    e.constraint = constraint;
    return e;
  };

  return withLock(async () => {
    const existing = await rowsStrict(PAYMENTS);
    const liveForOrder = existing.find((r) => r.status === 'PENDING' && String(r.order_id) === String(orderId));
    if (liveForOrder) throw conflict('order');

    const liveForBuyer = existing.find((r) =>
      r.status === 'PENDING' &&
      String(r.user_id) === String(userId) &&
      String(r.coupon_id) === String(couponId));
    if (liveForBuyer) throw conflict('buyer+coupon');

    const row = {
      payment_id: id,
      order_id: orderId,
      user_id: String(userId),
      user_email: userEmail,
      coupon_id: String(couponId),
      amount: money2(amount),
      currency: 'INR',
      status: 'PENDING',
      created_at: now,
      updated_at: now,
      expires_at: expiresAt,
      check_expires_at: checkExpiresAt || '',
      paid_at: '',
      upi_id: upiId,
      payee_name: payeeName,
      upi_uri: upiUri,
      verified_transaction_id: '',
      verified_utr: '',
      verification_source: '',
      verification_notes: '',
    };

    await db.appendRow(PAYMENTS, row, STRICT);

    // Confirm the row landed and that we did not end up with two live rows.
    const after = await rowsStrict(PAYMENTS);
    const mine = after.filter((r) => String(r.payment_id) === String(id));
    if (!mine.length) {
      const e = new Error('The payment row could not be confirmed after it was written.');
      e.code = 'WRITE_UNCONFIRMED';
      throw e;
    }

    const live = after.filter((r) =>
      r.status === 'PENDING' &&
      (String(r.order_id) === String(orderId) ||
       (String(r.user_id) === String(userId) && String(r.coupon_id) === String(couponId))));
    if (live.length > 1) {
      // Self-heal: keep the oldest (the one whose expires_at the buyer may
      // already have seen) and retire the rest, so the coupon cannot be
      // double-booked by a duplicate window.
      const [keep, ...extras] = live.sort((a, b) => toTime(a.created_at) - toTime(b.created_at));
      for (const extra of extras) {
        try {
          await db.updateRow(PAYMENTS, 'payment_id', extra.payment_id, {
            status: 'CANCELLED',
            updated_at: new Date().toISOString(),
            verification_notes: 'Retired automatically: a duplicate live payment window was detected.',
          }, STRICT);
        } catch (e) { /* best effort */ }
      }
      if (String(keep.payment_id) !== String(id)) throw conflict('order');
    }

    return fromPayment(row);
  });
}

/**
 * Compare-and-set a payment's status. Returns the updated row, or null when
 * another caller already moved it out of `fromStatus` (the caller should then
 * re-read and report the current truth).
 *
 * Because Sheets cannot do this atomically, the write is bracketed by two
 * reads: the row must still be in `fromStatus` before the update, and must
 * actually read back as `toStatus` afterwards.
 */
async function transitionPayment(paymentId, fromStatus, toStatus, extra = {}) {
  return withLock(async () => {
    const before = await rowsStrict(PAYMENTS);
    const current = before.find((r) => String(r.payment_id) === String(paymentId));
    if (!current || current.status !== fromStatus) return null;

    const patch = { status: toStatus, updated_at: new Date().toISOString(), ...extra };
    // Strict: Sheets must acknowledge the status change. A non-strict write
    // returns "success" from an in-memory mirror during an outage, and the
    // read-back below would then confirm a change that never reached the ledger.
    await db.updateRow(PAYMENTS, 'payment_id', paymentId, patch, STRICT);

    const after = await rowsStrict(PAYMENTS);
    const written = after.find((r) => String(r.payment_id) === String(paymentId));
    if (!written || written.status !== toStatus) return null; // lost the race
    return fromPayment(written);
  });
}

/**
 * Stamp the two-timer fields when the customer's 10-minute timer ends. Written
 * once: the row must still have an empty payment_expires_at, so a repeated call
 * (the browser, the pinger, or a restart) never moves the deadline. Returns the
 * stamped payment, or null when it was already stamped or is no longer PENDING.
 * The instant is taken from the server clock, never from the browser.
 */
async function stampVerificationWindow(paymentId, nowMs = Date.now()) {
  return withLock(async () => {
    const rows = await rowsStrict(PAYMENTS);
    const current = rows.find((r) => String(r.payment_id) === String(paymentId));
    if (!current || current.status !== 'PENDING') return null;
    if (current.payment_expires_at) return null; // already stamped — never move it

    const expiresIso = current.expires_at ? new Date(current.expires_at).toISOString() : null;
    const expiryMs = expiresIso ? new Date(expiresIso).getTime() : NaN;
    // Only stamp once the customer timer has really ended on the server clock.
    if (!Number.isFinite(expiryMs) || nowMs < expiryMs) return null;

    const paymentExpiresAt = new Date(expiryMs).toISOString();
    const verificationStartedAt = paymentExpiresAt;
    const verificationDeadline = new Date(expiryMs + 10 * 60 * 1000).toISOString();
    const nowIso = new Date(nowMs).toISOString();

    await db.updateRow(PAYMENTS, 'payment_id', paymentId, {
      payment_expires_at: paymentExpiresAt,
      verification_started_at: verificationStartedAt,
      verification_deadline: verificationDeadline,
      last_checked_at: nowIso,
      updated_at: nowIso,
    }, STRICT);

    const after = await rowsStrict(PAYMENTS);
    const written = after.find((r) => String(r.payment_id) === String(paymentId));
    if (!written || !written.payment_expires_at) return null;
    return fromPayment(written);
  });
}

async function transitionOrder(orderId, fromStatus, toStatus, extra = {}) {
  return withLock(async () => {
    const before = await rowsStrict(ORDERS);
    const current = before.find((r) => String(r.id) === String(orderId));
    if (!current || current.status !== fromStatus) return null;

    const patch = { status: toStatus, updated_at: new Date().toISOString(), ...extra };
    await db.updateRow(ORDERS, 'id', orderId, patch, STRICT);

    const after = await rowsStrict(ORDERS);
    const written = after.find((r) => String(r.id) === String(orderId));
    if (!written || written.status !== toStatus) return null;
    return fromOrder(written);
  });
}

/**
 * Expire a payment (and its order) if it is still PENDING and past its
 * deadline. The deadline is compared against the server's own clock, so a
 * drifting client cannot expire a payment early.
 *
 * The coupon reservation is released here (ownership-checked), which makes the
 * coupon visible again in the public listings once the 20-minute backend
 * window closes with no payment.
 */
async function expireIfDue(paymentId, { now = new Date().toISOString() } = {}) {
  const current = await findPaymentById(paymentId);
  if (!current || current.status !== 'PENDING') return null;
  // Only retire once the BACKEND checking window (20 min) has closed — NOT at
  // the 10-minute frontend timer. Until then the payment stays PENDING so a
  // late credit can still settle it.
  if (checkDeadline(current) > toTime(now)) return null;

  const expired = await transitionPayment(paymentId, 'PENDING', 'EXPIRED', { updated_at: now });
  if (expired) {
    await transitionOrder(expired.orderId, 'PENDING', 'EXPIRED', { updated_at: now });
    console.log(`[PAYMENT_SESSION] backend expiry reached sessionId=${paymentId} verification stopped`);
    if (expired.couponId) {
      await releaseCouponReservation({ couponId: expired.couponId, paymentId }).catch(() => {});
    }
  }
  return expired;
}

/** Cancel a payment. Only a PENDING one can be cancelled. */
async function cancelPayment(paymentId, { reason = 'Cancelled by buyer' } = {}) {
  const now = new Date().toISOString();
  const cancelled = await transitionPayment(paymentId, 'PENDING', 'CANCELLED', {
    verification_notes: reason,
    updated_at: now,
  });
  if (cancelled) {
    await transitionOrder(cancelled.orderId, 'PENDING', 'CANCELLED', { updated_at: now });
    if (cancelled.couponId) {
      await releaseCouponReservation({ couponId: cancelled.couponId, paymentId }).catch(() => {});
    }
  }
  return cancelled;
}

// ── Coupon unlock — the one atomic step ────────────────────────────────────

/**
 * Flip the coupon to sold, but ONLY if it is still available.
 *
 * This is a single conditional UPDATE in Postgres (`WHERE id = ? AND status =
 * 'available'`), which the database serialises for us. That is what makes the
 * unlock exactly-once: two concurrent settlements cannot both affect a row,
 * so the coupon can never be handed to two buyers. Do not "simplify" this
 * into a read-then-write — that is the whole guarantee.
 *
 * Returns { unlocked, code, status, buyerEmail }.
 */
async function unlockCoupon({ couponId, userEmail, paidAt, paymentId }) {
  const client = supabase.isConfigured() ? supabase.getClient() : null;
  // A read-then-write in Google Sheets cannot reserve a coupon safely across
  // Vercel instances. Never settle or reveal a coupon unless Postgres can
  // perform the conditional UPDATE atomically.
  if (!client) throw new Error('Atomic coupon storage is required to settle payments.');

  const { data, error } = await client
    .from('coupons')
    .update({ status: 'sold', sold_at: paidAt, buyer_email: userEmail, sold_payment_id: paymentId })
    .eq('id', String(couponId))
    .eq('status', 'available')
    .select('id, code, status, buyer_email, sold_payment_id');

  if (error) throw new Error('Atomic coupon update failed.');
  const row = (data || [])[0];
  if (row) return { unlocked: true, code: row.code || '', status: 'sold', buyerEmail: userEmail, soldPaymentId: row.sold_payment_id || '' };

  // 0 rows affected: it was not available. Read it back to find out why —
  // already sold to this same buyer is idempotent only for this same order,
  // guarded by finalizePayment's duplicate-paid check.
  const { data: cur, error: readErr } = await client
    .from('coupons')
    .select('id, code, status, buyer_email, sold_payment_id')
    .eq('id', String(couponId))
    .maybeSingle();
  if (readErr) throw new Error('Could not confirm coupon state.');
  return {
    unlocked: false,
    code: (cur && cur.code) || '',
    status: (cur && cur.status) || '',
    buyerEmail: (cur && cur.buyer_email) || '',
    soldPaymentId: (cur && cur.sold_payment_id) || '',
  };
}

/**
 * Settle a verified payment: payment → PAID, order → PAID, coupon unlocked.
 *
 * The whole settlement runs inside the process lock, and the coupon flip is
 * the database-serialised step described in unlockCoupon().
 *
 * Safe to call repeatedly with the same confirmation: an already-PAID payment
 * returns ok:true with idempotent:true and does not unlock twice.
 *
 * Verdict codes mirror the finalize_payment() SQL function that used to do
 * this, so the verifier and routes read the same way they always did.
 */
async function finalizePayment({
  paymentId,
  transactionId = null,
  utr = null,
  source = '',
  notes = '',
  paidAt = null,
  raw = null,
  // The verified rupee total the gateway or mailbox reported. Persisted on
  // the Payments row so the refund service can see what actually arrived
  // versus what was required. Defaults to the payment's required amount
  // when callers don't supply it.
  receivedAmount = null,
}) {
  return withLock(async () => {
    // ─ Fail-closed pre-flight ──────────────────────────────────────────────
    // Settlement makes ONE durable write that cannot be rolled back: the
    // Postgres coupon flip in unlockCoupon() below marks the coupon sold. The
    // ledger that records PAID lives in the spreadsheet, so if the spreadsheet
    // is unreachable we must refuse BEFORE touching the coupon. Without this
    // check a Sheets outage would flip the coupon to 'sold', write PAID only
    // into this process's memory, release the code to the buyer and email a
    // receipt — for a payment row that no longer exists after a restart.
    //
    // The strict read throws when the spreadsheet cannot be read, and callers
    // (services/paymentVerifier.js) turn that into a structured refusal.
    await ensureReadyOrThrow();

    const rows = await rowsFresh(PAYMENTS, STRICT);
    const found = rows.find((r) => String(r.payment_id) === String(paymentId));
    if (!found) return { ok: false, code: 'PAYMENT_NOT_FOUND' };

    const payment = fromPayment(found);
    const settledAt = paidAt || new Date().toISOString();

    // Already settled: repeat the original answer. This is what makes a
    // duplicate webhook / re-run of the verifier a no-op.
    if (payment.status === 'PAID') {
      const coupon = await readCoupon(payment.couponId);
      return {
        ok: true, code: 'ALREADY_PAID', payment_status: 'PAID',
        coupon_code: (coupon && coupon.code) || '', idempotent: true,
      };
    }

    // Only a live attempt can be settled. EXPIRED / CANCELLED / REVIEW are final.
    if (payment.status !== 'PENDING') {
      return { ok: false, code: 'PAYMENT_NOT_PENDING', payment_status: payment.status };
    }

    // A second successful payment for the same buyer/coupon must not be
    // treated as an idempotent coupon reveal. Park it for explicit refund or
    // support handling, with no code returned for the duplicate order.
    const sameBuyerPaid = rows.find((r) =>
      String(r.payment_id) !== String(paymentId) &&
      r.status === 'PAID' &&
      String(r.coupon_id) === String(payment.couponId) &&
      ((payment.userId && String(r.user_id) === String(payment.userId)) ||
        (payment.userEmail && String(r.user_email).toLowerCase() === String(payment.userEmail).toLowerCase())));
    if (sameBuyerPaid) {
      await transitionPayment(paymentId, 'PENDING', 'REVIEW', {
        verification_source: source,
        verification_notes: (notes ? notes + ' ' : '') + 'Duplicate paid order for this buyer and coupon; held for refund review.',
        updated_at: settledAt,
      });
      await transitionOrder(payment.orderId, 'PENDING', 'REVIEW', { updated_at: settledAt });
      return { ok: false, code: 'DUPLICATE_PURCHASE', payment_status: 'REVIEW' };
    }

    // Replay guard: is this txn / UTR already attached to a different settled
    // payment? (Belt and braces — the verifier checks this too.)
    const txn = transactionId || '';
    const reference = utr || '';
    if (txn || reference) {
      const clash = rows.find((r) =>
        String(r.payment_id) !== String(paymentId) &&
        r.status === 'PAID' &&
        ((txn && r.verified_transaction_id === txn) || (reference && r.verified_utr === reference)));
      if (clash) {
        return {
          ok: false, code: 'REPLAY_DETECTED', payment_status: payment.status,
          conflict_payment_id: clash.payment_id,
        };
      }
    }

    // Settlement window: a confirmation that claims to have happened before the
    // request was raised or after the backend verification deadline is not this
    // payment. The deadline is the 20-minute backend window (check_expires_at,
    // = created + 20 min) — never the 10-minute on-screen timer. Rows written
    // before that column existed keep their legacy expires_at + 30 min grace.
    const at = toTime(settledAt);
    const explicitCheck = payment.checkExpiresAt || '';
    const settleDeadline = explicitCheck
      ? toTime(explicitCheck)
      : toTime(payment.expiresAt) + 30 * 60 * 1000;
    if (at && ((at < toTime(payment.createdAt) - 5 * 60 * 1000) || (at > settleDeadline))) {
      return { ok: false, code: 'OUTSIDE_WINDOW', payment_status: payment.status };
    }

    // ─ The coupon flip is the gate: do it first, and only record PAID if it
    //   actually happened. That way a payment is never marked PAID for a
    //   coupon this buyer did not receive.
    const unlock = await unlockCoupon({
      couponId: payment.couponId,
      userEmail: payment.userEmail,
      paidAt: settledAt,
      paymentId: payment.paymentId,
    });

    if (!unlock.unlocked) {
      const sameBuyer = String(unlock.buyerEmail || '').toLowerCase() === String(payment.userEmail || '').toLowerCase();
      if (String(unlock.status).toLowerCase() === 'sold' && sameBuyer && String(unlock.soldPaymentId) === String(payment.paymentId)) {
        // Already sold to this same buyer — a successful, idempotent unlock.
        await markPaid({ payment, txn, reference, source, notes, settledAt, receivedAmount });
        return {
          ok: true, code: 'OK_ALREADY_UNLOCKED', payment_status: 'PAID',
          coupon_code: unlock.code || '', idempotent: true,
        };
      }

      // Someone else holds the coupon (or it vanished). Park it for a human
      // rather than silently unlocking a coupon nobody paid for.
      await transitionPayment(paymentId, 'PENDING', 'REVIEW', {
        verification_source: source,
        verification_notes:
          (notes ? notes + ' ' : '') +
          `Coupon ${payment.couponId} could not be unlocked (status: ${unlock.status || 'missing'}).`,
        updated_at: settledAt,
      });
      await transitionOrder(payment.orderId, 'PENDING', 'REVIEW', { updated_at: settledAt });
      return {
        ok: false, code: 'COUPON_UNAVAILABLE', payment_status: 'REVIEW',
        coupon_status: unlock.status || '',
      };
    }

    await markPaid({ payment, txn, reference, source, notes, settledAt, receivedAmount });
    return { ok: true, code: 'OK', payment_status: 'PAID', coupon_code: unlock.code || '' };
  });
}

/**
 * Record an underpayment on a pending payment WITHOUT unlocking the coupon.
 *
 * The order-code mismatch path uses this when the verified received amount
 * is below the required amount. The payment moves PENDING → REVIEW; the
 * coupon stays locked (so the buyer can retry, or another buyer can take
 * the listing); the refund service still writes its underpayment row so the
 * full received amount is returned to the buyer.
 *
 * Idempotent: a second call on a row that's already REVIEW/underpaid is a
 * no-op (returns the original answer with idempotent:true).
 *
 * Never unlocks the coupon. Never marks PAID. The dashboard surfaces the
 * refund record + the REVIEW notes for admin processing.
 */
async function finalizeUnderpayment({
  paymentId,
  transactionId = null,
  utr = null,
  source = '',
  notes = '',
  paidAt = null,
  raw = null,
  receivedAmount = null,
}) {
  return withLock(async () => {
    const rows = await rowsFresh(PAYMENTS);
    const found = rows.find((r) => String(r.payment_id) === String(paymentId));
    if (!found) return { ok: false, code: 'PAYMENT_NOT_FOUND' };

    const payment = fromPayment(found);
    const occurredAt = paidAt || new Date().toISOString();

    // Idempotent: if this payment is already parked in REVIEW by an earlier
    // underpayment settlement, repeat the original verdict. Keeps a redelivered
    // webhook / re-run of the verifier from rewriting notes or double-writing.
    if (payment.status === 'REVIEW') {
      return {
        ok: true, code: 'UNDERPAYMENT_ALREADY_RECORDED', payment_status: 'REVIEW',
        idempotent: true,
      };
    }

    // Only a PENDING payment can be parked for underpayment. EXPIRED /
    // CANCELLED / PAID are all final.
    if (payment.status !== 'PENDING') {
      return { ok: false, code: 'PAYMENT_NOT_PENDING', payment_status: payment.status };
    }

    const patch = {
      status: 'REVIEW',
      received_amount: money2(receivedAmount !== null && receivedAmount !== undefined ? receivedAmount : payment.amount),
      verified_transaction_id: transactionId || '',
      verified_utr: utr || '',
      verification_source: source || '',
      verification_notes:
        (notes ? notes + ' ' : '') +
        `Underpayment: required ${money2(payment.amount)}, received ${money2(receivedAmount)}. Coupon NOT unlocked; refund record created for full received amount.`,
      updated_at: occurredAt,
    };
    await db.updateRow(PAYMENTS, 'payment_id', payment.paymentId, patch, STRICT);
    // Order mirrors the payment so the listing stays available (coupon still
    // locked) while admin processes the refund.
    await db.updateRow(ORDERS, 'id', payment.orderId, {
      status: 'REVIEW',
      updated_at: occurredAt,
    }, STRICT);
    // The buyer is getting a refund and there is no live session left; hand the
    // coupon's visibility back to the marketplace (best-effort).
    if (payment.couponId) {
      try { await releaseCouponReservation({ couponId: payment.couponId, paymentId: payment.paymentId }); } catch (e) {}
    }

    return { ok: true, code: 'UNDERPAYMENT_RECORDED', payment_status: 'REVIEW' };
  });
}

/** Write the PAID state onto the payment and its order. */
async function markPaid({ payment, txn, reference, source, notes, settledAt, receivedAmount }) {
  const patch = {
    status: 'PAID',
    paid_at: settledAt,
    updated_at: new Date().toISOString(),
    verified_transaction_id: txn || '',
    verified_utr: reference || '',
    verification_source: source || '',
    verification_notes: notes || '',
  };
  // The verifier passes the verified amount it extracted from the
  // notification/webhook; persisting it on the row lets the refund
  // service and any later audit reconstruct the mismatch without
  // re-reading the notification. Default to the required amount when
  // callers don't pass it (legacy exact-amount callers).
  if (receivedAmount !== undefined && receivedAmount !== null) {
    patch.received_amount = money2(receivedAmount);
  }
  // Strict writes: the ledger must acknowledge PAID before this returns. If
  // either write fails the caller sees the throw, flags the notification for
  // review and never reports a settlement — which is the correct outcome, since
  // the coupon flip that has already happened is visible to an admin, whereas a
  // PAID row that exists only in this process's memory is not.
  await db.updateRow(PAYMENTS, 'payment_id', payment.paymentId, patch, STRICT);
  await db.updateRow(ORDERS, 'id', payment.orderId, {
    status: 'PAID',
    paid_at: settledAt,
    updated_at: new Date().toISOString(),
  }, STRICT);
  console.log(`[PAYMENT_STATUS] sessionId=${payment.paymentId} status=PAID`);
  // The sale itself removes the coupon from every listing; dropping the
  // reservation row fields keeps the record clean. Best-effort: the sold flip
  // above is the authoritative state change and must not be undermined if the
  // reservation schema is missing.
  if (payment.couponId) {
    try { await releaseCouponReservation({ couponId: payment.couponId, paymentId: payment.paymentId }); } catch (e) {}
  }
}

async function readCoupon(couponId) {
  const client = supabase.isConfigured() ? supabase.getClient() : null;
  if (client) {
    try {
      const { data } = await client.from('coupons').select('id, code, status, buyer_email, sold_payment_id').eq('id', String(couponId)).maybeSingle();
      if (data) return {
        id: data.id, code: data.code || '', status: data.status || '',
        buyerEmail: data.buyer_email || '', soldPaymentId: data.sold_payment_id || '',
      };
    } catch (e) { /* fall through to the sheet */ }
  }
  const fresh = await db.findRowsFresh(db.SHEETS.COUPONS, 'id', String(couponId));
  const c = (fresh || [])[0];
  return c ? {
    id: c.id, code: c.code || '', status: c.status || '',
    buyerEmail: c.buyer_email || '', soldPaymentId: c.sold_payment_id || '',
  } : null;
}

// ── Coupon reservation — hide a listed coupon while its payment window is open ──
//
// A coupon under an active payment session must disappear from the
// marketplace/index listings for the FULL backend session (20 minutes), not
// just the 10-minute on-screen timer. Reservations are stored ON THE COUPON ROW
// (reserved_until / reserved_payment_id / reserved_by — see
// setup_coupon_reservation.sql) and every write is a single conditional UPDATE
// in Postgres, so two buyers racing for the same coupon are serialised by the
// database exactly like the sold-flip in unlockCoupon().
//
// The coupon's `status` deliberately stays 'available' while reserved — the
// sold-flip's `WHERE status = 'available'` precondition keeps working and no
// existing reader has to learn a new status. Listings hide reserved coupons by
// filtering `reserved_until` (see supabase.getCoupons excludeReserved), and a
// lapsed reservation simply drops out of that filter on its own — visibility is
// restored by the timestamp, not by a background job.
//
// Every helper here is BEST-EFFORT: until setup_coupon_reservation.sql has been
// applied the columns don't exist, the writes fail, and the payment flow
// continues unreserved (as it behaved before). A reservation problem must never
// break a legitimate purchase or a settlement.

/**
 * Atomically reserve a coupon for one payment session.
 *
 * The conditional UPDATE wins only when the coupon is still available AND
 * (no active reservation OR the reservation already belongs to this payment
 * or this buyer — which is what lets the same buyer refresh or reopen their
 * own window). Two different buyers racing get exactly one winner.
 *
 * Returns { ok:true } when THIS payment owns the reservation, { ok:false }
 * when somebody else holds it, and throws on storage/schema problems.
 */
async function reserveCouponForPayment({ couponId, userId, userEmail, paymentId, until }) {
  const client = supabase.isConfigured() ? supabase.getClient() : null;
  if (!client) throw new Error('Atomic coupon storage is required to reserve coupons.');
  if (!couponId || !paymentId) throw new Error('couponId and paymentId are required.');

  const nowIso = new Date().toISOString();
  const untilIso = until || new Date(Date.now() + PAYMENT_CHECK_WINDOW_MS).toISOString();
  const byId = String(userId || '');

  const { data, error } = await client
    .from('coupons')
    .update({ reserved_until: untilIso, reserved_payment_id: String(paymentId), reserved_by: byId })
    .eq('id', String(couponId))
    .eq('status', 'available')
    .or([
      'reserved_until.is.null',
      `reserved_until.lte.${nowIso}`,
      `reserved_payment_id.eq.${String(paymentId)}`,
      ...(byId ? [`reserved_by.eq.${byId}`] : []),
    ].join(','))
    .select('id, code, reserved_until, reserved_payment_id, reserved_by');

  if (error) throw new Error('Atomic coupon reservation failed: ' + error.message);
  const row = (data || [])[0];
  if (row && String(row.reserved_payment_id) === String(paymentId)) {
    console.log(`[COUPON_RESERVATION] reserved coupon=${couponId} payment=${paymentId} until=${untilIso}`);
    return { ok: true, until: row.reserved_until || untilIso };
  }
  console.log(`[COUPON_RESERVATION] rejected coupon=${couponId} payment=${paymentId} — held by ${row ? row.reserved_payment_id || 'another buyer' : 'another buyer'}`);
  return { ok: false };
}

/**
 * Release the reservation a payment session holds on a coupon. The
 * `reserved_payment_id` precondition is the ownership check: a superseded or
 * expired old session can never release the reservation that belongs to the
 * buyer's NEW session (spec §9). Returns true when this call released it.
 */
async function releaseCouponReservation({ couponId, paymentId }) {
  const client = supabase.isConfigured() ? supabase.getClient() : null;
  if (!client) throw new Error('Atomic coupon storage is required to release reservations.');
  if (!couponId || !paymentId) return false;

  const { data, error } = await client
    .from('coupons')
    .update({ reserved_until: null, reserved_payment_id: null, reserved_by: null })
    .eq('id', String(couponId))
    .eq('reserved_payment_id', String(paymentId))
    .select('id');

  if (error) throw new Error('Reservation release failed: ' + error.message);
  const released = (data || []).length > 0;
  if (released) console.log(`[COUPON_RESERVATION] released coupon=${couponId} payment=${paymentId}`);
  return released;
}

/**
 * Clear every lapsed reservation in one sweep. Visibility is already restored
 * lazily by the reserved_until filter, so this only tidies the rows — the
 * reconcile cron calls it. Returns the number of rows cleared.
 */
async function clearExpiredCouponReservations() {
  const client = supabase.isConfigured() ? supabase.getClient() : null;
  if (!client) return 0;

  const { data, error } = await client
    .from('coupons')
    .update({ reserved_until: null, reserved_payment_id: null, reserved_by: null })
    .lt('reserved_until', new Date().toISOString())
    .select('id');

  if (error) throw new Error('Reservation cleanup failed: ' + error.message);
  return (data || []).length;
}

/** Park a payment for a human. Used when a value didn't match exactly. */
async function flagForReview(paymentId, { notes = '', source = '', raw = null } = {}) {
  const now = new Date().toISOString();
  const flagged = await transitionPayment(paymentId, 'PENDING', 'REVIEW', {
    verification_source: source,
    verification_notes: notes,
    updated_at: now,
  });
  if (flagged) {
    await transitionOrder(flagged.orderId, 'PENDING', 'REVIEW', { updated_at: now });
  }
  return flagged;
}

// ── Maintenance ────────────────────────────────────────────────────────────

/**
 * Enforce "one active payment-checking session per user". Any OTHER live
 * (PENDING) payment this user holds is retired to CANCELLED so it can no longer
 * be matched or settled — this is what makes opening a new payment window
 * immediately deactivate the previous one, even for a different coupon, and
 * prevents an old window from processing a payment meant for the new order.
 *
 * `keepPaymentId` is the session that should stay live (the one just
 * created/reused); pass null to retire every live session for the user.
 * CANCELLED (not a new status) is reused so finance/dashboard/admin readers,
 * which already understand CANCELLED, need no changes.
 */
async function supersedeLivePaymentsForUser(userId, { keepPaymentId = null, reason = 'Superseded: a newer payment window was opened.' } = {}) {
  if (!userId) return 0;
  const rows = await rowsFresh(PAYMENTS);
  const targets = rows.filter((r) =>
    r.status === 'PENDING' &&
    String(r.user_id) === String(userId) &&
    (!keepPaymentId || String(r.payment_id) !== String(keepPaymentId)));

  let superseded = 0;
  for (const row of targets) {
    try {
      const moved = await transitionPayment(row.payment_id, 'PENDING', 'CANCELLED', {
        verification_notes: reason,
        updated_at: new Date().toISOString(),
      });
      if (moved) {
        superseded++;
        try {
          await transitionOrder(moved.orderId, 'PENDING', 'CANCELLED', { updated_at: new Date().toISOString() });
        } catch (e) { /* best effort: a stale order row is harmless */ }
        // The retired session must not keep hiding its coupon: release ONLY the
        // reservation this payment owns, so a newer session's reservation on
        // the same coupon (the buyer re-opened the window) survives untouched.
        if (moved.couponId) {
          try { await releaseCouponReservation({ couponId: moved.couponId, paymentId: moved.paymentId }); } catch (e) {}
        }
      }
    } catch (e) {
      console.warn('[paymentStore] supersede failed for', row.payment_id, e.message);
    }
  }
  return superseded;
}

/**
 * Reconcile pass for the payment lifecycle — safe to run from a cron or after
 * any deployment/restart. Everything here is derived from stored timestamps,
 * so the pass is idempotent and recoverable:
 *   1. expire every PENDING payment whose BACKEND checking window (20 min)
 *      has closed (releases its coupon reservation too),
 *   2. tidy lapsed coupon reservations.
 * Returns a summary for the caller to log.
 */
async function reconcileExpiredPayments() {
  const nowIso = new Date().toISOString();
  const rows = await rowsFresh(PAYMENTS);
  const due = rows.filter((r) => r.status === 'PENDING' && checkDeadline(r) <= toTime(nowIso));
  let expired = 0;
  for (const row of due) {
    try {
      const moved = await expireIfDue(row.payment_id, { now: nowIso });
      if (moved) expired++;
    } catch (e) {
      console.warn('[paymentStore] reconcile expire failed for', row.payment_id, e.message);
    }
  }
  let reservationsCleared = 0;
  try {
    reservationsCleared = await clearExpiredCouponReservations();
  } catch (e) {
    console.warn('[paymentStore] reconcile reservation cleanup notice:', e.message);
  }
  return { expired, reservationsCleared };
}

// ── Notification inbox ─────────────────────────────────────────────────────

/**
 * Record an observed confirmation. Returns { notification, duplicate }.
 *
 * `duplicate: true` means a row with this fingerprint already existed — the
 * caller must NOT re-apply it, which is what makes a re-read mailbox or a
 * redelivered webhook a no-op.
 *
 * The fingerprint is the natural key of a notification, so it is checked
 * before the append. Sheets cannot enforce that uniqueness, so the check and
 * the append sit inside the process lock to keep a single instance honest.
 */
async function recordNotification({
  fingerprint,
  source = 'unknown',
  amount = null,
  currency = 'INR',
  transactionId = null,
  utr = null,
  payerVpa = '',
  payeeVpa = '',
  reference = '',
  occurredAt = null,
  raw = null,
  status = 'RECEIVED',
  notes = '',
}) {
  return withLock(async () => {
    const existing = await rowsFresh(NOTIFICATIONS);
    const seen = existing.find((r) => String(r.fingerprint) === String(fingerprint));
    if (seen) return { notification: fromNotification(seen), duplicate: true };

    const row = {
      id: crypto.randomUUID(),
      fingerprint,
      source,
      amount: amount === null || amount === undefined ? '' : money2(amount),
      currency,
      transaction_id: transactionId || '',
      utr: utr || '',
      payer_vpa: payerVpa,
      payee_vpa: payeeVpa,
      reference,
      occurred_at: occurredAt || '',
      status,
      matched_payment_id: '',
      notes,
      created_at: new Date().toISOString(),
      processed_at: '',
      // Truncated so a long email body cannot bloat the sheet; the full text
      // lives in the payment mailbox if a dispute needs it.
      raw: raw ? JSON.stringify(raw).slice(0, 1000) : '',
    };

    await db.appendRow(NOTIFICATIONS, row);
    return { notification: fromNotification(row), duplicate: false };
  });
}

async function findNotificationByFingerprint(fingerprint) {
  const rows = await rowsFresh(NOTIFICATIONS);
  return fromNotification(rows.find((r) => String(r.fingerprint) === String(fingerprint)));
}

async function updateNotification(id, updates = {}) {
  await db.updateRow(NOTIFICATIONS, 'id', String(id), {
    ...updates,
    processed_at: new Date().toISOString(),
  });
  const rows = await rowsFresh(NOTIFICATIONS);
  return fromNotification(rows.find((r) => String(r.id) === String(id)));
}

module.exports = {
  PAYMENT_WINDOW_MS,
  PAYMENT_CHECK_WINDOW_MS,
  ensureReady,
  isConfigured,
  // ids
  newOrderCode,
  newPaymentId,
  // reads
  findOrderById,
  findOrderByCode,
  findPaymentById,
  findLivePaymentForOrder,
  findLatestPaymentForOrder,
  findLivePaymentForUserCoupon,
  findLiveOpenPayment,
  isTransactionUsed,
  findPaymentByTransaction,
  findPaidPaymentForBuyer,
  findPendingPaymentsForAmount,
  findPendingPaymentByOrderCode,
  findLateCandidatePayments,
  stampDueVerificationWindows,
  // writes
  createOrder,
  createPayment,
  transitionPayment,
  stampVerificationWindow,
  transitionOrder,
  expireIfDue,
  cancelPayment,
  finalizePayment,
  finalizeUnderpayment,
  flagForReview,
  supersedeLivePaymentsForUser,
  unlockCoupon,
  readCoupon,
  reserveCouponForPayment,
  releaseCouponReservation,
  clearExpiredCouponReservations,
  reconcileExpiredPayments,
  // notification inbox
  recordNotification,
  findNotificationByFingerprint,
  updateNotification,
  // mapping
  fromOrder,
  fromPayment,
  fromNotification,
  moneyEquals,
};
