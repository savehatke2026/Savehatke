// ============================================
// SaveHatke — Backup-Code Admin Login (SOS Access)
// ============================================
// Emergency admin access path: a backup code typed into the login email
// field unlocks a "Reason for using this Backup code" prompt, then a
// picker for one of two privileged admin emails. Every step is audited.
//
// Storage: codes live in Supabase (table backup_codes) and/or MongoDB
// (models/BackupCode.js), behind services/backupCodeStore.js. Only the bcrypt
// hash + a short prefix are persisted. The cleartext is shown to the
// minter exactly once and is never recoverable from either store.
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
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const backupCodeStore = require('../services/backupCodeStore');

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

// The Mongo-only code lookup that used to live here (matchBackupCode /
// isCodeUsable / ensureMongoReady) is gone: matching now belongs to
// services/backupCodeStore.js, which checks every store a code may live in.
// Nothing called them — /init and /complete were retired long before this.

// ── RETIRED: POST /init and POST /complete ────────────────────────────────
// These two endpoints used to be the whole SOS flow: they took the raw backup
// code and a reason, and /complete then minted a 12-hour admin JWT with no
// CAPTCHA, no security questions, no server-side session row and no cookie.
//
// They are answered with 410 rather than deleted because leaving a weaker
// parallel path mounted would defeat the staged flow entirely — a code holder
// could simply skip the questions. The replacement lives in routes/sos.js:
//   POST /api/admin/sos/check-code  →  /start  →  /select-admin  →  /verify
//
// The reply is intentionally uninformative about codes and administrators.
const RETIRED_MSG = { error: 'Unable to continue with SOS recovery.' };

router.post('/init', (req, res) => {
  console.warn(`[backup-code] retired /init called from ${getClientIP(req)} — direct to /api/admin/sos/check-code`);
  res.status(410).json(RETIRED_MSG);
});

router.post('/complete', (req, res) => {
  console.warn(`[backup-code] retired /complete called from ${getClientIP(req)} — direct to /api/admin/sos/verify`);
  res.status(410).json(RETIRED_MSG);
});

// ── GET /api/admin/backup-code/status ─────────────────────────────────────
// This endpoint is unauthenticated, so it now says only whether the flow can
// run. It used to publish both administrators' email addresses, how many backup
// codes exist and the exact rate-limit parameters — a free reconnaissance feed
// for anyone probing the break-glass path. The counts and identities moved to
// GET /admin/list, which requires an authenticated admin.
//
// "Available" means at least one code store can be reached: codes live in
// Supabase, MongoDB or both, and either is enough to verify one.
router.get('/status', async (_req, res) => {
  const stores = backupCodeStore.describeStores();
  res.json({ ok: true, available: Boolean(stores.mongo || stores.supabase) });
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN MANAGEMENT ENDPOINTS (auth required, super-admin only)
// ════════════════════════════════════════════════════════════════════════════

// All admin-management routes are gated by authenticateToken + requireAdmin
// (same as the rest of /api/admin/*). The admin that creates a code is
// recorded as the `createdBy` field on the Mongo row.

/**
 * Mint a fresh code, persist the hash to every reachable store, and return the
 * cleartext EXACTLY ONCE in the response. The caller is responsible for
 * capturing it and handing it to the human owner over a secure channel.
 *
 * The same id and the same bcrypt hash go to every store, so one code reads as
 * one code in the audit trail no matter which store later answers for it.
 */
router.post('/admin/create', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const stores = backupCodeStore.describeStores();
    if (!stores.mongo && !stores.supabase) {
      return res.status(503).json({ error: 'No code store is reachable (Supabase and MongoDB are both unavailable). Cannot mint a new code right now.' });
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

    const fields = {
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
    };

    const { written, failed } = await backupCodeStore.create(fields);
    if (!written.length) {
      console.error('[backup-code] mint failed in every store:', JSON.stringify(failed));
      return res.status(503).json({
        error: 'Could not save the new code to any store. Nothing was minted.',
        details: failed.map((f) => `${f.store}: ${f.error}`),
      });
    }
    if (failed.length) {
      console.warn('[backup-code] minted, but one store refused:', JSON.stringify(failed));
    }

    res.status(201).json({
      message: 'Backup code minted. Save the cleartext now — it will NOT be shown again.',
      // Which stores actually hold it. A code in only one store still works, but
      // the operator should know the redundancy they did or did not get.
      savedTo: written.map((w) => w.store),
      storeErrors: failed.map((f) => `${f.store}: ${f.error}`),
      code: {
        id: fields.id,
        codePrefix,
        cleartext,                  // shown ONCE
        label: fields.label,
        createdBy,
        notes: fields.notes,
        expiresAt: fields.expiresAt,
        maxUses: fields.maxUses,
        allowedAdminEmails: fields.allowedAdminEmails,
      },
    });
  } catch (err) {
    console.error('Backup code create error:', err);
    res.status(500).json({ error: 'Failed to mint backup code: ' + err.message });
  }
});

/** List codes from every reachable store (no secrets). */
router.get('/admin/list', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { includeInactive = 'true' } = req.query;
    const { rows, answered } = await backupCodeStore.listAll({
      includeInactive: includeInactive !== 'false',
    });
    if (!answered.length) {
      return res.status(503).json({ error: 'No code store is reachable.' });
    }
    res.json({
      total: rows.length,
      stores: answered,
      codes: rows.map(backupCodeStore.toSafeJSON),
    });
  } catch (err) {
    console.error('Backup code list error:', err);
    res.status(500).json({ error: 'Failed to list codes.' });
  }
});

