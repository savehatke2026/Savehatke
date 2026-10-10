// ============================================
// SaveHatke — Admin Routes
// ============================================

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireAdmin, generateToken } = require('../middleware/auth');
const { adminMutationLimiter } = require('../utils/adminRateLimit');
const { getActiveAdminEmails, isAdminRosterStale, refreshAdminRoster } = require('../config/security');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');
const twilioWhatsApp = require('../services/twilioWhatsApp');
const emailService = require('../services/emailService');
const monthlyReports = require('../services/monthlyReports');
const couponListCache = require('../services/couponListCache');
const googleDrive = require('../services/googleDrive');
const securityStore = require('../services/securityCredentialsStore');
const paymentMailbox = require('../services/paymentMailbox');
// Payout withholding and the seller status vocabulary live with the Payouts tab,
// so the invalidate action below reuses them instead of restating the rules.
const payouts = require('./payouts');
// The single seller-payout formula (7% of face value, rounded to the paise).
// Admin writes never trust a client-supplied payout — it is always derived here.
const { calculateSellerPayout, couponPayoutInfo } = require('../services/sellerPayout');
// The Sell-Coupon route settles through the REAL payment pipeline (order →
// payment → finalizePayment) so an admin sale is recorded exactly like a
// verified buyer purchase — same atomic coupon flip, same ledger rows.
const paymentStore = require('../services/paymentStore');
const dynamicPricing = require('../services/dynamicPricing');
const upi = require('../services/upi');

const router = express.Router();

// ── Seller payout helpers (admin) ────────────────────────────────────────
// Every payout field a client might send. They are dropped from every admin
// write so a raw request body can never set its own payout.
const PAYOUT_BODY_KEYS = [
  'sellerPayout', 'seller_payout', 'payout_amount', 'payoutAmount',
  'payoutStatus', 'payout_status', 'payout',
];

function stripPayoutFields(body) {
  const out = {};
  Object.entries(body || {}).forEach(([k, v]) => {
    if (PAYOUT_BODY_KEYS.includes(k)) return;
    out[k] = v;
  });
  return out;
}

// Face value from any accepted alias. `??`-style precedence (never `||`) so a
// 0 or '' is treated as a real answer to validate, not a missing value.
function faceValueFromBody(body) {
  for (const k of ['originalValue', 'original_value', 'faceValue', 'face_value']) {
    if (body && body[k] !== undefined && body[k] !== null) return body[k];
  }
  return undefined;
}

function hasFaceValue(faceValue) {
  return faceValue !== undefined && faceValue !== null && String(faceValue).trim() !== '';
}

// 7% of the face value, or null when it is not a valid seller face value.
// Admin marketplace coupons may legitimately sit outside ₹100–₹10,000: they
// stay usable and simply report no payout.
function payoutForFaceValue(faceValue) {
  if (!hasFaceValue(faceValue)) return null;
  try {
    return calculateSellerPayout(faceValue);
  } catch (e) {
    return null;
  }
}

function isValidSellerFaceValue(faceValue) {
  if (!hasFaceValue(faceValue)) return false;
  try {
    calculateSellerPayout(faceValue);
    return true;
  } catch (e) {
    return false;
  }
}

function isSellerCoupon(coupon) {
  return String((coupon && coupon.source) || '').toLowerCase() === 'user-submitted';
}

// Existing Payouts rows indexed by the coupon they came from, so each coupon
// can show its payout status without an N+1 read. A failed read behaves as "no
// payouts", which is the safe direction for the lock checks below.
async function payoutsByCouponId() {
  const map = new Map();
  try {
    const rows = await db.getRows(db.SHEETS.PAYOUTS);
    for (const p of rows || []) {
      const key = String((p && p.sourceCouponId) || '');
      if (key && !map.has(key)) map.set(key, p);
    }
  } catch (e) {
    console.warn('[admin] Payouts read notice:', e.message);
  }
  return map;
}

function payoutSummary(coupon, payout) {
  // The canonical sellerPayout is always the server-computed 7% of the face
  // value (never the marketplace sellingPrice, never the stored value). The
  // stored value is also returned so a discrepancy is visible — admin can see
  // the row's stored payout next to the formula-correct one.
  //
  // The coupon itself is spread in first: this summary is also the LIST row
  // shape for GET /admin/coupons and the review-record payload, so dropping
  // the coupon fields would blank every card (brand, code, title, prices...).
  const info = couponPayoutInfo(coupon);
  return {
    ...coupon,
    ...info,
    sellerPayout: info.payoutEligible ? info.sellerPayout : null,
    sellerPayoutStored: coupon && coupon.sellerPayout !== undefined ? coupon.sellerPayout : null,
    payoutStatus: payout ? String(payout.status || 'pending') : '',
    payoutAmount: payout ? Number(payout.amount || 0) : null,
  };
}

// ── Coupon-list cache (GET /admin/coupons) ───────────────────────────────
// The list merges three independent full reads: Supabase coupons, the Coupons
// sheet and the Payouts sheet (each a full network round trip). Tab switches,
// pagination clicks, pill filters and search keystrokes all re-request this
// endpoint even though the filtering itself happens client-side, so the same
// three round trips were paid over and over — measured ~1.1s per load with
// real data. A short in-process TTL cache of the final merged list makes
// those repeats instant; every admin coupon mutation below clears it, so the
// read that follows a change is always fresh. Payout LOCK checks in the PUT
// route keep their own fresh read — this cache is display-only.
// (Implementation lives in services/couponListCache.js so the coupon-image
// upload route can invalidate it too without a route-to-route require.)
function invalidateCouponListCache() {
  couponListCache.invalidate();
}

// Seller-submission parity with the admin client's isSellerSubmission().
function isSellerSubmissionRow(c) {
  const src = String(c.source || '').toLowerCase();
  return src === 'user-submitted' || src === 'user';
}

// Expiry parity with the admin client's couponIsExpired(): a row is expired
// when its status says so, or its date is past (timerOn does not rescue it).
const ADMIN_DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function adminCouponExpired(c) {
  if (String(c.status || '').toLowerCase() === 'expired') return true;
  const s = String((c && c.expiryDate) || '').trim();
  if (!s) return false;
  const m = ADMIN_DATE_ONLY_RE.exec(s);
  const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999) : Date.parse(s);
  return Number.isFinite(t) && t < Date.now();
}

/**
 * Merged admin coupon list — Supabase rows first (authoritative), then
 * sheet-only rows, sorted newest first. Filtering/paging happen here so a
 * five-figure inventory can never exceed the serverless response limit and
 * every tab/pill/search combo is a cheap 20-row fetch.
 *
 * opts: { status, source, category, pill, search, pending, page, pageSize }
 * Returns { coupons, total, page, pageSize, totalPages, summary, pendingBadge }
 * — summary counts the status/source/category set BEFORE pill/search so the
 * dashboard cards never flicker with a pill, and pendingBadge is the global
 * seller-submission count.
 */
async function getAdminCouponList(opts = {}) {
  const {
    status, source, category, pill, search, pending,
  } = opts;
  const page = parseInt(opts.page, 10) || 1;
  const pageSize = Math.min(200, Math.max(1, parseInt(opts.pageSize, 10) || 20));
  // `legacy` is part of the key: a no-param caller and a paged caller that
  // clamp to the same page/pageSize must never share a cached payload.
  const legacy = opts.page === undefined && opts.pageSize === undefined;
  const key = [status, source, category, pill, search, pending, page, pageSize, legacy ? 'L' : 'P']
    .map((v) => String(v == null ? '' : v)).join('|');
  const hit = couponListCache.get(key);
  if (hit) return hit;

  // The three reads are independent — run them concurrently instead of
  // paying each round trip one after the other. Each helper already swallows
  // its own errors (degrading to an empty set), so Promise.all cannot reject.
  let supaCoupons = [];
  let sheetCoupons = [];
  let payoutMap = new Map();
  await Promise.all([
    (async () => {
      if (supabase.isConfigured()) {
        try {
          supaCoupons = await supabase.getCoupons({ status, source, category });
        } catch (e) {
          console.warn('[admin/coupons] Supabase read failed:', e.message);
        }
      }
    })(),
    (async () => {
      try {
        sheetCoupons = await db.getRows(db.SHEETS.COUPONS);
        if (status) sheetCoupons = sheetCoupons.filter((c) => String(c.status || '') === status);
        if (source) sheetCoupons = sheetCoupons.filter((c) => String(c.source || '') === source);
        if (category) {
          sheetCoupons = sheetCoupons.filter(
            (c) => String(c.category || '').toLowerCase() === String(category).toLowerCase(),
          );
        }
      } catch (e) {
        console.warn('[admin/coupons] Sheets read failed:', e.message);
      }
    })(),
    (async () => {
      payoutMap = await payoutsByCouponId();
    })(),
  ]);

  // Supabase wins on a conflict: it is the store the marketplace reads, so its
  // row is the one an admin action should act on. Matching is by id and then by
  // coupon code — when the Supabase insert failed, the sheet row carries a
  // locally minted uuid and the code is the only shared identity.
  const merged = [];
  const seenIds = new Set();
  const seenCodes = new Set();
  const codeKey = (c) => String(c.code || '').toUpperCase().trim();

  const take = (c) => {
    merged.push(c);
    if (c.id) seenIds.add(String(c.id));
    if (codeKey(c)) seenCodes.add(codeKey(c));
  };

  supaCoupons.forEach(take);
  for (const c of sheetCoupons) {
    if (c.id && seenIds.has(String(c.id))) continue;
    if (codeKey(c) && seenCodes.has(codeKey(c))) continue;
    take(c);
  }

  // Newest first, so a fresh submission sits at the top of the pending queue.
  merged.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));

  // Summary counts the status/source/category set — before pill/search/base
  // exclusion — matching what the client's summary cards used to compute.
  const summary = {
    total: merged.length,
    active: 0, seller: 0, sold: 0, expired: 0,
  };
  let pendingBadge = 0;
  for (const c of merged) {
    const st = String(c.status || '').toLowerCase();
    const sellerSub = isSellerSubmissionRow(c);
    if (st === 'available') summary.active++;
    if (sellerSub) summary.seller++;
    if (st === 'sold') summary.sold++;
    if (adminCouponExpired(c)) summary.expired++;
    if (st === 'pending' && sellerSub) pendingBadge++;
  }

  // Base set: everything except still-pending seller submissions (those live
  // in the ⏳ Pending tab, so they aren't shown twice). A pending=1 request is
  // exactly that hidden set; a pill narrows the base further, except 'seller'
  // which spans the whole set (including pending) so the pill surfaces them.
  let rows = merged;
  if (pending === '1') {
    rows = merged.filter((c) => String(c.status || '').toLowerCase() === 'pending' && isSellerSubmissionRow(c));
  } else {
    rows = merged.filter((c) => !(String(c.status || '').toLowerCase() === 'pending' && isSellerSubmissionRow(c)));
    switch (pill) {
      case 'active': rows = rows.filter((c) => String(c.status || '').toLowerCase() === 'available'); break;
      case 'seller': rows = merged.filter(isSellerSubmissionRow); break;
      case 'sold': rows = rows.filter((c) => String(c.status || '').toLowerCase() === 'sold'); break;
      case 'expired': rows = rows.filter(adminCouponExpired); break;
      default: break;
    }
  }

  // Search across every field an admin might type — same field set the client
  // search used before this moved server-side.
  const q = String(search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((c) => {
      const fields = [
        c.title, c.brand, c.id, c.category, c.code, c.sellerEmail,
        c.status, c.description, c.discount,
      ];
      return fields.some((v) => String(v == null ? '' : v).toLowerCase().includes(q));
    });
  }

  const total = rows.length;
  // Legacy callers (no explicit page/pageSize — any client not yet converted)
  // keep receiving the full merged list exactly as before the paging refactor.
  const effectivePageSize = legacy ? Math.max(total, 1) : pageSize;
  const totalPages = legacy ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const safePage = legacy ? 1 : Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);
  const start = (safePage - 1) * effectivePageSize;

  const payload = {
    coupons: rows.slice(start, start + effectivePageSize).map((c) => payoutSummary(c, payoutMap.get(String(c.id)) || null)),
    total,
    page: safePage,
    pageSize: effectivePageSize,
    totalPages,
    summary,
    pendingBadge,
  };

  couponListCache.set(key, payload);
  return payload;
}

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://savehatke.vercel.app').replace(/\/$/, '');

