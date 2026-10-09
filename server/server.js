// ============================================
// SaveHatke — Express Server Entry Point
// ============================================

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { assertSecurityConfiguration, refreshAdminRoster, startAdminRosterAutoRefresh, isAdminRosterStale, getAdminAccount } = require('./config/security');
assertSecurityConfiguration();

// Hydrate the admin roster from Supabase (server/config/security.js also seeds
// from ADMIN_ALLOWLIST_EMAILS if Supabase is unconfigured/unreachable). The
// 60s auto-refresh keeps it fresh without changing any caller.
refreshAdminRoster()
  .then(() => {
    const stale = isAdminRosterStale();
    const count = getAdminAccount('any') !== null ? 'n/a' : '0'; // (placeholder — only used for log line)
    console.log(`[security] admin allowlist source=${stale ? 'env-fallback' : 'supabase'}`);
    if (stale) {
      console.warn('[security] admin sign-in is BLOCKED until Supabase admin_allowlist is reachable. ' +
        'Set ADMIN_ALLOWLIST_EMAILS in Vercel env vars to lift the block in an emergency.');
    }
  })
  .catch((e) => console.warn('[security] initial admin roster refresh failed:', (e && e.message) || e));
startAdminRosterAutoRefresh();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { safeRateLimitHandler } = require('./utils/rateLimit');

const db = require('./services/googleSheets');
// MongoDB is being cut over to Supabase / Google Sheets. connectDB() is
// temporarily kept as an import so existing initialiseServer() call sites
// still resolve; the shim is a no-op (see server/config/db.js).

// Import routes
const authRoutes = require('./routes/auth');
const couponRoutes = require('./routes/coupons');
const trackerRoutes = require('./routes/priceTracker');
const adminRoutes = require('./routes/admin');
const couponImageRoutes = require('./routes/couponImages');
const supportRoutes = require('./routes/support');
const chatbotAdminRoutes = require('./routes/chatbot');
const chatRoutes = require('./routes/chat');
const gmailRoutes = require('./routes/gmail');
const paymentMailboxRoutes = require('./routes/paymentMailbox');
const payoutRoutes = require('./routes/payouts');
const refundRoutes = require('./routes/refunds');
// Read-only admin financial API (Phase 1 single source of truth — services/finance.js).
const adminFinanceRoutes = require('./routes/adminFinance');
const adminEmailTestingRoutes = require('./routes/adminEmailTesting');
const reviewRoutes = require('./routes/reviews');
const testimonialRoutes = require('./routes/testimonials');
// Custom UPI checkout — the only payment gateway on the platform. Mounted at
// /api/payment (singular) so it cannot collide with any future payment path.
const upiPaymentRoutes = require('./routes/payment');
// The UPI primitives are imported here as well as inside the route, so the
// receiving VPA can be echoed (and any problem with it reported) at boot.
const upiService = require('./services/upi');
const driveProxyRoutes = require('./routes/driveProxy');
// Brand logos / coupon backgrounds resolved from the "SaveHatke Assets" Drive
// folders (server-side resolution + public image endpoint).
const brandAssetRoutes = require('./routes/brandAssets');
const consentRoutes = require('./routes/consent');
const maintenanceGuard = require('./middleware/maintenance');
const { checkPageAccess, resolveCaller, isAdminRole, isWhitelistedEmail } = require('./middleware/maintenance');
const supabase = require('./services/supabase');
const { getPublicSettings, renderLandingStats } = require('./services/publicSettings');

const app = express();

// gzip/br for HTML, JS, CSS and JSON responses — the biggest transfer win for
// the large hand-written pages and the server-rendered landing page. Paths
// that must NOT be buffered are excluded: /api/payment/stream is Server-Sent
// Events (events would sit in the compression buffer instead of arriving
// live), and /api/proxy/drive pipes already-compressed binaries with an exact
// Content-Length.
app.use(compression({
  filter: (req, res) => {
    const raw = String(req.originalUrl || req.url || '').split('?')[0].toLowerCase();
    if (raw === '/api/payment/stream' || raw.startsWith('/api/proxy/drive')) return false;
    return compression.filter(req, res);
  },
}));

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
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true, preload: false }
    : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // helmet (7.2) sets frameguard by default; stated explicitly so the API
  // responses and the pages this process renders are easy to reason about.
  // vercel.json sets the same header on the static files Vercel serves itself.
  frameguard: { action: 'sameorigin' },
}));

