// ============================================
// SaveHatke — Coupon Marketplace Routes
// ============================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');

const router = express.Router();

// GET /api/coupons — List available coupons (public, with optional auth)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { category, search, source } = req.query;
    let available = [];

    // Primary source: Supabase database
    if (supabase.isConfigured()) {
      try {
        const supaCoupons = await supabase.getCoupons({ status: 'available' });
        if (Array.isArray(supaCoupons)) {
          available = supaCoupons;
        }
      } catch (e) {
        console.warn('Supabase coupons read notice:', e.message);
      }
    }

    // Also include Google Sheets coupons (merging without duplicates)
    try {
      const gsheetCoupons = await db.getRows(db.SHEETS.COUPONS);
      const availableGsheet = gsheetCoupons.filter((c) => c.status === 'available');
      availableGsheet.forEach((gc) => {
        if (!available.some((sc) => sc.id === gc.id || (sc.code && gc.code && sc.code === gc.code))) {
          available.push(gc);
        }
      });
    } catch (e) {
      console.warn('G Sheet coupons read notice:', e.message);
    }

    // Apply filters
    if (category && category !== 'all') {
      available = available.filter((c) => (c.category || '').toLowerCase() === category.toLowerCase());
    }
    if (source) {
      available = available.filter((c) => c.source === source);
    }

    if (search) {
      const q = search.toLowerCase();
      available = available.filter(
        (c) => c.brand.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
      );
    }

    // Don't expose actual coupon codes to non-buyers
    const sanitized = available.map((c) => ({
      id: c.id,
      category: c.category,
      brand: c.brand,
      title: c.title || '',
      description: c.description,
      discount: c.discount || '',
      originalValue: c.originalValue,
      sellingPrice: c.sellingPrice,
      source: c.source,
      addedAt: c.addedAt,
    }));

    res.json({ coupons: sanitized, total: sanitized.length });
  } catch (err) {
    console.error('List coupons error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/coupons/categories — Get available categories with counts
router.get('/categories', async (req, res) => {
  try {
    let available = [];
    if (supabase.isConfigured()) {
      try {
        available = await supabase.getCoupons({ status: 'available' });
      } catch (e) {}
    }

    if (available.length === 0) {
      const allCoupons = await db.getRows(db.SHEETS.COUPONS);
      available = allCoupons.filter((c) => c.status === 'available');
    }

    const categories = {};
    available.forEach((c) => {
      categories[c.category] = (categories[c.category] || 0) + 1;
    });

    res.json({ categories });
  } catch (err) {
    console.error('Categories error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/coupons/sell & /api/coupons/submit — Submit a coupon to sell
const handleCouponSubmission = async (req, res) => {
  try {
    const { code, category, brand, description, originalValue, faceValue } = req.body;

    if (!code || !category || !brand) {
      return res.status(400).json({ error: 'Coupon code, category, and brand are required.' });
    }

    const cleanCode = code.toUpperCase().trim();
    const value = faceValue || originalValue || '0';

    // Check for duplicate codes in Supabase & Sheets
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
      return res.status(409).json({ error: 'This coupon code has already been submitted.' });
    }

    const sellerEmail = (req.user && req.user.email) ? req.user.email : 'user@savehatke.com';

    const coupon = {
      id: uuidv4(),
      code: cleanCode,
      category: category.trim(),
      brand: brand.trim(),
      description: description || '',
      originalValue: value.toString(),
      sellingPrice: '20', // Our markup price
      sellerEmail: sellerEmail,
      status: 'pending', // Needs admin approval
      source: 'user-submitted',
      addedAt: new Date().toISOString(),
      soldAt: '',
      buyerEmail: '',
    };

    if (supabase.isConfigured()) {
      try {
        await supabase.createCoupon(coupon);
      } catch (e) {}
    }
    try {
      await db.appendRow(db.SHEETS.COUPONS, coupon);
    } catch (e) {}

    res.status(201).json({
      message: 'Coupon submitted successfully! You will receive ₹10 once it is verified and sold.',
      coupon: {
        id: coupon.id,
        code: coupon.code,
        category: coupon.category,
        brand: coupon.brand,
        status: coupon.status,
        offerAmount: '₹10',
      },
    });
  } catch (err) {
    console.error('Sell coupon error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
};

router.post('/sell', optionalAuth, handleCouponSubmission);
router.post('/submit', optionalAuth, handleCouponSubmission);

// POST /api/coupons/buy/:id — Purchase a coupon (authenticated)
router.post('/buy/:id', authenticateToken, async (req, res) => {
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
    if (coupon.status !== 'available') {
      return res.status(400).json({ error: 'This coupon is no longer available.' });
    }
    if (coupon.sellerEmail === req.user.email) {
      return res.status(400).json({ error: 'You cannot buy your own coupon.' });
    }

    const updates = {
      status: 'sold',
      soldAt: new Date().toISOString(),
      buyerEmail: req.user.email,
    };

    if (supabase.isConfigured()) {
      try {
        await supabase.updateCoupon(id, updates);
      } catch (e) {}
    }
    try {
      await db.updateRow(db.SHEETS.COUPONS, 'id', id, updates);
    } catch (e) {}

    res.json({
      message: 'Coupon purchased successfully!',
      coupon: {
        id: coupon.id,
        code: coupon.code, // Reveal the code to the buyer
        category: coupon.category,
        brand: coupon.brand,
        description: coupon.description,
        originalValue: coupon.originalValue,
        pricePaid: coupon.sellingPrice,
      },
    });
  } catch (err) {
    console.error('Buy coupon error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/coupons/my-sales — User's sold coupons
router.get('/my-sales', authenticateToken, async (req, res) => {
  try {
    let coupons = [];
    if (supabase.isConfigured()) {
      try {
        coupons = await supabase.getCoupons({ sellerEmail: req.user.email });
      } catch (e) {}
    }
    if (coupons.length === 0) {
      coupons = await db.findRows(db.SHEETS.COUPONS, 'sellerEmail', req.user.email);
    }

    res.json({
      coupons: coupons.map((c) => ({
        id: c.id,
        code: c.code,
        category: c.category,
        brand: c.brand,
        status: c.status,
        addedAt: c.addedAt,
        soldAt: c.soldAt,
        earning: c.status === 'sold' ? '₹10' : '—',
      })),
    });
  } catch (err) {
    console.error('My sales error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/coupons/my-purchases — User's purchased coupons
router.get('/my-purchases', authenticateToken, async (req, res) => {
  try {
    let coupons = [];
    if (supabase.isConfigured()) {
      try {
        coupons = await supabase.getCoupons({ buyerEmail: req.user.email });
      } catch (e) {}
    }
    if (coupons.length === 0) {
      coupons = await db.findRows(db.SHEETS.COUPONS, 'buyerEmail', req.user.email);
    }

    res.json({
      coupons: coupons.map((c) => ({
        id: c.id,
        code: c.code,
        category: c.category,
        brand: c.brand,
        description: c.description,
        originalValue: c.originalValue,
        pricePaid: c.sellingPrice,
        purchasedAt: c.soldAt,
      })),
    });
  } catch (err) {
    console.error('My purchases error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
