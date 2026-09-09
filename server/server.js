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
const testimonialRoutes = require('./routes/testimonials');
const twoFactorRoutes = require('./routes/twoFactor');
const paymentRoutes = require('./routes/payments');
const driveProxyRoutes = require('./routes/driveProxy');
const backupCodeRoutes = require('./routes/backupCode');
const sosRoutes = require('./routes/sos');
const consentRoutes = require('./routes/consent');
const maintenanceGuard = require('./middleware/maintenance');
const { checkPageAccess } = require('./middleware/maintenance');
const supabase = require('./services/supabase');

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

// Break-glass admin recovery. Tighter than authLimiter and deliberately at the
// edge, in front of the route's own per-IP failure accounting, so a burst never
// reaches the bcrypt comparisons. The message says nothing about which stage or
// credential was involved.
const sosLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // covers a legitimate 3-stage recovery plus a few retries
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

// Stricter limit for coupon submissions & proof uploads (anti-spam/abuse)
const couponSubmissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 submissions/uploads per hour per IP
  message: { error: 'Too many submissions. Please try again in an hour.' },
});

// Support screenshot uploads: each one is a multi-MB body and a Google Drive
// round-trip, so they are capped well below the general API limit.
const supportUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 12, // enough for a few tickets with retries, not for a flood
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many screenshot uploads. Please try again later.' },
});

// AI screenshot scanning calls a paid vision API, so it gets its own cap. It is
// looser than the submission limiter (a seller may legitimately re-scan after a
// blurry photo) but far tighter than the general API limiter.
const couponScanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // 30 screenshot scans per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many screenshot scans. Please try again later, or enter the details manually.' },
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
//
// NOTE: the maintenance HTML guards are mounted BEFORE this static handler
// so /maintenance.html and the protected user pages can issue a true
// server-side redirect with no flash of the wrong page. The static
// handler only sees requests that survived those checks.

// ── HTML Maintenance Guards ─────────────────────────────────────────────
// These run BEFORE the static file handler so the redirect happens at the
// server, with no chance of flashing the wrong page. Each rule:
//
//   /maintenance            → when OFF, redirect to /index.html
//   /<protected user page>  → when ON and caller is not admin, redirect to /maintenance.html
//
// The list of protected user pages mirrors the requirements spec; add to
// it whenever a new authenticated-user HTML page is introduced. Admin
// pages (vault.html, admin-*.html) are intentionally not protected here
// because the admin role bypasses maintenance mode entirely.
const PROTECTED_USER_PAGES = new Set([
  '/dashboard', '/dashboard.html',
  '/profile', '/profile.html',
  '/account', '/account.html',
  '/marketplace', '/marketplace.html',
  '/buy', '/buy.html',
  '/sell', '/sell.html',
  '/my-coupons', '/my-coupons.html',
  '/purchased', '/purchased.html',
  '/checkout', '/checkout.html',
  '/payment', '/payment.html',
  '/orders', '/orders.html',
  '/settings', '/settings.html',
  '/wallet', '/wallet.html',
  '/payouts', '/payouts.html',
  '/notifications', '/notifications.html',
  '/security', '/security.html',
]);

function isMaintenanceHtmlRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // Trim query string and decode the path before comparing.
  const raw = (req.path || '').toLowerCase();
  return raw === '/maintenance' || raw === '/maintenance.html';
}

function isProtectedUserHtmlRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const raw = (req.path || '').toLowerCase();
  return PROTECTED_USER_PAGES.has(raw);
}

// /maintenance and /maintenance.html: when maintenance is OFF, redirect
// straight to /index.html. This is a true server-side 302 with no body,
// so the Maintenance page can never flash on screen.
async function maintenancePageGuard(req, res, next) {
  if (!isMaintenanceHtmlRequest(req)) return next();
  try {
    const status = await supabase.getMaintenanceMode();
    if (!status || !status.enabled) {
      return res.redirect(302, '/index.html');
    }
  } catch (e) {
    // Fail open — if the status check itself errors, allow the page to
    // render rather than risk a redirect loop.
    console.warn('Maintenance page guard status check failed, allowing:', e.message);
  }
  return next();
}

// Protected user pages: when maintenance is ON and the caller is not an
// admin, redirect to /maintenance.html. Same true 302 story — the
// dashboard HTML never reaches the browser.
async function protectedPageGuard(req, res, next) {
  if (!isProtectedUserHtmlRequest(req)) return next();
  try {
    const access = await checkPageAccess(req);
    if (!access.allowed) {
      return res.redirect(302, access.redirect || '/maintenance.html');
    }
  } catch (e) {
    console.warn('Protected page guard check failed, allowing:', e.message);
  }
  return next();
}