// helmet 7 has no Permissions-Policy middleware (it was removed after v6), so it
// is set here. No SaveHatke page uses the camera, microphone, geolocation,
// payment or motion sensors, and none needs the FLoC opt-out to be implicit, so
// they are denied outright: a future third-party script cannot ask for them on
// a visitor's behalf. vercel.json carries the identical policy for the static
// files that never reach this process — keep the two in step.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), ' +
    'magnetometer=(), accelerometer=(), gyroscope=(), interest-cohort=()');
  next();
});

// ── Content-Security-Policy (REPORT-ONLY) ───────────────────────────────────
// The app is built from large hand-written pages that rely on inline <script>
// blocks, inline event handlers and inline <style>, and it loads Google
// Identity Services, Cloudflare Turnstile and Google Fonts. An enforcing policy
// strict enough to matter would therefore need nonces threaded through every
// page, and shipping one blind would break the login page and the dashboard —
// which the security requirements explicitly forbid.
//
// Report-only is the honest middle step: the browser reports what an enforced
// policy WOULD block, nothing is broken, and the violations collected tell us
// exactly which nonces/hashes are needed before switching to enforcement. Once
// reports are clean, change the header name to Content-Security-Policy.
//
// frame-ancestors is the one directive that is always safe to enforce, and it
// is enforced separately below.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy-Report-Only', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    // Google Identity Services, Cloudflare Turnstile, the QR image data URLs on
    // checkout, the font stylesheet the pages link, and the Tesseract.js CDN
    // (sell page's client-side coupon OCR: script + its wasm/model fetches;
    // its worker already runs from blob:, which worker-src allows).
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://challenges.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://accounts.google.com https://challenges.cloudflare.com https://cdn.jsdelivr.net",
    "frame-src https://accounts.google.com https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
  ].join('; '));
  next();
});

// Clickjacking: belt and braces with X-Frame-Options, and the only CSP
// directive enforced today. 'self' (not 'none') so it agrees with the
// SAMEORIGIN frameguard and with vercel.json instead of silently tightening
// framing past what the app has ever been tested with.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  next();
});

const allowedOrigins = new Set([
  'https://savehatke.vercel.app',
  ...(process.env.APP_BASE_URL ? [new URL(process.env.APP_BASE_URL).origin] : []),
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
]);
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.add('http://localhost:3000');
  allowedOrigins.add('http://127.0.0.1:3000');
}

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    return callback(null, allowedOrigins.has(origin) ? origin : false);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// CORS alone does not stop a cross-site form from reaching a state-changing
// endpoint. Block foreign browser origins, and require an Origin on cookie-
// authenticated mutations. Provider webhooks have no SaveHatke session cookie.
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (origin && !allowedOrigins.has(origin)) {
    return res.status(403).json({ error: 'Request origin is not allowed.' });
  }
  if (!safeMethod && req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'Cross-site request is not allowed.' });
  }
  const hasSessionCookie = String(req.headers.cookie || '').split(';').some((part) => part.trim().startsWith('sh_session='));
  if (!safeMethod && hasSessionCookie && !origin) {
    return res.status(403).json({ error: 'A same-origin request is required.' });
  }
  return next();
});

// Establish a correlation id before body parsers so malformed and oversized
// requests also receive safe, traceable error responses.
app.use((req, res, next) => {
  const crypto = require('crypto');
  req.requestId = crypto.randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
});

// Keep the base JSON limit small. These routes accept bounded base64
// images, so each receives its own parser cap before this general parser.
for (const uploadPath of [
  '/api/support/attachment',
  '/api/coupons/scan',
  '/api/coupons/proof',
  '/api/payouts/details/qr',
  '/api/admin/coupon-images',
]) {
  app.use(uploadPath, express.json({ limit: '4.25mb', strict: true }));
}

