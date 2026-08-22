// ============================================
// SaveHatke — Auth Middleware
// ============================================
// Stateless JWTs are combined with server-side 48-hour sessions stored in
// Supabase. The JWT carries a random `sid` (session token) claim and an
// `lgn` (login time) claim; the raw token also lives in an HttpOnly cookie.
// Every authenticated request validates the session row server-side:
// it must exist, be Active, and not have reached expires_at (login + 48h).
// The expiry is always computed from server/database time — the browser
// clock is never trusted.

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const supabaseService = require('../services/supabase');
const { maybeRunSessionCleanup } = require('../services/sessionCleanup');

// 48 hours — maximum session lifetime, starts at successful login.
const SESSION_TTL_MS = supabaseService.SESSION_TTL_MS;
const SESSION_COOKIE_NAME = 'sh_session';

function getJwtSecret() {
  return process.env.JWT_SECRET || 'savehatke_dev_secret_key';
}

// ── Session token helpers ──────────────────────────────────────────────────
// The raw token is 256 bits of crypto randomness. It exists only in the
// signed JWT and the HttpOnly cookie; the database stores its SHA-256 hash.

function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

// ── Session validation cache ───────────────────────────────────────────────
// A 60-second in-memory cache (per server instance) so the per-request DB
// check doesn't add a Supabase round-trip to every API call. Expiry itself
// is still enforced exactly: the JWT `exp` equals the session expiry and is
// verified against the server clock on every request. The cache only
// shortens (by ≤60s) how quickly a *revocation* (logout-all-devices) is
// noticed by a server instance that already cached the row.

const SESSION_CACHE_TTL_MS = 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 2 * 60 * 1000;
const sessionCache = new Map(); // tokenHash → { row, cachedAt, lastTouchAt }

function pruneSessionCache() {
  if (sessionCache.size < 5000) return;
  const cutoff = Date.now() - SESSION_CACHE_TTL_MS;
  for (const key of sessionCache.keys()) {
    const entry = sessionCache.get(key);
    if (!entry || entry.cachedAt < cutoff) sessionCache.delete(key);
  }
}

/**
 * Validate a raw session token against the database.
 * @returns {Promise<{ok:boolean, sessionId?:string, expiresAt?:string, degraded?:boolean}>}
 */
