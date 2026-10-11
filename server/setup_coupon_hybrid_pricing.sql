-- ============================================
-- SaveHatke — Hybrid automatic + manual coupon pricing
-- ============================================
-- Run in the Supabase SQL editor. Idempotent and backward-compatible:
--   • every new column is nullable or defaulted, so existing rows keep working
--   • no existing value is rewritten — legacy rows have no pricing_mode, so the
--     app decides them from manual_price exactly as it did before this migration
--   • until this runs, the app still prices every coupon correctly; writes that
--     carry the new fields are simply refused with a clear "run this migration"
--     message instead of silently dropping them

-- Pricing mode: 'automatic' | 'manual'. NULL = legacy (decided by manual_price).
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS pricing_mode TEXT;

-- What original_value means: 'face_value' | 'maximum_discount'.
-- NULL = legacy, treated as face value (the only meaning it ever had for pricing).
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS value_type TEXT;

-- Optional admin-entered last-24-hours price for manual mode. NULL = use the
-- default percentage off the manual normal price.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS manual_final_price TEXT;

-- Keep the values to the known set. A NULL always passes, so legacy rows are safe.
ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_pricing_mode_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_pricing_mode_check
  CHECK (pricing_mode IS NULL OR pricing_mode IN ('automatic', 'manual'));

ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_value_type_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_value_type_check
  CHECK (value_type IS NULL OR value_type IN ('face_value', 'maximum_discount'));
