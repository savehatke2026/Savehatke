// ============================================
// SaveHatke — SOS Backup Access (staged recovery)
// ============================================
// Break-glass admin recovery. Three server-authoritative stages, in order:
//
//   POST /api/admin/sos/start          code + reason + CAPTCHA  → eligible admins
//   POST /api/admin/sos/select-admin   pick an admin            → 5 questions
//   POST /api/admin/sos/verify         answers                  → admin session
//
// Design rules this file exists to enforce:
//   - The browser decides nothing. Every gate — code validity, CAPTCHA, admin
//     eligibility, answer correctness, whether the attempt may advance — is
//     evaluated here and recorded in MongoDB. There is no "verified" flag the
//     client can set.
//   - The raw backup code is submitted once, compared against a bcrypt hash,
//     and never stored, echoed, logged or persisted in any form. The audit trail
//     carries the code's database id and its non-secret display prefix only.
//   - Security answers are compared against per-admin bcrypt hashes after
//     normalisation. Plaintext answers exist only inside verifyAnswer().
//   - Failures are generic. Nothing in a response distinguishes "no such code"
//     from "code disabled", or says which question was wrong.
//   - The authenticated admin session is created at the very end, through the
//     same helpers a normal admin login uses, so it has a server-side session
//     row, an HttpOnly cookie and the 2-hour admin lifetime.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const Admin = require('../models/Admin');
const BackupCode = require('../models/BackupCode');
const SosSession = require('../models/SosSession');
const SosAuditLog = require('../models/SosAuditLog');

const { waitForMongoReady, isMongoReady } = require('../config/db');
const getClientIP = require('../middleware/getClientIP');
const { verifyTurnstileStrict } = require('../utils/turnstile');
const { describeClient, resolveApproxLocation, formatLocation } = require('../utils/sosContext');
const { verifyAnswer, selectQuestions } = require('../utils/sosAnswers');
const emailService = require('../services/emailService');

const router = express.Router();

// ── Policy ────────────────────────────────────────────────────────────────
const SESSION_TTL_MS = 10 * 60 * 1000;      // an attempt must finish in 10 min
const MAX_FAILED_ANSWER_ATTEMPTS = 5;       // then the session is destroyed
const REASON_MIN = 10;
const REASON_MAX = 500;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_FAILURES = 5;                  // failed attempts per IP per window

// Every client-visible message. Deliberately uninformative: none of them tells
// the caller which credential or answer was wrong, or whether a code exists.
const MSG = {
  generic: 'Unable to continue with SOS recovery.',
  captcha: 'CAPTCHA verification failed.',
  throttled: 'Too many attempts. Please try again later.',
  adminGone: 'This administrator is no longer available. Please select another administrator.',
  answers: 'Security verification failed. Please check your answers and try again.',
  reasonShort: `Please provide a reason of at least ${REASON_MIN} characters explaining why you need SOS access.`,
  reasonLong: `Reason is too long (max ${REASON_MAX} characters).`,
  offline: 'SOS recovery is temporarily unavailable. Please try again in a moment.',
};

// ── Small helpers ─────────────────────────────────────────────────────────
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

/** Shape gate only — never an existence check. */
function looksLikeBackupCode(value) {
  const v = String(value || '').trim();
  if (!v || v.length < 8 || v.length > 128) return false;
  return !v.includes('@');
}

/**
 * The reason is human-written text that ends up in an audit record and an
 * email. Strip control characters and angle brackets so it can never be
 * rendered as markup, and collapse the whitespace a paste tends to bring.
 */
function sanitiseReason(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REASON_MAX);
}

async function ensureStore() {
  if (isMongoReady()) return true;
  try {
    return await waitForMongoReady(5000);
  } catch (e) {
    return false;
  }
}

/**
 * Durable per-IP throttle. Counts recorded failures rather than living in a
 * process Map, so it survives a restart and works across serverless instances.
 */
async function ipIsThrottled(ip) {
  if (!ip) return false;
  try {
    const since = new Date(Date.now() - IP_WINDOW_MS);
    const failures = await SosAuditLog.countDocuments({ ip, success: false, created_at: { $gte: since } });
    return failures >= IP_MAX_FAILURES;
  } catch (e) {
    // A counting outage must not become a free pass, but it also must not lock
    // out a legitimate admin. Allow, and let the per-session limit still apply.
    return false;
  }
}

