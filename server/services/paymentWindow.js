// ============================================
// SaveHatke — Payment verification window math (pure, no I/O)
// ============================================
// Two consecutive 10-minute periods for one payment session starting at T:
//
//   Timer 1 (customer-facing, unchanged):  T  →  payment_expires_at = T + 10m
//   Timer 2 (backend verification):        payment_expires_at → verification_deadline = T + 20m
//
// All instants are epoch milliseconds or ISO-8601 strings from the server clock.
// The browser clock is never consulted.

const CUSTOMER_WINDOW_MS = 10 * 60 * 1000;
const VERIFICATION_WINDOW_MS = 10 * 60 * 1000;

function toMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

/**
 * The backend deadline for a session that started at `startedAt`. Derived from
 * the persisted expiry, never recomputed from a browser value.
 */
function verificationDeadlineFor(paymentExpiresAt) {
  const expiry = toMs(paymentExpiresAt);
  if (!Number.isFinite(expiry)) return null;
  return new Date(expiry + VERIFICATION_WINDOW_MS).toISOString();
}

/**
 * Which phase a session is in at `nowMs`.
 *   'customer'     — before the customer timer expires
 *   'verification' — customer timer expired, backend window still open
 *   'closed'       — backend deadline has passed
 *   'unknown'      — required timestamps missing or unreadable (fail closed)
 */
function phaseAt({ paymentExpiresAt, verificationDeadline }, nowMs) {
  const expiry = toMs(paymentExpiresAt);
  const deadline = toMs(verificationDeadline);
  if (!Number.isFinite(expiry) || !Number.isFinite(deadline) || !Number.isFinite(nowMs)) return 'unknown';
  if (nowMs < expiry) return 'customer';
  if (nowMs < deadline) return 'verification';
  return 'closed';
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

/**
 * Decide whether a verified transaction happened inside the backend window,
 * using the ACTUAL transaction instant. The email arrival time is never passed
 * in here. Returns 'within' | 'after' | 'before_start' | 'unknown'.
 */
function classifyTransactionTime({ transactionAt, sessionStartedAt, verificationDeadline }) {
  const tx = toMs(transactionAt);
  const start = toMs(sessionStartedAt);
  const deadline = toMs(verificationDeadline);
  if (!Number.isFinite(tx) || !Number.isFinite(start) || !Number.isFinite(deadline)) return 'unknown';
  // Allow a small clock-skew grace before the session start, matching the
  // existing 5-minute pre-window tolerance in the settlement path.
  if (tx < start - 5 * 60 * 1000) return 'before_start';
  if (tx > deadline) return 'after';
  return 'within';
}

const START_GRACE_MS = 5 * 60 * 1000;

/**
 * Pure decision for one verified incoming credit against one candidate session.
 * Every input comes from the server: the transaction instant parsed from the
 * FamApp body (never the mailbox arrival time), the session's persisted fields,
 * and the payer-name comparison the caller already performed.
 *
 * Returns { action, reason } where action is:
 *   'settle'      – inside the verification window, session still PENDING
 *   'late_refund' – real transaction after verification_deadline, purchase not
 *                   fulfilled → one admin refund task for the full amount
 *   'review'      – needs a human (unreadable time, name mismatch, ambiguous
 *                   state, clock disagreement, already fulfilled, etc.)
 *   'ignore'      – the transaction predates this session, so it is not for it
 */
function decideIncomingCredit({
  transactionAt,
  sessionStatus,
  sessionCreatedAt,
  verificationDeadline,
  payerNameMatches,
  nowMs = Date.now(),
} = {}) {
  const status = String(sessionStatus || '').toUpperCase();
  const tx = toMs(transactionAt);
  const start = toMs(sessionCreatedAt);
  const deadline = toMs(verificationDeadline);

  if (!Number.isFinite(tx)) {
    return { action: 'review', reason: 'The transaction time could not be read from the FamApp email.' };
  }
  if (!Number.isFinite(start) || !Number.isFinite(deadline)) {
    return { action: 'review', reason: 'The session timing is incomplete; not attributed automatically.' };
  }
  if (tx < start - START_GRACE_MS) {
    return { action: 'ignore', reason: 'The transaction happened before this order was created.' };
  }
  if (!payerNameMatches) {
    return { action: 'review', reason: 'The payer name does not match the order buyer, or could not be read.' };
  }
  if (status === 'PAID') {
    return { action: 'review', reason: 'This order is already fulfilled; a second payment is routed to review, not refunded automatically.' };
  }
  if (tx <= deadline) {
    if (status === 'PENDING') return { action: 'settle', reason: 'Transaction is inside the verification window.' };
    // The window is still open but the session was already closed, which
    // released its coupon. Delivering now could hand out a coupon someone else
    // may hold, so a person decides.
    return { action: 'review', reason: `Transaction is inside the window but the session is ${status || 'unknown'}; routed to review.` };
  }
  // The transaction is after the verification deadline.
  if (nowMs < deadline) {
    return { action: 'review', reason: 'Server clock disagrees with the transaction time; routed to review.' };
  }
  if (status === 'PENDING' || status === 'EXPIRED' || status === 'CANCELLED') {
    return { action: 'late_refund', reason: 'Verified transaction occurred after the verification deadline; full refund due.' };
  }
  return { action: 'review', reason: `Unexpected session status ${status || 'unknown'}; routed to review.` };
}

module.exports = {
  CUSTOMER_WINDOW_MS,
  VERIFICATION_WINDOW_MS,
  verificationDeadlineFor,
  phaseAt,
  parseFamAppTransactionTime,
  classifyTransactionTime,
  decideIncomingCredit,
};
