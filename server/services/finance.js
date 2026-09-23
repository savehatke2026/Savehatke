'use strict';

// ============================================================================
// SaveHatke — Central Financial Calculation Layer (single source of truth)
// ============================================================================
// PHASE 1 goal: every financial number the admin panel shows must be derived
// HERE, from the real production records, so the Dashboard, Revenue Overview,
// Monthly Settlement, Payment Transactions, Seller Payouts, Admin Payouts and
// Refunds pages can never disagree with one another.
//
// This module is strictly READ-ONLY. It never writes a sheet, never mutates a
// payment/order/payout/refund, and never touches the PDF generator. It only
// aggregates the records the rest of the platform already produces:
//
//   • Coupons  (Supabase primary, Sheets mirror) — status 'sold' + sellingPrice
//                is the established "revenue" definition already used by
//                /api/admin/stats and services/monthlyReports.js.
//   • Orders   (Sheets tab "Orders")   — one row per purchase attempt: the
//                sales-waterfall ledger (amount + status + created_at/paid_at).
//   • Payments (Sheets tab "Payments") — one row per UPI payment attempt: the
//                "Payment Transactions" ledger (gateway reference = verified_*).
//   • Refunds  (Sheets tab "Refunds")  — over/under-payment refund records
//                (amounts stored as integer PAISE).
//   • Payouts  (Sheets tab "Payouts")  — seller payout ledger (rupees).
//
// FINANCIAL MODEL (matches the task spec, Step 6/7, and the existing 7% rule):
//   Gross Sales        = Σ order.amount over orders in window (all statuses)
//   Pending value      = Σ amount where status PENDING
//   Cancelled value    = Σ amount where status CANCELLED | EXPIRED
//   Refunded value     = Σ refund_amount (refunded) in window        [paise→₹]
//   Settled Sales      = Gross − Pending − Cancelled − Refunded  ( = Paid − Refunded )
//   Seller Revenue     = Σ 7% of face value for SOLD user-submitted coupons
//                        (services/sellerPayout.js — never sellingPrice)
//   Platform Fee Rev.  = Settled Sales − Seller Revenue
//   Gateway Fees       = 0  (SaveHatke takes UPI directly — NO gateway fee is
//                        recorded anywhere, so per the spec we do NOT invent one)
//   Other Charges      = 0  (none recorded)
//   Net Distributable  = Platform Fee Rev. − Gateway Fees − Other Charges
//   Distribution       = Net × { Admin1 40%, Admin2 40%, SaveHatke 20% }
//                        (rounded so the three parts sum EXACTLY to Net)
//
// Timezone: all day/week/month boundaries are computed in IST (UTC+5:30), the
// marketplace's operating timezone, so a payment near midnight lands on the
// correct Indian calendar day regardless of where the server runs (Step 23).

const db = require('./googleSheets');
const supabase = require('./supabase');
const sellerPayout = require('./sellerPayout');
const monthlyReports = require('./monthlyReports');

// ── Configuration ───────────────────────────────────────────────────────────
const IST_OFFSET_MIN = 330; // UTC+5:30

// Revenue distribution. Kept as a single constant so every page uses the same
// split and a future change is one edit. Admin identities come from the same
// place the monthly report and login route already use (env override →
// two built-in Super Admins), so this never drifts from the real admins.
const DISTRIBUTION = Object.freeze({ admin1: 0.40, admin2: 0.40, platform: 0.20 });

// Status vocabularies as the code actually writes them (see paymentStore.js).
const PAID = 'PAID';
const PENDING = 'PENDING';
const CANCELLED_SET = new Set(['CANCELLED', 'EXPIRED']);
const REFUND_DONE = 'refunded';
const REFUND_OPEN = new Set(['pending', 'processing']);

// ── Small helpers ─────────────────────────────────────────────────────────
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Refund sheet stores integer paise; everything else is rupees.
function paiseToRupees(v) {
  return num(v) / 100;
}

