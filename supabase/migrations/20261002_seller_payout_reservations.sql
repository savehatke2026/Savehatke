-- A server-owned reservation ledger prevents concurrent seller payout requests
-- and administrator settlements from paying more than verified coupon earnings.
CREATE TABLE IF NOT EXISTS public.seller_payout_reservations (
  reservation_id UUID PRIMARY KEY,
  payout_id TEXT NOT NULL UNIQUE,
  seller_email TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'processing', 'settled', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS seller_payout_reservations_active_by_seller
  ON public.seller_payout_reservations (seller_email)
  WHERE status IN ('reserved', 'processing');

ALTER TABLE public.seller_payout_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seller_payout_reservations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.seller_payout_reservations TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_seller_payout(
  p_reservation_id UUID,
  p_payout_id TEXT,
  p_seller_email TEXT,
  p_amount INTEGER,
  p_earned_amount INTEGER,
  p_paid_amount INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT := lower(trim(coalesce(p_seller_email, '')));
  v_reserved BIGINT;
  v_existing public.seller_payout_reservations%ROWTYPE;
BEGIN
  IF p_reservation_id IS NULL OR nullif(trim(coalesce(p_payout_id, '')), '') IS NULL
     OR v_email = '' OR p_amount IS NULL OR p_amount <= 0
     OR p_earned_amount IS NULL OR p_earned_amount < 0
     OR p_paid_amount IS NULL OR p_paid_amount < 0 THEN
    RETURN FALSE;
  END IF;

  -- Serialize financial reservations for one seller across all app instances.
  PERFORM pg_advisory_xact_lock(hashtextextended('savehatke-payout:' || v_email, 0));

  SELECT * INTO v_existing
    FROM public.seller_payout_reservations
    WHERE reservation_id = p_reservation_id;
  IF FOUND THEN
    RETURN v_existing.seller_email = v_email
       AND v_existing.payout_id = p_payout_id
       AND v_existing.amount = p_amount
       AND v_existing.status = 'reserved';
  END IF;

  -- One settlement reservation lifecycle per payout row. This also blocks
  -- replay from another Vercel instance after the Sheets cache is stale.
  IF EXISTS (SELECT 1 FROM public.seller_payout_reservations WHERE payout_id = p_payout_id) THEN
    RETURN FALSE;
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_reserved
    FROM public.seller_payout_reservations
    WHERE seller_email = v_email AND status IN ('reserved', 'processing');

  IF p_paid_amount::BIGINT + v_reserved + p_amount > p_earned_amount THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.seller_payout_reservations
    (reservation_id, payout_id, seller_email, amount, status)
  VALUES (p_reservation_id, p_payout_id, v_email, p_amount, 'reserved');
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_seller_payout_reservation(
  p_reservation_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
BEGIN
  SELECT seller_email INTO v_email
    FROM public.seller_payout_reservations
    WHERE reservation_id = p_reservation_id AND status = 'reserved';
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('savehatke-payout:' || v_email, 0));
  UPDATE public.seller_payout_reservations
    SET status = 'processing', updated_at = now()
    WHERE reservation_id = p_reservation_id AND status = 'reserved';
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_seller_payout_reservation(
  p_reservation_id UUID,
  p_status TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('settled', 'released') THEN
    RETURN FALSE;
  END IF;

  SELECT seller_email INTO v_email
    FROM public.seller_payout_reservations
    WHERE reservation_id = p_reservation_id;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('savehatke-payout:' || v_email, 0));
  UPDATE public.seller_payout_reservations
    SET status = p_status, updated_at = now()
    WHERE reservation_id = p_reservation_id AND status IN ('reserved', 'processing');
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_seller_payout(UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_seller_payout_reservation(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_seller_payout_reservation(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_seller_payout(UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_seller_payout_reservation(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_seller_payout_reservation(UUID, TEXT) TO service_role;
