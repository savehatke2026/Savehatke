// ============================================
// SaveHatke — Gmail Storage (Supabase-backed) — DEPRECATED / UNUSED
// ============================================
// The Support Mailbox no longer uses a database at all. It is a single shared
// mailbox, so the only thing that must persist is ONE OAuth refresh token,
// which now lives in GMAIL_REFRESH_TOKEN (or the local encrypted token file).
// See services/gmailTokenStore.js.
//
// Nothing imports this file anymore. It is kept only as a reference for the
// old per-admin gmail_connections / gmail_audit_logs schema, and the matching
// Mongoose models (models/GmailConnection.js, models/GmailAuditLog.js) are
// likewise unused. All three can be deleted.

const { getClient } = require('./supabase');

const TABLES = {
  connections: 'gmail_connections',
  audit: 'gmail_audit_logs',
};

function isReady() {
  return Boolean(getClient());
}

function toConnection(row) {
  if (!row) return null;
  return {
    admin_user_id: row.admin_user_id,
    admin_email: row.admin_email,
    gmail_email: row.gmail_email,
    encrypted_refresh_token: row.encrypted_refresh_token,
    granted_scopes: row.granted_scopes || '',
    access_token_expires_at: row.access_token_expires_at,
    history_id: row.history_id || '',
    watch_expiration: row.watch_expiration,
    watch_push_token: row.watch_push_token || '',
    unread_count: typeof row.unread_count === 'number' ? row.unread_count : 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getConnection(adminId) {
  const client = getClient();
  if (!client) return null;
  const id = String(adminId || '');
  if (!id) return null;
  try {
    const { data, error } = await client
      .from(TABLES.connections)
      .select('*')
      .eq('admin_user_id', id)
      .limit(1);
    if (error) {
      console.warn('Gmail getConnection warning:', error.message);
      return null;
    }
    return data && data.length ? toConnection(data[0]) : null;
  } catch (e) {
    console.warn('Gmail getConnection exception:', e.message);
    return null;
  }
}

async function upsertConnection(payload) {
  const client = getClient();
  if (!client) throw new Error('Supabase not configured');
  const row = {
    admin_user_id: String(payload.admin_user_id || ''),
    admin_email: String(payload.admin_email || ''),
    gmail_email: String(payload.gmail_email || ''),
    encrypted_refresh_token: String(payload.encrypted_refresh_token || ''),
    granted_scopes: String(payload.granted_scopes || ''),
    access_token_expires_at: payload.access_token_expires_at || null,
    history_id: payload.history_id || null,
    watch_expiration: payload.watch_expiration || null,
    watch_push_token: payload.watch_push_token || '',
    unread_count: typeof payload.unread_count === 'number' ? payload.unread_count : 0,
    updated_at: new Date().toISOString(),
  };

  // Supabase upsert via onConflict on the unique admin_user_id column.
  const { data, error } = await client
    .from(TABLES.connections)
    .upsert(row, { onConflict: 'admin_user_id' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return toConnection(data);
}

async function deleteConnection(adminId) {
  const client = getClient();
  if (!client) return;
  const id = String(adminId || '');
  if (!id) return;
  try {
    const { error } = await client
      .from(TABLES.connections)
      .delete()
      .eq('admin_user_id', id);
    if (error) console.warn('Gmail deleteConnection warning:', error.message);
  } catch (e) {
    console.warn('Gmail deleteConnection exception:', e.message);
  }
}

async function updateConnectionMeta(adminId, patch) {
  const client = getClient();
  if (!client) return null;
  const id = String(adminId || '');
  if (!id) return null;
  try {
    const safe = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === undefined) continue;
      safe[k] = v;
    }
    safe.updated_at = new Date().toISOString();
    const { data, error } = await client
      .from(TABLES.connections)
      .update(safe)
      .eq('admin_user_id', id)
      .select()
      .single();
    if (error) {
      console.warn('Gmail updateConnectionMeta warning:', error.message);
      return null;
    }
    return toConnection(data);
  } catch (e) {
    console.warn('Gmail updateConnectionMeta exception:', e.message);
    return null;
  }
}

async function writeAuditLog({ admin_user_id, admin_email, action, target_id, details, ip }) {
  const client = getClient();
  if (!client) return; // best-effort — never block the main action
  try {
    const { error } = await client.from(TABLES.audit).insert({
      admin_user_id: String(admin_user_id || ''),
      admin_email: String(admin_email || ''),
      action: String(action || '').slice(0, 100),
      target_id: String(target_id || '').slice(0, 200),
      details: String(details || '').slice(0, 500),
      ip: String(ip || '').slice(0, 80),
    });
    if (error) console.warn('Gmail audit log warning:', error.message);
  } catch (e) {
    console.warn('Gmail audit log exception:', e.message);
  }
}

module.exports = {
  isReady,
  getConnection,
  upsertConnection,
  deleteConnection,
  updateConnectionMeta,
  writeAuditLog,
  TABLES,
};
