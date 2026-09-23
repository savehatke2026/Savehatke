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
const finance = require('../services/finance');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');

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
      return res.status(400).json({ error: err.message });
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
router.post('/admin-payouts', authenticateToken, requireAdmin, async (req, res) => {
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
router.post('/admin-payouts/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
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
    await db.updateRow(db.SHEETS.ADMIN_PAYOUTS, 'id', id, updates);
    await auditFinancial(req, 'admin_payout_paid', id, { paymentReference: updates.payment_reference });
    const updated = await db.findRow(db.SHEETS.ADMIN_PAYOUTS, 'id', id).catch(() => null);
    res.json({ ok: true, payout: finance.normAdminPayout(updated || { ...existing, ...updates }) });
  } catch (err) {
    console.error('Approve admin payout error:', err);
    res.status(500).json({ error: 'Could not update payout.' });
  }
});

// POST reject an admin payout (does NOT permanently reduce the balance)
router.post('/admin-payouts/:id/reject', authenticateToken, requireAdmin, async (req, res) => {
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
    await db.updateRow(db.SHEETS.ADMIN_PAYOUTS, 'id', id, updates);
    await auditFinancial(req, 'admin_payout_rejected', id, { reason: updates.rejection_reason });
    const updated = await db.findRow(db.SHEETS.ADMIN_PAYOUTS, 'id', id).catch(() => null);
    res.json({ ok: true, payout: finance.normAdminPayout(updated || { ...existing, ...updates }) });
  } catch (err) {
    console.error('Reject admin payout error:', err);
    res.status(500).json({ error: 'Could not update payout.' });
  }
});

// GET /api/admin/finance/report?year=YYYY&month=M  — full monthly report DATA
// object (the single prepared object the master-PDF generator consumes). Real,
// read-only, same source of truth as the dashboard/overview/settlement.
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
      return res.status(400).json({ error: err.message });
    }
    console.error('Finance report error:', err);
    res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
});

module.exports = router;
