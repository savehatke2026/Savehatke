#!/usr/bin/env node
/**
 * SaveHatke — Brand Scaffolding CLI
 * ===================================
 * Usage:  node scripts/create-brand.js <brand-name>
 * Example: node scripts/create-brand.js myntra
 *
 * Generates:
 *   brands/<brand-name>/
 *   ├── index.html          — Brand coupon page
 *   ├── brand.css           — Brand-specific overrides
 *   ├── coupons.json        — Coupon data store
 *   └── auto-verify/
 *       ├── config.json     — Selectors & cart URL
 *       └── verify.js       — Client-side verification logic
 */

const fs   = require('fs');
const path = require('path');

/* ── Helpers ──────────────────────────────────────────── */
const ROOT       = path.resolve(__dirname, '..');
const BRANDS_DIR = path.join(ROOT, 'brands');

function titleCase(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function kebabCase(str) {
  return str.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`  📁  Created  ${path.relative(ROOT, dir)}/`);
  }
}

function writeFile(filePath, content) {
  if (fs.existsSync(filePath)) {
    console.log(`  ⚠️   Skipped  ${path.relative(ROOT, filePath)}  (already exists)`);
    return;
  }
  fs.writeFileSync(filePath, content, 'utf-8');
  console.log(`  ✅  Created  ${path.relative(ROOT, filePath)}`);
}

/* ── Template Generators ─────────────────────────────── */

function genCouponsJson(brandTitle) {
  return JSON.stringify({
    brand: brandTitle,
    lastUpdated: new Date().toISOString().split('T')[0],
    coupons: [
      {
        code:        "SAVE10",
        description: `Flat 10% off on ${brandTitle}`,
        discount:    "10%",
        minOrder:    499,
        maxDiscount: 200,
        category:    "all",
        expiresAt:   "2026-12-31",
        verified:    false,
        lastTested:  null
      },
      {
        code:        "FIRST50",
        description: `₹50 off on first ${brandTitle} order`,
        discount:    "₹50",
        minOrder:    299,
        maxDiscount: 50,
        category:    "new-user",
        expiresAt:   "2026-12-31",
        verified:    false,
        lastTested:  null
      }
    ]
  }, null, 2) + '\n';
}

function genConfigJson(brandSlug) {
  return JSON.stringify({
    brandSlug,
    cartUrl:        `https://www.${brandSlug}.com/cart`,
    selectors: {
      couponInput:    "#coupon-code-input",
      applyButton:    "#apply-coupon-btn",
      successMessage: ".coupon-success-message",
      errorMessage:   ".coupon-error-message"
    },
    timeout:     10000,
    waitForNav:  false,
    notes:       "Update selectors to match the real site DOM before running live tests."
  }, null, 2) + '\n';
}

function genBrandCSS(brandTitle) {
  return `/* ============================================
   ${brandTitle} — Brand-Specific Overrides
   ============================================ */

/*
 * Override any CSS custom property from global.css here.
 * Example:
 *   :root { --brand-accent: #ff6f00; }
 */

:root {
  --brand-accent: #3b82f6;
  --brand-accent-dark: #2563eb;
}

/* Brand logo area */
.brand-hero__logo img {
  max-height: 72px;
  object-fit: contain;
}

/* Override coupon card accent stripe for this brand */
.coupon-card::before {
  background: var(--brand-accent);
}
`;
}

