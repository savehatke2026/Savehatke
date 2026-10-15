'use strict';

// ============================================================================
// SaveHatke — Admin Transactions & Orders read model
// ============================================================================
// Two separate, read-only views over the records the platform already writes:
//
//   • Transactions = one row per UPI payment attempt (Payments sheet). Money
//     (expected vs detected), UTR / transaction reference, verification trail,
//     issues (mismatch, late credit, expired, cancelled, verification error)
//     and refund state.
//   • Orders       = one row per purchase (Orders sheet). Customer, coupon,
//     purchase price, the linked payment attempts, coupon reservation, coupon
//     unlock/delivery, cancellation and fulfilment problems.
//
// The two are linked by the internal order id (Payments.order_id = Orders.id);
// the human Order ID (Orders.order_code) is what the UI displays. Multiple
// payment attempts per order are supported. Nothing here writes a row — the one
// write (Retry Verification) lives in routes/adminFinance.js and reuses the
// existing mailbox verifier.
//
// Payment status, order status, coupon delivery and refund status are derived
// and reported as separate fields; they are never folded into one another.
// ============================================================================

const db = require('./googleSheets');
const finance = require('./finance');
const sellerPayout = require('./sellerPayout');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const EXPORT_CAP = 10000;

// Audit events that concern a single payment (see routes/payment.js and
// routes/adminFinance.js). Used to build the verification history.
const PAYMENT_AUDIT_EVENTS = new Set(['payment_admin_recovery', 'payment_retry_verification']);

// Heuristic for "verification error" on a payment that did not settle. The
// verifier writes free-text verification_notes; these words mark a failed check.
const VERIFY_ERROR_RE = /\b(error|failed|could not|unable|exception)\b/i;

const REFUND_OPEN = new Set(['pending', 'processing']);

// ── Small helpers ───────────────────────────────────────────────────────────
function str(v) { return v === undefined || v === null ? '' : String(v); }
function lower(v) { return str(v).toLowerCase(); }
function upper(v) { return str(v).toUpperCase(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function money(v) { return Math.round(num(v) * 100) / 100; }
function blank(v) { return v === '' || v === undefined || v === null; }
function ms(v) { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function parseSnapshot(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)) || {}; } catch (e) { return {}; }
}

function pageOf(query = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
}

function windowOf(query = {}) {
  return finance.resolveWindow(query.period || 'all', { from: query.from, to: query.to });
}

function inWindow(at, win) {
  if (win.key === 'all') return true;
  return at != null && at >= win.from && at < win.to;
}

// Coupons: Supabase primary + Sheets mirror (same merge as finance.js). Used
// only for display and reservation/delivery state — never for money.
async function fetchCouponRows() {
  const supabase = require('./supabase');
  let supa = [];
  if (supabase.isConfigured()) {
    try { supa = (await supabase.getCoupons()) || []; } catch (e) { supa = []; }
  }
  let sheet = [];
  try { sheet = (await db.getRows(db.SHEETS.COUPONS)) || []; } catch (e) { sheet = []; }
  const seen = new Set(supa.map((c) => str(c.id)));
  return [...supa, ...sheet.filter((c) => !seen.has(str(c.id)))];
}

function couponLabel(c, o) {
  if (c && c.brand) return `${c.brand}${c.title ? ` — ${c.title}` : ''}`;
  if (o && o.coupon_brand) return str(o.coupon_brand);
  return str(o && o.coupon_code);
}

// ── Data load ───────────────────────────────────────────────────────────────
// Orders and Payments are the financial truth: if they cannot be read the
// error propagates and the route answers 503. Everything else is best-effort.
async function optionalRows(sheet) {
  try { return (await db.getRows(sheet)) || []; } catch (e) { return []; }
}

