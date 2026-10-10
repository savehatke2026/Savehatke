// ============================================
// SaveHatke — Real-Time Marketplace Logic
// ============================================

// Marketplace-only brand imagery helpers. The shared helpers in coupon-meta.js
// (getBrandBackground / getBrandLogo) keep a multi-tier fallback chain (Drive
// → local library → clearbit) so older surfaces without Drive assets keep
// rendering. The marketplace card has its own graceful fallbacks (gradient
// block with brand initial + offer, white logo tile with first letter) and
// we treat Google Drive as the SINGLE source of truth here: if a brand has
// no Drive file yet, the card shows the fallback — never a stale local copy.
// Both helpers are pure consumers of the per-brand cache that coupon-meta.js
// builds via ensureBrandAssets(), so no extra Drive calls are introduced.
function getDriveBrandBackground(brand) {
  if (typeof getDriveAsset !== 'function') return '';
  const cached = getDriveAsset(brand);
  return (cached && cached.background) || '';
}

function getDriveBrandLogo(brand) {
  if (typeof getDriveAsset !== 'function') return '';
  const cached = getDriveAsset(brand);
  return (cached && cached.logo) || '';
}

let allCoupons = [];
let currentCategory = 'all';
let currentSource = '';
let searchQuery = '';
let currentPage = 1;
let currentSort = 'recommended';
let savedOnly = false;
// Server-driven paging state: /api/coupons returns one page at a time
// (a five-figure inventory cannot fit in one response), so these mirror the
// server's pagination facts for the pager + count chip.
let serverTotal = 0;
let serverPages = 1;
// Saved coupon IDs persisted to localStorage — the only state that survives a
// page reload. Coupon data itself is always re-fetched from /api/coupons so
// prices and availability stay live.
const SAVED_STORAGE_KEY = 'savehatke-saved';
let savedIds = loadSavedIds();
const PER_PAGE = 28;

