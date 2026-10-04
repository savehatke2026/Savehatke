-- Bind every newly created SaveHatke session to the Google subject verified
-- by the OAuth callback. Existing sessions predate this proof and are revoked
-- so email-only/unsigned-token sessions cannot survive the Google-only cutover.
ALTER TABLE IF EXISTS public.user_sessions
  ADD COLUMN IF NOT EXISTS google_sub TEXT NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS public.admin_sessions
  ADD COLUMN IF NOT EXISTS google_sub TEXT NOT NULL DEFAULT '';

UPDATE public.user_sessions
SET status = 'Logged out', revoked_at = now(), logged_out_at = now()
WHERE status = 'Active' AND COALESCE(google_sub, '') = '';

UPDATE public.admin_sessions
SET status = 'Logged out', revoked_at = now(), logged_out_at = now()
WHERE status = 'Active' AND COALESCE(google_sub, '') = '';
