'use strict';

// Server-owned authorization policy. The administrator roster lives in
// Supabase (table: admin_allowlist) so it can be edited without a redeploy.
//
// On boot the server reads the table once and caches it in this module. The
// cache is refreshed every 60 seconds and on-demand via refreshAdminRoster().
// All consumers (auth, maintenance, monthly reports) read synchronously from
// the cache — that keeps every existing call site unchanged.
//
// Bootstrap fallback: if Supabase is unconfigured or unreachable, the cache
// is seeded from ADMIN_ALLOWLIST_EMAILS (comma-separated) in the environment.
// While the server is in that fallback mode, admin sign-in is BLOCKED so a
// stale env list cannot accidentally grant admin access.

const supabase = require('../services/supabase');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// ── In-process cache ──────────────────────────────────────────────────
// Each entry: { email (lc), name, active, source: 'supabase' | 'env' }.
let ADMIN_CACHE = new Map();
let ADMIN_CACHE_SOURCE = 'env';      // 'supabase' once a successful Supabase read has populated it
let ADMIN_CACHE_HYDRATED = false;    // true after the first refresh attempt has finished
let ADMIN_CACHE_LAST_REFRESH = 0;    // epoch ms
const ADMIN_CACHE_TTL_MS = 60 * 1000;

function envFallbackRoster() {
  const raw = String(process.env.ADMIN_ALLOWLIST_EMAILS || '').trim();
  if (!raw) return [];
  // Optional name mapping via env: "alice@x.com:Alice, bob@x.com:Bob".
  return raw.split(',').map((chunk) => chunk.trim()).filter(Boolean).map((entry) => {
    const [email, name] = entry.split(':').map((s) => String(s || '').trim());
    return { email: normalizeEmail(email), name: name || '', active: true };
  }).filter((row) => row.email);
}

/**
 * Hydrate the cache from Supabase; fall back to the env list when Supabase is
 * unconfigured or the table is unreachable. Never throws.
 */
async function refreshAdminRoster() {
  let rows = [];
  if (supabase.isConfigured()) {
    try { rows = await supabase.getAdminAllowlist(); } catch (e) { rows = []; }
  }
  if (Array.isArray(rows) && rows.length > 0) {
    ADMIN_CACHE = new Map(rows.map((r) => [r.email, { ...r, source: 'supabase' }]));
    ADMIN_CACHE_SOURCE = 'supabase';
  } else if (ADMIN_CACHE.size === 0 || ADMIN_CACHE_SOURCE !== 'supabase') {
    // Either cold-boot with no Supabase OR we lost Supabase and have no cache yet:
    // seed from env so the server still boots cleanly.
    const envRows = envFallbackRoster();
    ADMIN_CACHE = new Map(envRows.map((r) => [r.email, { ...r, source: 'env' }]));
    ADMIN_CACHE_SOURCE = 'env';
  }
  // If we lost Supabase after a good read, keep the last good Supabase cache.
  // When the source is 'env' (bootstrap fallback), block admin sign-in.
  ADMIN_CACHE_HYDRATED = true;
  ADMIN_CACHE_LAST_REFRESH = Date.now();
}

/**
 * Returns the sync shape the rest of the server expects. Hydrate once at boot
 * via await refreshAdminRoster(); the 60s auto-refresh keeps it fresh.
 */
function getAdminAccount(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return ADMIN_CACHE.get(normalized) || null;
}

function isAuthorizedAdminEmail(email) {
  const account = getAdminAccount(email);
  return !!(account && account.active);
}

/**
 * True while the server is running off the env-var fallback (Supabase has not
 * given us a fresh roster). Callers should refuse admin sign-in in this mode
 * so a stale env list cannot grant access the Supabase roster would have denied.
 */
function isAdminRosterStale() {
  return ADMIN_CACHE_SOURCE !== 'supabase';
}

/**
 * Allow ADMIN_ACCOUNTS to keep working for the rest of the codebase without
 * a churn of imports — it's a frozen snapshot of the current cache, regenerated
 * whenever the cache refreshes. Anything that was already iterating the old
 * hardcoded list (e.g. monthlyReports) can keep using this proxy.
 */
let _ADMIN_ROSTER_SNAPSHOT = Object.freeze([]);
function _updateRosterSnapshot() {
  const active = [];
  ADMIN_CACHE.forEach((row) => {
    if (row.active) active.push(Object.freeze({ name: row.name, email: row.email, active: true }));
  });
  _ADMIN_ROSTER_SNAPSHOT = Object.freeze(active);
}
function getActiveAdminEmails() {
  const emails = [];
  ADMIN_CACHE.forEach((row) => { if (row.active) emails.push(row.email); });
  return emails;
}

// ── Background refresh ────────────────────────────────────────────────
let refreshTimer = null;
function startAdminRosterAutoRefresh(intervalMs = ADMIN_CACHE_TTL_MS) {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    refreshAdminRoster()
      .then(_updateRosterSnapshot)
      .catch(() => { /* keep last good cache */ });
  }, intervalMs);
  if (refreshTimer.unref) refreshTimer.unref();
}

