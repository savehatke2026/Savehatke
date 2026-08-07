// ============================================
// SaveHatke — Dashboard Logic
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  if (!requireAuth()) return;

  const user = Auth.getUser();
  const greeting = document.getElementById('dashGreeting');
  if (greeting && user) {
    greeting.textContent = `Welcome back, ${user.name}! Here's your savings overview.`;
  }

  initDashTabs();
  loadTrackedProducts();
  initAddTracker();
});

// ── Dashboard Tabs ──────────────────────────────────────────────────────
function initDashTabs() {
  const tabs = document.querySelectorAll('#dashTabs .category-pill');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      document.querySelectorAll('.dash-tab').forEach((t) => (t.style.display = 'none'));
      const target = document.getElementById(`tab-${tab.dataset.tab}`);
      if (target) {
        target.style.display = 'block';
        // Load data for the tab
        if (tab.dataset.tab === 'purchases') loadPurchases();
        if (tab.dataset.tab === 'sales') loadSales();
      }
    });
  });
}

// ── Price Tracker ───────────────────────────────────────────────────────
function initAddTracker() {
  const form = document.getElementById('addTrackerForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('addTrackerBtn');
    btn.disabled = true;
    btn.textContent = 'Tracking...';

    try {
      const productUrl = document.getElementById('productUrl').value;
      const targetPrice = document.getElementById('targetPrice').value;

      await api('/tracker/add', {
        method: 'POST',
        body: { productUrl, targetPrice: targetPrice || undefined },
      });

      showToast('Product added to your tracking list! 📊', 'success');
      form.reset();
      loadTrackedProducts();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '+ Track Price';
    }
  });
}

async function loadTrackedProducts() {
  const container = document.getElementById('trackedProducts');
  if (!container) return;

  try {
    const data = await api('/tracker/list');
    renderTrackedProducts(container, data.products);
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📊</div>
        <h3>Start Tracking Prices</h3>
        <p>Paste a product URL above to track its price and get alerts when it drops.</p>
      </div>
    `;
  }
}

function renderTrackedProducts(container, products) {
  if (products.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📊</div>
        <h3>No products tracked yet</h3>
        <p>Paste a product URL above to start tracking prices.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = products.map((p) => {
    const platformClass = p.platform.toLowerCase();
    const priceChange = Number(p.currentPrice) <= Number(p.lowestPrice) ? 'low' : '';

    return `
      <div class="tracker-card mb-4">
        <div class="tracker-platform ${platformClass}">
          ${p.platform.slice(0, 3).toUpperCase()}
        </div>
        <div class="tracker-info">
          <div class="tracker-name">${p.productName}</div>
          <div class="tracker-url">${p.productUrl}</div>
        </div>
        <div class="tracker-prices">
          <div class="tracker-price-item">
            <div class="tracker-price-label">Current</div>
            <div class="tracker-price-value ${priceChange}">₹${Number(p.currentPrice).toLocaleString('en-IN')}</div>
          </div>
          <div class="tracker-price-item">
            <div class="tracker-price-label">Target</div>
            <div class="tracker-price-value target">₹${Number(p.targetPrice).toLocaleString('en-IN')}</div>
          </div>
          <div class="tracker-price-item">
            <div class="tracker-price-label">Lowest</div>
            <div class="tracker-price-value low">₹${Number(p.lowestPrice).toLocaleString('en-IN')}</div>
          </div>
        </div>
        <div class="tracker-actions">
          <button class="btn btn-ghost btn-sm" onclick="refreshPrice('${p.id}')" title="Refresh price">🔄</button>
          <button class="btn btn-ghost btn-sm text-danger" onclick="removeTracker('${p.id}')" title="Stop tracking">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

async function refreshPrice(id) {
  try {
    const data = await api(`/tracker/check/${id}`);
    showToast(data.message, data.product.belowTarget ? 'success' : 'info');
    loadTrackedProducts();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function removeTracker(id) {
  if (!confirm('Stop tracking this product?')) return;
  try {
    await api(`/tracker/${id}`, { method: 'DELETE' });
    showToast('Product removed from tracking.', 'info');
    loadTrackedProducts();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── My Purchases ────────────────────────────────────────────────────────
async function loadPurchases() {
  const container = document.getElementById('purchasesList');
  if (!container) return;

  try {
    const data = await api('/coupons/my-purchases');

    if (data.coupons.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🛒</div>
          <h3>No purchases yet</h3>
          <p>Browse the marketplace to find great deals on coupons.</p>
          <a href="marketplace.html" class="btn btn-primary">Browse Coupons</a>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>Brand</th>
              <th>Category</th>
              <th>Code</th>
              <th>Description</th>
              <th>Worth</th>
              <th>Paid</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            ${data.coupons.map((c) => `
              <tr>
                <td><strong>${c.brand}</strong></td>
                <td><span class="badge badge-blue">${c.category}</span></td>
                <td><code style="background: rgba(37,99,235,0.1); padding: 2px 8px; border-radius: 4px; color: var(--color-teal-400); font-weight: 600;">${c.code}</code></td>
                <td>${c.description || '—'}</td>
                <td>₹${c.originalValue}</td>
                <td style="color: var(--color-success); font-weight: 700;">₹${c.pricePaid}</td>
                <td>${formatDate(c.purchasedAt)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🛒</div>
        <h3>No purchases yet</h3>
        <p>Browse the marketplace to find great deals on coupons.</p>
        <a href="marketplace.html" class="btn btn-primary">Browse Coupons</a>
      </div>
    `;
  }
}

// ── My Sales ────────────────────────────────────────────────────────────
async function loadSales() {
  const container = document.getElementById('salesList');
  if (!container) return;

  try {
    const data = await api('/coupons/my-sales');

    if (data.coupons.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">💰</div>
          <h3>No coupons sold yet</h3>
          <p>Have unused coupons? Sell them and earn ₹10 each!</p>
          <a href="sell.html" class="btn btn-success">Sell Coupons</a>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Brand</th>
              <th>Category</th>
              <th>Status</th>
              <th>Earning</th>
              <th>Submitted</th>
              <th>Sold</th>
            </tr>
          </thead>
          <tbody>
            ${data.coupons.map((c) => {
              const statusBadge = c.status === 'sold' ? 'green' : c.status === 'pending' ? 'amber' : 'blue';
              return `
                <tr>
                  <td><code style="background: rgba(37,99,235,0.1); padding: 2px 8px; border-radius: 4px; color: var(--color-teal-400);">${c.code}</code></td>
                  <td>${c.brand}</td>
                  <td>${c.category}</td>
                  <td><span class="badge badge-${statusBadge}">${c.status}</span></td>
                  <td style="color: var(--color-success); font-weight: 700;">${c.earning}</td>
                  <td>${formatDate(c.addedAt)}</td>
                  <td>${formatDate(c.soldAt)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">💰</div>
        <h3>No coupons sold yet</h3>
        <p>Have unused coupons? Sell them and earn ₹10 each!</p>
        <a href="sell.html" class="btn btn-success">Sell Coupons</a>
      </div>
    `;
  }
}
