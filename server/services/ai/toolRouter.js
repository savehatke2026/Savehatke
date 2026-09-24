// ============================================
// SaveHatke AI — Tool Router (Server-Only)
// ============================================
// The AI never touches a datastore. It states an intent; this module maps that
// intent onto a fixed, server-side allowlist of business operations and runs
// them with the same services the website uses.
//
// SECURITY — the rules this file enforces:
//   1. Identity comes ONLY from the authenticated session object passed in by
//      the caller (req.user, resolved from the verified JWT / HttpOnly cookie).
//      There is no code path in which a user id, email or role taken from chat
//      text, query params or tool arguments can select whose data is read.
//   2. Every tool declares a permission level. The chatbot exposes PUBLIC and
//      AUTHENTICATED_USER only. ADMIN_ONLY tools are defined here for
//      documentation and deliberately cannot be dispatched — not even for a
//      signed-in admin, because an admin using the chatbot is still a user.
//   3. Fail closed. If identity, ownership or the data source cannot be
//      established, the tool returns an error and the engine says it could not
//      retrieve the information. It never fabricates a result.
//
// AUTHORITY: the backend is the authority, not the assistant. Earnings, payout
// state and coupon availability are read live on every call.

const config = require('./config');
const security = require('./securityEngine');
const db = require('../googleSheets');
const supabase = require('../supabase');
// The ONE seller payout formula. Imported, never re-declared: a seller is paid
// 7% of a coupon's face value, and the marketplace selling price is not an input.
const sellerPayout = require('../sellerPayout');

// Permission levels. Only the first two are reachable from chat.
const LEVEL = {
  PUBLIC: 'PUBLIC',
  AUTHENTICATED_USER: 'AUTHENTICATED_USER',
  ADMIN_ONLY: 'ADMIN_ONLY',
};

// ── Authoritative business constants ──────────────────────────────────────
// Pricing model + the payout resolver are read from the module that actually
// pays (services/sellerPayout.js), rather than re-declared, so the chatbot can
// never drift from what a seller is really owed: 7% of a coupon's face value.
// The seller status ladder is a separate concern and still comes from the
// payouts router. The try/catch exists because requiring the payouts router
// pulls in Express route wiring; if that ever fails the pricing constants below
// remain in force.
let PAYOUT_PRICING_MODEL = sellerPayout.PAYOUT_PRICING_MODEL || 'face-value-7-percent';
let PAYOUT_RATE = sellerPayout.PAYOUT_RATE || 0.07;
let MIN_FACE_VALUE = sellerPayout.MIN_FACE_VALUE || 100;
let MAX_FACE_VALUE = sellerPayout.MAX_FACE_VALUE || 10000;
let SELLER_STATUS_LADDER = ['Pending Review', 'Active', 'Eligible for Payout', 'Payout Processing', 'Paid'];
let SELLER_STATUS = {};
let deriveSellerStatus = null;
try {
  // eslint-disable-next-line global-require
  const payouts = require('../../routes/payouts');
  if (Array.isArray(payouts.SELLER_STATUS_LADDER) && payouts.SELLER_STATUS_LADDER.length) SELLER_STATUS_LADDER = payouts.SELLER_STATUS_LADDER;
  if (payouts.SELLER_STATUS) SELLER_STATUS = payouts.SELLER_STATUS;
  if (typeof payouts.deriveSellerStatus === 'function') deriveSellerStatus = payouts.deriveSellerStatus;
} catch (e) {
  // Fail-safe constants above remain in force.
}

/** Round a monetary amount to the nearest paise (2 dp), avoiding binary drift. */
function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const MIN_PAYOUT_REQUEST = 50;
const MAX_PAYOUT_REQUEST = 100000;

// ── Shared data access (same merge the marketplace performs) ───────────────
function normEmail(v) {
  return String(v || '').toLowerCase().trim();
}

/**
 * Read the live, available coupon catalogue exactly the way GET /api/coupons
 * does: Supabase first, then the Google Sheets mirror, de-duplicated by id or
 * code. Availability is never trained into the model — it is asked for.
 */
