-- ============================================
-- SaveHatke — Rename payment_mailbox_credentials → security_credentials
-- ============================================
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- SAFE TO RUN ONCE, and IDEMPOTENT (re-running is a no-op).
--
-- WHAT THIS DOES
--   * Renames the EXISTING payment Gmail OAuth credential table
--       public.payment_mailbox_credentials  →  public.security_credentials
--     preserving every row, the encrypted_refresh_token, the email, the
--     status, all timestamps, the primary key, the unique(email) constraint,
--     the status CHECK constraint, the status index, and the updated_at
--     trigger.
--   * Renames the constraints / index / trigger for clarity.
--   * ADDS two nullable columns used by the admin panel's expiry-warning UI:
--       authorized_at        timestamptz
--       estimated_expires_at timestamptz
--   * Backfills those two columns for any existing row.
--   * Re-asserts Row Level Security (enabled, no permissive policy) and revokes
--     client-role grants so the encrypted token is never browser-readable.
--
-- WHAT THIS DOES NOT DO
--   * It NEVER drops the table, NEVER recreates it, and NEVER deletes a row.
--   * It does not touch coupons, users, refunds, sessions, or any other table.
--   * It does not insert or expose any refresh token (the token is populated by
--     the OAuth reconnect flow or server/scripts/migrate-payment-gmail-to-supabase.js).

-- ── 1) Rename the table (guarded so re-runs and fresh installs are both safe) ──
do $$
begin
  if to_regclass('public.payment_mailbox_credentials') is not null
     and to_regclass('public.security_credentials') is null then
    alter table public.payment_mailbox_credentials rename to security_credentials;
  end if;
end $$;

-- Safety net: if neither table exists yet (brand-new environment), create the
-- target table so the rest of the migration and the app have something to bind
-- to. Existing installs skip this entirely because the table already exists.
create table if not exists public.security_credentials (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  encrypted_refresh_token text not null,
  status text not null default 'active'
    check (status in ('active', 'reauthorization_required', 'error', 'disconnected')),
  connected_at     timestamptz not null default now(),
  last_verified_at timestamptz,
  last_used_at     timestamptz,
  last_error       text,
  updated_at       timestamptz not null default now()
);

-- ── 2) Add the expiry-warning columns (safe if already present) ───────────────
alter table public.security_credentials
  add column if not exists authorized_at        timestamptz,
  add column if not exists estimated_expires_at timestamptz;

-- ── 3) Rename constraints for clarity (each guarded) ──────────────────────────
do $$
begin
  if exists (select 1 from pg_constraint
             where conname = 'payment_mailbox_credentials_pkey'
               and conrelid = 'public.security_credentials'::regclass) then
    alter table public.security_credentials
      rename constraint payment_mailbox_credentials_pkey to security_credentials_pkey;
  end if;

  if exists (select 1 from pg_constraint
             where conname = 'payment_mailbox_credentials_email_key'
               and conrelid = 'public.security_credentials'::regclass) then
    alter table public.security_credentials
      rename constraint payment_mailbox_credentials_email_key to security_credentials_email_key;
  end if;

  if exists (select 1 from pg_constraint
             where conname = 'payment_mailbox_credentials_status_check'
               and conrelid = 'public.security_credentials'::regclass) then
    alter table public.security_credentials
      rename constraint payment_mailbox_credentials_status_check to security_credentials_status_check;
  end if;
end $$;

-- ── 4) Rename the status index, and guarantee it exists ───────────────────────
do $$
begin
  if to_regclass('public.payment_mailbox_credentials_status_idx') is not null
     and to_regclass('public.security_credentials_status_idx') is null then
    alter index public.payment_mailbox_credentials_status_idx
      rename to security_credentials_status_idx;
  end if;
end $$;

create index if not exists security_credentials_status_idx
  on public.security_credentials (status);

-- ── 5) Trigger: rename to the new name; keep the existing function ────────────
-- The function public.touch_payment_mailbox_updated_at() still bumps updated_at
-- correctly, so it is intentionally left in place (renaming a function is not
-- required for the trigger to keep working).
do $$
begin
  if exists (select 1 from pg_trigger
             where tgname = 'trg_payment_mailbox_touch_updated_at'
               and tgrelid = 'public.security_credentials'::regclass) then
    alter trigger trg_payment_mailbox_touch_updated_at
      on public.security_credentials
      rename to trg_security_credentials_touch_updated_at;
  end if;
end $$;

-- Ensure the function exists (fresh installs) and the trigger is bound under the
-- new name. This is idempotent: it drops only the new-named trigger, if present,
-- then recreates it.
create or replace function public.touch_payment_mailbox_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_security_credentials_touch_updated_at on public.security_credentials;
create trigger trg_security_credentials_touch_updated_at
  before update on public.security_credentials
  for each row execute function public.touch_payment_mailbox_updated_at();

-- ── 6) Backfill the new columns for existing row(s) ───────────────────────────
-- authorized_at mirrors the last successful (re)connect. estimated_expires_at
-- uses the Google "Testing" publishing-status refresh-token window (~7 days).
update public.security_credentials
   set authorized_at = coalesce(authorized_at, connected_at)
 where authorized_at is null;

update public.security_credentials
   set estimated_expires_at = coalesce(estimated_expires_at, connected_at + interval '7 days')
 where estimated_expires_at is null;

-- ── 7) Re-assert Row Level Security posture ───────────────────────────────────
-- RLS on + NO permissive policy = anon/authenticated read/write ZERO rows.
-- Only the backend service-role key (which bypasses RLS) can access it.
alter table public.security_credentials enable row level security;
revoke all on public.security_credentials from anon, authenticated;

-- ── 8) Verification (safe fields only; the token is never selected) ───────────
-- Run these after the migration to confirm the rename preserved everything:
--   select count(*) from public.security_credentials;
--   select email, status, connected_at, authorized_at, estimated_expires_at,
--          last_verified_at, last_used_at, last_error, updated_at
--     from public.security_credentials;
--   select conname from pg_constraint
--    where conrelid = 'public.security_credentials'::regclass;
--   select indexname from pg_indexes
--    where tablename = 'security_credentials';
--   select tgname from pg_trigger
--    where tgrelid = 'public.security_credentials'::regclass and not tgisinternal;
