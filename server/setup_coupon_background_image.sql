-- ============================================
-- SaveHatke — Supabase migration: per-coupon background image
-- ============================================
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent, so re-running is safe.
--
-- The marketplace card renders a hero image per coupon. The image URL/path is
-- stored on the coupon row itself so each coupon can carry a different image,
-- and the admin can change one coupon's image without touching frontend code.
-- Until this is applied:
--   • every coupon falls back to the generic SaveHatke default background
--     (the card reads backgroundImage || DEFAULT, never a hard-coded brand)
--   • saving a background image from Coupon Management / Add Coupon shows
--     an error toast and reverts — the background_image column isn't there yet
-- The rest of the app keeps working exactly as before either way.

-- 1) Optional hero image per coupon — public path (e.g. '/images/coupons/flipkart.webp')
--    or an absolute URL. NULL ⇒ the card uses the default SaveHatke background.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS background_image TEXT DEFAULT NULL;