// Write an audit row for every admin coupon action (best-effort, never blocks)
async function logCouponAudit(couponId, adminEmail, action, notes) {
  try {
    await db.appendRow(db.SHEETS.COUPON_AUDIT, {
      id: uuidv4(),
      couponId: String(couponId || ''),
      adminEmail: String(adminEmail || ''),
      action: String(action || ''),
      notes: String(notes || '').slice(0, 500),
      at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('Coupon audit log notice:', e.message);
  }
}

const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const Setting = require('../models/Setting');

function reportDebug(hypothesisId, location, msg, data = {}, runId = process.env.DEBUG_RUN_ID || 'pre-fix') {
  try {
    let debugUrl = 'http://127.0.0.1:7777/event';
    let sessionId = 'coupon-gsheet-sync';
    try {
      const env = fs.readFileSync('.dbg/coupon-gsheet-sync.env', 'utf8');
      debugUrl = env.match(/DEBUG_SERVER_URL=(.+)/)?.[1] || debugUrl;
      sessionId = env.match(/DEBUG_SESSION_ID=(.+)/)?.[1] || sessionId;
    } catch {}
    fetch(debugUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, runId, hypothesisId, location, msg: `[DEBUG] ${msg}`, data, ts: Date.now() }),
    }).catch(() => {});
  } catch {}
}

// The administrator roster lives in Supabase (table: admin_allowlist). These
// endpoints give the Admin & Role Management page a live, editable view of the
// REAL credentials: name, admin_id, active flag and joined date come from the
// roster table, Last Login from admin_sessions, and the avatar (the Google
// photo persisted at sign-in) from the admin profile store. Every entry is a
// plain admin — there are no roles and no deactivation from the panel; access
// is purely "on the roster and active". Every mutation re-hydrates the
// in-process sign-in cache (normally refreshed every 60s) so a roster change
// takes effect on the next sign-in immediately. Self-protection guards: an
// admin cannot delete their own account here, and the last remaining admin can
// never be removed — those actions would otherwise lock the panel permanently.

function adminMutationGuard(targetEmail, callerEmail, currentRoster) {
  if (targetEmail === callerEmail) {
    return 'You cannot remove your own account from the roster. Ask another admin, or edit the roster directly in Supabase.';
  }
  const remaining = currentRoster.filter((a) => a.email !== targetEmail);
  if (remaining.length === 0) {
    return 'This is the last administrator. Add another admin first, or edit the roster directly in Supabase.';
  }
  return null;
}

async function getAdminAvatarsByEmail(emails) {
  // Google photos are persisted to the admin profile at every sign-in
  // (routes/auth.js), so the panel shows the same picture Google verified —
  // read-only here; missing profiles simply fall back to the initials tile.
  if (!Array.isArray(emails) || emails.length === 0) return {};
  try {
    const docs = await Admin.find({ email: { $in: emails } })
      .select('email profile_image')
      .lean();
    const map = {};
    for (const d of docs || []) {
      if (d && d.email && d.profile_image) map[String(d.email).toLowerCase()] = d.profile_image;
    }
    return map;
  } catch (e) {
    console.warn('[admin] avatar lookup failed (falling back to initials):', e.message);
    return {};
  }
}

router.get('/list-admins', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [roster, lastLogins] = await Promise.all([
      supabase.getAdminAllowlist(),
      supabase.getLastAdminLogins(),
    ]);
    if (!roster.length) {
      // Supabase unreachable or roster empty — say so rather than showing a
      // fabricated list. The panel shows the notice and a retry button.
      return res.json({ admins: [], total: 0, source: 'unavailable' });
    }
    const avatars = await getAdminAvatarsByEmail(roster.map((a) => a.email));
    const admins = roster.map((a) => ({
      // Stable public identifier (admin_xxxxxxxx): derived from the email and
      // persisted in the roster once the admin_id column exists.
      id: a.adminId,
      name: a.name,
      email: a.email,
      avatar_url: avatars[a.email] || '',
      created_at: a.createdAt,
      last_login: lastLogins[a.email] || null,
    }));
    return res.json({ admins, total: admins.length, source: 'supabase' });
  } catch (e) {
    console.warn('[admin] list-admins failed:', e.message);
    return res.status(502).json({ error: 'Could not read the administrator roster from Supabase.', code: 'ROSTER_UNAVAILABLE' });
  }
});

router.post('/create-admin', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const existing = await supabase.getAdminAllowlist();
    if (existing.some((a) => a.email === email)) {
      return res.status(409).json({ error: 'That email is already on the administrator roster.', code: 'ADMIN_EXISTS' });
    }
    const created = await supabase.upsertAdminAllowlist({ email, name, active: true });
    await refreshAdminRoster().catch(() => {});
    console.log(`[admin] roster add ${created.email} (${created.adminId}) by=${req.user.email}`);
    return res.json({ message: `Administrator ${created.email} added to the Supabase roster.`, admin: created });
  } catch (e) {
    console.warn('[admin] create-admin failed:', e.message);
    return res.status(400).json({ error: e.message || 'Could not add the administrator.', code: 'ROSTER_WRITE_FAILED' });
  }
});

router.put('/update-admin/:email', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const target = String(req.params.email || '').trim().toLowerCase();
    const patch = {};
    if (req.body.name !== undefined) patch.name = String(req.body.name).trim();
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Nothing to update — only the display name can be changed here.', code: 'NOTHING_TO_UPDATE' });
    }
    const updated = await supabase.updateAdminAllowlist(target, patch);
    if (!updated) {
      return res.status(404).json({ error: 'That email is not on the administrator roster.', code: 'ADMIN_NOT_FOUND' });
    }
    await refreshAdminRoster().catch(() => {});
    console.log(`[admin] roster update ${target} fields=${Object.keys(patch).join('+')} by=${req.user.email}`);
    return res.json({ message: `Administrator ${target} updated.`, admin: updated });
  } catch (e) {
    console.warn('[admin] update-admin failed:', e.message);
    return res.status(400).json({ error: e.message || 'Could not update the administrator.', code: 'ROSTER_WRITE_FAILED' });
  }
});

router.delete('/delete-admin/:email', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const target = String(req.params.email || '').trim().toLowerCase();
    const roster = await supabase.getAdminAllowlist();
    const entry = roster.find((a) => a.email === target);
    if (!entry) {
      return res.status(404).json({ error: 'That email is not on the administrator roster.', code: 'ADMIN_NOT_FOUND' });
    }
    const guard = adminMutationGuard(entry.email, String(req.user.email || '').toLowerCase(), roster);
    if (guard) return res.status(403).json({ error: guard, code: 'ROSTER_SELF_LOCKOUT' });
    const removed = await supabase.deleteAdminAllowlist(target);
    await refreshAdminRoster().catch(() => {});
    console.log(`[admin] roster remove ${target} by=${req.user.email}`);
    return res.json({ message: `Administrator ${target} removed from the Supabase roster.`, removed });
  } catch (e) {
    console.warn('[admin] delete-admin failed:', e.message);
    return res.status(400).json({ error: e.message || 'Could not remove the administrator.', code: 'ROSTER_WRITE_FAILED' });
  }
});
// GET /api/admin/me — The AUTHENTICATED admin's own profile.
//
// Identity comes exclusively from the verified JWT that authenticateToken
// populated onto req.user — the caller can never name another admin or read
// anyone else's document. The response carries only what the panel header
// and avatar need; no password hash, no security questions, no session data.
router.get('/me', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const email = String(req.user.email || '').toLowerCase().trim();
    const id = String(req.user.id || '');

    const me = await Admin.findOne({
      $or: [{ email }, ...(id ? [{ id }] : [])],
    }).catch(() => null);

    if (!me) {
      // Admins that exist only in the env fallback (no Mongo document) keep
      // whatever the login response gave the frontend — answer with the JWT's
      // own claims rather than a 404, so the panel still renders.
      return res.json({
        admin: {
          id,
          email,
          name: req.user.name || email.split('@')[0] || 'Admin',
          role: req.user.role || 'Admin',
          profile_image: '',
        },
      });
    }

    res.json({
      admin: {
        id: me.id || (me._id ? me._id.toString() : id),
        email: me.email,
        name: me.name || me.full_name || req.user.name || 'Admin',
        role: me.role || 'Admin',
        profile_image: me.profile_image || '',
        last_login: me.last_login || null,
      },
    });
  } catch (err) {
    console.error('GET /admin/me error:', err);
    res.status(500).json({ error: 'Failed to load admin profile.' });
  }
});

// GET /api/admin/stats — Dashboard statistics
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Last month's report is due on the 1st. This deployment is serverless, so
    // there is no always-on scheduler: the check rides along with the first
    // dashboard load of the day instead (throttled inside the service, never
    // awaited, and it cannot fail this response).
    monthlyReports.maybeEnsure({ actor: 'admin-dashboard' });

    let totalUsers = 0;
    try {
      totalUsers = await db.countRows(db.SHEETS.USERS);
    } catch (e) {}

    let allCoupons = [];
    if (supabase.isConfigured()) {
      try {
        allCoupons = await supabase.getCoupons();
      } catch (e) {}
    }
    if (!allCoupons || allCoupons.length === 0) {
      try {
        allCoupons = await db.getRows(db.SHEETS.COUPONS);
      } catch (e) {}
    }

    allCoupons = allCoupons || [];
    const totalCoupons = allCoupons.length;
    const availableCoupons = allCoupons.filter((c) => c.status === 'available').length;
    const soldCoupons = allCoupons.filter((c) => c.status === 'sold').length;
    const pendingCoupons = allCoupons.filter((c) => c.status === 'pending').length;

    // Calculate revenue (sum of selling prices for sold coupons)
    const revenue = allCoupons
      .filter((c) => c.status === 'sold')
      .reduce((sum, c) => sum + Number(c.sellingPrice || 0), 0);

    // Calculate costs: a sold user-submitted coupon owes the seller its 7%
    // payout of the coupon's face value — NOT the marketplace sellingPrice.
    // couponPayoutInfo derives the payout from the authoritative face value, so
    // a stale stored payout cannot understate or overstate the cost.
    const costs = allCoupons
      .filter((c) => c.status === 'sold' && c.source === 'user-submitted')
      .reduce((sum, c) => {
        const info = couponPayoutInfo(c);
        return sum + (info.payoutEligible && Number.isFinite(info.sellerPayout) ? info.sellerPayout : 0);
      }, 0);

    let totalTracked = 0;
    let totalTickets = 0;
    try {
      totalTracked = await db.countRows(db.SHEETS.PRICE_TRACKING);
      totalTickets = await db.countRows(db.SHEETS.SUPPORT_TICKETS);
    } catch (e) {}

    res.json({
      stats: {
        totalUsers,
        totalCoupons,
        availableCoupons,
        soldCoupons,
        pendingCoupons,
        revenue: `₹${revenue}`,
        profit: `₹${revenue - costs}`,
        totalTracked,
        totalTickets,
      },
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.json({
      stats: {
        totalUsers: 0,
        totalCoupons: 0,
        availableCoupons: 0,
        soldCoupons: 0,
        pendingCoupons: 0,
        revenue: '₹0',
        profit: '₹0',
        totalTracked: 0,
        totalTickets: 0,
      },
    });
  }
});

