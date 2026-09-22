'use strict';

// ============================================
// SaveHatke — Refunds Service
// ============================================
// Handles the lifecycle of a refund record triggered by a payment-amount
// mismatch (the buyer paid more or less than the coupon's required amount).
//
// Single rule
// -----------
//   received === required  ->  no refund
//   received  >  required  ->  refund = received - required  (overpayment)
//   received  <  required  ->  refund = received             (underpayment)
//
// Every refund is created from server-side data the payment verifier
// already approved. The browser never gets to choose the amounts: it can
// only inspect what the server has stored. The Sheets `Refunds` tab and the
// Supabase `refunds` table are written together so the dashboard reads
// whatever is the most-up-to-date mirror.
//
// Money is stored as a 2-decimal string ("100.00") everywhere it touches
// Sheets, mirroring the existing Payments-tab shape — the paise arithmetic
// happens in money2() / moneyEquals() helpers. Supabase stores the same
// shape as numeric(12,2) via toNumber() so the JSON contract stays a
// string for the existing API consumers.

const { v4: uuidv4 } = require('uuid');
const db = require('./googleSheets');
const supabase = require('./supabase');

const SHEETS = db.SHEETS;
const STATUSES = ['pending', 'processing', 'refunded', 'rejected'];
const MISMATCH_TYPES = ['overpayment', 'underpayment'];

// Reasons are server-assigned, never user-typed. The spec ties the reason
// to the mismatch type so the dashboard always shows the same copy and the
// admin can scan the list at a glance.
const REASON_OVERPAYMENT  = 'Payment amount exceeded required amount';
const REASON_UNDERPAYMENT = 'Payment amount was below required amount';

