// ============================================
// SaveHatke — Maintenance Mode Middleware
// ============================================
// Server-side enforcement of maintenance mode. When maintenance is ON the
// callers that pass are:
//
//   1. admins (role admin / super admin / support) — always, and
//   2. whitelisted users — emails the admin listed under the
//      `maintenance_whitelist` site_settings key. They can log in from the
//      maintenance page and browse the normal site while maintenance runs.
//
// Every other caller gets a 503 MAINTENANCE_MODE response, which the
// frontend api() helper recognises and uses to redirect to
// /maintenance.html.
//
// This guard is mounted before route authentication, so it resolves the caller
// from the sh_session HttpOnly cookie. Page navigations never send an
// Authorization header; the session cookie is the only credential they have.
// The raw token is validated against the server-side session row, and admin
// status is derived from the server-owned two-account allowlist. Without this,
//      an ADMIN opening /dashboard during maintenance would be redirected to
//      /maintenance, whose own guard (correctly) recognises the admin and
//      sends them straight back — an infinite redirect loop.
//
// Resolution is cached per-request (the cookie lookup can hit Supabase),
// and deliberately returns null rather than throwing on any failure — an
// unresolvable caller is treated as a normal user and checked by the real
// auth gate downstream.

const supabase = require('../services/supabase');
const { isAuthorizedAdminEmail } = require('../config/security');
const {
  SESSION_COOKIE_NAME,
  validateSessionToken,
} = require('./auth');

/** Read + decode the session cookie without throwing. */
function parseSessionCookie(req) {
  const cookieHeader = req && req.headers && req.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE_NAME) {
      try { return decodeURIComponent(rest.join('=')); } catch (e) { return null; }
    }
  }
  return null;
}

/** Bearer tokens are retired; authentication is cookie-only. */
async function decodeCaller() { return null; }

/** True when the caller's claimed role grants admin-level maintenance bypass. */
function isAdminRole(caller) {
  return Boolean(caller && isAuthorizedAdminEmail(caller.email));
}

/**
 * True when the caller's email is on the maintenance whitelist. The list is
 * read from the same 10-second cache the maintenance flag uses, so the extra
 * cost on a blocked request is negligible. An unreadable list behaves as
 * empty — whitelist trouble must never lock out admins (checked first).
 */
async function isWhitelistedEmail(caller) {
  if (!caller || !caller.email) return false;
  const whitelist = await supabase.getMaintenanceWhitelist();
  return whitelist.includes(String(caller.email).toLowerCase().trim());
}

// Per-request cache: resolution is keyed by the request object itself (WeakMap so entries
// are garbage-collected with the request).
const resolvedCache = new WeakMap();

/**
 * Resolve the caller for maintenance purposes from the HttpOnly cookie.
 * The cookie is validated against the same session table as protected APIs.
 */
async function resolveCaller(req) {
  if (!req) return null;
  if (resolvedCache.has(req)) return resolvedCache.get(req);

  const promise = (async () => {
    const cookieToken = parseSessionCookie(req);
    if (!cookieToken) return null;

    try {
      // validateSessionToken is the same helper authenticateToken uses —
      // it enforces status Active + expires_at against Supabase on every call.
      const validation = await validateSessionToken(cookieToken);
      if (!validation || !validation.ok || !validation.user) return null;
      return {
        role: validation.user.role || '',
        email: validation.user.email ? String(validation.user.email).toLowerCase().trim() : '',
        id: validation.user.id || '',
      };
    } catch (e) {
      return null;
    }
  })();

  resolvedCache.set(req, promise);
  return promise;
}

/**
 * Express middleware that blocks every non-admin caller when maintenance is
 * ON. Returns 503 with a structured JSON body the frontend api() helper
 * recognises (`code: 'MAINTENANCE_MODE'`).
 *
 * Usage:
 *   app.use('/api/coupons', maintenanceGuard, couponRoutes);
 *
 * Reads the cached maintenance flag (≤10s stale) so the per-request cost
 * is negligible. Fails open on a Supabase outage — better to let users in
 * than to lock them out because of a transient DB error.
 */
async function maintenanceGuard(req, res, next) {
  try {
    const status = await supabase.getMaintenanceMode();
    if (!status || !status.enabled) {
      return next(); // Maintenance OFF — allow everything
    }

    // Maintenance is ON. Admins pass, and so do whitelisted users (they
    // logged in from the maintenance page specifically to keep working).
    const caller = await resolveCaller(req);
    if (isAdminRole(caller) || (await isWhitelistedEmail(caller))) {
      return next();
    }

    // Every other caller (anonymous, logged-in non-whitelisted user) is
    // blocked. The frontend's api() helper turns this 503 into a redirect
    // to /maintenance.html.
    return res.status(503).json({
      error: status.message || 'SaveHatke is temporarily unavailable while we make some improvements. Please check back shortly.',
      code: 'MAINTENANCE_MODE',
      message: status.message || 'SaveHatke is temporarily unavailable while we make some improvements. Please check back shortly.',
    });
  } catch (err) {
    console.warn('Maintenance guard check failed, allowing request:', err.message);
    return next();
  }
}

/**
 * Decide, given a request, whether the caller is allowed to view a protected
 * user-facing HTML page. Returns one of:
 *   { allowed: true }                                       — render the page
 *   { allowed: false, redirect: '/maintenance.html' }       — maintenance is ON
 *
 * Page navigation carries the HttpOnly session cookie. Admin status is
 * derived from the server-owned allowlist, never from a browser role claim.
 * Admins pass because of their role; whitelisted users because of their
 * email, so a whitelisted login from the maintenance page lands straight on
 * the normal site.
 */
async function checkPageAccess(req) {
  const status = await supabase.getMaintenanceMode();
  if (!status || !status.enabled) {
    // Maintenance OFF — no HTML-level gate, the page can render its own
    // auth check as it does today.
    return { allowed: true, status };
  }
  const caller = await resolveCaller(req);
  if (isAdminRole(caller)) {
    return { allowed: true, status };
  }
  if (await isWhitelistedEmail(caller)) {
    return { allowed: true, status };
  }
  return { allowed: false, redirect: '/maintenance.html', status };
}

module.exports = maintenanceGuard;
module.exports.maintenanceGuard = maintenanceGuard;
module.exports.checkPageAccess = checkPageAccess;
module.exports.decodeCaller = decodeCaller;
module.exports.resolveCaller = resolveCaller;
module.exports.isAdminRole = isAdminRole;
module.exports.isWhitelistedEmail = isWhitelistedEmail;
