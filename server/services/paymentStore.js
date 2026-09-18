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

const PAYMENT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes, per the checkout UI

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
    currency: r.currency || 'INR',
    status: r.status || '',
    createdAt: r.created_at || '',
    updatedAt: r.updated_at || '',
    expiresAt: r.expires_at || '',
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
  return 'SH-' + shortCode(6);
}

function newPaymentId() {
  return 'pay_' + crypto.randomBytes(16).toString('hex');
}

// ── Reads ──────────────────────────────────────────────────────────────────

const rowsFresh = (sheet) => db.getRowsFresh(sheet);
const rowsCached = (sheet) => db.getRows(sheet);

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
 * Live payments whose window has not yet closed, joined with the order code
 * the confirmation will quote back. Pass an amount to narrow to that exact
 * figure (the common case: we only care about money we are currently waiting
 * on).
 *
 * Only payments inside their window are returned — an expired attempt must
 * never be settled by a late confirmation.
 */
async function findPendingPaymentsForAmount(amount = null, { limit = 200 } = {}) {
  const now = Date.now();
  const [payments, orders] = await Promise.all([rowsFresh(PAYMENTS), rowsCached(ORDERS)]);

  const orderById = new Map(orders.map((o) => [String(o.id), o]));

  return payments
    .filter((r) => r.status === 'PENDING' && toTime(r.expires_at) > now)
    .filter((r) => (amount === null || amount === undefined ? true : moneyEquals(r.amount, amount)))
    .sort((a, b) => toTime(b.created_at) - toTime(a.created_at))
    .slice(0, limit)
    .map((r) => {
      const p = fromPayment(r);
      const o = orderById.get(String(p.orderId)) || {};
      return {
        ...p,
        orderCode: o.order_code || '',
        couponCode: o.coupon_code || '',
        couponBrand: o.coupon_brand || '',
      };
    });
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

  // The order code has ~1e9 of space, but a collision must not be a hard
  // failure — retry against the codes actually in the sheet.
  const existing = await rowsFresh(ORDERS);
  const taken = new Set(existing.map((r) => String(r.order_code)));

  let orderCode = newOrderCode();
  for (let attempt = 0; attempt < 5 && taken.has(orderCode); attempt++) orderCode = newOrderCode();

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
  };

  await db.appendRow(ORDERS, row);
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
    const existing = await rowsFresh(PAYMENTS);
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
      paid_at: '',
      upi_id: upiId,
      payee_name: payeeName,
      upi_uri: upiUri,
      verified_transaction_id: '',
      verified_utr: '',
      verification_source: '',
      verification_notes: '',
    };

    await db.appendRow(PAYMENTS, row);

    // Confirm the row landed and that we did not end up with two live rows.
    const after = await rowsFresh(PAYMENTS);
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
          });
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
    const before = await rowsFresh(PAYMENTS);
    const current = before.find((r) => String(r.payment_id) === String(paymentId));
    if (!current || current.status !== fromStatus) return null;

    const patch = { status: toStatus, updated_at: new Date().toISOString(), ...extra };
    await db.updateRow(PAYMENTS, 'payment_id', paymentId, patch);

    const after = await rowsFresh(PAYMENTS);
    const written = after.find((r) => String(r.payment_id) === String(paymentId));
    if (!written || written.status !== toStatus) return null; // lost the race
    return fromPayment(written);
  });
}

