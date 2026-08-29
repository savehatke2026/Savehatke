// ============================================
// SaveHatke — Coupon Marketplace Routes
// ============================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const db = require('../services/googleSheets');
const supabase = require('../services/supabase');
const twilioWhatsApp = require('../services/twilioWhatsApp');
const googleDrive = require('../services/googleDrive');
const couponVision = require('../services/couponVision');

const router = express.Router();

// Every coupon shows a live "expires in" countdown that starts at 2 weeks.
// When a coupon has no explicit expiry we anchor the 14-day window to its
// addedAt timestamp (stable across reloads); if addedAt is also missing we
// anchor to "now" so the coupon still gets a 14-day timer instead of none.
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
function defaultExpiry(explicitExpiry, addedAt) {
  if (explicitExpiry) return explicitExpiry;
  const base = addedAt ? new Date(addedAt).getTime() : Date.now();
  const t = Number.isFinite(base) ? base : Date.now();
  return new Date(t + TWO_WEEKS_MS).toISOString();
}

// Proof screenshot upload constraints
const PROOF_MAX_BYTES = 3 * 1024 * 1024; // 3MB
const PROOF_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// ── Minimum shelf life for a submitted coupon ──
// A seller has to hand us a coupon that is still valid at least 10 days out,
// which is the number the sell form shows and enforces. The server measures
// against 9 days instead: `date` and `datetime-local` inputs carry no timezone
// offset, so the seller's clock and ours can read the same string up to a day
// apart, and a seller in IST picking exactly the earliest allowed minute must
// not be rejected by a UTC server. The extra day is slack, not a second rule.
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_EXPIRY_DAYS = 10;
const MIN_EXPIRY_FLOOR_DAYS = MIN_EXPIRY_DAYS - 1;

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
      // Expiry is not sensitive (the code itself is still withheld) and the
      // marketplace cards render a live "expires in" countdown from it.
      // Every coupon's timer starts at 2 weeks: when no explicit expiry is
      // set we anchor 14 days to addedAt (or to now if addedAt is missing),
      // so every coupon always shows a live countdown timer.
      expiryDate: defaultExpiry(c.expiryDate, c.addedAt),
      // Admin-controlled sale switch — gates the "🔥 Sale" badge on the card.
      onSale: c.onSale !== false,
      // Admin-controlled timer switch — when off the card hides the countdown
      // even though expiryDate is still set.
      timerOn: c.timerOn !== false,
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

// POST /api/coupons/scan — Read a coupon screenshot with Gemini Vision and
// return the fields it could actually see, each with a confidence score.
//
// SECURITY: the Gemini key never leaves the server; the image is forwarded to
// Google from here, not from the browser. The model's JSON is whitelisted and
// type-checked in services/couponVision.js before any of it is returned.
//
// This endpoint only reads. It never creates a coupon, and it deliberately
// returns no selling price, source or status — those stay with the seller and
// the submit route.
router.post('/scan', authenticateToken, async (req, res) => {
  try {
    const { contentType, dataBase64 } = req.body || {};

    if (!dataBase64) {
      return res.status(400).json({ error: 'dataBase64 is required.' });
    }
    if (!couponVision.isConfigured()) {
      return res.status(503).json({
        error: 'AI scanning is not available right now. Please enter the coupon details manually.',
        reason: 'not_configured',
      });
    }

    let buffer;
    try {
      buffer = Buffer.from(String(dataBase64), 'base64');
    } catch (e) {
      buffer = null;
    }
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: 'The image could not be read.', reason: 'corrupted' });
    }

    const result = await couponVision.analyzeCouponImage({
      buffer,
      mimeType: contentType,
    });

    if (!result.ok) {
      // 422: the request was fine, the image was not usable.
      const status = result.reason === 'not_configured' ? 503
        : result.reason === 'rate_limited' ? 429
        : result.reason === 'ai_unavailable' ? 502
        : 422;
      return res.status(status).json({
        error: result.message,
        reason: result.reason,
        quality: result.quality || undefined,
      });
    }

    return res.json({
      ok: true,
      fields: result.fields,
      quality: result.quality,
      filledCount: result.filledCount,
      // Forced server-side, echoed so the form can show them as locked.
      locked: { source: 'user-submitted', status: 'pending' },
      verifyBelow: couponVision.VERIFY_BELOW_CONFIDENCE,
      image: result.image,
    });
  } catch (err) {
    console.error('Coupon scan error:', err);
    res.status(500).json({ error: 'Could not analyse the screenshot. Please try again.' });
  }
});

