// ============================================
// SaveHatke — Google Sheets Session Store
// ============================================
// Google Sheets is the sole source of truth for user/admin sessions.
// Only SHA-256 token hashes are stored; raw tokens stay in HttpOnly cookies.
// Every authorization lookup is a strict, fresh Sheets read (never memory fallback).

const crypto = require('crypto');
const db = require('./googleSheets');
const sessionCache = require('./sessionCache');

const SESSION_TTL_MS = 48 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const TABLES = [db.SHEETS.USER_SESSIONS, db.SHEETS.ADMIN_SESSIONS];

function isAdminLoginMethod(method) {
  return /^(google\s+)?admin$/i.test(String(method || '').trim());
}
function tableFor(method) {
  return isAdminLoginMethod(method) ? db.SHEETS.ADMIN_SESSIONS : db.SHEETS.USER_SESSIONS;
}
function clean(row) {
  const out = { ...row };
  delete out.session_token;
  return out;
}
async function rowsFor(table) {
  return db.getRows(table, { strict: true });
}
async function allRows() {
  const groups = await Promise.all(TABLES.map(rowsFor));
  return groups.flat();
}
async function findById(sessionId) {
  for (const table of TABLES) {
    const rows = await rowsFor(table);
    const row = rows.find((r) => String(r.session_id) === String(sessionId));
    if (row) return { table, row };
  }
  return null;
}
async function createSession(data, ttlMs) {
  if (!db.isSheetsConnected()) throw new Error('Google Sheets session storage is unavailable');
  const now = new Date();
  const lifetime = Number(ttlMs) || (isAdminLoginMethod(data.login_method) ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS);
  const row = {
    session_id: crypto.randomUUID(),
    user_id: String(data.user_id || ''),
    email: String(data.email || '').trim().toLowerCase(),
    device: data.device || '', os: data.os || '', browser: data.browser || '',
    country: data.country || '', state: data.state || '', city: data.city || '',
    ip_address: data.ip_address || '', login_method: data.login_method || 'Email',
    user_agent: data.user_agent || '', session_token: String(data.session_token || ''),
    login_time: now.toISOString(), last_active: now.toISOString(),
    expires_at: new Date(now.getTime() + lifetime).toISOString(),
    revoked_at: '', status: 'Active', logged_out_at: '',
  };
  if (!/^[a-f0-9]{64}$/i.test(row.session_token)) throw new Error('Invalid session token hash');
  await db.appendRow(tableFor(row.login_method), row, { strict: true });
  return row;
}
async function findSessionByToken(tokenHash) {
  if (!db.isSheetsConnected()) throw new Error('Google Sheets session storage is unavailable');
  for (const table of TABLES) {
    const rows = await rowsFor(table);
    const row = rows.find((r) => String(r.session_token || '') === String(tokenHash));
    if (row) return row;
  }
  return null;
}
async function findSessionById(sessionId) {
  const found = await findById(sessionId);
  return found ? clean(found.row) : null;
}
async function updateFound(found, patch) {
  if (!found) return false;
  await db.updateRow(found.table, 'session_id', found.row.session_id, patch, { strict: true });
  if (found.row.session_token) sessionCache.remove(found.row.session_token);
  sessionCache.invalidateBySessionId(found.row.session_id);
  return true;
}
async function endSessionByToken(tokenHash, reason = 'Logged out') {
  const row = await findSessionByToken(tokenHash);
  if (!row || row.status !== 'Active') { sessionCache.remove(tokenHash); return false; }
  const now = new Date().toISOString();
  return updateFound({ table: tableFor(row.login_method), row }, {
    status: reason, last_active: now, revoked_at: now,
    ...(reason === 'Logged out' ? { logged_out_at: now } : {}),
  });
}
async function updateSessionActivity(sessionId) {
  const found = await findById(sessionId);
  if (!found || found.row.status !== 'Active') return false;
  await db.updateRow(found.table, 'session_id', sessionId, { last_active: new Date().toISOString() }, { strict: true });
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
  const except = String(options.exceptSessionId || '');
  let changed = 0;
  for (const table of TABLES) {
    const rows = await rowsFor(table);
    for (const row of rows) {
      if (String(row.user_id) !== String(userId) || row.status !== 'Active' || (except && String(row.session_id) === except)) continue;
      const now = new Date().toISOString();
      await db.updateRow(table, 'session_id', row.session_id, {
        status: 'Logged out', logged_out_at: now, last_active: now, revoked_at: now,
      }, { strict: true });
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
  for (const table of TABLES) {
    const rows = await rowsFor(table);
    for (const row of rows) {
      if (row.status !== 'Active' || !row.expires_at || new Date(row.expires_at).getTime() > Date.now()) continue;
      await db.updateRow(table, 'session_id', row.session_id, {
        status: 'Expired', last_active: now, revoked_at: now,
      }, { strict: true });
      if (row.session_token) sessionCache.remove(row.session_token);
      count++;
    }
  }
  sessionCache.clear();
  return { count };
}
async function deleteExpiredSessions() {
  const cutoff = Date.now() - SESSION_RETENTION_MS;
  let count = 0;
  for (const table of TABLES) {
    count += await db.deleteRowsWhere(table, (row) =>
      ['Expired', 'Logged out'].includes(String(row.status)) &&
      new Date(row.expires_at || row.login_time || 0).getTime() < cutoff
    );
  }
  return { count };
}
async function getAllSessions() {
  return (await allRows()).map(clean).sort((a,b) => new Date(b.login_time || 0) - new Date(a.login_time || 0));
}
async function getAdminSessions() {
  return (await rowsFor(db.SHEETS.ADMIN_SESSIONS)).map(clean).sort((a,b) => new Date(b.login_time || 0) - new Date(a.login_time || 0));
}
async function getUserSessions(userId) {
  const rows = await rowsFor(db.SHEETS.USER_SESSIONS);
  return rows.filter((r) => String(r.user_id) === String(userId)).map(clean)
    .sort((a,b) => new Date(b.login_time || 0) - new Date(a.login_time || 0));
}
async function getAccountSessionHistory(email, limit = 200) {
  try {
    const key = String(email || '').trim().toLowerCase();
    if (!key) return [];
    return (await allRows()).filter((r) => String(r.email || '').trim().toLowerCase() === key)
      .sort((a,b) => new Date(b.login_time || 0) - new Date(a.login_time || 0))
      .slice(0, Math.max(1, Number(limit) || 200));
  } catch (err) {
    console.warn('[sessions] Google Sheets history unavailable:', err.message);
    return null;
  }
}
async function countActiveSessions() {
  return (await allRows()).filter((r) => r.status === 'Active' && new Date(r.expires_at).getTime() > Date.now()).length;
}

module.exports = {
  SESSION_TTL_MS, ADMIN_SESSION_TTL_MS, SESSION_RETENTION_MS,
  createSession, findSessionByToken, findSessionById, endSessionByToken,
  updateSessionActivity, updateSessionFields, endSession, endAllUserSessions,
  expireOutdatedSessions, deleteExpiredSessions, getAllSessions,
  getAdminSessions, getUserSessions, getAccountSessionHistory, countActiveSessions,
};