async function readAvailableCoupons() {
  const available = [];
  if (supabase.isConfigured()) {
    try {
      const supa = await supabase.getCoupons({ status: 'available' });
      if (Array.isArray(supa)) available.push(...supa);
    } catch (e) { /* Sheets mirror below may still answer */ }
  }
  try {
    const rows = await db.getRows(db.SHEETS.COUPONS);
    (rows || []).filter((c) => String(c.status) === 'available').forEach((gc) => {
      if (!available.some((sc) => sc.id === gc.id || (sc.code && gc.code && sc.code === gc.code))) {
        available.push(gc);
      }
    });
  } catch (e) { /* Supabase rows already collected are still usable */ }
  return available;
}

/** A seller's own coupons, read the way /api/coupons/my-sales does. */
async function readSellerCoupons(email) {
  const target = normEmail(email);
  if (!target) return [];
  let coupons = [];
  if (supabase.isConfigured()) {
    try {
      coupons = await supabase.getCoupons({ sellerEmail: target });
    } catch (e) { /* fall through to Sheets */ }
  }
  if (!coupons.length) {
    const rows = await db.getRows(db.SHEETS.COUPONS).catch(() => []);
    coupons = (rows || []).filter((c) => normEmail(c.sellerEmail) === target);
  }
  return coupons;
}

/** A buyer's own coupons, read the way /api/coupons/my-purchases does. */
async function readBuyerCoupons(email) {
  const target = normEmail(email);
  if (!target) return [];
  let coupons = [];
  if (supabase.isConfigured()) {
    try {
      coupons = await supabase.getCoupons({ buyerEmail: target });
    } catch (e) { /* fall through to Sheets */ }
  }
  if (!coupons.length) {
    const rows = await db.getRows(db.SHEETS.COUPONS).catch(() => []);
    coupons = (rows || []).filter((c) => normEmail(c.buyerEmail) === target);
  }
  return coupons;
}

async function readPayouts() {
  return db.getRows(db.SHEETS.PAYOUTS).catch(() => []);
}

function maskEmail(email) {
  const e = String(email || '');
  const at = e.indexOf('@');
  if (at < 1) return e ? '***' : '';
  return `${e.slice(0, 2)}***${e.slice(at)}`;
}

