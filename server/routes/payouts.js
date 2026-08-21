// ============================================
// SaveHatke — Payouts Routes
// ============================================
// Admin pays sellers when their coupons are sold.
// All sellers earn ₹10 per sold coupon. The platform tracks payouts
// in a dedicated Google Sheet tab (Payouts) and exposes admin and
// seller-facing endpoints.

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const db = require('../services/googleSheets');

const router = express.Router();

// Per-coupon earning (matches the offer in /api/coupons/sell)
const PER_COUPON_EARNING = 10;

// ─── Helpers ──────────────────────────────────────────────────────
function nowIso() {
  return new Date().toISOString();
}

function sanitize(payout) {
  return {
    id: payout.id,
    sellerEmail: payout.sellerEmail,
    sellerUserId: payout.sellerUserId || '',
    amount: Number(payout.amount || 0),
    currency: payout.currency || 'INR',
    method: payout.method || 'UPI',
    upiId: payout.upiId || '',
    bankAccount: payout.bankAccount || '',
    bankIfsc: payout.bankIfsc || '',
    beneficiaryName: payout.beneficiaryName || '',
    status: payout.status || 'pending',
    sourceType: payout.sourceType || 'auto',
    sourceCouponId: payout.sourceCouponId || '',
    requestedAt: payout.requestedAt || '',
    processedAt: payout.processedAt || '',
    processedBy: payout.processedBy || '',
    paymentReference: payout.paymentReference || '',
    rejectionReason: payout.rejectionReason || '',
    notes: payout.notes || '',
  };
}

async function getAllPayouts() {
  return db.getRows(db.SHEETS.PAYOUTS);
}

async function findPayoutById(id) {
  if (!id) return null;
  const all = await getAllPayouts();
  return all.find((p) => String(p.id) === String(id)) || null;
}

async function sumPayoutsByStatus(payouts) {
  const out = { pending: 0, processing: 0, paid: 0, rejected: 0, count: payouts.length };
  for (const p of payouts) {
    const s = String(p.status || 'pending').toLowerCase();
    const amt = Number(p.amount || 0);
    if (out[s] !== undefined) out[s] += amt;
  }
  return out;
}

function getStartOfCurrentMonthIso() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

// ===================================================
//  ADMIN ENDPOINTS
// ===================================================

