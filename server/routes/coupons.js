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

// POST /api/coupons/sell & /api/coupons/submit — Submit coupon(s) to sell
// Accepts the multi-coupon format { category, coupons: [{code, brand, description, faceValue}] }
// and the legacy single-coupon format { code, category, brand, ... }.
const handleCouponSubmission = async (req, res) => {
  try {
    const { code, category, brand, description, originalValue, faceValue, coupons } = req.body;

    // Normalize both formats into a list
    let list;
    if (Array.isArray(coupons) && coupons.length > 0) {
      if (!category) {
        return res.status(400).json({ error: 'Category is required.' });
      }
      list = coupons.map((c) => ({
        code: c && c.code,
        category,
        brand: c && c.brand,
        description: (c && c.description) || '',
        faceValue: (c && (c.faceValue || c.originalValue)) || faceValue || originalValue || '0',
      }));
    } else {
      list = [{ code, category, brand, description, faceValue: faceValue || originalValue }];
    }

    const sellerEmail = (req.user && req.user.email) ? req.user.email : 'user@savehatke.com';
    const submitted = [];
    const skipped = [];

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.code || !c.category || !c.brand) {
        skipped.push(`Coupon ${i + 1}: code, category, and brand are required.`);
        continue;
      }

      const cleanCode = String(c.code).toUpperCase().trim();

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
        skipped.push(`Coupon ${i + 1} (${cleanCode}): this code has already been submitted.`);
        continue;
      }

      const coupon = {
        id: uuidv4(),
        code: cleanCode,
        category: String(c.category).trim(),
        brand: String(c.brand).trim(),
        description: c.description || '',
        originalValue: String(c.faceValue || '0'),
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

      submitted.push(coupon);
    }

    if (submitted.length === 0) {
      return res.status(skipped.length ? 409 : 400).json({
        error: skipped[0] || 'No coupons submitted.',
        skipped,
      });
    }

    const offer = `₹${submitted.length * 10}`;
    res.status(201).json({
      message: submitted.length === 1
        ? 'Coupon submitted successfully! You will receive ₹10 once it is verified and sold.'
        : `${submitted.length} coupons submitted successfully! You will receive ${offer} once they are verified and sold.`,
      coupon: {
        id: submitted[0].id,
        code: submitted[0].code,
        category: submitted[0].category,
        brand: submitted[0].brand,
        status: submitted[0].status,
        offerAmount: offer,
      },
      coupons: submitted.map((c) => ({ id: c.id, code: c.code, brand: c.brand, status: c.status })),
      submitted: submitted.length,
      skipped,
      offerAmount: offer,
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
