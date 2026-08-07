// ============================================
// SaveHatke — Shared App Utilities
// ============================================
// Auth state, API client, toast notifications, nav, mobile menu

const API_BASE = '/api';

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

  // Admin auth is separate
  getAdminToken() {
    return localStorage.getItem('sh_admin_token');
  },

  setAdminAuth(token, user) {
    localStorage.setItem('sh_admin_token', token);
    localStorage.setItem('sh_admin_user', JSON.stringify(user));
  },

  clearAdmin() {
    localStorage.removeItem('sh_admin_token');
    localStorage.removeItem('sh_admin_user');
  },

  isAdminLoggedIn() {
    return !!this.getAdminToken();
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
    const user = Auth.getUser();
    const initials = user?.name ? user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'U';
    navActions.innerHTML = `
      <a href="dashboard.html" class="btn btn-secondary btn-sm">Dashboard</a>
      <div class="nav-user" id="navUserMenu">
        <div class="user-avatar">${initials}</div>
        <span>${user?.name || 'User'}</span>
      </div>
    `;

    // Logout on user menu click
    document.getElementById('navUserMenu')?.addEventListener('click', () => {
      if (confirm('Log out of SaveHatke?')) {
        Auth.clear();
        window.location.href = 'index.html';
      }
    });
  } else {
    navActions.innerHTML = `
      <button class="btn btn-ghost btn-sm" onclick="openAuthModal('login')">Log In</button>
      <button class="btn btn-primary btn-sm" onclick="openAuthModal('register')">Sign Up Free</button>
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

      // Redirect to dashboard if on landing page
      const currentPage = window.location.pathname.split('/').pop();
      if (currentPage === 'index.html' || currentPage === '') {
        setTimeout(() => window.location.href = 'dashboard.html', 500);
      } else {
        // Reload current page to reflect auth state
        setTimeout(() => window.location.reload(), 500);
      }
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

// ── Require Auth ────────────────────────────────────────────────────────
function requireAuth() {
  if (!Auth.isLoggedIn()) {
    showToast('Please log in to continue.', 'warning');
    setTimeout(() => openAuthModal('login'), 300);
    return false;
  }
  return true;
}

// ── Initialize ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initScrollReveal();
});
