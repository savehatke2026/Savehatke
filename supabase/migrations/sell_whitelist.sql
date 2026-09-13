-- ============================================
-- SaveHatke — Sell Whitelist Migration
-- ============================================
-- Seeds the sell whitelist into the existing site_settings table (created
-- by maintenance_mode.sql). The whitelist is the list of user emails that
-- may see and use the coupon selling form on /sell. Admins (admin / super
-- admin / support) bypass it on role, so the operator can never lock
-- themselves out.
--
-- Run this in the Supabase SQL Editor. Safe to re-run.

INSERT INTO site_settings (key, value, updated_by)
VALUES ('sell_whitelist', '{"emails": []}', 'system')
ON CONFLICT (key) DO NOTHING;