function genVerifyJS() {
  return `/**
 * SaveHatke — Coupon Auto-Verify (Client)
 * =========================================
 * Sends the coupon + brand config to the verification server
 * and updates the UI with the result.
 */

const API_URL = 'http://localhost:3000/api/verify-coupon';

/* ── DOM refs (populated on DOMContentLoaded) ── */
let configData    = null;
let elInput       = null;
let elBtn         = null;
let elResult      = null;
let elResultIcon  = null;
let elResultText  = null;
let elSpinner     = null;

/* ── Bootstrap ── */
document.addEventListener('DOMContentLoaded', async () => {
  elInput      = document.getElementById('verify-coupon-input');
  elBtn        = document.getElementById('verify-coupon-btn');
  elResult     = document.getElementById('verify-result');
  elResultIcon = document.getElementById('verify-result-icon');
  elResultText = document.getElementById('verify-result-text');
  elSpinner    = document.getElementById('verify-spinner');

  if (!elInput || !elBtn) {
    console.warn('[auto-verify] Required DOM elements not found.');
    return;
  }

  /* Load brand config */
  try {
    const res  = await fetch('./config.json');
    if (!res.ok) throw new Error(\`Config fetch failed: \${res.status}\`);
    configData = await res.json();
    console.log('[auto-verify] Config loaded for:', configData.brandSlug);
  } catch (err) {
    console.error('[auto-verify] Failed to load config.json:', err);
    showResult('error', 'Configuration error — config.json not found.');
    elBtn.disabled = true;
    return;
  }

  elBtn.addEventListener('click', handleVerify);
  elInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleVerify();
  });
});

/* ── Verify handler ── */
async function handleVerify() {
  const code = elInput.value.trim().toUpperCase();
  if (!code) {
    shakeInput();
    return;
  }
  if (!configData) {
    showResult('error', 'Brand config not loaded.');
    return;
  }

  setLoading(true);
  hideResult();

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        couponCode: code,
        cartUrl:    configData.cartUrl,
        selectors:  configData.selectors,
        timeout:    configData.timeout || 10000,
        waitForNav: configData.waitForNav || false
      })
    });

    if (!res.ok) throw new Error(\`Server returned \${res.status}\`);

    const data = await res.json();

    if (data.valid) {
      showResult('success', data.reason || 'Coupon is valid! Discount applied successfully.');
    } else {
      showResult('error', data.reason || 'Coupon is invalid or expired.');
    }
  } catch (err) {
    console.error('[auto-verify] Request failed:', err);
    showResult('error', \`Verification failed: \${err.message}\`);
  } finally {
    setLoading(false);
  }
}

/* ── UI helpers ── */
function setLoading(on) {
  elBtn.disabled = on;
  elInput.disabled = on;
  if (elSpinner) elSpinner.style.display = on ? 'flex' : 'none';
  elBtn.innerHTML = on
    ? '<span class="btn-spinner"></span> Verifying…'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg> Test Coupon';
}

function showResult(type, message) {
  if (!elResult) return;
  elResult.className = \`verify-result verify-result--\${type} verify-result--visible\`;
  if (elResultIcon) {
    elResultIcon.innerHTML = type === 'success'
      ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>'
      : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
  }
  if (elResultText) elResultText.textContent = message;
}

function hideResult() {
  if (elResult) elResult.className = 'verify-result';
}

function shakeInput() {
  elInput.classList.add('shake');
  elInput.focus();
  setTimeout(() => elInput.classList.remove('shake'), 500);
}
`;
}

function genIndexHTML(brandSlug, brandTitle) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${brandTitle} coupons, promo codes & deals — verified live by SaveHatke. Save money on every ${brandTitle} order.">
  <title>${brandTitle} Coupons & Promo Codes — SaveHatke</title>

  <!-- Design System -->
  <link rel="stylesheet" href="../../public/css/global.css">
  <link rel="stylesheet" href="brand.css">

  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
