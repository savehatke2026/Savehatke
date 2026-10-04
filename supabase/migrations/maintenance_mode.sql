-- ============================================
-- SaveHatke — Maintenance Mode Migration
-- ============================================
-- Creates a generic site_settings key-value table in Supabase for storing
-- global application settings (starting with maintenance_mode).
--
-- Run this in the Supabase SQL Editor BEFORE deploying the code changes.

CREATE TABLE IF NOT EXISTS site_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL DEFAULT ''
);

-- Seed the maintenance flag to OFF by default
INSERT INTO site_settings (key, value, updated_by)
VALUES ('maintenance_mode', '{"enabled": false, "message": ""}', 'system')
ON CONFLICT (key) DO NOTHING;

-- Settings contain operator-controlled values. Only the server's service
-- role may access this table; browser anon/authenticated roles receive no grants.
ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE site_settings FROM anon, authenticated;
GRANT ALL ON TABLE site_settings TO service_role;

DROP POLICY IF EXISTS "Service role full access" ON site_settings;
CREATE POLICY "Service role full access" ON site_settings
  TO service_role
  FOR ALL
  USING (true)
  WITH CHECK (true);
