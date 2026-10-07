-- ============================================================
-- SaveHatke — Admin Allowlist (Supabase)
-- ============================================================
-- The administrator roster lives in this table so it can be edited without
-- a redeploy. The server reads it at boot, refreshes every 60 seconds, and
-- blocks admin sign-in while the table is unreachable.
--
-- Every roster entry is a plain admin: there is no role column and no
-- deactivation — access is "on the roster and active". Each admin gets a
-- stable public identifier (admin_xxxxxxxx) in the admin_id column.
--
-- Run once in the Supabase SQL editor (Database → SQL Editor → New query).
-- Safe to re-run.

create table if not exists public.admin_allowlist (
  email      text        primary key,                -- lowercased on insert
  name       text        not null default '',
  admin_id   text        unique,                     -- admin_xxxxxxxx, filled automatically
  active     boolean     not null default true,
  created_at timestamptz not null default now()
);

-- Upgrade an existing roster in place: add the admin_id column (ids are
-- derived from each email and backfilled automatically by the server on the
-- next roster read) and drop the role column if an earlier migration added it.
alter table public.admin_allowlist add column if not exists admin_id text unique;
alter table public.admin_allowlist drop column if exists role;
notify pgrst, 'reload schema';

-- Seed the original two admins so the migration is loss-less. Run again
-- any time with different emails to change the roster.
insert into public.admin_allowlist (email, name, active) values
  ('rupayandas2024@gmail.com', 'Rupayan', true),
  ('jaggik8888@gmail.com',     'Jaggik',  true)
on conflict (email) do update
  set name   = excluded.name,
      active = excluded.active;
