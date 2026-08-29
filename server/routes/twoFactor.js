// ============================================
// SaveHatke — Two-Factor Authentication Routes
// ============================================
// Authenticator-app (TOTP) 2FA for the passwordless account system.
//
// Enrolment is deliberately multi-step, and every step is verified server-side:
//   POST /setup/start          send an email OTP to the account address
//   POST /setup/verify-email   consume that OTP  -> step-up token
//   POST /setup/secret         issue an unconfirmed secret + QR (needs step-up)
//   POST /setup/enable         verify a live TOTP code -> enable + recovery codes
//
// Sensitive changes (disable, regenerate recovery codes, re-enrol a new
// authenticator) all require BOTH a fresh email-OTP step-up token AND a current
// authenticator code, so neither a stolen session nor a stolen inbox is enough
// on its own.
//
// Login: POST /login exchanges a half-completed login (challenge token minted
// by /api/auth/verify-otp or the Google paths) plus a TOTP or recovery code for
// a real session. No session, JWT or cookie exists until that call succeeds.

const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const { authenticateToken } = require('../middleware/auth');
const getClientIP = require('../middleware/getClientIP');
const db = require('../services/googleSheets');
const otpService = require('../services/otpService');
const emailService = require('../services/emailService');
const twoFactor = require('../services/twoFactorService');
// Session minting lives in routes/auth.js and is published on its router
// object, so a 2FA login produces exactly the same session as a normal one.
const authRoutes = require('./auth');

const router = express.Router();

// ── Rate limits ────────────────────────────────────────────────────────────
// Everything that checks a secret gets a budget well below the generic
// /api/auth limit. The key differs by endpoint on purpose.

// Unauthenticated and directly brute-forceable, so this one is keyed to the IP.
const loginVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please try again in a few minutes.' },
});

// Authenticated verification, keyed to the account rather than the IP. Keying
// these to the IP would let one user on a shared office or carrier-NAT address
// exhaust the budget for everyone else behind it. Every route using this runs
// authenticateToken first, so req.user is populated by the time it is called.
function accountKey(req) {
  const who = (req.user && (req.user.id || req.user.email)) || '';
  return who ? `2fa:${String(who).toLowerCase()}` : `2fa-ip:${req.ip}`;
}

const accountVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  keyGenerator: accountKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: 'Too many verification attempts. Please try again in a few minutes.' },
});

const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: accountKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: 'Too many requests. Please try again in a few minutes.' },
});

// Per-challenge attempt ceiling, on top of the per-IP limiter above. The
// challenge token itself is stateless, so the count lives here keyed by a hash
// of the token. On a multi-instance deployment this is per-instance; the IP
// limiter and the 5-minute challenge lifetime are the guarantees that hold
// everywhere, and this simply closes the single-instance case tightly.
const MAX_CHALLENGE_ATTEMPTS = 5;
const challengeAttempts = new Map();

