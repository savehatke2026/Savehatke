// ============================================
// SaveHatke — Buyer Pricing Service (hybrid automatic + manual)
// ============================================
// The single authority for what a buyer pays. Every purchase path (payment
// create, admin sell, the coupon read endpoint, the listing) calls
// getBuyerPrice(coupon, now), so checkout, payment verification and the card
// can never disagree.
//
// Pricing modes (coupon.pricingMode):
//   'automatic' — derived from the value:
//       face_value        → normal = 20% of face, last 24h = 10% of face
//       maximum_discount  → normal / last-24h from the configured tier table
//       neither           → NOT purchasable ("Pricing unavailable")
//   'manual'    — admin sets the normal price (manualPrice). The last-24h price
//       is manualFinalPrice when set, otherwise normal × (1 − default final %).
//   legacy      — no pricingMode stored: 'manual' when a manual price exists,
//       else 'automatic'. This keeps every existing coupon priced exactly as
//       before.
//
// Value type (coupon.valueType): 'face_value' | 'maximum_discount'. Legacy rows
// without it are face value, the only meaning originalValue ever had for
// pricing. A maximum discount is never treated as a face value.
//
// The expiry gate is shared: expired → not purchasable, final-day price applies
// at or under 24h remaining. The stored normal price is never rewritten.
//
// Money is computed in integer paise so 20% / 10% / tiers never drift.

const { parseCouponExpiry } = require('../utils/couponExpiry');
const pricingConfig = require('./pricingConfig');

const LAST_24H_MS = 24 * 60 * 60 * 1000;
const NORMAL_RATE = 0.20;
const LAST24H_RATE = 0.10;
const MS_PER_HOUR = 60 * 60 * 1000;

const PRICING_MODES = ['automatic', 'manual'];
const VALUE_TYPES = ['face_value', 'maximum_discount'];

// ---------------------------------------------------------------------------
// Paise helpers — all arithmetic happens on integers.
// ---------------------------------------------------------------------------

/** "1000", "1000.5", "1000.50" → paise (100000 / 100050 / 100050). null if invalid. */
function toPaise(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}

/** paise → "200" / "199.50" (two decimals only when needed). */
function fromPaise(paise) {
  const whole = Math.floor(paise / 100);
  const frac = paise % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
}

/** Percentage of a paise amount, rounded half-up to whole paise, integer math. */
function percentOfPaise(paise, percent) {
  // percent may be fractional like 20 or 10 or 50; scale by 100 to stay integer.
  const scaled = Math.round(percent * 100);
  return Math.floor((paise * scaled + 5000) / 10000);
}

// Compatibility: legacy callers used the float helper names. Kept for tests.
function parseFaceValue(faceValue) {
  const p = toPaise(faceValue);
  return p === null || p <= 0 ? NaN : p / 100;
}

function parseManualPrice(value) {
  const p = toPaise(value);
  if (p === null || p <= 0 || p > 100000 * 100) return null;
  return p / 100;
}

// ---------------------------------------------------------------------------
// Mode / value-type inference
// ---------------------------------------------------------------------------

function normMode(raw, hasManualPrice) {
  const m = String(raw || '').trim().toLowerCase();
  if (PRICING_MODES.includes(m)) return m;
  // Legacy row (no stored mode): manual only when an admin manual price exists,
  // so every existing coupon keeps the price it already has.
  return hasManualPrice ? 'manual' : 'automatic';
}

function normValueType(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return VALUE_TYPES.includes(v) ? v : 'face_value';
}