// The security audit sheet is only read for the single-payment detail view
// (loadLedger({ audit: true })) so list pages stay cheap.
async function loadLedger({ audit = false } = {}) {
  const [orders, payments] = await Promise.all([
    db.getRows(db.SHEETS.ORDERS),
    db.getRows(db.SHEETS.PAYMENTS),
  ]);
  // Refunds are financial truth: a read failure must propagate (route → 503),
  // never show as zero refunds in the transaction and ledger views.
  const [refunds, notifications, auditRows, coupons] = await Promise.all([
    db.getRows(db.SHEETS.REFUNDS, { strict: true }).then((r) => r || []),
    optionalRows(db.SHEETS.PAYMENT_NOTIFICATIONS),
    audit ? optionalRows(db.SHEETS.SECURITY_AUDIT) : Promise.resolve([]),
    fetchCouponRows().catch(() => []),
  ]);

  const orderRows = orders || [];
  const paymentRows = payments || [];
  const couponRows = coupons || [];

  return {
    now: Date.now(),
    orders: orderRows,
    payments: paymentRows,
    orderById: new Map(orderRows.map((o) => [str(o.id), o])),
    paymentById: new Map(paymentRows.map((p) => [str(p.payment_id), p])),
    paymentsByOrder: groupBy(paymentRows, (p) => str(p.order_id)),
    refundsByPayment: groupBy(refunds, (r) => str(r.payment_id)),
    notesByPayment: groupBy(notifications, (n) => str(n.matched_payment_id)),
    couponById: new Map(couponRows.map((c) => [str(c.id), c])),
    auditByPayment: groupBy(
      (auditRows || []).filter((a) => PAYMENT_AUDIT_EVENTS.has(str(a.event))),
      auditPaymentId,
    ),
  };
}

function auditPaymentId(row) {
  const d = str(row.detail);
  let m = /payment=([^\s"]+)/.exec(d);
  if (m) return m[1];
  m = /"recordId":"([^"]+)"/.exec(d);
  return m ? m[1] : '';
}

// ── Transactions ────────────────────────────────────────────────────────────
function refundFor(ctx, paymentId) {
  const list = ctx.refundsByPayment.get(paymentId) || [];
  if (!list.length) return null;
  const r = [...list].sort((a, b) => ms(b.created_at) - ms(a.created_at))[0];
  return refundRow(r);
}

function refundRow(r) {
  return {
    id: str(r.id),
    // Refund amounts are stored in rupees (see services/finance.js refundRupees).
    amount: money(num(r.refund_amount)),
    reference: str(r.refund_reference),
    status: lower(r.status),
    reason: str(r.refund_reason),
    createdAt: str(r.created_at),
    processedAt: str(r.processed_at),
  };
}

function paymentIssues({ status, expected, received, notes, lateCount }) {
  const out = [];
  if (received != null && received !== expected) out.push('MISMATCH');
  if (status === 'REVIEW') out.push('REVIEW');
  if (status === 'EXPIRED') out.push('EXPIRED');
  if (status === 'CANCELLED') out.push('CANCELLED');
  if (lateCount > 0) out.push('LATE_PAYMENT');
  if (status !== 'PAID' && VERIFY_ERROR_RE.test(notes)) out.push('VERIFICATION_ERROR');
  return out;
}

function transactionRow(p, ctx) {
  const paymentId = str(p.payment_id);
  const o = ctx.orderById.get(str(p.order_id)) || null;
  const c = ctx.couponById.get(str(p.coupon_id)) || null;
  const status = upper(p.status);
  const expected = money(p.amount);
  const received = blank(p.received_amount) ? null : money(p.received_amount);
  // Detected = what the bank actually reported. Absent a mismatch record, a
  // PAID payment was detected at its exact expected amount.
  const detected = received != null ? received : (status === 'PAID' ? expected : null);
  const lateCount = (ctx.notesByPayment.get(paymentId) || []).filter((n) => upper(n.status) === 'IGNORED').length;
  const refund = refundFor(ctx, paymentId);
  const notes = str(p.verification_notes);
  const issues = paymentIssues({ status, expected, received, notes, lateCount });

  return {
    paymentId,
    orderId: o ? (str(o.order_code) || str(o.id)) : str(p.order_id),
    orderRef: str(p.order_id),
    transactionId: o ? str(o.transaction_id) : '',
    customerName: o ? str(o.buyer_name) : '',
    customerEmail: str(p.user_email || (o && (o.buyer_email || o.user_email))),
    userId: str(p.user_id || (o && o.user_id)),
    couponId: str(p.coupon_id),
    couponName: couponLabel(c, o),
    expectedAmount: expected,
    detectedAmount: detected,
    receivedAmount: received,
    currency: str(p.currency) || 'INR',
    utr: str(p.verified_utr),
    gatewayTransactionId: str(p.verified_transaction_id),
    status,
    createdAt: str(p.created_at),
    detectedAt: str(p.paid_at),
    verificationStartedAt: str(p.verification_started_at),
    verificationDeadline: str(p.verification_deadline),
    lastCheckedAt: str(p.last_checked_at),
    verificationSource: str(p.verification_source),
    verificationNotes: notes,
    issues,
    refund: refund,
    refundId: refund ? refund.id : '',
    refundAmount: refund ? refund.amount : null,
    refundReference: refund ? refund.reference : '',
    refundStatus: refund ? refund.status : '',
    _ms: ms(p.created_at),
  };
}

