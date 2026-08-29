// ============================================
// SaveHatke — Two-Factor Authentication (TOTP) Service
// ============================================
// Authenticator-app 2FA (RFC 6238) for the passwordless account system.
// The TOTP maths comes from `otpauth`; nothing cryptographic is hand-rolled
// here beyond AES-GCM envelope handling and hashing.
//
// What is persisted, per user, in the UserTwoFactor sheet:
//   secretEncrypted         AES-256-GCM blob of the base32 TOTP secret
//   pendingSecretEncrypted  same, for an enrolment not yet confirmed
//   recoveryCodes           JSON array of { hash, usedAt, usedIp } — bcrypt only
//   lastCounter             highest TOTP time-step already accepted (replay guard)
//
// What is never persisted anywhere: the plaintext secret, any 6-digit code, and
// any plaintext recovery code.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { TOTP, Secret } = require('otpauth');
const QRCode = require('qrcode');
const db = require('./googleSheets');

// ── Tunables ───────────────────────────────────────────────────────────────
const ISSUER = 'SaveHatke';
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TOTP_ALGORITHM = 'SHA1';        // what every mainstream authenticator app assumes
const TOTP_WINDOW = 1;                // accept the neighbouring step for clock drift
const SECRET_BYTES = 20;              // 160-bit secret, the RFC 4226 recommendation

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_GROUP_LEN = 4;         // rendered as XXXX-XXXX
// No I, L, O, 0 or 1 — those are the characters people mistype off a printout.
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RECOVERY_BCRYPT_ROUNDS = 10;

// An enrolment that is started and abandoned must not stay usable forever.
const PENDING_SETUP_TTL_MS = 15 * 60 * 1000;

// Purpose-scoped token lifetimes.
const STEP_UP_TTL_SECONDS = 10 * 60;  // "recent verification" for sensitive changes
const CHALLENGE_TTL_SECONDS = 5 * 60; // login half-completed, awaiting the TOTP code

// ── Encryption ─────────────────────────────────────────────────────────────
// The TOTP secret has to be recoverable to verify codes, so it is encrypted
// rather than hashed. Missing key = fail closed: enrolment is refused rather
// than silently storing a secret in the clear.

