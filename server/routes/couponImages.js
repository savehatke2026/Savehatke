// ============================================
// SaveHatke — Coupon Image Upload (Admin → Google Drive)
// ============================================
// POST /api/admin/coupon-images — upload ONE image for the Coupon Management
// edit form ("Upload Brand Logo" / "Upload Coupon Background Image") and
// immediately apply it to THAT coupon.
//
// Flow (per requirement: update only the required coupon record, never show a
// successful save if the image or database update failed):
//   1. validate the image (magic bytes; PNG/JPEG/WebP; ≤3MB; base64-in-JSON —
//      the project's bounded-image convention, no multipart parser)
//   2. upload the binary into the matching EXISTING Drive asset folder
//      (services/couponImages.js → services/googleDrive.js)
//   3. on upload success, update ONLY this coupon's one field —
//      coupons.brand_logo / coupons.background_image in Supabase, mirrored to
//      the Coupons sheet — and store the image REFERENCE
//      (/api/brand-assets/file/<fileId>), never binary data
//   4. any failure returns an error response and changes nothing the admin
//      would mistake for a save: a failed Drive upload leaves the record
//      untouched; a failed record update is reported as a failure even though
//      an orphan file may remain in Drive (the safe direction)
//
// Display: the stored reference is served by the existing scoped proxy
// /api/brand-assets/file/:fileId, which authorizes only files inside the two
// asset folders — the same image-loading system every brand-level asset
// already uses. Mounted at a dedicated prefix (like /api/admin/gmail) so only
// this endpoint receives the large-body parser.
// ============================================

const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { adminMutationLimiter } = require('../utils/adminRateLimit');
const supabase = require('../services/supabase');
const db = require('../services/googleSheets');
const couponImages = require('../services/couponImages');
const couponListCache = require('../services/couponListCache');

const router = express.Router();

// field → { supabaseColumn, sheetColumn, label }
const FIELD_MAP = {
  brandLogo: { supabaseColumn: 'brandLogo', sheetColumn: 'brandLogo', label: 'brand logo' },
  backgroundImage: { supabaseColumn: 'backgroundImage', sheetColumn: 'backgroundImage', label: 'background image' },
};

router.post('/', authenticateToken, requireAdmin, adminMutationLimiter, async (req, res) => {
  try {
    const { couponId, field, dataBase64, contentType } = req.body || {};

    if (!FIELD_MAP[field]) {
      return res.status(400).json({ error: 'Unknown image field. Expected brandLogo or backgroundImage.' });
    }
    if (!couponImages.isConfigured()) {
      return res.status(503).json({ error: 'Google Drive is not configured on the server.' });
    }

    // The upload must belong to a real coupon — the edit form can only reach
    // this route for a coupon it already opened.
    let coupon = null;
    if (supabase.isConfigured()) {
      try { coupon = await supabase.findCouponById(couponId); } catch (e) {}
    }
    if (!coupon) {
      try { coupon = await db.findRow(db.SHEETS.COUPONS, 'id', couponId); } catch (e) {}
    }
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found. Reload the coupon list and try again.' });
    }

    let image;
    try {
      image = couponImages.validateImageUpload({ dataBase64, contentType });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // 1) Drive upload into the existing asset folder.
    let uploaded;
    try {
      uploaded = await couponImages.uploadCouponImage({
        couponId: coupon.id,
        kind: field,
        brand: coupon.brand,
        buffer: image.buffer,
        ext: image.ext,
        contentType: image.contentType,
      });
    } catch (err) {
      console.error('Coupon image Drive upload failed:', err.code || '', err.message);
      const status = err.code === 'DRIVE_NOT_CONFIGURED' || err.code === 'DRIVE_FOLDER_NOT_FOUND' ? 503 : 502;
      return res.status(status).json({ error: err.message || 'Image upload failed.' });
    }

    // 2) Apply to ONLY this coupon, ONLY this field. Supabase is the canonical
    // store the marketplace reads; the sheet is the admin mirror.
    const ref = uploaded.url;
    const columns = FIELD_MAP[field];
    let supabaseError = null;
    let supabaseMissingColumn = false;
    let sheetError = null;

    if (supabase.isConfigured()) {
      try {
        await supabase.updateCoupon(coupon.id, { [columns.supabaseColumn]: ref });
      } catch (e) {
        supabaseError = e;
        supabaseMissingColumn = /does not exist|Could not find the/i.test(e.message || '');
      }
    }
    try {
      await db.updateRow(db.SHEETS.COUPONS, 'id', coupon.id, { [columns.sheetColumn]: ref });
    } catch (e) {
      sheetError = e;
    }

    // Never report success when the record update failed.
    if (supabaseError && supabase.isConfigured()) {
      const hint = supabaseMissingColumn
        ? (field === 'brandLogo'
          ? ' Run supabase/migrations/20261009_coupon_brand_logo_and_list_indexes.sql in the Supabase SQL editor.'
          : ' Run server/setup_coupon_background_image.sql in the Supabase SQL editor.')
        : '';
      return res.status(supabaseMissingColumn ? 400 : 500).json({
        error: `The image uploaded to Google Drive, but saving it on the coupon failed.${hint} ${(supabaseError.message || '').slice(0, 200)}`,
      });
    }
    if (!supabase.isConfigured() && sheetError) {
      return res.status(500).json({
        error: `The image uploaded to Google Drive, but saving it on the coupon failed. ${(sheetError.message || '').slice(0, 200)}`,
      });
    }

    // Fresh lists for every admin — the next GET reflects the new image.
    couponListCache.invalidate();

    res.status(201).json({
      message: `${columns.label === 'brand logo' ? 'Brand logo' : 'Background image'} updated.`,
      field,
      url: ref,
      fileId: uploaded.fileId,
    });
  } catch (err) {
    console.error('Coupon image upload error:', err);
    res.status(500).json({ error: err.message || 'Image upload failed.' });
  }
});

module.exports = router;
