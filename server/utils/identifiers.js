'use strict';

// ============================================================================
// SaveHatke — Canonical Identifier Generator
// ============================================================================
// ONE place that mints and validates every user/admin-facing financial
// identifier, so the whole system (frontend, backend, sheets, Supabase,
// emails, PDFs, exports, API responses) speaks exactly one format.
//
//   Order ID        SH-<TYPE>-YYYYMMDD-XXXXXX      (6-char random tail)
//   Transaction ID  TXN-YYYYMMDD-XXXXXXXX          (8-char random tail)
//
// <TYPE> is the 3-letter code for the transaction type:
//   PURCHASE      -> PUR   e.g. SH-PUR-20260926-A7K92P
//   REFUND        -> REF   e.g. SH-REF-20260926-M4D81Q
//   SELLER_PAYOUT -> PAY   e.g. SH-PAY-20260926-X9K31L
//
// RULES (see the product spec):
//   - Generated SERVER-SIDE ONLY. The browser never mints a final id.
//   - Cryptographically secure randomness (crypto.randomBytes), with rejection
//     sampling so every character is uniformly distributed (no modulo bias).
//   - Random tail uses UPPERCASE A-Z and 0-9 only. No lowercase, no spaces,
//     no punctuation.
//   - Order ID and Transaction ID are DIFFERENT identifiers and are never
//     stored in each other's field.
//   - Callers enforce uniqueness before insert via the *Unique* helpers.
//
// BACKWARD COMPATIBILITY: the old order code format was `SH-XXXXXX` (6 chars
// from an ambiguity-free alphabet). Historical rows keep it. The matcher/
// validators below recognise BOTH the new and the legacy format so in-flight
// payments still reconcile and old records still render.
// ============================================================================

const crypto = require('crypto');

// Full uppercase alphanumeric alphabet, per spec (A-Z, 0-9) = 36 symbols.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// transaction_type (stored, canonical) -> 3-letter order-id TYPE code.
const TYPE_TO_CODE = Object.freeze({
  PURCHASE: 'PUR',
  REFUND: 'REF',
  SELLER_PAYOUT: 'PAY',
});

// Reverse map, for turning a parsed order-id TYPE back into a transaction_type.
const CODE_TO_TYPE = Object.freeze({
  PUR: 'PURCHASE',
  REF: 'REFUND',
  PAY: 'SELLER_PAYOUT',
});

const TRANSACTION_TYPES = Object.freeze(Object.keys(TYPE_TO_CODE));
const ORDER_TYPE_CODES = Object.freeze(Object.values(TYPE_TO_CODE));

// ── Format regexes ──────────────────────────────────────────────────────────
// Anchored validators for a whole string.
const ORDER_ID_RE = /^SH-(PUR|REF|PAY)-(\d{8})-([A-Z0-9]{6})$/;
const TRANSACTION_ID_RE = /^TXN-(\d{8})-([A-Z0-9]{8})$/;
// Legacy order code: `SH-` + 6 chars from the old ambiguity-free alphabet.
const LEGACY_ORDER_CODE_RE = /^SH-[2-9A-HJKMNP-Z]{6}$/i;

// Order code as it appears *inside* free text (bank notification / UPI `tr`
// echo). Matches the new format first, then the legacy 6-char code. Used by the
// payment verifier to tie a notification back to the order that created it.
// NOTE: keep the new-format branch first so `SH-PUR-...` is never mis-read as a
// legacy 6-char code.
const ORDER_CODE_IN_TEXT_RE =
  /\bSH-(?:(?:PUR|REF|PAY)-\d{8}-[A-Z0-9]{6}|[2-9A-HJKMNP-Z]{6})\b/i;

// ── Random tail ───────────────────────────────────────────────────────────
// Uniform, unbiased random string over ALPHABET using rejection sampling.
// 256 is not a multiple of 36, so a naive `byte % 36` over-weights the first
// (256 mod 36 = 4) symbols. We discard bytes at/above the largest multiple of
// 36 that fits in a byte (252) to keep the distribution flat.
function randomTail(length) {
  const n = ALPHABET.length; // 36
  const cutoff = Math.floor(256 / n) * n; // 252
  let out = '';
  while (out.length < length) {
    const need = length - out.length;
    const bytes = crypto.randomBytes(need + 8); // small over-fetch to limit loops
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      const b = bytes[i];
      if (b < cutoff) out += ALPHABET[b % n];
    }
  }
  return out;
}

