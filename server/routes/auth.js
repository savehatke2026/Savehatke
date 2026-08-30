const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const UAParser = require('ua-parser-js');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const {
  authenticateToken,
  generateToken,
  refreshToken,
  decodeTokenIgnoreExpiry,
  generateSessionToken,
  hashSessionToken,
  setSessionCookie,
  clearSessionCookie,
  SESSION_TTL_MS,
  ADMIN_SESSION_TTL_MS,
} = require('../middleware/auth');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');
const emailService = require('../services/emailService');
const otpService = require('../services/otpService');
const getClientIP = require('../middleware/getClientIP');
const { verifyTurnstile } = require('../utils/turnstile');
const sessionCleanup = require('../services/sessionCleanup');
const twoFactor = require('../services/twoFactorService');

const router = express.Router();

/**
 * Second-factor gate for every login path.
 *
 * Called after the primary factor (email OTP, Google) has already proved the
 * account. When the account has an authenticator enrolled, this returns a
 * challenge instead of letting the caller mint a session — so no session, JWT
 * or cookie is created until routes/twoFactor.js POST /login verifies a code.
 *
 * A lookup failure deliberately falls through to a normal login rather than
 * locking the user out: the sheets store being unreachable is an availability
 * problem, and every other login path in this file degrades the same way.
 *
 * @returns {Promise<{required:boolean, body?:object}>} body is the response to
 *          send verbatim when required is true.
 */
async function twoFactorGate(req, sheetUser, { email, method, role = 'user' }) {
  const cleanEmail = twoFactor.normEmail(email);
  const userId = (sheetUser && (sheetUser.user_id || sheetUser.id)) || '';

  let record = null;
  try {
    record = await twoFactor.findRecord({ userId, email: cleanEmail });
  } catch (e) {
    console.warn('[auth] 2FA lookup failed, continuing without a challenge:', e.message);
    return { required: false };
  }
  if (!record || !twoFactor.truthy(record.enabled)) return { required: false };

  // twoFactorService binds the challenge to the caller's IP + User-Agent, so it
  // needs the same resolved IP the 2FA route will compute on the way back in.
  req.clientIpForTwoFactor = getClientIP(req);

  const name = (sheetUser && sheetUser.name) || cleanEmail.split('@')[0];
  const challengeToken = twoFactor.issueLoginChallengeToken({
    uid: userId,
    email: cleanEmail,
    name,
    username: (sheetUser && sheetUser.username) || cleanEmail.split('@')[0],
    status: (sheetUser && sheetUser.status) || 'active',
    role,
    method,
  }, req);

  return {
    required: true,
    body: {
      twoFactorRequired: true,
      challengeToken,
      maskedEmail: twoFactor.maskEmail(cleanEmail),
      message: 'Enter the 6-digit code from your authenticator app.',
    },
  };
}

/**
 * Extract device info from User-Agent and create a server-side 48-hour
 * session in Supabase. Called on EVERY successful login (users and admins).
 *
 * The returned object carries the raw session token (which the caller embeds
 * in the JWT `sid` claim and the HttpOnly cookie) plus the session id and
 * expiry. The database stores only a SHA-256 hash of the token.
 *
 * The user_id is resolved against the Users Google Sheet first (by email),
 * so Supabase always stores the real user id that exists in the sheet.
 * Geo-IP enrichment runs in the background â€” it never delays the login.
 *
 * @returns {Promise<{token:string, sessionId:string, expiresAt:string}|null>}
 *   null when Supabase is unreachable (login still succeeds; the JWT is
 *   issued without a sid and still hard-expires 48h after login).
 */

/**
 * Pull the canonical user_id out of a sheet row, no matter how the column
 * is named in the spreadsheet. The configured header is `user_id`, but live
 * sheets sometimes use `userId`, `userid`, `UserID`, `User Id`, or even just
 * `id` / `uuid`. Without this, the session table ends up with the wrong id
 * (or a freshly generated one) and the admin Sessions page can't join the
 * row back to the user.
 */
function extractUserIdFromSheetUser(sheetUser) {
  if (!sheetUser || typeof sheetUser !== 'object') return '';
  // Direct field names first â€” covers the common header variants
  for (const key of ['user_id', 'userId', 'userid', 'id', 'uuid']) {
    if (sheetUser[key]) return String(sheetUser[key]);
  }
  // Fallback: any field whose normalized name collapses to "userid" or "uuid"
  for (const [key, value] of Object.entries(sheetUser)) {
    if (!value) continue;
    const nk = String(key).trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (nk === 'userid' || nk === 'uuid') return String(value);
  }
  return '';
}

async function resolveSessionUserId(userId, cleanEmail) {
  let realUserId = String(userId || '');
  let userIdSource = 'passed-in';
  if (!cleanEmail) return { realUserId, userIdSource };

  let sheetUser = await db.findRow(db.SHEETS.USERS, 'email', cleanEmail).catch(() => null);
  if (!sheetUser) {
    // Retry case/whitespace-insensitive â€” sheet rows may hold mixed-case emails
    const allRows = await db.getRows(db.SHEETS.USERS).catch(() => []);
    sheetUser = allRows.find((r) => String(r.email || '').toLowerCase().trim() === cleanEmail) || null;
  }

  let fromSheet = extractUserIdFromSheetUser(sheetUser);

  // â”€â”€ Backfill: sheet has the user row but the user_id cell is empty.
  //    This is the most common cause of "wrong user_id in Supabase" â€”
  //    the row was created before the user_id column was populated, or the
  //    column was added later by ensureSheets(). Generate a UUID,
  //    write it back to the sheet, and use it for the session.
  if (sheetUser && !fromSheet) {
    const newId = uuidv4();
    try {
      await db.updateRow(db.SHEETS.USERS, 'email', cleanEmail, {
        user_id: newId,
        id: newId,
        updated_at: new Date().toISOString(),
      });
      fromSheet = newId;
      userIdSource = 'sheet-row-backfilled';
      console.log(`[session] Backfilled empty user_id for ${cleanEmail} â†’ ${newId}`);
    } catch (e) {
      console.warn(`[session] Failed to backfill user_id for ${cleanEmail}:`, e.message);
    }
  }

  if (fromSheet) {
    realUserId = fromSheet;
    if (userIdSource === 'passed-in') userIdSource = 'google-sheet';
  } else if (sheetUser) {
    userIdSource = 'sheet-row-missing-id';
  } else {
    userIdSource = 'sheet-row-not-found';
  }
  return { realUserId, userIdSource };
}

function parseUserAgent(req) {
  const ua = new UAParser(req.headers['user-agent'] || '');
  const device = ua.getDevice();
  const os = ua.getOS();
  const browser = ua.getBrowser();

  let deviceStr = '';
  if (device.vendor && device.model) {
    deviceStr = `${device.vendor} ${device.model}`;
  } else if (device.vendor) {
    deviceStr = device.vendor;
  } else {
    deviceStr = device.type ? device.type.charAt(0).toUpperCase() + device.type.slice(1) : 'Desktop';
  }

  const osStr = os.name ? `${os.name}${os.version ? ' ' + os.version : ''}` : 'Unknown';
  const browserStr = browser.name ? `${browser.name}${browser.version ? ' ' + browser.version.split('.')[0] : ''}` : 'Unknown';
  return { deviceStr, osStr, browserStr, raw: String(req.headers['user-agent'] || '').slice(0, 300) };
}

/**
 * Background geo enrichment â€” looks up country/state/city for the login IP
 * and updates the session row. Fire-and-forget; failures are harmless.
 */
/**
 * Look up country/state/city for a login IP. Best-effort: private/loopback
 * addresses and total provider failure both yield 'Unknown' fields. Shared by
 * the session-row enrichment and the "new sign-in" alert email, so a login
 * only ever costs one geo lookup.
 */
