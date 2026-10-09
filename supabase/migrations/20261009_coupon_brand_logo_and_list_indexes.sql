-- ============================================
-- SaveHatke — Supabase migration: per-coupon brand logo + list indexes
-- ============================================
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent, so re-running is safe. Backward compatible: existing coupon
-- rows keep every value; the new column is optional and NULL by default.
--
-- 1) brand_logo — per-coupon brand-logo OVERRIDE. Set from the Coupon
--    Management edit form ("Upload Brand Logo"). Stores an IMAGE REFERENCE —
--    '/api/brand-assets/file/<googleDriveFileId>' — pointing at a file in the
--    existing "SaveHatke Assets/Brand Logos" Google Drive folder. No image
--    binary and no base64 data is stored in Supabase; the file lives in
--    Google Drive and is served through the existing authorized proxy
--    /api/brand-assets/file/:fileId.
--    NULL (the default) means the card keeps resolving the brand-level Drive
--    logo exactly as before — every existing coupon renders unchanged.
--    (Per-coupon background references continue to live in the EXISTING
--    coupons.background_image column — setup_coupon_background_image.sql —
--    which the Coupon Backgrounds uploads use the same way.)
--
-- 2) Indexes — the admin coupon list and the marketplace both filter on
--    status and sort by added_at. The (status, added_at DESC) composite
--    serves that exact shape; code is the duplicate-check lookup key
--    (findCouponByCode) and the sheet-merge join key. Purely physical; no
--    query results change.
-- ============================================

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS brand_logo TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_coupons_status_added_at ON coupons (status, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons (code);