function getEncryptionKey() {
  const raw = process.env.TWOFA_ENCRYPTION_KEY || '';
  if (!raw) return null;
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function isConfigured() {
  return Boolean(getEncryptionKey());
}

function encryptSecret(plaintext) {
  const key = getEncryptionKey();
  if (!key) throw new Error('TWOFA_ENCRYPTION_KEY is not configured.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function decryptSecret(payload) {
  try {
    const key = getEncryptionKey();
    if (!key || typeof payload !== 'string') return null;
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

// ── Purpose-scoped tokens ──────────────────────────────────────────────────
// Deliberately signed with a key derived from JWT_SECRET rather than
// JWT_SECRET itself. authenticateToken() accepts any JWT_SECRET-signed token
// that carries no `sid`, so a login challenge signed with the session secret
// would be a complete 2FA bypass when replayed as a Bearer token. These tokens
// fail that verification by construction.

function purposeSecret() {
  const base = process.env.JWT_SECRET || 'savehatke_dev_secret_key';
  return crypto.createHmac('sha256', String(base)).update('savehatke-2fa-v1').digest('hex');
}

// Binding the token to the caller's IP and User-Agent means a leaked token is
// not portable to another machine.
function bindingHash(req) {
  const ip = String((req && req.clientIpForTwoFactor) || (req && req.ip) || '');
  const ua = String((req && req.headers && req.headers['user-agent']) || '');
  return crypto.createHash('sha256').update(ip + '|' + ua).digest('hex').slice(0, 32);
}

function signPurposeToken(purpose, claims, ttlSeconds, req) {
  return jwt.sign(
    {
      ...claims,
      purpose,
      bind: bindingHash(req),
      // A random id per token. Without it, two tokens minted in the same second
      // with the same claims are byte-identical, which would silently merge
      // their per-challenge attempt counters.
      jti: crypto.randomBytes(9).toString('base64url'),
    },
    purposeSecret(),
    { expiresIn: ttlSeconds },
  );
}

/**
 * @returns {{ok:true, claims:object}|{ok:false, error:string}}
 */
function verifyPurposeToken(token, expectedPurpose, req) {
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'Verification expired. Please start again.' };
  }
  let claims;
  try {
    claims = jwt.verify(token, purposeSecret());
  } catch (e) {
    return { ok: false, error: 'Verification expired. Please start again.' };
  }
  if (claims.purpose !== expectedPurpose) {
    return { ok: false, error: 'Verification expired. Please start again.' };
  }
  if (claims.bind !== bindingHash(req)) {
    return { ok: false, error: 'Verification is no longer valid on this device. Please start again.' };
  }
  return { ok: true, claims };
}

function issueStepUpToken(user, req) {
  return signPurposeToken('2fa-step-up', {
    uid: user.id || '',
    email: normEmail(user.email),
  }, STEP_UP_TTL_SECONDS, req);
}

function verifyStepUpToken(token, user, req) {
  const res = verifyPurposeToken(token, '2fa-step-up', req);
  if (!res.ok) return res;
  if (normEmail(res.claims.email) !== normEmail(user.email)) {
    return { ok: false, error: 'Verification expired. Please start again.' };
  }
  return res;
}

function issueLoginChallengeToken(payload, req) {
  return signPurposeToken('2fa-login', payload, CHALLENGE_TTL_SECONDS, req);
}

function verifyLoginChallengeToken(token, req) {
  return verifyPurposeToken(token, '2fa-login', req);
}

// ── Row access ─────────────────────────────────────────────────────────────

function normEmail(v) {
  return String(v || '').toLowerCase().trim();
}

function nowIso() {
  return new Date().toISOString();
}

function truthy(v) {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  return s === 'true' || s === 'yes' || s === '1';
}

/** Look up a user's 2FA row by user id, falling back to email for older rows. */
async function findRecord({ userId, email }) {
  const cleanEmail = normEmail(email);
  if (userId) {
    const byId = await db.findRow(db.SHEETS.USER_TWO_FACTOR, 'userId', userId).catch(() => null);
    if (byId) return byId;
  }
  if (cleanEmail) {
    return db.findRow(db.SHEETS.USER_TWO_FACTOR, 'email', cleanEmail).catch(() => null);
  }
  return null;
}

/**
 * Write a user's 2FA fields, creating the row on first use. Returns nothing
 * useful — callers re-read when they need the merged state.
 */
async function saveRecord({ userId, email }, updates) {
  const cleanEmail = normEmail(email);
  const existing = await findRecord({ userId, email: cleanEmail });
  const payload = { ...updates, updatedAt: nowIso() };

  if (!existing) {
    await db.appendRow(db.SHEETS.USER_TWO_FACTOR, {
      userId: userId || '',
      email: cleanEmail,
      enabled: 'false',
      secretEncrypted: '',
      pendingSecretEncrypted: '',
      pendingCreatedAt: '',
      recoveryCodes: '[]',
      lastCounter: '',
      enabledAt: '',
      disabledAt: '',
      lastUsedAt: '',
      ...payload,
    });
    return;
  }

  // Update by whichever key actually identifies the stored row.
  if (existing.userId) {
    await db.updateRow(db.SHEETS.USER_TWO_FACTOR, 'userId', existing.userId, payload);
  } else {
    await db.updateRow(db.SHEETS.USER_TWO_FACTOR, 'email', normEmail(existing.email), payload);
  }
}

/**
 * Public-safe view of a user's 2FA state. Never includes a secret or a hash.
 */
function describeRecord(record) {
  if (!record || !truthy(record.enabled)) {
    return { enabled: false, enabledAt: '', lastUsedAt: '', recoveryCodesRemaining: 0, recoveryCodesTotal: 0 };
  }
  const codes = parseRecoveryCodes(record.recoveryCodes);
  return {
    enabled: true,
    enabledAt: record.enabledAt || '',
    lastUsedAt: record.lastUsedAt || '',
    recoveryCodesRemaining: codes.filter((c) => !c.usedAt).length,
    recoveryCodesTotal: codes.length,
  };
}

// ── Recovery codes ─────────────────────────────────────────────────────────

function randomRecoveryCode() {
  const pick = () => {
    let out = '';
    for (let i = 0; i < RECOVERY_GROUP_LEN; i++) {
      out += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    }
    return out;
  };
  return `${pick()}-${pick()}`;
}

function normalizeRecoveryInput(v) {
  // Accept "abcd efgh", "ABCD-EFGH" and "abcdefgh" as the same code.
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function parseRecoveryCodes(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('[2fa] unreadable recovery code column — treating as empty');
    return [];
  }
}

/**
 * Mint a fresh set of recovery codes. Returns the plaintext codes for a
 * one-time display plus the hashed records to store. Any previous set is
 * replaced by the caller, which is what invalidates the old codes.
 */
async function generateRecoveryCodes() {
  const plain = [];
  const seen = new Set();
  while (plain.length < RECOVERY_CODE_COUNT) {
    const code = randomRecoveryCode();
    if (seen.has(code)) continue;
    seen.add(code);
    plain.push(code);
  }
  const stored = await Promise.all(plain.map(async (code) => ({
    hash: await bcrypt.hash(normalizeRecoveryInput(code), RECOVERY_BCRYPT_ROUNDS),
    usedAt: '',
    usedIp: '',
  })));
  return { plain, stored };
}

/**
 * Check a recovery code against the unused hashes.
 *
 * Every unused hash is compared rather than looking one up by prefix: storing a
 * lookup prefix would halve the entropy of a code sitting in the database.
 * @returns {Promise<{ok:boolean, index:number}>}
 */
async function matchRecoveryCode(codes, input) {
  const candidate = normalizeRecoveryInput(input);
  if (!candidate) return { ok: false, index: -1 };

  for (let i = 0; i < codes.length; i++) {
    const entry = codes[i];
    if (!entry || entry.usedAt || !entry.hash) continue;
    // eslint-disable-next-line no-await-in-loop
    const hit = await bcrypt.compare(candidate, entry.hash).catch(() => false);
    if (hit) return { ok: true, index: i };
  }
  return { ok: false, index: -1 };
}

// ── TOTP ───────────────────────────────────────────────────────────────────

function buildTotp(base32Secret, email) {
  return new TOTP({
    issuer: ISSUER,
    label: normEmail(email) || 'account',
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(base32Secret),
  });
}

/**
 * Create an unconfirmed enrolment: a fresh secret plus everything the UI needs
 * to show it. The secret is returned once, here, and only ever again as an
 * encrypted blob.
 */
async function createEnrolment(email) {
  const secret = new Secret({ size: SECRET_BYTES });
  const base32 = secret.base32;
  const totp = buildTotp(base32, email);
  const uri = totp.toString();
  const qrDataUrl = await QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
    color: { dark: '#0a1024', light: '#ffffff' },
  });
  return { base32, uri, qrDataUrl };
}

