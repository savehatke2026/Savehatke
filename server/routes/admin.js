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

const router = express.Router();

const Admin = require('../models/Admin');

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

// GET /api/admin/list-admins — List all admins stored in MongoDB Atlas
router.get('/list-admins', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const admins = await Admin.find().select('-password_hash').sort({ created_at: -1 });
    res.json({ admins, total: admins.length });
  } catch (err) {
    console.error('List admins error:', err);
    res.status(500).json({ error: 'Failed to fetch admins list from MongoDB Atlas.' });
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
    const totalUsers = await db.countRows(db.SHEETS.USERS);
    let allCoupons = [];
    if (supabase.isConfigured()) {
      allCoupons = await supabase.getCoupons();
    }
    if (allCoupons.length === 0) {
      allCoupons = await db.getRows(db.SHEETS.COUPONS);
    }

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

    const totalTracked = await db.countRows(db.SHEETS.PRICE_TRACKING);
    const totalTickets = await db.countRows(db.SHEETS.SUPPORT_TICKETS);

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
    res.status(500).json({ error: 'Internal server error.' });
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

// GET /api/admin/users — List all users
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await db.getRows(db.SHEETS.USERS);
    res.json({
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        createdAt: u.createdAt,
      })),
      total: users.length,
    });
  } catch (err) {
    console.error('Admin list users error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