function challengeKey(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function bumpChallengeAttempts(token) {
  const key = challengeKey(token);
  const now = Date.now();

  // Opportunistic sweep — the map only ever holds live challenges.
  if (challengeAttempts.size > 500) {
    for (const [k, v] of challengeAttempts) {
      if (v.expires < now) challengeAttempts.delete(k);
    }
  }

  const entry = challengeAttempts.get(key) || { count: 0, expires: now + 10 * 60 * 1000 };
  entry.count += 1;
  challengeAttempts.set(key, entry);
  return entry.count;
}

function challengeAttemptsExhausted(token) {
  const entry = challengeAttempts.get(challengeKey(token));
  return Boolean(entry && entry.count >= MAX_CHALLENGE_ATTEMPTS);
}

function clearChallengeAttempts(token) {
  challengeAttempts.delete(challengeKey(token));
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function requestContext(req) {
  const ip = getClientIP(req);
  // twoFactorService binds its tokens to this value, so it must be the same
  // resolved IP on both the issue and the verify side.
  req.clientIpForTwoFactor = ip;
  const ua = String((req.headers && req.headers['user-agent']) || '');
  return { ip, device: ua.slice(0, 180) };
}

function ensureConfigured(res) {
  if (twoFactor.isConfigured()) return true;
  console.error('[2fa] TWOFA_ENCRYPTION_KEY is not configured — refusing to enrol.');
  res.status(503).json({ error: 'Two-factor authentication is temporarily unavailable. Please try again later.' });
  return false;
}

/** The signed-in user's identity as the sheets store knows it. */
function actor(req) {
  return { id: req.user.id || '', email: twoFactor.normEmail(req.user.email) };
}

/** Look up the display name for an email so notices can greet the user. */
async function displayNameFor(email) {
  try {
    const row = await db.findRow(db.SHEETS.USERS, 'email', twoFactor.normEmail(email));
    return (row && row.name) || '';
  } catch (e) {
    return '';
  }
}

/**
 * Fire-and-forget account-security notice. Never awaited on a request path: a
 * mail outage must not fail or delay the security change itself.
 */
function notifySecurityChange({ email, ip, device, change, recoveryCodesRemaining }) {
  displayNameFor(email)
    .then((userName) => emailService.sendTwoFactorSecurityEmail({
      to: email, userName, change, ip, device, when: Date.now(), recoveryCodesRemaining,
    }))
    .then((r) => {
      if (!r || r.success) return;
      if (r.isSimulated) console.warn(`[2fa] "${change}" notice not sent (SMTP unconfigured) for ${email}`);
      else console.warn(`[2fa] "${change}" notice failed for ${email}: ${r.error}`);
    })
    .catch((e) => console.warn('[2fa] security notice error:', e.message));
}

// ── GET /status ────────────────────────────────────────────────────────────
// Authenticated only, so it reveals nothing to an unauthenticated attacker.
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const me = actor(req);
    const record = await twoFactor.findRecord({ userId: me.id, email: me.email });
    res.json({
      ...twoFactor.describeRecord(record),
      maskedEmail: twoFactor.maskEmail(me.email),
      available: twoFactor.isConfigured(),
    });
  } catch (err) {
    console.error('[2fa] status failed:', err.message);
    res.status(500).json({ error: 'Unable to load your two-factor status.' });
  }
});

// ── POST /setup/start ──────────────────────────────────────────────────────
// Step 1: prove control of the registered email before anything is issued.
// Also used as the "resend" endpoint — otpService owns the cooldown.
router.post('/setup/start', authenticateToken, setupLimiter, async (req, res) => {
  try {
    if (!ensureConfigured(res)) return;

    const me = actor(req);
    const { ip, device } = requestContext(req);

    const result = await otpService.requestOTP(me.id, me.email, ip);
    if (!result.success) {
      // Cooldown / hourly / daily ceilings all surface as the service's own copy.
      return res.status(429).json({ error: result.error, retryAfterSeconds: result.retryAfterSeconds });
    }

    const sent = await emailService.sendOTPEmail(me.email, result.otp);
    if (!sent.success && !sent.isSimulated) {
      console.warn('[2fa] setup OTP email failed:', sent.error);
      return res.status(502).json({ error: 'We could not send the verification code. Please try again.' });
    }

    await twoFactor.logSecurityEvent({
      userId: me.id, email: me.email, event: twoFactor.EVENTS.SETUP_STARTED,
      ip, device, detail: 'Verification code sent to the account email',
    });

    res.json({
      message: 'Verification code sent.',
      maskedEmail: twoFactor.maskEmail(me.email),
      cooldownSeconds: Math.round(otpService.COOLDOWN_MS / 1000),
    });
  } catch (err) {
    console.error('[2fa] setup/start failed:', err.message);
    res.status(500).json({ error: 'Unable to start two-factor setup.' });
  }
});

