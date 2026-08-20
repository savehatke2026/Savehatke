// ============================================
// SaveHatke — Coupon Marketplace Routes
// ============================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');
const twilioWhatsApp = require('../services/twilioWhatsApp');

const router = express.Router();

// Proof screenshot upload constraints
const PROOF_MAX_BYTES = 3 * 1024 * 1024; // 3MB
const PROOF_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const PROOF_BUCKET = 'coupon-proofs';

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://savehatke.com').replace(/\/$/, '');

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

// POST /api/coupons/proof — Upload a coupon proof screenshot to Supabase Storage (authenticated)
router.post('/proof', authenticateToken, async (req, res) => {
  try {
    const { filename, contentType, dataBase64 } = req.body;

    if (!dataBase64 || !filename) {
      return res.status(400).json({ error: 'filename and dataBase64 are required.' });
    }
    const type = String(contentType || '').toLowerCase().split(';')[0].trim();
    if (!PROOF_ALLOWED_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Unsupported file type. Allowed: PNG, JPG, WEBP.' });
    }

    const buffer = Buffer.from(dataBase64, 'base64');
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: 'File could not be read.' });
    }
    if (buffer.length > PROOF_MAX_BYTES) {
      return res.status(400).json({ error: 'File is too large. Maximum size is 3MB.' });
    }

    const supabaseClient = supabase.getClient();
    if (!supabaseClient) {
      return res.status(503).json({ error: 'Proof uploads are temporarily unavailable.' });
    }

    // Ensure the bucket exists (created once, then reused)
    const buckets = await supabaseClient.storage.listBuckets();
    const exists = (buckets.data || []).some((b) => b.name === PROOF_BUCKET);
    if (!exists) {
      const created = await supabaseClient.storage.createBucket(PROOF_BUCKET, { public: true });
      if (created.error) throw new Error(created.error.message);
    }

    const ext = (String(filename).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const path = `proofs/${uuidv4()}-${safeName || 'proof' + ext}`;

    const upload = await supabaseClient.storage
      .from(PROOF_BUCKET)
      .upload(path, buffer, { contentType: type, upsert: false });
    if (upload.error) throw new Error(upload.error.message);

    const { data: urlData } = supabaseClient.storage.from(PROOF_BUCKET).getPublicUrl(path);
    res.status(201).json({ url: urlData.publicUrl, path, name: filename });
  } catch (err) {
    console.error('Coupon proof upload error:', err);
    res.status(500).json({ error: 'Failed to upload screenshot.' });
  }
});

