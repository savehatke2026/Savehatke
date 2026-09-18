// ============================================
// SaveHatke — Express Server Entry Point
// ============================================

const path = require('path');
const fs = require('fs');
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
// Custom UPI checkout — a separate module from the Razorpay routes above, on
// the singular path so neither flow can disturb the other.
const upiPaymentRoutes = require('./routes/payment');
const driveProxyRoutes = require('./routes/driveProxy');
const backupCodeRoutes = require('./routes/backupCode');
const sosRoutes = require('./routes/sos');
const consentRoutes = require('./routes/consent');
const maintenanceGuard = require('./middleware/maintenance');
const { checkPageAccess, resolveCaller, isAdminRole, isWhitelistedEmail } = require('./middleware/maintenance');
const supabase = require('./services/supabase');
const { getPublicSettings, renderLandingStats } = require('./services/publicSettings');

const app = express();

// Behind Vercel's edge proxy — exactly one trusted hop between the client and
// this server. Trusting only that first hop makes req.ip resolve the real
// client IP from X-Forwarded-For while ignoring client-spoofed entries.
// (Boolean `true` would trust every hop, letting anyone forge XFF headers to
// bypass the IP-based rate limiters below.)
app.set('trust proxy', 1);

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

app.use(express.json({
  limit: '10mb',
  // Keep the exact bytes of the payment webhook body: its HMAC is computed
  // over the raw payload, so a re-serialised object would not verify.
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.split('?')[0] === '/api/payment/webhook') {
      req.rawBody = Buffer.from(buf);
    }
  },
}));
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
// reaches the backup-code checks. The message says nothing about which stage or
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
// server, with no chance of flashing the wrong page. Rules:
//
//   /maintenance            → when OFF, redirect to /index.html
//   /<protected user page>  → when ON and caller is not admin, redirect to /maintenance.html
//
// PROTECTED_USER_PAGES covers every authenticated user page named in the
// requirements spec (dashboard, profile, account, marketplace, buy, sell,
// my-coupons, purchased, checkout, payment, orders, settings, …).
// PROTECTED_PUBLIC_PAGES covers the pages the navbar and footer expose
// (home, how-it-works, about) — during maintenance a logged-in user must
// not be able to leave the maintenance page through them, so they share the
// same "ON + non-admin → /maintenance" rule.
//
// Intentionally NOT protected here: login.html (auth must keep working),
// maintenance.html itself, and the admin pages (vault.html, admin-*.html)
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

// Navbar / footer destinations that are public pages. terms.html,
// privacy.html and support.html are deliberately listed: the requirements
// say footer navigation must stay locked during maintenance unless a page
// is explicitly whitelisted — none has been. (support.html's own UI links
// to the public /api/support endpoints; those stay reachable via the API
// guard rules below.)
//
// The maintenance page's own minimal footer links DIRECTLY to /privacy and
// /terms — the requirements call those the genuinely public pages ("Only
// expose genuinely public pages"), so they are intentionally NOT in this
// set and stay reachable even while maintenance is ON.
const PROTECTED_PUBLIC_PAGES = new Set([
  '/', '/index', '/index.html',
  '/how-it-works', '/how-it-works.html',
  '/about', '/about.html',
  '/support', '/support.html',
]);

function isMaintenanceHtmlRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const raw = (req.path || '').toLowerCase();
  return raw === '/maintenance' || raw === '/maintenance.html';
}

function isProtectedUserHtmlRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const raw = (req.path || '').toLowerCase();
  return PROTECTED_USER_PAGES.has(raw);
}

function isProtectedPublicHtmlRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const raw = (req.path || '').toLowerCase();
  return PROTECTED_PUBLIC_PAGES.has(raw);
}

