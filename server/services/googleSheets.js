// ============================================
// SaveHatke — Google Sheets Database Service
// ============================================
// Provides CRUD operations on Google Sheets acting as the primary database.
// Sheets: Users | Coupons | PriceTracking | SupportTickets

const { google } = require('googleapis');
const fs = require('fs');

// Sheet names (tabs inside the spreadsheet)
const SHEETS = {
  USERS: 'Users',
  COUPONS: 'Coupons',
  PRICE_TRACKING: 'PriceTracking',
  SUPPORT_TICKETS: 'SupportTickets',
  SETTINGS: 'Settings',
  OTP_REQUESTS: 'OTPRequests',
  CHATBOT_SETTINGS: 'ChatbotSettings',
  CHATBOT_KNOWLEDGE: 'ChatbotKnowledge',
  CHATBOT_CONVERSATIONS: 'ChatbotConversations',
  CHATBOT_MESSAGES: 'ChatbotMessages',
  CHATBOT_LOGS: 'ChatbotLogs',
  CHATBOT_AUDIT: 'ChatbotAudit',
  COUPON_AUDIT: 'CouponAudit',
  PAYOUTS: 'Payouts',
  REVIEWS: 'Reviews',
  USER_TWO_FACTOR: 'UserTwoFactor',
  SECURITY_AUDIT: 'SecurityAudit',
  BACKUP_CODE_AUDIT: 'BackupCodeAudit',
  MONTHLY_REPORTS: 'MonthlyReports',
  SELLER_PAYOUT_DETAILS: 'SellerPayoutDetails',
  TESTIMONIALS: 'Testimonials',
  // ── Custom UPI checkout ────────────────────────────────────────────────
  // Orders + payments live here rather than in Supabase (operator decision:
  // one place to read the money trail). The coupon unlock still happens in
  // the Supabase `coupons` table, because that single conditional UPDATE is
  // what makes unlocking exactly-once.
  ORDERS: 'Orders',
  PAYMENTS: 'Payments',
  PAYMENT_NOTIFICATIONS: 'PaymentNotifications',
  // Single-row-per-mailbox state for the Gmail push (watch) + History-API
  // incremental scanner: the last processed historyId and the current watch
  // expiration. Lets the fast path check only new messages and lets the daily
  // cron renew the watch before Google's ~7-day expiry.
  PAYMENT_GMAIL_STATE: 'PaymentGmailState',
  REFUNDS: 'Refunds',
  // Admin revenue-share payouts (40/40/20). One row per admin payout event.
  ADMIN_PAYOUTS: 'AdminPayouts',
  // One row per reconciled calendar month (upserted by `month`, never appended).
  MONTHLY_SETTLEMENTS: 'MonthlySettlements',
};