function timeOf(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function upper(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

function lower(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

// Round to paise (2 dp) without binary-FP drift.
function round2(n) {
  return Math.round((num(n) + Number.EPSILON) * 100) / 100;
}

// ── Admin identities (reused, never re-declared) ────────────────────────────
function adminEmails() {
  try {
    return monthlyReports.configuredAdminEmails();
  } catch (e) {
    return [];
  }
}

// ── IST date windows ────────────────────────────────────────────────────────
// Return the UTC epoch-ms of IST 00:00 for the calendar day containing `ms`.
function istMidnightMs(ms) {
  const shifted = new Date(ms + IST_OFFSET_MIN * 60000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  return Date.UTC(y, m, d, 0, 0, 0, 0) - IST_OFFSET_MIN * 60000;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Start of the IST calendar month that contains `ms`, as UTC epoch-ms.
function istMonthStartMs(ms, monthDelta = 0) {
  const shifted = new Date(ms + IST_OFFSET_MIN * 60000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  return Date.UTC(y, m + monthDelta, 1, 0, 0, 0, 0) - IST_OFFSET_MIN * 60000;
}

/**
 * Resolve a named period (or explicit YYYY-MM-DD custom range, IST) into a
 * half-open window [from, to). `to` is exclusive.
 * Supported: today | 7d | 30d | 3m | thisMonth | prevMonth | month | custom | all
 */
function resolveWindow(period, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const todayStart = istMidnightMs(now);
  const tomorrowStart = todayStart + DAY_MS;
  const p = lower(period) || '30d';

  switch (p) {
    case 'today':
      return { key: 'today', label: 'Today', from: todayStart, to: tomorrowStart };
    case '7d':
    case '7days':
      return { key: '7d', label: 'Last 7 days', from: todayStart - 6 * DAY_MS, to: tomorrowStart };
    case '30d':
    case '30days':
      return { key: '30d', label: 'Last 30 days', from: todayStart - 29 * DAY_MS, to: tomorrowStart };
    case '3m':
    case '3months':
      // Trailing 3 calendar months, inclusive of the current month.
      return { key: '3m', label: 'Last 3 months', from: istMonthStartMs(now, -2), to: istMonthStartMs(now, 1) };
    case 'thismonth':
    case 'month':
      return { key: 'thisMonth', label: 'This month', from: istMonthStartMs(now, 0), to: istMonthStartMs(now, 1) };
    case 'prevmonth':
    case 'previousmonth':
    case 'lastmonth':
      return { key: 'prevMonth', label: 'Previous month', from: istMonthStartMs(now, -1), to: istMonthStartMs(now, 0) };
    case 'all':
      return { key: 'all', label: 'All time', from: 0, to: tomorrowStart };
    case 'custom': {
      // opts.from / opts.to are YYYY-MM-DD interpreted as IST day boundaries.
      const f = parseIstDate(opts.from);
      const t = parseIstDate(opts.to);
      const from = f == null ? 0 : f;
      const to = t == null ? tomorrowStart : (t + DAY_MS); // inclusive end day
      return { key: 'custom', label: 'Custom range', from, to };
    }
    default:
      return { key: '30d', label: 'Last 30 days', from: todayStart - 29 * DAY_MS, to: tomorrowStart };
  }
}

// YYYY-MM-DD (IST) → UTC epoch-ms of that IST midnight, or null.
function parseIstDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0) - IST_OFFSET_MIN * 60000;
}

function inWindow(ms, win) {
  return ms != null && ms >= win.from && ms < win.to;
}

// ── Record fetchers (real production data) ──────────────────────────────────
// Coupons: Supabase primary + Sheets mirror, de-duplicated by id then code —
// the exact merge services/monthlyReports.js and GET /api/admin/coupons use.
async function fetchCoupons() {
  let supaCoupons = [];
  if (supabase.isConfigured()) {
    try { supaCoupons = await supabase.getCoupons(); } catch (e) { /* fall back to sheet */ }
  }
  let sheetCoupons = [];
  try { sheetCoupons = await db.getRows(db.SHEETS.COUPONS); } catch (e) { /* may be unavailable */ }

  const merged = [];
  const seenIds = new Set();
  const seenCodes = new Set();
  const codeKey = (c) => String(c.code || '').toUpperCase().trim();
  const take = (c) => {
    merged.push(c);
    if (c.id) seenIds.add(String(c.id));
    if (codeKey(c)) seenCodes.add(codeKey(c));
  };
  (supaCoupons || []).forEach(take);
  for (const c of sheetCoupons || []) {
    if (c.id && seenIds.has(String(c.id))) continue;
    if (codeKey(c) && seenCodes.has(codeKey(c))) continue;
    take(c);
  }
  return merged;
}

async function fetchOrders() { try { return await db.getRows(db.SHEETS.ORDERS) || []; } catch (e) { return []; } }
async function fetchPayments() { try { return await db.getRows(db.SHEETS.PAYMENTS) || []; } catch (e) { return []; } }
async function fetchRefunds() { try { return await db.getRows(db.SHEETS.REFUNDS) || []; } catch (e) { return []; } }
async function fetchPayouts() { try { return await db.getRows(db.SHEETS.PAYOUTS) || []; } catch (e) { return []; } }

// ── Normalisers ─────────────────────────────────────────────────────────────
function normCoupon(c) {
  return {
    id: String(c.id || ''),
    sellingPrice: num(c.sellingPrice != null ? c.sellingPrice : c.selling_price),
    status: lower(c.status),
    source: lower(c.source),
    sellerEmail: c.sellerEmail || c.seller_email || '',
    soldAt: timeOf(c.soldAt || c.sold_at),
    faceValue: sellerPayout.faceValueOf(c),
  };
}

function isSellerListing(c) {
  const source = lower(c.source);
  if (source === 'user-submitted') return true;
  if (source === 'admin' || source === 'auto-scraped') return false;
  return Boolean(String(c.sellerEmail || '').trim());
}

// Seller revenue for one sold coupon = 7% of its face value, or 0 when it is
// not a payable seller listing / has no valid face value. Never throws.
function sellerRevenueForCoupon(c) {
  if (!isSellerListing(c)) return 0;
  try {
    return round2(sellerPayout.calculateSellerPayout(c.faceValue));
  } catch (e) {
    return 0;
  }
}

// ── Distribution (40/40/20, exact sum) ──────────────────────────────────────
// Admin1 and Admin2 are rounded to paise; SaveHatke platform absorbs the
// rounding remainder so admin1 + admin2 + platform === net exactly.
function distribute(net) {
  const base = round2(net);
  const a1 = round2(base * DISTRIBUTION.admin1);
  const a2 = round2(base * DISTRIBUTION.admin2);
  const platform = round2(base - a1 - a2);
  return {
    admin1: a1,
    admin2: a2,
    platform,
    total: round2(a1 + a2 + platform),
    percentages: { ...DISTRIBUTION },
  };
}

// ============================================================================
//  PURE COMPUTE (unit-testable without any I/O)
// ============================================================================
/**
 * @param {{orders:Array,coupons:Array,refunds:Array,payouts:Array,admins:string[]}} data
 * @param {{from:number,to:number,key:string,label:string}} win
 */
function computeOverviewFromData(data, win) {
  const orders = data.orders || [];
  const coupons = (data.coupons || []).map(normCoupon);
  const refunds = data.refunds || [];
  const payouts = data.payouts || [];
  const admins = data.admins || [];

  // ── Sales waterfall from the Orders ledger (windowed by created_at) ──
  let gross = 0, pending = 0, cancelled = 0, paid = 0;
  let ordersCount = 0, paidCount = 0, pendingCount = 0, cancelledCount = 0;
  for (const o of orders) {
    const at = timeOf(o.created_at);
    if (!inWindow(at, win)) continue;
    const amt = num(o.amount);
    const st = upper(o.status);
    gross += amt;
    ordersCount += 1;
    if (st === PAID) { paid += amt; paidCount += 1; }
    else if (st === PENDING) { pending += amt; pendingCount += 1; }
    else if (CANCELLED_SET.has(st)) { cancelled += amt; cancelledCount += 1; }
  }

  // ── Refunds (windowed by created_at; amounts are paise) ──
  let refundedValue = 0, refundedCount = 0, refundPendingCount = 0;
  for (const r of refunds) {
    const at = timeOf(r.created_at);
    if (!inWindow(at, win)) continue;
    const st = lower(r.status);
    if (st === REFUND_DONE) { refundedValue += paiseToRupees(r.refund_amount); refundedCount += 1; }
    else if (REFUND_OPEN.has(st)) { refundPendingCount += 1; }
  }
  refundedValue = round2(refundedValue);

  // ── Seller revenue from SOLD coupons (windowed by soldAt) ──
  let sellerRevenue = 0, soldCount = 0, soldSellingPrice = 0;
  for (const c of coupons) {
    if (c.status !== 'sold') continue;
    if (!inWindow(c.soldAt, win)) continue;
    soldCount += 1;
    soldSellingPrice += c.sellingPrice;
    sellerRevenue += sellerRevenueForCoupon(c);
  }
  sellerRevenue = round2(sellerRevenue);
  soldSellingPrice = round2(soldSellingPrice);

  // ── Waterfall ──
  const settledSales = round2(gross - pending - cancelled - refundedValue);
  const platformServiceFeeRevenue = round2(settledSales - sellerRevenue);
  const gatewayFees = 0;   // Not recorded anywhere — direct UPI. Do NOT invent.
  const otherCharges = 0;  // Not recorded anywhere.
  const netDistributable = round2(platformServiceFeeRevenue - gatewayFees - otherCharges);
  const distribution = distribute(netDistributable);

  // ── Reconciliation (Step 13). Variance is 0 by construction; we still
  //    surface a cross-check against the coupon "sold sellingPrice" total,
  //    which is the number the existing stats + monthly PDF report. ──
  const distributionVariance = round2(netDistributable - distribution.total);
  const settledVsSoldCoupons = round2(paid - soldSellingPrice); // ideally ~0
  const reconciled = Math.abs(distributionVariance) < 0.01;

  return {
    period: { key: win.key, label: win.label, from: win.from, to: win.to,
      fromIso: new Date(win.from).toISOString(), toIso: new Date(win.to).toISOString() },
    currency: 'INR',
    grossSales: round2(gross),
    pendingValue: round2(pending),
    cancelledValue: round2(cancelled),
    refundedValue,
    paidValue: round2(paid),
    settledSales,
    sellerRevenue,
    platformServiceFeeRevenue,
    gatewayFees,
    otherCharges,
    netDistributableRevenue: netDistributable,
    distribution: {
      admin1: { email: admins[0] || '', share: DISTRIBUTION.admin1, amount: distribution.admin1 },
      admin2: { email: admins[1] || '', share: DISTRIBUTION.admin2, amount: distribution.admin2 },
      platform: { name: 'SaveHatke', share: DISTRIBUTION.platform, amount: distribution.platform },
      total: distribution.total,
    },
    counts: {
      orders: ordersCount,
      paidOrders: paidCount,
      pendingOrders: pendingCount,
      cancelledOrders: cancelledCount,
      soldCoupons: soldCount,
      refundsCompleted: refundedCount,
      refundsOpen: refundPendingCount,
    },
    reconciliation: {
      reconciled,
      distributionVariance,
      settledVsSoldCouponsVariance: settledVsSoldCoupons,
    },
  };
}

// ============================================================================
//  PUBLIC (I/O) — fetch real records then compute
// ============================================================================
async function getOverview(period, opts = {}) {
  const win = resolveWindow(period, opts);
  const [orders, coupons, refunds, payouts] = await Promise.all([
    fetchOrders(), fetchCoupons(), fetchRefunds(), fetchPayouts(),
  ]);
  return computeOverviewFromData({ orders, coupons, refunds, payouts, admins: adminEmails() }, win);
}

// Daily gross / seller-payout-liability / net series for the dashboard chart
// (Step 22). Buckets are IST calendar days across the window.
async function getRevenueSeries(period, opts = {}) {
  const win = resolveWindow(period, opts);
  const [orders, coupons] = await Promise.all([fetchOrders(), fetchCoupons()]);
  const normCoupons = coupons.map(normCoupon);

  const days = [];
  for (let dayStart = win.from; dayStart < win.to; dayStart += DAY_MS) {
    const dayWin = { from: dayStart, to: dayStart + DAY_MS, key: 'day', label: '' };
    let gross = 0, seller = 0, paid = 0;
    for (const o of orders) {
      const at = timeOf(o.created_at);
      if (!inWindow(at, dayWin)) continue;
      const amt = num(o.amount);
      gross += amt;
      if (upper(o.status) === PAID) paid += amt;
    }
    for (const c of normCoupons) {
      if (c.status !== 'sold' || !inWindow(c.soldAt, dayWin)) continue;
      seller += sellerRevenueForCoupon(c);
    }
    const net = round2(paid - seller);
    days.push({
      date: new Date(dayStart + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10),
      grossRevenue: round2(gross),
      sellerPayouts: round2(seller),
      netRevenue: net,
    });
  }
  return { period: { key: win.key, label: win.label }, series: days };
}

// Payment-transaction list for the admin "Recent Transactions" / "Payment
// Transactions" tables. Built from the real Payments ledger, enriched from
// Orders (buyer name / coupon brand) and Coupons (brand/title), and joined to
// Refunds by payment_id for the refund-status column. READ-ONLY. Statuses are
// returned exactly as the payment system writes them (PENDING/PAID/CANCELLED/
// EXPIRED/REVIEW) — never renamed to a fake "COMPLETED".
async function getTransactions(period, opts = {}) {
  const win = resolveWindow(period, opts);
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 20, 1), 200);
  const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
  const statusFilter = opts.status ? upper(opts.status) : '';
  const search = String(opts.search || '').trim().toLowerCase();

  const [payments, orders, coupons, refunds] = await Promise.all([
    fetchPayments(), fetchOrders(), fetchCoupons(), fetchRefunds(),
  ]);

  const orderById = new Map((orders || []).map((o) => [String(o.id), o]));
  const couponById = new Map((coupons || []).map((c) => [String(c.id), c]));
  const refundByPayment = new Map();
  for (const r of refunds || []) {
    const k = String(r.payment_id || '');
    if (k) refundByPayment.set(k, r);
  }

  let rows = (payments || []).map((p) => {
    const o = orderById.get(String(p.order_id)) || {};
    const c = couponById.get(String(p.coupon_id)) || {};
    const rf = refundByPayment.get(String(p.payment_id));
    const couponLabel = c.brand
      ? `${c.brand}${c.title ? ` — ${c.title}` : ''}`
      : (o.coupon_brand || '');
    return {
      id: p.payment_id || '',
      orderCode: o.order_code || '',
      user: o.buyer_name || p.user_email || o.user_email || '',
      userEmail: p.user_email || o.user_email || '',
      couponId: p.coupon_id || '',
      coupon: couponLabel,
      amount: num(p.amount),
      currency: p.currency || 'INR',
      status: upper(p.status) || '',
      method: 'UPI',
      gatewayReference: p.verified_transaction_id || p.verified_utr || '',
      refundStatus: rf ? lower(rf.status) : '',
      createdAt: p.created_at || '',
      paidAt: p.paid_at || '',
      _ms: timeOf(p.created_at),
    };
  });

  if (win.key !== 'all') rows = rows.filter((r) => inWindow(r._ms, win));
  if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
  if (search) {
    rows = rows.filter((r) =>
      String(r.id).toLowerCase().includes(search) ||
      String(r.orderCode).toLowerCase().includes(search) ||
      String(r.user).toLowerCase().includes(search) ||
      String(r.userEmail).toLowerCase().includes(search) ||
      String(r.coupon).toLowerCase().includes(search) ||
      String(r.gatewayReference).toLowerCase().includes(search));
  }
  rows.sort((a, b) => (b._ms || 0) - (a._ms || 0));

  const total = rows.length;
  const page = rows.slice(offset, offset + limit).map((r) => { delete r._ms; return r; });
  return { period: { key: win.key, label: win.label }, total, limit, offset, transactions: page };
}

// ============================================================================
//  MONTHLY SETTLEMENT + ADMIN PAYOUT LEDGER (Phase 1 next increment)
// ============================================================================
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

async function fetchAdminPayouts() {
  try { return (await db.getRows(db.SHEETS.ADMIN_PAYOUTS)) || []; } catch (e) { return []; }
}

// Normalise one AdminPayouts ledger row.
function normAdminPayout(p) {
  return {
    id: p.id || '',
    adminEmail: lower(p.admin_email),
    adminName: p.admin_name || '',
    amount: num(p.amount),
    currency: p.currency || 'INR',
    status: lower(p.status) || 'pending',
    paymentReference: p.payment_reference || '',
    note: p.note || '',
    rejectionReason: p.rejection_reason || '',
    requestedAt: p.requested_at || '',
    processedAt: p.processed_at || '',
    processedBy: p.processed_by || '',
    createdBy: p.created_by || '',
    createdAt: p.created_at || '',
    updatedAt: p.updated_at || '',
    _ms: timeOf(p.processed_at || p.requested_at || p.created_at),
  };
}

// IST calendar-month window from an explicit year + month (1-12).
function monthWindowYM(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!Number.isInteger(y) || m < 1 || m > 12) return null;
  const from = Date.UTC(y, m - 1, 1, 0, 0, 0, 0) - IST_OFFSET_MIN * 60000;
  const to = Date.UTC(y, m, 1, 0, 0, 0, 0) - IST_OFFSET_MIN * 60000;
  return { key: `${y}-${String(m).padStart(2, '0')}`, label: `${MONTH_NAMES[m - 1]} ${y}`, from, to };
}

// Sum seller PAYOUTS rows by status within a window (by processed/requested date).
function sumSellerPayouts(payouts, statusSet, win) {
  let amount = 0, count = 0;
  for (const p of payouts || []) {
    if (!statusSet.has(lower(p.status))) continue;
    const t = timeOf(p.processedAt || p.processed_at || p.requestedAt || p.requested_at);
    if (win && !inWindow(t, win)) continue;
    amount += num(p.amount); count += 1;
  }
  return { amount: round2(amount), count };
}

// Full monthly settlement for a specific year/month, from the central model.
async function getSettlement(year, month) {
  const win = monthWindowYM(year, month);
  if (!win) throw new Error('Invalid year/month.');
  const [orders, coupons, refunds, payouts, adminPayoutsRaw] = await Promise.all([
    fetchOrders(), fetchCoupons(), fetchRefunds(), fetchPayouts(), fetchAdminPayouts(),
  ]);
  const overview = computeOverviewFromData({ orders, coupons, refunds, payouts, admins: adminEmails() }, win);
  const sellerPaid = sumSellerPayouts(payouts, new Set(['paid']), win);
  const sellerPending = sumSellerPayouts(payouts, new Set(['pending', 'processing']), win);

  const ledger = adminPayoutsRaw.map(normAdminPayout);
  const admins = adminEmails();
  const perAdmin = [
    { key: 'admin1', email: admins[0] || '', allocated: overview.distribution.admin1.amount },
    { key: 'admin2', email: admins[1] || '', allocated: overview.distribution.admin2.amount },
  ].map((a) => {
    const mine = ledger.filter((p) => a.email && p.adminEmail === a.email && inWindow(p._ms, win));
    const by = (st) => round2(mine.filter((p) => p.status === st).reduce((s, p) => s + p.amount, 0));
    return { ...a, paid: by('paid'), processing: by('processing'), pending: by('pending') };
  });

  return {
    month: win.key,
    monthLabel: win.label,
    periodStart: new Date(win.from).toISOString(),
    periodEnd: new Date(win.to - 1).toISOString(),
    overview,
    sellerPayouts: { paid: sellerPaid.amount, paidCount: sellerPaid.count, pending: sellerPending.amount },
    adminPayouts: perAdmin,
    platformAllocated: overview.distribution.platform.amount,
  };
}

// Per-admin balances from ALL-TIME net distributable minus ledger commitments.
// Rejected/failed payouts never reduce the balance; the same payout cannot be
// counted twice because each ledger row has a unique id and one status.
async function getAdminBalances() {
  const [overviewAll, adminPayoutsRaw] = await Promise.all([getOverview('all'), fetchAdminPayouts()]);
  const admins = adminEmails();
  const ledger = adminPayoutsRaw.map(normAdminPayout);
  const build = (email, name, allocated) => {
    const mine = ledger.filter((p) => email && p.adminEmail === email);
    const by = (st) => round2(mine.filter((p) => p.status === st).reduce((s, p) => s + p.amount, 0));
    const paid = by('paid'), processing = by('processing'), pending = by('pending');
    return { email, name, allocated, paid, processing, pending, available: round2(allocated - paid - processing - pending) };
  };
  return {
    netDistributableRevenue: overviewAll.netDistributableRevenue,
    percentages: { ...DISTRIBUTION },
    admins: {
      admin1: build(admins[0] || '', 'Admin 1', overviewAll.distribution.admin1.amount),
      admin2: build(admins[1] || '', 'Admin 2', overviewAll.distribution.admin2.amount),
      platform: { name: 'SaveHatke', allocated: overviewAll.distribution.platform.amount },
    },
    ledger: ledger.sort((a, b) => (b._ms || 0) - (a._ms || 0)).map((p) => { const q = { ...p }; delete q._ms; return q; }),
  };
}

async function getAdminPayoutStats() {
  const ledger = (await fetchAdminPayouts()).map(normAdminPayout);
  const pending = ledger.filter((p) => p.status === 'pending');
  const processing = ledger.filter((p) => p.status === 'processing');
  const paid = ledger.filter((p) => p.status === 'paid');
  return {
    pendingCount: pending.length,
    pendingAmount: round2(pending.reduce((s, p) => s + p.amount, 0)),
    processingCount: processing.length,
    paidTotal: round2(paid.reduce((s, p) => s + p.amount, 0)),
    total: ledger.length,
  };
}

module.exports = {
  DISTRIBUTION,
  adminEmails,
  resolveWindow,
  istMidnightMs,
  istMonthStartMs,
  distribute,
  computeOverviewFromData,
  getOverview,
  getRevenueSeries,
  getTransactions,
  getSettlement,
  getAdminBalances,
  getAdminPayoutStats,
  fetchAdminPayouts,
  monthWindowYM,
  normAdminPayout,
  // exposed for reuse/testing
  _internals: { normCoupon, isSellerListing, sellerRevenueForCoupon, inWindow, paiseToRupees },
};
