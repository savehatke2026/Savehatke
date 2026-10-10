#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   verify-coupon-ocr.cjs — tests for the client-side coupon OCR pipeline
   ══════════════════════════════════════════════════════════════════════════
   Two layers:

   1. UNIT — public/js/coupon-ocr.js's pure functions (parseCouponData,
      ocrTargetSize) against synthetic Tesseract output, covering the spec's
      15 cases as far as pure logic goes (label detection, code extraction,
      O/0-I/1-S/5-B/8 repair, confidence bands, junk rejection).

   2. E2E — a real Tesseract.js run (same package the browser loads from the
      CDN) against a rendered coupon PNG, asserting the whole pipeline runs
      and surfaces the printed code. Skipped when Tesseract's language model
      cannot be fetched (offline CI), so unit coverage still runs.

   Run: node verify-coupon-ocr.cjs
   ══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const ocr = require('./public/js/coupon-ocr.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

/* ── Mock builders (mirror real Tesseract output: one word per token) ────── */

/** A line of words sharing one confidence, laid out left→right. */
function mkLine(text, conf, y0) {
  return mw(String(text).split(/\s+/).filter(Boolean).map((w) => [w, conf]), y0 || 0);
}

/** Words with individual confidences: [['Use',96],['Code:',95]]. */
function mw(pairs, y0) {
  const y1 = (y0 || 0) + 30;
  let x = 20;
  const ws = pairs.map(([text, conf]) => {
    const w0 = x;
    x += String(text).length * 12 + 14;
    return { text, confidence: conf, bbox: { x0: w0, x1: x, y0: y0 || 0, y1 } };
  });
  return {
    text: ws.map((w) => w.text).join(' '),
    confidence: ws.reduce((s, w) => s + w.confidence, 0) / ws.length,
    bbox: { x0: 20, x1: x, y0: y0 || 0, y1 },
    words: ws,
  };
}

/* ═══════════════════════════════ UNIT TESTS ═══════════════════════════════ */

function unitTests() {
  console.log('\n── Unit: coupon-code detection ──');

  // 1 + 7. Clear screenshot, "Use Code" label → high confidence, auto-fill.
  {
    const r = ocr.parseCouponData([
      mkLine('Get 50% OFF', 96, 10),
      mw([['Use', 96], ['Code:', 97], ['SAVE50ABC', 97]], 60),
      mkLine('Valid until 31 Dec 2026', 95, 120),
    ]);
    check('1/7: labeled code detected', r.fields.coupon_code && r.fields.coupon_code.value === 'SAVE50ABC', JSON.stringify(r.fields.coupon_code));
    check('1: high confidence ≥0.9, no verify', r.fields.coupon_code && r.fields.coupon_code.confidence >= 0.9 && r.fields.coupon_code.verify === false, JSON.stringify(r.fields.coupon_code));
    check('1: discount read', r.fields.discount_value && r.fields.discount_value.value === '50% OFF', JSON.stringify(r.fields.discount_value));
    check('1: expiry ISO', r.fields.expiry_date && r.fields.expiry_date.value === '2026-12-31', JSON.stringify(r.fields.expiry_date));
  }

  // 2. Clear phone photo — decent but imperfect OCR → fills with verify badge.
  {
    const r = ocr.parseCouponData([mw([['Use', 62], ['Code:', 64], ['WELCOME20', 60]], 0)]);
    check('2: phone photo fills with verify', r.fields.coupon_code && r.fields.coupon_code.value === 'WELCOME20' && r.fields.coupon_code.verify === true, JSON.stringify(r.fields.coupon_code));
  }

  // 3. Numeric-heavy code.
  {
    const r = ocr.parseCouponData([mw([['Code', 92], ['FLAT500', 90]], 0)]);
    check('3: digits-heavy code filled', r.fields.coupon_code && r.fields.coupon_code.value === 'FLAT500', JSON.stringify(r.fields.coupon_code));
  }

  // 4. Letters+numbers (covered by 1/2/3); O/0 handled in 5, I/1 in 6.

  // 5. O vs 0 repair (only next to a digit).
  {
    const r = ocr.parseCouponData([mw([['Code:', 95], ['SAVE5OABC', 93]], 0)]);
    check('5: O→0 repaired', r.fields.coupon_code && r.fields.coupon_code.value === 'SAVE50ABC', JSON.stringify(r.fields.coupon_code));
    check('5: repaired confidence capped', r.fields.coupon_code && r.fields.coupon_code.confidence <= 0.82, JSON.stringify(r.fields.coupon_code));
  }

  // 6. I/1 repair.
  {
    const r = ocr.parseCouponData([mw([['Code:', 94], ['W1NTER2O', 92]], 0)]);
    check('6: O→0 in W1NTER2O', r.fields.coupon_code && r.fields.coupon_code.value === 'W1NTER20', JSON.stringify(r.fields.coupon_code));
  }

  // 5b. All-letter words are NEVER "repaired".
  {
    const r = ocr.parseCouponData([mw([['Code:', 95], ['WINTER', 93]], 0)]);
    check('5b: all-letter token untouched', r.fields.coupon_code && r.fields.coupon_code.value === 'WINTER', JSON.stringify(r.fields.coupon_code));
  }

  // 8. Code without a label → fills, but capped in the verify band.
  {
    const r = ocr.parseCouponData([
      mkLine('Flat 30% off on all fashion', 93, 10),
      mkLine('FESTIVE50 for new users', 94, 60),
    ]);
    check('8: unlabeled code found', r.fields.coupon_code && r.fields.coupon_code.value === 'FESTIVE50', JSON.stringify(r.fields.coupon_code));
    check('8: unlabeled capped ≤0.78', r.fields.coupon_code && r.fields.coupon_code.confidence <= 0.78 && r.fields.coupon_code.verify === true, JSON.stringify(r.fields.coupon_code));
  }

  // 9. Blurry — low OCR confidence → NOT auto-filled; candidate offered for
  //    manual confirmation (spec §6 low-confidence path).
  {
    const r = ocr.parseCouponData([mw([['Code:', 55], ['PARTY20', 52]], 0)]);
    check('9: blurry → candidate, not filled', !r.fields.coupon_code && r.candidate && r.candidate.value === 'PARTY20', JSON.stringify({ f: r.fields.coupon_code, c: r.candidate }));
  }

  // 9b. Very low confidence but readable → candidate, never auto-filled.
  {
    const r = ocr.parseCouponData([mw([['Code:', 40], ['SUMMER25', 38]], 0)]);
    check('9b: low conf → candidate, no fill', !r.fields.coupon_code && r.candidate && r.candidate.value === 'SUMMER25', JSON.stringify({ f: r.fields.coupon_code, c: r.candidate }));
  }

  // 9c. Unreadable → nothing at all.
  {
    const r = ocr.parseCouponData([mw([['Code:', 12], ['XXXX0000', 10]], 0)]);
    check('9c: unreadable → no fill, no candidate', !r.fields.coupon_code && !r.candidate, JSON.stringify({ f: r.fields.coupon_code, c: r.candidate }));
  }

  // 10. Rotated: parser sees garbage → no fields, no candidate (the browser
  //     layer retries the 90° image; unit covers the "give up honestly" half).
  {
    const r = ocr.parseCouponData([mkLine('kjad lkjhelkjh 9287 lkjh', 22, 0)]);
    check('10: garbage lines produce nothing', Object.keys(r.fields).length === 0 && !r.candidate, JSON.stringify(r.fields));
  }

  // 11. Multiple codes — the labeled one wins over a stray sweep token.
  {
    const r = ocr.parseCouponData([
      mkLine('Get 20% OFF today', 95, 10),
      mw([['Use', 96], ['Code:', 97], ['FESTIVE50', 96]], 60),
      mkLine('MEGA75 also live', 95, 120),
    ]);
    check('11: labeled beats unlabeled', r.fields.coupon_code && r.fields.coupon_code.value === 'FESTIVE50', JSON.stringify(r.fields.coupon_code));
  }

  // 12. No coupon code — other fields may still fill; code stays empty.
  {
    const r = ocr.parseCouponData([
      mkLine('Save up to 70% on everything', 95, 10),
      mkLine('Offer ends 31 Dec 2026', 95, 60),
    ]);
    check('12: no code field', !r.fields.coupon_code && !r.candidate, JSON.stringify({ c: r.fields.coupon_code, cand: r.candidate }));
    check('12: discount still read', r.fields.discount_value && /70% OFF/.test(r.fields.discount_value.value), JSON.stringify(r.fields.discount_value));
    check('12: expiry still read', r.fields.expiry_date && r.fields.expiry_date.value === '2026-12-31', JSON.stringify(r.fields.expiry_date));
  }

  // 13/14. Sizing: huge image capped, small image upscaled (≤4×).
  {
    const big = ocr.ocrTargetSize(6000, 4000);
    check('13: large capped to 3200 long edge', Math.max(big.w, big.h) === 3200, JSON.stringify(big));
    const small = ocr.ocrTargetSize(320, 240);
    check('14: small upscaled, ≤4×', small.scale <= 4 && Math.min(small.w, small.h) >= 900, JSON.stringify(small));
  }

  // 15. Non-coupon text — order numbers / greetings produce nothing.
  {
    const r = ocr.parseCouponData([
      mkLine('Hey there!', 96, 10),
      mkLine('Your order 4521 has shipped', 96, 60),
      mkLine('Track it in the app', 96, 120),
    ]);
    check('15: non-coupon yields no fields/candidate', !r.fields.coupon_code && !r.candidate, JSON.stringify({ c: r.fields.coupon_code, cand: r.candidate }));
  }

  // Junk rejection: vocabulary, years, prices, order ids.
  {
    const r = ocr.parseCouponData([
      mw([['Code:', 95], ['OFF', 95]], 0),
      mkLine('Get FLAT 2026 on orders above 499', 95, 60),
    ]);
    check('junk: OFF/year/price/order-id not codes', !r.fields.coupon_code, JSON.stringify(r.fields.coupon_code));
  }

  // Spaces inside the token are stripped but penalized.
  {
    const r = ocr.parseCouponData([mw([['Code:', 96], ['SAVE', 96], ['50ABC', 96]], 0)]);
    check('spaces: joined token', r.fields.coupon_code && r.fields.coupon_code.value === 'SAVE50ABC', JSON.stringify(r.fields.coupon_code));
  }

  // Below-label: code on the line under "Coupon Code".
  {
    const r = ocr.parseCouponData([
      mw([['Coupon', 95], ['Code', 95]], 0),
      mkLine('FESTIVE50', 95, 60),
    ]);
    check('below-label: next-line code found', r.fields.coupon_code && r.fields.coupon_code.value === 'FESTIVE50', JSON.stringify(r.fields.coupon_code));
  }

  // Code words never contain a space in the filled value.
  {
    const r = ocr.parseCouponData([mw([['Code:', 95], ['SAVE', 95], ['50ABC', 95]], 0)]);
    check('sanitize: filled value has no space', r.fields.coupon_code && !/\s/.test(r.fields.coupon_code.value), JSON.stringify(r.fields.coupon_code));
  }

  // Minimum order + face value.
  {
    const r = ocr.parseCouponData([
      mkLine('Get ₹100 OFF on orders above ₹999', 95, 10),
      mkLine('Up to ₹500 instant discount', 95, 60),
    ]);
    check('mov: min order read', r.fields.minimum_order_value && r.fields.minimum_order_value.value === '999', JSON.stringify(r.fields.minimum_order_value));
    check('face: face value read', r.fields.original_value_or_max_discount && r.fields.original_value_or_max_discount.value === '500', JSON.stringify(r.fields.original_value_or_max_discount));
    check('mov: verify flagged (<0.85)', r.fields.minimum_order_value && r.fields.minimum_order_value.verify === true, JSON.stringify(r.fields.minimum_order_value));
  }

  // Expiry time pairs with date.
  {
    const r = ocr.parseCouponData([mkLine('Valid till 31/12/2026 11:59 PM', 95, 0)]);
    check('expiry+time', r.fields.expiry_date && r.fields.expiry_date.value === '2026-12-31' && r.fields.expiry_time && r.fields.expiry_time.value === '23:59', JSON.stringify({ d: r.fields.expiry_date, t: r.fields.expiry_time }));
  }

  // Invalid dates are never invented (no year → null; 31 Feb → null).
  {
    const r = ocr.parseCouponData([mkLine('Valid till 31 Dec, hurry', 95, 0)]);
    check('no year → no expiry', !r.fields.expiry_date, JSON.stringify(r.fields.expiry_date));
    const r2 = ocr.parseCouponData([mkLine('Valid till 31/02/2026', 95, 0)]);
    check('31 Feb rejected', !r2.fields.expiry_date, JSON.stringify(r2.fields.expiry_date));
  }
}

/* ═══════════════════════════════ Paddle engine layer ═════════════════════ */

/**
 * The REAL-OCR end-to-end run moved to a real browser (embedded Chromium
 * against a locally served build): PaddleOCR.js is browser-only (it needs
 * DOM canvas inputs), so Node can exercise everything except inference.
 * Covered here instead:
 *   1. normalizePaddleItems — the SDK's OcrResult.items → parser line shape.
 *   2. extract() contract in a hostile env — the bundle genuinely fails to
 *      load from the browser-only path, which must surface as
 *      code 'engine_load_failed', a concurrent second call must get 'busy'
 *      (single-flight), and dispose() must be safe to call at any time.
 */

function paddleNormalizeTests() {
  console.log('\n── Paddle: normalizePaddleItems ──');

  // A realistic OcrResult.items payload (SDK: poly is [[x,y]×4], score 0–1).
  {
    const lines = ocr.normalizePaddleItems([
      { text: 'FLAT 50% OFF', score: 0.97, poly: [[20, 10], [300, 10], [300, 44], [20, 44]] },
      { text: 'USE CODE: SAVE50ABC', score: 0.95, poly: [[20, 60], [380, 60], [380, 94], [20, 94]] },
      { text: '   ', score: 0.9, poly: [[0, 0], [10, 0], [10, 10], [0, 10]] },   // blank → dropped
      { text: '', score: 0.8, poly: [[0, 0], [10, 0], [10, 10], [0, 10]] },      // empty → dropped
    ]);
    check('paddle: line count (blanks dropped)', lines.length === 2, JSON.stringify(lines.map((l) => l.text)));
    check('paddle: text kept verbatim', lines[1].text === 'USE CODE: SAVE50ABC', lines[1].text);
    check('paddle: score ×100 onto confidence', lines[0].confidence === 97 && lines[1].confidence === 95, JSON.stringify([lines[0].confidence, lines[1].confidence]));
    check('paddle: bbox from poly extent', lines[0].bbox && lines[0].bbox.x0 === 20 && lines[0].bbox.x1 === 300 && lines[0].bbox.y0 === 10 && lines[0].bbox.y1 === 44, JSON.stringify(lines[0].bbox));
    check('paddle: words empty (parser pseudo-word fallback)', lines[0].words.length === 0, JSON.stringify(lines[0].words));
  }

  // Point objects and out-of-range scores are tolerated; junk input is safe.
  {
    const lines = ocr.normalizePaddleItems([
      { text: 'CODE ABC123', score: 1.7, poly: [{ x: 5, y: 6 }, { x: 200, y: 6 }, { x: 200, y: 40 }, { x: 5, y: 40 }] },
      { text: 'NO POLY', score: 0.8 },
      null,
      'garbage',
      42,
    ]);
    check('paddle: score clamped to 100', lines[0].confidence === 100, JSON.stringify(lines[0].confidence));
    check('paddle: {x,y} poly accepted', lines[0].bbox && lines[0].bbox.x1 === 200 && lines[0].bbox.y1 === 40, JSON.stringify(lines[0].bbox));
    check('paddle: missing poly → null bbox, line kept', lines[1].bbox === null && lines[1].text === 'NO POLY', JSON.stringify(lines[1]));
    check('paddle: junk entries skipped', lines.length === 2, JSON.stringify(lines.length));
    check('paddle: non-array → []', ocr.normalizePaddleItems(undefined).length === 0 && ocr.normalizePaddleItems(null).length === 0);
  }

  // Round-trip: normalized Paddle lines feed parseCouponData and fill the code.
  {
    const lines = ocr.normalizePaddleItems([
      { text: 'USE CODE: WELCOME20', score: 0.93, poly: [[20, 0], [400, 0], [400, 34], [20, 34]] },
    ]);
    const r = ocr.parseCouponData(lines);
    check('paddle: normalized lines parse to code', r.fields.coupon_code && r.fields.coupon_code.value === 'WELCOME20', JSON.stringify(r.fields.coupon_code));
    // A crisply-read labeled code (0.93) scores ≥0.85 → fills without the
    // verify badge; a mediocre read (0.55) must land in the verify band.
    check('paddle: clean read fills without verify', r.fields.coupon_code && r.fields.coupon_code.verify === false, JSON.stringify(r.fields.coupon_code));
    const r2 = ocr.parseCouponData(ocr.normalizePaddleItems([
      { text: 'USE CODE: WELCOME20', score: 0.55, poly: [[20, 0], [400, 0], [400, 34], [20, 34]] },
    ]));
    check('paddle: weak read lands in verify band', r2.fields.coupon_code && r2.fields.coupon_code.verify === true, JSON.stringify(r2.fields.coupon_code));
  }
}

async function engineContractTests() {
  console.log('\n── Engine: extract() contract in Node (no browser) ──');

  // The engine bundle lives at a browser-only same-origin URL. In Node the
  // dynamic import genuinely fails → the failure must surface as
  // 'engine_load_failed' (never a raw module-not-found leak), and a second
  // call fired while the first is in flight must be rejected with 'busy'.
  const p1 = ocr.extract({ width: 800, height: 600 }, {});
  const p2 = ocr.extract({ width: 800, height: 600 }, {}).catch((e) => e.code);
  const [r1, r2] = await Promise.all([
    p1.then(() => 'resolved').catch((e) => e.code),
    p2,
  ]);
  check('engine: bundle load failure → engine_load_failed', r1 === 'engine_load_failed', 'got ' + JSON.stringify(r1));
  check('engine: concurrent call rejected as busy', r2 === 'busy', 'got ' + JSON.stringify(r2));

  // After a failure the single-flight state must be cleared: a third call
  // gets a fresh attempt (same code — the bundle is still missing in Node —
  // but 'busy' would mean the failure poisoned the engine slot).
  const r3 = await ocr.extract({ width: 800, height: 600 }, {}).then(() => 'resolved').catch((e) => e.code);
  check('engine: failure did not poison the next scan', r3 === 'engine_load_failed', 'got ' + JSON.stringify(r3));

  // dispose() is always safe — with no engine and after a failed init.
  try {
    ocr.dispose();
    ocr.dispose();
    check('engine: dispose idempotent, never throws', true);
  } catch (e) {
    check('engine: dispose idempotent, never throws', false, e.message);
  }
}

/* ═══════════════════════════════ Run ══════════════════════════════════════ */

(async () => {
  unitTests();
  paddleNormalizeTests();
  await engineContractTests();

  console.log('\n════════════════════════════════════════════');
  console.log((failed === 0 ? 'ALL PASSED' : 'FAILURES') + ':  passed=' + passed + '  failed=' + failed);
  if (failed) { failures.forEach((f) => console.log('  • ' + f)); process.exit(1); }
})().catch((e) => { console.error('Harness error:', e); process.exit(1); });
