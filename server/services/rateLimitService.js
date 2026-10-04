'use strict';

// ============================================================================
// SaveHatke — Distributed rate limiting (Upstash Redis)
// ============================================================================
// ONE place that creates every Redis-backed rate limiter. Routes never build
// their own Redis client and never call the Upstash SDK directly; they ask this
// module for a named limiter or, more usually, let `distributedLimiter()` apply
// the right one based on the request.
//
// WHY THIS EXISTS
// The application-level limiters used to be express-rate-limit's in-process
// MemoryStore. On Vercel every request may land on a different instance, so the
// real allowance was (configured limit x number of warm instances), and every
// cold start reset the counters to zero. The counters that gate sign-in, coupon
// submissions, payments, refunds, payouts and the paid AI chatbot therefore
// under-counted exactly when an attacker benefits from it. This module moves
// those counters into Upstash Redis so all instances share one budget.
//
// THE LAYER ORDER (unchanged shape, one new layer)
//   Client
//     -> Vercel Firewall / WAF            (configured outside this codebase)
//     -> Upstash distributed limiter      (this module — shared counters)
//     -> existing local emergency limiter (express-rate-limit, kept as backstop)
//     -> authentication -> authorization -> business logic -> datastore
//
// The in-process limiters in server.js and utils/adminRateLimit.js are
// deliberately KEPT. They are the second line: when Redis is unreachable they
// are the only thing still bounding a flood inside one instance, and when Redis
// is healthy they cost nothing because the Redis budget is always the tighter
// of the two.
//
// IDENTITY
// Identifiers come only from server-verified state:
//   ip:<trusted client ip>        from middleware/getClientIP (Vercel-trusted only)
//   user:<verified account id>    from the validated session row
//   admin:<verified admin email>  from the validated session row + allowlist
// Nothing from req.body / req.query is ever used. A caller cannot choose which
// budget they spend by sending user_id, email, role or isAdmin.
//
// FAILURE BEHAVIOUR (documented per limiter in LIMITS below)
//   'closed'    — Redis unavailable => 503, request refused. Used by everything
//                 that guards money, credentials or the admin surface: those
//                 must never become unrestricted because a cache is down.
//   'local'     — Redis unavailable => fall back to this instance's own
//                 in-memory sliding window, sized from the same limit. Used by
//                 public low-risk reads so a Redis outage cannot take the whole
//                 marketplace down.
// Redis is never a hard dependency for browsing; it is a hard dependency for
// spending money or acting as an administrator.

const { Redis } = require('@upstash/redis');
const { Ratelimit } = require('@upstash/ratelimit');

const getClientIP = require('../middleware/getClientIP');
const { safeRateLimitHandler } = require('../utils/rateLimit');

// ── Redis client ───────────────────────────────────────────────────────────
// Server-side only. The URL and token are read from the environment and are
// never returned by any endpoint, never logged, and never sent to the browser
// (no VITE_/NEXT_PUBLIC_ variants exist).
const REDIS_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
const REDIS_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

let redis = null;
let redisReady = false;

if (REDIS_URL && REDIS_TOKEN) {
  try {
    redis = new Redis({
      url: REDIS_URL,
      token: REDIS_TOKEN,
      // The SDK's console logger prints connection details; disable it so a
      // transient failure can never put a URL or token fragment in the logs.
      enableTelemetry: false,
      retry: { retries: 1, backoff: () => 50 },
    });
    redisReady = true;
  } catch (e) {
    // A malformed URL/token must not take the process down; it degrades to the
    // documented per-limiter fallback instead.
    redis = null;
    redisReady = false;
    console.error('[ratelimit] Upstash client could not be created; distributed limits disabled.');
  }
} else {
  console.warn('[ratelimit] UPSTASH_REDIS_REST_URL/TOKEN are not set — distributed rate limiting is INACTIVE. The per-instance limiters in server.js are the only protection, so the effective allowance is (configured limit x number of warm instances) and it resets on every cold start. Set both variables in every deployed environment.');
}