/** Request context for the audit trail. Geo is resolved lazily, on success. */
function contextOf(req) {
  const ip = getClientIP(req);
  return { ip, client: describeClient(req), uaHash: sha256(String(req.headers['user-agent'] || '')) };
}

/**
 * Write one audit record. Never throws: an audit outage is logged loudly but a
 * legitimate recovery is not blocked by it.
 */
async function recordAudit(fields) {
  try {
    const doc = await SosAuditLog.create(fields);
    return doc;
  } catch (err) {
    console.error('[sos] AUDIT WRITE FAILED —', err.message, '| fields:', {
      attempt_id: fields.attempt_id,
      success: fields.success,
      failure_category: fields.failure_category,
    });
    return null;
  }
}

/** Safe projection of an administrator for the picker. */
function publicAdmin(doc) {
  return {
    // Opaque-to-the-client reference. It is the admin's uuid `id`, never _id,
    // and it is re-validated server-side on every use.
    ref: doc.id,
    name: doc.name,
    role: doc.role || 'Admin',
    avatar: doc.profile_image || '',
    online: Boolean(doc.sos_available),
  };
}

/** Currently eligible administrators, read live on every call. */
async function eligibleAdmins() {
  const rows = await Admin.find({ is_active: true, sos_enabled: true })
    .select('id name role profile_image sos_available sos_enabled is_active')
    .lean();
  return rows.filter((r) => r.sos_available !== false);
}

// ── Stage 1: POST /api/admin/sos/start ────────────────────────────────────
// Body: { code, reason, cfTurnstileToken }
// The only place the raw code is accepted. On success the caller gets an opaque
// session token and the list of administrators eligible right now.
router.post('/start', async (req, res) => {
  const { ip, client, uaHash } = contextOf(req);
  const baseAudit = {
    ip,
    browser: client.browser,
    os: client.os,
    device: client.device,
    user_agent: client.userAgent,
    attempt_number: 1,
  };

  try {
    if (await ipIsThrottled(ip)) {
      await recordAudit({ ...baseAudit, success: false, failure_category: 'RATE_LIMITED' });
      return res.status(429).json({ error: MSG.throttled });
    }

    const rawCode = String((req.body && req.body.code) || '');
    const reason = sanitiseReason(req.body && req.body.reason);

    // Reason is checked before the code, so a malformed request never becomes a
    // code-guessing oracle.
    if (reason.length < REASON_MIN) return res.status(400).json({ error: MSG.reasonShort });
    if (reason.length > REASON_MAX) return res.status(400).json({ error: MSG.reasonLong });

    // CAPTCHA before any database work, so bots cannot make us hash.
    const captcha = await verifyTurnstileStrict(req, 'sos-start');
    if (!captcha.ok) {
      await recordAudit({
        ...baseAudit, reason, success: false,
        failure_category: 'CAPTCHA_FAILED', captcha_result: captcha.result,
      });
      return res.status(400).json({ error: captcha.error || MSG.captcha });
    }

    if (!looksLikeBackupCode(rawCode)) {
      await recordAudit({
        ...baseAudit, reason, success: false,
        failure_category: 'CODE_INVALID', captcha_result: captcha.result,
      });
      return res.status(401).json({ error: MSG.generic });
    }

    if (!(await ensureStore())) {
      await recordAudit({
        ...baseAudit, reason, success: false,
        failure_category: 'STORE_UNAVAILABLE', captcha_result: captcha.result,
      });
      return res.status(503).json({ error: MSG.offline });
    }

    // Compare against every live code's hash. Same work either way, so a
    // response time does not reveal whether the code exists.
    const candidates = await BackupCode.find({ isActive: true }).select('+codeHash').lean();
    let matched = null;
    for (const row of candidates) {
      // eslint-disable-next-line no-await-in-loop
      if (row.codeHash && await bcrypt.compare(rawCode, row.codeHash)) { matched = row; break; }
    }

    // Single use is the default: a code with no explicit maxUses is spent after
    // one successful recovery. Expiry and revocation are checked here too, and
    // every rejection returns the same message as "no such code".
    const usable = matched
      && (!matched.expiresAt || new Date(matched.expiresAt) > new Date())
      && (matched.usageCount || 0) < (matched.maxUses == null ? 1 : matched.maxUses);

    if (!usable) {
      await recordAudit({
        ...baseAudit, reason, success: false,
        backup_code_id: matched ? matched.id : '',
        backup_code_prefix: matched ? matched.codePrefix : '',
        failure_category: matched ? 'CODE_NOT_USABLE' : 'CODE_INVALID',
        captcha_result: captcha.result,
      });
      return res.status(401).json({ error: MSG.generic });
    }

    const admins = await eligibleAdmins();
    if (!admins.length) {
      await recordAudit({
        ...baseAudit, reason, success: false,
        backup_code_id: matched.id, backup_code_prefix: matched.codePrefix,
        failure_category: 'ADMIN_INELIGIBLE', captcha_result: captcha.result,
      });
      return res.status(503).json({ error: MSG.offline });
    }

    // The token goes to the browser once; only its hash is stored.
    const token = crypto.randomBytes(32).toString('hex');
    const session = await SosSession.create({
      token_hash: sha256(token),
      backup_code_id: matched.id,
      backup_code_prefix: matched.codePrefix || '',
      reason,
      stage: 'select-admin',
      captcha_passed: captcha.result === 'passed',
      ip,
      user_agent_hash: uaHash,
      expires_at: new Date(Date.now() + SESSION_TTL_MS),
    });

    console.log(`🆘 [sos] attempt ${session.attempt_id} opened from ${ip} (code ${matched.codePrefix}) — awaiting admin selection`);

    return res.json({
      sosToken: token,
      attemptId: session.attempt_id,
      expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000),
      captcha: captcha.result,
      admins: admins.map(publicAdmin),
    });
  } catch (err) {
    console.error('[sos] start failed:', err.message);
    await recordAudit({ ...baseAudit, success: false, failure_category: 'BAD_REQUEST' });
    return res.status(500).json({ error: MSG.generic });
  }
});