async function resolveGeo(ip) {
  let country = 'Unknown', state = 'Unknown', city = 'Unknown';
  const isIPv6 = ip.includes(':');
  const lookupable = ip && ip !== 'unknown' && ip !== '127.0.0.1'
    && !/^(10\.|192\.168\.|169\.254\.)/.test(ip) && !/^172\.(1[6-9]|2\d|3[01])\./.test(ip);

  if (lookupable) {
    // Order matters: try HTTPS services first (Vercel allows them), then HTTP
    const services = isIPv6
      ? [
        { name: 'ipwho.is', url: `https://ipwho.is/${ip}`, parse: (j) => ({ ok: j.success === true, country: j.country, state: j.region, city: j.city }) },
        { name: 'ipapi.co', url: `https://ipapi.co/${ip}/json/`, parse: (j) => ({ ok: !j.error, country: j.country_name, state: j.region, city: j.city }) },
      ]
      : [
        { name: 'ipapi.co', url: `https://ipapi.co/${ip}/json/`, parse: (j) => ({ ok: !j.error, country: j.country_name, state: j.region, city: j.city }) },
        { name: 'ipwho.is', url: `https://ipwho.is/${ip}`, parse: (j) => ({ ok: j.success === true, country: j.country, state: j.region, city: j.city }) },
        { name: 'ip-api.com', url: `http://ip-api.com/json/${ip}?fields=status,country,regionName,city`, parse: (j) => ({ ok: j.status === 'success', country: j.country, state: j.regionName, city: j.city }) },
      ];

    for (const svc of services) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const geoRes = await fetch(svc.url, { signal: controller.signal });
        clearTimeout(timer);
        if (geoRes.ok) {
          const geo = await geoRes.json();
          const result = svc.parse(geo);
          if (result.ok) {
            if (result.country) country = result.country;
            if (result.state) state = result.state;
            if (result.city) city = result.city;
            break;
          }
        }
      } catch (e) {
        // Try next service
      }
    }
  }

  return { country, state, city };
}

/**
 * Write the resolved geo onto the session row. Pass an already-resolved `geo`
 * to reuse the login's single lookup. Fire-and-forget: on failure the row just
 * keeps its 'Unknown' placeholders.
 */
async function enrichSessionGeo(sessionId, ip, geo) {
  const { country: rawCountry, state, city } = geo || (await resolveGeo(ip));
  // The admin Sessions view shows a flag beside India; the alert email keeps
  // the plain provider name. Written as escapes so the emoji is not at the
  // mercy of this file's encoding.
  const country = rawCountry === 'India' ? 'India \u{1F1EE}\u{1F1F3}' : rawCountry;

  try {
    const client = supabase.getClient();
    if (client) {
      // The session lives in exactly one of the two tables; updating both is
      // harmless (the non-matching table simply updates zero rows).
      await Promise.all([
        client.from('user_sessions').update({ country, state, city }).eq('session_id', sessionId),
        client.from('admin_sessions').update({ country, state, city }).eq('session_id', sessionId),
      ]);
    }
  } catch (e) { /* enrichment is best-effort */ }
}

/**
 * Record a rejected sign-in attempt in the append-only security audit log.
 *
 * This is what makes the Login History page able to show a "Failed" row at
 * all — a rejected attempt never creates a session, so there is nothing in
 * user_sessions to read. Best-effort: a logging outage must never turn into a
 * login error, so failures here are swallowed.
 */
function logLoginFailure(req, { email, userId = '', detail = '' }) {
  try {
    const { deviceStr, osStr, browserStr } = parseUserAgent(req);
    twoFactor.logSecurityEvent({
      userId,
      email,
      event: 'login_failed',
      outcome: 'failure',
      ip: getClientIP(req),
      device: [browserStr, osStr || deviceStr].filter(Boolean).join(' \u2022 '),
      detail,
    }).catch(() => {});
  } catch (e) { /* audit logging is best-effort */ }
}

async function createLoginSession(req, userId, loginMethod, email, userName) {
  try {
    const cleanEmail = String(email || '').toLowerCase().trim();
    const isAdminLogin = /admin/i.test(String(loginMethod || ''));

    const { deviceStr, osStr, browserStr, raw: userAgentRaw } = parseUserAgent(req);
    const ip = getClientIP(req); // Real client IP only â€” never a sample/hardcoded address

    // One geo lookup per login, shared by the alert email (which prints the
    // Location line) and the session row enrichment below. Never awaited on
    // the login response path.
    const signInAt = new Date().toISOString();
    const geoPromise = resolveGeo(ip).catch(() => null);

    // Send the "New sign-in detected" security alert to the account's own
    // address (user or admin) from the SaveHatke Security mailbox. It runs
    // before the user-id lookup and the session row are written, so neither a
    // Google Sheets nor a Supabase outage can swallow the notification.
    // Opt-out via SIGNIN_ALERT_DISABLED=true.
    if (cleanEmail && process.env.SIGNIN_ALERT_DISABLED !== 'true') {
      geoPromise
        .then((geo) => emailService.sendSignInAlertEmail({
          to: cleanEmail,
          userName: userName && String(userName).trim() ? String(userName).trim() : '',
          userEmail: cleanEmail,
          signInTime: signInAt,
          ip,
          device: deviceStr,
          browser: browserStr,
          os: osStr,
          city: geo ? geo.city : '',
          country: geo ? geo.country : '',
          loginMethod: loginMethod || (isAdminLogin ? 'Admin' : 'Email'),
        }))
        .then((r) => {
          if (r && r.success) {
            console.log(`[Auth] Sign-in alert sent to ${cleanEmail} (IP ${ip}, device ${deviceStr})`);
          } else if (r && r.isSimulated) {
            console.warn(`[Auth] Sign-in alert NOT sent for ${cleanEmail} -> ${r.error || 'SMTP not configured'}`);
          } else {
            console.warn(`[Auth] Sign-in alert FAILED for ${cleanEmail}: ${(r && r.error) || 'unknown'}`);
          }
        })
        .catch((e) => console.warn('[Auth] Sign-in alert unexpected error:', e && e.message ? e.message : e));
    }

    // Cryptographically random session identifier. The raw value goes into
    // the JWT and cookie; only its SHA-256 hash is stored in the database.
    const rawToken = generateSessionToken();

    const { realUserId, userIdSource } = await resolveSessionUserId(userId, cleanEmail);
    const finalUserId = realUserId || ('user_' + Date.now());

    // Admin sessions are short-lived: automatic logout 2 hours after login.
    // User sessions last 48 hours.
    const ttlMs = isAdminLogin ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS;

    const sessionResult = await supabase.createSession({
      user_id: finalUserId,
      email: cleanEmail,
      device: deviceStr,
      os: osStr,
      browser: browserStr,
      ip_address: ip,
      login_method: loginMethod || 'Email',
      user_agent: userAgentRaw,
      session_token: hashSessionToken(rawToken),
    }, ttlMs);

    if (!sessionResult || !sessionResult.session_token) {
      // Row created without the session_token column (pre-migration DB) or
      // insert failed entirely â€” no enforceable session for this login.
      console.warn('âš ï¸ Login session not enforceable (Supabase session_token unavailable) â€” issuing time-limited JWT only.');
      return null;
    }

    console.log(`âœ… Session created in Supabase: ${sessionResult.session_id} for ${isAdminLogin ? 'ADMIN' : 'user'} ${finalUserId}${cleanEmail ? ' (' + cleanEmail + ')' : ''} | user_id source: ${userIdSource} | ip: ${ip} | expires: ${sessionResult.expires_at} (${isAdminLogin ? '2h' : '48h'})`);

    // Geo-IP enrichment in the background â€” never blocks the login response
    geoPromise
      .then((geo) => enrichSessionGeo(sessionResult.session_id, ip, geo))
      .catch(() => {});

    return {
      token: rawToken,
      sessionId: sessionResult.session_id,
      expiresAt: sessionResult.expires_at,
      ttlMs,
    };
  } catch (err) {
    console.warn('Session creation notice:', err.message);
    return null;
  }
}

/**
 * Mint the login JWT. Every token records its login time (`lgn`) so refresh
 * can never extend past the session's hard limit, and carries the session
 * token (`sid`) for server-side validation. User tokens live 48h; admin
 * tokens live 2h (automatic admin logout) and refresh within the same
 * 2-hour session window.
 */
function issueLoginToken(user, session) {
  const payload = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role || 'user',
    lgn: Math.floor(Date.now() / 1000),
  };
  if (session && session.token) payload.sid = session.token;
  const expiresIn = user.role === 'admin' ? '2h' : '48h';
  return generateToken(payload, expiresIn);
}