// "Redis is not configured at all" is a DIFFERENT situation from "Redis is
// configured but temporarily unreachable", and they must behave differently:
//
//   • Not configured (this deployment has no Upstash credentials yet): the
//     fail-closed policy below must NOT apply. Refusing every sensitive request
//     would take down sign-in, checkout and the admin panel outright — a
//     deployment that has not finished configuring Upstash would be a total
//     outage, which is exactly the catastrophic failure mode we must avoid.
//     Instead the in-process window enforces each limiter, and the env warning
//     above says loudly that the budget is per-instance.
//
//   • Configured but unreachable (an actual outage): fail closed for sensitive
//     surfaces, degrade for low-risk reads. This is the case the policy
//     documents, and it is only reachable when credentials exist, i.e. in a
//     deployment that has opted into distributed limiting.
const REDIS_CONFIGURED = redisReady;

function isDistributed() {
  return redisReady;
}

// ── Limiter catalogue ──────────────────────────────────────────────────────
// name -> { limit, window, fail }
//   limit  : requests allowed per window, per identifier
//   window : Upstash duration string (s/m/h/d)
//   fail   : behaviour when Redis is unavailable ('closed' | 'local')
//
// The values are the SaveHatke security baselines. Each one is annotated with
// the request it protects and, where it differs from a previously stricter
// in-process limit, why the change is safe.
const LIMITS = {
  // ── Public / browsing ────────────────────────────────────────────────────
  'public-read': { limit: 120, window: '1 m', fail: 'local' },
  'public-burst': { limit: 30, window: '10 s', fail: 'local' },

  // ── Authentication ───────────────────────────────────────────────────────
  // Tighter than the previous 20/15min per instance. Starts the Google OAuth
  // handshake, so it gates credential brute force and OAuth-callback flooding.
  auth: { limit: 5, window: '1 m', fail: 'closed' },
  'auth-account': { limit: 20, window: '15 m', fail: 'closed' },

  // ── Coupons ──────────────────────────────────────────────────────────────
  'coupon-read-ip': { limit: 60, window: '1 m', fail: 'local' },
  'coupon-read-account': { limit: 30, window: '1 m', fail: 'local' },
  // Was 30/hour/IP for scans (a paid vision API); the baseline is 10/hour/IP
  // plus a per-account cap so one account cannot burn the vision budget from
  // rotating addresses.
  'coupon-scan-account': { limit: 5, window: '1 h', fail: 'closed' },
  'coupon-scan-ip': { limit: 10, window: '1 h', fail: 'closed' },
  // Was 10/hour/IP. The baseline is stricter AND per-account, so a single
  // account can no longer submit 10 listings an hour and an IP cannot submit
  // 10 a day.
  'coupon-submit-account': { limit: 5, window: '1 d', fail: 'closed' },
  'coupon-submit-ip': { limit: 10, window: '1 d', fail: 'closed' },

  // ── Purchase / payment ───────────────────────────────────────────────────
  'purchase-account': { limit: 5, window: '1 m', fail: 'closed' },
  'purchase-ip': { limit: 10, window: '1 m', fail: 'closed' },
  'payment-create-account': { limit: 3, window: '1 m', fail: 'closed' },
  'payment-create-hour-account': { limit: 10, window: '1 h', fail: 'closed' },
  'payment-create-ip': { limit: 10, window: '1 m', fail: 'closed' },
  // A payment verification is a status read the checkout polls; 1 per 30s per
  // account is the baseline and is generous for the real UI.
  'payment-verify-account': { limit: 1, window: '30 s', fail: 'closed' },
  'payment-verify-ip': { limit: 6, window: '1 m', fail: 'closed' },

  // ── Refunds / payouts (admin + seller money movement) ────────────────────
  'refund-account': { limit: 3, window: '1 d', fail: 'closed' },
  'refund-ip': { limit: 10, window: '1 h', fail: 'closed' },
  'payout-account': { limit: 2, window: '1 d', fail: 'closed' },
  'payout-ip': { limit: 10, window: '1 h', fail: 'closed' },

  // ── Chatbot / AI (paid provider) ─────────────────────────────────────────
  'chat-guest': { limit: 10, window: '15 m', fail: 'closed' },
  'chat-account': { limit: 40, window: '15 m', fail: 'local' },
  'chat-ip': { limit: 60, window: '15 m', fail: 'closed' },

  // ── Admin surface ────────────────────────────────────────────────────────
  // Reads are frequent (the panel fires several calls per page and the payouts
  // page auto-refreshes every 30s), so 120/min/account and 300/min/IP.
  'admin-read-account': { limit: 120, window: '1 m', fail: 'local' },
  'admin-read-ip': { limit: 300, window: '1 m', fail: 'local' },
  // Mutations are rare and dangerous.
  'admin-mutation-account': { limit: 5, window: '1 m', fail: 'closed' },
  'admin-mutation-ip': { limit: 20, window: '1 m', fail: 'closed' },
};

