// ============================================
// SaveHatke — Payouts Routes
// ============================================
// Admin pays sellers when their coupons are sold.
// All sellers earn ₹10 per sold coupon. The platform tracks payouts
// in a dedicated Google Sheet tab (Payouts) and exposes admin and
// seller-facing endpoints.
//
// Where the money goes is stored once per seller in the SellerPayoutDetails tab
// and copied onto a Payouts row when a request is made — a coupon row never
// carries payment credentials, and a seller is never asked to re-type an
// account number per request.

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');
const googleDrive = require('../services/googleDrive');
// A payout QR is an image upload, so it goes through the same content sniffing the
// support screenshots use rather than trusting the browser's content type.
const { sniffImage, looksComplete } = require('../utils/imageSniff');

const router = express.Router();

// Per-coupon earning (matches the offer in /api/coupons/sell)
const PER_COUPON_EARNING = 10;

// Length caps for a stored payout destination — identical to the caps the payout
// request used to apply when these were typed in per request, so a row written
// by either generation of the flow reads back in the same shape.
const DETAIL_LIMITS = { upiId: 120, qrFileId: 120, qrFileName: 120, beneficiaryName: 120 };

// Written onto a Payouts row when the coupon it came from is marked invalid.
// It is a fixed prefix because it also marks the money as withheld-by-validation
// rather than merely declined by an admin, which is what the seller-facing
// status ladder reads back when the coupon field did not survive the write.
const WITHHELD_REASON = 'Coupon validation failed — payment withheld.';

// The seller-facing status ladder. It is derived here, once, and returned as a
// single string per coupon: two clients deriving it from raw coupon + payout
// rows would be free to disagree about where the same coupon sits.
const SELLER_STATUS = {
  PENDING_REVIEW: 'Pending Review',
  ACTIVE: 'Active',
  ELIGIBLE: 'Eligible for Payout',
  PROCESSING: 'Payout Processing',
  PAID: 'Paid',
  FAILED: 'Validation Failed',
};
const SELLER_STATUS_LADDER = [
  SELLER_STATUS.PENDING_REVIEW,
  SELLER_STATUS.ACTIVE,
  SELLER_STATUS.ELIGIBLE,
  SELLER_STATUS.PROCESSING,
  SELLER_STATUS.PAID,
];

// Marketplace statuses that mean "not reviewed yet", including the legacy
// spellings the Coupons tab still holds. Invalidation refuses these: rejecting a
// coupon that never passed review belongs to the review screen's own action.
const PRE_REVIEW_COUPON_STATUSES = ['', 'pending', 'review', 'awaiting', 'submitted', 'proof_requested'];

// ─── Helpers ──────────────────────────────────────────────────────
function nowIso() {
  return new Date().toISOString();
}

// Sheet cells are strings, so a stored flag arrives as 'true' rather than true.
function truthy(v) {
  if (typeof v === 'boolean') return v;
  return ['true', '1', 'yes'].includes(String(v == null ? '' : v).trim().toLowerCase());
}

// A destination is echoed back so the seller can confirm the account is still
// the right one — never so a dashboard (or a screenshot of one) carries a usable
// account number. Only the last few characters survive, and the number of dots
// is fixed so the mask does not leak the length either.
function maskTail(value, keep = 4) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  if (clean.length <= keep) return '•'.repeat(clean.length);
  return `••••${clean.slice(-keep)}`;
}

function maskUpi(upiId) {
  const clean = String(upiId || '').trim();
  if (!clean) return '';
  const at = clean.indexOf('@');
  if (at < 1) return maskTail(clean, 2);
  // The handle is the identifying half; the provider suffix is not a secret and
  // is what tells the seller which app the money lands in.
  return `${clean.slice(0, at).slice(0, 2)}••••${clean.slice(at)}`;
}

