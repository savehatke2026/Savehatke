-- ============================================
-- SaveHatke — Sessions Table (Supabase)
-- ============================================
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)

CREATE TABLE IF NOT EXISTS sessions (
  session_id    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       TEXT NOT NULL,
  email         TEXT DEFAULT '',
  device        TEXT DEFAULT '',
  os            TEXT DEFAULT '',
  browser       TEXT DEFAULT '',
  country       TEXT DEFAULT '',
  state         TEXT DEFAULT '',
  city          TEXT DEFAULT '',
  ip_address    TEXT DEFAULT '',
  login_method  TEXT NOT NULL DEFAULT 'Email',
  login_time    TIMESTAMPTZ DEFAULT now(),
  last_active   TIMESTAMPTZ DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'Active'
                CHECK (status IN ('Active', 'Expired', 'Logged out')),
  logged_out_at TIMESTAMPTZ
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

-- If the sessions table already exists (created before the email column),
-- add it now. Safe to re-run.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS email TEXT DEFAULT '';

-- Enable Row Level Security (optional, service key bypasses it)
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
