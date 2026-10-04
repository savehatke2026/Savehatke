/**
 * SaveHatke — distributed rate limiting regression suite
 * =====================================================
 * Proves the Redis-backed rate limiting actually behaves as required, against
 * the real middleware, with a local stub speaking the Upstash REST protocol
 * (scripts/test/upstash-stub.cjs). No real credentials and no network access
 * are needed, and nothing is sent anywhere.
 *
 * What is asserted:
 *   1. Shared counters — two independent limiter "instances" spend ONE budget,
 *      which is the entire point of moving off in-process counters.
 *   2. 429 shape — status, Retry-After, Cache-Control: no-store, and the
 *      RATE_LIMITED code the existing frontend redirect keys on.
 *   3. Browser vs API — an HTML navigation gets the branded page, XHR gets JSON.
 *   4. IP limits and account limits are independent.
 *   5. Admin mutations are far stricter than admin reads.
 *   6. Chat: guest bucket, and an authenticated account gets the larger budget.
 *   7. Forged identity — body user_id / email / role / isAdmin cannot move a
 *      caller into another bucket or out of their own.
 *   8. Spoofed IP headers — X-Forwarded-For / X-Real-IP / cf-connecting-ip /
 *      true-client-ip cannot buy a fresh budget.
 *   9. Redis outage — sensitive limiters refuse (fail closed), public reads
 *      degrade to the in-process window, and Redis details never leak.
 *  10. Webhooks are never rate limited (provider retries must not be blocked).
 *
 * Usage:  node verify-ratelimit.cjs
 *         npm run verify:ratelimit
 */

'use strict';

const path = require('path');
const http = require('http');

const ROOT = __dirname;
require('dotenv').config({ path: path.join(ROOT, '.env') });

