-- ============================================
-- SaveHatke — Canonical transaction identifiers on `refunds`
-- ============================================
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent: re-running is safe (ADD COLUMN IF NOT EXISTS / CREATE INDEX
-- IF NOT EXISTS). It does NOT touch amounts, status, RLS, or any other table.
--
-- WHY
--   Every financial record now carries three separate, standardized fields:
--     order_id         SH-<TYPE>-YYYYMMDD-XXXXXX   (the record's Order ID)
--     transaction_id   TXN-YYYYMMDD-XXXXXXXX       (the financial transaction)
--     transaction_type PURCHASE | REFUND | SELLER_PAYOUT
--   For a refund row: order_id is SH-REF-…, transaction_type is always
--   'REFUND'. `refund_id` (business key) and `order_code` (a REFERENCE to the
--   original purchase order being refunded) are unchanged and kept.
--
-- BACKWARD COMPATIBILITY
--   Existing refunds predate these columns. They are added NULLable so old
--   rows are untouched and never regenerated. The app reads them with a
--   fallback (refund_id for the id, 'REFUND' for the type). Only NEW refunds
--   are minted with the canonical ids.

alter table public.refunds add column if not exists order_id text;
alter table public.refunds add column if not exists transaction_id text;
alter table public.refunds add column if not exists transaction_type text
  not null default 'REFUND';

-- Keep transaction_type honest to the canonical vocabulary. Added as NOT VALID
-- first would require a validate step; since the column is server-set and
-- defaults to 'REFUND', a plain CHECK added conditionally is safe. Guard so a
-- re-run does not error on an already-present constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'refunds_transaction_type_check2'
  ) then
    alter table public.refunds
      add constraint refunds_transaction_type_check2
      check (transaction_type in ('PURCHASE', 'REFUND', 'SELLER_PAYOUT'));
  end if;
end $$;

-- order_id is indexed for lookups/joins (per the ID spec). Not unique: a
-- refund's order_id is its own SH-REF id, but we index rather than constrain
-- so a hypothetical backfill cannot hard-fail on a legacy blank.
create index if not exists refunds_order_id_idx on public.refunds (order_id);

-- transaction_id MUST be globally unique and never reused. A UNIQUE index over
-- a NULLable column still permits many legacy NULLs (Postgres treats NULLs as
-- distinct), so old rows coexist while every new TXN-… is guaranteed unique.
create unique index if not exists refunds_transaction_id_unique
  on public.refunds (transaction_id);
