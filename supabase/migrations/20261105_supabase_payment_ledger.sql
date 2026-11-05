-- ============================================
-- SaveHatke — Supabase payment ledger
-- ============================================
-- Apply this migration BEFORE deploying the Supabase-backed paymentStore.
-- Existing Google Sheets tabs (Orders, Payments, PaymentNotifications) are
-- retained as a read-only migration/backup source; the application stops
-- writing to them after cutover.
--
-- All tables are accessed from server code with SUPABASE_SERVICE_KEY only.
-- RLS is enabled and browser roles receive no table privileges.

CREATE TABLE IF NOT EXISTS public.orders (
  id                text PRIMARY KEY,
  order_code        text NOT NULL DEFAULT '',
  user_id           text NOT NULL DEFAULT '',
  user_email        text NOT NULL DEFAULT '',
  coupon_id         text NOT NULL DEFAULT '',
  amount            numeric(12,2) NOT NULL DEFAULT 0,
  currency          text NOT NULL DEFAULT 'INR',
  status            text NOT NULL DEFAULT 'PENDING',
  buyer_name        text NOT NULL DEFAULT '',
  buyer_email       text NOT NULL DEFAULT '',
  buyer_phone       text NOT NULL DEFAULT '',
  coupon_code       text NOT NULL DEFAULT '',
  coupon_brand      text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz,
  paid_at           timestamptz,
  transaction_id    text,
  transaction_type  text,
  coupon_snapshot   text
);