app.use(maintenancePageGuard);
app.use(protectedPageGuard);

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
// 2FA is mounted ahead of /api/auth on purpose. It carries its own, tighter
// per-endpoint limiters (10 verification attempts / 15 min), and the generic
// 20-per-15-min authLimiter would otherwise exhaust itself part-way through the
// four-step enrolment flow.
//
// NOTE: the auth routes are intentionally NOT behind a maintenance guard.
// Login must keep working while maintenance is ON so the user can complete
// authentication and then be sent to the maintenance page client-side (the
// same destination the API guard would have sent them to). This satisfies
// the requirement that "normal users should still be able to authenticate"
// even while maintenance is active.
app.use('/api/auth/2fa', twoFactorRoutes);
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/coupons/sell', couponSubmissionLimiter);
app.use('/api/coupons/submit', couponSubmissionLimiter);
app.use('/api/coupons/proof', couponSubmissionLimiter);
app.use('/api/coupons/scan', couponScanLimiter);
app.use('/api/coupons', apiLimiter, maintenanceGuard, couponRoutes);
app.use('/api/tracker', apiLimiter, maintenanceGuard, trackerRoutes);
app.use('/api/admin/gmail', gmailRoutes); // own rate limits; must precede /api/admin to avoid the generic limiter
// SOS backup access. Mounted before /api/admin so it keeps its own tight
// limiter instead of the generous authenticated-admin one.
app.use('/api/admin/sos', sosLimiter, sosRoutes);
app.use('/api/admin/backup-code', sosLimiter, backupCodeRoutes); // code management + retired legacy pair

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

// Screenshot uploads cost a Drive round-trip and a few MB of body each, so they
// get a tighter cap than the rest of the support API. Mounted first so it
// applies before the generic apiLimiter on the line below.
app.use('/api/support/attachment', supportUploadLimiter);
app.use('/api/support', apiLimiter, maintenanceGuard, supportRoutes);
app.use('/api/reviews', apiLimiter, maintenanceGuard, reviewRoutes); // buyer reviews of purchased coupons
app.use('/api/testimonials', apiLimiter, testimonialRoutes); // homepage testimonials — public read, admin CRUD
app.use('/api/chatbot', apiLimiter, chatbotAdminRoutes);
app.use('/api/chat', maintenanceGuard, chatRoutes); // /api/chat applies its own service-level rate limits
app.use('/api/payments', apiLimiter, maintenanceGuard, paymentRoutes); // Razorpay: /api/payments/{config,create-order,verify}
app.use('/api/proxy/drive', apiLimiter, maintenanceGuard, driveProxyRoutes); // Auth-protected Google Drive file streaming
// Read-only view of the visitor's cookie consent. Mounted before the generic
// '/api' router below so it is not shadowed by it, and left off the rate limiter
// on purpose: it is a cheap cookie read that any page may call on load, and
// throttling it would make the consent state unreadable exactly when a visitor
// is browsing quickly.
app.use('/api/consent', consentRoutes);

// Public maintenance mode status (no auth required — called by the maintenance
// page "Try Again" button and the dashboard auth guard to decide where to send
// the user). Deliberately unauthenticated so it works before login.
//
// Mounted BEFORE the generic '/api' mount below so the maintenance guard
// there cannot shadow it — the status endpoint MUST remain reachable so
// blocked users can poll for the toggle to be flipped off.
//
// When the caller supplies an `Authorization: Bearer <jwt>` header we ALSO
// resolve whether that user is an admin (the only role that bypasses
// maintenance). The response then carries `canAccess` / `isAdmin` so the
// frontend doesn't have to guess. If no token is sent, both flags default
// to false — i.e. an anonymous visitor is always treated as "no bypass".
app.get('/api/maintenance/status', async (req, res) => {
  try {
    const supabaseService = require('./services/supabase');
    const status = await supabaseService.getMaintenanceMode();

    let isAdmin = false;
    if (status.enabled) {
      const authHeader = req.headers && req.headers.authorization;
      if (authHeader && /^Bearer\s+/i.test(authHeader)) {
        const token = authHeader.replace(/^Bearer\s+/i, '').trim();
        if (token) {
          try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.decode(token) || null;
            if (decoded) {
              const role = decoded.role ? String(decoded.role).toLowerCase() : '';
              isAdmin = role === 'admin' || role === 'super admin' || role === 'support';
            }
          } catch (e) { /* bad token — treat as anonymous */ }
        }
      }
    }

    const canAccess = !status.enabled || isAdmin;

    res.json({
      enabled: status.enabled,
      message: status.message,
      canAccess,
      isAdmin,
    });
  } catch (err) {
    // Fail open — if the check fails, report maintenance as off
    res.json({
      enabled: false,
      message: '',
      canAccess: true,
      isAdmin: false,
    });
  }
});

app.use('/api', apiLimiter, maintenanceGuard, payoutRoutes); // /api/payouts/* (seller)

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
    await supabase.ensureSiteSettingsTable();

    // Maintenance mode itself has no seed data — `site_settings.maintenance_mode`
    // is initialised to `{ enabled: false, message: '' }` by the migration
    // and there's intentionally no allow-list of "trusted" user emails:
    // admin role is the only bypass, decided server-side from the JWT.
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
