// ============================================
// SaveHatke — UPI QR round-trip verification (development)
// ============================================
// Proves that the QR the checkout renders is a genuine encoding of the
// server-built UPI URI, and that the URI is built from the ONE authoritative
// server-side VPA.
//
// The check is a real round trip, not a string comparison:
//
//   env UPI_ID -> buildUpiUri() -> generateQrPngDataUrl() -> PNG
//   PNG -> jsqr -> decoded string
//   decoded === built  ?
//
// Anything that silently corrupts the payload — a truncated digit in the VPA,
// an unencoded '&' in the payee name, a stale cached config — makes the two
// strings differ and fails the run.
//
// Usage:
//   node scripts/verify-upi-qr.cjs                    (all amounts)
//   node scripts/verify-upi-qr.cjs 15                 (one amount)
//   node scripts/verify-upi-qr.cjs --vpa=9876543210@fam
//                                                     (test a candidate VPA
//                                                      without editing .env)
//
// jsqr is not a runtime dependency of the server (the server only *writes*
// QRs), so it is loaded from the isolated runtime workspace when it is not
// installed locally. Without it the decode step is reported as SKIPPED rather
// than passed.
// ============================================

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env') });

// A candidate VPA supplied on the command line is applied to the process env
// before anything reads it. This is how you check a corrected UPI ID BEFORE
// putting it in .env — or in the Vercel dashboard, which is the copy that
// actually serves production.
const vpaArg = process.argv.find((a) => a.startsWith('--vpa='));
const candidateVpa = vpaArg ? vpaArg.slice('--vpa='.length).trim() : '';
if (candidateVpa) {
  process.env.UPI_ID = candidateVpa;
  console.log(`\n  Testing candidate VPA from the command line: ${candidateVpa}`);
  console.log('  (this overrides UPI_ID for this run only — nothing was written to .env)');
}

const upi = require('../server/services/upi');
const { PNG } = require('pngjs');

// ── Tiny assertion harness ────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
let advisories = 0;