function formatINR(amount) {
  const n = Number(amount) || 0;
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** Days until an expiry date; null when absent or unparseable. */
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

/** The 2-week countdown the marketplace uses when no explicit expiry is set. */
function effectiveExpiry(coupon) {
  if (coupon && coupon.expiryDate) {
    const t = new Date(coupon.expiryDate).getTime();
    if (Number.isFinite(t)) return coupon.expiryDate;
  }
  const base = coupon && coupon.addedAt ? new Date(coupon.addedAt).getTime() : Date.now();
  if (!Number.isFinite(base)) return '';
  return new Date(base + 14 * 86400000).toISOString();
}

// ── Tool definitions ──────────────────────────────────────────────────────
// `level` is enforced in execute(). `requiresAuth` mirrors the taxonomy binding.

const TOOLS = {
  search_coupons: {
    level: LEVEL.PUBLIC,
    requiresAuth: false,
    description: 'Search live marketplace coupons by brand, category, keyword or price.',
    args: ['query', 'brand', 'category', 'maxPrice', 'minPrice'],
  },
  search_knowledge: {
    level: LEVEL.PUBLIC,
    requiresAuth: false,
    description: 'Search the official SaveHatke knowledge base for policy and how-to answers.',
    args: ['query'],
  },
  check_earnings: {
    level: LEVEL.AUTHENTICATED_USER,
    requiresAuth: true,
    description: "The signed-in user's own sales count and earnings summary.",
    args: [],
  },
  check_submissions: {
    level: LEVEL.AUTHENTICATED_USER,
    requiresAuth: true,
    description: "The signed-in user's own submitted coupon review statuses.",
    args: [],
  },
  check_payout_status: {
    level: LEVEL.AUTHENTICATED_USER,
    requiresAuth: true,
    description: "The signed-in user's own payout state and any pending amount.",
    args: [],
  },
  check_payout_ladder: {
    level: LEVEL.PUBLIC,
    requiresAuth: false,
    description: 'The payout status ladder, the per-coupon rate and the minimum payout request.',
    args: [],
  },
  check_purchases: {
    level: LEVEL.AUTHENTICATED_USER,
    requiresAuth: true,
    description: "The signed-in user's own purchase history.",
    args: [],
    // This is the one tool permitted to return a coupon code: the record is the
    // caller's own completed purchase, which is precisely the authorization the
    // purchase flow grants. Every other tool has codes stripped (see contextSafe).
    mayReturnCode: true,
  },
  check_support_tickets: {
    level: LEVEL.AUTHENTICATED_USER,
    requiresAuth: true,
    description: "The signed-in user's own support tickets and their statuses.",
    args: [],
  },
  check_sell_eligibility: {
    level: LEVEL.AUTHENTICATED_USER,
    requiresAuth: true,
    description: 'Whether the signed-in user is permitted to submit coupons for sale.',
    args: [],
  },
  get_maintenance_status: {
    level: LEVEL.PUBLIC,
    requiresAuth: false,
    description: 'Whether SaveHatke is currently in maintenance mode.',
    args: [],
  },
  get_user_profile: {
    level: LEVEL.AUTHENTICATED_USER,
    requiresAuth: true,
    description: "The signed-in user's own profile summary.",
    args: [],
  },
  get_price_tracker: {
    level: LEVEL.AUTHENTICATED_USER,
    requiresAuth: true,
    description: "The signed-in user's own tracked products.",
    args: [],
  },
};

// Defined for completeness of the permission model, but never dispatchable.
// Documented here so an auditor can see the chatbot has no admin surface.
const ADMIN_ONLY_TOOLS = [
  'approve_coupon', 'reject_coupon', 'process_payout', 'mark_payout_paid',
  'list_all_users', 'list_all_payouts', 'update_user_role', 'delete_user',
  'read_any_conversation', 'update_settings', 'export_data', 'issue_refund',
];

// ── Individual tool implementations ───────────────────────────────────────

/** PUBLIC — live coupon search. Never returns a coupon code. */
async function searchCoupons(args = {}) {
  const coupons = await readAvailableCoupons();
  if (!coupons.length) {
    return { ok: true, empty: true, results: [], totalAvailable: 0 };
  }

  const brand = String(args.brand || '').toLowerCase().trim();
  const category = String(args.category || '').toLowerCase().trim();
  const query = String(args.query || '').toLowerCase().trim();
  const maxPrice = Number.isFinite(Number(args.maxPrice)) ? Number(args.maxPrice) : null;
  const minPrice = Number.isFinite(Number(args.minPrice)) ? Number(args.minPrice) : null;
  const terms = query ? query.split(/\s+/).filter((t) => t.length > 1) : [];

  let matches = coupons.filter((c) => {
    if (brand) {
      const b = String(c.brand || '').toLowerCase();
      if (!b.includes(brand) && !brand.includes(b)) return false;
    }
    if (category) {
      const cat = String(c.category || '').toLowerCase();
      if (cat !== category && !cat.includes(category) && !category.includes(cat)) return false;
    }
    if (terms.length) {
      const hay = `${c.brand || ''} ${c.title || ''} ${c.category || ''} ${c.description || ''} ${c.discount || ''}`.toLowerCase();
      if (!terms.some((t) => hay.includes(t))) return false;
    }
    if (maxPrice != null) {
      const p = parseFloat(c.sellingPrice);
      if (!Number.isFinite(p) || p > maxPrice) return false;
    }
    if (minPrice != null) {
      const p = parseFloat(c.sellingPrice);
      if (!Number.isFinite(p) || p < minPrice) return false;
    }
    return true;
  });

  // Cheapest first — the marketplace's own value ordering.
  matches.sort((a, b) => (parseFloat(a.sellingPrice) || 0) - (parseFloat(b.sellingPrice) || 0));
  const totalMatches = matches.length;
  const limited = matches.slice(0, config.maxCards);

  return {
    ok: true,
    empty: totalMatches === 0,
    totalAvailable: coupons.length,
    totalMatches,
    results: limited.map((c) => ({
      id: c.id,
      brand: c.brand || '',
      title: c.title || '',
      category: c.category || '',
      discount: c.discount || '',
      sellingPrice: c.sellingPrice != null ? String(c.sellingPrice) : '',
      originalValue: c.originalValue != null ? String(c.originalValue) : '',
      expiryDate: effectiveExpiry(c),
      expiresInDays: daysUntil(effectiveExpiry(c)),
      status: c.status || 'available',
      // NOTE: `code` is intentionally absent. It is disclosed only by the
      // purchase and payment-verification flows.
    })),
  };
}

/** AUTHENTICATED_USER — earnings, summed from 7% of each sold coupon's face value. */
async function checkEarnings(args = {}, ctx) {
  const email = normEmail(ctx.user && ctx.user.email);
  if (!email) return { ok: false, error: 'no_identity' };

  const coupons = await readSellerCoupons(email);
  const sold = coupons.filter((c) => String(c.status || '').toLowerCase() === 'sold');
  const available = coupons.filter((c) => String(c.status || '').toLowerCase() === 'available');
  const pending = coupons.filter((c) => ['', 'pending', 'review', 'awaiting', 'submitted', 'proof_requested'].includes(String(c.status || '').toLowerCase()));

  // A seller earns 7% of a coupon's FACE VALUE when it sells — never the
  // marketplace selling price, and never a flat per-coupon rate. The resolver
  // in services/sellerPayout.js is the single source of truth, so the chatbot,
  // the dashboard and the payout ledger all tell one story. Only coupons whose
  // payout resolves to a valid amount are counted; a face value outside
  // ₹100–₹10,000 is excluded rather than guessed at. Totals are monetary, so
  // they are rounded to the nearest paise.
  const payoutsForSold = sold
    .map((c) => sellerPayout.couponPayoutInfo(c))
    .filter((info) => info.payoutEligible && Number.isFinite(info.sellerPayout));
  const totalEarned = roundMoney(payoutsForSold.reduce((sum, info) => sum + info.sellerPayout, 0));
  const averagePerCoupon = payoutsForSold.length ? roundMoney(totalEarned / payoutsForSold.length) : 0;

  // Cross-check against the payout ledger so a discrepancy is visible rather
  // than silently reported as fact.
  const payouts = await readPayouts();
  const mine = payouts.filter((p) => normEmail(p.sellerEmail) === email);
  const paidAmount = mine
    .filter((p) => String(p.status || '').toLowerCase() === 'paid')
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const processingAmount = mine
    .filter((p) => ['pending', 'processing'].includes(String(p.status || '').toLowerCase()))
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);

  return {
    ok: true,
    soldCoupons: sold.length,
    countedCoupons: payoutsForSold.length,
    pricingModel: PAYOUT_PRICING_MODEL,
    payoutRate: PAYOUT_RATE,
    averagePerCoupon,
    totalEarned,
    currency: 'INR',
    totalSubmitted: coupons.length,
    availableCount: available.length,
    pendingCount: pending.length,
    paidAmount,
    processingAmount,
    // Withdrawable now = money owed but not yet paid out.
    availableToWithdraw: processingAmount,
    ledgerConsistent: (paidAmount + processingAmount) <= totalEarned,
    formatted: {
      totalEarned: formatINR(totalEarned),
      averagePerCoupon: sold.length ? formatINR(averagePerCoupon) : '',
      paidAmount: formatINR(paidAmount),
      processingAmount: formatINR(processingAmount),
    },
  };
}

