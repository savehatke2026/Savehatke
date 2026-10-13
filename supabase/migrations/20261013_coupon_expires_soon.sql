-- ============================================
-- SaveHatke — "Expires Soon" coupon flag
-- ============================================
-- Admin switch per coupon. When TRUE the coupon shows an "Expires Soon" badge
-- on the card and is EXCLUDED from the last-24-hours 10% pricing rule (it keeps
-- its standard normal price for the whole life of the coupon).
--
-- Backward-compatible:
--   • the column is added with DEFAULT false, so every existing row reads FALSE
--     and keeps exactly the price and badge state it has today
--   • the app also treats NULL as false, so it runs correctly before this
--     migration is applied; writes that carry the flag are only sent when the
--     admin actually touches it
--   • no expiry date, face value, seller payout or status is rewritten
--
-- Apply by pasting into the Supabase SQL editor. Idempotent.

ALTER TABLE public.coupons
  ADD COLUMN IF NOT EXISTS expires_soon BOOLEAN NOT NULL DEFAULT false;
