-- ============================================
-- SaveHatke — Supabase migration: per-coupon manual selling price
-- ============================================
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent, so re-running is safe.
--
-- Optional admin-typed buyer price. NULL (the default) means no manual price,
-- so the automatic 20% / 10% of face value rule applies, exactly as before.
-- Until this is applied, saving a manual price shows an error and the rest
-- of the app keeps working as before.

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS manual_price TEXT DEFAULT NULL;
