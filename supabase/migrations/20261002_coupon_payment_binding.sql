-- Bind a sold coupon to the exact verified payment that caused the unlock.
-- This makes repeated settlement for one payment idempotent while preventing
-- a second payment for the same buyer from receiving another reveal.
ALTER TABLE public.coupons
  ADD COLUMN IF NOT EXISTS sold_payment_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS coupons_sold_payment_id_unique
  ON public.coupons (sold_payment_id)
  WHERE sold_payment_id IS NOT NULL AND sold_payment_id <> '';