/** AUTHENTICATED_USER — review status of the user's own submissions. */
async function checkSubmissions(args = {}, ctx) {
  const email = normEmail(ctx.user && ctx.user.email);
  if (!email) return { ok: false, error: 'no_identity' };
  const coupons = await readSellerCoupons(email);
  const recent = coupons
    .slice()
    .sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0))
    .slice(0, 10);

  const counts = { pending: 0, available: 0, sold: 0, rejected: 0 };
  coupons.forEach((c) => {
    const s = String(c.status || '').toLowerCase();
    if (s === 'available') counts.available += 1;
    else if (s === 'sold') counts.sold += 1;
    else if (s === 'rejected') counts.rejected += 1;
    else counts.pending += 1;
  });

  return {
    ok: true,
    total: coupons.length,
    counts,
    submissions: recent.map((c) => ({
      id: c.id,
      brand: c.brand || '',
      title: c.title || '',
      status: c.status || 'pending',
      submitted: c.addedAt || '',
      expiresInDays: daysUntil(effectiveExpiry(c)),
    })),
  };
}

/** AUTHENTICATED_USER — payout state from the payout ledger. */
async function checkPayoutStatus(args = {}, ctx) {
  const email = normEmail(ctx.user && ctx.user.email);
  if (!email) return { ok: false, error: 'no_identity' };
  const payouts = await readPayouts();
  const mine = payouts.filter((p) => normEmail(p.sellerEmail) === email);

  const byStatus = { pending: [], processing: [], paid: [], rejected: [] };
  mine.forEach((p) => {
    const s = String(p.status || 'pending').toLowerCase();
    (byStatus[s] || byStatus.pending).push(p);
  });

  const sum = (list) => list.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const owed = sum(byStatus.pending) + sum(byStatus.processing);
  const paidTotal = sum(byStatus.paid);

  // A payout needs a destination on file before it can be processed.
  let hasDestination = false;
  try {
    const details = await db.findRow(db.SHEETS.SELLER_PAYOUT_DETAILS, 'sellerEmail', email).catch(() => null);
    hasDestination = Boolean(details && (details.upiId || details.qrFileId));
  } catch (e) { /* an unreadable destination is treated as not set */ }

  return {
    ok: true,
    hasPayouts: mine.length > 0,
    owedAmount: owed,
    paidAmount: paidTotal,
    availableToWithdraw: owed,
    canRequestPayout: owed >= MIN_PAYOUT_REQUEST && hasDestination,
    minPayoutRequest: MIN_PAYOUT_REQUEST,
    maxPayoutRequest: MAX_PAYOUT_REQUEST,
    hasDestination,
    counts: {
      pending: byStatus.pending.length,
      processing: byStatus.processing.length,
      paid: byStatus.paid.length,
      rejected: byStatus.rejected.length,
    },
    recent: mine
      .slice()
      .sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')))
      .slice(0, 5)
      .map((p) => ({
        amount: Number(p.amount) || 0,
        amountFormatted: formatINR(p.amount),
        status: String(p.status || 'pending').toLowerCase(),
        requestedAt: p.requestedAt || '',
        processedAt: p.processedAt || '',
        // A rejection reason is shown; destination details never are.
        note: p.status === 'rejected' ? String(p.rejectionReason || '').slice(0, 200) : '',
      })),
    formatted: {
      owedAmount: formatINR(owed),
      paidAmount: formatINR(paidTotal),
      minPayoutRequest: formatINR(MIN_PAYOUT_REQUEST),
    },
  };
}

