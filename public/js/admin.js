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
  initActiveTableControls();
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
let invCurrentPage = 1;
const INV_PAGE_SIZE = 20;
// Last rendered page-set, so an inline sale/timer edit can patch its row in
// place instead of re-fetching and losing the page + scroll position.
let INVENTORY_CACHE = [];

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

    // Unfiltered fetch already holds every coupon — use it to keep the ⏳ Pending
    // tab badge honest, since opening the section only loads this table.
    if (!status) {
      cmSetPendingBadge(
        (data.coupons || []).filter((c) => c.status === 'pending' || c.status === 'proof_requested').length,
      );
    }

    if (data.coupons.length === 0) {
      INVENTORY_CACHE = [];
      container.innerHTML = `
        <div class="empty-state">
          <div class="es-icon">📋</div>
          <div class="es-title">No coupons in inventory</div>
          <div class="es-sub">Add your first coupon with the “➕ Add Coupon” button above.</div>
        </div>
      `;
      return;
    }

    const search = document.getElementById('invSearch')?.value?.toLowerCase() || '';
    let coupons = data.coupons;
    if (search) {
      coupons = coupons.filter(
        (c) =>
          (c.code || '').toLowerCase().includes(search) ||
          (c.brand || '').toLowerCase().includes(search)
      );
    }

    // Pagination
    const totalFiltered = coupons.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / INV_PAGE_SIZE));
    if (invCurrentPage > totalPages) invCurrentPage = totalPages;
    const startIdx = (invCurrentPage - 1) * INV_PAGE_SIZE;
    const pageCoupons = coupons.slice(startIdx, startIdx + INV_PAGE_SIZE);
    INVENTORY_CACHE = pageCoupons;

    container.innerHTML = `
      <div class="table-card" style="margin-bottom:0">
        <div class="overflow-x">
          <table class="inv-table">
            <colgroup>
              <!-- Brand is logo-only now, so it needs far less room than it did
                   with the name beside it; the width it gives up goes to Code,
                   where long coupon codes were being ellipsised. -->
              <col style="width:112px"><col style="width:228px"><col style="width:120px">
              <col style="width:88px"><col style="width:92px"><col style="width:70px">
              <col style="width:70px"><col style="width:206px"><col style="width:116px">
              <col style="width:104px"><col style="width:110px">
            </colgroup>
            <thead>
              <tr>
                <th>Brand</th>
                <th>Code</th>
                <th>Category</th>
                <th class="ta-center">Value</th>
                <th>Price</th>
                <th class="ta-center" title="Show the 🔥 Sale badge on the marketplace card">Sale</th>
                <th class="ta-center" title="Show the expiry countdown on the marketplace card. Turning it off keeps the date — it just stops counting down.">Timer</th>
                <th title="When this coupon expires — drives the countdown on the marketplace card">Expires</th>
                <th>Source</th>
                <th>Status</th>
                <th class="ta-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${pageCoupons.map(invRowHtml).join('')}
            </tbody>
          </table>
        </div>
        <div class="inv-tfoot">
          <span>Showing ${startIdx + 1}–${Math.min(startIdx + INV_PAGE_SIZE, totalFiltered)} of ${totalFiltered} coupons</span>
          <div style="display:flex;align-items:center;gap:8px">
            <button class="btn btn-ghost btn-sm" onclick="invGoToPage(1)" ${invCurrentPage <= 1 ? 'disabled style="opacity:.4;pointer-events:none"' : ''}>«</button>
            <button class="btn btn-ghost btn-sm" onclick="invGoToPage(${invCurrentPage - 1})" ${invCurrentPage <= 1 ? 'disabled style="opacity:.4;pointer-events:none"' : ''}>‹ Prev</button>
            <span style="font-weight:700;color:#e2ecff">Page ${invCurrentPage} / ${totalPages}</span>
            <button class="btn btn-ghost btn-sm" onclick="invGoToPage(${invCurrentPage + 1})" ${invCurrentPage >= totalPages ? 'disabled style="opacity:.4;pointer-events:none"' : ''}>Next ›</button>
            <button class="btn btn-ghost btn-sm" onclick="invGoToPage(${totalPages})" ${invCurrentPage >= totalPages ? 'disabled style="opacity:.4;pointer-events:none"' : ''}>»</button>
          </div>
        </div>
      </div>
    `;

    startInventoryExpiryTicker();
  } catch (err) {
    if (seq === inventoryRequestSeq) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="es-icon">⚠️</div>
          <div class="es-title">Failed to load inventory</div>
          <div class="es-sub">${escHtml(err.message || 'Unknown error')}</div>
        </div>
      `;
    }
  } finally {
    inventoryLoading = false;
  }
}

/** One inventory row: brand logo (no name — the logo is the label), inline sale + timer switches, inline expiry. */
function invRowHtml(c) {
  const id = escHtml(c.id || '');
  const brand = c.brand || '';
  const statusBadge = c.status === 'sold' ? 'green' : c.status === 'pending' ? 'orange' : 'blue';
  const sourceBadge = c.source === 'admin' ? 'purple' : c.source === 'auto-scraped' ? 'teal' : 'blue';
  const logoUrl = getBrandLogo(brand);
  const logoClass = getBrandLogoClass(logoUrl);
  const initial = escHtml(getBrandInitial(brand));
  const onSale = c.onSale !== false;
  const timerOn = c.timerOn !== false;
  const timerValue = escHtml(toTimerInputValue(c.expiryDate));

  return `
    <tr data-coupon-id="${id}">
      <td>
        <div class="inv-brand" title="${escHtml(brand)}">
          ${logoUrl
            ? `<img class="inv-brand-logo${logoClass ? ' ' + logoClass : ''}" src="${escHtml(logoUrl)}" alt="${escHtml(brand)}" loading="lazy"
                    onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
               ><span class="inv-brand-initial" style="display:none">${initial}</span>`
            : `<span class="inv-brand-initial">${initial}</span>`
          }
        </div>
      </td>
      <td><code class="inv-code">${escHtml(c.code || '')}</code></td>
      <td>${escHtml(c.category || '—')}</td>
      <td class="ta-center">₹${escHtml(c.originalValue || '—')}</td>
      <td class="inv-price">₹${escHtml(c.sellingPrice || '0')}</td>
      <td class="ta-center">
        <label class="toggle" title="${onSale ? 'Sale is ON — turn it off' : 'Sale is OFF — turn it on'}">
          <input type="checkbox" ${onSale ? 'checked' : ''} onchange="setCouponSale('${id}', this.checked, this)">
          <span class="toggle-slider"></span>
        </label>
      </td>
      <td class="ta-center">
        <label class="toggle" title="${timerOn ? 'Timer is ON — turn it off to hide the countdown (the date is kept)' : 'Timer is OFF — turn it on to show the countdown again'}">
          <input type="checkbox" ${timerOn ? 'checked' : ''} onchange="setCouponTimer('${id}', this.checked, this)">
          <span class="toggle-slider"></span>
        </label>
      </td>
      <td>
        <input class="inv-timer${timerOn ? '' : ' inv-timer-off'}" type="datetime-local" value="${timerValue}" data-prev-value="${timerValue}"
               title="${timerOn ? 'Set when this coupon expires — clear the field to remove the timer' : 'Turn the Timer switch on to edit this'}"
               ${timerOn ? '' : 'disabled'}
               onchange="setCouponExpiry('${id}', this.value, this)">
        ${invExpiryChip(c.expiryDate, timerOn)}
      </td>
      <td><span class="badge badge-${sourceBadge}">${escHtml(c.source || '—')}</span></td>
      <td><span class="badge badge-${statusBadge}">${escHtml(c.status || '—')}</span></td>
      <td>
        <div class="admin-actions ta-right">
          ${c.status === 'pending' ? `<button class="btn btn-success btn-xs" title="Approve this coupon" onclick="approveCoupon('${id}')">✓</button>` : ''}
          <button class="btn btn-danger btn-xs" title="Delete this coupon" onclick="deleteCoupon('${id}')">🗑</button>
        </div>
      </td>
    </tr>
  `;
}

/**
 * Supabase stores expiry as text — 'YYYY-MM-DD' for older rows, and
 * 'YYYY-MM-DDTHH:mm' for anything set with the timer picker. Normalise both
 * into the value a <input type="datetime-local"> expects (a bare date becomes
 * 23:59 that day, matching how the countdown treats it).
 */
function toTimerInputValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T23:59`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return s;
  const at = parseExpiry(s);
  if (at === null) return '';
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Countdown chip beside the picker — same colour bands as the marketplace.
 * With the Timer switch off it shows a muted "Timer off" chip carrying the date
 * in its tooltip, and deliberately omits `data-inv-expiry` so the ticker leaves
 * it alone.
 */
function invExpiryChip(raw, timerOn) {
  const at = parseExpiry(raw);
  if (at === null) return '<span class="inv-exp-none">No timer set</span>';
  const when = new Date(at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (timerOn === false) {
    return `<div class="inv-exp inv-exp-off" title="Timer switched off — expiry ${when} is still saved">⏸ Timer off</div>`;
  }
  const msLeft = at - Date.now();
  return `<div class="inv-exp inv-exp-${expiryBand(msLeft)}" data-inv-expiry="${at}" title="Expires ${when}">${expiryLabel(msLeft)}</div>`;
}

let invExpiryTimerId = null;

/** Tick every inventory countdown once a second (single shared interval). */
function startInventoryExpiryTicker() {
  if (invExpiryTimerId !== null) return; // already running — re-renders are picked up on the next tick
  const tick = () => {
    const nodes = document.querySelectorAll('[data-inv-expiry]');
    if (nodes.length === 0) return;
    const now = Date.now();
    nodes.forEach((el) => {
      const msLeft = Number(el.dataset.invExpiry) - now;
      const label = expiryLabel(msLeft);
      if (el.textContent !== label) el.textContent = label;
      const cls = `inv-exp inv-exp-${expiryBand(msLeft)}`;
      if (el.className !== cls) el.className = cls;
    });
  };
  tick();
  invExpiryTimerId = setInterval(tick, 1000);
}

/**
 * Flip the per-coupon sale switch. Persists to Supabase via PUT and reverts the
 * checkbox if the write fails, so the UI never claims a save that didn't happen.
 */
async function setCouponSale(id, on, inputEl) {
  inputEl.disabled = true;
  try {
    await api(`/admin/coupons/${id}`, { method: 'PUT', useAdmin: true, body: { onSale: on } });
    const cached = INVENTORY_CACHE.find((c) => c.id === id);
    if (cached) cached.onSale = on;
    const label = inputEl.closest('label');
    if (label) label.title = on ? 'Sale is ON — turn it off' : 'Sale is OFF — turn it on';
    showToast(on ? '🔥 Sale turned ON for this coupon.' : 'Sale turned OFF for this coupon.', 'success');
  } catch (err) {
    inputEl.checked = !on; // put the switch back where it was
    // A session-expired error carries no copy — app.js already handles that one.
    if (!err.sessionExpired) showToast(err.message || 'Could not save the sale switch.', 'error');
  } finally {
    inputEl.disabled = false;
  }
}

/**
 * Flip the per-coupon timer switch. The expiry date itself is left untouched —
 * turning the timer off only hides the countdown on the marketplace card, so
 * turning it back on restores the date that's already saved. Persists via PUT
 * and reverts the checkbox if the write fails.
 */
async function setCouponTimer(id, on, inputEl) {
  inputEl.disabled = true;
  try {
    await api(`/admin/coupons/${id}`, { method: 'PUT', useAdmin: true, body: { timerOn: on } });
    const cached = INVENTORY_CACHE.find((c) => c.id === id);
    if (cached) cached.timerOn = on;

    const label = inputEl.closest('label');
    if (label) {
      label.title = on
        ? 'Timer is ON — turn it off to hide the countdown (the date is kept)'
        : 'Timer is OFF — turn it on to show the countdown again';
    }

    // The picker and the chip live in the next cell over, so walk up to the row.
    const row = inputEl.closest('tr');
    const picker = row?.querySelector('.inv-timer');
    if (picker) {
      picker.disabled = !on;
      picker.classList.toggle('inv-timer-off', !on);
      picker.title = on
        ? 'Set when this coupon expires — clear the field to remove the timer'
        : 'Turn the Timer switch on to edit this';
    }
    const chip = row?.querySelector('.inv-exp, .inv-exp-none');
    // The chip re-renders with (or without) data-inv-expiry; the shared ticker
    // re-queries the DOM every second, so it picks the change up on its own.
    if (chip) chip.outerHTML = invExpiryChip(cached ? cached.expiryDate : picker?.value, on);

    showToast(
      on ? '⏱ Timer turned ON for this coupon.' : 'Timer turned OFF — the expiry date is still saved.',
      'success'
    );
  } catch (err) {
    inputEl.checked = !on; // put the switch back where it was
    if (!err.sessionExpired) showToast(err.message || 'Could not save the timer switch.', 'error');
  } finally {
    inputEl.disabled = false;
  }
}

/** Save the per-coupon expiry timer and refresh just that row's countdown chip. */
async function setCouponExpiry(id, value, inputEl) {
  const previous = inputEl.dataset.prevValue || '';
  inputEl.disabled = true;
  try {
    await api(`/admin/coupons/${id}`, { method: 'PUT', useAdmin: true, body: { expiryDate: value || '' } });
    inputEl.dataset.prevValue = value;
    const cached = INVENTORY_CACHE.find((c) => c.id === id);
    if (cached) cached.expiryDate = value;

    const chip = inputEl.parentElement?.querySelector('.inv-exp, .inv-exp-none');
    // Only reachable while the Timer switch is on (the picker is disabled when
    // it's off), but read the flag back rather than assuming it.
    if (chip) chip.outerHTML = invExpiryChip(value, cached ? cached.timerOn !== false : true);

    showToast(value ? 'Timer saved for this coupon.' : 'Timer cleared for this coupon.', 'success');
  } catch (err) {
    inputEl.value = previous; // roll the picker back
    if (!err.sessionExpired) showToast(err.message || 'Could not save the timer.', 'error');
  } finally {
    inputEl.disabled = false;
  }
}

function invPrev() {
  if (invCurrentPage > 1) {
    invCurrentPage--;
    loadInventory();
  }
}

function invNext() {
  invCurrentPage++;
  loadInventory();
}

function invGoToPage(page) {
  if (page < 1) page = 1;
  invCurrentPage = page;
  loadInventory();
}

// Search / filter wiring for the coupon inventory table.
// initAdminApp() has always called this, but it was never defined — so typing in
// the Coupon Management search box did nothing and the ReferenceError aborted the
// rest of initAdminApp() (loadSystemSettings never ran).
function initInventoryTableControls() {
  const search = document.getElementById('invSearch');
  const filter = document.getElementById('invStatusFilter');
  // Debounced because loadInventory() refetches, and its single-flight guard
  // drops calls that overlap — undebounced keystrokes would lose renders.
  if (search) search.addEventListener('input', debounce(() => {
    invCurrentPage = 1;
    loadInventory();
  }, 220));
  if (filter) filter.addEventListener('change', () => {
    invCurrentPage = 1;
    loadInventory();
  });
}

// ── Coupon Management: ⏳ Pending + ✅ Active tables ──────────────────────
/*
 * These two tabs of Coupon Management show the same sets the Coupon Reviews
 * section works with: submissions still awaiting a decision, and the ones
 * review has approved (status 'available' — live in the marketplace).
 *
 * Both loaders were called from three places — showCouponTab() in vault.html,
 * and approveCoupon()/deleteCoupon() below — but neither was ever defined. So
 * the tabs rendered nothing, and the two unguarded calls threw a ReferenceError
 * immediately after a successful API call: approving or deleting a coupon
 * reported failure in a toast and left every table stale. Same class of bug as
 * initInventoryTableControls() above.
 */

const CM_PAGE_SIZE = 20;
// Fetched rows are cached so the search box and the source filter re-render
// without another round trip.
let activeCoupons = { rows: [], page: 1, search: '', source: 'all', loading: false, seq: 0 };
let pendingCoupons = { loading: false, seq: 0 };

async function loadActiveCoupons() {
  const container = document.getElementById('activeList');
  if (!container) return;
  if (activeCoupons.loading) return; // single-flight, like loadInventory()
  activeCoupons.loading = true;
  const seq = ++activeCoupons.seq;

  if (activeCoupons.rows.length === 0) {
    container.innerHTML = '<div class="cm-loading">Loading approved coupons…</div>';
  }

  try {
    // status=available is exactly the Coupon Reviews → ✅ Approved set.
    const data = await api('/admin/coupons?status=available', { useAdmin: true });
    if (seq !== activeCoupons.seq) return; // a newer load started while awaiting
    activeCoupons.rows = data.coupons || [];
    renderActiveCoupons();
  } catch (err) {
    if (seq === activeCoupons.seq) {
      container.innerHTML = cmStateHtml('⚠️', 'Failed to load approved coupons', escHtml(err.message || 'Unknown error'));
    }
  } finally {
    activeCoupons.loading = false;
  }
}

/** Re-render the approved table from cache (search / filter / paging). */
function renderActiveCoupons() {
  const container = document.getElementById('activeList');
  if (!container) return;

  const all = activeCoupons.rows;
  if (all.length === 0) {
    container.innerHTML = cmStateHtml(
      '✅',
      'No approved coupons yet',
      'Approve a submission in Coupon Reviews and it lands here, live in the marketplace.',
    );
    return;
  }

  const rows = all.filter(matchesActiveFilters);
  if (rows.length === 0) {
    container.innerHTML = cmStateHtml('🔍', 'Nothing matches this filter', 'Clear the search box or pick a different source.');
    return;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / CM_PAGE_SIZE));
  if (activeCoupons.page > totalPages) activeCoupons.page = totalPages;
  if (activeCoupons.page < 1) activeCoupons.page = 1;
  const start = (activeCoupons.page - 1) * CM_PAGE_SIZE;
  const pageRows = rows.slice(start, start + CM_PAGE_SIZE);
  const fromReviews = all.filter(isSellerSubmission).length;

  container.innerHTML = `
    <div class="cm-summary">
      <span><b>${all.length}</b> live in the marketplace</span>
      <span><b>${fromReviews}</b> approved from seller submissions</span>
      <span><b>${all.length - fromReviews}</b> added by admin</span>
    </div>
    <div class="table-card" style="margin-bottom:0">
      <div class="overflow-x">
        <table class="appr-table">
          <colgroup>
            <col style="width:200px"><col style="width:196px"><col style="width:118px">
            <col style="width:84px"><col style="width:84px"><col style="width:180px">
            <col style="width:132px"><col style="width:180px"><col style="width:148px">
            <col style="width:112px">
          </colgroup>
          <thead>
            <tr>
              <th>Brand</th>
              <th>Code</th>
              <th>Category</th>
              <th>Value</th>
              <th>Price</th>
              <th>Seller</th>
              <th title="When review approved this coupon">Approved</th>
              <th title="When this coupon expires — drives the countdown on the marketplace card">Expires</th>
              <th>Source</th>
              <th class="ta-right">Actions</th>
            </tr>
          </thead>
          <tbody>${pageRows.map(activeRowHtml).join('')}</tbody>
        </table>
      </div>
      <div class="inv-tfoot">
        <span>Showing ${start + 1}–${start + pageRows.length} of ${rows.length} approved coupon${rows.length !== 1 ? 's' : ''}</span>
        ${cmPagerHtml(activeCoupons.page, totalPages, 'activeGoToPage')}
      </div>
    </div>
  `;

  if (typeof startInventoryExpiryTicker === 'function') startInventoryExpiryTicker();
}

/** One approved-coupon row. */
function activeRowHtml(c) {
  const id = escHtml(c.id || '');
  const seller = c.sellerEmail || 'Admin';
  const src = String(c.source || '').toLowerCase();
  const srcBadge = src === 'admin' ? 'purple' : src === 'auto-scraped' ? 'teal' : src === 'partner' ? 'blue' : 'green';
  // review-action stamps verifiedAt on approve; older rows only carry addedAt.
  const approvedAt = c.verifiedAt || c.reviewedAt || c.approvedAt || '';
  const fallbackAt = c.addedAt || c.createdAt || '';

  return `
    <tr data-coupon-id="${id}">
      <td>${cmBrandCellHtml(c.brand || '')}</td>
      <td><code class="inv-code">${escHtml(c.code || '')}</code></td>
      <td>${escHtml(c.category || '—')}</td>
      <td>₹${escHtml(c.originalValue || '—')}</td>
      <td class="inv-price">₹${escHtml(c.sellingPrice || '0')}</td>
      <td><div class="cm-seller-cell">${c.sellerEmail ? emailAvatarHtml(c.sellerEmail, 24) : ''}<span class="cm-seller" title="${escHtml(seller)}">${escHtml(seller)}</span></div></td>
      <td>${cmWhenHtml(approvedAt, fallbackAt)}</td>
      <td>${typeof invExpiryChip === 'function' ? invExpiryChip(c.expiryDate, c.timerOn !== false) : escHtml(c.expiryDate || '—')}</td>
      <td><span class="badge badge-${srcBadge}">${escHtml(c.source || '—')}</span></td>
      <td>
        <div class="admin-actions ta-right">
          <button class="btn btn-ghost btn-xs" title="Open the full review record" onclick="openReviewModal('${id}')">🔍</button>
          <button class="btn btn-danger btn-xs" title="Delete this coupon" onclick="deleteCoupon('${id}')">🗑</button>
        </div>
      </td>
    </tr>
  `;
}

/** Anything not admin-entered came in through a seller submission → review. */
function isSellerSubmission(c) {
  const src = String(c.source || '').toLowerCase();
  return src === 'user-submitted' || src === 'user';
}

function matchesActiveFilters(c) {
  if (activeCoupons.source === 'review' && !isSellerSubmission(c)) return false;
  if (activeCoupons.source === 'admin' && isSellerSubmission(c)) return false;
  const q = activeCoupons.search;
  if (!q) return true;
  return `${c.code || ''} ${c.brand || ''} ${c.sellerEmail || ''} ${c.category || ''}`.toLowerCase().includes(q);
}

function setActiveSourceFilter(source, btnEl) {
  activeCoupons.source = source;
  activeCoupons.page = 1;
  document.querySelectorAll('#ctab-active .cm-filters .btn').forEach((b) => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  renderActiveCoupons();
}

function activeGoToPage(page) {
  activeCoupons.page = page < 1 ? 1 : page;
  renderActiveCoupons();
}

// Search box for the ✅ Active tab. It filters the cached rows, so there is no
// refetch and no need to debounce for the API's sake — the delay is only to
// avoid re-rendering the table on every keystroke.
function initActiveTableControls() {
  const search = document.getElementById('activeSearch');
  if (!search) return;
  search.addEventListener('input', debounce(() => {
    activeCoupons.search = search.value.trim().toLowerCase();
    activeCoupons.page = 1;
    renderActiveCoupons();
  }, 160));
}

async function loadPending() {
  const container = document.getElementById('pendingList');
  if (!container) return;
  if (pendingCoupons.loading) return;
  pendingCoupons.loading = true;
  const seq = ++pendingCoupons.seq;
  container.innerHTML = '<div class="cm-loading">Loading pending submissions…</div>';

  try {
    // 'pending' and 'proof_requested' are both still awaiting a decision, and
    // the API filters one status at a time — so fetch all and split here.
    const data = await api('/admin/coupons', { useAdmin: true });
    if (seq !== pendingCoupons.seq) return;
    const rows = (data.coupons || []).filter(
      (c) => c.status === 'pending' || c.status === 'proof_requested',
    );
    cmSetPendingBadge(rows.length);

    if (rows.length === 0) {
      container.innerHTML = cmStateHtml('⏳', 'No coupons awaiting approval', 'All caught up — new seller submissions land here.');
      return;
    }

    container.innerHTML = `
      <div class="table-card" style="margin-bottom:0">
        <div class="overflow-x">
          <table class="appr-table" style="min-width:1274px">
            <colgroup>
              <col style="width:200px"><col style="width:196px"><col style="width:118px">
              <col style="width:84px"><col style="width:84px"><col style="width:180px">
              <col style="width:132px"><col style="width:130px"><col style="width:150px">
            </colgroup>
            <thead>
              <tr>
                <th>Brand</th>
                <th>Code</th>
                <th>Category</th>
                <th>Value</th>
                <th>Price</th>
                <th>Seller</th>
                <th>Submitted</th>
                <th>Status</th>
                <th class="ta-right">Actions</th>
              </tr>
            </thead>
            <tbody>${rows.map(pendingRowHtml).join('')}</tbody>
          </table>
        </div>
        <div class="inv-tfoot">
          <span>${rows.length} submission${rows.length !== 1 ? 's' : ''} awaiting a decision</span>
          <button class="btn btn-ghost btn-sm" onclick="showSection('reviews')">Open Coupon Reviews →</button>
        </div>
      </div>
    `;
  } catch (err) {
    if (seq === pendingCoupons.seq) {
      container.innerHTML = cmStateHtml('⚠️', 'Failed to load pending submissions', escHtml(err.message || 'Unknown error'));
    }
  } finally {
    pendingCoupons.loading = false;
  }
}

/** One pending-submission row — approve/reject go through the review API. */
function pendingRowHtml(c) {
  const id = escHtml(c.id || '');
  const seller = c.sellerEmail || 'Admin';
  const proof = c.status === 'proof_requested';

  return `
    <tr data-coupon-id="${id}">
      <td>${cmBrandCellHtml(c.brand || '')}</td>
      <td><code class="inv-code">${escHtml(c.code || '')}</code></td>
      <td>${escHtml(c.category || '—')}</td>
      <td>₹${escHtml(c.originalValue || '—')}</td>
      <td class="inv-price">₹${escHtml(c.sellingPrice || '0')}</td>
      <td><div class="cm-seller-cell">${c.sellerEmail ? emailAvatarHtml(c.sellerEmail, 24) : ''}<span class="cm-seller" title="${escHtml(seller)}">${escHtml(seller)}</span></div></td>
      <td>${cmWhenHtml(c.addedAt || c.createdAt || '', '')}</td>
      <td><span class="badge badge-${proof ? 'blue' : 'orange'}">${escHtml(c.status || 'pending')}</span></td>
      <td>
        <div class="admin-actions ta-right">
          <button class="btn btn-ghost btn-xs" title="Open the full review record" onclick="openReviewModal('${id}')">🔍</button>
          <button class="btn btn-success btn-xs" title="Approve — publishes it to the marketplace" onclick="quickReviewAction('${id}','approve')">✓</button>
          <button class="btn btn-danger btn-xs" title="Reject this submission" onclick="quickReviewAction('${id}','reject')">✗</button>
        </div>
      </td>
    </tr>
  `;
}

// ── Shared bits for the two Coupon Management tables ────────────────────
function cmSetPendingBadge(count) {
  const badge = document.getElementById('pendingTabBadge');
  if (!badge) return;
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-block' : 'none';
}

function cmStateHtml(icon, title, sub) {
  return `
    <div class="empty-state">
      <div class="es-icon">${icon}</div>
      <div class="es-title">${title}</div>
      <div class="es-sub">${sub}</div>
    </div>
  `;
}

function cmPagerHtml(page, totalPages, fnName) {
  if (totalPages <= 1) return '<span></span>';
  const off = 'disabled style="opacity:.4;pointer-events:none"';
  return `
    <div style="display:flex;align-items:center;gap:8px">
      <button class="btn btn-ghost btn-sm" onclick="${fnName}(${page - 1})" ${page <= 1 ? off : ''}>‹ Prev</button>
      <span style="font-weight:700;color:#e2ecff">Page ${page} / ${totalPages}</span>
      <button class="btn btn-ghost btn-sm" onclick="${fnName}(${page + 1})" ${page >= totalPages ? off : ''}>Next ›</button>
    </div>
  `;
}

/** Brand logo + name, falling back to the initial tile when there's no logo. */
function cmBrandCellHtml(brand) {
  const logoUrl = typeof getBrandLogo === 'function' ? getBrandLogo(brand) : '';
  const logoClass = logoUrl && typeof getBrandLogoClass === 'function' ? getBrandLogoClass(logoUrl) : '';
  const initial = escHtml(
    typeof getBrandInitial === 'function' ? getBrandInitial(brand) : (brand || '?').slice(0, 1).toUpperCase(),
  );
  const logo = logoUrl
    ? `<img class="inv-brand-logo${logoClass ? ' ' + logoClass : ''}" src="${escHtml(logoUrl)}" alt="${escHtml(brand)}" loading="lazy"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
       ><span class="inv-brand-initial" style="display:none">${initial}</span>`
    : `<span class="inv-brand-initial">${initial}</span>`;
  return `
    <div class="inv-brand" title="${escHtml(brand)}">
      ${logo}<span class="appr-brand-name">${escHtml(brand || '—')}</span>
    </div>
  `;
}

/**
 * Date cell: absolute date on top, relative below. `fallback` is used when the
 * primary timestamp is missing (legacy rows approved before verifiedAt existed),
 * and is labelled as such so it is not read as an approval time.
 */
function cmWhenHtml(when, fallback) {
  const value = when || fallback;
  if (!value) return '<span class="admin-muted">—</span>';
  const rel = typeof timeAgo === 'function' ? timeAgo(value) : '';
  const title = new Date(value).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const note = when ? title : `Approval time not recorded — showing when it was submitted (${title})`;
  return `
    <div class="admin-dt" title="${escHtml(note)}">
      <div class="admin-dt-time">${escHtml(fmtDate(value))}${when ? '' : ' *'}</div>
      <div class="admin-dt-rel">${escHtml(rel)}</div>
    </div>
  `;
}

// ── Reports → Monthly Report Management ────────────────────────────────
// The current month's figures and how reporting itself is doing, then one card
// per completed month with its delivery state and per-recipient outcome. Opening
// the section also lets the server generate last month's report if the 1st has
// passed and it has not been produced yet, which is why the list can gain a card
// on a plain refresh — mrDedupeByMonth() keeps that from ever showing twice.

let monthlyReportsCache = [];
const mrFilters = { search: '', month: '', status: '', recipient: '' };

/** Keeps the first (newest) entry for each month key, preserving server order. */
function mrDedupeByMonth(reports) {
  const seen = new Set();
  return (reports || []).filter((r) => {
    const key = String(r && r.month || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Configured recipients only — an unconfigured slot is not a failed delivery. */
function mrConfigured(report) {
  return ((report && report.admins) || []).filter((a) => a && a.configured);
}

/**
 * One word for how a month's delivery went, and it drives both the card's badge
 * and its left rail.
 *   ok   every configured recipient received it
 *   warn some did, some did not
 *   bad  none did
 *   none no recipients are configured at all
 */
function mrDeliveryState(report) {
  const list = mrConfigured(report);
  if (!list.length) return 'none';
  const sent = list.filter((a) => String(a.status) === 'sent').length;
  if (sent === list.length) return 'ok';
  return sent ? 'warn' : 'bad';
}

const MR_STATE_LABEL = {
  ok: ['badge-green', 'Sent'],
  warn: ['badge-orange', 'Partly delivered'],
  bad: ['badge-red', 'Failed'],
  none: ['badge-gray', 'No recipients'],
};

/** Small local helper: admin.js has no shared text setter. */
function mrSetText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

async function loadMonthlyReports() {
  const table = document.getElementById('mrTable');
  if (!table) return;
  table.innerHTML = '<div class="cm-loading">Loading monthly reports…</div>';

  try {
    const data = await api('/admin/reports/monthly', { useAdmin: true });
    // One entry per month, newest first. The server already sorts and keys on
    // month, but a resend replaces a row and an auto-generation appends one, so
    // this de-dupes defensively: a repeated month key would otherwise render the
    // same report twice while still looking chronological.
    monthlyReportsCache = mrDedupeByMonth(data.reports || []);

    const cur = data.currentMonth || {};
    mrSetText('mrRevenue', `₹${Number(cur.revenue || 0).toLocaleString('en-IN')}`);
    mrSetText('mrBought', String(Number(cur.couponsBought || 0)));
    mrSetText('mrSold', String(Number(cur.couponsSold || 0)));
    mrSetText('mrRevenueSub', cur.periodLabel ? `${cur.monthLabel} · ${cur.periodLabel}` : 'Current month');
    mrRenderDeliveryMetrics();
    mrPopulateFilterOptions();

    const recipients = data.recipients || [];
    const note = document.getElementById('mrRecipients');
    if (note) {
      note.textContent = recipients.length
        ? `Generated automatically on the 1st and emailed to ${recipients.join(' and ')}.`
        : 'No admin recipients are configured, so reports cannot be delivered.';
    }

    if (data.notice) showToast(data.notice, 'warning');
    if (data.autoGenerated) showToast(`Generated the ${data.autoGenerated} report and emailed it to the admins.`, 'success');

    renderMonthlyReports();
    mrSetNavBadge(monthlyReportsCache);
  } catch (err) {
    if (err.sessionExpired) return;
    table.innerHTML = cmStateHtml('⚠️', 'Could not load monthly reports', escHtml(err.message || 'Please try again.'));
  }
}

/** Reports Generated + Delivery Success cells in the metric strip. */
function mrRenderDeliveryMetrics() {
  mrSetText('mrGenerated', String(monthlyReportsCache.length));
  const newest = monthlyReportsCache[0];
  mrSetText('mrGeneratedSub', newest
    ? `Latest: ${newest.monthLabel || newest.month}`
    : 'Months on record');

  let total = 0;
  let sent = 0;
  monthlyReportsCache.forEach((r) => {
    mrConfigured(r).forEach((a) => {
      total += 1;
      if (String(a.status) === 'sent') sent += 1;
    });
  });
  mrSetText('mrDelivery', total ? `${Math.round((sent / total) * 100)}%` : '—');
  mrSetText('mrDeliverySub', total
    ? `${sent} of ${total} deliveries succeeded`
    : 'Across all recipients');
}

/** Month and recipient dropdowns are built from the data actually on record. */
function mrPopulateFilterOptions() {
  const monthSel = document.getElementById('mrMonthFilter');
  if (monthSel) {
    const keep = monthSel.value;
    monthSel.innerHTML = '<option value="">All months</option>'
      + monthlyReportsCache.map((r) => `<option value="${escHtml(r.month)}">${escHtml(r.monthLabel || r.month)}</option>`).join('');
    monthSel.value = monthlyReportsCache.some((r) => r.month === keep) ? keep : '';
    mrFilters.month = monthSel.value;
  }

  const rcptSel = document.getElementById('mrRecipientFilter');
  if (rcptSel) {
    const keep = rcptSel.value;
    const seen = [];
    monthlyReportsCache.forEach((r) => mrConfigured(r).forEach((a) => {
      if (a.email && !seen.includes(a.email)) seen.push(a.email);
    }));
    rcptSel.innerHTML = '<option value="">All recipients</option>'
      + seen.map((e) => `<option value="${escHtml(e)}">${escHtml(e)}</option>`).join('');
    rcptSel.value = seen.includes(keep) ? keep : '';
    mrFilters.recipient = rcptSel.value;
  }
}

function mrApplyFilters() {
  mrFilters.search = String(document.getElementById('mrSearch')?.value || '').trim().toLowerCase();
  mrFilters.month = document.getElementById('mrMonthFilter')?.value || '';
  mrFilters.status = document.getElementById('mrStatusFilter')?.value || '';
  mrFilters.recipient = document.getElementById('mrRecipientFilter')?.value || '';
  renderMonthlyReports();
}

function mrClearFilters() {
  ['mrSearch', 'mrMonthFilter', 'mrStatusFilter', 'mrRecipientFilter'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  mrApplyFilters();
}

/** Filtering never reorders: the server's newest-first order is preserved. */
function mrVisibleReports() {
  return monthlyReportsCache.filter((r) => {
    if (mrFilters.month && String(r.month) !== mrFilters.month) return false;
    if (mrFilters.status && mrDeliveryState(r) !== mrFilters.status) return false;
    if (mrFilters.recipient
      && !mrConfigured(r).some((a) => a.email === mrFilters.recipient)) return false;
    if (mrFilters.search) {
      const hay = `${r.month || ''} ${r.monthLabel || ''} ${r.periodLabel || ''} `
        + mrConfigured(r).map((a) => a.email).join(' ');
      if (!hay.toLowerCase().includes(mrFilters.search)) return false;
    }
    return true;
  });
}

function renderMonthlyReports() {
  const list = document.getElementById('mrTable');
  if (!list) return;

  if (!monthlyReportsCache.length) {
    list.innerHTML = cmStateHtml(
      '🗓️',
      'No monthly report yet',
      'The first report is generated automatically on the 1st of next month and emailed to both admins.',
    );
    return;
  }

  const rows = mrVisibleReports();
  if (!rows.length) {
    list.innerHTML = cmStateHtml(
      '🔍',
      'No reports match these filters',
      'Try a different month, delivery state or recipient.',
    );
    return;
  }

  const note = rows.length === monthlyReportsCache.length
    ? `${rows.length} report${rows.length === 1 ? '' : 's'}, newest first`
    : `${rows.length} of ${monthlyReportsCache.length} reports`;
  list.innerHTML = `<div class="mr-count-note">${note}</div>` + rows.map(mrCardHtml).join('');
}


function mrWhen(iso, withTime = true) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', withTime
    ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Per-recipient state maps onto the same three tones as the card's rail. */
function mrRecipientTone(admin) {
  const s = String(admin && admin.status || '');
  if (s === 'sent') return 'ok';
  if (s === 'failed') return 'bad';
  return 'warn';
}

function mrCardHtml(r) {
  const month = escHtml(r.month || '');
  const state = mrDeliveryState(r);
  const [badgeClass, badgeText] = MR_STATE_LABEL[state] || MR_STATE_LABEL.none;
  const list = mrConfigured(r);
  const sent = list.filter((a) => String(a.status) === 'sent').length;

  const recipients = list.length
    ? list.map((a) => {
      const tone = mrRecipientTone(a);
      const when = mrWhen(a.at);
      return `
        <div class="mr-rcpt">
          <span class="mr-rcpt-dot ${tone}" aria-hidden="true"></span>
          ${a.email ? emailAvatarHtml(a.email, 20) : ''}
          <span class="mr-rcpt-mail">${escHtml(a.email || '—')}</span>
          ${when ? `<span class="mr-rcpt-when">${escHtml(when)}</span>` : ''}
        </div>
        ${a.error ? `<div class="mr-rcpt-err">${escHtml(a.email || 'Recipient')}: ${escHtml(a.error)}</div>` : ''}`;
    }).join('')
    : '<div class="mr-rcpt"><span class="mr-rcpt-mail">No admin recipients are configured.</span></div>';

  const generated = mrWhen(r.generatedAt);
  const resent = r.lastSentAt && r.lastSentAt !== r.generatedAt ? mrWhen(r.lastSentAt) : '';

  return `
    <div class="mr-card ${state}" data-month="${month}" tabindex="0" role="button"
         aria-label="Open details for ${escHtml(r.monthLabel || r.month || 'this report')}"
         onclick="mrOpenDrawer('${month}')"
         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();mrOpenDrawer('${month}');}">
      <div class="mr-card-top">
        <div style="min-width:0">
          <div class="mr-card-month">${escHtml(r.monthLabel || r.month || '—')}</div>
          <div class="mr-card-period">${escHtml(r.periodLabel || '—')}</div>
        </div>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>

      <div class="mr-card-metrics">
        <div class="mr-metric">
          <div class="mr-metric-lbl">Revenue</div>
          <div class="mr-metric-val green">₹${Number(r.revenue || 0).toLocaleString('en-IN')}</div>
        </div>
        <div class="mr-metric">
          <div class="mr-metric-lbl">Bought</div>
          <div class="mr-metric-val">${Number(r.couponsBought || 0)}</div>
        </div>
        <div class="mr-metric">
          <div class="mr-metric-lbl">Sold</div>
          <div class="mr-metric-val">${Number(r.couponsSold || 0)}</div>
        </div>
        <div class="mr-metric">
          <div class="mr-metric-lbl">Delivery</div>
          <div class="mr-metric-val">${list.length ? `${sent}/${list.length} Sent` : '—'}</div>
        </div>
      </div>

      <div class="mr-rcpt-lbl">Recipients</div>
      <div class="mr-rcpts">${recipients}</div>

      <div class="mr-card-foot">
        <span class="mr-gen">${generated ? `Generated: ${escHtml(generated)}` : 'Generation time not recorded'}${resent ? ` · Last sent: ${escHtml(resent)}` : ''}</span>
        <div class="mr-card-act" onclick="event.stopPropagation()">
          <button class="btn btn-ghost btn-xs" onclick="viewMonthlyReportPdf('${month}')" title="Open the report PDF">📄 View Report</button>
          <button class="btn btn-info btn-xs" onclick="resendMonthlyReport('${month}', this)" title="Email it to the configured admins again">✉️ Resend</button>
        </div>
      </div>
    </div>
  `;
}


/** Months where a configured admin still has not received the report. */
function mrSetNavBadge(reports) {
  const badge = document.getElementById('reportsNavBadge');
  if (!badge) return;
  const count = (reports || []).filter(
    (r) => (r.admins || []).some((a) => a && a.configured && a.status !== 'sent'),
  ).length;
  badge.textContent = String(count);
  badge.style.display = count ? 'inline-block' : 'none';
  badge.classList.toggle('green', false);
}

/**
 * The PDF route is admin-authenticated, so it cannot simply be opened as a URL —
 * the session token lives in localStorage, not in a cookie. Fetch it with the
 * header and hand the browser a blob instead.
 */
async function viewMonthlyReportPdf(month) {
  try {
    const token = Auth.getAdminToken() || Auth.getToken();
    const res = await fetch(`/api/admin/reports/monthly/${encodeURIComponent(month)}/pdf`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error || `Could not open the PDF (HTTP ${res.status}).`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) showToast('Allow pop-ups for this site to view the report PDF.', 'warning');
    // Revoked once the new tab has had time to load its own copy.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    showToast(err.message || 'Could not open the report PDF.', 'error');
  }
}

async function resendMonthlyReport(month, btn) {
  if (!confirm(`Email the ${month} report to the configured admins again?`)) return;

  const original = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Sending…'; }

  try {
    const data = await api(`/admin/reports/monthly/${encodeURIComponent(month)}/resend`, {
      method: 'POST',
      useAdmin: true,
    });
    // Replace just this month's row from the server's own record of the send.
    if (data.report) {
      const i = monthlyReportsCache.findIndex((r) => String(r.month) === String(month));
      if (i >= 0) monthlyReportsCache[i] = data.report;
      renderMonthlyReports();
      mrSetNavBadge(monthlyReportsCache);
    }
    const failed = (data.report && data.report.admins || []).filter((a) => a.configured && a.status !== 'sent');
    showToast(data.message || 'Report re-sent.', failed.length ? 'warning' : 'success');
  } catch (err) {
    if (!err.sessionExpired) showToast(err.message || 'Could not re-send the report.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  }
}

// ── Report details drawer ──────────────────────────────────────────────
// Opens over the list rather than navigating: the same cache the cards were
// rendered from is the only source, so the drawer can never disagree with them.
let mrDrawerMonth = '';

function mrOpenDrawer(month) {
  const r = monthlyReportsCache.find((x) => String(x.month) === String(month));
  if (!r) return;
  mrDrawerMonth = String(month);

  const list = mrConfigured(r);
  const sent = list.filter((a) => String(a.status) === 'sent').length;
  const [badgeClass, badgeText] = MR_STATE_LABEL[mrDeliveryState(r)] || MR_STATE_LABEL.none;

  mrSetText('mrDrawerTitle', r.monthLabel || r.month || 'Report');
  mrSetText('mrDrawerSub', r.periodLabel || '');

  const facts = [
    ['Report month', escHtml(r.monthLabel || r.month || '—'), ''],
    ['Report period', escHtml(r.periodLabel || '—'), ''],
    ['Revenue', `₹${Number(r.revenue || 0).toLocaleString('en-IN')}`, 'mono green'],
    ['Coupons bought', String(Number(r.couponsBought || 0)), 'mono'],
    ['Coupons sold', String(Number(r.couponsSold || 0)), 'mono'],
    ['Generated', escHtml(mrWhen(r.generatedAt) || 'Not recorded'), ''],
    ['Generated by', escHtml(r.generatedBy || 'Automatic'), ''],
    ['Last sent', escHtml(mrWhen(r.lastSentAt) || 'Never'), ''],
  ].map(([k, v, cls]) => `
    <div class="mr-dl-row">
      <span class="mr-dl-k">${k}</span>
      <span class="mr-dl-v ${cls}">${v}</span>
    </div>`).join('');

  const recipients = list.length
    ? list.map((a) => {
      const tone = mrRecipientTone(a);
      const label = { ok: 'Delivered', warn: 'Pending', bad: 'Failed' }[tone];
      const when = mrWhen(a.at);
      return `
        <div class="mr-dr-rcpt">
          <div class="mr-dr-rcpt-top">
            <span class="mr-rcpt-dot ${tone}" aria-hidden="true"></span>
            ${a.email ? emailAvatarHtml(a.email, 22) : ''}
            <span class="mr-dr-rcpt-mail">${escHtml(a.email || '—')}</span>
          </div>
          <div class="mr-dr-rcpt-meta">
            Status: <strong>${label}</strong>${when ? ` · ${escHtml(when)}` : ' · no delivery timestamp'}
          </div>
          ${a.error ? `<div class="mr-rcpt-err">${escHtml(a.error)}</div>` : ''}
        </div>`;
    }).join('')
    : '<div class="mr-dr-rcpt"><div class="mr-dr-rcpt-meta">No admin recipients are configured, so this report cannot be delivered.</div></div>';

  const body = document.getElementById('mrDrawerBody');
  if (body) {
    body.innerHTML = `
      <div class="mr-drawer-sec">Delivery</div>
      <div class="mr-dl">
        <div class="mr-dl-row">
          <span class="mr-dl-k">Overall</span>
          <span class="mr-dl-v"><span class="badge ${badgeClass}">${badgeText}</span></span>
        </div>
        <div class="mr-dl-row">
          <span class="mr-dl-k">Recipients reached</span>
          <span class="mr-dl-v mono">${list.length ? `${sent} of ${list.length}` : '—'}</span>
        </div>
      </div>
      <div class="mr-drawer-sec">Report</div>
      <div class="mr-dl">${facts}</div>
      <div class="mr-drawer-sec">Recipients</div>
      ${recipients}`;
  }

  // Rebound each open so the buttons always act on the month on screen.
  const pdf = document.getElementById('mrDrawerPdf');
  if (pdf) pdf.onclick = () => viewMonthlyReportPdf(mrDrawerMonth);
  const resend = document.getElementById('mrDrawerResend');
  if (resend) resend.onclick = () => resendMonthlyReport(mrDrawerMonth, resend);

  document.getElementById('mrDrawer')?.classList.add('open');
  document.getElementById('mrDrawerScrim')?.classList.add('open');
}

function mrCloseDrawer() {
  document.getElementById('mrDrawer')?.classList.remove('open');
  document.getElementById('mrDrawerScrim')?.classList.remove('open');
  mrDrawerMonth = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('mrDrawer')?.classList.contains('open')) {
    mrCloseDrawer();
  }
});

/** Header action: the newest report on record, without hunting for its card. */
function mrViewLatestPdf() {
  const newest = monthlyReportsCache[0];
  if (!newest) {
    showToast('There is no report to open yet.', 'warning');
    return;
  }
  viewMonthlyReportPdf(newest.month);
}

// ── Coupon Reviews (In-Panel) ──────────────────────────────────────────
let reviewsCache = { pending: [], available: [], rejected: [] };
let reviewsLoading = false;
let currentReviewCouponId = null;
let currentReviewData = null;

async function loadReviews() {
  if (reviewsLoading) return;
  reviewsLoading = true;
  try {
    const data = await api('/admin/coupons', { useAdmin: true });
    const all = data.coupons || [];
    reviewsCache.pending = all.filter(c => c.status === 'pending' || c.status === 'proof_requested');
    reviewsCache.available = all.filter(c => c.status === 'available');
    reviewsCache.rejected = all.filter(c => c.status === 'rejected');

    // Update nav badge in sidebar
    const navBadge = document.getElementById('reviewsNavBadge');
    if (navBadge) {
      navBadge.textContent = reviewsCache.pending.length;
      navBadge.style.display = reviewsCache.pending.length > 0 ? 'inline-block' : 'none';
    }
    // Update tab badge
    const tabBadge = document.getElementById('reviewPendingBadge');
    if (tabBadge) {
      tabBadge.textContent = reviewsCache.pending.length;
      tabBadge.style.display = reviewsCache.pending.length > 0 ? 'inline-block' : 'none';
    }

    renderReviewTable('pending', reviewsCache.pending);
    renderReviewTable('approved', reviewsCache.available);
    renderReviewTable('rejected', reviewsCache.rejected);
    // Coupon Management's ⏳ Pending tab badge, so the count is right before
    // that tab has ever been opened.
    cmSetPendingBadge(reviewsCache.pending.length);
  } catch (err) {
    const el = document.getElementById('reviewsPendingTable');
    if (el) el.innerHTML = `<p class="text-danger">Failed to load reviews: ${err.message}</p>`;
  } finally {
    reviewsLoading = false;
  }
}

function renderReviewTable(type, coupons) {
  const containerId = type === 'approved' ? 'reviewsApprovedTable' : type === 'rejected' ? 'reviewsRejectedTable' : 'reviewsPendingTable';
  const container = document.getElementById(containerId);
  if (!container) return;

  if (coupons.length === 0) {
    const label = type === 'pending' ? 'pending review' : type === 'approved' ? 'approved' : 'rejected';
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${type === 'pending' ? '⏳' : type === 'approved' ? '✅' : '❌'}</div>
        <h3>No ${label} coupons</h3>
        <p>${type === 'pending' ? 'All caught up! No coupons awaiting review.' : `No ${label} coupons found.`}</p>
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
            <th>Value</th>
            <th>Price</th>
            <th>Seller</th>
            <th>Submitted</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${coupons.map(c => {
            const submittedDate = c.createdAt || c.addedAt ? new Date(c.createdAt || c.addedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
            const statusBadge = c.status === 'available' ? 'green' : c.status === 'rejected' ? 'red' : c.status === 'proof_requested' ? 'blue' : 'amber';
            const sellerDisplay = c.sellerEmail || 'Admin';
            return `
              <tr>
                <td><code style="background:rgba(37,99,235,.12);padding:2px 8px;border-radius:4px;color:#4fc3f7;font-weight:600">${escapeHtml(c.code)}</code></td>
                <td style="font-weight:600;color:#e2ecff">${escapeHtml(c.brand)}</td>
                <td>${escapeHtml(c.category || 'General')}</td>
                <td>₹${escapeHtml(c.originalValue || '—')}</td>
                <td style="font-weight:700;color:#00e676">₹${escapeHtml(c.sellingPrice || '0')}</td>
                <td style="font-size:.8rem;color:#a8c0dc;max-width:140px" title="${escapeHtml(sellerDisplay)}"><div class="cm-seller-cell">${c.sellerEmail ? emailAvatarHtml(c.sellerEmail, 22) : ''}<span class="cm-seller">${escapeHtml(sellerDisplay)}</span></div></td>
                <td style="font-size:.78rem;color:#6b88aa">${submittedDate}</td>
                <td><span class="badge badge-${statusBadge}">${escapeHtml(c.status || 'pending')}</span></td>
                <td>
                  <div style="display:flex;gap:6px;flex-wrap:nowrap;align-items:center">
                    <button class="btn btn-ghost btn-sm" onclick="openReviewModal('${escapeHtml(c.id)}')" title="Review Full Details" style="border:1px solid rgba(79,195,247,.3);color:#4fc3f7">🔍 Review</button>
                    ${type === 'pending' ? `
                      <button class="btn btn-success btn-sm" onclick="quickReviewAction('${escapeHtml(c.id)}','approve')" title="Quick Approve">✓</button>
                      <button class="btn btn-danger btn-sm" onclick="quickReviewAction('${escapeHtml(c.id)}','reject')" title="Quick Reject">✗</button>
                    ` : ''}
                  </div>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="padding:10px 16px;font-size:.78rem;color:#6b88aa;border-top:1px solid rgba(79,195,247,.08)">
      ${coupons.length} ${type} coupon${coupons.length !== 1 ? 's' : ''}
    </div>
  `;
}

async function quickReviewAction(couponId, action) {
  if (!confirm(`Are you sure you want to ${action} this coupon?`)) return;
  try {
    const data = await api(`/admin/coupons/${couponId}/review-action`, {
      method: 'POST',
      useAdmin: true,
      body: { action },
    });
    if (typeof showToast === 'function') showToast(data.message || `Coupon ${action}d successfully!`, 'success');
    // Coupon Management shows the same two sets, so keep its tables in step.
    refreshCouponViews();
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Failed to ${action} coupon: ${err.message}`, 'error');
  }
}

function showReviewTab(tab, btnEl) {
  const tabRow = btnEl?.closest('.tab-row');
  if (tabRow) {
    tabRow.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
  }
  // Toggle tab content
  const section = document.getElementById('sec-reviews');
  if (section) {
    section.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    const target = document.getElementById(`rtab-${tab}`);
    if (target) target.classList.add('active');
  }
}

// ── In-Panel Review Modal Logic ─────────────────────────────────────────
async function openReviewModal(couponId) {
  currentReviewCouponId = couponId;
  const modal = document.getElementById('adminReviewModal');
  const loading = document.getElementById('armLoading');
  const content = document.getElementById('armContent');
  if (!modal) return;

  modal.style.display = 'flex';
  if (loading) loading.style.display = 'block';
  if (content) content.style.display = 'none';

  const couponIdEl = document.getElementById('armCouponId');
  if (couponIdEl) couponIdEl.textContent = `ID: ${couponId}`;

  try {
    const data = await api(`/admin/coupons/${encodeURIComponent(couponId)}/review`, { useAdmin: true });
    currentReviewData = data;
    const c = data.coupon || {};

    // Header Badge
    const statusBadgeEl = document.getElementById('armStatusBadge');
    if (statusBadgeEl) {
      const s = String(c.status || 'pending').toLowerCase();
      const bColor = s === 'available' ? 'green' : s === 'rejected' ? 'red' : s === 'proof_requested' ? 'blue' : 'amber';
      statusBadgeEl.innerHTML = `<span class="badge badge-${bColor}">${escapeHtml(s)}</span>`;
    }

    // Coupon Details
    const brandEl = document.getElementById('armBrand');
    if (brandEl) brandEl.textContent = c.brand || '—';

    const codeEl = document.getElementById('armCode');
    if (codeEl) {
      codeEl.innerHTML = `<code style="background:rgba(37,99,235,.15);padding:3px 10px;border-radius:6px;color:#4fc3f7;font-weight:700;font-family:'JetBrains Mono',monospace;letter-spacing:1px">${escapeHtml(c.code || '—')}</code>`;
    }

    const catEl = document.getElementById('armCategory');
    if (catEl) catEl.textContent = c.category || 'General';

    const typeEl = document.getElementById('armType');
    if (typeEl) typeEl.textContent = c.type || 'Public';

    const valEl = document.getElementById('armValue');
    if (valEl) valEl.textContent = c.originalValue ? `₹${c.originalValue}` : '—';

    const priceEl = document.getElementById('armPrice');
    if (priceEl) priceEl.textContent = c.sellingPrice ? `₹${c.sellingPrice}` : '₹0';

    const descEl = document.getElementById('armDesc');
    if (descEl) descEl.textContent = c.description || c.title || '—';

    const expEl = document.getElementById('armExpiry');
    if (expEl) expEl.textContent = c.expiryDate ? new Date(c.expiryDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

    const subEl = document.getElementById('armSubmitted');
    if (subEl) subEl.textContent = c.addedAt || c.createdAt ? new Date(c.addedAt || c.createdAt).toLocaleString('en-IN') : '—';

    // Seller Details — the account's own Google photo beside the address.
    const sEmailEl = document.getElementById('armSellerEmail');
    if (sEmailEl) {
      const sellerEmail = c.sellerEmail || '';
      sEmailEl.innerHTML = sellerEmail
        ? `<span style="display:inline-flex;align-items:center;gap:8px;min-width:0">`
          + `${emailAvatarHtml(sellerEmail, 24)}`
          + `<span style="overflow-wrap:anywhere">${escapeHtml(sellerEmail)}</span></span>`
        : 'Admin';
    }

    const sIdEl = document.getElementById('armSellerId');
    if (sIdEl) sIdEl.textContent = c.sellerUserId || '—';

    const sourceEl = document.getElementById('armSource');
    if (sourceEl) sourceEl.textContent = c.source || 'user-submitted';

    // Duplicate Check
    const dupEl = document.getElementById('armDuplicateCheck');
    if (dupEl) {
      const dup = data.duplicateCheck || {};
      if (dup.isDuplicate) {
        dupEl.innerHTML = `
          <div style="background:rgba(255,82,82,.12);border:1px solid rgba(255,82,82,.3);border-radius:8px;padding:8px 12px;color:#ef9a9a;">
            <strong>⚠️ Duplicate Found:</strong> Another coupon with code <code>${escapeHtml(c.code)}</code> exists (Status: ${escapeHtml(dup.duplicateStatus || '—')}).
          </div>
        `;
      } else {
        dupEl.innerHTML = `
          <div style="background:rgba(0,230,118,.1);border:1px solid rgba(0,230,118,.25);border-radius:8px;padding:8px 12px;color:#00e676;">
            ✅ No other coupon with this code was found.
          </div>
        `;
      }
    }

    // WhatsApp Notification Status
    renderReviewModalNotify(data.notification || {});

    // Proof screenshot
    const proofContainer = document.getElementById('armProofContainer');
    if (proofContainer) {
      if (c.proofUrl) {
        const rawUrl = String(c.proofUrl);
        let imgSrc = rawUrl;
        let linkHref = rawUrl;
        if (rawUrl.startsWith('drive:')) {
          const fileId = rawUrl.slice('drive:'.length);
          imgSrc = '/api/proxy/drive/' + encodeURIComponent(fileId);
          linkHref = imgSrc;
        }
        proofContainer.innerHTML = `
          <a href="${escapeHtml(linkHref)}" target="_blank" rel="noopener" style="display:inline-block">
            <img src="${escapeHtml(imgSrc)}" alt="Coupon Proof" style="max-width:100%;max-height:280px;border-radius:8px;border:1px solid rgba(79,195,247,.2);box-shadow:0 8px 24px rgba(0,0,0,.4);" />
            <div style="margin-top:6px;font-size:.78rem;color:#4fc3f7;">↗ Click to open full size</div>
          </a>
        `;
      } else {
        proofContainer.innerHTML = `<span style="color:#6b88aa;font-size:.82rem">No proof screenshot was submitted with this coupon.</span>`;
      }
    }

    // Admin Notes
    const notesEl = document.getElementById('armAdminNotes');
    if (notesEl) notesEl.value = c.adminNotes || '';

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'block';
  } catch (err) {
    if (loading) loading.innerHTML = `<div class="text-danger">Failed to load coupon details: ${escapeHtml(err.message)}</div>`;
  }
}

function renderReviewModalNotify(n) {
  const notifyEl = document.getElementById('armNotificationInfo');
  if (!notifyEl) return;
  const status = String(n.status || 'pending').toLowerCase();
  const badgeColor = status === 'sent' ? 'green' : status === 'failed' ? 'red' : 'amber';
  notifyEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="badge badge-${badgeColor}">Status: ${escapeHtml(status)}</span>
      <span style="color:#6b88aa;font-size:.76rem">SID: ${escapeHtml(n.sid || '—')}</span>
      ${n.lastAttempt ? `<span style="color:#6b88aa;font-size:.76rem">· ${new Date(n.lastAttempt).toLocaleString('en-IN')}</span>` : ''}
    </div>
    ${n.error ? `<div style="color:#ff6b6b;font-size:.76rem;margin-top:4px">${escapeHtml(n.error)}</div>` : ''}
  `;
}

function closeReviewModal() {
  const modal = document.getElementById('adminReviewModal');
  if (modal) modal.style.display = 'none';
  currentReviewCouponId = null;
  currentReviewData = null;
}

async function submitReviewModalAction(action) {
  if (!currentReviewCouponId) return;
  const buttons = ['armApproveBtn', 'armRejectBtn', 'armProofBtn'];
  buttons.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = true;
  });

  const notesEl = document.getElementById('armAdminNotes');
  const notes = notesEl ? notesEl.value.trim() : '';

  try {
    const data = await api(`/admin/coupons/${encodeURIComponent(currentReviewCouponId)}/review-action`, {
      method: 'POST',
      useAdmin: true,
      body: { action, notes },
    });
    if (typeof showToast === 'function') showToast(data.message || `Coupon ${action}d successfully!`, 'success');
    closeReviewModal();
    loadReviews();
    if (typeof loadAdminStats === 'function') loadAdminStats();
    if (typeof loadInventory === 'function') loadInventory();
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Action failed: ${err.message}`, 'error');
  } finally {
    buttons.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = false;
    });
  }
}

async function retryReviewModalNotify() {
  if (!currentReviewCouponId) return;
  const btn = document.getElementById('armRetryNotifyBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Retrying…'; }

  try {
    const data = await api(`/admin/coupons/${encodeURIComponent(currentReviewCouponId)}/notify-retry`, {
      method: 'POST',
      useAdmin: true,
    });
    if (typeof showToast === 'function') showToast(data.message || 'Notification retry initiated.', 'success');
    if (data.notification) renderReviewModalNotify(data.notification);
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Retry failed: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Retry'; }
  }
}

// Global functions for inline onclick handlers
window.loadInventory = loadInventory;
window.invPrev = invPrev;
window.invNext = invNext;
window.invGoToPage = invGoToPage;
window.loadReviews = loadReviews;
window.showReviewTab = showReviewTab;
window.quickReviewAction = quickReviewAction;
window.openReviewModal = openReviewModal;
window.closeReviewModal = closeReviewModal;
window.submitReviewModalAction = submitReviewModalAction;
window.retryReviewModalNotify = retryReviewModalNotify;
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

/* ── User avatars ──────────────────────────────────────────────────────
   These render the account's OWN Google profile photo, captured at Google
   login and served as `profilePicture` by GET /api/admin/users.

   This used to point every avatar at https://unavatar.io/<email>, a third-party
   service that guesses a photo from an email address. That was wrong twice
   over: the photo it returned was not necessarily the user's real Gmail one,
   and it disclosed every user's email address to an outside service on every
   load of the admin panel. Nothing here leaves our own origin now, apart from
   Google's own image host.

   An account with no photo on file — never logged in with Google, or a Google
   account without a picture — falls back to the initials tile. */

/** Only Google's own image hosts are ever loaded as a user photo. */
function safeProfilePictureUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return '';
    // googleusercontent.com serves the avatars; www.google.com is used by a few
    // older accounts. Anything else (including a hand-edited sheet cell) is
    // ignored rather than injected into the page.
    const okHost = /(^|\.)googleusercontent\.com$/.test(u.hostname)
      || /(^|\.)google\.com$/.test(u.hostname);
    return okHost ? u.href : '';
  } catch (e) {
    return '';
  }
}

/**
 * Avatar markup for one user row or panel.
 * @param {object} user  needs { profilePicture, name }
 * @param {number} size  px; drives the box and the fallback's font size
 * @param {string} extra optional extra CSS on both the img and the fallback
 */
function userAvatarHtml(user, size = 28, extra = '') {
  const initials = escapeHtml(userInitials(user && user.name));
  const box = `width:${size}px;height:${size}px;min-width:${size}px;border-radius:50%;flex-shrink:0`;
  const tile = `${box};display:flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.38)}px;${extra}`;
  const src = safeProfilePictureUrl(user && user.profilePicture);

  if (!src) {
    return `<div class="u-avatar" style="${tile}">${initials}</div>`;
  }

  // The photo and the initials tile are siblings and `onerror` only flips their
  // `display` — the same pattern the marketplace brand logos use. Building the
  // fallback as an HTML string inside the `onerror` attribute instead breaks as
  // soon as that string contains a quote, which is exactly what happened on the
  // first cut of this function: the `class="u-avatar"` in the fallback closed
  // the attribute early and leaked raw markup into the cell as visible text.
  //
  // referrerpolicy="no-referrer" is required: Google's avatar host rejects
  // requests carrying a referrer from an unregistered origin, which would leave
  // every photo broken. The hidden tile takes over if the URL has expired —
  // Google rotates them and we only refresh on the account's next login.
  return `<span style="display:inline-flex;align-items:center;flex-shrink:0">`
    + `<img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer"`
    + ` style="${box};object-fit:cover;${extra}"`
    + ` onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    + `<div class="u-avatar" style="${tile};display:none">${initials}</div>`
    + `</span>`;
}

/* ── Email → Google photo directory ───────────────────────────────────────
   Most admin sections carry only an email: a coupon row has sellerEmail, a
   payout has sellerEmail, a session has email. The Google photo lives on the
   user record, so those sections resolve it through this directory rather than
   deriving anything from the address itself.

   The lookup is an exact match on the lowercased email against the canonical
   users list, so a row can only ever show that account's own photo. An address
   with no matching user record — an admin-created coupon, a deleted account —
   keeps its initials tile. */

const userDirectory = new Map();
let userDirectoryPromise = null;

function rebuildUserDirectory() {
  userDirectory.clear();
  (usersCache || []).forEach((u) => {
    const key = String(u.email || '').toLowerCase().trim();
    if (key) userDirectory.set(key, u);
  });
}

/**
 * Loads the users list once so any section can resolve an email to its photo,
 * then upgrades the placeholders already on screen. Sections call this without
 * awaiting it: the avatars start as initials and fill in when it lands.
 */
function ensureUserDirectory() {
  if (userDirectory.size) return Promise.resolve();
  if (userDirectoryPromise) return userDirectoryPromise;

  userDirectoryPromise = (async () => {
    try {
      if (!usersCache.length) {
        const data = await api('/admin/users', { useAdmin: true });
        usersCache = data.users || [];
      }
      rebuildUserDirectory();
      hydrateEmailAvatars();
    } catch (e) {
      // A directory that cannot load is not an error worth showing an admin:
      // every avatar simply stays an initials tile.
      userDirectoryPromise = null;
    }
  })();
  return userDirectoryPromise;
}

/** Initials from an email local part, for an address with no user record. */
function emailInitials(email) {
  const local = String(email || '').split('@')[0];
  const word = local.split(/[\s._-]+/).filter(Boolean)[0] || '';
  return (word.slice(0, 2) || '?').toUpperCase();
}

/**
 * Avatar for a row that knows only an email address. Renders an initials tile
 * immediately and marks itself for hydrateEmailAvatars() to upgrade to the
 * account's Google photo once the directory is loaded, so a table never waits on
 * a second request to paint.
 */
function emailAvatarHtml(email, size = 28, extra = '') {
  const addr = String(email || '').trim();
  const key = addr.toLowerCase();
  const box = `width:${size}px;height:${size}px;min-width:${size}px;border-radius:50%;flex-shrink:0`;
  const tile = `${box};display:flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.38)}px;${extra}`;

  // Already known: render the real photo straight away.
  const known = key && userDirectory.get(key);
  if (known) return userAvatarHtml(known, size, extra);

  // First use from any section pulls the directory in. Single-flight, so calling
  // it once per row in a map() costs nothing.
  if (key) ensureUserDirectory();

  const slot = key
    ? ` data-avatar-email="${escapeHtml(key)}" data-avatar-size="${size}" data-avatar-extra="${escapeHtml(extra)}"`
    : '';
  return `<span class="u-avatar-slot" style="display:inline-flex;align-items:center;flex-shrink:0"${slot}>`
    + `<div class="u-avatar" style="${tile}">${escapeHtml(emailInitials(addr))}</div></span>`;
}

/** Swaps every pending placeholder for the matching account's Google photo. */
function hydrateEmailAvatars(root) {
  const scope = root || document;
  scope.querySelectorAll('.u-avatar-slot[data-avatar-email]').forEach((slot) => {
    const rec = userDirectory.get(slot.dataset.avatarEmail || '');
    if (!rec) return; // no such account — the initials tile is the right answer
    slot.innerHTML = userAvatarHtml(rec, Number(slot.dataset.avatarSize) || 28,
      slot.dataset.avatarExtra || '');
    slot.removeAttribute('data-avatar-email');
  });
}

// vault.html's inline script renders the payout sections, so these have to be
// reachable from there the same way loadUsers() already is.
window.emailAvatarHtml = emailAvatarHtml;
window.userAvatarHtml = userAvatarHtml;
window.hydrateEmailAvatars = hydrateEmailAvatars;
window.ensureUserDirectory = ensureUserDirectory;

function userStatusBadge(status) {
  const s = String(status || 'active').toLowerCase();
  if (s === 'suspended' || s === 'banned') return statusTag('suspended');
  if (s === 'active') return statusTag('active');
  return `<span class="badge badge-orange">${escapeHtml(status)}</span>`;
}

/**
 * The one status tag used everywhere: User Management, Recent Login History,
 * User Sessions and Admin Sessions. Same pill shape in every table — green for
 * Active, red for Suspended, grey once a session has ended.
 */
function statusTag(kind, label) {
  const map = {
    active: ['badge-green', 'Active'],
    suspended: ['badge-danger', 'Suspended'],
    'logged out': ['badge-gray', 'Logged out'],
    expired: ['badge-orange', 'Expired'],
    offline: ['badge-gray', 'Offline'],
  };
  const [cls, fallback] = map[String(kind || '').toLowerCase()] || ['badge-blue', kind || '—'];
  return `<span class="badge ${cls}">${escapeHtml(label || fallback)}</span>`;
}

/**
 * Google logins get the Google mark, email / OTP logins get the Gmail mark,
 * both on a 38px plate so they are actually legible in a table row.
 */
function loginMethodBadge(method) {
  const m = String(method || '').toLowerCase().trim();
  const plate = (src, label) =>
    `<span class="login-method-icon" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">` +
    `<img src="${src}" alt="${escapeHtml(label)}"></span>`;
  if (m.includes('google')) return plate('/google.png', method || 'Google');
  if (m.includes('otp')) return plate('/gmail.svg', method || 'Email OTP');
  if (m.includes('email') || m.includes('mail')) return plate('/gmail.svg', method || 'Email');
  // Admin panel password logins are email-based too — "Google Admin" already
  // matched above, so anything left here signed in with an email address.
  if (m.includes('admin') || m.includes('password')) return plate('/gmail.svg', method || 'Email');
  if (m) return `<span style="font-size:.82rem;color:#6b88aa">${escapeHtml(method)}</span>`;
  return '<span style="font-size:.82rem;color:#6b88aa">—</span>';
}

function userSessionStatusBadge(sessionStatus, accountStatus) {
  const ss = String(sessionStatus || '').toLowerCase();
  const as = String(accountStatus || 'active').toLowerCase();
  if (as === 'suspended' || as === 'banned') return statusTag('suspended');
  if (ss === 'active') return statusTag('active');
  if (ss === 'logged out' || ss === 'expired') return statusTag('logged out');
  return statusTag('offline');
}

async function loadUsers() {
  // Single-flight: ignore re-entries while a previous call is still in flight.
  if (usersLoading) return;
  usersLoading = true;
  const body = document.getElementById('usersTableBody');
  try {
    const data = await api('/admin/users', { useAdmin: true });
    usersCache = (data.users || []).slice().sort((a, b) => String(b.lastLoginAt || b.createdAt || '').localeCompare(String(a.lastLoginAt || a.createdAt || '')));
    // Refresh the email → photo directory from the same payload, then upgrade any
    // placeholder avatars another section already painted.
    rebuildUserDirectory();
    hydrateEmailAvatars();

    const c = data.counts || {};
    const total = c.total ?? usersCache.length;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('usersTotalCount', total);
    set('usersActiveCount', c.active ?? '—');
    set('usersSuspendedCount', c.suspended ?? '—');
    set('usersNavBadge', total);
    const sub = document.getElementById('usersSubtitle');
    if (sub) sub.textContent = `${total} total registered user${total === 1 ? '' : 's'}`;

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
    const idAttr = escapeHtml(u.id);
    const nameAttr = escapeHtml(String(u.name || '').replace(/'/g, '&#39;'));
    const emailAttr = escapeHtml(String(u.email || '').replace(/'/g, '&#39;'));
    const toggleAction = suspended
      ? `<span class="user-action-activate" onclick="toggleUserStatus('${idAttr}','active')">✅ Activate</span>`
      : `<span class="user-action-suspend" onclick="openSuspendModal('${idAttr}','${nameAttr}','${emailAttr}')">🚫 Suspend</span>`;
    return `<tr>
      <td style="text-align:center"><strong>${escapeHtml(u.name)}</strong></td>
      <td><div style="display:flex;align-items:center;gap:8px">${userAvatarHtml(u, 28)}<a href="mailto:${escapeHtml(u.email || '')}" style="color:#4fc3f7;font-size:.83rem">${escapeHtml(u.email || '—')}</a></div></td>
      <td style="text-align:center;font-size:.82rem;color:#a8c0dc">${fmtDateTime(u.lastLoginAt)}</td>
      <td style="text-align:center;font-size:.82rem;color:#a8c0dc">${fmtDateTime(u.lastLogoutAt)}</td>
      <td style="text-align:center">${loginMethodBadge(u.loginMethod)}</td>
      <td style="text-align:center">${userSessionStatusBadge(u.sessionStatus, u.status)}</td>
      <td style="text-align:center"><span class="mono" style="font-weight:600;color:#ce93d8">${u.couponsBought || 0}</span></td>
      <td style="text-align:center"><span class="mono" style="font-weight:600;color:#00e676">${u.couponsSold || 0}</span></td>
      <td style="text-align:center">${toggleAction}</td>
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
    <td style="text-align:center"><strong>${escapeHtml(u.name)}</strong></td>
    <td><div style="display:flex;align-items:center;gap:8px">${userAvatarHtml(u, 28)}<a href="mailto:${escapeHtml(u.email || '')}" style="color:#4fc3f7;font-size:.83rem">${escapeHtml(u.email || '—')}</a></div></td>
    <td style="text-align:center;font-size:.82rem;color:#a8c0dc">${fmtDateTime(u.lastLoginAt)}</td>
    <td style="text-align:center;font-size:.82rem;color:#a8c0dc">${fmtDateTime(u.lastLogoutAt)}</td>
    <td style="text-align:center">${loginMethodBadge(u.loginMethod)}</td>
    <td style="text-align:center">${userSessionStatusBadge(u.sessionStatus, u.status)}</td>
  </tr>`).join('');
}

/* ── Suspend user: reason is mandatory ─────────────────────────────────
   Suspending an account is not a one-click action. The modal collects the
   suspension text and Confirm stays disabled until at least 3 characters
   have been typed, so no account is ever suspended without a stated reason. */
let suspendTargetId = null;

function openSuspendModal(userId, name, email) {
  suspendTargetId = userId;
  const overlay = document.getElementById('suspendModal');
  if (!overlay) { // modal markup missing — fall back to the plain prompt
    const reason = window.prompt('Reason for suspending this account:');
    if (reason && reason.trim().length >= 3) toggleUserStatus(userId, 'suspended', reason.trim());
    return;
  }
  const who = document.getElementById('suspendModalUser');
  if (who) {
    who.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;min-width:0">`
      + `${email ? emailAvatarHtml(email, 24) : '👤'}`
      + `<span style="overflow-wrap:anywhere"><strong>${escapeHtml(name || 'This user')}</strong>`
      + `${email ? ' · ' + escapeHtml(email) : ''}</span></span>`;
  }
  const ta = document.getElementById('suspendReason');
  if (ta) ta.value = '';
  syncSuspendConfirm();
  overlay.classList.add('open');
  setTimeout(() => ta && ta.focus(), 60);
}

function closeSuspendModal() {
  suspendTargetId = null;
  document.getElementById('suspendModal')?.classList.remove('open');
}

// Confirm is only clickable once a reason has actually been written.
function syncSuspendConfirm() {
  const ta = document.getElementById('suspendReason');
  const btn = document.getElementById('suspendConfirmBtn');
  if (!btn) return;
  btn.disabled = String(ta?.value || '').trim().length < 3;
}

async function confirmSuspendUser() {
  const reason = String(document.getElementById('suspendReason')?.value || '').trim();
  if (!suspendTargetId) return;
  if (reason.length < 3) {
    showToast('Enter the suspension reason first.', 'warning');
    return;
  }
  const userId = suspendTargetId;
  closeSuspendModal();
  await toggleUserStatus(userId, 'suspended', reason);
}

async function toggleUserStatus(userId, nextStatus, reason) {
  // Suspension always goes through openSuspendModal(), which supplies the
  // reason; only reactivation still asks for a plain confirmation.
  if (nextStatus === 'suspended' && !String(reason || '').trim()) {
    openSuspendModal(userId);
    return;
  }
  if (nextStatus !== 'suspended' && !confirm('Reactivate this user?')) return;
  try {
    const body = { userId, status: nextStatus };
    if (nextStatus === 'suspended') body.reason = String(reason).trim();
    await api('/admin/users/status', { method: 'PUT', useAdmin: true, body });
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
  // The account's real Google photo, at panel size, keeping the green ring the
  // header already had. Falls back to the initials tile when none is on file.
  const avatarHtml = userAvatarHtml(user, 52, 'border:2px solid rgba(0,230,118,.3)');

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
          <div style="min-width:0;flex:1">
            <div style="font-weight:700;font-size:1.05rem;color:#e2ecff;overflow-wrap:anywhere">${escapeHtml(user.name)}</div>
            <a href="mailto:${emailStr}" title="${emailStr}" style="font-size:.82rem;color:#4fc3f7;display:block;overflow-wrap:anywhere">${emailStr || '—'}</a>
          </div>
          <span style="flex-shrink:0">${userSessionStatusBadge(user.sessionStatus, user.status)}</span>
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
            : `<button class="btn btn-danger btn-sm" onclick="document.getElementById('userDetailModal')?.remove();openSuspendModal('${escapeHtml(user.id)}','${escapeHtml(String(user.name || '').replace(/'/g, '&#39;'))}','${escapeHtml(String(user.email || '').replace(/'/g, '&#39;'))}')">🚫 Suspend</button>`
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
  if (s === 'active') return statusTag('active');
  if (s === 'logged out') return statusTag('logged out');
  if (s === 'expired') return statusTag('expired');
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
      sub.textContent = `${total} total session${total === 1 ? '' : 's'} · live from Supabase user_sessions table`;
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
    const isActive = String(s.status || '').toLowerCase() === 'active';
    const idAttr = escapeHtml(s.session_id || '');
    return `<tr>
      <td title="user_id: ${escapeHtml(s.user_id || '—')}"><div style="display:flex;align-items:center;gap:10px">${emailAvatarHtml(s.email, 28)}<strong>${escapeHtml(email)}</strong></div></td>
      <td>${escapeHtml(sessionListLabel(s, ['device', 'os', 'browser']))}</td>
      <td>${escapeHtml(sessionLocation(s))}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.78rem">${escapeHtml(s.ip_address || '—')}</td>
      <td>${loginMethodBadge(s.login_method || 'Email')}</td>
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
    refreshCouponViews();
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
    refreshCouponViews();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/**
 * Every view that reads the coupon list. Called after an approve or a delete so
 * Coupon Management and Coupon Reviews agree without the admin having to
 * refresh. (deleteCoupon() also used to call loadExpiredCoupons() — there has
 * never been such a function or an expired-coupons container; expired coupons
 * show up in the inventory table with an "Expired" chip.)
 */
function refreshCouponViews() {
  loadAdminStats();
  loadInventory();
  loadPending();
  loadActiveCoupons();
  loadReviews();
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

// ────────────────────────────────────────────────────────────────
// Admin & Role Management table
// ────────────────────────────────────────────────────────────────

// In-memory cache so the search filter doesn't re-fetch
let ADMINS_CACHE = [];
// 'mongodb' when Atlas answered, 'fallback' when the API served built-in owner
// accounts because Atlas was unreachable. Drives the notice above the table so
// the blank Phone / Last Login / Joined cells are explained, not mysterious.
let ADMINS_SOURCE = '';

// Tiny escape helper (used in HTML string templates)
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Date helpers — short, readable, locale-aware
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtRelative(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return fmtDate(s);
}

// Initials helper for the avatar fallback
function adminInitials(name, email) {
  const src = (name && String(name).trim()) || (email && String(email).split('@')[0]) || 'A';
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

// Role → badge color (matches the existing palette in vault.html)
function adminRoleClass(role) {
  if (role === 'Super Admin') return 'purple';
  if (role === 'Support') return 'teal';
  return 'blue';
}

// Build a single row's HTML
function adminRowHtml(a) {
  const realId = a.id || a._id || '';
  const shortId = realId ? realId.slice(0, 8).toUpperCase() : '—';
  const name = a.name || a.full_name || 'Admin';
  const email = a.email || '—';
  const role = a.role || 'Admin';
  const phone = a.phone || '';
  const initials = adminInitials(name, email);
  const avatar = a.profile_image
    ? `<img src="${escHtml(a.profile_image)}" alt="">`
    : escHtml(initials);
  const lastLogin = fmtDateTime(a.last_login);
  const lastLoginRel = fmtRelative(a.last_login);
  const joined = fmtDate(a.created_at);
  const roleClass = adminRoleClass(role);
  const statusClass = a.is_active ? 'green' : 'red';
  const statusLabel = a.is_active ? 'Active' : 'Inactive';

  return `
    <tr data-admin-id="${escHtml(realId)}">
      <td>
        <span class="admin-id" title="Click to copy full ID" onclick="copyAdminId(this, '${escHtml(realId)}')">
          <span>${escHtml(shortId)}…</span>
          <span style="font-size:.85em;opacity:.7">⧉</span>
        </span>
      </td>
      <td>
        <div class="admin-cell">
          <div class="admin-avatar">${avatar}</div>
          <div style="min-width:0">
            <div class="admin-name">${escHtml(name)}</div>
            <div class="admin-email">${escHtml(email)}</div>
          </div>
        </div>
      </td>
      <td><span class="badge badge-${roleClass}">${escHtml(role)}</span></td>
      <td class="admin-phone nowrap">${phone ? escHtml(phone) : '<span class="admin-muted">—</span>'}</td>
      <td><span class="badge badge-${statusClass}">${statusLabel}</span></td>
      <td class="nowrap">
        <div class="admin-dt">
          <div class="admin-dt-time">${escHtml(lastLogin)}</div>
          ${lastLoginRel ? `<div class="admin-dt-rel">${escHtml(lastLoginRel)}</div>` : '<div class="admin-dt-rel">never</div>'}
        </div>
      </td>
      <td class="admin-dt admin-dt-time nowrap">${escHtml(joined)}</td>
      <td>
        <div class="admin-actions ta-right">
          <button class="btn btn-ghost btn-xs" onclick="toggleAdminStatus('${escHtml(realId)}', ${!a.is_active})" title="${a.is_active ? 'Deactivate this admin' : 'Activate this admin'}">
            ${a.is_active ? '⏸ Deactivate' : '▶ Activate'}
          </button>
          <button class="btn btn-danger btn-xs" onclick="deleteAdminUser('${escHtml(realId)}')" title="Delete this admin permanently">
            🗑 Delete
          </button>
        </div>
      </td>
    </tr>
  `;
}

// Render the table body for whatever subset of ADMINS_CACHE matches the filter
function renderAdminsTable() {
  const container = document.getElementById('adminsTableContainer');
  if (!container) return;

  const q = (document.getElementById('adminsSearch')?.value || '').toLowerCase().trim();
  const filtered = !q
    ? ADMINS_CACHE
    : ADMINS_CACHE.filter((a) => {
        const blob = ((a.name || '') + ' ' + (a.email || '') + ' ' + (a.role || '') + ' ' + (a.phone || '')).toLowerCase();
        return blob.includes(q);
      });

  // Shown above the table whenever the rows didn't come from Atlas
  const notice = ADMINS_SOURCE === 'fallback'
    ? `<div class="admin-notice">
         <span>⚠️</span>
         <span><strong>MongoDB Atlas is unreachable</strong> — showing the built-in owner accounts so you can still sign in.
         Phone, Last Login and Joined are blank because that data lives in Atlas. Check the cluster's IP allow-list, then
         <a href="javascript:loadAdminsList(true)" style="color:#ffcc80;text-decoration:underline">retry</a>.</span>
       </div>`
    : '';

  if (filtered.length === 0) {
    container.innerHTML = `
      ${notice}
      <div class="admin-empty">
        <div class="admin-empty-icon">${q ? '🔍' : '👥'}</div>
        <div class="admin-empty-title">${q ? 'No admins match your search' : 'No admin accounts yet'}</div>
        <div class="admin-empty-hint">${q
          ? 'Try a different name, email, or role.'
          : 'Use the "Create Admin in MongoDB Atlas" button above to add the first one.'}</div>
      </div>
    `;
    return;
  }

  const store = ADMINS_SOURCE === 'fallback' ? 'built-in fallback' : 'MongoDB Atlas';

  container.innerHTML = `
    ${notice}
    <div class="overflow-x">
      <table class="data-table">
        <colgroup>
          <col style="width:118px"><col style="width:250px"><col style="width:124px">
          <col style="width:132px"><col style="width:100px"><col style="width:158px">
          <col style="width:110px"><col style="width:188px">
        </colgroup>
        <thead>
          <tr>
            <th>ID</th>
            <th>Admin</th>
            <th>Role</th>
            <th>Phone</th>
            <th>Status</th>
            <th>Last Login</th>
            <th>Joined</th>
            <th class="ta-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(adminRowHtml).join('')}
        </tbody>
      </table>
    </div>
    <div class="admin-tfoot">
      <span>Showing <strong>${filtered.length}</strong> of <strong>${ADMINS_CACHE.length}</strong> admin${ADMINS_CACHE.length === 1 ? '' : 's'} from ${store}${q ? ` matching "<strong style="color:#4fc3f7">${escHtml(q)}</strong>"` : ''}.</span>
      <span>Click any ID chip to copy the full admin ID.</span>
    </div>
  `;
}

// Filter on input — just re-renders the existing cache, no fetch
function filterAdmins() {
  renderAdminsTable();
}

// Click an ID chip to copy the full ID to the clipboard
async function copyAdminId(el, fullId) {
  if (!fullId || fullId === 'undefined') return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(fullId);
    } else {
      // Fallback for non-HTTPS or older browsers
      const ta = document.createElement('textarea');
      ta.value = fullId;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    el.classList.add('admin-id-copied');
    const original = el.innerHTML;
    el.innerHTML = '<span>✓ copied</span>';
    setTimeout(() => {
      el.classList.remove('admin-id-copied');
      el.innerHTML = original;
    }, 1400);
    if (typeof showToast === 'function') showToast('Admin ID copied to clipboard', 'success');
  } catch (e) {
    if (typeof showToast === 'function') showToast('Could not copy — please copy manually', 'error');
  }
}

async function loadAdminsList(force) {
  const container = document.getElementById('adminsTableContainer');
  if (!container) return;

  // Skeleton while loading (only on a forced / first load)
  if (force || !ADMINS_CACHE.length) {
    container.innerHTML = `
      <div style="padding:24px;text-align:center;color:#6b88aa;font-size:.85rem">
        <span style="display:inline-block;width:16px;height:16px;border:2px solid rgba(0,230,118,.2);border-top-color:#00e676;border-radius:50%;animation:spin 1s linear infinite;margin-right:8px;vertical-align:middle"></span>
        Loading admins from MongoDB Atlas…
      </div>
    `;
  }

  try {
    const data = await api('/admin/list-admins', { useAdmin: true });
    ADMINS_CACHE = data.admins || [];
    ADMINS_SOURCE = data.source || '';
    renderAdminsTable();
  } catch (err) {
    container.innerHTML = `
      <div class="admin-empty">
        <div class="admin-empty-icon">⚠️</div>
        <div class="admin-empty-title">Failed to load admin list</div>
        <div class="admin-empty-hint">${escHtml(err.message || 'Unknown error')}</div>
        <button class="btn btn-ghost btn-sm" style="margin-top:14px" onclick="loadAdminsList(true)">🔄 Retry</button>
      </div>
    `;
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
      if (document.getElementById('setHeroBadge')) document.getElementById('setHeroBadge').value = s.heroBadge || "🔥 Buy & Sell Coupons — All in One Place!";
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
    const heroBadge = document.getElementById('setHeroBadge')?.value?.trim() || "🔥 Buy & Sell Coupons — All in One Place!";
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
