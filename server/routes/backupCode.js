// ============================================
// SaveHatke — Backup-Code Admin Login (SOS Access)
// ============================================
// Emergency admin access path: a backup code typed into the login email
// field unlocks a "Reason for using this Backup code" prompt, then a
// picker for one of two privileged admin emails. Every step is audited.
//
// Storage: codes live in MongoDB (models/BackupCode.js). Only the bcrypt
// hash + a short prefix are persisted. The cleartext is shown to the
// minter exactly once and is never recoverable from the database.
//
// Two-step flow (prevents admin-email enumeration by anyone who doesn't
// hold a real code):
//   1. POST /api/admin/backup-code/init    { code, reason }
//        - bcrypt-compare the code against all active MongoDB rows
//        - record init in audit sheet
//        - issue a short-lived (5 min), single-use init token bound to IP
//        - return the list of 2 admin emails + their display names
//   2. POST /api/admin/backup-code/complete { code, chosenEmail, initToken }
//        - re-check the code, validate the init token
//        - confirm chosenEmail is in the allowlist
//        - mint a 12h admin JWT (same shape as POST /api/admin/login)
//        - bump usageCount, stamp lastUsedAt/IP/reason on the code row
//        - record completion in the audit sheet
//
// Admin management (auth required, all super-admin only):
//   POST   /api/admin/backup-code/admin/create         mint a new code
//   GET    /api/admin/backup-code/admin/list           list codes (no secrets)
//   PUT    /api/admin/backup-code/admin/:id            update label/notes/expiry/cap
//   POST   /api/admin/backup-code/admin/:id/revoke     revoke (isActive=false)
//   POST   /api/admin/backup-code/admin/:id/restore    re-activate a revoked code
//
// Rate-limited per IP. Audit log is best-effort; a Sheets write failure
// never blocks a legitimate SOS login, but is logged loudly to stderr.

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const db = require('../services/googleSheets');
const getClientIP = require('../middleware/getClientIP');
const { generateToken, authenticateToken, requireAdmin } = require('../middleware/auth');
const BackupCode = require('../models/BackupCode');
const mongoose = require('mongoose');

const router = express.Router();

// ── The two privileged admin emails the backup code can unlock. ────────────
// Mirrors the hardcoded fallback list in routes/admin.js so the SOS path
// works even when the Mongo Admin collection is unreachable. Update both
// if you ever rotate the admin roster.
const BACKUP_CODE_ALLOWED_ADMINS = [
  { email: 'jaggik8888@gmail.com', name: 'Jaggik',   role: 'Super Admin' },
  { email: 'rupayandas2024@gmail.com', name: 'Rupayan', role: 'Super Admin' },
];

// ── In-memory init tokens (5 min TTL, single-use, IP-bound). ───────────────
const INIT_TOKEN_TTL_MS = 5 * 60 * 1000;
const initTokenStore = new Map(); // token -> { codeId, codePrefix, reason, ip, ua, createdAt, used, allowedEmails }

function gcInitTokens() {
  const now = Date.now();
  for (const [k, v] of initTokenStore.entries()) {
    if (now - v.createdAt > INIT_TOKEN_TTL_MS) initTokenStore.delete(k);
  }
}
setInterval(gcInitTokens, 60 * 1000).unref?.();

// ── Per-IP rate limiter for the public flow. ───────────────────────────────
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 5;
const ipAttempts = new Map();

function noteAttempt(ip) {
  const now = Date.now();
  const arr = ipAttempts.get(ip) || [];
  const fresh = arr.filter((t) => now - t < RATE_WINDOW_MS);
  fresh.push(now);
  ipAttempts.set(ip, fresh);
  return fresh.length;
}

function isRateLimited(ip) {
  const now = Date.now();
  const arr = (ipAttempts.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  return arr.length >= RATE_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of ipAttempts.entries()) {
    const fresh = arr.filter((t) => now - t < RATE_WINDOW_MS);
    if (fresh.length === 0) ipAttempts.delete(ip);
    else ipAttempts.set(ip, fresh);
  }
}, 5 * 60 * 1000).unref?.();

// ── Helpers. ───────────────────────────────────────────────────────────────
function isBackupCodeShape(s) {
  if (!s || typeof s !== 'string') return false;
  const v = s.trim();
  if (v.length < 8 || v.length > 128) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return false; // not an email
  return true;
}

function isMongoReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function codePrefixFromHash(hash) {
  return crypto.createHash('sha256').update(String(hash)).digest('hex').slice(0, 6);
}

async function writeAuditRow(row) {
  try {
    await db.appendRow(db.SHEETS.BACKUP_CODE_AUDIT, {
      id: uuidv4(),
      codeSuffix: String(row.codePrefix || '').slice(0, 32),
      reason: String(row.reason || '').slice(0, 500),
      ip: String(row.ip || '').slice(0, 64),
      userAgent: String(row.userAgent || '').slice(0, 300),
      chosenEmail: String(row.chosenEmail || '').slice(0, 200),
      success: row.success ? 'true' : 'false',
      initAt: row.initAt || '',
      completeAt: row.completeAt || '',
      error: String(row.error || '').slice(0, 200),
    });
  } catch (e) {
    console.warn('[backupCode] audit row write failed:', e.message);
  }
}

/**
 * Find the first active MongoDB backup code that matches the submitted
 * cleartext via bcrypt, and that is not expired or over its usage cap.
 * Returns the BackupCode document on success, or null.
 */
async function matchBackupCode(code) {
  if (!isMongoReady()) return null;
  const now = new Date();
  const candidates = await BackupCode.find({
    isActive: true,
    $and: [
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
    ],
  }).select('+codeHash codePrefix usageCount maxUses');

  for (const row of candidates) {
    // If the row has a maxUses cap, skip rows that are already at it
    if (row.maxUses != null && row.usageCount >= row.maxUses) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(code, row.codeHash)) return row;
    } catch (e) { /* malformed hash — skip */ }
  }
  return null;
}

function isCodeUsable(row) {
  if (!row || !row.isActive) return false;
  if (row.expiresAt && new Date(row.expiresAt) <= new Date()) return false;
  if (row.maxUses != null && row.usageCount >= row.maxUses) return false;
  return true;
}

// ── POST /api/admin/backup-code/init ──────────────────────────────────────
router.post('/init', async (req, res) => {
  const ip = getClientIP(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const initAt = new Date().toISOString();

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }
  noteAttempt(ip);

  const { code, reason } = req.body || {};

  if (!isBackupCodeShape(code)) {
    return res.status(400).json({ error: 'Invalid backup code format.' });
  }
  const reasonText = String(reason || '').trim();
  if (reasonText.length < 10) {
    return res.status(400).json({ error: 'Please provide a reason of at least 10 characters explaining why you need SOS access.' });
  }
  if (reasonText.length > 500) {
    return res.status(400).json({ error: 'Reason is too long (max 500 characters).' });
  }

  if (!isMongoReady()) {
    await writeAuditRow({
      codePrefix: '(mongo-down)',
      reason: reasonText, ip, userAgent: ua, chosenEmail: '',
      success: false, initAt, completeAt: '',
      error: 'MONGO_NOT_READY',
    });
    return res.status(503).json({ error: 'Backup-code service is offline. Please try again in a moment.' });
  }

  const matched = await matchBackupCode(code.trim());

  if (!matched) {
    await writeAuditRow({
      codePrefix: code.trim().slice(-4),
      reason: reasonText, ip, userAgent: ua, chosenEmail: '',
      success: false, initAt, completeAt: '',
      error: 'CODE_MISMATCH',
    });
    return res.status(401).json({ error: 'Backup code is invalid.' });
  }

  const initToken = crypto.randomBytes(24).toString('hex');
  initTokenStore.set(initToken, {
    codeId: matched.id,
    codePrefix: matched.codePrefix,
    reason: reasonText,
    ip,
    ua,
    createdAt: Date.now(),
    used: false,
    allowedEmails: Array.isArray(matched.allowedAdminEmails) ? matched.allowedAdminEmails.slice() : [],
  });

  await writeAuditRow({
    codePrefix: matched.codePrefix,
    reason: reasonText, ip, userAgent: ua, chosenEmail: '',
    success: true, initAt, completeAt: '',
    error: '',
  });

  // Filter the allowlist to the admins this specific code is restricted to,
  // or show the full allowlist if the code has no per-code restriction.
  const allow = Array.isArray(matched.allowedAdminEmails) && matched.allowedAdminEmails.length
    ? BACKUP_CODE_ALLOWED_ADMINS.filter((a) => matched.allowedAdminEmails.includes(a.email))
    : BACKUP_CODE_ALLOWED_ADMINS;

  res.json({
    initToken,
    expiresInSeconds: Math.floor(INIT_TOKEN_TTL_MS / 1000),
    codePrefix: matched.codePrefix,
    admins: allow.map((a) => ({ email: a.email, name: a.name, role: a.role })),
  });
});

