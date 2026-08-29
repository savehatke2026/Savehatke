// ============================================
// SaveHatke — Supabase Database Service
// ============================================
// Handles user CRUD operations via Supabase (PostgreSQL)

const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');
const sessionCache = require('./sessionCache');

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
    // Omitted on purpose when the caller has no id yet — coupons.id defaults to
    // gen_random_uuid()::text, so Postgres mints the unique id on insert.
    ...(c.id ? { id: c.id } : {}),
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
    ...(c.onSale !== undefined ? { on_sale: Boolean(c.onSale !== false && c.onSale !== 'false') } : {}),
    ...(c.timerOn !== undefined ? { timer_on: Boolean(c.timerOn !== false && c.timerOn !== 'false') } : {}),
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
    // Both read as ON when the column is missing (pre-migration) or NULL, which
    // matches the DEFAULT TRUE the migration installs.
    onSale: r.on_sale !== false,
    // Timer OFF hides the countdown but keeps expiry_date, so flipping it back
    // on restores the date the admin already entered.
    timerOn: r.timer_on !== false,
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
  let { data, error } = await client
    .from('coupons')
    .insert(row)
    .select()
    .single();

  // The id is deliberately omitted so `coupons.id DEFAULT gen_random_uuid()::text`
  // (server/setup_coupon_sale_timer.sql) mints it. If that migration hasn't been
  // applied yet the column is still NOT NULL with no default, so Postgres answers
  // 23502 — mint the id here once and retry, rather than losing the coupon.
  if (error && error.code === '23502' && !row.id) {
    row.id = randomUUID();
    ({ data, error } = await client.from('coupons').insert(row).select().single());
  }

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
  // Sale switch, timer switch + expiry date, all edited inline from Coupon Management
  if (updates.onSale !== undefined) patch.on_sale = Boolean(updates.onSale !== false && updates.onSale !== 'false');
  if (updates.timerOn !== undefined) patch.timer_on = Boolean(updates.timerOn !== false && updates.timerOn !== 'false');
  if (updates.expiryDate !== undefined) patch.expiry_date = updates.expiryDate || null;

  if (Object.keys(patch).length === 0) {
    throw new Error('No updatable fields were supplied.');
  }

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

// 48 hours, in milliseconds — the maximum lifetime of any USER login session.
// Admin sessions are shorter: 2 hours (automatic admin logout).
const SESSION_TTL_MS = 48 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// Sessions are split across two physical tables so admin and user logins are
// never mixed together. Admin logins land in admin_sessions; everyone else in
// user_sessions. Token/id lookups that don't know the role upfront check both.
const USER_SESSIONS_TABLE = 'user_sessions';
const ADMIN_SESSIONS_TABLE = 'admin_sessions';
const SESSION_TABLES = [USER_SESSIONS_TABLE, ADMIN_SESSIONS_TABLE];

// Admin logins record login_method 'Admin' or 'Google Admin'.
function isAdminLoginMethod(method) {
  return /^(google\s+)?admin$/i.test(String(method || '').trim());
}

// Pick the destination table for a brand-new session from its login_method.
function sessionTableFor(loginMethod) {
  return isAdminLoginMethod(loginMethod) ? ADMIN_SESSIONS_TABLE : USER_SESSIONS_TABLE;
}

// Matches PostgREST errors raised when the sessions table hasn't been
// upgraded yet (missing session_token / revoked_at / user_agent columns).
function isMissingColumnError(err) {
  const msg = String((err && err.message) || err || '');
  return /session_token|revoked_at|user_agent|42703|could not find the column/i.test(msg);
}

/**
 * Ensure the session tables exist in Supabase.
 * Called once on startup; silently succeeds if already present.
 */
async function ensureSessionsTable() {
  const client = getClient();
  if (!client) return;

  for (const table of SESSION_TABLES) {
    try {
      // Lightweight probe — if it succeeds, the table (and the session_token
      // column added by the 48h-session upgrade) exists.
      await client.from(table).select('session_id, session_token').limit(1);
    } catch (err) {
      console.warn(`Sessions table probe failed for "${table}" (may need manual creation):`, err.message);
      console.warn('Run server/setup_sessions_table.sql in Supabase SQL Editor.');
    }
  }
}

/**
 * Create a new session record when a user or admin logs in.
 * User sessions expire exactly 48 hours from login; admin sessions 2 hours
 * (automatic admin logout). Nothing the client sends can extend that window.
 * @param {object} sessionData - includes session_token (SHA-256 hash) and user_agent
 * @param {number} [ttlMs] - session lifetime override (admins pass 2 hours)
 * @returns {object|null} The created session row
 */
async function createSession(sessionData, ttlMs) {
  const client = getClient();
  if (!client) return null;

  const now = new Date();
  const lifetimeMs = ttlMs || (isAdminLoginMethod(sessionData.login_method) ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS);
  const expiresAt = new Date(now.getTime() + lifetimeMs);

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
      .from(sessionTableFor(sessionData.login_method))
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

  let sawMissingColumn = false;

  for (const table of SESSION_TABLES) {
    try {
      const { data, error } = await client
        .from(table)
        .select('session_id, user_id, email, status, expires_at, login_time, last_active, login_method')
        .eq('session_token', tokenHash)
        .limit(1);

      if (error) {
        if (isMissingColumnError(error)) { sawMissingColumn = true; continue; }
        console.warn('Find session by token warning:', error.message);
        continue;
      }
      if (data && data.length) return data[0];
    } catch (err) {
      console.warn('Find session by token exception:', err.message);
    }
  }

  // Every table reported the session_token column missing (pre-migration DB)
  // so callers can fail open instead of locking every user out.
  if (sawMissingColumn) return { unavailable: true };
  return null;
}

