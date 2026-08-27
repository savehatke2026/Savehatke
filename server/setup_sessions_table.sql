-- ============================================
-- SaveHatke — Session Tables (Supabase)
-- ============================================
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query).
--
-- Login sessions are split across TWO tables so admin and user logins are
-- never stored together:
--   • user_sessions  — every non-admin login (Email / Email OTP / Google)
--   • admin_sessions — admin logins (login_method 'Admin' / 'Google Admin')
--
-- If you are migrating from the older single `sessions` table, run
-- supabase/migrations/split_sessions_user_admin.sql instead — it creates
-- both tables AND copies your existing rows into the correct one.

-- ---------- user_sessions ----------
CREATE TABLE IF NOT EXISTS user_sessions (
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
  user_agent    TEXT,
  session_token TEXT,
  login_time    TIMESTAMPTZ DEFAULT now(),
  last_active   TIMESTAMPTZ DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'Active'
                CHECK (status IN ('Active', 'Expired', 'Logged out')),
  logged_out_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_status ON user_sessions (status);
CREATE INDEX IF NOT EXISTS idx_user_sessions_session_token ON user_sessions (session_token);
CREATE INDEX IF NOT EXISTS idx_user_sessions_status_expires ON user_sessions (status, expires_at);
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;

-- ---------- admin_sessions ----------
CREATE TABLE IF NOT EXISTS admin_sessions (
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
  login_method  TEXT NOT NULL DEFAULT 'Admin',
  user_agent    TEXT,
  session_token TEXT,
  login_time    TIMESTAMPTZ DEFAULT now(),
  last_active   TIMESTAMPTZ DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'Active'
                CHECK (status IN ('Active', 'Expired', 'Logged out')),
  logged_out_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_id ON admin_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_status ON admin_sessions (status);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_session_token ON admin_sessions (session_token);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_status_expires ON admin_sessions (status, expires_at);
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
