// ============================================
// SaveHatke — Cookie Consent Manager
// ============================================
// The single source of truth for cookie consent across the whole site. Every
// page loads this file; nothing else is allowed to read or write the consent
// cookie or to decide whether an optional script may run.
//
// HOW CONSENT IS STORED
//   A real browser cookie, `sh_consent`, written with document.cookie:
//     Path=/                 one cookie for the whole site
//     Max-Age=15552000       180 days, then we ask again
//     SameSite=Lax           sent on top-level navigation, not on cross-site POSTs
//     Secure                 added automatically whenever the page is https
//   It is deliberately NOT HttpOnly: this script has to read it on every page
//   load to decide whether an optional script may run, and an HttpOnly cookie
//   is invisible to JavaScript by definition. Nothing sensitive is in it — see
//   the payload below — and the server can still read it (server/utils/consent.js).
//
//   Because it is a cookie and not sessionStorage, it survives closing and
//   reopening the browser. It is per-browser-profile by design, which is what
//   makes a private/incognito window ask again: that window has its own cookie
//   jar and is discarded on close. The same is true across devices — consent is
//   a property of the browser that would store the cookies, not of the account,
//   so we never copy one device's answer onto another.
//
// PAYLOAD — booleans and a timestamp, nothing more. No user id, no email, no
// name, no token, no payment data.
//     {"v":1,"analytics":false,"marketing":false,"ts":"2026-08-30T09:12:00.000Z"}
//
// HOW OPTIONAL SCRIPTS ARE GATED
//   Nothing optional runs until consent exists for its category:
//     CookieConsent.register('analytics', () => { ...init... }, () => { ...teardown... });
//     CookieConsent.loadScript('analytics', 'https://…/script.js');
//   A registration made before consent is queued, not executed. It runs the
//   moment consent is granted, and its teardown runs the moment consent is
//   withdrawn — in the same tab, without a reload.