function loadSavedIds() {
  try {
    const raw = localStorage.getItem(SAVED_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

function persistSavedIds() {
  try { localStorage.setItem(SAVED_STORAGE_KEY, JSON.stringify(Array.from(savedIds))); } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  // Deep-link category (?cat=Fashion) must be applied BEFORE the first load
  // so the opening fetch already carries it — otherwise the grid loads twice.
  const params = new URLSearchParams(window.location.search);
  const cat = params.get('cat');
  if (cat) {
    currentCategory = cat;
  }
  loadCoupons();
  initFilters();
  initVoiceSearch();
  spawnParticles();

  if (cat) {
    // Active state can land on either the visible pills or the "More" dropdown
    syncCategoryUI(cat);
  }
});

// Query the listing endpoint from the CURRENT filter state. The server does
// the filtering, sorting and paging; the client renders the returned page.
function buildCouponsQuery() {
  const params = new URLSearchParams();
  params.set('page', String(currentPage));
  params.set('pageSize', String(PER_PAGE));
  // The dropdown's "Price: low to high" sends 'price'; the server's sorter is
  // 'price-low' — translate here so the markup stays untouched.
  const SORT_MAP = { price: 'price-low', recommended: 'newest' };
  params.set('sort', SORT_MAP[currentSort] || currentSort);
  if (currentCategory && currentCategory !== 'all') params.set('category', currentCategory);
  if (currentSource) params.set('source', currentSource);
  const search = searchQuery || (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  if (search) params.set('search', search);
  return params;
}

async function loadCoupons() {
  try {
    // Saved-only view: fetch the user's bookmarked ids directly (the server
    // restricts to those ids and returns every match unpaged).
    if (savedOnly) {
      const ids = Array.from(savedIds).slice(0, 200).join(',');
      if (!ids) {
        allCoupons = [];
        serverTotal = 0;
        serverPages = 1;
        renderFilteredCoupons();
        return;
      }
      const params = new URLSearchParams({ ids });
      const SORT_MAP = { price: 'price-low', recommended: 'newest' };
      params.set('sort', SORT_MAP[currentSort] || currentSort);
      const data = await api('/coupons?' + params.toString());
      allCoupons = data.coupons || [];
      serverTotal = data.total || allCoupons.length;
      serverPages = 1;
    } else {
      const data = await api('/coupons?' + buildCouponsQuery().toString());
      allCoupons = data.coupons || [];
      serverTotal = data.total || 0;
      serverPages = data.totalPages || 1;
      if (currentPage > serverPages) {
        currentPage = serverPages;
        const retry = await api('/coupons?' + buildCouponsQuery().toString());
        allCoupons = retry.coupons || [];
      }
    }
    // Brand logos/backgrounds now come from Google Drive: resolve every brand
    // on the page in ONE batched request (cached per brand in coupon-meta.js)
    // before the first paint, so cards render with their final imagery.
    if (typeof ensureBrandAssets === 'function') {
      await ensureBrandAssets(allCoupons.map((c) => c.brand)).catch(() => {});
    }
    renderFilteredCoupons();
  } catch (err) {
    console.warn('Load coupons notice:', err.message);
    allCoupons = [];
    serverTotal = 0;
    serverPages = 1;
    renderFilteredCoupons();
  }
}

function renderFilteredCoupons() {
  // allCoupons already holds exactly the server's page for the active filters.
  // The saved-only branch can still narrow locally when sort/filters apply.
  let pageRows = [...allCoupons];
  if (savedOnly) {
    pageRows = pageRows.filter((c) => savedIds.has(String(c.id)));
  }

  // Update the count chip in the Explore header
  updateExploreCount(savedOnly ? pageRows.length : serverTotal);

  // Empty-state visibility — toggled off the grid itself, so the grid is
  // left untouched and never flashes a wrong number of cards on rerender.
  const emptyEl = document.getElementById('emptyMarket');
  if (emptyEl) {
    const h = emptyEl.querySelector('h3');
    const p = emptyEl.querySelector('p');
    if (savedOnly && pageRows.length === 0) {
      if (h) h.textContent = 'No saved coupons here yet';
      if (p) p.textContent = 'Tap the bookmark on a coupon to keep it for later.';
    } else {
      if (h) h.textContent = 'No coupons found';
      if (p) p.textContent = 'Try another brand or clear your filters for a fresh start.';
    }
    emptyEl.hidden = pageRows.length !== 0;
  }

  renderCouponGrid('couponGrid', pageRows);
  renderPagination(savedOnly ? 1 : serverPages);
}

function updateExploreCount(n) {
  const el = document.getElementById('couponCount');
  if (!el) return;
  el.textContent = `${n} available`;
}

/**
 * Reflect the active category across the visible pills and the "More"
 * dropdown, so the chosen filter reads correctly whichever surface picked
 * it. Pills hold the main six, the dropdown holds the rest — values match
 * the API's category strings (e.g. "Beauty & Personal Care", "Travel &
 * Transport"), so whichever one matches wins.
 */
function syncCategoryUI(cat) {
  const target = (cat || 'all').toLowerCase();
  document.querySelectorAll('#categoryPills .cpill').forEach((p) => {
    const isActive = (p.dataset.category || 'all').toLowerCase() === target;
    p.classList.toggle('active', isActive);
    p.setAttribute('aria-pressed', String(isActive));
  });
  const more = document.getElementById('moreCategories');
  if (more) {
    // If the chosen category isn't one of the visible pills, show it as the
    // dropdown's current selection. Otherwise leave the dropdown on its
    // "More categories" placeholder.
    const visible = Array.from(document.querySelectorAll('#categoryPills .cpill'))
      .some((p) => (p.dataset.category || '').toLowerCase() === target && target !== 'all');
    more.value = visible ? '' : cat;
  }
}

function renderCouponGrid(gridId, coupons) {
  const grid = document.getElementById(gridId);
  if (!grid) return;

  if (coupons.length === 0) {
    // The marketplace's outer empty state lives outside the grid (see
    // #emptyMarket in marketplace.html); it shows when zero coupons survive
    // the current filters. The grid itself just becomes empty.
    grid.innerHTML = '';
    return;
  }

  claimTimers.clear();

  grid.innerHTML = coupons
    .map((c) => {
      const isFree = c.source === 'auto-scraped';
      const priceText = isFree ? 'FREE' : `₹${c.sellingPrice || '15'}`;
      const origVal = c.discount
        ? (c.discount.includes('%') || c.discount.includes('₹') ? c.discount : `₹${c.discount} OFF`)
        : (c.originalValue ? `₹${c.originalValue} OFF` : 'SPECIAL OFFER');
      // The description only renders as its own line when it carries text the
      // title doesn't already show, so the card never repeats itself.
      const title = c.title || c.description || 'Verified Discount Offer';
      const desc = c.description && c.description !== title ? c.description : '';
      const id = String(c.id);
      const brand = c.brand || '';

      // Countdown — "2d 6h left" in the meta row, urgent under 48h and warning
      // under a week, refreshed by the shared ticker. Omitted when the admin
      // turned the timer off or the coupon has no expiry.
      const expiresAt = c.timerOn === false ? null : parseExpiry(c.expiryDate);
      let timerHtml = '';
      if (expiresAt !== null) {
        claimTimers.set(id, expiresAt);
        const hLeft = Math.max(0, (expiresAt - Date.now()) / 3600000);
        const band = hLeft < 48 ? 'urgent' : hLeft < 168 ? 'warning' : '';
        timerHtml = `<span class="match-timer ${band}">${CLAIM_TIMER_SVG}<span data-timer="${escapeCoupon(id)}">${formatClaimCountdown(expiresAt - Date.now())}</span></span>`;
      }

      const origPrice = !isFree && c.originalValue ? ` <del>₹${escapeCoupon(c.originalValue)}</del>` : '';

      // Brand imagery — the marketplace serves brand logos and coupon-card
      // backgrounds from Google Drive ONLY. When a brand has no Drive asset
      // yet the banner falls back to the gradient initial block and the tile
      // to the brand's first letter, so a missing Drive file never breaks a
      // card. The shared coupon-meta helpers (with their local/clearbit
      // fallbacks) still serve every other surface on the site.
      // Per-coupon background (set from Coupon Management) wins, then the
      // brand-level Drive background — the same rule checkout's hero applies.
      const brandImg = c.backgroundImage || getDriveBrandBackground(brand);
      // Per-coupon uploaded logo (set from Coupon Management) wins; empty
      // falls back to the brand-level Drive logo exactly as before.
      const logoUrl = c.brandLogo || getDriveBrandLogo(brand);
      const initial = typeof getBrandInitial === 'function'
        ? getBrandInitial(brand)
        : (brand.charAt(0) || '?').toUpperCase();
      const logoExtra = logoUrl && typeof getBrandLogoClass === 'function' ? getBrandLogoClass(logoUrl) : '';

      return `
        <article class="coupon-card" data-coupon-id="${id}" style="cursor:pointer" onclick="buyCoupon('${id}', ${isFree})">
          <div class="match-banner banner-${escapeCoupon(id)}">
            ${brandImg
              ? `<img src="${escapeCoupon(brandImg)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
              : `<div class="match-fallback" aria-hidden="true"><b>${escapeCoupon(initial)}</b><span>${escapeCoupon(origVal)}</span></div>`}
          </div>
          <div class="match-body">
            <div class="match-info">
              <div class="match-logo logo-${escapeCoupon(id)}" role="img" aria-label="${escapeCoupon(brand)} logo">
                ${logoUrl
                  ? `<img src="${escapeCoupon(logoUrl)}" alt="" class="${logoExtra}" loading="lazy" decoding="async" onerror="this.remove()">`
                  : `<b>${escapeCoupon(initial)}</b>`}
              </div>
              <div>
                <h3 class="match-title">${escapeCoupon(title)}</h3>
                ${desc ? `<p class="match-description" title="${escapeCoupon(desc)}">${escapeCoupon(desc)}</p>` : ''}
              </div>
            </div>
            <div class="match-meta">
              <span class="match-discount">${escapeCoupon(origVal)}</span>
              <span class="match-cost">${escapeCoupon(priceText)}${origPrice}</span>
              ${timerHtml}
            </div>
            <button type="button" class="match-claim" onclick="event.stopPropagation(); buyCoupon('${id}', ${isFree})">Claim Coupon</button>
          </div>
        </article>
      `;
    })
    .join('');

  startExpiryTicker();
}

/**
 * Toggle a coupon in/out of the user's saved set. Updates the button's
 * aria-pressed, fills/unfills the icon, persists the new set to localStorage,
 * and re-renders so the active "Saved only" filter (if on) reflects the
 * change immediately.
 */
function toggleSaved(id, btn) {
  const key = String(id);
  if (savedIds.has(key)) {
    savedIds.delete(key);
  } else {
    savedIds.add(key);
  }
  persistSavedIds();
  if (btn) {
    const isSaved = savedIds.has(key);
    btn.setAttribute('aria-pressed', String(isSaved));
    btn.setAttribute('aria-label', isSaved ? 'Unsave coupon' : 'Save coupon');
    btn.setAttribute('title', isSaved ? 'Saved' : 'Save');
    const svg = btn.querySelector('svg');
    if (svg) svg.setAttribute('fill', isSaved ? 'currentColor' : 'none');
  }
  // Only re-render when the saved-only filter is actually on; otherwise the
  // card the user just toggled would lose its position in the grid for no
  // visible reason.
  if (savedOnly) loadCoupons();
}

// ── Claim-card countdown ────────────────────────────────────────────────
// The card's "2d 6h left" timer. Deadlines live in claimTimers so the shared
// 60s interval below can re-derive the text and urgency band (urgent < 48h,
// warning < a week) without re-rendering the grid. parseExpiry lives in
// js/coupon-meta.js, shared with the admin Coupon Management table.
const claimTimers = new Map();
const CLAIM_TIMER_SVG = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="16" cy="18" r="12"/><path d="M16 10v8l5 4M13 2h6M16 2v4M25 6l3 3"/></svg>';

let expiryTimerId = null;

/** Live countdown text ("2d 6h 13m 05s left"); the tag itself never changes. */
function formatClaimCountdown(msLeft) {
  if (msLeft <= 0) return 'Expired';
  const totalSec = Math.floor(msLeft / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return d > 0
    ? `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s left`
    : `${pad(h)}h ${pad(m)}m ${pad(s)}s left`;
}

/** Tick every visible claim-card countdown once a second (single interval). */
function startExpiryTicker() {
  if (expiryTimerId !== null) return;
  const tick = () => {
    const now = Date.now();
    document.querySelectorAll('.match-timer [data-timer]').forEach((el) => {
      const at = claimTimers.get(el.dataset.timer);
      if (!at) return;
      const text = formatClaimCountdown(at - now);
      if (el.textContent !== text) el.textContent = text;
    });
  };
  tick();
  expiryTimerId = setInterval(tick, 1000);
}

function renderPagination(totalPages) {
  const bar = document.getElementById('paginationBar');
  const pagesSpan = document.getElementById('pgPages');
  const prevBtn = document.getElementById('pgPrev');
  const nextBtn = document.getElementById('pgNext');
  const infoSpan = document.getElementById('pgInfo');

  if (!bar || totalPages <= 1) {
    if (bar) bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';
  if (prevBtn) prevBtn.disabled = currentPage <= 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;

  // Smart page number list with ellipsis
  const pages = [];
  if (totalPages <= 7) {
    // Show all pages if 7 or fewer
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    // Always show first, last, current, and neighbors
    pages.push(1);
    if (currentPage > 3) pages.push('…');
    const start = Math.max(2, currentPage - 1);
    const end = Math.min(totalPages - 1, currentPage + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (currentPage < totalPages - 2) pages.push('…');
    pages.push(totalPages);
  }

  let pagesHtml = '';
  for (const p of pages) {
    if (p === '…') {
      pagesHtml += `<span class="pg-ellipsis">…</span>`;
    } else {
      pagesHtml += `<button class="pg-btn ${p === currentPage ? 'active' : ''}" onclick="goToPage(${p})">${p}</button>`;
    }
  }
  if (pagesSpan) pagesSpan.innerHTML = pagesHtml;
  if (infoSpan) infoSpan.textContent = `Page ${currentPage}/${totalPages}`;
}

function changePage(delta) {
  currentPage += delta;
  loadCoupons();
  document.getElementById('couponGrid')?.scrollIntoView({ behavior: 'smooth' });
}

function goToPage(page) {
  currentPage = page;
  loadCoupons();
  document.getElementById('couponGrid')?.scrollIntoView({ behavior: 'smooth' });
}

function buyCoupon(id, isFree) {
  const coupon = allCoupons.find(c => String(c.id) === String(id));
  if (coupon) {
    // These params only pre-paint the checkout page so it never flashes sample
    // data; checkout re-reads /api/coupons/:id and corrects itself. The coupon
    // `code` is deliberately NOT passed — /api/coupons never sends it to a
    // browser, and it is only released after a verified payment.
    const params = new URLSearchParams({
      id: coupon.id,
      brand: coupon.brand || '',
      category: coupon.category || '',
      title: coupon.title || coupon.description || 'Verified Discount Offer',
      price: coupon.sellingPrice || 15,
      value: coupon.originalValue || coupon.discount || 200,
      // Carry the countdown + sale state across so the checkout timer starts on
      // the same deadline the card was showing, rather than a default.
      expiry: coupon.expiryDate || '',
      onSale: coupon.onSale === false ? '0' : '1',
      timerOn: coupon.timerOn === false ? '0' : '1',
    });
    window.location.href = `checkout?${params.toString()}`;
  } else {
    window.location.href = `checkout?id=${encodeURIComponent(id)}`;
  }
}

// ── Card info modals — T&C and How to use ────────────────────────────────
// Both are opened from the compact ⓘ / 📖 icons on the card's hero and show the
// data belonging to THAT coupon. The list endpoint deliberately omits `terms`,
// so each modal fetches the single coupon after it opens — the modal paints
// instantly and fills in the coupon-specific text a beat later. Both are built
// here (not reusing openCouponTermsModal() from js/app.js) because this page
// ships its own stylesheet and never loads css/styles.css, so those classes
// would render unstyled; they also need to scope their cleanup to their own
// overlay class so the page's static auth modal (#modalOverlay) is left alone.

/** Open the Terms & Conditions modal for one card's coupon. */
function openCouponTerms(id) {
  const c = allCoupons.find((x) => String(x.id) === String(id)) || { id };
  const brand = c.brand || 'this coupon';
  const offer = c.title || c.description || 'Verified Discount Offer';

  // Only ever one of these open at a time. Scoped to .cterms-overlay so the
  // page's own auth modal is left alone.
  document.querySelectorAll('.modal-overlay.cterms-overlay').forEach((el) => el.remove());

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay cterms-overlay';
  overlay.dataset.termsId = String(id);
  overlay.innerHTML = `
    <div class="modal cterms-modal" role="dialog" aria-modal="true" aria-labelledby="ctermsTitle">
      <div class="mhdr" style="margin-bottom:20px">
        <div>
          <div class="mtitle" id="ctermsTitle">Terms &amp; Conditions</div>
          <div class="cterms-sub">${escapeCoupon(brand)}${c.category ? ' · ' + escapeCoupon(c.category) : ''}</div>
        </div>
        <button class="mclose" type="button" aria-label="Close">✕</button>
      </div>
      <div class="cterms-offer">${escapeCoupon(offer)}</div>
      <div class="cterms-body" data-terms-body>
        <div class="cterms-loading">Loading terms…</div>
      </div>
    </div>
  `;

  wireCouponModal(overlay);
  document.body.appendChild(overlay);
  void overlay.offsetWidth; // flush layout so the fade-in actually transitions
  overlay.classList.add('open');
  overlay.querySelector('.mclose').focus();

  loadCouponTerms(id);
}

/**
 * Fetch the coupon's stored terms and paint them into the open T&C modal.
 * sellerHowToText() strips the "How to use: …" paragraph the sell form appends
 * to terms — that text belongs to the How to Use modal, not this one.
 */
async function loadCouponTerms(id) {
  let terms = '';
  try {
    const res = await api(`/coupons/${encodeURIComponent(id)}`);
    terms = String(res?.coupon?.terms || '').trim();
    const match = terms.match(/how\s*to\s*use\s*:\s*([\s\S]*)/i);
    if (match) terms = terms.slice(0, match.index).trim();
  } catch (err) {
    terms = '';
  }

  // The modal may have been closed, or replaced by another coupon's, while the
  // request was in flight.
  const overlay = document.querySelector('.modal-overlay.cterms-overlay');
  if (!overlay || overlay.dataset.termsId !== String(id)) return;

  const body = overlay.querySelector('[data-terms-body]');
  if (!body) return;
  body.textContent = '';
  if (terms) {
    const p = document.createElement('p');
    p.className = 'cterms-text';
    p.textContent = terms;
    body.appendChild(p);
  } else {
    const none = document.createElement('p');
    none.className = 'cterms-none';
    none.textContent = 'No terms and conditions were provided for this coupon.';
    body.appendChild(none);
  }
}

/** Open the "How to use" modal for one card's coupon. */
function openCouponHowTo(id) {
  const c = allCoupons.find((x) => String(x.id) === String(id)) || { id };
  const isFree = c.source === 'auto-scraped';
  const brand = c.brand || 'the store';
  const offer = c.title || c.description || 'Verified Discount Offer';
  const priceText = isFree ? 'Free' : `₹${c.sellingPrice || '15'}`;
  const worth = c.discount || (c.originalValue ? `₹${c.originalValue} OFF` : '');

  // Only ever one of these open at a time. Scoped to .howto-overlay so the
  // page's own auth modal is left alone.
  document.querySelectorAll('.modal-overlay.howto-overlay').forEach((el) => el.remove());

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay howto-overlay';
  overlay.dataset.howtoId = String(id);
  overlay.innerHTML = `
    <div class="modal howto-modal" role="dialog" aria-modal="true" aria-labelledby="howtoTitle">
      <div class="mhdr" style="margin-bottom:20px">
        <div>
          <div class="mtitle" id="howtoTitle">How to Use This Coupon</div>
          <div class="howto-sub">${escapeCoupon(brand)}${c.category ? ' · ' + escapeCoupon(c.category) : ''}</div>
        </div>
        <button class="mclose" type="button" aria-label="Close">✕</button>
      </div>
      <div class="howto-offer">
        <div class="howto-offer-title">${escapeCoupon(offer)}</div>
        <div class="howto-offer-meta">${worth ? escapeCoupon(worth) + ' · ' : ''}You pay <b>${escapeCoupon(priceText)}</b></div>
      </div>
      <div class="chow-seller-slot"></div>
      <ol class="howto-steps">
        <li><span><b>${isFree ? 'Unlock the code' : 'Buy the coupon'}:</b> ${isFree
          ? 'Tap <em>Get Free Code</em> — the code is revealed right away, no payment needed.'
          : `Tap <em>Buy Coupon</em> and pay ${escapeCoupon(priceText)}. The code is revealed the moment the payment is confirmed.`}</span></li>
        <li><span><b>Copy the code:</b> Copy it from the confirmation screen, or any time later from <a href="dashboard">Dashboard → My Coupons</a>.</span></li>
        <li><span><b>Shop at ${escapeCoupon(brand)}:</b> Open the official ${escapeCoupon(brand)} app or website and add your items to the cart.</span></li>
        <li><span><b>Apply at checkout:</b> Paste the code into the <em>Have a coupon / promo code?</em> box and apply it before you pay.</span></li>
      </ol>
      <div class="howto-foot">
        Codes are checked before they are listed. If one does not work,
        <a href="support">contact support</a> within 48 hours of purchase for a refund or replacement.
      </div>
    </div>
  `;

  wireCouponModal(overlay);
  document.body.appendChild(overlay);
  void overlay.offsetWidth; // flush layout so the fade-in actually transitions
  overlay.classList.add('open');
  overlay.querySelector('.mclose').focus();

  loadSellerHowTo(id);
}

/**
 * Shared open/close behaviour for the card info modals: close button, backdrop
 * click, Escape, and a body scroll-lock so the page behind doesn't scroll while
 * a modal (or the phone bottom-sheet) is open. The lock is counted so two
 * modals never fight over restoring it, and it's released even if a modal is
 * removed by other code.
 */
const openCouponModals = new Set();

function wireCouponModal(overlay) {
  overlay.querySelector('.mclose').addEventListener('click', () => closeCouponModal(overlay));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCouponModal(overlay);
  });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key !== 'Escape') return;
    document.removeEventListener('keydown', onEsc);
    closeCouponModal(overlay);
  });
  openCouponModals.add(overlay);
  document.body.style.overflow = 'hidden';
  // Safety net: if the modal is removed by anything but closeCouponModal, the
  // lock must still lift.
  new MutationObserver((records, obs) => {
    if (!overlay.isConnected) {
      obs.disconnect();
      openCouponModals.delete(overlay);
      if (openCouponModals.size === 0) document.body.style.overflow = '';
    }
  }).observe(document.body, { childList: true, subtree: false });
}

function closeCouponModal(overlay) {
  if (!overlay.isConnected) return;
  openCouponModals.delete(overlay);
  if (openCouponModals.size === 0) document.body.style.overflow = '';
  overlay.classList.remove('open');
  setTimeout(() => overlay.remove(), 250); // matches the .modal-overlay transition
}

function closeCouponHowTo(overlay) {
  closeCouponModal(overlay);
}

/**
 * The four steps above are generic to every coupon. Sellers can also submit
 * their own instructions, which the sell form appends to Terms & Conditions as a
 * "How to use: …" paragraph (see sell.html) — so when this coupon has them, show
 * them above the generic steps.
 *
 * The list endpoint deliberately omits `terms`, hence the one-coupon read here.
 * It runs after the modal is already open, so the tag never feels slow, and a
 * failed request simply leaves the generic steps standing.
 */
async function loadSellerHowTo(id) {
  let note = '';
  try {
    const res = await api(`/coupons/${encodeURIComponent(id)}`);
    note = sellerHowToText(res && res.coupon && res.coupon.terms);
  } catch (err) {
    return;
  }
  if (!note) return;

  // The modal may have been closed, or replaced by another coupon's, while the
  // request was in flight.
  const overlay = document.querySelector('.modal-overlay.howto-overlay');
  if (!overlay || overlay.dataset.howtoId !== String(id)) return;
  const slot = overlay.querySelector('.chow-seller-slot');
  if (!slot || slot.querySelector('.chow-seller')) return;

  // Seller-supplied text: built with textContent, never innerHTML.
  const box = document.createElement('div');
  box.className = 'chow-seller';
  const head = document.createElement('div');
  head.className = 'chow-seller-head';
  head.textContent = '📝 Instructions from the seller';
  const body = document.createElement('p');
  body.className = 'chow-seller-body';
  body.textContent = note;
  box.append(head, body);
  slot.appendChild(box);
}

/** Pull the "How to use: …" paragraph back out of a coupon's stored terms. */
function sellerHowToText(terms) {
  const match = String(terms || '').match(/how\s*to\s*use\s*:\s*([\s\S]+)/i);
  return match ? match[1].trim().slice(0, 600) : '';
}

/** Coupon fields are seller-supplied, so escape them before interpolating. */
function escapeCoupon(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// ── Category icon ───────────────────────────────────────────────────────
// Purely presentational: maps the coupon's EXISTING category value (already
// stored/derived by SaveHatke) to the same emoji the category filter pills
// use in marketplace.html. It never assigns or changes a category — it only
// picks an icon to render in front of the category text the card displays.
// Matching is case-insensitive and covers the wider admin category set;
// anything unmapped falls back to the neutral tag icon.
const CATEGORY_ICONS = {
  'e-commerce': '🛒',
  'fashion': '👗',
  'beauty & personal care': '💄',
  'beauty': '💄',
  'food & delivery': '🍔',
  'food & dining': '🍔',
  'food': '🍔',
  'travel & transport': '✈️',
  'travel': '✈️',
  'hotels & stays': '🏨',
  'electronics & gadgets': '📱',
  'mobiles & electronics': '📱',
  'electronics': '📱',
  'gaming & entertainment': '🎮',
  'gaming': '🎮',
  'entertainment': '🎬',
  'fitness & sports': '🏋️',
  'fitness': '🏋️',
  'education': '📚',
  'health & pharmacy': '💊',
  'health & fitness': '💊',
  'health': '💊',
  'finance & payments': '💰',
  'furniture & home': '🛋️',
  'home & living': '🏠',
  'automotive': '🚗',
  'general': '🏷️',
};

function categoryIconFor(category) {
  const key = String(category || '').trim().toLowerCase();
  return CATEGORY_ICONS[key] || '🏷️';
}

function showCouponModal(coupon) {
  document.querySelector('.modal-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal" style="text-align: center;">
      <div class="mhdr">
        <div class="mtitle">🎉 Coupon Purchased!</div>
        <button class="mclose" onclick="this.closest('.modal-overlay').remove()">×</button>
      </div>
      <div style="margin-bottom: 20px;">
          <p style="color: #a8c0dc; margin-bottom: 14px;">Here's your coupon code for <strong style="color: #e2ecff;">${escapeCoupon(coupon.brand)}</strong>:</p>
          <div style="background: rgba(0,226,114, 0.1); border: 2px dashed #00E272; border-radius: 12px; padding: 18px; margin-bottom: 16px;">
          <code style="font-size: 1.6rem; font-weight: 800; color: #00E272; letter-spacing: 2px;">${escapeCoupon(coupon.code)}</code>
          </div>
        <button class="btn btn-primary btn-sm" data-copy-purchased-code>
          📋 Copy Code
        </button>
      </div>
      <p style="font-size: 0.8rem; color: #6b88aa;">
        ${escapeCoupon(coupon.description || '')}<br>
        Worth ₹${escapeCoupon(coupon.originalValue || coupon.discount || '')} · Paid ₹${escapeCoupon(coupon.pricePaid || coupon.sellingPrice || '')}
      </p>
      <a href="dashboard" class="btn btn-ghost btn-sm" style="margin-top: 16px;">View in Dashboard</a>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector('[data-copy-purchased-code]')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(String(coupon.code || ''));
      if (typeof showToast === 'function') showToast('Code copied to clipboard! 📋', 'success');
    } catch (err) {
      if (typeof showToast === 'function') showToast('Could not copy the code. Please select and copy it.', 'error');
    }
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// ── Voice search (search-bar microphone) ──────────────────────────────
// Uses the browser's Web Speech API to fill the EXISTING search input and
// trigger the EXISTING debounced search — no separate search system. The
// mic is one shared recognition instance; a second click stops it, and it
// is also stopped when the page is hidden/unloaded. Unsupported browsers
// keep normal text search and get a plain message instead.
function initVoiceSearch() {
  const micBtn = document.getElementById('voiceSearchBtn');
  const searchInput = document.getElementById('searchInput');
  if (!micBtn || !searchInput) return;

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  function notify(message) {
    if (typeof showToast === 'function') showToast(message, 'info');
    else micBtn.title = message;
  }

  if (!SpeechRec) {
    micBtn.title = 'Voice search is not supported in this browser';
    micBtn.addEventListener('click', () => {
      notify('Voice search is not supported in this browser — you can still type to search.');
    });
    return;
  }

  let recognition = null;
  let listening = false;

  function teardown() {
    listening = false;
    micBtn.classList.remove('is-listening');
    micBtn.setAttribute('aria-pressed', 'false');
    micBtn.setAttribute('aria-label', 'Search by voice');
  }

  // One path for every finish (final result, manual stop, error):
  // whatever the bar shows is what the existing search runs against.
  function runExistingSearch() {
    const term = searchInput.value.trim();
    if (!term) return;
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  micBtn.addEventListener('click', () => {
    if (!micBtn.isConnected || !searchInput.isConnected) return;
    // Second click while listening stops recognition (no duplicate sessions).
    if (listening) {
      try { recognition && recognition.stop(); } catch (e) { /* already dead */ }
      return;
    }

    try {
      recognition = new SpeechRec();
    } catch (e) {
      notify('Voice search could not start. Please try again.');
      return;
    }

    recognition.lang = 'en-IN';             // Indian English by default
    recognition.interimResults = true;      // recognized words appear live
    recognition.continuous = false;         // one phrase, then stop
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      listening = true;
      micBtn.classList.add('is-listening');   // pulse + ripple indicator
      micBtn.setAttribute('aria-pressed', 'true');
      micBtn.setAttribute('aria-label', 'Stop voice search');
    };

    recognition.onresult = (event) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript || '';
        if (event.results[i].isFinal) finalText += text;
        else interim += text;
      }
      const shown = (finalText || interim).trim();
      if (shown) searchInput.value = shown;
    };

    const ERROR_MESSAGES = {
      'not-allowed': 'Microphone access was denied. Allow it in your browser settings to search by voice.',
      'service-not-allowed': 'Voice search is blocked by your browser settings. Allow microphone access and try again.',
      'no-speech': 'We didn\'t hear anything. Tap the microphone and try again.',
      'audio-capture': 'No microphone was found. Connect one and try again.',
      'network': 'Voice search needs a network connection. Please try again.',
    };

    recognition.onerror = (event) => {
      // 'aborted' is our own stop() — silent by design.
      if (event.error === 'aborted') return;
      notify(ERROR_MESSAGES[event.error] || 'Voice search hit a problem. Please try again.');
    };

    recognition.onend = () => {
      teardown();
      recognition = null;
      runExistingSearch();
    };

    try {
      recognition.start();
    } catch (e) {
      // start() throws InvalidStateError if a session is somehow still alive —
      // never spawn a second instance.
      teardown();
      recognition = null;
      notify('Voice search is already running. Tap again to stop it.');
    }
  });

  // Leave the marketplace → stop recognition and release the microphone.
  const halt = () => {
    if (listening) {
      try { recognition && recognition.stop(); } catch (e) { /* already dead */ }
      teardown();
    }
  };
  window.addEventListener('pagehide', halt);
  window.addEventListener('beforeunload', halt);
}

function initFilters() {
  // Search input — debounced. The visible clear button shows only when
  // there's something to clear.
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  searchInput?.addEventListener('input', debounce((e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    if (searchClear) searchClear.hidden = searchQuery.length === 0;
    currentPage = 1;
    loadCoupons();
  }, 250));
  searchClear?.addEventListener('click', () => {
    if (!searchInput) return;
    searchInput.value = '';
    searchQuery = '';
    searchClear.hidden = true;
    currentPage = 1;
    loadCoupons();
    searchInput.focus();
  });

  // Popular search tags — Amazon/Myntra/Swiggy/Nykaa. Click fills the input
  // and runs the search immediately (no debounce delay).
  document.querySelectorAll('[data-search]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const term = btn.dataset.search || '';
      if (searchInput) {
        searchInput.value = term;
        searchInput.focus();
      }
      searchQuery = term.toLowerCase().trim();
      if (searchClear) searchClear.hidden = term.length === 0;
      currentPage = 1;
      loadCoupons();
    });
  });

  // Filter panel (popular row) — category + source dropdowns. Opening it
  // always reflects the CURRENT filter state, so it stays truthful whichever
  // surface (pills, panel, reset) changed the state last.
  const filterToggle = document.getElementById('filterToggle');
  const filterPanel = document.getElementById('filterPanel');
  function syncPanelFilterControls() {
    const catSel = document.getElementById('filterCategory');
    const srcSel = document.getElementById('filterSource');
    if (catSel) catSel.value = currentCategory === 'all' ? '' : currentCategory;
    if (srcSel) srcSel.value = currentSource || '';
  }
  function setFilterPanel(open, restoreFocus = false) {
    if (!filterPanel || !filterToggle) return;
    filterPanel.hidden = !open;
    filterToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      syncPanelFilterControls();
      document.getElementById('filterCategory')?.focus();
    } else if (restoreFocus) {
      filterToggle.focus();
    }
  }
  filterToggle?.addEventListener('click', () => setFilterPanel(filterPanel.hidden));
  document.getElementById('applyPanelFilters')?.addEventListener('click', () => {
    const catSel = document.getElementById('filterCategory');
    const srcSel = document.getElementById('filterSource');
    currentCategory = (catSel && catSel.value) || 'all';
    currentSource = (srcSel && srcSel.value) || '';
    currentPage = 1;
    syncCategoryUI(currentCategory);
    loadCoupons();
    setFilterPanel(false, true);
  });
  document.getElementById('clearPanelFilters')?.addEventListener('click', () => {
    const catSel = document.getElementById('filterCategory');
    const srcSel = document.getElementById('filterSource');
    if (catSel) catSel.value = '';
    if (srcSel) srcSel.value = '';
    currentCategory = 'all';
    currentSource = '';
    currentPage = 1;
    syncCategoryUI('all');
    loadCoupons();
  });
  // Click anywhere outside the wrap closes the panel; Escape closes it and
  // returns focus to the Filter button (same behaviour as the mockup).
  document.addEventListener('click', (event) => {
    if (!filterPanel || filterPanel.hidden) return;
    if (!event.target.closest('.popular-filter-wrap')) setFilterPanel(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && filterPanel && !filterPanel.hidden) setFilterPanel(false, true);
  });

  // Sort dropdown — Recommended / Price: low to high / Expiring soon
  document.getElementById('sortSelect')?.addEventListener('change', (e) => {
    currentSort = e.target.value || 'recommended';
    currentPage = 1;
    loadCoupons();
  });

  // Saved-only filter — shows only coupons the user has bookmarked.
  document.getElementById('savedFilter')?.addEventListener('click', (e) => {
    savedOnly = !savedOnly;
    const btn = e.currentTarget;
    btn.setAttribute('aria-pressed', String(savedOnly));
    btn.classList.toggle('active', savedOnly);
    currentPage = 1;
    loadCoupons();
  });

  // Reset button inside the empty-state — clears every filter and shows
  // every coupon again. The dropdown returns to its placeholder and the
  // pill row highlights "All".
  document.getElementById('resetFilters')?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    searchQuery = '';
    const sourceSel = document.getElementById('sourceFilter');
    if (sourceSel) sourceSel.value = '';
    currentSource = '';
    currentCategory = 'all';
    currentSort = 'recommended';
    const sortSel = document.getElementById('sortSelect');
    if (sortSel) sortSel.value = 'recommended';
    const more = document.getElementById('moreCategories');
    if (more) more.value = '';
    savedOnly = false;
    const savedBtn = document.getElementById('savedFilter');
    if (savedBtn) {
      savedBtn.setAttribute('aria-pressed', 'false');
      savedBtn.classList.remove('active');
    }
    if (searchClear) searchClear.hidden = true;
    currentPage = 1;
    syncCategoryUI('all');
    syncPanelFilterControls();
    loadCoupons();
  });
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

function spawnParticles() {
  const container = document.getElementById('pageParticles');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = (6 + Math.random() * 10) + 's';
    p.style.animationDelay = (Math.random() * 8) + 's';
    p.style.width = p.style.height = (2 + Math.random() * 3) + 'px';
    container.appendChild(p);
  }
}
