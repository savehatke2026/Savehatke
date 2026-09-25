// ============================================
// SaveHatke — Payment Mailbox Admin Routes
// Mounted at /api/admin/payment-mailbox behind JWT admin auth.
// ============================================
// Manages the DEDICATED payment mailbox (rupayandas2025@gmail.com) Gmail OAuth
// connection whose encrypted refresh token lives in Supabase
// (services/paymentMailboxStore.js). This is SEPARATE from the support mailbox
// routes in routes/gmail.js.
//
// SECURITY:
//   * The refresh token is NEVER returned by any endpoint here.
//   * /status returns only safe fields (email, status, timestamps, last_error).
//   * The OAuth consent flow reuses the SAME registered redirect URI as the
//     support mailbox (/api/admin/gmail/callback); it is told apart there by a
//     signed `flow: 'payment'` state claim. No new Google OAuth client and no
//     new redirect URI registration are required.

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const { authenticateToken, requireAdmin } = require('../middleware/auth');
const paymentMailbox = require('../services/paymentMailbox');
const store = require('../services/paymentMailboxStore');

const router = express.Router();

const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment-mailbox requests. Please slow down.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many OAuth attempts. Please try again later.' },
});

router.use(apiLimiter);

function getJwtSecret() {
  return process.env.JWT_SECRET || 'savehatke_dev_secret_key';
}

function requestBase(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.get('host');
  return host ? `${proto}://${host}` : APP_BASE_URL;
}

// ── Connection status ────────────────────────────────────────────────────────
// GET /api/admin/payment-mailbox/status
router.get('/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const configured = paymentMailbox.isOAuthConfigured();
    const supabaseReady = store.isReady();
    const safe = await store.getSafeStatus(paymentMailbox.expectedMailbox() || undefined);

    // Reflect a working-but-not-yet-migrated env fallback so the panel is honest.
    let source = 'supabase';
    if (!safe.exists) {
      const conn = await paymentMailbox.getConnection();
      if (conn && conn.source && conn.source !== 'supabase') source = conn.source;
    }

    res.json({
      configured,
      supabaseReady,
      expectedEmail: paymentMailbox.expectedMailbox() || null,
      redirectUri: paymentMailbox.getRedirectUri(requestBase(req)),
      source,
      ...safe,
    });
  } catch (err) {
    console.error('Payment mailbox status error:', err.message);
    res.status(500).json({ error: 'Failed to load payment mailbox status.' });
  }
});

// ── OAuth flow ───────────────────────────────────────────────────────────────
// POST /api/admin/payment-mailbox/auth/url — returns a short-lived signed start URL.
router.post('/auth/url', authLimiter, authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!paymentMailbox.isOAuthConfigured()) {
      return res.status(503).json({ error: 'Google OAuth is not configured on the server.' });
    }
    const ot = jwt.sign(
      { adminId: req.user.id, email: req.user.email, purpose: 'payment-gmail-oauth-start' },
      getJwtSecret(),
      { expiresIn: '5m' }
    );
    res.json({ url: `/api/admin/payment-mailbox/auth?ot=${encodeURIComponent(ot)}` });
  } catch (err) {
    console.error('Payment mailbox auth url error:', err.message);
    res.status(500).json({ error: 'Failed to prepare the payment mailbox connection.' });
  }
});

// GET /api/admin/payment-mailbox/auth — redirect admin to Google consent screen
router.get('/auth', authLimiter, async (req, res) => {
  try {
    let admin = req.user;
    if (!admin && req.query.ot) {
      try {
        const decoded = jwt.verify(String(req.query.ot), getJwtSecret());
        if (decoded.purpose === 'payment-gmail-oauth-start' && decoded.adminId) {
          admin = { id: decoded.adminId, email: decoded.email };
        }
      } catch (e) { /* invalid/expired start token */ }
    }
    if (!admin) return res.status(401).json({ error: 'Admin authentication required.' });

    if (!paymentMailbox.isOAuthConfigured()) {
      return res.status(503).send('Google OAuth is not configured on the server.');
    }
    // Signed, short-lived state carrying flow:'payment' so the shared
    // /api/admin/gmail/callback routes this back into the payment store.
    const state = jwt.sign(
      { adminId: admin.id, email: admin.email, flow: 'payment', nonce: crypto.randomBytes(8).toString('hex') },
      getJwtSecret(),
      { expiresIn: '10m' }
    );
    const url = paymentMailbox.buildAuthUrl(state, requestBase(req));
    res.redirect(url);
  } catch (err) {
    console.error('Payment mailbox auth redirect error:', err.message);
    res.status(500).json({ error: 'Failed to start the payment mailbox connection.' });
  }
});

// POST /api/admin/payment-mailbox/disconnect — mark the connection disconnected.
router.post('/disconnect', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const email = paymentMailbox.expectedMailbox() || undefined;
    if (store.isReady()) await store.markDisconnected(email);
    res.json({ ok: true, message: 'Payment mailbox marked disconnected. Reconnect to resume Gmail verification.' });
  } catch (err) {
    console.error('Payment mailbox disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect the payment mailbox.' });
  }
});

module.exports = router;
