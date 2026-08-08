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
};