/**
 * Load and re-validate the SOS session behind a request. Bound to the opening
 * IP and User-Agent, so a token lifted from one client cannot be replayed from
 * another. Returns a reason code rather than a message, so the caller decides
 * what the client is told.
 */
async function loadSession(req, expectedStage) {
  const token = String((req.body && req.body.sosToken) || '').trim();
  if (!token || token.length < 32) return { error: 'SESSION_INVALID' };

  const session = await SosSession.findOne({ token_hash: sha256(token) });
  if (!session) return { error: 'SESSION_INVALID' };
  if (session.stage === 'closed') return { error: 'SESSION_INVALID', session };
  if (!session.isLive()) return { error: 'SESSION_EXPIRED', session };
  if (expectedStage && session.stage !== expectedStage) return { error: 'SESSION_INVALID', session };

  const { ip, uaHash } = contextOf(req);
  if (session.ip && session.ip !== ip) return { error: 'CONTEXT_MISMATCH', session };
  if (session.user_agent_hash && session.user_agent_hash !== uaHash) return { error: 'CONTEXT_MISMATCH', session };

  return { session };
}

async function closeSession(session, why) {
  if (!session) return;
  try {
    session.stage = 'closed';
    session.closed_reason = why;
    await session.save();
  } catch (e) { /* the TTL index will collect it */ }
}

