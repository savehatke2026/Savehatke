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
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const finance = require('../services/finance');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');

const router = express.Router();

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
    const { period, from, to, limit, offset, status } = req.query;
    const data = await finance.getTransactions(period, { from, to, limit, offset, status });
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error('Finance transactions error:', err);
    res.status(503).json({ error: 'Unable to load financial data.', dataUnavailable: true });
  }
});

module.exports = router;