function normalizeMethod(method) {
  const m = String(method || '').trim().toLowerCase();
  if (m === 'upi') return 'UPI';
  // A payout QR is the other way this platform pays a seller. Bank transfer is
  // deliberately not offered.
  if (m === 'qr' || m === 'qrcode' || m === 'qr_code') return 'QR';
  return '';
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
    // QR payouts carry the Drive reference so an admin can open the image the
    // seller uploaded; bank fields stay for rows written before QR existed.
    qrFileId: payout.qrFileId || '',
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

// Seller-facing view of a payout row: same keys as sanitize() so the dashboard
// renders unchanged, but the destination is masked. The admin payout screens
// need the real account number to pay against; a seller's own history does not.
function sanitizeForSeller(payout) {
  const base = sanitize(payout);
  return { ...base, upiId: maskUpi(base.upiId), bankAccount: maskTail(base.bankAccount) };
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

// ─── Seller payout details (account-level, one row per seller) ─────

/**
 * The seller's stored destination, UNMASKED. Server-side only: it feeds the
 * Payouts row an admin actually pays against. Never hand this to a seller-facing
 * response — use toSellerDetails() there.
 */
async function loadSellerPayoutDetails(sellerEmail) {
  const email = String(sellerEmail || '').toLowerCase().trim();
  if (!email) return null;
  const rows = await db.getRows(db.SHEETS.SELLER_PAYOUT_DETAILS);
  // Matched case-insensitively: the key is written lowercased, but a row typed
  // into the sheet by hand should still resolve to the same seller.
  return rows.find((r) => String(r.sellerEmail || '').toLowerCase().trim() === email) || null;
}

// A destination is only usable when the chosen method carries everything a
// transfer needs — the same rule the payout request form enforced field by field.
function payoutDetailsComplete(row) {
  if (!row) return false;
  const method = normalizeMethod(row.method);
  if (method === 'UPI') return Boolean(String(row.upiId || '').trim());
  // A QR record is only payable once the image itself is in Drive.
  if (method === 'QR') return Boolean(String(row.qrFileId || '').trim());
  return false;
}

// Masked, seller-safe view. IFSC and beneficiary name come back in full on
// purpose: they identify a branch and a person rather than an account, and the
// seller needs them to notice a wrong entry.
function toSellerDetails(row) {
  if (!row) return null;
  return {
    method: normalizeMethod(row.method) || '',
    upiId: maskUpi(row.upiId),
    // The file id is not a credential and the seller needs it to see their own
    // QR through /api/proxy/drive/:fileId, which authorises every view.
    qrFileId: String(row.qrFileId || ''),
    qrFileName: String(row.qrFileName || ''),
    beneficiaryName: String(row.beneficiaryName || ''),
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
  };
}

// ─── Coupon invalidation (admin marks a live coupon invalid) ───────

/**
 * Has this coupon been marked invalid? Three sources are consulted because they
 * do not all survive everywhere: the coupon's own field is the intended home,
 * the CouponAudit row is the record that always persists, and a withheld Payouts
 * row proves it for a coupon that had already reached the payable stage.
 */
function describeCouponInvalidation(coupon, auditRows = [], payoutRows = []) {
  const couponId = String((coupon && coupon.id) || '');
  const flagged = Boolean(coupon
    && (String(coupon.validationStatus || '').toLowerCase() === 'failed' || truthy(coupon.paymentWithheld)));
  const auditRow = auditRows.find((r) => String(r.couponId || '') === couponId
    && String(r.action || '').toLowerCase() === 'invalidate') || null;
  const withheldPayout = payoutRows.find((p) => String(p.sourceCouponId || '') === couponId
    && String(p.rejectionReason || '').startsWith(WITHHELD_REASON)) || null;

  return {
    invalidated: Boolean(flagged || auditRow || withheldPayout),
    at: (coupon && coupon.invalidatedAt) || (auditRow && auditRow.at) || (withheldPayout && withheldPayout.processedAt) || '',
    by: (auditRow && auditRow.adminEmail) || (withheldPayout && withheldPayout.processedBy) || '',
    reason: (coupon && coupon.invalidationReason) || (auditRow && auditRow.notes) || '',
    paymentWithheld: Boolean(withheldPayout || (coupon && truthy(coupon.paymentWithheld))),
  };
}

/** describeCouponInvalidation() against freshly-read audit and payout rows. */
async function describeCouponInvalidationById(couponId, coupon = null) {
  const [auditRows, payoutRows] = await Promise.all([
    db.getRows(db.SHEETS.COUPON_AUDIT).catch(() => []),
    getAllPayouts().catch(() => []),
  ]);
  return describeCouponInvalidation({ ...(coupon || {}), id: couponId }, auditRows, payoutRows);
}

/** Where one coupon sits on the seller ladder, as a single ladder string. */
function deriveSellerStatus(coupon, payout, invalidation) {
  const raw = String((coupon && coupon.status) || '').toLowerCase();
  if ((invalidation && invalidation.invalidated) || raw === 'rejected') return SELLER_STATUS.FAILED;
  if (PRE_REVIEW_COUPON_STATUSES.includes(raw)) return SELLER_STATUS.PENDING_REVIEW;
  if (raw === 'sold') {
    const paidState = String((payout && payout.status) || '').toLowerCase();
    if (paidState === 'paid') return SELLER_STATUS.PAID;
    if (paidState === 'processing') return SELLER_STATUS.PROCESSING;
    // A sold coupon is payable even before its auto-payout row lands: the money
    // is owed either way, only the row is missing.
    return SELLER_STATUS.ELIGIBLE;
  }
  // Reviewed and live, or any later marketplace state that is not a failure.
  return SELLER_STATUS.ACTIVE;
}

/**
 * Move every still-payable payout for one coupon out of the payable state.
 * Only rows that could still be paid are touched, which is what makes a repeat
 * call — or a retry after a partial failure — a no-op instead of a double write.
 * 'rejected' is reused deliberately: every balance query already excludes it, so
 * withholding needs no new status and no new filtering anywhere else.
 */
async function withholdPayoutsForCoupon({ couponId, reason = '', actorEmail = 'admin' }) {
  const id = String(couponId || '');
  if (!id) return { count: 0, amount: 0, ids: [], alreadyPaid: 0 };

  const all = await getAllPayouts();
  const forCoupon = all.filter((p) => String(p.sourceCouponId || '') === id);
  const payable = forCoupon.filter((p) => ['pending', 'processing'].includes(String(p.status || 'pending').toLowerCase()));
  const withheldReason = `${WITHHELD_REASON}${reason ? ` ${reason}` : ''}`.slice(0, 500);

  const withheld = [];
  for (const p of payable) {
    await db.updateRow(db.SHEETS.PAYOUTS, 'id', p.id, {
      status: 'rejected',
      processedAt: nowIso(),
      processedBy: actorEmail,
      rejectionReason: withheldReason,
    });
    withheld.push({ id: p.id, amount: Number(p.amount || 0) });
  }

  return {
    count: withheld.length,
    amount: withheld.reduce((sum, p) => sum + p.amount, 0),
    ids: withheld.map((p) => p.id),
    // Money that already left cannot be withheld — surfaced so the admin screen
    // can say so instead of implying the payment was stopped.
    alreadyPaid: forCoupon.filter((p) => String(p.status || '').toLowerCase() === 'paid').length,
  };
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

// POST /api/payouts/details/qr — upload the seller's payment QR image
//
// The browser sends base64 plus a claimed filename. None of that is trusted: the
// bytes are sniffed for a real PNG / JPEG / WebP signature and checked for a
// complete trailer, the size limit is enforced here rather than in the browser,
// and the Drive filename is generated server-side so a crafted name never reaches
// storage. The image goes to the private "QR Code Images" folder and the response
// carries only a file id — the picture is served back through
// GET /api/proxy/drive/:fileId, which authorises the viewer.
//
// Uploading does not by itself change how the seller is paid: the id returned
// here has to be saved through PUT /payouts/details, which is the one place the
// destination changes.
const QR_MAX_BYTES = 3 * 1024 * 1024;
const QR_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

router.post('/payouts/details/qr', authenticateToken, async (req, res) => {
  try {
    const email = (req.user.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'User email not found.' });

    const { filename, dataBase64 } = req.body || {};
    if (!dataBase64) {
      return res.status(400).json({ error: 'No QR code image was received. Please try again.' });
    }

    let buffer;
    try {
      buffer = Buffer.from(String(dataBase64), 'base64');
    } catch (e) {
      buffer = null;
    }
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: 'That image could not be read. Please try another file.' });
    }
    if (buffer.length > QR_MAX_BYTES) {
      return res.status(413).json({ error: 'That image is too large. The maximum size is 3MB.' });
    }

    // Content decides the type, not the upload's claim about itself.
    const sniffed = sniffImage(buffer);
    if (!sniffed || !QR_ALLOWED_TYPES.includes(sniffed.mime)) {
      return res.status(400).json({ error: 'Please upload a PNG, JPG or WebP image of your QR code.' });
    }
    if (!looksComplete(buffer, sniffed.mime)) {
      return res.status(400).json({ error: 'That image looks incomplete. Please re-save it and try again.' });
    }

    if (!googleDrive.isConfigured()) {
      // Loud on the server, vague to the caller.
      console.error(
        '[payouts/qr] Google Drive is not configured — refusing the upload. '
        + 'Set GOOGLE_DRIVE_FOLDER_ID (and GOOGLE_DRIVE_QR_FOLDER_ID) plus '
        + 'GOOGLE_DRIVE_REFRESH_TOKEN in .env.',
      );
      return res.status(503).json({
        error: 'QR uploads are temporarily unavailable. Please use a UPI ID for now, or try again later.',
      });
    }

    const uploaded = await googleDrive.uploadPayoutQrImage({
      buffer,
      ext: sniffed.ext,
      mimeType: sniffed.mime,
      sellerEmail: email,
    });

    // Enough to confirm a real upload in the log without naming the seller.
    console.log(`[payouts/qr] uploaded ${sniffed.mime} ${buffer.length}B -> ${uploaded.fileId}`);

    // The seller's own filename travels back for display only.
    const displayName = String(filename || 'qr-code')
      .replace(/[\\/]/g, '_')
      .replace(/[^a-zA-Z0-9._ -]/g, '_')
      .slice(0, 120) || 'qr-code';

    res.status(201).json({
      fileId: uploaded.fileId,
      name: displayName,
      mimeType: sniffed.mime,
      size: buffer.length,
      uploadedAt: nowIso(),
    });
  } catch (err) {
    // Google's own error text can name folders and accounts, so it is logged and
    // not returned.
    console.error('Payout QR upload error:', err && err.message);
    res.status(500).json({ error: 'That upload could not be completed. Please try again.' });
  }
});

