// ============================================
// SaveHatke — Session Validation Cache
// ============================================
// Per-instance cache used only to throttle last_active writes. Session rows
// are always re-read from Supabase before authorization, so revocation is
// effective across Vercel instances on the next request.

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
  const previous = cache.get(tokenHash);
  const lastTouchAt = previous && previous.row && previous.row.session_id === row.session_id
    ? previous.lastTouchAt
    : 0;
  cache.set(tokenHash, { row, cachedAt: Date.now(), lastTouchAt });
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
