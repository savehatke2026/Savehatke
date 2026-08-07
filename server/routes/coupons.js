// ============================================
// SaveHatke — Coupon Marketplace Routes
// ============================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const db = require('../services/googleSheets');

const router = express.Router();

// GET /api/coupons — List available coupons (public, with optional auth)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const allCoupons = await db.getRows(db.SHEETS.COUPONS);
    let available = allCoupons.filter((c) => c.status === 'available');

    // Filter by category
    const { category, search, source } = req.query;
    if (category && category !== 'all') {
      available = available.filter((c) => c.category.toLowerCase() === category.toLowerCase());
    }
    if (search) {
      const q = search.toLowerCase();
      available = available.filter(
        (c) => c.brand.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
      );
    }
    if (source) {
      available = available.filter((c) => c.source === source);
    }

    // Don't expose actual coupon codes to non-buyers
    const sanitized = available.map((c) => ({
      id: c.id,
      category: c.category,
      brand: c.brand,
      description: c.description,
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
    const allCoupons = await db.getRows(db.SHEETS.COUPONS);
    const available = allCoupons.filter((c) => c.status === 'available');

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

// POST /api/coupons/sell — Submit a coupon to sell (authenticated)
router.post('/sell', authenticateToken, async (req, res) => {
  try {
    const { code, category, brand, description, originalValue } = req.body;

    if (!code || !category || !brand) {
      return res.status(400).json({ error: 'Coupon code, category, and brand are required.' });
    }

    // Check for duplicate codes
    const existing = await db.findRow(db.SHEETS.COUPONS, 'code', code.toUpperCase());
    if (existing) {
      return res.status(409).json({ error: 'This coupon code has already been submitted.' });
    }

    const coupon = {
      id: uuidv4(),
      code: code.toUpperCase().trim(),
      category: category.trim(),
      brand: brand.trim(),
      description: description || '',
      originalValue: originalValue || '0',
      sellingPrice: '20', // Our markup price
      sellerEmail: req.user.email,
      status: 'pending', // Needs admin approval
      source: 'user-submitted',
      addedAt: new Date().toISOString(),
      soldAt: '',
      buyerEmail: '',
    };

    await db.appendRow(db.SHEETS.COUPONS, coupon);

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
});

// POST /api/coupons/buy/:id — Purchase a coupon (authenticated)
router.post('/buy/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const coupon = await db.findRow(db.SHEETS.COUPONS, 'id', id);
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found.' });
    }
    if (coupon.status !== 'available') {
      return res.status(400).json({ error: 'This coupon is no longer available.' });
    }
    if (coupon.sellerEmail === req.user.email) {
      return res.status(400).json({ error: 'You cannot buy your own coupon.' });
    }

    // Mark as sold
    await db.updateRow(db.SHEETS.COUPONS, 'id', id, {
      status: 'sold',
      soldAt: new Date().toISOString(),
      buyerEmail: req.user.email,
    });

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
    const coupons = await db.findRows(db.SHEETS.COUPONS, 'sellerEmail', req.user.email);
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
    const coupons = await db.findRows(db.SHEETS.COUPONS, 'buyerEmail', req.user.email);
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
