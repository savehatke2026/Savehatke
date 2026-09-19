// ============================================
// SaveHatke — UPI Payment Primitives
// ============================================
// Everything needed to turn a server-authoritative rupee amount into a real,
// scannable UPI payment request:
//
//   buildUpiUri()        — the upi:// deep link the QR encodes and the
//                          "Open UPI app" button follows
//   generateQrPngDataUrl() — a genuine QR matrix rendered by the `qrcode`
//                          library. Never a picture: every pixel is derived
//                          from the URI, so the amount in the QR is the
//                          amount the server decided.
//
// The payee VPA and name come from the environment so no credential or
// receiving account is ever baked into the frontend bundle.
//
// Env:
//   UPI_ID          the receiving VPA, e.g. savehatke@fam
//   UPI_PAYEE_NAME  the display name the payer sees in their UPI app
// ============================================

const QRCode = require('qrcode');

// ── QR rendering options ──────────────────────────────────────────────────
// Frozen and exported so the verification suite can assert on the exact
// settings that shipped, instead of on a copy of them.
//
//   errorCorrectionLevel 'H' — 30% of the symbol can be lost and still decode.
//     The modal draws the QR on a dark plate behind a semi-transparent scrim,
//     and buyers scan it off a phone screen that may be dimmed, angled, or
//     partially fingerprinted. 'H' is the only level with real headroom for
//     that. It costs modules, which is why the render width is large.
//   margin 4 — the QR spec's minimum quiet zone, in modules. At margin 1 the
//     light border was thin enough that a camera framing tightly on the dark
//     modal background could lose the symbol's edge and fail to lock on.
//   width 1200 — the modal scales this down to ~226 CSS px, so the source has
//     to stay well above that to keep the modules crisp on a 3x display.
//     1200 rather than 1024 because the encoder snaps the render down to a
//     whole multiple of (modules + quiet zone): a request of exactly 1024
//     produces 1023x1023 for a short payload, i.e. it silently misses the
//     round number it was asked for. 1200 leaves enough slack that every
//     payload length this app produces still lands above 1024.
//
// Nothing is ever composited on top of the encoded area: no logo, no caption,
// no watermark. A logo punch-out is what turns a scannable QR into an
// intermittent one.
const QR_OPTIONS = Object.freeze({
  errorCorrectionLevel: 'H',
  type: 'image/png',
  margin: 4,
  width: 1200,
  color: { dark: '#0c1835', light: '#ffffff' },
});

// UPI requires exactly two decimal places. Anything else (37, 37.5, "37.00")
// must be normalised before it reaches the URI.
function formatAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  // Round to paise first so 0.005 does not silently become 0.01 via toFixed.
  const paise = Math.round(n * 100);
  if (paise <= 0) return null;
  return (paise / 100).toFixed(2);
}

/**
 * Parse a rupee amount from untrusted input into a positive, 2-dp number.
 * Returns null when the value is not a usable money amount.
 */
function parseAmount(value) {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const paise = Math.round(n * 100);
  if (paise <= 0) return null;
  // Cap guards against a fat-fingered/compromised coupon row turning into an
  // absurd collect request. Configurable for genuinely expensive inventory.
  const max = Number(process.env.PAYMENT_MAX_AMOUNT || 100000);
  if (Number.isFinite(max) && paise / 100 > max) return null;
  return paise / 100;
}

/**
 * Validate an amount supplied by the client.
 *
 * The checkout sends the amount it is showing, so this is the gate that stops
 * a tampered or fat-fingered value from ever reaching a collect request. It
 * deliberately distinguishes the two failure modes so the caller can return a
 * precise error instead of one generic rejection:
 *
 *   INVALID_AMOUNT   — not numeric, not finite, zero or negative
 *   AMOUNT_TOO_LARGE — valid money, but above PAYMENT_MAX_AMOUNT
 *
 * Returns { ok: true, amount } on success, or { ok: false, code, error }.
 */
