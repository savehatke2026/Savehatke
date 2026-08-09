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

/**
 * Ensure the sessions table exists in Supabase.
 * Called once on startup; silently succeeds if already present.
 */
async function ensureSessionsTable() {
  const client = getClient();
  if (!client) return;

  try {
    // Try a lightweight probe — if it succeeds, the table exists
    await client.from('sessions').select('session_id').limit(1);
  } catch (err) {
    // Table likely doesn't exist — try to create it via rpc or just log
    console.warn('Sessions table probe failed (may need manual creation):', err.message);
    console.warn('Run server/setup_sessions_table.sql in Supabase SQL Editor.');
  }
}

/**
 * Create a new session record when a user logs in.
 * @param {object} sessionData
 * @returns {object|null} The created session row
 */
async function createSession(sessionData) {
  const client = getClient();
  if (!client) return null;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours from now

  const row = {
    user_id: sessionData.user_id || '',
    device: sessionData.device || '',
    os: sessionData.os || '',
    browser: sessionData.browser || '',
    country: sessionData.country || '',
    state: sessionData.state || '',
    city: sessionData.city || '',
    ip_address: sessionData.ip_address || '',
    login_method: sessionData.login_method || 'Email',
    login_time: now.toISOString(),
    last_active: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    status: 'Active',
  };

  try {
    const { data, error } = await client
      .from('sessions')
      .insert(row)
      .select()
      .single();

    if (error) {
      console.warn('Create session warning:', error.message);
      return null;
    }
    return data;
  } catch (err) {
    console.warn('Create session exception:', err.message);
    return null;
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
 * End a session (logout or expiry).
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
    await client
      .from('sessions')
      .update(updates)
      .eq('session_id', sessionId);
  } catch (err) {
    console.warn('End session warning:', err.message);
  }
}

/**
 * End all active sessions for a user (used during logout when session_id is unknown).
 */
async function endAllUserSessions(userId) {
  const client = getClient();
  if (!client) return;

  const now = new Date().toISOString();
  try {
    await client
      .from('sessions')
      .update({
        status: 'Logged out',
        logged_out_at: now,
        last_active: now,
      })
      .eq('user_id', userId)
      .eq('status', 'Active');
  } catch (err) {
    console.warn('End all user sessions warning:', err.message);
  }
}

/**
 * Get all sessions (for admin panel).
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
    return data || [];
  } catch (err) {
    return [];
  }
}

/**
 * Get sessions for a specific user.
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
    return data || [];
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
  updateSessionActivity,
  endSession,
  endAllUserSessions,
  getAllSessions,
  getUserSessions,
  countActiveSessions,
};

