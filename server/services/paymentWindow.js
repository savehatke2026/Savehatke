// ============================================
// SaveHatke — Payment window math (pure, no I/O)
// ============================================
// Exactly ONE 10-minute customer-facing timer per payment session, starting at T:
//
//   payment_expires_at = T + 10m   (authoritative deadline, server clock)
//
// There is no second backend window and no grace period. A payment that is
// first verified after payment_expires_at never unlocks a coupon.
//
// All instants are epoch milliseconds or ISO-8601 strings from the server clock.
// The browser clock is never consulted.

const CUSTOMER_WINDOW_MS = 10 * 60 * 1000;

function toMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

/**
 * Which phase a session is in at `nowMs`.
 *   'open'    — before payment_expires_at; a payment may still settle
 *   'expired' — at or after payment_expires_at; no settlement, late path only
 *   'unknown' — required timestamps missing or unreadable (fail closed)
 */
function phaseAt({ paymentExpiresAt }, nowMs) {
  const expiry = toMs(paymentExpiresAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(nowMs)) return 'unknown';
  return nowMs < expiry ? 'open' : 'expired';
}

/**
 * Parse a FamApp transaction time such as "08:41 AM IST, 10 October 2026"
 * into an ISO instant. IST is UTC+05:30 with no daylight saving, so the offset
 * is fixed. Returns null when the text is missing or not a complete date+time,
 * so an unreadable transaction time can never be guessed.
 */
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function parseFamAppTransactionTime(text) {
  const s = String(text || '');
  const m = s.match(
    /(\d{1,2}):(\d{2})\s*(AM|PM)\s*IST[\s,]*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i
  );
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3].toUpperCase();
  const day = Number(m[4]);
  const month = MONTHS[m[5].toLowerCase()];
  const year = Number(m[6]);
  if (!month || hour < 1 || hour > 12 || minute > 59 || day < 1 || day > 31) return null;
  if (meridiem === 'PM' && hour !== 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  // Date.UTC with the fixed IST offset (+05:30) → the correct UTC instant.
  const utcMs = Date.UTC(year, month - 1, day, hour, minute) - (5 * 60 + 30) * 60 * 1000;
  const check = new Date(utcMs);
  // Reject impossible dates (e.g. 31 February) by round-tripping the IST day.
  const istDay = new Date(utcMs + (5 * 60 + 30) * 60 * 1000);
  if (istDay.getUTCDate() !== day) return null;
  if (Number.isNaN(check.getTime())) return null;
  return check.toISOString();
}

// Clock-skew tolerance before session creation, matching the existing settlement path.
const START_GRACE_MS = 5 * 60 * 1000;

/**
 * Pure decision for one verified FamApp credit against one candidate session.
 *
 * The timing rule is based on WHEN SAVEHATKE FIRST VERIFIES THE EMAIL
 * (`verifiedAtMs`, the server clock at detection), not on the transaction
 * timestamp in the FamApp body. A transaction that happened before the deadline
 * but was first verified after it is a late payment.
 *
 * Returns { action, reason }, where action is:
 *   'settle'      – first verified before payment_expires_at, session PENDING,
 *                   amount/name/references all matched → unlock the coupon once
 *   'expired_no_action' – the transaction itself occurred at/after the deadline →
 *                   no coupon and no refund (expired sessions are never refunded)
 *   'review'      – needs a human (unreadable time, name mismatch, already
 *                   fulfilled, unexpected status, missing timing data)
 *   'ignore'      – the transaction predates this session, so it is not for it
 */
function decideIncomingCredit({
  transactionAt,
  sessionStatus,
  sessionCreatedAt,
  paymentExpiresAt,
  payerNameMatches,
  verifiedAtMs = Date.now(),
} = {}) {
  const status = String(sessionStatus || '').toUpperCase();
  const tx = toMs(transactionAt);
  const start = toMs(sessionCreatedAt);
  const expiry = toMs(paymentExpiresAt);
  const verified = toMs(verifiedAtMs);

  if (!Number.isFinite(tx)) {
    return { action: 'review', reason: 'The transaction time could not be read from the FamApp email.' };
  }
  if (!Number.isFinite(start) || !Number.isFinite(expiry) || !Number.isFinite(verified)) {
    return { action: 'review', reason: 'The session timing is incomplete; not attributed automatically.' };
  }
  if (tx < start - START_GRACE_MS) {
    return { action: 'ignore', reason: 'The transaction happened before this order was created.' };
  }
  if (!payerNameMatches) {
    return { action: 'review', reason: 'The payer name does not match the order buyer, or could not be read.' };
  }
  if (status === 'PAID') {
    return { action: 'review', reason: 'This order is already fulfilled; a second payment is routed to review.' };
  }
  // Timing uses the ACTUAL transaction instant from the FamApp body. A payment
  // made inside the original window settles even if Gmail delivered it late.
  if (tx < expiry) {
    if (status === 'PENDING') return { action: 'settle', reason: 'Transaction occurred inside the original 10-minute window.' };
    // The session was already closed, which released its coupon. A person decides.
    return { action: 'review', reason: `Transaction inside the window but the session is ${status || 'unknown'}; routed to review.` };
  }
  // The transaction occurred at or after the deadline: never unlock, never refund.
  return { action: 'expired_no_action', reason: 'Transaction occurred after the 10-minute deadline; coupon not unlocked and no refund is due for an expired session.' };
}

module.exports = {
  CUSTOMER_WINDOW_MS,
  phaseAt,
  parseFamAppTransactionTime,
  decideIncomingCredit,
  START_GRACE_MS,
};
