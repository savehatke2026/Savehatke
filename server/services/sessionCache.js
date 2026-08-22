// ============================================
// SaveHatke — Session Validation Cache
// ============================================
// Shared, per-instance cache of validated session rows so authenticated
// requests don't hit Supabase every time. Lives in its own module (not the
// auth middleware) so the Supabase session writers can invalidate entries
// the moment a session is revoked — a logout takes effect immediately on
// this server instance. Other instances (serverless) notice within the
// 60-second TTL at most.
//
// Expiry itself never depends on this cache: the JWT `exp` equals the
// session expiry and is verified against the server clock on every request.

const SESSION_CACHE_TTL_MS = 60 * 1000;

const cache = new Map(); // tokenHash → { row, cachedAt, lastTouchAt }

function get(tokenHash) {
  const entry = cache.get(tokenHash);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt >= SESSION_CACHE_TTL_MS) {
    cache.delete(tokenHash);
    return null;
  }
  return entry;
}

function set(tokenHash, row) {
  cache.set(tokenHash, { row, cachedAt: Date.now(), lastTouchAt: 0 });
  prune();
}

function remove(tokenHash) {
  cache.delete(tokenHash);
}

function invalidateBySessionId(sessionId) {
  for (const [key, entry] of cache) {
    if (entry && entry.row && entry.row.session_id === sessionId) cache.delete(key);
  }
}

function invalidateByUserId(userId) {
  const wanted = String(userId);
  for (const [key, entry] of cache) {
    if (entry && entry.row && String(entry.row.user_id) === wanted) cache.delete(key);
  }
}

function clear() {
  cache.clear();
}

function prune() {
  if (cache.size < 5000) return;
  const cutoff = Date.now() - SESSION_CACHE_TTL_MS;
  for (const [key, entry] of cache) {
    if (!entry || entry.cachedAt < cutoff) cache.delete(key);
  }
}

module.exports = {
  get,
  set,
  remove,
  invalidateBySessionId,
  invalidateByUserId,
  clear,
  SESSION_CACHE_TTL_MS,
};