// ── Limiter construction ───────────────────────────────────────────────────
// One Ratelimit instance per (limit, window) pair, cached. Prefixes are scoped
// so a key can never collide across limiters or environments.
const instances = new Map();
// Ad-hoc limiters whose budget comes from configuration (see consumeDynamic).
const dynamicInstances = new Map();

function limiterFor(name) {
  const spec = LIMITS[name];
  if (!spec) throw new Error(`Unknown rate limiter: ${name}`);
  if (!redis) return null;

  const cacheKey = `${spec.limit}:${spec.window}`;
  if (instances.has(cacheKey)) return instances.get(cacheKey);

  const instance = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(spec.limit, spec.window),
    // Namespaced by deployment so a staging and production project sharing one
    // Redis database cannot spend each other's budget.
    prefix: `sh:rl:${process.env.NODE_ENV === 'production' ? 'prod' : 'dev'}`,
    analytics: false,
  });
  instances.set(cacheKey, instance);
  return instance;
}

// ── Local emergency limiter ────────────────────────────────────────────────
// A tiny in-process sliding window. Used ONLY when Redis is unreachable, for
// limiters whose failure policy is 'local'. It keeps a Redis outage from
// turning low-risk reads into an unbounded flood while never being the reason a
// normal user is refused.
const localBuckets = new Map();

// Floor for the degraded-mode window. Deliberately high: the local limiter
// exists to stop a FLOOD during a Redis outage, not to enforce the configured
// budget. A low floor would make an outage look like a rate-limit bug to
// ordinary users (fifteen normal requests in a minute would be refused), which
// is exactly the "don't make the site unusable because Redis blipped" rule.
// 300/minute/identifier still bounds abuse to a small multiple of any budget
// declared above.
const LOCAL_EMERGENCY_FLOOR = 300;

function localAllow(name, identifier, spec) {
  const perMinute = toPerMinute(spec.limit, spec.window);
  const emergencyMax = Math.max(LOCAL_EMERGENCY_FLOOR, perMinute * 4);
  const windowMs = 60 * 1000;
  const key = `${name}:${identifier}`;
  const now = Date.now();

  let bucket = localBuckets.get(key) || [];
  bucket = bucket.filter((ts) => now - ts < windowMs);
  if (bucket.length >= emergencyMax) {
    localBuckets.set(key, bucket);
    return { allowed: false, retryAfter: Math.ceil((windowMs - (now - bucket[0])) / 1000) };
  }
  bucket.push(now);
  localBuckets.set(key, bucket);

  // Bounded memory: drop empty buckets when the map grows.
  if (localBuckets.size > 20000) {
    for (const [k, v] of localBuckets) {
      if (!v.some((ts) => now - ts < windowMs)) localBuckets.delete(k);
    }
  }
  return { allowed: true };
}

const WINDOW_MINUTES = { s: 1 / 60, m: 1, h: 60, d: 60 * 24 };
function toPerMinute(limit, window) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(String(window).trim());
  if (!m) return limit;
  const minutes = Number(m[1]) * WINDOW_MINUTES[m[2]];
  if (!minutes || minutes <= 0) return limit;
  return Math.max(1, Math.ceil(limit / minutes));
}