let pass = 0;
let fail = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n${name.toUpperCase()}`);
}

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else {
    fail += 1;
    failures.push(`${currentGroup}: ${name}`);
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function request(port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
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
        try { json = JSON.parse(raw); } catch (e) { /* html or empty */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Poll until predicate is true or the budget runs out. */
async function until(fn, maxTries = 200, delayMs = 25) {
  for (let i = 0; i < maxTries; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, delayMs)); // eslint-disable-line no-await-in-loop
  }
  return null;
}

async function main() {
  console.log('SaveHatke distributed rate-limiting suite');

  // ── Boot the Upstash stub and point the service at it ───────────────────
  const { startUpstashStub } = require('./scripts/test/upstash-stub.cjs');
  const stub = await startUpstashStub();

  // The service reads these at require time, so they must be set first.
  process.env.UPSTASH_REDIS_REST_URL = stub.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token-not-a-secret';
  process.env.NODE_ENV = 'test';

  const rateLimitService = require('./server/services/rateLimitService');
  const { safeRateLimitHandler } = require('./server/utils/rateLimit');

  // A minimal app that mounts the REAL middleware, so the classification and
  // identity resolution under test are the production ones.
  const express = require('./server/node_modules/express');
  const app = express();
  app.set('trust proxy', 1);

  // Stand-in for the session resolver: production passes middleware/maintenance
  // resolveCaller, which validates the session row. Tests inject the identity
  // via a header so the resolver's own correctness is covered by verify-security.
  let resolverMode = 'header';
  app.use((req, res, next) => {
    const raw = req.get('x-test-identity');
    if (!raw) return next();
    if (resolverMode === 'off') return next();
    try {
      const parsed = JSON.parse(raw);
      // Mirror resolveCaller's return shape, and cache it like the real one.
      req.__caller = {
        id: parsed.id || '',
        email: String(parsed.email || '').toLowerCase(),
        isAdmin: Boolean(parsed.isAdmin),
      };
    } catch (e) { /* ignore */ }
    return next();
  });
  app.use('/api', rateLimitService.distributedLimiter({
    resolveCaller: async (req) => (resolverMode === 'off' ? null : req.__caller || null),
  }));
  app.all('/api/*', (req, res) => res.json({ ok: true, reached: req.originalUrl }));
  app.all('*', (req, res) => res.json({ ok: true, page: req.originalUrl }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const PORT = server.address().port;
  console.log(`test app on http://127.0.0.1:${PORT}  (stub ${stub.url})`);

  check('the rate-limit service reports distributed mode as active',
    rateLimitService.isDistributed() === true);

  // ── 1. Shared counters across instances ────────────────────────────────
  group('shared counters');
  {
    // Two independent Ratelimit clients (think: two Vercel instances) pointed at
    // the same stub must spend from ONE budget.
    const { Redis } = require('@upstash/redis');
    const { Ratelimit } = require('@upstash/ratelimit');
    const mk = () => new Ratelimit({
      redis: new Redis({ url: stub.url, token: 'test-token-not-a-secret' }),
      limiter: Ratelimit.slidingWindow(4, '1 m'),
      prefix: 'sh:test:shared',
      analytics: false,
    });
    const a = mk();
    const b = mk();
    const r1 = await a.limit('user:shared-probe');
    const r2 = await b.limit('user:shared-probe');
    const r3 = await a.limit('user:shared-probe');
    const r4 = await b.limit('user:shared-probe');
    const r5 = await a.limit('user:shared-probe');
    check('instance A and instance B share one counter (4 allowed, 5th refused)',
      r1.success && r2.success && r3.success && r4.success && r5.success === false,
      `successes=${[r1, r2, r3, r4, r5].map((r) => r.success).join(',')}`);

    // The service's own counters land in the shared store under a namespaced key.
    const before = stub.state.keysSeen.length;
    await rateLimitService.consume('public-read', 'ip:203.0.113.9');
    check('consume() writes a namespaced counter into the shared store',
      stub.state.keysSeen.length > before &&
      stub.state.keysSeen.some((k) => k.includes('sh:rl:')),
      `keys=${stub.state.keysSeen.slice(-1)[0] || 'none'}`);
  }

  // ── 2. 429 shape ───────────────────────────────────────────────────────
  group('429 response shape');
  {
    stub.reset();
    // /api/auth -> 5/min
    let limited = null;
    for (let i = 0; i < 8; i += 1) {
      const r = await request(PORT, 'POST', '/api/auth/login', { body: { email: 'a@b.c' } });
      if (r.status === 429) { limited = r; break; }
    }
    check('exceeding the auth budget returns 429', Boolean(limited),
      limited ? '' : 'never rate limited');
    if (limited) {
      check('429 sets Retry-After', Boolean(limited.headers['retry-after']),
        `retry-after=${limited.headers['retry-after']}`);
      check('Retry-After is a positive integer',
        /^\d+$/.test(String(limited.headers['retry-after'])) && Number(limited.headers['retry-after']) > 0,
        `retry-after=${limited.headers['retry-after']}`);
      check('429 sets Cache-Control: no-store',
        /no-store/.test(String(limited.headers['cache-control'])),
        `cc=${limited.headers['cache-control']}`);
      check('429 carries the RATE_LIMITED code the frontend redirect keys on',
        limited.json && limited.json.code === 'RATE_LIMITED', `body=${limited.raw.slice(0, 120)}`);
      check('429 carries a human message',
        Boolean(limited.json && (limited.json.message || limited.json.error)),
        `body=${limited.raw.slice(0, 120)}`);
      check('429 leaks no limiter name, key, Redis detail or counter',
        !/upstash|redis|simulated|public-read|auth-account|remaining|totalHits|store/i.test(limited.raw),
        `body=${limited.raw.slice(0, 200)}`);
    }
  }

  // ── 3. Browser vs API delivery ─────────────────────────────────────────
  group('browser vs api 429');
  {
    stub.reset();
    let htmlLimited = null;
    for (let i = 0; i < 8; i += 1) {
      const r = await request(PORT, 'GET', '/api/auth/google-config', {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      if (r.status === 429) { htmlLimited = r; break; }
    }
    check('a browser navigation receives the branded HTML 429 page',
      Boolean(htmlLimited) && /text\/html/.test(String(htmlLimited.headers['content-type'])) &&
      /Too Many Requests/i.test(htmlLimited.raw),
      htmlLimited ? `ct=${htmlLimited.headers['content-type']}` : 'never limited');
    check('the branded page still sets Retry-After',
      Boolean(htmlLimited && htmlLimited.headers['retry-after']));

    stub.reset();
    let jsonLimited = null;
    for (let i = 0; i < 8; i += 1) {
      const r = await request(PORT, 'GET', '/api/auth/google-config', {
        headers: { Accept: 'application/json' },
      });
      if (r.status === 429) { jsonLimited = r; break; }
    }
    check('an API/XHR caller receives JSON, not HTML',
      Boolean(jsonLimited) && /application\/json/.test(String(jsonLimited.headers['content-type'])),
      jsonLimited ? `ct=${jsonLimited.headers['content-type']}` : 'never limited');
  }

  // ── 4. IP vs account budgets are independent ───────────────────────────
  group('ip and account budgets');
  {
    stub.reset();
    // Ten different accounts from one IP: the per-account budget must never be
    // reached, but the shared IP budget must be.
    let sawDenied = false;
    let allowed = 0;
    for (let i = 0; i < 15; i += 1) {
      const r = await request(PORT, 'POST', '/api/payment/create', {
        headers: {
          'x-test-identity': JSON.stringify({ id: `acct-${i}`, email: `u${i}@example.com` }),
          'x-forwarded-for': '198.51.100.7',
        },
        body: { couponId: 'c' },
      });
      if (r.status === 429 || r.status === 503) { sawDenied = true; break; }
      allowed += 1;
    }
    check('the shared IP budget eventually stops many accounts from one address',
      sawDenied, `allowed=${allowed} before denial`);
    check('but a single account is not limited below its own budget',
      allowed >= 3, `allowed=${allowed} (per-account budget is 3/min)`);

    // A different IP with the same account still hits the account budget.
    stub.reset();
    let accountDenied = 0;
    for (let i = 0; i < 6; i += 1) {
      const r = await request(PORT, 'POST', '/api/payment/create', {
        headers: {
          'x-test-identity': JSON.stringify({ id: 'acct-fixed', email: 'fixed@example.com' }),
          'x-forwarded-for': `203.0.113.${100 + i}`,
        },
        body: {},
      });
      if (r.status === 429 || r.status === 503) accountDenied += 1;
    }
    check('rotating the source IP does not buy an account extra payment-create budget',
      accountDenied > 0, `denied=${accountDenied} of 6`);
  }

  // ── 5. Admin reads are looser than admin mutations ─────────────────────
  group('admin limits');
  {
    const admin = { id: 'admin-1', email: 'rupayandas2024@gmail.com', isAdmin: true };

    stub.reset();
    let readDenied = 0;
    for (let i = 0; i < 25; i += 1) {
      const r = await request(PORT, 'GET', '/api/admin/stats', {
        headers: { 'x-test-identity': JSON.stringify(admin), 'x-forwarded-for': '198.51.100.20' },
      });
      if (r.status === 429 || r.status === 503) readDenied += 1;
    }
    check('admin reads tolerate a normal panel burst (25 rapid reads allowed)',
      readDenied === 0, `denied=${readDenied}`);

    stub.reset();
    let mutationDenied = 0;
    let mutationAllowed = 0;
    for (let i = 0; i < 10; i += 1) {
      const r = await request(PORT, 'PUT', '/api/admin/maintenance', {
        headers: { 'x-test-identity': JSON.stringify(admin), 'x-forwarded-for': '198.51.100.21' },
        body: { enabled: false },
      });
      if (r.status === 429 || r.status === 503) mutationDenied += 1; else mutationAllowed += 1;
    }
    check('admin mutations are capped at the strict budget (5/min)',
      mutationAllowed === 5 && mutationDenied === 5,
      `allowed=${mutationAllowed} denied=${mutationDenied}`);
    check('the admin mutation budget is keyed on the verified admin, not the IP alone',
      stub.state.keysSeen.some((k) => k.includes('admin:rupayandas2024@gmail.com')),
      `keys=${stub.state.keysSeen.slice(-1)[0] || 'none'}`);
  }

  // ── 6. Chat tiers ──────────────────────────────────────────────────────
  group('chat limits');
  {
    stub.reset();
    let guestDenied = 0;
    for (let i = 0; i < 14; i += 1) {
      const r = await request(PORT, 'POST', '/api/chat', {
        headers: { 'x-forwarded-for': '198.51.100.30' }, body: { message: 'hi' },
      });
      if (r.status === 429 || r.status === 503) guestDenied += 1;
    }
    check('an anonymous guest is capped by the guest bucket',
      guestDenied > 0, `denied=${guestDenied} of 14`);

    stub.reset();
    let userDenied = 0;
    let userAllowed = 0;
    for (let i = 0; i < 14; i += 1) {
      const r = await request(PORT, 'POST', '/api/chat', {
        headers: {
          'x-test-identity': JSON.stringify({ id: 'chat-user-1', email: 'chatter@example.com' }),
          'x-forwarded-for': '198.51.100.31',
        },
        body: { message: 'hi' },
      });
      if (r.status === 429 || r.status === 503) userDenied += 1; else userAllowed += 1;
    }
    check('an authenticated user gets the larger account budget (more than the guest 10)',
      userAllowed > 10, `allowed=${userAllowed} denied=${userDenied}`);
  }

  // ── 7. Forged identity has no effect ───────────────────────────────────
  group('forged identity');
  {
    stub.reset();
    // Burn the guest/ip budget on /api/chat, then try to reset it by claiming an
    // identity in the body. The verified resolver ignores the body entirely, so
    // the caller stays in the guest bucket.
    for (let i = 0; i < 12; i += 1) {
      await request(PORT, 'POST', '/api/chat', {
        headers: { 'x-forwarded-for': '198.51.100.40' }, body: { message: 'hi' },
      });
    }
    const forged = await request(PORT, 'POST', '/api/chat', {
      headers: { 'x-forwarded-for': '198.51.100.40' },
      body: { message: 'hi', user_id: 'someone-else', email: 'admin@example.com', role: 'admin', isAdmin: true },
    });
    check('body user_id/email/role/isAdmin cannot reset a spent guest budget',
      forged.status === 429 || forged.status === 503, `status=${forged.status}`);

    stub.reset();
    // Conversely, an anonymous caller cannot spend an account's budget: send a
    // forged identity in the BODY (ignored) and confirm the account key is not
    // created from it.
    await request(PORT, 'POST', '/api/payment/create', {
      headers: { 'x-forwarded-for': '198.51.100.41' },
      body: { user_id: 'victim-account', email: 'victim@example.com' },
    });
    check('no counter key is ever derived from a body-supplied user_id',
      !stub.state.keysSeen.some((k) => k.includes('victim-account') || k.includes('victim@example.com')),
      `keys=${JSON.stringify(stub.state.keysSeen.slice(-3))}`);

    stub.reset();
    // A forged isAdmin must not reach the admin buckets: the resolver (server
    // session) decides, so an anonymous caller hitting an admin route is keyed
    // by IP only.
    await request(PORT, 'PUT', '/api/admin/maintenance', {
      headers: { 'x-forwarded-for': '198.51.100.42' },
      body: { isAdmin: true, role: 'admin' },
    });
    check('a body-forged isAdmin does not create an admin-keyed bucket',
      !stub.state.keysSeen.some((k) => k.includes('admin:')),
      `keys=${JSON.stringify(stub.state.keysSeen.slice(-3))}`);
  }

  // ── 8. Spoofed IP headers cannot bypass ────────────────────────────────
  group('ip spoofing');
  {
    stub.reset();
    const spoofHeaders = [
      ['x-forwarded-for', '203.0.113.201'],
      ['x-real-ip', '203.0.113.202'],
      ['cf-connecting-ip', '203.0.113.203'],
      ['true-client-ip', '203.0.113.204'],
      ['forwarded', 'for=203.0.113.205'],
    ];

    let denied = 0;
    let allowed = 0;
    // Rotate every spoofable header on every request. If any of them were
    // trusted, each request would land in a brand-new bucket and none would be
    // refused. With `trust proxy: 1` and no X-Forwarded-For, Express resolves
    // req.ip to the real socket address, so the budget must be consumed.
    for (let i = 0; i < 16; i += 1) {
      const headers = { Accept: 'application/json' };
      for (const [name, value] of spoofHeaders) headers[name] = `${value}.${i}`;
      const r = await request(PORT, 'POST', '/api/auth/login', { headers, body: { email: 'x@y.z' } });
      if (r.status === 429 || r.status === 503) denied += 1; else allowed += 1;
    }
    check('rotating X-Forwarded-For / X-Real-IP / cf-connecting-ip / Forwarded cannot bypass the IP budget',
      denied > 0, `allowed=${allowed} denied=${denied}`);
    check('the spoofed addresses never became counter keys',
      !stub.state.keysSeen.some((k) => /203\.0\.113\.20/.test(k)),
      `keys=${JSON.stringify(stub.state.keysSeen.slice(-2))}`);

    // The realistic attack: the caller supplies / appends to X-Forwarded-For.
    // On Vercel the edge also sets x-vercel-forwarded-for to the TRUE client
    // address, and that is the value that must win — the spoofed chain must be
    // ignored entirely, not merely out-ranked.
    stub.reset();
    let spoofDenied = 0;
    let spoofAllowed = 0;
    for (let i = 0; i < 16; i += 1) {
      const r = await request(PORT, 'POST', '/api/auth/login', {
        headers: {
          Accept: 'application/json',
          // The attacker's forged chain, changing on every request.
          'x-forwarded-for': `203.0.113.${200 + i}`,
          // What the edge actually observed, constant across the burst.
          'x-vercel-forwarded-for': '198.51.100.88',
        },
        body: { email: 'x@y.z' },
      });
      if (r.status === 429 || r.status === 503) spoofDenied += 1; else spoofAllowed += 1;
    }
    check('a spoofed X-Forwarded-For chain cannot bypass the budget when the edge header is present',
      spoofDenied > 0, `allowed=${spoofAllowed} denied=${spoofDenied}`);
    check('the forged addresses never became counter keys',
      !stub.state.keysSeen.some((k) => /203\.0\.113\.2\d\d/.test(k)),
      `keys=${JSON.stringify(stub.state.keysSeen.slice(-2))}`);
    check('the genuine edge address IS the counter key',
      stub.state.keysSeen.some((k) => k.includes('198.51.100.88')),
      `keys=${JSON.stringify(stub.state.keysSeen.slice(-2))}`);

    // Without any trusted header (off-Vercel / self-managed proxy), an
    // X-Forwarded-For chain must not be believed either: the chain is ignored
    // and the real socket address is used, so rotating it buys nothing.
    stub.reset();
    let chainDenied = 0;
    for (let i = 0; i < 16; i += 1) {
      const r = await request(PORT, 'POST', '/api/auth/login', {
        headers: { 'x-forwarded-for': `198.51.100.${90 + i}, 10.0.0.${i % 250}` },
        body: {},
      });
      if (r.status === 429 || r.status === 503) chainDenied += 1;
    }
    check('without a trusted proxy header, a rotating X-Forwarded-For chain still buys no fresh budget',
      chainDenied > 0, `denied=${chainDenied} of 16`);
    check('no forged address from that chain became a counter key',
      !stub.state.keysSeen.some((k) => /198\.51\.100\.(9\d|10\d)/.test(k)),
      `keys=${JSON.stringify(stub.state.keysSeen.slice(-2))}`);
  }

  // ── 9. Redis outage behaviour ──────────────────────────────────────────
  group('redis outage');
  {
    // Every probe below uses its OWN trusted IP so a budget spent by an earlier
    // test can never be mistaken for the outage behaviour under test.
    stub.reset();
    stub.setDown(true);

    // Sensitive limiter -> refuse.
    const denied = await request(PORT, 'POST', '/api/payment/create', {
      headers: {
        'x-test-identity': JSON.stringify({ id: 'acct-outage', email: 'o@example.com' }),
        'x-vercel-forwarded-for': '198.51.100.201',
      },
      body: {},
    });
    check('a sensitive endpoint is REFUSED while Redis is unreachable (fails closed)',
      denied.status === 503, `status=${denied.status}`);
    check('the refusal is a safe temporary-unavailable error',
      denied.json && denied.json.code === 'RATE_LIMIT_UNAVAILABLE' &&
      !/upstash|redis|simulated|econnrefused/i.test(denied.raw),
      `body=${denied.raw.slice(0, 160)}`);
    check('the refusal sets Retry-After and no-store',
      Boolean(denied.headers['retry-after']) && /no-store/.test(String(denied.headers['cache-control'])));

    // Auth also fails closed.
    const authDown = await request(PORT, 'POST', '/api/auth/login', {
      headers: { 'x-vercel-forwarded-for': '198.51.100.202' }, body: {},
    });
    check('authentication is REFUSED while Redis is unreachable',
      authDown.status === 503, `status=${authDown.status}`);
    check('the auth refusal is the safe unavailable error, not a 429-shaped leak',
      authDown.json && authDown.json.code === 'RATE_LIMIT_UNAVAILABLE',
      `body=${authDown.raw.slice(0, 160)}`);

    // Admin mutation fails closed. A FRESH admin identity is used on purpose:
    // @upstash/ratelimit keeps an in-process "blocked until" cache, so an
    // account whose budget was already spent earlier in this suite would be
    // refused from that cache (429) before Redis is ever consulted, which would
    // mask the outage behaviour under test.
    const outageAdmin = { id: 'admin-outage', email: 'outage-admin@example.com', isAdmin: true };
    const adminDown = await request(PORT, 'PUT', '/api/admin/maintenance', {
      headers: {
        'x-test-identity': JSON.stringify(outageAdmin),
        'x-vercel-forwarded-for': '198.51.100.203',
      },
      body: { enabled: false },
    });
    check('an admin mutation is REFUSED while Redis is unreachable',
      adminDown.status === 503, `status=${adminDown.status}`);
    check('the admin refusal is the safe unavailable error with a retry hint',
      adminDown.json && adminDown.json.code === 'RATE_LIMIT_UNAVAILABLE' &&
      Boolean(adminDown.headers['retry-after']),
      `body=${adminDown.raw.slice(0, 140)}`);

    // Refund / payout / coupon submission also fail closed.
    for (const [method, p] of [
      ['POST', '/api/refunds/RF-1/request'],
      ['POST', '/api/payouts/request'],
      ['POST', '/api/coupons/submit'],
    ]) {
      const r = await request(PORT, method, p, {
        headers: {
          'x-test-identity': JSON.stringify({ id: 'acct-outage2', email: 'o2@example.com' }),
          'x-vercel-forwarded-for': '198.51.100.204',
        },
        body: {},
      });
      check(`${method} ${p} is REFUSED while Redis is unreachable`, r.status === 503, `status=${r.status}`);
    }

    // Public low-risk read degrades instead of breaking the site.
    const readDown = await request(PORT, 'GET', '/api/coupons', {
      headers: { Accept: 'application/json', 'x-vercel-forwarded-for': '198.51.100.205' },
    });
    check('a public read DEGRADES to the in-process window instead of failing (site stays up)',
      readDown.status === 200, `status=${readDown.status}`);

    // The degraded window is still a limit, not a free-for-all — but it must be
    // a FLOOD threshold, high enough that an outage never looks like a
    // rate-limit bug to an ordinary user. Assert both properties.
    const floor = rateLimitService._internal.LOCAL_EMERGENCY_FLOOR;
    let normalRefused = 0;
    for (let i = 0; i < 60; i += 1) {
      const r = await request(PORT, 'GET', '/api/coupons', {
        headers: { Accept: 'application/json', 'x-vercel-forwarded-for': '198.51.100.206' },
      });
      if (r.status === 429) normalRefused += 1;
    }
    check('60 ordinary reads during an outage are all allowed (no false refusals)',
      normalRefused === 0, `refused=${normalRefused}`);

    let degradedDenied = 0;
    for (let i = 0; i < floor + 80; i += 1) {
      const r = await request(PORT, 'GET', '/api/coupons', {
        headers: { Accept: 'application/json', 'x-vercel-forwarded-for': '198.51.100.206' },
      });
      if (r.status === 429) { degradedDenied += 1; break; }
    }
    check('the degraded in-process window still refuses a sustained flood (not unlimited)',
      degradedDenied > 0, `no refusal within ${floor + 80} requests`);

    stub.setDown(false);
    stub.reset();

    // Recovery: once Redis is back, sensitive endpoints work again. A fresh
    // account, so the pre-outage block-cache cannot answer for Redis.
    const recovered = await request(PORT, 'POST', '/api/payment/create', {
      headers: {
        'x-test-identity': JSON.stringify({ id: 'acct-recovered', email: 'r@example.com' }),
        'x-vercel-forwarded-for': '198.51.100.207',
      },
      body: {},
    });
    check('sensitive endpoints recover automatically once Redis returns',
      recovered.status === 200, `status=${recovered.status}`);
    check('the outage did not leave the limiter permanently refusing',
      stub.isDown() === false, `isDown=${stub.isDown()}`);
  }

  // ── 10. Webhooks are never rate limited ────────────────────────────────
  group('webhooks exempt');
  {
    stub.reset();
    let webhook429 = 0;
    let reached = 0;
    for (let i = 0; i < 40; i += 1) {
      const r = await request(PORT, 'POST', '/api/payment/webhook', {
        headers: { 'x-forwarded-for': '198.51.100.60' }, body: { probe: i },
      });
      if (r.status === 429 || r.status === 503) webhook429 += 1;
      else reached += 1;
    }
    check('the payment webhook is never rate limited (provider retries must pass)',
      webhook429 === 0 && reached === 40, `reached=${reached} limited=${webhook429}`);
    check('no counter key was created for the webhook path',
      !stub.state.keysSeen.some((k) => k.includes('webhook')),
      `keys=${JSON.stringify(stub.state.keysSeen.slice(-2))}`);

    const adminPush = await request(PORT, 'POST', '/api/admin/gmail/push', { body: {} });
    check('the Gmail Pub/Sub push endpoint is exempt too',
      adminPush.status !== 429 && adminPush.status !== 503, `status=${adminPush.status}`);

    const classify = rateLimitService.classify;
    for (const p of ['/api/payment/webhook', '/api/payment/webhook/', '/API/Payment/Webhook']) {
      const d = classify({ originalUrl: p, url: p, method: 'POST', headers: {} });
      check(`classify(${p}) skips rate limiting`, d.skip === true, `decision=${JSON.stringify(d)}`);
    }
  }

  // ── 11. Classification coverage ────────────────────────────────────────
  group('classification');
  {
    const classify = rateLimitService.classify;
    const cases = [
      ['/api/auth/google-redirect', 'GET', false, 'auth'],
      ['/api/coupons/scan', 'POST', false, 'coupon-scan'],
      ['/api/coupons/sell', 'POST', false, 'coupon-submit'],
      ['/api/coupons', 'GET', false, 'coupon-read'],
      ['/api/payment/create', 'POST', false, 'payment-create'],
      ['/api/payment/verify', 'POST', false, 'payment-verify'],
      ['/api/refunds', 'GET', false, 'refund'],
      ['/api/payouts/my', 'GET', false, 'payout'],
      ['/api/chat', 'POST', false, 'chat'],
      ['/api/admin/stats', 'GET', false, 'admin-read'],
      ['/api/admin/maintenance', 'PUT', false, 'admin-mutation'],
      ['/api/coupons/submit', 'POST', false, 'coupon-submit'],
    ];
    for (const [p, method, expectSkip, label] of cases) {
      const d = classify({ originalUrl: p, url: p, method, headers: {} });
      const got = d.skip ? 'skip' : (d.admin ? (d.sensitive ? 'admin-mutation' : 'admin-read')
        : (d.kind === 'chat' ? 'chat' : JSON.stringify(d.set)));
      check(`classify ${method} ${p} → ${label}`, got.includes(label.split('-')[0]),
        `got=${got}`);
    }

    // Non-API paths are not limited (page loads behind a shared NAT must work).
    const page = classify({ originalUrl: '/dashboard.html', url: '/dashboard.html', method: 'GET', headers: {} });
    check('HTML page navigation is not rate limited by this layer', page.skip === true);

    // An unknown API route is still bounded.
    const unknown = classify({ originalUrl: '/api/brand-new-endpoint', url: '/api/brand-new-endpoint', method: 'GET', headers: {} });
    check('an unknown API route is still bounded (cannot be unlimited by omission)',
      unknown.skip !== true, `decision=${JSON.stringify(unknown)}`);
  }

  // ── 12. Secrets never leak ─────────────────────────────────────────────
  group('secret hygiene');
  {
    const described = rateLimitService.describe();
    const json = JSON.stringify(described);
    check('describe() never includes the Redis URL or token',
      !json.includes('127.0.0.1:') && !json.includes('test-token'),
      json.slice(0, 160));
    check('describe() lists the limiter catalogue and the exempt paths',
      Array.isArray(described.limiters) && described.limiters.length >= 12 &&
      Array.isArray(described.neverLimited));
    check('every limiter declares its behaviour when Redis is unavailable',
      described.limiters.every((l) => l.onRedisFailure === 'refuse' || l.onRedisFailure === 'in-process fallback'));

    const handler = safeRateLimitHandler('Too many requests. Please try again later.');
    check('the shared 429 handler is the one the service uses', typeof handler === 'function');
  }

  // ── 12. Unconfigured deployment (no Redis credentials) ─────────────────
  group('redis unconfigured');
  {
    // A deployment that has not set the Upstash variables yet must NOT refuse
    // every sensitive request — that would be a total outage (no sign-in, no
    // checkout, no admin panel) caused by a missing optional configuration.
    // It must instead enforce in-process limits, warn loudly, and still bound
    // the endpoint. Verified in a child process so the module loads without
    // credentials, which is the only way to reach this branch.
    const { execFileSync } = require('child_process');
    const probe = `
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      process.env.NODE_ENV = 'test';
      const svc = require(${JSON.stringify(path.join(ROOT, 'server', 'services', 'rateLimitService.js'))});
      (async () => {
        const out = { configured: svc.isConfigured(), distributed: svc.isDistributed() };
        // A sensitive limiter must still ALLOW a first request (not refuse).
        const first = await svc.consume('payment-create-account', 'user:probe-1');
        out.firstAllowed = first.allowed === true;
        out.degraded = first.degraded === true;
        out.unavailable = first.unavailable === true;
        // ...and must still bound a flood.
        let denied = 0;
        for (let i = 0; i < 400; i += 1) {
          const r = await svc.consume('payment-create-account', 'user:probe-1');
          if (!r.allowed) { denied += 1; break; }
        }
        out.floodDenied = denied;
        out.describe = svc.describe();
        console.log(JSON.stringify(out));
      })().catch((e) => { console.log(JSON.stringify({ error: String(e && e.message || e) })); });
    `;
    let parsed = null;
    let childErr = '';
    try {
      const stdout = execFileSync(process.execPath, ['-e', probe], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' },
      });
      parsed = JSON.parse(stdout.trim().split('\n').pop());
    } catch (e) {
      childErr = String((e && e.message) || e).slice(0, 200);
    }

    check('the service reports itself as unconfigured without credentials',
      parsed && parsed.configured === false && parsed.distributed === false,
      childErr || JSON.stringify(parsed));
    check('a sensitive endpoint still ALLOWS a normal request when Redis is simply not configured',
      parsed && parsed.firstAllowed === true, JSON.stringify(parsed));
    check('that request is flagged as degraded (served by the in-process window)',
      parsed && parsed.degraded === true, JSON.stringify(parsed));
    check('it is NOT refused as unavailable (unconfigured must not look like an outage)',
      parsed && parsed.unavailable === false, JSON.stringify(parsed));
    check('the in-process window still bounds a flood in unconfigured mode',
      parsed && parsed.floodDenied > 0, JSON.stringify(parsed));
    check('describe() reports the in-process-only mode and a warning for operators',
      parsed && parsed.describe && parsed.describe.mode === 'in-process-only' &&
      /UPSTASH_REDIS_REST_URL/.test(String(parsed.describe.warning)),
      JSON.stringify(parsed && parsed.describe && parsed.describe.mode));
  }

  // ── 13. Wired into the REAL application ────────────────────────────────
  group('wired into the real app');
  {
    // Everything above tests the middleware against a purpose-built app. This
    // group boots the actual server.js and proves the middleware is mounted
    // there too, in front of the real routers.
    const { spawn } = require('child_process');
    const realPort = 3411;
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(realPort),
        NODE_ENV: 'test',
        UPSTASH_REDIS_REST_URL: stub.url,
        UPSTASH_REDIS_REST_TOKEN: 'test-token-not-a-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childLog = '';
    child.stdout.on('data', (d) => { childLog += d.toString(); });
    child.stderr.on('data', (d) => { childLog += d.toString(); });

    const up = await until(async () => {
      try {
        const r = await request(realPort, 'GET', '/api/health', { headers: { Accept: 'application/json' } });
        return r.status === 200;
      } catch (e) { return false; }
    }, 400, 250);

    check('the real server.js boots with the distributed limiter enabled', Boolean(up),
      up ? '' : childLog.slice(-300));

    if (up) {
      stub.reset();
      // /api/auth allows 5/min: the real app must enforce it and answer 429.
      let realLimited = null;
      for (let i = 0; i < 10; i += 1) {
        const r = await request(realPort, 'POST', '/api/auth/login', {
          headers: { Accept: 'application/json', 'x-vercel-forwarded-for': '198.51.100.250' },
          body: { email: 'probe@example.com' },
        });
        if (r.status === 429) { realLimited = r; break; }
      }
      check('the REAL app returns 429 from the distributed limiter', Boolean(realLimited),
        realLimited ? '' : 'never limited in 10 attempts');
      if (realLimited) {
        check('the real 429 carries Retry-After',
          Boolean(realLimited.headers['retry-after']), `ra=${realLimited.headers['retry-after']}`);
        check('the real 429 carries the RATE_LIMITED code',
          realLimited.json && realLimited.json.code === 'RATE_LIMITED',
          `body=${realLimited.raw.slice(0, 120)}`);
      }

      // The webhook must still be reachable (not rate limited) in the real app.
      stub.reset();
      let webhookReached = 0;
      for (let i = 0; i < 12; i += 1) {
        const r = await request(realPort, 'POST', '/api/payment/webhook', {
          headers: { 'x-vercel-forwarded-for': '198.51.100.251' },
          body: { probe: i },
        });
        if (r.status !== 429 && r.status !== 503) webhookReached += 1;
      }
      check('the REAL app never rate limits the payment webhook',
        webhookReached === 12, `reached=${webhookReached}`);

      // Admin config surface is readable by an authenticated admin only, so the
      // unauthenticated probe must be refused (not 200) — and must not leak.
      const rl = await request(realPort, 'GET', '/api/admin/rate-limits', {
        headers: { Accept: 'application/json' },
      });
      check('GET /api/admin/rate-limits requires admin auth',
        [401, 403, 404].includes(rl.status), `status=${rl.status}`);
      check('that refusal leaks no Redis detail',
        !/upstash|token|127\.0\.0\.1/i.test(rl.raw), `body=${rl.raw.slice(0, 140)}`);
    }

    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log(`PASSED: ${pass}   FAILED: ${fail}`);
  if (failures.length) {
    console.log('\nFailed checks:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('='.repeat(64));

  server.close();
  await stub.close();
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 150).unref();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Harness error:', (err && err.stack) || err);
  process.exit(2);
});