// â”€â”€ POST /api/auth/send-otp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Send OTP to email with full security: rate limiting, hashing, audit trail.
// Identity is derived server-side â€” never trust frontend-supplied userId or IP.
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // Verify the Cloudflare Turnstile token. The shared verifier fails open on
    // CAPTCHA infrastructure problems (widget unreachable, siteverify down,
    // misconfigured key) so a bot defence outage can never stop a real user
    // from receiving their code; per-email and per-IP rate limits still apply.
    const captcha = await verifyTurnstile(req, 'send-otp');
    if (!captcha.ok) {
      return res.status(400).json({ error: captcha.error });
    }

    // Derive userId server-side (look up existing user, or leave it empty).
    // It must NOT be invented here: /verify-otp derives the same value again a
    // few minutes later, and otpService keys every OTP row on userId+email. A
    // clock-based placeholder produced a different key on each call, so a code
    // sent to an address with no account yet could never be verified — and the
    // per-email rate limits never matched either. An empty id keys the row on
    // the email alone, which both routes can reproduce.
    let userId = '';
    try {
      const existingUser = await db.findRow(db.SHEETS.USERS, 'email', cleanEmail);
      if (existingUser) {
        userId = existingUser.user_id || existingUser.id || '';
      }
    } catch (e) {
      // User lookup failed â€” continue with empty userId (new user flow)
    }

    // Derive IP address server-side
    const ipAddress = getClientIP(req);

    // Request OTP through the security service
    const result = await otpService.requestOTP(userId, cleanEmail, ipAddress);

    if (!result.success) {
      // Return rate-limit errors with 429 status
      return res.status(429).json({
        error: result.error,
        retryAfter: result.retryAfter || undefined,
      });
    }

    // Send real OTP via Nodemailer email service
    const emailResult = await emailService.sendOTPEmail(cleanEmail, result.otp);

    if (!emailResult.success) {
      console.warn('Email sending failed:', emailResult.error);
      // SMTP is configured but the send failed — don't pretend the code is on its way.
      if (!emailResult.isSimulated) {
        return res.status(502).json({
          error: 'We could not deliver the verification email right now. Please try again in a moment.',
        });
      }
    }

    res.json({
      message: 'Verification code sent to ' + cleanEmail + '.',
      // Only exposed when SMTP is not configured, so local dev without mail still works.
      // A real, delivered code is never returned over HTTP.
      devOtp: emailResult.isSimulated ? result.otp : undefined,
    });
  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
  }
});

// â”€â”€ POST /api/auth/verify-otp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Verify OTP, log the attempt, and create an authenticated session.
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and verification code are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Derive userId server-side exactly as /send-otp does, so verifyOTP looks
    // under the same composite key. Never substitute a placeholder here.
    let userId = '';
    try {
      const existingUser = await db.findRow(db.SHEETS.USERS, 'email', cleanEmail);
      if (existingUser) userId = existingUser.user_id || existingUser.id || '';
    } catch (e) { /* lookup failed — empty userId is fine, the email fallback still applies */ }

    // Verify OTP through the security service (handles hash comparison, expiry, attempts)
    const verification = await otpService.verifyOTP(userId, cleanEmail, otp);
    if (!verification.valid) {
      return res.status(400).json({ error: verification.error });
    }

    const now = new Date().toISOString();

    // Find or create user in Google Sheets
    let sheetUser = await db.findRow(db.SHEETS.USERS, 'email', cleanEmail).catch(() => null);
    let isNewSignup = false;
    if (!sheetUser) {
      // ── Paranoid pre-create scan ─────────────────────────────────────
      // findRow above should normally find any existing user. This
      // extra pass is a safety net: do a full case-insensitive scan
      // against the live sheet before appending. If anything matches,
      // we update that row in place instead of creating a duplicate.
      const allRows = await db.getRows(db.SHEETS.USERS).catch(() => []);
      const existingDup = (allRows || []).find((r) => {
        const v = (r && r.email) ? String(r.email).toLowerCase().trim() : '';
        return v && v === cleanEmail;
      });
      if (existingDup) {
        sheetUser = existingDup;
        isNewSignup = false;
        await db.updateRow(db.SHEETS.USERS, 'email', cleanEmail, {
          last_login_at: now,
          updated_at: now,
        }).catch((e) => console.warn('GSheet dedup update notice:', e.message));
      } else {
        // New user - create account
        const userId = uuidv4();
        sheetUser = {
          user_ID: userId,
          user_id: userId,
          id: userId,
          name: cleanEmail.split('@')[0],
          username: cleanEmail.split('@')[0],
          email: cleanEmail,
          status: 'active',
          created_at: now,
          updated_at: now,
          last_login_at: now,
          last_logout_at: '',
        };
        await db.appendRow(db.SHEETS.USERS, sheetUser).catch((e) => console.warn('GSheet write notice:', e.message));
        isNewSignup = true;
      }
    } else {
      // Existing user - update last login
      await db.updateRow(db.SHEETS.USERS, 'email', cleanEmail, {
        last_login_at: now,
        updated_at: now,
      }).catch((e) => console.warn('GSheet update notice:', e.message));
    }

    // Second-factor gate. When an authenticator is enrolled we stop here and
    // hand back a challenge — no session, JWT or cookie is created yet.
    const gate = await twoFactorGate(req, sheetUser, {
      email: cleanEmail,
      method: 'Email OTP + 2FA',
    });
    if (gate.required) return res.json(gate.body);

    // Create the server-side 48h session (must be awaited â€” the JWT and
    // cookie carry this session's token)
    const session = await createLoginSession(req, sheetUser.user_id || sheetUser.id, 'Email OTP', cleanEmail, sheetUser.name).catch(() => null);

    // Generate JWT token (48h hard limit, sid-bound to the session)
    const token = issueLoginToken({
      id: sheetUser.user_id || sheetUser.id,
      email: cleanEmail,
      name: sheetUser.name || cleanEmail.split('@')[0],
      role: 'user',
    }, session);
    if (session) setSessionCookie(res, session.token, session.ttlMs);

    // Send welcome email on first-time signup (fire-and-forget â€” never blocks the response)
    if (isNewSignup) {
      const welcomeName = sheetUser.name || cleanEmail.split('@')[0];
      emailService.sendWelcomeEmail(cleanEmail, welcomeName)
        .then((r) => {
          if (r.success) console.log(`ðŸ“§ Welcome email queued for new user: ${cleanEmail}`);
          else if (!r.isSimulated) console.warn(`ðŸ“§ Welcome email failed for ${cleanEmail}: ${r.error}`);
        })
        .catch((e) => console.warn('Welcome email notice:', e.message));
    }

    res.json({
      message: 'Email verified successfully!',
      token,
      session_id: session ? session.sessionId : undefined,
      session_expires_at: session ? session.expiresAt : undefined,
      user: {
        id: sheetUser.user_id || sheetUser.id,
        user_id: sheetUser.user_id || sheetUser.id,
        email: cleanEmail,
        name: sheetUser.name || cleanEmail.split('@')[0],
        username: sheetUser.username || cleanEmail.split('@')[0],
        status: sheetUser.status || 'active',
        role: 'user',
      },
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Failed to verify code. Please try again.' });
  }
});

function getSheetsFallbackError(message) {
  return db.getWriteAvailabilityError(message);
}

