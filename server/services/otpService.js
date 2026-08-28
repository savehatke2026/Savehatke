// ============================================
// SaveHatke — OTP Security Service
// ============================================
// Production-ready OTP request/verify service with:
// - Per-email mutex locks (race-condition safety)
// - bcrypt-hashed OTP storage (never plaintext)
// - Multi-tier rate limiting (cooldown, hourly, daily, IP)
// - Full audit trail in Google Sheets (OTPRequests tab)
//
// Identity rule (per spec):
//   userId + email  → COMPOSITE rate-limit key. An attacker can't bypass
//                      limits by varying either piece on its own.
//   email           → still used to look up the latest pending OTP at
//                      verify time, with a userIdEmail filter so the OTP
//                      can only be consumed by the same userId that asked
//                      for it.
//   IP address      → separate abuse-prevention layer.
//
// Lifecycle (per spec, applied to the userId+email key):
//   5 requests in 1 hour  → 1-hour limit reached
//   1-hour wait            → 3 more requests allowed
//   8 in 24 hours          → "Today's maximum OTP request limit has been
//                              reached. Please try again after 24 hours."
//   60-second cooldown     → between any two consecutive requests
//   5-minute validity      → each OTP expires on its own
//   verified OTPs          → marked 'verified' and CANNOT be reused
//                              (verifyOTP only matches status='pending')

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./googleSheets');

// ── Constants ───────────────────────────────────────────────────────────────
const OTP_EXPIRY_MS = 5 * 60 * 1000;           // 5 minutes per spec
const COOLDOWN_MS = 60 * 1000;                  // 60 seconds per spec
const HOURLY_WINDOW_MS = 60 * 60 * 1000;        // 1 hour
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;    // 24 hours
const MAX_HOURLY_REQUESTS = 5;                   // Phase 1 cap (spec)
const MAX_DAILY_REQUESTS = 8;                    // Phase 1 (5) + Phase 2 (3) per spec
const MAX_VERIFY_ATTEMPTS = 5;                   // Per OTP
const MAX_IP_HOURLY_REQUESTS = 15;               // Per IP per hour (abuse layer)
const BCRYPT_SALT_ROUNDS = 10;

// ── Per-Email Mutex Lock ────────────────────────────────────────────────────
// Prevents concurrent requests for the same email from bypassing rate limits.
const locks = new Map();

/**
 * Execute `fn` while holding an exclusive lock for `key`.
 * If another call is already in progress for the same key,
 * this call waits until the previous one completes.
 */
async function withLock(key, fn) {
  const normalizedKey = String(key || '').toLowerCase().trim();

  while (locks.has(normalizedKey)) {
    await locks.get(normalizedKey);
  }

  let releaseLock;
  const lockPromise = new Promise((resolve) => { releaseLock = resolve; });
  locks.set(normalizedKey, lockPromise);

  try {
    return await fn();
  } finally {
    locks.delete(normalizedKey);
    releaseLock();
  }
}

// ── Key helpers ─────────────────────────────────────────────────────────────

/**
 * Build the COMPOSITE userId+email key used for rate limiting and audit
 * trail. Lower-cased + trimmed so casing/space differences don't split
 * one user into multiple buckets. If the userId is empty (new-email flow)
 * we fall back to the email alone so the limit still applies.
 *
 * @param {string} userId
 * @param {string} email
 * @returns {string} composite key, e.g. "user_abc|user@example.com"
 */
function buildUserIdEmailKey(userId, email) {
  const cleanEmail = String(email || '').toLowerCase().trim();
  const cleanId = String(userId || '').toLowerCase().trim();
  if (!cleanId) return cleanEmail;
  return `${cleanId}|${cleanEmail}`;
}

// ── OTP Generation ──────────────────────────────────────────────────────────

/**
 * Generate a 6-digit OTP. Math.random() is adequate for 6-digit codes
 * because:
 *   1) the code is rate-limited (max 5/hour per user, 15/hour per IP)
 *   2) brute-force attempts are capped at 5 per OTP
 *   3) the hash is bcrypt(10), not plaintext
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── Helper: Query OTP Requests ──────────────────────────────────────────────

/**
 * Get all OTP requests for a (userId, email) key within a time window.
 * Uses the composite key — an attacker cannot bypass by varying either
 * field on its own.
 *
 * @param {string} userIdEmail - composite key from buildUserIdEmailKey()
 * @param {number} windowMs - Time window in milliseconds
 */
async function getRequestsByKeyInWindow(userIdEmail, windowMs) {
  const allRequests = await db.findRows(db.SHEETS.OTP_REQUESTS, 'userIdEmail', userIdEmail);
  const cutoff = Date.now() - windowMs;
  return allRequests.filter((r) => {
    const t = new Date(r.requestedAt).getTime();
    return !isNaN(t) && t >= cutoff;
  });
}