// ── Date part ───────────────────────────────────────────────────────────────
// YYYYMMDD for the id, formatted in India Standard Time (the business runs in
// IST) so the embedded date matches the date shown to buyers/admins. Derived
// from the SAME instant the record's created_at uses, when the caller passes it.
function yyyymmdd(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const when = Number.isFinite(d.getTime()) ? d : new Date();
  try {
    // en-CA yields ISO-like YYYY-MM-DD; strip the dashes.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(when);
    return parts.replace(/-/g, '');
  } catch (e) {
    // Fallback: shift UTC by +5:30 manually and read the UTC date parts.
    const ist = new Date(when.getTime() + 5.5 * 60 * 60 * 1000);
    const y = ist.getUTCFullYear();
    const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
    const day = String(ist.getUTCDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }
}

// ── Minting ───────────────────────────────────────────────────────────────
function typeCodeFor(transactionType) {
  const code = TYPE_TO_CODE[String(transactionType || '').toUpperCase()];
  if (!code) {
    throw new Error(
      `identifiers: unknown transaction type "${transactionType}". ` +
      `Expected one of ${TRANSACTION_TYPES.join(', ')}.`
    );
  }
  return code;
}

/** Mint one Order ID for the given transaction type. Not yet uniqueness-checked. */
function makeOrderId(transactionType, { date = new Date() } = {}) {
  return `SH-${typeCodeFor(transactionType)}-${yyyymmdd(date)}-${randomTail(6)}`;
}

/** Mint one Transaction ID. Not yet uniqueness-checked. */
function makeTransactionId({ date = new Date() } = {}) {
  return `TXN-${yyyymmdd(date)}-${randomTail(8)}`;
}

// ── Uniqueness-enforcing helpers ────────────────────────────────────────────
// Two flavours: a synchronous one against an in-memory Set (for callers that
// already read all rows, e.g. paymentStore.createOrder), and an async one
// against an `isTaken(id) => Promise<bool>` predicate.

function generateUniqueOrderIdSync(transactionType, takenSet, { date = new Date(), maxAttempts = 12 } = {}) {
  const taken = takenSet instanceof Set ? takenSet : new Set(takenSet || []);
  for (let i = 0; i < maxAttempts; i++) {
    const id = makeOrderId(transactionType, { date });
    if (!taken.has(id)) return id;
  }
  throw new Error('identifiers: could not mint a unique Order ID after retries.');
}

function generateUniqueTransactionIdSync(takenSet, { date = new Date(), maxAttempts = 12 } = {}) {
  const taken = takenSet instanceof Set ? takenSet : new Set(takenSet || []);
  for (let i = 0; i < maxAttempts; i++) {
    const id = makeTransactionId({ date });
    if (!taken.has(id)) return id;
  }
  throw new Error('identifiers: could not mint a unique Transaction ID after retries.');
}

async function generateUniqueOrderId(transactionType, isTaken, { date = new Date(), maxAttempts = 12 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const id = makeOrderId(transactionType, { date });
    // eslint-disable-next-line no-await-in-loop
    if (!(typeof isTaken === 'function' && (await isTaken(id)))) return id;
  }
  throw new Error('identifiers: could not mint a unique Order ID after retries.');
}

async function generateUniqueTransactionId(isTaken, { date = new Date(), maxAttempts = 12 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const id = makeTransactionId({ date });
    // eslint-disable-next-line no-await-in-loop
    if (!(typeof isTaken === 'function' && (await isTaken(id)))) return id;
  }
  throw new Error('identifiers: could not mint a unique Transaction ID after retries.');
}

// ── Validation / inspection ─────────────────────────────────────────────────
function isStandardOrderId(value) {
  return ORDER_ID_RE.test(String(value || ''));
}

function isLegacyOrderCode(value) {
  return LEGACY_ORDER_CODE_RE.test(String(value || ''));
}

/** True for either the new format or the legacy `SH-XXXXXX` code. */
function isAnyOrderCode(value) {
  return isStandardOrderId(value) || isLegacyOrderCode(value);
}

function isTransactionId(value) {
  return TRANSACTION_ID_RE.test(String(value || ''));
}

/** The transaction_type for a standard Order ID (PURCHASE/REFUND/SELLER_PAYOUT), or ''. */
function orderIdTransactionType(value) {
  const m = ORDER_ID_RE.exec(String(value || ''));
  return m ? CODE_TO_TYPE[m[1]] : '';
}

/** Pull the first order code (new or legacy) out of free text; '' if none. */
function extractOrderCodeFromText(text) {
  const m = String(text || '').match(ORDER_CODE_IN_TEXT_RE);
  if (!m) return '';
  // Normalise: legacy codes are stored uppercase; new codes are already upper.
  return m[0].toUpperCase();
}

module.exports = {
  ALPHABET,
  TYPE_TO_CODE,
  CODE_TO_TYPE,
  TRANSACTION_TYPES,
  ORDER_TYPE_CODES,
  ORDER_ID_RE,
  TRANSACTION_ID_RE,
  LEGACY_ORDER_CODE_RE,
  ORDER_CODE_IN_TEXT_RE,
  typeCodeFor,
  makeOrderId,
  makeTransactionId,
  generateUniqueOrderId,
  generateUniqueTransactionId,
  generateUniqueOrderIdSync,
  generateUniqueTransactionIdSync,
  isStandardOrderId,
  isLegacyOrderCode,
  isAnyOrderCode,
  isTransactionId,
  orderIdTransactionType,
  extractOrderCodeFromText,
};
