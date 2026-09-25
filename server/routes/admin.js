// ============================================
// SaveHatke — Admin Routes
// ============================================

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireAdmin, generateToken } = require('../middleware/auth');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');
const twilioWhatsApp = require('../services/twilioWhatsApp');
const emailService = require('../services/emailService');
const monthlyReports = require('../services/monthlyReports');
const googleDrive = require('../services/googleDrive');
const securityStore = require('../services/securityCredentialsStore');
const paymentMailbox = require('../services/paymentMailbox');
// Payout withholding and the seller status vocabulary live with the Payouts tab,
// so the invalidate action below reuses them instead of restating the rules.
const payouts = require('./payouts');
// The single seller-payout formula (7% of face value, rounded to the paise).
// Admin writes never trust a client-supplied payout — it is always derived here.
const { calculateSellerPayout, couponPayoutInfo } = require('../services/sellerPayout');

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
  const info = couponPayoutInfo(coupon);
  return {
    ...info,
    sellerPayout: info.payoutEligible ? info.sellerPayout : null,
    sellerPayoutStored: coupon && coupon.sellerPayout !== undefined ? coupon.sellerPayout : null,
    payoutStatus: payout ? String(payout.status || 'pending') : '',
    payoutAmount: payout ? Number(payout.amount || 0) : null,
  };
}

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://savehatke.com').replace(/\/$/, '');

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

// Admin sign-in is passwordless: admins authenticate with Google on the main
// login page (POST /api/auth/google-redirect verifies the Google identity and
// grants the admin session) or with a backup code through the SOS flow
// (routes/sos.js). The old password-based admin login endpoint was removed
// together with the rest of the password logic.

// POST /api/admin/create-admin — Create new Admin/Super Admin/Support in MongoDB
router.post('/create-admin', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, full_name, email, role, phone, profile_image } = req.body;
    const adminName = (name || full_name || '').trim();

    if (!email || !adminName) {
      return res.status(400).json({ error: 'Name and email are required.' });
    }

    const validRoles = ['Super Admin', 'Admin', 'Support'];
    const assignedRole = validRoles.includes(role) ? role : 'Admin';

    const existing = await Admin.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ error: 'An admin with this email already exists in MongoDB Atlas.' });
    }

    const newAdmin = await Admin.create({
      id: uuidv4(),
      name: adminName,
      email: email.toLowerCase().trim(),
      role: assignedRole,
      phone: phone || '',
      profile_image: profile_image || '',
      is_active: true,
      email_verified: true,
      two_factor_enabled: false,
    });

    res.status(201).json({
      message: 'Admin account created successfully in MongoDB Atlas.',
      admin: {
        id: newAdmin.id,
        name: newAdmin.name,
        email: newAdmin.email,
        role: newAdmin.role,
        phone: newAdmin.phone,
        profile_image: newAdmin.profile_image,
        is_active: newAdmin.is_active,
        created_at: newAdmin.created_at,
        updated_at: newAdmin.updated_at,
      },
    });
  } catch (err) {
    console.error('Create admin error:', err);
    res.status(500).json({ error: 'Failed to create admin in MongoDB Atlas.' });
  }
});

// GET /api/admin/list-admins — List all admins stored in MongoDB Atlas (with fallback)
// The response carries `source` so the admin panel can say *why* Phone / Last Login /
// Joined are blank instead of looking like a broken table: 'mongodb' means the rows
// are real, 'fallback' means Atlas was unreachable and these are the built-in owners.
const FALLBACK_ADMINS = () => [
  { id: '1', name: 'Rupayan', email: 'rupayandas2024@gmail.com', role: 'Super Admin', is_active: true, phone: '', created_at: null, last_login: null },
  { id: '2', name: 'Jaggik', email: 'jaggik8888@gmail.com', role: 'Super Admin', is_active: true, phone: '', created_at: null, last_login: null },
];

router.get('/list-admins', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let admins = [];
    if (mongoose.connection.readyState === 1) {
      admins = await Admin.find().sort({ created_at: -1 });
    }
    if (!admins || admins.length === 0) {
      admins = FALLBACK_ADMINS();
      return res.json({ admins, total: admins.length, source: 'fallback' });
    }
    res.json({ admins, total: admins.length, source: 'mongodb' });
  } catch (err) {
    console.error('List admins error:', err);
    const admins = FALLBACK_ADMINS();
    res.json({ admins, total: admins.length, source: 'fallback' });
  }
});

// PUT /api/admin/update-admin/:id — Update admin details in MongoDB Atlas
router.put('/update-admin/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, full_name, role, phone, profile_image, is_active } = req.body;

    const admin = await Admin.findOne({ $or: [{ id }, { _id: id }] });
    if (!admin) {
      return res.status(404).json({ error: 'Admin record not found.' });
    }

    if (name || full_name) admin.name = (name || full_name).trim();
    if (role && ['Super Admin', 'Admin', 'Support'].includes(role)) admin.role = role;
    if (phone !== undefined) admin.phone = phone.trim();
    if (profile_image !== undefined) admin.profile_image = profile_image.trim();
    if (is_active !== undefined) admin.is_active = Boolean(is_active);

    await admin.save();

    res.json({
      message: 'Admin updated successfully in MongoDB Atlas.',
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        phone: admin.phone,
        profile_image: admin.profile_image,
        is_active: admin.is_active,
        last_login: admin.last_login,
        created_at: admin.created_at,
        updated_at: admin.updated_at,
      },
    });
  } catch (err) {
    console.error('Update admin error:', err);
    res.status(500).json({ error: 'Failed to update admin details.' });
  }
});

