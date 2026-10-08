// ============================================
// SaveHatke — Real-Time Marketplace Logic
// ============================================

let allCoupons = [];
let currentCategory = 'all';
let currentSource = '';
let searchQuery = '';
let currentPage = 1;
let currentSort = 'recommended';
let savedOnly = false;
// Saved coupon IDs persisted to localStorage — the only state that survives a
// page reload. Coupon data itself is always re-fetched from /api/coupons so
// prices and availability stay live.
const SAVED_STORAGE_KEY = 'savehatke-saved';
let savedIds = loadSavedIds();
const PER_PAGE = 30;

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
  loadCoupons();
  initFilters();
  spawnParticles();

  // Check URL query parameters
  const params = new URLSearchParams(window.location.search);
  const cat = params.get('cat');
  if (cat) {
    currentCategory = cat;
    // Active state can land on either the visible pills or the "More" dropdown
    syncCategoryUI(cat);
  }
});

async function loadCoupons() {
  try {
    const data = await api('/coupons');
    allCoupons = data.coupons || [];
    renderFilteredCoupons();
  } catch (err) {
    console.warn('Load coupons notice:', err.message);
    allCoupons = [];
    renderFilteredCoupons();
  }
}

function renderFilteredCoupons() {
  let filtered = [...allCoupons];

  // Category filter
  if (currentCategory !== 'all') {
    filtered = filtered.filter((c) => (c.category || '').toLowerCase() === currentCategory.toLowerCase());
  }

  // Search filter
  const search = document.getElementById('searchInput')?.value?.toLowerCase().trim() || searchQuery;
  if (search) {
    filtered = filtered.filter(
      (c) =>
        (c.brand || '').toLowerCase().includes(search) ||
        (c.description || '').toLowerCase().includes(search) ||
        (c.title || '').toLowerCase().includes(search) ||
        (c.category || '').toLowerCase().includes(search)
    );
  }

  // Source filter
  const source = document.getElementById('sourceFilter')?.value || currentSource;
  if (source) {
    filtered = filtered.filter((c) => c.source === source);
  }

  // Saved-only filter (localStorage-backed)
  if (savedOnly) {
    filtered = filtered.filter((c) => savedIds.has(String(c.id)));
  }

  // Sort — recommended (default), price asc, or expiry asc
  filtered = sortCoupons(filtered, currentSort);

  // Update the count chip in the Explore header
  updateExploreCount(filtered.length);

  // Empty-state visibility — toggled off the grid itself, so the grid is
  // left untouched and never flashes a wrong number of cards on rerender.
  const emptyEl = document.getElementById('emptyMarket');
  if (emptyEl) {
    const h = emptyEl.querySelector('h3');
    const p = emptyEl.querySelector('p');
    if (savedOnly && filtered.length === 0) {
      if (h) h.textContent = 'No saved coupons here yet';
      if (p) p.textContent = 'Tap the bookmark on a coupon to keep it for later.';
    } else {
      if (h) h.textContent = 'No coupons found';
      if (p) p.textContent = 'Try another brand or clear your filters for a fresh start.';
    }
    emptyEl.hidden = filtered.length !== 0;
  }

  // Separate paid and free coupons only for pagination — the unified grid
  // renders everything (paid + free) together, with the FREE badge marking
  // auto-scraped coupons in-card.
  const paidCoupons = filtered.filter((c) => c.source !== 'auto-scraped');

  // Pagination for paid coupons (free coupons don't consume a page slot —
  // they're always shown alongside the paid ones).
  const totalPages = Math.ceil(paidCoupons.length / PER_PAGE);
  if (currentPage > totalPages) currentPage = Math.max(1, totalPages);
  const pageSlice = paidCoupons.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);

  renderCouponGrid('couponGrid', pageSlice);
  renderPagination(totalPages);
}