function validateAmount(value) {
  if (value === null || value === undefined || value === '') {
    return { ok: false, code: 'INVALID_AMOUNT', error: 'amount is required.' };
  }

  // Reject anything that is not a plain number. Number("") is 0 and
  // Number("  ") is 0, so the emptiness check above runs first; Number(true)
  // is 1 and Number([]) is 0, so objects/booleans are refused explicitly.
  if (typeof value === 'boolean' || typeof value === 'object') {
    return { ok: false, code: 'INVALID_AMOUNT', error: 'amount must be a number.' };
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) {
    return { ok: false, code: 'INVALID_AMOUNT', error: 'amount must be a valid number.' };
  }
  if (n <= 0) {
    return { ok: false, code: 'INVALID_AMOUNT', error: 'amount must be greater than zero.' };
  }

  // Work in paise so 0.001 cannot round its way past the floor.
  const paise = Math.round(n * 100);
  if (paise <= 0) {
    return { ok: false, code: 'INVALID_AMOUNT', error: 'amount must be greater than zero.' };
  }

  const max = Number(process.env.PAYMENT_MAX_AMOUNT || 100000);
  if (Number.isFinite(max) && max > 0 && paise / 100 > max) {
    return {
      ok: false,
      code: 'AMOUNT_TOO_LARGE',
      error: `amount must not exceed ₹${max.toFixed(2)}.`,
      max,
    };
  }

  return { ok: true, amount: paise / 100 };
}

/**
 * Structural validation of a VPA, with a specific reason on failure.
 *
 * `configured` used to be a single boolean off one loose regex, which meant a
 * truncated VPA looked exactly as healthy as a working one — the only way to
 * find out was to scan the QR on a real phone and read "Couldn't verify UPI
 * ID". Validation now returns the *reason* so the operator gets told which
 * character is wrong instead of being handed a generic rejection.
 *
 * Note the distinction between `ok: false` (structurally impossible to be a
 * VPA — refuse to build a URI) and `warning` (structurally possible but it
 * will not resolve at the PSP — allow the payment, tell the operator loudly).
 * Blocking on a warning would take payments down over a suspicion; staying
 * silent about it is what caused this bug.
 */
function validateVpa(raw) {
  const vpa = String(raw || '').trim();

  if (!vpa) {
    return { ok: false, code: 'VPA_MISSING', error: 'UPI_ID is not set. Set UPI_ID in the server environment.' };
  }
  if (/\s/.test(vpa)) {
    return { ok: false, code: 'VPA_HAS_WHITESPACE', error: `UPI_ID contains whitespace: ${JSON.stringify(vpa)}` };
  }

  const at = vpa.indexOf('@');
  if (at < 1 || at !== vpa.lastIndexOf('@')) {
    return {
      ok: false,
      code: 'VPA_MALFORMED',
      error: `UPI_ID must contain exactly one "@" with a non-empty handle on each side: ${JSON.stringify(vpa)}`,
    };
  }

  const local = vpa.slice(0, at);
  const psp = vpa.slice(at + 1);

  if (!/^[A-Za-z0-9][\w.\-]*[A-Za-z0-9]$/.test(local) || local.length < 2) {
    return {
      ok: false,
      code: 'VPA_MALFORMED_HANDLE',
      error: `The part before "@" must be 2+ characters, alphanumeric/./-, starting and ending alphanumeric: ${JSON.stringify(local)}`,
    };
  }
  if (!/^[A-Za-z][A-Za-z0-9]{1,}$/.test(psp)) {
    return {
      ok: false,
      code: 'VPA_MALFORMED_PSP',
      error: `The part after "@" must be a PSP handle of 2+ letters/digits: ${JSON.stringify(psp)}`,
    };
  }

  // ── Advisory checks: valid shape, but will not resolve at the PSP ───────
  // A purely numeric handle is a mobile number (the default VPA every UPI app
  // mints is `<mobile>@<psp>`), and an Indian mobile number is exactly 10
  // digits. A 9- or 11-digit numeric handle is therefore a typo or a
  // truncation, and the payer's app reports it as "Couldn't verify UPI ID".
  let warning = null;
  if (/^\d+$/.test(local) && local.length !== 10) {
    warning = {
      code: 'VPA_MOBILE_HANDLE_LENGTH',
      error:
        `UPI_ID "${vpa}" has a ${local.length}-digit numeric handle. A mobile-number VPA must be a full ` +
        `10-digit Indian mobile number (e.g. 9876543210@${psp}). If this handle is short or long by a digit, ` +
        `the VPA does not exist at the PSP and every UPI app will answer "Couldn't verify UPI ID" — ` +
        `confirm the exact VPA in your UPI app before trusting the QR.`,
    };
  }

  return { ok: true, vpa, local, psp, warning };
}

