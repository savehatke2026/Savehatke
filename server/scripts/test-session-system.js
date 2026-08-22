// ============================================
// 48h Session System — offline unit checks
// ============================================
// Run: node server/scripts/test-session-system.js
// Stubs the Supabase service before the auth middleware loads, then
// exercises session validation, JWT expiry, cookie fallback, and the
// refresh clamp (never past login + 48h).

process.env.JWT_SECRET = 'test_secret_for_harness_only';
const path = require('path');

// ── Stub the Supabase service in the require cache BEFORE anything loads it ──
const supabasePath = require.resolve('../services/supabase');
const activeTokenHashHolder = { hash: null, behavior: 'active', expiresAt: null };
const stubCalls = { endSessionByToken: [], updateSessionActivity: [] };

const stubSupabase = {
  SESSION_TTL_MS: 48 * 60 * 60 * 1000,
  ADMIN_SESSION_TTL_MS: 2 * 60 * 60 * 1000,
  getClient: () => null,
  isConfigured: () => true,
  findSessionByToken: async (hash) => {
    if (hash !== activeTokenHashHolder.hash) return null;
    if (activeTokenHashHolder.behavior === 'unavailable') return { unavailable: true };
    if (activeTokenHashHolder.behavior === 'revoked') {
      return { session_id: 'sess-1', user_id: 'u1', email: 'a@b.c', login_method: activeTokenHashHolder.method || 'Email', status: 'Logged out', expires_at: new Date(Date.now() + 3600e3).toISOString() };
    }
    return {
      session_id: 'sess-1',
      user_id: 'u1',
      email: 'a@b.c',
      login_method: activeTokenHashHolder.method || 'Email',
      status: 'Active',
      expires_at: activeTokenHashHolder.expiresAt || new Date(Date.now() + 24 * 3600e3).toISOString(),
    };
  },
  endSessionByToken: async (hash, reason) => {
    stubCalls.endSessionByToken.push({ hash, reason });
    sessionCache.remove(hash); // mirrors the real invalidation
  },
  updateSessionActivity: async (id) => { stubCalls.updateSessionActivity.push(id); },
  expireOutdatedSessions: async () => { sessionCache.clear(); return { count: 0 }; },
};
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: stubSupabase };

const sessionCache = require('../services/sessionCache');
const auth = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