/**
 * Find a session row by session_id (ownership checks on the revoke endpoint).
 */
async function findSessionById(sessionId) {
  const client = getClient();
  if (!client) return null;

  for (const table of SESSION_TABLES) {
    try {
      const { data, error } = await client
        .from(table)
        .select('session_id, user_id, status')
        .eq('session_id', sessionId)
        .limit(1);
      if (error) continue;
      if (data && data.length) return data[0];
    } catch (err) {
      // try next table
    }
  }
  return null;
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

  for (const table of SESSION_TABLES) {
    try {
      let { error } = await client
        .from(table)
        .update({ ...updates, revoked_at: now })
        .eq('session_token', tokenHash)
        .eq('status', 'Active');
      if (error && isMissingColumnError(error)) {
        ({ error } = await client
          .from(table)
          .update(updates)
          .eq('session_token', tokenHash)
          .eq('status', 'Active'));
      }
      if (error) console.warn('End session by token warning:', error.message);
    } catch (err) {
      console.warn('End session by token exception:', err.message);
    }
  }
  // Honor the revocation immediately on this instance (other instances
  // pick it up within the validation-cache TTL).
  sessionCache.remove(tokenHash);
}

/**
 * Update last_active timestamp for a session (heartbeat).
 */
async function updateSessionActivity(sessionId) {
  const client = getClient();
  if (!client) return;

  for (const table of SESSION_TABLES) {
    try {
      await client
        .from(table)
        .update({ last_active: new Date().toISOString() })
        .eq('session_id', sessionId);
    } catch (err) {
      console.warn('Update session activity warning:', err.message);
    }
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

  for (const table of SESSION_TABLES) {
    try {
      let { error } = await client
        .from(table)
        .update({ ...updates, revoked_at: now })
        .eq('session_id', sessionId);
      if (error && isMissingColumnError(error)) {
        ({ error } = await client
          .from(table)
          .update(updates)
          .eq('session_id', sessionId));
      }
      if (error) console.warn('End session warning:', error.message);
    } catch (err) {
      console.warn('End session exception:', err.message);
    }
  }
  sessionCache.invalidateBySessionId(sessionId);
}

/**
 * End all active sessions for a user ("log out all devices").
 *
 * @param {string} userId
 * @param {{ exceptSessionId?: string }} [options] — pass exceptSessionId to keep
 *        one session alive ("log out of all other devices"): that row is left
 *        Active so the device making the request stays signed in.
 */
async function endAllUserSessions(userId, options = {}) {
  const client = getClient();
  if (!client) return;

  const exceptSessionId = options.exceptSessionId || null;
  const now = new Date().toISOString();
  const updates = {
    status: 'Logged out',
    logged_out_at: now,
    last_active: now,
  };

  for (const table of SESSION_TABLES) {
    try {
      const build = (payload) => {
        let q = client
          .from(table)
          .update(payload)
          .eq('user_id', userId)
          .eq('status', 'Active');
        if (exceptSessionId) q = q.neq('session_id', exceptSessionId);
        return q;
      };

      let { error } = await build({ ...updates, revoked_at: now });
      if (error && isMissingColumnError(error)) {
        ({ error } = await build(updates));
      }
      if (error) console.warn('End all user sessions warning:', error.message);
    } catch (err) {
      console.warn('End all user sessions exception:', err.message);
    }
  }
  // Drops every cached validation for this user, including the kept session —
  // that one simply re-reads its still-Active row on the next request.
  sessionCache.invalidateByUserId(userId);
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
  let total = 0;

  for (const table of SESSION_TABLES) {
    try {
      let { data, error } = await client
        .from(table)
        .update({ ...updates, revoked_at: now })
        .eq('status', 'Active')
        .lte('expires_at', now)
        .select('session_id');
      if (error && isMissingColumnError(error)) {
        ({ data, error } = await client
          .from(table)
          .update(updates)
          .eq('status', 'Active')
          .lte('expires_at', now)
          .select('session_id'));
      }
      if (error) {
        console.warn('Expire outdated sessions warning:', error.message);
        continue;
      }
      total += (data || []).length;
    } catch (err) {
      console.warn('Expire outdated sessions exception:', err.message);
    }
  }
  sessionCache.clear(); // swept rows may be cached as Active
  return { count: total };
}

/**
 * Get all USER sessions (for the admin panel's "User Sessions" page).
 * Admin logins live in their own table. The session_token hash is never
 * exposed — not even to admins.
 */
async function getAllSessions() {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from(USER_SESSIONS_TABLE)
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
 * Get ADMIN login sessions (for the admin panel's "Admin Sessions" page —
 * admins are auto-logged-out 2 hours after login, so this doubles as a
 * "who's in the panel right now" view).
 */
async function getAdminSessions() {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from(ADMIN_SESSIONS_TABLE)
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
      .from(USER_SESSIONS_TABLE)
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
 * Count active sessions across both user and admin tables.
 */
async function countActiveSessions() {
  const client = getClient();
  if (!client) return 0;

  let total = 0;
  for (const table of SESSION_TABLES) {
    try {
      const { count, error } = await client
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('status', 'Active');
      if (!error) total += (count || 0);
    } catch (err) {
      // ignore — count best-effort
    }
  }
  return total;
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
  getAdminSessions,
  getUserSessions,
  countActiveSessions,
  SESSION_TTL_MS,
  ADMIN_SESSION_TTL_MS,
};