CREATE TABLE IF NOT EXISTS public.payments (
  payment_id               text PRIMARY KEY,
  order_id                 text NOT NULL,
  user_id                  text NOT NULL DEFAULT '',
  user_email               text NOT NULL DEFAULT '',
  coupon_id                text NOT NULL DEFAULT '',
  amount                   numeric(12,2) NOT NULL DEFAULT 0,
  received_amount          numeric(12,2),
  currency                 text NOT NULL DEFAULT 'INR',
  status                   text NOT NULL DEFAULT 'PENDING',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz,
  check_expires_at         timestamptz,
  payment_expires_at       timestamptz,
  verification_started_at  timestamptz,
  verification_deadline    timestamptz,
  last_checked_at          timestamptz,
  paid_at                  timestamptz,
  upi_id                   text NOT NULL DEFAULT '',
  payee_name               text NOT NULL DEFAULT '',
  upi_uri                  text NOT NULL DEFAULT '',
  verified_transaction_id  text NOT NULL DEFAULT '',
  verified_utr             text NOT NULL DEFAULT '',
  verification_source      text NOT NULL DEFAULT '',
  verification_notes       text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS public.payment_notifications (
  id                 text PRIMARY KEY,
  fingerprint        text NOT NULL,
  source             text NOT NULL DEFAULT 'unknown',
  amount             numeric(12,2),
  currency           text NOT NULL DEFAULT 'INR',
  transaction_id     text NOT NULL DEFAULT '',
  utr                text NOT NULL DEFAULT '',
  payer_vpa          text NOT NULL DEFAULT '',
  payee_vpa          text NOT NULL DEFAULT '',
  reference          text NOT NULL DEFAULT '',
  occurred_at        timestamptz,
  status             text NOT NULL DEFAULT 'RECEIVED',
  matched_payment_id text NOT NULL DEFAULT '',
  notes              text NOT NULL DEFAULT '',
  raw                jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz
);

-- Natural identifiers and race-prevention constraints.
CREATE UNIQUE INDEX IF NOT EXISTS orders_order_code_unique
  ON public.orders (order_code)
  WHERE order_code <> '';

CREATE UNIQUE INDEX IF NOT EXISTS orders_transaction_id_unique
  ON public.orders (transaction_id)
  WHERE transaction_id IS NOT NULL AND transaction_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS payments_one_pending_per_order
  ON public.payments (order_id)
  WHERE status = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS payments_one_pending_per_buyer_coupon
  ON public.payments (user_id, coupon_id)
  WHERE status = 'PENDING' AND coupon_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS payments_paid_transaction_id_unique
  ON public.payments (verified_transaction_id)
  WHERE status = 'PAID' AND verified_transaction_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS payments_paid_utr_unique
  ON public.payments (verified_utr)
  WHERE status = 'PAID' AND verified_utr <> '';

CREATE UNIQUE INDEX IF NOT EXISTS payment_notifications_fingerprint_unique
  ON public.payment_notifications (fingerprint);

CREATE INDEX IF NOT EXISTS payments_status_created_at_idx
  ON public.payments (status, created_at DESC);

CREATE INDEX IF NOT EXISTS payments_order_id_created_at_idx
  ON public.payments (order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_notifications_amount_occurred_at_idx
  ON public.payment_notifications (amount, occurred_at DESC);

-- Keep every financial table private to server-side service-role operations.
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.orders FROM anon, authenticated;
REVOKE ALL ON TABLE public.payments FROM anon, authenticated;
REVOKE ALL ON TABLE public.payment_notifications FROM anon, authenticated;
GRANT ALL ON TABLE public.orders TO service_role;
GRANT ALL ON TABLE public.payments TO service_role;
GRANT ALL ON TABLE public.payment_notifications TO service_role;

-- Atomically move a payment and its parent order to a matching state.
-- The payment row lock and expected-status check serialize competing
-- settlement attempts across serverless instances. Any error (including a
-- missing order row) rolls back BOTH updates.
CREATE OR REPLACE FUNCTION public.savehatke_update_payment_order(
  p_payment_id text,
  p_expected_status text,
  p_payment_patch jsonb,
  p_order_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_order public.orders%ROWTYPE;
BEGIN
  SELECT * INTO v_payment
  FROM public.payments
  WHERE payment_id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'updated', false,
      'reason', 'PAYMENT_NOT_FOUND'
    );
  END IF;

  -- Repeated settlement for the same payment is successful but has no side
  -- effects. This makes a retry after an interrupted response idempotent.
  IF v_payment.status = 'PAID' AND p_payment_patch->>'status' = 'PAID' THEN
    SELECT * INTO v_order
    FROM public.orders
    WHERE id = v_payment.order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Payment % references missing order %',
        p_payment_id, v_payment.order_id;
    END IF;
    RETURN jsonb_build_object(
      'updated', true,
      'idempotent', true,
      'payment', to_jsonb(v_payment),
      'order', to_jsonb(v_order)
    );
  END IF;

  IF v_payment.status <> p_expected_status THEN
    RETURN jsonb_build_object(
      'updated', false,
      'reason', 'STATUS_MISMATCH',
      'payment_status', v_payment.status
    );
  END IF;

  UPDATE public.payments AS p
  SET
    status = COALESCE(NULLIF(p_payment_patch->>'status', ''), p.status),
    paid_at = CASE WHEN p_payment_patch ? 'paid_at'
      THEN NULLIF(p_payment_patch->>'paid_at', '')::timestamptz ELSE p.paid_at END,
    updated_at = COALESCE(NULLIF(p_payment_patch->>'updated_at', '')::timestamptz, p.updated_at),
    received_amount = CASE WHEN p_payment_patch ? 'received_amount'
      THEN NULLIF(p_payment_patch->>'received_amount', '')::numeric ELSE p.received_amount END,
    verified_transaction_id = CASE WHEN p_payment_patch ? 'verified_transaction_id'
      THEN p_payment_patch->>'verified_transaction_id' ELSE p.verified_transaction_id END,
    verified_utr = CASE WHEN p_payment_patch ? 'verified_utr'
      THEN p_payment_patch->>'verified_utr' ELSE p.verified_utr END,
    verification_source = CASE WHEN p_payment_patch ? 'verification_source'
      THEN p_payment_patch->>'verification_source' ELSE p.verification_source END,
    verification_notes = CASE WHEN p_payment_patch ? 'verification_notes'
      THEN p_payment_patch->>'verification_notes' ELSE p.verification_notes END
  WHERE p.payment_id = p_payment_id
  RETURNING * INTO v_payment;

  UPDATE public.orders AS o
  SET
    status = COALESCE(NULLIF(p_order_patch->>'status', ''), o.status),
    paid_at = CASE WHEN p_order_patch ? 'paid_at'
      THEN NULLIF(p_order_patch->>'paid_at', '')::timestamptz ELSE o.paid_at END,
    updated_at = COALESCE(NULLIF(p_order_patch->>'updated_at', '')::timestamptz, o.updated_at)
  WHERE o.id = v_payment.order_id
  RETURNING * INTO v_order;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % references missing order %',
      p_payment_id, v_payment.order_id;
  END IF;

  RETURN jsonb_build_object(
    'updated', true,
    'idempotent', false,
    'payment', to_jsonb(v_payment),
    'order', to_jsonb(v_order)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.savehatke_update_payment_order(text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.savehatke_update_payment_order(text, text, jsonb, jsonb)
  TO service_role;
