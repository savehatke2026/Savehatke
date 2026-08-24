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
  initUsersTableControls();
  initSessionsTableControls();
  initInventoryTableControls();
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
  if (roleEl) {
    // The element contains a Gmail icon <img> + a text <span>. Only update
    // the span so the icon (rendered by the markup) is preserved. Fall
    // back to textContent only if the span structure isn't present yet.
    const emailSpan = roleEl.querySelector('.su-email-text') || roleEl.querySelector('span');
    const text = `${role} · ${email}`;
    if (emailSpan) {
      emailSpan.textContent = text;
    } else {
      roleEl.textContent = text;
    }
    if (email) roleEl.setAttribute('title', text);
  }

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
  // Revoke the server-side 48h session (fire-and-forget; navigation follows)
  try {
    api('/auth/logout', { method: 'POST', useAdmin: true }).catch(() => {});
  } catch (e) {}
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

  const hiddenCategory = document.getElementById('acCategory');
  if (hiddenCategory) hiddenCategory.value = '';

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
let inventoryLoading = false;
let inventoryRequestSeq = 0;

async function loadInventory() {
  const container = document.getElementById('inventoryTable');
  if (!container) return;

  // Single-flight: if a previous call is still in flight, don't fire another
  // (tab clicks, search keystrokes, and 30s auto-refresh can all overlap).
  if (inventoryLoading) return;
  inventoryLoading = true;

  const seq = ++inventoryRequestSeq;
  try {
    const status = document.getElementById('invStatusFilter')?.value || '';
    const data = await api(`/admin/coupons${status ? `?status=${status}` : ''}`, { useAdmin: true });
    // If a newer request started while we were awaiting, drop this response
    if (seq !== inventoryRequestSeq) return;

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
    if (seq === inventoryRequestSeq) {
      container.innerHTML = `<p class="text-danger">Failed to load inventory: ${err.message}</p>`;
    }
  } finally {
    inventoryLoading = false;
  }
}

// One-time init for the inventory filter controls. The previous version bound
// these listeners inside loadInventory itself, so every call added another
// listener (memory leak + duplicate fires + extra rate-limit hits).
function initInventoryTableControls() {
  const search = document.getElementById('invSearch');
  const filter = document.getElementById('invStatusFilter');
  if (search) search.addEventListener('input', debounce(loadInventory, 300));
  if (filter) filter.addEventListener('change', loadInventory);
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

    container.innerHTML = data.coupons.map((c) => {
      const waStatus = String(c.whatsappStatus || 'pending').toLowerCase();
      const waBadge = waStatus === 'sent'
        ? '<span class="badge badge-green">WhatsApp: Sent</span>'
        : waStatus === 'failed'
          ? '<span class="badge badge-red">WhatsApp: Failed</span>'
          : '<span class="badge badge-amber">WhatsApp: Pending</span>';
      const waMeta = c.whatsappLastAttempt
        ? ` · Last attempt: ${formatDate ? formatDate(c.whatsappLastAttempt) : c.whatsappLastAttempt}`
        : '';
      return `
      <div class="card mb-4" style="display: block;">
        <div style="display: flex; align-items: center; gap: var(--space-5); flex-wrap: wrap;">
          <div style="flex: 1; min-width: 220px;">
            <div style="font-weight: 700; color: var(--color-white); margin-bottom: 0.25rem;">${escapeHtml(c.brand)} — ${escapeHtml(c.category)}</div>
            <code style="background: rgba(37,99,235,0.1); padding: 2px 8px; border-radius: 4px; color: var(--color-teal-400); font-weight: 600;">${escapeHtml(c.code)}</code>
            <div style="font-size: 0.75rem; color: var(--color-slate-500); margin-top: 0.5rem;">${escapeHtml(c.description || 'No description')}</div>
            <div style="font-size: 0.75rem; color: var(--color-slate-500);">Submitted by: ${escapeHtml(c.sellerEmail || 'Admin')} · ${formatDate(c.addedAt)}</div>
            ${c.expiryDate ? `<div style="font-size: 0.75rem; color: var(--color-slate-500);">Expires: ${escapeHtml(c.expiryDate)} · Selling price: ₹${escapeHtml(c.sellingPrice || '20')}</div>` : ''}
            <div style="font-size: 0.75rem; margin-top: 0.4rem; display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
              ${waBadge}${waMeta ? `<span style="color: var(--color-slate-500);">${waMeta}</span>` : ''}
            </div>
          </div>
          <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;">
            <a class="btn btn-secondary btn-sm" href="/admin/coupons/${encodeURIComponent(c.id)}" target="_blank" rel="noopener">🔍 Review</a>
            <button class="btn btn-success btn-sm" onclick="pendingReviewAction('${escapeHtml(c.id)}','approve',this)">✅ Approve</button>
            <button class="btn btn-danger btn-sm" onclick="pendingReviewAction('${escapeHtml(c.id)}','reject',this)">❌ Reject</button>
            <button class="btn btn-secondary btn-sm" onclick="pendingReviewAction('${escapeHtml(c.id)}','request_proof',this)">📎 More Proof</button>
            ${waStatus !== 'sent' ? `<button class="btn btn-secondary btn-sm" onclick="retryPendingNotify('${escapeHtml(c.id)}',this)">🔄 Retry WhatsApp</button>` : ''}
          </div>
        </div>
        <textarea id="pendingNotes-${escapeHtml(c.id)}" placeholder="Admin notes (optional)…" style="width:100%;margin-top:12px;background:rgba(6,13,31,.6);border:1px solid rgba(79,195,247,.15);border-radius:8px;color:#e2ecff;padding:9px 12px;font-size:.8rem;min-height:44px;resize:vertical;"></textarea>
      </div>
    `;
    }).join('');
  } catch (err) {
    if (container) container.innerHTML = `<p class="text-danger">Failed to load: ${err.message}</p>`;
  }
}

