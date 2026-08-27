-- ============================================================
-- SaveHatke — Split sessions into user_sessions + admin_sessions
-- ============================================================
-- Run in the Supabase SQL Editor (Dashboard → SQL Editor → New query),
-- or apply via the Supabase migration tool.
-- Idempotent — safe to run multiple times.
--
-- Previously, admin and user logins were stored together in a single
-- `sessions` table and separated only by the login_method value. This
-- migration creates two dedicated tables and copies any existing rows
-- into the correct one. The application writes admin logins
-- (login_method 'Admin' / 'Google Admin') to admin_sessions and everyone
-- else to user_sessions.

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

-- ---------- Backfill from the old combined `sessions` table (if present) ----------
-- Copies existing rows into the correct new table, skipping any that were
-- already copied (matched on session_id). Admin rows are detected by the
-- same rule the application uses: login_method matching 'admin' or
-- 'google admin' (case-insensitive).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'sessions'
  ) THEN
    -- The old table may predate the 48h-session upgrade and be missing these
    -- columns. Add them (empty) so the copy below always has them to read.
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent    TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_token TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at    TIMESTAMPTZ;

    INSERT INTO user_sessions (
      session_id, user_id, email, device, os, browser, country, state, city,
      ip_address, login_method, user_agent, session_token, login_time,
      last_active, expires_at, revoked_at, status, logged_out_at
    )
    SELECT
      s.session_id, s.user_id, s.email, s.device, s.os, s.browser, s.country,
      s.state, s.city, s.ip_address, s.login_method, s.user_agent,
      s.session_token, s.login_time, s.last_active, s.expires_at, s.revoked_at,
      s.status, s.logged_out_at
    FROM sessions s
    WHERE s.login_method !~* '^(google\s+)?admin$'
    ON CONFLICT (session_id) DO NOTHING;

    INSERT INTO admin_sessions (
      session_id, user_id, email, device, os, browser, country, state, city,
      ip_address, login_method, user_agent, session_token, login_time,
      last_active, expires_at, revoked_at, status, logged_out_at
    )
    SELECT
      s.session_id, s.user_id, s.email, s.device, s.os, s.browser, s.country,
      s.state, s.city, s.ip_address, s.login_method, s.user_agent,
      s.session_token, s.login_time, s.last_active, s.expires_at, s.revoked_at,
      s.status, s.logged_out_at
    FROM sessions s
    WHERE s.login_method ~* '^(google\s+)?admin$'
    ON CONFLICT (session_id) DO NOTHING;
  END IF;
END $$;

-- The old `sessions` table is intentionally left in place so the copy can be
-- verified before dropping it. Once you've confirmed the data looks right in
-- user_sessions / admin_sessions, remove it manually:
--   DROP TABLE IF EXISTS sessions;