// Round to 2 decimals and stringify — the same shape used by the Payments
// tab, so dual-writes keep the same column type across sheets. Negative
// values are clamped to zero — refund amounts must never be negative, and
// keeping money2 honest is the single chokepoint for that rule.
function money2(n) {
  if (n === null || n === undefined || n === '') return '0.00';
  const num = Number(n);
  if (!Number.isFinite(num)) return '0.00';
  const clamped = num < 0 ? 0 : num;
  return (Math.round(clamped * 100) / 100).toFixed(2);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function clampStatus(s) {
  const v = String(s || '').toLowerCase();
  return STATUSES.includes(v) ? v : 'pending';
}

function clampMismatchType(t) {
  const v = String(t || '').toLowerCase();
  return MISMATCH_TYPES.includes(v) ? v : 'overpayment';
}

// Compute the refund arithmetic. This is the single place the rule lives —
// everywhere else reads from the persisted refund_amount and never
// re-derives it from a client-supplied value.
function computeRefund({ required, received }) {
  const r = Math.max(0, toNumber(required));
  const x = Math.max(0, toNumber(received));
  if (x === r) {
    return { mismatchType: null, refundAmount: 0, delta: 0 };
  }
  if (x > r) {
    return { mismatchType: 'overpayment', refundAmount: x - r, delta: x - r };
  }
  // Underpayment: the refund equals exactly what we received — the buyer
  // gets back everything they actually paid, never more.
  return { mismatchType: 'underpayment', refundAmount: x, delta: r - x };
}

// Format a refund row the same way regardless of source (Sheets or Supabase).
// Returns a clean object whose amount fields are always paise-precise
// strings and whose dates are ISO-8601.
function normalize(row) {
  if (!row) return null;
  return {
    id: row.id || row.refund_id || '',
    refundId: row.refund_id || row.id || '',
    userId: row.user_id || row.userId || '',
    userEmail: row.user_email || row.userEmail || '',
    paymentId: row.payment_id || row.paymentId || '',
    couponId: row.coupon_id || row.couponId || '',
    orderCode: row.order_code || row.orderCode || '',
    requiredAmount: money2(row.required_amount || row.requiredAmount),
    receivedAmount: money2(row.received_amount || row.receivedAmount),
    refundAmount: money2(row.refund_amount || row.refundAmount),
    currency: row.currency || 'INR',
    mismatchType: clampMismatchType(row.mismatch_type || row.mismatchType),
    refundReason: row.refund_reason || row.refundReason || '',
    status: clampStatus(row.status),
    refundReference: row.refund_reference || row.refundReference || '',
    adminNote: row.admin_note || row.adminNote || '',
    processedAt: row.processed_at || row.processedAt || '',
    processedBy: row.processed_by || row.processedBy || '',
    createdAt: row.created_at || row.createdAt || '',
    updatedAt: row.updated_at || row.updatedAt || '',
  };
}

// Map a normalized refund into the row shape that goes into Sheets. The
// column order matches the SHEETS.REFUNDS header so appendRow writes the
// cells in the right place.
function toSheetsRow(r) {
  return {
    id: r.refundId || r.id,
    user_id: r.userId,
    user_email: r.userEmail,
    payment_id: r.paymentId,
    coupon_id: r.couponId,
    order_code: r.orderCode,
    required_amount: r.requiredAmount,
    received_amount: r.receivedAmount,
    refund_amount: r.refundAmount,
    currency: r.currency,
    mismatch_type: r.mismatchType,
    refund_reason: r.refundReason,
    status: r.status,
    refund_reference: r.refundReference,
    admin_note: r.adminNote,
    processed_at: r.processedAt,
    processed_by: r.processedBy,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

// Supabase shape: numeric columns accept a JS number; paise-precise to
// 2 decimals is fine because the input is already 2-decimal-rounded by
// money2().
function toSupabaseRow(r) {
  return {
    id: r.id || undefined,                 // uuid is server-set; let Supabase default fire
    refund_id: r.refundId,
    user_id: r.userId,
    user_email: r.userEmail,
    payment_id: r.paymentId,
    coupon_id: r.couponId,
    order_code: r.orderCode,
    required_amount: toNumber(r.requiredAmount),
    received_amount: toNumber(r.receivedAmount),
    refund_amount: toNumber(r.refundAmount),
    currency: r.currency,
    mismatch_type: r.mismatchType,
    refund_reason: r.refundReason,
    status: r.status,
    refund_reference: r.refundReference,
    admin_note: r.adminNote,
    processed_at: r.processedAt || null,
    processed_by: r.processedBy,
    // created_at and updated_at default to now() at the SQL level — only
    // send values when the caller has an authoritative timestamp.
    ...(r.createdAt ? { created_at: r.createdAt } : {}),
    ...(r.updatedAt ? { updated_at: r.updatedAt } : {}),
  };
}

// ── Read helpers ──────────────────────────────────────────────────────────

async function readAllFromSheets() {
  try {
    const rows = await db.getRows(SHEETS.REFUNDS);
    return (rows || []).map(normalize).filter(Boolean);
  } catch (e) {
    console.warn('[refunds] Sheets read notice:', e.message);
    return [];
  }
}

async function readFromSupabase() {
  if (!supabase.isConfigured()) return [];
  const client = supabase.getClient();
  if (!client) return [];
  try {
    const { data, error } = await client
      .from('refunds')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      console.warn('[refunds] Supabase read notice:', error.message);
      return [];
    }
    return (data || []).map(normalize).filter(Boolean);
  } catch (e) {
    console.warn('[refunds] Supabase read notice:', e.message);
    return [];
  }
}

// Sheet-first read with Supabase fallback (and vice versa) — never silently
// drop a refund because one store is empty.
async function readAllRefunds() {
  const sheets = await readAllFromSheets();
  if (sheets.length > 0) {
    // Sheets is the operator-readable mirror. A row that exists only in
    // Supabase is also surfaced so a brand-new write that has not yet
    // mirrored to Sheets is still visible.
    const supa = await readFromSupabase();
    const seen = new Set(sheets.map((r) => r.refundId || r.id));
    return sheets.concat(supa.filter((r) => !seen.has(r.refundId || r.id)));
  }
  return readFromSupabase();
}

async function getRefundsForUser(userId) {
  if (!userId) return [];
  const all = await readAllRefunds();
  return all
    .filter((r) => r.userId === userId)
    .sort((a, b) => (new Date(b.createdAt || 0).getTime()) - (new Date(a.createdAt || 0).getTime()));
}

async function getRefundById(id) {
  if (!id) return null;
  const all = await readAllRefunds();
  return all.find((r) => (r.refundId || r.id) === id) || null;
}

// ── Write helpers (server-only) ──────────────────────────────────────────

/**
 * Create or update a refund for a payment.
 *
 * The payment verifier calls this when a verified received amount differs
 * from the required amount. The function is idempotent: a second call for
 * the same paymentId updates the existing row (or returns it unchanged),
 * never creates a duplicate. The amounts are ALWAYS read from the inputs
 * the server produced — the caller is trusted, the caller of the caller
 * (the browser) is not.
 */
async function createOrUpdateRefund({
  paymentId,
  userId,
  userEmail = '',
  couponId = '',
  orderCode = '',
  requiredAmount,
  receivedAmount,
  currency = 'INR',
  // Optional admin overrides; intentionally minimal — only the two fields
  // an admin might want to fill in at creation.
  status,
  adminNote = '',
  refundReference = '',
}) {
  if (!paymentId || !userId) {
    return { ok: false, code: 'INVALID_INPUT', error: 'paymentId and userId are required.' };
  }

  const computed = computeRefund({ required: requiredAmount, received: receivedAmount });
  if (!computed.mismatchType) {
    // Correct payment: nothing to create. If a stale refund row exists for
    // this payment, do NOT touch it here — the dashboard's "no refund"
    // path means there is no refund at all.
    return { ok: true, created: false, refund: null, reason: 'no_mismatch' };
  }

  const now = new Date().toISOString();
  const isUnderpayment = computed.mismatchType === 'underpayment';
  const reasonText = isUnderpayment ? REASON_UNDERPAYMENT : REASON_OVERPAYMENT;

  // Find an existing row by payment_id (the unique-per-payment key).
  const existing = (await readAllRefunds()).find((r) => r.paymentId === paymentId) || null;

  const merged = normalize({
    ...(existing || {}),
    refund_id: (existing && existing.refundId) || `rfnd_${uuidv4().slice(0, 12)}`,
    user_id: userId,
    user_email: userEmail || (existing && existing.userEmail) || '',
    payment_id: paymentId,
    coupon_id: couponId || (existing && existing.couponId) || '',
    order_code: orderCode || (existing && existing.orderCode) || '',
    required_amount: money2(requiredAmount),
    received_amount: money2(receivedAmount),
    refund_amount: money2(computed.refundAmount),
    currency,
    mismatch_type: computed.mismatchType,
    refund_reason: reasonText,
    // An underpayment refund starts in 'pending' so the user can see it
    // and either pay the remaining amount or ask for the partial refund.
    // An overpayment refund also starts in 'pending' and moves through
    // 'processing' → 'refunded' as the admin settles it.
    status: clampStatus(status || (existing && existing.status) || 'pending'),
    refund_reference: refundReference || (existing && existing.refundReference) || '',
    admin_note: adminNote || (existing && existing.adminNote) || '',
    processed_at: (existing && existing.processedAt) || '',
    processed_by: (existing && existing.processedBy) || '',
    created_at: (existing && existing.createdAt) || now,
    updated_at: now,
  });

  // Dual-write: Sheets first (operator mirror), then Supabase (structured
  // store). A Supabase failure never fails the call: the Sheets row is the
  // primary, and the dashboard can read from Sheets while the structured
  // store catches up.
  let sheetsSaved = false;
  try {
    if (existing) {
      await db.updateRow(SHEETS.REFUNDS, 'id', existing.refundId || existing.id, toSheetsRow(merged));
    } else {
      await db.appendRow(SHEETS.REFUNDS, toSheetsRow(merged));
    }
    sheetsSaved = true;
  } catch (e) {
    console.warn('[refunds] Sheets write notice:', e.message);
  }

  if (supabase.isConfigured()) {
    try {
      const client = supabase.getClient();
      if (client) {
        if (existing) {
          await client.from('refunds').update(toSupabaseRow(merged)).eq('refund_id', merged.refundId);
        } else {
          await client.from('refunds').insert(toSupabaseRow(merged));
        }
      }
    } catch (e) {
      console.warn('[refunds] Supabase write notice:', e.message);
    }
  }

  if (!sheetsSaved && !supabase.isConfigured()) {
    return { ok: false, code: 'STORAGE_UNAVAILABLE', error: 'Neither Sheets nor Supabase is configured.' };
  }

  return { ok: true, created: !existing, refund: merged };
}

/**
 * Update the admin-mutable fields on an existing refund. The amounts and
 * mismatch type are NEVER touched here — those are derived from the verified
 * payment record and must come from createOrUpdateRefund only.
 */
async function updateRefundStatus(refundId, { status, adminNote, refundReference, processedBy }) {
  if (!refundId) return { ok: false, code: 'INVALID_INPUT', error: 'refundId is required.' };
  const clamped = clampStatus(status);
  if (clamped !== status) {
    return { ok: false, code: 'INVALID_STATUS', error: 'Invalid refund status.' };
  }

  const all = await readAllRefunds();
  const existing = all.find((r) => (r.refundId || r.id) === refundId);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'Refund not found.' };

  const now = new Date().toISOString();
  const isTerminal = clamped === 'refunded' || clamped === 'rejected';
  const updated = normalize({
    ...existing,
    status: clamped,
    admin_note: typeof adminNote === 'string' ? adminNote : existing.adminNote,
    refund_reference: typeof refundReference === 'string' ? refundReference : existing.refundReference,
    processed_by: isTerminal ? (processedBy || existing.processedBy || 'admin') : (processedBy || existing.processedBy),
    processed_at: isTerminal ? now : existing.processedAt,
    updated_at: now,
  });

  // Sheets first, then Supabase (same dual-write pattern).
  try {
    await db.updateRow(SHEETS.REFUNDS, 'id', existing.refundId || existing.id, toSheetsRow(updated));
  } catch (e) {
    console.warn('[refunds] Sheets status update notice:', e.message);
  }
  if (supabase.isConfigured()) {
    try {
      const client = supabase.getClient();
      if (client) {
        await client.from('refunds').update(toSupabaseRow(updated)).eq('refund_id', updated.refundId);
      }
    } catch (e) {
      console.warn('[refunds] Supabase status update notice:', e.message);
    }
  }

  return { ok: true, refund: updated };
}

// ── Status timeline ──────────────────────────────────────────────────────

// Returns the ordered list of stages a refund passes through. The dashboard
// renders one of these as a 3- or 4-step visual: each step is either
// 'done', 'current', or 'pending'.
function statusTimeline(refund) {
  const status = clampStatus(refund && refund.status);
  if (status === 'rejected') {
    return [
      { id: 'created',  label: 'Request Created', state: 'done' },
      { id: 'review',   label: 'Under Review',    state: 'done' },
      { id: 'rejected', label: 'Rejected',         state: 'current' },
    ];
  }
  const isUnderpayment = clampMismatchType(refund && refund.mismatchType) === 'underpayment';
  const stages = [
    { id: 'created',    label: 'Request Created', state: status === 'pending' ? 'current' : 'done' },
    { id: 'review',     label: 'Under Review',    state: status === 'pending' ? 'pending' : (status === 'processing' ? 'current' : 'done') },
    { id: 'processing', label: isUnderpayment ? 'Pending Pay Remaining' : 'Processing', state: status === 'processing' ? 'current' : (status === 'refunded' ? 'done' : 'pending') },
    { id: 'refunded',   label: 'Refunded',        state: status === 'refunded' ? 'current' : 'pending' },
  ];
  return stages;
}

// Summary buckets for the dashboard's header cards. Each row is a status
// label and the integer-rupee sum of refund_amount in that bucket.
function summarize(refunds) {
  const out = {
    total: 0, totalCount: refunds.length,
    pending: 0, pendingCount: 0,
    processing: 0, processingCount: 0,
    refunded: 0, refundedCount: 0,
    rejected: 0, rejectedCount: 0,
  };
  for (const r of refunds) {
    const amt = toNumber(r.refundAmount);
    out.total += amt;
    if (r.status === 'pending')     { out.pending     += amt; out.pendingCount++; }
    if (r.status === 'processing')  { out.processing  += amt; out.processingCount++; }
    if (r.status === 'refunded')    { out.refunded    += amt; out.refundedCount++; }
    if (r.status === 'rejected')    { out.rejected    += amt; out.rejectedCount++; }
  }
  return {
    total: money2(out.total),
    totalCount: out.totalCount,
    pending: money2(out.pending),
    pendingCount: out.pendingCount,
    processing: money2(out.processing),
    processingCount: out.processingCount,
    refunded: money2(out.refunded),
    refundedCount: out.refundedCount,
    rejected: money2(out.rejected),
    rejectedCount: out.rejectedCount,
  };
}

module.exports = {
  STATUSES,
  MISMATCH_TYPES,
  REASON_OVERPAYMENT,
  REASON_UNDERPAYMENT,
  money2,
  toNumber,
  computeRefund,
  readAllRefunds,
  getRefundsForUser,
  getRefundById,
  createOrUpdateRefund,
  updateRefundStatus,
  statusTimeline,
  summarize,
  // Exported for tests and other services that need the canonical shape.
  normalize,
  toSheetsRow,
  toSupabaseRow,
};
