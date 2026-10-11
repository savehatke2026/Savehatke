// ============================================
// SaveHatke — Coupon-List Cache (shared)
// ============================================
// Short in-process TTL cache for the merged admin coupon list. The list
// re-requests on every tab switch, pagination click, pill filter and search
// keystroke; this makes those repeats instant. Every admin coupon mutation
// (and every coupon-image upload) invalidates it, so a read that follows any
// change is always fresh. See getAdminCouponList in routes/admin.js.
// ============================================

const COUPON_LIST_CACHE_TTL_MS = 15_000;
const COUPON_LIST_CACHE_MAX = 50; // filter-combination cap; the UI uses a handful

// "status|source|category" -> { at, payload }
const cache = new Map();

/** Cached merged-list payload for the filter key, or null when absent/stale. */
function get(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < COUPON_LIST_CACHE_TTL_MS) return hit.payload;
  return null;
}

/** Store a freshly merged payload under the filter key. */
function set(key, payload) {
  if (cache.size >= COUPON_LIST_CACHE_MAX) cache.clear();
  cache.set(key, { at: Date.now(), payload });
}

/** Drop every entry — call after ANY admin coupon mutation or image upload. */
function invalidate() {
  cache.clear();
  snapshot = null;
  snapshotPending = null;
}

// ── Raw source snapshot ───────────────────────────────────────────────────
// The three full reads behind every list request (all Supabase coupons, all
// Sheet coupons, the payouts map). Filter, page, search and sort changes all
// re-ran these; sharing one short-lived snapshot makes them instant. The same
// invalidate() above clears it, so any mutation is reflected on the next read.
const SNAPSHOT_TTL_MS = 20_000;
let snapshot = null;        // { at, value }
let snapshotPending = null; // single-flight: concurrent callers share one read

/** Returns the shared snapshot, loading it once via `loader` when absent or stale. */
async function getSnapshot(loader) {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.value;
  if (snapshotPending) return snapshotPending;
  const started = Date.now();
  snapshotPending = loader()
    .then((value) => { snapshot = { at: started, value }; return value; })
    .finally(() => { snapshotPending = null; });
  return snapshotPending;
}

module.exports = { get, set, invalidate, getSnapshot, COUPON_LIST_CACHE_TTL_MS };
