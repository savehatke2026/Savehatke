// ============================================
// SaveHatke — Refunds Routes
// ============================================
// The user-facing refund surface. The seller/admin write paths stay where
// they already are (the payment verifier + the admin router); this file
// only exposes the read API and the small per-user actions the buyer needs.
//
// Every endpoint is authenticated and auth-scoped: the route never returns
// another user's refund, and the only field the buyer can mutate is the
// status of an UNDERPAYMENT refund (request / cancel). The verified money
// fields are read-only — every number the user sees was derived on the
// server from the verified payment record, never from the browser.

const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const refundsService = require('../services/refunds');
const supabase = require('../services/supabase');
const db = require('../services/googleSheets');

const router = express.Router();

// Helper: the canonical user identifier the auth middleware put on req.
// Returns either the user id claim or the email as a last-resort match key.
function reqUserId(req) {
  return String((req.user && (req.user.id || req.user.user_id || req.user.userId)) || '').trim();
}

function reqUserEmail(req) {
  return String((req.user && (req.user.email || req.userEmail)) || '').toLowerCase().trim();
}

// ── GET /api/refunds ──────────────────────────────────────────────────────
// Returns the authenticated user's refunds (newest first). Each row carries
// the full payment mismatch record the dashboard needs to render the list
// and the detail modal. The summary is derived from the same list so the
// header cards and the table always agree.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

    const list = await refundsService.getRefundsForUser(userId);
    const summary = refundsService.summarize(list);
    res.json({ refunds: list, summary });
  } catch (err) {
    console.error('List refunds error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── GET /api/refunds/:id ───────────────────────────────────────────────────
// Returns one refund, scoped to the requesting user. A refund that exists
// but belongs to another user looks identical to a missing refund — the
// response is 404 either way, so a caller cannot enumerate refund ids.
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

    const refund = await refundsService.getRefundById(req.params.id);
    if (!refund || refund.userId !== userId) {
      return res.status(404).json({ error: 'Refund not found.' });
    }
    res.json({
      refund,
      timeline: refundsService.statusTimeline(refund),
    });
  } catch (err) {
    console.error('Get refund error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── POST /api/refunds/:id/request ──────────────────────────────────────────
// User-driven action on an UNDERPAYMENT refund: confirms the buyer wants
// their partial payment refunded (instead of paying the remaining amount).
// The refund_amount and mismatch type are server-set; the buyer cannot
// edit them. Status moves pending → processing.
router.post('/:id/request', authenticateToken, async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

    const existing = await refundsService.getRefundById(req.params.id);
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ error: 'Refund not found.' });
    }
    if (existing.mismatchType !== 'underpayment') {
      return res.status(400).json({ error: 'Only underpayment refunds can be requested by the buyer.' });
    }
    if (existing.status === 'refunded' || existing.status === 'rejected') {
      return res.status(409).json({ error: 'Refund has already been settled.' });
    }

    const result = await refundsService.updateRefundStatus(existing.refundId, {
      status: 'processing',
      adminNote: 'Buyer requested refund of the partial payment.',
      processedBy: reqUserEmail(req) || userId,
    });

    if (!result || !result.ok) {
      return res.status(500).json({ error: (result && result.error) || 'Could not update refund.' });
    }
    res.json({ ok: true, refund: result.refund });
  } catch (err) {
    console.error('Request refund error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Admin ──────────────────────────────────────────────────────────────────
// Same status update the buyer can request is exposed to admins with a
// broader surface: they can mark a refund refunded/rejected with a
// reference number and an admin note. These endpoints live here (not in
// /admin) so the refund surface stays in one file.
router.post('/admin/:id/mark-refunded', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { refundReference = '', adminNote = '' } = req.body || {};
    const result = await refundsService.updateRefundStatus(req.params.id, {
      status: 'refunded',
      refundReference,
      adminNote,
      processedBy: reqUserEmail(req) || 'admin',
    });
    if (!result || !result.ok) {
      return res.status(400).json({ error: (result && result.error) || 'Could not update refund.' });
    }
    res.json({ ok: true, refund: result.refund });
  } catch (err) {
    console.error('Mark refunded error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/admin/:id/reject', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { adminNote = '' } = req.body || {};
    const result = await refundsService.updateRefundStatus(req.params.id, {
      status: 'rejected',
      adminNote,
      processedBy: reqUserEmail(req) || 'admin',
    });
    if (!result || !result.ok) {
      return res.status(400).json({ error: (result && result.error) || 'Could not update refund.' });
    }
    res.json({ ok: true, refund: result.refund });
  } catch (err) {
    console.error('Reject refund error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
// Expose the service so internal callers (the payment verifier) can use
// the same createOrUpdateRefund without re-importing the file twice.
module.exports.service = refundsService;