(function () {
  'use strict';

  if (window.CookieConsent) return; // already initialised on this page

  // ── Configuration ────────────────────────────────────────────────────
  const COOKIE_NAME = 'sh_consent';
  const COOKIE_VERSION = 1;          // bump to re-ask everyone after a policy change
  const COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 days, in seconds
  const OPTIONAL = ['analytics', 'marketing'];

  /**
   * The cookie register shown in the settings panel. Purpose, duration and
   * provider are listed per category so a user can see exactly what each
   * choice covers.
   *
   * `clearOnRevoke` lists cookie name prefixes to delete when a category is
   * switched off, so turning analytics off actually removes its cookies instead
   * of only flipping a flag.
   */
  const CATEGORIES = {
    essential: {
      label: 'Essential Cookies',
      always: true,
      summary: 'Required for the site to work. These cannot be switched off.',
      detail: 'They keep you signed in, protect the site against abuse and cross-site '
        + 'request forgery, and remember this cookie choice. Without them you could not '
        + 'log in or complete a purchase.',
      cookies: [
        { name: 'sh_session', provider: 'SaveHatke', duration: '48 hours', purpose: 'Signed-in session. Holds a random session identifier only — never your password.' },
        { name: 'sh_consent', provider: 'SaveHatke', duration: '180 days', purpose: 'Remembers the choice you make on this panel.' },
        { name: '__cf_bm, cf_chl_*', provider: 'Cloudflare Turnstile', duration: 'Up to 30 minutes', purpose: 'Bot and abuse protection on the login and support forms.' },
        { name: 'Razorpay checkout', provider: 'Razorpay', duration: 'Session', purpose: 'Set only while a payment is in progress, to complete that payment securely.' },
      ],
    },
    analytics: {
      label: 'Analytics Cookies',
      always: false,
      summary: 'Help us understand which pages and coupons people actually use.',
      detail: 'Aggregated, statistical measurement only — how many people visited a page, '
        + 'which coupons get viewed, where people drop off. We never use it to identify you '
        + 'personally. Switched off until you allow it, and no analytics script is downloaded '
        + 'before then.',
      cookies: [],
      clearOnRevoke: ['_ga', '_gid', '_gat', '_gcl_au', 'sh_analytics'],
    },
    marketing: {
      label: 'Marketing Cookies',
      always: false,
      summary: 'Used to personalise offers and measure our campaigns.',
      detail: 'These let us show you coupon offers that are more relevant, and let us tell '
        + 'whether an advert we paid for actually worked. Switched off until you allow it, and '
        + 'no marketing or advertising script is downloaded before then.',
      cookies: [],
      clearOnRevoke: ['_fbp', '_fbc', 'fr', 'IDE', 'sh_marketing'],
    },
  };

  // No analytics or marketing provider is installed on SaveHatke today, which is
  // why both `cookies` lists above are empty: there is genuinely nothing to name
  // yet. The gate below is still enforced, so whenever one is added it cannot
  // fire before consent — add it with CookieConsent.loadScript(...) and list its
  // cookies here.

  // ── Raw cookie access ────────────────────────────────────────────────
  function readRawCookie(name) {
    const target = name + '=';
    for (const part of String(document.cookie || '').split(';')) {
      const c = part.trim();
      if (c.indexOf(target) === 0) return decodeURIComponent(c.slice(target.length));
    }
    return null;
  }

  function writeRawCookie(name, value, maxAgeSeconds) {
    // Secure cannot be sent over plain http or the browser drops the cookie
    // outright, which would silently break consent on a local http dev server.
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`;
  }

  function deleteRawCookie(name) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    // Also try the registrable domain: a third-party tag may have scoped its
    // cookie to `.example.com` rather than the exact host.
    const host = location.hostname.split('.');
    if (host.length > 2) {
      const parent = '.' + host.slice(-2).join('.');
      document.cookie = `${name}=; Path=/; Domain=${parent}; Max-Age=0; SameSite=Lax${secure}`;
    }
  }

  /** Remove every cookie whose name starts with one of the given prefixes. */
  function clearCookiesByPrefix(prefixes) {
    if (!prefixes || !prefixes.length) return;
    for (const part of String(document.cookie || '').split(';')) {
      const name = part.trim().split('=')[0];
      if (!name) continue;
      if (prefixes.some((p) => name === p || name.indexOf(p) === 0)) deleteRawCookie(name);
    }
  }

  // ── Consent state ────────────────────────────────────────────────────
  let state = null; // null === no decision recorded yet

  function parseConsent(raw) {
    if (!raw) return null;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return null; // corrupted or hand-edited — treat as "not asked yet"
    }
    if (!data || typeof data !== 'object') return null;
    // A payload from an older policy version is not consent for the current one.
    if (Number(data.v) !== COOKIE_VERSION) return null;
    return {
      v: COOKIE_VERSION,
      essential: true, // never optional
      analytics: data.analytics === true,
      marketing: data.marketing === true,
      ts: typeof data.ts === 'string' ? data.ts : '',
    };
  }

  function persist(next) {
    const payload = {
      v: COOKIE_VERSION,
      analytics: next.analytics === true,
      marketing: next.marketing === true,
      ts: new Date().toISOString(),
    };
    writeRawCookie(COOKIE_NAME, JSON.stringify(payload), COOKIE_MAX_AGE);
    return parseConsent(JSON.stringify(payload));
  }

  // ── The gate ─────────────────────────────────────────────────────────
  // Every optional integration registers here. `started` stops an init from
  // running twice when the user saves the same choice again.
  const registrations = []; // { category, init, teardown, started }
  const changeHandlers = [];

  function applyState(previous) {
    for (const reg of registrations) {
      const allowed = has(reg.category);
      if (allowed && !reg.started) {
        reg.started = true;
        try {
          reg.init();
        } catch (e) {
          console.warn(`[cookie-consent] ${reg.category} init failed:`, e);
        }
      } else if (!allowed && reg.started) {
        reg.started = false;
        try {
          if (reg.teardown) reg.teardown();
        } catch (e) {
          console.warn(`[cookie-consent] ${reg.category} teardown failed:`, e);
        }
      }
    }

    // Withdrawing a category also removes the cookies it had set, so "off"
    // means off rather than merely "not re-initialised".
    for (const cat of OPTIONAL) {
      const wasOn = previous ? previous[cat] === true : false;
      if (wasOn && !has(cat)) clearCookiesByPrefix(CATEGORIES[cat].clearOnRevoke);
    }

    const snapshot = get();
    for (const cb of changeHandlers) {
      try {
        cb(snapshot);
      } catch (e) {
        console.warn('[cookie-consent] change handler failed:', e);
      }
    }
    document.dispatchEvent(new CustomEvent('cookieconsentchange', { detail: snapshot }));
  }

  // ── Public API ───────────────────────────────────────────────────────
  function get() {
    return state ? Object.assign({}, state) : null;
  }

  function has(category) {
    if (category === 'essential') return true;
    if (!state) return false;
    return state[category] === true;
  }

  function commit(next, previous) {
    state = persist(next);
    applyState(previous);
    hideBanner();
    closeSettings();
  }

  function acceptAll() {
    const previous = get();
    commit({ analytics: true, marketing: true }, previous);
    announce('All cookies accepted.');
  }

  function rejectOptional() {
    const previous = get();
    commit({ analytics: false, marketing: false }, previous);
    announce('Optional cookies rejected. Only essential cookies are active.');
  }

  function save(choices) {
    const previous = get();
    commit({
      analytics: !!(choices && choices.analytics),
      marketing: !!(choices && choices.marketing),
    }, previous);
    announce('Your cookie preferences have been saved.');
  }

  /**
   * Register an optional integration. The init function is called only once
   * consent for `category` exists — immediately if it already does, otherwise
   * the moment it is granted. `teardown` is called if consent is withdrawn.
   */
  function register(category, init, teardown) {
    if (typeof init !== 'function') return;
    const reg = { category, init, teardown, started: false };
    registrations.push(reg);
    if (has(category)) {
      reg.started = true;
      try {
        init();
      } catch (e) {
        console.warn(`[cookie-consent] ${category} init failed:`, e);
      }
    }
  }

  /**
   * Inject a third-party <script> only after consent for `category`, and remove
   * it again if consent is withdrawn. This is the supported way to add an
   * analytics or advertising tag: put the call here instead of a <script> tag in
   * the HTML, and it can never load before the user has agreed.
   */
  function loadScript(category, src, attrs) {
    let el = null;
    register(category, () => {
      if (el) return;
      el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.dataset.consentCategory = category;
      if (attrs) Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
      document.head.appendChild(el);
    }, () => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      el = null;
    });
  }

  function onChange(cb) {
    if (typeof cb === 'function') changeHandlers.push(cb);
  }

  // ── Styles ───────────────────────────────────────────────────────────
  // Injected rather than added to each page's stylesheet: every page here
  // carries its own inline <style> block, so one shared injected sheet is the
  // only way to keep the banner identical everywhere. Values are taken from the
  // existing pages — #060d1f background, #0c1835 panels, #00e676 green accent,
  // #4fc3f7 blue, #e2ecff text, #6b88aa muted, Outfit typeface, rgba(79,195,247,.x)
  // borders — so nothing new is introduced to the design language.
  function injectStyles() {
    if (document.getElementById('sh-consent-css')) return;
    const el = document.createElement('style');
    el.id = 'sh-consent-css';
    el.textContent = `
.shc-banner{position:fixed;left:0;right:0;bottom:0;z-index:9000;background:rgba(9,16,34,.97);backdrop-filter:blur(14px);border-top:1px solid rgba(79,195,247,.16);box-shadow:0 -18px 50px rgba(0,0,0,.45);transform:translateY(110%);transition:transform .38s cubic-bezier(.22,.61,.36,1);font-family:'Outfit',system-ui,sans-serif}
.shc-banner.shc-in{transform:translateY(0)}
.shc-banner-inner{max-width:1120px;margin:0 auto;padding:18px 24px;display:flex;align-items:center;gap:22px}
.shc-copy{min-width:0;flex:1}
.shc-title{font-size:.98rem;font-weight:800;color:#e2ecff;margin-bottom:5px}
.shc-text{font-size:.83rem;line-height:1.6;color:#a8c0dc;margin:0}
.shc-text a{color:#4fc3f7;text-decoration:underline;text-underline-offset:2px}
.shc-actions{display:flex;align-items:center;gap:9px;flex-shrink:0;flex-wrap:wrap}
.shc-btn{font-family:'Outfit',system-ui,sans-serif;font-size:.83rem;font-weight:700;padding:0 18px;height:40px;border-radius:10px;cursor:pointer;white-space:nowrap;transition:all .2s;border:1.5px solid transparent}
.shc-btn:focus-visible{outline:2px solid rgba(0,230,118,.7);outline-offset:2px}
.shc-btn-primary{background:linear-gradient(135deg,#00e676,#00c853);color:#060d1f;border-color:transparent}
.shc-btn-primary:hover{opacity:.9;transform:translateY(-1px);box-shadow:0 10px 24px rgba(0,230,118,.32)}
.shc-btn-ghost{background:transparent;color:#e2ecff;border-color:rgba(79,195,247,.28)}
.shc-btn-ghost:hover{border-color:rgba(79,195,247,.55);background:rgba(79,195,247,.08)}
.shc-btn-link{background:none;border:none;color:#4fc3f7;font-size:.82rem;font-weight:600;text-decoration:underline;text-underline-offset:2px;cursor:pointer;padding:0 4px;height:40px;font-family:'Outfit',system-ui,sans-serif}
.shc-btn-link:hover{color:#8ed7ff}

.shc-overlay{position:fixed;inset:0;z-index:9100;background:rgba(0,0,0,.78);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;pointer-events:none;transition:opacity .25s;font-family:'Outfit',system-ui,sans-serif}
.shc-overlay.shc-in{opacity:1;pointer-events:auto}
.shc-modal{width:100%;max-width:560px;max-height:86vh;overflow-y:auto;border-radius:18px;background:#0c1835;border:1px solid rgba(79,195,247,.18);box-shadow:0 40px 100px rgba(0,0,0,.7);padding:28px;transform:translateY(16px) scale(.97);transition:transform .25s}
.shc-overlay.shc-in .shc-modal{transform:none}
.shc-modal-hdr{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:6px}
.shc-modal-title{font-size:1.15rem;font-weight:800;color:#e2ecff}
.shc-modal-sub{font-size:.82rem;color:#6b88aa;line-height:1.55;margin:0 0 20px}
.shc-close{background:none;border:none;color:#6b88aa;font-size:1.05rem;cursor:pointer;padding:2px 6px;line-height:1;border-radius:6px}
.shc-close:hover{color:#e2ecff}
.shc-close:focus-visible{outline:2px solid rgba(0,230,118,.7);outline-offset:2px}

.shc-cat{border:1px solid rgba(79,195,247,.12);background:rgba(255,255,255,.03);border-radius:12px;padding:15px 16px;margin-bottom:11px}
.shc-cat-top{display:flex;align-items:center;justify-content:space-between;gap:14px}
.shc-cat-name{font-size:.9rem;font-weight:700;color:#e2ecff}
.shc-cat-summary{font-size:.79rem;color:#a8c0dc;line-height:1.55;margin:7px 0 0}
.shc-cat-detail{font-size:.78rem;color:#6b88aa;line-height:1.6;margin:8px 0 0}
.shc-always{font-size:.66rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#00e676;background:rgba(0,230,118,.12);border:1px solid rgba(0,230,118,.28);border-radius:9999px;padding:4px 11px;white-space:nowrap}

.shc-switch{position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0}
.shc-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.shc-track{position:absolute;inset:0;background:rgba(107,136,170,.32);border-radius:9999px;transition:background .22s;pointer-events:none}
.shc-track::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#e2ecff;transition:transform .22s}
.shc-switch input:checked+.shc-track{background:linear-gradient(135deg,#00e676,#00c853)}
.shc-switch input:checked+.shc-track::after{transform:translateX(20px);background:#060d1f}
.shc-switch input:focus-visible+.shc-track{outline:2px solid rgba(0,230,118,.7);outline-offset:2px}

.shc-table{margin:11px 0 0;border-top:1px solid rgba(79,195,247,.1);padding-top:10px}
.shc-row{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:7px 0;border-bottom:1px solid rgba(79,195,247,.05)}
.shc-row:last-child{border-bottom:none}
.shc-row-name{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:.72rem;color:#4fc3f7;overflow-wrap:anywhere}
.shc-row-meta{font-size:.7rem;color:#6b88aa;white-space:nowrap;text-align:right}
.shc-row-purpose{grid-column:1/-1;font-size:.74rem;color:#8ba2c4;line-height:1.5}
.shc-none{font-size:.75rem;color:#6b88aa;font-style:italic;margin:10px 0 0}
.shc-modal-foot{display:flex;gap:10px;margin-top:20px}
.shc-modal-foot .shc-btn{flex:1;justify-content:center}
.shc-policy{font-size:.75rem;color:#6b88aa;margin:14px 0 0;line-height:1.55;text-align:center}
.shc-policy a{color:#4fc3f7}

/* Tablet: stack the copy above the buttons so nothing is squeezed. */
@media(max-width:860px){
  .shc-banner-inner{flex-direction:column;align-items:stretch;gap:14px;padding:16px 20px}
  .shc-actions{justify-content:flex-start}
}
/* Phone: full-width targets, comfortably tappable. */
@media(max-width:520px){
  .shc-banner-inner{padding:15px 16px}
  .shc-actions{flex-direction:column;align-items:stretch;gap:8px}
  .shc-btn,.shc-btn-link{width:100%;height:44px}
  .shc-modal{padding:22px 18px;max-height:92vh;border-radius:16px}
  .shc-modal-foot{flex-direction:column}
  .shc-row{grid-template-columns:1fr}
  .shc-row-meta{text-align:left}
}
@media(prefers-reduced-motion:reduce){
  .shc-banner,.shc-overlay,.shc-modal,.shc-track,.shc-track::after{transition:none}
}`;
    (document.head || document.documentElement).appendChild(el);
  }

  // ── Screen-reader announcements ──────────────────────────────────────
  function announce(message) {
    let live = document.getElementById('shc-live');
    if (!live) {
      live = document.createElement('div');
      live.id = 'shc-live';
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
      document.body.appendChild(live);
    }
    live.textContent = message;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Banner ───────────────────────────────────────────────────────────
  let bannerEl = null;

  function showBanner() {
    injectStyles();
    if (bannerEl) { bannerEl.classList.add('shc-in'); return; }

    bannerEl = document.createElement('div');
    bannerEl.className = 'shc-banner';
    bannerEl.id = 'shcBanner';
    bannerEl.setAttribute('role', 'region');
    bannerEl.setAttribute('aria-label', 'Cookie consent');
    bannerEl.innerHTML = `
      <div class="shc-banner-inner">
        <div class="shc-copy">
          <div class="shc-title">We use cookies 🍪</div>
          <p class="shc-text">We use essential cookies to keep our website secure and working
            properly. With your permission, we may also use optional cookies for analytics and
            personalized experiences. <a href="privacy">Privacy Policy</a></p>
        </div>
        <div class="shc-actions">
          <button type="button" class="shc-btn shc-btn-primary" data-shc="accept">Accept All</button>
          <button type="button" class="shc-btn shc-btn-ghost" data-shc="reject">Reject Optional</button>
          <button type="button" class="shc-btn-link" data-shc="settings">Cookie Settings</button>
        </div>
      </div>`;

    bannerEl.querySelector('[data-shc="accept"]').addEventListener('click', acceptAll);
    bannerEl.querySelector('[data-shc="reject"]').addEventListener('click', rejectOptional);
    bannerEl.querySelector('[data-shc="settings"]').addEventListener('click', () => openSettings());

    document.body.appendChild(bannerEl);
    // Flush layout so the transform transition runs from its start value, then
    // add the class synchronously. A queued requestAnimationFrame would race
    // with an immediate dismissal: a visitor who clicks "Accept All" before that
    // frame arrives would have the banner slide back in after being hidden.
    void bannerEl.offsetWidth;
    bannerEl.classList.add('shc-in');
  }

  function hideBanner() {
    if (bannerEl) bannerEl.classList.remove('shc-in');
  }

  // ── Settings panel ───────────────────────────────────────────────────
  let overlayEl = null;
  let lastFocused = null;

  function categoryHtml(key) {
    const c = CATEGORIES[key];
    const checked = has(key) ? ' checked' : '';
    const control = c.always
      ? '<span class="shc-always">Always Active</span>'
      : `<label class="shc-switch"><input type="checkbox" data-shc-cat="${esc(key)}"${checked}
           aria-label="${esc(c.label)}"><span class="shc-track"></span></label>`;

    const rows = (c.cookies || []).map((ck) => `
      <div class="shc-row">
        <span class="shc-row-name">${esc(ck.name)}</span>
        <span class="shc-row-meta">${esc(ck.provider)} · ${esc(ck.duration)}</span>
        <span class="shc-row-purpose">${esc(ck.purpose)}</span>
      </div>`).join('');

    // An empty list is stated plainly rather than left blank, so the panel never
    // implies a tracker exists when none does.
    const table = rows
      ? `<div class="shc-table">${rows}</div>`
      : '<p class="shc-none">No cookies in this category are in use on SaveHatke right now.</p>';

    return `
      <div class="shc-cat">
        <div class="shc-cat-top">
          <div class="shc-cat-name">${esc(c.label)}</div>
          ${control}
        </div>
        <p class="shc-cat-summary">${esc(c.summary)}</p>
        <p class="shc-cat-detail">${esc(c.detail)}</p>
        ${table}
      </div>`;
  }

  function openSettings() {
    injectStyles();
    lastFocused = document.activeElement;
    closeSettings(true);

    overlayEl = document.createElement('div');
    overlayEl.className = 'shc-overlay';
    overlayEl.id = 'shcSettings';
    overlayEl.innerHTML = `
      <div class="shc-modal" role="dialog" aria-modal="true" aria-labelledby="shcSettingsTitle">
        <div class="shc-modal-hdr">
          <div class="shc-modal-title" id="shcSettingsTitle">Cookie Settings</div>
          <button type="button" class="shc-close" data-shc="close" aria-label="Close cookie settings">✕</button>
        </div>
        <p class="shc-modal-sub">Choose which optional cookies SaveHatke may use. Essential
          cookies are always on because the site cannot function without them. You can change
          this at any time from “Cookie Settings” in the footer.</p>
        ${categoryHtml('essential')}
        ${categoryHtml('analytics')}
        ${categoryHtml('marketing')}
        <div class="shc-modal-foot">
          <button type="button" class="shc-btn shc-btn-ghost" data-shc="reject">Reject Optional</button>
          <button type="button" class="shc-btn shc-btn-primary" data-shc="save">Save Preferences</button>
        </div>
        <p class="shc-policy">Full details are in our <a href="privacy">Privacy Policy</a>.</p>
      </div>`;

    overlayEl.querySelector('[data-shc="close"]').addEventListener('click', () => closeSettings());
    overlayEl.querySelector('[data-shc="reject"]').addEventListener('click', rejectOptional);
    overlayEl.querySelector('[data-shc="save"]').addEventListener('click', () => {
      const picked = {};
      overlayEl.querySelectorAll('[data-shc-cat]').forEach((input) => {
        picked[input.getAttribute('data-shc-cat')] = input.checked;
      });
      save(picked);
    });
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) closeSettings();
    });
    document.addEventListener('keydown', onSettingsKeydown);

    document.body.appendChild(overlayEl);
    void overlayEl.offsetWidth; // flush layout so the fade-in transitions
    overlayEl.classList.add('shc-in');
    overlayEl.querySelector('[data-shc="save"]').focus();
  }

  function onSettingsKeydown(e) {
    if (!overlayEl) return;
    if (e.key === 'Escape') { closeSettings(); return; }
    if (e.key !== 'Tab') return;
    // Keep focus inside the dialog while it is open.
    const focusables = overlayEl.querySelectorAll('button, input, a[href]');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function closeSettings(immediate) {
    document.removeEventListener('keydown', onSettingsKeydown);
    const el = overlayEl;
    overlayEl = null;
    if (!el) return;
    if (immediate) { el.remove(); return; }
    el.classList.remove('shc-in');
    setTimeout(() => el.remove(), 260);
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    // A user who opened settings from the footer without ever answering the
    // banner must still be asked, so bring the banner back.
    if (!state) showBanner();
  }

  // ── Permanent footer entry point ─────────────────────────────────────
  // Added by script rather than by editing every page's footer markup: there are
  // a dozen footers and they must not drift apart. The link goes into the
  // "Company" column next to Terms and Privacy, which is where a user looks for
  // it; if the markup ever changes, it falls back to the last column and then
  // to the copyright line.
  function injectFooterLink() {
    if (document.querySelector('[data-shc="footer-link"]')) return;

    const make = (extraStyle) => {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = 'Cookie Settings';
      a.setAttribute('data-shc', 'footer-link');
      if (extraStyle) a.style.cssText = extraStyle;
      a.addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
      return a;
    };

    const columns = Array.from(document.querySelectorAll('.footer .fcol'));
    const company = columns.find((col) => {
      const h = col.querySelector('h4');
      return h && /company|legal/i.test(h.textContent || '');
    }) || columns[columns.length - 1];

    if (company) { company.appendChild(make()); return; }

    const bottom = document.querySelector('.footer .fbot');
    if (bottom) {
      const span = document.createElement('span');
      span.appendChild(make('color:#6b88aa;text-decoration:underline;text-underline-offset:2px'));
      bottom.appendChild(span);
    }
  }

  // ── Cross-tab / cross-view synchronisation ───────────────────────────
  // Cookies raise no storage event, so a change made in one tab has to be
  // broadcast. BroadcastChannel where available; re-reading the cookie when the
  // tab regains focus covers the rest and also catches a change made in another
  // window of the same profile.
  let channel = null;

  function broadcast() {
    if (channel) {
      try { channel.postMessage('changed'); } catch (e) { /* channel closed */ }
    }
  }

  function refreshFromCookie() {
    const incoming = parseConsent(readRawCookie(COOKIE_NAME));
    const before = JSON.stringify(state);
    if (JSON.stringify(incoming) === before) return;
    const previous = get();
    state = incoming;
    applyState(previous);
    if (state) hideBanner(); else showBanner();
  }

  function initSync() {
    if ('BroadcastChannel' in window) {
      try {
        channel = new BroadcastChannel('sh-cookie-consent');
        channel.addEventListener('message', refreshFromCookie);
      } catch (e) {
        channel = null;
      }
    }
    onChange(broadcast);
    window.addEventListener('focus', refreshFromCookie);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshFromCookie();
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────
  window.CookieConsent = {
    get, has, acceptAll, rejectOptional, save,
    register, loadScript, onChange,
    openSettings, showBanner,
    CATEGORIES, COOKIE_NAME, COOKIE_VERSION,
  };

  function start() {
    state = parseConsent(readRawCookie(COOKIE_NAME));
    injectStyles();
    injectFooterLink();
    initSync();

    // Run anything already registered that the saved consent allows. Nothing
    // optional has been touched up to this point.
    applyState(null);

    // No decision on file — first visit, a cleared cookie jar, a private window,
    // or a policy-version bump. Ask.
    if (!state) showBanner();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
