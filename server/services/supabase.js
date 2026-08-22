// ============================================
// SaveHatke — Supabase Database Service
// ============================================
// Handles user CRUD operations via Supabase (PostgreSQL)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

let supabase = null;

function getClient() {
  if (!supabase && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    console.log('✅ Supabase client initialized.');
  }
  return supabase;
}

// ── User Operations ─────────────────────────────────────────────────────

/**
 * Create a new user in Supabase.
 */
async function createUser({ name, email, password_hash, username }) {
  const client = getClient();
  if (!client) throw new Error('Supabase not configured');

  const { data, error } = await client
    .from('users')
    .insert({
      name,
      email: email.toLowerCase(),
      password_hash,
      username: username || null,
      status: 'active',
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error('A user with this email already exists.');
    }
    throw new Error(error.message);
  }
  return data;
}

/**
 * Find a user by email.
 */
async function findUserByEmail(email) {
  const client = getClient();
  if (!client) return null;

  const { data, error } = await client
    .from('users')
    .select('*')
    .eq('email', email.toLowerCase())
    .single();

  if (error) return null;
  return data;
}

/**
 * Find a user by user_id.
 */
async function findUserById(userId) {
  const client = getClient();
  if (!client) return null;

  const { data, error } = await client
    .from('users')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error) return null;
  return data;
}

/**
 * Update last_login_at timestamp.
 */
async function updateLoginTimestamp(userId) {
  const client = getClient();
  if (!client) return;

  await client
    .from('users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('user_id', userId);
}

/**
 * Update last_logout_at timestamp.
 */
async function updateLogoutTimestamp(userId) {
  const client = getClient();
  if (!client) return;

  await client
    .from('users')
    .update({ last_logout_at: new Date().toISOString() })
    .eq('user_id', userId);
}

/**
 * Update user profile fields.
 */
async function updateUser(userId, updates) {
  const client = getClient();
  if (!client) return null;

  const { data, error } = await client
    .from('users')
    .update(updates)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/**
 * Get all users (for admin panel).
 */
async function getAllUsers() {
  const client = getClient();
  if (!client) return [];

  const { data, error } = await client
    .from('users')
    .select('user_id, name, username, email, status, created_at, last_login_at, last_logout_at')
    .order('created_at', { ascending: false });

  if (error) return [];
  return data;
}

/**
 * Count users.
 */
async function countUsers() {
  const client = getClient();
  if (!client) return 0;

  const { count, error } = await client
    .from('users')
    .select('*', { count: 'exact', head: true });

  if (error) return 0;
  return count || 0;
}

/**
 * Check if Supabase is configured and reachable.
 */
function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
}

// ── Coupon Mapping Helpers ──────────────────────────────────────────────
function toSupabaseCoupon(c) {
  return {
    id: c.id,
    code: c.code ? c.code.toUpperCase().trim() : '',
    title: c.title || '',
    type: c.type || 'Public',
    category: c.category || 'General',
    brand: c.brand || '',
    description: c.description || '',
    discount: c.discount || '',
    original_value: String(c.originalValue || '0'),
    selling_price: String(c.sellingPrice || '15'),
    min_order_value: String(c.minOrderValue || ''),
    valid_from: c.validFrom || null,
    expiry_date: c.expiryDate || null,
    affiliate_link: c.affiliateLink || '',
    terms: c.terms || '',
    is_featured: Boolean(c.isFeatured === true || c.isFeatured === 'true'),
    is_exclusive: Boolean(c.isExclusive === true || c.isExclusive === 'true'),
    is_verified: Boolean(c.isVerified !== false && c.isVerified !== 'false'),
    seller_email: c.sellerEmail || '',
    status: c.status ? c.status.toLowerCase() : 'available',
    source: c.source ? c.source.toLowerCase() : 'admin',
    added_at: c.addedAt || new Date().toISOString(),
    sold_at: c.soldAt || null,
    buyer_email: c.buyerEmail || '',
    // New review/notification fields — only included when provided so writes
    // tolerate databases where the migration hasn't been applied yet
    ...(c.proofUrl !== undefined ? { proof_url: c.proofUrl || '' } : {}),
    ...(c.adminNotes !== undefined ? { admin_notes: c.adminNotes || '' } : {}),
    ...(c.verifiedAt !== undefined ? { verified_at: c.verifiedAt || null } : {}),
    ...(c.sellerUserId !== undefined ? { seller_user_id: c.sellerUserId || '' } : {}),
    ...(c.whatsappStatus !== undefined ? { whatsapp_status: c.whatsappStatus || '' } : {}),
    ...(c.whatsappSid !== undefined ? { whatsapp_sid: c.whatsappSid || '' } : {}),
    ...(c.whatsappLastAttempt !== undefined ? { whatsapp_last_attempt: c.whatsappLastAttempt || null } : {}),
    ...(c.whatsappError !== undefined ? { whatsapp_error: c.whatsappError || '' } : {}),
  };
}

function fromSupabaseCoupon(r) {
  if (!r) return null;
  return {
    id: r.id,
    code: r.code,
    title: r.title || '',
    type: r.type || 'Public',
    category: r.category || 'General',
    brand: r.brand || '',
    description: r.description || '',
    discount: r.discount || '',
    originalValue: r.original_value || '0',
    sellingPrice: r.selling_price || '15',
    minOrderValue: r.min_order_value || '',
    validFrom: r.valid_from || '',
    expiryDate: r.expiry_date || '',
    affiliateLink: r.affiliate_link || '',
    terms: r.terms || '',
    isFeatured: String(Boolean(r.is_featured)),
    isExclusive: String(Boolean(r.is_exclusive)),
    isVerified: String(Boolean(r.is_verified)),
    sellerEmail: r.seller_email || '',
    status: r.status || 'available',
    source: r.source || 'admin',
    addedAt: r.added_at || new Date().toISOString(),
    soldAt: r.sold_at || '',
    buyerEmail: r.buyer_email || '',
    proofUrl: r.proof_url || '',
    adminNotes: r.admin_notes || '',
    verifiedAt: r.verified_at || '',
    sellerUserId: r.seller_user_id || '',
    whatsappStatus: r.whatsapp_status || '',
    whatsappSid: r.whatsapp_sid || '',
    whatsappLastAttempt: r.whatsapp_last_attempt || '',
    whatsappError: r.whatsapp_error || '',
  };
}

// ── Coupon Operations ───────────────────────────────────────────────────

/**
 * Create a new coupon in Supabase.
 */
async function createCoupon(couponData) {
  const client = getClient();
  if (!client) throw new Error('Supabase not configured');

  const row = toSupabaseCoupon(couponData);
  const { data, error } = await client
    .from('coupons')
    .insert(row)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error('This coupon code already exists.');
    }
    throw new Error(error.message);
  }
  return fromSupabaseCoupon(data);
}