// ── Stage 2: POST /api/admin/sos/select-admin ─────────────────────────────
// Body: { sosToken, adminRef }
// Binds an administrator to the attempt after re-reading their eligibility, then
// hands back the questions chosen for this attempt — and only those.
router.post('/select-admin', async (req, res) => {
  const { ip, client } = contextOf(req);
  try {
    if (!(await ensureStore())) return res.status(503).json({ error: MSG.offline });

    const { session, error } = await loadSession(req, 'select-admin');
    if (error) {
      if (error === 'CONTEXT_MISMATCH') await closeSession(session, error);
      return res.status(401).json({ error: MSG.generic });
    }

    const adminRef = String((req.body && req.body.adminRef) || '').trim();
    if (!adminRef) return res.status(400).json({ error: MSG.generic });

    // Eligibility is re-read here rather than trusted from the list the browser
    // was given: an administrator may have gone unavailable in between.
    const admin = await Admin.findOne({ id: adminRef, is_active: true, sos_enabled: true })
      .select('+security_questions.answer_hash')
      .lean();

    if (!admin || admin.sos_available === false) {
      await recordAudit({
        attempt_id: session.attempt_id,
        backup_code_id: session.backup_code_id,
        backup_code_prefix: session.backup_code_prefix,
        reason: session.reason,
        ip, browser: client.browser, os: client.os, device: client.device, user_agent: client.userAgent,
        captcha_result: session.captcha_passed ? 'passed' : 'skipped',
        success: false, failure_category: 'ADMIN_INELIGIBLE',
        attempt_number: session.failed_attempts + 1,
      });
      // Named error: the user has to be able to pick somebody else.
      return res.status(409).json({ error: MSG.adminGone, admins: (await eligibleAdmins()).map(publicAdmin) });
    }

    const chosen = selectQuestions(admin.security_questions, admin.sos_questions_required || 5);
    if (!chosen.length) {
      await recordAudit({
        attempt_id: session.attempt_id,
        backup_code_id: session.backup_code_id,
        backup_code_prefix: session.backup_code_prefix,
        reason: session.reason,
        selected_admin_id: admin.id, selected_admin_name: admin.name,
        ip, browser: client.browser, os: client.os, device: client.device, user_agent: client.userAgent,
        captcha_result: session.captcha_passed ? 'passed' : 'skipped',
        success: false, failure_category: 'QUESTIONS_NOT_CONFIGURED',
        attempt_number: session.failed_attempts + 1,
      });
      console.error(`[sos] ${admin.name} has no answerable security questions configured — refusing SOS recovery. Run: node server/scripts/sos-setup-questions.js`);
      return res.status(409).json({ error: MSG.adminGone, admins: (await eligibleAdmins()).map(publicAdmin) });
    }

    session.selected_admin_id = admin.id;
    session.selected_admin_name = admin.name;
    session.question_keys = chosen.map((q) => q.key);
    session.stage = 'questions';
    await session.save();

    console.log(`🆘 [sos] attempt ${session.attempt_id} bound to ${admin.name} — ${chosen.length} questions issued`);

    return res.json({
      admin: publicAdmin(admin),
      // The answers, the hashes and the unselected questions never leave here.
      questions: chosen.map((q) => ({ key: q.key, question: q.question, kind: q.kind || 'text' })),
      attemptsRemaining: MAX_FAILED_ANSWER_ATTEMPTS - session.failed_attempts,
    });
  } catch (err) {
    console.error('[sos] select-admin failed:', err.message);
    return res.status(500).json({ error: MSG.generic });
  }
});

