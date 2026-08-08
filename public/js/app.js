// ============================================
// SaveHatke — Shared App Utilities
// ============================================
// Auth state, API client, toast notifications, nav, mobile menu

const API_BASE = '/api';

// ── Immediate Admin Redirect for Public Pages ─────────────────────────────
(function checkAdminRedirectImmediate() {
  try {
    const path = window.location.pathname.toLowerCase();
    const filename = path.split('/').pop() || 'index.html';
    if (filename === 'admin.html') return;

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
      window.location.replace('admin.html');
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

    const data = await res.json();

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

function updateNavAuth() {
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
          <a href="dashboard.html" class="npd-item">
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
        Auth.clear();
        showToast('Logged out successfully. 👋', 'info');
        setTimeout(() => {
          window.location.href = 'index.html';
        }, 400);
      });
    }
  } else {
    navActions.innerHTML = `
      <a href="login.html" class="btn btn-primary btn-sm">Log In</a>
    `;
  }
}

// ── Auth Modal ──────────────────────────────────────────────────────────
function openAuthModal(mode = 'login') {
  // Remove existing modal
  document.querySelector('.modal-overlay')?.remove();

  const isLogin = mode === 'login';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2 class="modal-title">${isLogin ? 'Welcome Back' : 'Create Account'}</h2>
        <button class="modal-close" onclick="closeAuthModal()">×</button>
      </div>
      <form id="authForm">
        ${!isLogin ? `
          <div class="form-group">
            <label class="form-label" for="authName">Full Name</label>
            <input class="form-input" type="text" id="authName" placeholder="Enter your name" required>
          </div>
        ` : ''}
        <div class="form-group">
          <label class="form-label" for="authEmail">Email Address</label>
          <input class="form-input" type="email" id="authEmail" placeholder="you@example.com" required>
        </div>
        <div class="form-group">
          <label class="form-label" for="authPassword">Password</label>
          <input class="form-input" type="password" id="authPassword" placeholder="Min 6 characters" required minlength="6">
        </div>
        <button type="submit" class="btn btn-primary btn-lg w-full" id="authSubmitBtn">
          ${isLogin ? 'Log In' : 'Create Account'}
        </button>
      </form>
      <p class="text-center mt-6" style="font-size: 0.875rem; color: var(--color-slate-400);">
        ${isLogin
          ? 'Don\'t have an account? <a href="#" onclick="openAuthModal(\'register\')">Sign up free</a>'
          : 'Already have an account? <a href="#" onclick="openAuthModal(\'login\')">Log in</a>'
        }
      </p>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('active'));

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeAuthModal();
  });

  // Form submit
  document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('authSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Please wait...';

    try {
      const email = document.getElementById('authEmail').value;
      const password = document.getElementById('authPassword').value;

      if (isLogin) {
        const data = await api('/auth/login', {
          method: 'POST',
          body: { email, password },
        });
        Auth.setAuth(data.token, data.user);

        // Admin role → redirect to admin panel
        if (data.user.role === 'admin') {
          Auth.setAdminAuth(data.token, data.user);
          showToast(`Welcome Admin ${data.user.name}! 🛡️`, 'success');
          closeAuthModal();
          setTimeout(() => window.location.href = 'admin.html', 500);
          return;
        }

        showToast('Welcome back! 👋', 'success');
      } else {
        const name = document.getElementById('authName').value;
        const data = await api('/auth/register', {
          method: 'POST',
          body: { email, password, name },
        });
        Auth.setAuth(data.token, data.user);
        showToast('Account created successfully! 🎉', 'success');
      }

      closeAuthModal();
      updateNavAuth();
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = isLogin ? 'Log In' : 'Create Account';
    }
  });
}

function closeAuthModal() {
  const overlay = document.querySelector('.modal-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    setTimeout(() => overlay.remove(), 300);
  }
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

// ── Top Green Progress Bar ──────────────────────────────────────────────
function initProgressBar() {
  let container = document.getElementById('topProgressBarContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'topProgressBarContainer';
    container.innerHTML = '<div id="topProgressBar"></div>';
    document.body.prepend(container);
  }
  const bar = document.getElementById('topProgressBar');
  if (!bar) return;

  // Initial load animation
  bar.style.width = '35%';
  setTimeout(() => { bar.style.width = '75%'; }, 150);
  setTimeout(() => { 
    bar.style.width = '100%'; 
    setTimeout(() => { updateScrollProgress(); }, 200); 
  }, 350);

  window.addEventListener('scroll', updateScrollProgress);
}

function updateScrollProgress() {
  const bar = document.getElementById('topProgressBar');
  if (!bar) return;
  const winScroll = document.body.scrollTop || document.documentElement.scrollTop;
  const height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
  if (height <= 0) {
    bar.style.width = '100%';
  } else {
    const scrolled = Math.min(100, Math.max(0, (winScroll / height) * 100));
    bar.style.width = scrolled + '%';
  }
}

// ── Floating Green Particles ────────────────────────────────────────────
function initParticles() {
  const containers = document.querySelectorAll('.particles');
  containers.forEach((container) => {
    if (container.children.length > 0) return;
    const count = 30;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      p.style.left = `${Math.random() * 100}%`;
      p.style.animationDuration = `${4 + Math.random() * 7}s`;
      p.style.animationDelay = `${Math.random() * 5}s`;
      const size = 2 + Math.random() * 3;
      p.style.width = `${size}px`;
      p.style.height = `${size}px`;
      container.appendChild(p);
    }
  });
}

// ── Initialize ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initProgressBar();
  initParticles();
  initNavigation();
  initScrollReveal();
});

