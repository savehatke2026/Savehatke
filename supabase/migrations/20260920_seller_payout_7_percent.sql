-- ============================================
-- SaveHatke — Supabase migration: 7% seller payout on face value
-- ============================================
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Everything here is idempotent, so re-running it is safe.
--
-- This ALTERs the EXISTING public.coupons table. It does NOT create a second
-- coupon table, and it never touches original_value, selling_price or any row
-- in the payout ledger.
--
-- Model: a seller's payout is 7% of the coupon's face value
-- (original_value), rounded to the nearest paise, and only for face values
-- between ₹100 and ₹10,000 inclusive. There is no clamp: ₹100 pays ₹7, not
-- ₹100. Admin marketplace coupons outside that range stay usable — they simply
-- carry a NULL seller_payout and are ineligible for a payout.
--
-- Until this is applied:
--   • the server still computes and stores the payout in the Sheets mirror
--   • Supabase writes of an eligible seller coupon will fail because the
--     seller_payout column does not exist yet
-- Apply it before taking new seller submissions.

-- ── 1) Add the stored payout column ─────────────────────────────────────
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS seller_payout numeric(12,2);

-- ── 2) Backfill ONLY rows with a strict decimal ORIGINAL face value ──────
-- The pattern is a strict decimal: digits, optional dot + 1–2 decimals. Any
-- other original_value (empty, "N/A", "₹500", "5,00" …) is left NULL so it is
-- visibly ineligible instead of being guessed at. selling_price is irrelevant
-- to the payout and is never read here.
UPDATE public.coupons
SET seller_payout = ROUND(btrim(original_value)::numeric * 0.07, 2)
WHERE seller_payout IS NULL
  AND original_value IS NOT NULL
  AND btrim(original_value) ~ '^[0-9]+([.][0-9]{1,2})?$'
  AND btrim(original_value)::numeric >= 100
  AND btrim(original_value)::numeric <= 10000;

-- ── 3) Enforce the rule on every future insert / update ─────────────────
-- The trigger:
--   (a) rejects an invalid face value on a seller submission (INSERT, or an
--       UPDATE that changes the face value / source) — but leaves unrelated
--       edits to legacy invalid rows alone;
--   (b) freezes the face value once the coupon is sold;
--   (c) always recomputes seller_payout from the face value, so a directly
--       supplied payout can never disagree with the 7% rule, and clears it to
--       NULL when the face value is ineligible.
CREATE OR REPLACE FUNCTION public.enforce_seller_payout_7_percent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  face_text  text;
  face       numeric;
  valid_face boolean;
  is_seller  boolean;
BEGIN
  face_text := btrim(coalesce(NEW.original_value, ''));

  IF face_text ~ '^[0-9]+([.][0-9]{1,2})?$' THEN
    face := face_text::numeric;
    valid_face := face >= 100 AND face <= 10000;
  ELSE
    valid_face := false;
  END IF;

  is_seller := lower(coalesce(NEW.source, '')) = 'user-submitted';

  -- (a) Seller submissions must carry a valid face value. Only checked when the
  --     face value (or source) is being written, so a legacy invalid row can
  --     still be updated on unrelated fields.
  IF is_seller AND NOT valid_face THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION
        'Coupon face value must be between 100 and 10000 for a seller submission.'
        USING ERRCODE = 'check_violation';
    ELSIF NEW.original_value IS DISTINCT FROM OLD.original_value
       OR NEW.source IS DISTINCT FROM OLD.source THEN
      RAISE EXCEPTION
        'Coupon face value must be between 100 and 10000 for a seller submission.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- (b) A sold coupon's face value is frozen.
  IF TG_OP = 'UPDATE' THEN
    IF lower(coalesce(OLD.status, '')) = 'sold'
       AND NEW.original_value IS DISTINCT FROM OLD.original_value THEN
      RAISE EXCEPTION
        'Coupon face value cannot change after the coupon is sold.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- (c) Enforce the payout. The stored value is always derived here.
  IF valid_face THEN
    NEW.seller_payout := ROUND(face * 0.07, 2);
  ELSE
    IF TG_OP = 'INSERT' THEN
      NEW.seller_payout := NULL;
    ELSIF NEW.original_value IS DISTINCT FROM OLD.original_value THEN
      NEW.seller_payout := NULL;
    ELSE
      -- Unrelated update to an ineligible (legacy) row: keep what is stored and
      -- ignore any direct override of seller_payout.
      NEW.seller_payout := OLD.seller_payout;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_coupons_seller_payout_7_percent ON public.coupons;
CREATE TRIGGER trg_coupons_seller_payout_7_percent
  BEFORE INSERT OR UPDATE ON public.coupons
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_seller_payout_7_percent();