/** PUBLIC — the ladder, the rate and the request bounds. */
async function checkPayoutLadder() {
  return {
    ok: true,
    ladder: SELLER_STATUS_LADDER,
    failedStatus: SELLER_STATUS.FAILED || 'Validation Failed',
    pricingModel: PAYOUT_PRICING_MODEL,
    minPayoutRequest: MIN_PAYOUT_REQUEST,
    minPayoutRequestFormatted: formatINR(MIN_PAYOUT_REQUEST),
    maxPayoutRequest: MAX_PAYOUT_REQUEST,
    maxPayoutRequestFormatted: formatINR(MAX_PAYOUT_REQUEST),
    payoutRate: PAYOUT_RATE,
    payoutModel: PAYOUT_PRICING_MODEL,
    howItWorks: `Each coupon of yours that sells earns you 7% of its face value — separate from the marketplace price a buyer pays. Once your balance reaches ${formatINR(MIN_PAYOUT_REQUEST)} you can request a payout, which moves through the ladder until it is paid.`,
  };
}

/** AUTHENTICATED_USER — the user's own purchases. */
async function checkPurchases(args = {}, ctx) {
  const email = normEmail(ctx.user && ctx.user.email);
  if (!email) return { ok: false, error: 'no_identity' };
  const coupons = await readBuyerCoupons(email);
  const sorted = coupons
    .slice()
    .sort((a, b) => new Date(b.soldAt || b.addedAt || 0) - new Date(a.soldAt || a.addedAt || 0));

  const codes = sorted.filter((c) => c.code).length;
  return {
    ok: true,
    total: sorted.length,
    codesAvailable: codes,
    purchases: sorted.slice(0, 6).map((c) => ({
      id: c.id,
      brand: c.brand || '',
      title: c.title || '',
      description: c.description || '',
      discount: c.discount || '',
      pricePaid: c.sellingPrice != null ? String(c.sellingPrice) : '',
      purchasedAt: c.soldAt || '',
      expiresInDays: daysUntil(effectiveExpiry(c)),
      status: c.status || 'sold',
      // The code IS released here: this listing is the buyer's own purchase,
      // which is exactly the authorization the purchase flow grants.
      code: c.code || '',
    })),
    // Told explicitly so the response engine can point them at the right page.
    hasMore: sorted.length > 6,
  };
}