// GET /api/admin/payouts — list payouts with optional filters
router.get('/admin/payouts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status, search } = req.query;
    let rows = await getAllPayouts();

    if (status && status !== 'all') {
      const wanted = String(status).toLowerCase();
      rows = rows.filter((r) => String(r.status || 'pending').toLowerCase() === wanted);
    }
    if (search) {
      const q = String(search).toLowerCase();
      rows = rows.filter((r) =>
        String(r.sellerEmail || '').toLowerCase().includes(q) ||
        String(r.id || '').toLowerCase().includes(q) ||
        String(r.upiId || '').toLowerCase().includes(q) ||
        String(r.beneficiaryName || '').toLowerCase().includes(q)
      );
    }

    // Newest first
    rows.sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));

    res.json({ payouts: rows.map(sanitize) });
  } catch (err) {
    console.error('List payouts error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/admin/payouts/stats — aggregated stats for the header cards
router.get('/admin/payouts/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const rows = await getAllPayouts();
    const monthStart = getStartOfCurrentMonthIso();
    const monthRows = rows.filter((r) => new Date(r.processedAt || r.requestedAt || 0) >= new Date(monthStart));

    const paidThisMonth = monthRows
      .filter((r) => String(r.status).toLowerCase() === 'paid')
      .reduce((s, r) => s + Number(r.amount || 0), 0);

    const pending = rows.filter((r) => String(r.status || 'pending').toLowerCase() === 'pending');
    const pendingAmount = pending.reduce((s, r) => s + Number(r.amount || 0), 0);

    const paidTotal = rows
      .filter((r) => String(r.status).toLowerCase() === 'paid')
      .reduce((s, r) => s + Number(r.amount || 0), 0);

    const rejectedCount = rows.filter((r) => String(r.status).toLowerCase() === 'rejected').length;

    res.json({
      paidThisMonth,
      pendingCount: pending.length,
      pendingAmount,
      paidTotal,
      rejectedCount,
      totalPayouts: rows.length,
    });
  } catch (err) {
    console.error('Payout stats error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/admin/payouts/:id/approve — mark a payout as paid
router.post('/admin/payouts/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentReference, notes } = req.body || {};
    const payout = await findPayoutById(id);
    if (!payout) return res.status(404).json({ error: 'Payout not found.' });
    if (String(payout.status).toLowerCase() === 'paid') {
      return res.status(400).json({ error: 'This payout is already marked as paid.' });
    }

    const updates = {
      status: 'paid',
      processedAt: nowIso(),
      processedBy: req.user.email || req.user.name || 'admin',
      paymentReference: String(paymentReference || '').slice(0, 120),
      notes: String(notes || payout.notes || '').slice(0, 500),
    };

    await db.updateRow(db.SHEETS.PAYOUTS, 'id', id, updates);

    const updated = await findPayoutById(id);
    res.json({ message: 'Payout marked as paid.', payout: sanitize(updated) });
  } catch (err) {
    console.error('Approve payout error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/admin/payouts/:id/reject — mark a payout as rejected
router.post('/admin/payouts/:id/reject', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const payout = await findPayoutById(id);
    if (!payout) return res.status(404).json({ error: 'Payout not found.' });
    if (String(payout.status).toLowerCase() === 'paid') {
      return res.status(400).json({ error: 'Cannot reject a payout that is already paid.' });
    }

    const updates = {
      status: 'rejected',
      processedAt: nowIso(),
      processedBy: req.user.email || req.user.name || 'admin',
      rejectionReason: String(reason || '').slice(0, 500),
    };

    await db.updateRow(db.SHEETS.PAYOUTS, 'id', id, updates);

    const updated = await findPayoutById(id);
    res.json({ message: 'Payout rejected.', payout: sanitize(updated) });
  } catch (err) {
    console.error('Reject payout error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/admin/payouts/batch-process — approve multiple pending payouts
router.post('/admin/payouts/batch-process', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { ids, paymentReference } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array of payout IDs.' });
    }
    if (ids.length > 200) {
      return res.status(400).json({ error: 'Cannot process more than 200 payouts at once.' });
    }

    const admin = req.user.email || req.user.name || 'admin';
    const ref = String(paymentReference || `batch-${Date.now()}`).slice(0, 120);
    const results = { processed: 0, skipped: [], errors: [] };

    for (const id of ids) {
      try {
        const payout = await findPayoutById(id);
        if (!payout) { results.skipped.push({ id, reason: 'not_found' }); continue; }
        if (String(payout.status).toLowerCase() !== 'pending') {
          results.skipped.push({ id, reason: `status_${payout.status}` });
          continue;
        }
        await db.updateRow(db.SHEETS.PAYOUTS, 'id', id, {
          status: 'paid',
          processedAt: nowIso(),
          processedBy: admin,
          paymentReference: ref,
        });
        results.processed += 1;
      } catch (e) {
        results.errors.push({ id, error: e.message });
      }
    }

    res.json({
      message: `Processed ${results.processed} payout${results.processed === 1 ? '' : 's'}.`,
      ...results,
    });
  } catch (err) {
    console.error('Batch payout error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ===================================================
//  SELLER ENDPOINTS
// ===================================================

// GET /api/payouts/my — seller's own payout history + summary
router.get('/payouts/my', authenticateToken, async (req, res) => {
  try {
    const email = (req.user.email || '').toLowerCase().trim();
    const all = await getAllPayouts();
    const mine = all
      .filter((p) => String(p.sellerEmail || '').toLowerCase() === email)
      .sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));

    const summary = {
      totalPaid: mine.filter((p) => String(p.status).toLowerCase() === 'paid').reduce((s, p) => s + Number(p.amount || 0), 0),
      pending: mine.filter((p) => String(p.status || 'pending').toLowerCase() === 'pending').reduce((s, p) => s + Number(p.amount || 0), 0),
      rejected: mine.filter((p) => String(p.status).toLowerCase() === 'rejected').length,
      totalCount: mine.length,
    };

    res.json({ payouts: mine.map(sanitize), summary });
  } catch (err) {
    console.error('My payouts error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/payouts/request — seller requests a payout of their current balance
router.post('/payouts/request', authenticateToken, async (req, res) => {
  try {
    const { amount, method, upiId, bankAccount, bankIfsc, beneficiaryName } = req.body || {};
    const email = (req.user.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'User email not found.' });

    // Compute the seller's available balance (sum of pending + un-requested earnings)
    // Currently: each sold coupon auto-creates a payout entry. Sellers can group
    // multiple pending payouts into a single request by amount, but only if
    // those individual entries aren't already in 'requested' state. For simplicity,
    // a manual request creates a NEW payout with sourceType='manual'.
    const requestedAmount = Number(amount);
    if (!Number.isFinite(requestedAmount) || requestedAmount < 50) {
      return res.status(400).json({ error: 'Minimum payout request is ₹50.' });
    }
    if (requestedAmount > 100000) {
      return res.status(400).json({ error: 'Maximum payout request is ₹100,000 per request.' });
    }
    if (!method || !['upi', 'bank'].includes(String(method).toLowerCase())) {
      return res.status(400).json({ error: 'Please choose UPI or bank transfer.' });
    }
    if (String(method).toLowerCase() === 'upi' && !upiId) {
      return res.status(400).json({ error: 'Please provide your UPI ID.' });
    }
    if (String(method).toLowerCase() === 'bank' && (!bankAccount || !bankIfsc)) {
      return res.status(400).json({ error: 'Please provide bank account number and IFSC.' });
    }

    const payout = {
      id: uuidv4(),
      sellerEmail: email,
      sellerUserId: req.user.id || req.user.user_id || '',
      amount: Math.round(requestedAmount),
      currency: 'INR',
      method: String(method).toLowerCase() === 'bank' ? 'Bank' : 'UPI',
      upiId: String(upiId || '').slice(0, 120),
      bankAccount: String(bankAccount || '').slice(0, 40),
      bankIfsc: String(bankIfsc || '').slice(0, 20).toUpperCase(),
      beneficiaryName: String(beneficiaryName || req.user.name || '').slice(0, 120),
      status: 'pending',
      sourceType: 'manual',
      sourceCouponId: '',
      requestedAt: nowIso(),
      processedAt: '',
      processedBy: '',
      paymentReference: '',
      rejectionReason: '',
      notes: 'Manual payout request from seller dashboard.',
    };

    await db.appendRow(db.SHEETS.PAYOUTS, payout);
    res.status(201).json({ message: 'Payout request submitted successfully.', payout: sanitize(payout) });
  } catch (err) {
    console.error('Request payout error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
module.exports.PER_COUPON_EARNING = PER_COUPON_EARNING;
module.exports.createAutoPayout = async function createAutoPayout({ coupon, sellerEmail, sellerUserId }) {
  // Called from /api/coupons/buy/:id when a coupon transitions to 'sold'.
  // Creates a ₹10 pending payout to the seller. Idempotent per coupon id
  // so a second buy attempt for the same coupon won't double-pay.
  if (!coupon || !sellerEmail) return null;
  try {
    const all = await getAllPayouts();
    const existing = all.find((p) => String(p.sourceCouponId) === String(coupon.id));
    if (existing) return sanitize(existing);

    const payout = {
      id: uuidv4(),
      sellerEmail: String(sellerEmail).toLowerCase().trim(),
      sellerUserId: String(sellerUserId || ''),
      amount: PER_COUPON_EARNING,
      currency: 'INR',
      method: 'UPI',
      upiId: '',
      bankAccount: '',
      bankIfsc: '',
      beneficiaryName: '',
      status: 'pending',
      sourceType: 'auto',
      sourceCouponId: String(coupon.id || ''),
      requestedAt: nowIso(),
      processedAt: '',
      processedBy: '',
      paymentReference: '',
      rejectionReason: '',
      notes: `Auto-payout for coupon ${coupon.code || coupon.id} (${coupon.brand || ''})`.slice(0, 500),
    };

    await db.appendRow(db.SHEETS.PAYOUTS, payout);
    return sanitize(payout);
  } catch (err) {
    console.warn('Auto-payout notice:', err.message);
    return null;
  }
};
