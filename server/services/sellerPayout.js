'use strict';

// The ONLY seller payout formula. Marketplace sellingPrice is never an input.
const PAYOUT_RATE = 0.07;
const PAYOUT_PRICING_MODEL = 'face-value-7-percent';
const MIN_FACE_VALUE = 100;
const MAX_FACE_VALUE = 10000;
const VALIDATION_MESSAGE = 'Coupon face value must be between ₹100 and ₹10,000, with at most two decimal places.';

// Parse decimal rupees without permissive parseFloat/character stripping.
// Integer paise avoid binary floating-point drift; fractions of a paise round
// half-up, matching PostgreSQL ROUND(numeric, 2).
function moneyToPaise(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}

function calculateSellerPayout(faceValue) {
  const paise = moneyToPaise(faceValue);
  if (paise === null || paise < MIN_FACE_VALUE * 100 || paise > MAX_FACE_VALUE * 100) {
    const error = new Error(VALIDATION_MESSAGE);
    error.code = 'INVALID_FACE_VALUE';
    error.status = 400;
    throw error;
  }
  // sellerPayout = faceValue * 0.07, rounded only to the nearest paise.
  return Math.floor((paise * 7 + 50) / 100) / 100;
}

function faceValueOf(coupon = {}) {
  // Existing originalValue/original_value is the authoritative face value.
  return coupon.originalValue ?? coupon.original_value ?? coupon.faceValue ?? coupon.face_value;
}

function couponPayoutInfo(coupon = {}) {
  try {
    const faceValue = faceValueOf(coupon);
    const sellerPayout = calculateSellerPayout(faceValue);
    const stored = coupon.sellerPayout ?? coupon.seller_payout;
    const storedPaise = moneyToPaise(stored);
    return {
      faceValue: moneyToPaise(faceValue) / 100,
      sellerPayout,
      payoutRate: PAYOUT_RATE,
      payoutEligible: true,
      payoutVerified: storedPaise !== null && storedPaise === moneyToPaise(sellerPayout),
      payoutValidationError: storedPaise === moneyToPaise(sellerPayout) ? '' : 'Stored seller payout is missing or does not match 7% of face value.',
    };
  } catch (error) {
    return { faceValue: faceValueOf(coupon) ?? null, sellerPayout: null, payoutRate: PAYOUT_RATE,
      payoutEligible: false, payoutVerified: false, payoutValidationError: error.message };
  }
}

function verifyStoredPayout(coupon) {
  const info = couponPayoutInfo(coupon);
  if (!info.payoutEligible || !info.payoutVerified) {
    return { ok: false, code: info.payoutEligible ? 'PAYOUT_MISMATCH' : 'INVALID_FACE_VALUE', reason: info.payoutValidationError };
  }
  return { ok: true, amount: info.sellerPayout, faceValue: info.faceValue };
}

module.exports = { PAYOUT_RATE, PAYOUT_PRICING_MODEL, MIN_FACE_VALUE, MAX_FACE_VALUE,
  VALIDATION_MESSAGE, moneyToPaise, calculateSellerPayout, faceValueOf, couponPayoutInfo, verifyStoredPayout };