/**
 * The receiving VPA and display name, read from the environment on every call.
 *
 * Deliberately NOT cached at module load: a cached copy would keep serving a
 * stale VPA after a config change, and would make an unconfigured process look
 * configured — which is precisely the failure isConfigured() exists to catch.
 */
function getPayee() {
  const validated = validateVpa(process.env.UPI_ID);
  const payeeName = String(process.env.UPI_PAYEE_NAME || '').trim() || 'SaveHatke';
  return {
    upiId: validated.ok ? validated.vpa : String(process.env.UPI_ID || '').trim(),
    payeeName,
    configured: validated.ok,
    warning: validated.warning || null,
    invalidReason: validated.ok ? null : validated.error,
  };
}

function isConfigured() {
  return getPayee().configured;
}

/**
 * Build a UPI deep link.
 *
 * The link is EXACTLY the four parameters the spec names, in this order:
 *
 *   upi://pay?pa=UPI_ID&pn=PAYEE_NAME&am=AMOUNT&cu=INR
 *   upi://pay?pa=810054436%40fam&pn=Rupayan%20Das&am=15.00&cu=INR
 *
 * `am` is always exactly two decimal places.
 *
 * WHY NOTHING ELSE IS APPENDED
 * ----------------------------
 * `tr` (transaction reference) and `tn` (note) used to be added whenever an
 * order existed — i.e. on every real payment. They were removed for three
 * reasons:
 *
 *   1. The spec says the QR must encode this link "only". Six parameters is not
 *      four, and a QR that does not carry the agreed payload cannot be signed
 *      off against the agreed payload.
 *   2. Compatibility. The minimal four-parameter form is the one every UPI app
 *      accepts. Extra parameters are where app-specific validation lives, and
 *      `tr` is the worst offender: apps that treat it as a de-duplication key
 *      will refuse a second scan of a link they have already seen.
 *   3. Scannability. Dropping ~40 characters takes the symbol from 57 modules
 *      (version 10) down to 45 (version 7) at error-correction 'H'. With the
 *      quiet zone fixed, that is roughly 22% more pixels per module — a
 *      meaningfully easier scan.
 *
 * The cost is real and worth stating: the order code no longer travels inside
 * the payment, so a bank notification cannot be correlated to an order by
 * matching `SH-XXXXXX`. `paymentVerifier` already treats the order code as an
 * optional narrowing step and falls back to amount + pending-window matching,
 * so nothing breaks — but when two live payments share an amount, that case now
 * needs manual review instead of resolving automatically.
 *
 * `includeReference: true` restores the `tr`/`tn` pair for callers that
 * genuinely need the correlator in the payment and accept those trade-offs.
 */
