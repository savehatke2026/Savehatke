// ============================================
// SaveHatke — Marketplace First-Run Tutorial
// ============================================
// A spotlight tour that opens once for a user who has never finished or
// skipped it. Everything here is additive: the overlay is injected at runtime,
// so the marketplace markup, layout and styles are untouched. The tour never
// clicks anything on the user's behalf — it only points at the real controls.
//
// State lives on the account (Users.onboarding_state via /api/auth/onboarding)
// so the tour follows the user across devices. Signed-out visitors have no
// account to write to, so they fall back to local storage. A mid-tour refresh
// resumes at the same step from session storage.
//
// Public entry point: window.startMarketplaceTutorial() — used by the
// "Replay tutorial" control under the search bar.

(function () {
  'use strict';

  const DONE_KEY = 'sh_marketplace_tour';        // 'completed' | 'skipped'
  const STEP_KEY = 'sh_marketplace_tour_step';   // resume index while running
  const NUMBERED = 5;                            // welcome/finish are unnumbered

  let steps = [];
  let idx = 0;
  let running = false;
  let dom = null;
  let lastFocused = null;
  let detach = [];

  // ── Persistence ────────────────────────────────────────────────────────
  const loggedIn = () => Boolean(window.Auth && Auth.isLoggedIn && Auth.isLoggedIn());

  function localState() {
    try { return localStorage.getItem(DONE_KEY) || ''; } catch (e) { return ''; }
  }

  function setLocalState(value) {
    try { localStorage.setItem(DONE_KEY, value); } catch (e) { /* private mode */ }
  }

  function saveStep(value) {
    try {
      if (value === null) sessionStorage.removeItem(STEP_KEY);
      else sessionStorage.setItem(STEP_KEY, String(value));
    } catch (e) { /* private mode */ }
  }

  function readStep() {
    try {
      const raw = sessionStorage.getItem(STEP_KEY);
      if (raw === null) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    } catch (e) { return null; }
  }

  // Records the outcome for the account when there is one, and always mirrors
  // it locally so a reload cannot re-trigger the tour before the API answers.
  function persistOutcome(outcome) {
    setLocalState(outcome);
    saveStep(null);
    if (!loggedIn() || typeof window.api !== 'function') return;
    const flag = outcome === 'completed'
      ? { marketplaceTutorialCompleted: true }
      : { marketplaceTutorialSkipped: true };
    Promise.resolve(api('/auth/onboarding', { method: 'PUT', body: flag })).catch(() => {});
  }

  // ── Step definitions ───────────────────────────────────────────────────
  // `target` is resolved fresh on every render, because the coupon grid is
  // repainted by search, filters and pagination while the tour is open.
  function buildSteps() {
    const q = (sel) => document.querySelector(sel);
    // First candidate that is actually rendered. The nav collapses its actions
    // behind a toggle on small screens, and the grid is empty until coupons
    // load, so a fixed selector is not enough.
    const firstVisible = (...selectors) => {
      for (const sel of selectors) {
        const el = q(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) return el;
      }
      return null;
    };

    return [
      {
        kind: 'intro',
        title: 'Welcome to Coupon Marketplace 👋',
        body: 'Find verified coupons at great prices and save more on your purchases.',
        primary: 'Start Tutorial',
        secondary: 'Skip',
      },
      {
        kind: 'step',
        target: () => q('.search-bar'),
        // The pills wrap into many rows on a narrow screen; spotlighting both
        // would be taller than the viewport, so they only join the highlight
        // when the pair still fits comfortably.
        also: () => (window.innerWidth > 900 ? q('#categoryPills') : null),
        title: 'Search & categories',
        body: 'Search for coupons by store, category, or keyword.',
      },
      {
        kind: 'step',
        target: () => q('#couponGrid .coupon-card') || q('#couponGrid'),
        title: 'Coupon cards',
        body: 'Compare the discount, price, validity, and other coupon details before choosing a coupon.',
      },
      {
        kind: 'step',
        target: () => q('#couponGrid .coupon-card .chow-tag') || q('#couponGrid .coupon-card') || q('#couponGrid'),
        title: 'Coupon details',
        body: 'Open a coupon to see all important information before buying.',
      },
      {
        kind: 'step',
        target: () => q('#couponGrid .coupon-card .cbuy-btn') || q('#couponGrid .coupon-card') || q('#couponGrid'),
        title: 'Buy coupon',
        body: 'Purchase the coupon securely and receive your coupon details.',
      },
      {
        kind: 'step',
        target: () => firstVisible('.nav-profile-wrapper', '.nav-auth-login', '.nav-actions', '#navToggle', '#nav'),
        title: 'My Coupons',
        body: loggedIn()
          ? 'After purchasing, you can find and manage your coupons from My Coupons in your dashboard — open it from your profile menu here.'
          : 'After purchasing, you can find and manage your coupons from My Coupons in your dashboard. Sign in here to reach it.',
      },
      {
        kind: 'outro',
        title: "You're all set! 🎉",
        body: 'Now you know how the Coupon Marketplace works.',
        primary: 'Explore Marketplace',
      },
    ];
  }

  // ── Styles ─────────────────────────────────────────────────────────────
  // Injected once. Colours, radii and type match the marketplace cards so the
  // overlay reads as part of the same product rather than a bolted-on library.
  const STYLE_ID = 'shTourStyles';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
    .sh-tour-blocker{position:fixed;inset:0;z-index:4000;background:transparent;cursor:default}
    .sh-tour-spot{position:fixed;z-index:4001;border-radius:14px;pointer-events:none;
      box-shadow:0 0 0 9999px rgba(4,9,22,.74),0 0 0 2px rgba(0,230,118,.75),0 0 28px rgba(0,230,118,.28);
      transition:top .32s cubic-bezier(.4,0,.2,1),left .32s cubic-bezier(.4,0,.2,1),
        width .32s cubic-bezier(.4,0,.2,1),height .32s cubic-bezier(.4,0,.2,1),opacity .2s}
    .sh-tour-spot.is-hidden{opacity:0}
    .sh-tour-dim{position:fixed;inset:0;z-index:4001;background:rgba(4,9,22,.74);pointer-events:none;
      opacity:0;transition:opacity .25s}
    .sh-tour-dim.is-on{opacity:1}

    .sh-tour-card{position:fixed;z-index:4002;width:min(360px,calc(100vw - 32px));
      background:rgba(15,30,58,.98);border:1px solid rgba(79,195,247,.22);border-radius:16px;
      box-shadow:0 24px 60px rgba(0,0,0,.6);padding:20px 22px;color:#e2ecff;
      font-family:'Outfit',system-ui,sans-serif;opacity:0;transform:translateY(6px);
      transition:opacity .24s ease,transform .24s ease,top .3s cubic-bezier(.4,0,.2,1),left .3s cubic-bezier(.4,0,.2,1)}
    .sh-tour-card.is-in{opacity:1;transform:translateY(0)}
    .sh-tour-card.is-centred{left:50%;top:50%;transform:translate(-50%,-50%);width:min(420px,calc(100vw - 32px))}
    .sh-tour-card.is-centred.is-in{transform:translate(-50%,-50%)}
    .sh-tour-progress{font-size:.68rem;font-weight:700;letter-spacing:.11em;text-transform:uppercase;
      color:#00e676;margin-bottom:9px}
    .sh-tour-title{font-family:'DM Serif Display',Georgia,serif;font-size:1.18rem;line-height:1.25;margin-bottom:9px}
    .sh-tour-body{font-size:.88rem;line-height:1.62;color:#a8c0dc;margin:0 0 18px}
    .sh-tour-dots{display:flex;gap:5px;margin-bottom:16px}
    .sh-tour-dot{height:3px;flex:1;border-radius:2px;background:rgba(107,136,170,.28)}
    .sh-tour-dot.is-done{background:rgba(0,230,118,.45)}
    .sh-tour-dot.is-now{background:#00e676}
    .sh-tour-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
    .sh-tour-btn{font-family:'Outfit',system-ui,sans-serif;font-size:.84rem;font-weight:700;
      padding:9px 16px;border-radius:10px;cursor:pointer;transition:background .18s,color .18s,border-color .18s;
      border:1px solid rgba(79,195,247,.22);background:rgba(255,255,255,.04);color:#a8c0dc}
    .sh-tour-btn:hover{background:rgba(79,195,247,.12);color:#e2ecff}
    .sh-tour-btn-primary{border-color:rgba(0,230,118,.45);
      background:linear-gradient(135deg,rgba(0,230,118,.16),rgba(79,195,247,.08));color:#00e676}
    .sh-tour-btn-primary:hover{background:linear-gradient(135deg,#00e676,#00c853);color:#060d1f}
    .sh-tour-btn-quiet{border-color:transparent;background:none;color:#6b88aa;padding:9px 6px;margin-left:auto}
    .sh-tour-btn-quiet:hover{background:none;color:#a8c0dc;text-decoration:underline}
    .sh-tour-btn:focus-visible{outline:2px solid rgba(0,230,118,.7);outline-offset:2px}

    /* Replay control — muted text button, same voice as the results count */
    .sh-tour-replay{display:inline-flex;align-items:center;gap:6px;margin:12px 0 0;
      font-family:'Outfit',system-ui,sans-serif;font-size:.8rem;font-weight:600;color:#6b88aa;
      background:none;border:none;padding:4px 0;cursor:pointer;transition:color .18s}
    .sh-tour-replay:hover{color:#00e676}
    .sh-tour-replay:focus-visible{outline:2px solid rgba(0,230,118,.6);outline-offset:3px;border-radius:6px}

    @media (max-width:640px){
      /* Bottom sheet on phones: the tooltip can never leave the viewport, and
         the spotlight above it stays visible. */
      .sh-tour-card,.sh-tour-card.is-centred{left:12px;right:12px;top:auto;bottom:14px;
        width:auto;transform:translateY(8px)}
      .sh-tour-card.is-in,.sh-tour-card.is-centred.is-in{transform:translateY(0)}
      .sh-tour-actions .sh-tour-btn{flex:1;justify-content:center;text-align:center;min-height:42px}
      .sh-tour-btn-quiet{flex:1 0 100%;margin-left:0;text-align:center}
    }
    @media (prefers-reduced-motion:reduce){
      .sh-tour-spot,.sh-tour-card{transition:none}
    }
    /* Held only while the tour jumps the page to the next target */
    html.sh-tour-instant-scroll,html.sh-tour-instant-scroll body{scroll-behavior:auto !important}`;
    const tag = document.createElement('style');
    tag.id = STYLE_ID;
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // ── Overlay DOM ────────────────────────────────────────────────────────
  function buildDom() {
    const blocker = document.createElement('div');
    blocker.className = 'sh-tour-blocker';

    // Full-screen dim for the unanchored welcome and finish cards; the spot
    // element carries its own dim via a very large box-shadow spread.
    const dim = document.createElement('div');
    dim.className = 'sh-tour-dim';

    const spot = document.createElement('div');
    spot.className = 'sh-tour-spot is-hidden';

    const card = document.createElement('div');
    card.className = 'sh-tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'shTourTitle');
    card.setAttribute('aria-describedby', 'shTourBody');
    // Focusable as a last resort, so focus management always has somewhere in
    // the dialog to land.
    card.setAttribute('tabindex', '-1');
    card.innerHTML = `
      <div class="sh-tour-progress" id="shTourProgress" aria-live="polite"></div>
      <div class="sh-tour-title" id="shTourTitle"></div>
      <p class="sh-tour-body" id="shTourBody"></p>
      <div class="sh-tour-dots" id="shTourDots" aria-hidden="true"></div>
      <div class="sh-tour-actions" id="shTourActions"></div>`;

    [blocker, dim, spot, card].forEach((el) => document.body.appendChild(el));
    return { blocker, dim, spot, card };
  }

  function removeDom() {
    if (!dom) return;
    Object.values(dom).forEach((el) => el && el.remove());
    dom = null;
  }

  // ── Geometry ───────────────────────────────────────────────────────────
  // Union of the primary target and an optional companion (the search bar plus
  // its category pills read as one thing, so they are spotlit together).
  function targetRect(step) {
    const el = step.target ? step.target() : null;
    if (!el) return null;
    let r = el.getBoundingClientRect();
    if (step.also) {
      const extra = step.also();
      if (extra) {
        const e = extra.getBoundingClientRect();
        const top = Math.min(r.top, e.top);
        const left = Math.min(r.left, e.left);
        r = {
          top,
          left,
          width: Math.max(r.right, e.right) - left,
          height: Math.max(r.bottom, e.bottom) - top,
          right: Math.max(r.right, e.right),
          bottom: Math.max(r.bottom, e.bottom),
        };
      }
    }
    if (!r.width && !r.height) return null;
    return r;
  }

  // Scrolling the target into view.
  //
  // The safe band excludes the space the tooltip occupies, so the highlight is
  // never hidden behind it — on phones the tooltip is a bottom sheet, which
  // would otherwise sit right on top of the element being explained.
  function scrollerEl() {
    return document.scrollingElement || document.documentElement || document.body;
  }

  function currentScroll() {
    const sc = scrollerEl();
    return sc.scrollTop || window.pageYOffset || 0;
  }

  function isPhone() {
    return window.matchMedia('(max-width:640px)').matches;
  }

  // [top, bottom] of the area a highlight may occupy, in viewport coordinates.
  function safeBand() {
    const vh = window.innerHeight;
    const top = 88;                                  // clears the fixed navbar
    let bottom = vh - 24;
    if (isPhone() && dom && dom.card) {
      const h = dom.card.getBoundingClientRect().height || 210;
      bottom = Math.max(top + 80, vh - h - 28);      // above the bottom sheet
    }
    return { top, bottom };
  }

  function scrollTargetIntoView(step) {
    const el = step.target ? step.target() : null;
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;

    const r = el.getBoundingClientRect();
    const band = safeBand();
    if (r.top >= band.top && r.bottom <= band.bottom) return false;

    const sc = scrollerEl();
    const from = currentScroll();
    // Centre it inside the band when there is room, otherwise pin it to the top
    // of the band so at least the start of the element is visible.
    const room = band.bottom - band.top;
    const offset = r.height >= room ? band.top : band.top + (room - r.height) / 2;
    const wanted = from + r.top - offset;
    const max = Math.max(0, sc.scrollHeight - window.innerHeight);
    const to = Math.min(Math.max(0, Math.round(wanted)), max);
    if (Math.abs(to - from) < 4) return false;

    // The page sets scroll-behavior:smooth globally, and a programmatic smooth
    // scroll is unreliable (some engines drop it outright, leaving the
    // spotlight pointing off-screen). Force an instant jump for the duration of
    // this move — the spotlight and tooltip animate to their new positions on
    // their own, so the transition still reads as smooth.
    const html = document.documentElement;
    html.classList.add('sh-tour-instant-scroll');
    try {
      sc.scrollTop = to;
      if (Math.abs(currentScroll() - to) > 4) window.scrollTo(0, to);
    } catch (e) { /* nothing else to try */ }
    requestAnimationFrame(() => html.classList.remove('sh-tour-instant-scroll'));

    return true;
  }

  // Repaints for a short window after a scroll starts, until the target rect
  // stops moving. Cheaper and more reliable than guessing the scroll duration.
  let settleTimer = null;

  function settle(maxMs) {
    if (settleTimer) { clearInterval(settleTimer); settleTimer = null; }
    const started = Date.now();
    let lastTop = null;
    let stableFor = 0;
    settleTimer = setInterval(() => {
      if (!running) { clearInterval(settleTimer); settleTimer = null; return; }
      reposition();
      const step = steps[idx];
      const rect = step && step.kind === 'step' ? targetRect(step) : null;
      const top = rect ? Math.round(rect.top) : null;
      stableFor = (top !== null && top === lastTop) ? stableFor + 1 : 0;
      lastTop = top;
      if (stableFor >= 3 || Date.now() - started > maxMs) {
        clearInterval(settleTimer);
        settleTimer = null;
        reposition();
      }
    }, 70);
  }

  // Places the tooltip beside the spotlight, clamped to the viewport so it can
  // never overflow horizontally or vertically. Phones use the bottom-sheet
  // layout from the stylesheet instead, so nothing is positioned here.
  const PAD = 14;

  function placeCard(rect) {
    const card = dom.card;
    const phone = isPhone();

    if (!rect || phone) {
      card.classList.toggle('is-centred', !rect);
      if (phone) { card.style.top = ''; card.style.left = ''; }
      return;
    }

    card.classList.remove('is-centred');
    const box = card.getBoundingClientRect();
    const w = box.width || 360;
    const h = box.height || 200;

    // Prefer below, then above, then beside — whichever fits without clipping.
    let top = rect.bottom + PAD;
    if (top + h > window.innerHeight - PAD) {
      const above = rect.top - PAD - h;
      top = above >= PAD ? above : Math.max(PAD, window.innerHeight - h - PAD);
    }

    let left = rect.left + (rect.width / 2) - (w / 2);
    left = Math.min(Math.max(PAD, left), window.innerWidth - w - PAD);

    card.style.top = `${Math.round(top)}px`;
    card.style.left = `${Math.round(left)}px`;
  }

  function paintSpot(rect) {
    const spot = dom.spot;
    if (!rect) {
      spot.classList.add('is-hidden');
      dom.dim.classList.add('is-on');
      return;
    }
    dom.dim.classList.remove('is-on');
    const inset = 6;
    spot.style.top = `${Math.round(rect.top - inset)}px`;
    spot.style.left = `${Math.round(rect.left - inset)}px`;
    spot.style.width = `${Math.round(rect.width + inset * 2)}px`;
    spot.style.height = `${Math.round(rect.height + inset * 2)}px`;
    spot.classList.remove('is-hidden');
  }

  function renderDots(step) {
    const host = dom.card.querySelector('#shTourDots');
    if (step.kind !== 'step') { host.innerHTML = ''; return; }
    const current = idx; // steps[1] is numbered 1
    host.innerHTML = Array.from({ length: NUMBERED }, (_, i) => {
      const n = i + 1;
      const cls = n < current ? ' is-done' : (n === current ? ' is-now' : '');
      return `<span class="sh-tour-dot${cls}"></span>`;
    }).join('');
  }

  function actionButton(label, variant, onClick, ariaLabel) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sh-tour-btn${variant ? ' ' + variant : ''}`;
    b.textContent = label;
    if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
    b.addEventListener('click', onClick);
    return b;
  }

  // ── Render a step ──────────────────────────────────────────────────────
  function render() {
    const step = steps[idx];
    if (!step) return finish();

    dom.card.querySelector('#shTourTitle').textContent = step.title;
    dom.card.querySelector('#shTourBody').textContent = step.body;
    dom.card.querySelector('#shTourProgress').textContent =
      step.kind === 'step' ? `Step ${idx} of ${NUMBERED}` : '';
    renderDots(step);

    const actions = dom.card.querySelector('#shTourActions');
    actions.innerHTML = '';

    if (step.kind === 'intro') {
      actions.appendChild(actionButton(step.primary, 'sh-tour-btn-primary', next));
      actions.appendChild(actionButton(step.secondary, 'sh-tour-btn-quiet', skip, 'Skip the tutorial'));
    } else if (step.kind === 'outro') {
      actions.appendChild(actionButton(step.primary, 'sh-tour-btn-primary', finish));
    } else {
      actions.appendChild(actionButton('Back', '', back, 'Go to the previous step'));
      actions.appendChild(actionButton('Next', 'sh-tour-btn-primary', next, 'Go to the next step'));
      actions.appendChild(actionButton('Skip Tutorial', 'sh-tour-btn-quiet', skip, 'Skip the tutorial'));
    }

    const scrolling = scrollTargetIntoView(step);
    requestAnimationFrame(() => {
      reposition();
      dom.card.classList.add('is-in');
      focusCard();
      // Re-check with the card at its real height for this step: on phones the
      // safe band depends on how tall the bottom sheet turned out.
      if (step.kind === 'step' && scrollTargetIntoView(step)) reposition();
    });
    // Keep tracking the target while the page settles, so the spotlight never
    // stops short of the element it is pointing at.
    if (step.kind === 'step') settle(scrolling ? 1400 : 500);
    saveStep(idx);
  }

  function reposition() {
    if (!running || !dom) return;
    const step = steps[idx];
    if (!step) return;
    const rect = step.kind === 'step' ? targetRect(step) : null;
    paintSpot(rect);
    placeCard(rect);
  }

  // Focus lands on the step's main action so the keyboard is immediately in the
  // tour. Re-asserted shortly after, because the page's own load-time scripts
  // can move focus back to the document after the first attempt.
  function focusCard() {
    if (!dom) return;
    const first = dom.card.querySelector('.sh-tour-btn-primary') || dom.card.querySelector('.sh-tour-btn');
    const aim = first || dom.card;
    try { aim.focus({ preventScroll: true }); } catch (e) { aim.focus(); }
    setTimeout(() => {
      if (!running || !dom) return;
      if (dom.card.contains(document.activeElement)) return;
      const again = dom.card.querySelector('.sh-tour-btn-primary') || dom.card.querySelector('.sh-tour-btn') || dom.card;
      try { again.focus({ preventScroll: true }); } catch (e) { again.focus(); }
    }, 140);
  }

  // ── Navigation ─────────────────────────────────────────────────────────
  function next() {
    if (idx < steps.length - 1) { idx += 1; render(); }
    else finish();
  }

  function back() {
    if (idx > 0) { idx -= 1; render(); }
  }

  function skip() {
    persistOutcome('skipped');
    teardown();
  }

  function finish() {
    persistOutcome('completed');
    teardown();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  function on(target, event, handler, opts) {
    target.addEventListener(event, handler, opts);
    detach.push(() => target.removeEventListener(event, handler, opts));
  }

  function keydown(e) {
    if (!running) return;
    if (e.key === 'Escape') { e.preventDefault(); skip(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); back(); return; }
    if (e.key !== 'Tab') return;

    // Focus trap: the tour owns the keyboard while it is open.
    const focusables = Array.from(dom.card.querySelectorAll('.sh-tour-btn'));
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!dom.card.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }

  function start(fromIndex) {
    if (running) return;
    injectStyles();
    steps = buildSteps();
    idx = Math.min(Math.max(0, fromIndex || 0), steps.length - 1);
    running = true;
    lastFocused = document.activeElement;
    dom = buildDom();

    on(window, 'resize', reposition);
    on(window, 'scroll', reposition, { passive: true });
    // Capture phase, because the page scrolls <body> rather than the document
    // element and a scroll event on an element does not bubble to window.
    on(document, 'scroll', reposition, true);
    on(document, 'keydown', keydown, true);
    // The grid repaints on search, filter and pagination; keep the spotlight
    // glued to whatever card is in that position now.
    const grid = document.getElementById('couponGrid');
    if (grid && typeof MutationObserver === 'function') {
      const mo = new MutationObserver(() => reposition());
      mo.observe(grid, { childList: true, subtree: true });
      detach.push(() => mo.disconnect());
    }

    render();
  }

  function teardown() {
    running = false;
    if (settleTimer) { clearInterval(settleTimer); settleTimer = null; }
    detach.forEach((fn) => { try { fn(); } catch (e) { /* already gone */ } });
    detach = [];
    removeDom();
    if (lastFocused && typeof lastFocused.focus === 'function') {
      try { lastFocused.focus(); } catch (e) { /* element left the DOM */ }
    }
    lastFocused = null;
  }

  // ── Replay control ─────────────────────────────────────────────────────
  // Added under the search bar rather than into the markup, so marketplace.html
  // keeps its existing structure. It is the manual entry point once the tour
  // has been completed or skipped.
  function mountReplay() {
    if (document.getElementById('shTourReplay')) return;
    const host = document.querySelector('.search-bar');
    if (!host) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'shTourReplay';
    btn.className = 'sh-tour-replay';
    btn.innerHTML = '<span aria-hidden="true">🧭</span> New here? Replay tutorial';
    btn.setAttribute('aria-label', 'Replay the marketplace tutorial');
    btn.addEventListener('click', () => window.startMarketplaceTutorial());
    host.appendChild(btn);
  }

  // ── Auto-launch ────────────────────────────────────────────────────────
  // Only for a user who has never finished or skipped it. The account flag wins
  // when it is readable; local storage covers signed-out visitors and the
  // window before the API answers.
  async function alreadySeen() {
    const local = localState();
    if (local === 'completed' || local === 'skipped') return true;
    if (!loggedIn() || typeof window.api !== 'function') return false;
    try {
      const data = await api('/auth/onboarding');
      const state = (data && data.onboarding) || {};
      const seen = Boolean(state.marketplaceTutorialCompleted || state.marketplaceTutorialSkipped);
      if (seen) setLocalState(state.marketplaceTutorialCompleted ? 'completed' : 'skipped');
      return seen;
    } catch (e) {
      // Unreachable state store: do not nag a user we cannot check. Local
      // storage still gates the very first view per browser.
      return true;
    }
  }

  // The card-anchored steps need a rendered grid. Waits briefly for the first
  // coupon card, then starts regardless so an empty marketplace still explains
  // itself against the grid container.
  function waitForGrid(timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        if (document.querySelector('#couponGrid .coupon-card') || Date.now() > deadline) return resolve();
        setTimeout(tick, 180);
      };
      tick();
    });
  }

  async function boot() {
    mountReplay();

    const resumeAt = readStep();
    if (resumeAt !== null) {
      // A refresh mid-tour resumes where the user was.
      await waitForGrid(6000);
      start(resumeAt);
      return;
    }

    if (await alreadySeen()) return;
    await waitForGrid(6000);
    if (readStep() !== null || running) return;
    start(0);
  }

  window.startMarketplaceTutorial = function startMarketplaceTutorial(fromIndex) {
    if (running) return;
    injectStyles();
    start(typeof fromIndex === 'number' ? fromIndex : 0);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
