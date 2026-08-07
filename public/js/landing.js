// ============================================
// SaveHatke — Landing Page Logic
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  initParticles();
  loadPreviewCoupons();
  initCategoryPills();
});

// ── Background Particle Animation ───────────────────────────────────────
function initParticles() {
  const container = document.getElementById('particles');
  if (!container) return;

  const count = 25;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = `${Math.random() * 100}%`;
    p.style.animationDuration = `${6 + Math.random() * 8}s`;
    p.style.animationDelay = `${Math.random() * 5}s`;
    container.appendChild(p);
  }
}

// ── Load Preview Coupons ────────────────────────────────────────────────
async function loadPreviewCoupons() {
  const grid = document.getElementById('previewCoupons');
  if (!grid) return;

  try {
    const data = await api('/coupons');
    renderCoupons(grid, data.coupons.slice(0, 6));
  } catch (err) {
    // Fallback demo data if API is not available
    renderCoupons(grid, getDemoCoupons());
  }
}

function renderCoupons(grid, coupons) {
  if (coupons.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1; text-align: center; padding: 48px;">
        <div style="font-size: 3rem; margin-bottom: 12px; opacity: 0.5;">🏷️</div>
        <h3 style="color: white; font-weight: 700;">No coupons found</h3>
        <p style="color: var(--slate-500); font-size: 0.875rem;">Check back soon — fresh coupons are added daily!</p>
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

    // Calculate discount % estimate
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
        <button class="btn-coupon" onclick="window.location.href='marketplace.html'">
          ${isFree ? 'Get Free Code →' : 'Get Coupon →'}
        </button>
      </div>
    `;
  }).join('');
}

// ── Category Pills ──────────────────────────────────────────────────────
function initCategoryPills() {
  const pills = document.querySelectorAll('#previewCategoryPills .category-pill');
  pills.forEach((pill) => {
    pill.addEventListener('click', async () => {
      pills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');

      const category = pill.dataset.category;
      const grid = document.getElementById('previewCoupons');

      try {
        const data = await api(`/coupons${category !== 'all' ? `?category=${category}` : ''}`);
        renderCoupons(grid, data.coupons.slice(0, 6));
      } catch {
        const all = getDemoCoupons();
        const filtered = category === 'all' ? all : all.filter((c) => c.category === category);
        renderCoupons(grid, filtered.slice(0, 6));
      }
    });
  });
}

// ── Demo Fallback Data ──────────────────────────────────────────────────
function getDemoCoupons() {
  return [
    { id: 'c001', category: 'Makeup', brand: 'Nykaa', description: '₹500 off on orders above ₹999', originalValue: '500', sellingPrice: '20', code: 'NYK500', source: 'user-submitted', addedAt: new Date(Date.now() - 3600000).toISOString() },
    { id: 'c002', category: 'Electronics', brand: 'boAt', description: '₹1,000 off on boAt audio', originalValue: '1000', sellingPrice: '35', code: 'BOAT1K', source: 'admin', addedAt: new Date(Date.now() - 7200000).toISOString() },
    { id: 'c003', category: 'Fashion', brand: 'Puma', description: '₹500 off on Puma shoes & wear', originalValue: '500', sellingPrice: '20', code: 'PUMA500', source: 'user-submitted', addedAt: new Date(Date.now() - 10800000).toISOString() },
    { id: 'c004', category: 'Food', brand: 'Swiggy', description: '₹200 off on food delivery', originalValue: '200', sellingPrice: '15', code: 'SWG200', source: 'admin', addedAt: new Date(Date.now() - 14400000).toISOString() },
    { id: 'c005', category: 'Makeup', brand: 'Lakme', description: '₹300 off on beauty products', originalValue: '300', sellingPrice: '15', code: 'LAK300', source: 'user-submitted', addedAt: new Date(Date.now() - 18000000).toISOString() },
    { id: 'c006', category: 'Electronics', brand: 'Samsung', description: '₹2,000 off on mobile & accessories', originalValue: '2000', sellingPrice: '50', code: 'SAM2K', source: 'admin', addedAt: new Date(Date.now() - 21600000).toISOString() },
  ];
}
