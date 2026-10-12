-- ============================================
-- SaveHatke — Supabase migration for the coupon discount-display switch
-- ============================================
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent: safe to re-run.
--
-- discount_on controls whether the discount value (e.g. "20% OFF") is shown on
-- the marketplace card. DEFAULT FALSE: discounts are hidden until an admin turns
-- the switch on for a coupon. Existing rows are set to FALSE on purpose.
--
-- Until this is applied, the Discount switch in Coupon Management shows an
-- error toast and reverts. The rest of the app keeps working.

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS discount_on BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE coupons SET discount_on = FALSE WHERE discount_on IS NULL;
