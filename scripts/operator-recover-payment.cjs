// One-off operator recovery for a verified-but-unsettled payment.
// Runs the SAME steps as POST /api/payment/admin/recover/:paymentId (the
// endpoint that ships with this change), including the SecurityAudit row.
//
// The amount, Transaction ID and UTR are NEVER taken from the command line:
// they come from the notification the system recorded, or — for rows written
// before references were persisted — are re-derived from the original FamApp
// message in the payment mailbox. Every trust/amount/window gate is re-applied.
//
// Usage: node scripts/operator-recover-payment.cjs <paymentId> <reason> [--commit]
require('dotenv').config({ quiet: true });
const { v4: uuidv4 } = require('uuid');
const db = require('../server/services/googleSheets');
const store = require('../server/services/paymentStore');
const verifier = require('../server/services/paymentVerifier');

const COMMIT = process.argv.includes('--commit');
const paymentId = String(process.argv[2] || '').trim();
const reason = String(process.argv.slice(3).filter((a) => a !== '--commit').join(' ')).trim();
const ACTING_ADMIN = process.env.RECOVERY_ACTOR || 'operator-cli';

function fail(msg) { console.error('ABORT: ' + msg); process.exit(1); }
if (!paymentId) fail('a payment id is required');
if (reason.length < 8) fail('a reason of 8+ characters is required for the audit log');

async function audit(outcome, detail) {
  try {
    await db.appendRow(db.SHEETS.SECURITY_AUDIT, {
      id: uuidv4(), userId: '', email: ACTING_ADMIN,
      event: 'payment_admin_recovery', outcome,
      ipAddress: 'local-cli', device: 'operator-recover-payment',
      detail: `payment=${paymentId} reason=${reason} ${detail}`.slice(0, 400),
      createdAt: new Date().toISOString(),
    });
  } catch (e) { console.error('audit write failed:', e.message); }
}

(async () => {
  await db.initialize();
  const ready = await store.ensureReady();
  if (!ready.ok) fail('storage unavailable: ' + ready.reason);

  const payment = await store.findPaymentById(paymentId);
  if (!payment) fail('payment not found: ' + paymentId);
  console.log(`payment : ${payment.paymentId}  status=${payment.status}  ₹${payment.amount}`);
  console.log(`coupon  : ${payment.couponId}  window closes ${payment.paymentExpiresAt || payment.expiresAt}`);
  console.log(`created : ${payment.createdAt}`);
  console.log(`MODE    : ${COMMIT ? 'COMMIT (will write)' : 'DRY RUN (no writes)'}`);

  if (payment.status === 'PAID') {
    await audit('ALREADY_PAID', 'no action needed');
    console.log('\nAlready PAID — nothing to do (idempotent).');
    process.exit(0);
  }
  if (payment.status !== 'PENDING') fail(`payment is ${payment.status}, not PENDING — not recoverable`);

  // 1) Evidence recorded directly on the notification row.
  let evidence = await store.findSettlementEvidence(payment);
  let source = 'notification';
  let sourceNotificationId = (evidence && evidence.id) || '';
  console.log(`\nstep 1  recorded evidence: ${evidence ? 'found' : 'none'}`);

  // 2) Otherwise re-read the original FamApp message.
  if (!evidence) {
    const candidates = await store.findRecordedCreditsForPayment(payment);
    console.log(`step 2  candidate notification rows: ${candidates.length}`);
    for (const c of candidates) {
      let derived = null;
      try { derived = await verifier.reDeriveEvidence(c, payment); } catch (e) { console.log(`        row ${c.id}: re-read error ${e.message}`); }
      if (derived && derived.transactionId && derived.utr) {
        evidence = derived; source = 'mailbox_reverify'; sourceNotificationId = c.id;
        console.log(`        row ${c.id}: RE-VERIFIED from the original FamApp message`);
        break;
      }
      console.log(`        row ${c.id}: did not re-derive usable evidence`);
    }
  }

  if (!evidence) {
    // A dry run must leave the audit log untouched — it writes nothing at all.
    if (COMMIT) await audit('NO_EVIDENCE', 'no verifiable credit found');
    fail('no verified credit matches this payment amount inside its payment window — NOT settling');
  }

  console.log(`\nevidence (${source}):`);
  console.log(`  transaction id : ${evidence.transactionId}`);
  console.log(`  utr            : ${evidence.utr}`);
  console.log(`  amount         : ₹${evidence.amount}`);
  console.log(`  transaction at : ${evidence.transactionAt || evidence.occurredAt}`);

  if (!COMMIT) {
    console.log('\nDRY RUN complete — nothing was written. Re-run with --commit to settle.');
    process.exit(0);
  }

  const result = await store.finalizePayment({
    paymentId,
    transactionId: evidence.transactionId,
    utr: evidence.utr,
    source: 'admin_recovery',
    notes: `Operator recovery (${source}): ${reason}`,
    paidAt: evidence.occurredAt || evidence.transactionAt,
    transactionAt: evidence.transactionAt || evidence.occurredAt,
    receivedAmount: evidence.amount,
  });

  await audit(result && result.ok ? 'SETTLED' : 'REFUSED',
    `source=${source} code=${(result && result.code) || 'UNKNOWN'}`);

  if (!result || !result.ok) {
    console.error('\nREFUSED:', JSON.stringify(result));
    process.exit(1);
  }

  // Close the loop in the notification inbox, so a settled payment is not left
  // sitting next to a REVIEW row that a later scan would try to settle again.
  if (sourceNotificationId) {
    try {
      await store.updateNotification(sourceNotificationId, {
        status: 'MATCHED',
        matched_payment_id: paymentId,
        transaction_id: evidence.transactionId,
        utr: evidence.utr,
        notes: `Recovered by admin recovery (${source}); payment ${paymentId} settled (${result.code}).`,
      });
      console.log(`notification ${sourceNotificationId} marked MATCHED`);
    } catch (e) { console.error('notification update notice:', e.message); }
  }

  const after = await store.findPaymentById(paymentId);
  const coupon = await store.readCoupon(payment.couponId);
  console.log('\nSETTLED.');
  console.log(`  payment status : ${after.status}`);
  console.log(`  coupon code    : ${(coupon && coupon.code) || ''}`);
  console.log(`  coupon status  : ${(coupon && coupon.status) || ''}`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });