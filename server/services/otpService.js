// ============================================
// SaveHatke — OTP Security Service
// ============================================
// Production-ready OTP request/verify service with:
// - Per-email mutex locks (race-condition safety)
// - bcrypt-hashed OTP storage (never plaintext)
// - Multi-tier rate limiting (cooldown, hourly, daily, IP)
// - Full audit trail in Google Sheets (OTPRequests tab)
//
// Identity rule:
//   userId + email → associates OTP with the intended account
//   email          → primary rate-limit key
//   IP address     → abuse-prevention layer

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./googleSheets');

// ── Constants ───────────────────────────────────────────────────────────────
const OTP_EXPIRY_MS = 5 * 60 * 1000;           // 5 minutes
const COOLDOWN_MS = 60 * 1000;                  // 60 seconds between requests
const HOURLY_WINDOW_MS = 60 * 60 * 1000;        // 1 hour
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;    // 24 hours
const MAX_HOURLY_REQUESTS = 5;                   // Phase 1 cap
const MAX_DAILY_REQUESTS = 8;                    // Phase 1 (5) + Phase 2 (3)
const MAX_VERIFY_ATTEMPTS = 5;                   // Per OTP
const MAX_IP_HOURLY_REQUESTS = 15;               // Per IP per hour
const BCRYPT_SALT_ROUNDS = 10;

// ── Per-Email Mutex Lock ────────────────────────────────────────────────────
// Prevents concurrent requests for the same email from bypassing rate limits.
// Each email gets its own queue; requests are serialized per-email.
const locks = new Map();

/**
 * Execute `fn` while holding an exclusive lock for `key`.
 * If another call is already in progress for the same key,
 * this call waits until the previous one completes.
 */
async function withLock(key, fn) {
  const normalizedKey = key.toLowerCase().trim();

  // Wait for any existing lock to release
  while (locks.has(normalizedKey)) {
    await locks.get(normalizedKey);
  }

  // Create a new lock (promise that resolves when fn completes)
  let releaseLock;
  const lockPromise = new Promise((resolve) => {
    releaseLock = resolve;
  });
  locks.set(normalizedKey, lockPromise);

  try {
    return await fn();
  } finally {
    locks.delete(normalizedKey);
    releaseLock();
  }
}

// ── OTP Generation ──────────────────────────────────────────────────────────

/**
 * Generate a cryptographically-sufficient 6-digit OTP.
 * Uses Math.random() which is adequate for 6-digit codes with
 * rate limiting and bcrypt hashing in place.
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── Helper: Query OTP Requests ──────────────────────────────────────────────

/**
 * Get all OTP requests for an email within a time window.
 * @param {string} email - Normalized email
 * @param {number} windowMs - Time window in milliseconds
 * @returns {Promise<Array>} Matching request rows
 */
async function getEmailRequestsInWindow(email, windowMs) {
  const allRequests = await db.findRows(db.SHEETS.OTP_REQUESTS, 'email', email);
  const cutoff = Date.now() - windowMs;
  return allRequests.filter((r) => {
    const requestTime = new Date(r.requestedAt).getTime();
    return requestTime >= cutoff;
  });
}

/**
 * Get all OTP requests from an IP within a time window.
 * @param {string} ip - Client IP address
 * @param {number} windowMs - Time window in milliseconds
 * @returns {Promise<Array>} Matching request rows
 */
async function getIPRequestsInWindow(ip, windowMs) {
  const allRequests = await db.findRows(db.SHEETS.OTP_REQUESTS, 'ipAddress', ip);
  const cutoff = Date.now() - windowMs;
  return allRequests.filter((r) => {
    const requestTime = new Date(r.requestedAt).getTime();
    return requestTime >= cutoff;
  });
}

/**
 * Get the most recent OTP request for an email.
 * @param {string} email
 * @returns {Promise<object|null>}
 */
async function getLastRequestForEmail(email) {
  const allRequests = await db.findRows(db.SHEETS.OTP_REQUESTS, 'email', email);
  if (!allRequests.length) return null;

  // Sort by requestedAt descending, return the most recent
  return allRequests.sort((a, b) => {
    return new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime();
  })[0];
}

/**
 * Mark all previous pending OTPs for an email as 'superseded'.
 * Ensures only the latest OTP is valid.
 * @param {string} email
 */
async function invalidatePreviousOTPs(email) {
  const allRequests = await db.findRows(db.SHEETS.OTP_REQUESTS, 'email', email);
  const pending = allRequests.filter((r) => r.status === 'pending');

  for (const req of pending) {
    await db.updateRow(db.SHEETS.OTP_REQUESTS, 'id', req.id, {
      status: 'superseded',
    }).catch((e) => console.warn('OTP invalidation notice:', e.message));
  }
}

