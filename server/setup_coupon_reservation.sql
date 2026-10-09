-- ============================================
-- SaveHatke — Supabase migration for the payment-window coupon reservation
-- ============================================
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Everything here is idempotent, so re-running it is safe.
--
-- Until it is applied the server keeps working exactly as before: reserving is
-- best-effort, payment windows open unreserved, and the atomic sold-flip still
-- prevents a double sale.
--
-- What it adds — a temporary reservation that hides a coupon from the public
-- listings (marketplace / index / categories / chatbot) while a buyer's payment
-- window is open, for the FULL 20-minute backend session (not just the visible
-- 10-minute timer):
--
--   payment window opened  → reserved_until = now + 20 min  (coupon hidden)
--   payment verified       → coupon sold (reservation fields cleared)
--   window cancelled       → reservation released (coupon visible)
--   20 minutes, no payment → reservation lapses (coupon visible again —
--                            lapsed rows simply fail the reserved_until filter,
--                            no background job is required for visibility)

-- 1) Reservation ownership on the coupon row itself. The coupon's status
--    stays 'available' while reserved — the sold-flip's
--    `WHERE status = 'available'` precondition keeps working unchanged.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ NULL;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS reserved_payment_id TEXT NULL;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS reserved_by TEXT NULL;

-- 2) Indexes.
--    a) reserved_until — the listing filter ("is there an ACTIVE reservation?")
--       and the reconcile cleanup sweep. Partial: only rows that actually
--       carry a reservation are indexed, so the common unreserved case costs
--       nothing.
--    b) reserved_payment_id — ownership-scoped release/transfer writes
--       (`WHERE reserved_payment_id = <session>`) during cancel, supersede,
--       underpayment, settlement and expiry paths.
CREATE INDEX IF NOT EXISTS idx_coupons_reserved_until
  ON coupons (reserved_until)
  WHERE reserved_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_coupons_reserved_payment_id
  ON coupons (reserved_payment_id)
  WHERE reserved_payment_id IS NOT NULL;
