-- SaveHatke: server-only marketplace user activity samples.
-- One sample per heartbeat (normally every 5 minutes) and 15-minute IST slot.
create table if not exists public.user_activity_intervals (
  id bigint generated always as identity primary key,
  user_id text not null,
  email text not null,
  activity_date date not null,
  interval_slot smallint not null check (interval_slot between 0 and 95),
  session_id uuid not null,
  seen_at timestamptz not null default now(),
  page text not null default ''
);
create unique index if not exists user_activity_intervals_user_date_slot_uidx
  on public.user_activity_intervals (user_id, activity_date, interval_slot);
create index if not exists user_activity_intervals_date_slot_idx
  on public.user_activity_intervals (activity_date desc, interval_slot);
create index if not exists user_activity_intervals_user_date_idx
  on public.user_activity_intervals (user_id, activity_date desc);
alter table public.user_activity_intervals enable row level security;
-- No client policies: reads/writes go through the backend service-role client only.