app.use(express.json({
  limit: '256kb',
  // Keep the exact bytes of the payment webhook body: its HMAC is computed
  // over the raw payload, so a re-serialised object would not verify.
  //
  // The path is normalised before the comparison. An exact string match missed
  // every equivalent spelling of the same route — a trailing slash
  // ('/api/payment/webhook/') or different casing ('/API/Payment/Webhook'),
  // both of which Express still routes to the handler. On those variants
  // req.rawBody stayed unset and the verifier silently fell back to
  // JSON.stringify(req.body), so the signature covered a re-serialisation
  // instead of the signed bytes: a legitimate gateway signature would be
  // rejected, and the byte-exact binding the HMAC is supposed to give would
  // not hold. Normalising here keeps the invariant for every spelling.
  verify: (req, res, buf) => {
    const path = String(req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
    if (path === '/api/payment/webhook') {
      req.rawBody = Buffer.from(buf);
    }
  },
}));
app.use(express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 100 }));

// Record administrator mutations as structured metadata only. Never include
// bodies, tokens or provider data.
//
// The path MUST be captured here, at middleware entry, and not re-read from
// `req.path` inside the finish handler. Express trims `req.url` when it enters a
// path-mounted layer (`app.use('/api/admin', …)`) and only restores it in the
// router's own next(); a handler that responds never calls next(), so at
// `finish` time `req.path` is the mount-relative path ('/users/status') and the
// /api/admin test below never matched. The effect was that this log recorded
// nothing but unhandled 404s — every real admin mutation (settings, maintenance,
// user suspension, coupon changes, payout approvals, session termination) was
// invisible. `req.originalUrl` is set once and is never rewritten; it is
// captured before the body parsers so the value is stable for the whole request.
app.use((req, res, next) => {
  const method = req.method;
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  res.on('finish', () => {
    if (!/^\/api\/admin(?:\/|$)/i.test(path) || ['GET', 'HEAD', 'OPTIONS'].includes(method)) return;
    console.info(JSON.stringify({
      event: 'admin_mutation', requestId: req.requestId,
      adminEmail: req.user ? req.user.email : null,
      method, path: path.slice(0, 180),
      status: res.statusCode, timestamp: new Date().toISOString(),
    }));
  });
  next();
});

// ── Rate limiting ───────────────────────────────────────────────────────────
//
// TWO LAYERS, deliberately, in this order:
//
//   1. Distributed (Upstash Redis) — services/rateLimitService. One shared
//      counter across every Vercel instance, so the budget cannot be multiplied
//      by the number of warm instances and cannot be reset by a cold start.
//      Mounted below, before the body parsers, so a throttled upload is refused
//      before its bytes are buffered.
//
//   2. Local (express-rate-limit, in-process) — the limiters defined in this
//      block. KEPT as the emergency backstop: when Redis is unreachable these
//      are the only thing still bounding a flood inside one instance. When
//      Redis is healthy they never fire first, because the Redis budget is
//      always the tighter of the two.
//
// Layer order end to end:  Vercel WAF -> distributed Redis -> local backstop
//                          -> authentication -> authorization -> business logic.
//
// Webhooks are excluded from both: see NEVER_LIMIT in the rate-limit service.
// A throttled payment-provider retry is a lost payment confirmation, so those
// routes are protected by their HMAC signature over the exact raw bytes (which
// refuses when unconfigured) and by notification-fingerprint idempotency.
const { distributedLimiter, describe: describeRateLimits } = require('./services/rateLimitService');

app.use('/api', distributedLimiter({ resolveCaller }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  standardHeaders: false,
  legacyHeaders: false,
  handler: safeRateLimitHandler(),
});

// Admin panel makes many legitimate calls per page load
// (users + sessions + coupons + stats + settings + payouts list + payouts stats),
// and the payouts page auto-refreshes every 30s. A 100/15min cap is far too
// tight for an authenticated admin and was causing "Too many requests" errors
// on normal pages. Keep a separate bounded budget for this small admin group.
const adminApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: false,
  legacyHeaders: false,
  handler: safeRateLimitHandler('Too many requests. Please wait before trying again.'),
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: false,
  legacyHeaders: false,
  handler: safeRateLimitHandler('Too many sign-in attempts. Please wait before trying again.'),
});

