-- ============================================
-- SaveHatke — Maintenance Whitelist Migration
-- ============================================
-- Seeds the maintenance whitelist into the existing site_settings table
-- (created by maintenance_mode.sql). The whitelist is the list of user
-- emails that may log in and browse the site normally while maintenance
-- mode is ON. Admins bypass maintenance regardless of this list.
--
-- Run this in the Supabase SQL Editor. Safe to re-run.

INSERT INTO site_settings (key, value, updated_by)
VALUES ('maintenance_whitelist', '{"emails": []}', 'system')
ON CONFLICT (key) DO NOTHING;
