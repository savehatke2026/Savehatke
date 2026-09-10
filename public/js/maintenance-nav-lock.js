// ============================================
// SaveHatke — Maintenance Navigation Lock
// ============================================
// Loaded ONLY by maintenance.html. While maintenance mode is ON the user
// must stay on the maintenance page: every navbar/footer link that points
// at another page is intercepted before the browser navigates, so the
// destination never even starts to load (the server-side 302 guards are
// the real enforcement — this is the instant, flash-free client half).
//
// The profile dropdown is the deliberate exception: it must keep opening so
// Logout works. Its items are <a href="dashboard"> (Account page — blocked)
// and a logout <button> (allowed), which is exactly how the requirements
// draw the line: dropdown YES, profile page NO.

(function initMaintenanceNavLock() {
  // Pages reachable while ON: maintenance itself and login (auth/logout must
  // keep working). Everything else — user pages, home, info pages — is locked.
  const ALLOWED = new Set([
    '/maintenance',
    '/maintenance.html',
    '/login',
    '/login.html',
  ]);

  function isAllowedHref(href) {
    if (!href) return true; // href="#", javascript:, empty — not a navigation
    try {
      const url = new URL(href, window.location.origin);
      if (url.origin !== window.location.origin) return true; // external — let it be
      const p = url.pathname.toLowerCase().replace(/\/+$/, '') || '/';
      return ALLOWED.has(p) || ALLOWED.has(p + '.html');
    } catch (e) {
      return true;
    }
  }

  // Capture-phase listener so it runs before any page's own click handlers,
  // and covers links added later (the navbar renders the profile dropdown
  // dynamically via updateNavAuth()).
  document.addEventListener('click', (e) => {
    const link = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!link) return;
    if (!isAllowedHref(link.getAttribute('href'))) {
      e.preventDefault();
      e.stopPropagation();
      // Stay on the maintenance page; if we somehow drifted off it, come back.
      const here = (window.location.pathname || '').toLowerCase();
      if (here !== '/maintenance' && here !== '/maintenance.html') {
        window.location.replace('/maintenance.html');
      }
    }
  }, true);

  // Keyboard / middle-click opens of blocked links land on the server-side
  // 302 guards anyway, but a same-tab "Enter" on a focused link runs through
  // the click path above. History entries (Back/Forward) are also covered
  // server-side — a blocked page 302s straight back here with no flash.
})();