function _setRosterCacheForTests(rows) {
  ADMIN_CACHE = new Map((rows || []).map((r) => [normalizeEmail(r.email), { ...r, source: 'test' }]));
  ADMIN_CACHE_SOURCE = 'test';
  ADMIN_CACHE_HYDRATED = true;
  ADMIN_CACHE_LAST_REFRESH = Date.now();
  _updateRosterSnapshot();
}

// ── Public origin (unchanged) ──────────────────────────────────────────
function getPublicOrigin(req) {
  const configured = String(process.env.APP_BASE_URL || process.env.SITE_URL || '').trim();
  if (configured) {
    const base = new URL(configured);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
        (process.env.NODE_ENV === 'production' && base.protocol !== 'https:')) {
      throw new Error('Invalid public application URL configuration.');
    }
    return base.origin;
  }

  const allowed = new Set([
    'https://savehatke.com', 'https://www.savehatke.com', 'https://savehatke.vercel.app',
    ...(process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
  ]);
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || '').split(',')[0].trim().toLowerCase();
  const host = String((req && typeof req.get === 'function' && req.get('host')) || '').trim();
  if (host && ['http', 'https'].includes(forwardedProto)) {
    try {
      const candidate = new URL(`${forwardedProto}://${host}`);
      if (allowed.has(candidate.origin)) return candidate.origin;
      if (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(candidate.hostname)) {
        return candidate.origin;
      }
    } catch (e) { /* use fixed fallback below */ }
  }

  if (process.env.NODE_ENV === 'production') return 'https://savehatke.com';
  return `http://localhost:${String(process.env.PORT || '3000')}`;
}

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '');
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 bytes.');
  }
  return secret;
}

function assertSecurityConfiguration() {
  getJwtSecret();

  // Google OAuth callback sanity check. In production the redirect_uri sent to
  // Google is the *only* thing that decides whether sign-in works or fails with
  // redirect_uri_mismatch — so a missing / http / wrong-path value must abort
  // startup rather than be discovered at the first failed login.
  if (process.env.NODE_ENV === 'production') {
    const raw = String(process.env.GOOGLE_REDIRECT_URI || '').trim();
    if (!raw) {
      throw new Error(
        'GOOGLE_REDIRECT_URI is not set in production. Set it in your hosting ' +
        'environment (Vercel → Settings → Environment Variables → Production) to ' +
        '"https://savehatke.vercel.app/api/auth/google-redirect", then redeploy.'
      );
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:') {
        throw new Error(`GOOGLE_REDIRECT_URI must be https in production (got ${parsed.protocol}).`);
      }
      if (parsed.pathname !== '/api/auth/google-redirect') {
        throw new Error(
          `GOOGLE_REDIRECT_URI must end with /api/auth/google-redirect in production ` +
          `(got ${parsed.pathname}).`
        );
      }
    } catch (e) {
      throw new Error(`GOOGLE_REDIRECT_URI is invalid: ${e.message}`);
    }
  }

  // Always log the resolved redirect_uri on startup so a misconfiguration is
  // visible in deploy logs without exposing secrets. We only print host + path,
  // never the env-var raw value, query, fragment, or credentials.
  try {
    const raw = String(process.env.GOOGLE_REDIRECT_URI || '').trim();
    if (raw) {
      const parsed = new URL(raw);
      console.log(`[security] Google OAuth redirect_uri: ${parsed.protocol}//${parsed.host}${parsed.pathname}`);
    } else if (process.env.NODE_ENV !== 'production') {
      console.log('[security] Google OAuth redirect_uri: derived from APP_BASE_URL/SITE_URL or localhost');
    }
  } catch (e) {
    console.warn('[security] Google OAuth redirect_uri could not be parsed for diagnostics.');
  }
}

module.exports = {
  normalizeEmail,
  getAdminAccount,
  isAuthorizedAdminEmail,
  getActiveAdminEmails,
  refreshAdminRoster,
  startAdminRosterAutoRefresh,
  isAdminRosterStale,
  getPublicOrigin,
  getJwtSecret,
  assertSecurityConfiguration,
  _setRosterCacheForTests,
  _adminCache: () => ({
    source: ADMIN_CACHE_SOURCE, size: ADMIN_CACHE.size,
    lastRefresh: ADMIN_CACHE_LAST_REFRESH, hydrated: ADMIN_CACHE_HYDRATED,
  }),
  // Backwards-compat: a snapshot of the current cache, refreshed whenever the
  // roster refreshes. Anything that was importing the old hardcoded list (e.g.
  // monthlyReports.configuredAdminEmails) keeps working unchanged.
  get ADMIN_ACCOUNTS() { return _ADMIN_ROSTER_SNAPSHOT; },
};