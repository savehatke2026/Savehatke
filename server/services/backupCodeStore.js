// ============================================
// SaveHatke — Backup-Code Store
// ============================================
// One place that knows where SOS backup codes live. Codes may sit in Supabase
// (table backup_codes), in MongoDB (models/BackupCode), or in both, and the SOS
// gate reads every store it can reach.
//
// Why two stores rather than a migration to one: a break-glass credential is
// worth nothing if it can only be verified through the database that happens to
// be misconfigured. An Atlas IP allowlist, an expired connection string or a
// paused cluster is exactly the situation the code exists for. So a store that
// is unreachable is skipped, never fatal — the caller is told which stores
// answered, and refuses only when none of them did.
//
// The cleartext code never reaches this file. Callers bcrypt-compare against the
// `codeHash` on the rows returned by listActiveCandidates().

const supabase = require('./supabase');
const { isMongoReady, waitForMongoReady } = require('../config/db');

const MONGO = 'mongo';
const SUPABASE = 'supabase';

/** Loaded lazily so requiring this file never forces a Mongoose model build. */
function mongoModel() {
  // eslint-disable-next-line global-require
  return require('../models/BackupCode');
}

async function mongoUsable(waitMs = 0) {
  if (isMongoReady()) return true;
  if (!waitMs) return false;
  try {
    return await waitForMongoReady(waitMs);
  } catch (e) {
    return false;
  }
}

function supabaseUsable() {
  return supabase.isConfigured();
}

/** Which stores are configured at all. Neither implies reachable. */
function describeStores() {
  return { mongo: isMongoReady(), supabase: supabaseUsable() };
}

/**
 * Every live code worth bcrypt-comparing against, from every store that
 * answered. Each row carries the `store` it came from so a later usage stamp
 * lands in the right place.
 *
 * @returns {Promise<{candidates: object[], answered: string[], failed: object[]}>}
 *          `answered` lists the stores that responded (even with zero rows);
 *          an empty `answered` means nothing could be consulted.
 */
async function listActiveCandidates({ waitForMongoMs = 5000 } = {}) {
  const candidates = [];
  const answered = [];
  const failed = [];

  if (supabaseUsable()) {
    try {
      const rows = await supabase.listActiveBackupCodes();
      if (rows === null) {
        failed.push({ store: SUPABASE, error: 'backup_codes table is missing (run the migration)' });
      } else {
        rows.forEach((row) => candidates.push({ ...row, store: SUPABASE }));
        answered.push(SUPABASE);
      }
    } catch (err) {
      failed.push({ store: SUPABASE, error: err.message });
      console.warn('[backupCodeStore] Supabase lookup failed:', err.message);
    }
  }

  if (await mongoUsable(waitForMongoMs)) {
    try {
      const rows = await mongoModel().find({ isActive: true }).select('+codeHash').lean();
      rows.forEach((row) => candidates.push({ ...row, store: MONGO }));
      answered.push(MONGO);
    } catch (err) {
      failed.push({ store: MONGO, error: err.message });
      console.warn('[backupCodeStore] MongoDB lookup failed:', err.message);
    }
  }

  return { candidates, answered, failed };
}

/**
 * Persist a freshly minted code to every configured store, so it keeps working
 * if one of them later becomes unreachable. Succeeds when at least one write
 * landed; the caller decides what to tell the operator.
 *
 * Each store hashes nothing itself — the caller supplies `codeHash` and
 * `codePrefix`. When the same cleartext is registered in two stores from two
 * separate bcrypt calls the prefixes differ, which is why `written` reports the
 * prefix per store.
 */
async function create(fields, { waitForMongoMs = 5000 } = {}) {
  const written = [];
  const failed = [];

  if (supabaseUsable()) {
    try {
      const row = await supabase.createBackupCode(fields);
      if (row) written.push({ store: SUPABASE, id: row.id, codePrefix: row.codePrefix });
      else failed.push({ store: SUPABASE, error: 'backup_codes table is missing (run the migration)' });
    } catch (err) {
      failed.push({ store: SUPABASE, error: err.message });
    }
  }

  if (await mongoUsable(waitForMongoMs)) {
    try {
      const row = await mongoModel().create(fields);
      written.push({ store: MONGO, id: row.id, codePrefix: row.codePrefix });
    } catch (err) {
      failed.push({ store: MONGO, error: err.message });
    }
  }

  return { written, failed };
}

