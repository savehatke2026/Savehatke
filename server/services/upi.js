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
 * The receiving VPA and display name, read from the environment on every call.
 *
 * Deliberately NOT cached at module load: a cached copy would keep serving a
 * stale VPA after a config change, and would make an unconfigured process look
 * configured — which is precisely the failure isConfigured() exists to catch.
 */
function getPayee() {
  const upiId = String(process.env.UPI_ID || '').trim();
  const payeeName = String(process.env.UPI_PAYEE_NAME || '').trim() || 'SaveHatke';
  return { upiId, payeeName, configured: /^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upiId) };
}

function isConfigured() {
  return getPayee().configured;
}

/**
 * Build a UPI deep link.
 *
 * Format: upi://pay?pa=UPI_ID&pn=PAYEE_NAME&am=AMOUNT&cu=INR
 * `am` is always exactly two decimal places.
 *
 * The four base parameters are the whole link when there is no order context:
 *
 *   upi://pay?pa=810054436%40fam&pn=Rupayan%20Das&am=299.00&cu=INR
 *
 * `tr` (transaction reference) and `tn` (note) are appended ONLY when an
 * order or payment id exists, because they are what let the verifier tie a
 * bank credit back to one specific order. Neither is ever supplied by the
 * browser — both are generated server-side.
 */
function buildUpiUri({ upiId, payeeName, amount, currency = 'INR', orderCode = '', paymentId = '' }) {
  const { upiId: fallbackId, payeeName: fallbackName } = getPayee();
  const vpa = String(upiId || fallbackId || '').trim();
  const name = String(payeeName || fallbackName || 'SaveHatke').trim();
  const am = formatAmount(amount);
  if (!vpa) throw new Error('UPI_ID is not configured.');
  if (!am) throw new Error('A valid positive amount is required to build a UPI URI.');

  const params = new URLSearchParams();
  params.set('pa', vpa);
  params.set('pn', name);
  params.set('am', am);
  params.set('cu', String(currency || 'INR').toUpperCase());

  // Short reference — some PSPs cap `tr` at 35 chars. The order code alone is
  // unique and human-readable, so it is used as the primary handle.
  const tr = String(orderCode || paymentId || '').slice(0, 35);
  if (tr) {
    params.set('tr', tr);
    params.set('tn', orderCode ? `SaveHatke ${orderCode}` : 'SaveHatke coupon purchase');
  }

  // URLSearchParams encodes spaces as '+' and the VPA's '@' as %40. UPI apps
  // render a literal '+' as a plus sign, so spaces are restored to %20. The
  // '@' stays percent-encoded, which is both the RFC 3986 form and what the
  // UPI deep-link examples use.
  return 'upi://pay?' + params.toString().replace(/\+/g, '%20');
}

/**
 * Render a UPI URI to a real QR code PNG data URL.
 * Error correction 'M' survives a phone camera at an angle. The default is
 * rendered at 1024px so it stays crisp when the modal scales it up on a
 * phone screen — a 512px source upscaled on a 3x display softens the modules
 * enough to make scanning finicky.
 */
async function generateQrPngDataUrl(uri, { size = 1024, margin = 1 } = {}) {
  if (!uri) throw new Error('A UPI URI is required to generate a QR code.');
  return QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    type: 'image/png',
    margin: Number(margin) >= 0 ? Number(margin) : 1,
    width: Number(size) || 1024,
    color: { dark: '#0c1835', light: '#ffffff' },
  });
}

module.exports = {
  formatAmount,
  parseAmount,
  validateAmount,
  getPayee,
  isConfigured,
  buildUpiUri,
  generateQrPngDataUrl,
};