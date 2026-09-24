-- ============================================
-- SaveHatke — security_credentials: multi-service support (Payment Gmail + Google Drive)
-- ============================================
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- SAFE TO RUN ONCE, and IDEMPOTENT (re-running is a no-op).
--
-- Prereq: the rename migration
--   20260924_rename_payment_mailbox_to_security_credentials.sql
-- should be applied first. This file is defensive: if the table is still named
-- payment_mailbox_credentials it renames it first, so it also works standalone.
--
-- WHAT THIS DOES
--   * Adds a `service` discriminator column so ONE table can hold the
--     Payment Gmail credential AND the Google Drive credential:
--         service = 'payment_gmail'  (email = rupayandas2024@gmail.com)
--         service = 'google_drive'   (email = database.savehatke@gmail.com)
--     with a CHECK constraint restricting it to those two values.
--   * Backfills every existing row to service = 'payment_gmail' (the table only
--     ever held the payment mailbox credential before this change).
--   * Replaces UNIQUE(email) with a composite UNIQUE(service, email) so the same
--     address could in theory serve two services, and each (service,email) pair
--     is stored exactly once (OAuth reconnect UPSERTs the same row).
--   * Adds lookup indexes on (service, email) and (service, status).
--
-- WHAT THIS DOES NOT DO
--   * NEVER drops the table, NEVER deletes a row, NEVER touches the encrypted
--     tokens, timestamps, or status values. It does not create a second table.

-- ── 0) Defensive rename (only if the rename migration was skipped) ────────────
do $$
begin
  if to_regclass('public.payment_mailbox_credentials') is not null
     and to_regclass('public.security_credentials') is null then
    alter table public.payment_mailbox_credentials rename to security_credentials;
  end if;
end $$;

-- Make sure the table exists (fresh environments) with the full shape.
create table if not exists public.security_credentials (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  encrypted_refresh_token text not null,
  status text not null default 'active'
    check (status in ('active', 'reauthorization_required', 'error', 'disconnected')),
  connected_at         timestamptz not null default now(),
  authorized_at        timestamptz,
  estimated_expires_at timestamptz,
  last_verified_at     timestamptz,
  last_used_at         timestamptz,
  last_error           text,
  updated_at           timestamptz not null default now()
);

-- ── 1) Add the service discriminator (nullable first so backfill is safe) ─────
alter table public.security_credentials
  add column if not exists service text;

-- Backfill any pre-existing row: the table only held the payment mailbox before.
update public.security_credentials
   set service = 'payment_gmail'
 where service is null;

-- Enforce NOT NULL now that every row has a value.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'security_credentials'
               and column_name = 'service' and is_nullable = 'YES') then
    alter table public.security_credentials alter column service set not null;
  end if;
end $$;

-- Restrict service to the two allowed values (guarded; add only once).
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'security_credentials_service_check'
                   and conrelid = 'public.security_credentials'::regclass) then
    alter table public.security_credentials
      add constraint security_credentials_service_check
      check (service in ('payment_gmail', 'google_drive'));
  end if;
end $$;

-- ── 2) Swap UNIQUE(email) → UNIQUE(service, email) ────────────────────────────
-- Drop the old single-column unique (whatever it is named) if present.
do $$
begin
  if exists (select 1 from pg_constraint
             where conname = 'security_credentials_email_key'
               and conrelid = 'public.security_credentials'::regclass) then
    alter table public.security_credentials drop constraint security_credentials_email_key;
  end if;
  -- Also handle the pre-rename legacy name, just in case.
  if exists (select 1 from pg_constraint
             where conname = 'payment_mailbox_credentials_email_key'
               and conrelid = 'public.security_credentials'::regclass) then
    alter table public.security_credentials drop constraint payment_mailbox_credentials_email_key;
  end if;
end $$;

-- Add the composite unique (guarded).
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'security_credentials_service_email_key'
                   and conrelid = 'public.security_credentials'::regclass) then
    alter table public.security_credentials
      add constraint security_credentials_service_email_key unique (service, email);
  end if;
end $$;

-- ── 3) Lookup indexes ─────────────────────────────────────────────────────────
create index if not exists security_credentials_service_email_idx
  on public.security_credentials (service, email);
create index if not exists security_credentials_service_status_idx
  on public.security_credentials (service, status);

-- ── 4) Re-assert Row Level Security posture (unchanged) ───────────────────────
alter table public.security_credentials enable row level security;
revoke all on public.security_credentials from anon, authenticated;

-- ── 5) Verification (safe fields only; the token is never selected) ───────────
--   select service, email, status, connected_at, authorized_at,
--          estimated_expires_at, last_verified_at, last_used_at, updated_at
--     from public.security_credentials order by service;
--   select conname from pg_constraint
--    where conrelid = 'public.security_credentials'::regclass;
--   select indexname from pg_indexes where tablename = 'security_credentials';
