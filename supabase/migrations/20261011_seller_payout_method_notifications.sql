-- Records the "add your payout method" notification per seller. One row per
-- seller, so a seller is emailed at most once until a payout method is saved.
-- The unique seller_email key is what makes the claim atomic: concurrent approvals
-- or retries race on INSERT ... ON CONFLICT, and only one caller wins the claim.
--
-- Payment details are NOT stored here. The authoritative source stays the
-- SellerPayoutDetails sheet tab; this table only tracks notification state.
CREATE TABLE IF NOT EXISTS public.seller_payout_method_notifications (
  seller_email TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.seller_payout_method_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seller_payout_method_notifications FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.seller_payout_method_notifications TO service_role;