// Column headers for each sheet (used for initialization and row mapping)
const HEADERS = {
  [SHEETS.USERS]: [
    'user_ID',
    'name',
    'username',
    'email',
    'status',
    // Google's own avatar URL for the account, captured at Google login. The
    // admin panel renders it next to the email instead of guessing an avatar
    // from a third-party service. ensureSheets() adds this column to tabs
    // created before it existed, so old sheets fill in on the next login.
    'profile_picture',
    // JSON blob of the user's notification opt-ins, e.g.
    // {"coupon_activity":true,"marketing":false}. Absent/blank means
    // "defaults" — the server fills in the defaults on read.
    'notification_prefs',
    'created_at',
    'updated_at',
    'last_login_at',
    'last_logout_at',
    // JSON blob of one-time onboarding flags, e.g.
    // {"marketplaceTutorialCompleted":true,"marketplaceTutorialSkipped":false}.
    // Appended by ensureSheets() on sheets created before it existed, so an
    // older row simply reads back as "nothing seen yet".
    'onboarding_state',
    // Preferred display name chosen by the user during first-login onboarding.
    'preferred_name',
  ],
  [SHEETS.COUPONS]: [
    'id',
    'brand',
    'title',
    'code',
    'type',
    'discount',
    'sellingPrice',
    'minOrderValue',
    'originalValue',
    'validFrom',
    'expiryDate',
    // Hero image for the marketplace card, per coupon ('/images/coupons/amazon.webp'
    // or an absolute URL). Blank ⇒ the card falls back to the default background.
    'backgroundImage',
    // Per-coupon brand-logo override (uploaded image URL). Blank ⇒ the card
    // resolves the brand-level logo from the Brand Logos Drive folder as before.
    'brandLogo',
    'category',
    'source',
    'status',
    'affiliateLink',
    'terms',
    'isFeatured',
    'isExclusive',
    'isVerified',
    'sellerEmail',
    'buyerEmail',
    'addedAt',
    'soldAt',
    'proofUrl',
    'adminNotes',
    'verifiedAt',
    'sellerUserId',
    'whatsappStatus',
    'whatsappSid',
    'whatsappLastAttempt',
    'whatsappError',
    // Server-computed seller payout (7% of the coupon's face value, rounded to
    // the paise). APPENDED AT THE END on purpose: ensureSheets() grows the
    // header row to the right, so existing columns and their data never shift.
    'sellerPayout',
  ],
  [SHEETS.COUPON_AUDIT]: [
    'id',
    'couponId',
    'adminEmail',
    'action',
    'notes',
    'at',
  ],
  [SHEETS.PAYOUTS]: [
    'id',
    'sellerEmail',
    'sellerUserId',
    'amount',
    'currency',
    'method',
    'upiId',
    'bankAccount',
    'bankIfsc',
    'beneficiaryName',
    'status',
    'sourceType',
    'sourceCouponId',
    'requestedAt',
    'processedAt',
    'processedBy',
    'paymentReference',
    'rejectionReason',
    'notes',
    // Canonical financial identifiers (see server/utils/identifiers.js). This
    // sheet uses camelCase headers, so these match that style; the API layer
    // still exposes them as order_id / transaction_id / transaction_type.
    //   orderId         SH-PAY-YYYYMMDD-XXXXXX (the payout's Order ID)
    //   transactionId   TXN-YYYYMMDD-XXXXXXXX  (the payout financial txn)
    //   transactionType always 'SELLER_PAYOUT'
    // APPENDED AT THE END; legacy payouts read back blank and fall back to `id`.
    'orderId',
    'transactionId',
    'transactionType',
    'reservationId',
    'settlementReservationId',
  ],
  // One row per seller: where that seller's money goes. Payout destinations are
  // account-level on purpose — a coupon row must never carry payment
  // credentials, and a seller must never be asked to re-type an account number
  // for every payout request. /api/payouts/request copies this row onto the
  // Payouts row it creates, so the admin payout screens keep reading one place.
  //
  // sellerEmail is the key and is stored lowercased so it matches the Payouts
  // tab's sellerEmail under one identity. Only a destination is kept here (UPI
  // handle, or account number + IFSC) — never a card number, CVV or password —
  // and seller-facing responses return it masked. Every row also carries an `id`
  // because appendRow/getRows identify a row by it when merging the in-memory
  // fallback: without one, two sellers' rows collide as "the same row".
  [SHEETS.SELLER_PAYOUT_DETAILS]: [
    'id',
    'sellerEmail',
    'sellerUserId',
    'method',           // 'UPI' | 'QR' — same casing the Payouts tab stores
    'upiId',
    // A payout QR image lives in Drive ("QR Code Images"); only its file id and
    // the seller's own filename are kept here, so the sheet never carries the
    // picture and it is served back through the authorised drive proxy.
    'qrFileId',
    'qrFileName',
    'beneficiaryName',
    'createdAt',
    'updatedAt',
  ],
  [SHEETS.PRICE_TRACKING]: [
    'id', 'userEmail', 'productUrl', 'platform', 'productName',
    'currentPrice', 'targetPrice', 'lowestPrice', 'lastChecked', 'alertSent',
  ],
  // One row per calendar month, written when that month's report is generated
  // (automatically on the 1st, or on demand from Reports → Monthly Reports).
  //
  // The figures are stored, not recomputed on read, so a report always shows the
  // numbers that were actually mailed out. Delivery is tracked per configured
  // admin address — status is one of sent | pending | not_sent | failed — so the
  // panel can show at a glance whether both admins received the PDF. The PDF
  // itself is not stored: it is rebuilt from this row on demand.
  [SHEETS.MONTHLY_REPORTS]: [
    'id',
    'month',            // YYYY-MM, the key used by every route
    'monthLabel',       // "August 2026"
    'periodLabel',      // "Aug 1-31, 2026"
    'periodStart',
    'periodEnd',
    'revenue',
    'couponsBought',
    'couponsSold',
    'generatedAt',
    'generatedBy',      // 'auto' or the admin email that triggered it
    'admin1Email',
    'admin1Status',
    'admin1At',
    'admin1Error',
    'admin2Email',
    'admin2Status',
    'admin2At',
    'admin2Error',
    'lastSentAt',
  ],
  // Buyer reviews of coupons they purchased. brand/couponTitle/pricePaid are
  // copied in at write time so a review still reads correctly after the coupon
  // row is edited or removed.
  [SHEETS.REVIEWS]: [
    'id',
    'couponId',
    'buyerEmail',
    'buyerUserId',
    'brand',
    'couponTitle',
    'pricePaid',
    'rating',
    'reviewText',
    'createdAt',
    'updatedAt',
  ],
  // Homepage testimonials, written and ordered entirely from the admin panel's
  // Reviews section. These are marketing copy the admin controls — unrelated to
  // SHEETS.REVIEWS above, which holds real buyer reviews of purchased coupons.
  //
  // isVisible / sortOrder are stored as strings because sheet writes are RAW:
  // 'false' and '0' read back unambiguously, an empty cell does not.
  [SHEETS.TESTIMONIALS]: [
    'id',
    'name',
    // The location line shown under the reviewer's name on the homepage card
    // (e.g. "Kolkata, India"). Historic rows may hold a job title instead —
    // readers treat it as a free-form subtitle either way.
    'role',
    'quote',
    'rating',
    // Review-carousel extras (added after the carousel replaced the static
    // three-card grid). ensureSheets() appends these headers to the right of
    // the live tab, so older rows simply read back empty here.
    //   verified — 'true' renders the blue check beside the name
    //   photo    — sprite key: 'priya' | 'arjun' | 'neha' | '' (initials tile)
    //   brand    — coupon store chip (e.g. "Myntra")
    //   offer    — coupon name (e.g. "Myntra Fashion Coupon")
    //   detail   — offer terms line (e.g. "50% OFF on selected styles")
    //   savings  — amount the reviewer saved, rendered as "Saved ₹800"
    'verified',
    'photo',
    'brand',
    'offer',
    'detail',
    'savings',
    'isVisible',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  // One row per user holding their authenticator-app enrolment.
  //
  // secretEncrypted / pendingSecretEncrypted are AES-256-GCM blobs, never the
  // raw base32 secret. recoveryCodes is a JSON array of
  // { hash, usedAt, usedIp } — bcrypt hashes only, so a leaked sheet yields no
  // usable code. pendingSecretEncrypted holds the not-yet-confirmed secret
  // during enrolment and is cleared the moment 2FA is enabled or abandoned.
  [SHEETS.USER_TWO_FACTOR]: [
    'userId',
    'email',
    'enabled',
    'secretEncrypted',
    'pendingSecretEncrypted',
    'pendingCreatedAt',
    'recoveryCodes',
    'lastCounter',
    'enabledAt',
    'disabledAt',
    'lastUsedAt',
    'updatedAt',
  ],
  // Append-only security event log. Never holds codes, secrets or hashes.
  [SHEETS.SECURITY_AUDIT]: [
    'id',
    'userId',
    'email',
    'event',
    'outcome',
    'ipAddress',
    'device',
    'detail',
    'createdAt',
  ],
  [SHEETS.SUPPORT_TICKETS]: [
    'id', 'name', 'userEmail', 'subject', 'message',
    'status', 'createdAt', 'resolvedAt', 'resolution', 'attachmentUrl', 'attachmentName',
    // Added after the columns above. ensureSheets() appends missing headers to
    // the right of an existing tab without moving data, so pre-existing rows
    // simply read back empty here and the readers below fall back.
    //   updatedAt — bumped on every reply and status change, so the support list
    //               can show a real "last updated" instead of the created date.
    //   messages  — JSON array holding the reply thread:
    //               [{ from: 'user' | 'support', body, at }]
    'updatedAt', 'messages',
    // Support category and the references it needs. Appended like the columns
    // above, so existing rows read back empty and the readers fall back.
    'category', 'orderId', 'transactionId', 'utr', 'couponId', 'brand',
    'payoutRef', 'reportedUser', 'pageUrl', 'amount', 'paymentDate',
    // Screenshot metadata for the Drive-backed attachment. attachmentUrl holds
    // the reference ('drive:<fileId>'), these describe the file itself so the
    // ticket view can label it without fetching from Drive first.
    'attachmentMime', 'attachmentSize', 'attachmentFileId', 'attachmentUploadedAt',
  ],
  [SHEETS.SETTINGS]: [
    'key', 'activeUsers', 'couponsTraded', 'savedByUsers', 'platformName', 'adminEmail', 'showActiveUsers', 'showCouponsTraded', 'showSavedByUsers',
    // heroBadge/showHeroBadge were removed — the landing-page hero badge is now
    // permanent. The two columns may still exist in live sheets; rows are
    // mapped by header name, so they are simply never read or written again.
    // Homepage testimonials section — the heading copy and whether the section
    // renders at all. The testimonials themselves live in SHEETS.TESTIMONIALS.
    // testimonialsSeeded is an internal one-time flag: it stops the three
    // starter testimonials being re-created after an admin deletes them.
    'testimonialsLabel', 'testimonialsTitle', 'testimonialsTitleHighlight',
    'testimonialsSubtitle', 'showTestimonials', 'testimonialsSeeded',
    'updatedAt',
  ],
  [SHEETS.OTP_REQUESTS]: [
    'id', 'userId', 'userIdEmail', 'email', 'ipAddress', 'otpHash',
    'requestedAt', 'expiresAt', 'verifiedAt',
    'status', 'requestNumber', 'dailyRequestCount',
    'hourlyRequestCount', 'verifyAttempts',
    // Appended by ensureSheets() on existing tabs (data is never moved):
    //   limitKey    — canonical email the rate limit is counted on (+tags and
    //                 gmail dots folded), so alias tricks share one bucket.
    //   blockReason — why a request was refused / voided, for the audit trail.
    //   purpose     — 'login' (6-digit sign-in code) or '2fa_setup' (8-digit
    //                 enrolment code). Blank on pre-existing rows, which
    //                 otpService reads as 'login'.
    'limitKey', 'blockReason', 'purpose',
  ],
  [SHEETS.BACKUP_CODE_AUDIT]: [
    'id', 'codeSuffix', 'reason', 'ip', 'userAgent', 'chosenEmail',
    'success', 'initAt', 'completeAt', 'error',
  ],
  [SHEETS.CHATBOT_SETTINGS]: ['key', 'value', 'updated_at'],
  [SHEETS.CHATBOT_KNOWLEDGE]: [
    'id', 'category', 'question', 'answer', 'keywords', 'enabled', 'created_at', 'updated_at',
  ],
  [SHEETS.CHATBOT_CONVERSATIONS]: [
    'id', 'user_id', 'user_email', 'user_name', 'is_guest',
    'message_count', 'status', 'flagged', 'started_at', 'last_active_at',
  ],
  [SHEETS.CHATBOT_MESSAGES]: [
    'id', 'conversation_id', 'role', 'content',
    'response_time_ms', 'model', 'status', 'created_at',
  ],
  [SHEETS.CHATBOT_LOGS]: [
    'id', 'timestamp', 'request_id', 'user', 'conversation_id',
    'model', 'response_time_ms', 'status', 'error_type',
  ],
  [SHEETS.CHATBOT_AUDIT]: [
    'id', 'timestamp', 'admin_id', 'admin_email', 'action',
    'setting', 'old_value', 'new_value',
  ],

  // ── Custom UPI checkout ────────────────────────────────────────────────
  // One row per purchase attempt. `amount` is the server's own figure (read
  // from the coupon), never the browser's — it is the price the QR encodes.
  // Column names deliberately mirror the SQL these tables replaced, so the
  // field mapping in services/paymentStore.js stays a 1:1 rename.
  [SHEETS.ORDERS]: [
    'id',
    'order_code',
    'user_id',
    'user_email',
    'coupon_id',
    'amount',
    'currency',
    'status',
    'buyer_name',
    'buyer_email',
    'buyer_phone',
    'coupon_code',
    'coupon_brand',
    'created_at',
    'updated_at',
    'expires_at',
    'paid_at',
    // Canonical financial identifiers (see server/utils/identifiers.js).
    // `order_code` above is the human Order ID (SH-PUR-YYYYMMDD-XXXXXX for new
    // rows, legacy SH-XXXXXX for old ones). `transaction_id` is the separate
    // TXN-YYYYMMDD-XXXXXXXX financial-transaction id; `transaction_type` is
    // always 'PURCHASE' for an order row. APPENDED AT THE END so existing rows
    // keep lining up (they read back blank and callers fall back).
    'transaction_id',
    'transaction_type',
    // Historical coupon snapshot (JSON string) written when a sold coupon is
    // removed from the inventory stores, so purchase history keeps rendering
    // after an inventory reset. APPENDED AT THE END — old rows read back blank.
    'coupon_snapshot',
  ],
  // One row per UPI payment attempt against an order. verified_transaction_id
  // / verified_utr are only ever written by the server-side verifier.
  // received_amount is the verified rupee total the bank reported; it can
  // differ from `amount` (the coupon's required price) and the difference
  // drives the refund record. APPENDED AT THE END on purpose so existing
  // rows and any older header positions keep lining up.
  [SHEETS.PAYMENTS]: [
    'payment_id',
    'order_id',
    'user_id',
    'user_email',
    'coupon_id',
    'amount',
    'currency',
    'status',
    'created_at',
    'updated_at',
    'expires_at',
    'paid_at',
    'upi_id',
    'payee_name',
    'upi_uri',
    'verified_transaction_id',
    'verified_utr',
    'verification_source',
    'verification_notes',
    'received_amount',
    // Backend checking deadline (20 min from creation, PAYMENT_CHECK_WINDOW_MS).
    // The 10-minute `expires_at` above still drives the on-screen countdown.
    // APPENDED AT THE END so existing rows keep lining up.
    'check_expires_at',
    // Two-timer verification fields (see server/services/paymentWindow.js).
    // payment_expires_at  — server-clock instant the customer timer expired
    // verification_started_at — same instant; the backend window opens here
    // verification_deadline — payment_expires_at + 10 minutes
    // last_checked_at     — last server-side verification pass for this session
    // All blank on legacy rows; blank means "not yet expired", so existing data
    // is never rewritten.
    'payment_expires_at',
    'verification_started_at',
    'verification_deadline',
    'last_checked_at',
  ],
  // Every confirmation the server observes (gateway webhook or payment-mailbox
  // email), recorded before it is acted on. `fingerprint` is the identity that
  // makes detection exactly-once; `raw` is a truncated payload kept for
  // disputes.
  [SHEETS.PAYMENT_NOTIFICATIONS]: [
    'id',
    'fingerprint',
    'source',
    'amount',
    'currency',
    'transaction_id',
    'utr',
    'payer_vpa',
    'payee_vpa',
    'reference',
    'occurred_at',
    'status',
    'matched_payment_id',
    'notes',
    'created_at',
    'processed_at',
    'raw',
  ],
  // One row per connected payment mailbox. Tracks the Gmail push (watch) state:
  // the last processed historyId (so incremental scans read only new messages)
  // and the current watch expiration (so a daily cron renews it in time).
  [SHEETS.PAYMENT_GMAIL_STATE]: [
    'email',
    'last_history_id',
    'watch_expiration',
    'updated_at',
  ],
  // One row per refund event triggered by a payment-amount mismatch (the buyer
  // paid more or less than the coupon's required amount). Overpayments refund
  // the excess; underpayments refund the partial amount actually received —
  // never more than the verified received amount. refund_amount / received_amount
  // / required_amount are stored as integer paise to avoid binary FP drift.
  // Each refund also tracks its status lifecycle (pending → processing →
  // refunded / rejected) so the seller-facing dashboard can render a real
  // audit trail, not a single mutable flag.
  [SHEETS.REFUNDS]: [
    'id',
    'user_id',
    'user_email',
    'payment_id',
    'coupon_id',
    'order_code',
    'required_amount',
    'received_amount',
    'refund_amount',
    'currency',
    'mismatch_type',     // 'overpayment' | 'underpayment'
    'refund_reason',     // human-readable reason assigned automatically
    'status',            // 'pending' | 'processing' | 'refunded' | 'rejected'
    'refund_reference',  // bank/UPI txn id once processed
    'admin_note',
    'processed_at',
    'processed_by',
    'created_at',
    'updated_at',
    // Canonical financial identifiers (see server/utils/identifiers.js).
    // `order_code` above is a REFERENCE to the original purchase order being
    // refunded. These three are the refund's OWN standardized identity:
    //   order_id         SH-REF-YYYYMMDD-XXXXXX (the refund's Order ID)
    //   transaction_id   TXN-YYYYMMDD-XXXXXXXX  (the refund financial txn)
    //   transaction_type always 'REFUND'
    // APPENDED AT THE END; legacy refunds read back blank and fall back to
    // refund_id/order_code for display.
    'order_id',
    'transaction_id',
    'transaction_type',
  ],
  // Admin revenue-share payout ledger (40/40/20). One row per payout event; the
  // acting admin, amount, status and references are the audit trail. Amounts are
  // rupees. status ∈ pending|processing|paid|rejected|failed.
  [SHEETS.ADMIN_PAYOUTS]: [
    'id',
    'admin_email',
    'admin_name',
    'amount',
    'currency',
    'status',
    'payment_reference',
    'note',
    'rejection_reason',
    'requested_at',
    'processed_at',
    'processed_by',
    'created_by',
    'created_at',
    'updated_at',
  ],
  // One row per reconciled calendar month. UPSERTED by `month` (YYYY-MM) — never
  // appended twice — so re-opening a month updates its row in place. Figures are
  // the ones services/finance.js computed for that month (rupees).
  [SHEETS.MONTHLY_SETTLEMENTS]: [
    'id',
    'month',            // YYYY-MM — the unique key
    'monthLabel',       // "August 2026"
    'periodStart',
    'periodEnd',
    'grossSales',
    'pendingSales',
    'cancelledSales',
    'refundedSales',
    'settledSales',
    'sellerRevenue',
    'platformServiceFeeRevenue',
    'gatewayFees',
    'otherCharges',
    'netDistributableRevenue',
    'admin1Allocation',
    'admin2Allocation',
    'platformAllocation',
    'reconciliationVariance',
    'updatedAt',
  ],
};

let sheetsClient = null;
let spreadsheetId = null;
let lastSheetsError = null;
let serviceAccountEmail = null;

// A leftover debug beacon used to live here: it POSTed JSON to
// http://127.0.0.1:7777/event on every cold start, with the destination
// overridable by reading `.dbg/coupon-gsheet-sync.env` from disk, and included
// the spreadsheet-ID suffix and a service-account email hint. It was removed
// because it is an unmonitored outbound channel inside the one module that
// holds the Google service-account private key, and because nothing consumes
// its output any more. All diagnostics below go through console.* instead,
// which lands in the platform's protected server logs.

/**
 * Initialize the Google Sheets client using Service Account credentials.
 * Falls back to a local in-memory store if credentials are not configured,
 * allowing development without a live Google Sheet.
 */
async function initialize() {
  spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  serviceAccountEmail = email || null;
  lastSheetsError = null;

  if (!spreadsheetId || !email || !privateKey || spreadsheetId === 'your_spreadsheet_id_here') {
    lastSheetsError = {
      type: 'missing-config',
      message: 'Google Sheets credentials are not fully configured.',
    };
    console.warn('⚠️  Google Sheets credentials not configured. Using in-memory fallback database.');
    console.warn('   To connect Google Sheets, fill in your .env file. See .env.example for details.');
    return false;
  }

  try {
    const cleanKey = privateKey.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
    const auth = new google.auth.JWT(
      email,
      null,
      cleanKey,
      ['https://www.googleapis.com/auth/spreadsheets']
    );

    sheetsClient = google.sheets({ version: 'v4', auth });

    // Verify connection by reading spreadsheet metadata. The response is
    // handed to ensureSheets(), which used to issue a second identical
    // spreadsheets.get straight afterwards — one wasted round-trip (~1.4s) on
    // every cold start.
    const metaRes = await sheetsClient.spreadsheets.get({ spreadsheetId });
    console.log('✅ Connected to Google Sheets database.');

    // Ensure all sheet tabs exist with headers
    await ensureSheets(metaRes);
    return true;
  } catch (err) {
    const looksLikeAccessOrMissingSheet = err.code === 404 || err.status === 404;
    lastSheetsError = {
      type: looksLikeAccessOrMissingSheet ? 'sheet-not-found-or-no-access' : 'connect-failed',
      message: err.message,
      code: err.code || err.status || '',
    };
    // #region debug-point A:sheets-connect-failed
    // (beacon removed — diagnostics go to the protected server log below)
    // #endregion
    console.error('❌ Failed to connect to Google Sheets:', err.message);
    console.warn('   Falling back to in-memory database.');
    sheetsClient = null;
    return false;
  }
}

function isSheetsConnected() {
  return Boolean(sheetsClient);
}

function getStorageStatus() {
  return {
    connected: Boolean(sheetsClient),
    mode: sheetsClient ? 'google-sheets' : 'memory-fallback',
    spreadsheetId,
    serviceAccountEmail,
    lastError: lastSheetsError,
  };
}

function getWriteAvailabilityError(message = 'Google Sheets is not connected.') {
  if (sheetsClient) return null;

  return {
    error: message,
    details: {
      spreadsheetId,
      serviceAccountEmail,
      reason: lastSheetsError?.message || 'Google Sheets connection unavailable.',
      type: lastSheetsError?.type || 'unavailable',
    },
  };
}

// Convert a 1-indexed column number to A1 notation (1→A, 27→AA, …)
function columnToLetter(col) {
  let s = '';
  while (col > 0) {
    const m = (col - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}

/**
 * Ensure all required sheets exist and have headers.
 * Existing tabs are upgraded: any configured headers missing from the tab's
 * header row are appended as new columns on the right (existing data is
 * never moved or shifted).
 */
async function ensureSheets(prefetched) {
  if (!sheetsClient) return;

  try {
    // initialize() already fetched the spreadsheet metadata; reuse it instead
    // of paying for a second identical call.
    const res = prefetched || (await sheetsClient.spreadsheets.get({ spreadsheetId }));

    // sheetId is needed to grow a grid, and columnCount tells us whether a
    // missing header even fits before we try to write it.
    const meta = {};
    res.data.sheets.forEach((s) => {
      meta[s.properties.title] = {
        sheetId: s.properties.sheetId,
        columnCount: (s.properties.gridProperties || {}).columnCount || 0,
      };
    });
    const existingSheets = Object.keys(meta);

    // 1. Create any tab that does not exist yet, with its header row. Only
    //    ever runs on a fresh spreadsheet / after a new feature adds a tab.
    const created = [];
    for (const [sheetName, headers] of Object.entries(HEADERS)) {
      if (existingSheets.includes(sheetName)) continue;
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: sheetName } } }],
        },
      });
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headers] },
      });
      created.push(sheetName);
    }

    // 2. Top up the header row of each EXISTING tab with columns added since it
    //    was created. This used to be one values.get per tab — 24 sequential
    //    round-trips, ~24s, paid on EVERY cold start because initServices()
    //    runs on the first request of each serverless instance. That was the
    //    "sometimes the dashboard is slow" delay. batchGet collapses all 24
    //    reads into a single request.
    const toCheck = Object.keys(HEADERS).filter(
      (name) => existingSheets.includes(name) && !created.includes(name)
    );
    if (!toCheck.length) return;

    const batch = await sheetsClient.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: toCheck.map((name) => `${name}!1:1`),
    });
    const valueRanges = batch.data.valueRanges || [];

    const updates = [];
    const expansions = [];

    toCheck.forEach((sheetName, i) => {
      const current = (valueRanges[i] && valueRanges[i].values && valueRanges[i].values[0]) || [];
      const currentNorm = current.map((c) => normKey(c));
      const missing = HEADERS[sheetName].filter((h) => !currentNorm.includes(normKey(h)));
      if (!missing.length) return;

      const startCol = current.length + 1;                 // 1-based column index
      const lastNeeded = startCol + missing.length - 1;    // last column the header needs
      const gridCols = meta[sheetName].columnCount;

      // A grid that is full rejects the write outright ("Range (X!AF1) exceeds
      // grid limits") and, in a batch, would take every other tab down with it.
      // Grow the grid by the shortfall first — this is what the old per-tab
      // code was reaching for, and why Coupons never got its `backgroundImage`
      // header: the tab was already at its 31-column limit.
      if (lastNeeded > gridCols) {
        expansions.push({
          sheetId: meta[sheetName].sheetId,
          length: lastNeeded - gridCols,
          sheetName,
        });
      }

      updates.push({
        range: `${sheetName}!${columnToLetter(startCol)}1`,
        values: [missing],
      });
    });

    if (expansions.length) {
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: expansions.map((e) => ({
            appendDimension: { sheetId: e.sheetId, dimension: 'COLUMNS', length: e.length },
          })),
        },
      });
      expansions.forEach((e) => {
        console.log(`ensureSheets: grew ${e.sheetName} by ${e.length} column(s) to fit new headers.`);
      });
    }

    if (updates.length) {
      await sheetsClient.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data: updates },
      });
      console.log(
        'ensureSheets: added missing headers to ' +
        updates.map((u) => u.range.split('!')[0]).join(', ')
      );
    }
  } catch (err) {
    console.warn('ensureSheets warning:', err.message);
  }
}