// POST /api/admin/coupons — Add offline coupon codes manually
router.post('/coupons', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const {
      code,
      category,
      brand,
      title,
      type,
      description,
      discount,
      minOrderValue,
      validFrom,
      expiryDate,
      affiliateLink,
      terms,
      sellingPrice,
      status,
      source,
      isFeatured,
      isExclusive,
      isVerified,
      onSale,
      timerOn,
      backgroundImage,
    } = req.body;

    if (!code || !brand) {
      return res.status(400).json({ error: 'Coupon code and brand are required.' });
    }

    const cleanCode = code.toUpperCase().trim();
    // `req.user?.email` is always populated for an authenticated admin route
    // (authenticateToken ran upstream). The empty-string fallback forces a
    // clear 401 if that contract ever breaks instead of silently attributing
    // the row to a phantom address.
    const sellerEmail = req.user?.email || '';

    // Face value from any accepted alias; the seller payout is always derived
    // from it here. An admin marketplace coupon may sit outside the ₹100–₹10,000
    // seller range — it stays usable and simply carries a null payout. Any
    // sellerPayout / seller_payout / payout_amount in the body is ignored.
    const faceValue = faceValueFromBody(req.body) ?? discount ?? '0';

    // Check for duplicate code in Supabase & Sheets
    let existing = null;
    if (supabase.isConfigured()) {
      try {
        existing = await supabase.findCouponByCode(cleanCode);
      } catch (e) {}
    }
    if (!existing) {
      existing = await db.findRow(db.SHEETS.COUPONS, 'code', cleanCode);
    }
    if (existing) {
      return res.status(409).json({ error: 'This coupon code already exists.' });
    }

    const coupon = {
      // No id here on purpose — Supabase mints it (coupons.id defaults to
      // gen_random_uuid()::text). A uuid is only generated locally below when
      // Supabase isn't configured at all.
      code: cleanCode,
      title: title ? title.trim() : '',
      type: type ? type.trim() : 'Public',
      category: category ? category.trim() : 'General',
      brand: brand.trim(),
      description: title || description || discount || '',
      discount: discount ? discount.trim() : '',
      originalValue: String(faceValue),
      sellerPayout: payoutForFaceValue(faceValue),
      sellingPrice: sellingPrice || '15',
      minOrderValue: minOrderValue || '',
      validFrom: validFrom || '',
      expiryDate: expiryDate || '',
      affiliateLink: affiliateLink ? affiliateLink.trim() : '',
      terms: terms ? terms.trim() : '',
      isFeatured: String(Boolean(isFeatured)),
      isExclusive: String(Boolean(isExclusive)),
      isVerified: String(isVerified !== false),
      sellerEmail,
      status: status ? status.toLowerCase() : 'available',
      source: source ? source.toLowerCase().replace(/\s+/g, '-') : 'admin',
      // Only sent when the caller explicitly asks for a state. Left out otherwise
      // so the `DEFAULT TRUE` on on_sale / timer_on decides — which also keeps
      // inserts working before server/setup_coupon_sale_timer.sql is applied.
      ...(onSale !== undefined ? { onSale: Boolean(onSale !== false && onSale !== 'false') } : {}),
      ...(timerOn !== undefined ? { timerOn: Boolean(timerOn !== false && timerOn !== 'false') } : {}),
      // Card hero image — optional, length-capped. Same "only when provided"
      // rule as the switches so inserts work before
      // server/setup_coupon_background_image.sql is applied.
      ...(backgroundImage !== undefined ? { backgroundImage: String(backgroundImage).trim().slice(0, 300) } : {}),
      addedAt: new Date().toISOString(),
      soldAt: '',
      buyerEmail: '',
    };

    // Supabase first — it owns the coupon id and is the live store the
    // marketplace reads from. Sheets is the mirror and gets the same id.
    let created = null;
    if (supabase.isConfigured()) {
      try {
        created = await supabase.createCoupon(coupon);
        coupon.id = created.id;
      } catch (err) {
        if (/already exists/i.test(err.message)) {
          return res.status(409).json({ error: 'This coupon code already exists.' });
        }
        console.warn('Supabase createCoupon notice:', err.message);
      }
    }

    // Fallback id for the Sheets mirror when Supabase is off or unreachable
    if (!coupon.id) coupon.id = uuidv4();

    let saved = null;
    try {
      saved = await db.appendRow(db.SHEETS.COUPONS, coupon);
    } catch (err) {
      console.warn('Sheets appendRow notice:', err.message);
      if (!created) throw err; // nothing persisted anywhere — surface the failure
    }

    invalidateCouponListCache();

    res.status(201).json({
      message: created
        ? 'Coupon published successfully! 🎟️'
        : 'Coupon published successfully to Google Sheets! 📊',
      coupon: created || saved || coupon,
    });
  } catch (err) {
    console.error('Admin add coupon error:', err);
    res.status(500).json({ error: 'Failed to save coupon.' });
  }
});

