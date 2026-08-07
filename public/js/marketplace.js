// ============================================
// SaveHatke — Marketplace Logic
// ============================================

let allCoupons = [];
let currentCategory = 'all';

document.addEventListener('DOMContentLoaded', () => {
  loadCoupons();
  initFilters();

  // Check URL for pre-selected category
  const params = new URLSearchParams(window.location.search);
  const cat = params.get('cat');
  if (cat) {
    currentCategory = cat;
    document.querySelectorAll('#categoryPills .category-pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.category === cat);
    });
  }
});

async function loadCoupons() {
  try {
    const data = await api('/coupons');
    allCoupons = data.coupons;
    renderFilteredCoupons();
  } catch {
    allCoupons = getDemoMarketplaceCoupons();
    renderFilteredCoupons();
  }
}

function renderFilteredCoupons() {
  let filtered = [...allCoupons];

  // Category filter
  if (currentCategory !== 'all') {
    filtered = filtered.filter((c) => c.category === currentCategory);
  }

  // Search filter
  const search = document.getElementById('searchInput')?.value?.toLowerCase() || '';
  if (search) {
    filtered = filtered.filter(
      (c) => c.brand.toLowerCase().includes(search) || (c.description || '').toLowerCase().includes(search)
    );
  }

  // Source filter
  const source = document.getElementById('sourceFilter')?.value || '';
  if (source) {
    filtered = filtered.filter((c) => c.source === source);
  }

  // Separate paid and free coupons
  const paidCoupons = filtered.filter((c) => c.source !== 'auto-scraped');
  const freeCoupons = filtered.filter((c) => c.source === 'auto-scraped');

  renderCouponGrid('couponGrid', paidCoupons);

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
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div class="empty-state-icon">🏷️</div>
        <h3>No coupons found</h3>
        <p>Try changing your filters or check back later.</p>
      </div>
    `;
    return;
  }

  const categoryEmojis = {
    'Makeup': '💄',
    'Electronics': '🎧',
    'Fashion': '👟',
    'Food': '🍔',
  };

  const badgeClass = {
    'Makeup': 'badge-makeup',
    'Electronics': 'badge-electronics',
    'Fashion': 'badge-fashion',
    'Food': 'badge-food',
  };

  grid.innerHTML = coupons.map((c) => {
    const emoji = categoryEmojis[c.category] || '🏷️';
    const bClass = badgeClass[c.category] || 'badge-electronics';
    const isFree = c.source === 'auto-scraped';
    const priceText = isFree ? 'FREE' : `₹${c.sellingPrice || '20'}`;
    const origVal = c.originalValue || '500';
    const cJson = JSON.stringify(c).replace(/"/g, '&quot;');

    const origNum = Number(origVal) || 500;
    const sellNum = isFree ? 0 : (Number(c.sellingPrice) || 20);
    const savePct = Math.min(99, Math.max(85, Math.round(((origNum - sellNum) / origNum) * 100)));

    return `
      <div class="coupon-card">
        <div class="coupon-card-top">
          <div class="coupon-brand">${emoji} ${c.brand}</div>
          <span class="coupon-category-badge ${bClass}">${c.category}</span>
        </div>
        <div class="coupon-value">₹${origVal} OFF</div>
        <div class="coupon-value-label">${c.description || 'Face Value Discount'}</div>
        <div class="coupon-price-row">
          <div>
            <div class="coupon-price">${priceText}</div>
            <div class="coupon-price-label">Our Price</div>
          </div>
          <span class="coupon-discount-badge">Save ${savePct}%</span>
        </div>
        <div class="coupon-code-row">
          <span class="coupon-code">${c.code ? c.code.slice(0, 6) : 'SAVE2026'}</span>
          <span class="coupon-code-label">🔒 Unlock to reveal</span>
        </div>
        <button class="coupon-tc-btn" onclick="openCouponTermsModal(${cJson})">
          📜 Terms & How to Use
        </button>
        <button class="btn-coupon" onclick="buyCoupon('${c.id}', ${isFree})">
          ${isFree ? 'Get Free Code →' : 'Buy Coupon →'}
        </button>
      </div>
    `;
  }).join('');
}

function getCatBadge(category) {
  const map = { 'Makeup': 'purple', 'Electronics': 'blue', 'Fashion': 'teal', 'Food': 'amber' };
  return map[category] || 'blue';
}

async function buyCoupon(id, isFree) {
  if (!Auth.isLoggedIn()) {
    showToast('Please log in to buy coupons.', 'warning');
    openAuthModal('login');
    return;
  }

  const confirmMsg = isFree
    ? 'Get this free coupon code?'
    : 'Purchase this coupon? The code will be revealed in your dashboard.';

  if (!confirm(confirmMsg)) return;

  try {
    const data = await api(`/coupons/buy/${id}`, { method: 'POST' });
    showToast(`🎉 Coupon purchased! Code: ${data.coupon.code}`, 'success', 8000);

    // Show the code in a modal
    showCouponModal(data.coupon);
    loadCoupons();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function showCouponModal(coupon) {
  document.querySelector('.modal-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="text-align: center;">
      <div class="modal-header">
        <h2 class="modal-title">🎉 Coupon Purchased!</h2>
        <button class="modal-close" onclick="this.closest('.modal-overlay').classList.remove('active'); setTimeout(() => this.closest('.modal-overlay').remove(), 300)">×</button>
      </div>
      <div style="margin-bottom: var(--space-6);">
        <p style="color: var(--color-slate-400); margin-bottom: var(--space-4);">Here's your coupon code for <strong style="color: var(--color-white);">${coupon.brand}</strong>:</p>
        <div style="background: rgba(37, 99, 235, 0.1); border: 2px dashed var(--color-blue-500); border-radius: var(--radius-lg); padding: var(--space-5); margin-bottom: var(--space-4);">
          <code style="font-size: var(--font-size-2xl); font-weight: 800; color: var(--color-teal-400); letter-spacing: 2px;">${coupon.code}</code>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${coupon.code}'); showToast('Code copied!', 'success')">
          📋 Copy Code
        </button>
      </div>
      <p style="font-size: var(--font-size-xs); color: var(--color-slate-500);">
        ${coupon.description || ''}<br>
        Worth ₹${coupon.originalValue} · Paid ₹${coupon.pricePaid}
      </p>
      <a href="dashboard.html" class="btn btn-primary mt-4">View in Dashboard</a>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('active'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 300);
    }
  });
}

function initFilters() {
  // Category pills
  document.querySelectorAll('#categoryPills .category-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#categoryPills .category-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      currentCategory = pill.dataset.category;
      renderFilteredCoupons();
    });
  });

  // Search
  document.getElementById('searchInput')?.addEventListener('input', debounce(renderFilteredCoupons, 300));

  // Source filter
  document.getElementById('sourceFilter')?.addEventListener('change', renderFilteredCoupons);
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

function getDemoMarketplaceCoupons() {
  return [
    { id: 'c001', category: 'Makeup', brand: 'Nykaa', description: '₹200 off on orders above ₹999', originalValue: '200', sellingPrice: '20', source: 'user-submitted', addedAt: new Date(Date.now() - 3600000).toISOString() },
    { id: 'c002', category: 'Fashion', brand: 'Puma', description: 'Flat 30% off on Puma shoes', originalValue: '500', sellingPrice: '25', source: 'user-submitted', addedAt: new Date(Date.now() - 7200000).toISOString() },
    { id: 'c003', category: 'Electronics', brand: 'boAt', description: '15% off on boAt earbuds', originalValue: '300', sellingPrice: '20', source: 'admin', addedAt: new Date(Date.now() - 10800000).toISOString() },
    { id: 'c004', category: 'Food', brand: 'Swiggy', description: '₹100 off on first 3 orders', originalValue: '100', sellingPrice: '15', source: 'admin', addedAt: new Date(Date.now() - 14400000).toISOString() },
    { id: 'c005', category: 'Fashion', brand: 'Myntra', description: '₹500 off on ₹2000+ purchase', originalValue: '500', sellingPrice: '30', source: 'user-submitted', addedAt: new Date(Date.now() - 18000000).toISOString() },
    { id: 'c006', category: 'Makeup', brand: 'Mamaearth', description: '20% off on skincare range', originalValue: '250', sellingPrice: '0', source: 'auto-scraped', addedAt: new Date(Date.now() - 21600000).toISOString() },
    { id: 'c007', category: 'Electronics', brand: 'Croma', description: '10% off on electronics (max ₹1000)', originalValue: '1000', sellingPrice: '35', source: 'admin', addedAt: new Date(Date.now() - 25200000).toISOString() },
    { id: 'c008', category: 'Food', brand: 'Zomato', description: 'Free delivery on 5 orders', originalValue: '150', sellingPrice: '0', source: 'auto-scraped', addedAt: new Date(Date.now() - 28800000).toISOString() },
  ];
}
