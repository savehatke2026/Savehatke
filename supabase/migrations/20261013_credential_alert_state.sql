-- ============================================
-- SaveHatke — Credential alert notification state
-- ============================================
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- NOT applied automatically. Idempotent: re-running is safe.
--
-- Tracks which refresh-token warnings have been emailed, so the daily cron
-- never sends a duplicate for the same (service, recipient, IST day) and a
-- failed send is retried (a row is written only after a successful send).
--
-- Keys are per integration: service is one of support_gmail, google_drive,
-- payment_gmail. The row never contains a token or a secret.

CREATE TABLE IF NOT EXISTS public.credential_alert_state (
  id              bigserial PRIMARY KEY,
  service         text        NOT NULL,
  recipient       text        NOT NULL,
  alert_state     text        NOT NULL,          -- e.g. reconnect_soon, expired, reauthorization_required, error
  ist_day         date        NOT NULL,          -- calendar day in Asia/Kolkata, the dedup bucket
  sent_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_alert_state_service_check
    CHECK (service IN ('support_gmail', 'google_drive', 'payment_gmail')),
  CONSTRAINT credential_alert_state_unique
    UNIQUE (service, recipient, ist_day, alert_state)
);

-- Latest state per (service, recipient) for the "state changed" check.
CREATE INDEX IF NOT EXISTS credential_alert_state_latest_idx
  ON public.credential_alert_state (service, recipient, sent_at DESC);

-- Server-only table. RLS on with no permissive policy, so no browser client
-- can read it; the service-role key bypasses RLS (same model as security_credentials).
ALTER TABLE public.credential_alert_state ENABLE ROW LEVEL SECURITY;
