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
const ids = require('../utils/identifiers');

const SHEETS = db.SHEETS;
const STATUSES = ['pending', 'processing', 'refunded', 'rejected'];
// 'late_payment' — a verified transaction that actually occurred after the
// backend verification deadline. The full received amount is refunded and the
// coupon is never delivered for that session.
const MISMATCH_TYPES = ['overpayment', 'underpayment', 'late_payment'];

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

// Reason text for a late payment. Server-assigned, never user-typed.
const REASON_LATE_PAYMENT = 'Payment was made after the verification deadline; full refund due';

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
    // `orderCode` is a REFERENCE to the original purchase order being refunded.
    orderCode: row.order_code || row.orderCode || '',
    // Canonical financial identity of THIS refund record. Legacy rows have none,
    // so fall back to refund_id for the visible id and 'REFUND' for the type
    // (every row in this store is, by definition, a refund).
    orderId: row.order_id || row.orderId || '',
    transactionId: row.transaction_id || row.transactionId || '',
    transactionType: row.transaction_type || row.transactionType || 'REFUND',
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
    order_id: r.orderId,
    transaction_id: r.transactionId,
    transaction_type: r.transactionType || 'REFUND',
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
    // Canonical financial identifiers (see server/utils/identifiers.js).
    order_id: r.orderId || null,
    transaction_id: r.transactionId || null,
    transaction_type: r.transactionType || 'REFUND',
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
  const allRefunds = await readAllRefunds();
  const existing = allRefunds.find((r) => r.paymentId === paymentId) || null;

  // Mint canonical identifiers for a NEW refund; an existing refund keeps the
  // ones it already has (never regenerate a historical id). Uniqueness is
  // enforced against the refunds already in the store.
  const takenOrderIds = new Set(allRefunds.map((r) => r.orderId).filter(Boolean));
  const takenTxnIds = new Set(allRefunds.map((r) => r.transactionId).filter(Boolean));
  const refundOrderId = (existing && existing.orderId)
    || ids.generateUniqueOrderIdSync('REFUND', takenOrderIds, { date: now });
  const refundTransactionId = (existing && existing.transactionId)
    || ids.generateUniqueTransactionIdSync(takenTxnIds, { date: now });

  const merged = normalize({
    ...(existing || {}),
    refund_id: (existing && existing.refundId) || `rfnd_${uuidv4().slice(0, 12)}`,
    user_id: userId,
    user_email: userEmail || (existing && existing.userEmail) || '',
    payment_id: paymentId,
    coupon_id: couponId || (existing && existing.couponId) || '',
    order_code: orderCode || (existing && existing.orderCode) || '',
    order_id: refundOrderId,
    transaction_id: refundTransactionId,
    transaction_type: 'REFUND',
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
  // store).
  //
  // The Sheets write is STRICT. A refund is money owed to a buyer, so "the
  // mirror was unreachable" must not be reported as "recorded": a non-strict
  // updateRow silently falls back to this instance's in-memory copy, which
  // returns ok:true for a row that exists nowhere authoritative and is gone
  // after a restart — while a buyer-facing "your refund is being processed"
  // message has already gone out.
  let sheetsSaved = false;
  let sheetsError = '';
  try {
    if (existing) {
      await db.updateRow(SHEETS.REFUNDS, 'id', existing.refundId || existing.id, toSheetsRow(merged), { strict: true });
    } else {
      await db.appendRow(SHEETS.REFUNDS, toSheetsRow(merged), { strict: true });
    }
    sheetsSaved = true;
  } catch (e) {
    sheetsError = e && e.message ? e.message : 'Sheets write failed';
    console.warn('[refunds] Sheets write notice:', sheetsError);
  }

  // Supabase carries a unique index on payment_id, which is what actually makes
  // "one refund per payment" true across instances. The result used to be
  // discarded, so a duplicate insert failed invisibly and the caller still got
  // ok:true. It is now inspected: a unique-constraint violation means another
  // writer already created this refund, which is reported, not swallowed.
  let supabaseSaved = false;
  let supabaseConflict = false;
  let supabaseError = '';
  if (supabase.isConfigured()) {
    try {
      const client = supabase.getClient();
      if (client) {
        const { error } = existing
          ? await client.from('refunds').update(toSupabaseRow(merged)).eq('refund_id', merged.refundId)
          : await client.from('refunds').insert(toSupabaseRow(merged));
        if (error) {
          supabaseError = error.message || 'Supabase write failed';
          if (error.code === '23505' || /duplicate key|unique constraint/i.test(supabaseError)) {
            supabaseConflict = true;
          }
          console.warn('[refunds] Supabase write notice:', supabaseError);
        } else {
          supabaseSaved = true;
        }
      }
    } catch (e) {
      supabaseError = e && e.message ? e.message : 'Supabase write failed';
      console.warn('[refunds] Supabase write notice:', supabaseError);
    }
  }

  // Fail closed. At least one authoritative store must have accepted the row.
  if (!sheetsSaved && !supabaseSaved) {
    return {
      ok: false,
      code: supabaseConflict ? 'REFUND_ALREADY_EXISTS' : 'STORAGE_UNAVAILABLE',
      error: supabaseConflict
        ? 'A refund for this payment already exists.'
        : 'The refund record could not be saved. No refund was created.',
    };
  }

  return { ok: true, created: !existing, refund: merged };
}

/**
 * Create the single refund task for a verified payment that arrived after its
 * verification deadline. Full received amount, never fulfilled, never a coupon.
 *
 * Idempotent per payment: the existing row is returned unchanged on any repeat
 * call, and the Supabase unique index on payment_id is the cross-instance guard.
 * The task starts 'pending' and only moves to 'refunded' through the admin gate
 * in updateRefundStatus (UTR + explicit confirmation).
 */
async function createLateRefundTask({
  paymentId,
  userId,
  userEmail = '',
  couponId = '',
  orderCode = '',
  receivedAmount,
  transactionId = '',
  verificationDeadline = '',
  transactionAt = '',
  payerName = '',
}) {
  if (!paymentId || !userId) {
    return { ok: false, code: 'INVALID_INPUT', error: 'paymentId and userId are required.' };
  }
  const amount = money2(receivedAmount);
  if (!(Number(amount) > 0)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'A positive received amount is required.' };
  }

  const allRefunds = await readAllRefunds();
  const existing = allRefunds.find((r) => r.paymentId === paymentId) || null;
  if (existing) {
    // Never rewrite a task that already exists, whatever its status.
    return { ok: true, created: false, refund: existing, reason: 'already_exists' };
  }

  const now = new Date().toISOString();
  const takenOrderIds = new Set(allRefunds.map((r) => r.orderId).filter(Boolean));
  const takenTxnIds = new Set(allRefunds.map((r) => r.transactionId).filter(Boolean));
  const merged = normalize({
    refund_id: `rfnd_${uuidv4().slice(0, 12)}`,
    user_id: userId,
    user_email: userEmail,
    payment_id: paymentId,
    coupon_id: couponId,
    order_code: orderCode,
    order_id: ids.generateUniqueOrderIdSync('REFUND', takenOrderIds, { date: now }),
    transaction_id: ids.generateUniqueTransactionIdSync(takenTxnIds, { date: now }),
    transaction_type: 'REFUND',
    required_amount: '0.00',
    received_amount: amount,
    refund_amount: amount,
    currency: 'INR',
    mismatch_type: 'late_payment',
    refund_reason: REASON_LATE_PAYMENT,
    status: 'pending',
    refund_reference: '',
    admin_note: [
      `Late payment: transaction ${transactionId || 'n/a'} at ${transactionAt || 'unknown'}`,
      `after verification deadline ${verificationDeadline || 'n/a'}.`,
      `Payer name on email: ${payerName || 'n/a'}.`,
      'Not fulfilled; no coupon delivered.',
    ].join(' '),
    processed_at: '',
    processed_by: '',
    created_at: now,
    updated_at: now,
  });

  let sheetsSaved = false;
  let sheetsError = '';
  try {
    await db.appendRow(SHEETS.REFUNDS, toSheetsRow(merged), { strict: true });
    sheetsSaved = true;
  } catch (e) {
    sheetsError = e && e.message ? e.message : 'Sheets write failed';
    console.warn('[refunds] Sheets late-task write notice:', sheetsError);
  }

  let supabaseSaved = false;
  let supabaseConflict = false;
  if (supabase.isConfigured()) {
    try {
      const client = supabase.getClient();
      if (client) {
        const { error } = await client.from('refunds').insert(toSupabaseRow(merged));
        if (error) {
          const msg = error.message || '';
          if (error.code === '23505' || /duplicate key|unique constraint/i.test(msg)) supabaseConflict = true;
          console.warn('[refunds] Supabase late-task write notice:', msg);
        } else {
          supabaseSaved = true;
        }
      }
    } catch (e) {
      console.warn('[refunds] Supabase late-task write notice:', e.message);
    }
  }

  if (supabaseConflict) {
    // Another instance created the task first. Return it instead of failing.
    const again = (await readAllRefunds()).find((r) => r.paymentId === paymentId) || null;
    return { ok: true, created: false, refund: again, reason: 'already_exists' };
  }
  if (!sheetsSaved && !supabaseSaved) {
    return { ok: false, code: 'STORAGE_UNAVAILABLE', error: sheetsError || 'Refund task could not be saved.' };
  }
  return { ok: true, created: true, refund: merged };
}

