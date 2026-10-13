'use strict';

// ============================================================================
// SaveHatke — Admin Financial API (READ-ONLY, Phase 1)
// ============================================================================
// Every endpoint here is admin-only and derives its numbers from the single
// financial source of truth in services/finance.js. Nothing here mutates a
// payment, order, payout or refund, and nothing touches the PDF generator.
//
// Mounted at /api/admin/finance (see server.js). Authorization reuses the
// existing admin auth + role system (authenticateToken + requireAdmin); the
// caller identity always comes from the verified token, never from the body.
//
// Error handling (Step 27): when the underlying data store is unreachable we
// return HTTP 503 with { error, dataUnavailable: true } so the UI can show
// "Unable to load financial data." instead of a misleading ₹0.

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { adminFinancialLimiter } = require('../utils/adminRateLimit');
const finance = require('../services/finance');
const adminLedger = require('../services/adminLedger');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');
const { generateMonthlyReportPdf } = require('../utils/monthlyReportPdf');

const router = express.Router();

function nowIso() { return new Date().toISOString(); }
function actingAdmin(req) {
  return String((req.user && (req.user.email || req.user.name)) || 'admin').toLowerCase().trim();
}

// Best-effort append-only audit trail for financial actions. Reuses the
// existing SecurityAudit sheet; never fatal, never logs secrets.
async function auditFinancial(req, event, recordId, detail) {
  try {
    await db.appendRow(db.SHEETS.SECURITY_AUDIT, {
      id: uuidv4(),
      userId: String((req.user && (req.user.id || req.user.user_id)) || ''),
      email: actingAdmin(req),
      event,
      outcome: 'success',
      ipAddress: (req.ip || '').slice(0, 60),
      device: String(req.headers['user-agent'] || '').slice(0, 120),
      detail: (() => { try { return JSON.stringify({ recordId, ...detail }).slice(0, 480); } catch (e) { return String(recordId); } })(),
      createdAt: nowIso(),
    });
  } catch (e) { /* audit is best-effort */ }
}

function storeReachable() {
  let sheets = false;
  try { sheets = db.isSheetsConnected(); } catch (e) { sheets = false; }
  let supa = false;
  try { supa = supabase.isConfigured(); } catch (e) { supa = false; }
  return sheets || supa;
}

// GET /api/admin/finance/overview?period=today|7d|30d|3m|thisMonth|prevMonth|custom&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/overview', authenticateToken, requireAdmin, async (req, res) => {
  if (!storeReachable()) {
    return res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
  try {
    const { period, from, to } = req.query;
    const overview = await finance.getOverview(period, { from, to });
    res.json({ ok: true, overview });
  } catch (err) {
    console.error('Finance overview error:', err);
    res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
});

