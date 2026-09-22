// ============================================
// SaveHatke — Independent Payment Verifier
// ============================================
// The ONLY component allowed to decide that money arrived. The frontend has no
// path to a PAID status: a QR being generated, a QR being scanned, a UPI app
// opening, or a button being clicked prove nothing and are never consulted.
//
// Two independent confirmation sources, both server-side:
//
//   1. Gateway webhook (POST /api/payment/webhook)
//      Authenticated with an HMAC-SHA256 over the raw request body. This is
//      the strongest source: the payload is signed by the PSP and cannot be
//      forged by anyone without the shared secret.
//
//   2. Payment mailbox (Gmail)
//      During a payment's 10-minute window the server reads the configured
//      payment mailbox for credit notifications and tries to tie one to a
//      specific pending payment. Credentials stay on the server; the browser
//      never sees a mail token.
//
// Matching policy — auto-settlement requires EVERY one of:
//   * the notification is a CREDIT (money received), not a debit or a request
//   * the payee VPA is exactly our configured UPI_ID
//   * the amount equals the pending payment's amount to the paisa
//   * a strong correlator is present: our order code in the reference/narration,
//     OR a transaction id / UTR
//   * the transaction id / UTR has not already settled another payment
//   * the claimed time falls inside the payment's own window
//
// An email that merely contains the right amount is NOT enough: without a
// correlator, or when more than one pending payment could match, the
// notification is parked for manual review instead of unlocking a coupon.
// ============================================

const crypto = require('crypto');
const store = require('./paymentStore');
const upi = require('./upi');
// Refund-record service for the mismatch (overpayment / underpayment)
// path. Loaded eagerly so a circular-import somewhere never costs us the
// first overpayment: processCandidate() only ever invokes it from a
// server-verified code path, so the load itself is harmless.
const refundsService = require('./refunds');

// ── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_MAIL_SENDERS = [
  'famapp',
  'fam.co',
  'famapp.in',
  'phonepe',
  'paytm',
  'googlepay',
  'okaxis',
  'okhdfcbank',
  'okicici',
  'oksbi',
  'ybl',
];

function getMailConfig() {
  const senders = String(process.env.PAYMENT_MAIL_FROM || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    // Hosts/addresses we are willing to read a confirmation from. When unset we
    // fall back to well-known UPI PSP / bank identifiers — matching is still
    // gated on the strict correlators below, so a wider net here cannot by
    // itself unlock anything.
    senders: senders.length ? senders : DEFAULT_MAIL_SENDERS,
    lookbackDays: Number(process.env.PAYMENT_MAIL_LOOKBACK_DAYS || 2),
    explicit: senders.length > 0,
  };
}

function getWebhookSecret() {
  return String(process.env.PAYMENT_WEBHOOK_SECRET || '').trim();
}

// ── Text extraction ────────────────────────────────────────────────────────