// POST /api/auth/register â€” Save user EXCLUSIVELY to Google Sheets (Users tab)
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, username } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanName = name.trim();
    const cleanUsername = (username || cleanEmail.split('@')[0]).trim();

    // Check for existing user in Google Sheets
    const existingSheetUser = await db.findRow(db.SHEETS.USERS, 'email', cleanEmail);
    if (existingSheetUser) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const now = new Date().toISOString();
    const userId = uuidv4();

    const sheetUser = {
      user_ID: userId,
      user_id: userId,
      id: userId,
      name: cleanName,
      username: cleanUsername,
      email: cleanEmail,
      status: 'active',
      created_at: now,
      updated_at: now,
      last_login_at: now,
      last_logout_at: '',
    };

    // Save profile details to Google Sheets (Users tab)
    await db.appendRow(db.SHEETS.USERS, sheetUser);

    // Dual-sync password hash securely to Supabase (not stored in Sheets)
    if (supabase.isConfigured()) {
      try {
        await supabase.createUser({
          user_id: userId,
          name: cleanName,
          email: cleanEmail,
          password_hash: passwordHash,
          username: cleanUsername,
        });
      } catch (spErr) {
        console.warn('Supabase password hash storage notice:', spErr.message);
      }
    }

    // Create the server-side 48h session
    const session = await createLoginSession(req, userId, 'Email', cleanEmail, cleanName).catch(() => null);

    // Generate token (48h hard limit, sid-bound to the session)
    const token = issueLoginToken({ id: userId, email: cleanEmail, name: cleanName, role: 'user' }, session);
    if (session) setSessionCookie(res, session.token, session.ttlMs);

    // Send welcome email to the newly registered user (fire-and-forget â€” never blocks the response)
    emailService.sendWelcomeEmail(cleanEmail, cleanName)
      .then((r) => {
        if (r.success) console.log(`ðŸ“§ Welcome email queued for new user: ${cleanEmail}`);
        else if (!r.isSimulated) console.warn(`ðŸ“§ Welcome email failed for ${cleanEmail}: ${r.error}`);
      })
      .catch((e) => console.warn('Welcome email notice:', e.message));

    res.status(201).json({
      message: 'Account created successfully in Google Sheets! ðŸ“Š',
      token,
      session_id: session ? session.sessionId : undefined,
      session_expires_at: session ? session.expiresAt : undefined,
      user: {
        id: userId,
        user_id: userId,
        name: cleanName,
        username: cleanUsername,
        email: cleanEmail,
        status: 'active',
        role: 'user',
      },
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/auth/login â€” Read user EXCLUSIVELY from Google Sheets
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const loginEmail = email.toLowerCase().trim();

    // â”€â”€ 1. Check MongoDB Admin collection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let Admin;
    try {
      Admin = require('../models/Admin');
    } catch (e) {}

    if (Admin) {
      try {
        const dbAdmin = await Admin.findOne({ email: loginEmail });
        if (dbAdmin) {
          if (!dbAdmin.is_active) {
            return res.status(403).json({ error: 'This admin account is currently deactivated.' });
          }

          const isMatch = await bcrypt.compare(password, dbAdmin.password_hash);
          if (isMatch) {
            dbAdmin.last_login = new Date();
            await dbAdmin.save();

            // Server-side 48h session for the admin login
            const session = await createLoginSession(req, dbAdmin.id || dbAdmin._id.toString(), 'Admin', dbAdmin.email, dbAdmin.name || dbAdmin.full_name).catch(() => null);
            const token = issueLoginToken({
              id: dbAdmin.id || dbAdmin._id.toString(),
              email: dbAdmin.email,
              name: dbAdmin.name || dbAdmin.full_name,
              role: 'admin',
            }, session);
            if (session) setSessionCookie(res, session.token, session.ttlMs);

            return res.json({
              message: 'Admin login successful.',
              token,
              session_id: session ? session.sessionId : undefined,
              session_expires_at: session ? session.expiresAt : undefined,
              user: {
                id: dbAdmin.id || dbAdmin._id.toString(),
                email: dbAdmin.email,
                name: dbAdmin.name || dbAdmin.full_name,
                role: 'admin',
                profile_image: dbAdmin.profile_image,
              },
            });
          }
        }
      } catch (e) {}
    }

    // â”€â”€ 2. Hardcoded admin fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const hardcodedAdmins = [
      { email: 'rupayandas2024@gmail.com', password: 'Rupayan', name: 'Rupayan' },
      { email: 'jaggik8888@gmail.com', password: 'Jaggik', name: 'Jaggik' },
    ];

    const hardcoded = hardcodedAdmins.find(a => a.email === loginEmail && a.password === password);
    if (hardcoded) {
      const hardcodedId = uuidv4();

      // Server-side 48h session for the admin login
      const session = await createLoginSession(req, hardcodedId, 'Admin', hardcoded.email, hardcoded.name).catch(() => null);
      const token = issueLoginToken({
        id: hardcodedId,
        email: hardcoded.email,
        name: hardcoded.name,
        role: 'admin',
      }, session);
      if (session) setSessionCookie(res, session.token, session.ttlMs);

      return res.json({
        message: 'Admin login successful.',
        token,
        session_id: session ? session.sessionId : undefined,
        session_expires_at: session ? session.expiresAt : undefined,
        user: {
          id: hardcodedId,
          email: hardcoded.email,
          name: hardcoded.name,
          role: 'admin',
        },
      });
    }

    // â”€â”€ 3. Read user EXCLUSIVELY from Google Sheets (Users tab) â”€â”€â”€â”€â”€â”€
    let sheetUser = await db.findRow(db.SHEETS.USERS, 'email', loginEmail);

    if (sheetUser) {
      if (sheetUser.status && sheetUser.status !== 'active') {
        return res.status(403).json({ error: `Account is ${sheetUser.status}. Please contact support.` });
      }

      if (password && sheetUser.passwordHash) {
        const validPassword = await bcrypt.compare(password, sheetUser.passwordHash);
        if (!validPassword) {
          logLoginFailure(req, {
            email: loginEmail,
            userId: sheetUser.user_id || sheetUser.id || '',
            detail: 'Incorrect password',
          });
          return res.status(401).json({ error: 'Invalid password.' });
        }
      }

      const now = new Date().toISOString();
      // Non-blocking background timestamp update to ensure instant response
      db.updateRow(db.SHEETS.USERS, 'email', loginEmail, {
        last_login_at: now,
        updated_at: now,
      }).catch((e) => console.warn('Background timestamp update notice:', e.message));

      // Second-factor gate — stop before any session exists.
      const gate = await twoFactorGate(req, sheetUser, {
        email: loginEmail,
        method: 'Email + 2FA',
      });
      if (gate.required) return res.json(gate.body);

      // Server-side 48h session
      const session = await createLoginSession(req, sheetUser.user_id || sheetUser.id, 'Email', loginEmail, sheetUser.name).catch(() => null);
      const token = issueLoginToken({
        id: sheetUser.user_id || sheetUser.id,
        email: sheetUser.email,
        name: sheetUser.name,
        role: 'user',
      }, session);
      if (session) setSessionCookie(res, session.token, session.ttlMs);

      return res.json({
        message: 'Login successful.',
        token,
        session_id: session ? session.sessionId : undefined,
        session_expires_at: session ? session.expiresAt : undefined,
        user: {
          id: sheetUser.user_id || sheetUser.id,
          user_id: sheetUser.user_id || sheetUser.id,
          email: sheetUser.email,
          name: sheetUser.name || 'User',
          username: sheetUser.username || sheetUser.email.split('@')[0],
          status: sheetUser.status || 'active',
          role: 'user',
        },
      });
    }

    // â”€â”€ 4. Auto-register user in Google Sheets if email-only flow â”€â”€â”€â”€
    const nameFromEmail = loginEmail.split('@')[0];
    const displayName = nameFromEmail.charAt(0).toUpperCase() + nameFromEmail.slice(1);
    const newUserId = uuidv4();
    const now = new Date().toISOString();

    sheetUser = {
      user_ID: newUserId,
      user_id: newUserId,
      id: newUserId,
      name: displayName,
      username: nameFromEmail,
      email: loginEmail,
      status: 'active',
      created_at: now,
      updated_at: now,
      last_login_at: now,
      last_logout_at: '',
    };
    await db.appendRow(db.SHEETS.USERS, sheetUser);

    // Server-side 48h session
    const session = await createLoginSession(req, newUserId, 'Email', loginEmail, displayName).catch(() => null);
    const token = issueLoginToken({ id: newUserId, email: loginEmail, name: displayName, role: 'user' }, session);
    if (session) setSessionCookie(res, session.token, session.ttlMs);

    // Send welcome email to the auto-registered user (fire-and-forget)
    emailService.sendWelcomeEmail(loginEmail, displayName)
      .then((r) => {
        if (r.success) console.log(`ðŸ“§ Welcome email queued for new user: ${loginEmail}`);
        else if (!r.isSimulated) console.warn(`ðŸ“§ Welcome email failed for ${loginEmail}: ${r.error}`);
      })
      .catch((e) => console.warn('Welcome email notice:', e.message));

    res.json({
      message: 'Login successful.',
      token,
      session_id: session ? session.sessionId : undefined,
      session_expires_at: session ? session.expiresAt : undefined,
      user: {
        id: newUserId,
        user_id: newUserId,
        name: displayName,
        username: nameFromEmail,
        email: loginEmail,
        status: 'active',
        role: 'user',
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/auth/google-config
router.get('/google-config', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || '930893529973-2j5h36csl909m139urdq552n63h1hl1q.apps.googleusercontent.com';
  res.json({
    clientId,
    configured: !!(clientId && !clientId.includes('your_google_client_id')),
  });
});

// GET /api/auth/google-redirect â€” Handle OAuth fragment redirects (#access_token=... or #id_token=...)
// OAuth handoff page â€” stores auth state and redirects immediately.
// Renders no visible "logging in" window: just the site background and the
// same top progress bar every page shows, so the hop reads as a page load.
// Google hands us the account's own avatar URL in the ID token. Persisting it
// is what lets the admin panel show the real Gmail profile photo next to an
// email address instead of guessing one from a third-party avatar service.
//
// It is re-written on every Google login because Google rotates these URLs,
// and it is only written when Google actually sent one -- a Google account
// with no photo, or a later email-OTP login, must never blank a photo we
// already have on file.
function googlePictureFields(picture) {
  const url = String(picture || '').trim();
  return url ? { profile_picture: url } : {};
}

function sendAuthHandoff(res, innerScript) {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>SaveHatke</title>
<style>
  body{background:#060d1f;margin:0;min-height:100vh}
  #shPageProgressBar{position:fixed;top:0;left:0;height:3px;width:0;z-index:10000;
    background:linear-gradient(90deg,#00e676,#00c853);box-shadow:0 0 10px rgba(0,230,118,.7);
    border-radius:0 3px 3px 0;transition:width .25s ease,opacity .4s ease;opacity:1;pointer-events:none}
</style>
</head>
<body>
<div id="shPageProgressBar"></div>
<script>
(function(){
  var bar=document.getElementById('shPageProgressBar');
  requestAnimationFrame(function(){bar.style.width='35%';});
  setTimeout(function(){bar.style.width='70%';},160);
})();
</script>
<script>${innerScript}</script>
</body>
</html>`);
}

router.get('/google-redirect', (req, res) => {
  sendAuthHandoff(res, `
    (async function() {
      const hash = window.location.hash;
      if (hash && (hash.includes('id_token=') || hash.includes('access_token='))) {
        const params = new URLSearchParams(hash.substring(1));
        const idToken = params.get('id_token');
        const accessToken = params.get('access_token');
        try {
          let payload = {};
          if (idToken) {
            payload = { credential: idToken };
          } else if (accessToken) {
            const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo?access_token=' + accessToken);
            const profile = await res.json();
            if (profile.email) {
              payload = { email: profile.email, name: profile.name, picture: profile.picture };
            }
          }
          if (payload.credential || payload.email) {
            const apiRes = await fetch('/api/auth/google', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            const data = await apiRes.json();
            if (data.token && data.user) {
              localStorage.setItem('sh_token', data.token);
              localStorage.setItem('sh_user', JSON.stringify(data.user));
              if (data.user.role === 'admin' || data.user.role === 'Super Admin' || data.user.role === 'Admin') {
                localStorage.setItem('sh_admin_token', data.token);
                localStorage.setItem('sh_admin_user', JSON.stringify(data.user));
                window.location.replace('/vault');
              } else {
                window.location.replace('/index');
              }
              return;
            }
          }
        } catch(e) {
          console.error(e);
        }
      }
      window.location.replace('/login');
    })();
  `);
});

// POST /api/auth/google-redirect â€” Handle Google OAuth redirect mode (same-page login)
router.post('/google-redirect', async (req, res) => {
  try {
    // Google form_post sends the token as 'id_token', but we also support 'credential'
    const credential = req.body.credential || req.body.id_token;
    let userEmail = '';
    let userName = '';
    let userPicture = '';

    if (credential) {
      try {
        let payloadBase64 = credential.split('.')[1];
        if (payloadBase64) {
          payloadBase64 = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
          const pad = payloadBase64.length % 4;
          if (pad) payloadBase64 += '='.repeat(4 - pad);
          const decodedJson = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
          if (decodedJson.email) userEmail = decodedJson.email;
          if (decodedJson.name) userName = decodedJson.name;
          if (decodedJson.picture) userPicture = decodedJson.picture;
        }
      } catch (e) {}
    }

    if (!userEmail) {
      return res.status(400).send('<h3>Google authentication failed: Email missing.</h3><a href="/login">Return to Login</a>');
    }

    userEmail = userEmail.toLowerCase();
    userName = userName || userEmail.split('@')[0];

    // Admin check
    const adminEmails = ['rupayandas2024@gmail.com', 'jaggik8888@gmail.com'];
    let isAdmin = adminEmails.includes(userEmail);
    let adminData = null;

    if (!isAdmin) {
      try {
        const AdminModel = require('../models/Admin');
        adminData = await AdminModel.findOne({ email: userEmail });
        if (adminData && adminData.is_active) isAdmin = true;
      } catch (e) {}
    }

    if (isAdmin) {
      const adminName = adminData ? (adminData.name || adminData.full_name) : userName;
      const adminId = adminData ? (adminData.id || adminData._id.toString()) : uuidv4();

      // Server-side 48h session for the admin login
      const session = await createLoginSession(req, adminId, 'Google Admin', userEmail, adminName).catch(() => null);
      const token = issueLoginToken({ id: adminId, email: userEmail, name: adminName, role: 'admin' }, session);
      if (session) setSessionCookie(res, session.token, session.ttlMs);

      const adminUser = {
        id: adminId,
        email: userEmail,
        name: adminName,
        picture: userPicture || '',
        role: 'admin',
      };

      return sendAuthHandoff(res, `
        try {
          localStorage.setItem('sh_token', ${JSON.stringify(token)});
          localStorage.setItem('sh_user', JSON.stringify(${JSON.stringify(adminUser)}));
          localStorage.setItem('sh_admin_token', ${JSON.stringify(token)});
          localStorage.setItem('sh_admin_user', JSON.stringify(${JSON.stringify(adminUser)}));
        } catch(e) {}
        window.location.replace('/vault');
      `);
    }

    // Save/Find user in Google Sheets (Users tab) asynchronously
    const now = new Date().toISOString();
    let sheetUser = await db.findRow(db.SHEETS.USERS, 'email', userEmail).catch(() => null);
    if (!sheetUser) {
      // Paranoid pre-create scan — see verify-otp path for rationale.
      const allRows = await db.getRows(db.SHEETS.USERS).catch(() => []);
      const existingDup = (allRows || []).find((r) => {
        const v = (r && r.email) ? String(r.email).toLowerCase().trim() : '';
        return v && v === userEmail;
      });
      if (existingDup) {
        sheetUser = existingDup;
        db.updateRow(db.SHEETS.USERS, 'email', userEmail, {
          last_login_at: now,
          updated_at: now,
          ...googlePictureFields(userPicture),
        }).catch((e) => console.warn('GSheet dedup update notice:', e.message));
      } else {
        const userId = uuidv4();
        sheetUser = {
          user_ID: userId,
          user_id: userId,
          id: userId,
          name: userName,
          username: userEmail.split('@')[0],
          email: userEmail,
          status: 'active',
          ...googlePictureFields(userPicture),
          created_at: now,
          updated_at: now,
          last_login_at: now,
          last_logout_at: '',
        };
        db.appendRow(db.SHEETS.USERS, sheetUser).catch((e) => console.warn('GSheet write notice:', e.message));
      }
    } else {
      db.updateRow(db.SHEETS.USERS, 'email', userEmail, {
        last_login_at: now,
        updated_at: now,
        ...googlePictureFields(userPicture),
      }).catch((e) => console.warn('GSheet update notice:', e.message));
    }

    const userId = sheetUser.user_id || sheetUser.id;

    // Second-factor gate — stop before any session exists.
    const gate = await twoFactorGate(req, sheetUser, {
      email: userEmail,
      method: 'Google + 2FA',
    });
    if (gate.required) return res.json(gate.body);

    // Server-side 48h session
    const session = await createLoginSession(req, userId, 'Google', userEmail, sheetUser.name || userName).catch(() => null);
    const token = issueLoginToken({
      id: userId,
      email: userEmail,
      name: sheetUser.name || userName,
      role: 'user',
    }, session);
    if (session) setSessionCookie(res, session.token, session.ttlMs);

    const regularUser = {
      id: userId,
      email: userEmail,
      name: sheetUser.name || userName,
      username: sheetUser.username || userEmail.split('@')[0],
      picture: userPicture || '',
      role: 'user',
    };

    return sendAuthHandoff(res, `
      try {
        localStorage.setItem('sh_token', ${JSON.stringify(token)});
        localStorage.setItem('sh_user', JSON.stringify(${JSON.stringify(regularUser)}));
      } catch(e) {}
      window.location.replace('/index');
    `);
  } catch (err) {
    console.error('Google redirect handler error:', err);
    res.status(500).send('<h3>Google authentication failed.</h3><a href="/login">Return to Login</a>');
  }
});

// POST /api/auth/google â€” Google login stored EXCLUSIVELY to Google Sheets
router.post('/google', async (req, res) => {
  try {
    const { credential, email, name, picture } = req.body;

    let userEmail = email;
    let userName = name;
    let userPicture = picture;

    // Parse payload if credential passed
    if (credential) {
      try {
        let payloadBase64 = credential.split('.')[1];
        if (payloadBase64) {
          payloadBase64 = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
          const pad = payloadBase64.length % 4;
          if (pad) payloadBase64 += '='.repeat(4 - pad);
          const decodedJson = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
          if (decodedJson.email) userEmail = decodedJson.email;
          if (decodedJson.name) userName = decodedJson.name;
          if (decodedJson.picture) userPicture = decodedJson.picture;
        }
      } catch (e) {}
    }

    if (!userEmail) {
      return res.status(400).json({ error: 'Google authentication failed: Email missing.' });
    }

    userEmail = userEmail.toLowerCase();
    userName = userName || userEmail.split('@')[0];

    // Admin check
    const adminEmails = ['rupayandas2024@gmail.com', 'jaggik8888@gmail.com'];
    let isAdmin = adminEmails.includes(userEmail);
    let adminData = null;

    if (!isAdmin) {
      try {
        const AdminModel = require('../models/Admin');
        adminData = await AdminModel.findOne({ email: userEmail });
        if (adminData && adminData.is_active) isAdmin = true;
      } catch (e) {}
    }

    if (isAdmin) {
      const adminName = adminData ? (adminData.name || adminData.full_name) : userName;
      const adminId = adminData ? (adminData.id || adminData._id.toString()) : uuidv4();

      // Server-side 48h session for the admin login
      const session = await createLoginSession(req, adminId, 'Google Admin', userEmail, adminName).catch(() => null);
      const token = issueLoginToken({ id: adminId, email: userEmail, name: adminName, role: 'admin' }, session);
      if (session) setSessionCookie(res, session.token, session.ttlMs);

      return res.json({
        message: 'Admin Google login successful.',
        token,
        session_id: session ? session.sessionId : undefined,
        session_expires_at: session ? session.expiresAt : undefined,
        user: {
          id: adminId,
          email: userEmail,
          name: adminName,
          picture: userPicture || '',
          role: 'admin',
        },
      });
    }

    // Save/Find user in Google Sheets (Users tab) asynchronously
    const now = new Date().toISOString();
    let sheetUser = await db.findRow(db.SHEETS.USERS, 'email', userEmail).catch(() => null);
    if (!sheetUser) {
      // Paranoid pre-create scan — see verify-otp path for rationale.
      const allRows = await db.getRows(db.SHEETS.USERS).catch(() => []);
      const existingDup = (allRows || []).find((r) => {
        const v = (r && r.email) ? String(r.email).toLowerCase().trim() : '';
        return v && v === userEmail;
      });
      if (existingDup) {
        sheetUser = existingDup;
        db.updateRow(db.SHEETS.USERS, 'email', userEmail, {
          last_login_at: now,
          updated_at: now,
          ...googlePictureFields(userPicture),
        }).catch((e) => console.warn('GSheet dedup update notice:', e.message));
      } else {
        const userId = uuidv4();
        sheetUser = {
          user_ID: userId,
          user_id: userId,
          id: userId,
          name: userName,
          username: userEmail.split('@')[0],
          email: userEmail,
          status: 'active',
          ...googlePictureFields(userPicture),
          created_at: now,
          updated_at: now,
          last_login_at: now,
          last_logout_at: '',
        };
        db.appendRow(db.SHEETS.USERS, sheetUser).catch((e) => console.warn('GSheet write notice:', e.message));
      }
    } else {
      db.updateRow(db.SHEETS.USERS, 'email', userEmail, {
        last_login_at: now,
        updated_at: now,
        ...googlePictureFields(userPicture),
      }).catch((e) => console.warn('GSheet update notice:', e.message));
    }

    // Second-factor gate — stop before any session exists.
    const gate = await twoFactorGate(req, sheetUser, {
      email: userEmail,
      method: 'Google + 2FA',
    });
    if (gate.required) return res.json(gate.body);

    // Server-side 48h session
    const session = await createLoginSession(req, sheetUser.user_id || sheetUser.id, 'Google', userEmail, sheetUser.name || userName).catch(() => null);
    const token = issueLoginToken({
      id: sheetUser.user_id || sheetUser.id,
      email: userEmail,
      name: sheetUser.name || userName,
      role: 'user',
    }, session);
    if (session) setSessionCookie(res, session.token, session.ttlMs);

    res.json({
      message: 'Google login successful.',
      token,
      session_id: session ? session.sessionId : undefined,
      session_expires_at: session ? session.expiresAt : undefined,
      user: {
        id: sheetUser.user_id || sheetUser.id,
        user_id: sheetUser.user_id || sheetUser.id,
        email: userEmail,
        name: sheetUser.name || userName,
        username: sheetUser.username || userEmail.split('@')[0],
        picture: userPicture,
        status: sheetUser.status || 'active',
        role: 'user',
      },
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Failed to authenticate with Google.' });
  }
});

// POST /api/auth/logout â€” Revoke the current session, record last_logout_at
// in the G Sheet, and clear the session cookie.
// Priority: the Bearer token's session (logs out only THIS device), then an
// explicit body.session_id, then the legacy email/user_id fallback (ends all
// of the user's sessions).
router.post('/logout', async (req, res) => {
  try {
    clearSessionCookie(res);
    const { email, user_id, session_id } = req.body;
    const now = new Date().toISOString();

    // 1) Best: revoke the session bound to the presented token (this device)
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    let revokedByToken = false;
    if (token) {
      const decoded = decodeTokenIgnoreExpiry(token);
      if (decoded && decoded.sid) {
        await supabase.endSessionByToken(hashSessionToken(decoded.sid), 'Logged out').catch(() => {});
        revokedByToken = true;
      }
    }

    // 2) Explicit session_id (e.g. "Log out this device" on the sessions page)
    if (!revokedByToken && session_id) {
      supabase.endSession(session_id).catch(() => {});
    }

    // 3) Legacy fallback â€” no session info available: end ALL sessions
    if (!revokedByToken && !session_id) {
      if (user_id) {
        supabase.endAllUserSessions(user_id).catch(() => {});
      } else if (email) {
        const sheetUser = await db.findRow(db.SHEETS.USERS, 'email', email.toLowerCase().trim()).catch(() => null);
        if (sheetUser && (sheetUser.user_id || sheetUser.id)) {
          supabase.endAllUserSessions(sheetUser.user_id || sheetUser.id).catch(() => {});
        }
      }
    }

    // Update G Sheet user record
    if (email) {
      db.updateRow(db.SHEETS.USERS, 'email', email.toLowerCase().trim(), {
        last_logout_at: now,
        updated_at: now,
      }).catch((e) => console.warn('Logout G Sheet notice:', e.message));
    }

    res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    console.warn('Logout notice:', err.message);
    res.json({ message: 'Logged out.' });
  }
});

// POST /api/auth/refresh â€” Issue a new token from an expired one.
// The new token can NEVER outlive the 48-hour session window that started
// at login; if the session was revoked or has expired, refresh is refused
// with SESSION_EXPIRED and the user must log in again.
router.post('/refresh', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided.' });
    }

    const result = await refreshToken(token);
    if (!result) {
      const stale = decodeTokenIgnoreExpiry(token);
      const msg = (stale && String(stale.role).toLowerCase() === 'admin')
        ? 'Your 2-hour admin session has expired. Please log in again.'
        : 'Your 2-day login session has expired. Please log in again.';
      return res.status(401).json({
        error: msg,
        code: 'SESSION_EXPIRED',
      });
    }

    res.json({ token: result.token, message: 'Token refreshed.' });
  } catch (err) {
    console.error('Token refresh error:', err);
    res.status(500).json({ error: 'Token refresh failed.' });
  }
});

// â”€â”€ Device / session management (user-facing) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// GET /api/auth/sessions â€” List the current user's sessions (device page).
// Never exposes raw session tokens â€” only metadata plus an is_current flag.
router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const rows = await supabase.getUserSessions(req.user.id);

    // req.sessionId was set by the middleware from the validated session â€”
    // use it to flag which row is the device making this request.
    const sessions = rows.map((r) => ({
      session_id: r.session_id,
      device: r.device || 'Unknown device',
      os: r.os || '',
      browser: r.browser || '',
      ip_address: r.ip_address || '',
      login_method: r.login_method || '',
      login_time: r.login_time,
      last_active: r.last_active,
      expires_at: r.expires_at,
      status: r.status,
      is_current: Boolean(req.sessionId) && r.session_id === req.sessionId,
    }));

    res.json({ sessions, current_session_id: req.sessionId || null });
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Could not load sessions.' });
  }
});

// POST /api/auth/sessions/revoke â€” "Log out this device".
// The session id must belong to the authenticated user â€” one user can never
// revoke another user's session.
router.post('/sessions/revoke', authenticateToken, async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) {
      return res.status(400).json({ error: 'session_id is required.' });
    }

    const row = await supabase.findSessionById(session_id);
    if (!row) {
      return res.status(404).json({ error: 'Session not found.' });
    }
    if (String(row.user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'You can only manage your own sessions.' });
    }

    await supabase.endSession(session_id, 'Logged out');

    // Revoking the session this request came from? Clear the cookie too.
    if (req.sessionId === session_id) clearSessionCookie(res);

    res.json({ message: 'Device logged out.' });
  } catch (err) {
    console.error('Revoke session error:', err);
    res.status(500).json({ error: 'Could not log out this device.' });
  }
});

// POST /api/auth/sessions/revoke-all â€” "Log out all devices".
// Revokes every Active session for the authenticated user (including the
// current one). The account/profile is untouched.
router.post('/sessions/revoke-all', authenticateToken, async (req, res) => {
  try {
    await supabase.endAllUserSessions(req.user.id);
    clearSessionCookie(res);
    res.json({ message: 'All devices have been logged out.' });
  } catch (err) {
    console.error('Revoke all sessions error:', err);
    res.status(500).json({ error: 'Could not log out all devices.' });
  }
});

// POST /api/auth/sessions/revoke-others - "Log out of all other devices".
// Every other Active session for this user is revoked; the session this
// request came from stays Active, so the current device is NOT signed out.
router.post('/sessions/revoke-others', authenticateToken, async (req, res) => {
  try {
    // Without a known current session id we cannot promise "your current
    // session will remain active" - refuse rather than silently sign the user
    // out of the device they are using.
    if (!req.sessionId) {
      return res.status(409).json({
        error: 'This device\u2019s session could not be identified. Please sign in again and retry.',
      });
    }

    await supabase.endAllUserSessions(req.user.id, { exceptSessionId: req.sessionId });
    res.json({ message: 'All other devices have been logged out.' });
  } catch (err) {
    console.error('Revoke other sessions error:', err);
    res.status(500).json({ error: 'Could not log out the other devices.' });
  }
});

// GET /api/auth/login-history â€” Read-only sign-in log for the security page.
//
// Two sources, merged newest-first:
//   â€¢ user_sessions        â†’ every successful sign-in (a session only exists
//                            because the login succeeded), including ones that
//                            have since expired or been logged out.
//   â€¢ SecurityAudit rows   â†’ rejected attempts (wrong password, failed 2FA
//                            code), which never produce a session row.
//
// Never exposes session tokens or IP addresses â€” only what the user needs to
// recognise their own activity: when, from what, roughly where, and whether it
// worked. If the audit log is unreachable the successful history is still
// returned, with failures_available:false so the UI can say so honestly.
router.get('/login-history', authenticateToken, async (req, res) => {
  const LIMIT = 50;

  // Session rows carry a flag emoji beside the country for the admin view. Some
  // older rows hold it mis-decoded (the UTF-8 bytes read back as Latin-1 or
  // CP1252), so strip the real emoji and both mangled forms — the user-facing
  // location line is plain text either way.
  const stripFlag = (v) => String(v || '')
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/\u00f0[\u009f\u0178][\u0087\u2021][\u0080-\u00bf]/g, '')
    .trim();

  const placeOf = (r) => [r.city, r.state, stripFlag(r.country)]
    .map((p) => String(p || '').trim())
    .filter((p) => p && !/^unknown$/i.test(p))
    .filter((p, i, arr) => arr.indexOf(p) === i)
    .join(', ');

  try {
    const rows = await supabase.getUserSessions(req.user.id);

    const entries = rows.map((r) => ({
      at: r.login_time,
      browser: r.browser || '',
      os: r.os || '',
      device: r.device || '',
      location: placeOf(r),
      method: r.login_method || '',
      status: 'Successful',
      detail: '',
      is_current: Boolean(req.sessionId) && r.session_id === req.sessionId,
      session_status: r.status || '',
    }));

    // Failed attempts are keyed by email in the audit log â€” a rejected login
    // may not have resolved a user id at all.
    let failuresAvailable = true;
    try {
      const audit = await db.findRows(db.SHEETS.SECURITY_AUDIT, 'email', String(req.user.email || '').toLowerCase().trim());
      audit
        .filter((r) => String(r.outcome || '').toLowerCase() === 'failure'
          && /login_failed$/.test(String(r.event || '')))
        .forEach((r) => {
          const [browser = '', os = ''] = String(r.device || '').split('\u2022').map((s) => s.trim());
          entries.push({
            at: r.createdAt,
            browser,
            os,
            device: r.device || '',
            location: '',
            method: String(r.event) === '2fa_login_failed' ? 'Two-factor code' : 'Email',
            status: 'Failed',
            detail: r.detail || '',
            is_current: false,
            session_status: '',
          });
        });
    } catch (e) {
      failuresAvailable = false;
    }

    entries.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

    res.json({ entries: entries.slice(0, LIMIT), failures_available: failuresAvailable });
  } catch (err) {
    console.error('Login history error:', err);
    res.status(500).json({ error: 'Could not load your login history.' });
  }
});

// GET|POST /api/auth/session-cleanup â€” 10-minute expiry sweep endpoint for
// external/Vercel cron. Guarded by SESSION_CLEANUP_SECRET (query param
// `secret` or `x-cleanup-secret` header) when configured; otherwise only
// an authenticated admin may trigger it.
router.all('/session-cleanup', async (req, res) => {
  const secret = process.env.SESSION_CLEANUP_SECRET;
  if (secret) {
    const provided = req.query.secret || req.headers['x-cleanup-secret'];
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
  } else {
    // No secret configured â€” require an admin bearer token
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized.' });
    const decoded = decodeTokenIgnoreExpiry(token);
    const role = decoded && decoded.role ? String(decoded.role).toLowerCase() : '';
    if (!decoded || !(role === 'admin' || role === 'super admin' || role === 'support')) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
  }

  const result = await sessionCleanup.runSessionCleanup();
  res.json({ message: 'Session cleanup complete.', expired: result.count, ranAt: new Date().toISOString() });
});

// GET /api/auth/me
router.get('/me', authenticateToken, async (req, res) => {
  try {
    // The JWT is issued at login and never changes, so the account status has
    // to be read live — otherwise an admin suspending the account is invisible
    // to the logged-in browser until the user signs out and back in.
    let status = 'active';
    let suspendReason = '';
    try {
      let row = null;
      if (req.user.id) {
        row = await db.findRow(db.SHEETS.USERS, 'user_id', req.user.id)
          || await db.findRow(db.SHEETS.USERS, 'id', req.user.id);
      }
      if (!row && req.user.email) {
        row = await db.findRow(db.SHEETS.USERS, 'email', String(req.user.email).toLowerCase().trim());
      }
      if (row) {
        status = String(row.status || 'active').toLowerCase();
        if (status !== 'active') suspendReason = String(row.suspend_reason || '');
      }
    } catch (e) {
      // Sheet unreachable — fall back to 'active' rather than locking the user
      // out of their own dashboard on a transient read failure.
      console.warn('[auth/me] account status lookup failed:', e.message);
    }

    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        role: req.user.role,
        status,
        ...(suspendReason ? { suspendReason } : {}),
      },
    });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Notification preferences ───────────────────────────────────────────────
// Every category the user can actually switch, with its default. Account and
// security notices are deliberately not in this map: they are mandatory, so
// there is nothing to store and nothing to switch off. Marketing is the only
// category that starts off.
const NOTIFICATION_DEFAULTS = Object.freeze({
  coupon_activity: true,
  purchases: true,
  sales: true,
  payments: true,
  reviews: true,
  support: true,
  marketing: false,
});

// Reads the stored JSON blob and fills every known key, so a preference added
// after the row was written still comes back with its default instead of
// undefined. A corrupt cell degrades to the defaults rather than a 500.
function parseNotificationPrefs(raw) {
  let stored = {};
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') stored = parsed;
    } catch (e) {
      console.warn('[notification-preferences] unparseable value, using defaults');
    }
  } else if (raw && typeof raw === 'object') {
    stored = raw;
  }

  const out = {};
  for (const [key, dflt] of Object.entries(NOTIFICATION_DEFAULTS)) {
    out[key] = typeof stored[key] === 'boolean' ? stored[key] : dflt;
  }
  return out;
}

// The Users sheet is keyed on user_ID, but older rows were written before the
// id existed, so email is the fallback lookup — same order as /me.
async function findUserRowForRequest(user) {
  if (!user) return null;
  if (user.id) {
    const byId = await db.findRow(db.SHEETS.USERS, 'user_id', user.id)
      || await db.findRow(db.SHEETS.USERS, 'id', user.id);
    if (byId) return byId;
  }
  if (user.email) {
    return db.findRow(db.SHEETS.USERS, 'email', String(user.email).toLowerCase().trim());
  }
  return null;
}

router.get('/notification-preferences', authenticateToken, async (req, res) => {
  try {
    const row = await findUserRowForRequest(req.user);
    if (!row) return res.status(404).json({ error: 'Account not found.' });

    res.json({
      preferences: parseNotificationPrefs(row.notification_prefs),
      defaults: { ...NOTIFICATION_DEFAULTS },
    });
  } catch (err) {
    console.error('[notification-preferences] read failed:', err.message);
    res.status(500).json({ error: 'Unable to load notification settings.' });
  }
});

router.put('/notification-preferences', authenticateToken, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const incoming = body.preferences && typeof body.preferences === 'object' ? body.preferences : body;

    const unknown = Object.keys(incoming).filter((k) => !(k in NOTIFICATION_DEFAULTS));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown notification setting: ${unknown.join(', ')}` });
    }

    const row = await findUserRowForRequest(req.user);
    if (!row) return res.status(404).json({ error: 'Account not found.' });

    // Merge onto what is already stored so a single-toggle PATCH-style save
    // never silently resets the other categories.
    const merged = parseNotificationPrefs(row.notification_prefs);
    for (const [key, value] of Object.entries(incoming)) {
      if (typeof value === 'boolean') merged[key] = value;
    }

    const idField = row.user_ID !== undefined ? 'user_ID' : (row.user_id !== undefined ? 'user_id' : 'email');
    const idValue = idField === 'email' ? String(row.email || '').toLowerCase().trim() : row[idField];

    await db.updateRow(db.SHEETS.USERS, idField, idValue, {
      notification_prefs: JSON.stringify(merged),
      updated_at: new Date().toISOString(),
    });

    res.json({ preferences: merged });
  } catch (err) {
    console.error('[notification-preferences] save failed:', err.message);
    res.status(500).json({ error: 'Unable to save notification settings.' });
  }
});