// ── In-Memory Fallback Database ─────────────────────────────────────────────
// Used when Google Sheets credentials are not available
const memoryDB = {
  [SHEETS.USERS]: [],
  [SHEETS.COUPONS]: [],
  [SHEETS.PRICE_TRACKING]: [],
  [SHEETS.SUPPORT_TICKETS]: [],
  [SHEETS.SETTINGS]: [],
  [SHEETS.OTP_REQUESTS]: [],
  [SHEETS.COUPON_AUDIT]: [],
  [SHEETS.PAYOUTS]: [],
  [SHEETS.REVIEWS]: [],
  [SHEETS.USER_TWO_FACTOR]: [],
  [SHEETS.SECURITY_AUDIT]: [],
  [SHEETS.BACKUP_CODE_AUDIT]: [],
  [SHEETS.TESTIMONIALS]: [],
  [SHEETS.ORDERS]: [],
  [SHEETS.PAYMENTS]: [],
  [SHEETS.PAYMENT_NOTIFICATIONS]: [],
  [SHEETS.REFUNDS]: [],
  [SHEETS.ADMIN_PAYOUTS]: [],
  [SHEETS.MONTHLY_SETTLEMENTS]: [],
};

function seedDemoData() {
  // No-op: Demo coupons removed per requirements
}

