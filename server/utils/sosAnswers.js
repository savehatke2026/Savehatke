// ============================================
// SaveHatke — SOS Security Answer Handling
// ============================================
// Normalisation and comparison for security-question answers.
//
// The goal is to forgive formatting, not meaning. "Raju Das", "raju das",
// "  Raju   Das " and "RAJU DAS" are the same answer; "Raju" and "Raj Das" are
// not. There is no fuzzy matching, no edit distance and no partial credit —
// after normalisation the comparison is exact, against a bcrypt hash.
//
// Plaintext answers exist only inside a single function call. They are never
// stored, logged, echoed in a response or written to the audit trail.

const bcrypt = require('bcryptjs');

// Cost 12: answers are short and guessable-by-a-human secrets, so they get a
// slower hash than the session-token path uses.
const ANSWER_BCRYPT_ROUNDS = 12;

/**
 * Normalise a free-text answer.
 *   - Unicode NFKC, so composed and decomposed accents compare equal
 *   - trim, then collapse internal whitespace runs to one space
 *   - drop zero-width characters that copy-paste tends to smuggle in
 *   - fold the common apostrophe/dash variants onto ASCII
 *   - lowercase
 */
function normaliseText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Canonicalise a date answer to YYYY-MM-DD.
 *
 * Accepted, all day-first because that is how the questions are asked in India:
 *   04-11-2010, 04/11/2010, 4-11-2010, 4.11.2010, 04 11 2010
 * Also accepted: an ISO value from a native date input (2010-11-04), which is
 * unambiguous because the year comes first.
 *
 * Returns '' when the value is not a date this function is willing to read —
 * the caller treats that as a wrong answer rather than guessing.
 */
function normaliseDate(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';

  const iso = raw.match(/^(\d{4})[-/.\s](\d{1,2})[-/.\s](\d{1,2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return buildDate(y, m, d);
  }

  const dayFirst = raw.match(/^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{4})$/);
  if (dayFirst) {
    const [, d, m, y] = dayFirst;
    return buildDate(y, m, d);
  }

  return '';
}

function buildDate(y, m, d) {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return '';
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  // Reject impossible days (31 April, 30 February) rather than letting the Date
  // constructor roll them into the next month.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Normalise according to the question's configured kind. */
function normaliseAnswer(value, kind) {
  return kind === 'date' ? normaliseDate(value) : normaliseText(value);
}

/** Hash a normalised answer for storage. Returns '' for an empty answer. */
async function hashAnswer(value, kind) {
  const normalised = normaliseAnswer(value, kind);
  if (!normalised) return '';
  return bcrypt.hash(normalised, ANSWER_BCRYPT_ROUNDS);
}

/**
 * Compare a submitted answer against a stored hash. Always runs a bcrypt
 * comparison when a hash exists, so a wrong answer and an unanswerable question
 * take a similar amount of time.
 */
async function verifyAnswer(value, kind, storedHash) {
  const normalised = normaliseAnswer(value, kind);
  if (!storedHash) return false;
  if (!normalised) return false;
  try {
    return await bcrypt.compare(normalised, storedHash);
  } catch (e) {
    return false;
  }
}

/**
 * Pick `count` questions from an admin's enabled, answerable set.
 * Fisher-Yates with crypto randomness, server-side only. The caller never tells
 * the browser which questions were left out.
 */
function selectQuestions(questions, count) {
  const crypto = require('crypto');
  const pool = (questions || []).filter((q) => q && q.enabled !== false && q.answer_hash);
  const take = Math.max(1, Math.min(Number(count) || 5, pool.length));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

module.exports = {
  ANSWER_BCRYPT_ROUNDS,
  normaliseText,
  normaliseDate,
  normaliseAnswer,
  hashAnswer,
  verifyAnswer,
  selectQuestions,
};