// ── POST /api/admin/backup-code/complete ──────────────────────────────────
router.post('/complete', async (req, res) => {
  const ip = getClientIP(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const completeAt = new Date().toISOString();

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }
  noteAttempt(ip);

  const { code, chosenEmail, initToken } = req.body || {};

  const record = initToken ? initTokenStore.get(initToken) : null;
  if (!record || record.used || (Date.now() - record.createdAt) > INIT_TOKEN_TTL_MS) {
    if (record) initTokenStore.delete(initToken);
    return res.status(401).json({ error: 'Your backup-code session has expired. Please start over.' });
  }
  if (record.ip !== ip) {
    initTokenStore.delete(initToken);
    return res.status(401).json({ error: 'Network changed during the backup-code flow. Please start over.' });
  }

  const cleanEmail = String(chosenEmail || '').toLowerCase().trim();
  const admin = BACKUP_CODE_ALLOWED_ADMINS.find((a) => a.email === cleanEmail);
  if (!admin) {
    return res.status(400).json({ error: 'Selected admin account is not allowed.' });
  }
  if (record.allowedEmails.length && !record.allowedEmails.includes(cleanEmail)) {
    return res.status(403).json({ error: 'This backup code is not authorized for that admin account.' });
  }

  if (!isBackupCodeShape(code)) {
    initTokenStore.delete(initToken);
    return res.status(401).json({ error: 'Backup code is invalid.' });
  }

  // Re-check against MongoDB (defence in depth + cap / expiry freshness).
  if (!isMongoReady()) {
    initTokenStore.delete(initToken);
    return res.status(503).json({ error: 'Backup-code service is offline. Please try again in a moment.' });
  }
  const fresh = await BackupCode.findOne({ id: record.codeId }).select('+codeHash');
  if (!isCodeUsable(fresh) || !(await bcrypt.compare(code.trim(), fresh.codeHash))) {
    initTokenStore.delete(initToken);
    await writeAuditRow({
      codePrefix: record.codePrefix,
      reason: record.reason, ip, userAgent: ua, chosenEmail: cleanEmail,
      success: false, initAt: '', completeAt,
      error: fresh && !isCodeUsable(fresh) ? 'CODE_UNUSABLE' : 'CODE_MISMATCH_AT_COMPLETE',
    });
    return res.status(401).json({ error: 'Backup code is invalid or no longer usable.' });
  }

  // Burn the token and stamp usage on the code row
  record.used = true;
  initTokenStore.delete(initToken);

  try {
    fresh.usageCount = (fresh.usageCount || 0) + 1;
    fresh.lastUsedAt = new Date();
    fresh.lastUsedIp = ip;
    fresh.lastUsedReason = record.reason.slice(0, 500);
    await fresh.save();
  } catch (e) {
    // Non-blocking: if we can't bump the counter, the user still got in
    console.warn('[backupCode] failed to bump usageCount:', e.message);
  }

  // Issue admin JWT (same shape as /api/admin/login)
  const adminId = uuidv4();
  const adminUser = {
    id: adminId,
    full_name: admin.name,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    is_active: true,
    email_verified: true,
    two_factor_enabled: false,
    login_method: 'Backup Code (SOS)',
    last_login: new Date().toISOString(),
  };

  const token = generateToken(
    { id: adminId, email: admin.email, name: admin.name, role: 'admin' },
    '12h',
  );

  await writeAuditRow({
    codePrefix: record.codePrefix,
    reason: record.reason, ip, userAgent: ua, chosenEmail: cleanEmail,
    success: true, initAt: '', completeAt,
    error: '',
  });

  console.log(
    `\n\x1b[32m[SOS] Backup-code admin login: ${admin.email} from IP ${ip} | codePrefix: ${record.codePrefix} | reason: "${record.reason}"\x1b[0m`,
  );

  res.json({
    message: 'Admin login successful (backup code).',
    token,
    user: adminUser,
  });
});