// DELETE /api/admin/delete-admin/:id — Delete admin record from MongoDB Atlas
router.delete('/delete-admin/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const admin = await Admin.findOne({ $or: [{ id }, { _id: id }] });
    if (!admin) {
      return res.status(404).json({ error: 'Admin record not found.' });
    }

    await admin.deleteOne();
    res.json({ message: 'Admin deleted successfully from MongoDB Atlas.' });
  } catch (err) {
    console.error('Delete admin error:', err);
    res.status(500).json({ error: 'Failed to delete admin.' });
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
router.post('/coupons', authenticateToken, requireAdmin, async (req, res) => {
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
    const sellerEmail = req.user?.email || 'admin@savehatke.com';

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

    res.status(201).json({
      message: created
        ? 'Coupon published successfully! 🎟️'
        : 'Coupon published successfully to Google Sheets! 📊',
      coupon: created || saved || coupon,
    });
  } catch (err) {
    console.error('Admin add coupon error:', err);
    res.status(500).json({ error: 'Failed to save coupon: ' + err.message });
  }
});

// GET /api/admin/coupons — View all coupons with filters
router.get('/coupons', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status, source, category } = req.query;

    // Coupons live in two stores. A user submission writes to Supabase first and
    // then mirrors into the Coupons sheet, but the Supabase insert is
    // best-effort — when it fails, the submission exists only in the sheet.
    //
    // This list used to read Supabase and fall back to the sheet only when
    // Supabase returned nothing, so a sheet-only submission was invisible in
    // Coupon Management as soon as Supabase held even one row. Both stores are
    // merged now, so a pending coupon shows up wherever it managed to land.
    let supaCoupons = [];
    if (supabase.isConfigured()) {
      try {
        supaCoupons = await supabase.getCoupons({ status, source, category });
      } catch (e) {
        console.warn('[admin/coupons] Supabase read failed:', e.message);
      }
    }

    let sheetCoupons = [];
    try {
      sheetCoupons = await db.getRows(db.SHEETS.COUPONS);
    } catch (e) {
      console.warn('[admin/coupons] Sheets read failed:', e.message);
    }
    if (status) sheetCoupons = sheetCoupons.filter((c) => String(c.status || '') === status);
    if (source) sheetCoupons = sheetCoupons.filter((c) => String(c.source || '') === source);
    if (category) {
      sheetCoupons = sheetCoupons.filter(
        (c) => String(c.category || '').toLowerCase() === String(category).toLowerCase(),
      );
    }

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

    // Attach the derived payout info and the payout's current status (joined
    // from the existing Payouts tab by sourceCouponId) to every coupon.
    const payoutMap = await payoutsByCouponId();
    const withPayout = merged.map((c) => payoutSummary(c, payoutMap.get(String(c.id)) || null));

    res.json({ coupons: withPayout, total: withPayout.length });
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
router.put('/coupons/:id', authenticateToken, requireAdmin, async (req, res) => {
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
      'terms', 'status', 'onSale', 'timerOn', 'backgroundImage', 'isFeatured',
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

    res.json({ message: 'Coupon updated successfully.', coupon: updated || { id, ...updates } });
  } catch (err) {
    console.error('Admin update coupon error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/admin/coupons/:id — Delete a coupon
router.delete('/coupons/:id', authenticateToken, requireAdmin, async (req, res) => {
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
router.post('/coupons/:id/review-action', authenticateToken, requireAdmin, async (req, res) => {
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
router.post('/coupons/:id/invalidate', authenticateToken, requireAdmin, async (req, res) => {
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
router.post('/coupons/:id/notify-retry', authenticateToken, requireAdmin, async (req, res) => {
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

// PUT /api/admin/users/status — Suspend or reactivate a user in the sheet
router.put('/users/status', authenticateToken, requireAdmin, async (req, res) => {
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
      return res.status(503).json({ error: 'Supabase is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.' });
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
      return res.status(503).json({ error: 'Supabase is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.' });
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
router.post('/sessions/backfill-userids', authenticateToken, requireAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Backfill failed.', detail: err.message });
  }
});

// PUT /api/admin/sessions/:sessionId/terminate — Force-end an active session
router.put('/sessions/:sessionId/terminate', authenticateToken, requireAdmin, async (req, res) => {
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
router.put('/support-cases/:id/status', authenticateToken, requireAdmin, async (req, res) => {
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
router.put('/settings', authenticateToken, requireAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Failed to update settings: ' + err.message });
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
      autoRun = { generated: false, error: err.message };
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
router.post('/reports/monthly/:month/resend', authenticateToken, requireAdmin, async (req, res) => {
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
    res.status(500).json({ error: err.message || 'Failed to re-send the report.' });
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
    res.status(500).json({ error: err.message || 'Failed to generate the report.' });
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
    res.status(500).json({ error: err.message || 'Keepalive failed.' });
  }
}
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
router.put('/maintenance', authenticateToken, requireAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Failed to update maintenance mode: ' + err.message });
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
router.put('/maintenance/whitelist', authenticateToken, requireAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Failed to update the maintenance whitelist: ' + err.message });
  }
});

module.exports = router;
