// ============================================
// SaveHatke — Auth Middleware
// ============================================
// Google-verified identities receive server-side sessions stored in Supabase.
// A random 256-bit session identifier is kept only in an HttpOnly cookie and
// every authenticated request validates its row server-side:
// it must exist, be Active, and not have reached expires_at (login + 48h).
// The expiry is always computed from server/database time — the browser
// clock is never trusted.

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const supabaseService = require('../services/supabase');
const sessionCache = require('../services/sessionCache');
const { maybeRunSessionCleanup } = require('../services/sessionCleanup');
const { getJwtSecret, isAuthorizedAdminEmail } = require('../config/security');

// 48 hours — maximum session lifetime, starts at successful login.
const SESSION_TTL_MS = supabaseService.SESSION_TTL_MS;
// Admins are logged out automatically 2 hours after login (hard limit).
const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = 'sh_session';

// Role-appropriate expiry message: users get 2 days, admins 2 hours.
function sessionExpiredMessage(role) {
  if (String(role || '').toLowerCase() === 'admin') {
    return 'Your 2-hour admin session has expired. Please log in again.';
  }
  return 'Your 2-day login session has expired. Please log in again.';
}

// ── Session token helpers ──────────────────────────────────────────────────
// The raw token is 256 bits of crypto randomness. It exists only in the
// HttpOnly cookie; the database stores its SHA-256 hash.

function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

// This cache is used only to throttle last_active writes. It must never be
// used as an authorization cache: every request re-reads the session row so
// logout/revocation takes effect across Vercel instances immediately.
const SESSION_TOUCH_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Validate a raw session token against the database.
 * @returns {Promise<{ok:boolean, user?:{id,email,role}, sessionId?:string, expiresAt?:string, unavailable?:boolean}>}
 */
async function validateSessionToken(rawToken) {
  const tokenHash = hashSessionToken(rawToken);
  const now = Date.now();

  const row = await supabaseService.findSessionByToken(tokenHash);

  // A pre-migration database cannot enforce revocation. Treat it as
  // unavailable and refuse the request; possession of a cookie alone is not a session.
  if (row && row.unavailable) {
    return { ok: false, unavailable: true };
  }

  if (!row) return { ok: false };

  // Invalidate sessions from pre-Google-only login routes. A session is
  // accepted only when its row carries the subject verified at login.
  if (!String(row.google_sub || '').trim()) {
    sessionCache.remove(tokenHash);
    return { ok: false, user: rowUser(row) };
  }

  const expiresMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (row.status !== 'Active' || expiresMs <= now) {
    // Lazily flip expired-but-still-Active rows between scheduled sweeps.
    if (row.status === 'Active') {
      supabaseService.endSessionByToken(tokenHash, 'Expired').catch(() => {});
    }
    sessionCache.remove(tokenHash);
    return { ok: false, user: rowUser(row) };
  }

  sessionCache.set(tokenHash, row);
  return { ok: true, user: rowUser(row), sessionId: row.session_id, expiresAt: row.expires_at };
}

/**
 * Rebuild a minimal request identity from the verified session row.
 */
function rowUser(row) {
  const email = String(row.email || '').trim().toLowerCase();
  const role = isAuthorizedAdminEmail(email) ? 'admin' : 'user';
  return { id: row.user_id, userId: row.user_id, user_id: row.user_id, email, role };
}

/**
 * Update last_active (heartbeat) at most once per interval per session.
 * Fire-and-forget — never blocks or breaks the request.
 */
function touchSessionThrottled(rawToken, sessionId) {
  if (!sessionId) return;
  const tokenHash = hashSessionToken(rawToken);
  const entry = sessionCache.get(tokenHash);
  const now = Date.now();
  if (entry && now - (entry.lastTouchAt || 0) < SESSION_TOUCH_INTERVAL_MS) return;
  if (entry) entry.lastTouchAt = now;
  supabaseService.updateSessionActivity(sessionId).catch(() => {});
}

// ── Session cookie helpers ─────────────────────────────────────────────────

function parseSessionCookie(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE_NAME) {
      try { return decodeURIComponent(rest.join('=')); } catch (e) { return null; }
    }
  }
  return null;
}

/**
 * Set the HttpOnly session cookie. Only the random session identifier is
 * stored in the browser — no secrets, no user data.
 * Secure flag is enabled outside development; SameSite=Lax mitigates CSRF
 * while keeping normal top-level navigation working.
 *
 * res.append, not res.setHeader: setHeader REPLACES the whole Set-Cookie header,
 * so it would silently drop any other cookie set earlier in the same response.
 * Nothing did that when this was written, which is why it went unnoticed —
 * append keeps it correct now that the site also has a consent cookie.
 */
