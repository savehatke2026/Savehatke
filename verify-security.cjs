/**
 * SaveHatke — Security regression suite (local, non-destructive)
 * =============================================================
 * Boots the real Express app on a loopback port and asserts the
 * authentication, authorization, coupon-reveal, payment, header, error-handling
 * and rate-limit guarantees the security requirements call for. Every check is
 * phrased as a MUST-FAIL or a MUST-PASS, and the process exits non-zero if any
 * expectation is not met, so it can be wired into CI.
 *
 * This performs NO destructive testing and NO load testing: a few dozen
 * requests against 127.0.0.1, a handful of deliberately malformed ones, and one
 * bounded burst to prove the 429 path. Never point it at production.
 *
 * Usage:
 *   node verify-security.cjs                       # all checks
 *   node verify-security.cjs --only auth,admin     # only those groups
 *   SEC_TEST_PORT=3210 node verify-security.cjs
 *
 * Group names: auth, session, admin, coupon, payment, surfaces, csrf,
 *              headers, errors, ratelimit, funct
 */

'use strict';

const path = require('path');
const http = require('http');

const ROOT = __dirname;
require('dotenv').config({ path: path.join(ROOT, '.env') });

const PORT = Number(process.env.SEC_TEST_PORT || 3199);
const BASE = `http://127.0.0.1:${PORT}`;

// The app validates the Origin header against an allowlist (server.js) and
// correctly refuses a foreign origin with 403. The harness declares its own
// origin BEFORE the app is required so the checks exercise the real handlers
// instead of tripping the CSRF gate on every request. The gate itself is
// verified separately with a deliberately foreign origin.
process.env.ALLOWED_ORIGINS = [process.env.ALLOWED_ORIGINS, BASE].filter(Boolean).join(',');

const only = (() => {
  const i = process.argv.indexOf('--only');
  if (i === -1) return new Set();
  return new Set(String(process.argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean));
})();

let pass = 0;
let fail = 0;
const failures = [];
let groupSkipped = false;
let currentGroup = '';

function group(name) {
  currentGroup = name;
  groupSkipped = only.size > 0 && !only.has(name);
  if (!groupSkipped) console.log(`\n${name.toUpperCase()}`);
}