// Approve / Reject / Request More Proof straight from the pending list
async function pendingReviewAction(id, action, btn) {
  const original = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳'; }
  try {
    const notesEl = document.getElementById('pendingNotes-' + id);
    const notes = notesEl ? notesEl.value.trim() : '';
    const data = await api(`/admin/coupons/${id}/review-action`, {
      method: 'POST',
      useAdmin: true,
      body: { action, notes },
    });
    showToast(data.message || 'Action completed.', 'success');
    loadAdminStats();
    loadPending();
    loadInventory();
  } catch (err) {
    showToast(err.message || 'Action failed.', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  }
}

// Re-send the WhatsApp submission alert from the pending list
async function retryPendingNotify(id, btn) {
  const original = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Sending…'; }
  try {
    const data = await api(`/admin/coupons/${id}/notify-retry`, { method: 'POST', useAdmin: true });
    showToast(data.message || 'WhatsApp notification sent.', 'success');
    loadPending();
  } catch (err) {
    showToast(err.message || 'Notification retry failed.', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  }
}
window.pendingReviewAction = pendingReviewAction;
window.retryPendingNotify = retryPendingNotify;

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
window.loadUsers = loadUsers;
window.toggleUserStatus = toggleUserStatus;
window.loadSessions = loadSessions;
window.renderSessions = renderSessions;
window.terminateSession = terminateSession;

// ── User Management (live Google Sheets data) ────────────────────────────
let usersCache = [];
let usersLoading = false;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function userInitials(name) {
  return String(name || '?').split(/[\s._-]+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '?';
}

function userStatusBadge(status) {
  const s = String(status || 'active').toLowerCase();
  if (s === 'suspended' || s === 'banned') return '<span class="badge badge-red">Suspended</span>';
  if (s === 'active') return '<span class="badge badge-green">Active</span>';
  return `<span class="badge badge-orange">${escapeHtml(status)}</span>`;
}

function loginMethodBadge(method) {
  const m = String(method || '').toLowerCase().trim();
  const googleLogo = '<img src="https://www.google.com/favicon.ico" alt="G" style="width:14px;height:14px;border-radius:2px;vertical-align:middle;margin-right:4px">';
  if (m.includes('google')) return `<span style="display:inline-flex;align-items:center;gap:3px;font-size:.82rem;font-weight:600;color:#4fc3f7">${googleLogo}Google</span>`;
  if (m.includes('otp') || m.includes('email')) return '<span style="display:inline-flex;align-items:center;gap:3px;font-size:.82rem;font-weight:600;color:#ffb74d">✉️ Email OTP</span>';
  if (m) return `<span style="font-size:.82rem;color:#6b88aa">${escapeHtml(method)}</span>`;
  return '<span style="font-size:.82rem;color:#6b88aa">—</span>';
}

function userSessionStatusBadge(sessionStatus, accountStatus) {
  const ss = String(sessionStatus || '').toLowerCase();
  const as = String(accountStatus || 'active').toLowerCase();
  if (as === 'suspended' || as === 'banned') return '<span style="display:inline-flex;align-items:center;gap:5px;font-size:.82rem;font-weight:600;color:#ef9a9a">🔴 Suspended</span>';
  if (ss === 'active') return '<span style="display:inline-flex;align-items:center;gap:5px;font-size:.82rem;font-weight:600;color:#00e676">🟢 Active</span>';
  if (ss === 'logged out' || ss === 'expired') return '<span style="display:inline-flex;align-items:center;gap:5px;font-size:.82rem;font-weight:600;color:#6b88aa">⚪ Logged Out</span>';
  return '<span style="display:inline-flex;align-items:center;gap:5px;font-size:.82rem;font-weight:600;color:#6b88aa">⚪ Offline</span>';
}

function emailAvatarHtml(email, name) {
  const initials = userInitials(name);
  const emailStr = escapeHtml(email || '');
  // Use unavatar.io for Gmail profile pictures — falls back gracefully to initials
  if (emailStr) {
    return `<img src="https://unavatar.io/${emailStr}?fallback=false" alt="" style="width:30px;height:30px;border-radius:50%;object-fit:cover;flex-shrink:0" onerror="this.outerHTML='<div class=\\'u-avatar\\'>${escapeHtml(initials)}</div>'">`;
  }
  return `<div class="u-avatar">${escapeHtml(initials)}</div>`;
}

async function loadUsers() {
  // Single-flight: ignore re-entries while a previous call is still in flight.
  if (usersLoading) return;
  usersLoading = true;
  const body = document.getElementById('usersTableBody');
  try {
    const data = await api('/admin/users', { useAdmin: true });
    usersCache = (data.users || []).slice().sort((a, b) => String(b.lastLoginAt || b.createdAt || '').localeCompare(String(a.lastLoginAt || a.createdAt || '')));

    const c = data.counts || {};
    const total = c.total ?? usersCache.length;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('usersTotalCount', total);
    set('usersActiveCount', c.active ?? '—');
    set('usersSuspendedCount', c.suspended ?? '—');
    set('usersNavBadge', total);
    const sub = document.getElementById('usersSubtitle');
    if (sub) sub.textContent = `${total} total registered user${total === 1 ? '' : 's'} · live from Google Sheets`;

    renderUsers();
    renderLoginHistory();
  } catch (err) {
    if (body) body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#ef9a9a;padding:24px;">Failed to load users: ${escapeHtml(err.message)}</td></tr>`;
  } finally {
    usersLoading = false;
  }
}

function renderUsers() {
  const body = document.getElementById('usersTableBody');
  if (!body) return;

  const q = (document.getElementById('usersSearch')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('usersStatusFilter')?.value || '';

  const rows = usersCache.filter((u) => {
    if (q && !`${u.name} ${u.username} ${u.email}`.toLowerCase().includes(q)) return false;
    if (statusFilter === 'active' && u.status !== 'active') return false;
    if (statusFilter === 'suspended' && u.status !== 'suspended' && u.status !== 'banned') return false;
    return true;
  });

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#6b88aa;padding:24px;">No users match your filters.</td></tr>';
    return;
  }

  body.innerHTML = rows.map((u) => {
    const suspended = u.status === 'suspended' || u.status === 'banned';
    const toggleAction = suspended
      ? `<a href="#" style="color:#00e676;font-weight:600;font-size:.82rem" onclick="event.preventDefault();toggleUserStatus('${escapeHtml(u.id)}','active')">Activate</a>`
      : `<a href="#" style="color:#ffb74d;font-weight:600;font-size:.82rem" onclick="event.preventDefault();toggleUserStatus('${escapeHtml(u.id)}','suspended')">Suspend</a>`;
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:10px">${emailAvatarHtml(u.email, u.name)}<strong>${escapeHtml(u.name)}</strong></div></td>
      <td><a href="mailto:${escapeHtml(u.email || '')}" style="color:#4fc3f7;font-size:.83rem">${escapeHtml(u.email || '—')}</a></td>
      <td style="font-size:.82rem;color:#a8c0dc">${fmtDateTime(u.lastLoginAt)}</td>
      <td style="font-size:.82rem;color:#a8c0dc">${fmtDateTime(u.lastLogoutAt)}</td>
      <td>${loginMethodBadge(u.loginMethod)}</td>
      <td>${userSessionStatusBadge(u.sessionStatus, u.status)}</td>
      <td><span class="mono" style="font-weight:600;color:#ce93d8">${u.couponsBought || 0}</span></td>
      <td><span class="mono" style="font-weight:600;color:#00e676">${u.couponsSold || 0}</span></td>
      <td><span style="display:flex;align-items:center;gap:6px;white-space:nowrap"><a href="#" style="color:#4fc3f7;font-weight:600;font-size:.82rem" onclick="event.preventDefault();viewUserDetail('${escapeHtml(u.id)}')">View</a> <span style="color:#6b88aa">·</span> ${toggleAction}</span></td>
    </tr>`;
  }).join('');
}

function renderLoginHistory() {
  const body = document.getElementById('loginHistoryBody');
  if (!body) return;

  const rows = usersCache
    .filter((u) => u.lastLoginAt)
    .slice()
    .sort((a, b) => String(b.lastLoginAt).localeCompare(String(a.lastLoginAt)))
    .slice(0, 10);

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#6b88aa;padding:24px;">No logins recorded yet.</td></tr>';
    return;
  }

  body.innerHTML = rows.map((u) => `<tr>
    <td><div style="display:flex;align-items:center;gap:10px">${emailAvatarHtml(u.email, u.name)}<strong>${escapeHtml(u.name)}</strong></div></td>
    <td><a href="mailto:${escapeHtml(u.email || '')}" style="color:#4fc3f7;font-size:.83rem">${escapeHtml(u.email || '—')}</a></td>
    <td style="font-size:.82rem;color:#a8c0dc">${fmtDateTime(u.lastLoginAt)}</td>
    <td style="font-size:.82rem;color:#a8c0dc">${fmtDateTime(u.lastLogoutAt)}</td>
    <td>${loginMethodBadge(u.loginMethod)}</td>
    <td>${userSessionStatusBadge(u.sessionStatus, u.status)}</td>
  </tr>`).join('');
}

async function toggleUserStatus(userId, nextStatus) {
  if (!confirm(nextStatus === 'suspended' ? 'Suspend this user?' : 'Reactivate this user?')) return;
  try {
    await api('/admin/users/status', { method: 'PUT', useAdmin: true, body: { userId, status: nextStatus } });
    showToast(`User is now ${nextStatus}.`, 'success');
    loadUsers();
  } catch (err) {
    showToast(err.message || 'Failed to update user status.', 'error');
  }
}

function viewUserDetail(userId) {
  const user = usersCache.find((u) => u.id === userId);
  if (!user) { showToast('User not found.', 'error'); return; }

  const suspended = user.status === 'suspended' || user.status === 'banned';
  const emailStr = escapeHtml(user.email || '');
  const avatarUrl = emailStr ? `https://unavatar.io/${emailStr}?fallback=false` : '';
  const avatarHtml = avatarUrl
    ? `<img src="${avatarUrl}" alt="" style="width:52px;height:52px;border-radius:50%;object-fit:cover;flex-shrink:0;border:2px solid rgba(0,230,118,.3)" onerror="this.outerHTML='<div class=\\'u-avatar\\' style=\\'width:52px;height:52px;font-size:1.1rem\\'>${escapeHtml(userInitials(user.name))}</div>'">`
    : `<div class="u-avatar" style="width:52px;height:52px;font-size:1.1rem">${escapeHtml(userInitials(user.name))}</div>`;

  // Build modal HTML
  const html = `
    <div class="modal-overlay open" id="userDetailModal" onclick="if(event.target===this)this.classList.remove('open')">
      <div class="modal" style="max-width:520px">
        <div class="modal-hdr" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <div class="modal-title" style="font-family:'DM Serif Display',serif;font-size:1.3rem">User Details</div>
          <button class="modal-close" onclick="document.getElementById('userDetailModal').classList.remove('open');setTimeout(()=>document.getElementById('userDetailModal')?.remove(),300)" style="background:none;border:none;color:#6b88aa;cursor:pointer;font-size:1.2rem;padding:2px 6px">✕</button>
        </div>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:22px">
          ${avatarHtml}
          <div>
            <div style="font-weight:700;font-size:1.05rem;color:#e2ecff">${escapeHtml(user.name)}</div>
            <a href="mailto:${emailStr}" style="font-size:.82rem;color:#4fc3f7">${emailStr || '—'}</a>
          </div>
          <span style="margin-left:auto">${userSessionStatusBadge(user.sessionStatus, user.status)}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px">
          <div style="background:rgba(255,255,255,.04);border-radius:10px;padding:12px 14px">
            <div style="font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6b88aa;margin-bottom:4px">Joined</div>
            <div style="font-size:.85rem;color:#e2ecff;font-weight:600">${fmtDate(user.createdAt)}</div>
          </div>
          <div style="background:rgba(255,255,255,.04);border-radius:10px;padding:12px 14px">
            <div style="font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6b88aa;margin-bottom:4px">Last Login</div>
            <div style="font-size:.85rem;color:#e2ecff;font-weight:600">${fmtDateTime(user.lastLoginAt)}</div>
          </div>
          <div style="background:rgba(255,255,255,.04);border-radius:10px;padding:12px 14px">
            <div style="font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6b88aa;margin-bottom:4px">Login Method</div>
            <div style="font-size:.85rem">${loginMethodBadge(user.loginMethod)}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px">
          <div style="background:rgba(206,147,216,.06);border:1px solid rgba(206,147,216,.15);border-radius:10px;padding:12px 14px">
            <div style="font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6b88aa;margin-bottom:4px">🎟️ Coupons Bought</div>
            <div style="font-size:1.3rem;font-family:'JetBrains Mono',monospace;color:#ce93d8;font-weight:600">${user.couponsBought || 0}</div>
          </div>
          <div style="background:rgba(0,230,118,.06);border:1px solid rgba(0,230,118,.15);border-radius:10px;padding:12px 14px">
            <div style="font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6b88aa;margin-bottom:4px">💰 Coupons Sold</div>
            <div style="font-size:1.3rem;font-family:'JetBrains Mono',monospace;color:#00e676;font-weight:600">${user.couponsSold || 0}</div>
          </div>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          ${suspended
            ? `<button class="btn btn-success btn-sm" onclick="toggleUserStatus('${escapeHtml(user.id)}','active');document.getElementById('userDetailModal')?.remove()">✅ Activate</button>`
            : `<button class="btn btn-warning btn-sm" onclick="toggleUserStatus('${escapeHtml(user.id)}','suspended');document.getElementById('userDetailModal')?.remove()">⚠️ Suspend</button>`
          }
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('userDetailModal').classList.remove('open');setTimeout(()=>document.getElementById('userDetailModal')?.remove(),300)">Close</button>
        </div>
      </div>
    </div>`;

  // Remove any existing modal first
  document.getElementById('userDetailModal')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
}

window.viewUserDetail = viewUserDetail;

// Search / filter wiring for the users table
function initUsersTableControls() {
  const search = document.getElementById('usersSearch');
  const filter = document.getElementById('usersStatusFilter');
  if (search) search.addEventListener('input', () => renderUsers());
  if (filter) filter.addEventListener('change', () => renderUsers());
}

// ── User Sessions (live Supabase data) ──────────────────────────────────
let sessionsCache = [];
let sessionsLoading = false;

function sessionStatusBadge(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active') return '<span class="badge badge-green">Active</span>';
  if (s === 'logged out') return '<span class="badge badge-gray">Logged out</span>';
  if (s === 'expired') return '<span class="badge badge-orange">Expired</span>';
  return `<span class="badge badge-blue">${escapeHtml(status || '—')}</span>`;
}

function sessionListLabel(session, fields) {
  return fields.map((f) => session[f]).filter((v) => v && String(v).trim()).join(' · ') || '—';
}

function sessionLocation(session) {
  return [session.city, session.state, session.country].filter((v) => v && String(v).trim()).join(', ') || '—';
}

async function loadSessions() {
  // Single-flight: ignore re-entries while a previous call is still in flight.
  if (sessionsLoading) return;
  sessionsLoading = true;
  const body = document.getElementById('sessionsTableBody');
  try {
    const data = await api('/admin/sessions', { useAdmin: true });
    sessionsCache = data.sessions || [];

    const c = data.counts || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('sessionsActiveCount', c.active ?? '—');
    set('sessionsUniqueUsers', c.uniqueUsers ?? '—');
    set('sessionsTodayCount', c.loginsToday ?? '—');
    set('sessionsEndedCount', (c.loggedOut ?? 0) + (c.expired ?? 0));
    set('sessionsNavBadge', c.active ?? '—');
    const sub = document.getElementById('sessionsSubtitle');
    if (sub) {
      const total = c.total ?? sessionsCache.length;
      sub.textContent = `${total} total session${total === 1 ? '' : 's'} · live from Supabase sessions table`;
    }

    renderSessions();
  } catch (err) {
    if (body) body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#ef9a9a;padding:24px;">Failed to load sessions: ${escapeHtml(err.message)}</td></tr>`;
  } finally {
    sessionsLoading = false;
  }
}

function renderSessions() {
  const body = document.getElementById('sessionsTableBody');
  if (!body) return;

  const q = (document.getElementById('sessionsSearch')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('sessionsStatusFilter')?.value || '';

  const rows = sessionsCache.filter((s) => {
    if (statusFilter && String(s.status || '') !== statusFilter) return false;
    if (q) {
      const haystack = `${s.email || ''} ${s.user_id || ''} ${s.ip_address || ''} ${s.city || ''} ${s.state || ''} ${s.country || ''} ${s.browser || ''} ${s.os || ''} ${s.device || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#6b88aa;padding:24px;">No sessions match your filters.</td></tr>';
    return;
  }

  body.innerHTML = rows.map((s) => {
    const email = s.email || s.user_id || 'Unknown user';
    const initials = String(email).split(/[\s@._-]+/).filter(Boolean)[0]?.slice(0, 2).toUpperCase() || '?';
    const isActive = String(s.status || '').toLowerCase() === 'active';
    const idAttr = escapeHtml(s.session_id || '');
    return `<tr>
      <td title="user_id: ${escapeHtml(s.user_id || '—')}"><div style="display:flex;align-items:center;gap:10px"><div class="u-avatar">${escapeHtml(initials)}</div><strong>${escapeHtml(email)}</strong></div></td>
      <td>${escapeHtml(sessionListLabel(s, ['device', 'os', 'browser']))}</td>
      <td>${escapeHtml(sessionLocation(s))}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.78rem">${escapeHtml(s.ip_address || '—')}</td>
      <td><span class="badge badge-blue">${escapeHtml(s.login_method || 'Email')}</span></td>
      <td style="font-size:.78rem;color:#6b88aa">${fmtDateTime(s.login_time)}</td>
      <td style="font-size:.78rem;color:#6b88aa">${fmtDateTime(s.last_active)}</td>
      <td>${sessionStatusBadge(s.status)}</td>
      <td>${isActive ? `<button class="btn btn-danger btn-sm" onclick="terminateSession('${idAttr}')">Terminate</button>` : '<span class="badge badge-gray">Ended</span>'}</td>
    </tr>`;
  }).join('');
}

async function terminateSession(sessionId) {
  if (!sessionId || !confirm('Terminate this session? The user will be logged out on that device.')) return;
  try {
    const data = await api(`/admin/sessions/${encodeURIComponent(sessionId)}/terminate`, {
      method: 'PUT',
      useAdmin: true,
    });
    showToast(data.message || 'Session terminated.', 'success');
    loadSessions();
  } catch (err) {
    showToast(err.message || 'Failed to terminate session.', 'error');
  }
}

// Search / filter wiring for the sessions table
function initSessionsTableControls() {
  const search = document.getElementById('sessionsSearch');
  const filter = document.getElementById('sessionsStatusFilter');
  if (search) search.addEventListener('input', () => renderSessions());
  if (filter) filter.addEventListener('change', () => renderSessions());
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
      // Load toggle states
      if (document.getElementById('toggleActiveUsers')) document.getElementById('toggleActiveUsers').checked = s.showActiveUsers !== false;
      if (document.getElementById('toggleCouponsTraded')) document.getElementById('toggleCouponsTraded').checked = s.showCouponsTraded !== false;
      if (document.getElementById('toggleSavedByUsers')) document.getElementById('toggleSavedByUsers').checked = s.showSavedByUsers !== false;
      if (document.getElementById('setHeroBadge')) document.getElementById('setHeroBadge').value = s.heroBadge || "🚀 India's #1 Coupon Marketplace — Now Live!";
      if (document.getElementById('toggleHeroBadge')) document.getElementById('toggleHeroBadge').checked = s.showHeroBadge !== false;
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
    // Get toggle states
    const showActiveUsers = document.getElementById('toggleActiveUsers')?.checked !== false;
    const showCouponsTraded = document.getElementById('toggleCouponsTraded')?.checked !== false;
    const showSavedByUsers = document.getElementById('toggleSavedByUsers')?.checked !== false;
    const heroBadge = document.getElementById('setHeroBadge')?.value?.trim() || "🚀 India's #1 Coupon Marketplace — Now Live!";
    const showHeroBadge = document.getElementById('toggleHeroBadge')?.checked !== false;

    const data = await api('/admin/settings', {
      method: 'PUT',
      useAdmin: true,
      body: {
        activeUsers,
        couponsTraded,
        savedByUsers,
        platformName,
        adminEmail,
        showActiveUsers,
        showCouponsTraded,
        showSavedByUsers,
        heroBadge,
        showHeroBadge,
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
