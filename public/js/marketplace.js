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
    allCoupons = data.coupons || [];
    renderFilteredCoupons();
  } catch (err) {
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
  const search = document.getElementById('searchInput')?.value?.toLowerCase() || '';
  if (search) {
    filtered = filtered.filter(
      (c) => (c.brand || '').toLowerCase().includes(search) || (c.description || '').toLowerCase().includes(search) || (c.title || '').toLowerCase().includes(search)
    );
  }

  // Source filter
  const source = document.getElementById('sourceFilter')?.value || '';
  if (source) {
    filtered = filtered.filter((c) => c.source === source);
  }

  const resultsText = document.getElementById('resultsText');
  if (resultsText) {
    resultsText.textContent = `Showing ${filtered.length} verified coupon${filtered.length === 1 ? '' : 's'} from database`;
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
      <div class="empty-state">
        <div class="empty-ico">🏷️</div>
        <div class="empty-title">No coupons found in database</div>
        <div class="empty-sub">Add your first coupon in the Admin panel or sell a coupon to make it appear here.</div>
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

  grid.innerHTML = coupons.map((c) => {
    const emoji = categoryEmojis[c.category] || '🏷️';
    const isFree = c.source === 'auto-scraped';
    const priceText = isFree ? 'FREE' : `₹${c.sellingPrice || '15'}`;
    const origVal = c.originalValue || c.discount || '100';

    return `
      <div class="coupon-card">
        ${isFree ? '<span class="cfree-badge">FREE</span>' : '<div class="cverified">✓ VERIFIED DEAL</div>'}
        <div class="ctop">
          <div class="cbrand">${emoji} ${c.brand}</div>
          <div class="coff">₹${origVal} OFF</div>
        </div>
        <div class="cdesc">${c.title || c.description || c.discount || 'Verified Discount Offer'}</div>
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
  }).join('');
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
  document.querySelectorAll('#categoryPills .cpill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#categoryPills .cpill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      currentCategory = pill.dataset.category || 'all';
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
