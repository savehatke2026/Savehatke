// ============================================
// SaveHatke — Email OTP Security Service
// ============================================
// Production OTP request/verify service. Everything is enforced server-side;
// nothing the browser sends is trusted.
//
// Identity model
// ──────────────
//   limitKey    canonical email (lower-cased, +tag stripped, gmail dots
//               folded) → the PRIMARY rate-limit bucket. Alias tricks such as
//               "me+1@gmail.com" or "m.e@gmail.com" all collapse into the
//               same bucket, so an attacker cannot reset their counters by
//               reshaping the address.
//   userIdEmail userId + canonical email → binds the code to the intended
//               account. A code can only be consumed by the same account it
//               was issued for.
//   ipAddress   independent abuse layer, so creating fresh accounts/emails
//               does not buy more codes from one machine.
//
// Limits (all rolling windows, all server-side)
// ─────────────────────────────────────────────
//   60 s   cooldown between two requests for the same limitKey
//   5      requests per 1 hour     → blocked until the window rolls off
//   3 more once eligible again     → falls out of the 8-per-24h ceiling
//   8      requests per 24 hours   → "Today's maximum OTP request limit has
//                                     been reached. Please try again after
//                                     24 hours."
//   15/h and 40/24h per IP address (abuse layer)
//   5 m    OTP lifetime, 5 verification attempts per code
//
// Race-condition safety on an append-only store
// ─────────────────────────────────────────────
// Google Sheets has no transactions, so a two-phase CLAIM protocol is used
// instead of a read-then-write check, which is what actually makes concurrent
// requests safe:
//
//   1. read the ledger fresh (never from cache) and reject anything that is
//      already obviously over the line — the cheap path, no write at all;
//   2. APPEND a claim row (status 'pending');
//   3. read the ledger fresh again and rank our own claim against every other
//      claim in the window using a total order (requestedAt, then id). If our
//      rank is at or past the ceiling, we lost the race: the claim is voided
//      (status 'refused', hash wiped so the code is dead) and the caller is
//      refused.
//
// Concurrent requests therefore all land, all observe the same total order,
// and only the first N survive — regardless of how many server instances are
// running. In-process mutexes are kept as a fast path so a single instance
// usually never has to void anything.
//
// Codes are never stored in plaintext: only a bcrypt hash is written, and it
// is wiped as soon as the row stops being usable.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./googleSheets');

// ── Constants ───────────────────────────────────────────────────────────────
const OTP_LENGTH = 6;
const OTP_EXPIRY_MS = 5 * 60 * 1000;            // 5 minutes
const COOLDOWN_MS = 60 * 1000;                   // 60 seconds
const HOURLY_WINDOW_MS = 60 * 60 * 1000;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_HOURLY_REQUESTS = 5;                   // phase 1 ceiling
const MAX_DAILY_REQUESTS = 8;                    // phase 1 (5) + phase 2 (3)
const MAX_VERIFY_ATTEMPTS = 5;                   // per issued code
const MAX_IP_HOURLY_REQUESTS = 15;
const MAX_IP_DAILY_REQUESTS = 40;
const MAX_IP_VERIFY_FAILURES = 30;               // failed verifies per IP per hour
const BCRYPT_SALT_ROUNDS = 10;

// Statuses that do NOT count towards any limit: claims that lost the race or
// were voided administratively. Everything else counts, including codes the
// user never used — asking for a code is the metered action.
const VOID_STATUSES = new Set(['refused', 'void']);

// The single message the spec requires for the 24-hour ceiling.
const DAILY_LIMIT_MESSAGE =
  "Today's maximum OTP request limit has been reached. Please try again after 24 hours.";
// Deliberately identical whether the account exists, the code is wrong, the
// code expired or no code was ever issued — existence must not leak.
const GENERIC_VERIFY_ERROR =
  'That verification code is invalid or has expired. Please request a new one.';

// ── Identity / key helpers ──────────────────────────────────────────────────

/** Lower-case + trim. The literal address, used for display and delivery. */
function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