function setSessionCookie(res, rawToken, ttlMs) {
  if (!rawToken) return;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const maxAge = Math.floor((ttlMs || SESSION_TTL_MS) / 1000);
  res.append('Set-Cookie',
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  // Max-Age=0 expires it immediately. The attributes must match the ones used
  // when setting it, or the browser treats it as a different cookie and the old
  // one survives logout.
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

// ── Middleware ─────────────────────────────────────────────────────────────

/**
 * Middleware: validate the HttpOnly SaveHatke cookie against the server-side
 * session table, then attach its row-derived identity to the request.
 */
async function authenticateToken(req, res, next) {
  // Browser authentication is cookie-only. A bearer token can be stolen by
  // page JavaScript/XSS, so Authorization headers are never accepted as a
  // substitute for the HttpOnly session cookie.
  const cookieToken = parseSessionCookie(req);
  if (!cookieToken) return res.status(401).json({ error: 'Your session has expired. Please log in again.', code: 'SESSION_EXPIRED' });
  try {
    const validation = await validateSessionToken(cookieToken);
    if (!validation.ok) {
      if (validation.unavailable) {
        return res.status(503).json({ error: 'Authentication is temporarily unavailable.', code: 'AUTH_UNAVAILABLE' });
      }
      return res.status(401).json({
        error: sessionExpiredMessage(validation.user && validation.user.role),
        code: 'SESSION_EXPIRED',
      });
    }
    if (!validation.user || !validation.sessionId) {
      return res.status(401).json({ error: 'Access denied.', code: 'SESSION_EXPIRED' });
    }
    req.user = validation.user;
    req.sessionId = validation.sessionId;
    req.authSessionToken = cookieToken;
    touchSessionThrottled(cookieToken, req.sessionId);
    maybeRunSessionCleanup();
  } catch (err) {
    console.warn('Session validation unavailable.');
    return res.status(503).json({ error: 'Authentication is temporarily unavailable.', code: 'AUTH_UNAVAILABLE' });
  }

  next();
}

/**
 * Middleware: Verify the user is an admin.
 * Must be used AFTER authenticateToken.
 */
function requireAdmin(req, res, next) {
  if (!req.user || !req.sessionId || !isAuthorizedAdminEmail(req.user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  // Role comes from the server-owned allowlist, never a caller claim.
  req.user.role = 'admin';
  next();
}

/**
 * Optional auth — attaches user if token present, but doesn't block.
 * (Public endpoints only; no server-side session enforcement here.)
 */
async function optionalAuth(req, res, next) {
  const cookieToken = parseSessionCookie(req);
  if (cookieToken) {
    try {
      const validation = await validateSessionToken(cookieToken);
      if (validation.ok && validation.user && validation.sessionId) {
        req.user = validation.user;
        req.sessionId = validation.sessionId;
        req.authSessionToken = cookieToken;
      }
    } catch (e) {
      // Optional identity is omitted when the session store is unavailable.
    }
  }
  next();
}

/**
 * Generate a JWT token for a user.
 */
function generateToken(payload, expiresIn = '48h') {
  return jwt.sign(payload, getJwtSecret(), { expiresIn });
}

/**
 * Decode a token without verifying expiry.
 * Returns the decoded payload or null if the token is malformed.
 */
function decodeTokenIgnoreExpiry(token) {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { ignoreExpiration: true });
    return decoded;
  } catch (e) {
    return null;
  }
}

/**
 * Refresh an expired (or about-to-expire) token WITHOUT ever extending the
 * session past its hard limit: 48 hours from the original login (lgn claim)
 * and the session row's expires_at, whichever comes first. If the session
 * was revoked, logged out, or has expired, refresh is refused and the user
 * must log in again.
 * @returns {Promise<{token:string}|null>}
 */
async function refreshToken(oldToken) {
  const decoded = decodeTokenIgnoreExpiry(oldToken);
  if (!decoded || !decoded.sid || !decoded.id || !decoded.email) return null;

  const validation = await validateSessionToken(decoded.sid);
  if (!validation.ok || !validation.user || !validation.sessionId ||
      String(validation.user.id) !== String(decoded.id) ||
      String(validation.user.email).toLowerCase() !== String(decoded.email).toLowerCase()) return null;
  const sessionUser = validation.user;

  // Hard limit measured from the ORIGINAL login, not from "now" — refreshing
  // can never reset the timer. Users: 48 hours; admins: 2 hours.
  const loginMs = decoded.lgn ? decoded.lgn * 1000 : (decoded.iat ? decoded.iat * 1000 : 0);
  const roleLimitMs = sessionUser.role === 'admin' ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS;
  let hardLimitMs = loginMs ? loginMs + roleLimitMs : null;

  if (validation.expiresAt) {
    const rowExpiryMs = new Date(validation.expiresAt).getTime();
    hardLimitMs = hardLimitMs ? Math.min(hardLimitMs, rowExpiryMs) : rowExpiryMs;
  }

  // Refresh windows: admins 2 hours, users 48 hours — and always clamped
  // to the session's hard limit anyway.
  const windowMs = sessionUser.role === 'admin' ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS;
  let expiresMs = Date.now() + windowMs;
  if (hardLimitMs) expiresMs = Math.min(expiresMs, hardLimitMs);

  const secondsLeft = Math.floor((expiresMs - Date.now()) / 1000);
  if (secondsLeft <= 60) return null; // session effectively over — force re-login

  const newToken = jwt.sign({
    id: sessionUser.id,
    email: sessionUser.email,
    name: decoded.name,
    role: sessionUser.role,
    sid: decoded.sid,
    ...(decoded.lgn ? { lgn: decoded.lgn } : {}),
  }, getJwtSecret(), { expiresIn: secondsLeft });

  return { token: newToken };
}

module.exports = {
  authenticateToken,
  requireAdmin,
  optionalAuth,
  generateToken,
  refreshToken,
  decodeTokenIgnoreExpiry,
  validateSessionToken,
  generateSessionToken,
  hashSessionToken,
  setSessionCookie,
  clearSessionCookie,
  SESSION_TTL_MS,
  ADMIN_SESSION_TTL_MS,
  SESSION_COOKIE_NAME,
};
