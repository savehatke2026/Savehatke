-- ============================================================
-- SaveHatke — Admin Allowlist: profile columns (Step 2/4 of the
-- Mongo → Supabase cutover)
-- ============================================================
-- Adds the per-admin profile fields that today live on the Admin MongoDB
-- document. Safe to re-run; uses `add column if not exists` so a partially-
-- migrated Supabase project won't error.
--
-- After running:
--   * server/routes/auth.js will write the Google `picture` URL into
--     admin_allowlist.profile_image on every admin Google sign-in (already
--     shipped in commit 2fe4331).
--   * server/routes/admin.js /admin/me will read profile_image + last_login
--     from this table instead of the Admin MongoDB document.
--
-- Run once in the Supabase SQL editor.

alter table public.admin_allowlist
  add column if not exists profile_image text    not null default '',
  add column if not exists last_login   timestamptz;

comment on column admin_allowlist.profile_image is
  'Google avatar URL (lh3.googleusercontent.com / google.com). Allowlist-safe — same allowlist the client uses in safeProfilePictureUrl.';
comment on column admin_allowlist.last_login is
  'Set on every successful Google admin sign-in (server/routes/auth.js).';