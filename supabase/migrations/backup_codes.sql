-- ============================================================
-- SaveHatke — backup_codes (SOS break-glass admin codes)
-- ============================================================
-- Run in the Supabase SQL Editor (Dashboard → SQL Editor → New query),
-- or apply via the Supabase migration tool.
-- Idempotent — safe to run multiple times.
--
-- Mirrors server/models/BackupCode.js so a code can live in Supabase,
-- MongoDB, or both: the SOS gate checks every store it can reach, which is
-- the point of a break-glass credential. Column names are snake_case here
-- and mapped to the camelCase field names the application uses in
-- server/services/supabase.js.
--
-- SECURITY
--   The cleartext code is NEVER stored — only its bcrypt hash. code_prefix
--   is the first 6 hex characters of SHA-256(code_hash): a non-secret handle
--   so an administrator can tell two codes apart in the audit trail. Because
--   each bcrypt hash carries its own salt, the SAME cleartext registered in
--   both stores gets a different prefix in each. That is expected.
--
--   RLS is enabled with no policies, matching the sessions tables: the
--   service_role key used by the server bypasses RLS, and the anon key
--   therefore cannot read a single row.

CREATE TABLE IF NOT EXISTS backup_codes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash            TEXT NOT NULL,
  code_prefix          TEXT NOT NULL,
  label                TEXT NOT NULL,
  created_by           TEXT NOT NULL DEFAULT 'admin',
  notes                TEXT NOT NULL DEFAULT '',
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  -- NULL = never expires
  expires_at           TIMESTAMPTZ,
  -- NULL = single use (the SOS route treats a missing cap as one use)
  max_uses             INTEGER,
  usage_count          INTEGER NOT NULL DEFAULT 0,
  last_used_at         TIMESTAMPTZ,
  last_used_ip         TEXT NOT NULL DEFAULT '',
  last_used_reason     TEXT NOT NULL DEFAULT '',
  -- Empty = any administrator on the route-level allowlist may be chosen
  allowed_admin_emails TEXT[] NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The gate only ever reads live codes, and only bcrypt-compares against
-- those, so this is the index that matters.
CREATE INDEX IF NOT EXISTS idx_backup_codes_active ON backup_codes (is_active, expires_at);
CREATE INDEX IF NOT EXISTS idx_backup_codes_prefix ON backup_codes (code_prefix);

ALTER TABLE backup_codes ENABLE ROW LEVEL SECURITY;

-- Verify:
--   SELECT id, code_prefix, label, is_active, usage_count, max_uses, expires_at
--   FROM backup_codes ORDER BY created_at DESC;
