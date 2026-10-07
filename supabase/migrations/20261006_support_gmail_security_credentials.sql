-- ============================================
-- SaveHatke — Support Mailbox joins security_credentials
-- ============================================
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent: re-running is safe.
--
-- The Support Mailbox Gmail OAuth credential (refresh token) is stored in the
-- EXISTING public.security_credentials table — the same server-only store that
-- already holds payment_gmail and google_drive — as a new service value:
--
--     service = 'support_gmail'
--
-- No new table is created. The refresh token is stored AES-256-GCM ENCRYPTED
-- (server/services/gmailCrypto.js, key = SUPPORT_MAILBOX_TOKEN_ENCRYPTION_KEY,
-- falling back to GMAIL_TOKEN_ENCRYPTION_KEY). Plaintext tokens never enter
-- this table, the browser, or Git.
--
-- The only schema change required: extend the service CHECK constraint to
-- accept the new 'support_gmail' value. Row Level Security / grants below are
-- re-asserted defensively (idempotent) so the support token gets exactly the
-- same server-only protection as payment_gmail and google_drive.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'security_credentials_service_check'
      and conrelid = 'public.security_credentials'::regclass
      and pg_get_constraintdef(oid) like '%support_gmail%'
  ) then
    alter table public.security_credentials
      drop constraint security_credentials_service_check;
    alter table public.security_credentials
      add constraint security_credentials_service_check
      check (service = any (array['payment_gmail'::text, 'google_drive'::text, 'support_gmail'::text]));
  end if;
end
$$;

-- Defensive re-assertion (idempotent) — server-only access, matching the
-- 20261002 convention for this table.
alter table public.security_credentials enable row level security;
revoke all on public.security_credentials from PUBLIC, anon, authenticated;
grant all on public.security_credentials to service_role;

-- NOTE: no data changes here. The support mailbox row (service='support_gmail')
-- is created by the one-time migration script
-- (server/scripts/migrate-support-gmail-to-supabase.js) or by the admin OAuth
-- reconnect flow. The refresh token is NEVER inserted in plaintext and NEVER
-- committed to source control.