/** Locate a code by id in either store. Returns null when neither has it. */
async function findById(id, { waitForMongoMs = 0 } = {}) {
  if (!id) return null;

  if (supabaseUsable()) {
    try {
      const row = await supabase.findBackupCodeById(id);
      if (row) return { ...row, store: SUPABASE };
    } catch (err) {
      console.warn('[backupCodeStore] Supabase findById failed:', err.message);
    }
  }

  if (await mongoUsable(waitForMongoMs)) {
    try {
      const row = await mongoModel().findOne({ id }).lean();
      if (row) return { ...row, store: MONGO };
    } catch (err) {
      console.warn('[backupCodeStore] MongoDB findById failed:', err.message);
    }
  }

  return null;
}

/**
 * Apply metadata changes to the store the row actually lives in. `store` comes
 * from a row this module returned; without it both stores are tried.
 */
async function update(id, updates, { store = null, waitForMongoMs = 0 } = {}) {
  if (!id) return null;

  if ((!store || store === SUPABASE) && supabaseUsable()) {
    try {
      const row = await supabase.updateBackupCode(id, updates);
      if (row) return { ...row, store: SUPABASE };
    } catch (err) {
      if (store === SUPABASE) throw err;
      console.warn('[backupCodeStore] Supabase update failed:', err.message);
    }
  }

  if ((!store || store === MONGO) && await mongoUsable(waitForMongoMs)) {
    const doc = await mongoModel().findOne({ id });
    if (doc) {
      Object.assign(doc, updates);
      await doc.save();
      return { ...doc.toObject(), store: MONGO };
    }
  }

  return null;
}

/** Spend one use and stamp who/why, in the row's own store. */
async function stampUsage(id, { store = null, ip = '', reason = '' } = {}) {
  if (!id) return null;

  if ((!store || store === SUPABASE) && supabaseUsable()) {
    try {
      const row = await supabase.stampBackupCodeUsage(id, { ip, reason });
      if (row) return { ...row, store: SUPABASE };
    } catch (err) {
      console.warn('[backupCodeStore] Supabase usage stamp failed:', err.message);
    }
  }

  if ((!store || store === MONGO) && await mongoUsable(0)) {
    try {
      const res = await mongoModel().updateOne(
        { id },
        {
          $inc: { usageCount: 1 },
          $set: { lastUsedAt: new Date(), lastUsedIp: ip, lastUsedReason: reason },
        }
      );
      if (res && (res.matchedCount || res.n)) return { id, store: MONGO };
    } catch (err) {
      console.warn('[backupCodeStore] MongoDB usage stamp failed:', err.message);
    }
  }

  return null;
}

/** Merged listing for the admin UI, newest first. Metadata only is the caller's job. */
async function listAll({ includeInactive = true, waitForMongoMs = 0 } = {}) {
  const rows = [];
  const answered = [];

  if (supabaseUsable()) {
    try {
      const found = await supabase.listAllBackupCodes({ includeInactive });
      if (found !== null) {
        found.forEach((row) => rows.push({ ...row, store: SUPABASE }));
        answered.push(SUPABASE);
      }
    } catch (err) {
      console.warn('[backupCodeStore] Supabase list failed:', err.message);
    }
  }

  if (await mongoUsable(waitForMongoMs)) {
    try {
      const filter = includeInactive ? {} : { isActive: true };
      const found = await mongoModel().find(filter).sort({ created_at: -1 }).limit(200).lean();
      found.forEach((row) => rows.push({ ...row, store: MONGO }));
      answered.push(MONGO);
    } catch (err) {
      console.warn('[backupCodeStore] MongoDB list failed:', err.message);
    }
  }

  rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  return { rows, answered };
}

/** Metadata only — never the hash, and never anything a caller could replay. */
function toSafeJSON(row) {
  if (!row) return null;
  return {
    id: row.id,
    store: row.store || '',
    codePrefix: row.codePrefix,
    label: row.label,
    createdBy: row.createdBy,
    notes: row.notes || '',
    isActive: row.isActive !== false,
    expiresAt: row.expiresAt || null,
    maxUses: row.maxUses == null ? null : row.maxUses,
    usageCount: row.usageCount || 0,
    lastUsedAt: row.lastUsedAt || null,
    lastUsedIp: row.lastUsedIp || '',
    lastUsedReason: row.lastUsedReason || '',
    allowedAdminEmails: Array.isArray(row.allowedAdminEmails) ? row.allowedAdminEmails : [],
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

module.exports = {
  MONGO,
  SUPABASE,
  describeStores,
  listActiveCandidates,
  create,
  findById,
  update,
  stampUsage,
  listAll,
  toSafeJSON,
};