// Short-term in-memory cache to speed up repeated queries (e.g. user logins)
const rowsCache = {};
const CACHE_TTL_MS = 3000; // 3 seconds

function invalidateCache(sheetName) {
  delete rowsCache[sheetName];
}

/**
 * Get all rows from a sheet. Returns array of objects keyed by column header.
 */
// The range a sheet is read with. The Coupons tab carries more columns than fit
// in A:Z (and the sellerPayout column is appended at the very end), so reading
// only A:Z would silently drop every column past Z — including the stored
// payout. Reading it wider keeps stored values visible instead of masking them.
function readRangeFor(sheetName) {
  return sheetName === SHEETS.COUPONS ? 'A:BZ' : 'A:Z';
}

async function getRows(sheetName, options = {}) {
  // Strict reads are used by financial callers: the spreadsheet is the source
  // of truth, so an unreachable spreadsheet must surface as an error instead of
  // silently degrading to this process's in-memory mirror. Without it a Sheets
  // outage looks like an empty (or stale) ledger and the caller proceeds.
  const strict = options.strict === true;
  const now = Date.now();
  if (!strict && rowsCache[sheetName] && (now - rowsCache[sheetName].timestamp < CACHE_TTL_MS)) {
    return [...rowsCache[sheetName].data];
  }

  if (!sheetsClient) {
    if (strict) throw new Error(`Google Sheets is unavailable for a strict read of ${sheetName}`);
  }

  if (sheetsClient) {
    try {
      const res = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!${readRangeFor(sheetName)}`,
      });

      const rows = res.data.values;
      if (!rows || rows.length <= 1) {
        const fallback = [...(memoryDB[sheetName] || [])];
        rowsCache[sheetName] = { data: fallback, timestamp: now };
        return fallback;
      }

      const headers = rows[0];
      const gsheetRows = rows.slice(1).map((row) => {
        const obj = {};
        headers.forEach((h, i) => {
          if (String(h).trim() === '') return;
          const v = row[i] || '';
          obj[h] = v;
          // Also expose the value under the normalized key so code using
          // "user_id" can read a sheet headed "user_ID".
          const nk = normKey(h);
          if (obj[nk] === undefined) obj[nk] = v;
        });
        if (sheetName === SHEETS.USERS) {
          // Normalize email on read so every downstream lookup
          // (findRow, updateRow) is case-insensitive. Without this, a
          // historical row written with mixed-case email would never
          // match a lowercased cleanEmail and a duplicate row would
          // be appended on the next login.
          if (typeof obj.email === 'string') {
            obj.email = obj.email.toLowerCase().trim();
          }
        }
        if (sheetName === SHEETS.USERS) {
          // Resolve the canonical user_id even if the sheet's header uses a
          // different naming convention (userId, userid, UserID, id, uuid…).
          // The sheet's `user_id` column is the source of truth for sessions
          // and admin lookups, so we sync every common variant to it.
          let resolvedUserId = '';
          for (const [key, value] of Object.entries(obj)) {
            if (value === '' || value == null) continue;
            const nk = normKey(key).replace(/[\s_-]+/g, '');
            if (nk === 'userid' || nk === 'uuid') {
              resolvedUserId = String(value);
              break;
            }
          }
          if (!resolvedUserId) resolvedUserId = obj.user_ID || obj.user_id || obj.userId || obj.userid || obj.id || obj.uuid || '';
          obj.id = resolvedUserId;
          obj.user_ID = resolvedUserId;
          obj.user_id = resolvedUserId;
          obj.createdAt = obj.created_at || obj.createdAt || '';
          obj.created_at = obj.created_at || obj.createdAt || '';
        }
        return obj;
      });

      // Combine with memoryDB rows to prevent data loss when fallback was active.
      // The match must use the sheet's own natural key: keying this on `id`/`code`
      // alone made a row whose identity is `payment_id` (Payments) or
      // `fingerprint` (PaymentNotifications) appear TWICE — once from the sheet
      // and once from memoryDB — which downstream code read as two live records.
      // Strict reads skip the memoryDB merge, exactly like strict writes skip
      // the memoryDB write. A financial caller must never see a row that only
      // exists in one instance's RAM: an unacknowledged write would otherwise
      // read back as a real payment/order and could be settled twice.
      const combined = strict ? [...gsheetRows] : (() => {
        const memRows = memoryDB[sheetName] || [];
        const out = [...gsheetRows];
        memRows.forEach((m) => {
          if (!out.some((g) => sameRow(sheetName, g, m))) {
            out.push(m);
          }
        });
        return out;
      })();

      rowsCache[sheetName] = { data: combined, timestamp: Date.now() };
      return combined;
    } catch (err) {
      if (strict) throw new Error(`Google Sheets read failed for ${sheetName}`);
      console.warn(`getRows warning for ${sheetName}:`, err.message);
    }
  }

  const fallback = [...(memoryDB[sheetName] || [])];
  rowsCache[sheetName] = { data: fallback, timestamp: Date.now() };
  return fallback;
}

// Normalize header names for matching (live sheets may use e.g. "user_ID"
// while code uses "user_id" — treat them as the same column).
const normKey = (h) => String(h || '').trim().toLowerCase();

// The column(s) that identify a row in each sheet.
//
// Both memoryDB reconciliation (getRows) and appendRow's upsert need to know
// what "the same row" means. They used to hardcode `id`/`code`, which is
// wrong for any sheet keyed by something else: a Payments row is keyed by
// `payment_id`, so the memoryDB copy never matched its sheet twin and the row
// was returned TWICE on every read. Listing the keys per sheet fixes that, and
// keeps the fix from being payment-specific.
//
// The default stays `id`/`code` — the previous behaviour — so every sheet not
// listed here is completely unaffected.
const NATURAL_KEYS = {
  [SHEETS.ORDERS]: ['id', 'order_code'],
  [SHEETS.PAYMENTS]: ['payment_id'],
  [SHEETS.PAYMENT_NOTIFICATIONS]: ['id', 'fingerprint'],
  [SHEETS.ADMIN_PAYOUTS]: ['id'],
  [SHEETS.MONTHLY_SETTLEMENTS]: ['id', 'month'],
};

const DEFAULT_NATURAL_KEYS = ['id', 'code'];

/**
 * Are these two rows the same record? True when any natural key for the sheet
 * is populated on both sides and equal. Blank/absent values never match, so a
 * row missing its key cannot swallow an unrelated row.
 */
function sameRow(sheetName, a, b) {
  if (!a || !b) return false;
  const keys = NATURAL_KEYS[sheetName] || DEFAULT_NATURAL_KEYS;
  return keys.some((k) => {
    const av = a[k], bv = b[k];
    if (av === undefined || av === null || av === '') return false;
    if (bv === undefined || bv === null || bv === '') return false;
    return String(av) === String(bv);
  });
}

// Build a lookup of data values by normalized key name.
function dataByNormKey(data) {
  const map = {};
  Object.entries(data || {}).forEach(([k, v]) => {
    map[normKey(k)] = v;
  });
  return map;
}

/**
 * Append a row to a sheet.
 * @param {string} sheetName
 * @param {object} data — object with keys matching column headers (case-insensitive)
 */
async function appendRow(sheetName, data, options = {}) {
  const headers = HEADERS[sheetName];
  if (!headers) throw new Error(`Unknown sheet: ${sheetName}`);
  const strict = options.strict === true;
  if (strict && !sheetsClient) throw new Error('Google Sheets is unavailable for a financial write');

  // Normalize on write so every newly-appended row has a canonical
  // email value. Without this, a row written by an older code path
  // (e.g. mixed case) would still cause a duplicate-row bug because
  // getRows cannot retroactively normalize values that were never
  // fetched yet (i.e. they only exist in the live sheet until the
  // next read).
  if (sheetName === SHEETS.USERS && data && typeof data.email === 'string') {
    data = { ...data, email: data.email.toLowerCase().trim() };
  }

  // Upsert on the sheet's natural key, not just id/code. Strict financial
  // writes update the in-process mirror only after Sheets acknowledges them.
  const remember = () => {
    memoryDB[sheetName] = memoryDB[sheetName] || [];
    const existingIdx = memoryDB[sheetName].findIndex((r) => sameRow(sheetName, r, data));
    if (existingIdx >= 0) memoryDB[sheetName][existingIdx] = data;
    else memoryDB[sheetName].push(data);
  };
  if (!strict) remember();

  if (sheetsClient) {
    try {
      // Align values with the sheet's actual header row (case-insensitive)
      // so data lands in the correct columns even if the live tab's headers
      // differ from config in naming or order.
      let rowHeaders = headers;
      try {
        const hdrRes = await sheetsClient.spreadsheets.values.get({
          spreadsheetId,
          range: `${sheetName}!1:1`,
        });
        const actual = hdrRes.data.values && hdrRes.data.values[0]
          ? hdrRes.data.values[0].filter((h) => String(h).trim() !== '')
          : [];
        if (actual.length) rowHeaders = actual;
      } catch (e) {
        // Header read failed — fall back to configured header order
      }
      const normData = dataByNormKey(data);
      const row = rowHeaders.map((h) => {
        const v = data[h] !== undefined ? data[h] : normData[normKey(h)];
        return v !== undefined && v !== null ? v : '';
      });
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      });
    } catch (err) {
      console.warn(`Google Sheets append warning for ${sheetName}:`, err.message);
      if (strict) throw new Error('Google Sheets financial write failed');
      data.gsheetError = err.message;
    }
  }

  if (strict) remember();

  invalidateCache(sheetName);
  return data;
}

/**
 * Normalize a lookup value for case-insensitive matching on the user
 * email field. Without this, a row written long ago with mixed-case
 * email (e.g. "Rupayan@Example.com") would never match the lowercased
 * `cleanEmail` the auth code uses, and a duplicate user row would be
 * appended on the next login.
 */
function normalizeLookupValue(sheetName, field, value) {
  if (sheetName === SHEETS.USERS && field === 'email' && typeof value === 'string') {
    return value.toLowerCase().trim();
  }
  return value;
}

/**
 * Normalize the same key on the row side, so lookups match even when
 * the row's stored email value hasn't been through `getRows` yet (e.g.
 * freshly-appended rows sitting in memoryDB).
 */
function normalizeRowValue(sheetName, field, value) {
  if (sheetName === SHEETS.USERS && field === 'email' && typeof value === 'string') {
    return value.toLowerCase().trim();
  }
  return value;
}

async function findRow(sheetName, field, value) {
  const rows = await getRows(sheetName);
  const nv = normalizeLookupValue(sheetName, field, value);
  return rows.find((r) => normalizeRowValue(sheetName, field, r[field]) === nv) || null;
}

/**
 * Find all rows matching a field value.
 */
async function findRows(sheetName, field, value) {
  const rows = await getRows(sheetName);
  const nv = normalizeLookupValue(sheetName, field, value);
  return rows.filter((r) => normalizeRowValue(sheetName, field, r[field]) === nv);
}

/**
 * Get all rows from a sheet, bypassing (and clearing) the 3-second read
 * cache. Security counters must never be computed from a stale snapshot:
 * two OTP requests a second apart would otherwise both read the same
 * cached rows and both pass a limit that only one should.
 */
async function getRowsFresh(sheetName, options = {}) {
  invalidateCache(sheetName);
  return getRows(sheetName, options);
}

/**
 * findRows against a guaranteed-fresh read.
 */
async function findRowsFresh(sheetName, field, value) {
  await getRowsFresh(sheetName);
  return findRows(sheetName, field, value);
}

/**
 * Update a row by finding it via a field match and replacing values.
 */
async function updateRow(sheetName, field, value, updatedData, options = {}) {
  const strict = options.strict === true;
  // Always update memoryDB to guarantee local consistency
  const arr = memoryDB[sheetName] || [];
  const nv = normalizeLookupValue(sheetName, field, value);
  const idx = arr.findIndex((r) => normalizeRowValue(sheetName, field, r[field]) === nv);
  if (!strict && idx !== -1) {
    arr[idx] = { ...arr[idx], ...updatedData };
  }

  if (!sheetsClient) {
    if (strict) throw new Error('Google Sheets is unavailable for a financial write');
    invalidateCache(sheetName);
    return idx !== -1 ? arr[idx] : null;
  }

  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!${readRangeFor(sheetName)}`,
    });

    const rows = res.data.values;
    if (!rows || rows.length <= 1) {
      if (strict) throw new Error('Financial row was not found');
      invalidateCache(sheetName);
      return idx !== -1 ? arr[idx] : null;
    }

    const headers = rows[0];
    let fieldIdx = headers.indexOf(field);
    if (fieldIdx === -1) fieldIdx = headers.findIndex((h) => normKey(h) === normKey(field));
    if (fieldIdx === -1) {
      if (strict) throw new Error('Financial row key was not found');
      invalidateCache(sheetName);
      return idx !== -1 ? arr[idx] : null;
    }

    // Find the row index (1-indexed, +1 for header)
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (normalizeRowValue(sheetName, field, rows[i][fieldIdx]) === nv) {
        rowIndex = i + 1; // Sheets is 1-indexed
        break;
      }
    }

    if (rowIndex === -1) {
      if (strict) throw new Error('Financial row was not found');
      invalidateCache(sheetName);
      return idx !== -1 ? arr[idx] : null;
    }

    // Merge existing row with updates (match keys case-insensitively so
    // "user_id" updates land under a sheet headed "user_ID").
    const existingRow = rows[rowIndex - 1];
    const normUpdates = dataByNormKey(updatedData);
    const merged = {};
    headers.forEach((h, i) => {
      const v = updatedData[h] !== undefined ? updatedData[h]
        : normUpdates[normKey(h)] !== undefined ? normUpdates[normKey(h)]
        : (existingRow[i] || '');
      if (String(h).trim() !== '' || v !== '') merged[h] = v;
    });

    // Keep falsy values (false, 0) — `merged[h] || ''` used to wipe a `false`
    // toggle into an empty cell, which read back as the default (true).
    const newRow = headers.map((h) => (merged[h] === undefined || merged[h] === null ? '' : merged[h]));
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [newRow] },
    });

    if (strict && idx !== -1) arr[idx] = { ...arr[idx], ...updatedData };

    invalidateCache(sheetName);
    return merged;
  } catch (err) {
    console.warn(`Google Sheets update warning for ${sheetName}:`, err.message);
    invalidateCache(sheetName);
    if (strict) throw new Error('Google Sheets financial write failed');
    return idx !== -1 ? arr[idx] : null;
  }
}