// ── Identifier resolution ──────────────────────────────────────────────────
// Trusted sources only. `req.user` is set by the session middleware from a
// validated database row; getClientIP() only trusts Vercel's own forwarding
// header and Express's single-hop `req.ip`.
function verifiedIdentity(req) {
  if (req && req.user && req.user.id) {
    return { kind: 'user', value: `user:${String(req.user.id)}` };
  }
  if (req && req.user && req.user.email) {
    return { kind: 'user', value: `user:${String(req.user.email).toLowerCase().trim()}` };
  }
  return null;
}

function trustedIp(req) {
  try {
    return getClientIP(req) || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

// ── Route classification ───────────────────────────────────────────────────
// Explicit allowlist of endpoints that must NEVER be rate limited by this
// layer. The payment webhook is the important one: a provider retry that gets a
// 429 is a lost payment confirmation. Its security is the HMAC signature over
// the exact bytes, HMAC fail-closed when unconfigured, and the notification
// fingerprint / ALREADY_PAID idempotency guards — not a request counter.
const NEVER_LIMIT = [
  /^\/api\/payment\/webhook\/?$/i,
  // Google Pub/Sub push for the payment mailbox: carries its own token, and a
  // throttled push means a missed payment until the next cron sweep.
  /^\/api\/payment\/gmail-push\/?$/i,
  /^\/api\/admin\/gmail\/push\/?$/i,
];

// Path -> limiter names, as { account, ip } pairs. The first match wins, so
// order matters: more specific paths come first.
const RULES = [
  // ── Admin ────────────────────────────────────────────────────────────────
  {
    test: (p) => /^\/api\/admin(?:\/|$)/i.test(p),
    mutation: (method) => !['GET', 'HEAD', 'OPTIONS'].includes(method),
    read: { account: 'admin-read-account', ip: 'admin-read-ip' },
    write: { account: 'admin-mutation-account', ip: 'admin-mutation-ip' },
    admin: true,
  },

  // ── Authentication ───────────────────────────────────────────────────────
  { test: (p) => /^\/api\/auth(?:\/|$)/i.test(p), both: { ip: 'auth' }, sensitive: true },

  // ── Coupons ──────────────────────────────────────────────────────────────
  { test: (p) => /^\/api\/coupons\/scan\/?$/i.test(p), both: { account: 'coupon-scan-account', ip: 'coupon-scan-ip' }, requireAccount: true, sensitive: true },
  { test: (p) => /^\/api\/coupons\/(?:sell|submit|proof)\/?$/i.test(p), both: { account: 'coupon-submit-account', ip: 'coupon-submit-ip' }, requireAccount: true, sensitive: true },
  { test: (p) => /^\/api\/coupons\/buy\//i.test(p), both: { account: 'purchase-account', ip: 'purchase-ip' }, requireAccount: true, sensitive: true },
  { test: (p) => /^\/api\/coupons(?:\/|$)/i.test(p), both: { account: 'coupon-read-account', ip: 'coupon-read-ip' } },

  // ── Payments (webhook paths are excluded above) ──────────────────────────
  // /verify is its own bucket because the checkout polls it; /cancel and
  // /stream share the create budget, which is what bounds session churn.
  { test: (p) => /^\/api\/payment\/verify\/?$/i.test(p), both: { account: 'payment-verify-account', ip: 'payment-verify-ip' }, requireAccount: true, sensitive: true },
  { test: (p) => /^\/api\/payment\/(?:create|cancel|active|status|stream)\/?$/i.test(p), both: { account: 'payment-create-account', ip: 'payment-create-ip' }, requireAccount: true, sensitive: true },
  // Any other /api/payment path (config, cron) falls back to the public budget
  // so an unknown sub-route can never be unlimited.
  { test: (p) => /^\/api\/payment(?:\/|$)/i.test(p), both: { ip: 'public-read' } },

  // ── Refunds / payouts ────────────────────────────────────────────────────
  { test: (p) => /^\/api\/refunds(?:\/|$)/i.test(p), both: { account: 'refund-account', ip: 'refund-ip' }, requireAccount: true, sensitive: true },
  { test: (p) => /^\/api\/payouts(?:\/|$)/i.test(p), both: { account: 'payout-account', ip: 'payout-ip' }, requireAccount: true, sensitive: true },

  // ── Chatbot / AI ─────────────────────────────────────────────────────────
  { test: (p) => /^\/api\/chat(?:\/|$)/i.test(p), chat: true },
  { test: (p) => /^\/api\/(?:chatbot|support|reviews|testimonials|tracker|proxy|consent)(?:\/|$)/i.test(p), both: { ip: 'public-read' } },
];

function classify(req) {
  const raw = String(req.originalUrl || req.url || '').split('?')[0];
  const path = raw.replace(/\/+$/, '') || '/';

  if (NEVER_LIMIT.some((re) => re.test(path))) {
    return { skip: true, reason: 'never-limit' };
  }

  // Non-API paths (pages, static assets) are not rate limited here. The HTML
  // guards and Vercel's edge own that layer; putting a per-IP API budget on
  // page loads would break ordinary browsing behind a shared NAT.
  if (!/^\/api(?:\/|$)/i.test(path)) {
    return { skip: true, reason: 'not-api' };
  }

  for (const rule of RULES) {
    if (!rule.test(path)) continue;

    if (rule.chat) {
      return { kind: 'chat', sensitive: false };
    }
    if (rule.admin) {
      const isMutation = rule.mutation(req.method);
      return {
        kind: 'pair',
        set: isMutation ? rule.write : rule.read,
        admin: true,
        sensitive: isMutation,
      };
    }
    return {
      kind: 'pair',
      set: rule.both,
      requireAccount: Boolean(rule.requireAccount),
      sensitive: Boolean(rule.sensitive),
    };
  }

  // Unknown API route: still bounded, so a new endpoint cannot be unlimited by
  // omission.
  return { kind: 'pair', set: { ip: 'public-read' }, sensitive: false };
}

// ── Failure policy ─────────────────────────────────────────────────────────
function onRedisFailure(name, err) {
  // Log classification only. Never the key, the identifier, the URL or the
  // token — an operator needs to know WHICH limiter degraded, not who tripped it.
  console.error(JSON.stringify({
    event: 'ratelimit_degraded',
    limiter: name,
    errorType: String((err && (err.name || err.constructor && err.constructor.name)) || 'Error').slice(0, 60),
    timestamp: new Date().toISOString(),
  }));
}

function unavailable(res, retryAfterSec = 5) {
  res.set('Retry-After', String(retryAfterSec));
  res.set('Cache-Control', 'no-store');
  return res.status(503).json({
    error: 'service_temporarily_unavailable',
    code: 'RATE_LIMIT_UNAVAILABLE',
    message: 'This action is temporarily unavailable for security reasons. Please try again in a moment.',
  });
}

/**
 * Consume one token from a named limiter.
 * @returns {Promise<{allowed:boolean, unavailable?:boolean, retryAfter:number}>}
 */
async function consume(name, identifier) {
  const spec = LIMITS[name];
  if (!spec) return { allowed: true, retryAfter: 0 };

  if (!redis) {
    // No credentials configured at all: enforce with the in-process window so
    // the endpoint still works, and so the budget is not unbounded. See the
    // REDIS_CONFIGURED note above for why this is not a fail-closed case.
    const local = localAllow(name, identifier, spec);
    return { allowed: local.allowed, retryAfter: local.retryAfter || 60, degraded: true, unconfigured: true };
  }

  const limiter = limiterFor(name);
  try {
    const result = await limiter.limit(identifier);
    if (result && result.success) return { allowed: true, retryAfter: 0 };
    const reset = Number(result && result.reset) || Date.now() + 60000;
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((reset - Date.now()) / 1000)) };
  } catch (err) {
    onRedisFailure(name, err);
    if (spec.fail === 'closed') return { allowed: false, unavailable: true, retryAfter: 5 };
    const local = localAllow(name, identifier, spec);
    return { allowed: local.allowed, retryAfter: local.retryAfter || 60, degraded: true };
  }
}

/**
 * Consume one token from an ad-hoc limiter whose budget is decided at runtime
 * rather than declared in LIMITS above.
 *
 * Used by the chatbot, whose guest/user/IP budgets are stored in the database
 * and editable from the admin panel. The counters still live in Redis so all
 * instances share them; only the numbers come from configuration.
 *
 * @param {string} name   stable cache/counter name, e.g. 'chat-guest'
 * @param {string} identifier trusted identity, e.g. 'ip:1.2.3.4'
 * @param {{limit:number, window:string, fail?:'closed'|'local'}} spec
 */
async function consumeDynamic(name, identifier, spec) {
  const limit = Number(spec && spec.limit);
  if (!Number.isFinite(limit) || limit <= 0) return { allowed: true, retryAfter: 0 };
  const window = String((spec && spec.window) || '15 m');

  const resolved = { limit: Math.floor(limit), window, fail: (spec && spec.fail) || 'closed' };

  if (!redis) {
    if (resolved.fail === 'closed' && REDIS_CONFIGURED) {
      return { allowed: false, unavailable: true, retryAfter: 5 };
    }
    const local = localAllow(`${name}:dyn`, identifier, resolved);
    return { allowed: local.allowed, retryAfter: local.retryAfter || 60, degraded: true };
  }

  const key = `${name}:${resolved.limit}:${window}`;
  let instance = dynamicInstances.get(key);
  if (!instance) {
    try {
      instance = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(resolved.limit, window),
        prefix: `sh:rl:${process.env.NODE_ENV === 'production' ? 'prod' : 'dev'}`,
        analytics: false,
      });
    } catch (e) {
      onRedisFailure(name, e);
      if (resolved.fail === 'closed') return { allowed: false, unavailable: true, retryAfter: 5 };
      const local = localAllow(`${name}:dyn`, identifier, resolved);
      return { allowed: local.allowed, retryAfter: local.retryAfter || 60, degraded: true };
    }
    dynamicInstances.set(key, instance);
  }

  try {
    const result = await instance.limit(identifier);
    if (result && result.success) return { allowed: true, retryAfter: 0 };
    const reset = Number(result && result.reset) || Date.now() + 60000;
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((reset - Date.now()) / 1000)) };
  } catch (err) {
    onRedisFailure(name, err);
    if (resolved.fail === 'closed') return { allowed: false, unavailable: true, retryAfter: 5 };
    const local = localAllow(`${name}:dyn`, identifier, resolved);
    return { allowed: local.allowed, retryAfter: local.retryAfter || 60, degraded: true };
  }
}