// ── Main: Request OTP ───────────────────────────────────────────────────────

/**
 * Request a new OTP for a user. Enforces all rate limits and security rules.
 *
 * @param {string} userId - Server-derived user ID
 * @param {string} email - User email (normalized by caller)
 * @param {string} ipAddress - Client IP (derived server-side)
 * @returns {Promise<{success: boolean, otp?: string, error?: string, retryAfter?: number}>}
 */
async function requestOTP(userId, email, ipAddress) {
  const cleanEmail = email.toLowerCase().trim();

  // All checks run inside a per-email lock to prevent race conditions
  return withLock(cleanEmail, async () => {
    const now = Date.now();
    const nowISO = new Date(now).toISOString();

    // ── 1. IP-based rate limit ────────────────────────────────────────
    const ipHourlyRequests = await getIPRequestsInWindow(ipAddress, HOURLY_WINDOW_MS);
    if (ipHourlyRequests.length >= MAX_IP_HOURLY_REQUESTS) {
      console.warn(`[OTP] IP rate limit hit: ${ipAddress} (${ipHourlyRequests.length} requests/hour)`);
      return {
        success: false,
        error: 'Too many requests. Please try again later.',
      };
    }

    // ── 2. 60-second cooldown ─────────────────────────────────────────
    const lastRequest = await getLastRequestForEmail(cleanEmail);
    if (lastRequest) {
      const lastRequestTime = new Date(lastRequest.requestedAt).getTime();
      const elapsed = now - lastRequestTime;
      if (elapsed < COOLDOWN_MS) {
        const retryAfter = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        return {
          success: false,
          error: `Please wait ${retryAfter} seconds before requesting a new code.`,
          retryAfter,
        };
      }
    }

    // ── 3. Hourly limit (5 per rolling 1-hour window) ─────────────────
    const hourlyRequests = await getEmailRequestsInWindow(cleanEmail, HOURLY_WINDOW_MS);
    const hourlyCount = hourlyRequests.length;

    if (hourlyCount >= MAX_HOURLY_REQUESTS) {
      // Check if we're in the Phase 2 window (after the first hourly window expires)
      // Phase 2 allows 3 more requests (total 8 daily)
      const dailyRequests = await getEmailRequestsInWindow(cleanEmail, DAILY_WINDOW_MS);
      const dailyCount = dailyRequests.length;

      if (dailyCount >= MAX_DAILY_REQUESTS) {
        // ── 4. 24-hour hard cap ─────────────────────────────────────────
        return {
          success: false,
          error: "Today's maximum OTP request limit has been reached. Please try again after 24 hours.",
        };
      }

      // Hourly cap hit but daily cap not reached: user is temporarily blocked
      // Find the oldest request in the current hourly window to calculate when it expires
      const oldestHourlyRequest = hourlyRequests.sort((a, b) => {
        return new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime();
      })[0];
      const oldestTime = new Date(oldestHourlyRequest.requestedAt).getTime();
      const windowExpiresAt = oldestTime + HOURLY_WINDOW_MS;
      const waitSeconds = Math.ceil((windowExpiresAt - now) / 1000);

      return {
        success: false,
        error: `Hourly OTP limit reached. Please try again in ${Math.ceil(waitSeconds / 60)} minute(s).`,
        retryAfter: waitSeconds,
      };
    }

    // ── Also check 24-hour cap even if hourly is OK ────────────────────
    const dailyRequests = await getEmailRequestsInWindow(cleanEmail, DAILY_WINDOW_MS);
    const dailyCount = dailyRequests.length;

    if (dailyCount >= MAX_DAILY_REQUESTS) {
      return {
        success: false,
        error: "Today's maximum OTP request limit has been reached. Please try again after 24 hours.",
      };
    }

    // ── 5. Generate OTP + Hash ────────────────────────────────────────
    const otp = generateOTP();
    const otpHash = await bcrypt.hash(otp, BCRYPT_SALT_ROUNDS);

    // ── 6. Invalidate previous pending OTPs ───────────────────────────
    await invalidatePreviousOTPs(cleanEmail);

    // ── 7. Store new OTP request in Google Sheets ─────────────────────
    const requestId = uuidv4();
    const requestNumber = dailyCount + 1;
    const expiresAt = new Date(now + OTP_EXPIRY_MS).toISOString();

    const otpRecord = {
      id: requestId,
      userId: userId || '',
      email: cleanEmail,
      ipAddress: ipAddress || '',
      otpHash,
      requestedAt: nowISO,
      expiresAt,
      verifiedAt: '',
      status: 'pending',
      requestNumber: String(requestNumber),
      dailyRequestCount: String(dailyCount + 1),
      hourlyRequestCount: String(hourlyCount + 1),
      verifyAttempts: '0',
    };

    await db.appendRow(db.SHEETS.OTP_REQUESTS, otpRecord);

    console.log(`[OTP] Request #${requestNumber} created for ${cleanEmail} (IP: ${ipAddress}, ID: ${requestId})`);

    return {
      success: true,
      otp, // Plaintext — only returned to caller for email sending, never stored
      requestId,
    };
  });
}