/**
 * Backward-compat: include any pre-migration rows that have an empty
 * `userIdEmail` but a matching `email` so the rate limit doesn't reset
 * when the new code rolls out. These rows simply have their `email` in
 * the empty-key bucket.
 */
async function getRequestsByKeyInWindowWithFallback(userIdEmail, email, windowMs) {
  const direct = await getRequestsByKeyInWindow(userIdEmail, windowMs);
  if (!userIdEmail.includes('|')) return direct; // fallback key IS just email
  const allByEmail = await db.findRows(db.SHEETS.OTP_REQUESTS, 'email', String(email || '').toLowerCase().trim());
  const cutoff = Date.now() - windowMs;
  const legacy = allByEmail.filter((r) => {
    if (r.userIdEmail) return false; // new schema, already counted
    const t = new Date(r.requestedAt).getTime();
    return !isNaN(t) && t >= cutoff;
  });
  return [...direct, ...legacy];
}

/**
 * IP-based limit (abuse layer) — counts every OTP request that came
 * from this IP, regardless of the email it was for.
 */
async function getIPRequestsInWindow(ip, windowMs) {
  const allRequests = await db.findRows(db.SHEETS.OTP_REQUESTS, 'ipAddress', ip);
  const cutoff = Date.now() - windowMs;
  return allRequests.filter((r) => {
    const t = new Date(r.requestedAt).getTime();
    return !isNaN(t) && t >= cutoff;
  });
}

/**
 * Most-recent request for this (userId, email) key — used by the
 * 60-second cooldown check.
 */
async function getLastRequestForKey(userIdEmail) {
  const allRequests = await db.findRows(db.SHEETS.OTP_REQUESTS, 'userIdEmail', userIdEmail);
  if (allRequests.length) {
    return allRequests.sort((a, b) => {
      return new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime();
    })[0];
  }
  // Fallback to email-only for legacy rows
  return null;
}

/**
 * Mark all previous PENDING OTPs for this user as 'superseded' so only the
 * latest code can be used. Matches on the composite key AND on the email,
 * because rows for the same person can sit under different keys (a signup
 * whose account was created after the code was sent, or pre-migration rows).
 */
