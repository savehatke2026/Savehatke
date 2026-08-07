// ============================================
// SaveHatke — Admin Panel Logic
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  if (Auth.isAdminLoggedIn()) {
    showAdminDashboard();
  }

  initAdminLogin();
  initAdminTabs();
  initAddCouponForm();
});

// ── Admin Login ─────────────────────────────────────────────────────────
function initAdminLogin() {
  const form = document.getElementById('adminLoginForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('adminLoginBtn');
    btn.disabled = true;
    btn.textContent = 'Authenticating...';

    try {
      const username = document.getElementById('adminUsername').value;
      const password = document.getElementById('adminPassword').value;

      const data = await api('/admin/login', {
        method: 'POST',
        body: { username, password },
      });

      Auth.setAdminAuth(data.token, data.user);
      showToast('Admin access granted. 🔐', 'success');
      showAdminDashboard();
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });
}

function showAdminDashboard() {
  document.getElementById('adminLoginGate').style.display = 'none';
  document.getElementById('adminDashboard').style.display = 'block';
  document.getElementById('adminLogoutBtn').style.display = 'inline-flex';
  loadAdminStats();
}

function adminLogout() {
  Auth.clearAdmin();
  document.getElementById('adminLoginGate').style.display = 'block';
  document.getElementById('adminDashboard').style.display = 'none';
  document.getElementById('adminLogoutBtn').style.display = 'none';
  showToast('Logged out.', 'info');
}

// ── Admin Stats ─────────────────────────────────────────────────────────
async function loadAdminStats() {
  try {
    const data = await api('/admin/stats', { useAdmin: true });
    const s = data.stats;

    document.getElementById('statUsers').textContent = s.totalUsers;
    document.getElementById('statCoupons').textContent = s.availableCoupons;
    document.getElementById('statPending').textContent = s.pendingCoupons;
    document.getElementById('statRevenue').textContent = s.revenue;
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// ── Admin Tabs ──────────────────────────────────────────────────────────
function initAdminTabs() {
  document.querySelectorAll('#adminTabs .category-pill').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#adminTabs .category-pill').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      document.querySelectorAll('.admin-tab').forEach((t) => (t.style.display = 'none'));
      const target = document.getElementById(`tab-${tab.dataset.tab}`);
      if (target) {
        target.style.display = 'block';
        if (tab.dataset.tab === 'inventory') loadInventory();
        if (tab.dataset.tab === 'pending') loadPending();
      }
    });
  });
}

// ── Add Coupon Form ─────────────────────────────────────────────────────
function initAddCouponForm() {
  const form = document.getElementById('addCouponForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('addCouponBtn');
    btn.disabled = true;
    btn.textContent = 'Adding...';

    try {
      const data = await api('/admin/coupons', {
        method: 'POST',
        useAdmin: true,
        body: {
          code: document.getElementById('acCode').value.trim(),
          brand: document.getElementById('acBrand').value.trim(),
          category: document.getElementById('acCategory').value,
          originalValue: document.getElementById('acValue').value.trim(),
          description: document.getElementById('acDescription').value.trim(),
          sellingPrice: document.getElementById('acPrice').value.trim(),
        },
      });

      showToast(data.message, 'success');
      form.reset();
      document.getElementById('acPrice').value = '20';
      loadAdminStats();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '➕ Add Coupon to Inventory';
    }
  });
}

