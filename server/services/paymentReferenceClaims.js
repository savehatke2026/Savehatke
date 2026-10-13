// Duplicate-reference protection for payment settlement.
//
// Google Sheets stays the payment ledger. The public.payment_reference_claims
// table (see supabase/migrations/_pending_review/20261010_payment_reference_claims.sql,
// already present on the live project) only guarantees that one FamApp
// Transaction ID or UTR settles at most one payment. The database's unique
// constraints make a claim atomic across Vercel instances; an in-memory lock or
// a read-before-write check is NOT relied on for this.
//
// Outcomes:
//   'claimed'   — both references are now held by this payment (or were already
//                 held by this same payment from an earlier, interrupted try).
//   'conflict'  — a reference is held by a DIFFERENT payment. Settle nothing.
//   'unavailable' — the database could not be reached or answered unexpectedly.
//                 Callers must treat this as "do not settle", never as success.
//
// Only the backend service-role client is used. Nothing here is exposed to
// the browser.

const supabase = require('./supabase');

const TABLE = 'payment_reference_claims';
const TYPES = { transaction: 'transaction_id', utr: 'utr' };

function client() {
  return supabase.isConfigured() ? supabase.getClient() : null;
}

function cleanRef(v) {
  return String(v || '').trim();
}

/**
 * Insert one claim. Returns { ok:true } when the row is ours, { ok:false,
 * conflictPaymentId } when another payment already holds the reference.
 */
async function insertClaim(db, refType, refValue, paymentId) {
  const { error } = await db
    .from(TABLE)
    .insert({ ref_type: refType, ref_value: refValue, payment_id: String(paymentId) });
  if (!error) return { ok: true };
  // 23505 = unique_violation. Find out whose claim it is.
  if (error.code === '23505') {
    const { data, error: readErr } = await db
      .from(TABLE)
      .select('payment_id')
      .eq('ref_type', refType)
      .eq('ref_value', refValue)
      .maybeSingle();
    if (readErr) throw new Error('Could not read existing reference claim.');
    if (data && String(data.payment_id) === String(paymentId)) return { ok: true, resumed: true };
    return { ok: false, conflictPaymentId: data ? String(data.payment_id) : '' };
  }
  throw new Error('Reference claim insert failed.');
}

/**
 * Claim the Transaction ID and the UTR for one payment, atomically per row.
 * If the UTR claim conflicts after the transaction claim succeeded, the
 * transaction claim is released again (it was only taken for this attempt),
 * unless the claim already belonged to this payment.
 */
async function claimReferences({ paymentId, transactionId, utr }) {
  const db = client();
  if (!db) return { status: 'unavailable', reason: 'Supabase is not configured.' };
  const txn = cleanRef(transactionId);
  const ref = cleanRef(utr);
  if (!txn || !ref) return { status: 'conflict', reason: 'Transaction ID and UTR are both required.' };

  try {
    const t = await insertClaim(db, TYPES.transaction, txn, paymentId);
    if (!t.ok) return { status: 'conflict', reason: `Transaction ${txn} already settled payment ${t.conflictPaymentId}.`, conflictPaymentId: t.conflictPaymentId };

    const u = await insertClaim(db, TYPES.utr, ref, paymentId);
    if (!u.ok) {
      // Only undo the transaction claim this attempt created.
      if (!t.resumed) await releaseClaim({ paymentId, refType: TYPES.transaction, refValue: txn });
      return { status: 'conflict', reason: `UTR ${ref} already settled payment ${u.conflictPaymentId}.`, conflictPaymentId: u.conflictPaymentId };
    }
    return { status: 'claimed', resumed: Boolean(t.resumed && u.resumed) };
  } catch (e) {
    return { status: 'unavailable', reason: e.message };
  }
}

/**
 * Release the claims held by one payment. Used ONLY when the coupon was
 * provably NOT sold to that payment (so no purchase exists to protect).
 * Matches on payment_id, so it can never remove another payment's claim.
 */
async function releaseClaim({ paymentId, refType, refValue }) {
  const db = client();
  if (!db) return false;
  const { error } = await db
    .from(TABLE)
    .delete()
    .eq('payment_id', String(paymentId))
    .eq('ref_type', refType)
    .eq('ref_value', refValue);
  return !error;
}

/**
 * Read which payment holds a reference. Used by recovery to decide between
 * "resume" and "release" without guessing.
 */
async function holderOf({ refType, refValue }) {
  const db = client();
  if (!db) return null;
  const { data, error } = await db
    .from(TABLE)
    .select('payment_id')
    .eq('ref_type', refType)
    .eq('ref_value', cleanRef(refValue))
    .maybeSingle();
  if (error) throw new Error('Could not read reference claim.');
  return data ? String(data.payment_id) : null;
}

module.exports = {
  TABLE,
  TYPES,
  claimReferences,
  releaseClaim,
  holderOf,
};