/**
 * Get coupons from Supabase with optional filters.
 */
async function getCoupons(filters = {}) {
  const client = getClient();
  if (!client) return [];

  let query = client.from('coupons').select('*');

  if (filters.status) {
    query = query.eq('status', filters.status.toLowerCase());
  }
  if (filters.source) {
    query = query.eq('source', filters.source.toLowerCase());
  }
  if (filters.category) {
    query = query.ilike('category', filters.category);
  }
  if (filters.sellerEmail) {
    query = query.eq('seller_email', filters.sellerEmail);
  }
  if (filters.buyerEmail) {
    query = query.eq('buyer_email', filters.buyerEmail);
  }

  query = query.order('added_at', { ascending: false });

  const { data, error } = await query;
  if (error) {
    console.warn('Supabase getCoupons warning:', error.message);
    return [];
  }
  return (data || []).map(fromSupabaseCoupon);
}

/**
 * Find coupon by ID.
 */
async function findCouponById(id) {
  const client = getClient();
  if (!client) return null;

  const { data, error } = await client
    .from('coupons')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) return null;
  return fromSupabaseCoupon(data);
}

/**
 * Find coupon by Code.
 */
async function findCouponByCode(code) {
  const client = getClient();
  if (!client) return null;

  const cleanCode = code ? code.toUpperCase().trim() : '';
  const { data, error } = await client
    .from('coupons')
    .select('*')
    .eq('code', cleanCode)
    .single();

  if (error || !data) return null;
  return fromSupabaseCoupon(data);
}

