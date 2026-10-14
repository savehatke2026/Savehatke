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
// Matching policy has TWO independent server-side sources:
//
//   Payment mailbox (FamApp email) — the primary buyer path:
//     * the sender is EXACTLY no-reply@famapp.in (no other sender counts)
//     * the notification is a CREDIT ("successfully received")
//     * the received amount equals a live pending payment's amount to the paisa
//     * the email arrived AFTER that payment's window opened (new-email
//       checkpoint) — an old FamApp email can never settle a new order
//     * exactly ONE live session is waiting for that amount; two concurrent
//       same-amount orders are parked for review, never guessed
//     Transaction ID / UTR are NEVER extracted, stored, or used for matching.
//     Deduplication is by Gmail message id only.
//
//   Gateway webhook (POST /api/payment/webhook) — HMAC-signed PSP path, left
//   intact for gateways that post signed confirmations.
//
// An email that merely contains the right amount but predates the window, or
// is ambiguous across concurrent orders, is parked for review instead of
// unlocking a coupon.
// ============================================

const crypto = require('crypto');
const store = require('./paymentStore');
const upi = require('./upi');
const ids = require('../utils/identifiers');
// Refund-record service for the mismatch (overpayment / underpayment)
// path. Loaded eagerly so a circular-import somewhere never costs us the
// first overpayment: processCandidate() only ever invokes it from a
// server-verified code path, so the load itself is harmless.
const refundsService = require('./refunds');
// Pure payment-window rules (single T+10 deadline,
// IST transaction-time parsing, settle / late-refund / review decision).
const paymentWindow = require('./paymentWindow');
// Buyer receipt email. Sent best-effort AFTER a payment is genuinely settled;
// it never affects the settlement result (see deliverPaymentSuccessEmail).
const emailService = require('./emailService');
// Coupon lookup (Supabase first, then the Sheets mirror) for the buyer's
// "Your Coupon Details" email. Read-only; never affects settlement.
const supabase = require('./supabase');
const db = require('./googleSheets');

// ── Configuration ──────────────────────────────────────────────────────────

// FamApp is the ONLY sender SaveHatke accepts as a payment confirmation. The
// buyer's UPI credit lands in the payment mailbox as an email from this exact
// address; no bank/PSP/other sender can settle an order.
const FAMAPP_SENDER = 'no-reply@famapp.in';

function getMailConfig() {
  // The sender allow-list defaults to FamApp ONLY. PAYMENT_MAIL_FROM can
  // override it (e.g. for a staging inbox), but the shipped default is
  // FamApp-only so a stray email can never confirm a payment.
  const senders = String(process.env.PAYMENT_MAIL_FROM || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    senders: senders.length ? senders : [FAMAPP_SENDER],
    lookbackDays: Number(process.env.PAYMENT_MAIL_LOOKBACK_DAYS || 1),
    explicit: senders.length > 0,
  };
}

/** True only when an email's From is the FamApp payment-notification address. */
function isFamAppSender(from) {
  const value = String(from || '').trim().toLowerCase();
  const address = value.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/)?.[1] || value;
  return address === FAMAPP_SENDER;
}

// Gmail folders that can never hold an incoming payment confirmation.
const NON_INCOMING_LABELS = ['SENT', 'DRAFT', 'SPAM', 'TRASH'];

/**
 * True only when a FamApp message is a received (incoming) message. Sent, draft,
 * spam and trash copies are rejected. INBOX is NOT required: an archived or
 * label-filtered received notification has no INBOX label but is still real money
 * received. A message with no labels at all is still rejected (fail closed).
 */
function isIncomingInboxMessage(labels) {
  const list = Array.isArray(labels) ? labels : [];
  if (!list.length) return false;
  return !NON_INCOMING_LABELS.some((l) => list.includes(l));
}

/**
 * Gmail search for FamApp credit notifications. Sender-restricted and bounded to
 * the payment window, with no `in:inbox` filter so archived mail is still found.
 * Sent, drafts, spam and trash are excluded at the search level and again in code.
 */
function buildPaymentSearchQuery({ senders, afterSecs }) {
  const from = senders.map((s) => `from:${s}`).join(' OR ');
  return `(${from}) -in:sent -in:drafts -in:spam -in:trash after:${afterSecs}`;
}