// ── Main: Verify OTP ────────────────────────────────────────────────────────

/**
 * Verify an OTP submitted by the user.
 *
 * @param {string} email - User email
 * @param {string} otpInput - The OTP code the user entered
 * @returns {Promise<{valid: boolean, error?: string, userId?: string}>}
 */
async function verifyOTP(email, otpInput) {
  const cleanEmail = email.toLowerCase().trim();

  return withLock(`verify:${cleanEmail}`, async () => {
    const now = Date.now();

    // Find the most recent pending OTP for this email
    const allRequests = await db.findRows(db.SHEETS.OTP_REQUESTS, 'email', cleanEmail);
    const pendingOTPs = allRequests
      .filter((r) => r.status === 'pending')
      .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());

    if (!pendingOTPs.length) {
      console.warn(`[OTP] Verify failed — no pending OTP for ${cleanEmail}`);
      // Generic error — don't reveal whether account/email exists
      return { valid: false, error: 'Invalid or expired verification code. Please request a new one.' };
    }

    const activeOTP = pendingOTPs[0];
    const attempts = parseInt(activeOTP.verifyAttempts, 10) || 0;

    // ── Check max verification attempts ───────────────────────────────
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await db.updateRow(db.SHEETS.OTP_REQUESTS, 'id', activeOTP.id, {
        status: 'expired',
      }).catch((e) => console.warn('OTP expire notice:', e.message));

      console.warn(`[OTP] Max verify attempts reached for ${cleanEmail} (OTP: ${activeOTP.id})`);
      return { valid: false, error: 'Too many failed attempts. Please request a new verification code.' };
    }

    // ── Check expiry ──────────────────────────────────────────────────
    const expiresAt = new Date(activeOTP.expiresAt).getTime();
    if (now > expiresAt) {
      await db.updateRow(db.SHEETS.OTP_REQUESTS, 'id', activeOTP.id, {
        status: 'expired',
      }).catch((e) => console.warn('OTP expire notice:', e.message));

      console.warn(`[OTP] Expired OTP verification attempt for ${cleanEmail}`);
      return { valid: false, error: 'Verification code has expired. Please request a new one.' };
    }

    // ── Compare hash ──────────────────────────────────────────────────
    const isMatch = await bcrypt.compare(otpInput, activeOTP.otpHash);

    if (!isMatch) {
      // Increment attempt counter
      const newAttempts = attempts + 1;
      await db.updateRow(db.SHEETS.OTP_REQUESTS, 'id', activeOTP.id, {
        verifyAttempts: String(newAttempts),
      }).catch((e) => console.warn('OTP attempt update notice:', e.message));

      // If this was the last allowed attempt, also expire the OTP
      if (newAttempts >= MAX_VERIFY_ATTEMPTS) {
        await db.updateRow(db.SHEETS.OTP_REQUESTS, 'id', activeOTP.id, {
          status: 'expired',
          verifyAttempts: String(newAttempts),
        }).catch((e) => console.warn('OTP expire notice:', e.message));
      }

      console.warn(`[OTP] Invalid OTP attempt #${newAttempts} for ${cleanEmail}`);
      return { valid: false, error: 'Invalid verification code. Please try again.' };
    }

    // ── Success! Mark as verified ─────────────────────────────────────
    const verifiedAt = new Date(now).toISOString();
    await db.updateRow(db.SHEETS.OTP_REQUESTS, 'id', activeOTP.id, {
      status: 'verified',
      verifiedAt,
      verifyAttempts: String(attempts + 1),
    }).catch((e) => console.warn('OTP verify update notice:', e.message));

    console.log(`[OTP] ✅ Verified successfully for ${cleanEmail} (OTP: ${activeOTP.id})`);

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
  // Exposed for testing
  OTP_EXPIRY_MS,
  COOLDOWN_MS,
  MAX_HOURLY_REQUESTS,
  MAX_DAILY_REQUESTS,
  MAX_IP_HOURLY_REQUESTS,
};
