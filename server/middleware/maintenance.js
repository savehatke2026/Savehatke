// ============================================
// SaveHatke — Maintenance Mode Middleware
// ============================================
// Server-side enforcement of maintenance mode. When maintenance is ON the
// only callers that pass are admins (role admin / super admin / support).
// Every other authenticated or anonymous caller — including any
// allow-listed test user — gets a 503 MAINTENANCE_MODE response, which the
// frontend api() helper recognises and uses to redirect to /maintenance.html.
//
// There is no email-allow-list any more. The previous implementation had
// one, but the requirements explicitly forbid giving specific user emails
// a maintenance bypass; the only "bypass" is the admin role, decided
// server-side from the JWT.
//
// This guard is mounted BEFORE the per-route authenticateToken (see
// server.js), so req.user is NOT populated when we run. We therefore
// verify the JWT ourselves — cheaply, with `jwt.decode` — to read the
// caller's claimed role. The route's own authenticateToken remains the
// real auth gate for the resource the caller is trying to use.

const jwt = require('jsonwebtoken');
const supabase = require('../services/supabase');

/**
 * Pull a best-effort `{ role, email, id }` out of the Authorization header
 * without throwing. Uses `jwt.decode` (no signature check) because the
 * guard's only job is to read who the caller claims to be; the real auth
 * is enforced by the route's own authenticateToken.
 */
function decodeCaller(req) {
  const authHeader = req && req.headers && req.headers.authorization;
  if (!authHeader || !/^Bearer\s+/i.test(authHeader)) return null;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const decoded = jwt.decode(token) || null;
    if (!decoded) return null;
    return {
      role: decoded.role ? String(decoded.role).toLowerCase() : '',
      email: decoded.email ? String(decoded.email).toLowerCase().trim() : '',
      id: decoded.id || '',
    };
  } catch (e) {
    return null;
  }
}

/** True when the caller's claimed role grants admin-level maintenance bypass. */
function isAdminRole(caller) {
  if (!caller || !caller.role) return false;
  return caller.role === 'admin'
      || caller.role === 'super admin'
      || caller.role === 'support';
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

    // Maintenance is ON. Only admins pass.
    const caller = decodeCaller(req);
    if (isAdminRole(caller)) {
      return next();
    }

    // Every other caller (anonymous, logged-in user, allow-listed email) is
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
 * Decide, given a request and the maintenance status, whether the caller
 * is allowed to view a protected user-facing HTML page. Returns one of:
 *   { allowed: true }                                       — render the page
 *   { allowed: false, redirect: '/maintenance.html' }       — maintenance is ON
 *   { allowed: false, redirect: '/login.html' }             — not authenticated
 *
 * Exported so server.js can apply the same rule to HTML routes without
 * pulling in the full middleware machinery.
 */
async function checkPageAccess(req) {
  const status = await supabase.getMaintenanceMode();
  if (!status || !status.enabled) {
    // Maintenance OFF — no HTML-level gate, the page can render its own
    // auth check as it does today.
    return { allowed: true, status };
  }
  const caller = decodeCaller(req);
  if (isAdminRole(caller)) {
    return { allowed: true, status };
  }
  return { allowed: false, redirect: '/maintenance.html', status };
}

module.exports = maintenanceGuard;
module.exports.maintenanceGuard = maintenanceGuard;
module.exports.checkPageAccess = checkPageAccess;
module.exports.decodeCaller = decodeCaller;
module.exports.isAdminRole = isAdminRole;