/**
 * Canonical form of an address, used as the PRIMARY rate-limit key.
 *
 * Sub-addressing ("user+anything@") and Gmail's ignored dots are both folded
 * away, because both deliver to the same inbox — counting them separately
 * would hand an attacker unlimited codes for one mailbox. Domains that treat
 * dots as significant keep them.
 */
const DOTLESS_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function canonicalEmail(email) {
  const clean = normalizeEmail(email);
  const at = clean.lastIndexOf('@');
  if (at <= 0) return clean;

  let local = clean.slice(0, at);
  const domain = clean.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (DOTLESS_DOMAINS.has(domain)) local = local.replace(/\./g, '');

  return `${local}@${domain}`;
}

/**
 * Composite userId + canonical email key. This is what binds a code to an
 * account. With no userId yet (first-ever sign-in for an address) it degrades
 * to the canonical email, which both /send-otp and /verify-otp can reproduce.
 */
function buildUserIdEmailKey(userId, email) {
  const canon = canonicalEmail(email);
  const id = String(userId || '').toLowerCase().trim();
  return id ? `${id}|${canon}` : canon;
}

// ── Per-key mutex (single-instance fast path) ───────────────────────────────
// Serializes same-key work inside one process so the claim protocol below
// almost never has to void a row. It is a performance aid, not the safety
// mechanism — correctness across instances comes from the claim ranking.
const locks = new Map();

async function withLock(key, fn) {
  const k = String(key || '');
  while (locks.has(k)) {
    await locks.get(k).catch(() => {});
  }
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  locks.set(k, held);
  try {
    return await fn();
  } finally {
    locks.delete(k);
    release();
  }
}

// ── OTP generation ──────────────────────────────────────────────────────────

/**
 * Cryptographically secure 6-digit code. crypto.randomInt is uniform and
 * unpredictable; Math.random is neither and must never mint credentials.
 */
function generateOTP() {
  const min = 10 ** (OTP_LENGTH - 1);
  const max = 10 ** OTP_LENGTH;
  return String(crypto.randomInt(min, max));
}

/** Constant-time compare of the submitted code against the stored bcrypt hash. */
async function matchesHash(otpInput, hash) {
  if (!hash) return false;
  try {
    return await bcrypt.compare(String(otpInput || ''), hash);
  } catch (e) {
    return false;
  }
}

// ── Ledger access ───────────────────────────────────────────────────────────
// Every read below is FRESH (cache-bypassing). A cached snapshot would let two
// requests a second apart both see the same counts and both pass a limit only
// one should.

function rowTime(row) {
  const t = new Date(row && row.requestedAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Rows that count towards a limit — everything except voided claims. */
function counts(row) {
  return !VOID_STATUSES.has(String((row && row.status) || '').toLowerCase());
}

/**
 * Total order shared by every instance: chronological, with the row id as the
 * tie-breaker so two claims written in the same millisecond still rank
 * deterministically. This is what makes the concurrent case resolve the same
 * way no matter who is looking.
 */
function byClaimOrder(a, b) {
  const d = rowTime(a) - rowTime(b);
  return d !== 0 ? d : String(a.id || '').localeCompare(String(b.id || ''));
}

async function allRows() {
  return db.getRowsFresh(db.SHEETS.OTP_REQUESTS).catch(() => []);
}

/**
 * Requests inside `windowMs` for one limit key.
 *
 * Matching is deliberately wide: the canonical `limitKey` column, plus rows
 * written before that column existed whose `email` canonicalizes to the same
 * value. Rolling out the new column must not reset anyone's counters.
 */
function requestsForLimitKey(rows, limitKey, windowMs, now) {
  const cutoff = now - windowMs;
  return rows.filter((r) => {
    if (!counts(r)) return false;
    if (rowTime(r) < cutoff) return false;
    const rowKey = r.limitKey ? String(r.limitKey).toLowerCase() : canonicalEmail(r.email);
    return rowKey === limitKey;
  });
}

function requestsForIP(rows, ip, windowMs, now) {
  const cutoff = now - windowMs;
  const clean = String(ip || '').trim();
  if (!clean || clean === 'unknown') return [];
  return rows.filter((r) => counts(r) && rowTime(r) >= cutoff && String(r.ipAddress || '').trim() === clean);
}

/** Newest first. */
function newestFirst(list) {
  return [...list].sort((a, b) => rowTime(b) - rowTime(a));
}

/**
 * Patch a ledger row. Writes are best-effort by design: a failed audit update
 * must never take down authentication, and every security decision re-reads
 * the ledger rather than trusting an in-memory copy.
 */
async function patchRow(id, patch) {
  try {
    await db.updateRow(db.SHEETS.OTP_REQUESTS, 'id', id, patch);
    return true;
  } catch (e) {
    console.warn(`[otp] ledger update failed for ${id}:`, e.message);
    return false;
  }
}

/**
 * Retire a row: clears otpHash so the code behind it is unusable even if the
 * spreadsheet later leaks, and records why.
 */
async function retireRow(id, status, reason = '') {
  return patchRow(id, { status, otpHash: '', blockReason: reason });
}

/**
 * Structured security log. Codes and hashes are never logged — only the
 * decision, the identifiers and the counts, which is what an incident review
 * actually needs.
 */
function audit(event, fields) {
  const parts = Object.entries(fields || {})
    .filter(([, v]) => v !== undefined && v !== '' && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`[otp] ${event} ${parts}`);
}

// ── Limit evaluation ────────────────────────────────────────────────────────

function refuse(error, retryAfterSeconds, reason) {
  return {
    success: false,
    error,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds || 1)),
    // Same value under both names — callers/clients in this codebase read
    // either, and a rate limit that silently reads as `undefined` is worse
    // than a duplicated field.
    retryAfter: Math.max(1, Math.ceil(retryAfterSeconds || 1)),
    reason,
  };
}