async function transitionOrder(orderId, fromStatus, toStatus, extra = {}) {
  return withLock(async () => {
    const before = await rowsFresh(ORDERS);
    const current = before.find((r) => String(r.id) === String(orderId));
    if (!current || current.status !== fromStatus) return null;

    const patch = { status: toStatus, updated_at: new Date().toISOString(), ...extra };
    await db.updateRow(ORDERS, 'id', orderId, patch);

    const after = await rowsFresh(ORDERS);
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
 * The coupon is deliberately NOT touched: an expired payment must not unlock
 * it, and must not reserve it either.
 */
async function expireIfDue(paymentId, { now = new Date().toISOString() } = {}) {
  const current = await findPaymentById(paymentId);
  if (!current || current.status !== 'PENDING') return null;
  if (toTime(current.expiresAt) > toTime(now)) return null;

  const expired = await transitionPayment(paymentId, 'PENDING', 'EXPIRED', { updated_at: now });
  if (expired) {
    await transitionOrder(expired.orderId, 'PENDING', 'EXPIRED', { updated_at: now });
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
async function unlockCoupon({ couponId, userEmail, paidAt }) {
  const client = supabase.isConfigured() ? supabase.getClient() : null;

  if (client) {
    const { data, error } = await client
      .from('coupons')
      .update({ status: 'sold', sold_at: paidAt, buyer_email: userEmail })
      .eq('id', String(couponId))
      .eq('status', 'available')
      .select('id, code, status, buyer_email');

    if (error) throw new Error(error.message);

    const row = (data || [])[0];
    if (row) return { unlocked: true, code: row.code || '', status: 'sold', buyerEmail: userEmail };

    // 0 rows affected: it was not available. Read it back to find out why —
    // already sold to this same buyer is a successful, idempotent unlock;
    // anything else needs a human.
    const { data: cur, error: readErr } = await client
      .from('coupons')
      .select('id, code, status, buyer_email')
      .eq('id', String(couponId))
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    return {
      unlocked: false,
      code: (cur && cur.code) || '',
      status: (cur && cur.status) || '',
      buyerEmail: (cur && cur.buyer_email) || '',
    };
  }

  // Fallback for a coupon that only exists in the spreadsheet. Best effort by
  // necessity: the sheet has no conditional write, so this is a read-then-write
  // with a re-read to confirm. See the header.
  const fresh = await db.findRowsFresh(db.SHEETS.COUPONS, 'id', String(couponId));
  const coupon = (fresh || [])[0];
  if (!coupon) return { unlocked: false, code: '', status: '', buyerEmail: '' };
  if (String(coupon.status || '').toLowerCase() !== 'available') {
    return { unlocked: false, code: coupon.code || '', status: coupon.status || '', buyerEmail: coupon.buyer_email || '' };
  }

  await db.updateRow(db.SHEETS.COUPONS, 'id', String(couponId), {
    status: 'sold',
    soldAt: paidAt,
    buyerEmail: userEmail,
  });
  const check = (await db.findRowsFresh(db.SHEETS.COUPONS, 'id', String(couponId)))[0] || {};
  return {
    unlocked: String(check.status || '').toLowerCase() === 'sold',
    code: check.code || coupon.code || '',
    status: check.status || '',
    buyerEmail: check.buyer_email || '',
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
}) {
  return withLock(async () => {
    const rows = await rowsFresh(PAYMENTS);
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
    // request was raised or long after the window closed is not this payment.
    const at = toTime(settledAt);
    if (at && ((at < toTime(payment.createdAt) - 5 * 60 * 1000) || (at > toTime(payment.expiresAt) + 30 * 60 * 1000))) {
      return { ok: false, code: 'OUTSIDE_WINDOW', payment_status: payment.status };
    }

    // ─ The coupon flip is the gate: do it first, and only record PAID if it
    //   actually happened. That way a payment is never marked PAID for a
    //   coupon this buyer did not receive.
    const unlock = await unlockCoupon({
      couponId: payment.couponId,
      userEmail: payment.userEmail,
      paidAt: settledAt,
    });

    if (!unlock.unlocked) {
      const sameBuyer = String(unlock.buyerEmail || '').toLowerCase() === String(payment.userEmail || '').toLowerCase();
      if (String(unlock.status).toLowerCase() === 'sold' && sameBuyer) {
        // Already sold to this same buyer — a successful, idempotent unlock.
        await markPaid({ payment, txn, reference, source, notes, settledAt });
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

    await markPaid({ payment, txn, reference, source, notes, settledAt });
    return { ok: true, code: 'OK', payment_status: 'PAID', coupon_code: unlock.code || '' };
  });
}

/** Write the PAID state onto the payment and its order. */
async function markPaid({ payment, txn, reference, source, notes, settledAt }) {
  await db.updateRow(PAYMENTS, 'payment_id', payment.paymentId, {
    status: 'PAID',
    paid_at: settledAt,
    updated_at: new Date().toISOString(),
    verified_transaction_id: txn || '',
    verified_utr: reference || '',
    verification_source: source || '',
    verification_notes: notes || '',
  });
  await db.updateRow(ORDERS, 'id', payment.orderId, {
    status: 'PAID',
    paid_at: settledAt,
    updated_at: new Date().toISOString(),
  });
}

async function readCoupon(couponId) {
  const client = supabase.isConfigured() ? supabase.getClient() : null;
  if (client) {
    try {
      const { data } = await client.from('coupons').select('id, code, status, buyer_email').eq('id', String(couponId)).maybeSingle();
      if (data) return { id: data.id, code: data.code || '', status: data.status || '', buyerEmail: data.buyer_email || '' };
    } catch (e) { /* fall through to the sheet */ }
  }
  const fresh = await db.findRowsFresh(db.SHEETS.COUPONS, 'id', String(couponId));
  const c = (fresh || [])[0];
  return c ? { id: c.id, code: c.code || '', status: c.status || '', buyerEmail: c.buyer_email || '' } : null;
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
 * Sweep PENDING payments whose window has closed. Called opportunistically so
 * a buyer who closes the tab still leaves an EXPIRED (not PENDING) row, and a
 * later real payment cannot settle a stale window.
 */
async function expireOverduePayments({ limit = 50 } = {}) {
  const now = Date.now();
  const rows = await rowsFresh(PAYMENTS);
  const overdue = rows
    .filter((r) => r.status === 'PENDING' && toTime(r.expires_at) <= now)
    .slice(0, limit);

  let expired = 0;
  for (const row of overdue) {
    try {
      const done = await expireIfDue(row.payment_id);
      if (done) expired++;
    } catch (e) {
      console.warn('[paymentStore] expire sweep failed for', row.payment_id, e.message);
    }
  }
  return expired;
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
  // writes
  createOrder,
  createPayment,
  transitionPayment,
  transitionOrder,
  expireIfDue,
  cancelPayment,
  finalizePayment,
  flagForReview,
  expireOverduePayments,
  unlockCoupon,
  readCoupon,
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