// ── POST /setup/verify-email ───────────────────────────────────────────────
// Consumes the email OTP and hands back a short-lived step-up token. That token
// is the "recent verification" every sensitive operation below insists on.
router.post('/setup/verify-email', authenticateToken, accountVerifyLimiter, async (req, res) => {
  try {
    if (!ensureConfigured(res)) return;

    const me = actor(req);
    const { ip, device } = requestContext(req);
    const otp = String((req.body && req.body.otp) || '').replace(/\D/g, '');

    if (otp.length !== 6) {
      return res.status(400).json({ error: 'Enter the 6-digit code we emailed you.' });
    }

    const check = await otpService.verifyOTP(me.id, me.email, otp);
    if (!check.valid) {
      await twoFactor.logSecurityEvent({
        userId: me.id, email: me.email, event: twoFactor.EVENTS.VERIFY_FAILED,
        outcome: 'failure', ip, device, detail: 'Email verification code rejected during 2FA setup',
      });
      return res.status(400).json({ error: check.error || 'That code is not valid.' });
    }

    await twoFactor.logSecurityEvent({
      userId: me.id, email: me.email, event: twoFactor.EVENTS.EMAIL_VERIFIED, ip, device,
    });

    res.json({
      message: 'Email verified.',
      stepUpToken: twoFactor.issueStepUpToken({ id: me.id, email: me.email }, req),
    });
  } catch (err) {
    console.error('[2fa] setup/verify-email failed:', err.message);
    res.status(500).json({ error: 'Unable to verify that code.' });
  }
});

// ── POST /setup/secret ────────────────────────────────────────────────────
// Step 2: mint an unconfirmed secret and render it as a QR plus a manual key.
// It is stored only as pendingSecretEncrypted, so an abandoned setup can never
// authenticate anything, and an existing enabled authenticator keeps working
// until /setup/enable succeeds.
router.post('/setup/secret', authenticateToken, setupLimiter, async (req, res) => {
  try {
    if (!ensureConfigured(res)) return;

    const me = actor(req);
    const { ip, device } = requestContext(req);

    const stepUp = twoFactor.verifyStepUpToken((req.body && req.body.stepUpToken) || '', me, req);
    if (!stepUp.ok) return res.status(401).json({ error: stepUp.error });

    const enrolment = await twoFactor.createEnrolment(me.email);
    await twoFactor.saveRecord(
      { userId: me.id, email: me.email },
      {
        pendingSecretEncrypted: twoFactor.encryptSecret(enrolment.base32),
        pendingCreatedAt: twoFactor.nowIso(),
      },
    );

    await twoFactor.logSecurityEvent({
      userId: me.id, email: me.email, event: twoFactor.EVENTS.SECRET_ISSUED, ip, device,
      detail: 'Authenticator secret issued for an unconfirmed enrolment',
    });

    // The QR encodes the secret, so the manual key reveals nothing extra. Both
    // are returned only inside this step-up-gated response and never persisted
    // anywhere the UI can re-read them.
    res.json({
      qrDataUrl: enrolment.qrDataUrl,
      manualKey: twoFactor.formatManualKey(enrolment.base32),
      issuer: 'SaveHatke',
      account: me.email,
      expiresInSeconds: Math.round(twoFactor.PENDING_SETUP_TTL_MS / 1000),
    });
  } catch (err) {
    console.error('[2fa] setup/secret failed:', err.message);
    res.status(500).json({ error: 'Unable to start authenticator setup.' });
  }
});