// â”€â”€ One-time onboarding flags â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Small booleans that record which product tours the account has already
// seen, so a tutorial auto-opens exactly once per user rather than once per
// browser. Stored as a JSON blob in Users.onboarding_state alongside the
// notification blob above, and read with the same defaults-on-missing rule.
// Signed-out visitors have nowhere to persist this, so the client falls back
// to local storage for them.
const ONBOARDING_DEFAULTS = Object.freeze({
  marketplaceTutorialCompleted: false,
  marketplaceTutorialSkipped: false,
});

function parseOnboardingState(raw) {
  let stored = {};
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') stored = parsed;
    } catch (e) {
      console.warn('[onboarding] unparseable value, using defaults');
    }
  } else if (raw && typeof raw === 'object') {
    stored = raw;
  }

  const out = {};
  for (const [key, dflt] of Object.entries(ONBOARDING_DEFAULTS)) {
    out[key] = typeof stored[key] === 'boolean' ? stored[key] : dflt;
  }
  return out;
}

router.get('/onboarding', authenticateToken, async (req, res) => {
  try {
    const row = await findUserRowForRequest(req.user);
    if (!row) return res.status(404).json({ error: 'Account not found.' });

    res.json({
      onboarding: parseOnboardingState(row.onboarding_state),
      defaults: { ...ONBOARDING_DEFAULTS },
    });
  } catch (err) {
    console.error('[onboarding] read failed:', err.message);
    res.status(500).json({ error: 'Unable to load your onboarding state.' });
  }
});