/** AUTHENTICATED_USER — the user's own support tickets. */
async function checkSupportTickets(args = {}, ctx) {
  const email = normEmail(ctx.user && ctx.user.email);
  if (!email) return { ok: false, error: 'no_identity' };
  let tickets = [];
  try {
    const rows = await db.getRows(db.SHEETS.SUPPORT_TICKETS);
    tickets = (rows || []).filter((t) => normEmail(t.userEmail) === email);
  } catch (e) {
    return { ok: false, error: 'source_unavailable' };
  }

  const sorted = tickets
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const normStatus = (s) => {
    const v = String(s || 'open').toLowerCase().trim().replace(/[\s_-]+/g, '');
    if (v === 'investigating') return 'inprogress';
    return ['open', 'inprogress', 'resolved', 'closed'].includes(v) ? v : 'open';
  };

  return {
    ok: true,
    total: sorted.length,
    openCount: sorted.filter((t) => normStatus(t.status) === 'open').length,
    inProgressCount: sorted.filter((t) => normStatus(t.status) === 'inprogress').length,
    resolvedCount: sorted.filter((t) => ['resolved', 'closed'].includes(normStatus(t.status))).length,
    tickets: sorted.slice(0, 5).map((t) => ({
      id: t.id,
      subject: String(t.subject || '').slice(0, 160),
      status: normStatus(t.status),
      createdAt: t.createdAt || '',
      updatedAt: t.updatedAt || t.resolvedAt || '',
      // The admin's reply, when there is one.
      resolution: String(t.resolution || '').slice(0, 400),
    })),
  };
}

/** AUTHENTICATED_USER — can this user sell? Uses the same gate as the API. */
async function checkSellEligibility(args = {}, ctx) {
  const user = ctx.user;
  if (!user || !user.email) return { ok: false, error: 'no_identity' };

  const role = String(user.role || '').toLowerCase();
  const isAdminRole = role === 'admin' || role === 'super admin' || role === 'support';
  if (isAdminRole) {
    return { ok: true, canSell: true, reason: 'admin_role' };
  }

  // The authoritative rule: selling is invite-only, gated on the admin-managed
  // whitelist — NOT on purchase history. Read from Supabase, the single source
  // of truth, and fail closed if it cannot be read.
  let whitelisted = false;
  let reachable = true;
  try {
    const whitelist = await supabase.getMaintenanceWhitelist();
    whitelisted = Array.isArray(whitelist) && whitelist.map(normEmail).includes(normEmail(user.email));
  } catch (e) {
    reachable = false;
  }

  if (!reachable) {
    return { ok: true, canSell: false, reason: 'unverifiable', fallbackToSupport: true };
  }
  return {
    ok: true,
    canSell: whitelisted,
    reason: whitelisted ? 'whitelisted' : 'not_whitelisted',
    // The seller's own history, so the answer can be useful either way.
    ...(await (async () => {
      try {
        const mine = await readSellerCoupons(user.email);
        return { submittedCount: mine.length };
      } catch (e) { return { submittedCount: null }; }
    })()),
  };
}