// ── POST /setup/enable ────────────────────────────────────────────────────
// Step 3 + 4: a live code from the app proves the secret actually reached it.
// Only then is 2FA switched on, and only then are recovery codes minted. They
// are returned exactly once, here.
router.post('/setup/enable', authenticateToken, accountVerifyLimiter, async (req, res) => {
  try {
    if (!ensureConfigured(res)) return;

    const me = actor(req);
    const { ip, device } = requestContext(req);

    const stepUp = twoFactor.verifyStepUpToken((req.body && req.body.stepUpToken) || '', me, req);
    if (!stepUp.ok) return res.status(401).json({ error: stepUp.error });

    const record = await twoFactor.findRecord({ userId: me.id, email: me.email });
    if (!twoFactor.isPendingFresh(record)) {
      return res.status(409).json({ error: 'This setup has expired. Please scan a new QR code.' });
    }

    const secret = twoFactor.decryptSecret(record.pendingSecretEncrypted);
    if (!secret) {
      console.error('[2fa] pending secret could not be decrypted — key rotated?');
      return res.status(409).json({ error: 'This setup is no longer valid. Please scan a new QR code.' });
    }

    const check = twoFactor.verifyTotp(secret, (req.body && req.body.code) || '', 0);
    if (!check.ok) {
      await twoFactor.logSecurityEvent({
        userId: me.id, email: me.email, event: twoFactor.EVENTS.VERIFY_FAILED,
        outcome: 'failure', ip, device, detail: 'Authenticator code rejected while enabling 2FA',
      });
      return res.status(400).json({ error: check.error });
    }

    const wasEnabled = twoFactor.truthy(record.enabled);
    const codes = await twoFactor.generateRecoveryCodes();

    await twoFactor.saveRecord({ userId: me.id, email: me.email }, {
      enabled: 'true',
      secretEncrypted: record.pendingSecretEncrypted,
      pendingSecretEncrypted: '',
      pendingCreatedAt: '',
      recoveryCodes: JSON.stringify(codes.stored),
      lastCounter: String(check.counter),
      enabledAt: wasEnabled ? (record.enabledAt || twoFactor.nowIso()) : twoFactor.nowIso(),
      disabledAt: '',
      lastUsedAt: twoFactor.nowIso(),
    });

    await twoFactor.logSecurityEvent({
      userId: me.id, email: me.email,
      event: wasEnabled ? twoFactor.EVENTS.AUTHENTICATOR_CHANGED : twoFactor.EVENTS.ENABLED,
      ip, device,
      detail: wasEnabled ? 'Authenticator app replaced' : 'Authenticator app connected',
    });

    notifySecurityChange({
      email: me.email, ip, device,
      change: wasEnabled ? 'authenticator_changed' : 'enabled',
    });

    res.json({
      message: 'Two-factor authentication enabled.',
      enabledAt: twoFactor.nowIso(),
      recoveryCodes: codes.plain,
    });
  } catch (err) {
    console.error('[2fa] setup/enable failed:', err.message);
    res.status(500).json({ error: 'Unable to enable two-factor authentication.' });
  }
});

/**
 * Verify a second factor against an enabled enrolment and spend it.
 *
 * Accepts a live authenticator code or, when `allowRecovery`, one unused
 * recovery code. Both are single-use: an accepted TOTP time-step is recorded in
 * lastCounter and an accepted recovery code is stamped used before this returns,
 * so neither can be replayed.
 *
 * @returns {Promise<{ok:true, method:string, counter?:number}|{ok:false, status:number, error:string}>}
 */
async function consumeSecondFactor({ record, body, me, ip, device, allowRecovery = true }) {
  const code = String(body.code || '').replace(/\D/g, '');
  const recoveryCode = String(body.recoveryCode || '').trim();

  // ── Authenticator code ──
  if (code) {
    const secret = twoFactor.decryptSecret(record.secretEncrypted);
    if (!secret) {
      console.error('[2fa] stored secret could not be decrypted — TWOFA_ENCRYPTION_KEY rotated?');
      return { ok: false, status: 409, error: 'Your authenticator could not be verified. Use a recovery code instead.' };
    }

    const check = twoFactor.verifyTotp(secret, code, record.lastCounter);
    if (!check.ok) {
      await twoFactor.logSecurityEvent({
        userId: me.id, email: me.email, event: twoFactor.EVENTS.VERIFY_FAILED,
        outcome: 'failure', ip, device, detail: 'Authenticator code rejected',
      });
      return { ok: false, status: 400, error: check.error };
    }

    await twoFactor.saveRecord({ userId: me.id, email: me.email }, {
      lastCounter: String(check.counter),
      lastUsedAt: twoFactor.nowIso(),
    });
    return { ok: true, method: 'authenticator', counter: check.counter };
  }

  // ── Recovery code ──
  if (recoveryCode) {
    if (!allowRecovery) {
      return { ok: false, status: 400, error: 'Enter the 6-digit code from your authenticator app.' };
    }

    const codes = twoFactor.parseRecoveryCodes(record.recoveryCodes);
    const match = await twoFactor.matchRecoveryCode(codes, recoveryCode);
    if (!match.ok) {
      await twoFactor.logSecurityEvent({
        userId: me.id, email: me.email, event: twoFactor.EVENTS.VERIFY_FAILED,
        outcome: 'failure', ip, device, detail: 'Recovery code rejected',
      });
      return { ok: false, status: 400, error: 'That recovery code is not valid or has already been used.' };
    }

    // Spend it before returning, so a concurrent request cannot reuse it.
    codes[match.index] = { ...codes[match.index], usedAt: twoFactor.nowIso(), usedIp: ip || '' };
    await twoFactor.saveRecord({ userId: me.id, email: me.email }, {
      recoveryCodes: JSON.stringify(codes),
      lastUsedAt: twoFactor.nowIso(),
    });

    const remaining = codes.filter((c) => !c.usedAt).length;
    await twoFactor.logSecurityEvent({
      userId: me.id, email: me.email, event: twoFactor.EVENTS.RECOVERY_USED, ip, device,
      detail: `Recovery code spent; ${remaining} of ${codes.length} remaining`,
    });
    notifySecurityChange({
      email: me.email, ip, device, change: 'recovery_used', recoveryCodesRemaining: remaining,
    });

    return { ok: true, method: 'recovery code', remaining };
  }

  return { ok: false, status: 400, error: 'Enter the 6-digit code from your authenticator app.' };
}

