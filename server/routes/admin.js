// ============================================
// SaveHatke — Admin Routes
// ============================================

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireAdmin, generateToken } = require('../middleware/auth');
const db = require('../services/googleSheets');

const router = express.Router();

const Admin = require('../models/Admin');

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

// POST /api/admin/create-admin — Create new Admin/Super Admin in MongoDB
router.post('/create-admin', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { full_name, email, password, role, phone, profile_image } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'Full name, email, and password are required.' });
    }

    const existing = await Admin.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ error: 'An admin with this email already exists.' });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const newAdmin = await Admin.create({
      id: uuidv4(),
      full_name: full_name.trim(),
      email: email.toLowerCase().trim(),
      password_hash,
      role: role === 'Super Admin' ? 'Super Admin' : 'Admin',
      phone: phone || '',
      profile_image: profile_image || '',
      is_active: true,
      email_verified: true,
      two_factor_enabled: false,
    });

    res.status(201).json({
      message: 'Admin account created successfully in MongoDB.',
      admin: {
        id: newAdmin.id,
        full_name: newAdmin.full_name,
        email: newAdmin.email,
        role: newAdmin.role,
        phone: newAdmin.phone,
        is_active: newAdmin.is_active,
        created_at: newAdmin.created_at,
      },
    });
  } catch (err) {
    console.error('Create admin error:', err);
    res.status(500).json({ error: 'Failed to create admin.' });
  }
});

// GET /api/admin/list-admins — List all admins stored in MongoDB
router.get('/list-admins', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const admins = await Admin.find().select('-password_hash').sort({ created_at: -1 });
    res.json({ admins, total: admins.length });
  } catch (err) {
    console.error('List admins error:', err);
    res.status(500).json({ error: 'Failed to fetch admins list.' });
  }
});

// GET /api/admin/stats — Dashboard statistics
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const totalUsers = await db.countRows(db.SHEETS.USERS);
    const allCoupons = await db.getRows(db.SHEETS.COUPONS);

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
    const { code, category, brand, description, originalValue, sellingPrice } = req.body;

    if (!code || !category || !brand) {
      return res.status(400).json({ error: 'Code, category, and brand are required.' });
    }

    // Check for duplicate
    const existing = await db.findRow(db.SHEETS.COUPONS, 'code', code.toUpperCase());
    if (existing) {
      return res.status(409).json({ error: 'This coupon code already exists.' });
    }

    const coupon = {
      id: uuidv4(),
      code: code.toUpperCase().trim(),
      category: category.trim(),
      brand: brand.trim(),
      description: description || '',
      originalValue: originalValue || '0',
      sellingPrice: sellingPrice || '20',
      sellerEmail: '',
      status: 'available', // Admin coupons are immediately available
      source: 'admin',
      addedAt: new Date().toISOString(),
      soldAt: '',
      buyerEmail: '',
    };

    await db.appendRow(db.SHEETS.COUPONS, coupon);

    res.status(201).json({
      message: 'Coupon added successfully and is now live for sale.',
      coupon,
    });
  } catch (err) {
    console.error('Admin add coupon error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/admin/coupons — View all coupons with filters
router.get('/coupons', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let coupons = await db.getRows(db.SHEETS.COUPONS);

    const { status, source, category } = req.query;
    if (status) coupons = coupons.filter((c) => c.status === status);
    if (source) coupons = coupons.filter((c) => c.source === source);
    if (category) coupons = coupons.filter((c) => c.category.toLowerCase() === category.toLowerCase());

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

    const coupon = await db.findRow(db.SHEETS.COUPONS, 'id', id);
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }

    // Only allow updating specific fields
    const allowedFields = ['code', 'category', 'brand', 'description', 'originalValue', 'sellingPrice', 'status'];
    const sanitized = {};
    for (const key of allowedFields) {
      if (updates[key] !== undefined) {
        sanitized[key] = updates[key];
      }
    }

    const updated = await db.updateRow(db.SHEETS.COUPONS, 'id', id, sanitized);

    res.json({ message: 'Coupon updated successfully.', coupon: updated });
  } catch (err) {
    console.error('Admin update coupon error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/admin/coupons/:id — Delete a coupon
router.delete('/coupons/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const coupon = await db.findRow(db.SHEETS.COUPONS, 'id', id);
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }

    await db.deleteRow(db.SHEETS.COUPONS, 'id', id);
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
