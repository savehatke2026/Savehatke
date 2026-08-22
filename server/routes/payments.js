// ============================================
// SaveHatke — Payments Routes (Razorpay)
// ============================================
// Endpoints:
//   GET  /api/payments/config        — public key + isConfigured flag
//   POST /api/payments/create-order  — create a Razorpay order (auth required)
//   POST /api/payments/verify        — verify HMAC signature & fulfill (auth required)
//
// Env variables (server/.env):
//   RAZORPAY_KEY_ID      = rzp_test_xxxx  | rzp_live_xxxx
//   RAZORPAY_KEY_SECRET  = <from Razorpay dashboard>
//
// Get keys from: https://dashboard.razorpay.com/app/keys
// ============================================

const express = require('express');
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/auth');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');

const router = express.Router();

// ── Helpers ─────────────────────────────────────────────────────────────────
function getRazorpayCreds() {
  const keyId = process.env.RAZORPAY_KEY_ID || '';
  const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
  const configured =
    !!keyId &&
    !!keySecret &&
    !keyId.includes('YOUR_KEY_HERE') &&
    !keySecret.includes('YOUR_KEY_HERE');
  return { keyId, keySecret, configured };
}

// Lazily require the official SDK so the server can boot even if the package
// is missing in a stray environment.
let _razorpay = null;
function getRazorpay() {
  if (_razorpay !== null) return _razorpay;
  const { keyId, keySecret, configured } = getRazorpayCreds();
  if (!configured) {
    _razorpay = false; // sentinel: "not configured"
    return _razorpay;
  }
  try {
    const Razorpay = require('razorpay');
    _razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  } catch (e) {
    console.error('[payments] Failed to load razorpay SDK:', e.message);
    _razorpay = false;
  }
  return _razorpay;
}

// Coupon pricing — total is the coupon's selling price as listed, no
// platform fee added on top. Keep in sync with public/checkout.html.
const PLATFORM_FEE = 0;

function buildAmount(couponPrice) {
  const price = Number(couponPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  // Razorpay expects the amount in the smallest currency unit (paise for INR)
  return Math.round((price + PLATFORM_FEE) * 100);
}

// ── Public config (no auth — used by checkout page to load the SDK key) ─────
router.get('/config', (req, res) => {
  const { keyId, configured } = getRazorpayCreds();
  // Never expose the secret. Just tell the client whether payments are live.
  res.json({
    configured,
    keyId: configured ? keyId : '',
    platform: 'razorpay',
    currency: 'INR',
    platformFee: PLATFORM_FEE,
  });
});

// ── Create a Razorpay order (auth required) ─────────────────────────────────
// The server is the source of truth for the amount — the client cannot
// tamper with the price once an order_id is issued.
router.post('/create-order', authenticateToken, async (req, res) => {
  try {
    const rzp = getRazorpay();
    const { configured } = getRazorpayCreds();
    if (!configured || !rzp) {
      return res.status(503).json({
        error:
          'Razorpay is not configured on the server. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your environment, then restart.',
      });
    }

    const { couponId } = req.body || {};
    if (!couponId) {
      return res.status(400).json({ error: 'couponId is required.' });
    }

    // Look up the coupon to derive a server-authoritative price
    let coupon = null;
    if (supabase.isConfigured()) {
      try {
        coupon = await supabase.findCouponById(couponId);
      } catch (e) {}
    }
    if (!coupon) {
      try {
        coupon = await db.findRow(db.SHEETS.COUPONS, 'id', couponId);
      } catch (e) {}
    }

    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }
    if (coupon.status && coupon.status !== 'available') {
      return res.status(400).json({ error: 'This coupon is no longer available.' });
    }
    if (coupon.sellerEmail && coupon.sellerEmail === req.user.email) {
      return res.status(400).json({ error: 'You cannot buy your own coupon.' });
    }

    const amount = buildAmount(coupon.sellingPrice);
    if (!amount) {
      return res.status(400).json({ error: 'Invalid coupon price.' });
    }

    // Receipt id must be <= 40 chars and unique per attempt
    const receipt = 'rcpt_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

    const order = await rzp.orders.create({
      amount,
      currency: 'INR',
      receipt,
      notes: {
        couponId: String(coupon.id),
        couponCode: String(coupon.code || ''),
        brand: String(coupon.brand || ''),
        buyerEmail: req.user.email,
        buyerUserId: String(req.user.userId || ''),
      },
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      coupon: {
        id: coupon.id,
        code: coupon.code,
        brand: coupon.brand,
        title: coupon.title,
        category: coupon.category,
        sellingPrice: Number(coupon.sellingPrice),
        originalValue: coupon.originalValue,
        minOrderValue: coupon.minOrderValue,
        expiryDate: coupon.expiryDate,
      },
      platformFee: PLATFORM_FEE,
    });
  } catch (err) {
    console.error('[payments] create-order error:', err);
    res.status(500).json({
      error: 'Could not create payment order. Please try again.',
      detail: err?.message || String(err),
    });
  }
});