// ── POST /disable ─────────────────────────────────────────────────────────
// Never one-click. Needs a fresh email-OTP step-up token AND a live
// authenticator code (or an unused recovery code, for someone who has lost the
// app but still wants to turn 2FA off).
router.post('/disable', authenticateToken, accountVerifyLimiter, async (req, res) => {
  try {
    const me = actor(req);
    const { ip, device } = requestContext(req);
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    const stepUp = twoFactor.verifyStepUpToken(body.stepUpToken || '', me, req);
    if (!stepUp.ok) return res.status(401).json({ error: stepUp.error });

    const record = await twoFactor.findRecord({ userId: me.id, email: me.email });
    if (!record || !twoFactor.truthy(record.enabled)) {
      return res.status(409).json({ error: 'Two-factor authentication is not enabled on this account.' });
    }

    const proof = await consumeSecondFactor({ record, body, me, ip, device });
    if (!proof.ok) return res.status(proof.status).json({ error: proof.error });

    await twoFactor.saveRecord({ userId: me.id, email: me.email }, {
      enabled: 'false',
      secretEncrypted: '',
      pendingSecretEncrypted: '',
      pendingCreatedAt: '',
      // Recovery codes are worthless without an enrolment, and keeping spent
      // ones around would let a later re-enrol inherit a used set.
      recoveryCodes: '[]',
      lastCounter: '',
      disabledAt: twoFactor.nowIso(),
    });

    await twoFactor.logSecurityEvent({
      userId: me.id, email: me.email, event: twoFactor.EVENTS.DISABLED, ip, device,
      detail: `Disabled after ${proof.method} verification`,
    });
    notifySecurityChange({ email: me.email, ip, device, change: 'disabled' });

    res.json({ message: 'Two-factor authentication disabled.' });
  } catch (err) {
    console.error('[2fa] disable failed:', err.message);
    res.status(500).json({ error: 'Unable to disable two-factor authentication.' });
  }
});

// ── POST /recovery-codes/regenerate ───────────────────────────────────────
// Replaces the whole set, which is what invalidates every previous code. The
// new codes are returned once and never retrievable again.
router.post('/recovery-codes/regenerate', authenticateToken, accountVerifyLimiter, async (req, res) => {
  try {
    const me = actor(req);
    const { ip, device } = requestContext(req);
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    const stepUp = twoFactor.verifyStepUpToken(body.stepUpToken || '', me, req);
    if (!stepUp.ok) return res.status(401).json({ error: stepUp.error });

    const record = await twoFactor.findRecord({ userId: me.id, email: me.email });
    if (!record || !twoFactor.truthy(record.enabled)) {
      return res.status(409).json({ error: 'Two-factor authentication is not enabled on this account.' });
    }

    // Deliberately authenticator-only: letting a recovery code mint a fresh set
    // would make a single leaked code self-renewing.
    const proof = await consumeSecondFactor({ record, body, me, ip, device, allowRecovery: false });
    if (!proof.ok) return res.status(proof.status).json({ error: proof.error });

    const codes = await twoFactor.generateRecoveryCodes();
    await twoFactor.saveRecord({ userId: me.id, email: me.email }, {
      recoveryCodes: JSON.stringify(codes.stored),
      lastCounter: String(proof.counter || record.lastCounter || ''),
    });

    await twoFactor.logSecurityEvent({
      userId: me.id, email: me.email, event: twoFactor.EVENTS.RECOVERY_REGENERATED, ip, device,
      detail: `${codes.plain.length} new recovery codes issued; all previous codes invalidated`,
    });
    notifySecurityChange({ email: me.email, ip, device, change: 'recovery_regenerated' });

    res.json({ message: 'New recovery codes generated.', recoveryCodes: codes.plain });
  } catch (err) {
    console.error('[2fa] regenerate failed:', err.message);
    res.status(500).json({ error: 'Unable to generate new recovery codes.' });
  }
});

