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

const router = express.Router();

// ── Rate limits ────────────────────────────────────────────────────────────
// Anything that checks a secret gets its own tight per-IP budget, well below
// the generic /api/auth limit.

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please try again in a few minutes.' },
});

const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
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
router.post('/setup/verify-email', authenticateToken, verifyLimiter, async (req, res) => {
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
router.post('/setup/enable', authenticateToken, verifyLimiter, async (req, res) => {
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

module.exports = router;
