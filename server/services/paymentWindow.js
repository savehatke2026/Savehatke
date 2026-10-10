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

module.exports = {
  CUSTOMER_WINDOW_MS,
  VERIFICATION_WINDOW_MS,
  verificationDeadlineFor,
  phaseAt,
  parseFamAppTransactionTime,
  classifyTransactionTime,
};
