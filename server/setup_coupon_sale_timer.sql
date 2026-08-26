-- ============================================
-- SaveHatke — Supabase migration for the coupon sale switch + expiry timer
-- ============================================
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Everything here is idempotent, so re-running it is safe.
--
-- Until it is applied:
--   • the Sale switch in Coupon Management will show an error toast and revert
--     (the on_sale column simply isn't there yet)
--   • coupon ids keep being generated in Node instead of by Postgres
-- The rest of the app keeps working exactly as before either way.

-- 1) Sale switch, one flag per coupon.
--    DEFAULT TRUE so the coupons already in the table keep the "🔥 SALE" badge
--    that the marketplace currently shows on every paid coupon.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS on_sale BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill in case the column was added earlier without a default.
UPDATE coupons SET on_sale = TRUE WHERE on_sale IS NULL;

-- 2) Let Supabase mint the unique coupon id.
--    coupons.id is TEXT (not UUID), so cast the generated uuid to text.
--    After this, the server can INSERT without an id and Postgres fills it in.
ALTER TABLE coupons ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

-- 3) Indexes for the marketplace reads ("on sale" + expiry countdown ordering).
--    expiry_date stays TEXT — it holds 'YYYY-MM-DD' today and also accepts
--    'YYYY-MM-DDTHH:mm' from the new admin timer picker.
CREATE INDEX IF NOT EXISTS idx_coupons_on_sale     ON coupons (on_sale);
CREATE INDEX IF NOT EXISTS idx_coupons_expiry_date ON coupons (expiry_date);