/** Group the base32 secret into readable blocks for manual entry. */
function formatManualKey(base32) {
  return String(base32 || '').replace(/(.{4})/g, '$1 ').trim();
}

function currentCounter() {
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD);
}

/**
 * Validate a 6-digit code against a secret, refusing any time-step that has
 * already been spent so a shoulder-surfed code cannot be replayed.
 * @returns {{ok:true, counter:number}|{ok:false, error:string}}
 */
function verifyTotp(base32Secret, token, lastCounter) {
  const digits = String(token || '').replace(/\D/g, '');
  if (digits.length !== TOTP_DIGITS) {
    return { ok: false, error: 'Enter the 6-digit code from your authenticator app.' };
  }

  let delta;
  try {
    delta = buildTotp(base32Secret, '').validate({ token: digits, window: TOTP_WINDOW });
  } catch (e) {
    return { ok: false, error: 'That code is not valid. Please try again.' };
  }
  if (delta === null || delta === undefined) {
    return { ok: false, error: 'That code is not valid. Please try again.' };
  }

  const counter = currentCounter() + delta;
  const previous = Number(lastCounter);
  if (Number.isFinite(previous) && previous > 0 && counter <= previous) {
    return { ok: false, error: 'That code has already been used. Wait for the next code in your app.' };
  }
  return { ok: true, counter };
}