/** Update mutable fields (label, notes, expiresAt, maxUses, allowedAdminEmails). */
router.put('/admin/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const row = await backupCodeStore.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Code not found.' });

    const { label, notes, expiresAt, maxUses, allowedAdminEmails } = req.body || {};
    const updates = {};

    if (label !== undefined) {
      if (!String(label).trim()) return res.status(400).json({ error: 'label cannot be empty.' });
      if (String(label).length > 120) return res.status(400).json({ error: 'label is too long (max 120 chars).' });
      updates.label = String(label).trim();
    }
    if (notes !== undefined) updates.notes = String(notes || '').slice(0, 1000);

    if (expiresAt !== undefined) {
      if (expiresAt === null || expiresAt === '') {
        updates.expiresAt = null;
      } else {
        const d = new Date(expiresAt);
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'expiresAt must be a valid ISO date string or null.' });
        updates.expiresAt = d;
      }
    }

    if (maxUses !== undefined) {
      if (maxUses === null || maxUses === '') {
        updates.maxUses = null;
      } else {
        const n = Number(maxUses);
        if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'maxUses must be a positive integer or null.' });
        updates.maxUses = n;
      }
    }

    if (allowedAdminEmails !== undefined) {
      if (!Array.isArray(allowedAdminEmails)) return res.status(400).json({ error: 'allowedAdminEmails must be an array.' });
      updates.allowedAdminEmails = allowedAdminEmails
        .map((e) => String(e).toLowerCase().trim())
        .filter((e) => BACKUP_CODE_ALLOWED_ADMINS.some((a) => a.email === e));
    }

    const saved = await backupCodeStore.update(row.id, updates, { store: row.store });
    if (!saved) return res.status(503).json({ error: 'Could not save the change to the code store.' });
    res.json({ message: 'Code updated.', code: backupCodeStore.toSafeJSON(saved) });
  } catch (err) {
    console.error('Backup code update error:', err);
    res.status(500).json({ error: 'Failed to update code.' });
  }
});

/** Revoke a code (isActive=false). The hash + audit history are preserved. */
router.post('/admin/:id/revoke', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const row = await backupCodeStore.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Code not found.' });
    const saved = await backupCodeStore.update(row.id, { isActive: false }, { store: row.store });
    if (!saved) return res.status(503).json({ error: 'Could not save the change to the code store.' });
    res.json({ message: 'Code revoked.', code: backupCodeStore.toSafeJSON(saved) });
  } catch (err) {
    console.error('Backup code revoke error:', err);
    res.status(500).json({ error: 'Failed to revoke code.' });
  }
});

/** Re-activate a previously revoked code. */
router.post('/admin/:id/restore', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const row = await backupCodeStore.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Code not found.' });
    if (row.expiresAt && new Date(row.expiresAt) <= new Date()) {
      return res.status(400).json({ error: 'Cannot restore an expired code. Update expiresAt first.' });
    }
    const saved = await backupCodeStore.update(row.id, { isActive: true }, { store: row.store });
    if (!saved) return res.status(503).json({ error: 'Could not save the change to the code store.' });
    res.json({ message: 'Code restored.', code: backupCodeStore.toSafeJSON(saved) });
  } catch (err) {
    console.error('Backup code restore error:', err);
    res.status(500).json({ error: 'Failed to restore code.' });
  }
});

module.exports = router;