/**
 * Update the admin-mutable fields on an existing refund. The amounts and
 * mismatch type are NEVER touched here — those are derived from the verified
 * payment record and must come from createOrUpdateRefund only.
 *
 * Completion gate: 'refunded' requires a real refund UTR/reference AND an
 * explicit confirmation that the transfer was sent. Entering a UTR or merely
 * creating the task never completes a refund. Terminal states stay final.
 */
async function updateRefundStatus(refundId, { status, adminNote, refundReference, processedBy, confirmSent = false }) {
  if (!refundId) return { ok: false, code: 'INVALID_INPUT', error: 'refundId is required.' };
  const clamped = clampStatus(status);
  if (clamped !== status) {
    return { ok: false, code: 'INVALID_STATUS', error: 'Invalid refund status.' };
  }

  const all = await readAllRefunds();
  const existing = all.find((r) => (r.refundId || r.id) === refundId);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'Refund not found.' };

  if (clamped === 'refunded') {
    const ref = String(refundReference || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9\-_\/]{5,39}$/.test(ref)) {
      return { ok: false, code: 'UTR_REQUIRED', error: 'Enter the real refund UTR/reference (6–40 letters, digits, - _ /).' };
    }
    if (confirmSent !== true) {
      return { ok: false, code: 'CONFIRMATION_REQUIRED', error: 'Confirm that the UPI transfer was actually sent before marking this refund completed.' };
    }
    if (!processedBy) {
      return { ok: false, code: 'ADMIN_REQUIRED', error: 'The administrator identity is required.' };
    }
    refundReference = ref;
  }

  // ── Terminal states are final ────────────────────────────────────────────
  // 'refunded' and 'rejected' are set by an administrator and record that money
  // has (or has not) moved. Without this guard the whole row was rebuilt from a
  // stale snapshot with no precondition, so a buyer's own
  // POST /api/refunds/:id/request racing an admin's "mark refunded" could write
  // 'processing' over 'refunded' — erasing the audit trail of a completed
  // payout. Re-opening a terminal refund is a deliberate admin action, not a
  // side effect of a status update.
  const currentStatus = clampStatus(existing.status);
  const currentTerminal = currentStatus === 'refunded' || currentStatus === 'rejected';
  if (currentTerminal && clamped !== currentStatus) {
    return {
      ok: false,
      code: 'REFUND_FINALISED',
      error: `This refund is already marked "${currentStatus}" and cannot be changed.`,
      refund: existing,
    };
  }

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

  // Sheets first, then Supabase (same dual-write pattern). Both are checked:
  // reporting success for a status change that no authoritative store accepted
  // would tell an admin the money is marked refunded when it is not.
  let sheetsSaved = false;
  try {
    await db.updateRow(SHEETS.REFUNDS, 'id', existing.refundId || existing.id, toSheetsRow(updated), { strict: true });
    sheetsSaved = true;
  } catch (e) {
    console.warn('[refunds] Sheets status update notice:', e.message);
  }
  let supabaseSaved = false;
  if (supabase.isConfigured()) {
    try {
      const client = supabase.getClient();
      if (client) {
        const { error } = await client.from('refunds').update(toSupabaseRow(updated)).eq('refund_id', updated.refundId);
        if (error) console.warn('[refunds] Supabase status update notice:', error.message);
        else supabaseSaved = true;
      }
    } catch (e) {
      console.warn('[refunds] Supabase status update notice:', e.message);
    }
  }

  // Fail closed: a status change that no authoritative store accepted must not
  // be reported as done, or an admin is told the money is marked refunded while
  // the ledger still shows it pending.
  if (!sheetsSaved && !supabaseSaved) {
    return {
      ok: false,
      code: 'STORAGE_UNAVAILABLE',
      error: 'The refund status could not be saved. Nothing was changed — please try again.',
      refund: existing,
    };
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
  createLateRefundTask,
  updateRefundStatus,
  statusTimeline,
  summarize,
  // Exported for tests and other services that need the canonical shape.
  normalize,
  toSheetsRow,
  toSupabaseRow,
};