// /maintenance and /maintenance.html: when maintenance is OFF, redirect
// straight to /index.html (true server-side 302 with no body, so the
// Maintenance page can never flash on screen). When maintenance is ON the
// page is served — EXCEPT to admins and whitelisted users, who bypass
// maintenance entirely: admins are sent to the admin panel so they are
// never stranded on the page they are supposed to be able to manage
// around, and whitelisted users are sent to the real site, because
// logging in as a whitelisted user must open the normal pages, never the
// maintenance page.
async function maintenancePageGuard(req, res, next) {
  if (!isMaintenanceHtmlRequest(req)) return next();
  try {
    const status = await supabase.getMaintenanceMode();
    if (!status || !status.enabled) {
      return res.redirect(302, '/index.html');
    }
    const caller = await resolveCaller(req);
    if (isAdminRole(caller)) {
      return res.redirect(302, '/vault');
    }
    if (await isWhitelistedEmail(caller)) {
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

// Navbar / footer public pages (home, about, terms, privacy, support, …):
// while maintenance is ON a signed-in NORMAL user is kept on the maintenance
// page — the navbar and footer must not be an exit. Anonymous visitors get
// the same treatment so the whole site reads as "down for maintenance",
// and admins pass through untouched (they keep the real site so the admin
// panel and its pages stay fully usable while maintenance runs).
async function protectedPublicPageGuard(req, res, next) {
  if (!isProtectedPublicHtmlRequest(req)) return next();
  try {
    const access = await checkPageAccess(req);
    if (!access.allowed) {
      return res.redirect(302, '/maintenance.html');
    }
  } catch (e) {
    console.warn('Public page guard check failed, allowing:', e.message);
  }
  return next();
}

app.use(maintenancePageGuard);
app.use(protectedPageGuard);
app.use(protectedPublicPageGuard);

// ── Landing page — hero counters rendered server-side ─────────────────────
// The homepage's three counters (Active Users / Coupons Traded / Saved by
// Users) used to paint with hardcoded defaults and then wait on a
// /api/settings round-trip to correct themselves — a visible flash on every
// visit, and a frozen default whenever that API was slow or unavailable.
// Rendering them here puts the admin's values AND each counter's on/off
// state into the first byte of the page. The settings read is cached
// (services/publicSettings), so this costs nothing per visit; the client
// fetch in index.html still runs afterwards and converges to the same
// values, keeping the page self-healing.
const LANDING_PAGE_PATH = path.join(__dirname, '..', 'public', 'index.html');
let landingHtmlCache = null;

async function sendLandingPage(req, res) {
  try {
    if (!landingHtmlCache) {
      landingHtmlCache = fs.readFileSync(LANDING_PAGE_PATH, 'utf8');
    }
    let html = landingHtmlCache;
    try {
      html = renderLandingStats(html, await getPublicSettings());
    } catch (e) {
      // Settings read failed — the values already in the file are the
      // install defaults and remain a sane first paint.
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Same no-store policy express.static applies to the HTML files.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(html);
  } catch (err) {
    res.status(500).send('Landing page unavailable.');
  }
}

// Mounted after the page guards so maintenance redirects still win, and
// before express.static so '/', '/index' and '/index.html' never fall
// through to the plain file.
app.get(['/', '/index', '/index.html'], sendLandingPage);

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
// The gateway webhook is mounted BEFORE the guarded mount below, so it stays
// reachable while the site is in maintenance: a confirmation that arrives
// during a maintenance window must still be processed, or a paid order would
// be left unsettled forever. It carries its own HMAC signature and refuses
// every request when PAYMENT_WEBHOOK_SECRET is unset, which is why dropping
// the maintenance guard and the general limiter here is safe.
app.use('/api/payment/webhook', upiPaymentRoutes.webhookHandler);
// Custom UPI checkout: /api/payment/{config,create,status,active,verify,cancel,stream}.
// Singular path on purpose — it must not collide with the Razorpay routes above.
app.use('/api/payment', apiLimiter, maintenanceGuard, upiPaymentRoutes);
app.use('/api/proxy/drive', apiLimiter, maintenanceGuard, driveProxyRoutes); // Auth-protected Google Drive file streaming
// Read-only view of the visitor's cookie consent. Mounted before the generic
// '/api' router below so it is not shadowed by it, and left off the rate limiter
// on purpose: it is a cheap cookie read that any page may call on load, and
// throttling it would make the consent state unreadable exactly when a visitor
// is browsing quickly.
app.use('/api/consent', consentRoutes);

// Public maintenance mode status (no auth required — called by the maintenance
// page and page guards to decide where to send the user). Deliberately
// unauthenticated so it works before login.
//
// Mounted BEFORE the generic '/api' mount below so the maintenance guard
// there cannot shadow it — the status endpoint MUST remain reachable so
// blocked users can poll for the toggle to be flipped off.
//
// When the caller carries a credential (a verified Bearer JWT, or the
// HttpOnly session cookie that page navigations rely on) we ALSO resolve
// whether that user bypasses maintenance: the admin role always, and any
// user whose email is on the maintenance whitelist. The response then
// carries `canAccess` / `isAdmin` / `isWhitelisted` so the frontend doesn't
// have to guess. With no credential at all, all flags default to false —
// an anonymous visitor is always treated as "no bypass". The role and email
// are read from VERIFIED credentials only (never a raw decode of an
// untrusted token), so nobody can forge themselves a bypass answer.
app.get('/api/maintenance/status', async (req, res) => {
  try {
    const supabaseService = require('./services/supabase');
    const status = await supabaseService.getMaintenanceMode();

    let isAdmin = false;
    let isWhitelisted = false;
    if (status.enabled) {
      const caller = await resolveCaller(req);
      isAdmin = isAdminRole(caller);
      if (!isAdmin) {
        isWhitelisted = await isWhitelistedEmail(caller);
      }
    }

    const canAccess = !status.enabled || isAdmin || isWhitelisted;

    res.json({
      enabled: status.enabled,
      message: status.message,
      canAccess,
      isAdmin,
      isWhitelisted,
    });
  } catch (err) {
    // Fail open — if the check fails, report maintenance as off
    res.json({
      enabled: false,
      message: '',
      canAccess: true,
      isAdmin: false,
      isWhitelisted: false,
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
    // Shared cached read (services/publicSettings) — the same one that
    // server-renders the landing-page counters. Sheets + Mongo are no longer
    // hit per request, so this endpoint (and every page that calls it) is
    // fast even under a cold function.
    const settings = await getPublicSettings();
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
app.get('*', async (req, res) => {
  // Only serve HTML for non-API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found.' });
  }
  // Unknown paths normally land on the landing page — during maintenance
  // that would hand a normal user the full site, so they get the maintenance
  // page instead. Admins keep the real fallback (they bypass maintenance).
  try {
    const access = await checkPageAccess(req);
    if (!access.allowed) {
      return res.redirect(302, '/maintenance.html');
    }
  } catch (e) { /* status check failed — fail open like the static guards */ }
  // Same server-rendered counters as the canonical landing page paths.
  return sendLandingPage(req, res);
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
    // is initialised to `{ enabled: false, message: '' }` and
    // `site_settings.maintenance_whitelist` to `{ "emails": [] }` by the
    // migrations. Bypasses are decided server-side only: the admin role from
    // the verified JWT, and user emails from the whitelist row. The same
    // whitelist row also gates who may see the selling form (routes/coupons
    // canSellCoupons), so one list serves both purposes.
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