function buildUpiUri({
  upiId,
  payeeName,
  amount,
  currency = 'INR',
  orderCode = '',
  paymentId = '',
  includeReference = false,
}) {
  const { upiId: fallbackId, payeeName: fallbackName } = getPayee();
  const vpa = String(upiId || fallbackId || '').trim();
  const name = String(payeeName || fallbackName || 'SaveHatke').trim();
  const am = formatAmount(amount);

  // Refuse to emit a URI carrying a VPA that cannot be a VPA at all. A
  // malformed `pa` produces a QR that scans cleanly and then fails inside the
  // payer's app, which is the worst possible failure mode: it looks like our
  // bug and is invisible from the server.
  const check = validateVpa(vpa);
  if (!check.ok) throw new Error(check.error);
  if (!am) throw new Error('A valid positive amount is required to build a UPI URI.');

  const params = new URLSearchParams();
  params.set('pa', check.vpa);
  params.set('pn', name);
  params.set('am', am);
  params.set('cu', String(currency || 'INR').toUpperCase());

  if (includeReference) {
    // Short reference — some PSPs cap `tr` at 35 chars. The order code alone is
    // unique and human-readable, so it is used as the primary handle.
    const tr = String(orderCode || paymentId || '').slice(0, 35);
    if (tr) {
      params.set('tr', tr);
      params.set('tn', orderCode ? `SaveHatke ${orderCode}` : 'SaveHatke coupon purchase');
    }
  }

  // URLSearchParams encodes spaces as '+' and the VPA's '@' as %40. UPI apps
  // render a literal '+' as a plus sign, so spaces are restored to %20. The
  // '@' stays percent-encoded, which is both the RFC 3986 form and what the
  // UPI deep-link examples use.
  return 'upi://pay?' + params.toString().replace(/\+/g, '%20');
}

/**
 * Render a UPI URI to a real QR code PNG data URL.
 *
 * Every pixel is derived from the URI by the `qrcode` library — there is no
 * pre-rendered asset anywhere in the project, so the amount and the payee
 * inside the QR are by construction the ones the server decided.
 *
 * See QR_OPTIONS for why 'H' and a 4-module quiet zone.
 */
async function generateQrPngDataUrl(uri, overrides = {}) {
  if (!uri) throw new Error('A UPI URI is required to generate a QR code.');
  return QRCode.toDataURL(uri, { ...QR_OPTIONS, ...overrides });
}

// ── Logging ───────────────────────────────────────────────────────────────
// The VPA is not a secret in the credential sense — it is printed inside the
// QR the buyer scans — but it is also the receiving account, and server logs
// are kept far longer and read by far more people than a checkout screen. So
// development gets the exact URI (which is the point: you can scan the log
// line to reproduce a report), and production gets the same URI with the VPA
// masked down to enough characters to confirm *which* account is configured.
//
// The webhook secret and every mailbox credential are never passed here.
function maskVpa(vpa) {
  const [local, psp] = String(vpa).split('@');
  if (!psp || !local) return '(malformed)';
  if (local.length <= 4) return '*'.repeat(local.length) + '@' + psp;
  return `${local.slice(0, 2)}${'*'.repeat(Math.min(local.length - 4, 6))}${local.slice(-2)}@${psp}`;
}

function maskUpiUri(uri) {
  return String(uri).replace(/([?&]pa=)([^&]*)/, (m, key, value) => {
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch (e) {}
    return key + maskVpa(decoded);
  });
}

/**
 * Log a generated UPI URI server-side.
 *
 * Development: the full URI, so a reported scan failure can be reproduced
 * exactly from the logs. Production: the VPA masked. Never logs the payee's
 * name in production beyond what the URI already carries publicly.
 */
function logUpiUri(uri, context = '') {
  const tag = context ? `[upi] ${context}` : '[upi]';
  if (process.env.NODE_ENV === 'production') {
    console.log(`${tag} payment URI issued: ${maskUpiUri(uri)}`);
    return;
  }
  console.log(`${tag} generated UPI URI: ${uri}`);
}

/** Log the configured receiving VPA once at boot, with any advisory warning. */
function logPayeeConfig() {
  const payee = getPayee();
  if (!payee.configured) {
    console.error(`[upi] UPI_ID is not usable: ${payee.invalidReason}`);
    return;
  }
  console.log(`[upi] receiving VPA: ${process.env.NODE_ENV === 'production' ? maskVpa(payee.upiId) : payee.upiId} (payee "${payee.payeeName}")`);
  if (payee.warning) console.warn(`[upi] WARNING ${payee.warning.code}: ${payee.warning.error}`);
}

