-- ============================================
-- SaveHatke — Supabase migration: per-coupon "How to use"
-- ============================================
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent, so re-running is safe.
--
-- Free-text steps shown on the coupon as its own "How to use" section.
-- Until this is applied, saving a How to use text shows an error and the
-- rest of the app keeps working as before.

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS how_to_use TEXT DEFAULT NULL;