/**
 * Update a coupon by ID.
 */
async function updateCoupon(id, updates) {
  const client = getClient();
  if (!client) throw new Error('Supabase not configured');

  const patch = {};
  if (updates.code) patch.code = updates.code.toUpperCase().trim();
  if (updates.brand) patch.brand = updates.brand.trim();
  if (updates.category) patch.category = updates.category.trim();
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.originalValue !== undefined) patch.original_value = String(updates.originalValue);
  if (updates.sellingPrice !== undefined) patch.selling_price = String(updates.sellingPrice);
  if (updates.status !== undefined) patch.status = updates.status.toLowerCase();
  if (updates.soldAt !== undefined) patch.sold_at = updates.soldAt;
  if (updates.buyerEmail !== undefined) patch.buyer_email = updates.buyerEmail;

  const { data, error } = await client
    .from('coupons')
    .update(patch)
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return fromSupabaseCoupon(data);
}

/**
 * Delete a coupon by ID.
 */
async function deleteCoupon(id) {
  const client = getClient();
  if (!client) throw new Error('Supabase not configured');

  const { error } = await client
    .from('coupons')
    .delete()
    .eq('id', id);

  if (error) throw new Error(error.message);
  return true;
}

/**
 * Count coupons matching status or filters.
 */
async function countCoupons(filters = {}) {
  const client = getClient();
  if (!client) return 0;

  let query = client.from('coupons').select('*', { count: 'exact', head: true });
  if (filters.status) {
    query = query.eq('status', filters.status.toLowerCase());
  }

  const { count, error } = await query;
  if (error) return 0;
  return count || 0;
}

// ── Session Tracking Operations ─────────────────────────────────────────
// Sessions are the server-side source of truth for authentication.
// Every login creates a row with a 48-hour expires_at; the raw session
// token lives only in the JWT `sid` claim + HttpOnly cookie — the database
// stores a SHA-256 hash so a database leak cannot forge valid sessions.

// 48 hours, in milliseconds — the maximum lifetime of any login session.
const SESSION_TTL_MS = 48 * 60 * 60 * 1000;

// Matches PostgREST errors raised when the sessions table hasn't been
// upgraded yet (missing session_token / revoked_at / user_agent columns).
function isMissingColumnError(err) {
  const msg = String((err && err.message) || err || '');
  return /session_token|revoked_at|user_agent|42703|could not find the column/i.test(msg);
}

/**
 * Ensure the sessions table exists in Supabase.
 * Called once on startup; silently succeeds if already present.
 */
async function ensureSessionsTable() {
  const client = getClient();
  if (!client) return;

  try {
    // Try a lightweight probe — if it succeeds, the table (and the
    // session_token column added by the 48h-session upgrade) exists.
    await client.from('sessions').select('session_id, session_token').limit(1);
  } catch (err) {
    // Table likely doesn't exist — try to create it via rpc or just log
    console.warn('Sessions table probe failed (may need manual creation):', err.message);
    console.warn('Run server/setup_sessions_table.sql in Supabase SQL Editor.');
  }
}

/**
 * Create a new session record when a user logs in.
 * The session expires exactly 48 hours from the server-side creation time;
 * nothing the client sends can extend that window.
 * @param {object} sessionData - includes session_token (SHA-256 hash) and user_agent
 * @returns {object|null} The created session row
 */
