/*
 * PurchasedCouponModal — the single shared "purchased coupon box".
 *
 * Used by BOTH:
 *   - checkout.html   (the box that opens after the server confirms PAID)
 *   - dashboard.html  (User Dashboard -> Coupon Overview -> tap a coupon)
 *
 * Usage:
 *   PurchasedCouponModal.mount();              // inject markup + CSS once
 *   PurchasedCouponModal.open(coupon, opts);   // coupon = { brand, title, discount,
 *                                              //   description, value, category, expiry,
 *                                              //   backgroundImage, terms, code, orderId,
 *                                              //   id, kind, ... }
 *   PurchasedCouponModal.close();
 *
 * Security: this component never fetches or invents codes. It shows only the
 * `code` it is handed. Callers must pass codes that came from an owner-gated
 * endpoint (checkout: the PAID response; dashboard: /api/coupons/my-purchases,
 * which returns code = '' unless the user owns the PAID sale).
 *
 * Reveal state is keyed per coupon (orderId || id || code) in localStorage so a
 * revealed coupon stays revealed after reopening, without scratching again.
 */
(function (global) {
  'use strict';

  var ROOT_ID = 'pcmOverlay';
  var CSS_ID = 'pcm-styles';
  var DEFAULT_BG = '/images/coupons/default.svg';
  var REVEAL_THRESHOLD = 0.5;

  var state = {
    coupon: null,
    key: '',
    revealed: false,
    strokes: [],
    ctx: null,
    canvas: null,
    activePointer: null,
    previous: null,
    onClose: null,
    bound: false,
    resizeObs: null,
  };

  // ── helpers ──────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"']/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(raw) {
    var t = Date.parse(raw || '');
    if (isNaN(t)) return '';
    return new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function heroFor(c) {
    var raw = String((c && c.backgroundImage) || '').trim();
    if (/^https?:\/\/\S+$/i.test(raw)) return raw;
    if (/^\/[\w\-./~%#?=&+]*$/.test(raw) && raw.indexOf('"') < 0 && raw.indexOf("'") < 0) return raw;
    var brandBg = (typeof global.getBrandBackground === 'function') ? global.getBrandBackground(c && c.brand) : '';
    return brandBg || DEFAULT_BG;
  }
  function logoHtml(brand) {
    var initial = (typeof global.getBrandInitial === 'function')
      ? global.getBrandInitial(brand)
      : (String(brand || '?').charAt(0).toUpperCase() || '?');
    var url = (typeof global.getBrandLogo === 'function') ? global.getBrandLogo(brand) : '';
    if (!url) return '<span class="pcm-initial">' + esc(initial) + '</span>';
    var extra = (typeof global.getBrandLogoClass === 'function') ? (global.getBrandLogoClass(url) || '') : '';
    return '<img src="' + esc(url) + '" alt="' + esc(brand) + '"' +
      (extra ? ' class="' + esc(extra) + '"' : '') +
      ' onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
      '<span class="pcm-initial" style="display:none">' + esc(initial) + '</span>';
  }
  function storageKey(c) {
    var id = (c && (c.orderId || c.id || c.code)) || '';
    return id ? 'sh_scratched_' + id : '';
  }
  function wasRevealed(c) {
    try { var k = storageKey(c); return !!k && global.localStorage.getItem(k) === '1'; } catch (e) { return false; }
  }
  function markRevealed(c) {
    try { var k = storageKey(c); if (k) global.localStorage.setItem(k, '1'); } catch (e) { /* private mode */ }
  }

  // ── markup + styles ──────────────────────────────────────────────────────
  var CSS = [
    '#pcmOverlay{position:fixed;inset:0;z-index:9000;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(6,13,31,.92);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);overflow-y:auto}',
    '#pcmOverlay.open{display:flex}',
    '#pcmOverlay .pcm-card{position:relative;width:100%;max-width:440px;max-height:calc(100dvh - 40px);overflow-y:auto;border-radius:18px;background:#0c1628;border:1.5px solid #00E272;box-shadow:0 0 0 1px rgba(0,226,114,.08),0 0 60px rgba(0,226,114,.06),0 30px 80px rgba(0,0,0,.6);padding:14px;font-family:Inter,system-ui,sans-serif;color:#f8f8fa;box-sizing:border-box}',
    '#pcmOverlay .pcm-close{position:absolute;top:12px;right:12px;z-index:2;width:34px;height:34px;border-radius:50%;border:1px solid #2c4262;background:#0b1d34;color:#b8bfff;display:grid;place-items:center;cursor:pointer;padding:0}',
    '#pcmOverlay .pcm-close:hover{border-color:#57789c;transform:scale(1.04)}',
    '#pcmOverlay .pcm-close:focus-visible{outline:3px solid rgba(0,226,114,.36);outline-offset:3px}',
    '#pcmOverlay .pcm-close svg{width:15px;height:15px}',
    '#pcmOverlay .pcm-hero{aspect-ratio:1062/334;background-size:cover;background-position:center;background-color:#082331;border-radius:14px;width:100%}',
    '#pcmOverlay .pcm-content{padding:14px 2px 2px}',
    '#pcmOverlay .pcm-offer{display:grid;grid-template-columns:72px 1fr;gap:12px;align-items:center}',
    // White rounded square holding the logo, contained with padding so it is never stretched.
    '#pcmOverlay .pcm-logo{width:72px;height:72px;border-radius:14px;background:#ffffff;display:grid;place-items:center;padding:10px;box-sizing:border-box;overflow:hidden}',
    '#pcmOverlay .pcm-logo img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block}',
    '#pcmOverlay .pcm-initial{font-size:28px;font-weight:800;color:#060d1f}',
    '#pcmOverlay .pcm-title{margin:0 0 6px;font-size:clamp(18px,4.8vw,22px);font-weight:700;line-height:1.25;letter-spacing:-.4px;color:#f8f8fa;word-break:break-word}',
    '#pcmOverlay .pcm-sub{margin:0;font-size:clamp(14px,3.8vw,17px);line-height:1.3;color:#b8bfff;word-break:break-word}',
    // Whole scratch box is white; the code sits inside it once revealed.
    '#pcmOverlay .pcm-box{position:relative;margin-top:14px;height:56px;border-radius:14px;background:#ffffff;overflow:hidden;user-select:none;-webkit-user-select:none}',
    '#pcmOverlay .pcm-code{position:absolute;inset:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;border:0;background:#ffffff;color:#001522;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:clamp(16px,4.6vw,20px);font-weight:700;letter-spacing:2px;cursor:default;padding:0 12px;box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
    '#pcmOverlay .pcm-code.copyable{cursor:pointer}',
    '#pcmOverlay .pcm-code:focus-visible{outline:3px solid rgba(0,226,114,.5);outline-offset:-3px}',
    '#pcmOverlay .pcm-code-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#pcmOverlay .pcm-canvas{position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;touch-action:none;border-radius:14px}',
    '#pcmOverlay .pcm-canvas.gone{display:none}',
    '#pcmOverlay .pcm-view{width:100%;margin-top:14px;padding:16px 10px;border:0;border-radius:14px;background:#00E272;color:#00100c;font-size:18px;font-weight:700;cursor:pointer}',
    '#pcmOverlay .pcm-view:hover{filter:brightness(1.08)}',
    '#pcmOverlay .pcm-view:focus-visible{outline:none;filter:brightness(1.18)}',
    '#pcmOverlay .pcm-toast{margin:10px 0 0;min-height:18px;text-align:center;font-size:13px;color:#00E272}',
    '#pcmOverlay .pcm-toast.err{color:#ff8585}',
    '#pcmOverlay .pcm-acc{margin-top:10px;border-radius:12px;background:#082331;overflow:hidden}',
    '#pcmOverlay .pcm-acc summary{padding:14px 14px;list-style:none;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-size:15px;color:#f8f8fa}',
    '#pcmOverlay .pcm-acc summary::-webkit-details-marker{display:none}',
    '#pcmOverlay .pcm-acc summary::after{content:"";width:9px;height:9px;border-right:2px solid #b8bfff;border-bottom:2px solid #b8bfff;transform:rotate(45deg);margin-right:4px}',
    '#pcmOverlay .pcm-acc[open] summary::after{transform:translateY(4px) rotate(225deg)}',
    '#pcmOverlay .pcm-acc-body{padding:0 14px 14px;color:#b8bfff;font-size:14px;line-height:1.6}',
    '#pcmOverlay .pcm-acc-body p{margin:0}',
    '@media (max-width:480px){#pcmOverlay{padding:12px}#pcmOverlay .pcm-card{padding:12px}}'
  ].join('\n');

  var MARKUP = [
    '<div class="pcm-card" role="dialog" aria-modal="true" aria-labelledby="pcmTitle">',
    '  <button class="pcm-close" type="button" data-pcm="close" aria-label="Close coupon">',
    '    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round"/></svg>',
    '  </button>',
    '  <div class="pcm-hero" id="pcmHero" role="img" aria-label="Coupon banner"></div>',
    '  <div class="pcm-content">',
    '    <div class="pcm-offer">',
    '      <div class="pcm-logo" id="pcmLogo"></div>',
    '      <div>',
    '        <h2 class="pcm-title" id="pcmTitle"></h2>',
    '        <p class="pcm-sub" id="pcmSub"></p>',
    '      </div>',
    '    </div>',
    '    <div class="pcm-box" id="pcmBox">',
    '      <button class="pcm-code" id="pcmCode" type="button" disabled aria-label="Coupon code"><span class="pcm-code-text" id="pcmCodeText"></span></button>',
    '      <canvas class="pcm-canvas" id="pcmCanvas" tabindex="0" role="button" aria-label="Scratch to reveal your coupon code. Press Enter to reveal."></canvas>',
    '    </div>',
    '    <button class="pcm-view" id="pcmView" type="button">Redeem Now</button>',
    '    <p class="pcm-toast" id="pcmToast" role="status" aria-live="polite"></p>',
    '    <details class="pcm-acc">',
    '      <summary>How to use</summary>',
    '      <div class="pcm-acc-body"><p>Scratch the white box to reveal your code, or focus it and press Enter. Tap the revealed code to copy it, then paste it in the promo code field at checkout.</p></div>',
    '    </details>',
    '    <details class="pcm-acc">',
    '      <summary>Terms and Conditions</summary>',
    '      <div class="pcm-acc-body" id="pcmTerms"><p>&mdash;</p></div>',
    '    </details>',
    '  </div>',
    '</div>'
  ].join('\n');

  // ── mount / open / close ─────────────────────────────────────────────────
  function mount() {
    if ($(ROOT_ID)) return;
    if (!$(CSS_ID)) {
      var style = document.createElement('style');
      style.id = CSS_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    var overlay = document.createElement('div');
    overlay.id = ROOT_ID;
    overlay.innerHTML = MARKUP;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
      var btn = e.target.closest && e.target.closest('[data-pcm="close"]');
      if (btn) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('open')) close();
    });
    $('pcmCode').addEventListener('click', copyCode);
    $('pcmView').addEventListener('click', copyCode);
  }

  function open(coupon, opts) {
    mount();
    opts = opts || {};
    state.coupon = coupon || {};
    state.onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
    state.key = storageKey(state.coupon);
    state.strokes = [];
    state.revealed = false;
    state.activePointer = null;
    state.previous = null;

    populate(state.coupon);

    var overlay = $(ROOT_ID);
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';

    // Already-revealed coupons (or non-purchased rows) skip the foil.
    var canScratch = opts.scratch !== false && state.coupon.kind !== 'used' && state.coupon.kind !== 'expired';
    if (!canScratch || wasRevealed(state.coupon) || !state.coupon.code) {
      setRevealed(true);
      return;
    }
    requestAnimationFrame(function () { requestAnimationFrame(initScratch); });
  }

  function close() {
    var overlay = $(ROOT_ID);
    if (!overlay || !overlay.classList.contains('open')) return;
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    if (state.onClose) state.onClose();
  }

  function populate(c) {
    var brand = String(c.brand || '').trim();
    var title = String(c.title || '').trim();
    var discount = String(c.discount || '').trim();
    var heading = title && title !== discount ? title : (brand || 'Discount Coupon');
    var sub = String(c.description || '').trim();
    if (!sub || sub === brand || sub === heading) sub = c.value ? ('Value ' + c.value) : 'on selected items';

    $('pcmHero').style.backgroundImage = "url('" + heroFor(c).replace(/'/g, '%27') + "')";
    $('pcmLogo').innerHTML = logoHtml(brand);
    $('pcmTitle').textContent = heading;
    $('pcmSub').textContent = sub;
    $('pcmCodeText').textContent = c.code ? String(c.code) : '';
    var termsEl = $('pcmTerms');
    var terms = String(c.terms || '').trim();
    termsEl.textContent = terms || 'Standard SaveHatke terms apply. Coupon codes are non-refundable once revealed.';
    $('pcmToast').textContent = '';
    $('pcmToast').className = 'pcm-toast';
    $('pcmCanvas').classList.remove('gone');
  }

  // ── reveal + copy ────────────────────────────────────────────────────────
  function setRevealed(on) {
    state.revealed = !!on;
    var codeBtn = $('pcmCode');
    codeBtn.disabled = !on;
    codeBtn.classList.toggle('copyable', !!on);
    var canvas = $('pcmCanvas');
    canvas.classList.toggle('gone', !!on);
  }

  // Only an actual scratch (or keyboard reveal) is persisted, never the
  // no-layout fallback, so a coupon is never marked scratched unscratched.
  function revealNow() {
    if (state.revealed) return;
    setRevealed(true);
    if (state.coupon && state.coupon.code) markRevealed(state.coupon);
  }

  function copyCode() {
    if (!state.revealed) return; // taps during scratching never copy
    var code = state.coupon && state.coupon.code ? String(state.coupon.code) : '';
    if (!code) return;
    var toast = $('pcmToast');
    var ok = function () { toast.className = 'pcm-toast'; toast.textContent = 'Code copied!'; setTimeout(function () { if (toast.textContent === 'Code copied!') toast.textContent = ''; }, 1800); };
    var fail = function () { toast.className = 'pcm-toast err'; toast.textContent = 'Could not copy. Select the code and copy it manually.'; };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = code; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var done = false;
      try { done = document.execCommand('copy'); } catch (e) { done = false; }
      document.body.removeChild(ta);
      done ? ok() : fail();
    };
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(code).then(ok, fallback);
    } else {
      fallback();
    }
  }

  // ── scratch foil ─────────────────────────────────────────────────────────
  function initScratch() {
    var canvas = $('pcmCanvas');
    var box = $('pcmBox');
    if (!canvas || !box) return;
    state.canvas = canvas;
    state.ctx = canvas.getContext('2d');
    state.strokes = [];
    state.revealed = false;
    canvas.classList.remove('gone');
    $('pcmCode').disabled = true;
    if (!state.ctx || !box.offsetWidth || !box.offsetHeight) {
      // Cannot lay out a foil: show the code rather than trap it.
      setRevealed(true);
      return;
    }
    if (!state.bound) bindScratch();
    paintFoil();
    if (!state.resizeObs && 'ResizeObserver' in global) {
      state.resizeObs = new ResizeObserver(function () { if (!state.revealed) paintFoil(); });
      state.resizeObs.observe(box);
    }
  }

  function paintFoil() {
    if (state.revealed || !state.ctx) return;
    var canvas = state.canvas;
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var dpr = global.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    var ctx = state.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    // Solid white foil covering the entire box — no grey strip, no gaps.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = '#46515e';
    ctx.font = '700 14px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SCRATCH TO REVEAL', rect.width / 2, rect.height / 2);
    state.strokes.forEach(function (s) { erase(s.from, s.to); });
  }

  function erase(from, to) {
    var ctx = state.ctx;
    if (!ctx) return;
    var w = state.canvas.clientWidth, h = state.canvas.clientHeight;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = 34;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x * w, from.y * h);
    ctx.lineTo(to.x * w, to.y * h);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(to.x * w, to.y * h, 17, 0, Math.PI * 2);
    ctx.fill();
  }

  function point(event) {
    var r = state.canvas.getBoundingClientRect();
    return { x: (event.clientX - r.left) / r.width, y: (event.clientY - r.top) / r.height };
  }

  function coverageCheck() {
    if (!state.ctx || state.revealed || !state.canvas.width || !state.canvas.height) return;
    var px = state.ctx.getImageData(0, 0, state.canvas.width, state.canvas.height).data;
    var cleared = 0, total = 0;
    for (var i = 3; i < px.length; i += 64) { total++; if (px[i] < 128) cleared++; }
    if (total && cleared / total >= REVEAL_THRESHOLD) revealNow();
  }

  function bindScratch() {
    state.bound = true;
    var canvas = state.canvas;
    // Canvas is re-used across opens; bind once against the element.
    canvas.addEventListener('pointerdown', function (event) {
      if (state.revealed || state.activePointer !== null || event.button !== 0) return;
      event.preventDefault();
      state.activePointer = event.pointerId;
      state.previous = point(event);
      canvas.setPointerCapture(event.pointerId);
      state.strokes.push({ from: state.previous, to: state.previous });
      erase(state.previous, state.previous);
    });
    canvas.addEventListener('pointermove', function (event) {
      if (event.pointerId !== state.activePointer || state.revealed) return;
      var next = point(event);
      state.strokes.push({ from: state.previous, to: next });
      erase(state.previous, next);
      state.previous = next;
    });
    var finish = function (event) {
      if (event.pointerId !== state.activePointer) return;
      state.activePointer = null;
      state.previous = null;
      coverageCheck();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
    canvas.addEventListener('lostpointercapture', finish);
    canvas.addEventListener('keydown', function (event) {
      if ((event.key === 'Enter' || event.key === ' ') && !state.revealed) {
        event.preventDefault();
        revealNow();
      }
    });
  }

  global.PurchasedCouponModal = { mount: mount, open: open, close: close };
})(window);