// ── GET /api/admin/backup-code/status ─────────────────────────────────────
router.get('/status', async (_req, res) => {
  let codeCount = 0;
  let activeCount = 0;
  if (isMongoReady()) {
    try {
      codeCount = await BackupCode.countDocuments({});
      activeCount = await BackupCode.countDocuments({ isActive: true });
    } catch (e) { /* ignore */ }
  }
  res.json({
    ok: true,
    mongoReady: isMongoReady(),
    codeCount,
    activeCount,
    admins: BACKUP_CODE_ALLOWED_ADMINS.map((a) => ({ email: a.email, name: a.name, role: a.role })),
    initTokenTtlSeconds: Math.floor(INIT_TOKEN_TTL_MS / 1000),
    rateLimit: { max: RATE_MAX, windowSeconds: Math.floor(RATE_WINDOW_MS / 1000) },
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN MANAGEMENT ENDPOINTS (auth required, super-admin only)
// ════════════════════════════════════════════════════════════════════════════

// All admin-management routes are gated by authenticateToken + requireAdmin
// (same as the rest of /api/admin/*). The admin that creates a code is
// recorded as the `createdBy` field on the Mongo row.

/**
 * Mint a fresh code, persist the hash to MongoDB, and return the cleartext
 * EXACTLY ONCE in the response. The caller is responsible for capturing it
 * and handing it to the human owner over a secure channel.
 */
router.post('/admin/create', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isMongoReady()) {
      return res.status(503).json({ error: 'MongoDB is not reachable. Cannot mint a new code right now.' });
    }

    const {
      label,
      notes = '',
      expiresAt = null,    // ISO date string or null
      maxUses = null,      // integer or null
      allowedAdminEmails = [],
    } = req.body || {};

    if (!label || !String(label).trim()) {
      return res.status(400).json({ error: 'label is required.' });
    }
    if (String(label).length > 120) {
      return res.status(400).json({ error: 'label is too long (max 120 chars).' });
    }

    let expiresAtDate = null;
    if (expiresAt) {
      const d = new Date(expiresAt);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'expiresAt must be a valid ISO date string.' });
      if (d.getTime() <= Date.now()) return res.status(400).json({ error: 'expiresAt must be in the future.' });
      expiresAtDate = d;
    }

    let maxUsesInt = null;
    if (maxUses !== null && maxUses !== undefined && maxUses !== '') {
      const n = Number(maxUses);
      if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'maxUses must be a positive integer.' });
      maxUsesInt = n;
    }

    // Validate any per-code email restrictions against the route allowlist
    const validEmails = Array.isArray(allowedAdminEmails)
      ? allowedAdminEmails
          .map((e) => String(e).toLowerCase().trim())
          .filter((e) => BACKUP_CODE_ALLOWED_ADMINS.some((a) => a.email === e))
      : [];
    if (Array.isArray(allowedAdminEmails) && allowedAdminEmails.length && validEmails.length === 0) {
      return res.status(400).json({ error: 'allowedAdminEmails did not contain any recognised admin addresses.' });
    }

    // Mint the cleartext (64 bits of entropy) and bcrypt it
    const segs = [];
    for (let i = 0; i < 4; i++) segs.push(crypto.randomBytes(2).toString('hex').toUpperCase());
    const cleartext = `SH-BK-${segs.join('-')}`;
    const hash = await bcrypt.hash(cleartext, 10);
    const codePrefix = codePrefixFromHash(hash);

    const createdBy = req.user?.email || req.user?.id || 'admin';

    const row = await BackupCode.create({
      id: uuidv4(),
      codeHash: hash,
      codePrefix,
      label: String(label).trim(),
      createdBy,
      notes: String(notes || '').slice(0, 1000),
      isActive: true,
      expiresAt: expiresAtDate,
      maxUses: maxUsesInt,
      allowedAdminEmails: validEmails,
    });

    res.status(201).json({
      message: 'Backup code minted. Save the cleartext now — it will NOT be shown again.',
      code: {
        id: row.id,
        codePrefix: row.codePrefix,
        cleartext,                  // shown ONCE
        label: row.label,
        createdBy: row.createdBy,
        notes: row.notes,
        expiresAt: row.expiresAt,
        maxUses: row.maxUses,
        allowedAdminEmails: row.allowedAdminEmails,
        created_at: row.created_at,
      },
    });
  } catch (err) {
    console.error('Backup code create error:', err);
    res.status(500).json({ error: 'Failed to mint backup code: ' + err.message });
  }
});

