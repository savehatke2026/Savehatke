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

-- Allow the service role full access (RLS is off by default for new tables
-- accessed via the service key, but this is explicit for clarity).
ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;

-- Service-role policy: the server uses the service key, so it bypasses RLS
-- automatically. This policy is a safety net for any future anon/authenticated
-- access patterns.
CREATE POLICY "Service role full access" ON site_settings
  FOR ALL
  USING (true)
  WITH CHECK (true);
