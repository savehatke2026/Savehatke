-- ============================================================
-- SaveHatke — Admin Allowlist (Supabase)
-- ============================================================
-- The administrator roster lives in this table so it can be edited without
-- a redeploy. The server reads it at boot, refreshes every 60 seconds, and
-- blocks admin sign-in while the table is unreachable.
--
-- Run once in the Supabase SQL editor (Database → SQL Editor → New query).
-- Safe to re-run.

create table if not exists public.admin_allowlist (
  email      text        primary key,                -- lowercased on insert
  name       text        not null default '',
  active     boolean     not null default true,
  created_at timestamptz not null default now()
);

-- Seed the original two admins so the migration is loss-less. Run again
-- any time with different emails to change the roster.
insert into public.admin_allowlist (email, name, active) values
  ('rupayandas2024@gmail.com', 'Rupayan', true),
  ('jaggik8888@gmail.com',     'Jaggik',  true)
on conflict (email) do update
  set name   = excluded.name,
      active = excluded.active;