/** Seconds until the oldest request in `list` rolls out of `windowMs`. */
function secondsUntilWindowFrees(list, windowMs, now) {
  if (!list.length) return 1;
  const oldest = Math.min(...list.map(rowTime));
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}

/**
 * Apply every ceiling, in the order the spec lays out: cooldown → 1 hour →
 * 24 hours → IP. Returns a refusal, or null when the request may proceed.
 *
 * `claim` is set on the post-append pass: instead of counting rows, each limit
 * ranks our own claim within the shared total order and refuses if it sits at
 * or beyond the ceiling. That converts "read, decide, write" (racy) into
 * "write, then agree on who was first" (safe).
 */
function evaluateLimits(rows, { limitKey, ipAddress, now, claim }) {
  const rank = (list) => {
    const ordered = [...list].sort(byClaimOrder);
    return ordered.findIndex((r) => r.id === claim.id);
  };

  // ── 1. 60-second cooldown ─────────────────────────────────────────────
  const recent = requestsForLimitKey(rows, limitKey, COOLDOWN_MS, now)
    .filter((r) => r.id !== claim.id);
  if (recent.length) {
    // Someone (possibly this same user in a parallel tab) already holds the
    // cooldown window. Whoever ranks first keeps it.
    const ours = rowTime(claim);
    const earlier = recent.filter((r) => byClaimOrder(r, claim) < 0);
    if (earlier.length) {
      const newest = Math.max(...earlier.map(rowTime));
      const wait = Math.max(1, Math.ceil((newest + COOLDOWN_MS - Math.max(now, ours)) / 1000));
      return refuse(
        `Please wait ${wait} second${wait === 1 ? '' : 's'} before requesting a new code.`,
        wait,
        'cooldown',
      );
    }
  }

  // ── 2. Rolling 1-hour limit — 5 requests ──────────────────────────────
  const hourly = requestsForLimitKey(rows, limitKey, HOURLY_WINDOW_MS, now);
  const hourlyRank = rank(hourly);
  const hourlyPosition = hourlyRank === -1 ? hourly.length : hourlyRank;

  // ── 3. Rolling 24-hour limit — 8 requests (hard stop) ─────────────────
  // Checked before the hourly refusal is returned so the 24-hour message
  // always wins: once the day is spent, "wait for the hour" would be a lie.
  const daily = requestsForLimitKey(rows, limitKey, DAILY_WINDOW_MS, now);
  const dailyRank = rank(daily);
  const dailyPosition = dailyRank === -1 ? daily.length : dailyRank;

  if (dailyPosition >= MAX_DAILY_REQUESTS) {
    return refuse(
      DAILY_LIMIT_MESSAGE,
      secondsUntilWindowFrees(daily, DAILY_WINDOW_MS, now),
      'daily_limit',
    );
  }

  if (hourlyPosition >= MAX_HOURLY_REQUESTS) {
    const wait = secondsUntilWindowFrees(hourly, HOURLY_WINDOW_MS, now);
    const minutes = Math.ceil(wait / 60);
    return refuse(
      `You have reached the limit of ${MAX_HOURLY_REQUESTS} verification codes per hour. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      wait,
      'hourly_limit',
    );
  }

  // ── 4. IP abuse layer ─────────────────────────────────────────────────
  // Stops the "new email / new account each time" bypass: the per-user
  // ceilings above are per mailbox, these are per machine.
  const ipHourly = requestsForIP(rows, ipAddress, HOURLY_WINDOW_MS, now);
  const ipHourlyRank = rank(ipHourly);
  if (ipHourly.length && (ipHourlyRank === -1 ? ipHourly.length : ipHourlyRank) >= MAX_IP_HOURLY_REQUESTS) {
    return refuse(
      'Too many verification codes have been requested from this network. Please try again later.',
      secondsUntilWindowFrees(ipHourly, HOURLY_WINDOW_MS, now),
      'ip_hourly_limit',
    );
  }

  const ipDaily = requestsForIP(rows, ipAddress, DAILY_WINDOW_MS, now);
  const ipDailyRank = rank(ipDaily);
  if (ipDaily.length && (ipDailyRank === -1 ? ipDaily.length : ipDailyRank) >= MAX_IP_DAILY_REQUESTS) {
    return refuse(
      'Too many verification codes have been requested from this network. Please try again later.',
      secondsUntilWindowFrees(ipDaily, DAILY_WINDOW_MS, now),
      'ip_daily_limit',
    );
  }

  return {
    success: true,
    hourlyCount: hourlyPosition + 1,
    dailyCount: dailyPosition + 1,
  };
}

// ── Request OTP ─────────────────────────────────────────────────────────────

/**
 * Issue a fresh code for an account, or refuse with the reason.
 *
 * `userId` and `ipAddress` must be derived server-side by the caller; nothing
 * here trusts a value that came from the browser. A missing userId is normal
 * (first sign-in for an address) and simply keys the row on the canonical
 * email, which the verify path reproduces identically.
 *
 * Returns { success: true, otp, requestId, expiresAt, ... } or a refusal from
 * refuse() carrying `error` + `retryAfterSeconds`/`retryAfter`.
 */
async function requestOTP(userId, email, ipAddress) {
  const cleanEmail = normalizeEmail(email);
  const limitKey = canonicalEmail(cleanEmail);
  const userIdEmail = buildUserIdEmailKey(userId, cleanEmail);
  const ip = String(ipAddress || '').trim() || 'unknown';

  if (!limitKey || !limitKey.includes('@')) {
    return refuse('Please enter a valid email address.', 1, 'invalid_email');
  }

  // The lock only serializes same-mailbox work inside this process; the claim
  // ranking below is what keeps multiple instances honest.
  return withLock(`req:${limitKey}`, async () => {
    // ── Phase 1: cheap pre-check, no write ────────────────────────────────
    // A claim with an id that cannot match any row makes every rank() fall
    // back to "count the window", i.e. plain limit counting.
    const preNow = Date.now();
    const probe = { id: '\u0000probe', requestedAt: new Date(preNow).toISOString() };
    const pre = evaluateLimits(await allRows(), { limitKey, ipAddress: ip, now: preNow, claim: probe });
    if (!pre.success) {
      audit('request.refused', {
        limitKey, userId: userId || '-', ip, reason: pre.reason, retryAfter: pre.retryAfterSeconds,
      });
      return pre;
    }

    // ── Phase 2: append the claim (plaintext code never leaves this scope) ─
    const otp = generateOTP();
    const otpHash = await bcrypt.hash(otp, BCRYPT_SALT_ROUNDS);
    const now = Date.now();
    const claim = {
      id: uuidv4(),
      userId: String(userId || ''),
      userIdEmail,
      limitKey,
      email: cleanEmail,
      ipAddress: ip,
      otpHash,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + OTP_EXPIRY_MS).toISOString(),
      verifiedAt: '',
      status: 'pending',
      requestNumber: String(pre.dailyCount),
      dailyRequestCount: String(pre.dailyCount),
      hourlyRequestCount: String(pre.hourlyCount),
      verifyAttempts: '0',
      blockReason: '',
    };

    try {
      await db.appendRow(db.SHEETS.OTP_REQUESTS, claim);
    } catch (e) {
      console.error('[otp] could not record the request:', e.message);
      // No ledger row means no enforceable limit, so no code is handed out.
      return refuse('We could not send a verification code right now. Please try again.', 5, 'ledger_unavailable');
    }

    // ── Phase 3: re-read and rank our own claim ───────────────────────────
    const rows = await allRows();
    const verdict = evaluateLimits(rows, { limitKey, ipAddress: ip, now: Date.now(), claim });

    if (!verdict.success) {
      // We lost a concurrent race (or the window moved under us). Void the
      // claim so it neither counts nor works, then refuse.
      await retireRow(claim.id, 'refused', verdict.reason);
      audit('request.refused', {
        limitKey, userId: userId || '-', ip, reason: verdict.reason,
        retryAfter: verdict.retryAfterSeconds, raced: 1,
      });
      return verdict;
    }

    // Correct the stored counts to the authoritative post-append ranking.
    if (verdict.dailyCount !== pre.dailyCount || verdict.hourlyCount !== pre.hourlyCount) {
      await patchRow(claim.id, {
        requestNumber: String(verdict.dailyCount),
        dailyRequestCount: String(verdict.dailyCount),
        hourlyRequestCount: String(verdict.hourlyCount),
      });
    }

    // Only the newest code may be used: retire every older pending code bound
    // to the same account. They still count towards the limits — requesting is
    // the metered action, not using.
    const stale = rows.filter((r) => (
      r.id !== claim.id
      && String(r.status || '').toLowerCase() === 'pending'
      && (r.userIdEmail ? String(r.userIdEmail).toLowerCase() === userIdEmail : canonicalEmail(r.email) === limitKey)
    ));
    for (const row of stale) {
      await retireRow(row.id, 'superseded', 'newer code issued');
    }

    audit('request.issued', {
      requestId: claim.id, limitKey, userId: userId || '-', ip,
      hourly: `${verdict.hourlyCount}/${MAX_HOURLY_REQUESTS}`,
      daily: `${verdict.dailyCount}/${MAX_DAILY_REQUESTS}`,
      superseded: stale.length || undefined,
    });

    return {
      success: true,
      otp,                                  // caller emails it; never persisted
      requestId: claim.id,
      expiresAt: claim.expiresAt,
      expiresInSeconds: Math.round(OTP_EXPIRY_MS / 1000),
      cooldownSeconds: Math.round(COOLDOWN_MS / 1000),
      hourlyRequestCount: verdict.hourlyCount,
      dailyRequestCount: verdict.dailyCount,
      remainingHourly: Math.max(0, MAX_HOURLY_REQUESTS - verdict.hourlyCount),
      remainingDaily: Math.max(0, MAX_DAILY_REQUESTS - verdict.dailyCount),
    };
  });
}

// ── Verify OTP ──────────────────────────────────────────────────────────────

/** Failed verifications charged to one IP in the last hour. */
function ipVerifyFailures(rows, ip, now) {
  return requestsForIP(rows, ip, HOURLY_WINDOW_MS, now)
    .reduce((sum, r) => sum + (parseInt(r.verifyAttempts, 10) || 0), 0);
}

/**
 * Consume a code. Every failure path returns the exact same message, so the
 * response can never be used to probe whether an address has an account, has a
 * live code, or typed the wrong digits.
 *
 * Returns { valid: true, ... } or { valid: false, error: GENERIC_VERIFY_ERROR }.
 */
async function verifyOTP(userId, email, otpInput, ipAddress) {
  const cleanEmail = normalizeEmail(email);
  const limitKey = canonicalEmail(cleanEmail);
  const userIdEmail = buildUserIdEmailKey(userId, cleanEmail);
  const ip = String(ipAddress || '').trim() || 'unknown';
  const submitted = String(otpInput || '').replace(/\D/g, '');

  const reject = (reason, extra) => {
    audit('verify.failed', { limitKey, userId: userId || '-', ip, reason, ...(extra || {}) });
    return { valid: false, success: false, error: GENERIC_VERIFY_ERROR, reason };
  };

  if (!limitKey || submitted.length !== OTP_LENGTH) {
    return reject('malformed_input');
  }

  // Serialize per account so two parallel submissions cannot both consume the
  // same code (and so attempt counters cannot be lost to a write race).
  return withLock(`vrf:${userIdEmail}`, async () => {
    const now = Date.now();
    const rows = await allRows();

    // IP-level brute-force ceiling, independent of which account is targeted.
    if (ipVerifyFailures(rows, ip, now) >= MAX_IP_VERIFY_FAILURES) {
      return reject('ip_verify_blocked');
    }

    // Candidate codes: bound to userId + canonical email. Rows filed with an
    // empty userId are accepted for the same mailbox because sign-up issues a
    // code before the account row exists — the account cannot be chosen by the
    // client, so this does not widen who can consume the code.
    const candidates = newestFirst(rows.filter((r) => {
      if (String(r.status || '').toLowerCase() !== 'pending') return false;
      if (canonicalEmail(r.email) !== limitKey && String(r.limitKey || '').toLowerCase() !== limitKey) return false;
      const rowUser = String(r.userId || '').toLowerCase().trim();
      return !rowUser || rowUser === String(userId || '').toLowerCase().trim();
    }));

    if (!candidates.length) return reject('no_active_code');

    const row = candidates[0];

    const expiresAt = new Date(row.expiresAt).getTime();
    if (!Number.isNaN(expiresAt) && expiresAt <= now) {
      await retireRow(row.id, 'expired', 'code expired before use');
      return reject('expired', { requestId: row.id });
    }

    const attempts = parseInt(row.verifyAttempts, 10) || 0;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await retireRow(row.id, 'blocked', 'too many verification attempts');
      return reject('attempts_exhausted', { requestId: row.id });
    }

    if (!(await matchesHash(submitted, row.otpHash))) {
      const next = attempts + 1;
      if (next >= MAX_VERIFY_ATTEMPTS) {
        // Burn the code rather than leave a guessable row behind.
        await retireRow(row.id, 'blocked', 'too many verification attempts');
      } else {
        await patchRow(row.id, { verifyAttempts: String(next) });
      }
      return reject('wrong_code', { requestId: row.id, attempt: `${next}/${MAX_VERIFY_ATTEMPTS}` });
    }

    // Success: mark used and destroy the hash so the code is single-use even if
    // the ledger is read again a millisecond later. verifyAttempts is left as
    // it was — it is the failure counter the IP ceiling sums, and a correct
    // code is not a failure.
    await patchRow(row.id, {
      status: 'verified',
      verifiedAt: new Date().toISOString(),
      otpHash: '',
      blockReason: '',
    });

    audit('verify.success', {
      requestId: row.id, limitKey, userId: row.userId || userId || '-', ip,
    });

    return {
      valid: true,
      success: true,
      requestId: row.id,
      userId: row.userId || String(userId || ''),
      email: cleanEmail,
      limitKey,
    };
  });
}

module.exports = {
  requestOTP,
  verifyOTP,

  // Helpers other modules legitimately need
  canonicalEmail,
  buildUserIdEmailKey,

  // Limits, exported so routes/UI can describe them without redefining them
  OTP_EXPIRY_MS,
  COOLDOWN_MS,
  HOURLY_WINDOW_MS,
  DAILY_WINDOW_MS,
  MAX_HOURLY_REQUESTS,
  MAX_DAILY_REQUESTS,
  MAX_VERIFY_ATTEMPTS,
  MAX_IP_HOURLY_REQUESTS,
  MAX_IP_DAILY_REQUESTS,
  MAX_IP_VERIFY_FAILURES,
  DAILY_LIMIT_MESSAGE,
  GENERIC_VERIFY_ERROR,
};
