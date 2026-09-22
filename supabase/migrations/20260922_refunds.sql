-- ============================================
-- SaveHatke — Refunds table for payment-amount mismatches
-- ============================================
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent: re-running is safe.
--
-- This migration creates ONE new table: `refunds`. It does NOT touch the
-- existing `coupons`, `users`, or any other table. Refund amounts are
-- stored as integer paise (numeric(12,0)) to avoid binary FP drift, and
-- every monetary field is constrained to be non-negative.
--
-- The Google Sheets `Refunds` tab is the canonical mirror of this table,
-- but Supabase holds the structured source of truth that the user-facing
-- dashboard reads from. Row Level Security (RLS) is enabled so a user
-- can ONLY see their own refunds, and can NEVER mutate the verified
-- amounts or the status — those fields are server-set.

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),

  -- Business key — matches the Sheets row's `id` and is what we expose in
  -- URLs and notifications. Distinct from the uuid so the API can stay
  -- stable even if the underlying id is ever re-shaped.
  refund_id text not null unique,

  -- Ownership: the buyer whose account paid. user_id is the canonical
  -- SaveHatke user id (matches Users tab and the JWT subject claim).
  user_id text not null,
  user_email text not null default '',

  -- The existing payment this refund is attached to. payment_id is the
  -- same string the existing Payments sheet uses (e.g. 'pay_xxx'), and
  -- a refund is unique per payment so a second over/under event on the
  -- same payment updates the existing row, never creates a duplicate.
  payment_id text not null,
  coupon_id text not null default '',
  order_code text not null default '',

  -- Money fields. All stored as integer paise (numeric(12,0)) so a
  -- backend calculation in JS paise-land round-trips cleanly. These are
  -- ALWAYS set by the server from the verified payment, never from a
  -- client request body.
  required_amount numeric(12,0) not null check (required_amount >= 0),
  received_amount numeric(12,0) not null check (received_amount >= 0),
  refund_amount   numeric(12,0) not null check (refund_amount   >= 0),
  currency text not null default 'INR',

  -- 'overpayment' or 'underpayment'. The reason column carries the
  -- human-readable copy the user sees; mismatch_type is the canonical
  -- machine-readable value for filters and joins.
  mismatch_type text not null check (mismatch_type in ('overpayment', 'underpayment')),
  refund_reason text not null default '',

  -- Status ladder: pending → processing → refunded | rejected.
  -- Server-driven only; RLS below denies client-side updates entirely.
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'refunded', 'rejected')),

  -- Audit fields, all server-set. Filled when status transitions to a
  -- terminal state.
  refund_reference text not null default '',
  admin_note text not null default '',
  processed_at timestamptz,
  processed_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One refund per payment: a second verification event on the same payment
-- updates the existing row (a notification replay cannot mint a duplicate).
create unique index if not exists refunds_payment_id_unique
  on public.refunds (payment_id);

-- The dashboard list and admin screens both filter by user + status; these
-- indexes keep those queries cheap as the table grows.
create index if not exists refunds_user_id_idx       on public.refunds (user_id);
create index if not exists refunds_status_idx        on public.refunds (status);
create index if not exists refunds_created_at_idx    on public.refunds (created_at desc);

-- Auto-bump updated_at on UPDATE. Simpler than a trigger to wire up because
-- the function already exists in the payouts/coupons migrations.
create or replace function public.touch_refunds_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_refunds_touch_updated_at on public.refunds;
create trigger trg_refunds_touch_updated_at
  before update on public.refunds
  for each row execute function public.touch_refunds_updated_at();

-- ── Row Level Security ─────────────────────────────────────────────────────
-- The user can SELECT only their own refunds. They cannot INSERT / UPDATE /
-- DELETE — every write goes through a server-side service that uses the
-- Supabase service key (which bypasses RLS). This is the only safe shape:
-- giving the buyer INSERT or UPDATE rights would let a malicious client
-- rewrite refund_amount, received_amount, or status, which the spec
-- forbids.
alter table public.refunds enable row level security;

drop policy if exists refunds_select_own on public.refunds;
create policy refunds_select_own on public.refunds
  for select
  using (user_id = auth.jwt() ->> 'sub');

-- ── Storage mirror ─────────────────────────────────────────────────────────
-- If Supabase Storage needs to hold refund receipts later, keep the bucket
-- name aligned with this table's snake_case. Commented out so the
-- migration is pure schema — no buckets are created unless the operator
-- runs the corresponding storage snippet.
-- create bucket 'refund-receipts' if not exists;