/**
 * Delete a row by finding it via a field match.
 */
async function deleteRow(sheetName, field, value) {
  // Always update memoryDB
  const arr = memoryDB[sheetName] || [];
  const idx = arr.findIndex((r) => r[field] === value);
  if (idx !== -1) {
    arr.splice(idx, 1);
  }
  invalidateCache(sheetName);

  if (!sheetsClient) {
    return idx !== -1;
  }

  try {
    // For Sheets, we need the sheet's gid to delete a row
    const spreadsheet = await sheetsClient.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find(
      (s) => s.properties.title === sheetName
    );
    if (!sheet) return false;

    const sheetId = sheet.properties.sheetId;

    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:Z`,
    });

    const rows = res.data.values;
    if (!rows || rows.length <= 1) return false;

    const headers = rows[0];
    let fieldIdx = headers.indexOf(field);
    if (fieldIdx === -1) fieldIdx = headers.findIndex((h) => normKey(h) === normKey(field));
    if (fieldIdx === -1) return false;

    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][fieldIdx] === value) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex === -1) return false;

    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        }],
      },
    });

    invalidateCache(sheetName);
    return true;
  } catch (err) {
    console.warn(`Google Sheets delete warning for ${sheetName}:`, err.message);
    // Fall back to memoryDB
    const arr = memoryDB[sheetName] || [];
    const idx = arr.findIndex((r) => r[field] === value);
    if (idx === -1) return false;
    arr.splice(idx, 1);
    return true;
  }
}

/**
 * Delete every row matching predicate(row) in ONE batched request.
 * Used by inventory maintenance (mirroring/dedup) where per-row deleteRow
 * round-trips are too slow and row identities can collide on a field match.
 * predicate receives the row object keyed by header. Rows are deleted
 * bottom-up so earlier indexes stay valid; the whole set goes out as a single
 * batchUpdate. MemoryDB is rebuilt from the survivors.
 */
async function deleteRowsWhere(sheetName, predicate) {
  if (!sheetsClient) {
    const arr = memoryDB[sheetName] || [];
    const survivors = arr.filter((r) => !predicate(r));
    const removed = arr.length - survivors.length;
    memoryDB[sheetName] = survivors;
    invalidateCache(sheetName);
    return removed;
  }
  const spreadsheet = await sheetsClient.spreadsheets.get({ spreadsheetId });
  const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) return 0;
  const sheetId = sheet.properties.sheetId;

  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:Z`,
  });
  const rows = res.data.values;
  if (!rows || rows.length <= 1) return 0;
  const headers = rows[0];

  // rows[i] is the 0-based sheet row i (row 0 = header). A data row at index
  // i therefore maps to deleteDimension startIndex i.
  const doomed = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = rows[i][idx] === undefined ? '' : String(rows[i][idx]); });
    if (predicate(obj)) doomed.push(i);
  }
  if (doomed.length === 0) return 0;

  // Bottom-up ranges; merge adjacent indexes into single ranges.
  const ranges = [];
  let start = null; let prev = null;
  for (const i of doomed.sort((a, b) => b - a)) {
    if (prev !== null && i === prev - 1) { prev = i; continue; }
    if (prev !== null) ranges.push({ startIndex: prev, endIndex: start + 1 });
    start = i; prev = i;
  }
  ranges.push({ startIndex: prev, endIndex: start + 1 });

  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: ranges.map((r) => ({
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: r.startIndex, endIndex: r.endIndex },
        },
      })),
    },
  });

  // Rebuild memoryDB from the surviving sheet rows.
  const keep = [];
  const doomedSet = new Set(doomed);
  for (let i = 1; i < rows.length; i++) {
    if (doomedSet.has(i)) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = rows[i][idx] === undefined ? '' : String(rows[i][idx]); });
    keep.push(obj);
  }
  memoryDB[sheetName] = keep;
  invalidateCache(sheetName);
  return doomed.length;
}

