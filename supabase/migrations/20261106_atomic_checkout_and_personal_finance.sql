-- SaveHatke atomic checkout creation + Personal Finance.
-- Existing PersonalFinanceBalance/PersonalFinanceLedger Sheets data is imported
-- once by the authenticated server route before the first read/write.

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
  type text not null check (type = 'EXPENSE'),
  amount numeric(14,2) not null check (amount > 0),
  category text not null default '',
  note text not null default '',
  transaction_date date not null,
  created_at timestamptz not null default now(),
  created_by text not null default ''
);

create table if not exists public.personal_finance_operations (
  request_id text primary key,
  operation_type text not null check (operation_type in ('BALANCE_ADD','EXPENSE')),
  amount numeric(14,2) not null check (amount > 0),
  balance_after numeric(14,2) not null,
  created_at timestamptz not null default now()
);

alter table public.personal_finance_wallet enable row level security;
alter table public.personal_finance_ledger enable row level security;
alter table public.personal_finance_operations enable row level security;
revoke all on table public.personal_finance_wallet from public, anon, authenticated;
revoke all on table public.personal_finance_ledger from public, anon, authenticated;
revoke all on table public.personal_finance_operations from public, anon, authenticated;
grant all on table public.personal_finance_wallet to service_role;
grant all on table public.personal_finance_ledger to service_role;
grant all on table public.personal_finance_operations to service_role;

-- Atomic checkout insert: if the payment insert or any unique constraint fails,
-- the order insert is rolled back too.
create or replace function public.savehatke_create_checkout(p_order jsonb, p_payment jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare v_order public.orders%rowtype; v_payment public.payments%rowtype;
begin
  insert into public.orders select (jsonb_populate_record(null::public.orders,p_order)).*
  returning * into v_order;
  insert into public.payments select (jsonb_populate_record(null::public.payments,p_payment)).*
  returning * into v_payment;
  return jsonb_build_object('order',to_jsonb(v_order),'payment',to_jsonb(v_payment));
end;
$$;
revoke all on function public.savehatke_create_checkout(jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.savehatke_create_checkout(jsonb,jsonb) to service_role;

-- One-time import of existing Sheets balance + expense history. The wallet row
-- lock and imported_at marker prevent two Vercel instances importing twice.
create or replace function public.savehatke_personal_finance_import(p_balance numeric,p_entries jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare v_wallet public.personal_finance_wallet%rowtype; v_count integer := 0;
begin
  select * into v_wallet from public.personal_finance_wallet where id='personal' for update;
  if v_wallet.imported_at is not null then
    return jsonb_build_object('already_imported',true,'balance',v_wallet.balance);
  end if;
  if p_balance is null or p_balance < 0 then raise exception 'Invalid opening balance'; end if;
  if jsonb_typeof(coalesce(p_entries,'[]'::jsonb)) <> 'array' then raise exception 'Entries must be an array'; end if;
  insert into public.personal_finance_ledger(id,request_id,type,amount,category,note,transaction_date,created_at,created_by)
  select coalesce(nullif(e->>'id',''),gen_random_uuid()::text),
         coalesce(nullif(e->>'id',''),gen_random_uuid()::text),
         'EXPENSE',(e->>'amount')::numeric,coalesce(e->>'category',''),coalesce(e->>'note',''),
         coalesce(nullif(e->>'transactionDate','')::date,current_date),
         coalesce(nullif(e->>'createdAt','')::timestamptz,now()),coalesce(e->>'createdBy','')
  from jsonb_array_elements(coalesce(p_entries,'[]'::jsonb)) e
  where upper(coalesce(e->>'type','EXPENSE'))='EXPENSE'
  on conflict (id) do nothing;
  get diagnostics v_count=row_count;
  update public.personal_finance_wallet set balance=round(p_balance,2),imported_at=now(),updated_at=now()
  where id='personal';
  return jsonb_build_object('already_imported',false,'imported_entries',v_count,'balance',round(p_balance,2));
end;
$$;
revoke all on function public.savehatke_personal_finance_import(numeric,jsonb) from public, anon, authenticated;
grant execute on function public.savehatke_personal_finance_import(numeric,jsonb) to service_role;

-- One transaction for balance change + expense row + retry key.
create or replace function public.savehatke_personal_finance_apply(
 p_request_id text,p_type text,p_amount numeric,p_category text,p_note text,
 p_transaction_date date,p_created_by text
) returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
 v_wallet public.personal_finance_wallet%rowtype;
 v_entry public.personal_finance_ledger%rowtype;
 v_operation public.personal_finance_operations%rowtype;
 v_balance numeric(14,2);
begin
 if nullif(btrim(p_request_id),'') is null then raise exception 'Request ID required'; end if;
 if p_type not in ('BALANCE_ADD','EXPENSE') then raise exception 'Invalid type'; end if;
 if p_amount is null or p_amount<=0 or p_amount>100000000 then raise exception 'Invalid amount'; end if;
 select * into v_wallet from public.personal_finance_wallet where id='personal' for update;
 if not found or v_wallet.imported_at is null then raise exception 'Personal Finance not initialized'; end if;
 select * into v_operation from public.personal_finance_operations where request_id=p_request_id;
 if found then
   select * into v_entry from public.personal_finance_ledger where request_id=p_request_id;
   return jsonb_build_object('ok',true,'duplicate',true,'balance',v_operation.balance_after,
     'entry',case when v_entry.id is null then null else to_jsonb(v_entry) end);
 end if;
 if p_type='EXPENSE' and v_wallet.balance<round(p_amount,2) then
   return jsonb_build_object('ok',false,'code','INSUFFICIENT_BALANCE','balance',v_wallet.balance);
 end if;
 v_balance:=case when p_type='BALANCE_ADD' then v_wallet.balance+round(p_amount,2)
                 else v_wallet.balance-round(p_amount,2) end;
 if p_type='EXPENSE' then
   insert into public.personal_finance_ledger(id,request_id,type,amount,category,note,transaction_date,created_by)
   values(gen_random_uuid()::text,p_request_id,'EXPENSE',round(p_amount,2),coalesce(p_category,''),
          coalesce(p_note,''),coalesce(p_transaction_date,current_date),coalesce(p_created_by,''))
   returning * into v_entry;
 end if;
 update public.personal_finance_wallet set balance=v_balance,updated_at=now() where id='personal';
 insert into public.personal_finance_operations(request_id,operation_type,amount,balance_after)
 values(p_request_id,p_type,round(p_amount,2),v_balance);
 return jsonb_build_object('ok',true,'duplicate',false,'balance',v_balance,
   'entry',case when v_entry.id is null then null else to_jsonb(v_entry) end);
end;
$$;
revoke all on function public.savehatke_personal_finance_apply(text,text,numeric,text,text,date,text) from public, anon, authenticated;
grant execute on function public.savehatke_personal_finance_apply(text,text,numeric,text,text,date,text) to service_role;