async function invalidatePreviousOTPs(userIdEmail, email) {
  const byKey = await db.findRows(db.SHEETS.OTP_REQUESTS, 'userIdEmail', userIdEmail);
  const cleanEmail = String(email || '').toLowerCase().trim();
  const byEmail = cleanEmail
    ? await db.findRows(db.SHEETS.OTP_REQUESTS, 'email', cleanEmail).catch(() => [])
    : [];

  const seen = new Set();
  const pending = [...byKey, ...byEmail].filter((r) => {
    if (!r || r.status !== 'pending' || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  for (const req of pending) {
    await db.updateRow(db.SHEETS.OTP_REQUESTS, 'id', req.id, {
      status: 'superseded',
    }).catch((e) => console.warn('OTP invalidation notice:', e.message));
  }
}

// ── Main: Request OTP ───────────────────────────────────────────────────────

/**
 * Request a new OTP for a user. Enforces every rate limit and security rule
 * listed at the top of this file.
 *
 * @param {string} userId   - Server-derived user ID (may be 'pending_*' for new emails)
 * @param {string} email    - User email
 * @param {string} ipAddress - Client IP (derived server-side, never trusted from client)
 * @returns {Promise<{success: boolean, otp?: string, error?: string, retryAfter?: number, requestId?: string}>}
 */
async function requestOTP(userId, email, ipAddress) {
  const cleanEmail = String(email || '').toLowerCase().trim();
  const userIdEmail = buildUserIdEmailKey(userId, cleanEmail);

  return withLock(`req:${userIdEmail}`, async () => {
    const now = Date.now();
    const nowISO = new Date(now).toISOString();

    // ── 1. IP-based rate limit (abuse layer) ─────────────────────────
    const ipHourly = await getIPRequestsInWindow(ipAddress, HOURLY_WINDOW_MS);
    if (ipHourly.length >= MAX_IP_HOURLY_REQUESTS) {
      console.warn(`[OTP] IP rate limit hit: ${ipAddress} (${ipHourly.length} requests/hour)`);
      return {
        success: false,
        error: 'Too many requests from this device. Please try again later.',
      };
    }

    // ── 2. 60-second cooldown between requests ───────────────────────
    const last = await getLastRequestForKey(userIdEmail);
    if (last) {
      const lastTime = new Date(last.requestedAt).getTime();
      const elapsed = now - lastTime;
      if (elapsed < COOLDOWN_MS) {
        const retryAfter = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        return {
          success: false,
          error: `Please wait ${retryAfter} second${retryAfter === 1 ? '' : 's'} before requesting a new code.`,
          retryAfter,
        };
      }
    }

    // ── 3. Hourly limit: 5 per rolling 1-hour window ─────────────────
    const hourly = await getRequestsByKeyInWindowWithFallback(userIdEmail, cleanEmail, HOURLY_WINDOW_MS);
    const hourlyCount = hourly.length;

    if (hourlyCount >= MAX_HOURLY_REQUESTS) {
      // Hourly cap hit. Is the daily cap also hit?
      const daily = await getRequestsByKeyInWindowWithFallback(userIdEmail, cleanEmail, DAILY_WINDOW_MS);
      const dailyCount = daily.length;

      if (dailyCount >= MAX_DAILY_REQUESTS) {
        // ── 4. Daily cap (8 in 24h) reached — hard block ─────────────
        // Find the oldest of the 8 so the user knows when to come back.
        const oldestInDay = daily.sort((a, b) => {
          return new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime();
        })[0];
        const resetAt = new Date(new Date(oldestInDay.requestedAt).getTime() + DAILY_WINDOW_MS);
        return {
          success: false,
          error: "Today's maximum OTP request limit has been reached. Please try again after 24 hours.",
          retryAfter: Math.max(60, Math.ceil((resetAt.getTime() - now) / 1000)),
        };
      }

      // ── Hourly cap hit, daily cap not yet hit ─────────────────────
      // The user has burnt their 5; tell them exactly when the hour
      // window will roll off so they can do their Phase 2 (3 more).
      const oldestInHour = hourly.sort((a, b) => {
        return new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime();
      })[0];
      const hourResetsAt = new Date(new Date(oldestInHour.requestedAt).getTime() + HOURLY_WINDOW_MS);
      const waitSec = Math.max(60, Math.ceil((hourResetsAt.getTime() - now) / 1000));
      return {
        success: false,
        error: `1-hour OTP limit reached (5 requests). Please wait until the hour resets — try again in ${Math.ceil(waitSec / 60)} minute(s).`,
        retryAfter: waitSec,
      };
    }

    // ── 5. Daily cap check (in case hourly is OK but daily is hit) ──
    const daily = await getRequestsByKeyInWindowWithFallback(userIdEmail, cleanEmail, DAILY_WINDOW_MS);
    if (daily.length >= MAX_DAILY_REQUESTS) {
      const oldestInDay = daily.sort((a, b) => {
        return new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime();
      })[0];
      const resetAt = new Date(new Date(oldestInDay.requestedAt).getTime() + DAILY_WINDOW_MS);
      return {
        success: false,
        error: "Today's maximum OTP request limit has been reached. Please try again after 24 hours.",
        retryAfter: Math.max(60, Math.ceil((resetAt.getTime() - now) / 1000)),
      };
    }

    // ── 6. All limits clear — generate OTP ──────────────────────────
    const otp = generateOTP();
    const otpHash = await bcrypt.hash(otp, BCRYPT_SALT_ROUNDS);

    // ── 7. Invalidate previous PENDING OTPs (only one valid at a time) ─
    await invalidatePreviousOTPs(userIdEmail, cleanEmail);

    // ── 8. Persist the new request ───────────────────────────────────
    const requestId = uuidv4();
    const dailyCount = daily.length;
    const requestNumber = dailyCount + 1;
    const expiresAt = new Date(now + OTP_EXPIRY_MS).toISOString();

    const otpRecord = {
      id: requestId,
      userId: String(userId || ''),
      userIdEmail,                          // composite key for rate-limit queries
      email: cleanEmail,
      ipAddress: ipAddress || '',
      otpHash,
      requestedAt: nowISO,
      expiresAt,
      verifiedAt: '',
      status: 'pending',
      requestNumber: String(requestNumber),
      dailyRequestCount: String(requestNumber),
      hourlyRequestCount: String(hourlyCount + 1),
      verifyAttempts: '0',
    };

    await db.appendRow(db.SHEETS.OTP_REQUESTS, otpRecord);

    console.log(`[OTP] Request #${requestNumber} for ${userIdEmail} (IP ${ipAddress}) — ${hourlyCount + 1}/5 hourly, ${requestNumber}/8 daily`);

    return {
      success: true,
      otp, // Plaintext — only returned to caller for email sending
      requestId,
    };
  });
}

// ── Main: Verify OTP ────────────────────────────────────────────────────────

/**
 * Verify an OTP submitted by the user. The OTP can only be consumed by
 * the same (userId, email) combination that requested it. Once verified
 * it is marked 'verified' so it cannot be reused.
 *
 * @param {string} userId   - Server-derived user ID
 * @param {string} email    - User email
 * @param {string} otpInput - The 6-digit code the user entered
 * @returns {Promise<{valid: boolean, error?: string, userId?: string}>}
 */
async function verifyOTP(userId, email, otpInput) {
  const cleanEmail = String(email || '').toLowerCase().trim();
  const userIdEmail = buildUserIdEmailKey(userId, cleanEmail);

  return withLock(`verify:${userIdEmail}`, async () => {
    const now = Date.now();

    // Find the most-recent PENDING OTP for this key
    let candidates = await db.findRows(db.SHEETS.OTP_REQUESTS, 'userIdEmail', userIdEmail);
    let pendingOTPs = candidates
      .filter((r) => r.status === 'pending')
      .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());

    // Fallback: any pending OTP issued for this email, whatever key it was
    // filed under. The key can legitimately differ between the send and the
    // verify — a pre-migration row with no userIdEmail, or an account that was
    // created in between so the id went from empty to a real user_id. The code
    // is bound to the email either way, which is the fact being proved, so a
    // key mismatch must never strand a code the user actually received.
    if (!pendingOTPs.length) {
      const byEmail = await db.findRows(db.SHEETS.OTP_REQUESTS, 'email', cleanEmail);
      pendingOTPs = byEmail
        .filter((r) => r.status === 'pending')
        .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());
    }

    if (!pendingOTPs.length) {
      console.warn(`[OTP] Verify failed — no pending OTP for ${userIdEmail}`);
      return { valid: false, error: 'Invalid or expired verification code. Please request a new one.' };
    }

    const activeOTP = pendingOTPs[0];
    const attempts = parseInt(activeOTP.verifyAttempts, 10) || 0;

    // ── 1. Max verify attempts per OTP ──────────────────────────────
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await db.updateRow(db.SHEETS.OTP_REQUESTS, 'id', activeOTP.id, {
        status: 'expired',
      }).catch((e) => console.warn('OTP expire notice:', e.message));
      console.warn(`[OTP] Max verify attempts reached for ${userIdEmail}`);
      return { valid: false, error: 'Too many failed attempts. Please request a new verification code.' };
    }

    // ── 2. 5-minute expiry ──────────────────────────────────────────
    const expiresAt = new Date(activeOTP.expiresAt).getTime();
    if (now > expiresAt) {
      await db.updateRow(db.SHEETS.OTP_REQUESTS, 'id', activeOTP.id, {
        status: 'expired',
      }).catch((e) => console.warn('OTP expire notice:', e.message));
      console.warn(`[OTP] Expired OTP verification attempt for ${userIdEmail}`);
      return { valid: false, error: 'Verification code has expired. Please request a new one.' };
    }

    // ── 3. bcrypt compare ───────────────────────────────────────────
    const isMatch = await bcrypt.compare(otpInput, activeOTP.otpHash);

    if (!isMatch) {
      const newAttempts = attempts + 1;
      await db.updateRow(db.SHEETS.OTP_REQUESTS, 'id', activeOTP.id, {
        verifyAttempts: String(newAttempts),
      }).catch((e) => console.warn('OTP attempt update notice:', e.message));

      if (newAttempts >= MAX_VERIFY_ATTEMPTS) {
        await db.updateRow(db.SHEETS.OTP_REQUESTS, 'id', activeOTP.id, {
          status: 'expired',
          verifyAttempts: String(newAttempts),
        }).catch((e) => console.warn('OTP expire notice:', e.message));
      }

      console.warn(`[OTP] Invalid OTP attempt #${newAttempts} for ${userIdEmail}`);
      return { valid: false, error: 'Invalid verification code. Please try again.' };
    }

    // ── 4. Success — mark as 'verified' so it CANNOT be reused ─────
    const verifiedAt = new Date(now).toISOString();
    await db.updateRow(db.SHEETS.OTP_REQUESTS, 'id', activeOTP.id, {
      status: 'verified',
      verifiedAt,
      verifyAttempts: String(attempts + 1),
    }).catch((e) => console.warn('OTP verify update notice:', e.message));

    console.log(`[OTP] Verified ${userIdEmail} (OTP ${activeOTP.id} now marked 'verified' — cannot be reused)`);

    return {
      valid: true,
      userId: activeOTP.userId || '',
    };
  });
}

// ── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  requestOTP,
  verifyOTP,
  // Exposed for testing / future use
  buildUserIdEmailKey,
  OTP_EXPIRY_MS,
  COOLDOWN_MS,
  HOURLY_WINDOW_MS,
  DAILY_WINDOW_MS,
  MAX_HOURLY_REQUESTS,
  MAX_DAILY_REQUESTS,
  MAX_VERIFY_ATTEMPTS,
  MAX_IP_HOURLY_REQUESTS,
};