// ── QR self-test ──────────────────────────────────────────────────────────
// "The QR decodes to the URI we meant" is the one property that cannot be
// established by looking at the code: it depends on the encoder, the payload
// and the render options together. So it is measured, not assumed.
//
// The decoder is a *development* tool — the server only ever writes QRs, so
// `jsqr`/`pngjs` are devDependencies and are loaded lazily. On Vercel
// (NODE_ENV=production) this never runs, and a missing decoder degrades to
// SKIP rather than throwing, so a dev box without the devDeps still boots.
let _decoder;
function loadDecoder() {
  if (_decoder !== undefined) return _decoder;
  try {
    const { PNG } = require('pngjs');
    const jsqr = require('jsqr');
    _decoder = { PNG, jsqr };
  } catch (e) {
    _decoder = null;
  }
  return _decoder;
}

/**
 * Decode a generated QR PNG data URL and compare it to the URI it came from.
 * Returns { status: 'PASS' | 'FAIL' | 'SKIP', decoded, reason }.
 */
function selfTestQrDecode(uri, dataUrl) {
  const dec = loadDecoder();
  if (!dec) {
    return { status: 'SKIP', decoded: null, reason: 'no QR decoder installed (npm i -D jsqr pngjs)' };
  }
  try {
    const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
    const png = dec.PNG.sync.read(Buffer.from(base64, 'base64'));
    const pixels = new Uint8ClampedArray(png.data);
    const found = dec.jsqr.default
      ? dec.jsqr.default(pixels, png.width, png.height)
      : dec.jsqr(pixels, png.width, png.height);

    if (!found) {
      return { status: 'FAIL', decoded: null, reason: 'no QR symbol could be found in the generated image' };
    }
    if (found.data !== uri) {
      return { status: 'FAIL', decoded: found.data, reason: 'decoded payload does not match the generated URI' };
    }
    return { status: 'PASS', decoded: found.data, reason: '' };
  } catch (e) {
    return { status: 'FAIL', decoded: null, reason: e.message };
  }
}

/**
 * The development diagnostic block: what was charged, to whom, from what URI,
 * and whether the QR that was actually rendered decodes back to that URI.
 *
 * Runs only outside production, and never prints a credential — the URI carries
 * the VPA (public: it is inside the QR) and nothing else sensitive.
 */
function logPaymentDiagnostics({ orderCode, amount, upiId, upiUri, qr }) {
  if (process.env.NODE_ENV === 'production') return null;

  const test = qr
    ? selfTestQrDecode(upiUri, qr)
    : { status: 'FAIL', decoded: null, reason: 'no QR was produced' };

  const rows = [
    '── UPI PAYMENT DIAGNOSTICS ──────────────────────────',
    `ORDER:             ${orderCode || '(none)'}`,
    `AMOUNT:            ${amount}  (URI carries am=${formatAmount(amount) || '?'})`,
    `UPI ID:            ${upiId}`,
    `GENERATED UPI URI: ${upiUri}`,
    `QR GENERATED:      ${qr ? 'YES' : 'NO'}`,
    `QR DECODE TEST:    ${test.status}`,
  ];
  if (test.status === 'FAIL') {
    rows.push(`  decoded:         ${test.decoded === null ? '(nothing)' : test.decoded}`);
    rows.push(`  reason:          ${test.reason}`);
  } else if (test.status === 'SKIP') {
    rows.push(`  reason:          ${test.reason}`);
  }
  rows.push('─────────────────────────────────────────────────────');

  const out = rows.map((r) => `[upi] ${r}`).join('\n');
  if (test.status === 'FAIL') console.error(out);
  else console.log(out);

  if (test.status === 'FAIL') {
    console.error(
      `[upi] QR SELF-TEST FAILED for ${orderCode || 'this order'}. The QR does not decode back to the URI ` +
      `the server generated, so a payer cannot be charged the right amount. Do not deploy until this passes.`
    );
  }
  return test;
}

module.exports = {
  QR_OPTIONS,
  formatAmount,
  parseAmount,
  validateAmount,
  validateVpa,
  getPayee,
  isConfigured,
  buildUpiUri,
  generateQrPngDataUrl,
  maskVpa,
  maskUpiUri,
  logUpiUri,
  logPayeeConfig,
  selfTestQrDecode,
  logPaymentDiagnostics,
};