// ── Verify payment signature & fulfill (auth required) ──────────────────────
// Called by the client after Razorpay's on-success handler fires. We
// re-check the HMAC SHA256 of (order_id|payment_id) against the Razorpay
// secret here, so the client can't forge a "paid" response.
router.post('/verify', authenticateToken, async (req, res) => {
  try {
    const { keySecret, configured } = getRazorpayCreds();
    if (!configured || !keySecret) {
      return res.status(503).json({ error: 'Razorpay is not configured on the server.' });
    }

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      couponId,
    } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing Razorpay payment details.' });
    }
    if (!couponId) {
      return res.status(400).json({ error: 'couponId is required.' });
    }

    // Recompute signature using the server-side secret
    const expected = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const sigBuf = Buffer.from(String(razorpay_signature), 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (
      sigBuf.length !== expBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expBuf)
    ) {
      return res.status(400).json({ error: 'Invalid payment signature.' });
    }

    // Signature is valid. Now look up the coupon and mark it sold.
    let coupon = null;
    if (supabase.isConfigured()) {
      try {
        coupon = await supabase.findCouponById(couponId);
      } catch (e) {}
    }
    if (!coupon) {
      try {
        coupon = await db.findRow(db.SHEETS.COUPONS, 'id', couponId);
      } catch (e) {}
    }
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }
    if (coupon.status && coupon.status !== 'available') {
      // Payment succeeded but the coupon is already taken. This is rare (TOCTOU);
      // surface a clear error so the client can trigger a manual refund path.
      return res.status(409).json({
        error: 'Payment received but coupon is no longer available. Please contact support for a refund.',
        paymentId: razorpay_payment_id,
      });
    }

    const updates = {
      status: 'sold',
      soldAt: new Date().toISOString(),
      buyerEmail: req.user.email,
    };

    if (supabase.isConfigured()) {
      try {
        await supabase.updateCoupon(couponId, updates);
      } catch (e) {}
    }
    try {
      await db.updateRow(db.SHEETS.COUPONS, 'id', couponId, updates);
    } catch (e) {}

    // Best-effort auto-payout for the seller
    try {
      const { createAutoPayout } = require('./payouts');
      await createAutoPayout({
        coupon: { id: coupon.id, code: coupon.code, brand: coupon.brand },
        sellerEmail: coupon.sellerEmail,
        sellerUserId: coupon.sellerUserId,
      });
    } catch (e) {
      console.warn('[payments] auto-payout notice:', e.message);
    }

    res.json({
      success: true,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      coupon: {
        id: coupon.id,
        code: coupon.code,
        category: coupon.category,
        brand: coupon.brand,
        description: coupon.description,
        originalValue: coupon.originalValue,
        pricePaid: coupon.sellingPrice,
        expiryDate: coupon.expiryDate,
      },
    });
  } catch (err) {
    console.error('[payments] verify error:', err);
    res.status(500).json({ error: 'Could not verify payment. Please contact support.' });
  }
});

module.exports = router;