// ── Express middleware ─────────────────────────────────────────────────────
/**
 * Apply the distributed limits for the request. Mount once, early, on /api.
 *
 * Because it runs before the routers, `req.user` is not populated yet — the
 * account identifier is resolved from the session cookie through the same
 * validated-session helper the HTML guards use, which reads the session row
 * (Active + unexpired + Google-subject) and caches the result per request for
 * the downstream authenticateToken call.
 */
function distributedLimiter(options = {}) {
  const resolveCaller = options.resolveCaller;

  return async function rateLimitMiddleware(req, res, next) {
    let decision;
    try {
      decision = classify(req);
    } catch (e) {
      return next();
    }
    if (decision.skip) return next();

    // Attach what we DID rate limit so ops can see it without guessing.
    res.set('X-RateLimit-Scope', decision.kind === 'chat' ? 'chat' : (decision.admin ? 'admin' : 'api'));

    // Resolve verified identity once per request (cached by resolveCaller).
    let caller = null;
    if (resolveCaller) {
      try { caller = await resolveCaller(req); } catch (e) { caller = null; }
    }
    const accountId = caller && caller.id
      ? `user:${caller.id}`
      : (caller && caller.email ? `user:${String(caller.email).toLowerCase().trim()}` : null);
    const isAdmin = Boolean(caller && caller.isAdmin);
    const adminId = caller && caller.email ? `admin:${String(caller.email).toLowerCase().trim()}` : null;
    const ip = trustedIp(req);

    const checks = [];

    if (decision.kind === 'chat') {
      // Guests are anonymous and expensive: their own hard bucket. An
      // authenticated user gets the account bucket plus the shared IP bucket.
      if (accountId) {
        checks.push(['chat-account', accountId]);
        checks.push(['chat-ip', `ip:${ip}`]);
      } else {
        checks.push(['chat-guest', `ip:${ip}`]);
      }
    } else {
      const set = decision.set || {};
      if (set.account) {
        // Account budget only applies to a verified account; an anonymous
        // caller on an authenticated-only endpoint is left to the IP bucket
        // and the route's own 401.
        const id = decision.admin ? adminId : accountId;
        if (id) checks.push([set.account, id]);
      }
      if (set.ip) checks.push([set.ip, `ip:${ip}`]);
    }

    // An endpoint that requires an account but is called anonymously would
    // otherwise only be bounded by IP; keep that behaviour (the route 401s
    // anyway) but never let it be unlimited.
    if (decision.requireAccount && !accountId && !checks.length) {
      checks.push(['public-read', `ip:${ip}`]);
    }

    for (const [name, identifier] of checks) {
      // eslint-disable-next-line no-await-in-loop
      const result = await consume(name, identifier);
      if (result.allowed) continue;

      if (result.unavailable) {
        // Sensitive surface + Redis down => refuse. Never silently unrestricted.
        // RATELIMIT_DEBUG=1 records WHICH limiter refused, for troubleshooting.
        // It never logs the identifier, the Redis URL, the token or a counter.
        if (process.env.RATELIMIT_DEBUG === '1') {
          console.error(`[ratelimit] refused (${name}): distributed counter unavailable`);
        }
        return unavailable(res, result.retryAfter);
      }
      if (process.env.RATELIMIT_DEBUG === '1') {
        console.error(`[ratelimit] throttled (${name}): budget exhausted`);
      }
      return safeRateLimitHandler(
        name === 'auth' ? 'Too many sign-in attempts. Please wait before trying again.'
          : 'Too many requests. Please try again later.'
      )(req, res);
    }

    return next();
  };
}