// POST /api/coupons/proof — Upload a coupon proof screenshot to Google Drive.
// Drive is the ONLY accepted destination for proof screenshots: they must stay
// in the operator's own Drive folder, never on public object storage. If Drive
// is not usable we fail loudly rather than silently stashing the file elsewhere.
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

    // Drive must be configured — no fallback destination exists.
    if (!googleDrive.isConfigured()) {
      console.error(
        '[coupons/proof] Google Drive is not configured — refusing the upload. ' +
        'Set GOOGLE_DRIVE_FOLDER_ID and GOOGLE_DRIVE_REFRESH_TOKEN in .env.'
      );
      return res.status(503).json({
        error: 'Screenshot uploads are temporarily unavailable. Please try again later.',
      });
    }

    try {
      const result = await googleDrive.uploadProofScreenshot({
        buffer,
        filename,
        mimeType: type,
        sellerEmail: req.user?.email,
      });
      return res.status(201).json({
        url: result.url,           // 'drive:<fileId>'
        fileId: result.fileId,
        storage: 'google-drive',
        name: result.name,
        webViewLink: result.webViewLink,
      });
    } catch (driveErr) {
      // Loud, specific server log so a misconfiguration is obvious in the
      // console; the client gets a generic retry message.
      if (driveErr.code === 'DRIVE_NO_QUOTA') {
        console.error(
          '[coupons/proof] Google Drive upload rejected: the service account has no storage ' +
          'quota of its own and cannot write into a personal My Drive folder. Mint a user ' +
          'refresh token with `cd server && node scripts/authorize-drive.js`, set ' +
          'GOOGLE_DRIVE_REFRESH_TOKEN in .env, and restart the server.'
        );
      } else {
        console.error(
          `[coupons/proof] Google Drive upload failed (${driveErr.code || 'error'}): ${driveErr.message}`
        );
      }
      return res.status(502).json({
        error: 'Could not save your screenshot right now. Please try again in a moment.',
      });
    }
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
      title, discount, minOrderValue, validFrom, affiliateLink, terms,
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

    // Proof screenshots live in Google Drive only, so the only shape we accept
    // is the `drive:<fileId>` token minted by our own /proof endpoint (served
    // back through /api/proxy/drive/<fileId>). Anything else is dropped — a
    // client cannot talk us into persisting an arbitrary external URL.
    const sanitizeProofUrl = (v) => {
      if (!v) return '';
      const raw = String(v).trim();
      return /^drive:[a-zA-Z0-9_-]{10,80}$/.test(raw) ? raw.slice(0, 80) : '';
    };
    const safeProofUrl = sanitizeProofUrl(proofUrl);

    // Normalize both formats into a list
    let list;
    if (Array.isArray(coupons) && coupons.length > 0) {
      // The sell form derives a category per coupon (from the brand), so a
      // shared top-level category is only required when a coupon omits its own.
      const missingCategory = coupons.some((c) => !cleanStr(c && c.category, 60));
      if (!cleanCategory && missingCategory) {
        return res.status(400).json({ error: 'Category is required.' });
      }
      list = coupons.map((c) => ({
        code: c && c.code,
        category: cleanStr(c && c.category, 60) || cleanCategory,
        brand: c && c.brand,
        description: (c && c.description) || '',
        faceValue: (c && (c.faceValue || c.originalValue)) || faceValue || originalValue || '0',
        type: (c && c.type) || type,
        sellingPrice: (c && c.sellingPrice) !== undefined ? c.sellingPrice : sellingPrice,
        expiryDate: (c && c.expiryDate) || expiryDate,
        title: (c && c.title) || title,
        discount: (c && c.discount) || discount,
        minOrderValue: (c && c.minOrderValue) || minOrderValue,
        validFrom: (c && c.validFrom) || validFrom,
        affiliateLink: (c && c.affiliateLink) || affiliateLink,
        terms: (c && c.terms) || terms,
        // Each coupon can carry its own screenshot; falls back to the shared one.
        proofUrl: sanitizeProofUrl(c && c.proofUrl) || safeProofUrl,
      }));
    } else {
      list = [{ code, category: cleanCategory, brand, description, faceValue: faceValue || originalValue, type, sellingPrice, expiryDate, title, discount, minOrderValue, validFrom, affiliateLink, terms, proofUrl: safeProofUrl }];
    }

    const sellerEmail = req.user.email;
    const sellerUserId = req.user.id || req.user.user_id || '';
    const submitted = [];
    const skipped = [];
    let dbSaveFailed = false;

    // ── Minimum shelf life ──
    // A coupon is only worth listing if the buyer has time to use it, so every
    // submission has to still be valid at least MIN_EXPIRY_DAYS out. Checked as
    // a pre-pass over the whole batch, not inside the save loop below: that loop
    // writes as it goes, so returning 400 from inside it would leave the earlier
    // coupons already saved.
    const expiryFloor = Date.now() + MIN_EXPIRY_FLOOR_DAYS * DAY_MS;
    for (let i = 0; i < list.length; i++) {
      const raw = String(list[i].expiryDate == null ? '' : list[i].expiryDate).trim();
      if (!raw) {
        return res.status(400).json({
          error: `Coupon ${i + 1}: an expiry date is required, at least ${MIN_EXPIRY_DAYS} days from today.`,
        });
      }
      const at = Date.parse(raw);
      if (!Number.isFinite(at)) {
        return res.status(400).json({ error: `Coupon ${i + 1}: expiry date is not a valid date.` });
      }
      if (at < expiryFloor) {
        return res.status(400).json({
          error: `Coupon ${i + 1}: the coupon must stay valid at least ${MIN_EXPIRY_DAYS} days from today. Please submit a coupon with a later expiry.`,
        });
      }
    }

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.code || !c.category || !c.brand) {
        skipped.push(`Coupon ${i + 1}: code, category, and brand are required.`);
        continue;
      }

      const cleanCode = String(c.code).toUpperCase().trim().slice(0, 60);
      const cleanBrand = cleanStr(c.brand, 80);
      const cleanDescription = cleanStr(c.description, 500) || cleanStr(c.title, 500);
      const cleanFaceValue = cleanStr(c.faceValue || '0', 20);

      // Extended listing fields submitted by the sell form (all optional, length-capped)
      const itemTitle = cleanStr(c.title, 120) || cleanBrand;
      const itemDiscount = cleanStr(c.discount, 60);
      const itemMinOrder = cleanStr(c.minOrderValue, 20);
      const itemAffiliate = cleanStr(c.affiliateLink, 500);
      const itemTerms = cleanStr(c.terms, 1000);
      const itemValidFrom = cleanStr(c.validFrom, 30);
      if (itemValidFrom && isNaN(Date.parse(itemValidFrom))) {
        return res.status(400).json({ error: `Coupon ${i + 1}: valid-from date is not a valid date.` });
      }

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
        // id omitted — Supabase mints it; a local uuid is only used as a
        // fallback below when Supabase isn't configured or rejects the insert.
        code: cleanCode,
        category: String(c.category).trim().slice(0, 60),
        brand: cleanBrand,
        title: itemTitle,
        description: cleanDescription,
        type: itemType,
        discount: itemDiscount,
        originalValue: cleanFaceValue,
        minOrderValue: itemMinOrder,
        validFrom: itemValidFrom,
        affiliateLink: itemAffiliate,
        terms: itemTerms,
        sellingPrice: itemPrice,
        expiryDate: itemExpiry,
        proofUrl: sanitizeProofUrl(c.proofUrl) || safeProofUrl,
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
          const created = await supabase.createCoupon(coupon);
          coupon.id = created.id; // Supabase-generated unique id
          saved = true;
        } catch (e) {
          console.warn('Supabase coupon save notice:', e.message);
        }
      }
      if (!coupon.id) coupon.id = uuidv4();
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

      submitted.push(coupon);
    }

    // ── Batch WhatsApp notification — one message for ALL submitted coupons ──
    if (submitted.length > 0) {
      const reviewUrl = `${APP_BASE_URL}/admin`;
      const sellerInfo = { name: req.user.name || '', email: sellerEmail };
      const notify = await twilioWhatsApp.sendCouponSubmissionAlert(submitted, sellerInfo, reviewUrl);
      const now = new Date().toISOString();
      const notifyUpdate = {
        whatsappStatus: notify.success ? 'sent' : 'failed',
        whatsappSid: notify.success ? (notify.sid || '') : '',
        whatsappLastAttempt: now,
        whatsappError: notify.success ? '' : (notify.error || 'Unknown error'),
      };

      // Update WhatsApp status on every submitted coupon
      for (const coupon of submitted) {
        Object.assign(coupon, notifyUpdate);
        if (supabase.isConfigured()) {
          try { await supabase.updateCoupon(coupon.id, notifyUpdate); } catch (e) {}
        }
        try { await db.updateRow(db.SHEETS.COUPONS, 'id', coupon.id, notifyUpdate); } catch (e) {}
      }
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

    // Auto-create a payout entry for the seller so the admin can pay them
    // for this sale. Failure here never breaks the buy flow — payouts are
    // best-effort and can be retried from the admin panel.
    try {
      const { createAutoPayout } = require('./payouts');
      await createAutoPayout({
        coupon: { id: coupon.id, code: coupon.code, brand: coupon.brand },
        sellerEmail: coupon.sellerEmail,
        sellerUserId: coupon.sellerUserId,
      });
    } catch (e) {
      console.warn('Auto-payout on buy notice:', e.message);
    }

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
        title: c.title,
        description: c.description,
        discount: c.discount,
        originalValue: c.originalValue,
        sellingPrice: c.sellingPrice,
        expiryDate: c.expiryDate,
        status: c.status,
        addedAt: c.addedAt,
        soldAt: c.soldAt,
        buyerEmail: c.buyerEmail,
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
        title: c.title,
        description: c.description,
        discount: c.discount,
        originalValue: c.originalValue,
        sellingPrice: c.sellingPrice,
        pricePaid: c.sellingPrice,
        expiryDate: c.expiryDate,
        status: c.status,
        addedAt: c.addedAt,
        soldAt: c.soldAt,
        purchasedAt: c.soldAt,
        sellerEmail: c.sellerEmail,
      })),
    });
  } catch (err) {
    console.error('My purchases error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
