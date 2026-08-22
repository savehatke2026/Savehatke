// ============================================
// SaveHatke — Admin Routes
// ============================================

const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireAdmin, generateToken } = require('../middleware/auth');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');
const twilioWhatsApp = require('../services/twilioWhatsApp');

const router = express.Router();

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

// POST /api/admin/login — Admin login (MongoDB backed)
router.post('/login', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const loginIdentifier = (email || username || '').toLowerCase().trim();

    if (!loginIdentifier || !password) {
      return res.status(400).json({ error: 'Email/Username and password are required.' });
    }

    let authenticatedAdmin = null;

    // 1. Check MongoDB Admin collection by email or username
    try {
      const dbAdmin = await Admin.findOne({
        $or: [
          { email: loginIdentifier },
          { email: { $regex: `^${loginIdentifier}@` } },
        ],
      });

      if (dbAdmin) {
        if (!dbAdmin.is_active) {
          return res.status(403).json({ error: 'This admin account is currently deactivated.' });
        }

        const isMatch = await bcrypt.compare(password, dbAdmin.password_hash);
        if (isMatch) {
          // Update last_login timestamp
          dbAdmin.last_login = new Date();
          await dbAdmin.save();

          authenticatedAdmin = {
            id: dbAdmin.id || dbAdmin._id.toString(),
            full_name: dbAdmin.full_name,
            email: dbAdmin.email,
            role: dbAdmin.role,
            phone: dbAdmin.phone,
            profile_image: dbAdmin.profile_image,
            is_active: dbAdmin.is_active,
            email_verified: dbAdmin.email_verified,
            two_factor_enabled: dbAdmin.two_factor_enabled,
            last_login: dbAdmin.last_login,
            created_at: dbAdmin.created_at,
          };
        }
      }
    } catch (e) {
      console.warn('MongoDB Admin lookup error, checking env fallback:', e.message);
    }

    // 2. Fallback to admin credentials if DB match not found
    if (!authenticatedAdmin) {
      if ((loginIdentifier === 'jaggik8888@gmail.com' || loginIdentifier === 'jaggik') && password === 'Jaggik') {
        authenticatedAdmin = {
          id: uuidv4(),
          full_name: 'Jaggik',
          email: 'jaggik8888@gmail.com',
          role: 'Super Admin',
          is_active: true,
          email_verified: true,
          two_factor_enabled: false,
          last_login: new Date(),
        };
      } else if ((loginIdentifier === 'rupayandas2024@gmail.com' || loginIdentifier === 'rupayan') && password === 'Rupayan') {
        authenticatedAdmin = {
          id: uuidv4(),
          full_name: 'Rupayan',
          email: 'rupayandas2024@gmail.com',
          role: 'Super Admin',
          is_active: true,
          email_verified: true,
          two_factor_enabled: false,
          last_login: new Date(),
        };
      }
    }

    if (!authenticatedAdmin) {
      return res.status(401).json({ error: 'Invalid admin credentials.' });
    }

    const token = generateToken({
      id: authenticatedAdmin.id,
      email: authenticatedAdmin.email,
      name: authenticatedAdmin.full_name,
      role: 'admin',
    }, '12h');

    res.json({
      message: 'Admin login successful.',
      token,
      user: authenticatedAdmin,
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/admin/create-admin — Create new Admin/Super Admin/Support in MongoDB
router.post('/create-admin', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, full_name, email, password, role, phone, profile_image } = req.body;
    const adminName = (name || full_name || '').trim();

    if (!email || !password || !adminName) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }

    const validRoles = ['Super Admin', 'Admin', 'Support'];
    const assignedRole = validRoles.includes(role) ? role : 'Admin';

    const existing = await Admin.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ error: 'An admin with this email already exists in MongoDB Atlas.' });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const newAdmin = await Admin.create({
      id: uuidv4(),
      name: adminName,
      email: email.toLowerCase().trim(),
      password_hash,
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
router.get('/list-admins', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let admins = [];
    if (mongoose.connection.readyState === 1) {
      admins = await Admin.find().select('-password_hash').sort({ created_at: -1 });
    }
    if (!admins || admins.length === 0) {
      admins = [
        { id: '1', name: 'Rupayan', email: 'rupayandas2024@gmail.com', role: 'Super Admin', is_active: true },
        { id: '2', name: 'Jaggik', email: 'jaggik8888@gmail.com', role: 'Super Admin', is_active: true }
      ];
    }
    res.json({ admins, total: admins.length });
  } catch (err) {
    console.error('List admins error:', err);
    res.json({
      admins: [
        { id: '1', name: 'Rupayan', email: 'rupayandas2024@gmail.com', role: 'Super Admin', is_active: true },
        { id: '2', name: 'Jaggik', email: 'jaggik8888@gmail.com', role: 'Super Admin', is_active: true }
      ],
      total: 2
    });
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

// GET /api/admin/stats — Dashboard statistics
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
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

    // Calculate costs (₹10 per user-submitted sold coupon)
    const costs = allCoupons
      .filter((c) => c.status === 'sold' && c.source === 'user-submitted')
      .length * 10;

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
      originalValue,
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
    } = req.body;

    if (!code || !brand) {
      return res.status(400).json({ error: 'Coupon code and brand are required.' });
    }

    const cleanCode = code.toUpperCase().trim();
    const sellerEmail = req.user?.email || 'admin@savehatke.com';

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
      id: uuidv4(),
      code: cleanCode,
      title: title ? title.trim() : '',
      type: type ? type.trim() : 'Public',
      category: category ? category.trim() : 'General',
      brand: brand.trim(),
      description: title || description || discount || '',
      discount: discount ? discount.trim() : '',
      originalValue: originalValue || discount || '0',
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
      addedAt: new Date().toISOString(),
      soldAt: '',
      buyerEmail: '',
    };

    // Save coupon EXCLUSIVELY to Google Sheets (Coupons tab)
    const saved = await db.appendRow(db.SHEETS.COUPONS, coupon);

    // Dual-sync to Supabase as backup if configured
    if (supabase.isConfigured()) {
      try {
        await supabase.createCoupon(coupon);
      } catch (err) {
        console.warn('Supabase backup createCoupon notice:', err.message);
      }
    }

    res.status(201).json({
      message: 'Coupon published successfully to Google Sheets! 📊',
      coupon: saved || coupon,
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
    let coupons = [];

    if (supabase.isConfigured()) {
      try {
        coupons = await supabase.getCoupons({ status, source, category });
      } catch (e) {}
    }

    if (coupons.length === 0) {
      coupons = await db.getRows(db.SHEETS.COUPONS);
      if (status) coupons = coupons.filter((c) => c.status === status);
      if (source) coupons = coupons.filter((c) => c.source === source);
      if (category) coupons = coupons.filter((c) => c.category.toLowerCase() === category.toLowerCase());
    }

    res.json({ coupons, total: coupons.length });
  } catch (err) {
    console.error('Admin list coupons error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/admin/coupons/:id — Update coupon (approve/edit)
router.put('/coupons/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    let updated = null;
    if (supabase.isConfigured()) {
      try {
        updated = await supabase.updateCoupon(id, updates);
      } catch (e) {}
    }

    try {
      const gUpdated = await db.updateRow(db.SHEETS.COUPONS, 'id', id, updates);
      if (!updated) updated = gUpdated;
    } catch (e) {}

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

    res.json({
      coupon,
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
    if (action === 'approve') {
      updates.isVerified = true;
      updates.verifiedAt = now;
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
    const users = await db.getRows(db.SHEETS.USERS);
    const list = users.map((u) => ({
      id: u.user_id || u.id || '',
      name: u.name || u.username || String(u.email || '').split('@')[0] || 'Unknown',
      username: u.username || '',
      email: u.email || '',
      status: String(u.status || 'active').toLowerCase().trim(),
      createdAt: u.created_at || u.createdAt || '',
      lastLoginAt: u.last_login_at || '',
      lastLogoutAt: u.last_logout_at || '',
    }));
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

    let existing = await db.findRow(db.SHEETS.USERS, 'user_id', userId);
    if (!existing) existing = await db.findRow(db.SHEETS.USERS, 'id', userId);
    if (!existing) return res.status(404).json({ error: 'User not found.' });

    const now = new Date().toISOString();
    await db.updateRow(db.SHEETS.USERS, 'user_id', userId, { status, updated_at: now });
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

    const sessions = await supabase.getAllSessions();

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

    const sessions = await supabase.getAdminSessions();

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
          .from('sessions')
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
    const { status } = req.body;
    const id = req.params.id;
    if (!id || !['open', 'inprogress', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'A status of open/inprogress/resolved/closed is required.' });
    }

    const existing = await db.findRow(db.SHEETS.SUPPORT_TICKETS, 'id', id);
    if (!existing) return res.status(404).json({ error: 'Support case not found.' });

    const now = new Date().toISOString();
    const resolvedAt = (status === 'resolved' || status === 'closed') ? (existing.resolvedAt || now) : '';
    await db.updateRow(db.SHEETS.SUPPORT_TICKETS, 'id', id, { status, resolvedAt });
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
            heroBadge: mongoSetting.heroBadge || settings.heroBadge,
            showHeroBadge: mongoSetting.showHeroBadge !== undefined ? mongoSetting.showHeroBadge : settings.showHeroBadge,
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
        heroBadge: "🚀 India's #1 Coupon Marketplace — Now Live!",
        showHeroBadge: true,
      },
    });
  }
});

// PUT /api/admin/settings — Update system settings (saved to Google Sheets & MongoDB)
router.put('/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { activeUsers, couponsTraded, savedByUsers, platformName, adminEmail, showActiveUsers, showCouponsTraded, showSavedByUsers, heroBadge, showHeroBadge } = req.body;

    const payload = {
      activeUsers: activeUsers ? String(activeUsers).trim() : '10K+',
      couponsTraded: couponsTraded ? String(couponsTraded).trim() : '50K+',
      savedByUsers: savedByUsers ? String(savedByUsers).trim() : '₹2L+',
      platformName: platformName ? String(platformName).trim() : 'SaveHatke',
      adminEmail: adminEmail ? String(adminEmail).trim() : 'rupayandas2024@gmail.com',
      showActiveUsers: showActiveUsers !== undefined ? Boolean(showActiveUsers) : true,
      showCouponsTraded: showCouponsTraded !== undefined ? Boolean(showCouponsTraded) : true,
      showSavedByUsers: showSavedByUsers !== undefined ? Boolean(showSavedByUsers) : true,
      heroBadge: heroBadge !== undefined ? String(heroBadge).trim().slice(0, 120) : "🚀 India's #1 Coupon Marketplace — Now Live!",
      showHeroBadge: showHeroBadge !== undefined ? Boolean(showHeroBadge) : true,
    };

    // 1. Save to Google Sheets / memoryDB
    const savedSheet = await db.saveSettings(payload);

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

module.exports = router;