// GET /api/admin/finance/series?period=7d|30d|3m  — daily chart series
router.get('/series', authenticateToken, requireAdmin, async (req, res) => {
  if (!storeReachable()) {
    return res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
  try {
    const { period, from, to } = req.query;
    const data = await finance.getRevenueSeries(period, { from, to });
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error('Finance series error:', err);
    res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
});

// GET /api/admin/finance/transactions?period=&status=&limit=&offset=
// Real payment records (Payments ledger, enriched from Orders/Coupons/Refunds).
router.get('/transactions', authenticateToken, requireAdmin, async (req, res) => {
  if (!storeReachable()) {
    return res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
  try {
    const { period, from, to, limit, offset, status, search } = req.query;
    const data = await finance.getTransactions(period, { from, to, limit, offset, status, search });
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error('Finance transactions error:', err);
    res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
});

// GET /api/admin/finance/settlement?year=YYYY&month=M  — monthly reconciliation.
// Also UPSERTS the MonthlySettlements sheet row (create-or-update by month;
// never appends a duplicate). The sheet write is best-effort and never blocks
// the response.
router.get('/settlement', authenticateToken, requireAdmin, async (req, res) => {
  if (!storeReachable()) {
    return res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
  try {
    const now = new Date();
    const year = req.query.year || now.getFullYear();
    const month = req.query.month || (now.getMonth() + 1);
    const settlement = await finance.getSettlement(year, month);

    let synced = false;
    try { synced = await upsertSettlementRow(settlement); } catch (e) { synced = false; }

    res.json({ ok: true, settlement, synced });
  } catch (err) {
    if (/Invalid year\/month/.test(err.message || '')) {
      return res.status(400).json({ error: 'Year and month must describe a valid reporting period.' });
    }
    console.error('Finance settlement error:', err);
    res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
});

// Create-or-update the MonthlySettlements row for a month. Returns true on write.
async function upsertSettlementRow(s) {
  const o = s.overview;
  const record = {
    month: s.month,
    monthLabel: s.monthLabel,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    grossSales: o.grossSales,
    pendingSales: o.pendingValue,
    cancelledSales: o.cancelledValue,
    refundedSales: o.refundedValue,
    settledSales: o.settledSales,
    sellerRevenue: o.sellerRevenue,
    platformServiceFeeRevenue: o.platformServiceFeeRevenue,
    gatewayFees: o.gatewayFees,
    otherCharges: o.otherCharges,
    netDistributableRevenue: o.netDistributableRevenue,
    admin1Allocation: o.distribution.admin1.amount,
    admin2Allocation: o.distribution.admin2.amount,
    platformAllocation: o.distribution.platform.amount,
    reconciliationVariance: o.reconciliation.distributionVariance,
    updatedAt: nowIso(),
  };
  const existing = await db.findRow(db.SHEETS.MONTHLY_SETTLEMENTS, 'month', s.month).catch(() => null);
  if (existing) {
    await db.updateRow(db.SHEETS.MONTHLY_SETTLEMENTS, 'month', s.month, record);
  } else {
    await db.appendRow(db.SHEETS.MONTHLY_SETTLEMENTS, { id: uuidv4(), ...record });
  }
  return true;
}

// ── Admin payout ledger (40/40/20) ──────────────────────────────────────────
// GET balances + ledger
router.get('/admin-payouts', authenticateToken, requireAdmin, async (req, res) => {
  if (!storeReachable()) {
    return res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
  try {
    const data = await finance.getAdminBalances();
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error('Admin payouts error:', err);
    res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
});

// GET pending stats (dashboard "Admin Payouts Pending")
router.get('/admin-payouts/stats', authenticateToken, requireAdmin, async (req, res) => {
  if (!storeReachable()) {
    return res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
  try {
    const stats = await finance.getAdminPayoutStats();
    res.json({ ok: true, ...stats });
  } catch (err) {
    console.error('Admin payout stats error:', err);
    res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
});

// POST create an admin payout request (status PENDING). Validates the recipient
// is a configured admin and that the amount does not exceed available balance.
router.post('/admin-payouts', authenticateToken, requireAdmin, adminFinancialLimiter, async (req, res) => {
  if (!db.isSheetsConnected()) {
    return res.status(503).json({ error: 'Google Sheets is not connected; cannot record payout.' });
  }
  try {
    const { adminEmail, amount, note } = req.body || {};
    const email = String(adminEmail || '').toLowerCase().trim();
    const amt = Math.round(Number(amount) * 100) / 100;
    const allowed = finance.adminEmails();
    if (!allowed.includes(email)) {
      return res.status(400).json({ error: 'Recipient must be a configured admin.' });
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number.' });
    }
    const balances = await finance.getAdminBalances();
    const who = balances.admins.admin1.email === email ? balances.admins.admin1
      : (balances.admins.admin2.email === email ? balances.admins.admin2 : null);
    if (!who) return res.status(400).json({ error: 'Recipient is not an allocated admin.' });
    if (amt > who.available + 0.001) {
      return res.status(400).json({ error: `Amount exceeds available balance (₹${who.available}).` });
    }

    const id = 'AP-' + uuidv4().slice(0, 8).toUpperCase();
    const row = {
      id,
      admin_email: email,
      admin_name: who.name || '',
      amount: amt,
      currency: 'INR',
      status: 'pending',
      payment_reference: '',
      note: String(note || '').slice(0, 500),
      rejection_reason: '',
      requested_at: nowIso(),
      processed_at: '',
      processed_by: '',
      created_by: actingAdmin(req),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    await db.appendRow(db.SHEETS.ADMIN_PAYOUTS, row);
    await auditFinancial(req, 'admin_payout_created', id, { adminEmail: email, amount: amt });
    res.json({ ok: true, payout: finance.normAdminPayout(row) });
  } catch (err) {
    console.error('Create admin payout error:', err);
    res.status(500).json({ error: 'Could not create admin payout.' });
  }
});

// POST mark an admin payout PAID
//
// Approving a payout is a real disbursement, so the two failure modes that
// matter are (a) two concurrent approvals both reporting success, and (b) a
// spreadsheet write that never landed still being reported as success.
//
//   • The status write is strict: Google Sheets must acknowledge it before this
//     handler believes it happened. A non-strict updateRow falls back to this
//     instance's in-memory mirror during an outage, which would return
//     { ok: true } for a payout that is still pending in the ledger — and the
//     human then pays it a second time.
//   • The status is re-read after the write (compare-and-set). If another
//     approval won the race, or the sheet still shows a non-paid status, this
//     request reports a conflict instead of success.
router.post('/admin-payouts/:id/approve', authenticateToken, requireAdmin, adminFinancialLimiter, async (req, res) => {
  if (!db.isSheetsConnected()) {
    return res.status(503).json({ error: 'Google Sheets is not connected; cannot update payout.' });
  }
  try {
    const { id } = req.params;
    const { paymentReference, note } = req.body || {};
    const existing = await db.findRow(db.SHEETS.ADMIN_PAYOUTS, 'id', id).catch(() => null);
    if (!existing) return res.status(404).json({ error: 'Admin payout not found.' });
    if (String(existing.status).toLowerCase() === 'paid') {
      return res.status(400).json({ error: 'This payout is already marked as paid.' });
    }
    const updates = {
      status: 'paid',
      payment_reference: String(paymentReference || '').slice(0, 120),
      note: String(note || existing.note || '').slice(0, 500),
      processed_at: nowIso(),
      processed_by: actingAdmin(req),
      updated_at: nowIso(),
    };
    await db.updateRow(db.SHEETS.ADMIN_PAYOUTS, 'id', id, updates, { strict: true });

    // Compare-and-set: read the authoritative row back before claiming success.
    const written = await db.findRow(db.SHEETS.ADMIN_PAYOUTS, 'id', id).catch(() => null);
    if (!written || String(written.status).toLowerCase() !== 'paid') {
      console.error(`[adminFinance] payout ${id} approval did not land (status=${written && written.status})`);
      return res.status(409).json({
        error: 'This payout could not be marked as paid — it may have been processed by someone else. Reload the page.',
      });
    }

    await auditFinancial(req, 'admin_payout_paid', id, { paymentReference: updates.payment_reference });
    res.json({ ok: true, payout: finance.normAdminPayout(written) });
  } catch (err) {
    // Strict write failed: the payout is NOT paid. Never report success.
    console.error('Approve admin payout error:', err && err.message ? err.message : err);
    res.status(503).json({ error: 'The payout could not be saved. Nothing was changed — please try again.' });
  }
});

// POST reject an admin payout (does NOT permanently reduce the balance)
router.post('/admin-payouts/:id/reject', authenticateToken, requireAdmin, adminFinancialLimiter, async (req, res) => {
  if (!db.isSheetsConnected()) {
    return res.status(503).json({ error: 'Google Sheets is not connected; cannot update payout.' });
  }
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const existing = await db.findRow(db.SHEETS.ADMIN_PAYOUTS, 'id', id).catch(() => null);
    if (!existing) return res.status(404).json({ error: 'Admin payout not found.' });
    if (String(existing.status).toLowerCase() === 'paid') {
      return res.status(400).json({ error: 'Cannot reject a payout that is already paid.' });
    }
    const updates = {
      status: 'rejected',
      rejection_reason: String(reason || '').slice(0, 500),
      processed_at: nowIso(),
      processed_by: actingAdmin(req),
      updated_at: nowIso(),
    };
    await db.updateRow(db.SHEETS.ADMIN_PAYOUTS, 'id', id, updates, { strict: true });

    const written = await db.findRow(db.SHEETS.ADMIN_PAYOUTS, 'id', id).catch(() => null);
    if (!written || String(written.status).toLowerCase() !== 'rejected') {
      console.error(`[adminFinance] payout ${id} rejection did not land (status=${written && written.status})`);
      return res.status(409).json({
        error: 'This payout could not be rejected — it may have been processed by someone else. Reload the page.',
      });
    }

    await auditFinancial(req, 'admin_payout_rejected', id, { reason: updates.rejection_reason });
    res.json({ ok: true, payout: finance.normAdminPayout(written) });
  } catch (err) {
    console.error('Reject admin payout error:', err && err.message ? err.message : err);
    res.status(503).json({ error: 'The payout could not be saved. Nothing was changed — please try again.' });
  }
});

// GET /api/admin/finance/report?year=YYYY&month=M  — full monthly report DATA
// object (the single prepared object the master-PDF generator consumes). This
// report endpoint is read-only and uses the dashboard/overview source of truth.
router.get('/report', authenticateToken, requireAdmin, async (req, res) => {
  if (!storeReachable()) {
    return res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
  try {
    const now = new Date();
    const year = req.query.year || now.getFullYear();
    const month = req.query.month || (now.getMonth() + 1);
    const report = await finance.buildMonthlyReportData(year, month);
    res.json({ ok: true, report });
  } catch (err) {
    if (/Invalid year\/month/.test(err.message || '')) {
      return res.status(400).json({ error: 'Year and month must describe a valid reporting period.' });
    }
    console.error('Finance report error:', err);
    res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
});

// GET /api/admin/finance/report/pdf?year=YYYY&month=M  — the monthly report
// rendered onto the approved master template with REAL data. READ-ONLY.
router.get('/report/pdf', authenticateToken, requireAdmin, async (req, res) => {
  if (!storeReachable()) {
    return res.status(503).json({ error: 'Unable to generate report — financial data is unavailable.', dataUnavailable: true });
  }
  try {
    const now = new Date();
    const year = req.query.year || now.getFullYear();
    const month = req.query.month || (now.getMonth() + 1);
    const report = await finance.buildMonthlyReportData(year, month);
    const { buffer } = await generateMonthlyReportPdf(report);
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const [yy, mm] = String(report.period.key).split('-').map(Number);
    const fname = `SaveHatke_Monthly_Revenue_Report_${MON[mm - 1]}${yy}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    if (/Invalid year\/month/.test(err.message || '')) return res.status(400).json({ error: 'Year and month must describe a valid reporting period.' });
    console.error('Finance report PDF error:', err);
    res.status(503).json({ error: 'Unable to generate report — financial data is unavailable.', dataUnavailable: true });
  }
});

// ── Transactions & Orders (admin, read-only except Retry Verification) ─────────
// Transactions = payment attempts; Orders = customer purchases. Both are derived
// from the existing Orders / Payments / Refunds / Coupons records (services/
// adminLedger.js). Nothing is copied into a new store.

// GET /api/admin/finance/payments?period=&from=&to=&status=&issue=&search=&limit=&offset=
router.get('/payments', authenticateToken, requireAdmin, async (req, res) => {
  if (!storeReachable()) return res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  try {
    const data = await adminLedger.listTransactions(req.query);
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error('Admin transactions error:', err && err.message ? err.message : err);
    res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
});

// GET /api/admin/finance/payments/export.csv?...  (same filters, capped at 10,000 rows)
router.get('/payments/export.csv', authenticateToken, requireAdmin, adminFinancialLimiter, async (req, res) => {
  if (!storeReachable()) return res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  try {
    const { csv, count, truncated } = await adminLedger.exportTransactionsCsv(req.query);
    await auditFinancial(req, 'admin_transactions_exported', 'payments', { rows: count, truncated, filters: pickFilters(req.query) });
    sendCsv(res, `SaveHatke_Transactions_${stamp()}.csv`, csv, truncated);
  } catch (err) {
    console.error('Transactions export error:', err && err.message ? err.message : err);
    res.status(503).json({ error: 'Unable to export financial data.', dataUnavailable: true });
  }
});

// GET /api/admin/finance/payments/:paymentId  — full investigation view
router.get('/payments/:paymentId', authenticateToken, requireAdmin, async (req, res) => {
  if (!storeReachable()) return res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  try {
    const detail = await adminLedger.getTransactionDetail(req.params.paymentId);
    if (!detail) return res.status(404).json({ error: 'Payment not found.' });
    res.json({ ok: true, ...detail });
  } catch (err) {
    console.error('Admin transaction detail error:', err && err.message ? err.message : err);
    res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
});

// POST /api/admin/finance/payments/:paymentId/retry-verification
// Re-runs the SAME verifier the buyer's "I've paid" button uses: a mailbox scan
// that can only settle a payment from an independent FamApp credit matched on
// amount and window. It accepts no status, amount or UTR from the caller, so an
// admin cannot self-certify a payment through this endpoint. Idempotent: an
// already-decided payment returns its current state without a second scan.
router.post('/payments/:paymentId/retry-verification', authenticateToken, requireAdmin, adminFinancialLimiter, async (req, res) => {
  const paymentId = String(req.params.paymentId || '').trim();
  if (!paymentId) return res.status(400).json({ error: 'A payment id is required.' });
  if (!storeReachable()) return res.status(503).json({ error: 'Unable to verify — financial data is unavailable.', dataUnavailable: true });
  try {
    const store = require('../services/paymentStore');
    const verifier = require('../services/paymentVerifier');
    const ready = await store.ensureReady();
    if (!ready.ok) return res.status(503).json({ error: 'Payment storage is temporarily unavailable. Please try again later.' });

    const before = await store.findPaymentById(paymentId);
    if (!before) return res.status(404).json({ error: 'Payment not found.' });

    if (before.status !== 'PENDING') {
      await auditFinancial(req, 'admin_retry_verification', paymentId, { outcome: 'NOT_PENDING', status: before.status });
      return res.json({ ok: true, payment: { paymentId, status: before.status }, scanned: false, changed: false });
    }

    // Past the backend checking deadline the payment can no longer be matched:
    // expire it exactly as the buyer flow does, rather than scanning.
    const deadline = new Date(before.checkExpiresAt || before.expiresAt).getTime();
    if (Number.isFinite(deadline) && deadline <= Date.now()) {
      await store.expireIfDue(paymentId);
      const after = await store.findPaymentById(paymentId);
      await auditFinancial(req, 'admin_retry_verification', paymentId, { outcome: 'EXPIRED', status: after && after.status });
      return res.json({ ok: true, payment: { paymentId, status: after && after.status }, scanned: false, changed: true });
    }

    const mail = await verifier.triggerMailboxScan({ force: true, maxMessages: 15 });
    const after = await store.findPaymentById(paymentId);
    const changed = !!after && after.status !== before.status;
    await auditFinancial(req, 'admin_retry_verification', paymentId, {
      outcome: changed ? 'SETTLED_OR_CHANGED' : 'NO_MATCH',
      status: after && after.status,
      mailboxOk: !!(mail && mail.ok),
    });
    res.json({
      ok: true,
      payment: { paymentId, status: after ? after.status : before.status },
      scanned: !!(mail && mail.ok),
      changed,
      mailboxReason: mail && mail.ok ? '' : 'Mailbox verification is temporarily unavailable.',
    });
  } catch (err) {
    console.error('Retry verification error:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Verification could not run. Nothing was changed.' });
  }
});

// GET /api/admin/finance/orders?period=&from=&to=&status=&delivery=&search=&limit=&offset=
router.get('/orders', authenticateToken, requireAdmin, async (req, res) => {
  if (!storeReachable()) return res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  try {
    const data = await adminLedger.listOrders(req.query);
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error('Admin orders error:', err && err.message ? err.message : err);
    res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
});

// GET /api/admin/finance/orders/export.csv?...
router.get('/orders/export.csv', authenticateToken, requireAdmin, adminFinancialLimiter, async (req, res) => {
  if (!storeReachable()) return res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  try {
    const { csv, count, truncated } = await adminLedger.exportOrdersCsv(req.query);
    await auditFinancial(req, 'admin_orders_exported', 'orders', { rows: count, truncated, filters: pickFilters(req.query) });
    sendCsv(res, `SaveHatke_Orders_${stamp()}.csv`, csv, truncated);
  } catch (err) {
    console.error('Orders export error:', err && err.message ? err.message : err);
    res.status(503).json({ error: 'Unable to export order data.', dataUnavailable: true });
  }
});

// GET /api/admin/finance/orders/:orderId  — order + linked payment attempts
router.get('/orders/:orderId', authenticateToken, requireAdmin, async (req, res) => {
  if (!storeReachable()) return res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  try {
    const detail = await adminLedger.getOrderDetail(req.params.orderId);
    if (!detail) return res.status(404).json({ error: 'Order not found.' });
    res.json({ ok: true, ...detail });
  } catch (err) {
    console.error('Admin order detail error:', err && err.message ? err.message : err);
    res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
});

function pickFilters(q = {}) {
  return ['period', 'from', 'to', 'status', 'issue', 'delivery', 'search']
    .reduce((acc, k) => { if (q[k]) acc[k] = String(q[k]).slice(0, 60); return acc; }, {});
}

function stamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); }

function sendCsv(res, filename, csv, truncated) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  if (truncated) res.setHeader('X-Export-Truncated', 'true');
  res.send(csv);
}

module.exports = router;
