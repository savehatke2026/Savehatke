// ============================================
// SaveHatke — Missing payout-method reminder
// ============================================
// When a seller's coupon is approved and becomes payout-eligible but the seller
// has no complete payout method, send ONE email asking them to add one.
//
// Source of truth: the SellerPayoutDetails sheet tab (keyed by sellerEmail). This
// module never stores payment details of its own. The only state it writes is the
// notification row in Supabase table seller_payout_method_notifications, whose
// primary key (seller_email) makes the claim atomic.
//
// Rules:
//  - A missing/unreadable sheet is NOT treated as "missing details": we skip and
//    let a later trigger retry.
//  - Details are re-read immediately before sending; if they are now complete the
//    pending send is cancelled.
//  - A row is marked 'sent' only after the mail provider accepts the message.
//  - Payment details, the payout id and the seller's payout destination never go
//    into logs or the email body.

const db = require('./googleSheets');
const supabase = require('./supabase');
const emailService = require('./emailService');
const { payoutDetailsComplete } = require('../routes/payouts');

const TABLE = 'seller_payout_method_notifications';
const MAX_ATTEMPTS = 5;

const normEmail = (e) => String(e || '').toLowerCase().trim();

/**
 * Reads the seller's payout details from the sheet, strictly. Throws when the
 * sheet cannot be read or verified, so the caller never guesses "missing".
 * Returns { complete: boolean }.
 */
async function readPayoutMethodStatus(sellerEmail) {
  const email = normEmail(sellerEmail);
  if (!email) throw new Error('seller email required');
  const rows = await db.getRowsFresh(db.SHEETS.SELLER_PAYOUT_DETAILS, { strict: true });
  const row = rows.find((r) => normEmail(r.sellerEmail) === email) || null;
  return { complete: payoutDetailsComplete(row) };
}

function requireClient() {
  const client = supabase.getClient();
  if (!client) throw new Error('Supabase not configured');
  return client;
}

/**
 * Atomically claims the notification for a seller. Returns true only for the
 * caller that inserted the row, or that re-claims a previously failed row.
 * A row already 'claimed' (in flight) or 'sent' blocks a second claim.
 */
async function claimNotification(sellerEmail) {
  const client = requireClient();
  const email = normEmail(sellerEmail);

  const { data: inserted, error: insErr } = await client
    .from(TABLE)
    .insert({ seller_email: email, status: 'claimed', attempts: 1, last_attempt_at: new Date().toISOString() })
    .select('seller_email')
    .maybeSingle();
  if (!insErr && inserted) return true;
  if (insErr && insErr.code !== '23505') throw new Error('notification claim failed');

  // Row exists. Only a 'failed' row with attempts left may be re-claimed, and the
  // update is conditional on the status we read, so two retries cannot both win.
  const { data: existing, error: selErr } = await client
    .from(TABLE)
    .select('status, attempts')
    .eq('seller_email', email)
    .maybeSingle();
  if (selErr) throw new Error('notification claim failed');
  if (!existing || existing.status !== 'failed' || existing.attempts >= MAX_ATTEMPTS) return false;

  const { data: reclaimed, error: upErr } = await client
    .from(TABLE)
    .update({
      status: 'claimed',
      attempts: existing.attempts + 1,
      last_attempt_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('seller_email', email)
    .eq('status', 'failed')
    .eq('attempts', existing.attempts)
    .select('seller_email')
    .maybeSingle();
  if (upErr) throw new Error('notification claim failed');
  return Boolean(reclaimed);
}

async function markNotification(sellerEmail, patch) {
  const client = requireClient();
  const { error } = await client
    .from(TABLE)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('seller_email', normEmail(sellerEmail));
  if (error) console.error('[payoutMethodReminder] could not record state:', error.message);
}

/**
 * Called after a seller coupon is approved. Never throws to the caller: the
 * approval is already saved, and this is a best-effort notification that retries
 * on a later trigger. Returns a short status string for logs/tests.
 */
async function maybeSendMissingPayoutMethodEmail({ sellerEmail, sellerName = '' } = {}) {
  const email = normEmail(sellerEmail);
  if (!email) return 'skipped:no-email';

  if (!supabase.isConfigured()) return 'skipped:no-claim-store';

  try {
    // 1. Verify the sheet. Any failure here means "unknown", so do nothing.
    let status;
    try {
      status = await readPayoutMethodStatus(email);
    } catch (err) {
      console.warn('[payoutMethodReminder] payout details could not be verified; will retry later.');
      return 'deferred:sheets-unavailable';
    }
    if (status.complete) return 'skipped:payout-method-present';

    // 2. Claim atomically. Losers of a race (or repeat triggers) stop here.
    let claimed;
    try {
      claimed = await claimNotification(email);
    } catch (err) {
      console.warn('[payoutMethodReminder] claim unavailable; will retry later.');
      return 'deferred:claim-unavailable';
    }
    if (!claimed) return 'skipped:already-notified';

    // 3. Recheck immediately before sending: the seller may have just saved details.
    try {
      status = await readPayoutMethodStatus(email);
    } catch (err) {
      await markNotification(email, { status: 'failed', last_error: 'recheck unavailable' });
      return 'deferred:recheck-unavailable';
    }
    if (status.complete) {
      await markNotification(email, { status: 'failed', last_error: 'cancelled: payout method added before send' });
      return 'cancelled:payout-method-added';
    }

    // 4. Send. The row becomes 'sent' only after the provider accepts the message.
    let result;
    try {
      result = await emailService.sendPayoutMethodReminderEmail({ to: email, sellerName });
    } catch (err) {
      result = { success: false, error: err && err.message };
    }
    if (result && result.success) {
      await markNotification(email, {
        status: 'sent',
        sent_at: new Date().toISOString(),
        last_error: '',
        provider_message_id: String(result.messageId || '').slice(0, 200),
      });
      return 'sent';
    }
    await markNotification(email, { status: 'failed', last_error: String((result && result.error) || 'send failed').slice(0, 300) });
    return 'failed:provider';
  } catch (err) {
    console.error('[payoutMethodReminder] unexpected error:', err && err.message);
    return 'failed:unexpected';
  }
}

module.exports = { maybeSendMissingPayoutMethodEmail, readPayoutMethodStatus, claimNotification };