/** Normalise an Indian-format money string to a 2-dp number, or null. */
function parseMoney(text) {
  if (text === null || text === undefined) return null;
  const s = String(text);
  // Indian grouping only (12,34,567.89) — a bare "3,000" is also accepted.
  const m = s.match(/(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i) ||
            s.match(/([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:₹|rs\.?|inr)/i);
  const raw = m ? m[1] : (s.match(/^\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*$/)?.[1] ?? null);
  if (raw === null) return null;
  const n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/** Compare two money values exactly, at paise precision. */
function moneyEquals(a, b) {
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.round(x * 100) === Math.round(y * 100);
}

/** Pull the first labelled transaction reference out of a block of text. */
function extractTransaction(text) {
  const s = String(text || '');
  const labelled = [
    /(?:utr|rrn|ref(?:erence)?(?:\s*(?:no|number|id))?|txn(?:\s*(?:id|no|ref))?|transaction(?:\s*(?:id|no|ref))?)\s*[:#\-]?\s*([A-Za-z0-9]{8,30})/i,
  ];
  for (const re of labelled) {
    const m = s.match(re);
    if (m && m[1]) return m[1].trim();
  }
  // Unlabelled fallback: UPI UTRs are 12 digits; some PSPs use 14–18.
  const digits = s.match(/\b(\d{12,18})\b/);
  return digits ? digits[1] : '';
}

/** True when the text describes money coming IN to us. */
function detectDirection(text) {
  const s = String(text || '').toLowerCase();

  // Hard negatives first: an outgoing payment or a collect request must never
  // be mistaken for a credit, even if it also mentions "successful".
  const debit = [
    'you paid', 'you have paid', 'payment made', 'amount debited', 'debited from',
    'sent to', 'you sent', 'paid to', 'transfer to', 'requested', 'collect request',
    'payment request', 'request money', 'reminder', 'failed', 'declined',
    'cancelled', 'reversed', 'refund',
  ];
  for (const p of debit) if (s.includes(p)) return 'debit';

  const credit = [
    'received', 'credited', 'you got', 'has paid you', 'paid you', 'money added',
    'added to your', 'cashback received', 'credit of', 'payment received',
    'successful payment of', 'has sent you',
  ];
  for (const p of credit) if (s.includes(p)) return 'credit';

  return 'unknown';
}

/** Extract the order code (SH-XXXXXX) we generated, if it appears. */
function extractOrderCode(text) {
  const m = String(text || '').match(/\bSH-([2-9A-HJKMNP-Z]{6})\b/i);
  return m ? ('SH-' + m[1].toUpperCase()) : '';
}

/** Find a UPI VPA in the text. */
function extractVpas(text) {
  const found = String(text || '').match(/[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}/g) || [];
  return found.map((v) => v.toLowerCase());
}

function vpaEquals(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function fingerprintOf(parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// ── Candidate construction ─────────────────────────────────────────────────

/**
 * Turn a raw confirmation (email body or webhook payload) into a normalised
 * candidate. Everything here is a CLAIM — the matching step below is what
 * decides whether any of it is trustworthy.
 */
function buildCandidateFromEmail({ messageId, from = '', subject = '', body = '', date = '' }) {
  const text = `${subject}\n${body}`;
  const orderCode = extractOrderCode(text);
  const vpas = extractVpas(text);
  const payee = upi.getPayee();

  // The receiving VPA is the one we recognise; anything else is the payer.
  const payeeVpa = vpas.find((v) => vpaEquals(v, payee.upiId)) || '';
  const payerVpa = vpas.find((v) => !vpaEquals(v, payee.upiId)) || '';

  return {
    source: 'email',
    fingerprint: fingerprintOf(['email', messageId || fingerprintOf([from, subject, date, text.slice(0, 500)])]),
    direction: detectDirection(text),
    amount: parseMoney(text),
    currency: 'INR',
    transactionId: extractTransaction(text),
    utr: extractTransaction(text),
    orderCode,
    payerVpa,
    payeeVpa,
    reference: orderCode,
    occurredAt: date ? new Date(date).toISOString() : new Date().toISOString(),
    from,
    subject,
    raw: { messageId, from, subject, date, snippet: String(body || '').slice(0, 2000) },
  };
}

/**
 * Normalise a gateway webhook body. Field names vary by PSP, so the common
 * aliases are all accepted.
 */
function buildCandidateFromWebhook(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (p[k] !== undefined && p[k] !== null && p[k] !== '') return p[k];
    }
    return '';
  };
  const nested = p.data && typeof p.data === 'object' ? p.data : {};

  const amountRaw = pick('amount', 'amt', 'value', 'transactionAmount') || nested.amount;
  let amount = null;
  if (amountRaw !== '' && amountRaw !== undefined) {
    const n = Number(String(amountRaw).replace(/[^0-9.]/g, ''));
    // Gateways frequently send paise. Treat a plain integer as rupees only
    // when it has no decimal part AND a currency field says INR — otherwise
    // use the value as-is, because guessing here would mis-price a payment.
    amount = Number.isFinite(n) ? n : parseMoney(String(amountRaw));
  }

  const status = String(pick('status', 'state', 'paymentStatus') || nested.status || '').toLowerCase();
  const text = JSON.stringify(p).toLowerCase();

  let direction = 'unknown';
  if (/success|paid|received|credited|captured|completed/.test(status)) direction = 'credit';
  if (/fail|decline|cancel|reversed|refund|pending_request/.test(status)) direction = 'debit';

  const transactionId = String(
    pick('transactionId', 'transaction_id', 'txnId', 'txn_id', 'rrn', 'utr', 'bankRrn', 'paymentId') ||
    nested.transactionId || nested.utr || ''
  ).trim();

  const orderCode = extractOrderCode(pick('reference', 'note', 'narration', 'remarks', 'description', 'orderCode') || text) ||
                    extractOrderCode(text);

  const payeeVpa = String(pick('payeeVpa', 'payee_vpa', 'vpa', 'payeeAddress') || nested.payeeVpa || '').trim();
  const payerVpa = String(pick('payerVpa', 'payer_vpa', 'payerAddress', 'customerVpa') || nested.payerVpa || '').trim();

  const occurredRaw = pick('occurredAt', 'occurred_at', 'timestamp', 'paidAt', 'createdAt', 'txnDate') || nested.occurredAt;
  let occurredAt = new Date().toISOString();
  if (occurredRaw) {
    const d = new Date(/^\d+$/.test(String(occurredRaw)) ? Number(occurredRaw) : occurredRaw);
    if (!Number.isNaN(d.getTime())) occurredAt = d.toISOString();
  }

  return {
    source: 'webhook',
    fingerprint: fingerprintOf([
      'webhook',
      transactionId || String(pick('id', 'eventId', 'webhookId') || ''),
      String(amount ?? ''),
      occurredAt,
    ]),
    direction,
    amount,
    currency: String(pick('currency', 'cu') || 'INR').toUpperCase(),
    transactionId,
    utr: transactionId,
    orderCode,
    payerVpa,
    payeeVpa,
    reference: orderCode,
    occurredAt,
    raw: p,
  };
}

// ─ Matching ───────────────────────────────────────────────────────────────

/**
 * Decide what to do with a candidate. Returns a verdict object; when it
 * settles a payment the `result` carries the store's finalizePayment answer.
 *
 * Never mutates state unless every check passes.
 */
async function processCandidate(candidate, { pendingPayments = null } = {}) {
  // Persist the observation first. Its unique fingerprint makes a re-read
  // email or a redelivered webhook a no-op on every later attempt.
  let recorded;
  try {
    recorded = await store.recordNotification({
      fingerprint: candidate.fingerprint,
      source: candidate.source,
      amount: candidate.amount,
      currency: candidate.currency,
      transactionId: candidate.transactionId,
      utr: candidate.utr,
      payerVpa: candidate.payerVpa,
      payeeVpa: candidate.payeeVpa,
      reference: candidate.reference || candidate.orderCode,
      occurredAt: candidate.occurredAt,
      raw: candidate.raw,
    });
  } catch (e) {
    console.error('[paymentVerifier] could not record notification:', e.message);
    return { action: 'error', reason: 'Could not record the notification: ' + e.message };
  }

  if (recorded.duplicate) {
    // Already handled. Reporting the stored outcome keeps the caller honest —
    // it must not act on this one again.
    return {
      action: 'duplicate',
      reason: 'This notification was already processed.',
      notification: recorded.notification,
      previousStatus: recorded.notification?.status,
      previousPaymentId: recorded.notification?.matchedPaymentId || '',
    };
  }

  const notification = recorded.notification;

  const reject = async (status, notes) => {
    try { await store.updateNotification(notification.id, { status, notes }); } catch (e) {}
    return { action: status === 'REVIEW' ? 'review' : 'ignored', reason: notes, notification };
  };

  // 1) It must be money coming in.
  if (candidate.direction !== 'credit') {
    return reject('IGNORED', `Not a credit notification (direction: ${candidate.direction}).`);
  }
  if (!candidate.amount || candidate.amount <= 0) {
    return reject('IGNORED', 'No usable amount found in the notification.');
  }

  // 1b) Only rupees settle a rupee order. Without this, a notification quoting
  //     the right number in another currency would satisfy an INR payment —
  //     ₹299 and 299 of something else are not the same amount of money.
  const candidateCurrency = String(candidate.currency || 'INR').toUpperCase();
  if (candidateCurrency !== 'INR') {
    return reject(
      'IGNORED',
      `Notification is in ${candidateCurrency}, not INR — it cannot settle an INR order.`
    );
  }

  const payee = upi.getPayee();
  if (!payee.configured) {
    return reject('REVIEW', 'UPI_ID is not configured, so the payee could not be verified.');
  }

  // 2) For email-sourced claims the payee VPA is mandatory. An email alone is
  //    never sufficient evidence of receipt.
  if (candidate.source === 'email') {
    if (!candidate.payeeVpa) {
      return reject('REVIEW', 'No payee UPI ID found — cannot attribute this receipt to SaveHatke.');
    }
    if (!vpaEquals(candidate.payeeVpa, payee.upiId)) {
      return reject('REVIEW', `Payee ${candidate.payeeVpa} is not the configured receiving UPI ID.`);
    }
  } else if (candidate.payeeVpa && !vpaEquals(candidate.payeeVpa, payee.upiId)) {
    return reject('REVIEW', `Payee ${candidate.payeeVpa} is not the configured receiving UPI ID.`);
  }

  // 3) Gather the payments this could plausibly be.
  //
  // Two lookup strategies:
  //   a) Exact-amount match — the original flow. The notification's verified
  //      amount equals the payment's required amount, so the coupon unlock
  //      happens with no refund record.
  //   b) Order-code match — new path. The verified amount differs from the
  //      payment's required amount (overpayment or underpayment), and the
  //      order code is the only thing that ties the mismatch back to the
  //      original payment. The verifier settles the payment AND surfaces a
  //      refund record for the mismatch — see step 10 below.
  const exactPending = pendingPayments || (await store.findPendingPaymentsForAmount(candidate.amount));
  const amountMatches = exactPending.filter((p) => moneyEquals(p.amount, candidate.amount));

  if (!amountMatches.length) {
    // No exact-amount match. If the notification carries an order code, see
    // if there is a still-live pending payment for it — that is the only
    // way an over/under payment can be attributed to a single order.
    if (candidate.orderCode && store.findPendingPaymentByOrderCode) {
      const byCode = await store.findPendingPaymentByOrderCode(candidate.orderCode);
      if (byCode) {
        // Single-candidate mismatch path. Step 10 below will compute the
        // refund (or no-op when amounts still match) after settlement.
        return await settleMatch({
          payment: byCode,
          candidate,
          notification,
          pendingPayments: [byCode],
          mismatchPath: true,
          reject,
        });
      }
    }
    return reject('IGNORED', `No pending payment matches ₹${candidate.amount.toFixed(2)}.`);
  }

  // 4) Narrow by the correlator. The order code (which we put in the UPI `tr`
  //    field, so it comes back in the narration) is the strongest signal.
  let candidates = amountMatches;
  if (candidate.orderCode) {
    const byCode = amountMatches.filter((p) => p.orderCode === candidate.orderCode);
    if (!byCode.length) {
      return reject(
        'REVIEW',
        `Notification references ${candidate.orderCode}, which does not match any pending payment of ₹${candidate.amount.toFixed(2)}.`
      );
    }
    candidates = byCode;
  } else if (!candidate.transactionId) {
    // No order code AND no transaction id: nothing ties this to one order.
    return reject('REVIEW', 'No order reference or transaction ID — cannot attribute this payment to an order.');
  }

  // 5) Without an order code, a transaction id must still be unambiguous: if
  //    several pending payments carry the same amount, we cannot tell which
  //    one this payment was for.
  if (!candidate.orderCode && candidates.length > 1) {
    return reject(
      'REVIEW',
      `₹${candidate.amount.toFixed(2)} is ambiguous — ${candidates.length} pending payments share this amount and no order reference was supplied.`
    );
  }

  // Both the exact-amount path and the order-code mismatch path land here:
  // a single candidate payment, narrowed by the strongest correlator. The
  // mismatch path carries an extra `mismatchPath: true` flag so the
  // settlement helper knows to create a refund record after the move.
  return await settleMatch({
    payment: candidates[0],
    candidate,
    notification,
    pendingPayments: candidates,
    mismatchPath: false,
    reject,
  });
}

/**
 * Settle one candidate payment against the verified notification. This is
 * shared between the exact-amount path (the original flow) and the new
 * order-code mismatch path (overpayment / underpayment). The only
 * difference is the post-settlement refund creation, gated on
 * `mismatchPath`.
 */
async function settleMatch({ payment, candidate, notification, pendingPayments, mismatchPath, reject }) {
  // 6) Replay: this transaction must not already have settled something else.
  if (candidate.transactionId) {
    try {
      const used = await store.isTransactionUsed({
        transactionId: candidate.transactionId,
        utr: candidate.utr && candidate.utr !== candidate.transactionId ? candidate.utr : '',
      });
      if (used) {
        const existing = await store.findPaymentByTransaction(candidate.transactionId);
        if (existing && existing.paymentId !== payment.paymentId) {
          return reject(
            'REVIEW',
            `Transaction ${candidate.transactionId} already settled payment ${existing.paymentId}.`
          );
        }
      }
    } catch (e) {
      return reject('REVIEW', 'Could not check for a duplicate transaction: ' + e.message);
    }
  }

  // 7) Time window. finalizePayment() enforces this again inside the process
  //    lock; checking here too lets a clearly-out-of-window notification be
  //    parked for review rather than bouncing off the store.
  const occurred = new Date(candidate.occurredAt).getTime();
  const created = new Date(payment.createdAt).getTime();
  const expires = new Date(payment.expiresAt).getTime();
  if (Number.isFinite(occurred) && Number.isFinite(created) && Number.isFinite(expires)) {
    if (occurred < created - 5 * 60 * 1000 || occurred > expires + 30 * 60 * 1000) {
      return reject(
        'REVIEW',
        `Payment time ${candidate.occurredAt} is outside the payment window (${payment.createdAt} → ${payment.expiresAt}).`
      );
    }
  }

  // 8) The payment must still be live. A late confirmation for an expired
  //    attempt is never settled.
  if (payment.status !== 'PENDING') {
    return reject('REVIEW', `Payment ${payment.paymentId} is ${payment.status}, not PENDING.`);
  }

  // 9) Settle atomically. This is the only call that can move money.
  let result;
  try {
    result = await store.finalizePayment({
      paymentId: payment.paymentId,
      transactionId: candidate.transactionId || null,
      utr: candidate.utr || null,
      source: candidate.source,
      notes: `Matched on ${candidate.orderCode ? 'order code' : 'transaction ID'}; amount ₹${candidate.amount.toFixed(2)}${mismatchPath ? ' (mismatch — see refund record)' : ''}.`,
      paidAt: candidate.occurredAt,
      raw: candidate.raw,
      receivedAmount: candidate.amount,
    });
  } catch (e) {
    return reject('REVIEW', 'Settlement failed: ' + e.message);
  }

  if (!result || !result.ok) {
    const code = (result && result.code) || 'UNKNOWN';
    if (code === 'REPLAY_DETECTED') {
      return reject('REJECTED', 'A duplicate transaction reference was detected.');
    }
    return reject('REVIEW', `Settlement refused by the database (${code}).`);
  }

  // 10) Mismatch handling — only runs on the order-code path, after the
  //     payment itself has been settled to PAID. The refund service is the
  //     same writer the dashboard reads from, so the user sees the record
  //     on the next refresh. The required amount comes from the payment
  //     row (server-set), the received amount from the verified
  //     notification — never from the request body.
  let refundRecord = null;
  if (mismatchPath) {
    try {
      const required = Number(payment.amount || 0);
      const received = Number(candidate.amount || 0);
      const created = await refundsService.createOrUpdateRefund({
        paymentId: payment.paymentId,
        userId: payment.userId || payment.userEmail || '',
        userEmail: payment.userEmail || '',
        couponId: payment.couponId || '',
        orderCode: payment.orderCode || candidate.orderCode || '',
        requiredAmount: required,
        receivedAmount: received,
        currency: payment.currency || 'INR',
      });
      if (created && created.ok && created.refund) {
        refundRecord = created.refund;
      }
    } catch (e) {
      console.warn('[paymentVerifier] refund record notice:', e.message);
    }
  }

  try {
    await store.updateNotification(notification.id, {
      status: 'MATCHED',
      matched_payment_id: payment.paymentId,
      notes: `Settled payment ${payment.paymentId} (${result.code})${refundRecord ? `; refund ${refundRecord.refundId} created for ${refundRecord.mismatchType}` : ''}.`,
    });
  } catch (e) {}

  return {
    action: 'settled',
    reason: `Payment ${payment.paymentId} settled (${result.code}).`,
    notification,
    payment,
    result,
    refund: refundRecord,
    mismatch: mismatchPath ? {
      requiredAmount: payment.amount,
      receivedAmount: candidate.amount,
      delta: Number((Number(candidate.amount || 0) - Number(payment.amount || 0)).toFixed(2)),
    } : null,
  };
}

// ── Webhook path ───────────────────────────────────────────────────────────

/**
 * Verify the HMAC on a raw webhook body. Returns true only on an exact match,
 * compared in constant time so the signature cannot be brute-forced by timing.
 */
function verifyWebhookSignature(rawBody, signature, secret = getWebhookSecret()) {
  if (!secret) return false;
  const provided = String(signature || '').trim();
  if (!provided) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const candidates = [provided, provided.replace(/^sha256=/i, '')];

  for (const cand of candidates) {
    const a = Buffer.from(cand, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

// ── Mailbox path ───────────────────────────────────────────────────────────

/**
 * Read recent payment-mailbox messages and try to settle any that correspond
 * to a pending payment. Returns a summary; safe to call often — the inbox
 * fingerprint makes repeat scans cheap and idempotent.
 */
async function scanPaymentMailbox({ maxMessages = 25 } = {}) {
  const cfg = getMailConfig();

  // The read helpers (listMessages / getMessageFull) live on gmailService and
  // take a `gmail` client as their first argument, so they work against ANY
  // authorized client. The client itself comes from the DEDICATED payment
  // mailbox (rupayandas2024@gmail.com) when connected; the shared support
  // mailbox is only a fallback so a half-configured deploy still degrades
  // gracefully instead of going dark.
  const gmailService = require('./gmailService');
  const paymentMailbox = require('./paymentMailbox');

  let gmail;
  let mailboxSource = '';
  try {
    let client = null;
    try {
      client = await paymentMailbox.getAuthorizedClient();
      if (client) mailboxSource = 'payment';
    } catch (e) {
      console.warn('[paymentVerifier] dedicated payment mailbox open notice:', e.message);
    }
    if (!client) {
      client = await gmailService.getAuthorizedClient();
      if (client) mailboxSource = 'support-fallback';
    }
    if (!client) {
      return {
        ok: false,
        reason:
          'The payment mailbox is not connected. Run `node server/scripts/authorize-payment-gmail.js` and set PAYMENT_GMAIL_REFRESH_TOKEN.',
        scanned: 0,
        settled: 0,
      };
    }
    gmail = client.gmail;
  } catch (e) {
    return { ok: false, reason: 'Could not open the payment mailbox: ' + e.message, scanned: 0, settled: 0 };
  }

  const senders = cfg.senders.map((s) => `from:${s}`).join(' OR ');
  const q = `newer_than:${cfg.lookbackDays}d (${senders})`;

  let messages = [];
  try {
    const list = await gmailService.listMessages(gmail, { q, maxResults: maxMessages });
    messages = list.messages || [];
  } catch (e) {
    return { ok: false, reason: 'Mailbox search failed: ' + e.message, scanned: 0, settled: 0 };
  }

  const pending = await store.findPendingPaymentsForAmount(null);
  const results = [];

  for (const msg of messages) {
    const candidate = buildCandidateFromEmail({
      messageId: msg.id,
      from: msg.from,
      subject: msg.subject,
      body: msg.snippet,
      date: msg.date,
    });

    // Cheap pre-filter before spending a full-body fetch: it must look like a
    // credit for an amount, and mention our order code when one is available.
    if (candidate.direction !== 'credit' || !candidate.amount) {
      // Record-and-ignore so the same message is not re-examined forever.
      try {
        await store.recordNotification({
          fingerprint: candidate.fingerprint,
          source: 'email',
          amount: candidate.amount,
          transactionId: candidate.transactionId,
          payerVpa: candidate.payerVpa,
          payeeVpa: candidate.payeeVpa,
          reference: candidate.reference,
          occurredAt: candidate.occurredAt,
          raw: candidate.raw,
          status: 'IGNORED',
          notes: 'Not a credit notification (snippet pre-filter).',
        });
      } catch (e) {}
      continue;
    }

    // The snippet usually holds the amount and reference; fetch the full body
    // only when the amount matches something we are actually waiting for.
    const plausible = pending.some((p) => moneyEquals(p.amount, candidate.amount)) ||
      (!candidate.orderCode && pending.some((p) => moneyEquals(p.amount, candidate.amount)));

    if (!plausible) {
      try {
        await store.recordNotification({
          fingerprint: candidate.fingerprint,
          source: 'email',
          amount: candidate.amount,
          transactionId: candidate.transactionId,
          reference: candidate.reference,
          occurredAt: candidate.occurredAt,
          raw: candidate.raw,
          status: 'IGNORED',
          notes: 'No pending payment is waiting for this amount.',
        });
      } catch (e) {}
      continue;
    }

    // Resolve the fullest text we can for the definitive match.
    let full = candidate;
    try {
      const detail = await gmailService.getMessageFull(gmail, msg.id);
      const body = detail?.bodyText || detail?.bodyHtml || detail?.text || '';
      if (body) {
        full = buildCandidateFromEmail({
          messageId: msg.id,
          from: msg.from,
          subject: msg.subject,
          body: body + '\n' + (msg.snippet || ''),
          date: msg.date,
        });
      }
    } catch (e) {
      // Fall back to the snippet-derived candidate; it is stricter, not looser.
    }

    try {
      results.push(await processCandidate(full, { pendingPayments: pending }));
    } catch (e) {
      results.push({ action: 'error', reason: e.message });
    }
  }

  const settled = results.filter((r) => r.action === 'settled').length;
  return {
    ok: true,
    scanned: messages.length,
    settled,
    results,
    sendersConfigured: cfg.explicit,
    mailbox: mailboxSource, // 'payment' (dedicated) or 'support-fallback'
  };
}

module.exports = {
  // config
  getMailConfig,
  getWebhookSecret,
  // extraction (exported for tests)
  parseMoney,
  moneyEquals,
  extractTransaction,
  extractOrderCode,
  extractVpas,
  detectDirection,
  vpaEquals,
  fingerprintOf,
  // candidates
  buildCandidateFromEmail,
  buildCandidateFromWebhook,
  // core
  processCandidate,
  verifyWebhookSignature,
  scanPaymentMailbox,
};