// POST /api/coupons/sell & /api/coupons/submit — Submit coupon(s) to sell
// Accepts the multi-coupon format { category, coupons: [{code, brand, description, faceValue}] }
// and the legacy single-coupon format { code, category, brand, ... }.
const handleCouponSubmission = async (req, res) => {
  try {
    const {
      code, category, brand, description, originalValue, faceValue, coupons,
      type, sellingPrice, expiryDate, proofUrl,
    } = req.body;

    // Sanitized shared fields (length-capped, never trusted from the client)
    const cleanStr = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
    const cleanCategory = cleanStr(category, 60);
    const cleanType = cleanStr(type, 30) || 'Public';
    const cleanExpiry = cleanStr(expiryDate, 30);
    if (cleanExpiry && isNaN(Date.parse(cleanExpiry))) {
      return res.status(400).json({ error: 'Expiry date is not a valid date.' });
    }

    // Selling price: seller-proposed, server-validated positive number, default ₹20
    let cleanSellingPrice = '20';
    if (sellingPrice !== undefined && sellingPrice !== null && sellingPrice !== '') {
      const priceNum = Number(sellingPrice);
      if (!Number.isFinite(priceNum) || priceNum <= 0 || priceNum > 100000) {
        return res.status(400).json({ error: 'Selling price must be a number between 1 and 100000.' });
      }
      cleanSellingPrice = String(Math.round(priceNum));
    }

    // Only accept proof URLs that point at our own storage
    let safeProofUrl = '';
    if (proofUrl) {
      const supabaseUrl = process.env.SUPABASE_URL || '';
      if (supabaseUrl && String(proofUrl).startsWith(supabaseUrl + '/storage/')) {
        safeProofUrl = String(proofUrl).slice(0, 500);
      }
    }

    // Normalize both formats into a list
    let list;
    if (Array.isArray(coupons) && coupons.length > 0) {
      if (!cleanCategory) {
        return res.status(400).json({ error: 'Category is required.' });
      }
      list = coupons.map((c) => ({
        code: c && c.code,
        category: cleanCategory,
        brand: c && c.brand,
        description: (c && c.description) || '',
        faceValue: (c && (c.faceValue || c.originalValue)) || faceValue || originalValue || '0',
        type: (c && c.type) || type,
        sellingPrice: (c && c.sellingPrice) !== undefined ? c.sellingPrice : sellingPrice,
        expiryDate: (c && c.expiryDate) || expiryDate,
      }));
    } else {
      list = [{ code, category: cleanCategory, brand, description, faceValue: faceValue || originalValue, type, sellingPrice, expiryDate }];
    }

    const sellerEmail = req.user.email;
    const sellerUserId = req.user.id || req.user.user_id || '';
    const submitted = [];
    const skipped = [];
    let dbSaveFailed = false;

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.code || !c.category || !c.brand) {
        skipped.push(`Coupon ${i + 1}: code, category, and brand are required.`);
        continue;
      }

      const cleanCode = String(c.code).toUpperCase().trim().slice(0, 60);
      const cleanBrand = cleanStr(c.brand, 80);
      const cleanDescription = cleanStr(c.description, 500);
      const cleanFaceValue = cleanStr(c.faceValue || '0', 20);

      // Per-coupon overrides for type / selling price / expiry (fall back to shared values)
      const itemType = cleanStr(c.type, 30) || cleanType;
      let itemPrice = cleanSellingPrice;
      if (c.sellingPrice !== undefined && c.sellingPrice !== null && c.sellingPrice !== '') {
        const priceNum = Number(c.sellingPrice);
        if (!Number.isFinite(priceNum) || priceNum <= 0 || priceNum > 100000) {
          return res.status(400).json({ error: `Coupon ${i + 1}: selling price must be a number between 1 and 100000.` });
        }
        itemPrice = String(Math.round(priceNum));
      }
      let itemExpiry = cleanExpiry;
      if (c.expiryDate !== undefined && c.expiryDate !== '') {
        const rawExpiry = cleanStr(c.expiryDate, 30);
        if (rawExpiry && isNaN(Date.parse(rawExpiry))) {
          return res.status(400).json({ error: `Coupon ${i + 1}: expiry date is not a valid date.` });
        }
        itemExpiry = rawExpiry;
      }

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
        category: String(c.category).trim().slice(0, 60),
        brand: cleanBrand,
        title: cleanBrand,
        description: cleanDescription,
        type: itemType,
        originalValue: cleanFaceValue,
        sellingPrice: itemPrice,
        expiryDate: itemExpiry,
        proofUrl: safeProofUrl,
        sellerEmail: sellerEmail,
        sellerUserId: sellerUserId,
        status: 'pending', // Needs admin approval
        source: 'user-submitted',
        isVerified: false,
        addedAt: new Date().toISOString(),
        soldAt: '',
        buyerEmail: '',
        adminNotes: '',
        verifiedAt: '',
        whatsappStatus: 'pending',
        whatsappSid: '',
        whatsappLastAttempt: '',
        whatsappError: '',
      };

      // Persist first — WhatsApp is only sent after a successful DB save
      let saved = false;
      if (supabase.isConfigured()) {
        try {
          await supabase.createCoupon(coupon);
          saved = true;
        } catch (e) {
          console.warn('Supabase coupon save notice:', e.message);
        }
      }
      try {
        await db.appendRow(db.SHEETS.COUPONS, coupon);
        saved = true;
      } catch (e) {
        console.warn('Sheets coupon save notice:', e.message);
      }

      if (!saved) {
        dbSaveFailed = true;
        skipped.push(`Coupon ${i + 1} (${cleanCode}): could not be saved. Please try again.`);
        continue; // No WhatsApp notification when the DB save failed
      }

      // Notify the admin via WhatsApp (failure never deletes/invalidates the coupon)
      const reviewUrl = `${APP_BASE_URL}/admin/coupons/${coupon.id}`;
      const notify = await twilioWhatsApp.sendCouponSubmissionAlert(coupon, reviewUrl);
      const notifyUpdate = {
        whatsappStatus: notify.success ? 'sent' : 'failed',
        whatsappSid: notify.success ? (notify.sid || '') : '',
        whatsappLastAttempt: new Date().toISOString(),
        whatsappError: notify.success ? '' : (notify.error || 'Unknown error'),
      };
      Object.assign(coupon, notifyUpdate);

      if (supabase.isConfigured()) {
        try {
          await supabase.updateCoupon(coupon.id, notifyUpdate);
        } catch (e) {}
      }
      try {
        await db.updateRow(db.SHEETS.COUPONS, 'id', coupon.id, notifyUpdate);
      } catch (e) {}

      submitted.push(coupon);
    }

    if (submitted.length === 0) {
      return res.status(skipped.length ? (dbSaveFailed ? 500 : 409) : 400).json({
        error: dbSaveFailed ? 'Your coupon could not be saved. Please try again.' : (skipped[0] || 'No coupons submitted.'),
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

router.post('/sell', authenticateToken, handleCouponSubmission);
router.post('/submit', authenticateToken, handleCouponSubmission);

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