/** Stable, idempotent sort. Returns a NEW array — never mutates the input. */
function sortCoupons(list, mode) {
  const out = list.slice();
  if (mode === 'price') {
    // Free coupons (₹0) come first, then ascending by sellingPrice.
    out.sort((a, b) => (Number(a.sellingPrice) || 0) - (Number(b.sellingPrice) || 0));
  } else if (mode === 'expiry') {
    // Soonest-to-expire first. Coupons with no expiry date sink to the end.
    out.sort((a, b) => {
      const ax = parseExpiry(a.expiryDate)?.valueOf() ?? Infinity;
      const bx = parseExpiry(b.expiryDate)?.valueOf() ?? Infinity;
      return ax - bx;
    });
  }
  // 'recommended' = preserve the API order (insertion order).
  return out;
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

  grid.innerHTML = coupons
    .map((c) => {
      const isFree = c.source === 'auto-scraped';
      const priceText = isFree ? 'FREE' : `₹${c.sellingPrice || '15'}`;
      const origVal = c.discount
        ? (c.discount.includes('%') || c.discount.includes('₹') ? c.discount : `₹${c.discount} OFF`)
        : (c.originalValue ? `₹${c.originalValue} OFF` : 'SPECIAL OFFER');
      // Admin-controlled per-coupon switch (Coupon Management → Sale column).
      // Defaults to on, so coupons from a pre-migration database keep the badge.
      const onSale = c.onSale !== false;
      // The description only renders as its own line when it carries text the
      // title doesn't already show, so the card never repeats itself.
      const title = c.title || c.description || 'Verified Discount Offer';
      const desc = c.description && c.description !== title ? c.description : '';
      const id = String(c.id);
      const isSaved = savedIds.has(id);

      // Brand tile — the brand's logo when one is on file, its initial
      // otherwise. The letter sits underneath the img, so a failed logo load
      // just reveals the letter instead of leaving an empty white tile.
      const brand = c.brand || '';
      const initial = typeof getBrandInitial === 'function'
        ? getBrandInitial(brand)
        : (brand.charAt(0) || '?').toUpperCase();
      const logoUrl = typeof getBrandLogo === 'function' ? getBrandLogo(brand) : '';
      const logoExtra = logoUrl && typeof getBrandLogoClass === 'function' ? getBrandLogoClass(logoUrl) : '';

      return `
        <article class="coupon-card" data-coupon-id="${id}" style="cursor:pointer" onclick="buyCoupon('${id}', ${isFree})">
          <div class="match-banner">
            <div class="match-fallback" aria-hidden="true">
              <b>${escapeCoupon(initial)}</b>
              <span>${escapeCoupon(origVal)}</span>
            </div>
            <div class="coupon-badges">
              ${isFree ? '<span class="coupon-verified">✓ FREE CODE</span>' : '<span class="coupon-verified">✓ VERIFIED DEAL</span>'}
              ${!isFree && onSale ? '<span class="coupon-sale">🔥 SALE</span>' : ''}
            </div>
            <div class="coupon-actions">
              <button type="button" class="coupon-icon" aria-label="View Terms and Conditions" title="Terms &amp; Conditions"
                      onclick="event.stopPropagation(); openCouponTerms('${id}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7h.01"/>
                </svg>
              </button>
              <button type="button" class="coupon-icon" aria-label="View How to Use" title="How to Use"
                      onclick="event.stopPropagation(); openCouponHowTo('${id}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                </svg>
              </button>
              <button type="button" class="coupon-icon coupon-save-btn" data-action="save" aria-pressed="${isSaved}" aria-label="${isSaved ? 'Unsave coupon' : 'Save coupon'}" title="${isSaved ? 'Saved' : 'Save'}"
                      onclick="event.stopPropagation(); toggleSaved('${id}', this)">
                <svg viewBox="0 0 24 24" fill="${isSaved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M6 3h12v18l-6-4-6 4V3Z"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="match-body">
            <div class="match-info">
              <span class="match-logo" aria-hidden="true"><b>${escapeCoupon(initial)}</b>${logoUrl ? `<img src="${escapeCoupon(logoUrl)}" alt="" class="${logoExtra}" loading="lazy" decoding="async" onerror="this.style.display='none'">` : ''}</span>
              <div class="match-copy">
                <h3 class="match-title">${escapeCoupon(title)}</h3>
                ${desc ? `<p class="match-description" title="${escapeCoupon(desc)}">${escapeCoupon(desc)}</p>` : ''}
              </div>
            </div>
            <div class="match-meta">
              <span class="match-discount">${escapeCoupon(origVal)}</span>
              <span class="match-cost">${escapeCoupon(priceText)}</span>
            </div>
            ${renderExpiryTimer(c.expiryDate, c.timerOn)}
            <button type="button" class="match-claim" onclick="event.stopPropagation(); buyCoupon('${id}', ${isFree})">
              ${isFree ? 'Get Free Coupon →' : 'Buy Coupon →'}
            </button>
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
  if (savedOnly) renderFilteredCoupons();
}

// ── Expiry Countdown ────────────────────────────────────────────────────
// parseExpiry / expiryBand / expiryParts live in js/coupon-meta.js so the admin
// Coupon Management table shares the exact same maths and colour bands:
//   Timer starts at 2 weeks (auto-set when no expiry is configured).
//   ≥ 7 days → DDd HH:MM:SS (green/yellow)   < 7 days → HH:MM:SS (red)

/** Card-level colour class for the time remaining. */
function expiryClass(msLeft) {
  return `cexpiry-${expiryBand(msLeft)}`;
}

/**
 * Markup for one card's compact countdown pill. Empty string when no expiry is
 * set, or when the admin turned this coupon's timer off in Coupon Management —
 * the expiry date stays stored either way, so switching it back on restores it.
 *
 * One slim line inside a rounded pill: clock icon, "Ends in", then every unit
 * inline as value+letter ("48d 01h 43m 40s"). The digits live in their own
 * long-lived spans and the "Offer ended" copy ships with every pill, hidden by
 * CSS. That way the ticker below only ever writes `textContent`: the unit spans
 * and the breathing clock icon are never replaced, so the animation keeps
 * running instead of restarting every second, and both the expired state and
 * the "no days left to show" state are reached by a class swap rather than a
 * re-render.
 */
function renderExpiryTimer(raw, timerOn) {
  if (timerOn === false) return '';
  const at = parseExpiry(raw);
  if (at === null) return '';
  const msLeft = at - Date.now();
  const p = expiryParts(msLeft);
  const when = new Date(at).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return `<div class="cexpiry ${expiryClass(msLeft)}${p.dd ? '' : ' cexp-no-days'}" data-expiry="${at}" title="Expires ${when}">
            <span class="cexp-head">
              <svg class="cexp-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
                <path d="M12 7.4V12l3.1 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span class="cexp-label">Ends in</span>
            </span>
            <span class="cexp-clock">
              <span class="cexp-tile cexp-tile-d"><b class="cexp-d">${dayDigits(p.dd)}</b><i>d</i></span>
              <span class="cexp-tile"><b class="cexp-n cexp-h">${p.hh}</b><i>h</i></span>
              <span class="cexp-tile"><b class="cexp-n cexp-m">${p.mm}</b><i>m</i></span>
              <span class="cexp-tile"><b class="cexp-n cexp-s">${p.ss}</b><i>s</i></span>
            </span>
            <span class="cexp-over">◷ Offer ended</span>
          </div>`;
}

/**
 * expiryParts() returns the day count with its own 'd' suffix ('12d') because
 * the admin chip renders it as one string. The card tiles carry the unit letter
 * in their own element, so strip it here.
 */
function dayDigits(dd) {
  return dd ? String(dd).replace(/d$/i, '') : '';
}

let expiryTimerId = null;

/** Tick every countdown on the page once a second (single shared interval). */
function startExpiryTicker() {
  if (expiryTimerId !== null) return; // already running — re-renders are picked up on the next tick
  const setText = (el, value) => {
    if (el && el.textContent !== value) el.textContent = value;
  };
  const tick = () => {
    const nodes = document.querySelectorAll('.cexpiry[data-expiry]');
    if (nodes.length === 0) return;
    const now = Date.now();
    nodes.forEach((el) => {
      const msLeft = Number(el.dataset.expiry) - now;
      const p = expiryParts(msLeft);
      // Digits only — never innerHTML, or the unit letters and the icon's
      // breathing animation would be rebuilt (and restarted) every second.
      setText(el.querySelector('.cexp-d'), dayDigits(p.dd));
      setText(el.querySelector('.cexp-h'), p.hh);
      setText(el.querySelector('.cexp-m'), p.mm);
      setText(el.querySelector('.cexp-s'), p.ss);
      // Colour band, the clock → "Offer ended" swap, and hiding the days unit
      // once under a week remains all ride on this one class string.
      const cls = `cexpiry ${expiryClass(msLeft)}${p.dd ? '' : ' cexp-no-days'}`;
      if (el.className !== cls) el.className = cls;
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
  renderFilteredCoupons();
  document.getElementById('couponGrid')?.scrollIntoView({ behavior: 'smooth' });
}

function goToPage(page) {
  currentPage = page;
  renderFilteredCoupons();
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
          <div style="background: rgba(0, 230, 118, 0.1); border: 2px dashed #00e676; border-radius: 12px; padding: 18px; margin-bottom: 16px;">
          <code style="font-size: 1.6rem; font-weight: 800; color: #00e676; letter-spacing: 2px;">${escapeCoupon(coupon.code)}</code>
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

function initFilters() {
  // Category pills — visible row (the main six categories + All)
  document.querySelectorAll('#categoryPills .cpill').forEach((pill) => {
    pill.addEventListener('click', () => {
      currentCategory = pill.dataset.category || 'all';
      // Reset the "More categories" dropdown so the user can see they picked
      // a main pill, not a long-tail one.
      const more = document.getElementById('moreCategories');
      if (more) more.value = '';
      currentPage = 1;
      syncCategoryUI(currentCategory);
      syncPanelFilterControls();
      renderFilteredCoupons();
    });
  });

  // "More categories" dropdown — for the long-tail categories that don't get
  // a dedicated pill. Picking one here syncs the same UI state as a pill click.
  document.getElementById('moreCategories')?.addEventListener('change', (e) => {
    const value = e.target.value;
    if (!value) return;
    currentCategory = value;
    currentPage = 1;
    syncCategoryUI(value);
    syncPanelFilterControls();
    renderFilteredCoupons();
  });

  // Search input — debounced. The visible clear button shows only when
  // there's something to clear.
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  searchInput?.addEventListener('input', debounce((e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    if (searchClear) searchClear.hidden = searchQuery.length === 0;
    currentPage = 1;
    renderFilteredCoupons();
  }, 250));
  searchClear?.addEventListener('click', () => {
    if (!searchInput) return;
    searchInput.value = '';
    searchQuery = '';
    searchClear.hidden = true;
    currentPage = 1;
    renderFilteredCoupons();
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
      renderFilteredCoupons();
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
    renderFilteredCoupons();
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
    renderFilteredCoupons();
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
    renderFilteredCoupons();
  });

  // Saved-only filter — shows only coupons the user has bookmarked.
  document.getElementById('savedFilter')?.addEventListener('click', (e) => {
    savedOnly = !savedOnly;
    const btn = e.currentTarget;
    btn.setAttribute('aria-pressed', String(savedOnly));
    btn.classList.toggle('active', savedOnly);
    currentPage = 1;
    renderFilteredCoupons();
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
    renderFilteredCoupons();
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