// ── POST /login ───────────────────────────────────────────────────────────
// The second half of a 2FA login. The first half (email OTP or Google) already
// proved the account, and handed back a challenge token instead of a session.
// This exchanges that challenge plus a live authenticator code — or one unused
// recovery code — for the real session.
//
// Session fixation is prevented structurally: the challenge token is not a
// session, carries no `sid`, is signed with a different key than session JWTs,
// and the session is created fresh here only after the code verifies.
router.post('/login', loginVerifyLimiter, async (req, res) => {
  try {
    const { ip, device } = requestContext(req);
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const challengeToken = String(body.challengeToken || '');

    const challenge = twoFactor.verifyLoginChallengeToken(challengeToken, req);
    if (!challenge.ok) return res.status(401).json({ error: challenge.error });

    if (challengeAttemptsExhausted(challengeToken)) {
      return res.status(429).json({
        error: 'Too many incorrect codes. Please sign in again to get a new verification prompt.',
      });
    }

    const me = {
      id: challenge.claims.uid || '',
      email: twoFactor.normEmail(challenge.claims.email),
    };

    const record = await twoFactor.findRecord({ userId: me.id, email: me.email });
    if (!record || !twoFactor.truthy(record.enabled)) {
      // The challenge was minted because 2FA was on; if it is off now the user
      // should simply sign in again and be let straight through.
      return res.status(409).json({ error: 'Please sign in again.' });
    }

    const proof = await consumeSecondFactor({ record, body, me, ip, device });
    if (!proof.ok) {
      const used = bumpChallengeAttempts(challengeToken);
      await twoFactor.logSecurityEvent({
        userId: me.id, email: me.email, event: twoFactor.EVENTS.LOGIN_FAILED,
        outcome: 'failure', ip, device,
        detail: `Second factor rejected at sign-in (attempt ${used} of ${MAX_CHALLENGE_ATTEMPTS})`,
      });
      return res.status(proof.status).json({
        error: proof.error,
        attemptsRemaining: Math.max(0, MAX_CHALLENGE_ATTEMPTS - used),
      });
    }

    clearChallengeAttempts(challengeToken);

    // Only now does a session exist.
    const name = challenge.claims.name || me.email.split('@')[0];
    const session = await authRoutes.createLoginSession(
      req, me.id, challenge.claims.method || 'Email OTP + 2FA', me.email, name,
    ).catch(() => null);

    const token = authRoutes.issueLoginToken({
      id: me.id, email: me.email, name, role: challenge.claims.role || 'user',
    }, session);
    if (session) authRoutes.setSessionCookie(res, session.token, session.ttlMs);

    await twoFactor.logSecurityEvent({
      userId: me.id, email: me.email, event: twoFactor.EVENTS.LOGIN_SUCCESS, ip, device,
      detail: `Signed in with ${proof.method}`,
    });

    res.json({
      message: 'Two-factor verification successful.',
      token,
      session_id: session ? session.sessionId : undefined,
      session_expires_at: session ? session.expiresAt : undefined,
      usedRecoveryCode: proof.method === 'recovery code',
      recoveryCodesRemaining: proof.remaining,
      user: {
        id: me.id,
        user_id: me.id,
        email: me.email,
        name,
        username: challenge.claims.username || me.email.split('@')[0],
        status: challenge.claims.status || 'active',
        role: challenge.claims.role || 'user',
      },
    });
  } catch (err) {
    console.error('[2fa] login exchange failed:', err.message);
    res.status(500).json({ error: 'Unable to complete two-factor verification.' });
  }
});

module.exports = router;
