-- ============================================
-- SaveHatke — Supabase migration for coupon review & WhatsApp notifications
-- ============================================
-- Optional: Google Sheets stays the source of truth for the new fields until
-- this migration is applied. Run it in the Supabase SQL editor if you want
-- the new fields persisted in Postgres as well.

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS proof_url TEXT DEFAULT '';
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS admin_notes TEXT DEFAULT '';
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS seller_user_id TEXT DEFAULT '';
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS whatsapp_status TEXT DEFAULT '';
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS whatsapp_sid TEXT DEFAULT '';
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS whatsapp_last_attempt TIMESTAMPTZ;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS whatsapp_error TEXT DEFAULT '';

-- Index for the admin pending-review list
CREATE INDEX IF NOT EXISTS idx_coupons_status ON coupons (status);
