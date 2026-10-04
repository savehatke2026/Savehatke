// ============================================
// SaveHatke — MongoDB shim (Step 1 of 4-cutover migration)
// ============================================
//
// The project is moving off MongoDB onto Supabase / Google Sheets. This file
// remains as a no-op shim so every existing import path keeps resolving
// without a sweep across routes/services. The shim stays in place through the
// full 4-commit cutover and is finally removed in step 4 (when the last
// remaining Mongo consumers have been replaced).
//
// Behaviour:
//   connectDB()       → no-op (used to be the boot-time mongoose.connect)
//   isMongoReady()    → false
//   waitForMongoReady → returns false immediately (with a clear log)
//   lastConnectAttemptAt() → always 0
//
// Models in server/models/* are NOT deleted by this step — the routes that
// still import them (SOS, Gmail mailbox, settings, backup codes) keep
// working through the Mongo path until their respective cutover commits.

function connectDB() {
  // intentionally empty — MongoDB connection is no longer established at boot.
  return Promise.resolve();
}

function isMongoReady() {
  return false;
}

async function waitForMongoReady(maxMs = 5000, pollMs = 150) {
  // Step 1: pretend the connection never comes up. Routes that still depend
  // on Mongo will surface their own "service unavailable" copy. The shape of
  // this function is preserved so callers do not need to change.
  if (maxMs > 0) {
    console.warn(
      '[mongo-shim] waitForMongoReady called but MongoDB has been decoupled ' +
      'from boot; returning false. Consumer should now be reading from ' +
      'Supabase / Google Sheets.',
    );
  }
  return false;
}

function lastConnectAttemptAt() {
  return 0;
}

module.exports = {
  connectDB,
  isMongoReady,
  waitForMongoReady,
  lastConnectAttemptAt,
};