// Stricter limit for coupon submissions & proof uploads (anti-spam/abuse)
const couponSubmissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 submissions/uploads per hour per IP
  standardHeaders: false,
  legacyHeaders: false,
  handler: safeRateLimitHandler('Too many submissions. Please try again later.'),
});

// Support screenshot uploads: each one is a multi-MB body and a Google Drive
// round-trip, so they are capped well below the general API limit.
const supportUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 12, // enough for a few tickets with retries, not for a flood
  standardHeaders: false,
  legacyHeaders: false,
  handler: safeRateLimitHandler('Too many uploads. Please try again later.'),
});

// AI screenshot scanning calls a paid vision API, so it gets its own cap. It is
// looser than the submission limiter (a seller may legitimately re-scan after a
// blurry photo) but far tighter than the general API limiter.
const couponScanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // 30 screenshot scans per hour per IP
  standardHeaders: false,
  legacyHeaders: false,
  handler: safeRateLimitHandler('Too many screenshot scans. Please try again later.'),
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
  '/onboarding', '/onboarding.html',
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
    } else {
      // Static assets are immutable per deploy and referenced by stable paths,
      // so let browsers skip re-fetching them for a day (the CDN keeps serving
      // stale copies for up to a week while it revalidates in the background).
      // HTML above stays no-cache so a deploy is picked up immediately.
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
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
//
// NOTE: the auth routes are intentionally NOT behind a maintenance guard.
// Login must keep working while maintenance is ON so the user can complete
// authentication and then be sent to the maintenance page client-side (the
// same destination the API guard would have sent them to). This satisfies
// the requirement that "normal users should still be able to authenticate"
// even while maintenance is active.
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/coupons/sell', couponSubmissionLimiter);
app.use('/api/coupons/submit', couponSubmissionLimiter);
app.use('/api/coupons/proof', couponSubmissionLimiter);
app.use('/api/coupons/scan', couponScanLimiter);
app.use('/api/coupons', apiLimiter, maintenanceGuard, couponRoutes);
app.use('/api/tracker', apiLimiter, maintenanceGuard, trackerRoutes);
app.use('/api/admin/gmail', gmailRoutes); // own rate limits; must precede /api/admin to avoid the generic limiter
app.use('/api/admin/payment-mailbox', paymentMailboxRoutes); // own rate limits; must precede /api/admin
// Read-only admin financial API. Mounted BEFORE the generic /api/admin router
// so its /finance/* routes are matched first; it shares the admin limiter and
// the same authenticateToken + requireAdmin gate the other admin routes use.
app.use('/api/admin/finance', adminApiLimiter, adminFinanceRoutes);

// Admin Email Testing tool. Mounted BEFORE the generic /api/admin router so its
// /email-testing/* routes match first; shares the admin limiter and the same
// authenticateToken + requireAdmin gate, plus its own per-admin send rate limit.
app.use('/api/admin/email-testing', adminApiLimiter, adminEmailTestingRoutes);

// Admin API — use a much more generous limiter than the public one. The admin
// panel makes 5+ requests per page-load (users + sessions + coupons + stats
// + settings + payouts) and the payouts page auto-refreshes every 30s, so a
// 100/15min cap was causing "Too many requests" errors on the user / session
// / coupon / payout pages.
app.use('/api/admin/coupon-images', adminApiLimiter, couponImageRoutes); // image uploads; must precede /api/admin (own 4.25mb parser)
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
// The gateway webhook is mounted BEFORE the guarded mount below, so it stays
// reachable while the site is in maintenance: a confirmation that arrives
// during a maintenance window must still be processed, or a paid order would
// be left unsettled forever. It carries its own HMAC signature and refuses
// every request when PAYMENT_WEBHOOK_SECRET is unset, which is why dropping
// the maintenance guard and the general limiter here is safe.
app.use('/api/payment/webhook', upiPaymentRoutes.webhookHandler);
// Custom UPI checkout: /api/payment/{config,create,status,active,verify,cancel,stream}.
app.use('/api/payment', apiLimiter, maintenanceGuard, upiPaymentRoutes);
app.use('/api/proxy/drive', apiLimiter, maintenanceGuard, driveProxyRoutes); // Auth-protected Google Drive file streaming
// Public brand-logo / coupon-background resolver + image streaming from the
// "SaveHatke Assets" Drive folders. Resolution and credentials stay server-side.
app.use('/api/brand-assets', apiLimiter, maintenanceGuard, brandAssetRoutes);
// Read-only view of the visitor's cookie consent. Mounted before the generic
// '/api' router below so it is not shadowed by it, and left off the rate limiter
// on purpose: it is a cheap cookie read that any page may call on load, and
// throttling it would make the consent state unreadable exactly when a visitor
// is browsing quickly.
app.use('/api/consent', apiLimiter, consentRoutes);

// Public maintenance mode status (no auth required — called by the maintenance
// page and page guards to decide where to send the user). Deliberately
// unauthenticated so it works before login.
//
// Mounted BEFORE the generic '/api' mount below so the maintenance guard
// there cannot shadow it — the status endpoint MUST remain reachable so
// blocked users can poll for the toggle to be flipped off.
//
// When the caller carries the HttpOnly session cookie we ALSO resolve
// whether that user bypasses maintenance: a fixed allowlisted admin, or
// a user whose email is on the maintenance whitelist. The response then
// carries `canAccess` / `isAdmin` / `isWhitelisted` so the frontend doesn't
// have to guess. With no credential at all, all flags default to false —
// an anonymous visitor is always treated as "no bypass". The role and email
// are read from VERIFIED credentials only (never a raw decode of an
// untrusted token), so nobody can forge themselves a bypass answer.
app.get('/api/maintenance/status', apiLimiter, async (req, res) => {
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
app.use('/api/refunds', apiLimiter, maintenanceGuard, refundRoutes); // /api/refunds/* (buyer + admin)

// Public Turnstile site key for CAPTCHA widgets (secret stays in .env)
app.get('/api/turnstile-config', apiLimiter, (req, res) => {
  res.json({ siteKey: process.env.TURNSTILE_SITE_KEY || '' });
});

// Public settings route (for index.html hero stats & platform settings)
app.get('/api/settings', apiLimiter, async (req, res) => {
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
app.get('/api/health', apiLimiter, (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    name: 'SaveHatke API',
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
  if (res.headersSent) return next(err);
  const status = err && (err.type === 'entity.too.large' ? 413
    : err instanceof SyntaxError && Object.prototype.hasOwnProperty.call(err, 'body') ? 400
      : Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500);
  console.error(JSON.stringify({
    event: 'request_error', requestId: req.requestId || null,
    status, errorType: String((err && (err.type || err.name)) || 'Error').slice(0, 80),
  }));
  return res.status(status).json({
    error: status === 413 ? 'Request body is too large.'
      : status === 400 ? 'Request body is invalid.'
        : 'Something went wrong. Please try again.',
    requestId: req.requestId || undefined,
  });
});

// ── Initialize DB & Sheets (runs on cold start for both local & Vercel) ─────
let initialized = false;

async function initServices() {
  if (initialized) return;
  initialized = true;

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
    // migrations. Bypasses are decided server-side only: the fixed admin
    // allowlist, and user emails from the whitelist row. The whitelist
    // controls maintenance-mode access only — selling is open to every
    // signed-in user (see routes/coupons canSellCoupons).
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
      // Echo the receiving VPA at boot. A wrong or truncated UPI_ID otherwise
      // stays invisible until a buyer scans the QR and their app refuses it.
      //
      // Guarded on purpose: logPayeeConfig() is a later addition to the UPI
      // service, and this boot path must not depend on it. Calling it unguarded
      // takes the entire app down — locally only, since the block is skipped
      // when process.env.VERCEL is set — over a diagnostic log line.
      if (typeof upiService.logPayeeConfig === 'function') upiService.logPayeeConfig();
      console.log('');
    });
  }).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

// ── Export for Vercel Serverless ─────────────────────────────────────────────
module.exports = app;
