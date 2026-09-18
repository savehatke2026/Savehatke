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

// Defaults keep the flow usable in a dev environment; production must set
// both variables (see isConfigured()).
const DEFAULT_UPI_ID = process.env.UPI_ID || '';
const DEFAULT_PAYEE_NAME = process.env.UPI_PAYEE_NAME || 'SaveHatke';

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

function getPayee() {
  const upiId = String(process.env.UPI_ID || DEFAULT_UPI_ID || '').trim();
  const payeeName = String(process.env.UPI_PAYEE_NAME || DEFAULT_PAYEE_NAME || '').trim() || 'SaveHatke';
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
 * `tr` (transaction reference) and `tn` (note) make the resulting payment
 * matchable later: when the confirmation arrives it carries the same
 * reference back, which is what lets the verifier tie a bank credit to one
 * specific order instead of guessing. The browser never supplies either —
 * both are generated here from the server's own payment id / order code.
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
  if (tr) params.set('tr', tr);

  const tn = orderCode ? `SaveHatke ${orderCode}` : 'SaveHatke coupon purchase';
  params.set('tn', tn);

  // URLSearchParams encodes spaces as '+' and the VPA's '@' as %40. UPI apps
  // render the first literally and several PSPs fail to resolve a %40-encoded
  // VPA, so both are restored to their plain form ('@' is a legal query
  // character) while everything else stays escaped.
  return 'upi://pay?' + params.toString().replace(/\+/g, '%20').replace(/%40/g, '@');
}

/**
 * Render a UPI URI to a real QR code PNG data URL.
 * Error correction 'M' survives a phone camera at an angle while keeping the
 * matrix small enough to stay scannable on a 240px display.
 */
async function generateQrPngDataUrl(uri, { size = 512, margin = 1 } = {}) {
  if (!uri) throw new Error('A UPI URI is required to generate a QR code.');
  return QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    type: 'image/png',
    margin: Number(margin) >= 0 ? Number(margin) : 1,
    width: Number(size) || 512,
    color: { dark: '#0c1835', light: '#ffffff' },
  });
}

module.exports = {
  formatAmount,
  parseAmount,
  getPayee,
  isConfigured,
  buildUpiUri,
  generateQrPngDataUrl,
};