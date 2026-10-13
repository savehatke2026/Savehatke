// ============================================
// SaveHatke — Page redirect & authentication guards
// ============================================
// Server-side 302s for four page rules. They run before express.static, so a
// restricted page's HTML never reaches the browser and nothing flashes:
//
//   1. /vault (any path form)                → always redirect to /
//   2. /dashboard (and any dashboard subpage) → / when the session is not valid
//   3. /login (and /login.html)              → / when the session IS valid
//   4. /login stays reachable for anyone not logged in
//
// Authentication reuses the same trusted check as the API: resolveCaller reads
// the HttpOnly sh_session cookie and validateSessionToken validates it against
// the server-side session table (Active status + expires_at). No localStorage,
// no unverified cookie, no client flag is trusted here.
//
// Loop safety: the redirect targets are "/" and the guards never redirect "/"
const { resolveCaller, isAdminRole } = require('./maintenance');

// Paths compared after lower-casing, with any trailing slash removed.
function normalisePath(req) {
  let p = String(req.path || '/').toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, '');
  // Strip a trailing .html so /vault.html and /vault are the same page.
  return p.replace(/\.html$/, '');
}

const ALWAYS_HOME_PAGES = new Set([]);
const VAULT_PAGES = new Set(['/vault']);
const LOGIN_PAGES = new Set(['/login']);

function isDashboardPath(p) {
  return p === '/dashboard' || p.startsWith('/dashboard/');
}

function isVaultPath(p) {
  return p === '/vault' || p.startsWith('/vault/');
}

function isGetOrHead(req) {
  return req.method === 'GET' || req.method === 'HEAD';
}

/**
 * Express middleware. Only page navigations are affected: API routes live
 * under /api and are never matched here.
 */
async function pageRedirectGuard(req, res, next) {
  if (!isGetOrHead(req)) return next();
  const p = normalisePath(req);

  // Rule 1 — unconditional redirect, no session lookup needed.
  if (ALWAYS_HOME_PAGES.has(p)) {
    return res.redirect(302, '/');
  }

  // Rules 2, 3 and 4 need the session.
  const isVault = isVaultPath(p);
  const isDash = isDashboardPath(p);
  const isLogin = LOGIN_PAGES.has(p);
  if (!isVault && !isDash && !isLogin) return next();

  let caller = null;
  try {
    caller = await resolveCaller(req);
  } catch (e) {
    // Fail closed for the dashboard and vault: an unverifiable session is not a session.
    // Fail open for login so a Supabase blip never locks people out of signing in.
    caller = null;
    if (isLogin) return next();
  }
  const loggedIn = Boolean(caller && caller.id);
  const isAdmin = Boolean(caller && (isAdminRole(caller) || ['admin', 'super admin', 'support'].includes(String(caller.role || '').toLowerCase())));

  // Vault is strictly for authenticated admins; non-admins bounce to /
  if (isVault && !isAdmin) return res.redirect(302, '/');
  // Dashboard requires a valid login session
  if (isDash && !loggedIn) return res.redirect(302, '/');
  // Logged-in users skip the login page and land on / (unless explicitly arriving via expired, logout, or oauth failure params)
  const hasExitParam = Boolean(req.query && (req.query.expired || req.query.logout || req.query.google));
  if (isLogin && loggedIn && !hasExitParam) return res.redirect(302, '/');
  return next();
}

module.exports = pageRedirectGuard;
module.exports.pageRedirectGuard = pageRedirectGuard;
module.exports.normalisePath = normalisePath;