// ── Inventory ───────────────────────────────────────────────────────────
async function loadInventory() {
  const container = document.getElementById('inventoryTable');
  if (!container) return;

  try {
    const status = document.getElementById('invStatusFilter')?.value || '';
    const data = await api(`/admin/coupons${status ? `?status=${status}` : ''}`, { useAdmin: true });

    if (data.coupons.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📋</div>
          <h3>No coupons in inventory</h3>
          <p>Add your first coupon using the form above.</p>
        </div>
      `;
      return;
    }

    const search = document.getElementById('invSearch')?.value?.toLowerCase() || '';
    let coupons = data.coupons;
    if (search) {
      coupons = coupons.filter(
        (c) => c.code.toLowerCase().includes(search) || c.brand.toLowerCase().includes(search)
      );
    }

    container.innerHTML = `
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Brand</th>
              <th>Category</th>
              <th>Value</th>
              <th>Price</th>
              <th>Source</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${coupons.map((c) => {
              const statusBadge = c.status === 'sold' ? 'green' : c.status === 'pending' ? 'amber' : 'blue';
              const sourceBadge = c.source === 'admin' ? 'purple' : c.source === 'auto-scraped' ? 'teal' : 'blue';
              return `
                <tr>
                  <td><code style="background: rgba(37,99,235,0.1); padding: 2px 8px; border-radius: 4px; color: var(--color-teal-400); font-weight: 600;">${c.code}</code></td>
                  <td>${c.brand}</td>
                  <td>${c.category}</td>
                  <td>₹${c.originalValue || '—'}</td>
                  <td style="font-weight: 700;">₹${c.sellingPrice}</td>
                  <td><span class="badge badge-${sourceBadge}">${c.source}</span></td>
                  <td><span class="badge badge-${statusBadge}">${c.status}</span></td>
                  <td>
                    <div style="display: flex; gap: 0.25rem;">
                      ${c.status === 'pending' ? `<button class="btn btn-success btn-sm" onclick="approveCoupon('${c.id}')">✓</button>` : ''}
                      <button class="btn btn-danger btn-sm" onclick="deleteCoupon('${c.id}')">🗑</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div style="padding: var(--space-4); color: var(--color-slate-500); font-size: 0.75rem;">
        Showing ${coupons.length} of ${data.total} coupons
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<p class="text-danger">Failed to load inventory: ${err.message}</p>`;
  }

  // Attach filter listeners
  document.getElementById('invSearch')?.addEventListener('input', debounce(loadInventory, 300));
  document.getElementById('invStatusFilter')?.addEventListener('change', loadInventory);
}

// ── Pending Submissions ─────────────────────────────────────────────────
async function loadPending() {
  const container = document.getElementById('pendingList');
  if (!container) return;

  try {
    const data = await api('/admin/coupons?status=pending', { useAdmin: true });

    if (data.coupons.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">✅</div>
          <h3>All caught up!</h3>
          <p>No pending coupon submissions to review.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = data.coupons.map((c) => `
      <div class="card mb-4" style="display: flex; align-items: center; gap: var(--space-5); flex-wrap: wrap;">
        <div style="flex: 1; min-width: 200px;">
          <div style="font-weight: 700; color: var(--color-white); margin-bottom: 0.25rem;">${c.brand} — ${c.category}</div>
          <code style="background: rgba(37,99,235,0.1); padding: 2px 8px; border-radius: 4px; color: var(--color-teal-400); font-weight: 600;">${c.code}</code>
          <div style="font-size: 0.75rem; color: var(--color-slate-500); margin-top: 0.5rem;">${c.description || 'No description'}</div>
          <div style="font-size: 0.75rem; color: var(--color-slate-500);">Submitted by: ${c.sellerEmail} · ${formatDate(c.addedAt)}</div>
        </div>
        <div style="display: flex; gap: 0.5rem;">
          <button class="btn btn-success btn-sm" onclick="approveCoupon('${c.id}')">✅ Approve</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCoupon('${c.id}')">🗑 Reject</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<p class="text-danger">Failed to load: ${err.message}</p>`;
  }
}

// ── Actions ─────────────────────────────────────────────────────────────
async function approveCoupon(id) {
  try {
    await api(`/admin/coupons/${id}`, {
      method: 'PUT',
      useAdmin: true,
      body: { status: 'available' },
    });
    showToast('Coupon approved and now live! ✅', 'success');
    loadAdminStats();
    loadPending();
    loadInventory();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteCoupon(id) {
  if (!confirm('Delete this coupon permanently?')) return;
  try {
    await api(`/admin/coupons/${id}`, {
      method: 'DELETE',
      useAdmin: true,
    });
    showToast('Coupon deleted.', 'info');
    loadAdminStats();
    loadPending();
    loadInventory();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}