</head>
<body>

  <!-- ─── Navbar ─── -->
  <nav class="nav" id="main-nav">
    <div class="nav__inner">
      <a href="/" class="nav__brand">
        <span class="nav__logo">S</span>
        <span class="nav__name">Save<span class="nav__name--accent">Hatke</span></span>
      </a>
      <div class="nav__links">
        <a href="/">Home</a>
        <a href="/public/about.html">About</a>
      </div>
    </div>
  </nav>

  <!-- ─── Brand Hero ─── -->
  <header class="brand-hero" id="brand-hero">
    <div class="brand-hero__glow"></div>
    <div class="brand-hero__inner">
      <div class="brand-hero__logo">
        <div class="brand-hero__logo-placeholder" id="brand-logo-placeholder">${brandTitle.charAt(0)}</div>
      </div>
      <div class="brand-hero__text">
        <h1 class="brand-hero__title">${brandTitle} Coupons & Deals</h1>
        <p class="brand-hero__subtitle">Verified promo codes updated daily. Tested live with our auto-verification engine.</p>
        <div class="brand-hero__badges">
          <span class="badge badge--green"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg> Auto-Verified</span>
          <span class="badge badge--blue"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Updated Today</span>
        </div>
      </div>
    </div>
  </header>

  <!-- ─── Main Content ─── -->
  <main class="brand-main" id="brand-main">

    <!-- Coupon List -->
    <section class="coupon-section" id="coupon-section">
      <h2 class="section-title">Active Coupons</h2>
      <div class="coupon-grid" id="coupon-grid">
        <!-- Populated by JS from coupons.json -->
        <div class="coupon-grid__loading" id="coupons-loading">
          <div class="pulse-loader"><span></span><span></span><span></span></div>
          <p>Loading coupons…</p>
        </div>
      </div>
    </section>

    <!-- Auto-Verify Section -->
    <section class="verify-section" id="verify-section">
      <div class="verify-card">
        <div class="verify-card__header">
          <div class="verify-card__icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              <path d="M9 12l2 2 4-4"/>
            </svg>
          </div>
          <div>
            <h2 class="verify-card__title">Auto-Verify a Coupon</h2>
            <p class="verify-card__desc">Enter any coupon code and we'll test it live on ${brandTitle}'s checkout page using headless automation.</p>
          </div>
        </div>
        <div class="verify-card__body">
          <div class="verify-input-group">
            <input
              type="text"
              id="verify-coupon-input"
              class="verify-input"
              placeholder="Enter coupon code…"
              autocomplete="off"
              spellcheck="false"
            >
            <button id="verify-coupon-btn" class="btn btn--verify">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
              Test Coupon
            </button>
          </div>
          <div id="verify-spinner" class="verify-spinner" style="display:none">
            <div class="orbit-spinner"><div></div><div></div><div></div></div>
            <span>Testing on ${brandTitle}…</span>
          </div>
          <div id="verify-result" class="verify-result">
            <span id="verify-result-icon" class="verify-result__icon"></span>
            <span id="verify-result-text" class="verify-result__text"></span>
          </div>
        </div>
      </div>
    </section>

  </main>

  <!-- ─── Footer ─── -->
  <footer class="footer" id="footer">
    <p>&copy; ${new Date().getFullYear()} SaveHatke. All rights reserved.</p>
  </footer>

  <!-- ─── Scripts ─── -->
  <script>
    /* Load coupons from coupons.json and render cards */
    (async () => {
      const grid    = document.getElementById('coupon-grid');
      const loading = document.getElementById('coupons-loading');
      try {
        const res     = await fetch('./coupons.json');
        const data    = await res.json();
        loading.remove();
        if (!data.coupons || data.coupons.length === 0) {
          grid.innerHTML = '<p class="coupon-grid__empty">No active coupons right now. Check back soon!</p>';
          return;
        }
        grid.innerHTML = data.coupons.map(c => couponCard(c)).join('');
      } catch (e) {
        loading.innerHTML = '<p class="coupon-grid__empty">Failed to load coupons.</p>';
      }
    })();

    function couponCard(c) {
      const verified = c.verified
        ? '<span class="badge badge--green badge--sm">✓ Verified</span>'
        : '<span class="badge badge--slate badge--sm">Unverified</span>';
      return \`
        <article class="coupon-card" data-code="\${c.code}">
          <div class="coupon-card__accent"></div>
          <div class="coupon-card__body">
            <div class="coupon-card__top">
              <span class="coupon-card__discount">\${c.discount}</span>
              \${verified}
            </div>
            <p class="coupon-card__desc">\${c.description}</p>
            <div class="coupon-card__meta">
              <span>Min. ₹\${c.minOrder}</span>
              <span>Expires \${c.expiresAt}</span>
            </div>
          </div>
          <div class="coupon-card__footer">
            <code class="coupon-card__code">\${c.code}</code>
            <button class="btn btn--copy" onclick="copyCode(this, '\${c.code}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              Copy
            </button>
          </div>
        </article>\`;
    }

    function copyCode(btn, code) {
      navigator.clipboard.writeText(code).then(() => {
        const orig = btn.innerHTML;
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 12l2 2 4-4"/></svg> Copied!';
        btn.classList.add('btn--copied');
        setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('btn--copied'); }, 1800);
      });
    }
  </script>
  <script src="./auto-verify/verify.js"></script>
</body>
</html>
`;
}

/* ── Main ─────────────────────────────────────────────── */
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
  SaveHatke — Brand Scaffolding CLI
  ──────────────────────────────────
  Usage:   node scripts/create-brand.js <brand-name>
  Example: node scripts/create-brand.js myntra

  Options:
    --help, -h    Show this help message
    --force       Overwrite existing files
`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const rawName   = args.find(a => !a.startsWith('--'));
  const force     = args.includes('--force');

  if (!rawName) {
    console.error('❌  Please provide a brand name.');
    process.exit(1);
  }

  const slug  = kebabCase(rawName);
  const title = titleCase(rawName);

  console.log(`\n🚀  Scaffolding brand: ${title} (${slug})\n`);

  /* Create directory tree */
  const brandDir  = path.join(BRANDS_DIR, slug);
  const verifyDir = path.join(brandDir, 'auto-verify');
  ensureDir(brandDir);
  ensureDir(verifyDir);

  /* Write files */
  const writer = force
    ? (p, c) => { fs.writeFileSync(p, c, 'utf-8'); console.log(`  ✅  Wrote     ${path.relative(ROOT, p)}`); }
    : writeFile;

  writer(path.join(brandDir, 'index.html'),            genIndexHTML(slug, title));
  writer(path.join(brandDir, 'brand.css'),              genBrandCSS(title));
  writer(path.join(brandDir, 'coupons.json'),           genCouponsJson(title));
  writer(path.join(verifyDir, 'config.json'),           genConfigJson(slug));
  writer(path.join(verifyDir, 'verify.js'),             genVerifyJS());

  console.log(`\n✨  Brand "${title}" scaffolded at  brands/${slug}/`);
  console.log(`    Next steps:`);
  console.log(`      1. Update  brands/${slug}/auto-verify/config.json  with real selectors`);
  console.log(`      2. Add real coupons to  brands/${slug}/coupons.json`);
  console.log(`      3. Add a brand logo image to  brands/${slug}/\n`);
}

main();
