-- ============================================
-- SaveHatke — Maintenance Whitelist Seed (Optional)
-- ============================================
-- The maintenance whitelist lives in the same `site_settings` key/value
-- table created by maintenance_mode.sql. Run this in the Supabase SQL
-- Editor ONLY if you want to pre-seed the allow-list without booting the
-- Node server (the server seeds the same row on startup, so this is
-- optional).
--
-- Two trusted test addresses are added by default:
--   - rupayandas2026@gmail.com
--   - rupayandas2025@gmail.com
-- The hardcoded admin accounts always bypass maintenance regardless of
-- this list, so they don't need to be added here.

INSERT INTO site_settings (key, value, updated_by)
VALUES (
  'maintenance_whitelist',
  jsonb_build_object(
    'emails',
    jsonb_build_array(
      'rupayandas2026@gmail.com',
      'rupayandas2025@gmail.com'
    )
  ),
  'system'
)
ON CONFLICT (key) DO NOTHING;
