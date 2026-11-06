// ============================================
// SaveHatke — Supabase Payment Ledger Adapter
// ============================================
// Orders, Payments and observed payment notifications live in PostgreSQL.
// The public API intentionally mirrors the small CRUD surface previously
// used by paymentStore.js, so checkout, Gmail verification and admin screens
// keep their existing application-level data shapes.
//
// This module MUST only be used on the server with SUPABASE_SERVICE_KEY.
// It is never imported by browser code.

const supabase = require('./supabase');
const sheets = require('./googleSheets');

const SHEETS = Object.freeze({
  ...sheets.SHEETS,
  ORDERS: sheets.SHEETS.ORDERS,
  PAYMENTS: sheets.SHEETS.PAYMENTS,
  PAYMENT_NOTIFICATIONS: sheets.SHEETS.PAYMENT_NOTIFICATIONS,
});

const TABLES = Object.freeze({
  [SHEETS.ORDERS]: 'orders',
  [SHEETS.PAYMENTS]: 'payments',
  [SHEETS.PAYMENT_NOTIFICATIONS]: 'payment_notifications',
});

const PRIMARY_KEYS = Object.freeze({
  orders: 'id',
  payments: 'payment_id',
  payment_notifications: 'id',
});

const TIMESTAMP_COLUMNS = new Set([
  'created_at', 'updated_at', 'expires_at', 'check_expires_at',
  'payment_expires_at', 'verification_started_at', 'verification_deadline',
  'last_checked_at', 'paid_at', 'occurred_at', 'processed_at',
]);

const NUMERIC_COLUMNS = new Set(['amount', 'received_amount']);
const PAGE_SIZE = 1000;

