-- SaveHatke atomic checkout creation + personal finance ledger.
-- Existing Sheets PersonalFinanceBalance/PersonalFinanceLedger are imported
-- once by the server-side personalFinance route before the first read/write.

create table if not exists public.personal_finance_wallet (
  id text primary key check (id = 'personal'),
  balance numeric(14,2) not null default 0 check (balance >= 0),
  imported_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.personal_finance_wallet(id,balance)
values ('personal',0) on conflict (id) do nothing;

create table if not exists public.personal_finance_ledger (
  id text primary key,
  request_id text not null unique,
  type text not null check (type in ('BALANCE_ADD','EXPENSE')),
  amount numeric(14,2) not null check (amount > 0),
  category text not null default '',
  note text not null default '',
  transaction_date date not null,
  created_at timestamptz not null default now(),
  created_by text not null default ''
);

alter table public.personal_finance_wallet enable row level security;
alter table public.personal_finance_ledger enable row level security;
revoke all on table public.personal_finance_wallet from public, anon, authenticated;
revoke all on table public.personal_finance_ledger from public, anon, authenticated;
grant all on table public.personal_finance_wallet to service_role;
grant all on table public.personal_finance_ledger to service_role;

create or replace function public.savehatke_create_checkout(p_order jsonb, p_payment jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare v_order public.orders%rowtype; v_payment public.payments%rowtype;
begin
  insert into public.orders(
    id,order_code,user_id,user_email,coupon_id,amount,currency,status,buyer_name,buyer_email,
    buyer_phone,coupon_code,coupon_brand,created_at,updated_at,expires_at,paid_at,transaction_id,
    transaction_type,coupon_snapshot
  ) values (
    p_order->>'id',coalesce(p_order->>'order_code',''),coalesce(p_order->>'user_id',''),
    coalesce(p_order->>'user_email',''),coalesce(p_order->>'coupon_id',''),
    coalesce((p_order->>'amount')::numeric,0),coalesce(p_order->>'currency','INR'),
    coalesce(p_order->>'status','PENDING'),coalesce(p_order->>'buyer_name',''),
    coalesce(p_order->>'buyer_email',''),coalesce(p_order->>'buyer_phone',''),
    coalesce(p_order->>'coupon_code',''),coalesce(p_order->>'coupon_brand',''),
    coalesce((p_order->>'created_at')::timestamptz,now()),
    coalesce((p_order->>'updated_at')::timestamptz,now()),
    nullif(p_order->>'expires_at','')::timestamptz,
    nullif(p_order->>'paid_at','')::timestamptz,
    nullif(p_order->>'transaction_id',''),nullif(p_order->>'transaction_type',''),
    nullif(p_order->>'coupon_snapshot','')
  ) returning * into v_order;

  insert into public.payments(
    payment_id,order_id,user_id,user_email,coupon_id,amount,received_amount,currency,status,
    created_at,updated_at,expires_at,check_expires_at,payment_expires_at,verification_started_at,
    verification_deadline,last_checked_at,paid_at,upi_id,payee_name,upi_uri,
    verified_transaction_id,verified_utr,verification_source,verification_notes
  ) values (
    p_payment->>'payment_id',p_payment->>'order_id',coalesce(p_payment->>'user_id',''),
    coalesce(p_payment->>'user_email',''),coalesce(p_payment->>'coupon_id',''),
    coalesce((p_payment->>'amount')::numeric,0),nullif(p_payment->>'received_amount','')::numeric,
    coalesce(p_payment->>'currency','INR'),coalesce(p_payment->>'status','PENDING'),
    coalesce((p_payment->>'created_at')::timestamptz,now()),
    coalesce((p_payment->>'updated_at')::timestamptz,now()),
    nullif(p_payment->>'expires_at','')::timestamptz,
    nullif(p_payment->>'check_expires_at','')::timestamptz,
    nullif(p_payment->>'payment_expires_at','')::timestamptz,
    nullif(p_payment->>'verification_started_at','')::timestamptz,
    nullif(p_payment->>'verification_deadline','')::timestamptz,
    nullif(p_payment->>'last_checked_at','')::timestamptz,
    nullif(p_payment->>'paid_at','')::timestamptz,
    coalesce(p_payment->>'upi_id',''),coalesce(p_payment->>'payee_name',''),
    coalesce(p_payment->>'upi_uri',''),coalesce(p_payment->>'verified_transaction_id',''),
    coalesce(p_payment->>'verified_utr',''),coalesce(p_payment->>'verification_source',''),
    coalesce(p_payment->>'verification_notes','')
  ) returning * into v_payment;
  return jsonb_build_object('order',to_jsonb(v_order),'payment',to_jsonb(v_payment));
end;
$$;
revoke all on function public.savehatke_create_checkout(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.savehatke_create_checkout(jsonb,jsonb) to service_role;

create or replace function public.savehatke_personal_finance_import(p_balance numeric, p_entries jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare v_wallet public.personal_finance_wallet%rowtype; v_count integer := 0;
begin
  select * into v_wallet from public.personal_finance_wallet where id='personal' for update;
  if v_wallet.imported_at is not null then
    return jsonb_build_object('initialized',true,'already_imported',true,'balance',v_wallet.balance);
  end if;
  if p_balance is null or p_balance < 0 then raise exception 'Invalid opening balance'; end if;
  if jsonb_typeof(coalesce(p_entries,'[]'::jsonb)) <> 'array' then raise exception 'Entries must be an array'; end if;
  insert into public.personal_finance_ledger(id,request_id,type,amount,category,note,transaction_date,created_at,created_by)
  select
    coalesce(nullif(e->>'id',''),gen_random_uuid()::text),
    coalesce(nullif(e->>'id',''),gen_random_uuid()::text),
    case when upper(coalesce(e->>'type','EXPENSE'))='BALANCE_ADD' then 'BALANCE_ADD' else 'EXPENSE' end,
    (e->>'amount')::numeric,coalesce(e->>'category',''),coalesce(e->>'note',''),
    coalesce(nullif(e->>'transactionDate','')::date,current_date),
    coalesce(nullif(e->>'createdAt','')::timestamptz,now()),coalesce(e->>'createdBy','')
  from jsonb_array_elements(coalesce(p_entries,'[]'::jsonb)) e
  on conflict (id) do nothing;
  get diagnostics v_count = row_count;
  update public.personal_finance_wallet set balance=round(p_balance,2),imported_at=now(),updated_at=now()
  where id='personal';
  return jsonb_build_object('initialized',true,'already_imported',false,'imported_entries',v_count,'balance',round(p_balance,2));
end;
$$;
revoke all on function public.savehatke_personal_finance_import(numeric,jsonb) from public,anon,authenticated;
grant execute on function public.savehatke_personal_finance_import(numeric,jsonb) to service_role;

create or replace function public.savehatke_personal_finance_apply(
  p_request_id text,p_type text,p_amount numeric,p_category text,p_note text,
  p_transaction_date date,p_created_by text
) returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare v_wallet public.personal_finance_wallet%rowtype; v_existing public.personal_finance_ledger%rowtype; v_balance numeric(14,2);
begin
  if nullif(btrim(p_request_id),'') is null then raise exception 'Request ID is required'; end if;
  if p_type not in ('BALANCE_ADD','EXPENSE') then raise exception 'Invalid transaction type'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then raise exception 'Invalid amount'; end if;
  select * into v_existing from public.personal_finance_ledger where request_id=p_request_id;
  if found then
    select * into v_wallet from public.personal_finance_wallet where id='personal';
    return jsonb_build_object('ok',true,'duplicate',true,'balance',v_wallet.balance,'entry',to_jsonb(v_existing));
  end if;
  select * into v_wallet from public.personal_finance_wallet where id='personal' for update;
  if not found or v_wallet.imported_at is null then raise exception 'Personal finance ledger is not initialized'; end if;
  if p_type='EXPENSE' and v_wallet.balance < round(p_amount,2) then
    return jsonb_build_object('ok',false,'code','INSUFFICIENT_BALANCE','balance',v_wallet.balance);
  end if;
  v_balance := case when p_type='BALANCE_ADD' then v_wallet.balance+round(p_amount,2) else v_wallet.balance-round(p_amount,2) end;
  insert into public.personal_finance_ledger(id,request_id,type,amount,category,note,transaction_date,created_by)
  values(gen_random_uuid()::text,p_request_id,p_type,round(p_amount,2),coalesce(p_category,''),coalesce(p_note,''),
         coalesce(p_transaction_date,current_date),coalesce(p_created_by,'')) returning * into v_existing;
  update public.personal_finance_wallet set balance=v_balance,updated_at=now() where id='personal';
  return jsonb_build_object('ok',true,'duplicate',false,'balance',v_balance,'entry',to_jsonb(v_existing));
exception when unique_violation then
  select * into v_existing from public.personal_finance_ledger where request_id=p_request_id;
  select * into v_wallet from public.personal_finance_wallet where id='personal';
  return jsonb_build_object('ok',true,'duplicate',true,'balance',v_wallet.balance,'entry',to_jsonb(v_existing));
end;
$$;
revoke all on function public.savehatke_personal_finance_apply(text,text,numeric,text,text,date,text) from public,anon,authenticated;
grant execute on function public.savehatke_personal_finance_apply(text,text,numeric,text,text,date,text) to service_role;
