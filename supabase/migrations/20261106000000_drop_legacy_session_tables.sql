-- SaveHatke no longer stores authentication sessions in Supabase.
-- The application now uses the UserSessions and AdminSessions Google Sheets tabs.
-- Run only after the Sheets-session application release is deployed and verified.
DROP TABLE IF EXISTS public.admin_sessions;
DROP TABLE IF EXISTS public.user_sessions;