const ISSUE_FILTERS = {
  mismatch: (r) => r.issues.includes('MISMATCH'),
  review: (r) => r.issues.includes('REVIEW'),
  late: (r) => r.issues.includes('LATE_PAYMENT'),
  expired: (r) => r.status === 'EXPIRED',
  cancelled: (r) => r.status === 'CANCELLED',
  failed: (r) => r.status === 'EXPIRED' || r.status === 'CANCELLED',
  verification_error: (r) => r.issues.includes('VERIFICATION_ERROR'),
  refund: (r) => !!r.refund,
  refund_open: (r) => !!r.refund && REFUND_OPEN.has(r.refund.status),
};

function publicRow(row) {
  const out = { ...row };
  delete out._ms;
  return out;
}

function summarizeTransactions(rows) {
  let expectedTotal = 0;
  let detectedTotal = 0;
  let paidTotal = 0;
  let refundedTotal = 0;
  let issueCount = 0;
  for (const r of rows) {
    expectedTotal += r.expectedAmount;
    if (r.detectedAmount != null) detectedTotal += r.detectedAmount;
    if (r.status === 'PAID') paidTotal += r.expectedAmount;
    if (r.refund && r.refund.status === 'refunded') refundedTotal += r.refund.amount;
    if (r.issues.length) issueCount += 1;
  }
  return {
    count: rows.length,
    expectedTotal: money(expectedTotal),
    detectedTotal: money(detectedTotal),
    paidTotal: money(paidTotal),
    refundedTotal: money(refundedTotal),
    issueCount,
  };
}

// Payment-window sessions that never received money are noise on the financial
// page once they have been closed for a while. They are HIDDEN from the list,
// the CSV and the summary; nothing is deleted from Sheets or Supabase, so a late
// credit or dispute can still be found by ID. A row is hidden only when ALL hold:
//   • status is CANCELLED or EXPIRED (the window closed without settling),
//   • no money was detected (no received amount),
//   • no late-credit notification and no refund are linked to it,
//   • it is older than PAYMENT_HIDE_AFTER_MS (7 days).
const PAYMENT_HIDE_AFTER_DAYS = Number(process.env.PAYMENT_HIDE_AFTER_DAYS) > 0
  ? Number(process.env.PAYMENT_HIDE_AFTER_DAYS)
  : 7;
const PAYMENT_HIDE_AFTER_MS = PAYMENT_HIDE_AFTER_DAYS * 24 * 60 * 60 * 1000;

function isHiddenNoPaymentSession(r, nowMs) {
  if (r.status !== 'CANCELLED' && r.status !== 'EXPIRED') return false;
  if (r.receivedAmount != null) return false;
  if (r.refund) return false;
  if (r.issues.includes('LATE_PAYMENT')) return false;
  if (!r._ms || !Number.isFinite(nowMs)) return false;
  return nowMs - r._ms >= PAYMENT_HIDE_AFTER_MS;
}

