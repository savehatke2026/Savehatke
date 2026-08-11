// ============================================
// SaveHatke — Admin Panel Logic
// ============================================

function initAdminApp() {
  if (!Auth.isAdminLoggedIn()) {
    window.location.href = 'login.html';
    return;
  }

  renderCurrentAdminProfile();
  showAdminDashboard();
  initAdminTabs();
  initAddCouponForm();
  initCreateAdminForm();
  loadSystemSettings();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAdminApp);
} else {
  initAdminApp();
}

// ── Admin Dashboard Initializer ─────────────────────────────────────────
function showAdminDashboard() {
  const gate = document.getElementById('adminLoginGate');
  if (gate) gate.style.display = 'none';

  const dash = document.getElementById('adminDashboard');
  if (dash) dash.style.display = 'block';

  loadAdminStats();
}

function renderCurrentAdminProfile() {
  const adminUser = Auth.getAdminUser() || {};
  const name = adminUser.name || adminUser.full_name || 'Admin User';
  const email = adminUser.email || '';
  const role = adminUser.role || 'Super Admin';

  const initials = name ? name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'SA';

  const avatarEl = document.getElementById('currentAdminAvatar');
  if (avatarEl) {
    if (adminUser.profile_image) {
      avatarEl.innerHTML = `<img src="${adminUser.profile_image}" alt="${name}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />`;
    } else {
      avatarEl.textContent = initials;
    }
  }

  const nameEl = document.getElementById('currentAdminName');
  if (nameEl) nameEl.textContent = name;

  const roleEl = document.getElementById('currentAdminEmail');
  if (roleEl) roleEl.textContent = `${role} · ${email}`;

  // Topbar elements
  const topbarName = document.getElementById('topbarAdminName');
  if (topbarName) topbarName.textContent = name;

  const topbarAvatar = document.getElementById('topbarAdminAvatar');
  if (topbarAvatar) {
    if (adminUser.profile_image) {
      topbarAvatar.innerHTML = `<img src="${adminUser.profile_image}" alt="${name}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />`;
    } else {
      topbarAvatar.textContent = initials.slice(0, 1);
    }
  }
}

function adminLogout() {
  Auth.clearAdmin();
  Auth.clear();
  window.location.href = 'login.html';
}

