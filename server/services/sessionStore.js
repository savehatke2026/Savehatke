// ============================================
// SaveHatke — Supabase Session Store
// ============================================
// Supabase is the sole source of truth for user/admin sessions.
// Only SHA-256 token hashes are stored; raw tokens stay in HttpOnly cookies.
// Authorization always performs a fresh database lookup (never cache fallback).

const crypto = require('crypto');
const supabase = require('./supabase');
const sessionCache = require('./sessionCache');

const SESSION_TTL_MS = 48 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const USER_TABLE = 'user_sessions';
const ADMIN_TABLE = 'admin_sessions';
const TABLES = [USER_TABLE, ADMIN_TABLE];

function isAdminLoginMethod(method) {
  return /^(google\s+)?admin$/i.test(String(method || '').trim());
}
function tableFor(method) {
  return isAdminLoginMethod(method) ? ADMIN_TABLE : USER_TABLE;
}
function clean(row) {
  if (!row) return null;
  const out = { ...row };
  delete out.session_token;
  return out;
}
function getClient() {
  const client = supabase.getClient();
  if (!client) throw new Error('Supabase session storage is unavailable');
  return client;
}
function throwIfError(error, operation) {
  if (error) throw new Error(`Supabase session ${operation} failed: ${error.message || 'unknown error'}`);
}
async function rowsFor(table) {
  const { data, error } = await getClient().from(table).select('*').order('login_time', { ascending: false });
  throwIfError(error, 'read');
  return data || [];
}
async function allRows() {
  const groups = await Promise.all(TABLES.map(rowsFor));
  return groups.flat();
}
async function findById(sessionId) {
  for (const table of TABLES) {
    const { data, error } = await getClient().from(table).select('*').eq('session_id', sessionId).maybeSingle();
    throwIfError(error, 'lookup');
    if (data) return { table, row: data };
  }
  return null;
}
async function createSession(data, ttlMs) {
  const client = getClient();
  const now = new Date();
  const lifetime = Number(ttlMs) || (isAdminLoginMethod(data.login_method) ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS);
  const row = {
    session_id: crypto.randomUUID(),
    user_id: String(data.user_id || ''),
    email: String(data.email || '').trim().toLowerCase() || null,
    device: data.device || null,
    os: data.os || null,
    browser: data.browser || null,
    country: data.country || null,
    state: data.state || null,
    city: data.city || null,
    ip_address: data.ip_address || null,
    login_method: data.login_method || 'Email',
    user_agent: data.user_agent || null,
    session_token: String(data.session_token || ''),
    login_time: now.toISOString(),
    last_active: now.toISOString(),
    expires_at: new Date(now.getTime() + lifetime).toISOString(),
    revoked_at: null,
    status: 'Active',
    logged_out_at: null,
  };
  if (!/^[a-f0-9]{64}$/i.test(row.session_token)) throw new Error('Invalid session token hash');
  const targetTable = Number(ttlMs) > 0
    ? (Number(ttlMs) <= ADMIN_SESSION_TTL_MS ? ADMIN_TABLE : USER_TABLE)
    : tableFor(row.login_method);
  const { data: inserted, error } = await client.from(targetTable).insert(row).select('*').single();
  throwIfError(error, 'create');
  return inserted;
}
async function findTokenWithTable(tokenHash) {
  if (!/^[a-f0-9]{64}$/i.test(String(tokenHash || ''))) return null;
  const client = getClient();
  for (const table of TABLES) {
    const { data, error } = await client.from(table).select('*').eq('session_token', tokenHash).maybeSingle();
    throwIfError(error, 'token lookup');
    if (data) return { table, row: data };
  }
  return null;
}
async function findSessionByToken(tokenHash) {
  const found = await findTokenWithTable(tokenHash);
  return found ? found.row : null;
}
async function findSessionById(sessionId) {
  const found = await findById(sessionId);
  return found ? clean(found.row) : null;
}
async function updateFound(found, patch) {
  if (!found) return false;
  const { data, error } = await getClient().from(found.table)
    .update(patch).eq('session_id', found.row.session_id).select('session_id').maybeSingle();
  throwIfError(error, 'update');
  if (!data) return false;
  if (found.row.session_token) sessionCache.remove(found.row.session_token);
  sessionCache.invalidateBySessionId(found.row.session_id);
  return true;
}
async function endSessionByToken(tokenHash, reason = 'Logged out') {
  const found = await findTokenWithTable(tokenHash);
  if (!found || found.row.status !== 'Active') { sessionCache.remove(tokenHash); return false; }
  const now = new Date().toISOString();
  return updateFound(found, {
    status: reason, last_active: now, revoked_at: now,
    ...(reason === 'Logged out' ? { logged_out_at: now } : {}),
  });
}
async function updateSessionActivity(sessionId) {
  const found = await findById(sessionId);
  if (!found || found.row.status !== 'Active') return false;
  const { error } = await getClient().from(found.table)
    .update({ last_active: new Date().toISOString() })
    .eq('session_id', sessionId).eq('status', 'Active');
  throwIfError(error, 'activity update');
  return true;
}
async function updateSessionFields(sessionId, patch) {
  const found = await findById(sessionId);
  return updateFound(found, patch);
}
async function endSession(sessionId, reason = 'Logged out') {
  const found = await findById(sessionId);
  if (!found) return false;
  const now = new Date().toISOString();
  return updateFound(found, {
    status: reason, last_active: now, revoked_at: now,
    ...(reason === 'Logged out' ? { logged_out_at: now } : {}),
  });
}
async function endAllUserSessions(userId, options = {}) {
  const client = getClient();
  const except = String(options.exceptSessionId || '');
  let changed = 0;
  for (const table of TABLES) {
    let query = client.from(table).update({
      status: 'Logged out',
      logged_out_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
      revoked_at: new Date().toISOString(),
    }).eq('user_id', String(userId)).eq('status', 'Active').select('session_id,session_token');
    if (except) query = query.neq('session_id', except);
    const { data, error } = await query;
    throwIfError(error, 'bulk logout');
    for (const row of data || []) {
      if (row.session_token) sessionCache.remove(row.session_token);
      changed++;
    }
  }
  sessionCache.invalidateByUserId(userId);
  return { count: changed };
}
async function expireOutdatedSessions() {
  const now = new Date().toISOString();
  let count = 0;
  const client = getClient();
  for (const table of TABLES) {
    const { data, error } = await client.from(table)
      .update({ status: 'Expired', last_active: now, revoked_at: now })
      .eq('status', 'Active').lte('expires_at', now)
      .select('session_token');
    throwIfError(error, 'expiry sweep');
    for (const row of data || []) {
      if (row.session_token) sessionCache.remove(row.session_token);
      count++;
    }
  }
  sessionCache.clear();
  return { count };
}
async function deleteExpiredSessions() {
  const cutoffMs = Date.now() - SESSION_RETENTION_MS;
  let count = 0;
  const client = getClient();
  for (const table of TABLES) {
    const { data: ended, error: readError } = await client.from(table)
      .select('session_id,expires_at,login_time')
      .in('status', ['Expired', 'Logged out']);
    throwIfError(readError, 'retention lookup');
    const ids = (ended || []).filter((row) => {
      const endedAt = row.expires_at || row.login_time;
      return endedAt && new Date(endedAt).getTime() < cutoffMs;
    }).map((row) => row.session_id);
    if (!ids.length) continue;
    const { data, error } = await client.from(table).delete()
      .in('session_id', ids).select('session_id');
    throwIfError(error, 'retention cleanup');
    count += (data || []).length;
  }
  return { count };
}
async function getAllSessions() {
  return (await allRows()).map(clean)
    .sort((a, b) => new Date(b.login_time || 0) - new Date(a.login_time || 0));
}
async function getUserSessionsList() {
  return (await rowsFor(USER_TABLE)).map(clean)
    .sort((a, b) => new Date(b.login_time || 0) - new Date(a.login_time || 0));
}
async function getAdminSessions() {
  return (await rowsFor(ADMIN_TABLE)).map(clean)
    .sort((a, b) => new Date(b.login_time || 0) - new Date(a.login_time || 0));
}
async function getUserSessions(userId) {
  const { data, error } = await getClient().from(USER_TABLE).select('*')
    .eq('user_id', String(userId)).order('login_time', { ascending: false });
  throwIfError(error, 'user session read');
  return (data || []).map(clean);
}
async function getAccountSessionHistory(email, limit = 200) {
  try {
    const key = String(email || '').trim().toLowerCase();
    if (!key) return [];
    return (await allRows()).filter((r) => String(r.email || '').trim().toLowerCase() === key)
      .sort((a, b) => new Date(b.login_time || 0) - new Date(a.login_time || 0))
      .slice(0, Math.max(1, Number(limit) || 200)).map(clean);
  } catch (err) {
    console.warn('[sessions] Supabase history unavailable:', err.message);
    return null;
  }
}
async function countActiveSessions() {
  const now = new Date().toISOString();
  let count = 0;
  const client = getClient();
  for (const table of TABLES) {
    const { count: tableCount, error } = await client.from(table)
      .select('session_id', { count: 'exact', head: true })
      .eq('status', 'Active').gt('expires_at', now);
    throwIfError(error, 'active session count');
    count += tableCount || 0;
  }
  return count;
}

module.exports = {
  SESSION_TTL_MS, ADMIN_SESSION_TTL_MS, SESSION_RETENTION_MS,
  createSession, findSessionByToken, findSessionById, endSessionByToken,
  updateSessionActivity, updateSessionFields, endSession, endAllUserSessions,
  expireOutdatedSessions, deleteExpiredSessions, getAllSessions,
  getUserSessionsList, getAdminSessions, getUserSessions, getAccountSessionHistory, countActiveSessions,
};
