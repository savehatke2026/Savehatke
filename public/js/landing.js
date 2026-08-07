// ============================================
// SaveHatke — Landing Page Logic
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  loadPreviewCoupons();
  initCategoryPills();
});

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
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div class="empty-state-icon">🏷️</div>
        <h3>No coupons yet</h3>
        <p>Check back soon — fresh coupons are added daily!</p>
      </div>
    `;
    return;
  }

  const categoryColors = {
    'Makeup': { bg: 'rgba(236, 72, 153, 0.1)', color: '#ec4899', emoji: '💄' },
    'Electronics': { bg: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6', emoji: '⚡' },
    'Fashion': { bg: 'rgba(168, 85, 247, 0.1)', color: '#a855f7', emoji: '👟' },
    'Food': { bg: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b', emoji: '🍔' },
  };

  grid.innerHTML = coupons.map((c) => {
    const cat = categoryColors[c.category] || { bg: 'rgba(37, 99, 235, 0.1)', color: '#3b82f6', emoji: '🏷️' };
    const sourceLabel = c.source === 'auto-scraped' ? 'FREE' : `₹${c.sellingPrice}`;
    const isFree = c.source === 'auto-scraped';

    return `
      <div class="coupon-card">
        <div class="coupon-card-header">
          <div class="coupon-brand">
            <div class="coupon-brand-logo" style="background: ${cat.bg}; color: ${cat.color};">
              ${cat.emoji}
            </div>
            <div>
              <div class="coupon-brand-name">${c.brand}</div>
              <span class="badge badge-${getCategoryBadge(c.category)}" style="font-size: 0.65rem;">${c.category}</span>
            </div>
          </div>
          ${isFree ? '<span class="badge badge-green">FREE</span>' : ''}
        </div>
        <div class="coupon-card-body">
          <p class="coupon-description">${c.description || 'Discount code available'}</p>
          <div class="coupon-value">
            <span class="coupon-original-price">Worth ₹${c.originalValue}</span>
            <span class="coupon-price">${sourceLabel}</span>
          </div>
        </div>
        <div class="coupon-card-footer">
          <span style="font-size: 0.75rem; color: var(--color-slate-500);">${formatTimeAgo(c.addedAt)}</span>
          ${isFree
            ? `<button class="btn btn-success btn-sm" onclick="window.location.href='marketplace.html'">Get Free Code</button>`
            : `<button class="btn btn-primary btn-sm" onclick="window.location.href='marketplace.html'">Buy Now</button>`
          }
        </div>
      </div>
    `;
  }).join('');
}

function getCategoryBadge(category) {
  const map = { 'Makeup': 'purple', 'Electronics': 'blue', 'Fashion': 'teal', 'Food': 'amber' };
  return map[category] || 'blue';
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
    { id: 'c001', category: 'Makeup', brand: 'Nykaa', description: '₹200 off on orders above ₹999', originalValue: '200', sellingPrice: '20', source: 'user-submitted', addedAt: new Date(Date.now() - 3600000).toISOString() },
    { id: 'c002', category: 'Fashion', brand: 'Puma', description: 'Flat 30% off on Puma shoes', originalValue: '500', sellingPrice: '25', source: 'user-submitted', addedAt: new Date(Date.now() - 7200000).toISOString() },
    { id: 'c003', category: 'Electronics', brand: 'boAt', description: '15% off on boAt earbuds', originalValue: '300', sellingPrice: '20', source: 'admin', addedAt: new Date(Date.now() - 10800000).toISOString() },
    { id: 'c004', category: 'Food', brand: 'Swiggy', description: '₹100 off on first 3 orders', originalValue: '100', sellingPrice: '15', source: 'admin', addedAt: new Date(Date.now() - 14400000).toISOString() },
    { id: 'c005', category: 'Fashion', brand: 'Myntra', description: '₹500 off on ₹2000+ purchase', originalValue: '500', sellingPrice: '30', source: 'user-submitted', addedAt: new Date(Date.now() - 18000000).toISOString() },
    { id: 'c006', category: 'Makeup', brand: 'Mamaearth', description: '20% off on skincare range', originalValue: '250', sellingPrice: '0', source: 'auto-scraped', addedAt: new Date(Date.now() - 21600000).toISOString() },
  ];
}