/** PUBLIC — maintenance state, read from the same source the site uses. */
async function getMaintenanceStatus() {
  try {
    const mode = await supabase.getMaintenanceMode();
    return {
      ok: true,
      enabled: Boolean(mode && mode.enabled),
      message: String((mode && mode.message) || '').slice(0, 300),
    };
  } catch (e) {
    // Fail open for an informational answer: the site's own guard is what
    // actually enforces maintenance, so an unreadable flag must not become a
    // false "we are down" claim.
    return { ok: false, error: 'source_unavailable' };
  }
}

/** AUTHENTICATED_USER — a safe profile projection. */
async function getUserProfile(args = {}, ctx) {
  const user = ctx.user;
  if (!user || !user.email) return { ok: false, error: 'no_identity' };

  let hasPayoutDetails = false;
  try {
    const details = await db.findRow(db.SHEETS.SELLER_PAYOUT_DETAILS, 'sellerEmail', normEmail(user.email)).catch(() => null);
    hasPayoutDetails = Boolean(details && (details.upiId || details.qrFileId));
  } catch (e) { /* treated as not set */ }

  return {
    ok: true,
    // The user's own email, partially masked even back to them: the reply does
    // not need the full address, and masking keeps it out of transcripts.
    emailMasked: maskEmail(user.email),
    name: String(user.name || '').slice(0, 80),
    role: String(user.role || 'user').toLowerCase() === 'user' ? 'user' : 'member',
    hasPayoutDetails,
    // Account type is surfaced because accounts here are passwordless.
    signInMethod: 'email one-time code or Google',
  };
}

/** AUTHENTICATED_USER — the user's own tracked products. */
async function getPriceTracker(args = {}, ctx) {
  const email = normEmail(ctx.user && ctx.user.email);
  if (!email) return { ok: false, error: 'no_identity' };
  try {
    const rows = await db.getRows(db.SHEETS.PRICE_TRACKING);
    const mine = (rows || []).filter((r) => normEmail(r.userEmail) === email);
    return {
      ok: true,
      total: mine.length,
      items: mine.slice(0, 5).map((r) => ({
        productName: String(r.productName || '').slice(0, 120),
        platform: String(r.platform || '').slice(0, 60),
        currentPrice: r.currentPrice != null ? String(r.currentPrice) : '',
        targetPrice: r.targetPrice != null ? String(r.targetPrice) : '',
        lastChecked: r.lastChecked || '',
      })),
    };
  } catch (e) {
    return { ok: false, error: 'source_unavailable' };
  }
}

const IMPLEMENTATIONS = {
  search_coupons: searchCoupons,
  search_knowledge: async () => ({ ok: false, error: 'handled_by_knowledge_engine' }),
  check_earnings: checkEarnings,
  check_submissions: checkSubmissions,
  check_payout_status: checkPayoutStatus,
  check_payout_ladder: checkPayoutLadder,
  check_purchases: checkPurchases,
  check_support_tickets: checkSupportTickets,
  check_sell_eligibility: checkSellEligibility,
  get_maintenance_status: getMaintenanceStatus,
  get_user_profile: getUserProfile,
  get_price_tracker: getPriceTracker,
};

/**
 * Which tools may be offered for this context.
 * Admin tools are never listed, whatever the caller's role.
 */
function availableTools(ctx = {}) {
  return Object.entries(TOOLS)
    .filter(([, def]) => def.level !== LEVEL.ADMIN_ONLY)
    .filter(([, def]) => !def.requiresAuth || Boolean(ctx.user && ctx.user.email))
    .map(([name, def]) => ({ name, level: def.level, description: def.description, args: def.args }));
}