function filteredTransactions(query, ctx) {
  const win = windowOf(query);
  const status = upper(query.status);
  const issue = lower(query.issue);
  const search = lower(query.search).trim();

  const nowMs = Date.now();
  let rows = ctx.payments.map((p) => transactionRow(p, ctx));
  rows = rows.filter((r) => !isHiddenNoPaymentSession(r, nowMs));
  rows = rows.filter((r) => inWindow(r._ms, win));
  if (status) rows = rows.filter((r) => r.status === status);
  if (issue && ISSUE_FILTERS[issue]) rows = rows.filter(ISSUE_FILTERS[issue]);
  if (search) {
    rows = rows.filter((r) => [r.paymentId, r.orderId, r.transactionId, r.customerName, r.customerEmail,
      r.couponName, r.utr, r.gatewayTransactionId, r.refundReference]
      .some((v) => lower(v).includes(search)));
  }
  rows.sort((a, b) => (b._ms || 0) - (a._ms || 0));
  return { rows, win };
}

async function listTransactions(query = {}, ctx = null) {
  const c = ctx || await loadLedger();
  const { limit, offset } = pageOf(query);
  const { rows, win } = filteredTransactions(query, c);
  return {
    period: { key: win.key, label: win.label },
    total: rows.length,
    limit,
    offset,
    summary: summarizeTransactions(rows),
    transactions: rows.slice(offset, offset + limit).map(publicRow),
  };
}

function notificationRow(n) {
  return {
    id: str(n.id),
    source: str(n.source),
    status: upper(n.status),
    amount: blank(n.amount) ? null : money(n.amount),
    utr: str(n.utr),
    transactionId: str(n.transaction_id),
    payerVpa: str(n.payer_vpa),
    occurredAt: str(n.occurred_at),
    processedAt: str(n.processed_at),
    notes: str(n.notes),
    createdAt: str(n.created_at),
  };
}

function auditRow(a) {
  return {
    id: str(a.id),
    event: str(a.event),
    outcome: str(a.outcome),
    actor: str(a.email),
    detail: str(a.detail).slice(0, 400),
    createdAt: str(a.createdAt || a.created_at),
  };
}

// Chronological verification history for one payment: what the verifier saw,
// when, from which source, and every admin action taken on it.
function buildPaymentHistory(p, { notifications, audits, refunds }) {
  const events = [];
  const add = (at, event, extra = {}) => { if (at) events.push({ at: str(at), event, ...extra }); };
  const status = upper(p.status);

  add(p.created_at, 'Payment window opened', { status: 'PENDING' });
  add(p.verification_started_at, 'Verification window started');
  add(p.last_checked_at, 'Last verification check');
  add(p.paid_at, status === 'PAID' ? 'Payment detected and verified' : 'Payment detected', {
    source: str(p.verification_source),
    notes: str(p.verification_notes),
  });
  for (const n of notifications) {
    add(n.occurredAt || n.createdAt, `Credit notification received (${n.status || 'UNKNOWN'})`, {
      source: n.source, amount: n.amount, utr: n.utr, notes: n.notes,
    });
  }
  for (const a of audits) {
    add(a.createdAt, `Admin action: ${a.event}`, { actor: a.actor, outcome: a.outcome, notes: a.detail });
  }
  for (const r of refunds) {
    add(r.createdAt, `Refund ${r.status || 'recorded'}`, { amount: r.amount, reference: r.reference });
  }
  add(p.updated_at, `Current status: ${status}`);

  return events.sort((a, b) => ms(a.at) - ms(b.at));
}

async function getTransactionDetail(paymentId, ctx = null) {
  const c = ctx || await loadLedger();
  const id = str(paymentId).trim();
  const p = c.paymentById.get(id);
  if (!p) return null;

  const row = publicRow(transactionRow(p, c));
  const o = c.orderById.get(str(p.order_id)) || null;
  const notifications = (c.notesByPayment.get(id) || []).map(notificationRow)
    .sort((a, b) => ms(b.occurredAt || b.createdAt) - ms(a.occurredAt || a.createdAt));
  const audits = (c.auditByPayment.get(id) || []).map(auditRow)
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  const refunds = (c.refundsByPayment.get(id) || []).map(refundRow);
  const attempts = (c.paymentsByOrder.get(str(p.order_id)) || [])
    .slice().sort((a, b) => ms(b.created_at) - ms(a.created_at))
    .map((sp) => ({
      paymentId: str(sp.payment_id),
      status: upper(sp.status),
      amount: money(sp.amount),
      createdAt: str(sp.created_at),
      detectedAt: str(sp.paid_at),
      current: str(sp.payment_id) === id,
    }));

  return {
    payment: row,
    order: o ? orderRow(o, c) : null,
    attempts,
    notifications,
    refunds,
    audit: audits,
    history: buildPaymentHistory(p, { notifications, audits, refunds }),
  };
}