async function createSession(sessionData) {
  const client = getClient();
  if (!client) return null;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS); // exactly 48 hours from login

  const row = {
    user_id: sessionData.user_id || '',
    email: sessionData.email || '',
    device: sessionData.device || '',
    os: sessionData.os || '',
    browser: sessionData.browser || '',
    country: sessionData.country || '',
    state: sessionData.state || '',
    city: sessionData.city || '',
    ip_address: sessionData.ip_address || '',
    login_method: sessionData.login_method || 'Email',
    user_agent: sessionData.user_agent || '',
    session_token: sessionData.session_token || '',
    login_time: now.toISOString(),
    last_active: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    status: 'Active',
  };

  async function insert(payload) {
    const { data, error } = await client
      .from('sessions')
      .insert(payload)
      .select()
      .single();
    if (error) return { error };
    return { data };
  }

  try {
    let result = await insert(row);

    if (result.error) {
      // Table created before a column existed — retry without the missing ones
      // so logins still work before/without the migration. A session row
      // without session_token cannot be validated server-side; the caller
      // detects this and falls back to a legacy (non-session) JWT.
      let retryRow = null;
      if (isMissingColumnError(result.error)) {
        const { session_token: _t, user_agent: _u, revoked_at: _r, ...rest } = row;
        retryRow = rest;
      } else if (/email/i.test(result.error.message)) {
        const { email: _skip, ...rest } = row;
        retryRow = rest;
      }
      if (retryRow) {
        result = await insert(retryRow);
      }
    }

    if (result.error) {
      console.warn('Create session warning:', result.error.message);
      return null;
    }
    return result.data;
  } catch (err) {
    console.warn('Create session exception:', err.message);
    return null;
  }
}

/**
 * Look up a session by the SHA-256 hash of its raw session token.
 * Used by the auth middleware on every authenticated request.
 * @returns {Promise<object|null|{unavailable:true}>}
 *   - row object when found
 *   - null when no session matches
 *   - { unavailable: true } when the session_token column is missing
 *     (pre-migration database) so callers can fail open instead of
 *     locking every user out.
 */
async function findSessionByToken(tokenHash) {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('sessions')
      .select('session_id, user_id, email, status, expires_at, login_time, last_active')
      .eq('session_token', tokenHash)
      .limit(1);

    if (error) {
      if (isMissingColumnError(error)) return { unavailable: true };
      console.warn('Find session by token warning:', error.message);
      return null;
    }
    return (data && data.length) ? data[0] : null;
  } catch (err) {
    console.warn('Find session by token exception:', err.message);
    return null;
  }
}

/**
 * Find a session row by session_id (ownership checks on the revoke endpoint).
 */
async function findSessionById(sessionId) {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('sessions')
      .select('session_id, user_id, status')
      .eq('session_id', sessionId)
      .limit(1);
    if (error) return null;
    return (data && data.length) ? data[0] : null;
  } catch (err) {
    return null;
  }
}

/**
 * End the session matching a raw session token (logout of the current device).
 * Only flips rows that are still Active — idempotent.
 */
async function endSessionByToken(tokenHash, reason = 'Logged out') {
  const client = getClient();
  if (!client) return;

  const now = new Date().toISOString();
  const base = { status: reason, last_active: now };
  const updates = reason === 'Logged out' ? { ...base, logged_out_at: now } : base;

  try {
    let { error } = await client
      .from('sessions')
      .update({ ...updates, revoked_at: now })
      .eq('session_token', tokenHash)
      .eq('status', 'Active');
    if (error && isMissingColumnError(error)) {
      ({ error } = await client
        .from('sessions')
        .update(updates)
        .eq('session_token', tokenHash)
        .eq('status', 'Active'));
    }
    if (error) console.warn('End session by token warning:', error.message);
  } catch (err) {
    console.warn('End session by token exception:', err.message);
  }
}

/**
 * Update last_active timestamp for a session (heartbeat).
 */
async function updateSessionActivity(sessionId) {
  const client = getClient();
  if (!client) return;

  try {
    await client
      .from('sessions')
      .update({ last_active: new Date().toISOString() })
      .eq('session_id', sessionId);
  } catch (err) {
    console.warn('Update session activity warning:', err.message);
  }
}

/**
 * End a session (logout or expiry) by session_id.
 * @param {string} sessionId
 * @param {string} reason - 'Logged out' or 'Expired'
 */
async function endSession(sessionId, reason = 'Logged out') {
  const client = getClient();
  if (!client) return;

  const now = new Date().toISOString();
  const updates = {
    status: reason,
    last_active: now,
  };
  if (reason === 'Logged out') {
    updates.logged_out_at = now;
  }

  try {
    let { error } = await client
      .from('sessions')
      .update({ ...updates, revoked_at: now })
      .eq('session_id', sessionId);
    if (error && isMissingColumnError(error)) {
      ({ error } = await client
        .from('sessions')
        .update(updates)
        .eq('session_id', sessionId));
    }
    if (error) console.warn('End session warning:', error.message);
  } catch (err) {
    console.warn('End session exception:', err.message);
  }
}

