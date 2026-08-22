// ============================================
// SaveHatke — Session Expiry Cleanup
// ============================================
// Flips sessions whose 48-hour expires_at has passed from 'Active' to
// 'Expired'. Security never depends on this job alone — every authenticated
// request independently checks the expiration time — the job just keeps the
// database tidy.
//
// Two execution modes:
//   • Local / long-running server: a real setInterval, every 10 minutes.
//   • Vercel serverless: no persistent timers, so authenticated requests
//     piggyback a lazy sweep (at most once every 10 minutes per instance),
//     and an HTTP endpoint /api/auth/session-cleanup can be driven by an
//     external cron or Vercel Cron.

const supabaseService = require('./supabase');

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
let lastSweepAt = 0;
let intervalStarted = false;

/**
 * Run one expiry sweep immediately. Always resolves — never throws.
 * @returns {Promise<{count:number}>}
 */
async function runSessionCleanup() {
  const result = await supabaseService.expireOutdatedSessions();
  const count = (result && result.count) || 0;
  if (count > 0) {
    console.log(`🧹 Session cleanup: ${count} session${count === 1 ? '' : 's'} expired (48h limit reached).`);
  }
  return { count };
}

/**
 * Lazy sweep — call from request paths. Runs at most once per interval
 * per server instance.
 */
async function maybeRunSessionCleanup() {
  if (Date.now() - lastSweepAt < CLEANUP_INTERVAL_MS) return;
  lastSweepAt = Date.now();
  runSessionCleanup().catch(() => {});
}

/**
 * Start the periodic timer (skipped on serverless — no persistent runtime).
 */
function startSessionCleanupInterval() {
  if (process.env.VERCEL) return; // serverless: rely on lazy sweep + cron endpoint
  if (intervalStarted) return;
  intervalStarted = true;
  setInterval(() => {
    runSessionCleanup().catch((e) => console.warn('Session cleanup warning:', e.message));
  }, CLEANUP_INTERVAL_MS);
  // One sweep shortly after boot
  setTimeout(() => runSessionCleanup().catch(() => {}), 15 * 1000);
  console.log('⏱️  Session cleanup job scheduled (every 10 minutes). Sessions expire 48h after login.');
}

module.exports = {
  runSessionCleanup,
  maybeRunSessionCleanup,
  startSessionCleanupInterval,
};
