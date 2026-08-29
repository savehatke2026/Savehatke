// ============================================
// SaveHatke — Express Server Entry Point
// ============================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const mongoose = require('mongoose');
const db = require('./services/googleSheets');
const { connectDB } = require('./config/db');

// Connect to MongoDB
connectDB();

// Import routes
const authRoutes = require('./routes/auth');
const couponRoutes = require('./routes/coupons');
const trackerRoutes = require('./routes/priceTracker');
const adminRoutes = require('./routes/admin');
const supportRoutes = require('./routes/support');
const chatbotAdminRoutes = require('./routes/chatbot');
const chatRoutes = require('./routes/chat');
const gmailRoutes = require('./routes/gmail');
const payoutRoutes = require('./routes/payouts');
const reviewRoutes = require('./routes/reviews');
const paymentRoutes = require('./routes/payments');
const driveProxyRoutes = require('./routes/driveProxy');
const backupCodeRoutes = require('./routes/backupCode');

const app = express();

// Behind Vercel's edge proxy — makes req.ip resolve the real client IP
app.set('trust proxy', true);

// ── Security & Middleware ───────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline styles/scripts for our frontend
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: '*', // In production, restrict to your domain
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: { error: 'Too many requests. Please try again later.' },
});

// Admin panel makes many legitimate calls per page load
// (users + sessions + coupons + stats + settings + payouts list + payouts stats),
// and the payouts page auto-refreshes every 30s. A 100/15min cap is far too
// tight for an authenticated admin and was causing "Too many requests" errors
// on the user / session / coupon / payout pages. Bump it to a generous limit
// scoped just to admin traffic — the public apiLimiter above is unchanged.
const adminApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000, // 2000 admin requests per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests. Please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // Stricter for auth endpoints
  message: { error: 'Too many login attempts. Please try again later.' },
});

// Stricter limit for coupon submissions & proof uploads (anti-spam/abuse)
const couponSubmissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 submissions/uploads per hour per IP
  message: { error: 'Too many submissions. Please try again in an hour.' },
});

// Serverless async initializer middleware for Vercel
app.use(async (req, res, next) => {
  try {
    await initServices();
  } catch (e) {}
  next();
});

// ── Static Files ────────────────────────────────────────────────────────────
// Send "no-cache" for .html so users always see the latest markup after a
// deploy (browsers still get 304s via ETag when the file hasn't changed).
// JS / CSS / images get a short max-age so they stay snappy on repeat loads.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (/\.html?$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// Handle Google OAuth redirect POSTs to static login page
app.post(['/login', '/login.html'], (req, res) => {
  res.redirect(307, '/api/auth/google-redirect');
});

// Admin coupon review page — client-side admin gate, all data via authenticated API
app.get('/admin/coupons/:couponId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin-review.html'));
});

// ── API Routes ──────────────────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/coupons/sell', couponSubmissionLimiter);
app.use('/api/coupons/submit', couponSubmissionLimiter);
app.use('/api/coupons/proof', couponSubmissionLimiter);
app.use('/api/coupons', apiLimiter, couponRoutes);
app.use('/api/tracker', apiLimiter, trackerRoutes);
app.use('/api/admin/gmail', gmailRoutes); // own rate limits; must precede /api/admin to avoid the generic limiter
app.use('/api/admin/backup-code', backupCodeRoutes); // SOS admin access — has its own per-IP rate limit

// Admin API — use a much more generous limiter than the public one. The admin
// panel makes 5+ requests per page-load (users + sessions + coupons + stats
// + settings + payouts) and the payouts page auto-refreshes every 30s, so a
// 100/15min cap was causing "Too many requests" errors on the user / session
// / coupon / payout pages.
app.use('/api/admin', adminApiLimiter, adminRoutes);

// Admin payout routes live in routes/payouts.js (defined with paths like
// /admin/payouts). Mount that router under /api/admin with a tiny path
// rewrite so they share the adminApiLimiter above exactly once, instead of
// falling through to the public apiLimiter at /api.
app.use('/api/admin', (req, res, next) => {
  // req.url is the path relative to this mount point, so for a request to
  // /api/admin/payouts/stats it will be '/payouts/stats'.
  if (req.url === '/payouts' || req.url.startsWith('/payouts/')) {
    req.url = '/admin' + req.url; // re-target so the internal /admin/payouts/* route matches
    return payoutRoutes(req, res, next);
  }
  return next();
});

app.use('/api/support', apiLimiter, supportRoutes);
app.use('/api/reviews', apiLimiter, reviewRoutes); // buyer reviews of purchased coupons
app.use('/api/chatbot', apiLimiter, chatbotAdminRoutes);
app.use('/api/chat', chatRoutes); // /api/chat applies its own service-level rate limits
app.use('/api/payments', apiLimiter, paymentRoutes); // Razorpay: /api/payments/{config,create-order,verify}
app.use('/api/proxy/drive', apiLimiter, driveProxyRoutes); // Auth-protected Google Drive file streaming
app.use('/api', apiLimiter, payoutRoutes); // /api/payouts/* (seller)

