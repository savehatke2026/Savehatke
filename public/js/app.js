// ============================================
// SaveHatke — Shared App Utilities
// ============================================
// Auth state, API client, toast notifications, nav, mobile menu

const API_BASE = '/api';

// ── Page Loading Progress Bar ───────────────────────────────────────────
// Website-green bar at the very top: creeps forward while the page loads
// and completes the full width once everything has loaded.
function initPageProgressBar() {
  if (document.getElementById('shPageProgressBar')) return;

  const style = document.createElement('style');
  style.textContent = `
    #shPageProgressBar{position:fixed;top:0;left:0;height:3px;width:0;z-index:10000;
      background:linear-gradient(90deg,#00e676,#00c853);box-shadow:0 0 10px rgba(0,230,118,.7);
      border-radius:0 3px 3px 0;transition:width .25s ease,opacity .4s ease;opacity:1;pointer-events:none}
    #shPageProgressBar.done{opacity:0}
  `;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'shPageProgressBar';
  document.body.appendChild(bar);

  let finished = false;

  // Creep forward while assets load — never reach 100% before the page is done
  [[0, '15%'], [120, '30%'], [300, '45%'], [550, '60%'], [850, '72%'], [1200, '82%'], [1700, '88%']]
    .forEach(([t, w]) => setTimeout(() => { if (!finished) bar.style.width = w; }, t));

  const finish = () => {
    if (finished) return;
    finished = true;
    bar.style.width = '100%'; // complete the page
    setTimeout(() => {
      bar.classList.add('done');
      setTimeout(() => bar.remove(), 450);
    }, 300); // hold the full green bar briefly so the completion is visible
  };

  if (document.readyState === 'complete') finish();
  else window.addEventListener('load', finish, { once: true });
  // Safety net — never leave the bar stuck if a resource hangs
  setTimeout(finish, 4000);
}
initPageProgressBar();

// ── Immediate Admin Redirect for Public Pages ─────────────────────────────
(function checkAdminRedirectImmediate() {
  try {
    const path = window.location.pathname.toLowerCase();
    const filename = path.split('/').pop() || 'index.html';
    // Login pages handle their own logged-in redirect (to index) — never bounce admins to vault from there
    const adminPages = ['vault.html', 'vault', 'login.html', 'login'];
    if (adminPages.includes(filename)) return;

    const adminToken = localStorage.getItem('sh_admin_token') || localStorage.getItem('sh_token');
    const adminUserRaw = localStorage.getItem('sh_admin_user') || localStorage.getItem('sh_user');
    if (!adminToken || !adminUserRaw) return;

    const user = JSON.parse(adminUserRaw);
    const isAdmin = user && (
      user.role === 'admin' ||
      user.role === 'Super Admin' ||
      user.role === 'Admin' ||
      user.role === 'Support'
    );

    if (isAdmin) {
      if (document.documentElement) document.documentElement.style.display = 'none';
      window.location.replace('vault');
    }
  } catch (e) {}
})();

// ── Auth State Management ───────────────────────────────────────────────
const Auth = {
  getToken() {
    return localStorage.getItem('sh_token');
  },

  getUser() {
    const user = localStorage.getItem('sh_user');
    return user ? JSON.parse(user) : null;
  },

  setAuth(token, user) {
    localStorage.setItem('sh_token', token);
    localStorage.setItem('sh_user', JSON.stringify(user));
  },

  clear() {
    localStorage.removeItem('sh_token');
    localStorage.removeItem('sh_user');
  },

  isLoggedIn() {
    return !!this.getToken();
  },

  // Admin auth
  getAdminToken() {
    return localStorage.getItem('sh_admin_token') || localStorage.getItem('sh_token');
  },

  getAdminUser() {
    const adminUser = localStorage.getItem('sh_admin_user');
    if (adminUser) return JSON.parse(adminUser);
    const user = this.getUser();
    if (user && (user.role === 'admin' || user.role === 'Super Admin' || user.role === 'Admin' || user.role === 'Support')) return user;
    return null;
  },

  setAdminAuth(token, user) {
    localStorage.setItem('sh_admin_token', token);
    localStorage.setItem('sh_admin_user', JSON.stringify(user));
    localStorage.setItem('sh_token', token);
    localStorage.setItem('sh_user', JSON.stringify(user));
  },

  clearAdmin() {
    localStorage.removeItem('sh_admin_token');
    localStorage.removeItem('sh_admin_user');
    localStorage.removeItem('sh_token');
    localStorage.removeItem('sh_user');
  },

  isAdminLoggedIn() {
    const adminToken = localStorage.getItem('sh_admin_token');
    const adminUser = this.getAdminUser();
    if (adminToken && adminUser) return true;

    const user = this.getUser();
    return !!(user && (user.role === 'admin' || user.role === 'Super Admin' || user.role === 'Admin' || user.role === 'Support'));
  },
};

