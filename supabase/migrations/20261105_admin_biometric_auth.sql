-- SaveHatke admin passkey storage.
-- The tables are server-only: the backend accesses them with the Supabase
-- service-role client after verifying the admin allowlist/session.

create table if not exists public.admin_passkey_credentials (
  id uuid primary key default gen_random_uuid(),
  admin_email text not null,
  credential_id text not null unique,
  public_key text not null,
  sign_count bigint not null default 0 check (sign_count >= 0),
  transports text[] not null default '{}',
  device_type text not null default 'unknown',
  backed_up boolean not null default false,
  label text not null default 'This device',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint admin_passkey_email_normalized
    check (admin_email = lower(trim(admin_email)))
);

create index if not exists admin_passkey_credentials_admin_email_idx
  on public.admin_passkey_credentials (admin_email)
  where revoked_at is null;

create table if not exists public.admin_auth_challenges (
  id uuid primary key default gen_random_uuid(),
  admin_email text not null,
  purpose text not null check (purpose in ('passkey_registration', 'passkey_login', 'face_enrollment', 'face_login')),
  challenge text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  constraint admin_auth_challenges_email_normalized
    check (admin_email = lower(trim(admin_email))),
  constraint admin_auth_challenges_expiry
    check (expires_at > created_at)
);

create index if not exists admin_auth_challenges_lookup_idx
  on public.admin_auth_challenges (id, admin_email, purpose);

create index if not exists admin_auth_challenges_expiry_idx
  on public.admin_auth_challenges (expires_at)
  where used_at is null;

-- Face reference images remain in a private encrypted S3 bucket. This table
-- stores only the object key and enrollment metadata, never image/video bytes.
create table if not exists public.admin_biometric_enrollments (
  id uuid primary key default gen_random_uuid(),
  admin_email text not null,
  provider text not null check (provider in ('aws_rekognition')),
  reference_image_key text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  consent_version text not null,
  consented_at timestamptz not null,
  enrolled_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint admin_biometric_email_normalized
    check (admin_email = lower(trim(admin_email)))
);

create unique index if not exists admin_biometric_one_active_enrollment_idx
  on public.admin_biometric_enrollments (admin_email, provider)
  where status = 'active';

create table if not exists public.admin_biometric_audit (
  id uuid primary key default gen_random_uuid(),
  admin_email text not null,
  method text not null check (method in ('passkey', 'face')),
  event text not null,
  outcome text not null check (outcome in ('success', 'failure', 'revoked', 'enrolled')),
  request_id text,
  created_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb,
  constraint admin_biometric_audit_email_normalized
    check (admin_email = lower(trim(admin_email)))
);

create index if not exists admin_biometric_audit_email_created_idx
  on public.admin_biometric_audit (admin_email, created_at desc);

-- No browser role may read or write biometric credentials, challenges, face
-- references or audit data. Service-role access bypasses RLS and is kept in
-- backend environment variables only.
alter table public.admin_passkey_credentials enable row level security;
alter table public.admin_auth_challenges enable row level security;
alter table public.admin_biometric_enrollments enable row level security;
alter table public.admin_biometric_audit enable row level security;

revoke all on public.admin_passkey_credentials from anon, authenticated;
revoke all on public.admin_auth_challenges from anon, authenticated;
revoke all on public.admin_biometric_enrollments from anon, authenticated;
revoke all on public.admin_biometric_audit from anon, authenticated;

grant all on public.admin_passkey_credentials to service_role;
grant all on public.admin_auth_challenges to service_role;
grant all on public.admin_biometric_enrollments to service_role;
grant all on public.admin_biometric_audit to service_role;
