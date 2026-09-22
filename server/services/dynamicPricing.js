// ============================================
// SaveHatke — Buyer Pricing Service
// ============================================
// Single, simple buyer-pricing rule that applies to BOTH admin and seller
// coupons:
//
//   if coupon is expired:                         NOT PURCHASABLE
//   else if time_remaining <= 24 hours:           price = face_value * 0.10
//   else:                                          price = face_value * 0.20
//
// Only two inputs affect the buyer price:
//   1. face_value   — the coupon's `originalValue` / `faceValue`
//   2. expiry_date  — the coupon's `expiryDate`
//
// The price is NEVER stored. Every read site (marketplace card, checkout,
// payment, order summary) calls getBuyerPrice(coupon, now) and renders what
// it returns. A buyer that opens a card a few hours before expiry sees the
// price automatically drop from 20% to 10% without anyone touching the row.
//
// Notes for callers
// -----------------
//   • The result includes `rate` (0.10 or 0.20) and `bandLabel`
//     ("20% (more than 24h remaining)" / "10% (last 24 hours)") so the UI
//     can show the same caption on every surface.
//   • The result includes `faceValue` so the caller can render "20% of ₹1,000"
//     style copy without re-reading the coupon row.
//   • getBuyerPrice() is deterministic and pure — it only depends on its
//     arguments, so the same coupon always renders the same price on every
//     screen at the same moment. Server-side recalculation on the payment
//     route guarantees a malicious client cannot pay a different amount.

// ---------------------------------------------------------------------------
// Constants — the spec's exact thresholds and rates. Kept as named constants
// so future rate changes happen in one place and are easy to assert.
// ---------------------------------------------------------------------------

// Time remaining at or below this gets the 10% rate. >24h keeps the 20% rate.
const LAST_24H_MS = 24 * 60 * 60 * 1000;
const NORMAL_RATE = 0.20;
const LAST24H_RATE = 0.10;
const MS_PER_HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the face value to a finite positive number, or NaN if it isn't one.
 * Strict decimal: digits, optional . + 1–2 decimals. Matches the same shape
 * the seller payout validation accepts, so a coupon whose face value is
 * eligible for payout is always eligible for buyer pricing.
 */
function parseFaceValue(faceValue) {
  if (faceValue === undefined || faceValue === null) return NaN;
  const text = String(faceValue).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return NaN;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

/**
 * Time remaining in milliseconds until the coupon expires. Negative when
 * already expired, +Infinity when expiry is missing/unparseable (we treat
 * missing expiry as "indefinitely valid" so an admin coupon without an
 * expiry date still has a sensible price).
 */
function timeRemainingMs(expiryDate, now = Date.now()) {
  if (!expiryDate) return Number.POSITIVE_INFINITY;
  const at = new Date(expiryDate).getTime();
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  return at - now;
}

/**
 * Compute the effective buyer price for a coupon at a given moment.
 *
 * @param {object} coupon - { originalValue, expiryDate, … }.
 * @param {Date|number} [now] - Reference moment (defaults to server clock).
 * @returns {{
 *   price: number,           // 0 when not purchasable (expired or bad face value)
 *   purchasable: boolean,    // false when expired or face value is unparseable
 *   expired: boolean,        // true when the expiry timestamp is in the past
 *   rate: number,            // 0.10 or 0.20
 *   bandLabel: string,       // human-readable band for UI captions
 *   faceValue: number,       // the parsed face value (NaN if invalid)
 *   hoursRemaining: number   // whole hours until expiry (Infinity if no expiry)
 * }}
 */
function getBuyerPrice(coupon, now = Date.now()) {
  const faceValue = parseFaceValue(coupon && coupon.originalValue);
  const msLeft = timeRemainingMs(coupon && coupon.expiryDate, now);

  const expired = msLeft <= 0;
  const validFace = !Number.isNaN(faceValue);
  const purchasable = validFace && !expired;

  // Out-of-range face values (NaN) or expired coupons never produce a price —
  // the caller should hide the buy button rather than show "₹0" alongside a
  // stale 20% / 10% number. The 10% rate is the LAST-24-HOURS rate and must
  // never appear next to a coupon that has actually expired.
  if (!purchasable) {
    return {
      price: 0,
      purchasable: false,
      expired,
      rate: NORMAL_RATE,
      bandLabel: expired ? 'Expired' : '20% of face value',
      faceValue: Number.isNaN(faceValue) ? NaN : faceValue,
      hoursRemaining: Number.isFinite(msLeft) ? Math.max(0, msLeft / MS_PER_HOUR) : Number.POSITIVE_INFINITY,
    };
  }

  // 10% for last 24h, 20% otherwise. Inclusive boundary: <=24h gets 10%.
  const rate = msLeft <= LAST_24H_MS ? LAST24H_RATE : NORMAL_RATE;
  const price = parseFloat((faceValue * rate).toFixed(2));
  const bandLabel = rate === LAST24H_RATE
    ? '10% of face value (last 24 hours)'
    : '20% of face value';

  return {
    price,
    purchasable: true,
    expired: false,
    rate,
    bandLabel,
    faceValue,
    hoursRemaining: Number.isFinite(msLeft) ? Math.max(0, msLeft / MS_PER_HOUR) : Number.POSITIVE_INFINITY,
  };
}

// Backwards-compatible entry point: the old dynamicPricing.js exported
// getCurrentPrice(coupon). Some callers (e.g. payment.js) used that name.
// Keep the same shape so route code does not have to change in lockstep.
function getCurrentPrice(coupon, now = Date.now()) {
  const result = getBuyerPrice(coupon, now);
  return {
    price: result.price,
    isDynamic: true,
    expired: result.expired,
    purchasable: result.purchasable,
    rate: result.rate,
    bandLabel: result.bandLabel,
    faceValue: result.faceValue,
    hoursRemaining: result.hoursRemaining,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Primary API
  getBuyerPrice,
  // Backwards-compatible alias used by routes that pre-date the rename.
  getCurrentPrice,
  // Constants — exported so the verification harness can pin the spec
  // numbers without re-declaring them.
  NORMAL_RATE,
  LAST24H_RATE,
  LAST_24H_MS,
};