// ── API Client ──────────────────────────────────────────────────────────
async function api(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  // Add auth token if available
  const token = options.useAdmin ? Auth.getAdminToken() : Auth.getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(url, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}: ${text.slice(0, 80) || 'Error'}`);
      }
      data = {};
    }

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    return data;
  } catch (err) {
    if (err.message.includes('Failed to fetch')) {
      throw new Error('Network error. Please check your connection.');
    }
    throw err;
  }
}

// ── Toast Notifications ─────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 4000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${icons[type] || 'ℹ'}</span>
    <span>${message}</span>
    <button class="toast-close" onclick="this.parentElement.remove()">×</button>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideOutRight 0.3s ease-in forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Navigation ──────────────────────────────────────────────────────────
function initNavigation() {
  // Scroll effect
  const navbar = document.querySelector('.navbar');
  if (navbar) {
    window.addEventListener('scroll', () => {
      navbar.classList.toggle('scrolled', window.scrollY > 20);
    });
  }

  // Mobile menu toggle
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      toggle.classList.toggle('active');
      links.classList.toggle('active');
    });

    // Close menu on link click
    links.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => {
        toggle.classList.remove('active');
        links.classList.remove('active');
      });
    });
  }

  // Active link highlight
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach((a) => {
    const href = a.getAttribute('href');
    if (href === currentPage || (currentPage === '' && href === 'index.html')) {
      a.classList.add('active');
    }
  });

  // Update nav for auth state
  updateNavAuth();
}

// Navbar profile box styles — injected once so the avatar + dropdown render
// identically on every page, even ones without local rules for them.
function ensureNavProfileStyles() {
  if (document.getElementById('shNavProfileStyle')) return;
  const style = document.createElement('style');
  style.id = 'shNavProfileStyle';
  style.textContent = `
    .nav-profile-wrapper{position:relative;display:inline-block}
    .nav-profile-btn{width:38px;height:38px;border-radius:50%;padding:0;border:2px solid #00e676;
      background:linear-gradient(135deg,#00e676,#00c853);color:#060d1f;font-family:'Outfit',sans-serif;
      font-weight:800;font-size:.9rem;display:flex;align-items:center;justify-content:center;cursor:pointer;
      transition:all .22s ease;box-shadow:0 0 14px rgba(0,230,118,.35);outline:none;overflow:hidden}
    .nav-profile-btn:hover{transform:scale(1.08);box-shadow:0 0 22px rgba(0,230,118,.65);border-color:#4fc3f7}
    .nav-profile-btn img{width:100%;height:100%;border-radius:50%;object-fit:cover}
    .nav-profile-dropdown{position:absolute;top:calc(100% + 12px);right:0;width:230px;
      background:rgba(12,24,53,.96);backdrop-filter:blur(20px);border:1px solid rgba(79,195,247,.25);
      border-radius:14px;box-shadow:0 16px 40px rgba(0,0,0,.65);padding:10px;display:none;
      flex-direction:column;gap:6px;z-index:1000;animation:shDropdownFadeIn .2s ease-out forwards}
    .nav-profile-dropdown.active{display:flex}
    @keyframes shDropdownFadeIn{from{opacity:0;transform:translateY(-8px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
    .npd-header{display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid rgba(79,195,247,.12);margin-bottom:4px;padding-bottom:10px}
    .npd-avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#00e676,#00c853);color:#060d1f;font-weight:800;font-size:.85rem;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden}
    .npd-avatar img{width:100%;height:100%;border-radius:50%;object-fit:cover}
    .npd-info{display:flex;flex-direction:column;overflow:hidden}
    .npd-name{font-size:.88rem;font-weight:700;color:#e2ecff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .npd-email{font-size:.74rem;color:#6b88aa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .npd-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;color:#e2ecff;font-size:.86rem;font-weight:600;text-decoration:none;cursor:pointer;transition:all .18s;background:transparent;border:none;width:100%;text-align:left;font-family:'Outfit',sans-serif}
    .npd-item:hover{background:rgba(0,230,118,.12);color:#00e676}
    .npd-item-logout{color:#ff6b6b}
    .npd-item-logout:hover{background:rgba(255,80,80,.12);color:#ff8585}
  `;
  document.head.appendChild(style);
}

function updateNavAuth() {
  ensureNavProfileStyles();
  const navActions = document.querySelector('.nav-actions');
  if (!navActions) return;

  if (Auth.isLoggedIn()) {
    const user = Auth.getUser() || {};
    const name = user.name || 'User';
    const email = user.email || '';
    const initials = name ? name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'U';

    const avatarHtmlBtn = user.picture 
      ? `<img src="${user.picture}" alt="${name}" />`
      : initials;

    const avatarHtmlDropdown = user.picture
      ? `<img src="${user.picture}" alt="${name}" />`
      : initials;

    navActions.innerHTML = `
      <div class="nav-profile-wrapper">
        <button class="nav-profile-btn" id="navProfileCircleBtn" title="${name} (${email})">
          ${avatarHtmlBtn}
        </button>
        <div class="nav-profile-dropdown" id="navProfileDropdown">
          <div class="npd-header">
            <div class="npd-avatar">${avatarHtmlDropdown}</div>
            <div class="npd-info">
              <div class="npd-name">${name}</div>
              <div class="npd-email">${email}</div>
            </div>
          </div>
          <a href="dashboard" class="npd-item">
            <span>📊</span> Dashboard
          </a>
          <button class="npd-item npd-item-logout" id="npdLogoutBtn">
            <span>🚪</span> Log Out
          </button>
        </div>
      </div>
    `;

    const btn = document.getElementById('navProfileCircleBtn');
    const dropdown = document.getElementById('navProfileDropdown');
    const logoutBtn = document.getElementById('npdLogoutBtn');

    if (btn && dropdown) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('active');
      });

      document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && !btn.contains(e.target)) {
          dropdown.classList.remove('active');
        }
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        // Fire-and-forget logout API call (don't wait for it)
        try {
          api('/auth/logout', {
            method: 'POST',
            body: { userId: user.user_id || user.id, email: user.email },
          }).catch(() => {});
        } catch (e) {}
        // Instant clear and redirect
        Auth.clear();
        window.location.href = 'index';
      });
    }
  } else {
    // Don't overwrite login page's custom nav-actions (← Home button)
    const currentPage = window.location.pathname.split('/').pop() || '';
    if (currentPage === 'login' || currentPage === 'login.html') return;
    navActions.innerHTML = `
      <button type="button" class="btn btn-primary btn-sm" onclick="location.href='login.html'">Log In</button>
    `;
  }
}

const DEFAULT_GOOGLE_CLIENT_ID = '930893529973-2j5h36csl909m139urdq552n63h1hl1q.apps.googleusercontent.com';
let cachedGoogleClientId = '';

async function fetchGoogleClientId() {
  if (cachedGoogleClientId) return cachedGoogleClientId;

  try {
    const cfg = await api('/auth/google-config');
    if (cfg && cfg.clientId && cfg.clientId.trim() !== '') {
      cachedGoogleClientId = cfg.clientId;
      return cachedGoogleClientId;
    }
  } catch (err) {
    console.warn('Could not fetch Google client ID, using fallback:', err.message);
  }

  cachedGoogleClientId = DEFAULT_GOOGLE_CLIENT_ID;
  return cachedGoogleClientId;
}

async function authenticateGoogleCredential(response, { closeModalOnSuccess = false } = {}) {
  try {
    const data = await api('/auth/google', {
      method: 'POST',
      body: { credential: response.credential }
    });

    Auth.setAuth(data.token, data.user);

    if (data.user.role === 'admin' || data.user.role === 'Super Admin' || data.user.role === 'Admin') {
      Auth.setAdminAuth(data.token, data.user);
      if (closeModalOnSuccess) closeAuthModal();
      window.location.replace('vault');
      return;
    }

    if (closeModalOnSuccess) {
      closeAuthModal();
      updateNavAuth();
      window.location.reload();
      return;
    }

    updateNavAuth();
  } catch (err) {
    showToast(err.message || 'Google authentication failed.', 'error');
  }
}

async function initAuthGoogleButton() {
  const container = document.getElementById('authGoogleButton');
  if (!container) return;

  const clientId = await fetchGoogleClientId();
  if (!clientId) {
    container.innerHTML = '<div style="font-size:0.82rem;color:#fbbf24;text-align:center;">Google sign-in is unavailable right now.</div>';
    return;
  }

  // Create a styled redirect button instead of using GSI popup
  container.innerHTML = `
    <button type="button" id="authGoogleRedirectBtn" style="
      display:flex;align-items:center;justify-content:center;gap:10px;
      width:100%;max-width:360px;height:44px;border-radius:10px;
      background:rgba(255,255,255,.04);border:1.5px solid rgba(79,195,247,.22);
      color:#e2ecff;font-family:'Outfit',sans-serif;font-size:.9rem;font-weight:600;
      cursor:pointer;transition:all .22s;
    ">
      <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>
      Continue with Google
    </button>
  `;

  const btn = document.getElementById('authGoogleRedirectBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Redirecting to Google…';

      const redirectUri = window.location.origin + '/api/auth/google-redirect';
      const scope = 'openid email profile';
      const nonce = Math.random().toString(36).substring(2, 15);

      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'id_token',
        scope: scope,
        nonce: nonce,
        response_mode: 'form_post',
        prompt: 'select_account',
      }).toString();

      window.location.href = authUrl;
    });

    btn.addEventListener('mouseenter', () => {
      btn.style.borderColor = 'rgba(79,195,247,.45)';
      btn.style.background = 'rgba(255,255,255,.07)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.borderColor = 'rgba(79,195,247,.22)';
      btn.style.background = 'rgba(255,255,255,.04)';
    });
  }
}

// ── Auth Modal ──────────────────────────────────────────────────────────
function openAuthModal(mode = 'login') {
  // All login/signup entry points route to the dedicated login page
  window.location.href = 'login.html';
}

function closeAuthModal() {
  const overlay = document.querySelector('.modal-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    setTimeout(() => overlay.remove(), 300);
  }
}

// ── Google Auth Popup (Same-page authentication for modals) ─────────────────
async function handleAuthGooglePopup() {
  await initAuthGoogleButton();
}

// ── Scroll Reveal ───────────────────────────────────────────────────────
function initScrollReveal() {
  const reveals = document.querySelectorAll('.reveal');
  if (!reveals.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -50px 0px' }
  );

  reveals.forEach((el) => observer.observe(el));
}

// ── Utility: Format Date ────────────────────────────────────────────────
function formatDate(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  return d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatTimeAgo(isoString) {
  if (!isoString) return '—';
  const now = new Date();
  const d = new Date(isoString);
  const diff = Math.floor((now - d) / 1000);

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return formatDate(isoString);
}

// ── Coupon Terms & How-to-Use Modal ──────────────────────────────────────
function openCouponTermsModal(couponData) {
  let c = typeof couponData === 'object' ? couponData : { id: couponData };

  const brand = c.brand || 'Store';
  const category = c.category || 'General';
  const description = c.description || 'Special Discount Coupon';
  const originalValue = c.originalValue || '200';
  const sellingPrice = c.source === 'auto-scraped' ? 'FREE' : `₹${c.sellingPrice || '20'}`;

  // Remove existing modal
  document.querySelector('.modal-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width: 540px;">
      <div class="modal-header">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div style="width: 38px; height: 38px; border-radius: 8px; background: rgba(37,99,235,0.15); display: flex; align-items: center; justify-content: center; font-weight: 800; color: var(--color-blue-400);">
            🏷️
          </div>
          <div>
            <h2 class="modal-title" style="font-size: 1.25rem;">${brand} Details</h2>
            <span class="badge badge-blue" style="font-size: 0.65rem;">${category}</span>
          </div>
        </div>
        <button class="modal-close" onclick="this.closest('.modal-overlay').classList.remove('active'); setTimeout(() => this.closest('.modal-overlay').remove(), 300)">×</button>
      </div>

      <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid var(--glass-border); border-radius: var(--radius-md); padding: 1rem; margin-bottom: 1.25rem;">
        <div style="font-size: 0.95rem; font-weight: 700; color: var(--color-white); margin-bottom: 0.25rem;">${description}</div>
        <div style="font-size: 0.8rem; color: var(--color-slate-400);">Discount Value: ₹${originalValue} · Listing Price: <strong style="color: var(--color-success);">${sellingPrice}</strong></div>
      </div>

      <!-- Tab Buttons -->
      <div class="category-pills" style="margin-bottom: 1.25rem; border-bottom: 1px solid var(--glass-border); padding-bottom: 0.5rem; gap: 0.5rem;">
        <button class="category-pill active" id="btnModalTabUse" onclick="switchModalTab('use')">📖 How to Use Code</button>
        <button class="category-pill" id="btnModalTabTerms" onclick="switchModalTab('terms')">📜 Terms & Conditions</button>
      </div>

      <!-- How to Use Tab -->
      <div id="modalTabUse" class="modal-tab-content">
        <div style="display: flex; flex-direction: column; gap: 0.85rem;">
          <div style="display: flex; gap: 0.75rem; align-items: start;">
            <div style="width: 26px; height: 26px; border-radius: 50%; background: var(--color-blue-600); color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.8rem; flex-shrink: 0;">1</div>
            <div style="font-size: 0.875rem; color: var(--color-slate-300);"><strong style="color: var(--color-white);">Unlock Code:</strong> Click <em>Buy Now</em> (or <em>Get Free Code</em>) to reveal your unique coupon code.</div>
          </div>
          <div style="display: flex; gap: 0.75rem; align-items: start;">
            <div style="width: 26px; height: 26px; border-radius: 50%; background: var(--color-blue-600); color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.8rem; flex-shrink: 0;">2</div>
            <div style="font-size: 0.875rem; color: var(--color-slate-300);"><strong style="color: var(--color-white);">Copy Code:</strong> Copy the revealed code from your screen or from your <em>Dashboard Wallet</em>.</div>
          </div>
          <div style="display: flex; gap: 0.75rem; align-items: start;">
            <div style="width: 26px; height: 26px; border-radius: 50%; background: var(--color-blue-600); color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.8rem; flex-shrink: 0;">3</div>
            <div style="font-size: 0.875rem; color: var(--color-slate-300);"><strong style="color: var(--color-white);">Visit Store:</strong> Open the official <strong>${brand}</strong> app or website and add items to your cart.</div>
          </div>
          <div style="display: flex; gap: 0.75rem; align-items: start;">
            <div style="width: 26px; height: 26px; border-radius: 50%; background: var(--color-blue-600); color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.8rem; flex-shrink: 0;">4</div>
            <div style="font-size: 0.875rem; color: var(--color-slate-300);"><strong style="color: var(--color-white);">Apply at Checkout:</strong> Paste the code in the <em>Have a Coupon / Promo Code?</em> box before making payment.</div>
          </div>
        </div>
      </div>

      <!-- Terms & Conditions Tab -->
      <div id="modalTabTerms" class="modal-tab-content" style="display: none;">
        <ul style="font-size: 0.85rem; color: var(--color-slate-300); line-height: 1.8; padding-left: 1.25rem;">
          <li>Valid for purchases on official <strong>${brand}</strong> digital platforms.</li>
          <li>Cart value must meet the minimum requirement specified by ${brand} (e.g. ₹${originalValue}).</li>
          <li>Single-use promo code per user account on the merchant site.</li>
          <li>Cannot be combined with conflicting promotional vouchers or gift cards.</li>
          <li><strong>100% Active Guarantee:</strong> Verified by SaveHatke. If the code is invalid, request a full refund within 48 hours via your Dashboard.</li>
        </ul>
      </div>

      <div style="margin-top: 1.5rem; text-align: right;">
        <button class="btn btn-secondary btn-sm" onclick="this.closest('.modal-overlay').classList.remove('active'); setTimeout(() => this.closest('.modal-overlay').remove(), 300)">Close</button>
      </div>
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

function switchModalTab(tab) {
  const useBtn = document.getElementById('btnModalTabUse');
  const termsBtn = document.getElementById('btnModalTabTerms');
  const useTab = document.getElementById('modalTabUse');
  const termsTab = document.getElementById('modalTabTerms');

  if (!useBtn || !termsBtn || !useTab || !termsTab) return;

  if (tab === 'use') {
    useBtn.classList.add('active');
    termsBtn.classList.remove('active');
    useTab.style.display = 'block';
    termsTab.style.display = 'none';
  } else {
    termsBtn.classList.add('active');
    useBtn.classList.remove('active');
    termsTab.style.display = 'block';
    useTab.style.display = 'none';
  }
}

// ── Require Auth ────────────────────────────────────────────────────────
function requireAuth() {
  if (!Auth.isLoggedIn()) {
    showToast('Please log in to continue.', 'warning');
    setTimeout(() => openAuthModal('login'), 300);
    return false;
  }
  return true;
}

// ── Floating Green Particles ────────────────────────────────────────────
// Self-contained: injects its own styles so the green particles render on
// every page, even ones without local .particle CSS.
function initParticles() {
  if (!document.getElementById('shParticlesStyle')) {
    const style = document.createElement('style');
    style.id = 'shParticlesStyle';
    style.textContent = `
      .particles{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:1}
      .particle{position:absolute;width:3px;height:3px;background:#00e676;border-radius:50%;opacity:0;
        animation:shParticleFloat linear infinite;box-shadow:0 0 8px #00e676}
      @keyframes shParticleFloat{
        0%{transform:translateY(100vh) scale(0);opacity:0}
        20%{opacity:.6}
        80%{opacity:.3}
        100%{transform:translateY(-100px) scale(1.2);opacity:0}
      }
    `;
    document.head.appendChild(style);
  }

  let containers = document.querySelectorAll('.particles');
  if (containers.length === 0) {
    const parent = document.querySelector('.hero') || document.querySelector('.page-hero') || document.querySelector('.page') || document.querySelector('main') || document.body;
    if (parent) {
      const pContainer = document.createElement('div');
      pContainer.className = 'particles';
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }
      parent.insertBefore(pContainer, parent.firstChild);
      containers = [pContainer];
    }
  }

  containers.forEach((container) => {
    if (container.children.length > 0) return;
    const count = 22;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      p.style.left = `${Math.random() * 100}%`;
      p.style.animationDuration = `${5 + Math.random() * 8}s`;
      p.style.animationDelay = `${Math.random() * 6}s`;
      const size = 2 + Math.random() * 3;
      p.style.width = `${size}px`;
      p.style.height = `${size}px`;
      container.appendChild(p);
    }
  });
}

// ── Initialize ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initParticles();
  initNavigation();
  initScrollReveal();
});