/**
 * End all active sessions for a user ("log out all devices").
 */
async function endAllUserSessions(userId) {
  const client = getClient();
  if (!client) return;

  const now = new Date().toISOString();
  const updates = {
    status: 'Logged out',
    logged_out_at: now,
    last_active: now,
  };

  try {
    let { error } = await client
      .from('sessions')
      .update({ ...updates, revoked_at: now })
      .eq('user_id', userId)
      .eq('status', 'Active');
    if (error && isMissingColumnError(error)) {
      ({ error } = await client
        .from('sessions')
        .update(updates)
        .eq('user_id', userId)
        .eq('status', 'Active'));
    }
    if (error) console.warn('End all user sessions warning:', error.message);
  } catch (err) {
    console.warn('End all user sessions exception:', err.message);
  }
}

/**
 * 48-hour expiry sweep — flips every session whose expires_at has passed
 * but is still marked Active: status → 'Expired', revoked_at → now.
 * Runs from the 10-minute scheduled job (local server), the lazy sweep
 * (serverless), and the /api/auth/session-cleanup cron endpoint.
 * @returns {Promise<{count:number}>}
 */
async function expireOutdatedSessions() {
  const client = getClient();
  if (!client) return { count: 0 };

  const now = new Date().toISOString();
  const updates = { status: 'Expired', last_active: now };

  try {
    let req = client
      .from('sessions')
      .update({ ...updates, revoked_at: now })
      .eq('status', 'Active')
      .lte('expires_at', now)
      .select('session_id');
    let { data, error } = await req;
    if (error && isMissingColumnError(error)) {
      ({ data, error } = await client
        .from('sessions')
        .update(updates)
        .eq('status', 'Active')
        .lte('expires_at', now)
        .select('session_id'));
    }
    if (error) {
      console.warn('Expire outdated sessions warning:', error.message);
      return { count: 0 };
    }
    return { count: (data || []).length };
  } catch (err) {
    console.warn('Expire outdated sessions exception:', err.message);
    return { count: 0 };
  }
}

/**
 * Get all sessions (for admin panel).
 * The session_token hash is never exposed — not even to admins.
 */
async function getAllSessions() {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('sessions')
      .select('*')
      .order('login_time', { ascending: false })
      .limit(200);

    if (error) return [];
    return (data || []).map((row) => {
      delete row.session_token;
      return row;
    });
  } catch (err) {
    return [];
  }
}

/**
 * Get sessions for a specific user (device/session page).
 * The session_token hash is stripped — only a boolean is_current marker
 * is added by the caller comparing hashes server-side.
 */
async function getUserSessions(userId) {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .order('login_time', { ascending: false })
      .limit(50);

    if (error) return [];
    return (data || []).map((row) => {
      delete row.session_token;
      return row;
    });
  } catch (err) {
    return [];
  }
}

/**
 * Count active sessions.
 */
async function countActiveSessions() {
  const client = getClient();
  if (!client) return 0;

  try {
    const { count, error } = await client
      .from('sessions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'Active');

    if (error) return 0;
    return count || 0;
  } catch (err) {
    return 0;
  }
}

module.exports = {
  getClient,
  isConfigured,
  createUser,
  findUserByEmail,
  findUserById,
  updateLoginTimestamp,
  updateLogoutTimestamp,
  updateUser,
  getAllUsers,
  countUsers,
  // Coupon methods
  createCoupon,
  getCoupons,
  findCouponById,
  findCouponByCode,
  updateCoupon,
  deleteCoupon,
  countCoupons,
  // Session methods
  ensureSessionsTable,
  createSession,
  findSessionByToken,
  findSessionById,
  endSessionByToken,
  updateSessionActivity,
  endSession,
  endAllUserSessions,
  expireOutdatedSessions,
  getAllSessions,
  getUserSessions,
  countActiveSessions,
  SESSION_TTL_MS,
};