function hasTrustedFamAppAuthentication(authenticationResults) {
  const value = String(authenticationResults || '').toLowerCase();
  // Gmail's receiving-side authentication result must establish DMARC for
  // the exact From domain. A display name or matching From string alone is not
  // payment evidence.
  return /(?:^|;\s*)dmarc=pass\b[^;]*\bheader\.from=famapp\.in\b/.test(value);
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

/**
 * Extract the RECEIVED (credited) amount from a FamApp email, preferring the
 * amount tied to "received" and explicitly ignoring "Updated Balance" so a
 * ₹2 credit that leaves a ₹5 balance is read as ₹2, never ₹5. Returns a
 * 2-dp number or null.
 */
function parseReceivedAmount(text) {
  const s = String(text || '');
  const near =
    s.match(/received[\s\S]{0,40}?(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i) ||
    s.match(/(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)[\s\S]{0,20}?received/i);
  if (near && near[1]) {
    const n = Number(near[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
  }
  // Fallback: first money in the text with the balance line removed, so the
  // "Updated Balance" figure can never be mistaken for the credit.
  return parseMoney(s.replace(/updated\s*balance[\s\S]*/i, ''));
}

/**
 * Pull the payer's name from a FamApp credit line, e.g.
 * "received ₹1.0 from Parly Das at 08:41 AM …". Returns '' when no name is
 * present, so a missing name is treated as "cannot verify", never as a match.
 *
 * Two shapes have to be handled, because the first one alone matches nothing
 * real: the plain-text FamApp email puts the payer on the line AFTER the amount
 * and terminates the name with the next labelled field ("Transaction ID: …",
 * "UTR: …"), not with a connector word. Falling back to a naive "rest of the
 * body" capture would swallow the transaction id into the name, so the capture
 * stops at a newline or at a known label.
 */
function extractPayerName(text) {
  const s = String(text || '');
  const m = s.match(/received[\s\S]{0,40}?(?:₹|rs\.?|inr)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?\s+from\s+([A-Za-z][A-Za-z .'-]{0,60}?)\s+(?:at|on|via|with|through)\b/i);
  if (m) return m[1].replace(/\s+/g, ' ').trim();

  // Real FamApp layout: "<amount>\nfrom <Name>\nTransaction ID: …".
  const line = s.match(/received[\s\S]{0,40}?(?:₹|rs\.?|inr)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?\s+from\s+([^\n\r]+)/i);
  if (!line) return '';
  const name = line[1]
    // Cut the name at the first labelled field that follows it on that line.
    .split(/\b(?:transaction\s*(?:id|no|number)|utr|rrn|date|updated\s*balance)\b/i)[0]
    .replace(/[\s.,;:'"`|]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // A name is letters (with internal spaces, dots, apostrophes, hyphens) only.
  return /^[A-Za-z][A-Za-z .'-]{0,60}$/.test(name) ? name : '';
}

/**
 * Normalise a person's name for comparison: lower-case, letters only, single
 * spaces, and each word sorted so "Das Parly" and "Parly Das" compare equal.
 * Only case, spacing, and word order are ignored — no fuzzy matching.
 */
function normalizePersonName(name) {
  const words = String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.sort().join(' ');
}

/**
 * Payer-name gate. Passes only when the name in the email equals the order's
 * buyer name after normalisation. An empty name on either side fails closed.
 */
function payerNameMatches(emailPayerName, expectedName) {
  const a = normalizePersonName(emailPayerName);
  const b = normalizePersonName(expectedName);
  if (!a || !b) return false;
  return a === b;
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

/**
 * Extract the order code we generated, if it appears in the notification text.
 * Recognises BOTH the current format (SH-PUR/REF/PAY-YYYYMMDD-XXXXXX) and the
 * legacy SH-XXXXXX code, so in-flight payments created before the id change
 * still reconcile. Delegates to the single source of truth in utils/identifiers.
 */
function extractOrderCode(text) {
  return ids.extractOrderCodeFromText(text);
}

/**
 * Pull the FamApp transaction ID from a credit notification, e.g.
 * "Transaction ID: FMPIB6772399011". Returns '' when absent or malformed, so a
 * missing ID fails closed (the candidate is parked, never settled on amount).
 * Accepts 8–30 letters/digits, the same bounds as extractTransaction().
 */
function extractFamAppTransactionId(text) {
  const m = String(text || '').match(/transaction\s*(?:id|no|number)\s*[:#\-]?\s*([A-Za-z0-9]{8,30})\b/i);
  return m ? m[1].toUpperCase() : '';
}

/**
 * Pull the bank UTR from a FamApp credit, e.g. "UTR: 664974818901". Returns ''
 * when absent or malformed. UPI UTRs are 12 digits; accepted range is 12–22
 * digits so a stray short number cannot pass as a reference.
 */
function extractFamAppUtr(text) {
  const m = String(text || '').match(/\butr\s*[:#\-]?\s*(\d{12,22})\b/i);
  return m ? m[1] : '';
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

/**
 * Re-read the original FamApp message behind a recorded notification and
 * re-derive the settlement evidence from it.
 *
 * Used by the admin recovery path. The notification inbox deliberately keeps a
 * truncated copy of what it saw, and older rows were written before the
 * Transaction ID / UTR were persisted, so the references are re-read from the
 * ORIGINAL message instead of being typed in by an operator.
 *
 * Everything that made the original message trustworthy is re-checked here:
 * it must still be an incoming FamApp message with aligned DMARC, and its
 * amount and transaction instant must still fall inside this payment's window.
 * Returns { transactionId, utr, amount, transactionAt, messageId } or null.
 */
async function reDeriveEvidence(notification, payment) {
  if (!notification || !payment) return null;
  let messageId = '';
  try {
    const raw = typeof notification.raw === 'string' ? JSON.parse(notification.raw) : notification.raw;
    messageId = String((raw && raw.messageId) || '').trim();
  } catch (e) { /* recorded without parseable raw */ }
  if (!messageId) return null;

  const gmailService = require('./gmailService');
  const paymentMailbox = require('./paymentMailbox');

  let gmail = null;
  // Both openers return { gmail, oauth2, conn }; the Gmail API client is the
  // nested `gmail`. (Handing the wrapper straight to gmailService fails with
  // "cannot read properties of undefined".)
  try {
    const opened = await paymentMailbox.getAuthorizedClient();
    gmail = (opened && opened.gmail) || null;
  } catch (e) { /* fall through to the support mailbox */ }
  if (!gmail) {
    try {
      const fallback = await gmailService.getAuthorizedClient();
      gmail = (fallback && fallback.gmail) || null;
    } catch (e) { /* none available */ }
  }
  if (!gmail) return null;

  let detail;
  try { detail = await gmailService.getMessageFull(gmail, messageId); } catch (e) { return null; }
  if (!detail) return null;
  if (!isIncomingInboxMessage(detail.labels)) return null;
  if (!isFamAppSender(detail.from)) return null;

  const body = detail.bodyText || detail.bodyHtml || detail.text || '';
  const candidate = buildCandidateFromEmail({
    messageId: detail.id || messageId,
    from: detail.from,
    authenticationResults: detail.authenticationResults || '',
    subject: detail.subject || '',
    body,
    date: detail.date || '',
    internalDate: detail.internalDate || '',
    labels: detail.labels,
  });

  // Re-apply the same trust and freshness gates the live path applies.
  if (!hasTrustedFamAppAuthentication(candidate.authenticationResults)) return null;
  if (candidate.direction !== 'credit') return null;
  if (!candidate.transactionId || !candidate.utr) return null;
  if (!candidate.transactionAt) return null;
  if (!moneyEquals(candidate.amount, payment.amount)) return null;

  const createdMs = Date.parse(payment.createdAt || '') || 0;
  const deadlineMs = Date.parse(payment.paymentExpiresAt || payment.expiresAt || '') || 0;
  const at = Date.parse(candidate.transactionAt);
  if (!Number.isFinite(at)) return null;
  if (createdMs && at < createdMs - 5 * 60 * 1000) return null;
  if (deadlineMs && at >= deadlineMs) return null;

  return {
    messageId: candidate.fingerprint ? String(detail.id || messageId) : messageId,
    transactionId: candidate.transactionId,
    utr: candidate.utr,
    amount: candidate.amount,
    transactionAt: candidate.transactionAt,
  };
}

// ── Candidate construction ─────────────────────────────────────────────────

/**
 * Turn a raw confirmation (email body or webhook payload) into a normalised
 * candidate. Everything here is a CLAIM — the matching step below is what
 * decides whether any of it is trustworthy.
 */
function buildCandidateFromEmail({ messageId, from = '', authenticationResults = '', subject = '', body = '', date = '', internalDate = '', labels = [] }) {
  const text = `${subject}\n${body}`;
  const vpas = extractVpas(text);
  const payee = upi.getPayee();

  // The receiving VPA is the one we recognise; anything else is the payer.
  const payeeVpa = vpas.find((v) => vpaEquals(v, payee.upiId)) || '';
  const payerVpa = vpas.find((v) => !vpaEquals(v, payee.upiId)) || '';

  // Authoritative "when this landed in the mailbox": Gmail internalDate
  // (epoch ms) drives the per-session new-email checkpoint; the Date header
  // is only a fallback.
  let receivedAt = '';
  if (internalDate !== '' && internalDate !== null && /^\d+$/.test(String(internalDate))) {
    receivedAt = new Date(Number(internalDate)).toISOString();
  } else if (date) {
    const d = new Date(date);
    if (!Number.isNaN(d.getTime())) receivedAt = d.toISOString();
  }

  return {
    source: 'email',
    messageId: messageId || '',
    // Dedup key is the Gmail message id (technical dedup ONLY — never a
    // transaction id or UTR).
    fingerprint: fingerprintOf(['email', messageId || fingerprintOf([from, subject, date, text.slice(0, 500)])]),
    direction: detectDirection(text),
    // Amount is the RECEIVED credit, not the running balance.
    amount: parseReceivedAmount(text),
    currency: 'INR',
    payerVpa,
    payerName: extractPayerName(text),
    payeeVpa,
    // FamApp transaction ID: persisted and enforced unique across sessions.
    transactionId: extractFamAppTransactionId(text),
    utr: extractFamAppUtr(text),
    from,
    authenticationResults,
    labels: Array.isArray(labels) ? labels : [],
    subject,
    occurredAt: receivedAt || new Date().toISOString(),
    receivedAt,
    // The ACTUAL transaction instant from the FamApp body (IST, parsed to UTC).
    // null when unreadable. The arrival time above is never used for timing.
    transactionAt: paymentWindow.parseFamAppTransactionTime(text),
    raw: { messageId, from, subject, date, snippet: String(body || '').slice(0, 500) },
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

  // 6) Payer name must match the order's buyer name. Email-sourced claims only:
  //    the name is read from the email body, so an unreadable name fails closed.
  //    The buyer name is the SaveHatke account holder who placed the order.
  if (candidate.source === 'email') {
    const expectedName = candidates[0] && candidates[0].buyerName;
    if (!payerNameMatches(candidate.payerName, expectedName)) {
      return reject(
        'REVIEW',
        `Payer name ${candidate.payerName ? 'does not match' : 'could not be read from'} the order's buyer name — payment left pending for review.`
      );
    }
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
  console.log(`[PAYMENT_EMAIL] payment detected session=${payment.paymentId} amount=${candidate.amount.toFixed(2)} source=${candidate.source}${mismatchPath ? ' (order-code mismatch path)' : ''}`);
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
  //    parked for review rather than bouncing off the store. The deadline is
  //    the single 10-minute payment_expires_at. Nothing settles after it: a
  //    payment first verified later takes the late-refund path above.
  const created = new Date(payment.createdAt).getTime();
  const deadline = new Date(payment.paymentExpiresAt || payment.expiresAt).getTime();
  const verifiedNow = Date.now();
  if (Number.isFinite(created) && Number.isFinite(deadline)) {
    if (verifiedNow >= deadline) {
      return reject(
        'REVIEW',
        `Payment first verified after the 10-minute deadline (${new Date(deadline).toISOString()}); not unlocked.`
      );
    }
  }

  // 8) The payment must still be live. A late confirmation for an expired
  //    attempt is never settled.
  if (payment.status !== 'PENDING') {
    return reject('REVIEW', `Payment ${payment.paymentId} is ${payment.status}, not PENDING.`);
  }

  // 9) Settle atomically. This is the only call that can move money.
  //
  //    Order-code mismatch path can be either overpayment (received >
  //    required) or underpayment (received < required). Overpayments still
  //    unlock the coupon and queue a refund for the excess. Underpayments
  //    do NOT unlock the coupon — the order is parked in REVIEW and the
  //    refund service refunds the full received amount so the buyer gets
  //    their money back without a coupon.
  const requiredForMismatch = Number(payment.amount || 0);
  const receivedForMismatch = Number(candidate.amount || 0);
  // Integer-paise comparison: avoids float drift from the old "+ 0.005" fudge.
  const requiredPaise = Math.round(requiredForMismatch * 100);
  const receivedPaise = Math.round(receivedForMismatch * 100);
  const isUnderpayment = mismatchPath
    && Number.isFinite(requiredPaise)
    && Number.isFinite(receivedPaise)
    && receivedPaise < requiredPaise;

  let result;
  try {
    if (isUnderpayment) {
      result = await store.finalizeUnderpayment({
        paymentId: payment.paymentId,
        transactionId: candidate.transactionId || null,
        utr: candidate.utr || null,
        source: candidate.source,
        notes: `Matched on order code; received ₹${receivedForMismatch.toFixed(2)}, required ₹${requiredForMismatch.toFixed(2)} (underpayment — coupon NOT unlocked).`,
        paidAt: candidate.occurredAt,
        raw: candidate.raw,
        receivedAmount: receivedForMismatch,
      });
    } else {
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
    }
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
  //     payment itself has been settled (PAID for overpayment, REVIEW for
  //     underpayment). The refund service is the same writer the dashboard
  //     reads from, so the user sees the record on the next refresh. The
  //     required amount comes from the payment row (server-set), the
  //     received amount from the verified notification — never from the
  //     request body.
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
      notes: `${isUnderpayment ? 'Underpayment recorded' : 'Settled payment'} ${payment.paymentId} (${result.code})${refundRecord ? `; refund ${refundRecord.refundId} created for ${refundRecord.mismatchType}` : ''}.`,
    });
  } catch (e) {}

  if (result && result.ok && !isUnderpayment) {
    console.log(`[PAYMENT_EMAIL] payment verified session=${payment.paymentId} status=PAID code=${result.code}`);
  }

  // Payment is genuinely settled to PAID — send the buyer their confirmation
  // receipt. Skipped for idempotent replays so a redelivered webhook never
  // double-sends, and isolated so an email failure can't undo the settlement.
  // Underpayments never unlock the coupon, so the buyer does NOT get a
  // "Payment Successful" receipt here — the refund flow owns their notice.
  if (result && result.ok && !result.idempotent && !isUnderpayment) {
    await deliverPaymentSuccessEmail(payment);
  }

  return {
    action: isUnderpayment ? 'underpayment_recorded' : 'settled',
    reason: isUnderpayment
      ? `Payment ${payment.paymentId} parked as REVIEW (underpayment: required ₹${requiredForMismatch.toFixed(2)}, received ₹${receivedForMismatch.toFixed(2)}).`
      : `Payment ${payment.paymentId} settled (${result.code}).`,
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

// ── Mailbox path (FamApp email → amount-only settlement) ────────────────────

/**
 * Decide what to do with ONE FamApp payment-notification email.
 *
 * Amount-only matching: the received credit must equal a live pending
 * payment's amount to the paisa. Transaction ID / UTR are never extracted,
 * stored, or used. Deduplication is by Gmail message id (via the notification
 * fingerprint), so a re-read message is a no-op on every later scan.
 *
 * Isolation + freshness guarantees:
 *   * only no-reply@famapp.in can settle anything;
 *   * the email must have arrived AFTER the payment's window opened;
 *   * exactly one live session may be waiting for that amount — two concurrent
 *     same-amount orders are parked for review, never guessed.
 *
 * Never mutates state unless every check passes; settlement is delegated to
 * store.finalizePayment (atomic, coupon-flip-gated, idempotent).
 */
async function processEmailCandidate(candidate, { pendingPayments = null } = {}) {
  const tag = '[Payment Email]';

  // Folder gate: only a message Gmail reports as a received INBOX item can count.
  // Sent / draft / spam / trash copies are rejected before anything is recorded.
  if (!isIncomingInboxMessage(candidate.labels)) {
    return { action: 'ignored', reason: 'Not a received inbox message (Sent, draft, spam or trash).' };
  }
  // Hard sender gate: ONLY FamApp confirmations are ever considered.
  if (!isFamAppSender(candidate.from)) {
    return { action: 'ignored', reason: `Sender is not FamApp (${candidate.from || 'unknown'}).` };
  }
  if (!hasTrustedFamAppAuthentication(candidate.authenticationResults)) {
    return { action: 'ignored', reason: 'The receiving mailbox did not confirm aligned FamApp sender authentication.' };
  }

  // Record first — the message-id fingerprint makes a re-read email idempotent.
  let recorded;
  try {
    recorded = await store.recordNotification({
      fingerprint: candidate.fingerprint,
      source: 'email',
      amount: candidate.amount,
      currency: 'INR',
      // The bank references ARE persisted. They are the evidence a dispute or an
      // admin recovery is reconstructed from, and finalizePayment refuses to
      // settle without them, so a row that hides them cannot be explained or
      // replayed later. They are still never accepted from a client.
      transactionId: candidate.transactionId || '',
      utr: candidate.utr || '',
      payerVpa: candidate.payerVpa,
      payeeVpa: candidate.payeeVpa,
      reference: candidate.utr || '',
      occurredAt: candidate.occurredAt,
      raw: candidate.raw,
    });
  } catch (e) {
    console.error(`${tag} could not record notification:`, e.message);
    return { action: 'error', reason: 'Could not record the notification.' };
  }

  if (recorded.duplicate) {
    // A repeat sighting is only final once the earlier pass actually DECIDED
    // this message. `RECEIVED` (the pass died mid-flight) and `REVIEW`
    // (settlement failed for an infrastructure reason — the coupon flip, the
    // Sheets write, the database) are not decisions: they mean the money is
    // real and unclaimed. Short-circuiting there strands a verified payment
    // forever, because no later scan would ever look at it again. That is
    // precisely how a real, received ₹10.00 payment stayed PENDING for days
    // when coupons.sold_payment_id was missing in production.
    const prior = recorded.notification || {};
    // MATCHED = settled, IGNORED/REJECTED = a decision was made about the money.
    // Those are final and are never re-opened. RECEIVED and REVIEW are not.
    const resolvedStatuses = new Set(['MATCHED', 'SETTLED', 'DUPLICATE_UNDERPAYMENT', 'IGNORED', 'REJECTED']);
    if (resolvedStatuses.has(String(prior.status || '').toUpperCase())) {
      return {
        action: 'duplicate',
        reason: 'This FamApp message was already processed.',
        notification: prior,
        previousPaymentId: prior.matchedPaymentId || '',
      };
    }
    console.warn(
      `${tag} re-processing unresolved notification ${prior.id || '(unknown)'} ` +
      `(previous status: ${prior.status || 'none'}) — a settled or ignored message is never re-opened`
    );
  }

  const notification = recorded.notification;
  const reject = async (status, notes) => {
    try { await store.updateNotification(notification.id, { status, notes }); } catch (e) {}
    return { action: status === 'REVIEW' ? 'review' : 'ignored', reason: notes, notification };
  };

  // Must be an incoming credit ("successfully received").
  if (candidate.direction !== 'credit') {
    return reject('IGNORED', `Not a credit notification (direction: ${candidate.direction}).`);
  }
  if (!candidate.amount || candidate.amount <= 0) {
    return reject('IGNORED', 'No received amount found in the FamApp email.');
  }

  console.log(`${tag} FamApp email detected`);
  console.log(`${tag} Amount received: ₹${candidate.amount.toFixed(2)}`);

  // A transaction after its session's deadline never settles and never refunds.
  // Decided on the transaction instant, the payer name and the stored deadline.
  const lateHandled = await handleLateCandidate(candidate, notification, reject);
  if (lateHandled) return lateHandled;

  // The deadline is judged on the FamApp transaction instant. An unreadable or
  // missing transaction time is never guessed: the payment is parked for review.
  if (!candidate.transactionAt) {
    return reject('REVIEW', 'FamApp email has no readable transaction time — payment left pending for review.');
  }

  // Live pending payments only (findPendingPaymentsForAmount already excludes
  // expired windows). Amount-only match, to the paisa.
  const pending = pendingPayments || (await store.findPendingPaymentsForAmount(null));
  const amountMatches = pending.filter((p) => moneyEquals(p.amount, candidate.amount));

  if (!amountMatches.length) {
    // Wrong amount / nothing waiting: keep every session live until it expires
    // (spec — wrong-amount handling). Do NOT mark anything paid.
    return reject('IGNORED', `No active order is waiting for ₹${candidate.amount.toFixed(2)}.`);
  }

  // New-email checkpoint: a message must have arrived AFTER a session opened to
  // settle it. This is what stops an OLD FamApp email verifying a new order.
  const recvdMs = candidate.receivedAt ? new Date(candidate.receivedAt).getTime() : NaN;
  const fresh = amountMatches.filter((p) => {
    const startedMs = new Date(p.createdAt).getTime();
    // Fail-open only when a timestamp is genuinely unreadable; otherwise the
    // email must be at/after the window start (60s clock-skew grace).
    if (!Number.isFinite(recvdMs) || !Number.isFinite(startedMs)) return true;
    return recvdMs >= startedMs - 60 * 1000;
  });

  if (!fresh.length) {
    return reject('IGNORED', 'FamApp email predates the active payment window (old notification).');
  }

  // Session isolation: a bare amount cannot disambiguate two concurrent
  // same-amount orders. Settle only when exactly one live session waits for it.
  if (fresh.length > 1) {
    return reject(
      'REVIEW',
      `₹${candidate.amount.toFixed(2)} matches ${fresh.length} concurrent orders — cannot attribute by amount alone.`
    );
  }

  const payment = fresh[0];
  console.log(`${tag} Expected amount: ₹${Number(payment.amount).toFixed(2)}`);

  // Both references are required. The customer does not know them when opening
  // the window; they come from the verified FamApp email after payment. A
  // missing one parks the payment for review — never settles on amount alone.
  const txnId = candidate.transactionId || '';
  const utr = candidate.utr || '';
  if (!txnId) {
    return reject('REVIEW', 'FamApp email has no Transaction ID — payment left pending for review.');
  }
  if (!utr) {
    return reject('REVIEW', 'FamApp email has no UTR — payment left pending for review.');
  }

  // Neither reference may already belong to another settled payment. The store
  // re-checks both under its lock in finalizePayment; this gives a clear outcome.
  try {
    const used = await store.findPaymentByTransaction(txnId, utr);
    if (used && used.paymentId !== payment.paymentId) {
      return reject('REVIEW', `Transaction ${txnId} / UTR already settled another payment session.`);
    }
  } catch (e) {
    return reject('REVIEW', 'Could not check the transaction references for a duplicate: ' + e.message);
  }

  if (payment.status !== 'PENDING') {
    return reject('REVIEW', `Payment ${payment.paymentId} is ${payment.status}, not PENDING.`);
  }

  console.log(`${tag} Amount matched`);

  // Settle atomically. finalizePayment gates on the coupon flip, re-checks the
  // transaction ID and UTR under its lock, and is idempotent, so an email can
  // never unlock a coupon twice.
  let result;
  try {
    result = await store.finalizePayment({
      paymentId: payment.paymentId,
      transactionId: txnId,
      utr,
      source: 'email',
      notes: `Matched FamApp credit on amount ₹${candidate.amount.toFixed(2)}.`,
      paidAt: candidate.occurredAt,
      raw: candidate.raw,
      receivedAmount: candidate.amount,
      // The deadline is judged on when the money actually moved, not on when
      // Gmail delivered the email. A late email for an in-window payment settles.
      transactionAt: candidate.transactionAt,
    });
  } catch (e) {
    return reject('REVIEW', 'Settlement failed: ' + e.message);
  }

  if (!result || !result.ok) {
    const code = (result && result.code) || 'UNKNOWN';
    return reject('REVIEW', `Settlement refused by the database (${code}).`);
  }

  try {
    await store.updateNotification(notification.id, {
      status: 'MATCHED',
      matched_payment_id: payment.paymentId,
      notes: `Settled payment ${payment.paymentId} (${result.code}) on amount ₹${candidate.amount.toFixed(2)}.`,
    });
  } catch (e) {}

  console.log(`${tag} Payment verified: ${payment.paymentId} (order ${payment.orderCode || payment.orderId})`);
  console.log(`${tag} Verification stopped for ${payment.paymentId}`);

  // Genuinely settled — send the buyer their confirmation receipt (best-effort,
  // skipped on idempotent replays so a re-read FamApp email never double-sends).
  if (result && result.ok && !result.idempotent) {
    await deliverPaymentSuccessEmail(payment);
  }

  return {
    action: 'settled',
    reason: `Payment ${payment.paymentId} settled (${result.code}).`,
    notification,
    payment,
    result,
  };
}

/**
 * Handle a verified credit that may belong to a session whose verification
 * deadline has passed. Returns a result object when this path decided the
 * message, or null when no late-eligible session matches (normal path runs).
 *
 * Never delivers a coupon. A late session stays out of settlement; the admin
 * refund task is the only money-side effect, created once per payment.
 */
async function handleLateCandidate(candidate, notification, reject) {
  const tag = '[Payment Email]';
  if (!candidate.transactionAt) {
    // A transaction time we cannot read cannot be classified safely.
    return null;
  }
  const late = await store.findLateCandidatePayments();
  const sameAmount = late.filter((p) => moneyEquals(p.amount, candidate.amount));
  if (!sameAmount.length) return null;

  // Name is required to attribute a late payment; an unreadable name never matches.
  const named = sameAmount.filter((p) => payerNameMatches(candidate.payerName, p.buyerName));
  if (named.length !== 1) {
    if (named.length > 1) {
      return reject('REVIEW', `Late ₹${candidate.amount.toFixed(2)} matches ${named.length} sessions by name and amount — routed to review.`);
    }
    // No late session fits this name; the normal path decides.
    return null;
  }

  const session = named[0];
  const decision = paymentWindow.decideIncomingCredit({
    transactionAt: candidate.transactionAt,
    sessionStatus: session.status,
    sessionCreatedAt: session.createdAt,
    paymentExpiresAt: session.paymentExpiresAt || session.expiresAt,
    payerNameMatches: true,
    verifiedAtMs: Date.now(),
  });

  // Only an in-window transaction may settle. Everything else leaves the coupon
  // locked and creates NO refund: an expired session is never refunded.
  if (decision.action === 'ignore') return null;
  if (decision.action === 'settle') return null; // in-window: the normal path settles it
  if (decision.action === 'expired_no_action') {
    try {
      await store.updateNotification(notification.id, {
        status: 'IGNORED',
        matched_payment_id: session.paymentId,
        notes: `Transaction after the 10-minute deadline for ${session.paymentId}; coupon not unlocked; no refund for expired session.`,
      });
    } catch (e) {}
    return { action: 'ignored', reason: decision.reason, notification, payment: session };
  }
  return reject('REVIEW', decision.reason);
}

/**
 * Read recent FamApp emails from the payment mailbox and settle any that match
 * a live pending payment by amount. On-demand only: it is a no-op (and never
 * touches Gmail) when no payment session is active, so the inbox is not
 * monitored between checkouts. Safe to call often — message-id dedup makes
 * repeat scans cheap and idempotent.
 */
async function scanPaymentMailbox({ maxMessages = 15 } = {}) {
  const tag = '[Payment Email]';
  const cfg = getMailConfig();

  // ── On-demand guard ────────────────────────────────────────────────────────
  // Only scan when at least one payment session is actually live. With no active
  // order there is nothing an email could settle, so we never open the inbox —
  // this is what keeps Gmail from being monitored continuously.
  const pending = await store.findPendingPaymentsForAmount(null);
  // Late-eligible sessions (expired or cancelled but still inside their
  // verification deadline) also need the mailbox checked, so a late credit can
  // be detected and turned into a single refund task.
  const late = pending.length ? [] : await store.findLateCandidatePayments();
  if (!pending.length && !late.length) {
    return { ok: true, scanned: 0, settled: 0, reason: 'No active payment session.', idle: true };
  }
  console.log(`[PAYMENT_EMAIL] checking pending=${pending.length}`);

  // The read helpers (listMessages / getMessageFull) live on gmailService and
  // take a `gmail` client as their first argument, so they work against ANY
  // authorized client. The client itself comes from the DEDICATED payment
  // mailbox (rupayandas2025@gmail.com) when connected; the shared support
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
      console.warn(`${tag} payment mailbox open notice:`, e.message);
      // A failure to even open the dedicated mailbox is recorded against the
      // Supabase row so the admin panel can show reauthorization_required. This
      // NEVER settles or marks any order as paid — verification simply stops.
      try { await paymentMailbox.reportGmailError(e); } catch (_) {}
    }
    if (!client) {
      client = await gmailService.getAuthorizedClient();
      if (client) mailboxSource = 'support-fallback';
    }
    if (!client) {
      return {
        ok: false,
        reason:
          'The payment mailbox is not connected or its authorization expired. Reconnect it from the admin panel (Payment Gmail → Reconnect).',
        scanned: 0,
        settled: 0,
      };
    }
    gmail = client.gmail;
  } catch (e) {
    return { ok: false, reason: 'Could not open the payment mailbox: ' + e.message, scanned: 0, settled: 0 };
  }

  // ── Search: FamApp only, bounded to the active window(s) ─────────────────────
  // Restrict as tightly as possible: the sender allow-list (FamApp by default)
  // AND messages no older than the earliest live payment window (minus a small
  // grace). This never downloads the whole inbox.
  const watch = pending.length ? pending : late;
  const startTimes = watch.map((p) => new Date(p.createdAt).getTime()).filter(Number.isFinite);
  const earliestStart = startTimes.length ? Math.min(...startTimes) : NaN;
  const afterSecs = Number.isFinite(earliestStart)
    ? Math.floor((earliestStart - 5 * 60 * 1000) / 1000)
    : Math.floor((Date.now() - cfg.lookbackDays * 24 * 60 * 60 * 1000) / 1000);
  const senders = cfg.senders.map((s) => `from:${s}`).join(' OR ');
  // No `in:inbox` filter: an archived or label-filtered FamApp email is still a
  // real received payment notification. Sent, drafts, spam and trash are still
  // excluded here, and isIncomingInboxMessage() rejects them again in code.
  const q = buildPaymentSearchQuery({ senders: cfg.senders, afterSecs });

  let messages = [];
  try {
    const list = await gmailService.listMessages(gmail, { q, maxResults: maxMessages });
    messages = list.messages || [];
    // The token just proved good against the live Gmail API — clear any stale
    // reauthorization/error flag on the dedicated payment mailbox row.
    if (mailboxSource === 'payment') {
      try { await paymentMailbox.reportVerified(); } catch (_) {}
    }
  } catch (e) {
    // A clear auth/revocation error (invalid_grant, testing-mode expiry) flags
    // the connection for re-authorization instead of retrying forever. Gmail
    // verification stops gracefully; the webhook path is unaffected and no
    // order is ever marked paid because email verification failed.
    if (mailboxSource === 'payment') {
      try { await paymentMailbox.reportGmailError(e); } catch (_) {}
    }
    const reason = paymentMailbox.isAuthError(e)
      ? 'Payment Gmail authorization expired. Reconnect Gmail from the admin panel.'
      : 'Mailbox search failed: ' + e.message;
    return { ok: false, reason, scanned: 0, settled: 0 };
  }

  const results = [];

  for (const msg of messages) {
    // Folder gate first — a Sent/draft/spam/trash copy is never incoming money.
    if (!isIncomingInboxMessage(msg.labels)) continue;
    // Sender gate next — only FamApp is ever a payment confirmation.
    if (!isFamAppSender(msg.from)) continue;

    const candidate = buildCandidateFromEmail({
      messageId: msg.id,
      from: msg.from,
      authenticationResults: msg.authenticationResults,
      subject: msg.subject,
      body: msg.snippet,
      date: msg.date,
      internalDate: msg.internalDate,
      labels: msg.labels,
    });

    // Cheap snippet pre-filter before a full-body fetch: it must look like a
    // credit for an amount we are actually waiting on.
    //
    // This is ONLY a fetch optimisation and must stay that way. A Gmail snippet
    // is a truncated, auto-generated preview, so it can drop or mangle the
    // amount. The notification fingerprint is keyed on the Gmail message id, so
    // persisting an IGNORED verdict here would make processEmailCandidate treat
    // every later look at that same message as `duplicate` — the full body
    // would never be read and the credit could never settle. That turns a
    // detection miss into a payment the system is structurally unable to
    // verify. So: never record here.
    const isCredit = candidate.direction === 'credit';
    const amountLooksUseful =
      Boolean(candidate.amount) && watch.some((p) => moneyEquals(p.amount, candidate.amount));

    // Nothing here says money is arriving — skip the full-body fetch. Anything
    // that even looks like a credit falls through so processEmailCandidate can
    // read the real body and record the true outcome itself.
    if (!isCredit && !amountLooksUseful) continue;

    // Resolve the fullest text we can for the definitive amount read.
    let full = candidate;
    try {
      const detail = await gmailService.getMessageFull(gmail, msg.id);
      const body = detail?.bodyText || detail?.bodyHtml || detail?.text || '';
      if (body) {
        full = buildCandidateFromEmail({
          messageId: msg.id,
          from: msg.from,
          authenticationResults: detail.authenticationResults || msg.authenticationResults,
          subject: msg.subject,
          body: body + '\n' + (msg.snippet || ''),
          date: msg.date,
          internalDate: msg.internalDate,
          labels: detail.labels || msg.labels,
        });
      }
    } catch (e) {
      // Fall back to the snippet-derived candidate; it is stricter, not looser.
    }

    try {
      results.push(await processEmailCandidate(full, { pendingPayments: pending.length ? pending : null }));
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

// ── Coalesced, on-demand trigger ────────────────────────────────────────────
// Called from the live status paths (SSE /stream tick and /status poll) while a
// payment window is open. Concurrent callers share a single in-flight scan, and
// scans are throttled to a short minimum interval, so many simultaneous buyers
// never multiply Gmail API calls. When no session is active, scanPaymentMailbox
// short-circuits before touching Gmail.
let _scanInFlight = null;
let _lastScanStartedAt = 0;
const SCAN_MIN_INTERVAL_MS = Number(process.env.PAYMENT_MAIL_SCAN_MIN_MS || 1500);

async function triggerMailboxScan(opts = {}) {
  const { force = false, ...scanOpts } = opts || {};
  if (_scanInFlight) return _scanInFlight;
  // A genuine Gmail push (force) always scans; the time-throttle only guards
  // the high-frequency browser-poll callers. In-flight sharing still applies to
  // both, so a push arriving mid-scan never starts a second Gmail run.
  if (!force && Date.now() - _lastScanStartedAt < SCAN_MIN_INTERVAL_MS) {
    return { ok: true, coalesced: true, scanned: 0, settled: 0 };
  }
  _lastScanStartedAt = Date.now();
  _scanInFlight = (async () => {
    try {
      return await scanPaymentMailbox(scanOpts);
    } catch (e) {
      return { ok: false, reason: e.message, scanned: 0, settled: 0 };
    } finally {
      _scanInFlight = null;
    }
  })();
  return _scanInFlight;
}

// ── Gmail push (watch) orchestration ─────────────────────────────────────────
// The push webhook and the daily renewal cron call these. They reuse the SAME
// dedicated payment-mailbox client and the SAME scanner as the browser paths —
// this is not a second payment system, it only changes WHAT triggers a scan (an
// instant Google Pub/Sub push instead of a browser poll) and keeps the watch
// registration alive.
async function getPaymentGmail() {
  const paymentMailbox = require('./paymentMailbox');
  const client = await paymentMailbox.getAuthorizedClient();
  if (!client || !client.gmail) return null;
  let email = '';
  try { email = (await paymentMailbox.currentEmail()) || ''; } catch (e) {}
  return { gmail: client.gmail, email };
}

/**
 * Start (or refresh) the Gmail push watch on the payment mailbox. Google then
 * publishes to PAYMENT_GMAIL_PUBSUB_TOPIC whenever mail arrives. Idempotent:
 * calling it again just resets the ~7-day clock, so the daily cron uses it too.
 */
async function startGmailWatch() {
  const topicName = String(process.env.PAYMENT_GMAIL_PUBSUB_TOPIC || '').trim();
  if (!topicName) return { ok: false, reason: 'PAYMENT_GMAIL_PUBSUB_TOPIC is not set.' };
  const conn = await getPaymentGmail();
  if (!conn) return { ok: false, reason: 'Payment mailbox is not connected.' };

  const gmailService = require('./gmailService');
  const state = require('./paymentGmailState');
  try {
    const { historyId, expiration } = await gmailService.watchMailbox(conn.gmail, {
      topicName,
      labelIds: ['INBOX'],
    });
    await state.saveWatch(conn.email || 'payment', { historyId, expiration });
    const expMs = Number(expiration);
    console.log(
      `[Payment Watch] active for ${conn.email || '(mailbox)'}; historyId=${historyId}; ` +
      `expires=${Number.isFinite(expMs) ? new Date(expMs).toISOString() : expiration}`
    );
    return { ok: true, historyId, expiration };
  } catch (e) {
    console.warn('[Payment Watch] start failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

// Renewing is just (re)starting the watch — Google resets the clock and returns
// the current historyId. Safe to call daily (or more often).
async function renewGmailWatch() {
  return startGmailWatch();
}

/**
 * Handle a decoded Gmail Pub/Sub push. The historyId is recorded for
 * continuity, then detection runs the SAME bounded, dedup-safe scan the browser
 * paths use — so a duplicate, delayed, or out-of-order push can never
 * double-settle a payment (the notification-fingerprint guard owns that).
 */
async function handleGmailPush({ emailAddress = '', historyId = '' } = {}) {
  if (historyId) {
    try {
      const state = require('./paymentGmailState');
      await state.saveHistoryId(emailAddress || 'payment', historyId);
    } catch (e) { /* best effort */ }
  }
  return triggerMailboxScan({ force: true });
}

// ── Buyer receipt email ──────────────────────────────────────────────────────
// Fired ONLY after a payment is genuinely settled to PAID (server-verified via
// the HMAC webhook or the FamApp mailbox — never anything the browser reports).
// Fully isolated from settlement: it reads the order for the receipt fields,
// sends the confirmation, and can neither throw into nor stall (beyond a short
// cap) the settlement path that calls it.
// Best-effort coupon lookup for the coupon-details email. Mirrors the route
// layer's loadCoupon (Supabase first, then the Sheets mirror). Never throws.
async function loadCouponForEmail(couponId) {
  if (!couponId) return null;
  try {
    if (supabase && typeof supabase.isConfigured === 'function' && supabase.isConfigured()) {
      const c = await supabase.findCouponById(couponId).catch(() => null);
      if (c) return c;
    }
  } catch (e) { /* fall through to the Sheets mirror */ }
  try {
    return await db.findRow(db.SHEETS.COUPONS, 'id', couponId);
  } catch (e) {
    return null;
  }
}

async function deliverPaymentSuccessEmail(payment) {
  try {
    if (!payment || !payment.paymentId) return;
    const order = payment.orderId
      ? await store.findOrderById(payment.orderId).catch(() => null)
      : null;
    const to = (order && (order.buyerEmail || order.userEmail)) || payment.userEmail || '';
    if (!to) {
      console.warn('[Payment Email] Settled payment has no recipient address; confirmation skipped.');
      return;
    }
    const sendPromise = emailService.sendPaymentSuccessEmail({
      to,
      buyerName: (order && order.buyerName) || '',
      amount: (order && order.amount) || payment.amount || 0,
      orderCode: (order && order.orderCode) || '',
      couponBrand: (order && order.couponBrand) || '',
      couponCode: (order && order.couponCode) || '',
      paidAt: (order && order.paidAt) || payment.paidAt || new Date().toISOString(),
      // Our OWN canonical Transaction ID (TXN-YYYYMMDD-XXXXXXXX). The bank's UTR
      // is a separate external reference passed as gatewayReference.
      transactionId: (order && order.transactionId) || '',
      transactionType: (order && order.transactionType) || 'PURCHASE',
      gatewayReference: payment.verifiedTransactionId || payment.verifiedUtr || '',
    });
    // A hung SMTP call must never stall settlement reporting; cap the wait.
    // sendPaymentSuccessEmail swallows its own errors, so this never rejects.
    const res = await Promise.race([
      sendPromise,
      new Promise((resolve) => setTimeout(() => resolve({ success: false, error: 'send timed out' }), 12000)),
    ]);
    if (res && res.success) {
      console.log(`[Payment Email] Confirmation sent to ${to} (order ${(order && order.orderCode) || payment.paymentId}).`);
    } else if (res && res.isSimulated) {
      console.warn('[Payment Email] SMTP not configured — payment confirmation not sent.');
    } else {
      console.warn(`[Payment Email] Payment confirmation not sent: ${(res && res.error) || 'unknown error'}.`);
    }

    // ── ALSO send the buyer's "Your Coupon Details" email ────────────────────
    // A coupon-delivery note from the no-reply mailbox, sent IN ADDITION to the
    // receipt above. Isolated in its own try so it can never disturb settlement
    // or the receipt. Coupon facts (description, face value, expiry) come from
    // the coupon record; name/brand/order come from the settled order.
    try {
      const coupon = await loadCouponForEmail((order && order.couponId) || payment.couponId || '');
      const faceValue = coupon && (coupon.originalValue != null ? coupon.originalValue
        : (coupon.original_value != null ? coupon.original_value
          : (coupon.faceValue != null ? coupon.faceValue : coupon.face_value)));
      const couponRes = await Promise.race([
        emailService.sendCouponDetailsEmail({
          to,
          userName: (order && order.buyerName) || '',
          brandName: (coupon && coupon.brand) || (order && order.couponBrand) || '',
          couponDescription: (coupon && (coupon.description || coupon.title || coupon.discount)) || '',
          couponValue: faceValue == null ? '' : faceValue,
          expiryDate: (coupon && (coupon.expiryDate || coupon.expiry_date)) || '',
          orderId: (order && order.orderCode) || '',
        }),
        new Promise((resolve) => setTimeout(() => resolve({ success: false, error: 'send timed out' }), 12000)),
      ]);
      if (couponRes && couponRes.success) {
        console.log(`[Coupon Email] Coupon details sent to ${to} (order ${(order && order.orderCode) || payment.paymentId}).`);
      } else if (couponRes && couponRes.isSimulated) {
        console.warn('[Coupon Email] SMTP not configured — coupon-details email not sent.');
      } else {
        console.warn(`[Coupon Email] Coupon-details email not sent: ${(couponRes && couponRes.error) || 'unknown error'}.`);
      }
    } catch (e) {
      console.warn('[Coupon Email] Coupon-details send failed:', e.message);
    }
  } catch (e) {
    console.warn('[Payment Email] Payment confirmation send failed:', e.message);
  }
}

module.exports = {
  // config
  getMailConfig,
  getWebhookSecret,
  buildPaymentSearchQuery,
  isIncomingInboxMessage,
  isFamAppSender,
  isIncomingInboxMessage,
  FAMAPP_SENDER,
  // extraction (exported for tests)
  parseMoney,
  parseReceivedAmount,
  moneyEquals,
  extractTransaction,
  extractOrderCode,
  extractVpas,
  detectDirection,
  vpaEquals,
  fingerprintOf,
  extractPayerName,
  normalizePersonName,
  payerNameMatches,
  // candidates
  buildCandidateFromEmail,
  buildCandidateFromWebhook,
  reDeriveEvidence,
  // core
  processCandidate,
  processEmailCandidate,
  verifyWebhookSignature,
  scanPaymentMailbox,
  triggerMailboxScan,
  // Gmail push (watch)
  startGmailWatch,
  renewGmailWatch,
  handleGmailPush,
};