// ── Admin Stats ─────────────────────────────────────────────────────────
async function loadAdminStats() {
  try {
    const data = await api('/admin/stats', { useAdmin: true });
    const s = data.stats;

    const uEl = document.getElementById('statUsers');
    if (uEl) uEl.textContent = s.totalUsers;
    const cEl = document.getElementById('statCoupons');
    if (cEl) cEl.textContent = s.availableCoupons;
    const pEl = document.getElementById('statPending');
    if (pEl) pEl.textContent = s.pendingCoupons;
    const rEl = document.getElementById('statRevenue');
    if (rEl) rEl.textContent = s.revenue;
  } catch (err) {
    console.warn('Stats warning:', err.message);
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
        if (tab.dataset.tab === 'admins') loadAdminsList();
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
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Publishing Coupon...';
    }

    try {
      const code = document.getElementById('acCode')?.value?.trim() || '';
      const brand = document.getElementById('acBrand')?.value?.trim() || '';
      const title = document.getElementById('acTitle')?.value?.trim() || '';
      const type = document.getElementById('acType')?.value?.trim() || 'Public';
      const category = document.getElementById('acCategory')?.value || 'General';
      const discount = document.getElementById('acDiscount')?.value?.trim() || '';
      const originalValue = document.getElementById('acValue')?.value?.trim() || discount || '0';
      const minOrderValue = document.getElementById('acMinOrder')?.value?.trim() || '';
      const validFrom = document.getElementById('acValidFrom')?.value || '';
      const expiryDate = document.getElementById('acExpiry')?.value || '';
      const affiliateLink = document.getElementById('acLink')?.value?.trim() || '';
      const terms = document.getElementById('acTerms')?.value?.trim() || '';
      const description = title || discount || '';
      const sellingPrice = document.getElementById('acPrice')?.value?.trim() || '15';
      const status = document.getElementById('acStatus')?.value || 'available';
      const source = document.getElementById('acSource')?.value || 'admin';
      const isFeatured = !!document.getElementById('acFeatured')?.checked;
      const isExclusive = !!document.getElementById('acExclusive')?.checked;
      const isVerified = !!document.getElementById('acVerified')?.checked;

      if (!code || !brand) {
        showToast('Please select a Brand and enter a Coupon Code.', 'warning');
        return;
      }

      const data = await api('/admin/coupons', {
        method: 'POST',
        useAdmin: true,
        body: {
          code,
          brand,
          category,
          title,
          type,
          discount,
          originalValue,
          minOrderValue,
          validFrom,
          expiryDate,
          affiliateLink,
          terms,
          description,
          sellingPrice,
          status,
          source,
          isFeatured,
          isExclusive,
          isVerified,
        },
      });

      showToast(data.message || 'Coupon published successfully! 🚀', 'success');
      resetAddCouponForm(form);

      // Automatically switch to All Coupons tab
      if (typeof showCouponTab === 'function') {
        const allTabBtn = document.querySelector('#sec-coupons .tab-btn');
        showCouponTab('all', allTabBtn);
      }

      if (typeof loadInventory === 'function') loadInventory();
      if (typeof loadAdminStats === 'function') loadAdminStats();
    } catch (err) {
      showToast(err.message || 'Failed to publish coupon.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🎟️ Publish Coupon';
      }
    }
  });
}

