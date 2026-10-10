/* ══════════════════════════════════════════════════════════════════════════
   SaveHatke — Coupon screenshot OCR (client-side, ₹0 cost)
   ══════════════════════════════════════════════════════════════════════════
   The image never leaves the browser: PaddleOCR.js (the official
   @paddleocr/paddleocr-js SDK, PP-OCRv5 English models) reads it here,
   a pure parser finds the coupon details, and the result is fed into the
   EXISTING auto-fill machinery in sell.html (applyAiFields / markAiField),
   which is unchanged.

   Flow (matches the spec):
     upload → preprocess → PaddleOCR.js (det + rec) → text lines
           → coupon-code detection → confidence score → existing auto-fill

   Engine hosting (all legitimate, self-hosted where practical):
   • The SDK bundle is vendored at /vendor/paddleocr/paddleocr.bundle.mjs
     (built once from the npm package — see package.json build:vendor-ocr).
   • The ONNX Runtime wasm binary is vendored from the same installed
     onnxruntime-web version at /vendor/paddleocr/ort-wasm-simd-threaded.wasm
     (wasmPaths is pinned to it so the runtime always matches the bundle).
   • The PP-OCRv5 English det/rec model tars (~21 MB) are downloaded by the
     SDK on the FIRST scan from Paddle's official model host
     (paddle-model-ecology.bj.bcebos.com) and cached by the browser.

   Guarantees:
   • No paid API, no API key, no inference server. Images are processed
     locally; nothing about the screenshot is uploaded, logged or stored.
   • The engine is loaded lazily (dynamic import — nothing runs at page
     load) and the initialized engine is created once and reused for every
     scan; dispose() frees it on pagehide.
   • One OCR job at a time — a second concurrent call is rejected.
   • Every extracted value is sanitized plain text and reaches the form only
     through input.value assignments made by the existing auto-fill code.
     The final coupon validation is still the server's, exactly as before.
   • The SDK's Web-Worker mode needs a module-worker bundler, which this
     static site does not have, so inference runs on the main thread (the
     SDK's documented no-bundler path). Mobile devices may see brief jank
     while det/rec run.

   Exposes (browser):  window.CouponOCR = { extract, dispose }
   Exposes (Node):     module.exports  = { parseCouponData, ocrTargetSize }
   — parseCouponData/ocrTargetSize are pure functions, unit-tested by
   verify-coupon-ocr.cjs.
   ══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* Vendored SDK + ORT wasm (see header). Served same-origin. */
  var ENGINE_SRC = '/vendor/paddleocr/paddleocr.bundle.mjs';
  var ORT_WASM_DIR = '/vendor/paddleocr/';
  /* PP-OCRv5 mobile models — English/Latin text (Indian coupon screenshots). */
  var ENGINE_LANG = 'en';
  var ENGINE_OCR_VERSION = 'PP-OCRv5';

  /* ── Confidence bands (mirrors the old server semantics) ──
     The old vision service filled a field at ≥0.35 and flagged "please
     verify" below 0.85. The UI (markAiField) still keys off `verify`, so
     VERIFY_BELOW stays 0.85 exactly. OCR heuristics are noisier than a
     vision model's self-assessed confidence, so the fill gates are stricter:
       code  ≥0.50 → fill (verify badge when <0.85), 0.30–0.50 → candidate
                     shown for manual confirmation, never auto-filled
       other ≥0.55 → fill (verify badge when <0.85)                     */
  var CODE_FILL_MIN = 0.50;
  var CODE_CANDIDATE_MIN = 0.30;
  var FIELD_FILL_MIN = 0.55;
  var VERIFY_BELOW = 0.85;

  /* Value caps — same numbers the old server enforced (couponVision MAX_LEN). */
  var MAX_LEN = {
    coupon_code: 40,
    discount_value: 60,
    minimum_order_value: 7,   // digits
    original_value_or_max_discount: 7,
  };

  /* Words that look like codes but are offer vocabulary. */
  var JUNK_WORDS = {
    OFF: 1, FLAT: 1, GET: 1, UPTO: 1, SAVE: 1, BUY: 1, FREE: 1, ONLY: 1,
    CODE: 1, COUPON: 1, PROMO: 1, VOUCHER: 1, USE: 1, THE: 1, AND: 1,
    WITH: 1, YOUR: 1, ALL: 1, SITEWIDE: 1, CASHBACK: 1, VALID: 1, TILL: 1,
    UNTIL: 1, EXPIRY: 1, OFFER: 1, SHOP: 1, NOW: 1, ORDER: 1, MIN: 1,
    MAX: 1, RS: 1, INR: 1, PLUS: 1, NEW: 1, FIRST: 1, APP: 1, WEB: 1,
    BANK: 1, CARD: 1, PER: 1, DAY: 1, APPLY: 1, ENTER: 1, THIS: 1, OUR: 1,
    JAN: 1, FEB: 1, MAR: 1, APR: 1, MAY: 1, JUN: 1, JUL: 1, AUG: 1,
    SEP: 1, OCT: 1, NOV: 1, DEC: 1,
    // Non-offer copy that commonly surrounds a coupon in screenshots (order
    // updates, app banners) — none of it is a redeemable code.
    SHIPPED: 1, TRACK: 1, TRACKING: 1, DELIVERY: 1, DELIVERED: 1,
    DISPATCHED: 1, SHIPMENT: 1, PACKAGE: 1, PARCEL: 1, CUSTOMER: 1,
    ACCOUNT: 1, EVERYTHING: 1, FASHION: 1, USERS: 1, TODAY: 1, HURRY: 1,
    EXCLUSIVE: 1, LIMITED: 1, ENJOY: 1, HAPPY: 1, GRAB: 1, DEALS: 1,
    OFFERS: 1, LIVE: 1, ALSO: 1, INSTANT: 1, PERCENT: 1, MORE: 1,
    THERE: 1, THAT: 1, HAVE: 1, FROM: 1, FOR: 1, ARE: 1, WAS: 1, BUT: 1,
    NOT: 1, CAN: 1, WILL: 1, ANY: 1, OUT: 1,
  };

  /* Token prefixes that mark ids rather than redeemable codes. */
  var JUNK_PREFIXES = ['ORDER', 'REF', 'TXN', 'AWB', 'OTP', 'INV', 'UPI'];

  /* ── Small shared helpers ─────────────────────────────────────────────── */

  function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }
  function round2(n) { return Math.round(n * 100) / 100; }

  /** Sanitize any OCR-derived string: strip control chars, collapse spaces,
      cap length. Everything that reaches `fields` passes through here. */
  function scrub(v, max) {
    if (v == null) return null;
    var s = String(v)
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (!s) return null;
    return s.slice(0, max);
  }

  /* ── Preprocessing (browser-only; uses canvas) ────────────────────────── */

  /**
   * Size the OCR canvas: bring the SHORT edge up to ~1100px (small screenshots
   * and downscaled photos read far better upscaled), never blow an image up
   * more than 4×, and cap the LONG edge at 3200px so a 12MP photo stays fast.
   * Pure — unit-tested.
   */
  function ocrTargetSize(w, h) {
    if (!w || !h) return { w: 1, h: 1, scale: 1 };
    var short = Math.min(w, h);
    var long = Math.max(w, h);
    var scale = short < 1100 ? 1100 / short : 1;
    if (long * scale > 3200) scale = 3200 / long;
    scale = Math.max(0.05, Math.min(scale, 4));
    return {
      w: Math.max(1, Math.round(w * scale)),
      h: Math.max(1, Math.round(h * scale)),
      scale: scale,
    };
  }

  /**
   * Grayscale + percentile contrast stretch (+ light sharpen only when the
   * image was upscaled, where detail is soft). Deliberately NO binarization —
   * Tesseract's LSTM reads grayscale well and a hard threshold destroys
   * phone photos with gradients.
   */
  function prepareCanvas(source, srcW, srcH) {
    var t = ocrTargetSize(srcW, srcH);
    var canvas = document.createElement('canvas');
    canvas.width = t.w;
    canvas.height = t.h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    // White base flattens transparent PNGs instead of fringing them black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, t.w, t.h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, t.w, t.h);

    var id;
    try { id = ctx.getImageData(0, 0, t.w, t.h); } catch (e) { return canvas; }
    var d = id.data;

    var hist = new Float64Array(256);
    var i;
    var px;
    for (i = 0, px = 0; i < d.length; i += 4, px++) {
      var g0 = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      d[i] = d[i + 1] = d[i + 2] = g0;
      hist[g0 | 0]++;
    }

    var total = t.w * t.h;
    var lo = 0;
    var hi = 255;
    var acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.02) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= total * 0.02) { hi = i; break; } }

    if (hi - lo > 30 && hi > lo) {
      var range = hi - lo;
      for (i = 0; i < d.length; i += 4) {
        var g1 = (d[i] - lo) * 255 / range;
        if (g1 < 0) g1 = 0; else if (g1 > 255) g1 = 255;
        d[i] = d[i + 1] = d[i + 2] = g1;
      }
    }

    // Mild sharpen after upscaling (small images get soft). Skipped on big
    // images to stay fast — they don't need it.
    if (t.scale > 1.5 && total <= 4000000) {
      var copy = new Uint8ClampedArray(d);
      for (var y = 1; y < t.h - 1; y++) {
        for (var x = 1; x < t.w - 1; x++) {
          var c = (y * t.w + x) * 4;
          var v = 5 * copy[c] - copy[c - 4] - copy[c + 4] - copy[c - t.w * 4] - copy[c + t.w * 4];
          d[c] = d[c + 1] = d[c + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }

    ctx.putImageData(id, 0, 0);
    return canvas;
  }

  /** The same image rotated 90° clockwise — the second-chance pass. */
  function rotatedCanvas(source, srcW, srcH) {
    var canvas = document.createElement('canvas');
    canvas.width = srcH;
    canvas.height = srcW;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(srcH, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(source, 0, 0);
    return prepareCanvas(canvas, srcH, srcW);
  }

  /* ── PaddleOCR.js loading + engine reuse ──────────────────────────────── */

  /* The dynamic import() promise — single-flight, so the 11 MB SDK bundle is
     fetched and evaluated exactly once no matter how many scans run. */
  var modulePromise = null;
  function loadEngineModule() {
    if (modulePromise) return modulePromise;
    modulePromise = import(ENGINE_SRC).catch(function (e) {
      modulePromise = null;   // a failed load must not poison the next scan
      var err = new Error('Could not load the OCR engine bundle.');
      err.code = 'engine_load_failed';
      err.cause = e;
      throw err;
    });
    return modulePromise;
  }

  /* The initialized pipeline — created once, reused for every scan.
     backend "wasm" (not "auto"): deterministic across devices, needs no
     WebGPU and no cross-origin isolation, and always loads the vendored
     ort-wasm-simd-threaded.wasm instead of the heavier jsep build. */
  var enginePromise = null;
  function getEngine(onProgress) {
    if (!enginePromise) {
      enginePromise = loadEngineModule()
        .then(function (mod) {
          onProgress(0.06, 'Downloading the OCR models (first scan only)…');
          if (!mod || !mod.PaddleOCR || typeof mod.PaddleOCR.create !== 'function') {
            throw new Error('OCR engine bundle did not export PaddleOCR.create.');
          }
          return mod.PaddleOCR.create({
            lang: ENGINE_LANG,
            ocrVersion: ENGINE_OCR_VERSION,
            ortOptions: {
              backend: 'wasm',
              wasmPaths: ORT_WASM_DIR,
              numThreads: 1,
              simd: true,
            },
          });
        })
        .then(function (engine) {
          onProgress(0.4, 'Reading the coupon text…');
          return engine;
        })
        .catch(function (e) {
          enginePromise = null; // a failed init must not poison the next scan
          if (e && e.code) throw e;
          var err = new Error('Could not initialise the OCR engine.');
          err.code = 'engine_init_failed';
          err.cause = e;
          throw err;
        });
    }
    return enginePromise;
  }

  /** Free the cached pipeline (pagehide / explicit cleanup). */
  function dispose() {
    if (enginePromise) {
      var p = enginePromise;
      enginePromise = null;
      p.then(function (engine) {
        if (engine && typeof engine.dispose === 'function') {
          try { engine.dispose(); } catch (e) { /* already gone */ }
        }
      }).catch(function () { /* never initialized */ });
    }
  }

  /* ── PaddleOCR result → plain line list ───────────────────────────────── */

  /**
   * Accepts the SDK's OcrResult.items (one entry per detected text line:
   * { text, score, poly: [[x,y]×4] }) and returns the [{ text, confidence,
   * bbox, words }] shape the pure parser consumes — confidence on the same
   * 0–100 scale Tesseract used, bbox derived from the quad's extent, and
   * `words` left empty so the parser's pseudo-word fallback lays the line's
   * tokens out left→right. Pure — used by the unit tests too.
   */
  function normalizePaddleItems(items) {
    var lines = [];
    if (!Array.isArray(items)) return lines;
    items.forEach(function (it) {
      if (!it) return;
      var text = String(it.text || '').trim();
      if (!text) return;
      var bbox = null;
      if (Array.isArray(it.poly) && it.poly.length) {
        var xs = [];
        var ys = [];
        it.poly.forEach(function (pt) {
          if (Array.isArray(pt) && pt.length >= 2) { xs.push(Number(pt[0]) || 0); ys.push(Number(pt[1]) || 0); }
          else if (pt && typeof pt === 'object') { xs.push(Number(pt.x) || 0); ys.push(Number(pt.y) || 0); }
        });
        if (xs.length && ys.length) {
          bbox = {
            x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs),
            y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys),
          };
        }
      }
      var conf = Math.max(0, Math.min(1, Number(it.score) || 0)) * 100;
      lines.push({ text: text, confidence: conf, bbox: bbox, words: [] });
    });
    return lines;
  }

  /* ── Coupon-code detection (pure) ─────────────────────────────────────── */

  var CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._+\/-]{2,39}$/;
  var LABEL_WORD = /^(code|coupon|promo|voucher)s?[:.\-=?]*$/i;
  var FILLER_WORD = /^(is|the|our|this|your|use|enter|apply|here|below|above|it|a|an|to|on)$/i;

  function stripEdges(tok) {
    return String(tok || '').replace(/^[:;.,'"“”‘’([{\-_*|\\]+|[:;.,'"“”‘’)\]}\-_*|\\]+$/g, '');
  }

  function meanLineConf(lines) {
    if (!lines.length) return 0;
    var sum = 0;
    var n = 0;
    lines.forEach(function (l) {
      var ws = l.words && l.words.length ? l.words : null;
      if (ws) {
        ws.forEach(function (w) { sum += (Number(w.confidence) || 0) / 100; n++; });
      } else {
        sum += (Number(l.confidence) || 0) / 100;
        n++;
      }
    });
    return n ? sum / n : 0;
  }

  /**
   * Conservative OCR-error repair (spec §5): only when the token already has
   * ≥2 digits (so it is strongly code-like) are ambiguous letters that sit
   * NEXT TO a digit remapped — O→0, I/L→1, S→5, B→8. All-letter tokens are
   * never touched, and a corrected candidate carries a small penalty.
   * Pure — unit-tested.
   */
  function ocrFixVariant(tok) {
    var digitCount = (tok.match(/\d/g) || []).length;
    if (digitCount < 1) return null;
    var fixed = '';
    for (var i = 0; i < tok.length; i++) {
      var c = tok[i];
      // Never "repair" the first character: a real B00ST-style code must not
      // become 800ST. Mid-token letters squeezed next to digits are the
      // classic misread (SAVE5OABC → SAVE50ABC), so only those are remapped.
      var nearDigit = (i > 0 && /\d/.test(tok[i - 1])) || (i < tok.length - 1 && /\d/.test(tok[i + 1]));
      if (nearDigit) {
        if (c === 'O') c = '0';
        else if (c === 'I' || c === 'L') c = '1';
        else if (c === 'S') c = '5';
        else if (c === 'B') c = '8';
      }
      fixed += c;
    }
    return fixed !== tok ? fixed : null;
  }

  /**
   * Score one candidate token. Higher is better; 0 means reject.
   * base: mean OCR confidence of the word(s), 0–1.
   */
  function scoreCodeCandidate(tok, base, ctx) {
    var word = tok.value;
    if (JUNK_WORDS[word]) return 0;
    if (word.length > 4 && JUNK_WORDS[word.replace(/S$/, '')]) return 0;  // plural of junk
    if (/^(19|20)\d{2}$/.test(word)) return 0;          // a year, not a code
    for (var p = 0; p < JUNK_PREFIXES.length; p++) {
      if (word.indexOf(JUNK_PREFIXES[p]) === 0) return 0;  // order/ref/txn ids
    }
    if (word.length < 4 || word.length > 40) return 0;
    if (/^[A-Z]+$/.test(word) && word.length < 5) return 0;  // short words aren't codes

    // Label trust scales with how well the label itself was read: garbage OCR
    // should not hand out near-certain labels.
    var labelRef = ctx.labelConf != null ? ctx.labelConf : base;
    var k = 0.35 + labelRef * 0.65;
    var score = base * 0.75;
    if (ctx.labelSame != null) score += 0.18 * k;
    else if (ctx.labelBelow != null) score += 0.10 * k;

    var L = word.length;
    if (L >= 6 && L <= 16) score += 0.10;
    else if ((L >= 4 && L <= 5) || (L >= 17 && L <= 24)) score += 0.03;
    else score -= 0.12;

    var letters = /[A-Z]/.test(word);
    var digits = /\d/.test(word);
    if (letters && digits) score += 0.09;
    else if (letters) score += 0.02;
    else if (word.length <= 5) return 0;                 // 2–5 digit number: order id / OTP
    else score -= 0.30;                                  // digits-only: price/phone

    if (ctx.hadSpaces) score -= 0.07;
    if (tok.corrected) score -= 0.06;
    if (ctx.labelSame == null && ctx.labelBelow == null) {
      score = Math.min(score, 0.78);
      // No label anywhere and no digits at all ("FASHION", "SHIPPED") — that
      // is offer copy, not a code. Cap below the fill line: at most it can
      // surface as a low-confidence candidate for manual confirmation.
      if (!digits) score = Math.min(score, 0.45);
    }
    if (tok.corrected) score = Math.min(score, 0.82);

    return Math.min(score, 0.97);
  }

  function addCandidate(map, raw, base, ctx) {
    var rawStr = String(raw == null ? '' : raw).trim();
    if (!rawStr) return;
    // Tesseract words never contain spaces; a spaced raw is only legitimate
    // when the label logic deliberately joined adjacent short words. Anything
    // else (e.g. a whole line reaching the sweep) must not become one token.
    if (/\s/.test(rawStr) && !ctx.joined) return;
    var hadSpaces = /\s/.test(rawStr);
    var token = stripEdges(rawStr);
    if (!token) return;
    var upper = token.toUpperCase().replace(/\s+/g, '');
    if (!CODE_SHAPE.test(upper)) return;

    var variants = [{ value: upper, corrected: false }];
    var fixed = ocrFixVariant(upper);
    var hasFix = !!(fixed && CODE_SHAPE.test(fixed));
    if (hasFix) variants.push({ value: fixed, corrected: true });

    // Score every variant once, then apply the ordering rule: when a repair
    // variant is viable, the raw misread can never outrank it (the repaired
    // form IS what the spec wants surfaced; the raw one stays as a fallback
    // candidate below it, never silently dropped).
    var scores = variants.map(function (v) {
      return { v: v, score: scoreCodeCandidate(v, base, ctx) };
    });
    if (hasFix) {
      var bestFix = 0;
      scores.forEach(function (s) { if (s.v.corrected && s.score > bestFix) bestFix = s.score; });
      if (bestFix > 0) {
        scores.forEach(function (s) {
          if (!s.v.corrected) s.score = Math.min(s.score, Math.max(0, bestFix - 0.08));
        });
      }
    }

    scores.forEach(function (s) {
      if (s.score <= 0) return;
      var key = s.v.value;
      var prev = map.get(key);
      var entry = {
        value: s.v.value,
        corrected: s.v.corrected,
        confidence: round2(s.score),
        base: round2(clamp01(base)),
        order: map.size,
      };
      if (!prev || s.score > prev.confidence) map.set(key, entry);
    });
  }

  function wordBoxes(line) {
    if (line.words && line.words.length) return line.words;
    // Fallback: synthesize evenly spaced pseudo-words so the label logic still
    // works when Tesseract gives line text only.
    var parts = line.text.trim().split(/\s+/).filter(Boolean);
    var w = line.bbox ? (line.bbox.x1 - line.bbox.x0) / Math.max(parts.length, 1) : 0;
    return parts.map(function (p, i) {
      return {
        text: p,
        confidence: line.confidence,
        bbox: line.bbox ? { x0: line.bbox.x0 + i * w, x1: line.bbox.x0 + (i + 1) * w, y0: line.bbox.y0, y1: line.bbox.y1 } : null,
      };
    });
  }

  function bboxOverlapX(a, b) {
    if (!a || !b) return true;   // unknown geometry → allow
    return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0;
  }

  /**
   * Find the best coupon code in the OCR lines. Returns
   * { value, confidence, corrected } | null. Pure — unit-tested.
   */
  function detectCouponCode(lines) {
    var map = new Map();

    lines.forEach(function (line, idx) {
      var words = wordBoxes(line);
      var lineH = line.bbox ? line.bbox.y1 - line.bbox.y0 : 20;

      // Label words in this line → same-line candidates after the label,
      // plus below-label candidates on the next few lines.
      words.forEach(function (w, wi) {
        var bare = stripEdges(w.text);
        if (!LABEL_WORD.test(bare)) return;

        // same line, to the right of the label
        for (var j = wi + 1; j < words.length; j++) {
          var nxt = stripEdges(words[j].text);
          if (!nxt) continue;
          if (LABEL_WORD.test(nxt) || FILLER_WORD.test(nxt)) continue;
          var wConf = (Number(words[j].confidence) || 0) / 100;
          var w2 = (Number(w.confidence) || 0) / 100;
          addCandidate(map, nxt, wConf, { labelSame: true, labelBelow: null, hadSpaces: false, labelConf: w2 });
          // A labelled token joined from two short words: "SAVE 50ABC".
          if (j + 1 < words.length) {
            var joined = nxt + stripEdges(words[j + 1].text).toUpperCase();
            if (joined.length >= 4 && joined.length <= 40) {
              addCandidate(map, joined, wConf, { labelSame: true, labelBelow: null, hadSpaces: true, labelConf: w2, joined: true });
            }
          }
          break;
        }

        // up to three lines below the label
        for (var d = 1; d <= 3 && idx + d < lines.length; d++) {
          var below = lines[idx + d];
          var belowH = below.bbox ? below.bbox.y1 - below.bbox.y0 : lineH;
          var gapOk = !line.bbox || !below.bbox ||
            (below.bbox.y0 - line.bbox.y1) < Math.max(lineH, belowH) * 2.5;
          if (!gapOk) break;
          var bWords = wordBoxes(below);
          for (var b = 0; b < bWords.length; b++) {
            var bw = stripEdges(bWords[b].text);
            if (!bw || LABEL_WORD.test(bw) || FILLER_WORD.test(bw)) continue;
            var bConf = (Number(bWords[b].confidence) || 0) / 100;
            var horizOk = bboxOverlapX(w.bbox, bWords[b].bbox);
            if (horizOk || d === 1) {
              addCandidate(map, bw, bConf, { labelSame: null, labelBelow: true, hadSpaces: false, labelConf: (Number(w.confidence) || 0) / 100 });
            }
          }
        }
      });

      // Global sweep: any code-shaped word is a (weaker) candidate.
      words.forEach(function (w) {
        var bare = stripEdges(w.text);
        if (!bare || LABEL_WORD.test(bare) || FILLER_WORD.test(bare)) return;
        var conf = (Number(w.confidence) || 0) / 100;
        addCandidate(map, bare, conf, { labelSame: null, labelBelow: null, hadSpaces: false });
      });
    });

    var best = null;
    map.forEach(function (entry) {
      if (!best || entry.confidence > best.confidence ||
        (entry.confidence === best.confidence && entry.order < best.order)) best = entry;
    });
    return best ? { value: best.value, confidence: best.confidence, base: best.base, corrected: best.corrected } : null;
  }

  /* ── Other fields (pure, deliberately conservative) ───────────────────── */

  var MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };

  /** Normalize one date string to YYYY-MM-DD or null. Never invents a year.
      Same rules the old server applied (cleanDate). */
  function cleanDate(v) {
    var s = String(v || '').trim();
    if (!s) return null;
    var y, m, d, match;

    match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) { y = match[1]; m = match[2]; d = match[3]; }

    if (!match) {
      match = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
      if (match) { d = match[1]; m = match[2]; y = match[3]; }
    }
    if (!match) {
      match = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
      if (match) { d = match[1]; m = MONTHS[match[2].slice(0, 4).toLowerCase()] || MONTHS[match[2].slice(0, 3).toLowerCase()]; y = match[3]; }
    }
    if (!match) {
      match = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
      if (match) { m = MONTHS[match[1].slice(0, 4).toLowerCase()] || MONTHS[match[1].slice(0, 3).toLowerCase()]; d = match[2]; y = match[3]; }
    }
    if (!match || !y || !m || !d) return null;

    var yy = Number(y), mm = Number(m), dd = Number(d);
    if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
    if (yy < 2000 || yy > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

    var iso = yy + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
    var probe = new Date(iso + 'T00:00:00Z');
    if (Number.isNaN(probe.getTime()) || probe.getUTCDate() !== dd || probe.getUTCMonth() + 1 !== mm) return null;
    return iso;
  }

  function cleanAmount(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return null;
    var digits = s.replace(/[₹,\s]/g, '').replace(/\.\d+$/, '');
    if (!/^\d{1,7}$/.test(digits)) return null;
    var n = Number(digits);
    if (!Number.isFinite(n) || n < 0 || n > 9999999) return null;
    return String(n);
  }

  function cleanTime(v) {
    var s = String(v || '').trim().toLowerCase();
    if (!s) return null;
    var match = s.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/);
    if (!match) {
      match = s.match(/^(\d{1,2})\s*(am|pm)$/);
      if (match) match = [match[0], match[1], '00', match[2]];
    }
    if (!match) return null;
    var hour = Number(match[1]);
    var minute = Number(match[2]);
    var suffix = String(match[3] || '').replace(/\./g, '');
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null;
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    if (hour > 23) return null;
    return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
  }

  var DATE_RE = /(\d{4}-\d{1,2}-\d{1,2})|(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4})|(\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4})|([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/;
  var EXPIRY_CONTEXT = /valid|until|till|expir|through|use\s*by|ends?\b|onwards/i;
  var TIME_RE = /(\d{1,2}[:.]\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))/i;
  var MOV_RE = /(?:on\s+orders?\s+(?:above|over|of)|min(?:imum)?\s*(?:order|spend|purchase|amount|value)?\s*(?:of|is)?)[^₹\d\n]{0,14}(?:₹|rs\.?|inr)?\s*(\d[\d,]{0,7})/i;
  var FACE_RE = /(?:up\s*to|max(?:imum)?(?:\s+discount|\s+saving)?|worth)[^₹\d\n]{0,14}(?:₹|rs\.?|inr)?\s*(\d[\d,]{0,7})/i;

  function field(value, confidence) {
    return { value: value, confidence: round2(confidence), verify: confidence < VERIFY_BELOW };
  }

  function detectDiscount(lines) {
    var best = null;
    lines.forEach(function (line) {
      var text = line.text.replace(/\s+/g, ' ');
      var conf = line.words && line.words.length
        ? line.words.reduce(function (s, w) { return s + (Number(w.confidence) || 0); }, 0) / line.words.length / 100
        : (Number(line.confidence) || 0) / 100;

      var m = text.match(/(\d{1,3})\s*%/i);
      if (m && /off|discount|save|flat|up\s*to/i.test(text)) {
        var v = scrub(m[1] + '% OFF', MAX_LEN.discount_value);
        var c = clamp01(conf * 0.85);
        if (!best || c > best.confidence) best = field(v, c);
        return;
      }
      m = text.match(/(?:₹|rs\.?|inr)\s*(\d[\d,]{0,7})\s*(?:off|discount)/i);
      if (m) {
        var v2 = scrub('₹' + m[1] + ' OFF', MAX_LEN.discount_value);
        var c2 = clamp01(conf * 0.85);
        if (!best || c2 > best.confidence) best = field(v2, c2);
        return;
      }
      m = text.match(/\bbuy\s*(\d{1,2})\s*get\s*(\d{1,2})\b/i);
      if (m) {
        var v3 = scrub('Buy ' + m[1] + ' Get ' + m[2], MAX_LEN.discount_value);
        var c3 = clamp01(conf * 0.8);
        if (!best || c3 > best.confidence) best = field(v3, c3);
      }
    });
    return best && best.confidence >= FIELD_FILL_MIN ? best : null;
  }

  function detectType(fullText, hasDiscount) {
    if (/\bcash\s?back\b|\bcashback\b/i.test(fullText)) return field('Cashback', 0.8);
    if (/\bbuy\s*\d{0,2}\s*get\b|\bbogo\b/i.test(fullText)) return field('BOGO', 0.8);
    if (/\bfree\s+delivery\b/i.test(fullText)) return field('Free Delivery', 0.8);
    if (hasDiscount) return field('Discount', 0.55);
    return null;
  }

  function detectExpiry(lines) {
    var best = null;
    var bestIdx = -1;
    lines.forEach(function (line, idx) {
      var m = line.text.match(DATE_RE);
      if (!m) return;
      var iso = cleanDate(m[0]);
      if (!iso) return;
      var conf = line.words && line.words.length
        ? line.words.reduce(function (s, w) { return s + (Number(w.confidence) || 0); }, 0) / line.words.length / 100
        : (Number(line.confidence) || 0) / 100;
      var labelled = EXPIRY_CONTEXT.test(line.text) || (idx > 0 && EXPIRY_CONTEXT.test(lines[idx - 1].text));
      var c = clamp01(conf * (labelled ? 0.85 : 0.6));
      if (!best || c > best.confidence) { best = field(iso, c); bestIdx = idx; }
    });
    if (!best || best.confidence < FIELD_FILL_MIN) return { date: null, time: null };

    // Time only when a date was found (same rule the old server enforced).
    var time = null;
    for (var d = -1; d <= 1 && !time; d++) {
      var line = lines[bestIdx + d];
      if (!line) continue;
      var m2 = line.text.match(TIME_RE);
      if (m2) {
        var t = cleanTime(m2[1]);
        if (t) time = field(t, 0.7);
      }
    }
    return { date: best, time: time };
  }

  function detectAmount(fullText, re) {
    var m = fullText.match(re);
    if (!m) return null;
    var digits = cleanAmount(m[1]);
    if (!digits) return null;
    return field(digits, re === MOV_RE ? 0.75 : 0.6);
  }

  /**
   * The parser. Takes normalized OCR lines, returns
   * { fields, candidate, quality } — `fields` uses the same shape and key
   * names the old /api/coupons/scan endpoint returned, so the existing
   * auto-fill consumes it unchanged.
   * Pure — unit-tested.
   */
  function parseCouponData(lines) {
    var fullText = lines.map(function (l) { return l.text; }).join('\n')
      .replace(/[\u0000-\u001F]/g, ' ');
    var fields = {};
    var quality = {
      lineCount: lines.length,
      meanWordConf: round2(meanLineConf(lines)),
      codeFound: false,
    };

    var code = detectCouponCode(lines);
    if (code && code.confidence >= CODE_FILL_MIN && code.base >= 0.55) {
      fields.coupon_code = field(code.value, code.confidence);
      quality.codeFound = true;
    }
    var candidate = code && !fields.coupon_code
      && code.confidence >= CODE_CANDIDATE_MIN && code.base >= 0.35
      ? { value: code.value, confidence: code.confidence }
      : null;

    // Brand / title / category / T&C are intentionally NOT extracted: OCR
    // cannot tell a store name from a tagline reliably, and the spec forbids
    // inventing values. Those fields stay untouched in the form.
    var disc = detectDiscount(lines);
    if (disc) fields.discount_value = disc;

    var type = detectType(fullText, !!disc);
    if (type) fields.coupon_type = type;

    var exp = detectExpiry(lines);
    if (exp.date) fields.expiry_date = exp.date;
    if (exp.date && exp.time) fields.expiry_time = exp.time;

    var mov = detectAmount(fullText, MOV_RE);
    if (mov && mov.confidence >= FIELD_FILL_MIN) fields.minimum_order_value = mov;

    var face = detectAmount(fullText, FACE_RE);
    if (face && face.confidence >= FIELD_FILL_MIN) fields.original_value_or_max_discount = face;

    return { fields: fields, candidate: candidate, quality: quality };
  }

  /* ── The browser pipeline ─────────────────────────────────────────────── */

  var busy = false;

  /**
   * Read a coupon image and extract the fields OCR can actually see.
   * @param {HTMLImageElement|Canvas} img decoded image (runAiScan already
   *        validated type/size/resolution/brightness/blur before calling).
   * @param {{onProgress?:function(number,string)}} opts
   * @returns {Promise<{fields:object, candidate:object|null, quality:object}>}
   *          Resolves with possibly-empty `fields`. Throws Error with
   *          .code = 'busy' | 'engine_load_failed' | 'engine_init_failed'
   *          | 'ocr_unreadable'.
   */
  async function extract(img, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    if (busy) {
      var busyErr = new Error('An OCR job is already running.');
      busyErr.code = 'busy';
      throw busyErr;
    }
    busy = true;
    try {
      onProgress(0.02, 'Loading the OCR engine (first scan only)…');
      var engine = await getEngine(onProgress);

      onProgress(0.42, 'Preparing the image for reading…');
      var srcW = img.naturalWidth || img.width;
      var srcH = img.naturalHeight || img.height;
      var canvas = prepareCanvas(img, srcW, srcH);

      onProgress(0.5, 'Reading the coupon text…');
      var results = await engine.predict(canvas);
      var parsed = parseCouponData(normalizePaddleItems(results && results[0] && results[0].items));

      // Second chance: nothing readable at all → try the 90°-rotated image
      // once before giving up (phone photos are often sideways).
      if (!Object.keys(parsed.fields).length && !parsed.candidate) {
        onProgress(0.75, 'Trying another orientation…');
        var rot = rotatedCanvas(img, srcW, srcH);
        var results2 = await engine.predict(rot);
        var parsed2 = parseCouponData(normalizePaddleItems(results2 && results2[0] && results2[0].items));
        if (Object.keys(parsed2.fields).length || parsed2.candidate) parsed = parsed2;
      }

      if (!Object.keys(parsed.fields).length && !parsed.candidate) {
        // Garbage OCR overall = "difficult to read"; clean-but-irrelevant text
        // = a normal "no coupon found" result for the caller to message.
        if ((parsed.quality.meanWordConf || 0) < 0.45) {
          var err = new Error('The OCR output was too noisy to read.');
          err.code = 'ocr_unreadable';
          throw err;
        }
      }

      onProgress(1, 'Done.');
      return parsed;
    } finally {
      busy = false;
    }
  }

  var api = { extract: extract, dispose: dispose, parseCouponData: parseCouponData, ocrTargetSize: ocrTargetSize, normalizePaddleItems: normalizePaddleItems };

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', dispose);
    window.CouponOCR = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