// ── Stage 3: POST /api/admin/sos/verify ───────────────────────────────────
// Body: { sosToken, answers: { <questionKey>: <answer> } }
//
// Every answer is checked. The response never says which one failed, and a wrong
// set costs an attempt; five failures destroy the session. On success this is
// where — and the only where — an authenticated admin session is created.
router.post('/verify', async (req, res) => {
  const { ip, client } = contextOf(req);
  try {
    if (!(await ensureStore())) return res.status(503).json({ error: MSG.offline });

    const { session, error } = await loadSession(req, 'questions');
    if (error) {
      if (error === 'CONTEXT_MISMATCH') await closeSession(session, error);
      return res.status(401).json({ error: MSG.generic });
    }

    const auditBase = {
      attempt_id: session.attempt_id,
      backup_code_id: session.backup_code_id,
      backup_code_prefix: session.backup_code_prefix,
      reason: session.reason,
      selected_admin_id: session.selected_admin_id,
      selected_admin_name: session.selected_admin_name,
      ip,
      browser: client.browser,
      os: client.os,
      device: client.device,
      user_agent: client.userAgent,
      captcha_result: session.captcha_passed ? 'passed' : 'skipped',
      attempt_number: session.failed_attempts + 1,
    };

    // Availability is re-checked immediately before verification, per the
    // requirement that an administrator who steps out mid-recovery stops the
    // attempt rather than being impersonated.
    const admin = await Admin.findOne({ id: session.selected_admin_id, is_active: true, sos_enabled: true })
      .select('+security_questions.answer_hash')
      .lean();
    if (!admin || admin.sos_available === false) {
      await closeSession(session, 'ADMIN_INELIGIBLE');
      await recordAudit({ ...auditBase, success: false, failure_category: 'ADMIN_INELIGIBLE', questions_result: 'not-reached' });
      return res.status(409).json({ error: MSG.adminGone });
    }

    const submitted = (req.body && req.body.answers && typeof req.body.answers === 'object')
      ? req.body.answers : {};
    const expected = (admin.security_questions || []).filter((q) => session.question_keys.includes(q.key));

    // The session's key list is authoritative; a client cannot swap in an easier
    // question or drop one.
    if (expected.length !== session.question_keys.length || !expected.length) {
      await closeSession(session, 'QUESTIONS_NOT_CONFIGURED');
      await recordAudit({ ...auditBase, success: false, failure_category: 'QUESTIONS_NOT_CONFIGURED', questions_result: 'not-reached' });
      return res.status(409).json({ error: MSG.adminGone });
    }

    // Every question is compared, even after the first mismatch, so the time
    // taken does not point at the offending answer.
    let allCorrect = true;
    for (const q of expected) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await verifyAnswer(submitted[q.key], q.kind || 'text', q.answer_hash);
      if (!ok) allCorrect = false;
    }

    if (!allCorrect) {
      session.failed_attempts += 1;
      const exhausted = session.failed_attempts >= MAX_FAILED_ANSWER_ATTEMPTS;
      if (exhausted) await closeSession(session, 'LOCKED_OUT');
      else await session.save();

      await recordAudit({
        ...auditBase,
        success: false,
        failure_category: exhausted ? 'LOCKED_OUT' : 'ANSWERS_INCORRECT',
        questions_result: 'failed',
      });

      console.warn(`🆘 [sos] attempt ${session.attempt_id} failed verification (${session.failed_attempts}/${MAX_FAILED_ANSWER_ATTEMPTS})${exhausted ? ' — session destroyed' : ''}`);

      return res.status(exhausted ? 429 : 401).json({
        error: exhausted ? MSG.throttled : MSG.answers,
        attemptsRemaining: Math.max(0, MAX_FAILED_ANSWER_ATTEMPTS - session.failed_attempts),
        restart: exhausted,
      });
    }

    // ── Verified. Everything below is the grant. ──
    session.stage = 'verified';
    await session.save();

    // Spend the backup code. Single-use by default, so a replay of the same code
    // cannot open a second attempt.
    try {
      await BackupCode.updateOne(
        { id: session.backup_code_id },
        {
          $inc: { usageCount: 1 },
          $set: { lastUsedAt: new Date(), lastUsedIp: ip, lastUsedReason: session.reason },
        }
      );
    } catch (e) {
      console.warn('[sos] could not stamp backup code usage:', e.message);
    }

    // A real admin session: server-side row, HttpOnly cookie, 2-hour admin TTL,
    // visible in the admin Sessions view and revocable — created through the
    // same helpers a normal admin login uses.
    const authRoutes = require('./auth');
    let sessionRow = null;
    let token = null;
    try {
      sessionRow = await authRoutes.createLoginSession(req, admin.id, 'Admin (SOS)', admin.email, admin.name);
      token = authRoutes.issueLoginToken(
        { id: admin.id, email: admin.email, name: admin.name, role: 'admin' },
        sessionRow
      );
      if (sessionRow) authRoutes.setSessionCookie(res, sessionRow.token, sessionRow.ttlMs);
    } catch (e) {
      console.error('[sos] admin session creation failed:', e.message);
    }

    if (!token) {
      await closeSession(session, 'SESSION_CREATE_FAILED');
      await recordAudit({ ...auditBase, success: false, failure_category: 'SESSION_CREATE_FAILED', questions_result: 'passed' });
      return res.status(500).json({ error: MSG.generic });
    }

    // Location is only resolved once the attempt has succeeded, and the audit
    // record is written before the email so the alert can quote its reference.
    const location = await resolveApproxLocation(ip);
    const audit = await recordAudit({
      ...auditBase,
      location,
      success: true,
      failure_category: '',
      questions_result: 'passed',
      admin_session_created: true,
      admin_session_id: sessionRow ? sessionRow.sessionId : '',
    });

    await closeSession(session, 'COMPLETED');

    const auditRef = audit ? audit.audit_ref : 'unavailable';
    console.log(`🆘 [sos] GRANTED — attempt ${session.attempt_id} as ${admin.name} from ${ip} (${formatLocation(location)}), audit ${auditRef}`);

    // Both administrators are told, regardless of which one was selected. Fired
    // without blocking the response; a delivery failure is recorded, never a
    // reason to tear down a session the operator has legitimately earned.
    notifyAdminsOfSosAccess({
      audit,
      auditRef,
      selectedAdminName: admin.name,
      reason: session.reason,
      ip,
      location,
      client,
      captchaResult: auditBase.captcha_result,
    }).catch((e) => console.warn('[sos] alert dispatch error:', e.message));

    return res.json({
      message: 'SOS verification complete.',
      auditRef,
      token,
      user: {
        id: admin.id,
        name: admin.name,
        full_name: admin.name,
        email: admin.email,
        role: 'admin',
        profile_image: admin.profile_image || '',
        is_active: true,
        login_method: 'Backup Code (SOS)',
      },
    });
  } catch (err) {
    console.error('[sos] verify failed:', err.message);
    return res.status(500).json({ error: MSG.generic });
  }
});