// ── Orders ──────────────────────────────────────────────────────────────────
function reservationStatus(coupon, payIds, now) {
  if (!coupon) return 'unknown';
  // Columns from the reservation migration are absent on older databases.
  if (coupon.reserved_until === undefined && coupon.reserved_payment_id === undefined) return 'unknown';
  const holder = str(coupon.reserved_payment_id);
  if (!holder) return 'none';
  if (!payIds.has(holder)) return 'held_by_other';
  const until = ms(coupon.reserved_until);
  return until > now ? 'active' : 'expired';
}

function soldToBuyer(coupon, o, payIds) {
  if (!coupon || lower(coupon.status) !== 'sold') return false;
  if (payIds.has(str(coupon.sold_payment_id))) return true;
  const buyer = lower(o.buyer_email || o.user_email);
  return !!buyer && lower(coupon.buyer_email) === buyer;
}

function deliveryStatus(status, sold) {
  if (sold) return 'delivered';
  if (status === 'PAID') return 'undelivered';
  if (status === 'REVIEW') return 'held_for_review';
  if (status === 'CANCELLED' || status === 'EXPIRED') return 'not_delivered';
  return 'awaiting_payment';
}

function fulfilmentIssues({ status, delivery, coupon, paidCount, latest }) {
  const out = [];
  if (status === 'REVIEW') out.push('Order held for review');
  if (status === 'PAID' && delivery === 'undelivered') out.push('Paid but coupon is not unlocked to the buyer');
  if (status === 'PAID' && !coupon) out.push('Coupon record not found');
  if (paidCount > 1) out.push('More than one paid payment for this order');
  if (latest && status !== 'PAID' && VERIFY_ERROR_RE.test(str(latest.verification_notes))) {
    out.push('Verification error on latest payment');
  }
  return out;
}

function orderRow(o, c) {
  const id = str(o.id);
  const payments = (c.paymentsByOrder.get(id) || []).slice().sort((a, b) => ms(b.created_at) - ms(a.created_at));
  const latest = payments[0] || null;
  const payIds = new Set(payments.map((p) => str(p.payment_id)));
  const paidCount = payments.filter((p) => upper(p.status) === 'PAID').length;
  const coupon = c.couponById.get(str(o.coupon_id)) || null;
  const snap = parseSnapshot(o.coupon_snapshot);
  const status = upper(o.status);
  const sold = soldToBuyer(coupon, o, payIds);
  const delivery = deliveryStatus(status, sold);
  const reservation = reservationStatus(coupon, payIds, c.now);

  const faceRaw = coupon
    ? sellerPayout.faceValueOf(coupon)
    : (snap.originalValue ?? snap.original_value ?? snap.faceValue ?? snap.face_value);
  const faceValue = blank(faceRaw) || !Number.isFinite(Number(faceRaw)) ? null : money(faceRaw);

  const cancelled = status === 'CANCELLED' || status === 'EXPIRED';

  return {
    orderId: str(o.order_code) || id,
    orderRef: id,
    transactionId: str(o.transaction_id),
    transactionType: str(o.transaction_type) || (o.order_code ? 'PURCHASE' : ''),
    customerName: str(o.buyer_name),
    customerEmail: str(o.buyer_email || o.user_email),
    userId: str(o.user_id),
    couponId: str(o.coupon_id),
    couponName: couponLabel(coupon, o) || str(snap.brand),
    couponFaceValue: faceValue,
    purchasePrice: money(o.amount),
    currency: str(o.currency) || 'INR',
    status,
    createdAt: str(o.created_at),
    updatedAt: str(o.updated_at),
    paidAt: str(o.paid_at),
    paymentStatus: latest ? upper(latest.status) : 'NONE',
    paymentAttempts: payments.length,
    reservationStatus: reservation,
    deliveryStatus: delivery,
    couponSoldAt: sold ? str(coupon.sold_at) : '',
    cancellationType: cancelled ? status : '',
    cancellationAt: cancelled ? str(o.updated_at) : '',
    cancellationReason: cancelled && latest ? str(latest.verification_notes) : '',
    fulfilmentIssues: fulfilmentIssues({ status, delivery, coupon, paidCount, latest }),
    _ms: ms(o.created_at),
  };
}