function resetAddCouponForm(form) {
  form.reset();

  const brandInput = document.getElementById('acBrand');
  if (brandInput) brandInput.value = '';

  const brandSelectedText = document.getElementById('brandSelectedText');
  if (brandSelectedText) {
    brandSelectedText.innerHTML = `
      <span class="brand-logo-fallback">🏬</span>
      <span>— Select Brand —</span>
    `;
  }
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
  const badge = document.getElementById('pendingTabBadge');

  try {
    const data = await api('/admin/coupons?status=pending', { useAdmin: true });
    const count = data.coupons ? data.coupons.length : 0;

    if (badge) {
      if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }

    if (!container) return;

    if (count === 0) {
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
          <div style="font-size: 0.75rem; color: var(--color-slate-500);">Submitted by: ${c.sellerEmail || 'Admin'} · ${formatDate(c.addedAt)}</div>
        </div>
        <div style="display: flex; gap: 0.5rem;">
          <button class="btn btn-success btn-sm" onclick="approveCoupon('${c.id}')">✅ Approve</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCoupon('${c.id}')">🗑 Reject</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    if (container) container.innerHTML = `<p class="text-danger">Failed to load: ${err.message}</p>`;
  }
}

// ── Active Coupons ──────────────────────────────────────────────────────
async function loadActiveCoupons() {
  const container = document.getElementById('activeList');
  if (!container) return;

  try {
    const data = await api('/admin/coupons?status=available', { useAdmin: true });
    if (data.coupons.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🏷️</div>
          <h3>No active coupons found</h3>
          <p>Publish a new coupon to make it active.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = data.coupons.map((c) => `
      <div class="coupon-item" style="margin-bottom: 8px;">
        <div class="ci-brand">🏷️</div>
        <div class="ci-body">
          <div class="ci-name">${c.brand} — ${c.title || c.description || c.discount || 'Active Offer'}</div>
          <div class="ci-code">${c.code}</div>
          <div class="ci-meta">
            <span class="badge badge-green">Active</span>
            <span class="badge badge-blue">${c.category}</span>
            <span style="font-size:.78rem;color:#a8c0dc">₹${c.sellingPrice} · ${c.source}</span>
          </div>
        </div>
        <div class="ci-actions">
          <button class="btn btn-danger btn-sm" onclick="deleteCoupon('${c.id}')">🗑 Delete</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<p class="text-danger">Failed to load active coupons: ${err.message}</p>`;
  }
}

// ── Expired Coupons ─────────────────────────────────────────────────────
async function loadExpiredCoupons() {
  const container = document.getElementById('expiredList');
  if (!container) return;

  try {
    const data = await api('/admin/coupons?status=expired', { useAdmin: true });
    if (data.coupons.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🎉</div>
          <h3>No expired coupons</h3>
          <p>All active coupons are valid and up to date.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = data.coupons.map((c) => `
      <div class="coupon-item" style="opacity:.6; margin-bottom: 8px;">
        <div class="ci-brand">⏰</div>
        <div class="ci-body">
          <div class="ci-name">${c.brand} — ${c.code}</div>
          <div class="ci-meta"><span class="badge badge-red">Expired</span></div>
        </div>
        <div class="ci-actions">
          <button class="btn btn-danger btn-sm" onclick="deleteCoupon('${c.id}')">🗑 Delete</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<p class="text-danger">Failed to load expired coupons: ${err.message}</p>`;
  }
}

// Global functions for inline onclick handlers
window.loadInventory = loadInventory;
window.loadPending = loadPending;
window.loadActiveCoupons = loadActiveCoupons;
window.loadExpiredCoupons = loadExpiredCoupons;

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
    loadActiveCoupons();
    loadExpiredCoupons();
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

// ── Admin User Management (MongoDB Atlas) ───────────────────────────────
function initCreateAdminForm() {
  const form = document.getElementById('createAdminForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('createAdminBtn');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
      const data = await api('/admin/create-admin', {
        method: 'POST',
        useAdmin: true,
        body: {
          name: document.getElementById('newAdminName').value.trim(),
          email: document.getElementById('newAdminEmail').value.trim(),
          password: document.getElementById('newAdminPassword').value,
          role: document.getElementById('newAdminRole').value,
          phone: document.getElementById('newAdminPhone').value.trim(),
          profile_image: document.getElementById('newAdminAvatar').value.trim(),
        },
      });

      showToast(data.message, 'success');
      form.reset();
      loadAdminsList();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '➕ Create Admin in MongoDB Atlas';
    }
  });
}

async function loadAdminsList() {
  const container = document.getElementById('adminsTableContainer');
  if (!container) return;

  try {
    const data = await api('/admin/list-admins', { useAdmin: true });
    const admins = data.admins || [];

    if (admins.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">👥</div>
          <h3>No admin accounts found</h3>
          <p>Create your first admin account using the form above.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>Realtime ID</th>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Phone</th>
              <th>Status</th>
              <th>Last Login</th>
              <th>Created At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${admins.map((a) => {
              const roleBadge = a.role === 'Super Admin' ? 'purple' : a.role === 'Support' ? 'teal' : 'blue';
              const statusBadge = a.is_active ? 'green' : 'red';
              const realId = a.id || a._id;
              const adminName = a.name || a.full_name || 'Admin';
              const lastLoginFormatted = a.last_login ? new Date(a.last_login).toLocaleString('en-IN') : 'Never';
              const createdAtFormatted = a.created_at ? new Date(a.created_at).toLocaleDateString('en-IN') : '—';

              return `
                <tr>
                  <td><code style="background: rgba(37,99,235,0.1); padding: 2px 6px; border-radius: 4px; color: var(--color-gold-400); font-size: 0.75rem;">${realId.substring(0, 8)}...</code></td>
                  <td style="font-weight: 600; color: var(--color-white);">
                    <div style="display: flex; align-items: center; gap: 8px;">
                      ${a.profile_image ? `<img src="${a.profile_image}" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover;">` : '👤'}
                      <span>${adminName}</span>
                    </div>
                  </td>
                  <td>${a.email}</td>
                  <td><span class="badge badge-${roleBadge}">${a.role}</span></td>
                  <td>${a.phone || '—'}</td>
                  <td><span class="badge badge-${statusBadge}">${a.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td style="font-size: 0.75rem; color: var(--color-slate-400);">${lastLoginFormatted}</td>
                  <td style="font-size: 0.75rem; color: var(--color-slate-400);">${createdAtFormatted}</td>
                  <td>
                    <div style="display: flex; gap: 4px;">
                      <button class="btn btn-ghost btn-sm" onclick="toggleAdminStatus('${realId}', ${!a.is_active})">
                        ${a.is_active ? '⏸️' : '▶️'}
                      </button>
                      <button class="btn btn-danger btn-sm" onclick="deleteAdminUser('${realId}')">🗑</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div style="padding: var(--space-4); color: var(--color-slate-500); font-size: 0.75rem;">
        Total Admins in MongoDB Atlas: ${admins.length}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<p class="text-danger">Failed to load admin list: ${err.message}</p>`;
  }
}

async function toggleAdminStatus(id, newActiveState) {
  try {
    await api(`/admin/update-admin/${id}`, {
      method: 'PUT',
      useAdmin: true,
      body: { is_active: newActiveState },
    });
    showToast(`Admin account status updated.`, 'success');
    loadAdminsList();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteAdminUser(id) {
  if (!confirm('Are you sure you want to delete this admin account from MongoDB Atlas?')) return;
  try {
    await api(`/admin/delete-admin/${id}`, {
      method: 'DELETE',
      useAdmin: true,
    });
    showToast('Admin account deleted.', 'info');
    loadAdminsList();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── System Settings Handlers ──────────────────────────────────────────────
async function loadSystemSettings() {
  try {
    const data = await api('/admin/settings', { useAdmin: true });
    if (data && data.settings) {
      const s = data.settings;
      if (document.getElementById('setActiveUsers')) document.getElementById('setActiveUsers').value = s.activeUsers || '10K+';
      if (document.getElementById('setCouponsTraded')) document.getElementById('setCouponsTraded').value = s.couponsTraded || '50K+';
      if (document.getElementById('setSavedByUsers')) document.getElementById('setSavedByUsers').value = s.savedByUsers || '₹2L+';
      if (document.getElementById('setPlatformName')) document.getElementById('setPlatformName').value = s.platformName || 'SaveHatke';
      if (document.getElementById('setAdminEmail')) document.getElementById('setAdminEmail').value = s.adminEmail || 'rupayandas2024@gmail.com';
    }
  } catch (err) {
    console.warn('Failed to load system settings:', err.message);
  }
}

async function saveSystemSettings() {
  const btn = document.getElementById('saveSettingsBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving Settings...';
  }

  try {
    const activeUsers = document.getElementById('setActiveUsers')?.value?.trim() || '10K+';
    const couponsTraded = document.getElementById('setCouponsTraded')?.value?.trim() || '50K+';
    const savedByUsers = document.getElementById('setSavedByUsers')?.value?.trim() || '₹2L+';
    const platformName = document.getElementById('setPlatformName')?.value?.trim() || 'SaveHatke';
    const adminEmail = document.getElementById('setAdminEmail')?.value?.trim() || 'rupayandas2024@gmail.com';

    const data = await api('/admin/settings', {
      method: 'PUT',
      useAdmin: true,
      body: {
        activeUsers,
        couponsTraded,
        savedByUsers,
        platformName,
        adminEmail,
      },
    });

    if (typeof showToast === 'function') {
      showToast(data.message || 'Website settings updated successfully! 📊', 'success');
    } else {
      alert(data.message || 'Website settings updated successfully!');
    }
  } catch (err) {
    if (typeof showToast === 'function') {
      showToast(err.message || 'Failed to save settings.', 'error');
    } else {
      alert(err.message || 'Failed to save settings.');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '💾 Save Website Settings';
    }
  }
}
