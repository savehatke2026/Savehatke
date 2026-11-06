-- Cross-instance seller payout reservations.
-- All reservation mutations for a seller are serialized with a transaction-scoped
-- advisory lock. Amounts retain two decimal places (INR paise).

create table if not exists public.seller_payout_reservations (
  reservation_id text primary key,
  payout_id text not null unique,
  seller_email text not null,
  amount numeric(14,2) not null check (amount > 0),
  status text not null default 'reserved'
    check (status in ('reserved','processing','settled','released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists seller_payout_reservations_active_seller_idx
  on public.seller_payout_reservations (seller_email, status)
  where status in ('reserved','processing');

alter table public.seller_payout_reservations enable row level security;
revoke all on table public.seller_payout_reservations from public, anon, authenticated;
grant all on table public.seller_payout_reservations to service_role;

create or replace function public.reserve_seller_payout(
  p_reservation_id text,
  p_payout_id text,
  p_seller_email text,
  p_amount numeric,
  p_earned_amount numeric,
  p_paid_amount numeric
) returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_seller_email,'')));
  v_existing public.seller_payout_reservations%rowtype;
  v_reserved numeric(14,2);
  v_available numeric(14,2);
begin
  if nullif(btrim(coalesce(p_reservation_id,'')),'') is null
     or nullif(btrim(coalesce(p_payout_id,'')),'') is null
     or v_email = ''
     or p_amount is null or p_amount <= 0
     or p_earned_amount is null or p_earned_amount < 0
     or p_paid_amount is null or p_paid_amount < 0 then
    raise exception 'Invalid seller payout reservation input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_email, 0));

  select * into v_existing
  from public.seller_payout_reservations
  where reservation_id = p_reservation_id or payout_id = p_payout_id
  limit 1
  for update;

  if found then
    return v_existing.reservation_id = p_reservation_id
      and v_existing.payout_id = p_payout_id
      and v_existing.seller_email = v_email
      and v_existing.amount = round(p_amount,2)
      and v_existing.status in ('reserved','processing');
  end if;

  select coalesce(sum(amount),0) into v_reserved
  from public.seller_payout_reservations
  where seller_email = v_email and status in ('reserved','processing');

  v_available := round(p_earned_amount - p_paid_amount - v_reserved, 2);
  if round(p_amount,2) > v_available then return false; end if;

  insert into public.seller_payout_reservations(
    reservation_id,payout_id,seller_email,amount,status
  ) values (
    p_reservation_id,p_payout_id,v_email,round(p_amount,2),'reserved'
  );
  return true;
exception when unique_violation then
  return false;
end;
$$;

create or replace function public.claim_seller_payout_reservation(
  p_reservation_id text
) returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare v_updated integer;
begin
  update public.seller_payout_reservations
  set status='processing', updated_at=now()
  where reservation_id=p_reservation_id and status='reserved';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function public.finish_seller_payout_reservation(
  p_reservation_id text,
  p_status text
) returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare v_updated integer;
begin
  if p_status not in ('settled','released') then
    raise exception 'Invalid seller payout reservation final state';
  end if;
  update public.seller_payout_reservations
  set status=p_status, updated_at=now(), finished_at=now()
  where reservation_id=p_reservation_id and status in ('reserved','processing');
  get diagnostics v_updated = row_count;
  if v_updated = 1 then return true; end if;
  return exists (
    select 1 from public.seller_payout_reservations
    where reservation_id=p_reservation_id and status=p_status
  );
end;
$$;

revoke all on function public.reserve_seller_payout(text,text,text,numeric,numeric,numeric)
  from public, anon, authenticated;
revoke all on function public.claim_seller_payout_reservation(text)
  from public, anon, authenticated;
revoke all on function public.finish_seller_payout_reservation(text,text)
  from public, anon, authenticated;
grant execute on function public.reserve_seller_payout(text,text,text,numeric,numeric,numeric)
  to service_role;
grant execute on function public.claim_seller_payout_reservation(text)
  to service_role;
grant execute on function public.finish_seller_payout_reservation(text,text)
  to service_role;
