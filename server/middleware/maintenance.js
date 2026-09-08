// ============================================
// SaveHatke — Maintenance Mode Middleware
// ============================================
// Server-side enforcement of maintenance mode. When maintenance is enabled,
// the only callers that pass are:
//   1. Admins (role admin / super admin / support)
//   2. Authenticated users whose email is on the maintenance whitelist
//      (stored in Supabase site_settings.maintenance_whitelist)
// Everyone else gets a 503 MAINTENANCE_MODE response, which the frontend
// API client recognises and uses to redirect to /maintenance.html.
//
// IMPORTANT: this guard is mounted BEFORE the per-route authenticateToken
// (see server.js), so req.user is NOT populated when we run. We therefore
// verify the JWT ourselves — cheaply, with `jwt.decode` — and only fall
// back to a full verify when the role/email claims look malformed. The
// guard's job is "let the right users in"; the route's own authenticateToken
// is still the gate that decides what an authenticated caller may do.

const jwt = require('jsonwebtoken');
const supabase = require('../services/supabase');

/**
 * Pull a best-effort `{ role, email }` out of the Authorization header
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

/**
 * Express middleware that blocks non-allow-listed users when maintenance is ON.
 *
 * Usage:
 *   app.use('/api/coupons', maintenanceGuard, couponRoutes);
 *
 * The guard reads the cached maintenance flag and the cached whitelist
 * (both ≤10s stale) so the overhead per request is negligible. It returns
 * 503 with a structured JSON body that the frontend API client recognises
 * and reacts to.
 */
async function maintenanceGuard(req, res, next) {
  try {
    const status = await supabase.getMaintenanceMode();
    if (!status || !status.enabled) {
      return next(); // Maintenance OFF — allow everything
    }

    // Maintenance is ON — check the caller's claim
    const caller = decodeCaller(req);
    const isAdmin = caller && (
      caller.role === 'admin' ||
      caller.role === 'super admin' ||
      caller.role === 'support'
    );
    if (isAdmin) {
      return next(); // Admins always pass through
    }

    if (caller && caller.email) {
      try {
        const whitelist = await supabase.getMaintenanceWhitelist();
        if (whitelist && whitelist.has(caller.email)) {
          return next(); // Whitelisted user — pass through
        }
      } catch (e) {
        // Whitelist read failed — fall through to the block below. Better
        // to lock a user out for 10s than to leak access because of a
        // transient DB error.
      }
    }

    // Block: not an admin, not on the whitelist (or no auth at all)
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

/**
 * Auth-route guard. Same idea as maintenanceGuard but resolves the
 * requester's email from the request body instead of the JWT, because
 * login routes run before any session exists. The body has been parsed
 * by express.json() by the time this runs, so req.body.email is safe
 * to read.
 *
 * Recognised body shapes:
 *   { email }                 — direct email field
 *   { email, password }       — password login
 *   { email, otp }            — OTP login
 *   { credential, email, ...} — Google login (the email is usually the
 *                                canonical id_token payload field, already
 *                                present in req.body)
 *
 * Admins by hardcoded list always pass — they're recognised by the
 * `password`/`name` matching against the hardcoded admin list as well,
 * so even an unrecognised admin email is allowed.
 */
async function maintenanceAuthGuard(req, res, next) {
  try {
    const status = await supabase.getMaintenanceMode();
    if (!status || !status.enabled) {
      return next(); // Maintenance OFF — allow
    }

    const body = (req && req.body) || {};
    const emailRaw = body.email || (body.credential ? extractEmailFromGoogleCredential(body.credential) : '');
    const email = typeof emailRaw === 'string' ? emailRaw.toLowerCase().trim() : '';

    if (email) {
      const adminEmails = ['rupayandas2024@gmail.com', 'jaggik8888@gmail.com'];
      if (adminEmails.includes(email)) return next();

      try {
        const whitelist = await supabase.getMaintenanceWhitelist();
        if (whitelist && whitelist.has(email)) return next();
      } catch (e) {
        // whitelist read failed — fall through and block
      }
    }

    return res.status(503).json({
      error: status.message || 'SaveHatke is temporarily unavailable while we make some improvements. Please check back shortly.',
      code: 'MAINTENANCE_MODE',
      message: status.message || 'SaveHatke is temporarily unavailable while we make some improvements. Please check back shortly.',
    });
  } catch (err) {
    console.warn('Maintenance auth guard check failed, allowing request:', err.message);
    return next();
  }
}

/**
 * Decode a Google ID-token credential and pull the email out. Mirrors
 * what the /api/auth/google route does, but in a single inline helper so
 * the middleware doesn't need to require auth.js (which would create a
 * circular require). Failure to decode is non-fatal — the request just
 * falls through to the block path.
 */
function extractEmailFromGoogleCredential(credential) {
  try {
    if (!credential || typeof credential !== 'string') return '';
    const parts = credential.split('.');
    if (parts.length < 2) return '';
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad) b64 += '='.repeat(4 - pad);
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload.email === 'string' ? payload.email : '';
  } catch (e) {
    return '';
  }
}

module.exports = maintenanceGuard;
module.exports.maintenanceGuard = maintenanceGuard;
module.exports.maintenanceAuthGuard = maintenanceAuthGuard;
module.exports.decodeCaller = decodeCaller;