router.put('/onboarding', authenticateToken, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const incoming = body.onboarding && typeof body.onboarding === 'object' ? body.onboarding : body;

    const unknown = Object.keys(incoming).filter((k) => !(k in ONBOARDING_DEFAULTS));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown onboarding flag: ${unknown.join(', ')}` });
    }
    const nonBoolean = Object.entries(incoming).filter(([, v]) => typeof v !== 'boolean');
    if (nonBoolean.length) {
      return res.status(400).json({ error: 'Onboarding flags must be true or false.' });
    }

    const row = await findUserRowForRequest(req.user);
    if (!row) return res.status(404).json({ error: 'Account not found.' });

    // Merge, so marking one tour seen never clears another.
    const merged = { ...parseOnboardingState(row.onboarding_state), ...incoming };

    const idField = row.user_ID !== undefined ? 'user_ID' : (row.user_id !== undefined ? 'user_id' : 'email');
    const idValue = idField === 'email' ? String(row.email || '').toLowerCase().trim() : row[idField];

    await db.updateRow(db.SHEETS.USERS, idField, idValue, {
      onboarding_state: JSON.stringify(merged),
      updated_at: new Date().toISOString(),
    });

    res.json({ onboarding: merged });
  } catch (err) {
    console.error('[onboarding] save failed:', err.message);
    res.status(500).json({ error: 'Unable to save your onboarding state.' });
  }
});

module.exports = router;

// The 2FA login exchange in routes/twoFactor.js has to mint exactly the same
// session, JWT and cookie that a normal login does — the whole point is that no
// session exists until the second factor is verified. Publishing the two
// helpers here keeps a single implementation of "log this user in" instead of a
// second copy that could drift.
module.exports.createLoginSession = createLoginSession;
module.exports.issueLoginToken = issueLoginToken;
module.exports.setSessionCookie = setSessionCookie;