// GET /api/admin/coupons — View all coupons with filters
router.get('/coupons', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status, source, category, pill, search, pending } = req.query;

    // Coupons live in two stores. A user submission writes to Supabase first and
    // then mirrors into the Coupons sheet, but the Supabase insert is
    // best-effort — when it fails, the submission exists only in the sheet.
    //
    // This list used to read Supabase and fall back to the sheet only when
    // Supabase returned nothing, so a sheet-only submission was invisible in
    // Coupon Management as soon as Supabase held even one row. Both stores are
    // merged now, so a pending coupon shows up wherever it managed to land.
    //
    // The merge (plus the payout join) is served through getAdminCouponList,
    // which runs the three source reads concurrently, caches the merged result
    // briefly, and pages/filters server-side — every tab switch, pagination
    // click, pill filter and search keystroke fetches one cheap 20-row page
    // instead of the whole inventory.
    const payload = await getAdminCouponList({
      status, source, category, pill,
      search: typeof search === 'string' ? search : '',
      pending: pending === '1' ? '1' : '',
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    res.json(payload);
  } catch (err) {
    console.error('Admin list coupons error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/admin/coupons/:id — Update coupon (approve/edit)
//
// This is also the inline "status update" route the Coupon Management toggles
// use. It used to forward the raw request body straight to the stores, which
// let a caller write any column — including a payout. The body is now
// whitelisted, payout fields are dropped outright, and the seller payout is
// always recomputed from the authoritative face value.
router.put('/coupons/:id', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    // Load the current coupon first: a face-value or seller change is only
    // allowed while the coupon has not been sold / paid, and the payout must be
    // recomputed from the face value that will actually be stored.
    let coupon = null;
    if (supabase.isConfigured()) {
      try { coupon = await supabase.findCouponById(id); } catch (e) {}
    }
    if (!coupon) {
      try { coupon = await db.findRow(db.SHEETS.COUPONS, 'id', id); } catch (e) {}
    }
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }

    // Payout fields are never taken from the client.
    const safe = stripPayoutFields(body);

    const updates = {};
    const COPYABLE = [
      'code', 'brand', 'category', 'title', 'description', 'type', 'discount',
      'sellingPrice', 'minOrderValue', 'validFrom', 'expiryDate', 'affiliateLink',
      'terms', 'status', 'onSale', 'timerOn', 'backgroundImage', 'brandLogo', 'isFeatured',
      'isExclusive', 'isVerified', 'adminNotes', 'proofUrl', 'soldAt', 'buyerEmail',
    ];
    for (const key of COPYABLE) {
      if (safe[key] !== undefined) updates[key] = safe[key];
    }

    const sold = String(coupon.status || '').toLowerCase() === 'sold';
    const payoutMap = await payoutsByCouponId();
    const hasPayout = payoutMap.has(String(coupon.id));

    // Seller identity can never be reassigned once money is in play.
    const sellerChangeRequested =
      (safe.sellerEmail !== undefined && String(safe.sellerEmail) !== String(coupon.sellerEmail || '')) ||
      (safe.sellerUserId !== undefined && String(safe.sellerUserId) !== String(coupon.sellerUserId || ''));

    if (sellerChangeRequested && (sold || hasPayout)) {
      return res.status(409).json({
        error: 'The seller cannot be changed after the coupon has been sold or a payout exists.',
        code: 'COUPON_SELLER_LOCKED',
      });
    }
    if (sellerChangeRequested) {
      updates.sellerEmail = String(safe.sellerEmail || '').trim();
      updates.sellerUserId = String(safe.sellerUserId || '');
    }

    const rawFace = faceValueFromBody(body);
    const faceProvided = rawFace !== undefined;
    const newFaceText = faceProvided ? String(rawFace).trim() : '';
    const oldFaceText = String(coupon.originalValue == null ? '' : coupon.originalValue).trim();
    const faceChanged = faceProvided && newFaceText !== oldFaceText;

    if (faceChanged && (sold || hasPayout)) {
      return res.status(409).json({
        error: 'The face value cannot be changed after the coupon has been sold or a payout exists.',
        code: 'COUPON_FACE_LOCKED',
      });
    }

    const approving = String(updates.status || '').toLowerCase() === 'available';
    const sellerCoupon = isSellerCoupon(coupon);

    if (faceProvided) {
      // A seller's coupon must keep a valid seller face value; an admin
      // marketplace coupon may sit outside the range and stay usable.
      if ((sellerCoupon || approving) && !isValidSellerFaceValue(newFaceText)) {
        return res.status(400).json({
          error: 'Face value must be between ₹100 and ₹10,000 to keep or approve a seller coupon.',
          code: 'INVALID_FACE_VALUE',
        });
      }
      updates.originalValue = newFaceText;
      // Recompute the payout from the new face value; never trust a stored one.
      updates.sellerPayout = payoutForFaceValue(newFaceText);
    } else if (approving && sellerCoupon) {
      // Approving a legacy seller coupon: refuse an invalid face value, and make
      // sure the stored payout matches the face value before it goes live.
      if (!isValidSellerFaceValue(coupon.originalValue)) {
        return res.status(400).json({
          error: 'This coupon has an invalid face value and cannot be approved.',
          code: 'INVALID_FACE_VALUE',
        });
      }
      updates.sellerPayout = calculateSellerPayout(coupon.originalValue);
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ message: 'Nothing to update.', coupon });
    }

    let updated = null;
    let supabaseError = null;
    if (supabase.isConfigured()) {
      try {
        updated = await supabase.updateCoupon(id, updates);
      } catch (e) {
        supabaseError = e;
      }
    }

    try {
      const gUpdated = await db.updateRow(db.SHEETS.COUPONS, 'id', id, updates);
      if (!updated) updated = gUpdated;
    } catch (e) {}

    // Supabase is the live store the marketplace reads from, so a failed write
    // there must not be reported as success — the admin panel reverts its
    // inline sale switch / timer on a non-2xx response. A "no rows" error is
    // tolerated when the Sheets mirror did update (legacy Sheets-only coupons).
    if (supabaseError) {
      const missingColumn = /column .* does not exist|Could not find the '.*' column/i.test(supabaseError.message);
      const notInSupabase = /no rows|PGRST116/i.test(supabaseError.message);
      if (missingColumn || !(notInSupabase && updated)) {
        return res.status(missingColumn ? 400 : 500).json({
          error: missingColumn
            ? `${supabaseError.message} — run server/setup_coupon_sale_timer.sql in the Supabase SQL editor.`
            : supabaseError.message,
        });
      }
    }

    invalidateCouponListCache();

    res.json({ message: 'Coupon updated successfully.', coupon: updated || { id, ...updates } });
  } catch (err) {
    console.error('Admin update coupon error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Sell Coupon: assign an available coupon to a registered user ────────────
// NOT a frontend-only status flip. The sale is routed through the REAL payment
// pipeline (order → payment → finalizePayment) so every safeguard the buyers'
// flow has applies here too: DB-authoritative pricing, the atomic sold-flip in
// unlockCoupon(), duplicate-purchase detection, PAID ledger rows in Orders +
// Payments, and finance reporting that stays consistent.
function sellFail(res, status, code, error, extra = {}) {
  return res.status(status).json({ ok: false, code, error, ...extra });
}

// Lowest-case address from the paymentStore lookup precedence: Supabase first
// (findUserById is keyed on user_id), then the Users sheet. Sheets normalizes
// emails to lowercase on read, so a case-insensitive match is safe there.
function userRecordEmail(u) {
  if (!u) return '';
  for (const k of ['email', 'Email', 'EMAIL']) {
    if (u[k] !== undefined && u[k] !== null && String(u[k]).trim() !== '') {
      return String(u[k]).trim().toLowerCase();
    }
  }
  return '';
}

// POST /api/admin/coupons/:id/sell — record a real PAID sale of an available
// coupon to an active registered user, authorized by the signed-in admin.
router.post('/coupons/:id/sell', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  const adminEmail = String(req.user.email || '').trim().toLowerCase();
  try {
    const ready = await paymentStore.ensureReady();
    if (!ready.ok) {
      return sellFail(res, 503, 'STORAGE_UNAVAILABLE', 'The payments store is temporarily unavailable. Try again in a moment.');
    }

    // ── 1. Load the coupon (authoritative record only) ───────────────────────
    const couponId = String((req.params && req.params.id) || '').trim();
    let coupon = null;
    if (supabase.isConfigured()) {
      try { coupon = await supabase.findCouponById(couponId); } catch (e) {}
    }
    if (!coupon) {
      try { coupon = await db.findRow(db.SHEETS.COUPONS, 'id', couponId); } catch (e) {}
    }
    if (!coupon) {
      return sellFail(res, 404, 'COUPON_NOT_FOUND', 'Coupon not found.');
    }

    // ── 2. Coupon eligibility ────────────────────────────────────────────────
    // Same rules as a buyer's checkout: status 'available', no active
    // reservation held by somebody else, not expired, price derivable.
    const status = String(coupon.status || 'available').toLowerCase();
    if (status !== 'available') {
      return sellFail(res, 409, 'COUPON_UNAVAILABLE', `This coupon is no longer available (status: ${status || 'unknown'}).`);
    }

    // ── 3. Recipient eligibility — the body supplies ONLY a stable user id ───
    const recipientUserId = String((req.body && (req.body.userId || req.body.user_id)) || '').trim();
    if (!recipientUserId) {
      return sellFail(res, 400, 'RECIPIENT_REQUIRED', 'Select a registered user to receive this coupon.');
    }

    // Authoritative recipient record: Supabase first, then the Users sheet.
    let recipient = null;
    if (supabase.isConfigured()) {
      try { recipient = await supabase.findUserById(recipientUserId); } catch (e) {}
    }
    if (!recipient) {
      try {
        const rows = await db.getRows(db.SHEETS.USERS);
        recipient = rows.find((r) => String(r.user_ID || r.user_id || r.id || '') === recipientUserId) || null;
      } catch (e) {}
    }
    if (!recipient) {
      return sellFail(res, 404, 'USER_NOT_FOUND', 'Recipient account not found. Select a registered user.');
    }

    const recipientEmail = userRecordEmail(recipient);
    if (!recipientEmail) {
      return sellFail(res, 409, 'RECIPIENT_NO_EMAIL', 'This account has no email address on record and cannot receive a coupon.');
    }
    const recipientStatus = String(recipient.status || 'active').toLowerCase().trim();
    if (recipientStatus === 'suspended' || recipientStatus === 'banned') {
      return sellFail(res, 409, 'USER_INELIGIBLE', `This account is ${recipientStatus} and cannot receive a coupon.`);
    }
    const recipientName = String(recipient.name || recipient.username || recipientEmail.split('@')[0] || '').trim().slice(0, 120);

    // Self-grant is allowed (the admin may add a coupon to their own account);
    // only a SELLER granting their own listing is refused, matching checkout.
    const sellerEmail = String(coupon.sellerEmail || '').toLowerCase().trim();
    const sellerUserId = String(coupon.sellerUserId || '');
    if (sellerEmail && sellerEmail === recipientEmail) {
      return sellFail(res, 409, 'OWN_COUPON', 'This coupon belongs to that user. It cannot be sold to its own seller.');
    }
    if (sellerUserId && sellerUserId === recipientUserId) {
      return sellFail(res, 409, 'OWN_COUPON', 'This coupon belongs to that user. It cannot be sold to its own seller.');
    }

    // ── 4. Authoritative price (server-derived; body price never trusted) ────
    const priceInfo = dynamicPricing.getBuyerPrice(coupon);
    if (!priceInfo.purchasable) {
      return sellFail(
        res, 409, priceInfo.expired ? 'COUPON_EXPIRED' : 'INVALID_PRICE',
        priceInfo.expired
          ? 'This coupon has expired and cannot be sold.'
          : 'This coupon has an invalid face value and cannot be sold.'
      );
    }
    const priced = upi.validateAmount(String(priceInfo.price));
    if (!priced.ok) {
      return sellFail(res, priced.code === 'AMOUNT_TOO_LARGE' ? 409 : 400, priced.code,
        priced.code === 'AMOUNT_TOO_LARGE'
          ? `This coupon's price is above the ₹${Number(priced.max).toFixed(2)} online payment limit and cannot be recorded online.`
          : 'This coupon has an invalid price and cannot be sold.');
    }
    const amount = priced.amount;

    // ── 5. Real pipeline: supersede → reserve → order → payment → settle ─────
    // One live payment per user: retire the recipient's other live sessions so
    // the new sale's payment row is the only live one for them.
    try {
      await paymentStore.supersedeLivePaymentsForUser(recipientUserId, { keepPaymentId: null });
    } catch (e) {}

    const now = Date.now();
    const expiresAt = new Date(now + paymentStore.PAYMENT_WINDOW_MS).toISOString();
    const checkExpiresAt = new Date(now + paymentStore.PAYMENT_CHECK_WINDOW_MS).toISOString();
    const paymentId = paymentStore.newPaymentId();

    let reserved = false;
    try {
      const verdict = await paymentStore.reserveCouponForPayment({
        couponId,
        userId: recipientUserId,
        userEmail: recipientEmail,
        paymentId,
        until: checkExpiresAt,
      });
      reserved = verdict.ok;
      if (!verdict.ok) {
        return sellFail(res, 409, 'COUPON_UNAVAILABLE',
          'This coupon is temporarily reserved by another buyer. Try again in a few minutes.');
      }
    } catch (e) {
      // Reservation schema not applied / storage hiccup: proceed unreserved.
      // The atomic sold-flip at settlement still prevents a double sale.
      console.warn('[ADMIN_SELL] reserve unavailable, continuing unreserved:', e.message);
    }

    let order;
    try {
      order = await paymentStore.createOrder({
        userId: recipientUserId,
        userEmail: recipientEmail,
        couponId,
        amount,
        buyerName: recipientName,
        buyerEmail: recipientEmail,
        couponCode: (coupon && coupon.code) || '',
        couponBrand: (coupon && coupon.brand) || '',
        expiresAt,
      });
    } catch (e) {
      if (reserved) {
        try { await paymentStore.releaseCouponReservation({ couponId, paymentId }); } catch (_) {}
      }
      console.error('Admin sell coupon — createOrder failed:', e);
      return sellFail(res, 503, 'ORDER_FAILED', 'Could not record the sale order. No charge or assignment was made — try again.');
    }

    const payee = upi.getPayee();
    const upiUri = upi.buildUpiUri({ amount });

    let payment;
    try {
      payment = await paymentStore.createPayment({
        paymentId,
        orderId: order.id,
        userId: recipientUserId,
        userEmail: recipientEmail,
        couponId,
        amount,
        expiresAt,
        checkExpiresAt,
        upiId: payee.upiId,
        payeeName: payee.payeeName,
        upiUri,
      });
    } catch (e) {
      if (reserved) {
        try { await paymentStore.releaseCouponReservation({ couponId, paymentId }); } catch (_) {}
      }
      try { await paymentStore.transitionOrder(order.id, 'PENDING', 'CANCELLED'); } catch (_) {}
      console.error('Admin sell coupon — createPayment failed:', e);
      return sellFail(res, 409, 'PAYMENT_CONFLICT',
        'A live payment session already exists for this user and coupon. Try again in a few minutes.');
    }

    // ── 6. Settle immediately through the real verifier entry point ──────────
    // finalizePayment performs the atomic unlockCoupon flip (status available →
    // sold, buyer_email, sold_payment_id), duplicate/replay guards, and marks
    // payment + order PAID. Nothing is "sold" until this says so.
    const settlementNotes = `Admin sale authorized by ${adminEmail} (vault panel).`;
    const finalized = await paymentStore.finalizePayment({
      paymentId,
      source: 'admin_sale',
      notes: settlementNotes,
      paidAt: new Date().toISOString(),
      receivedAmount: amount,
    });

    if (!finalized.ok) {
      // Payment/order rows are already parked in REVIEW by the store — a human
      // can see and reverse them; the coupon was NOT unlocked.
      console.error('Admin sell coupon — settlement refused:', finalized.code, finalized);
      const friendly = {
        DUPLICATE_PURCHASE: 'This user already purchased this coupon. Sale parked for review — nothing was double-assigned.',
        COUPON_UNAVAILABLE: 'The coupon could not be assigned (already sold or changed state). The session was parked for review.',
        REPLAY_DETECTED: 'A conflicting transaction reference was found. Sale parked for review.',
        OUTSIDE_WINDOW: 'Settlement fell outside the allowed window. Sale parked for review.',
        PAYMENT_NOT_FOUND: 'The payment session vanished before settlement. Try again.',
        PAYMENT_NOT_PENDING: 'The payment session was already closed by another process. Try again.',
      };
      return sellFail(res, 409, finalized.code || 'SETTLEMENT_FAILED',
        friendly[finalized.code] || 'The sale could not be completed. It was parked for review rather than partially applied.');
    }

    // Label the order truthfully for finance reports (best-effort — the sale
    // itself is already recorded; a failed relabel must not fail the request).
    try {
      await db.updateRow(db.SHEETS.ORDERS, 'id', order.id, { transaction_type: 'ADMIN_SALE' });
    } catch (e) {}

    invalidateCouponListCache();

    // ── 7. Audit + recipient notification (best-effort, never fails the sale) ─
    try {
      await logCouponAudit(
        couponId, adminEmail, 'admin_sell',
        `Sold to ${recipientEmail}; order ${order.orderCode}; txn ${order.transactionId}; source admin_sale`
      );
    } catch (e) {}
    let notified = false;
    try {
      const mail = await emailService.sendCouponDetailsEmail({
        to: recipientEmail,
        userName: recipientName,
        brandName: (coupon && coupon.brand) || '',
        couponDescription: (coupon && (coupon.description || coupon.title)) || '',
        couponValue: (coupon && (coupon.originalValue || coupon.faceValue)) || '',
        expiryDate: (coupon && coupon.expiryDate) || '',
        orderId: order.orderCode,
      });
      notified = !!(mail && mail.success !== false);
    } catch (e) {
      console.warn('[ADMIN_SELL] recipient email failed:', e.message);
    }

    console.log(`[ADMIN_SELL] coupon=${couponId} → ${recipientEmail} amount=${amount.toFixed(2)} order=${order.orderCode} txn=${order.transactionId} by ${adminEmail}`);

    // The coupon code is deliberately NOT returned — it reaches the recipient
    // only through their own dashboard's sold-payment-gated reveal.
    res.json({
      ok: true,
      message: `Coupon sold to ${recipientEmail}.`,
      order: {
        id: order.id,
        orderCode: order.orderCode,
        transactionId: order.transactionId,
        amount: Number(amount.toFixed(2)),
        currency: 'INR',
      },
      recipient: { id: recipientUserId, email: recipientEmail, name: recipientName },
      price: { amount: Number(amount.toFixed(2)), rate: priceInfo.rate || '', bandLabel: priceInfo.bandLabel || '' },
      notified,
    });
  } catch (err) {
    console.error('Admin sell coupon error:', err);
    sellFail(res, 500, 'SELL_FAILED', 'Internal server error while recording the sale.');
  }
});

// DELETE /api/admin/coupons/:id — Delete a coupon
router.delete('/coupons/:id', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const { id } = req.params;

    if (supabase.isConfigured()) {
      try {
        await supabase.deleteCoupon(id);
      } catch (e) {}
    }

    try {
      await db.deleteRow(db.SHEETS.COUPONS, 'id', id);
    } catch (e) {}

    invalidateCouponListCache();

    res.json({ message: 'Coupon deleted successfully.' });
  } catch (err) {
    console.error('Admin delete coupon error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/admin/coupons/:id/review — Full review record for the admin review page
router.get('/coupons/:id/review', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    let coupon = null;
    if (supabase.isConfigured()) {
      try {
        coupon = await supabase.findCouponById(id);
      } catch (e) {}
    }
    if (!coupon) {
      coupon = await db.findRow(db.SHEETS.COUPONS, 'id', id);
    }
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }

    // Duplicate-check result: any OTHER coupon sharing the same code
    let duplicate = null;
    if (coupon.code) {
      const cleanCode = String(coupon.code).toUpperCase().trim();
      if (supabase.isConfigured()) {
        try {
          const dup = await supabase.findCouponByCode(cleanCode);
          if (dup && dup.id !== id) duplicate = dup;
        } catch (e) {}
      }
      if (!duplicate) {
        try {
          const rows = await db.findRows(db.SHEETS.COUPONS, 'code', cleanCode);
          duplicate = rows.find((r) => r.id !== id) || null;
        } catch (e) {}
      }
    }

    const payoutMap = await payoutsByCouponId();
    const payout = payoutMap.get(String(coupon.id)) || null;

    res.json({
      coupon: payoutSummary(coupon, payout),
      duplicateCheck: {
        isDuplicate: !!duplicate,
        duplicateId: duplicate ? duplicate.id : null,
        duplicateStatus: duplicate ? duplicate.status : null,
        duplicateAddedAt: duplicate ? duplicate.addedAt : null,
      },
      notification: {
        status: coupon.whatsappStatus || 'pending',
        sid: coupon.whatsappSid || '',
        lastAttempt: coupon.whatsappLastAttempt || '',
        error: coupon.whatsappError || '',
      },
      reviewUrl: `${APP_BASE_URL}/admin/coupons/${id}`,
    });
  } catch (err) {
    console.error('Admin review fetch error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/admin/coupons/:id/review-action — Approve / Reject / Request More Proof
// Status is decided server-side from a whitelisted action; never trusted from the client.
router.post('/coupons/:id/review-action', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { action, notes } = req.body || {};

    const transitions = {
      approve: { status: 'available' },
      reject: { status: 'rejected' },
      request_proof: { status: 'proof_requested' },
    };
    if (!transitions[action]) {
      return res.status(400).json({ error: 'Invalid action. Allowed: approve, reject, request_proof.' });
    }

    let coupon = null;
    if (supabase.isConfigured()) {
      try {
        coupon = await supabase.findCouponById(id);
      } catch (e) {}
    }
    if (!coupon) {
      coupon = await db.findRow(db.SHEETS.COUPONS, 'id', id);
    }
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }

    const now = new Date().toISOString();
    const updates = {
      status: transitions[action].status,
      adminNotes: String(notes || '').trim().slice(0, 500),
    };

    // ── Duplicate-payout protection ────────────────────────────────────────
    // If the coupon is already in the post-approval state (`available`), the
    // 7% payout has already been written to the existing Sheets sellerPayout
    // column. Refuse to re-write it on a duplicate Approve click — keeping
    // verifiedAt stable and stopping the same seller payout from being
    // "generated again" on every page refresh.
    const alreadyApproved = String(coupon.status || '').toLowerCase() === 'available';
    const willBeApproved = transitions[action].status === 'available';
    const skipPayoutWrite = action === 'approve' && alreadyApproved;

    if (action === 'approve') {
      // A seller coupon cannot go live with a face value outside ₹100–₹10,000,
      // and its payout must be the 7% of that face value — never a stored or
      // client-supplied figure. The face value is read from the coupon row,
      // not from the request body, so a client cannot influence the payout.
      if (isSellerCoupon(coupon) && !isValidSellerFaceValue(coupon.originalValue)) {
        return res.status(400).json({
          error: 'This coupon has an invalid face value and cannot be approved. Correct the face value or reject it.',
          code: 'INVALID_FACE_VALUE',
        });
      }
      // Always set the verification stamp on the first approval; leave it
      // untouched on a duplicate click so the original approval time survives.
      if (!alreadyApproved) {
        updates.isVerified = true;
        updates.verifiedAt = now;
      }
      if (isSellerCoupon(coupon) && !skipPayoutWrite) {
        // 7% of the verified face value — written to the existing Sheets
        // sellerPayout column (the only place this number is persisted).
        updates.sellerPayout = calculateSellerPayout(coupon.originalValue);
      }
    }

    let saved = false;
    if (supabase.isConfigured()) {
      try {
        await supabase.updateCoupon(id, updates);
        saved = true;
      } catch (e) {}
    }
    try {
      await db.updateRow(db.SHEETS.COUPONS, 'id', id, {
        ...updates,
        isVerified: updates.isVerified !== undefined ? String(updates.isVerified) : undefined,
      });
      saved = true;
    } catch (e) {}

    if (!saved) {
      return res.status(500).json({ error: 'Could not update the coupon. Please try again.' });
    }

    await logCouponAudit(id, req.user.email, action, updates.adminNotes);

    invalidateCouponListCache();

    res.json({
      message: action === 'approve'
        ? 'Coupon approved and is now live in the marketplace.'
        : action === 'reject' ? 'Coupon rejected.' : 'More proof requested from the seller.',
      coupon: { ...coupon, ...updates },
    });
  } catch (err) {
    console.error('Admin review action error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/admin/coupons/:id/invalidate — mark an already-reviewed coupon invalid
// The post-review counterpart of review-action's `reject`: the coupon is already
// live (or already sold and payable) and turns out not to work. Its marketplace
// `status` is left alone on purpose — the marketplace's own status filtering must
// not change under it — so the failure is recorded in its own field, and anything
// still owed on that coupon is withheld in the same call, because a coupon that
// failed validation must never reach a payout run.
router.post('/coupons/:id/invalidate', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const cleanReason = String(reason || '').trim().slice(0, 500);

    let coupon = null;
    if (supabase.isConfigured()) {
      try {
        coupon = await supabase.findCouponById(id);
      } catch (e) {}
    }
    if (!coupon) {
      coupon = await db.findRow(db.SHEETS.COUPONS, 'id', id);
    }
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }

    // Before review, the right tool is the review screen's Reject action. Refusing
    // pre-review statuses here keeps the two actions from silently overlapping.
    if (payouts.PRE_REVIEW_COUPON_STATUSES.includes(String(coupon.status || '').toLowerCase())) {
      return res.status(400).json({
        error: 'This coupon has not been reviewed yet. Use Reject on the review screen instead.',
        code: 'COUPON_NOT_REVIEWED',
      });
    }

    const existing = await payouts.describeCouponInvalidationById(id, coupon);
    const admin = req.user.email || req.user.name || 'admin';

    // Withholding runs on every call. It only touches rows that are still
    // payable, so a repeat click finishes a partially-failed first attempt
    // instead of paying or rejecting anything twice.
    const withheldPayouts = await payouts.withholdPayoutsForCoupon({
      couponId: id,
      reason: cleanReason,
      actorEmail: admin,
    });

    if (existing.invalidated) {
      return res.json({
        message: 'This coupon is already marked invalid. Payment stays withheld.',
        alreadyInvalidated: true,
        coupon,
        invalidation: { at: existing.at, by: existing.by, reason: existing.reason },
        withheldPayouts,
        sellerStatus: payouts.SELLER_STATUS.FAILED,
      });
    }

    const at = new Date().toISOString();
    const updates = {
      validationStatus: 'failed',
      invalidatedAt: at,
      invalidationReason: cleanReason,
      paymentWithheld: 'true',
    };

    // Same dual-write path as PUT /coupons/:id — Supabase is the store the
    // marketplace reads, the Coupons sheet is the mirror. Both are best-effort
    // here: the audit row below is the record that has to survive, which is why
    // it is also what the seller-facing status derivation reads back.
    if (supabase.isConfigured()) {
      try {
        await supabase.updateCoupon(id, updates);
      } catch (e) {
        console.warn('[admin/invalidate] Supabase write notice:', e.message);
      }
    }
    try {
      await db.updateRow(db.SHEETS.COUPONS, 'id', id, updates);
    } catch (e) {
      console.warn('[admin/invalidate] Sheets write notice:', e.message);
    }

    await logCouponAudit(id, admin, 'invalidate', cleanReason || 'Marked invalid by admin.');

    invalidateCouponListCache();

    res.json({
      message: withheldPayouts.count
        ? `Coupon marked invalid. ₹${withheldPayouts.amount} of pending payout was withheld.`
        : 'Coupon marked invalid. No pending payout to withhold.',
      alreadyInvalidated: false,
      coupon: { ...coupon, ...updates },
      invalidation: { at, by: admin, reason: cleanReason },
      withheldPayouts,
      sellerStatus: payouts.SELLER_STATUS.FAILED,
    });
  } catch (err) {
    console.error('Admin invalidate coupon error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/admin/coupons/:id/notify-retry — Re-send the WhatsApp submission alert
router.post('/coupons/:id/notify-retry', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const { id } = req.params;

    let coupon = null;
    if (supabase.isConfigured()) {
      try {
        coupon = await supabase.findCouponById(id);
      } catch (e) {}
    }
    if (!coupon) {
      coupon = await db.findRow(db.SHEETS.COUPONS, 'id', id);
    }
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }

    const reviewUrl = `${APP_BASE_URL}/admin/coupons/${id}`;
    const notify = await twilioWhatsApp.sendCouponSubmissionAlert(coupon, reviewUrl);
    const updates = {
      whatsappStatus: notify.success ? 'sent' : 'failed',
      whatsappSid: notify.success ? (notify.sid || '') : '',
      whatsappLastAttempt: new Date().toISOString(),
      whatsappError: notify.success ? '' : (notify.error || 'Unknown error'),
    };

    if (supabase.isConfigured()) {
      try {
        await supabase.updateCoupon(id, updates);
      } catch (e) {}
    }
    try {
      await db.updateRow(db.SHEETS.COUPONS, 'id', id, updates);
    } catch (e) {}

    invalidateCouponListCache();

    await logCouponAudit(id, req.user.email, 'notify_retry', notify.success ? 'sent' : updates.whatsappError);

    if (!notify.success) {
      return res.status(502).json({ error: updates.whatsappError, notification: updates });
    }
    res.json({ message: 'WhatsApp notification sent.', notification: updates });
  } catch (err) {
    console.error('Admin notify retry error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/admin/users — List all users (live Google Sheets Users tab)
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [users, coupons, sessions] = await Promise.all([
      db.getRows(db.SHEETS.USERS),
      db.getRows(db.SHEETS.COUPONS).catch(() => []),
      supabase.isConfigured() ? supabase.getAllSessions().catch(() => []) : Promise.resolve([]),
    ]);

    // Build bought/sold counts keyed by lowercase email
    const boughtMap = {};
    const soldMap = {};
    for (const c of coupons) {
      const buyer = String(c.buyerEmail || '').toLowerCase().trim();
      const seller = String(c.sellerEmail || '').toLowerCase().trim();
      if (buyer) boughtMap[buyer] = (boughtMap[buyer] || 0) + 1;
      if (seller) soldMap[seller] = (soldMap[seller] || 0) + 1;
    }

    // Build latest session per email (most recent login_time wins)
    const latestSessionMap = {};
    for (const s of sessions) {
      const sEmail = String(s.email || '').toLowerCase().trim();
      if (!sEmail) continue;
      const existing = latestSessionMap[sEmail];
      if (!existing || new Date(s.login_time || 0) > new Date(existing.login_time || 0)) {
        latestSessionMap[sEmail] = s;
      }
    }

    const list = users.map((u) => {
      const email = String(u.email || '').toLowerCase().trim();
      const session = latestSessionMap[email] || {};
      const sessionStatus = String(session.status || '').toLowerCase();
      return {
        id: u.user_id || u.id || '',
        name: u.name || u.username || String(u.email || '').split('@')[0] || 'Unknown',
        username: u.username || '',
        email: u.email || '',
        status: String(u.status || 'active').toLowerCase().trim(),
        // The account's own Google avatar URL, captured at Google login by
        // googlePictureFields() in routes/auth.js. Sending it is what lets the
        // admin panel show the real Gmail photo instead of asking a third-party
        // avatar service to guess one from the email address. Blank for accounts
        // that have never completed a Google login, or whose Google account has
        // no photo — the UI falls back to an initials tile.
        profilePicture: u.profile_picture || '',
        createdAt: u.created_at || u.createdAt || '',
        lastLoginAt: session.login_time || u.last_login_at || '',
        lastLogoutAt: session.last_active && (sessionStatus === 'logged out' || sessionStatus === 'expired')
          ? session.last_active : (u.last_logout_at || ''),
        loginMethod: session.login_method || '',
        sessionStatus: session.status || '',
        couponsBought: boughtMap[email] || 0,
        couponsSold: soldMap[email] || 0,
      };
    });
    res.json({
      users: list,
      counts: {
        total: list.length,
        active: list.filter((u) => u.status === 'active').length,
        suspended: list.filter((u) => u.status === 'suspended' || u.status === 'banned').length,
      },
    });
  } catch (err) {
    console.error('Admin list users error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/admin/users/search?q=&page=&pageSize= — paged, server-side search
// for the Sell-Coupon recipient picker. Reads the same live Users sheet as
// GET /users but returns only what the picker needs (id, name, email, status,
// avatar) — never credentials, tokens or session data.
router.get('/users/search', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const q = String((req.query && req.query.q) || '').trim().toLowerCase();
    const page = Math.max(1, parseInt((req.query && req.query.page) || '1', 10) || 1);
    const pageSize = Math.min(50, Math.max(5, parseInt((req.query && req.query.pageSize) || '25', 10) || 25));

    const rows = await db.getRows(db.SHEETS.USERS);
    const all = rows.map((u) => {
      const email = String(u.email || '').toLowerCase().trim();
      return {
        id: String(u.user_ID || u.user_id || u.id || ''),
        name: String(u.name || u.username || email.split('@')[0] || 'Unknown').trim(),
        username: String(u.username || '').trim(),
        email: String(u.email || '').trim(),
        status: String(u.status || 'active').toLowerCase().trim(),
        profilePicture: String(u.profile_picture || '').trim(),
      };
    }).filter((u) => u.id || u.email);

    const counts = { total: all.length, active: all.filter((u) => u.status === 'active').length };

    let filtered = all;
    if (q) {
      filtered = all.filter((u) =>
        u.name.toLowerCase().includes(q) ||
        (u.username && u.username.toLowerCase().includes(q)) ||
        u.email.toLowerCase().includes(q));
    }

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const users = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

    res.json({ users, total, page: safePage, pageSize, totalPages, counts });
  } catch (err) {
    console.error('Admin user search error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/admin/users/status — Suspend or reactivate a user in the sheet
router.put('/users/status', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const { userId, status } = req.body;
    if (!userId || !['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'userId and a status of active/suspended are required.' });
    }

    // A suspension must always carry its reason — the admin UI collects it in
    // the suspend modal, and this check keeps direct API calls honest too.
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    if (status === 'suspended' && reason.length < 3) {
      return res.status(400).json({ error: 'A suspension reason of at least 3 characters is required.' });
    }

    let existing = await db.findRow(db.SHEETS.USERS, 'user_id', userId);
    if (!existing) existing = await db.findRow(db.SHEETS.USERS, 'id', userId);
    if (!existing) return res.status(404).json({ error: 'User not found.' });

    const now = new Date().toISOString();
    // suspend_reason / suspended_at are only written when the Users sheet has
    // those columns; updateRow ignores keys with no matching header.
    await db.updateRow(db.SHEETS.USERS, 'user_id', userId, {
      status,
      updated_at: now,
      suspend_reason: status === 'suspended' ? reason : '',
      suspended_at: status === 'suspended' ? now : '',
    });
    console.log(
      `[admin] ${req.user && req.user.email ? req.user.email : 'admin'} set ${existing.email || userId} to ${status}` +
      (status === 'suspended' ? ` — reason: ${reason}` : '')
    );
    res.json({ message: `User is now ${status}.`, status });
  } catch (err) {
    console.error('Admin user status error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/admin/sessions — User sessions (live Supabase data)
router.get('/sessions', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!supabase.isConfigured()) {
      return res.status(503).json({ error: 'Administrative session storage is temporarily unavailable.' });
    }

    const [sessions, sheetUsers, mongoAdmins] = await Promise.all([
      supabase.getAllSessions(),
      db.getRows(db.SHEETS.USERS).catch(() => []),
      // readyState guard: an unconnected mongoose buffers the query and this
      // endpoint would hang instead of simply listing sessions without photos.
      mongoose.connection.readyState === 1
        ? Admin.find({}).select('email profile_image').lean().catch(() => [])
        : Promise.resolve([]),
    ]);

    // Email → Google profile photo. A session row knows only an email; the
    // photo lives on the account record — profile_picture on the Users sheet,
    // captured at Google login, plus profile_image on MongoDB admin documents.
    // Attaching it here means the avatar paints in the same pass as the
    // table, with no second client-side directory lookup — and it covers
    // Email-OTP sessions of accounts that have signed in with Google before.
    // Accounts that never used Google login have no photo anywhere (Google
    // offers no public email→photo lookup), and simply keep their initials.
    const photoByEmail = new Map();
    for (const u of sheetUsers || []) {
      const key = String((u && u.email) || '').toLowerCase().trim();
      const photo = String((u && u.profile_picture) || '').trim();
      if (key && photo) photoByEmail.set(key, photo);
    }
    for (const a of mongoAdmins || []) {
      const key = String((a && a.email) || '').toLowerCase().trim();
      const photo = String((a && a.profile_image) || '').trim();
      if (key && photo && !photoByEmail.has(key)) photoByEmail.set(key, photo);
    }
    for (const s of sessions) {
      const photo = photoByEmail.get(String(s.email || '').toLowerCase().trim());
      if (photo) s.profilePicture = photo;
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const counts = {
      total: sessions.length,
      active: sessions.filter((s) => s.status === 'Active').length,
      loggedOut: sessions.filter((s) => s.status === 'Logged out').length,
      expired: sessions.filter((s) => s.status === 'Expired').length,
      uniqueUsers: new Set(sessions.map((s) => s.user_id).filter(Boolean)).size,
      loginsToday: sessions.filter((s) => s.login_time && new Date(s.login_time) >= startOfDay).length,
    };

    res.json({ sessions, counts });
  } catch (err) {
    console.error('Admin list sessions error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/admin/admin-sessions — ADMIN login sessions (live Supabase data).
// Admin sessions auto-expire 2 hours after login; this view shows who is /
// was in the panel, from which device, and when their session ends.
router.get('/admin-sessions', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!supabase.isConfigured()) {
      return res.status(503).json({ error: 'Administrative session storage is temporarily unavailable.' });
    }

    const [sessions, sheetUsers, mongoAdmins] = await Promise.all([
      supabase.getAdminSessions(),
      db.getRows(db.SHEETS.USERS).catch(() => []),
      // Same readyState guard as /sessions above.
      mongoose.connection.readyState === 1
        ? Admin.find({}).select('email profile_image').lean().catch(() => [])
        : Promise.resolve([]),
    ]);

    // Same email→photo directory as GET /sessions above: admins get their
    // Google photo too, from whichever record holds the newest one.
    const photoByEmail = new Map();
    for (const u of sheetUsers || []) {
      const key = String((u && u.email) || '').toLowerCase().trim();
      const photo = String((u && u.profile_picture) || '').trim();
      if (key && photo) photoByEmail.set(key, photo);
    }
    for (const a of mongoAdmins || []) {
      const key = String((a && a.email) || '').toLowerCase().trim();
      const photo = String((a && a.profile_image) || '').trim();
      if (key && photo && !photoByEmail.has(key)) photoByEmail.set(key, photo);
    }
    for (const s of sessions) {
      const photo = photoByEmail.get(String(s.email || '').toLowerCase().trim());
      if (photo) s.profilePicture = photo;
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

    const counts = {
      total: sessions.length,
      active: sessions.filter((s) => s.status === 'Active').length,
      loggedOut: sessions.filter((s) => s.status === 'Logged out').length,
      expired: sessions.filter((s) => s.status === 'Expired').length,
      uniqueAdmins: new Set(sessions.map((s) => s.email || s.user_id).filter(Boolean)).size,
      loginsToday: sessions.filter((s) => s.login_time && new Date(s.login_time) >= startOfDay).length,
      last24h: sessions.filter((s) => s.login_time && new Date(s.login_time).getTime() >= dayAgo).length,
    };

    res.json({ sessions, counts });
  } catch (err) {
    console.error('Admin list admin-sessions error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/admin/sessions/backfill-userids
// One-shot migration: for every Supabase session whose user_id is empty or
// looks wrong (fallback "user_<timestamp>" prefix, or empty), look the email
// up in the Google Sheets USERS tab and write the canonical user_id back to
// the session row. Safe to re-run.
router.post('/sessions/backfill-userids', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    if (!supabase.isConfigured()) {
      return res.status(503).json({ error: 'Supabase is not configured on the server.' });
    }
    const supabaseClient = supabase.getClient();
    if (!supabaseClient) return res.status(503).json({ error: 'Supabase client unavailable.' });

    // Load all sessions + all users in parallel
    const [sessions, sheetUsers] = await Promise.all([
      supabase.getAllSessions(),
      db.getRows(db.SHEETS.USERS).catch(() => []),
    ]);

    // Build email → user_id lookup (case-insensitive)
    const emailToId = new Map();
    for (const u of sheetUsers) {
      const email = String(u.email || '').toLowerCase().trim();
      if (!email) continue;
      // Resolve the canonical user_id (any of user_id / userId / id / uuid…)
      let id = '';
      for (const k of ['user_id', 'userId', 'userid', 'id', 'uuid']) {
        if (u[k]) { id = String(u[k]); break; }
      }
      if (!id) {
        for (const [k, v] of Object.entries(u)) {
          if (!v) continue;
          const nk = String(k).trim().toLowerCase().replace(/[\s_-]+/g, '');
          if (nk === 'userid' || nk === 'uuid') { id = String(v); break; }
        }
      }
      if (id && !emailToId.has(email)) emailToId.set(email, id);
    }

    // Decide which sessions need fixing: empty user_id OR a fallback timestamp
    // OR no matching email in the sheet (left untouched).
    const isBad = (uid) => !uid || /^user_\d+$/.test(String(uid)) || /^\d{10,}$/.test(String(uid));

    let updated = 0;
    let skipped = 0;
    const sample = [];
    for (const s of sessions) {
      const email = String(s.email || '').toLowerCase().trim();
      const correctId = emailToId.get(email);
      if (!correctId) { skipped++; continue; }
      if (!isBad(s.user_id) && s.user_id === correctId) { skipped++; continue; }

      try {
        const { error } = await supabaseClient
          .from('user_sessions')
          .update({ user_id: correctId })
          .eq('session_id', s.session_id);
        if (error) {
          console.warn('[backfill] update error for', s.session_id, error.message);
          continue;
        }
        updated++;
        if (sample.length < 5) sample.push({ session_id: s.session_id, email, from: s.user_id, to: correctId });
      } catch (e) {
        console.warn('[backfill] exception for', s.session_id, e.message);
      }
    }

    res.json({ ok: true, updated, skipped, totalSessions: sessions.length, sample });
  } catch (err) {
    console.error('Backfill user_ids error:', err);
    res.status(500).json({ error: 'Backfill failed.' });
  }
});

// PUT /api/admin/sessions/:sessionId/terminate — Force-end an active session
router.put('/sessions/:sessionId/terminate', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required.' });
    }

    await supabase.endSession(sessionId, 'Logged out');
    res.json({ message: 'Session terminated. The user will be logged out on that device.' });
  } catch (err) {
    console.error('Admin terminate session error:', err);
    res.status(500).json({ error: 'Failed to terminate session.' });
  }
});

// GET /api/admin/support-cases — List support tickets (live Google Sheets data)
router.get('/support-cases', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const tickets = await db.getRows(db.SHEETS.SUPPORT_TICKETS);
    const normStatus = (s) => {
      const v = String(s || 'open').toLowerCase().trim().replace(/[\s_-]+/g, '');
      return ['open', 'inprogress', 'resolved', 'closed'].includes(v) ? v : 'open';
    };
    const list = tickets.map((t) => ({
      id: t.id || '',
      subject: t.subject || '(no subject)',
      user: t.name || String(t.userEmail || '').split('@')[0] || 'Unknown',
      email: t.userEmail || '',
      message: t.message || '',
      status: normStatus(t.status),
      createdAt: t.createdAt || '',
      resolvedAt: t.resolvedAt || '',
      resolution: t.resolution || '',
      attachmentUrl: t.attachmentUrl || '',
      attachmentName: t.attachmentName || '',
    })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    const counts = { total: list.length, open: 0, inprogress: 0, resolved: 0, closed: 0 };
    list.forEach((t) => { counts[t.status]++; });

    res.json({ cases: list, counts });
  } catch (err) {
    console.error('Admin support cases error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/admin/support-cases/:id/status — Move a ticket between statuses in the sheet
router.put('/support-cases/:id/status', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const { status, resolution } = req.body;
    const id = req.params.id;
    if (!id || !['open', 'inprogress', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'A status of open/inprogress/resolved/closed is required.' });
    }

    const existing = await db.findRow(db.SHEETS.SUPPORT_TICKETS, 'id', id);
    if (!existing) return res.status(404).json({ error: 'Support case not found.' });

    const wasResolved = existing.status === 'resolved';
    const now = new Date().toISOString();
    const resolvedAt = (status === 'resolved' || status === 'closed') ? (existing.resolvedAt || now) : '';

    // Persist the admin's resolution message when transitioning into "resolved".
    // Don't overwrite an existing one on subsequent status flips (e.g. reopen -> resolved).
    const cleanResolution = resolution && String(resolution).trim()
      ? String(resolution).trim().slice(0, 4000)
      : (existing.resolution || '');
    // updatedAt is what the user's Help & Support list shows as "Updated", so it
    // has to move whenever the case does — otherwise a case resolved today still
    // reads as last touched on the day it was opened.
    const update = { status, resolvedAt, updatedAt: now };
    if (status === 'resolved' && cleanResolution) update.resolution = cleanResolution;

    // Record the resolution in the case thread as well, so the user sees it as a
    // support reply in context rather than as a detached "resolution" field.
    // Appended once: a later status flip finds it already there and skips.
    if (cleanResolution) {
      let thread = [];
      try {
        const parsed = existing.messages ? JSON.parse(existing.messages) : [];
        if (Array.isArray(parsed)) thread = parsed;
      } catch (e) {
        console.warn(`[admin/support-cases] Could not parse messages for ${id}:`, e.message);
      }
      const already = thread.some((m) => m && m.from === 'support' && m.body === cleanResolution);
      if (!already) {
        thread.push({ from: 'support', body: cleanResolution, at: now });
        update.messages = JSON.stringify(thread);
      }
    }

    await db.updateRow(db.SHEETS.SUPPORT_TICKETS, 'id', id, update);

    // Fire the "Your case has been resolved ✅" email to the user — only on the
    // first transition into "resolved" (not on later flips).
    // IMPORTANT: awaited, not fire-and-forget. On Vercel the serverless
    // function is frozen the instant the response is sent, which would kill an
    // un-awaited SMTP send before it completes. We await and swallow errors so
    // a mail failure still can't fail the status update (row is already saved).
    if (status === 'resolved' && !wasResolved && existing.userEmail) {
      try {
        const r = await emailService.sendSupportResolvedEmail({
          to: existing.userEmail,
          userName: existing.name || '',
          caseId: existing.id,
          subject: existing.subject || '',
          resolvedAt: resolvedAt || now,
          userMessage: existing.message || '',
          resolution: cleanResolution || '',
        });
        if (r && r.success) {
          console.log(`📧 [Admin] Resolution email sent for case #${existing.id} → ${existing.userEmail}`);
        } else if (r && r.isSimulated) {
          console.warn(`📧 [Admin] Resolution email NOT sent for case #${existing.id} → ${existing.userEmail}`);
          console.warn(`   Reason: ${r.error || 'SMTP not configured'}`);
        } else {
          console.warn(`📧 [Admin] Resolution email FAILED for case #${existing.id} → ${existing.userEmail}: ${(r && r.error) || 'unknown'}`);
        }
      } catch (e) {
        console.warn('📧 [Admin] Resolution email unexpected error:', e && e.message ? e.message : e);
      }
    }

    res.json({ message: `Case moved to ${status}.`, status, resolvedAt });
  } catch (err) {
    console.error('Admin support case status error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/admin/settings — Fetch system settings
router.get('/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let settings = await db.getSettings();

    // Dual lookup in MongoDB Atlas if connected
    if (mongoose.connection.readyState === 1) {
      try {
        const mongoSetting = await Setting.findOne({ key: 'site_settings' });
        if (mongoSetting) {
          settings = {
            ...settings,
            activeUsers: mongoSetting.activeUsers || settings.activeUsers,
            couponsTraded: mongoSetting.couponsTraded || settings.couponsTraded,
            savedByUsers: mongoSetting.savedByUsers || settings.savedByUsers,
            platformName: mongoSetting.platformName || settings.platformName,
            adminEmail: mongoSetting.adminEmail || settings.adminEmail,
            showActiveUsers: mongoSetting.showActiveUsers !== undefined ? mongoSetting.showActiveUsers : settings.showActiveUsers,
            showCouponsTraded: mongoSetting.showCouponsTraded !== undefined ? mongoSetting.showCouponsTraded : settings.showCouponsTraded,
            showSavedByUsers: mongoSetting.showSavedByUsers !== undefined ? mongoSetting.showSavedByUsers : settings.showSavedByUsers,
            testimonialsLabel: mongoSetting.testimonialsLabel || settings.testimonialsLabel,
            testimonialsTitle: mongoSetting.testimonialsTitle || settings.testimonialsTitle,
            testimonialsTitleHighlight: mongoSetting.testimonialsTitleHighlight || settings.testimonialsTitleHighlight,
            testimonialsSubtitle: mongoSetting.testimonialsSubtitle !== undefined && mongoSetting.testimonialsSubtitle !== null
              ? mongoSetting.testimonialsSubtitle
              : settings.testimonialsSubtitle,
            showTestimonials: mongoSetting.showTestimonials !== undefined ? mongoSetting.showTestimonials : settings.showTestimonials,
          };
        }
      } catch (e) {}
    }

    res.json({ settings });
  } catch (err) {
    console.error('Admin get settings error:', err);
    res.json({
      settings: {
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
      },
    });
  }
});

// PUT /api/admin/settings — Update system settings (saved to Google Sheets & MongoDB)
router.put('/settings', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const { activeUsers, couponsTraded, savedByUsers, platformName, adminEmail, showActiveUsers, showCouponsTraded, showSavedByUsers } = req.body;
    const {
      testimonialsLabel, testimonialsTitle, testimonialsTitleHighlight,
      testimonialsSubtitle, showTestimonials,
    } = req.body;
    // A key the request omits is left at its stored value by db.saveSettings, so
    // a caller that only knows about some of the settings cannot blank the rest.
    const text = (v, max) => (v === undefined ? undefined : String(v == null ? '' : v).trim().slice(0, max));
    const flag = (v) => (v === undefined ? undefined : Boolean(v));

    const payload = {
      activeUsers: activeUsers ? String(activeUsers).trim() : '10K+',
      couponsTraded: couponsTraded ? String(couponsTraded).trim() : '50K+',
      savedByUsers: savedByUsers ? String(savedByUsers).trim() : '₹2L+',
      platformName: platformName ? String(platformName).trim() : 'SaveHatke',
      adminEmail: adminEmail ? String(adminEmail).trim() : 'rupayandas2024@gmail.com',
      showActiveUsers: showActiveUsers !== undefined ? Boolean(showActiveUsers) : true,
      showCouponsTraded: showCouponsTraded !== undefined ? Boolean(showCouponsTraded) : true,
      showSavedByUsers: showSavedByUsers !== undefined ? Boolean(showSavedByUsers) : true,
      // Heading above the homepage testimonial cards. The cards themselves are
      // managed through /api/testimonials, not here.
      testimonialsLabel: text(testimonialsLabel, 60),
      testimonialsTitle: text(testimonialsTitle, 120),
      testimonialsTitleHighlight: text(testimonialsTitleHighlight, 120),
      testimonialsSubtitle: text(testimonialsSubtitle, 240),
      showTestimonials: flag(showTestimonials),
    };

    // 1. Save to Google Sheets / memoryDB
    const savedSheet = await db.saveSettings(payload);

    // The landing page renders its hero counters from a cached settings read
    // (services/publicSettings) — drop that cache so the new values apply on
    // the very next page load rather than after the TTL.
    try { require('../services/publicSettings').invalidatePublicSettings(); } catch (e) {}

    // 2. Dual sync to MongoDB Atlas if connected
    if (mongoose.connection.readyState === 1) {
      try {
        await Setting.findOneAndUpdate(
          { key: 'site_settings' },
          { ...payload, updated_at: new Date() },
          { upsert: true, new: true }
        );
      } catch (e) {
        console.warn('MongoDB Setting save warning:', e.message);
      }
    }

    res.json({
      message: 'Website settings updated successfully! 📊',
      settings: savedSheet || payload,
    });
  } catch (err) {
    console.error('Admin update settings error:', err);
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// REPORTS → MONTHLY REPORTS
// ════════════════════════════════════════════════════════════════════════
// Three figures for the month in progress, plus the delivery history of every
// month that has already been mailed to the configured admins.
//
// The "generated automatically on the 1st" rule is enforced by
// ensurePreviousMonthReport(), which is idempotent: this deployment is
// serverless, so there is no always-on scheduler to rely on, and the check runs
// whenever the page is opened. POST /reports/monthly/run does the same thing for
// an external cron, so whichever happens first wins and the second is a no-op.

// GET /api/admin/reports/monthly — current-month figures + delivery table
router.get('/reports/monthly', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let autoRun = null;
    try {
      autoRun = await monthlyReports.ensurePreviousMonthReport({ actor: 'auto' });
    } catch (err) {
      // A failed generation must not blank the page — surface it as a notice.
      console.error('[admin/reports/monthly] auto-generation failed:', err.message);
      autoRun = { generated: false, error: 'Automatic report generation is temporarily unavailable.' };
    }

    const currentKey = monthlyReports.monthKey();
    const win = monthlyReports.monthWindow(currentKey);
    const metrics = await monthlyReports.computeMetrics(currentKey);
    const reports = await monthlyReports.listReports();

    res.json({
      currentMonth: {
        month: currentKey,
        monthLabel: win.monthLabel,
        periodLabel: win.periodLabel,
        ...metrics,
      },
      reports,
      recipients: monthlyReports.configuredAdminEmails().map((e) => monthlyReports.maskEmail(e)),
      autoGenerated: autoRun && autoRun.generated ? autoRun.month : null,
      notice: autoRun && autoRun.error ? autoRun.error : '',
    });
  } catch (err) {
    console.error('Admin monthly reports error:', err);
    res.status(500).json({ error: 'Failed to load monthly reports.' });
  }
});

// GET /api/admin/reports/monthly/:month/pdf — the report itself
router.get('/reports/monthly/:month/pdf', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { month } = req.params;
    if (!monthlyReports.isValidMonthKey(month)) {
      return res.status(400).json({ error: 'Month must look like 2026-08.' });
    }

    const { buffer, filename } = await monthlyReports.getPdf(month);
    res.setHeader('Content-Type', 'application/pdf');
    // inline: "View PDF" opens it in a tab; the reader's own button downloads it.
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    console.error('Admin monthly report PDF error:', err);
    res.status(500).json({ error: 'Failed to build the report PDF.' });
  }
});

// POST /api/admin/reports/monthly/:month/resend — mail it to both admins again
router.post('/reports/monthly/:month/resend', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const { month } = req.params;
    if (!monthlyReports.isValidMonthKey(month)) {
      return res.status(400).json({ error: 'Month must look like 2026-08.' });
    }

    const actor = (req.user && req.user.email) || 'admin';
    const report = await monthlyReports.sendReport(month, { actor });
    const failed = report.admins.filter((a) => a.configured && a.status !== 'sent');

    res.json({
      message: failed.length
        ? `Report re-sent, but ${failed.length} admin address did not accept it.`
        : 'Report re-sent to the configured admins.',
      report,
    });
  } catch (err) {
    console.error('Admin monthly report resend error:', err);
    res.status(500).json({ error: 'Failed to re-send the report.' });
  }
});

// GET|POST /api/admin/reports/monthly/run — generate last month's report if
// missing. This is the scheduled entry point: vercel.json runs it at 02:00 UTC
// on the 1st (07:30 IST), which is what makes the report actually go out on the
// 1st rather than whenever an admin next opens the panel.
//
// Vercel cron invokes with GET and, when CRON_SECRET is set, presents it as
// `Authorization: Bearer <secret>`; the older `x-cron-key` contract still works
// for any other external scheduler. Anything else falls through to a normal
// admin session. Vercel does not retry a failed run and delivery is best
// effort, so ensurePreviousMonthReport() stays idempotent per month and the
// in-request checks remain as a catch-up.
function cronSecretMatches(req) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return false;

  const bearer = String(req.get('authorization') || '').trim();
  const presented = bearer.toLowerCase().startsWith('bearer ')
    ? bearer.slice(7).trim()
    : String(req.get('x-cron-key') || '').trim();
  if (!presented) return false;

  // Constant-time compare — this is a shared secret checked on every hit.
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.all('/reports/monthly/run', async (req, res, next) => {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
  if (cronSecretMatches(req)) return handleMonthlyRun(req, res);
  return authenticateToken(req, res, () => requireAdmin(req, res, () => handleMonthlyRun(req, res)));
});

async function handleMonthlyRun(req, res) {
  try {
    const actor = (req.user && req.user.email) || 'cron';
    const result = await monthlyReports.ensurePreviousMonthReport({ actor });
    let message;
    if (result.generated) message = `Generated and sent the ${result.month} report.`;
    else if (result.skipped === 'storage-unavailable') message = 'Report storage is unavailable, so nothing was generated.';
    else message = `Nothing to do — the ${result.month} report already exists.`;
    res.json({ message, ...result });
  } catch (err) {
    console.error('Admin monthly report run error:', err);
    res.status(500).json({ error: 'Failed to generate the report.' });
  }
}

// GET /api/admin/security-credentials — admin-only. Returns the SAFE status of
// every server-side OAuth credential in public.security_credentials (Payment
// Gmail + Google Drive). NEVER returns any refresh token / encrypted blob /
// access token / client secret / encryption key.
router.get('/security-credentials', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const paymentEmail = paymentMailbox.expectedMailbox() || 'rupayandas2025@gmail.com';
    const driveEmail = googleDrive.expectedDriveEmail();

    const [payment, drive] = await Promise.all([
      securityStore.getSafeStatus(securityStore.SERVICES.PAYMENT_GMAIL, paymentEmail),
      securityStore.getSafeStatus(securityStore.SERVICES.GOOGLE_DRIVE, driveEmail),
    ]);

    // Probe Drive folder reachability using the stored (or env-fallback) token.
    // This is best-effort and never blocks the status response; failures just
    // mark the folders as inaccessible with a safe reason.
    let driveFolders = [];
    try { driveFolders = await googleDrive.probeKnownFoldersWithTokens(); }
    catch (_) { driveFolders = []; }

    // Shape each into the documented safe payload (no secrets).
    const shape = (s, service, fallbackEmail, configured) => ({
      service,
      email: (s && s.email) || fallbackEmail,
      status: s && s.exists ? s.status : 'not_connected',
      connected: Boolean(s && s.connected),
      exists: Boolean(s && s.exists),
      connectedAt: (s && s.connectedAt) || null,
      authorizedAt: (s && s.authorizedAt) || null,
      estimatedExpiresAt: (s && s.estimatedExpiresAt) || null,
      lastVerifiedAt: (s && s.lastVerifiedAt) || null,
      lastUsedAt: (s && s.lastUsedAt) || null,
      lastError: (s && s.lastError) || null,
      warning: (s && s.warning) || null,
      configured,
    });

    res.json({
      supabaseReady: securityStore.isReady(),
      credentials: [
        shape(payment, securityStore.SERVICES.PAYMENT_GMAIL, paymentEmail, paymentMailbox.isOAuthConfigured()),
        shape(drive, securityStore.SERVICES.GOOGLE_DRIVE, driveEmail, googleDrive.isOAuthConfigured()),
      ],
      driveFolders,
    });
  } catch (err) {
    console.error('security-credentials status error:', err.message);
    res.status(500).json({ error: 'Failed to load security credentials.' });
  }
});

// GET|POST /api/admin/drive/keepalive — refresh the Drive OAuth token so
// Google's six-month inactivity rule never invalidates it. vercel.json calls
// this on the 1st of every month.
//
// Why a cron at all: Google expires a refresh token that has not been used to
// mint an access token for six months. Normal operation refreshes it on every
// upload, so this only matters when the marketplace goes quiet — which is
// exactly the case nobody notices until a seller hits an upload error.
//
// Same auth contract as the monthly report run: Vercel Cron presents
// `Authorization: Bearer <CRON_SECRET>`, the older `x-cron-key` header still
// works for other schedulers, and an admin session is accepted as a fallback.
router.all('/drive/keepalive', async (req, res, next) => {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
  if (cronSecretMatches(req)) return handleDriveKeepAlive(req, res);
  return authenticateToken(req, res, () => requireAdmin(req, res, () => handleDriveKeepAlive(req, res)));
});

async function handleDriveKeepAlive(req, res) {
  try {
    const result = await googleDrive.keepAlive();

    // A dead token is a configuration problem, not a server fault. Report it
    // as 200 with ok:false and log the real reason loudly, so the cron output
    // says "token revoked" instead of a generic 5xx.
    if (!result.ok) {
      console.error(
        `[drive/keepalive] refresh FAILED${result.code ? ' (' + result.code + ')' : ''}: ${result.reason} ` +
        'Re-authorize with `cd server && node scripts/authorize-drive.js`.'
      );
    }

    res.json({
      ok: result.ok,
      configured: result.configured,
      mode: result.mode,
      skipped: result.skipped || '',
      refreshed: !!result.refreshed,
      reason: result.reason || '',
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Drive keepalive error:', err);
    res.status(500).json({ error: 'Keepalive failed.' });
  }
}
// ════════════════════════════════════════════════════════════════════════
// RATE LIMITING STATUS
// ════════════════════════════════════════════════════════════════════════
// GET /api/admin/rate-limits — which limiters are live and whether the shared
// Redis counters are actually connected.
//
// This exists so an operator can answer "are we distributed right now?" without
// reading logs or guessing. It reports configuration only: limiter names,
// their budgets and each one's behaviour when Redis is unavailable. It NEVER
// returns the Redis URL, the token, a counter value or any caller identifier.
router.get('/rate-limits', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const rateLimitService = require('../services/rateLimitService');
    res.json(rateLimitService.describe());
  } catch (err) {
    console.error('Rate-limit status error:', err.message);
    res.status(500).json({ error: 'Failed to load rate-limit status.' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// MAINTENANCE MODE
// ════════════════════════════════════════════════════════════════════════
// GET /api/admin/maintenance — Get current maintenance mode status
router.get('/maintenance', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = await supabase.getMaintenanceMode();
    res.json(status);
  } catch (err) {
    console.error('Admin get maintenance status error:', err);
    res.status(500).json({ error: 'Failed to fetch maintenance status.' });
  }
});

// PUT /api/admin/maintenance — Toggle maintenance mode ON/OFF
router.put('/maintenance', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const { enabled, message } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'The "enabled" field must be a boolean (true/false).' });
    }

    const adminEmail = (req.user && req.user.email) || 'unknown';
    const result = await supabase.setMaintenanceMode(enabled, message || '', adminEmail);

    const action = enabled ? 'enabled' : 'disabled';
    console.log(`[Maintenance] Mode ${action} by ${adminEmail}`);

    res.json({
      message: enabled
        ? 'Maintenance mode enabled. Normal users are now restricted.'
        : 'Maintenance mode disabled. Website is live for all users.',
      ...result,
    });
  } catch (err) {
    console.error('Admin update maintenance status error:', err);
    res.status(500).json({ error: 'Failed to update maintenance mode.' });
  }
});

// GET /api/admin/maintenance/whitelist — List emails that bypass maintenance
router.get('/maintenance/whitelist', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const emails = await supabase.getMaintenanceWhitelist();
    res.json({ emails });
  } catch (err) {
    console.error('Admin get maintenance whitelist error:', err);
    res.status(500).json({ error: 'Failed to fetch the maintenance whitelist.' });
  }
});

// PUT /api/admin/maintenance/whitelist — Replace the whitelist.
// Body: { emails: [ 'user@example.com', ... ] } — the full replacement list;
// sending [] clears it. Emails are normalised server-side.
router.put('/maintenance/whitelist', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const { emails } = req.body || {};
    if (!Array.isArray(emails)) {
      return res.status(400).json({ error: 'The "emails" field must be an array of email addresses.' });
    }
    if (emails.length > 500) {
      return res.status(400).json({ error: 'The whitelist is limited to 500 email addresses.' });
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const raw of emails) {
      const email = String(raw || '').toLowerCase().trim();
      if (!email || email.length > 254 || !emailPattern.test(email)) {
        return res.status(400).json({ error: `"${raw}" is not a valid email address.` });
      }
    }

    const adminEmail = (req.user && req.user.email) || 'unknown';
    const result = await supabase.setMaintenanceWhitelist(emails, adminEmail);

    console.log(`[Maintenance] Whitelist updated (${result.emails.length} email(s)) by ${adminEmail}`);
    res.json({
      message: `Whitelist saved — ${result.emails.length} whitelisted user(s) can browse the site during maintenance.`,
      ...result,
    });
  } catch (err) {
    console.error('Admin update maintenance whitelist error:', err);
    res.status(500).json({ error: 'Failed to update the maintenance whitelist.' });
  }
});

module.exports = router;