// ── Audit log ──────────────────────────────────────────────────────────────
// Append-only, best-effort: a logging failure must never block or fail the
// security action it is describing.

const EVENTS = Object.freeze({
  SETUP_STARTED: '2fa_setup_started',
  EMAIL_VERIFIED: '2fa_email_verified',
  SECRET_ISSUED: '2fa_secret_issued',
  ENABLED: '2fa_enabled',
  DISABLED: '2fa_disabled',
  LOGIN_SUCCESS: '2fa_login_success',
  LOGIN_FAILED: '2fa_login_failed',
  RECOVERY_USED: '2fa_recovery_code_used',
  RECOVERY_REGENERATED: '2fa_recovery_codes_regenerated',
  AUTHENTICATOR_CHANGED: '2fa_authenticator_changed',
  VERIFY_FAILED: '2fa_verification_failed',
});

async function logSecurityEvent({ userId, email, event, outcome = 'success', ip = '', device = '', detail = '' }) {
  try {
    await db.appendRow(db.SHEETS.SECURITY_AUDIT, {
      id: uuidv4(),
      userId: userId || '',
      email: normEmail(email),
      event: String(event || ''),
      outcome: String(outcome || ''),
      ipAddress: String(ip || ''),
      device: String(device || ''),
      // Detail is for humans reading the log — never a code, secret or hash.
      detail: String(detail || ''),
      createdAt: nowIso(),
    });
  } catch (e) {
    console.warn('[2fa] audit write failed:', e.message);
  }
}

/** "rupayan@example.com" -> "r******n@example.com" */
function maskEmail(email) {
  const clean = normEmail(email);
  const at = clean.indexOf('@');
  if (at <= 0) return '***';
  const name = clean.slice(0, at);
  const domain = clean.slice(at);
  if (name.length <= 2) return `${name[0]}***${domain}`;
  return `${name[0]}${'*'.repeat(Math.max(3, name.length - 2))}${name[name.length - 1]}${domain}`;
}

function isPendingFresh(record) {
  if (!record || !record.pendingSecretEncrypted) return false;
  const started = Date.parse(record.pendingCreatedAt || '');
  if (!Number.isFinite(started)) return false;
  return Date.now() - started < PENDING_SETUP_TTL_MS;
}

module.exports = {
  // config
  isConfigured,
  EVENTS,
  RECOVERY_CODE_COUNT,
  PENDING_SETUP_TTL_MS,
  // crypto
  encryptSecret,
  decryptSecret,
  // tokens
  issueStepUpToken,
  verifyStepUpToken,
  issueLoginChallengeToken,
  verifyLoginChallengeToken,
  // storage
  findRecord,
  saveRecord,
  describeRecord,
  parseRecoveryCodes,
  isPendingFresh,
  // recovery codes
  generateRecoveryCodes,
  matchRecoveryCode,
  normalizeRecoveryInput,
  // totp
  createEnrolment,
  formatManualKey,
  verifyTotp,
  currentCounter,
  // misc
  logSecurityEvent,
  maskEmail,
  normEmail,
  truthy,
  nowIso,
};