const ORDER_DELIVERY = new Set(['delivered', 'undelivered', 'held_for_review', 'not_delivered', 'awaiting_payment']);

function filteredOrders(query, c) {
  const win = windowOf(query);
  const status = upper(query.status);
  const delivery = lower(query.delivery);
  const search = lower(query.search).trim();

  const nowMs = Date.now();
  let rows = c.orders.map((o) => orderRow(o, c));
  // Same hide rule as Transactions: a closed, never-paid order older than the
  // retention window is not shown. Nothing is deleted.
  rows = rows.filter((r) => !(
    (r.status === 'CANCELLED' || r.status === 'EXPIRED')
    && r.paidAt === ''
    && r._ms && Number.isFinite(nowMs) && nowMs - r._ms >= PAYMENT_HIDE_AFTER_MS
  ));
  rows = rows.filter((r) => inWindow(r._ms, win));
  if (status) rows = rows.filter((r) => r.status === status);
  if (delivery && ORDER_DELIVERY.has(delivery)) rows = rows.filter((r) => r.deliveryStatus === delivery);
  if (search) {
    rows = rows.filter((r) => [r.orderId, r.orderRef, r.transactionId, r.customerEmail, r.customerName,
      r.userId, r.couponName, r.couponId]
      .some((v) => lower(v).includes(search)));
  }
  rows.sort((a, b) => (b._ms || 0) - (a._ms || 0));
  return { rows, win };
}

async function listOrders(query = {}, ctx = null) {
  const c = ctx || await loadLedger();
  const { limit, offset } = pageOf(query);
  const { rows, win } = filteredOrders(query, c);
  return {
    period: { key: win.key, label: win.label },
    total: rows.length,
    limit,
    offset,
    orders: rows.slice(offset, offset + limit).map(publicRow),
  };
}

async function getOrderDetail(orderId, ctx = null) {
  const c = ctx || await loadLedger();
  const key = str(orderId).trim();
  const o = c.orders.find((x) => str(x.order_code) === key || str(x.id) === key);
  if (!o) return null;

  const id = str(o.id);
  const order = publicRow(orderRow(o, c));
  const payments = (c.paymentsByOrder.get(id) || []).slice().sort((a, b) => ms(b.created_at) - ms(a.created_at));
  const attempts = payments.map((p) => publicRow(transactionRow(p, c)));

  const refunds = payments.flatMap((p) => (c.refundsByPayment.get(str(p.payment_id)) || []).map(refundRow));
  const events = [];
  const add = (at, event, extra = {}) => { if (at) events.push({ at: str(at), event, ...extra }); };
  add(o.created_at, 'Order created', { status: upper(o.status) });
  for (const p of payments) {
    add(p.created_at, `Payment attempt ${str(p.payment_id)} started`, { status: 'PENDING' });
    add(p.paid_at, `Payment ${str(p.payment_id)} detected`, { status: upper(p.status) });
  }
  add(o.paid_at, 'Order paid');
  if (order.couponSoldAt) add(order.couponSoldAt, 'Coupon unlocked to buyer');
  if (order.cancellationType) add(order.cancellationAt, `Order ${order.cancellationType.toLowerCase()}`, { notes: order.cancellationReason });
  for (const r of refunds) add(r.createdAt, `Refund ${r.status || 'recorded'}`, { amount: r.amount, reference: r.reference });
  add(o.updated_at, `Current status: ${upper(o.status)}`);

  return {
    order,
    attempts,
    refunds,
    history: events.sort((a, b) => ms(a.at) - ms(b.at)),
  };
}

// ── CSV export ──────────────────────────────────────────────────────────────
// Formula-injection guard: a text cell that starts with = + - @ or a tab/CR is
// prefixed so spreadsheet apps do not evaluate it.
function csvCell(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(columns, rows) {
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(','));
  return '\uFEFF' + [header, ...body].join('\r\n') + '\r\n';
}