// Public Turnstile site key for CAPTCHA widgets (secret stays in .env)
app.get('/api/turnstile-config', (req, res) => {
  res.json({ siteKey: process.env.TURNSTILE_SITE_KEY || '' });
});

// Public settings route (for index.html hero stats & platform settings)
app.get('/api/settings', async (req, res) => {
  try {
    let settings = await db.getSettings();

    if (mongoose.connection.readyState === 1) {
      try {
        const Setting = require('./models/Setting');
        const mongoSetting = await Setting.findOne({ key: 'site_settings' });
        if (mongoSetting) {
          settings = {
            ...settings,
            activeUsers: mongoSetting.activeUsers || settings.activeUsers,
            couponsTraded: mongoSetting.couponsTraded || settings.couponsTraded,
            savedByUsers: mongoSetting.savedByUsers || settings.savedByUsers,
            platformName: mongoSetting.platformName || settings.platformName,
            adminEmail: mongoSetting.adminEmail || settings.adminEmail,
            showActiveUsers: mongoSetting.showActiveUsers !== undefined ? mongoSetting.showActiveUsers : settings.showActiveUsers,
            showCouponsTraded: mongoSetting.showCouponsTraded !== undefined ? mongoSetting.showCouponsTraded : settings.showCouponsTraded,
            showSavedByUsers: mongoSetting.showSavedByUsers !== undefined ? mongoSetting.showSavedByUsers : settings.showSavedByUsers,
            heroBadge: mongoSetting.heroBadge || settings.heroBadge,
            showHeroBadge: mongoSetting.showHeroBadge !== undefined ? mongoSetting.showHeroBadge : settings.showHeroBadge,
          };
        }
      } catch (e) {}
    }
    // Normalize toggle booleans — Google Sheets stores as strings ('true'/'false')
    // which breaks strict comparison on the frontend. Force-cast to real booleans.
    const toBool = (v) => v === true || v === 'true';
    settings.showActiveUsers = toBool(settings.showActiveUsers);
    settings.showCouponsTraded = toBool(settings.showCouponsTraded);
    settings.showSavedByUsers = toBool(settings.showSavedByUsers);
    settings.showHeroBadge = toBool(settings.showHeroBadge);

    res.json({ settings });
  } catch (err) {
    console.error('Get public settings error:', err);
    res.json({
      settings: {
        activeUsers: '10K+',
        couponsTraded: '50K+',
        savedByUsers: '₹2L+',
        platformName: 'SaveHatke',
        adminEmail: 'rupayandas2024@gmail.com',
        showActiveUsers: true,
        showCouponsTraded: true,
        showSavedByUsers: true,
        heroBadge: "🚀 India's #1 Coupon Marketplace — Now Live!",
        showHeroBadge: true,
      },
    });
  }
});

// ── Health Check ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const storageStatus = db.getStorageStatus();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    name: 'SaveHatke API',
    storage: {
      connected: storageStatus.connected,
      mode: storageStatus.mode,
      lastError: storageStatus.lastError,
    },
  });
});

// ── SPA Fallback — serve index.html for unmatched routes ────────────────────
app.get('*', (req, res) => {
  // Only serve HTML for non-API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found.' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Error Handler ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ── Initialize DB & Sheets (runs on cold start for both local & Vercel) ─────
let initialized = false;

async function initServices() {
  if (initialized) return;
  initialized = true;

  // Connect to MongoDB Atlas
  await connectDB();

  // Initialize Google Sheets connection
  const sheetsConnected = await db.initialize();
  if (!sheetsConnected) {
    console.warn('⚠️  Google Sheets unavailable. Operating in memory fallback mode.');
  }

  // Ensure Supabase sessions table exists
  const supabase = require('./services/supabase');
  if (supabase.isConfigured()) {
    await supabase.ensureSessionsTable();
  }

  // 48-hour session expiry sweep — a real interval on a long-running server;
  // skipped on Vercel (serverless), where the lazy per-request sweep and the
  // /api/auth/session-cleanup cron endpoint cover it instead.
  const { startSessionCleanupInterval } = require('./services/sessionCleanup');
  startSessionCleanupInterval();
}

// Run initialization immediately
initServices().catch((err) => {
  console.error('Service initialization warning:', err.message);
});

// ── Start Server (only when running locally, NOT on Vercel) ─────────────────
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;

  initServices().then(() => {
    app.listen(PORT, () => {
      console.log('');
      console.log('  ╔══════════════════════════════════════╗');
      console.log('  ║        SaveHatke Server v1.0         ║');
      console.log('  ╚══════════════════════════════════════╝');
      console.log('');
      console.log(`🚀 Server running at http://localhost:${PORT}`);
      console.log(`📄 Landing page: http://localhost:${PORT}`);
      console.log(`🔧 Admin panel:  http://localhost:${PORT}/vault.html`);
      console.log(`💡 API health:   http://localhost:${PORT}/api/health`);
      console.log('');
    });
  }).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

// ── Export for Vercel Serverless ─────────────────────────────────────────────
module.exports = app;