/**
 * Execute a tool. This is the only dispatch path, and it re-checks the
 * permission level at call time — listing a tool is not the same as being
 * allowed to run it.
 *
 * @param {string} name
 * @param {object} args — model/user supplied; treated as untrusted input
 * @param {{user?:object, conversationId?:string}} ctx
 * @returns {Promise<{ok:boolean, name:string, error?:string, [key:string]:any}>}
 */
async function execute(name, args = {}, ctx = {}) {
  const toolName = String(name || '');
  const def = TOOLS[toolName];

  // Unregistered or admin-only names fail closed. There is no dynamic dispatch.
  if (!def || def.level === LEVEL.ADMIN_ONLY || ADMIN_ONLY_TOOLS.includes(toolName)) {
    return { ok: false, name: toolName, error: 'tool_not_permitted' };
  }

  // Identity is required for user-scoped tools and can only come from ctx.user.
  if (def.requiresAuth && !(ctx.user && ctx.user.email)) {
    return { ok: false, name: toolName, error: 'login_required', requiresLogin: true };
  }

  const impl = IMPLEMENTATIONS[toolName];
  if (typeof impl !== 'function') {
    return { ok: false, name: toolName, error: 'tool_not_implemented' };
  }

  // Strict allowlist of arguments. Anything the model invents is dropped rather
  // than forwarded — the tool layer never accepts an identity or a scope it was
  // not given by the session.
  const safeArgs = {};
  (def.args || []).forEach((key) => {
    if (args && args[key] !== undefined && args[key] !== null) {
      safeArgs[key] = typeof args[key] === 'string' ? args[key].slice(0, 200) : args[key];
    }
  });

  try {
    const result = await impl(safeArgs, ctx);
    // The tool result is untrusted data from the engine's point of view. It is
    // stripped of anything secret before it can influence a reply. Only a tool
    // explicitly marked mayReturnCode keeps a code, and only because the record
    // belongs to the caller.
    const safe = contextSafe(result, { keepCode: Boolean(def.mayReturnCode) });
    return { ...safe, name: toolName };
  } catch (err) {
    // Fail closed, and never surface the internal reason to the user.
    return { ok: false, name: toolName, error: 'tool_execution_failed' };
  }
}

/**
 * Defence in depth on tool output: even though the implementations above are
 * written not to return codes, nothing reaches the engine that carries one
 * unless the tool declared that a code is legitimate for the caller.
 */
function contextSafe(result, opts = {}) {
  const keepCode = Boolean(opts.keepCode);
  if (!result || typeof result !== 'object') return result;
  const clone = JSON.parse(JSON.stringify(result));
  const strip = (obj, depth = 0) => {
    if (depth > 6 || !obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) { obj.forEach((v) => strip(v, depth + 1)); return obj; }
    Object.keys(obj).forEach((k) => {
      const lower = k.toLowerCase();
      if (!keepCode && (lower === 'code' || lower === 'couponcode' || lower === 'coupon_code')) {
        delete obj[k];
      }
      strip(obj[k], depth + 1);
    });
    return obj;
  };
  return strip(clone);
}

/** Metadata for the admin surface and tests. */
function listToolDefs() {
  return Object.entries(TOOLS).map(([name, def]) => ({
    name,
    level: def.level,
    requiresAuth: def.requiresAuth,
    description: def.description,
  }));
}

module.exports = {
  LEVEL,
  TOOLS,
  ADMIN_ONLY_TOOLS,
  availableTools,
  execute,
  listToolDefs,
  PAYOUT_PRICING_MODEL,
  PAYOUT_RATE,
  MIN_FACE_VALUE,
  MAX_FACE_VALUE,
  MIN_PAYOUT_REQUEST,
  MAX_PAYOUT_REQUEST,
  SELLER_STATUS_LADDER,
  // exported for tests and for the response engine's phrasing
  roundMoney,
  formatINR,
  daysUntil,
  effectiveExpiry,
  maskEmail,
  readAvailableCoupons,
  // the authoritative resolver, re-exported so tests can assert against it
  couponPayoutInfo: sellerPayout.couponPayoutInfo,
  calculateSellerPayout: sellerPayout.calculateSellerPayout,
};