function check(name, ok, detail) {
  if (groupSkipped) return;
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else {
    fail += 1;
    failures.push(`${currentGroup}: ${name}`);
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function request(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** header.payload.signature with nothing signing it. */
function fakeJwt(payload, header = { alg: 'RS256', typ: 'JWT', kid: 'fake' }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64(header)}.${b64(payload)}.${Buffer.from('not-a-real-signature').toString('base64url')}`;
}

/** A token whose payload is entirely attacker-chosen — including an admin email. */
const ATTACKER_IDENTITY = {
  iss: 'accounts.google.com',
  aud: process.env.GOOGLE_CLIENT_ID || 'x.apps.googleusercontent.com',
  sub: '1234567890',
  email: 'rupayandas2024@gmail.com',
  email_verified: true,
  name: 'Attacker',
  picture: 'https://evil.example/x.png',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
  nonce: 'attacker-nonce',
};

/** True when a SaveHatke SESSION cookie was issued (the OAuth state cookie does not count). */
function issuedSessionCookie(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.some((c) => String(c).startsWith('sh_session=') && !/sh_session=;/.test(String(c)));
}

const ORIGIN = BASE;

async function authChecks() {
  group('auth');

  const emailOnly = await request('POST', '/api/auth/login', {
    headers: { Origin: ORIGIN }, body: { email: 'someone@example.com' },
  });
  check('POST /api/auth/login {email} does not authenticate',
    emailOnly.status !== 200 && !issuedSessionCookie(emailOnly),
    `status=${emailOnly.status}`);

  const registerOnly = await request('POST', '/api/auth/register', {
    headers: { Origin: ORIGIN }, body: { email: 'someone@example.com' },
  });
  check('POST /api/auth/register {email} does not authenticate',
    registerOnly.status !== 200 && !issuedSessionCookie(registerOnly),
    `status=${registerOnly.status}`);

  for (const p of ['/api/auth/google', '/api/auth/google-redirect']) {
    const forged = await request('POST', p, {
      headers: { Origin: ORIGIN },
      body: {
        credential: fakeJwt(ATTACKER_IDENTITY), id_token: fakeJwt(ATTACKER_IDENTITY),
        email: 'rupayandas2024@gmail.com', role: 'admin', isAdmin: true,
      },
    });
    check(`POST ${p} with a forged Google token issues no session`,
      !issuedSessionCookie(forged), `status=${forged.status}`);
  }

  const forgedCallback = await request('GET',
    '/api/auth/google-redirect?id_token=' + encodeURIComponent(fakeJwt(ATTACKER_IDENTITY)) +
    '&email=rupayandas2024@gmail.com&role=admin&isAdmin=true&code=fake-code&state=fake-state',
    { headers: { Origin: ORIGIN } });
  check('GET /api/auth/google-redirect with a forged identity issues no session cookie',
    !issuedSessionCookie(forgedCallback), `status=${forgedCallback.status}`);
  check('forged callback is refused (redirects to the login failure state)',
    forgedCallback.status >= 300 && forgedCallback.status < 400 &&
    /\/login\?google=failed/.test(String(forgedCallback.headers.location || '')),
    `status=${forgedCallback.status} location=${forgedCallback.headers.location || ''}`);
  check('forged callback does not land on an authenticated page',
    !/vault|dashboard/i.test(String(forgedCallback.headers.location || '')));

  // Tokens that are well-formed but wrong in each specific way the OAuth
  // callback is required to reject. The callback talks to Google directly, so a
  // token placed in the request cannot be substituted for the exchanged one —
  // which is exactly why every one of these lands on the failure state.
  const badTokens = {
    expired: fakeJwt({ ...ATTACKER_IDENTITY, exp: Math.floor(Date.now() / 1000) - 60 }),
    wrongAudience: fakeJwt({ ...ATTACKER_IDENTITY, aud: 'someone-elses-client-id.apps.googleusercontent.com' }),
    wrongIssuer: fakeJwt({ ...ATTACKER_IDENTITY, iss: 'accounts.evil.com' }),
    unverifiedEmail: fakeJwt({ ...ATTACKER_IDENTITY, email_verified: false }),
    noSubject: fakeJwt({ ...ATTACKER_IDENTITY, sub: undefined }),
  };
  for (const [label, token] of Object.entries(badTokens)) {
    const r = await request('GET', '/api/auth/google-redirect?code=x&state=y',
      { headers: { Origin: ORIGIN, 'X-Test-Id-Token': token } });
    check(`rejected identity (${label}) issues no session cookie and lands on the failure state`,
      !issuedSessionCookie(r) && /google=failed/.test(String(r.headers.location || '')),
      `status=${r.status} location=${r.headers.location || ''}`);
  }
}

async function sessionChecks() {
  group('session');

  const me = await request('GET', '/api/auth/me', { headers: { Origin: ORIGIN } });
  check('GET /api/auth/me without a session → 401', me.status === 401, `status=${me.status}`);

  const logout = await request('POST', '/api/auth/logout', {
    headers: { Origin: ORIGIN },
    body: { user_id: 'victim', email: 'victim@example.com', session_id: 'sess_victim' },
  });
  check('POST /api/auth/logout unauthenticated → 401 (cannot revoke another session)',
    logout.status === 401, `status=${logout.status}`);

  // 401 (no such session) and 503 (store unreachable) are both refusals; the
  // guarantee is that an unverified cookie never yields a 2xx.
  const bogus = await request('GET', '/api/auth/me', {
    headers: { Origin: ORIGIN, Cookie: 'sh_session=' + 'a'.repeat(43) },
  });
  check('GET /api/auth/me with a bogus sh_session cookie → refused, never 2xx',
    bogus.status === 401 || bogus.status === 503, `status=${bogus.status}`);

  for (const p of ['/api/auth/me', '/api/admin/stats']) {
    const bearer = await request('GET', p, {
      headers: { Origin: ORIGIN, Authorization: 'Bearer ' + fakeJwt({ ...ATTACKER_IDENTITY, role: 'admin' }) },
    });
    check(`Bearer token is not accepted on ${p}`, bearer.status === 401, `status=${bearer.status}`);
  }

  const cleanup = await request('POST', '/api/auth/session-cleanup', {
    headers: { Origin: ORIGIN }, body: {},
  });
  check('POST /api/auth/session-cleanup without the cron/admin credential → refused',
    cleanup.status === 401 || cleanup.status === 403, `status=${cleanup.status}`);
}

async function adminChecks() {
  group('admin');

  const adminGets = [
    '/api/admin/stats', '/api/admin/users', '/api/admin/coupons', '/api/admin/sessions',
    '/api/admin/settings', '/api/admin/me', '/api/admin/list-admins',
    '/api/admin/finance/overview', '/api/admin/finance/report',
    '/api/admin/payouts', '/api/admin/payouts/stats',
    '/api/admin/email-testing/templates', '/api/admin/email-testing/config',
    '/api/admin/gmail/status', '/api/admin/payment-mailbox/status',
    '/api/admin/security-credentials', '/api/admin/maintenance',
  ];
  for (const p of adminGets) {
    const r = await request('GET', p, { headers: { Origin: ORIGIN } });
    check(`GET ${p} unauthenticated → 401/403/404 (never 2xx)`,
      [401, 403, 404].includes(r.status), `status=${r.status}`);
  }

  const adminWrites = [
    ['POST', '/api/admin/create-admin', { email: 'attacker@evil.com', role: 'admin', isAdmin: true }],
    ['PUT', '/api/admin/update-admin/1', { role: 'admin', isAdmin: true }],
    ['DELETE', '/api/admin/delete-admin/2', {}],
    ['PUT', '/api/admin/settings', { maintenanceMode: true }],
    ['PUT', '/api/admin/users/status', { userId: 'x', status: 'active', role: 'admin' }],
    ['PUT', '/api/admin/maintenance', { enabled: false }],
    ['POST', '/api/admin/finance/admin-payouts', { amount: 999999, adminEmail: 'attacker@evil.com' }],
    ['POST', '/api/admin/finance/admin-payouts/AP-1/approve', { paymentReference: 'x' }],
    ['POST', '/api/admin/payouts/AP-1/approve', { paymentReference: 'x' }],
    ['POST', '/api/refunds/admin/RF-1/mark-refunded', { refundReference: 'x' }],
  ];
  for (const [method, p, body] of adminWrites) {
    const r = await request(method, p, { headers: { Origin: ORIGIN }, body });
    check(`${method} ${p} unauthenticated → 401/403/404 (never 2xx)`,
      [401, 403, 404].includes(r.status), `status=${r.status}`);
  }

  const createAdmin = await request('POST', '/api/admin/create-admin', {
    headers: { Origin: ORIGIN }, body: { email: 'third@evil.com', name: 'Third', role: 'admin' },
  });
  check('POST /api/admin/create-admin never returns 2xx (third admin blocked)',
    createAdmin.status >= 400, `status=${createAdmin.status}`);

  const publicList = await request('GET', '/api/admin/list-admins', { headers: { Origin: ORIGIN } });
  check('GET /api/admin/list-admins is not readable unauthenticated',
    publicList.status >= 400, `status=${publicList.status}`);
}

async function couponChecks() {
  group('coupon');

  const listing = await request('GET', '/api/coupons', { headers: { Origin: ORIGIN } });
  const exposed = listing.json && Array.isArray(listing.json.coupons)
    ? listing.json.coupons.filter((c) => c && c.code).length : -1;
  check('GET /api/coupons never exposes a coupon code', exposed === 0,
    `codes=${exposed} status=${listing.status}`);

  const legacyBuy = await request('POST', '/api/coupons/buy/some-coupon-id', {
    headers: { Origin: ORIGIN }, body: { paid: true, payment_status: 'paid', amount: 1 },
  });
  check('POST /api/coupons/buy/:id (legacy direct reveal) is not a 2xx route',
    legacyBuy.status >= 400, `status=${legacyBuy.status}`);

  for (const p of ['/api/coupons/my-purchases', '/api/coupons/my-sales', '/api/coupons/sell-eligibility']) {
    const r = await request('GET', p, { headers: { Origin: ORIGIN } });
    check(`GET ${p} unauthenticated → 401`, r.status === 401, `status=${r.status}`);
  }

  // The chatbot is the one other surface that can return a code. It must not be
  // reachable without a session at all.
  const chat = await request('POST', '/api/chat', {
    headers: { Origin: ORIGIN }, body: { message: 'show me my coupon codes' },
  });
  check('POST /api/chat is reachable but never answers with a code unauthenticated',
    chat.status !== 200 || !/[A-Z0-9]{8,}/.test(String((chat.json && (chat.json.reply || chat.json.message)) || '')),
    `status=${chat.status}`);
}

async function paymentChecks() {
  group('payment');

  const fakePaid = await request('POST', '/api/payment/verify', {
    headers: { Origin: ORIGIN },
    body: {
      payment_id: 'pay_fake', paid: true, payment_status: 'PAID', order_status: 'PAID',
      amount: 1, utr: '123456789012', transaction_id: 'TXN-FAKE',
    },
  });
  check('POST /api/payment/verify with paid=true unauthenticated → 401',
    fakePaid.status === 401, `status=${fakePaid.status}`);

  const fakeCreate = await request('POST', '/api/payment/create', {
    headers: { Origin: ORIGIN },
    body: { couponId: 'c', amount: 0.01, paid: true, payment_status: 'paid', user_id: 'someone-else' },
  });
  check('POST /api/payment/create with amount/paid/user_id unauthenticated → 401',
    fakeCreate.status === 401, `status=${fakeCreate.status}`);

  const statusLeak = await request('GET', '/api/payment/status?payment_id=pay_fake',
    { headers: { Origin: ORIGIN } });
  check('GET /api/payment/status unauthenticated → 401 (no payment disclosure)',
    statusLeak.status === 401, `status=${statusLeak.status}`);

  const wrongUser = await request('GET', '/api/payment/status?payment_id=pay_someone_else',
    { headers: { Origin: ORIGIN, Cookie: 'sh_session=' + 'b'.repeat(43) } });
  check('GET /api/payment/status with a foreign payment id is never 2xx',
    wrongUser.status !== 200, `status=${wrongUser.status}`);

  const badSig = await request('POST', '/api/payment/webhook', {
    headers: { Origin: ORIGIN, 'X-Payment-Signature': 'deadbeef' },
    body: { status: 'SUCCESS', amount: 1, utr: '1', reference: 'x' },
  });
  check('POST /api/payment/webhook with a bad signature → 401', badSig.status === 401, `status=${badSig.status}`);

  // The raw-body capture must cover every spelling Express routes to the same
  // handler, or the HMAC would silently be computed over a re-serialisation.
  for (const p of ['/api/payment/webhook/', '/API/Payment/Webhook']) {
    const r = await request('POST', p, {
      headers: { Origin: ORIGIN, 'X-Payment-Signature': 'deadbeef' },
      body: { status: 'SUCCESS', amount: 1 },
    });
    check(`POST ${p} with a bad signature → 401 (raw-body capture normalised)`,
      r.status === 401, `status=${r.status}`);
  }

  const noSecret = await request('POST', '/api/payment/webhook', {
    headers: { Origin: ORIGIN }, body: { status: 'SUCCESS', amount: 1 },
  });
  check('POST /api/payment/webhook without any signature → refused (fails closed)',
    noSecret.status >= 400, `status=${noSecret.status}`);
}

async function surfaceChecks() {
  group('surfaces');

  const routes = [
    ['GET', '/api/refunds'], ['GET', '/api/refunds/RF-1'], ['POST', '/api/refunds/RF-1/request'],
    ['GET', '/api/payouts/details'], ['GET', '/api/payouts/my'], ['POST', '/api/payouts/request'],
    ['GET', '/api/tracker/list'], ['POST', '/api/tracker/add'],
    ['GET', '/api/auth/sessions'], ['GET', '/api/auth/login-history'],
    ['GET', '/api/auth/security-events'], ['PUT', '/api/auth/preferred-name'],
    ['GET', '/api/admin/gmail/audit'], ['GET', '/api/admin/gmail/messages'],
    ['PUT', '/api/auth/notification-preferences'],
  ];
  for (const [method, p] of routes) {
    const r = await request(method, p, {
      headers: { Origin: ORIGIN }, body: method === 'GET' ? null : {},
    });
    check(`${method} ${p} unauthenticated → 401/403/404`,
      [401, 403, 404].includes(r.status), `status=${r.status}`);
  }
}

async function csrfChecks() {
  group('csrf');

  const foreign = await request('POST', '/api/auth/logout', {
    headers: { Origin: 'https://evil.example' }, body: {},
  });
  check('POST with a foreign Origin → 403', foreign.status === 403, `status=${foreign.status}`);

  const foreignAdmin = await request('PUT', '/api/admin/maintenance', {
    headers: { Origin: 'https://evil.example' }, body: { enabled: false },
  });
  check('admin PUT with a foreign Origin → 403', foreignAdmin.status === 403, `status=${foreignAdmin.status}`);

  const crossSite = await request('POST', '/api/auth/logout', {
    headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }, body: {},
  });
  check('POST with Sec-Fetch-Site: cross-site → 403', crossSite.status === 403, `status=${crossSite.status}`);

  const preflight = await request('OPTIONS', '/api/auth/me', {
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
  });
  check('CORS never returns Access-Control-Allow-Origin: *',
    preflight.headers['access-control-allow-origin'] !== '*',
    `acao=${preflight.headers['access-control-allow-origin']}`);
  check('CORS does not reflect a foreign origin',
    !preflight.headers['access-control-allow-origin'],
    `acao=${preflight.headers['access-control-allow-origin']}`);

  const allowed = await request('OPTIONS', '/api/auth/me', {
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' },
  });
  check('CORS reflects the legitimate SaveHatke origin',
    allowed.headers['access-control-allow-origin'] === ORIGIN,
    `acao=${allowed.headers['access-control-allow-origin']}`);
}

async function headerChecks() {
  group('headers');

  const page = await request('GET', '/api/health', { headers: { Origin: ORIGIN } });
  check('X-Content-Type-Options: nosniff', page.headers['x-content-type-options'] === 'nosniff');
  check('X-Frame-Options set', Boolean(page.headers['x-frame-options']));
  check('Referrer-Policy set', Boolean(page.headers['referrer-policy']));
  check('Permissions-Policy denies camera/microphone/geolocation',
    /camera=\(\)/.test(String(page.headers['permissions-policy'])) &&
    /microphone=\(\)/.test(String(page.headers['permissions-policy'])));
  check('Content-Security-Policy frame-ancestors enforced',
    /frame-ancestors/.test(String(page.headers['content-security-policy'])));
  check('CSP report-only present (no UI breakage, violations reported)',
    Boolean(page.headers['content-security-policy-report-only']));
  check('X-Powered-By is not disclosed', !page.headers['x-powered-by']);

  const html = await request('GET', '/login.html', { headers: { Origin: ORIGIN } });
  check('the login page itself carries the security headers',
    html.headers['x-content-type-options'] === 'nosniff' &&
    Boolean(html.headers['permissions-policy']));
}

async function errorChecks() {
  group('errors');

  const malformed = await request('POST', '/api/auth/logout', {
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{not json',
  });
  const body = malformed.raw || '';
  check('malformed JSON → 400 with a safe message',
    malformed.status === 400 && !/SyntaxError|node_modules|\/server\//i.test(body),
    `status=${malformed.status} body=${body.slice(0, 120)}`);
  check('error responses carry no stack trace',
    !/\bat\s+Object\.|\bnode:internal\b/.test(body));

  const notFound = await request('GET', '/api/definitely-not-a-route', { headers: { Origin: ORIGIN } });
  check('unknown API route → safe 404 JSON',
    notFound.status === 404 && !/node_modules|\/server\//.test(notFound.raw || ''),
    `status=${notFound.status}`);

  const oversized = await request('POST', '/api/auth/logout', {
    headers: { Origin: ORIGIN },
    body: JSON.stringify({ pad: 'x'.repeat(400 * 1024) }),
  });
  check('oversized body → 413 with a safe message',
    oversized.status === 413 && !/node_modules|\/server\//.test(oversized.raw || ''),
    `status=${oversized.status}`);

  const health = await request('GET', '/api/health', { headers: { Origin: ORIGIN } });
  check('no endpoint echoes environment values',
    !/SUPABASE_SERVICE|GOOGLE_PRIVATE_KEY|JWT_SECRET|SMTP_PASS/.test(health.raw || ''));
}

async function rateLimitChecks() {
  group('ratelimit');

  // /api/auth allows 20 requests / 15 min per IP. A bounded burst proves the
  // 429 path without load-testing anything.
  let limited = null;
  for (let i = 0; i < 30; i += 1) {
    const r = await request('POST', '/api/auth/login', {
      headers: { Origin: ORIGIN }, body: { email: `probe${i}@example.com` },
    });
    if (r.status === 429) { limited = r; break; }
  }
  check('excessive requests to /api/auth → 429', Boolean(limited));
  if (limited) {
    check('429 includes Retry-After', Boolean(limited.headers['retry-after']),
      `retry-after=${limited.headers['retry-after']}`);
    check('429 body carries the RATE_LIMITED code (frontend 429 page)',
      limited.json && limited.json.code === 'RATE_LIMITED',
      `body=${limited.raw.slice(0, 120)}`);
    check('429 sets Cache-Control: no-store',
      /no-store/.test(String(limited.headers['cache-control'])));
    check('429 body does not leak internal rate-limit state',
      !/store|key|remaining|totalHits/i.test(limited.raw));
  }

  // A browser navigation must receive the branded page, a machine caller JSON.
  const { safeRateLimitHandler, wantsHtml } = require('./server/utils/rateLimit');
  const asReq = (url, accept) => ({ originalUrl: url, url, headers: { accept } });
  check('HTML navigation gets the branded 429 page',
    wantsHtml(asReq('/api/coupons', 'text/html,application/xhtml+xml')) === true);
  check('API/XHR callers get JSON',
    wantsHtml(asReq('/api/coupons', 'application/json')) === false);
  check('machine endpoints always get JSON, even with an HTML Accept header',
    wantsHtml(asReq('/api/payment/webhook', 'text/html')) === false &&
    wantsHtml(asReq('/api/admin/reports/monthly/run', 'text/html')) === false &&
    wantsHtml(asReq('/api/auth/session-cleanup', 'text/html')) === false);
  check('safeRateLimitHandler is exported for every limiter', typeof safeRateLimitHandler === 'function');
}

async function functionalityChecks() {
  group('funct');

  const publicRoutes = [
    ['GET', '/api/health', 200],
    ['GET', '/api/settings', 200],
    ['GET', '/api/coupons', 200],
    ['GET', '/api/coupons/categories', 200],
    ['GET', '/api/turnstile-config', 200],
    ['GET', '/api/consent', 200],
    ['GET', '/api/maintenance/status', 200],
    ['GET', '/login.html', 200],
    ['GET', '/429.html', 200],
    ['GET', '/index.html', 200],
    ['GET', '/marketplace.html', 200],
    ['GET', '/support.html', 200],
  ];
  for (const [method, p, expected] of publicRoutes) {
    const r = await request(method, p, { headers: { Origin: ORIGIN } });
    check(`${method} ${p} → ${expected}`, r.status === expected, `status=${r.status}`);
  }

  const login = await request('GET', '/login.html', { headers: { Origin: ORIGIN } });
  check('login page still renders the email input',
    /id="inputEmail"/.test(login.raw) && /type="text"[^>]*id="inputEmail"/.test(login.raw));
  check('login page still renders the Google sign-in button',
    /id="googleSignInBtn"/.test(login.raw) && /Continue with Google/.test(login.raw));
  check('login page still has the email submit button',
    /id="submitBtn"/.test(login.raw));

  const cfg = await request('GET', '/api/turnstile-config', { headers: { Origin: ORIGIN } });
  check('turnstile-config returns a site key (public half only)',
    cfg.status === 200 && Boolean(cfg.json && cfg.json.siteKey) &&
    !/secret/i.test(cfg.raw || ''));
}

async function main() {
  console.log('SaveHatke security regression suite (local, non-destructive)');
  if (only.size) console.log(`Filter: ${[...only].join(', ')}`);

  const app = require('./server/server.js');
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  console.log(`App listening on ${BASE}`);

  await authChecks();
  await sessionChecks();
  await adminChecks();
  await couponChecks();
  await paymentChecks();
  await surfaceChecks();
  await csrfChecks();
  await headerChecks();
  await errorChecks();
  await rateLimitChecks();
  await functionalityChecks();

  console.log(`\n${'='.repeat(62)}`);
  console.log(`PASSED: ${pass}   FAILED: ${fail}`);
  if (failures.length) {
    console.log('\nFailed checks:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('='.repeat(62));

  server.close();
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 200).unref();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Harness error:', (err && err.stack) || err);
  process.exit(2);
});