function clientOrThrow() {
  const client = supabase.getClient();
  if (!client) {
    throw new Error('Supabase payment ledger is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  }
  return client;
}

function tableFor(sheet) {
  const table = TABLES[sheet];
  if (!table) throw new Error('Unsupported payment-ledger sheet: ' + String(sheet));
  return table;
}

function parseJson(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    return { text: String(value) };
  }
}

function normalizeRow(row = {}) {
  const out = { ...row };
  for (const key of Object.keys(out)) {
    const value = out[key];
    if (TIMESTAMP_COLUMNS.has(key) && (value === '' || value === undefined)) {
      out[key] = null;
    } else if (NUMERIC_COLUMNS.has(key) && (value === '' || value === undefined)) {
      out[key] = null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(out, 'raw')) {
    out.raw = parseJson(out.raw);
  }
  return out;
}

function throwDatabaseError(action, table, error) {
  const err = new Error(
    'Supabase payment ledger ' + action + ' failed for ' + table + ': ' +
    String(error && error.message ? error.message : 'unknown database error')
  );
  if (error && error.code) {
    err.databaseCode = String(error.code);
    err.code = error.code === '23505' ? 'CONFLICT' : error.code;
  }
  if (error && error.details) err.details = error.details;
  err.cause = error;
  throw err;
}

async function initialize() {
  const client = clientOrThrow();
  for (const table of Object.keys(PRIMARY_KEYS)) {
    const key = PRIMARY_KEYS[table];
    const { error } = await client.from(table).select(key).limit(1);
    if (error) {
      throw new Error(
        'Supabase payment ledger table "' + table + '" is unavailable. ' +
        'Apply supabase/migrations/20261105_supabase_payment_ledger.sql. ' +
        error.message
      );
    }
  }
  return true;
}

async function readAll(table) {
  const client = clientOrThrow();
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await client
      .from(table)
      .select('*')
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throwDatabaseError('read', table, error);
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

async function getRowsFresh(sheet, options = {}) {
  // Coupon fallback remains on the existing inventory store. Only the three
  // financial-ledger tabs are redirected to Supabase.
  if (sheet === SHEETS.COUPONS) return sheets.getRowsFresh(sheet, options);
  return readAll(tableFor(sheet));
}

async function getRows(sheet) {
  // Financial decisions must always use current database state, not an
  // instance-local cache that can be stale across Vercel functions.
  return getRowsFresh(sheet);
}

async function appendRow(sheet, row) {
  const table = tableFor(sheet);
  const client = clientOrThrow();
  const { data, error } = await client
    .from(table)
    .insert(normalizeRow(row))
    .select('*')
    .single();
  if (error) throwDatabaseError('insert', table, error);
  return data;
}

async function updateRow(sheet, key, value, patch) {
  const table = tableFor(sheet);
  const client = clientOrThrow();
  const { data, error } = await client
    .from(table)
    .update(normalizeRow(patch))
    .eq(key, value)
    .select('*');
  if (error) throwDatabaseError('update', table, error);
  return (data || [])[0] || null;
}

/**
 * Database-level compare-and-set. The status predicate is evaluated by
 * PostgreSQL in the UPDATE itself, so separate Vercel instances cannot both
 * move the same payment/order out of the same prior state.
 */
async function compareAndSet(sheet, key, value, expectedStatus, patch) {
  const table = tableFor(sheet);
  const client = clientOrThrow();
  const { data, error } = await client
    .from(table)
    .update(normalizeRow(patch))
    .eq(key, value)
    .eq('status', expectedStatus)
    .select('*')
    .maybeSingle();
  if (error) throwDatabaseError('compare-and-set', table, error);
  return data || null;
}

/**
 * Update a payment and its order in ONE PostgreSQL transaction using the
 * migration's SECURITY DEFINER RPC. This is used for PAID and underpayment
 * settlement paths so the two ledger rows can never diverge on a partial write.
 */
async function createCheckout(orderRow, paymentRow) {
  const client = clientOrThrow();
  const { data, error } = await client.rpc('savehatke_create_checkout', {
    p_order: normalizeRow(orderRow),
    p_payment: normalizeRow(paymentRow),
  });
  if (error) throwDatabaseError('atomic checkout creation', 'orders + payments', error);
  if (!data || !data.order || !data.payment) throw new Error('Atomic checkout creation returned an incomplete result.');
  return data;
}

async function updatePaymentAndOrder(paymentId, expectedStatus, paymentPatch, orderPatch) {
  const client = clientOrThrow();
  const { data, error } = await client.rpc('savehatke_update_payment_order', {
    p_payment_id: String(paymentId),
    p_expected_status: String(expectedStatus),
    p_payment_patch: normalizeRow(paymentPatch),
    p_order_patch: normalizeRow(orderPatch),
  });
  if (error) throwDatabaseError('atomic payment/order update', 'payments + orders', error);
  return data || null;
}

async function createCheckout(order, payment) {
  const client = clientOrThrow();
  const { data, error } = await client.rpc('savehatke_create_checkout', {
    p_order: normalizeRow(order),
    p_payment: normalizeRow(payment),
  });
  if (error) throwDatabaseError('atomic checkout creation', 'orders + payments', error);
  if (!data || !data.order || !data.payment) throw new Error('Atomic checkout creation returned incomplete records.');
  return data;
}

async function findRowsFresh(sheet, key, value) {
  if (sheet === SHEETS.COUPONS) return sheets.findRowsFresh(sheet, key, value);
  const rows = await getRowsFresh(sheet);
  return rows.filter((row) => String(row[key]) === String(value));
}

function isConfigured() {
  return supabase.isConfigured();
}

// Kept as a compatibility alias for paymentStore's prior availability gate.
function isSheetsConnected() {
  return isConfigured();
}

module.exports = {
  SHEETS,
  initialize,
  isConfigured,
  isSheetsConnected,
  getRows,
  getRowsFresh,
  appendRow,
  updateRow,
  compareAndSet,
  updatePaymentAndOrder,
  createCheckout,
  findRowsFresh,
};
