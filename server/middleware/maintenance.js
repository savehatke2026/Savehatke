// ============================================
// SaveHatke — Maintenance Mode Middleware
// ============================================
// Server-side enforcement of maintenance mode. When maintenance is enabled,
// normal users are blocked from accessing protected user APIs with a 503
// response. Admins bypass the check entirely.
//
// This middleware must be applied AFTER authenticateToken (so req.user is
// available) on user-facing API routes. Admin routes (/api/admin/*) should
// NOT use this middleware — they have their own requireAdmin gate.

const supabase = require('../services/supabase');

/**
 * Express middleware that blocks non-admin users when maintenance mode is ON.
 *
 * Usage:
 *   app.use('/api/coupons', maintenanceGuard, couponRoutes);
 *
 * The guard reads the cached maintenance flag (≤10s stale) so the overhead
 * per request is negligible. It returns 503 with a structured JSON body that
 * the frontend API client recognises and reacts to.
 */
async function maintenanceGuard(req, res, next) {
  try {
    const status = await supabase.getMaintenanceMode();

    if (!status || !status.enabled) {
      return next(); // Maintenance OFF — allow everything
    }

    // Maintenance is ON — check if the requester is an admin
    const role = req.user && req.user.role ? String(req.user.role).toLowerCase() : '';
    const isAdmin = role === 'admin' || role === 'super admin' || role === 'support';

    if (isAdmin) {
      return next(); // Admins always pass through
    }

    // Normal user while maintenance is ON → block
    return res.status(503).json({
      error: status.message || 'SaveHatke is temporarily unavailable while we make some improvements. Please check back shortly.',
      code: 'MAINTENANCE_MODE',
      message: status.message || 'SaveHatke is temporarily unavailable while we make some improvements. Please check back shortly.',
    });
  } catch (err) {
    // If the maintenance check itself fails, fail open — don't lock users out
    // because of a transient database error.
    console.warn('Maintenance guard check failed, allowing request:', err.message);
    return next();
  }
}

module.exports = maintenanceGuard;
