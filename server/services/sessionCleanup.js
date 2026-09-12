// ============================================
// SaveHatke — Session Expiry Cleanup
// ============================================
// Two-phase cleanup of the application's own session data:
//
//   Phase 1 (expire): sessions whose 48-hour (user) / 2-hour (admin)
//     expires_at has passed are flipped from 'Active' to 'Expired'.
//     Security never depends on this job alone — every authenticated request
//     independently checks the expiration time — the flip just keeps the
//     database tidy.
//
//   Phase 2 (purge): rows that ENDED ('Expired' / 'Logged out') more than
//     SESSION_RETENTION_MS ago (90 days) are deleted from the application's
//     own user_sessions / admin_sessions tables, so expired session data does
//     not remain in the database indefinitely. The retention window exists
//     because those rows double as the device-history ledger behind the
//     "New device detected" alert (services/deviceRecognition.js) and the
//     Security page's login history. Only definitely-ended, definitely-old
//     rows are removed — an Active session is never deleted.
//
//   Phase 3 (mongo): expired SOS recovery sessions in MongoDB are swept the
//     same way. MongoDB's TTL index collects them eventually, but a TTL
//     index only runs on a replica set with a working clock — this sweep
//     makes the guarantee explicit, idempotent, and observable.
//
// Supabase's own auth.* tables are never touched: this application manages
// sessions in its own tables and does not use Supabase Auth.
//
// Two execution modes:
//   • Local / long-running server: a real setInterval, every 10 minutes.
//   • Vercel serverless: no persistent timers, so authenticated requests
//     piggyback a lazy sweep (at most once every 10 minutes per instance),
//     and an HTTP endpoint /api/auth/session-cleanup is driven daily by
//     Vercel Cron (see vercel.json).

const mongoose = require('mongoose');
const supabaseService = require('./supabase');

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes

// The purge phase has real deletes to make, so it is throttled to once an hour
// per instance; the cheap expire flip keeps its 10-minute cadence.
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

let lastSweepAt = 0;
let lastPurgeAt = 0;
let intervalStarted = false;

/**
 * Delete SOS recovery sessions in MongoDB whose expires_at has passed.
 * MongoDB's TTL index is the primary collector; this is the explicit,
 * observable backstop for the cases it misses. Only rows whose expiry has
 * DEFINITELY passed (strictly earlier than now) are removed, so a session
 * that is still live can never be swept. Idempotent by construction.
 * @returns {Promise<number>} documents removed
 */
async function purgeExpiredSosSessions() {
  try {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) return 0;
    const SosSession = require('../models/SosSession');
    const result = await SosSession.deleteMany({ expires_at: { $lt: new Date() } });
    return result ? Number(result.deletedCount || 0) : 0;
  } catch (err) {
    // Log the failure without any document contents — a Mongo error string
    // never carries session tokens, but stay in the habit anyway.
    console.warn('SOS session purge warning:', err && err.message ? err.message : err);
    return 0;
  }
}

/**
 * Run one full cleanup pass immediately. Always resolves — never throws.
 * Errors in one phase never stop the others.
 * @returns {Promise<{expired:number, purged:number, sosPurged:number}>}
 */
async function runSessionCleanup() {
  let expired = 0;
  let purged = 0;
  let sosPurged = 0;

  try {
    const result = await supabaseService.expireOutdatedSessions();
    expired = (result && result.count) || 0;
  } catch (e) {
    console.warn('Session expiry sweep warning:', e && e.message ? e.message : e);
  }
  if (expired > 0) {
    console.log(`🧹 Session cleanup: ${expired} session${expired === 1 ? '' : 's'} expired (session limit reached).`);
  }

  try {
    const result = await supabaseService.deleteExpiredSessions();
    purged = (result && result.count) || 0;
  } catch (e) {
    console.warn('Session purge warning:', e && e.message ? e.message : e);
  }
  if (purged > 0) {
    const days = Math.round(supabaseService.SESSION_RETENTION_MS / (24 * 60 * 60 * 1000));
    console.log(`🗑️  Session cleanup: ${purged} ended session${purged === 1 ? '' : 's'} deleted (past ${days}-day retention).`);
  }

  sosPurged = await purgeExpiredSosSessions();
  if (sosPurged > 0) {
    console.log(`🗑️  Session cleanup: ${sosPurged} expired SOS recovery session${sosPurged === 1 ? '' : 's'} deleted.`);
  }

  return { expired, purged, sosPurged };
}

/**
 * Lazy sweep — call from request paths. The cheap expire flip runs at most
 * once per CLEANUP_INTERVAL_MS, the purge at most once per PURGE_INTERVAL_MS,
 * per server instance.
 */
async function maybeRunSessionCleanup() {
  const now = Date.now();
  if (now - lastSweepAt < CLEANUP_INTERVAL_MS) return;
  lastSweepAt = now;

  const shouldPurge = now - lastPurgeAt >= PURGE_INTERVAL_MS;
  if (shouldPurge) lastPurgeAt = now;

  (async () => {
    if (!shouldPurge) {
      // Flip only — the same cheap sweep the interval timer performs.
      try {
        const result = await supabaseService.expireOutdatedSessions();
        const count = (result && result.count) || 0;
        if (count > 0) {
          console.log(`🧹 Session cleanup: ${count} session${count === 1 ? '' : 's'} expired (session limit reached).`);
        }
      } catch (e) {
        console.warn('Session cleanup warning:', e && e.message ? e.message : e);
      }
      return;
    }
    await runSessionCleanup();
  })().catch(() => {});
}

/**
 * Start the periodic timer (skipped on serverless — no persistent runtime).
 * Every 10 minutes: expire flip. Hourly (every 6th tick): full pass with
 * purge + SOS sweep. A full pass also runs shortly after boot.
 */
function startSessionCleanupInterval() {
  if (process.env.VERCEL) return; // serverless: rely on lazy sweep + cron endpoint
  if (intervalStarted) return;
  intervalStarted = true;
  let tick = 0;
  setInterval(() => {
    tick += 1;
    if (tick % 6 === 0) {
      // Hourly: expire + purge + SOS sweep.
      runSessionCleanup().catch((e) => console.warn('Session cleanup warning:', e && e.message ? e.message : e));
    } else {
      // 10-minute cadence: just flip past-expiry rows to 'Expired'.
      supabaseService.expireOutdatedSessions()
        .then((result) => {
          const count = (result && result.count) || 0;
          if (count > 0) {
            console.log(`🧹 Session cleanup: ${count} session${count === 1 ? '' : 's'} expired (session limit reached).`);
          }
        })
        .catch((e) => console.warn('Session cleanup warning:', e && e.message ? e.message : e));
    }
  }, CLEANUP_INTERVAL_MS);
  // One full sweep shortly after boot
  setTimeout(() => runSessionCleanup().catch(() => {}), 15 * 1000);
  const days = Math.round(supabaseService.SESSION_RETENTION_MS / (24 * 60 * 60 * 1000));
  console.log(`⏱️  Session cleanup job scheduled (every 10 minutes; ended sessions deleted after ${days} days).`);
}

module.exports = {
  runSessionCleanup,
  maybeRunSessionCleanup,
  startSessionCleanupInterval,
  purgeExpiredSosSessions,
};