const TRANSACTION_COLUMNS = [
  { label: 'Transaction ID', value: (r) => r.transactionId },
  { label: 'Order ID', value: (r) => r.orderId },
  { label: 'Refund ID', value: (r) => r.refundId },
  { label: 'Customer Name', value: (r) => r.customerName },
  { label: 'Customer Email', value: (r) => r.customerEmail },
  { label: 'Coupon', value: (r) => r.couponName },
  { label: 'Expected Amount', value: (r) => r.expectedAmount },
  { label: 'Detected Amount', value: (r) => (r.detectedAmount == null ? '' : r.detectedAmount) },
  { label: 'UTR', value: (r) => r.utr },
  { label: 'Gateway Transaction ID', value: (r) => r.gatewayTransactionId },
  { label: 'Payment Status', value: (r) => r.status },
  { label: 'Issues', value: (r) => r.issues.join('; ') },
  { label: 'Created At', value: (r) => r.createdAt },
  { label: 'Detected At', value: (r) => r.detectedAt },
  { label: 'Verification Source', value: (r) => r.verificationSource },
  { label: 'Verification Notes', value: (r) => r.verificationNotes },
  { label: 'Refund Amount', value: (r) => (r.refundAmount == null ? '' : r.refundAmount) },
  { label: 'Refund Reference', value: (r) => r.refundReference },
  { label: 'Refund Status', value: (r) => r.refundStatus },
];

const ORDER_COLUMNS = [
  { label: 'Order ID', value: (r) => r.orderId },
  { label: 'Transaction ID', value: (r) => r.transactionId },
  { label: 'Customer Name', value: (r) => r.customerName },
  { label: 'Customer Email', value: (r) => r.customerEmail },
  { label: 'User ID', value: (r) => r.userId },
  { label: 'Coupon', value: (r) => r.couponName },
  { label: 'Coupon ID', value: (r) => r.couponId },
  { label: 'Coupon Face Value', value: (r) => (r.couponFaceValue == null ? '' : r.couponFaceValue) },
  { label: 'Purchase Price', value: (r) => r.purchasePrice },
  { label: 'Order Status', value: (r) => r.status },
  { label: 'Payment Status', value: (r) => r.paymentStatus },
  { label: 'Payment Attempts', value: (r) => r.paymentAttempts },
  { label: 'Reservation Status', value: (r) => r.reservationStatus },
  { label: 'Delivery Status', value: (r) => r.deliveryStatus },
  { label: 'Coupon Unlocked At', value: (r) => r.couponSoldAt },
  { label: 'Cancellation Type', value: (r) => r.cancellationType },
  { label: 'Cancellation Reason', value: (r) => r.cancellationReason },
  { label: 'Fulfilment Issues', value: (r) => r.fulfilmentIssues.join('; ') },
  { label: 'Created At', value: (r) => r.createdAt },
  { label: 'Updated At', value: (r) => r.updatedAt },
];

async function exportTransactionsCsv(query = {}, ctx = null) {
  const c = ctx || await loadLedger();
  const { rows } = filteredTransactions(query, c);
  const capped = rows.slice(0, EXPORT_CAP).map(publicRow);
  return { csv: toCsv(TRANSACTION_COLUMNS, capped), count: capped.length, truncated: rows.length > EXPORT_CAP };
}

async function exportOrdersCsv(query = {}, ctx = null) {
  const c = ctx || await loadLedger();
  const { rows } = filteredOrders(query, c);
  const capped = rows.slice(0, EXPORT_CAP).map(publicRow);
  return { csv: toCsv(ORDER_COLUMNS, capped), count: capped.length, truncated: rows.length > EXPORT_CAP };
}

module.exports = {
  listTransactions,
  getTransactionDetail,
  listOrders,
  getOrderDetail,
  exportTransactionsCsv,
  exportOrdersCsv,
  // exposed for tests
  _internals: { loadLedger, transactionRow, orderRow, refundRow, paymentIssues, reservationStatus, deliveryStatus, soldToBuyer, csvCell, toCsv, auditPaymentId, buildPaymentHistory, transactionColumns: TRANSACTION_COLUMNS, isHiddenNoPaymentSession, PAYMENT_HIDE_AFTER_MS },
};
