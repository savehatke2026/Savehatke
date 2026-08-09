// ============================================
// SaveHatke — Real-Time Marketplace Logic
// ============================================

let allCoupons = [];
let currentCategory = 'all';
let currentSource = '';
let searchQuery = '';
let currentPage = 1;
const PER_PAGE = 9;

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

  const resultsText = document.getElementById('resultsText');
  if (resultsText) {
    resultsText.textContent =
      filtered.length === 0
        ? 'No coupons found in database'
        : `Showing ${filtered.length} verified coupon${filtered.length === 1 ? '' : 's'} from database`;
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

  const categoryEmojis = {
    'Makeup': '💄',
    'Electronics': '⚡',
    'Fashion': '👟',
    'Food': '🍔',
    'Travel': '✈️',
    'Health': '💊',
  };

  grid.innerHTML = coupons
    .map((c) => {
      const emoji = categoryEmojis[c.category] || '🏷️';
      const isFree = c.source === 'auto-scraped';
      const priceText = isFree ? 'FREE' : `₹${c.sellingPrice || '15'}`;
      const origVal = c.discount ? (c.discount.includes('%') || c.discount.includes('₹') ? c.discount : `₹${c.discount} OFF`) : (c.originalValue ? `₹${c.originalValue} OFF` : 'SPECIAL OFFER');

      return `
        <div class="coupon-card">
          ${isFree ? '<span class="cfree-badge">FREE</span>' : '<div class="cverified">✓ VERIFIED DEAL</div>'}
          <div class="ctop">
            <div class="cbrand">${emoji} ${c.brand}</div>
            <div class="coff">${origVal}</div>
          </div>
          <div class="cdesc">${c.title || c.description || 'Verified Discount Offer'}</div>
          <div class="cmeta">
            <div>
              <span class="clbl">Selling Price</span>
              <span class="cval">${priceText}</span>
            </div>
            <span class="ccat ${c.category}">${c.category}</span>
          </div>
          <button class="cbuy-btn" onclick="buyCoupon('${c.id}', ${isFree})">
            ${isFree ? 'Get Free Code →' : 'Buy Coupon →'}
          </button>
        </div>
      `;
    })
    .join('');
}

function renderPagination(totalPages) {
  const bar = document.getElementById('paginationBar');
  const pagesSpan = document.getElementById('pgPages');
  const prevBtn = document.getElementById('pgPrev');
  const nextBtn = document.getElementById('pgNext');

  if (!bar || totalPages <= 1) {
    if (bar) bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';
  if (prevBtn) prevBtn.disabled = currentPage <= 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;

  let pagesHtml = '';
  for (let i = 1; i <= totalPages; i++) {
    pagesHtml += `<button class="pg-btn ${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
  }
  if (pagesSpan) pagesSpan.innerHTML = pagesHtml;
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

async function buyCoupon(id, isFree) {
  if (typeof Auth !== 'undefined' && !Auth.isLoggedIn()) {
    if (typeof showToast === 'function') showToast('Please log in to buy coupons.', 'warning');
    if (typeof openAuthModal === 'function') openAuthModal('login');
    else window.location.href = 'login.html';
    return;
  }

  const confirmMsg = isFree
    ? 'Get this free coupon code?'
    : 'Purchase this coupon? The code will be revealed instantly in your dashboard.';

  if (!confirm(confirmMsg)) return;

  try {
    const data = await api(`/coupons/buy/${id}`, { method: 'POST' });
    if (typeof showToast === 'function') showToast(`🎉 Coupon purchased! Code: ${data.coupon.code}`, 'success', 8000);

    showCouponModal(data.coupon);
    loadCoupons();
  } catch (err) {
    if (typeof showToast === 'function') showToast(err.message, 'error');
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
      <a href="dashboard.html" class="btn btn-ghost btn-sm" style="margin-top: 16px;">View in Dashboard</a>
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
