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
}

module.exports = { get, set, invalidate, COUPON_LIST_CACHE_TTL_MS };