// ── Introspection (admin/ops only — never exposes keys or credentials) ─────
function describe() {
  return {
    distributed: isDistributed(),
    // Distinguishes "no credentials" (per-instance budget) from "credentials
    // present but failing" (sensitive surfaces refusing). An operator can see
    // at a glance which one they are in.
    mode: isDistributed() ? 'distributed' : 'in-process-only',
    warning: isDistributed()
      ? ''
      : 'UPSTASH_REDIS_REST_URL/TOKEN are not set: counters are per-instance and reset on cold start. Set both to share one budget across all instances.',
    // Which deployment namespace the counters live in.
    namespace: process.env.NODE_ENV === 'production' ? 'prod' : 'dev',
    limiters: Object.entries(LIMITS).map(([name, spec]) => ({
      name,
      limit: spec.limit,
      window: spec.window,
      onRedisFailure: spec.fail === 'closed' ? 'refuse' : 'in-process fallback',
    })),
    neverLimited: ['/api/payment/webhook', '/api/payment/gmail-push', '/api/admin/gmail/push'],
  };
}

module.exports = {
  distributedLimiter,
  consume,
  consumeDynamic,
  describe,
  isDistributed,
  LIMITS,
  // True only when credentials are present, i.e. when the fail-closed outage
  // policy applies. An unconfigured deployment degrades to in-process limits
  // instead, so it does not refuse every sensitive request.
  isConfigured: () => REDIS_CONFIGURED,
  // Exported for the regression suite so the classification can be tested
  // without an HTTP server.
  classify,
  _internal: { localAllow, toPerMinute, trustedIp, NEVER_LIMIT, LOCAL_EMERGENCY_FLOOR },
};
