/**
 * SaveHatke — Coupon Auto-Verification Server
 * =============================================
 * Standalone Express + Puppeteer server that tests coupon codes
 * against real e-commerce checkout pages using headless Chrome.
 *
 * Endpoint:  POST /api/verify-coupon
 * Port:      3000 (or process.env.VERIFY_PORT)
 *
 * Start:     node server/verify-server.js
 * =============================================
 */

const express    = require('express');
const puppeteer  = require('puppeteer');
const dns        = require('dns').promises;
const net        = require('net');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.VERIFY_PORT || 3000;

/* ── Middleware ── */
app.disable('x-powered-by');
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin) {
    // This helper is local-only. Pages opened from file:// (Origin: null) and
    // arbitrary websites are deliberately refused to prevent browser-based SSRF.
    if (!/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(origin)) {
      return res.status(403).json({ error: 'Local verification requests only.' });
    }
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.vary('Origin');
  }
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
  }
  next();
});
app.use(express.json({ limit: '24kb', strict: true }));

const requestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: false,
  legacyHeaders: false,
  handler: (req, res) => {
    res.set('Retry-After', String(Math.max(1, Math.ceil((req.rateLimit.resetTime.getTime() - Date.now()) / 1000))));
    res.status(429).json({ error: 'Too many verification attempts. Please wait before trying again.' });
  },
});

const APPROVED_CART_ROOTS = ['amazon.com', 'amazon.in', 'flipkart.com'];
let activeJobs = 0;

function approvedRoot(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return APPROVED_CART_ROOTS.find((root) => host === root || host.endsWith(`.${root}`)) || '';
}

function isPrivateAddress(address) {
  const normalized = String(address || '').toLowerCase().split('%')[0];
  if (net.isIPv4(normalized)) {
    const octets = normalized.split('.').map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && octets[2] === 0) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(normalized)) {
    if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
    return normalized === '::' || normalized === '::1' ||
      /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff');
  }
  return true;
}

const dnsCache = new Map();
function cacheDnsResult(host, result, ttlMs) {
  if (dnsCache.size >= 500 && !dnsCache.has(host)) {
    const now = Date.now();
    for (const [key, value] of dnsCache) {
      if (value.expiresAt <= now) dnsCache.delete(key);
    }
    while (dnsCache.size >= 500) dnsCache.delete(dnsCache.keys().next().value);
  }
  dnsCache.set(host, { public: result, expiresAt: Date.now() + ttlMs });
}

async function hostResolvesPublicly(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (net.isIP(host)) return !isPrivateAddress(host);
  const cached = dnsCache.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached.public;
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    const publicOnly = records.length > 0 && records.every((record) => !isPrivateAddress(record.address));
    cacheDnsResult(host, publicOnly, 30_000);
    return publicOnly;
  } catch (e) {
    cacheDnsResult(host, false, 5_000);
    return false;
  }
}

/* ── Health check ── */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'savehatke-verify', uptime: process.uptime() });
});

