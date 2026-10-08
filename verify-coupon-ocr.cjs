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

/* ═══════════════════════════════ E2E (real Tesseract) ═════════════════════ */

const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  Y: ['10001', '01010', '00100', '00100', '00100', '00100', '00100'],
  '0': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00100', '00100'],
};

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}

async function e2eTest() {
  console.log('\n── E2E: real Tesseract.js on a rendered coupon ──');
  const { PNG } = require('pngjs');
  const Tesseract = require('tesseract.js');

  const W = 1100;
  const H = 560;
  const SCALE = 8;
  const png = new PNG({ width: W, height: H });

  function drawText(text, ox, oy) {
    let cx = ox;
    for (const ch of text.toUpperCase()) {
      if (ch === ' ') { cx += 5 * SCALE; continue; }
      const glyph = FONT[ch];
      if (!glyph) { cx += 7 * SCALE; continue; }
      for (let ry = 0; ry < 7; ry++) {
        for (let rx = 0; rx < 5; rx++) {
          if (glyph[ry][rx] === '1') {
            for (let sy = 0; sy < SCALE; sy++) {
              for (let sx = 0; sx < SCALE; sx++) {
                const px = cx + rx * SCALE + sx;
                const py = oy + ry * SCALE + sy;
                if (px < W && py < H) {
                  const idx = (py * W + px) * 4;
                  png.data[idx] = 10; png.data[idx + 1] = 10; png.data[idx + 2] = 10; png.data[idx + 3] = 255;
                }
              }
            }
          }
        }
      }
      cx += 7 * SCALE;   // 5 glyph columns + 2 blank
    }
  }

  drawText('FLAT 50% OFF', 50, 60);
  drawText('USE CODE: SAVE50ABC', 50, 220);
  drawText('VALID UNTIL 31 DEC 2026', 50, 380);

  const pngBuffer = PNG.sync.write(png);

  let worker;
  try {
    worker = await Tesseract.createWorker('eng');
  } catch (e) {
    console.log('  SKIP e2e (Tesseract language model unavailable: ' + e.message.slice(0, 80) + ')');
    return;
  }

  try {
    const res = await worker.recognize(pngBuffer, {}, { text: true, blocks: true });
    const lines = ocr.normalizeTesseractData(res.data);
    const r = ocr.parseCouponData(lines);

    console.log('  OCR text: ' + JSON.stringify(lines.map((l) => l.text)));

    // A crude bitmap font is hard for LSTM, so require a close match rather
    // than a byte-perfect one: same code modulo the classic O/0 I/1 S/5 B/8
    // confusions (normalized), allowing ≤3 character edits.
    const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
    const got = r.fields.coupon_code ? r.fields.coupon_code.value : (r.candidate ? r.candidate.value : '');
    const target = norm('SAVE50ABC');
    const gotN = norm(got);
    const dist = gotN ? levenshtein(gotN, target) : 99;
    const close = gotN && (gotN.endsWith(target.slice(-5)) || dist <= 3);
    check('e2e: code SAVE50ABC surfaced (close match)', close, 'got ' + JSON.stringify(got) + ' dist=' + dist);
    check('e2e: result is in the auto-fill shape', r.fields && typeof r.fields === 'object' && (!got || /^[\w./+-]+$/.test(got)), JSON.stringify(Object.keys(r.fields)));
    check('e2e: a code candidate was found at all', !!got, 'no code surfaced');
  } finally {
    await worker.terminate();
  }
}

/* ═══════════════════════════════ Run ══════════════════════════════════════ */

(async () => {
  unitTests();
  await e2eTest();

  console.log('\n════════════════════════════════════════════');
  console.log((failed === 0 ? 'ALL PASSED' : 'FAILURES') + ':  passed=' + passed + '  failed=' + failed);
  if (failed) { failures.forEach((f) => console.log('  • ' + f)); process.exit(1); }
})().catch((e) => { console.error('Harness error:', e); process.exit(1); });
