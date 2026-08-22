-- ============================================================
-- SaveHatke — 48-hour session system upgrade
-- ============================================================
-- Run ONCE in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Idempotent — safe to run multiple times.
--
-- Adds the columns the server-side 48h session validation needs to the
-- existing `sessions` table. Until this runs, the server detects the
-- missing columns automatically and falls back to 48h-limited JWTs
-- (logins keep working; server-side revocation is not enforceable).

-- Random session identifier (SHA-256 hash — the raw token never touches the DB)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_token text;

-- When (and why) the session stopped being active
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- Raw User-Agent of the login request
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;

-- Fast lookup on every authenticated API request
CREATE INDEX IF NOT EXISTS idx_sessions_session_token ON sessions (session_token);
CREATE INDEX IF NOT EXISTS idx_sessions_status_expires ON sessions (status, expires_at);

-- Optional: clean up very old session rows (keep 90 days of history)
-- DELETE FROM sessions WHERE login_time < now() - interval '90 days';