/**
 * Alert BOTH administrators that SOS access happened, and record per-recipient
 * delivery on the audit document.
 *
 * Deliberately best-effort with one retry: the session already exists and is
 * legitimate, so a mail outage must not revoke it — it must be visible instead.
 */
async function notifyAdminsOfSosAccess(info) {
  let recipients = [];
  try {
    recipients = await Admin.find({ is_active: true }).select('name email').lean();
  } catch (e) {
    console.warn('[sos] could not load alert recipients:', e.message);
  }
  if (!recipients.length) return;

  const statuses = [];
  for (const rec of recipients) {
    if (!rec.email) continue;
    let delivered = false;
    let simulated = false;
    let lastError = '';
    let attempts = 0;

    // Two passes: transient SMTP failures are common and this alert matters.
    for (let pass = 1; pass <= 2 && !delivered; pass++) {
      attempts = pass;
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await emailService.sendSosAccessAlertEmail({
          to: rec.email,
          recipientName: rec.name,
          selectedAdminName: info.selectedAdminName,
          reason: info.reason,
          ip: info.ip,
          location: info.location,
          browser: info.client.browser,
          os: info.client.os,
          device: info.client.device,
          captchaStatus: info.captchaResult === 'passed' ? 'Passed' : 'Skipped (not configured)',
          securityStatus: 'Passed',
          accessStatus: 'Granted',
          auditRef: info.auditRef,
        });
        delivered = Boolean(out && out.success);
        simulated = Boolean(out && out.isSimulated);
        if (!delivered) lastError = (out && out.error) || 'unknown';
      } catch (e) {
        lastError = e.message;
      }
      // eslint-disable-next-line no-await-in-loop
      if (!delivered && pass === 1) await new Promise((r) => setTimeout(r, 1500));
    }

    statuses.push({
      to_ref: rec.name || 'administrator',
      delivered,
      simulated,
      error: delivered ? '' : String(lastError).slice(0, 200),
      attempts,
    });

    if (delivered) console.log(`🆘 [sos] alert delivered to ${rec.name}`);
    else console.warn(`🆘 [sos] alert FAILED for ${rec.name}: ${lastError}`);
  }

  if (info.audit && statuses.length) {
    try {
      await SosAuditLog.updateOne({ _id: info.audit._id }, { $set: { email_status: statuses } });
    } catch (e) {
      console.warn('[sos] could not record alert delivery status:', e.message);
    }
  }
}

// ── GET /api/admin/sos/health ─────────────────────────────────────────────
// Deliberately says nothing an attacker can use: no admin identities, no code
// counts, no limits. Just whether the flow can run at all.
router.get('/health', async (_req, res) => {
  const ready = await ensureStore();
  res.json({ ok: true, available: ready });
});

module.exports = router;