/**
 * Count rows in a sheet
 */
async function countRows(sheetName) {
  if (!sheetsClient) {
    return (memoryDB[sheetName] || []).length;
  }

  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:Z`,
    });

    const rows = res.data.values;
    if (!rows || rows.length <= 1) return 0;
    return rows.length - 1; // Subtract header row
  } catch (err) {
    console.warn(`Google Sheets countRows warning for ${sheetName}:`, err.message);
    // Fall back to memoryDB
    return (memoryDB[sheetName] || []).length;
  }
}

// Cast stored toggle values ('true'/'TRUE'/true/'1' → true, 'false'/'FALSE'/false/'0' → false)
function toSettingBool(v, dflt = true) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return dflt;
}

/**
 * Get website settings from Google Sheets
 */
async function getSettings() {
  const defaultSettings = {
    key: 'site_settings',
    activeUsers: '10K+',
    couponsTraded: '50K+',
    savedByUsers: '₹2L+',
    platformName: 'SaveHatke',
    adminEmail: 'rupayandas2024@gmail.com',
    showActiveUsers: true,
    showCouponsTraded: true,
    showSavedByUsers: true,
    testimonialsLabel: 'Testimonials',
    testimonialsTitle: 'Loved by',
    testimonialsTitleHighlight: '10,000+ Smart Shoppers',
    testimonialsSubtitle: 'Real stories from real users who save big with SaveHatke.',
    showTestimonials: true,
    testimonialsSeeded: false,
    updatedAt: new Date().toISOString(),
  };

  try {
    const existing = await findRow(SHEETS.SETTINGS, 'key', 'site_settings');
    if (existing) {
      // A settings row written before the testimonial columns existed reads them
      // back as '' once ensureSheets() tops up the header row, which is
      // indistinguishable from an admin clearing a field. The toggles settle it:
      // saveSettings() always writes the whole record, so if every testimonial
      // cell is empty the row simply predates the feature and the defaults
      // apply. After one save, '' means the admin meant it to be empty.
      const written = ['testimonialsLabel', 'testimonialsTitle', 'testimonialsTitleHighlight',
        'testimonialsSubtitle', 'showTestimonials', 'testimonialsSeeded']
        .some((k) => String(existing[k] == null ? '' : existing[k]).trim() !== '');
      const copy = (k) => (written ? String(existing[k] == null ? '' : existing[k]) : defaultSettings[k]);

      return {
        ...defaultSettings,
        ...existing,
        showActiveUsers: toSettingBool(existing.showActiveUsers),
        showCouponsTraded: toSettingBool(existing.showCouponsTraded),
        showSavedByUsers: toSettingBool(existing.showSavedByUsers),
        showTestimonials: written ? toSettingBool(existing.showTestimonials) : defaultSettings.showTestimonials,
        // Unlike the display toggles this one defaults to false: a blank cell
        // means "the starter testimonials have never been written".
        testimonialsSeeded: toSettingBool(existing.testimonialsSeeded, false),
        testimonialsLabel: copy('testimonialsLabel'),
        testimonialsTitle: copy('testimonialsTitle'),
        testimonialsTitleHighlight: copy('testimonialsTitleHighlight'),
        testimonialsSubtitle: copy('testimonialsSubtitle'),
      };
    }
  } catch (err) {
    console.warn('getSettings warning:', err.message);
  }
  return defaultSettings;
}

/**
 * Save website settings to Google Sheets.
 *
 * Every key the caller omits keeps the value already on record, so a caller that
 * only knows about some of the settings cannot silently reset the rest.
 */
async function saveSettings(data) {
  const current = await getSettings();
  const text = (key, max) => {
    const value = data[key] !== undefined ? data[key] : current[key];
    const s = String(value == null ? '' : value).trim();
    return max ? s.slice(0, max) : s;
  };
  // Toggles are stored as 'true'/'false' strings: RAW sheet writes of booleans
  // are ambiguous and empty-string cells read back as the default (true).
  const flag = (key) => String(Boolean(data[key] !== undefined ? data[key] : current[key]));

  const record = {
    key: 'site_settings',
    activeUsers: text('activeUsers') || '10K+',
    couponsTraded: text('couponsTraded') || '50K+',
    savedByUsers: text('savedByUsers') || '₹2L+',
    platformName: text('platformName') || 'SaveHatke',
    adminEmail: text('adminEmail') || 'rupayandas2024@gmail.com',
    showActiveUsers: flag('showActiveUsers'),
    showCouponsTraded: flag('showCouponsTraded'),
    showSavedByUsers: flag('showSavedByUsers'),
    testimonialsLabel: text('testimonialsLabel', 60),
    testimonialsTitle: text('testimonialsTitle', 120),
    testimonialsTitleHighlight: text('testimonialsTitleHighlight', 120),
    testimonialsSubtitle: text('testimonialsSubtitle', 240),
    showTestimonials: flag('showTestimonials'),
    testimonialsSeeded: flag('testimonialsSeeded'),
    updatedAt: new Date().toISOString(),
  };

  try {
    const existing = await findRow(SHEETS.SETTINGS, 'key', 'site_settings');
    if (existing) {
      await updateRow(SHEETS.SETTINGS, 'key', 'site_settings', record);
    } else {
      await appendRow(SHEETS.SETTINGS, record);
    }
  } catch (err) {
    console.warn('saveSettings error:', err.message);
  }
  return record;
}

module.exports = {
  SHEETS,
  HEADERS,
  initialize,
  isSheetsConnected,
  getStorageStatus,
  getWriteAvailabilityError,
  seedDemoData,
  getRows,
  getRowsFresh,
  appendRow,
  findRow,
  findRows,
  findRowsFresh,
  updateRow,
  deleteRow,
  deleteRowsWhere,
  countRows,
  getSettings,
  saveSettings,
};