/** List codes (no secrets). Supports a few filters. */
router.get('/admin/list', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isMongoReady()) {
      return res.status(503).json({ error: 'MongoDB is not reachable.' });
    }
    const { includeInactive = 'true' } = req.query;
    const filter = includeInactive === 'false' ? { isActive: true } : {};
    const rows = await BackupCode.find(filter).sort({ created_at: -1 }).limit(200);
    res.json({
      total: rows.length,
      codes: rows.map((r) => r.toSafeJSON()),
    });
  } catch (err) {
    console.error('Backup code list error:', err);
    res.status(500).json({ error: 'Failed to list codes.' });
  }
});

/** Update mutable fields (label, notes, expiresAt, maxUses, allowedAdminEmails). */
router.put('/admin/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isMongoReady()) return res.status(503).json({ error: 'MongoDB is not reachable.' });
    const row = await BackupCode.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Code not found.' });

    const { label, notes, expiresAt, maxUses, allowedAdminEmails } = req.body || {};

    if (label !== undefined) {
      if (!String(label).trim()) return res.status(400).json({ error: 'label cannot be empty.' });
      if (String(label).length > 120) return res.status(400).json({ error: 'label is too long (max 120 chars).' });
      row.label = String(label).trim();
    }
    if (notes !== undefined) row.notes = String(notes || '').slice(0, 1000);

    if (expiresAt !== undefined) {
      if (expiresAt === null || expiresAt === '') {
        row.expiresAt = null;
      } else {
        const d = new Date(expiresAt);
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'expiresAt must be a valid ISO date string or null.' });
        row.expiresAt = d;
      }
    }

    if (maxUses !== undefined) {
      if (maxUses === null || maxUses === '') {
        row.maxUses = null;
      } else {
        const n = Number(maxUses);
        if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'maxUses must be a positive integer or null.' });
        row.maxUses = n;
      }
    }

    if (allowedAdminEmails !== undefined) {
      if (!Array.isArray(allowedAdminEmails)) return res.status(400).json({ error: 'allowedAdminEmails must be an array.' });
      const valid = allowedAdminEmails
        .map((e) => String(e).toLowerCase().trim())
        .filter((e) => BACKUP_CODE_ALLOWED_ADMINS.some((a) => a.email === e));
      row.allowedAdminEmails = valid;
    }

    await row.save();
    res.json({ message: 'Code updated.', code: row.toSafeJSON() });
  } catch (err) {
    console.error('Backup code update error:', err);
    res.status(500).json({ error: 'Failed to update code.' });
  }
});

/** Revoke a code (isActive=false). The hash + audit history are preserved. */
router.post('/admin/:id/revoke', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isMongoReady()) return res.status(503).json({ error: 'MongoDB is not reachable.' });
    const row = await BackupCode.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Code not found.' });
    row.isActive = false;
    await row.save();
    res.json({ message: 'Code revoked.', code: row.toSafeJSON() });
  } catch (err) {
    console.error('Backup code revoke error:', err);
    res.status(500).json({ error: 'Failed to revoke code.' });
  }
});

/** Re-activate a previously revoked code. */
router.post('/admin/:id/restore', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isMongoReady()) return res.status(503).json({ error: 'MongoDB is not reachable.' });
    const row = await BackupCode.findOne({ id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Code not found.' });
    if (row.expiresAt && new Date(row.expiresAt) <= new Date()) {
      return res.status(400).json({ error: 'Cannot restore an expired code. Update expiresAt first.' });
    }
    row.isActive = true;
    await row.save();
    res.json({ message: 'Code restored.', code: row.toSafeJSON() });
  } catch (err) {
    console.error('Backup code restore error:', err);
    res.status(500).json({ error: 'Failed to restore code.' });
  }
});

module.exports = router;
