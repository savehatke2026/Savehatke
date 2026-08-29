// ============================================
// SaveHatke — Buyer Review Routes
// ============================================
// Buyers review coupons they actually bought. Everything here is scoped to the
// authenticated buyer: there is no seller-side review surface and no public
// listing endpoint.
//
// Eligibility is enforced here rather than trusted from the client. A coupon is
// reviewable only when the requesting user is its recorded buyer, the purchase
// is completed, the coupon is not the user's own listing, and no review exists
// for it yet.

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const db = require('../services/googleSheets');

const router = express.Router();

const MAX_REVIEW_LENGTH = 500;

// Statuses that are not a completed purchase. Anything still in the seller's
// submission pipeline ("pending", "available", …) or explicitly unwound
// ("cancelled", "refunded") can never be reviewed.
const NON_COMPLETED_STATUSES = new Set([
  'pending', 'review', 'awaiting', 'submitted', 'available',
  'rejected', 'cancelled', 'canceled', 'refunded', 'failed', 'expired',
]);

function nowIso() {
  return new Date().toISOString();
}

function normEmail(v) {
  return String(v || '').toLowerCase().trim();
}

function sanitize(row) {
  return {
    id: row.id,
    couponId: row.couponId || '',
    brand: row.brand || '',
    couponTitle: row.couponTitle || '',
    pricePaid: Number(row.pricePaid || 0),
    rating: Number(row.rating || 0),
    reviewText: row.reviewText || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
  };
}

/**
 * A rating is required and must be a whole 1–5. Review text is optional.
 * @returns {{ok:true, rating:number, reviewText:string}|{ok:false, error:string}}
 */
function validateReviewInput(body) {
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: 'Please select a rating between 1 and 5 stars.' };
  }

  const reviewText = String(body.reviewText == null ? '' : body.reviewText).trim();
  if (reviewText.length > MAX_REVIEW_LENGTH) {
    return { ok: false, error: `Your review must be ${MAX_REVIEW_LENGTH} characters or fewer.` };
  }

  return { ok: true, rating, reviewText };
}

/**
 * Resolve the coupon the user is trying to review and confirm they are allowed
 * to review it.
 * @returns {Promise<{ok:true, coupon:object}|{ok:false, status:number, error:string}>}
 */
async function resolveReviewableCoupon(couponId, user) {
  if (!couponId) return { ok: false, status: 400, error: 'A coupon is required.' };

  const coupon = await db.findRow(db.SHEETS.COUPONS, 'id', couponId);
  if (!coupon) return { ok: false, status: 404, error: 'That coupon no longer exists.' };

  const buyer = normEmail(user.email);
  if (!buyer || normEmail(coupon.buyerEmail) !== buyer) {
    // Deliberately the same message as a non-purchase: this must not confirm
    // whether some other user bought a given coupon.
    return { ok: false, status: 403, error: 'You can only review coupons you have purchased.' };
  }

  if (normEmail(coupon.sellerEmail) === buyer) {
    return { ok: false, status: 403, error: 'You cannot review your own coupon.' };
  }

  const status = String(coupon.status || '').toLowerCase();
  if (NON_COMPLETED_STATUSES.has(status)) {
    return { ok: false, status: 409, error: 'This purchase is not completed yet.' };
  }
  if (!coupon.soldAt) {
    return { ok: false, status: 409, error: 'This purchase is not completed yet.' };
  }

  return { ok: true, coupon };
}

async function findOwnReview(reviewId, user) {
  const row = await db.findRow(db.SHEETS.REVIEWS, 'id', reviewId);
  if (!row) return { ok: false, status: 404, error: 'Review not found.' };
  if (normEmail(row.buyerEmail) !== normEmail(user.email)) {
    // Not 403 — a user should not learn that someone else's review has this id.
    return { ok: false, status: 404, error: 'Review not found.' };
  }
  return { ok: true, row };
}

// ─── GET /api/reviews/my — the signed-in buyer's own reviews ──────────────
router.get('/my', authenticateToken, async (req, res) => {
  try {
    const rows = await db.findRows(db.SHEETS.REVIEWS, 'buyerEmail', normEmail(req.user.email));
    const reviews = rows
      .map(sanitize)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    res.json({ reviews });
  } catch (err) {
    console.error('[reviews] list failed:', err.message);
    res.status(500).json({ error: 'Unable to load your reviews.' });
  }
});

// ─── POST /api/reviews — review a completed purchase ─────────────────────
router.post('/', authenticateToken, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const valid = validateReviewInput(body);
    if (!valid.ok) return res.status(400).json({ error: valid.error });

    const couponId = String(body.couponId || '').trim();
    const eligible = await resolveReviewableCoupon(couponId, req.user);
    if (!eligible.ok) return res.status(eligible.status).json({ error: eligible.error });

    // One review per purchase. Editing an existing review goes through PUT.
    const existing = await db.findRows(db.SHEETS.REVIEWS, 'couponId', couponId);
    if (existing.some((r) => normEmail(r.buyerEmail) === normEmail(req.user.email))) {
      return res.status(409).json({ error: 'You have already reviewed this coupon.' });
    }

    const coupon = eligible.coupon;
    const row = {
      id: uuidv4(),
      couponId,
      buyerEmail: normEmail(req.user.email),
      buyerUserId: req.user.id || '',
      brand: coupon.brand || '',
      couponTitle: coupon.title || coupon.description || '',
      pricePaid: Number(coupon.sellingPrice || 0),
      rating: valid.rating,
      reviewText: valid.reviewText,
      createdAt: nowIso(),
      updatedAt: '',
    };

    await db.appendRow(db.SHEETS.REVIEWS, row);
    res.status(201).json({ review: sanitize(row) });
  } catch (err) {
    console.error('[reviews] create failed:', err.message);
    res.status(500).json({ error: 'Unable to submit your review.' });
  }
});

// ─── PUT /api/reviews/:id — edit your own review ─────────────────────────
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const valid = validateReviewInput(body);
    if (!valid.ok) return res.status(400).json({ error: valid.error });

    const own = await findOwnReview(String(req.params.id || '').trim(), req.user);
    if (!own.ok) return res.status(own.status).json({ error: own.error });

    const updates = {
      rating: valid.rating,
      reviewText: valid.reviewText,
      updatedAt: nowIso(),
    };
    await db.updateRow(db.SHEETS.REVIEWS, 'id', own.row.id, updates);

    res.json({ review: sanitize({ ...own.row, ...updates }) });
  } catch (err) {
    console.error('[reviews] update failed:', err.message);
    res.status(500).json({ error: 'Unable to update your review.' });
  }
});

// ─── DELETE /api/reviews/:id — delete your own review ────────────────────
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const own = await findOwnReview(String(req.params.id || '').trim(), req.user);
    if (!own.ok) return res.status(own.status).json({ error: own.error });

    await db.deleteRow(db.SHEETS.REVIEWS, 'id', own.row.id);
    res.json({ deleted: own.row.id });
  } catch (err) {
    console.error('[reviews] delete failed:', err.message);
    res.status(500).json({ error: 'Unable to delete your review.' });
  }
});

module.exports = router;