/** Manual price as paise, or null when blank / invalid (formula applies). */
function manualPaiseOf(coupon) {
  const raw = coupon && coupon.manualPrice;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const p = toPaise(raw);
  if (p === null || p <= 0 || p > 100000 * 100) return null;
  return p;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Compute the buyer price for a coupon at a given moment.
 *
 * Returns the same shape callers already read, plus the new pricing fields:
 *   price, normalPrice, finalPrice, purchasable, expired, pricingSource,
 *   pricingMode, valueType, rate, bandLabel, faceValue, hoursRemaining,
 *   pricingError ('' or 'PRICING_UNAVAILABLE' / 'INVALID_PRICE').
 *
 * `price` is the price in effect right now (normal, or final-day inside 24h).
 */
function getBuyerPrice(coupon, now = Date.now(), config = pricingConfig.getCachedConfig()) {
  const c = coupon || {};
  const msLeft = expiryMsLeft(c.expiryDate, now);
  const expired = msLeft <= 0;
  const manualPaise = manualPaiseOf(c);
  const mode = normMode(c.pricingMode, manualPaise !== null);
  const valueType = normValueType(c.valueType);
  const faceValueNum = Number.isNaN(parseFaceValue(c.originalValue)) ? NaN : parseFaceValue(c.originalValue);
  const hoursRemaining = Number.isFinite(msLeft) ? Math.max(0, msLeft / MS_PER_HOUR) : Number.POSITIVE_INFINITY;
  const finalDay = msLeft <= LAST_24H_MS;

  const base = {
    expired,
    pricingMode: mode,
    valueType,
    faceValue: faceValueNum,
    hoursRemaining,
    normalPrice: 0,
    finalPrice: 0,
    price: 0,
    rate: null,
    pricingSource: '',
    purchasable: false,
    pricingError: '',
    bandLabel: '',
  };

  if (expired) {
    return { ...base, bandLabel: 'Expired', pricingError: 'EXPIRED' };
  }

  let normal;
  let final;
  let rate = null;
  let source;

  if (mode === 'manual' && manualPaise !== null) {
    normal = manualPaise;
    const explicitFinal = toPaise(c.manualFinalPrice);
    if (explicitFinal !== null && explicitFinal >= 0) {
      final = Math.min(explicitFinal, normal);
    } else {
      const pct = Number(config.manualFinalPercentOff);
      final = normal - percentOfPaise(normal, pct);
    }
    source = 'manual';
  } else if (valueType === 'maximum_discount') {
    const maxPaise = toPaise(c.originalValue);
    if (maxPaise === null || maxPaise <= 0) {
      return { ...base, pricingError: 'PRICING_UNAVAILABLE', bandLabel: 'Pricing unavailable' };
    }
    const tier = pricingConfig.tierFor(config, maxPaise);
    normal = tier.normalPaise;
    final = tier.finalPaise;
    source = 'auto';
  } else {
    // face_value (or legacy) automatic: 20% / 10% of face value.
    if (Number.isNaN(faceValueNum)) {
      // No face value and no manual price → automatic pricing unavailable.
      return { ...base, pricingError: 'PRICING_UNAVAILABLE', bandLabel: 'Pricing unavailable' };
    }
    const facePaise = toPaise(c.originalValue);
    normal = percentOfPaise(facePaise, 20);
    final = percentOfPaise(facePaise, 10);
    source = 'auto';
  }

  if (!Number.isSafeInteger(normal) || normal <= 0 || final < 0 || final > normal) {
    return { ...base, pricingError: 'INVALID_PRICE', bandLabel: 'Invalid price' };
  }

  const price = finalDay ? final : normal;
  const percentLabel = source === 'auto' && valueType === 'face_value' && normal > 0
    ? (finalDay ? '10% of face value (last 24 hours)' : '20% of face value')
    : '';
  if (source === 'auto' && valueType === 'face_value') rate = finalDay ? LAST24H_RATE : NORMAL_RATE;

  return {
    ...base,
    purchasable: true,
    normalPrice: normal / 100,
    finalPrice: final / 100,
    price: price / 100,
    rate,
    pricingSource: source,
    bandLabel: source === 'manual'
      ? (finalDay ? 'Manual price (last 24 hours)' : 'Manual price')
      : (percentLabel || (finalDay ? 'Last 24 hours price' : 'Auto-calculated price')),
  };
}

/** Time remaining in ms. +Infinity when no usable expiry (never invented). */
function expiryMsLeft(expiryDate, now = Date.now()) {
  if (!expiryDate) return Number.POSITIVE_INFINITY;
  const at = parseCouponExpiry(expiryDate);
  if (at === null) return Number.POSITIVE_INFINITY;
  return at - now;
}

// Backwards-compatible entry point used by older callers.
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

/**
 * Validate an admin pricing form for save/publish. Returns { ok, errors[] }.
 * `merged` is the coupon as it will be stored after this save.
 */
function validatePricing(merged, config = pricingConfig.getCachedConfig()) {
  const errors = [];
  const mode = normMode(merged.pricingMode, manualPaiseOf(merged) !== null);
  const manualText = merged.manualPrice === undefined || merged.manualPrice === null ? '' : String(merged.manualPrice).trim();
  const finalText = merged.manualFinalPrice === undefined || merged.manualFinalPrice === null ? '' : String(merged.manualFinalPrice).trim();

  if (mode === 'manual') {
    if (manualText === '') errors.push('Manual pricing needs a normal selling price.');
    else if (manualPaiseOf(merged) === null) errors.push('Manual selling price must be a number between 1 and 100000 with up to 2 decimals.');
    if (finalText !== '') {
      const f = toPaise(finalText);
      const n = manualPaiseOf(merged);
      if (f === null) errors.push('Last 24 hours price must be a number with up to 2 decimals.');
      else if (n !== null && f > n) errors.push('Last 24 hours price cannot be higher than the normal selling price.');
    }
  } else {
    const valueType = normValueType(merged.valueType);
    const faceText = String(merged.originalValue == null ? '' : merged.originalValue).trim();
    const hasValue = faceText !== '' && toPaise(faceText) !== null && toPaise(faceText) > 0;
    if (!hasValue) {
      errors.push('Pricing unavailable — enter a manual selling price or provide pricing data.');
    } else if (valueType === 'maximum_discount' && !pricingConfig.tierForConfigured(config)) {
      errors.push('No maximum-discount pricing tiers are configured.');
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  // Primary API
  getBuyerPrice,
  getCurrentPrice,
  validatePricing,
  // Helpers (exported for tests and the admin preview endpoint)
  toPaise,
  fromPaise,
  percentOfPaise,
  expiryMsLeft,
  PRICING_MODES,
  VALUE_TYPES,
  // Constants
  NORMAL_RATE,
  LAST24H_RATE,
  LAST_24H_MS,
};