function check(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? '  ->  ' + detail : ''}`);
  }
}

function skip(label, why) {
  skipped++;
  console.log(`  SKIP  ${label}  (${why})`);
}

/**
 * Something about operator-supplied configuration that is worth knowing but is
 * not a defect in this codebase. Reported with the same prominence as a
 * failure, counted separately so the run still exits 0.
 */
function advise(label, detail) {
  advisories++;
  console.log(`  ADVISORY  ${label}${detail ? '\n            ' + detail : ''}`);
}

function head(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

// ── jsqr loader (isolated runtime workspace fallback) ─────────────────────
let jsqr = null;
try {
  jsqr = require('jsqr');
} catch (e) {
  const ws = 'C:/Users/Rupayan/.workbuddy-ai/binaries/node/workspace';
  try {
    jsqr = require(path.join(ws, 'node_modules', 'jsqr'));
  } catch (e2) {
    jsqr = null;
  }
}

function decodeDataUrl(dataUrl) {
  if (!dataUrl) return null;
  const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  const pixels = new Uint8ClampedArray(png.data);
  const result = jsqr.default
    ? jsqr.default(pixels, png.width, png.height)
    : jsqr(pixels, png.width, png.height);
  return result ? result.data : null;
}

// ── 1. The configured VPA ─────────────────────────────────────────────────
const payee = upi.getPayee();
const VPA = payee.upiId;

head('1. Server-side UPI configuration (the single source of truth)');
console.log(`  UPI_ID          = ${VPA || '(empty)'}`);
console.log(`  UPI_PAYEE_NAME  = ${payee.payeeName}`);
console.log(`  PAYMENT_MAX_AMOUNT = ${process.env.PAYMENT_MAX_AMOUNT || '(unset)'}`);

check('UPI_ID is set and non-empty', VPA.length > 0, `got ${JSON.stringify(VPA)}`);
check('UPI_ID matches the VPA shape <handle>@<psp>', payee.configured, `got ${JSON.stringify(VPA)}`);
check('UPI_ID has no whitespace or control characters', !/\s/.test(VPA), JSON.stringify(VPA));
check('UPI_ID contains exactly one @', (VPA.match(/@/g) || []).length === 1, JSON.stringify(VPA));
check('UPI_ID is not a placeholder value',
  !/^(test|dummy|example|your|xxxx|placeholder)/i.test(VPA) && !VPA.includes('@example'),
  JSON.stringify(VPA));

// A VPA whose local part is purely digits is a mobile-number handle, and the
// UPI spec for those is a full 10-digit Indian mobile number. A handle that is
// short or long by a digit resolves to nothing at the PSP, which the scanning
// app surfaces as "Couldn't verify UPI ID".
//
// This is an ADVISORY, not a failure: the VPA is operator-supplied config, and
// the decisive test is entering it by hand in a UPI app (see the spec's CASE A
// / CASE B rule). The repo cannot settle it, so it must not pretend to.
const local = VPA.split('@')[0] || '';
if (/^\d+$/.test(local)) {
  if (local.length === 10) {
    check('numeric VPA handle is a full 10-digit mobile number (UPI spec)', true);
  } else {
    advise(`numeric VPA handle is ${local.length} digits, not 10`,
      `"${VPA}" looks like a mobile-number VPA, and those must be a full 10-digit Indian\n` +
      `            mobile number (e.g. 9876543210@${VPA.split('@')[1]}). If a digit is missing or\n` +
      `            extra, the VPA does not exist at the PSP and every UPI app will answer\n` +
      `            "Couldn't verify UPI ID" no matter how the QR is generated.\n` +
      `            DECISIVE TEST: type "${VPA}" by hand into Google Pay / PhonePe.\n` +
      `              resolves a payee name  -> CASE A, the VPA is fine, keep debugging the QR\n` +
      `              refuses it            -> CASE B, the VPA/account needs the provider`);
  }
} else {
  skip('numeric VPA handle is a full 10-digit mobile number', 'handle is not purely numeric');
}

// ── 2. URI construction ───────────────────────────────────────────────────
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--') && Number.isFinite(Number(a)));
const amounts = positional.length ? [Number(positional[0])] : [15, 1, 10, 37, 299, 15.5];

head('2. UPI URI for each amount — exact payload the QR must carry');
for (const amount of amounts) {
  const uri = upi.buildUpiUri({ amount });
  console.log(`  ₹${amount}  ->  ${uri}`);
}

head('3. Required URI shape');
const uri15 = upi.buildUpiUri({ amount: 15 });
console.log(`  ${uri15}`);
check('starts with upi://pay?', uri15.startsWith('upi://pay?'), uri15);
check('carries the exact configured VPA', uri15.includes('pa=' + encodeURIComponent(VPA)), uri15);
check('carries am=15.00 (two decimal places on the wire)', /[?&]am=15\.00(&|$)/.test(uri15), uri15);
check('carries cu=INR', /[?&]cu=INR(&|$)/.test(uri15), uri15);
check('payee name is percent-encoded, no raw spaces', !uri15.includes('+') && !/pn=[^&]* /.test(uri15), uri15);
check('no parameter is empty', !/[?&]\w+=($|&)/.test(uri15), uri15);
check('carries exactly the four spec parameters — pa, pn, am, cu — and nothing else',
  /^upi:\/\/pay\?pa=[^&]+&pn=[^&]+&am=15\.00&cu=INR$/.test(uri15), uri15);
check('the VPA digit string survives verbatim',
  uri15.includes(VPA.replace('@', '%40')) || uri15.includes(VPA),
  uri15);

// ── 4. QR round trip ──────────────────────────────────────────────────────
(async () => {
  head('4. QR round trip — generate, then decode back');

  if (!jsqr) {
    skip('QR decodes back to the exact URI', 'jsqr not installed (run with NODE_PATH set)');
  }

  for (const amount of amounts) {
    const built = upi.buildUpiUri({ amount });
    let dataUrl;
    try {
      dataUrl = await upi.generateQrPngDataUrl(built);
    } catch (e) {
      check(`₹${amount}: QR generated`, false, e.message);
      continue;
    }

    check(`₹${amount}: a real PNG data URL was produced`,
      /^data:image\/png;base64,/.test(dataUrl), String(dataUrl).slice(0, 30));

    const png = PNG.sync.read(Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
    check(`₹${amount}: rendered at ${png.width}x${png.height} (>= 1024px)`,
      png.width >= 1024 && png.height >= 1024, `${png.width}x${png.height}`);

    if (!jsqr) continue;

    const decoded = decodeDataUrl(dataUrl);
    if (decoded === null) {
      check(`₹${amount}: QR decodes at all`, false, 'jsqr found no QR in the image');
      continue;
    }
    check(`₹${amount}: decoded payload === generated URI (exact, byte for byte)`,
      decoded === built,
      `\n         built   = ${built}\n         decoded = ${decoded}`);

    const expectedAm = amount.toFixed(2);
    check(`₹${amount}: decoded payload carries am=${expectedAm}`,
      new RegExp('[?&]am=' + expectedAm.replace('.', '\\.') + '(&|$)').test(decoded),
      decoded);
  }

  // The amount must be *inside* the QR. If two different amounts produced the
  // same payload the modal would be showing a static image.
  if (jsqr) {
    const a = decodeDataUrl(await upi.generateQrPngDataUrl(upi.buildUpiUri({ amount: 15 })));
    const b = decodeDataUrl(await upi.generateQrPngDataUrl(upi.buildUpiUri({ amount: 16 })));
    check('₹15 and ₹16 produce genuinely different QR payloads',
      a !== null && b !== null && a !== b,
      `a=${a} b=${b}`);
  }

  // ── 5. Quiet zone and error correction ──────────────────────────────────
  head('5. Scannability — error correction and quiet zone');
  const opts = upi.QR_OPTIONS || {};
  console.log(`  errorCorrectionLevel = ${opts.errorCorrectionLevel}`);
  console.log(`  margin (quiet zone)  = ${opts.margin} modules`);
  console.log(`  width                = ${opts.width}px`);
  check("error correction is high ('H')", opts.errorCorrectionLevel === 'H', String(opts.errorCorrectionLevel));
  check('quiet zone is at least 4 modules (QR spec minimum)',
    Number(opts.margin) >= 4, String(opts.margin));
  check('rendered width is at least 1024px', Number(opts.width) >= 1024, String(opts.width));

  // ── 6. Server-side logging (dev verbatim, production redacted) ──────────
  head('6. Server-side URI logging — verbatim in dev, masked in production');

  function captureLog(fn) {
    const lines = [];
    const real = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try { fn(); } finally { console.log = real; }
    return lines.join('\n');
  }

  const originalEnv = process.env.NODE_ENV;

  try {
    process.env.NODE_ENV = 'development';
    const devOut = captureLog(() => upi.logUpiUri(uri15, 'test'));
    check('development logs the full URI, so a scan report can be reproduced',
      devOut.includes(uri15), devOut);
  } finally {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }

  try {
    process.env.NODE_ENV = 'production';
    const prodOut = captureLog(() => upi.logUpiUri(uri15, 'test'));
    check('production does NOT log the full receiving VPA',
      !prodOut.includes(VPA), prodOut);
    check('production still logs which PSP handle is configured (so the line is useful)',
      prodOut.includes('@' + VPA.split('@')[1]), prodOut);
    check('production log line is still recognisably a UPI URI',
      prodOut.includes('upi://pay?') && prodOut.includes('am=15.00'), prodOut);
    console.log(`  (production log line reads: ${prodOut.trim()})`);

    // Requirement: never expose private credentials in logs.
    const secret = process.env.PAYMENT_WEBHOOK_SECRET;
    if (secret) {
      check('neither log line leaks PAYMENT_WEBHOOK_SECRET',
        !prodOut.includes(secret), 'secret appeared in the log');
    } else {
      skip('neither log line leaks PAYMENT_WEBHOOK_SECRET', 'PAYMENT_WEBHOOK_SECRET is not set here');
    }
  } finally {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }

  check('maskVpa keeps the PSP handle and hides the account handle',
    upi.maskVpa('9876543210@fam') === '98******10@fam', upi.maskVpa('9876543210@fam'));

  // ── 7. Server-side QR self-test (the §12 diagnostic block) ─────────────
  head('7. Server-side QR decode self-test and diagnostic block');

  const passTest = upi.selfTestQrDecode(uri15, await upi.generateQrPngDataUrl(uri15));
  check('selfTestQrDecode reports PASS for a correct QR', passTest.status === 'PASS',
    `${passTest.status}: ${passTest.reason}`);

  // The self-test has to be able to FAIL, or it proves nothing. Corrupt the
  // image and confirm it stops reporting PASS.
  const realQr = await upi.generateQrPngDataUrl(uri15);
  const corrupted = realQr.slice(0, Math.floor(realQr.length / 2));
  const corruptTest = upi.selfTestQrDecode(uri15, corrupted);
  check('selfTestQrDecode does NOT report PASS for a corrupted image',
    corruptTest.status !== 'PASS', `${corruptTest.status}: ${corruptTest.reason}`);

  // A QR that decodes to a DIFFERENT uri must be caught, not accepted.
  const mismatched = upi.selfTestQrDecode('upi://pay?pa=x@y&am=99.00&cu=INR', realQr);
  check('selfTestQrDecode FAILs when the decoded payload differs from the URI',
    mismatched.status === 'FAIL', `${mismatched.status}: ${mismatched.reason}`);

  const diagLines = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a) => diagLines.push(a.join(' '));
  console.error = (...a) => diagLines.push(a.join(' '));
  let diag;
  try {
    diag = upi.logPaymentDiagnostics({
      orderCode: 'SH-TEST12', amount: 15, upiId: VPA, upiUri: uri15, qr: realQr,
    });
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  const diagOut = diagLines.join('\n');
  check('the diagnostic block reports QR DECODE TEST: PASS',
    /QR DECODE TEST:\s+PASS/.test(diagOut), diagOut);
  for (const label of ['ORDER:', 'AMOUNT:', 'UPI ID:', 'GENERATED UPI URI:', 'QR GENERATED:']) {
    check(`the diagnostic block contains "${label}"`, diagOut.includes(label), diagOut);
  }
  check('the diagnostic block carries the exact URI', diagOut.includes(uri15), diagOut);
  console.log('\n' + diagOut + '\n');

  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (secret) {
    check('the diagnostic block leaks no webhook secret', !diagOut.includes(secret));
  }

  // The block is a development tool. In production it must print nothing at
  // all — no VPA, no order codes, and no attempt to load the devDependency
  // decoder.
  const envBefore = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const prodLines = [];
    const rl = console.log; const re = console.error;
    console.log = (...a) => prodLines.push(a.join(' '));
    console.error = (...a) => prodLines.push(a.join(' '));
    let prodReturn;
    try {
      prodReturn = upi.logPaymentDiagnostics({
        orderCode: 'SH-PROD12', amount: 15, upiId: VPA, upiUri: uri15, qr: realQr,
      });
    } finally {
      console.log = rl; console.error = re;
    }
    check('the diagnostic block is silent in production', prodLines.length === 0,
      prodLines.join(' | '));
    check('the diagnostic block returns null in production', prodReturn === null,
      String(prodReturn));
  } finally {
    if (envBefore === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = envBefore;
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  head('Summary');
  console.log(`  passed: ${passed}   failed: ${failed}   skipped: ${skipped}` +
    (advisories ? `   advisory: ${advisories}` : ''));
  console.log(`\n  Scan this to confirm the VPA by hand: ${uri15}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