async function validateSessionToken(rawToken) {
  const tokenHash = hashSessionToken(rawToken);
  const now = Date.now();

  const cached = sessionCache.get(tokenHash);
  if (cached && now - cached.cachedAt < SESSION_CACHE_TTL_MS) {
    const row = cached.row;
    const expiresMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    if (row.status === 'Active' && expiresMs > now) {
      return { ok: true, sessionId: row.session_id, expiresAt: row.expires_at };
    }
    return { ok: false };
  }

  const row = await supabaseService.findSessionByToken(tokenHash);

  // Pre-migration database (session_token column missing) — fail open so
  // logins aren't locked out, but say so loudly once in a while.
  if (row && row.unavailable) {
    return { ok: true, degraded: true };
  }

  if (!row) return { ok: false };

  const expiresMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (row.status !== 'Active' || expiresMs <= now) {
    // Lazily flip expired-but-still-Active rows between scheduled sweeps.
    if (row.status === 'Active') {
      supabaseService.endSessionByToken(tokenHash, 'Expired').catch(() => {});
    }
    sessionCache.delete(tokenHash);
    return { ok: false };
  }

  sessionCache.set(tokenHash, { row, cachedAt: now, lastTouchAt: 0 });
  pruneSessionCache();
  return { ok: true, sessionId: row.session_id, expiresAt: row.expires_at };
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
    if (name === SESSION_COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * Set the HttpOnly session cookie. Only the random session identifier is
 * stored in the browser — no secrets, no user data.
 * Secure flag is enabled outside development; SameSite=Lax mitigates CSRF
 * while keeping normal top-level navigation working.
 */
function setSessionCookie(res, rawToken) {
  if (!rawToken) return;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ── Middleware ─────────────────────────────────────────────────────────────

/**
 * Middleware: Verify JWT token from Authorization header (or the HttpOnly
 * session cookie) and validate the server-side session when the token
 * carries one. Attaches decoded user to req.user and the session id to
 * req.sessionId.
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Fallback: HttpOnly session cookie (browser navigation without JS headers)
  if (!token) token = parseSessionCookie(req);

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, getJwtSecret());
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') {
      // The 48-hour JWT lifetime equals the session lifetime — an expired
      // token means the session is over.
      return res.status(401).json({
        error: 'Your 2-day login session has expired. Please log in again.',
        code: 'SESSION_EXPIRED',
      });
    }
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }

  req.user = decoded;

  // Tokens issued before the 48-hour session upgrade have no `sid`; they
  // keep working until their own JWT expiry and cannot be refreshed.
  if (decoded.sid) {
    try {
      const validation = await validateSessionToken(decoded.sid);
      if (!validation.ok) {
        return res.status(401).json({
          error: 'Your 2-day login session has expired. Please log in again.',
          code: 'SESSION_EXPIRED',
        });
      }
      req.sessionId = validation.sessionId || null;
      touchSessionThrottled(decoded.sid, req.sessionId);
      // Lazy expiry sweep for serverless deployments where no interval
      // timer exists — gated to run at most once every 10 minutes.
      maybeRunSessionCleanup();
    } catch (err) {
      // Database unreachable — fail open rather than lock everyone out.
      console.warn('Session validation skipped (database unreachable):', err.message);
    }
  }

  next();
}

/**
 * Middleware: Verify the user is an admin.
 * Must be used AFTER authenticateToken.
 */
function requireAdmin(req, res, next) {
  const role = req.user?.role ? String(req.user.role).toLowerCase() : '';
  const isAdminRole = role === 'admin' || role === 'super admin' || role === 'support';
  if (!req.user || !isAdminRole) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

/**
 * Optional auth — attaches user if token present, but doesn't block.
 * (Public endpoints only; no server-side session enforcement here.)
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    try {
      req.user = jwt.verify(token, getJwtSecret());
    } catch (err) {
      // Token invalid, continue without user
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
  if (!decoded || !decoded.id || !decoded.email) return null;

  // Hard 48h window measured from the ORIGINAL login, not from "now" —
  // refreshing can never reset the timer.
  const loginMs = decoded.lgn ? decoded.lgn * 1000 : (decoded.iat ? decoded.iat * 1000 : 0);
  let hardLimitMs = loginMs ? loginMs + SESSION_TTL_MS : null;

  if (decoded.sid) {
    const validation = await validateSessionToken(decoded.sid);
    if (!validation.ok) return null; // session revoked / expired / missing
    if (validation.expiresAt) {
      const rowExpiryMs = new Date(validation.expiresAt).getTime();
      hardLimitMs = hardLimitMs ? Math.min(hardLimitMs, rowExpiryMs) : rowExpiryMs;
    }
  }

  const windowMs = decoded.role === 'admin' ? 12 * 60 * 60 * 1000 : SESSION_TTL_MS;
  let expiresMs = Date.now() + windowMs;
  if (hardLimitMs) expiresMs = Math.min(expiresMs, hardLimitMs);

  const secondsLeft = Math.floor((expiresMs - Date.now()) / 1000);
  if (secondsLeft <= 60) return null; // session effectively over — force re-login

  const newToken = jwt.sign({
    id: decoded.id,
    email: decoded.email,
    name: decoded.name,
    role: decoded.role,
    ...(decoded.sid ? { sid: decoded.sid } : {}),
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
  generateSessionToken,
  hashSessionToken,
  setSessionCookie,
  clearSessionCookie,
  SESSION_TTL_MS,
  SESSION_COOKIE_NAME,
};