// GET /api/payouts/details — the signed-in seller's stored payout destination
// The seller is taken from the verified session, never from a query or body
// field, so one seller can never read another's destination by guessing an
// email. Values come back masked: this response only has to prove which account
// is on file, not reproduce it.
router.get('/payouts/details', authenticateToken, async (req, res) => {
  try {
    const email = (req.user.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'User email not found.' });

    const row = await loadSellerPayoutDetails(email);
    res.json({ details: toSellerDetails(row), complete: payoutDetailsComplete(row) });
  } catch (err) {
    console.error('Payout details read error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/payouts/details — create or replace that seller's destination
// One row per seller, keyed by the session's email: payout details belong to the
// account, not to a coupon and not to a single request.
router.put('/payouts/details', authenticateToken, async (req, res) => {
  try {
    const email = (req.user.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'User email not found.' });

    const { method, upiId, qrFileId, qrFileName, beneficiaryName } = req.body || {};
    const cleanMethod = normalizeMethod(method);
    if (!cleanMethod) {
      return res.status(400).json({ error: 'Please choose a UPI ID or a payment QR code.' });
    }

    const cleanUpi = String(upiId || '').trim().slice(0, DETAIL_LIMITS.upiId);
    // The id has to be one this seller just uploaded through /payouts/details/qr;
    // it is stored as an opaque reference and never used to build a path.
    const cleanQrId = String(qrFileId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, DETAIL_LIMITS.qrFileId);
    const cleanQrName = String(qrFileName || '').trim().replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, DETAIL_LIMITS.qrFileName);
    const cleanName = String(beneficiaryName || req.user.name || '').trim().slice(0, DETAIL_LIMITS.beneficiaryName);

    if (cleanMethod === 'UPI' && !cleanUpi) {
      return res.status(400).json({ error: 'Please provide your UPI ID.' });
    }
    if (cleanMethod === 'QR' && !cleanQrId) {
      return res.status(400).json({ error: 'Please upload your payment QR code image.' });
    }

    const existing = await loadSellerPayoutDetails(email);
    const now = nowIso();
    // Only the chosen method's destination is kept: there is no reason to leave
    // the account a seller has just moved away from sitting in the sheet.
    const row = {
      id: (existing && existing.id) || uuidv4(),
      sellerEmail: email,
      sellerUserId: String(req.user.id || req.user.user_id || (existing && existing.sellerUserId) || ''),
      method: cleanMethod,
      upiId: cleanMethod === 'UPI' ? cleanUpi : '',
      qrFileId: cleanMethod === 'QR' ? cleanQrId : '',
      qrFileName: cleanMethod === 'QR' ? cleanQrName : '',
      beneficiaryName: cleanName,
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now,
    };

    if (existing) {
      await db.updateRow(db.SHEETS.SELLER_PAYOUT_DETAILS, 'sellerEmail', existing.sellerEmail || email, row);
    } else {
      await db.appendRow(db.SHEETS.SELLER_PAYOUT_DETAILS, row);
    }

    res.json({
      message: existing ? 'Payout details updated.' : 'Payout details saved.',
      created: !existing,
      details: toSellerDetails(row),
      complete: payoutDetailsComplete(row),
    });
  } catch (err) {
    // The error only — the request body carries a payment destination and must
    // never reach the logs.
    console.error('Payout details save error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

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

    res.json({ payouts: mine.map(sanitizeForSeller), summary });
  } catch (err) {
    console.error('My payouts error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/payouts/coupon-status — where each of this seller's coupons sits on
// the payout ladder, as one server-derived string per coupon (`sellerStatus`).
// The sales list and the payouts view read the same field, so they cannot show
// a coupon at two different stages.
router.get('/payouts/coupon-status', authenticateToken, async (req, res) => {
  try {
    const email = (req.user.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'User email not found.' });

    // Coupons live in two stores. Read them the way /api/coupons/my-sales does so
    // the seller's two views never disagree about which coupons exist.
    let coupons = [];
    if (supabase.isConfigured()) {
      try {
        coupons = await supabase.getCoupons({ sellerEmail: email });
      } catch (e) {}
    }
    if (coupons.length === 0) {
      const rows = await db.getRows(db.SHEETS.COUPONS);
      coupons = rows.filter((c) => String(c.sellerEmail || '').toLowerCase().trim() === email);
    }

    const [payoutRows, auditRows] = await Promise.all([
      getAllPayouts(),
      db.getRows(db.SHEETS.COUPON_AUDIT).catch(() => []),
    ]);

    const items = coupons.map((c) => {
      const payout = payoutRows.find((p) => String(p.sourceCouponId || '') === String(c.id || '')) || null;
      const invalidation = describeCouponInvalidation(c, auditRows, payoutRows);
      const sellerStatus = deriveSellerStatus(c, payout, invalidation);
      return {
        couponId: c.id,
        code: c.code || '',
        brand: c.brand || '',
        title: c.title || '',
        couponStatus: c.status || '',
        sellerStatus,
        // 1-based rung, or 0 for Validation Failed — that state is off the ladder
        // rather than a step along it.
        sellerStatusStep: SELLER_STATUS_LADDER.indexOf(sellerStatus) + 1,
        paymentWithheld: Boolean(invalidation.paymentWithheld),
        invalidatedAt: invalidation.at || '',
        invalidationReason: invalidation.reason || '',
        payout: payout
          ? {
            id: payout.id,
            status: String(payout.status || 'pending').toLowerCase(),
            amount: Number(payout.amount || 0),
            requestedAt: payout.requestedAt || '',
            processedAt: payout.processedAt || '',
            rejectionReason: payout.rejectionReason || '',
          }
          : null,
        addedAt: c.addedAt || '',
        soldAt: c.soldAt || '',
      };
    }).sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));

    res.json({ ladder: SELLER_STATUS_LADDER, failedStatus: SELLER_STATUS.FAILED, coupons: items });
  } catch (err) {
    console.error('Seller coupon status error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/payouts/request — seller requests a payout of their current balance
// Only the amount is read from the body. The destination comes from the seller's
// stored account details, so a client cannot redirect a payout by posting its own
// UPI id or account number — any payment field sent here is ignored on purpose.
router.post('/payouts/request', authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body || {};
    const email = (req.user.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'User email not found.' });

    // Each sold coupon auto-creates a ₹10 payout entry; a manual request is a
    // separate row with sourceType='manual' that the admin settles by amount.
    const requestedAmount = Number(amount);
    if (!Number.isFinite(requestedAmount) || requestedAmount < 50) {
      return res.status(400).json({ error: 'Minimum payout request is ₹50.' });
    }
    if (requestedAmount > 100000) {
      return res.status(400).json({ error: 'Maximum payout request is ₹100,000 per request.' });
    }

    const stored = await loadSellerPayoutDetails(email);
    if (!payoutDetailsComplete(stored)) {
      // Machine-readable so the dashboard can send the seller to their account
      // settings instead of re-opening a per-request form for payment details.
      return res.status(409).json({
        error: 'Add your payout details to your account before requesting a payout.',
        code: 'PAYOUT_DETAILS_MISSING',
      });
    }

    // The stored destination is copied onto the row exactly as before, so the
    // admin payout screens and sanitize() keep reading one place.
    const payout = {
      id: uuidv4(),
      sellerEmail: email,
      sellerUserId: req.user.id || req.user.user_id || stored.sellerUserId || '',
      amount: Math.round(requestedAmount),
      currency: 'INR',
      method: normalizeMethod(stored.method),
      upiId: String(stored.upiId || '').slice(0, DETAIL_LIMITS.upiId),
      qrFileId: String(stored.qrFileId || '').slice(0, DETAIL_LIMITS.qrFileId),
      beneficiaryName: String(stored.beneficiaryName || req.user.name || '').slice(0, DETAIL_LIMITS.beneficiaryName),
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
    res.status(201).json({ message: 'Payout request submitted successfully.', payout: sanitizeForSeller(payout) });
  } catch (err) {
    console.error('Request payout error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
module.exports.PER_COUPON_EARNING = PER_COUPON_EARNING;
// Shared with the admin routes so the post-review "mark invalid" action and the
// seller ladder speak one vocabulary and apply one withholding rule.
module.exports.SELLER_STATUS = SELLER_STATUS;
module.exports.SELLER_STATUS_LADDER = SELLER_STATUS_LADDER;
module.exports.PRE_REVIEW_COUPON_STATUSES = PRE_REVIEW_COUPON_STATUSES;
module.exports.WITHHELD_REASON = WITHHELD_REASON;
module.exports.deriveSellerStatus = deriveSellerStatus;
module.exports.describeCouponInvalidation = describeCouponInvalidation;
module.exports.describeCouponInvalidationById = describeCouponInvalidationById;
module.exports.withholdPayoutsForCoupon = withholdPayoutsForCoupon;
module.exports.payoutDetailsComplete = payoutDetailsComplete;
// Unmasked destination for the payout processing path only. Anything the seller
// can see must go through the masked shape instead.
module.exports.loadSellerPayoutDetails = loadSellerPayoutDetails;
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
      qrFileId: '',
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
