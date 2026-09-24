-- ============================================
-- SaveHatke — Payment Mailbox Gmail OAuth credential store
-- ============================================
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent: re-running is safe.
--
-- Moves the DEDICATED payment mailbox (rupayandas2024@gmail.com) Gmail OAuth
-- refresh token out of the PAYMENT_GMAIL_REFRESH_TOKEN environment variable and
-- into a single-row-per-mailbox table. Supabase becomes the source of truth for
-- the payment Gmail address, its OAuth connection status, the (encrypted)
-- refresh token, and the connection / verification / error timestamps.
--
-- SECURITY MODEL — server-only table:
--   * The refresh token is stored AES-256-GCM ENCRYPTED (see
--     server/services/gmailCrypto.js). The encryption key lives ONLY in the
--     server env (PAYMENT_GMAIL_TOKEN_ENCRYPTION_KEY) — never in this table,
--     never in the browser, never in Git.
--   * Row Level Security is enabled with NO permissive policy, so anon and
--     authenticated clients get ZERO rows. Only the backend service-role
--     connection (SUPABASE_SERVICE_KEY, which bypasses RLS) can read or write.
--   * The plaintext refresh token, the encrypted blob, Google access tokens,
--     and the client secret are NEVER returned to any browser client.
--
-- This migration creates ONE new table: `payment_mailbox_credentials`. It does
-- NOT touch coupons, users, refunds, sessions, or any existing table.

create table if not exists public.payment_mailbox_credentials (
  id uuid primary key default gen_random_uuid(),

  -- The payment inbox address. Single source of truth for which Gmail account
  -- the payment verifier reads. UNIQUE so an OAuth reconnect UPSERTs the same
  -- row instead of creating a duplicate.
  email text not null unique,

  -- AES-256-GCM encrypted Gmail refresh token, formatted as
  -- "v1.<iv>.<authTag>.<ciphertext>" (base64 parts). NEVER the raw token.
  encrypted_refresh_token text not null,

  -- Connection lifecycle:
  --   active                 → token present and last known-good
  --   reauthorization_required → Google returned invalid_grant / revoked;
  --                              the admin must reconnect (testing-mode expiry)
  --   error                  → a non-auth failure was recorded
  --   disconnected           → intentionally disconnected by an admin
  status text not null default 'active'
    check (status in ('active', 'reauthorization_required', 'error', 'disconnected')),

  -- Audit timestamps, all server-set.
  connected_at     timestamptz not null default now(),  -- last successful (re)connect
  last_verified_at timestamptz,                          -- last time the token was proven good
  last_used_at     timestamptz,                          -- last time the verifier opened the mailbox
  last_error       text,                                 -- SAFE human-readable message only
  updated_at       timestamptz not null default now()
);

-- Fast lookup by the connection status for the admin panel.
create index if not exists payment_mailbox_credentials_status_idx
  on public.payment_mailbox_credentials (status);

-- Auto-bump updated_at on UPDATE (mirrors the refunds migration pattern).
create or replace function public.touch_payment_mailbox_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_payment_mailbox_touch_updated_at on public.payment_mailbox_credentials;
create trigger trg_payment_mailbox_touch_updated_at
  before update on public.payment_mailbox_credentials
  for each row execute function public.touch_payment_mailbox_updated_at();

-- ── Row Level Security ─────────────────────────────────────────────────────
-- Enable RLS and deliberately create NO policy. With RLS on and no permissive
-- policy, anon and authenticated roles can read/write ZERO rows. Every backend
-- access goes through the Supabase SERVICE-ROLE key, which bypasses RLS. This
-- is the only safe shape for a table that holds an OAuth refresh token:
-- a normal authenticated user must never be able to read it.
alter table public.payment_mailbox_credentials enable row level security;

-- Belt-and-suspenders: revoke the default table grants from the client roles so
-- even a future accidental permissive policy cannot leak the encrypted token.
revoke all on public.payment_mailbox_credentials from anon, authenticated;

-- NOTE: the initial record for rupayandas2024@gmail.com is created by the
-- one-time migration script (server/scripts/migrate-payment-gmail-to-supabase.js)
-- or by the admin OAuth reconnect flow. The refresh token is NEVER inserted in
-- plaintext here and NEVER committed to source control.