/* ── Main verification endpoint ── */
app.post('/api/verify-coupon', requestLimiter, async (req, res) => {
  if (activeJobs >= 1) {
    res.set('Retry-After', '15');
    return res.status(429).json({ error: 'A verification is already running. Please try again shortly.' });
  }
  activeJobs += 1;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { couponCode, cartUrl, selectors, timeout = 10000, waitForNav = false } = body;

  /* ── Validate payload ── */
  if (typeof couponCode !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(couponCode)) {
    activeJobs -= 1;
    return res.status(400).json({ valid: false, reason: 'Missing or invalid couponCode.' });
  }
  if (!cartUrl || typeof cartUrl !== 'string' || cartUrl.length > 2048) {
    activeJobs -= 1;
    return res.status(400).json({ valid: false, reason: 'Missing or invalid cartUrl.' });
  }
  let target;
  try { target = new URL(cartUrl); } catch (e) { target = null; }
  const root = target && approvedRoot(target.hostname);
  if (!target || target.protocol !== 'https:' || target.port && target.port !== '443' ||
      target.username || target.password || !root) {
    activeJobs -= 1;
    return res.status(400).json({ valid: false, reason: 'Only approved HTTPS shopping-cart hosts are supported.' });
  }
  if (!selectors || !selectors.couponInput || !selectors.applyButton) {
    activeJobs -= 1;
    return res.status(400).json({ valid: false, reason: 'Missing required selectors (couponInput, applyButton).' });
  }
  if (!selectors.successMessage && !selectors.errorMessage) {
    activeJobs -= 1;
    return res.status(400).json({ valid: false, reason: 'At least one of successMessage or errorMessage selector is required.' });
  }
  if (typeof waitForNav !== 'boolean') {
    activeJobs -= 1;
    return res.status(400).json({ valid: false, reason: 'Invalid navigation setting.' });
  }
  for (const selector of [selectors.couponInput, selectors.applyButton, selectors.successMessage, selectors.errorMessage].filter(Boolean)) {
    if (typeof selector !== 'string' || selector.length > 200 || /[\r\n\0]/.test(selector)) {
      activeJobs -= 1;
      return res.status(400).json({ valid: false, reason: 'Invalid selector.' });
    }
  }
  const boundedTimeout = Number.isFinite(Number(timeout)) ? Math.min(15000, Math.max(2000, Number(timeout))) : 10000;

  let browser = null;

  try {
    /* ── Launch headless browser ── */
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,800'],
      defaultViewport: { width: 1280, height: 800 }
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(boundedTimeout);
    page.setDefaultTimeout(boundedTimeout);
    await page.setRequestInterception(true);
    let networkRequests = 0;
    page.on('request', (request) => {
      (async () => {
        networkRequests += 1;
        if (networkRequests > 300) return request.abort('blockedbyclient');
        const url = new URL(request.url());
        const hostRoot = approvedRoot(url.hostname);
        const isMainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
        if (url.protocol !== 'https:' || (isMainNavigation && hostRoot !== root) ||
            !await hostResolvesPublicly(url.hostname)) {
          return request.abort('blockedbyclient');
        }
        return request.continue();
      })().catch(() => request.abort('blockedbyclient').catch(() => {}));
    });

    /* Set a realistic user agent to avoid bot detection */
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    /* ── Navigate to cart page ── */
    console.log('  → Navigating to cart URL…');
    await page.goto(cartUrl, {
      waitUntil: 'networkidle2',
      timeout: boundedTimeout
    });

    /* ── Wait for the coupon input to be present ── */
    console.log('  → Waiting for coupon input field…');
    await page.waitForSelector(selectors.couponInput, { visible: true, timeout: boundedTimeout });

    /* ── Clear any existing value and type the coupon code ── */
    console.log(`  → Typing coupon code: ${couponCode}`);
    const inputEl = await page.$(selectors.couponInput);
    await inputEl.click({ clickCount: 3 }); // Select all existing text
    await inputEl.type(couponCode, { delay: 50 }); // Human-like typing speed

    /* ── Click the apply button ── */
    console.log('  → Clicking apply button…');
    await page.waitForSelector(selectors.applyButton, { visible: true, timeout: Math.min(5000, boundedTimeout) });

    if (waitForNav) {
      /* Some sites reload the page after applying a coupon */
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: boundedTimeout }),
        page.click(selectors.applyButton)
      ]);
    } else {
      await page.click(selectors.applyButton);
    }

    /* ── Wait for either success or error message ── */
    console.log('  → Waiting for result…');

    const racePromises = [];

    if (selectors.successMessage) {
      racePromises.push(
        page.waitForSelector(selectors.successMessage, { visible: true, timeout: boundedTimeout })
          .then(async (el) => {
            const text = await el.evaluate(node => node.textContent.trim());
            return { valid: true, reason: text || 'Coupon applied successfully.' };
          })
      );
    }

    if (selectors.errorMessage) {
      racePromises.push(
        page.waitForSelector(selectors.errorMessage, { visible: true, timeout: boundedTimeout })
          .then(async (el) => {
            const text = await el.evaluate(node => node.textContent.trim());
            return { valid: false, reason: text || 'Coupon is invalid or expired.' };
          })
      );
    }

    /* Race: first selector to appear wins */
    const result = await Promise.race(racePromises);

    console.log(`  ✅  Result: ${result.valid ? 'VALID' : 'INVALID'} — ${result.reason}`);
    return res.json(result);

  } catch (err) {
    /* ── Timeout or navigation error ── */
    const isTimeout = err.name === 'TimeoutError' || (err.message && err.message.includes('timeout'));

    console.error('[verify] browser job failed:', err && err.name ? err.name : 'Error');

    if (isTimeout) {
      return res.json({
        valid: false,
        reason: 'Verification timed out. The site may be slow or the selectors may be incorrect.'
      });
    }

    return res.status(500).json({ valid: false, reason: 'Verification could not be completed.' });

  } finally {
    /* ── ALWAYS close the browser to prevent memory leaks ── */
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.error('[verify] browser cleanup failed.');
      }
    }
    activeJobs = Math.max(0, activeJobs - 1);
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err && err.type === 'entity.too.large' ? 413
    : err instanceof SyntaxError && Object.prototype.hasOwnProperty.call(err, 'body') ? 400 : 500;
  console.error('[verify] request error:', String((err && (err.type || err.name)) || 'Error').slice(0, 80));
  return res.status(status).json({
    valid: false,
    reason: status === 413 ? 'Request body is too large.'
      : status === 400 ? 'Request body is invalid.' : 'Verification could not be completed.',
  });
});

/* ── Start server ── */
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  SaveHatke Coupon Verification Server    ║`);
  console.log(`║  Running on http://localhost:${PORT}         ║`);
  console.log(`║  POST /api/verify-coupon                 ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
