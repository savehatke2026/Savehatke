// ============================================
// SaveHatke — Sensitive API cache policy
// ============================================
// Forces `Cache-Control: no-store` on every response from routes that carry
// private, financial, identity or admin data, so no browser, proxy or CDN can
// keep a copy and replay it to another user.
//
// This is a header-only policy. It does not change status codes, bodies or
// auth. It runs before the routers and only matches the prefixes below, so the
// public read caches (brands, brand assets, recent-sales, static files) are
// untouched.
//
// Deliberately NOT listed here:
//   /api/coupons (public listing)  — response depends on the maintenance guard,
//                                    so it must not be shared-cached (see
//                                    server.js). It keeps its current behaviour.
//   /api/proxy/drive               — already `private, max-age=300` per image.
//   /api/chat/config, /api/chat/status — public widget config, cacheable.
//   /api/settings                  — shared public settings, cacheable.
//   /api/tracker                   — IS listed (per-user, authenticated).
//   POST /api/chat                 — IS listed (per-conversation state).
// ============================================

const NO_STORE = 'no-store';

const SENSITIVE_PREFIXES = [
  '/api/admin',          // admin panel, finance, revenue, Gmail, credentials
  '/api/payment',        // payment create/verify/status, webhook
  '/api/payouts',        // seller payout details and requests
  '/api/refunds',        // refund requests and ledgers
  '/api/auth',           // login, logout, session, 2FA, OTP
  '/api/support',        // support tickets and attachments
  '/api/reviews',        // buyer review eligibility
  '/api/consent',        // consent records
  '/api/coupons/my-sales',
  '/api/coupons/my-purchases',
  '/api/coupons/sell-eligibility',
  '/api/coupons/proof',  // proof-image uploads
  '/api/coupons/scan',   // paid vision scans, signed-in only
  '/api/tracker',        // per-user price-tracking list (authenticated, user-scoped)
];

// POST /api/chat carries per-user conversation state. Its public read-only
// siblings (/api/chat/config, /api/chat/status) are NOT listed here and keep
// their normal behaviour, so the widget config stays cacheable.
const SENSITIVE_EXACT = [
  { method: 'POST', path: '/api/chat' },
];

function isSensitiveRequest(method, p) {
  const m = String(method || '').toUpperCase();
  const path = String(p || '').toLowerCase();
  if (SENSITIVE_EXACT.some((r) => r.method === m && r.path === path)) return true;
  return isSensitivePath(path);
}

function isSensitivePath(p) {
  const path = String(p || '').toLowerCase();
  return SENSITIVE_PREFIXES.some((prefix) =>
    path === prefix || path.startsWith(prefix + '/')
  );
}

/** Express middleware: mark matching API responses as never storable. */
function noStoreSensitiveApi(req, res, next) {
  if (isSensitiveRequest(req.method, req.path)) {
    res.setHeader('Cache-Control', NO_STORE);
    res.setHeader('Pragma', 'no-cache');
  }
  return next();
}

module.exports = { noStoreSensitiveApi, isSensitivePath, isSensitiveRequest, SENSITIVE_PREFIXES, NO_STORE };