(async () => {
  console.log('\n── token helpers ──');
  const raw = auth.generateSessionToken();
  const hash = auth.hashSessionToken(raw);
  check('session token is 43-char base64url (256-bit)', /^[A-Za-z0-9_-]{43}$/.test(raw), raw.length);
  check('hash is sha256 hex and != raw', /^[0-9a-f]{64}$/.test(hash) && hash !== raw);

  console.log('\n── cookie helpers ──');
  let res = makeRes();
  auth.setSessionCookie(res, raw);
  check('cookie is HttpOnly', res.headers['Set-Cookie'].includes('HttpOnly'));
  check('cookie is SameSite=Lax', res.headers['Set-Cookie'].includes('SameSite=Lax'));
  check('cookie Max-Age = 48h', res.headers['Set-Cookie'].includes('Max-Age=172800'));
  check('no Secure flag in dev', !res.headers['Set-Cookie'].includes('Secure'));
  res = makeRes();
  auth.clearSessionCookie(res);
  check('clear cookie Max-Age=0', res.headers['Set-Cookie'].includes('Max-Age=0'));

  console.log('\n── authenticateToken ──');
  const activeSid = auth.generateSessionToken();
  activeTokenHashHolder.hash = auth.hashSessionToken(activeSid);

  // a) no token → 401
  let r = makeRes(); let nexted = false;
  await auth.authenticateToken({ headers: {} }, r, () => { nexted = true; });
  check('no token → 401', r.statusCode === 401 && !nexted);

  // b) expired JWT → 401 SESSION_EXPIRED
  const expiredJwt = jwt.sign({ id: 'u1', email: 'a@b.c', role: 'user', sid: activeSid }, SECRET, { expiresIn: -3600 });
  r = makeRes(); nexted = false;
  await auth.authenticateToken({ headers: { authorization: 'Bearer ' + expiredJwt } }, r, () => { nexted = true; });
  check('expired JWT → 401 SESSION_EXPIRED', r.statusCode === 401 && r.body && r.body.code === 'SESSION_EXPIRED', r.body);

  // c) valid JWT + active session → next()
  const goodJwt = jwt.sign({ id: 'u1', email: 'a@b.c', role: 'user', sid: activeSid, lgn: Math.floor(Date.now() / 1000) }, SECRET, { expiresIn: '48h' });
  const req = { headers: { authorization: 'Bearer ' + goodJwt } };
  r = makeRes(); nexted = false;
  await auth.authenticateToken(req, r, () => { nexted = true; });
  check('active session → next()', nexted && req.user.id === 'u1' && req.sessionId === 'sess-1');

  // d) revoked session → 401 SESSION_EXPIRED (revocation goes through
  //    endSessionByToken, which invalidates the cache — emulate that here)
  activeTokenHashHolder.behavior = 'revoked';
  await stubSupabase.endSessionByToken(auth.hashSessionToken(activeSid), 'Logged out');
  r = makeRes(); nexted = false;
  await auth.authenticateToken({ headers: { authorization: 'Bearer ' + goodJwt } }, r, () => { nexted = true; });
  check('revoked session → 401 SESSION_EXPIRED', r.statusCode === 401 && r.body.code === 'SESSION_EXPIRED');
  activeTokenHashHolder.behavior = 'active';
  sessionCache.clear();

  // e) unknown sid → 401
  const unknownSidJwt = jwt.sign({ id: 'u1', email: 'a@b.c', role: 'user', sid: 'does-not-exist' }, SECRET, { expiresIn: '1h' });
  r = makeRes(); nexted = false;
  await auth.authenticateToken({ headers: { authorization: 'Bearer ' + unknownSidJwt } }, r, () => { nexted = true; });
  check('unknown sid → 401 SESSION_EXPIRED', r.statusCode === 401 && r.body.code === 'SESSION_EXPIRED');

  // f) legacy token (no sid) → allowed (pre-upgrade tokens age out naturally)
  const legacyJwt = jwt.sign({ id: 'u1', email: 'a@b.c', role: 'user' }, SECRET, { expiresIn: '1h' });
  r = makeRes(); nexted = false;
  await auth.authenticateToken({ headers: { authorization: 'Bearer ' + legacyJwt } }, r, () => { nexted = true; });
  check('legacy token (no sid) → allowed', nexted);

  // g) HttpOnly cookie fallback (no Authorization header) — validates the
  //    raw session token directly and rebuilds identity from the session row
  r = makeRes(); nexted = false;
  const cookieReq = { headers: { cookie: 'other=1; sh_session=' + encodeURIComponent(activeSid) + '; x=y' } };
  await auth.authenticateToken(cookieReq, r, () => { nexted = true; });
  check('cookie fallback authenticates', nexted && cookieReq.sessionId === 'sess-1' &&
    cookieReq.user && cookieReq.user.id === 'u1' && cookieReq.user.role === 'user');

  // h) session active but expires_at already passed in DB → rejected + lazily expired
  activeTokenHashHolder.expiresAt = new Date(Date.now() - 60 * 1000).toISOString();
  sessionCache.clear();
  const freshJwt = jwt.sign({ id: 'u1', email: 'a@b.c', role: 'user', sid: activeSid }, SECRET, { expiresIn: '1h' });
  r = makeRes(); nexted = false;
  await auth.authenticateToken({ headers: { authorization: 'Bearer ' + freshJwt } }, r, () => { nexted = true; });
  check('DB expires_at passed → 401 + lazy Expired flip',
    r.statusCode === 401 && r.body.code === 'SESSION_EXPIRED' &&
    stubCalls.endSessionByToken.some((c) => c.reason === 'Expired'));
  activeTokenHashHolder.expiresAt = new Date(Date.now() + 24 * 3600e3).toISOString();

  // i) tampered signature → 403
  r = makeRes(); nexted = false;
  await auth.authenticateToken({ headers: { authorization: 'Bearer ' + goodJwt.slice(0, -3) + 'abc' } }, r, () => { nexted = true; });
  check('tampered token → 403', r.statusCode === 403);

  console.log('\n── refreshToken (48h clamp) ──');
  const H = 3600e3;
  const mk = (payload, expSec) => jwt.sign(payload, SECRET, { expiresIn: expSec });

  // a) login 47h ago, no sid → refresh clamped to ~1h left
  const t47 = mk({ id: 'u1', email: 'a@b.c', role: 'user', lgn: Math.floor((Date.now() - 47 * H) / 1000) }, '1h');
  const out47 = await auth.refreshToken(t47);
  check('47h-old login refreshes with ~1h left', out47 && out47.token &&
    Math.abs(jwt.decode(out47.token).exp * 1000 - (Date.now() + 1 * H)) < 5 * 60 * 1000,
    out47 && jwt.decode(out47.token).exp);

  // b) login 49h ago → refused
  const t49 = mk({ id: 'u1', email: 'a@b.c', role: 'user', lgn: Math.floor((Date.now() - 49 * H) / 1000) }, '1h');
  check('49h-old login → refresh refused', (await auth.refreshToken(t49)) === null);

  // c) session row expires before login+role-limit → clamped to session expiry
  //    (admin 30 minutes into a 2-hour session, row expires in 1 hour)
  activeTokenHashHolder.expiresAt = new Date(Date.now() + 1 * H).toISOString();
  const tSess = mk({ id: 'u1', email: 'a@b.c', role: 'admin', sid: activeSid, lgn: Math.floor((Date.now() - 30 * 60 * 1000) / 1000) }, '30m');
  const outSess = await auth.refreshToken(tSess);
  check('admin refresh clamped to session expires_at (1h left)', outSess &&
    Math.abs(jwt.decode(outSess.token).exp * 1000 - (Date.now() + 1 * H)) < 5 * 60 * 1000);
  check('refreshed token keeps sid + lgn', outSess && jwt.decode(outSess.token).sid === activeSid &&
    typeof jwt.decode(outSess.token).lgn === 'number');

  // d) revoked session → refresh refused
  activeTokenHashHolder.behavior = 'revoked';
  sessionCache.clear(); // emulate endSessionByToken invalidation
  const tRevoked = mk({ id: 'u1', email: 'a@b.c', role: 'user', sid: activeSid, lgn: Math.floor(Date.now() / 1000) }, '1h');
  check('revoked session → refresh refused', (await auth.refreshToken(tRevoked)) === null);
  activeTokenHashHolder.behavior = 'active';
  sessionCache.clear();

  // e) changing the computer clock cannot bypass: system clock ahead ⇒ JWT
  //    verified against signing time; login-time clamp is server-recorded lgn.
  const tClock = mk({ id: 'u1', email: 'a@b.c', role: 'user', lgn: Math.floor((Date.now() - 48.5 * H) / 1000) }, '1h');
  check('login+48h30m → refresh refused (clock-irrelevant, lgn-based)', (await auth.refreshToken(tClock)) === null);

  console.log('\n── admin 2-hour auto-logout ──');
  // a) admin login 1h ago, session row expires in 1h → refresh clamped to 1h
  activeTokenHashHolder.expiresAt = new Date(Date.now() + 1 * H).toISOString();
  activeTokenHashHolder.method = 'Admin';
  sessionCache.clear();
  const tAdmin1h = mk({ id: 'adm1', email: 'admin@x.c', role: 'admin', sid: activeSid, lgn: Math.floor((Date.now() - 1 * H) / 1000) }, '30m');
  const outAdmin1h = await auth.refreshToken(tAdmin1h);
  check('admin 1h into session → refresh clamped to remaining 1h', outAdmin1h &&
    Math.abs(jwt.decode(outAdmin1h.token).exp * 1000 - (Date.now() + 1 * H)) < 5 * 60 * 1000);

  // b) admin login 2h15m ago (past the 2h wall) → refused
  const tAdminLate = mk({ id: 'adm1', email: 'admin@x.c', role: 'admin', sid: activeSid, lgn: Math.floor((Date.now() - 2.25 * H) / 1000) }, '30m');
  check('admin past 2h wall → refresh refused', (await auth.refreshToken(tAdminLate)) === null);

  // c) expired admin JWT → role-aware message
  const tAdminExpired = mk({ id: 'adm1', email: 'admin@x.c', role: 'admin', sid: activeSid }, -1800);
  r = makeRes(); nexted = false;
  await auth.authenticateToken({ headers: { authorization: 'Bearer ' + tAdminExpired } }, r, () => { nexted = true; });
  check('expired admin JWT → 401 + 2-hour message', r.statusCode === 401 &&
    r.body.code === 'SESSION_EXPIRED' && /2-hour/.test(r.body.error), r.body);

  // d) cookie path with an ADMIN session row → identity rebuilt with admin role
  sessionCache.clear();
  const cookieReq2 = { headers: { cookie: 'sh_session=' + encodeURIComponent(activeSid) } };
  r = makeRes(); nexted = false;
  await auth.authenticateToken(cookieReq2, r, () => { nexted = true; });
  check('admin session via cookie → role admin', nexted && cookieReq2.user && cookieReq2.user.role === 'admin');

  // e) admin session revoked mid-window → immediate 401 with 2-hour message
  activeTokenHashHolder.behavior = 'revoked';
  await stubSupabase.endSessionByToken(auth.hashSessionToken(activeSid), 'Logged out');
  const tAdminLive = mk({ id: 'adm1', email: 'admin@x.c', role: 'admin', sid: activeSid, lgn: Math.floor(Date.now() / 1000) }, '30m');
  r = makeRes(); nexted = false;
  await auth.authenticateToken({ headers: { authorization: 'Bearer ' + tAdminLive } }, r, () => { nexted = true; });
  check('revoked admin session → 401 + 2-hour message', r.statusCode === 401 &&
    r.body.code === 'SESSION_EXPIRED' && /2-hour/.test(r.body.error));
  activeTokenHashHolder.behavior = 'active';
  activeTokenHashHolder.method = 'Email';
  sessionCache.clear();

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
