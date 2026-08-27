// ============================================
// SaveHatke — Real-Time Marketplace Logic
// ============================================

let allCoupons = [];
let currentCategory = 'all';
let currentSource = '';
let searchQuery = '';
let currentPage = 1;
const PER_PAGE = 30;

document.addEventListener('DOMContentLoaded', () => {
  loadCoupons();
  initFilters();
  spawnParticles();

  // Check URL query parameters
  const params = new URLSearchParams(window.location.search);
  const cat = params.get('cat');
  if (cat) {
    currentCategory = cat;
    document.querySelectorAll('#categoryPills .cpill').forEach((p) => {
      p.classList.toggle('active', p.dataset.category === cat);
    });
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

  // Separate paid and free coupons
  const paidCoupons = filtered.filter((c) => c.source !== 'auto-scraped');
  const freeCoupons = filtered.filter((c) => c.source === 'auto-scraped');

  // Pagination for paid coupons
  const totalPages = Math.ceil(paidCoupons.length / PER_PAGE);
  if (currentPage > totalPages) currentPage = 1;
  const pageSlice = paidCoupons.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);

  renderCouponGrid('couponGrid', pageSlice);
  renderPagination(totalPages);

  // Free codes section
  const freeSection = document.getElementById('freeCodesSection');
  if (freeCoupons.length > 0 && freeSection) {
    freeSection.style.display = 'block';
    renderCouponGrid('freeCodesGrid', freeCoupons);
  } else if (freeSection) {
    freeSection.style.display = 'none';
  }
}

function renderCouponGrid(gridId, coupons) {
  const grid = document.getElementById(gridId);
  if (!grid) return;

  if (coupons.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-ico">🏷️</div>
        <div class="empty-title">No coupons found in database</div>
        <div class="empty-sub">Add coupons in the Admin panel or sell a coupon to make it appear here live!</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = coupons
    .map((c) => {
      const isFree = c.source === 'auto-scraped';
      const priceText = isFree ? 'FREE' : `₹${c.sellingPrice || '15'}`;
      const origVal = c.discount ? (c.discount.includes('%') || c.discount.includes('₹') ? c.discount : `₹${c.discount} OFF`) : (c.originalValue ? `₹${c.originalValue} OFF` : 'SPECIAL OFFER');
      const logoUrl = getBrandLogo(c.brand);
      const initial = getBrandInitial(c.brand);
      // Admin-controlled per-coupon switch (Coupon Management → Sale column).
      // Defaults to on, so coupons from a pre-migration database keep the badge.
      const onSale = c.onSale !== false;

      return `
        <div class="coupon-card" style="cursor:pointer" onclick="buyCoupon('${c.id}', ${isFree})">
          ${isFree
            ? '<span class="cfree-badge">FREE</span>'
            : `<div class="cbadges">
                 <span class="cverified">✓ VERIFIED DEAL</span>
                 ${onSale ? '<span class="csale-badge">🔥 Sale</span>' : ''}
               </div>`
          }
          <div class="ctop">
            <div class="cbrand">
              <span class="cbrand-logo-wrap">
                ${logoUrl
                  ? `<img class="cbrand-logo" src="${logoUrl}" alt="${c.brand}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="cbrand-initial" style="display:none">${initial}</span>`
                  : `<span class="cbrand-initial">${initial}</span>`
                }
              </span>
              <span class="cbrand-name">${c.brand}</span>
            </div>
            <div class="coff">${origVal}</div>
          </div>
          <div class="cdesc">${c.title || c.description || 'Verified Discount Offer'}</div>
          <div class="cmeta">
            <div>
              <span class="clbl">Selling Price</span>
              <span class="cval">${priceText}</span>
            </div>
            <span class="ccat">${c.category}</span>
          </div>
          ${renderExpiryTimer(c.expiryDate, c.timerOn)}
          <button class="cbuy-btn" onclick="event.stopPropagation(); buyCoupon('${c.id}', ${isFree})">
            ${isFree ? 'Get Free Code →' : 'Buy Coupon →'}
          </button>
        </div>
      `;
    })
    .join('');

  startExpiryTicker();
}

// ── Expiry Countdown ────────────────────────────────────────────────────
// parseExpiry / expiryBand / expiryParts live in js/coupon-meta.js so the admin
// Coupon Management table shares the exact same maths and colour bands:
//   ≤ 1 week (7d) → red   ≤ 2 weeks (14d) → yellow   beyond → green

/** Card-level colour class for the time remaining. */
function expiryClass(msLeft) {
  return `cexpiry-${expiryBand(msLeft)}`;
}

/**
 * Markup for one card's countdown row. Empty string when no expiry is set, or
 * when the admin turned this coupon's timer off in Coupon Management — the
 * expiry date stays stored either way, so switching it back on restores it.
 *
 * The digits sit in their own long-lived spans and the "Offer ended" copy ships
 * with every pill, hidden by CSS. That way the ticker below only ever writes
 * `textContent`: the separator nodes are never replaced, so their 1Hz blink
 * animation keeps running instead of restarting from zero every second, and the
 * expired state is reached by a class swap rather than a re-render.
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
  return `<div class="cexpiry ${expiryClass(msLeft)}" data-expiry="${at}" title="Expires ${when}">
            <svg class="cexp-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
              <path d="M12 7.4V12l3.1 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="cexp-label">Ends in</span>
            <span class="cexp-clock">
              <b class="cexp-d">${p.dd}</b><b class="cexp-n cexp-h">${p.hh}</b><i class="cexp-sep">:</i><b class="cexp-n cexp-m">${p.mm}</b><i class="cexp-sep">:</i><b class="cexp-n cexp-s">${p.ss}</b>
            </span>
            <span class="cexp-over">Offer ended</span>
          </div>`;
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
      // Digits only — never innerHTML, or the blinking colons reset each second.
      setText(el.querySelector('.cexp-d'), p.dd); // '' collapses via .cexp-d:empty
      setText(el.querySelector('.cexp-h'), p.hh);
      setText(el.querySelector('.cexp-m'), p.mm);
      setText(el.querySelector('.cexp-s'), p.ss);
      // Colour band, and the clock → "Offer ended" swap, both ride on this class.
      const cls = `cexpiry ${expiryClass(msLeft)}`;
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
    const params = new URLSearchParams({
      id: coupon.id,
      brand: coupon.brand || '',
      category: coupon.category || '',
      title: coupon.title || coupon.description || 'Verified Discount Offer',
      price: coupon.sellingPrice || 15,
      value: coupon.originalValue || coupon.discount || 200,
      code: coupon.code || '',
      minOrder: coupon.minOrderValue || '999'
    });
    window.location.href = `checkout?${params.toString()}`;
  } else {
    window.location.href = `checkout?id=${encodeURIComponent(id)}`;
  }
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
        <p style="color: #a8c0dc; margin-bottom: 14px;">Here's your coupon code for <strong style="color: #e2ecff;">${coupon.brand}</strong>:</p>
        <div style="background: rgba(0, 230, 118, 0.1); border: 2px dashed #00e676; border-radius: 12px; padding: 18px; margin-bottom: 16px;">
          <code style="font-size: 1.6rem; font-weight: 800; color: #00e676; letter-spacing: 2px;">${coupon.code}</code>
        </div>
        <button class="btn btn-primary btn-sm" onclick="navigator.clipboard.writeText('${coupon.code}'); if(typeof showToast==='function') showToast('Code copied to clipboard! 📋', 'success')">
          📋 Copy Code
        </button>
      </div>
      <p style="font-size: 0.8rem; color: #6b88aa;">
        ${coupon.description || ''}<br>
        Worth ₹${coupon.originalValue || coupon.discount || ''} · Paid ₹${coupon.pricePaid || coupon.sellingPrice || ''}
      </p>
      <a href="dashboard" class="btn btn-ghost btn-sm" style="margin-top: 16px;">View in Dashboard</a>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

function initFilters() {
  // Category pills
  document.querySelectorAll('#categoryPills .cpill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#categoryPills .cpill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      currentCategory = pill.dataset.category || 'all';
      currentPage = 1;
      renderFilteredCoupons();
    });
  });

  // Search
  document.getElementById('searchInput')?.addEventListener('input', debounce((e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    currentPage = 1;
    renderFilteredCoupons();
  }, 250));

  // Source filter
  document.getElementById('sourceFilter')?.addEventListener('change', (e) => {
    currentSource = e.target.value;
    currentPage = 1;
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
