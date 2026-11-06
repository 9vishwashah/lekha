-- Money with a client without creating a ledger.
--
-- Every client gets at most one direct account: an ordinary two-person shared account, created on
-- first use and looked after by the app. The balance, correction, repayment, export and sharing
-- code all keep working on it, so there is no second way of working out what someone owes.
--
-- An expense split with several clients becomes one split group: a two-person record per client,
-- plusa your own share as an expense, plus the cash once. Any door that voids one part voids them
-- all, and nothing can change one part alone.
--
-- Also fixes: repayments blocked in groups of three or more, ledger perspective changing after
-- entries exist, and an advance adjusted against a bill held in a different ledger.

-- ---------------------------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------------------------
alter table public.ledgers add column if not exists is_direct boolean not null default false;
alter table public.ledgers drop constraint if exists ledgers_direct_has_client;
alter table public.ledgers add constraint ledgers_direct_has_client
  check (not is_direct or (ledger_type = 'personal' and contractor_id is not null));
create unique index if not exists ledgers_one_direct_per_client_idx
  on public.ledgers (workspace_id, contractor_id) where is_direct;

create table if not exists public.split_groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  group_date date not null,
  total_amount numeric(14,2) not null check (total_amount > 0),
  your_share numeric(14,2) not null check (your_share >= 0 and your_share <= total_amount),
  paid_by_contractor_id uuid, -- null: you paid
  transaction_id uuid unique, -- the cash, once, when it came out of a ledger
  status text not null default 'active' check (status in ('active', 'void')),
  void_reason text,
  idempotency_key text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, idempotency_key),
  foreign key (paid_by_contractor_id, workspace_id) references public.contractors (id, workspace_id),
  foreign key (transaction_id, workspace_id) references public.transactions (id, workspace_id)
);
create index if not exists split_groups_ws_idx on public.split_groups (workspace_id, group_date);

alter table public.shared_expenses add column if not exists split_group_id uuid;
alter table public.expenses add column if not exists split_group_id uuid;
alter table public.settlements add column if not exists transaction_id uuid unique;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shared_expenses_split_group_fk') then
    alter table public.shared_expenses add constraint shared_expenses_split_group_fk
      foreign key (split_group_id, workspace_id) references public.split_groups (id, workspace_id);
    alter table public.expenses add constraint expenses_split_group_fk
      foreign key (split_group_id, workspace_id) references public.split_groups (id, workspace_id);
    alter table public.settlements add constraint settlements_transaction_fk
      foreign key (transaction_id, workspace_id) references public.transactions (id, workspace_id);
  end if;
end $$;
create index if not exists shared_expenses_split_group_idx on public.shared_expenses (split_group_id) where split_group_id is not null;
create index if not exists expenses_split_group_idx on public.expenses (split_group_id) where split_group_id is not null;

alter table public.split_groups enable row level security;
drop policy if exists split_groups_select on public.split_groups;
create policy split_groups_select on public.split_groups for select to authenticated
  using ((select app.is_member(workspace_id)));
grant select on public.split_groups to authenticated;

drop trigger if exists split_groups_touch_updated_at on public.split_groups;
create trigger split_groups_touch_updated_at before update on public.split_groups
  for each row execute function app.touch_updated_at();
drop trigger if exists split_groups_audit on public.split_groups;
create trigger split_groups_audit after insert or update or delete on public.split_groups
  for each row execute function app.audit_row();

-- An adjustment of an advance can now carry a non-cash entry in the bill's ledger.
alter table public.transactions drop constraint if exists transactions_kind_check;
alter table public.transactions add constraint transactions_kind_check check (kind in (
  'regular', 'invoice', 'tax_settlement', 'advance_given', 'advance_recovery', 'advance_adjustment', 'expense', 'reversal'
));
alter table public.advance_allocations drop constraint if exists advance_allocations_check;

create or replace function app.kind_flags(p_kind text, out is_cash boolean, out affects_party boolean)
language sql immutable set search_path = '' as $$
  select
    p_kind in ('regular', 'tax_settlement', 'advance_given', 'advance_recovery', 'expense'),
    p_kind in ('regular', 'invoice', 'advance_given', 'advance_recovery', 'advance_adjustment', 'expense')
$$;

-- ---------------------------------------------------------------------------------------------
-- Guards: these sit on the tables, so no present or future function can get around them.
-- app.linked_op is set only for the length of a cascade below.
-- ---------------------------------------------------------------------------------------------
create or replace function app.guard_linked_txn() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_target uuid;
begin
  if coalesce(current_setting('app.linked_op', true), '') = '1' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    v_target := new.reversal_of;
  elsif (new.status, new.amount, new.direction, new.txn_date) is distinct from (old.status, old.amount, old.direction, old.txn_date) then
    v_target := old.id;
  end if;
  if v_target is null then
    return new;
  end if;
  if exists (select 1 from public.split_groups where transaction_id = v_target) then
    raise exception 'This entry belongs to a split expense. Change it from Expenses.' using errcode = '22023';
  end if;
  if exists (select 1 from public.settlements where transaction_id = v_target) then
    raise exception 'This entry is a payment on a client account. Change it from their page.' using errcode = '22023';
  end if;
  if exists (select 1 from public.advance_allocations where transaction_id = v_target and kind = 'adjustment') then
    raise exception 'This entry belongs to an advance. Change it from the advance.' using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists transactions_guard_linked on public.transactions;
create trigger transactions_guard_linked before insert or update on public.transactions
  for each row execute function app.guard_linked_txn();

create or replace function app.guard_split_parts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.split_group_id is null or coalesce(current_setting('app.linked_op', true), '') = '1' then
    return new;
  end if;
  if tg_table_name = 'expenses' then
    if (new.status, new.amount, new.expense_date, new.title) is distinct from (old.status, old.amount, old.expense_date, old.title) then
      raise exception 'This expense is split with other people. Void it and add it again.' using errcode = '22023';
    end if;
  elsif new.status is distinct from old.status then
    raise exception 'This is part of a split expense. Void it and add it again.' using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists expenses_guard_split on public.expenses;
create trigger expenses_guard_split before update on public.expenses
  for each row execute function app.guard_split_parts();
drop trigger if exists shared_expenses_guard_split on public.shared_expenses;
create trigger shared_expenses_guard_split before update on public.shared_expenses
  for each row execute function app.guard_split_parts();

-- A direct account is between two people, whichever way someone tries to join it.
create or replace function app.guard_direct_participants() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.ledgers where id = new.ledger_id and is_direct)
     and (select count(*) from public.ledger_participants where ledger_id = new.ledger_id) >= 2 then
    raise exception 'A client account is between two people. Use a shared account for a group.' using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists ledger_participants_guard_direct on public.ledger_participants;
create trigger ledger_participants_guard_direct before insert on public.ledger_participants
  for each row execute function app.guard_direct_participants();

-- A client name can be longer than a participant name, and can match the owner's name. Neither
-- may stop an entry being saved. Runs after the placeholder-name trigger (alphabetical order).
create or replace function app.fit_participant_name() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_name text := left(btrim(new.display_name), 60);
  v_try text := v_name;
  v_n integer := 1;
begin
  while exists (select 1 from public.ledger_participants o
                where o.ledger_id = new.ledger_id and o.id is distinct from new.id and lower(o.display_name) = lower(v_try)) loop
    v_n := v_n + 1;
    v_try := left(v_name, 54) || ' (' || v_n || ')';
  end loop;
  new.display_name := v_try;
  return new;
end $$;

drop trigger if exists ledger_participants_zz_fit_name on public.ledger_participants;
create trigger ledger_participants_zz_fit_name before insert or update of display_name on public.ledger_participants
  for each row execute function app.fit_participant_name();

-- A direct account follows the client's name, unless it was adopted with a name of its own.
create or replace function app.sync_direct_ledger_name() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.name is distinct from old.name then
    update public.ledgers set name = left(new.name, 120)
    where contractor_id = new.id and is_direct and name = left(old.name, 120);
  end if;
  return null;
end $$;

drop trigger if exists contractors_sync_direct_ledger on public.contractors;
create trigger contractors_sync_direct_ledger after update of name on public.contractors
  for each row execute function app.sync_direct_ledger_name();

-- ---------------------------------------------------------------------------------------------
-- Direct accounts
-- ---------------------------------------------------------------------------------------------
-- The client row is locked first, so two people adding the first entry at once get one account.
-- The owner's side is the workspace owner, whoever on the team adds the entry: the account is
-- between the business and the client.
create or replace function app.ensure_direct_ledger(p_ws uuid, p_client uuid) returns public.ledgers
language plpgsql set search_path = '' as $$
declare
  c public.contractors;
  w public.workspaces;
  v public.ledgers;
begin
  select * into c from public.contractors where id = p_client and workspace_id = p_ws for update;
  if not found then
    raise exception 'Choose people from your client accounts' using errcode = '22023';
  end if;
  if not c.is_active then
    raise exception '% is marked inactive. Reactivate them first.', c.name using errcode = '22023';
  end if;
  select * into v from public.ledgers where workspace_id = p_ws and contractor_id = p_client and is_direct;
  if found then
    return v;
  end if;
  select * into w from public.workspaces where id = p_ws;
  insert into public.ledgers (workspace_id, contractor_id, name, ledger_type, perspective, is_direct, color, owner_user_id, voucher_prefix)
  values (p_ws, p_client, left(c.name, 120), 'personal', 'personal', true, 'pink', w.owner_user_id, 'PS')
  returning * into v;
  insert into public.ledger_participants (workspace_id, ledger_id, display_name, user_id, position)
  values (p_ws, v.id, app.real_name_for(w.owner_user_id, p_ws), w.owner_user_id, 0);
  perform app.add_client_participant(v, p_client, 1);
  return v;
end $$;

create or replace function app.direct_owner(p_ledger uuid) returns uuid
language sql stable set search_path = '' as $$
  select id from public.ledger_participants where ledger_id = p_ledger and position = 0
$$;

create or replace function app.direct_client(p_ledger uuid) returns uuid
language sql stable set search_path = '' as $$
  select id from public.ledger_participants where ledger_id = p_ledger and position <> 0
$$;

-- Cash may only move through a cash-book ledger here. A party ledger is already an account with
-- this person, so posting there too would count the same money against them twice.
create or replace function app.lock_cash_ledger(p_ledger uuid, p_ws uuid) returns public.ledgers
language plpgsql set search_path = '' as $$
declare
  v public.ledgers;
begin
  v := app.lock_ledger(p_ledger, false);
  if v.workspace_id <> p_ws then
    raise exception 'Ledger not found' using errcode = 'P0002';
  end if;
  if v.perspective <> 'cashbook' then
    raise exception 'Choose a cash or bank ledger. A party ledger would count this twice.' using errcode = '22023';
  end if;
  return v;
end $$;

-- Payment between you and a client, with or without a ledger for the cash. A direct account is a
-- running account: money can arrive ahead of any expense, and the balance simply flips.
create or replace function public.record_client_payment(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := (p ->> 'workspace_id')::uuid;
  v_client uuid := (p ->> 'contractor_id')::uuid;
  v_dir text := p ->> 'direction';
  v_amount numeric := app.money(p ->> 'amount', 'Amount');
  v_date date := app.txn_date(p ->> 'txn_date');
  v_idem text := nullif(p ->> 'idempotency_key', '');
  v_cash uuid := nullif(p ->> 'ledger_id', '')::uuid;
  v public.ledgers;
  c public.contractors;
  v_me uuid;
  v_them uuid;
  v_txn uuid;
  v_id uuid;
begin
  perform app.require_write(v_ws);
  if v_dir is null or v_dir not in ('received', 'paid') then
    raise exception 'Choose whether you received or paid this' using errcode = '22023';
  end if;
  if v_cash is not null then
    perform app.lock_cash_ledger(v_cash, v_ws);
  end if;
  v := app.ensure_direct_ledger(v_ws, v_client);
  v := app.lock_ledger(v.id, true);
  if v_idem is not null then
    select id into v_id from public.settlements where ledger_id = v.id and idempotency_key = v_idem;
    if v_id is not null then
      return jsonb_build_object('id', v_id, 'ledger_id', v.id, 'duplicate', true);
    end if;
  end if;
  v_me := app.direct_owner(v.id);
  v_them := app.direct_client(v.id);
  select * into c from public.contractors where id = v_client;
  if v_cash is not null then
    v_txn := app.insert_txn(v_cash, v_ws, v_date, case v_dir when 'received' then 'in' else 'out' end, v_amount, 'regular',
      jsonb_build_object('description', case v_dir when 'received' then 'Received from ' else 'Paid to ' end || c.name,
        'counterparty', c.name, 'payment_mode', p ->> 'payment_mode', 'reference_no', p ->> 'reference_no'),
      'posted', 'member', case when v_idem is null then null else 'pay:' || v_idem end);
  end if;
  insert into public.settlements (
    workspace_id, ledger_id, from_participant_id, to_participant_id, amount, txn_date, payment_mode,
    reference_no, notes, transaction_id, idempotency_key, created_by)
  values (
    v_ws, v.id, case v_dir when 'received' then v_them else v_me end, case v_dir when 'received' then v_me else v_them end,
    v_amount, v_date, app.payment_mode(p ->> 'payment_mode'), app.clean_text(p ->> 'reference_no', 80),
    app.clean_text(p ->> 'notes', 2000), v_txn, v_idem, app.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'ledger_id', v.id, 'duplicate', false);
end $$;

-- A balance from before Lekha. It is a normal entry, so nets still add up to zero and it can be
-- corrected or voided like any other. Who actually spent it is unknown, so it touches no cash.
create or replace function public.record_client_opening(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := (p ->> 'workspace_id')::uuid;
  v_amount numeric := app.money(p ->> 'amount', 'Amount');
  v_they_owe boolean := coalesce((p ->> 'they_owe')::boolean, true);
  v_idem text := nullif(p ->> 'idempotency_key', '');
  v public.ledgers;
  v_id uuid;
  v_me uuid;
  v_them uuid;
begin
  perform app.require_write(v_ws);
  v := app.ensure_direct_ledger(v_ws, (p ->> 'contractor_id')::uuid);
  v := app.lock_ledger(v.id, true);
  if v_idem is not null then
    select id into v_id from public.shared_expenses where ledger_id = v.id and idempotency_key = v_idem;
    if v_id is not null then
      return jsonb_build_object('id', v_id, 'ledger_id', v.id, 'duplicate', true);
    end if;
  end if;
  v_me := app.direct_owner(v.id);
  v_them := app.direct_client(v.id);
  v_id := app.write_shared_expense(v, jsonb_build_object(
    'txn_date', p ->> 'txn_date', 'description', 'Opening balance', 'total_amount', v_amount, 'split_method', 'exact',
    'category', 'Opening balance', 'idempotency_key', v_idem, 'notes', p ->> 'notes',
    'payers', jsonb_build_array(jsonb_build_object('participant_id', case when v_they_owe then v_me else v_them end, 'amount', v_amount)),
    'shares', jsonb_build_array(jsonb_build_object('participant_id', case when v_they_owe then v_them else v_me end, 'amount', v_amount))),
    'member', null);
  return jsonb_build_object('id', v_id, 'ledger_id', v.id, 'duplicate', false);
end $$;

-- An existing two-person account becomes the client's direct account, only when the user says so.
-- Nothing is converted automatically: a two-person account may have a name and a purpose of its
-- own, and a client can have several of them but only one direct account.
create or replace function public.adopt_direct_ledger(p_ledger uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.ledgers;
  v_client uuid;
begin
  v := app.lock_ledger(p_ledger, true);
  perform app.require_write(v.workspace_id);
  if v.is_direct then
    return;
  end if;
  if (select count(*) from public.ledger_participants where ledger_id = p_ledger) <> 2 then
    raise exception 'Only an account between two people can become a client account' using errcode = '22023';
  end if;
  select contractor_id into v_client from public.ledger_participants where ledger_id = p_ledger and position <> 0;
  if v_client is null then
    raise exception 'This account is not with a client' using errcode = '22023';
  end if;
  perform 1 from public.contractors where id = v_client for update;
  if exists (select 1 from public.ledgers where workspace_id = v.workspace_id and contractor_id = v_client and is_direct) then
    raise exception 'This client already has a direct account' using errcode = '22023';
  end if;
  update public.ledgers set is_direct = true, contractor_id = v_client where id = p_ledger;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Split expenses
-- One client: one full record on their account, whoever paid.
-- Several clients: you paid, and each person's share goes on their own account. When someone else
-- paid for a group, the others owe that person, not you, and that debt has no place on your
-- accounts, so it is refused here. A named shared account holds that case properly.
-- Your own share is the expense; the cash leaves its ledger once, at the full amount. They are
-- separate rows because they differ, and neither is ever added to the other in a total.
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_split_expense(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := (p ->> 'workspace_id')::uuid;
  v_idem text := coalesce(nullif(p ->> 'idempotency_key', ''), gen_random_uuid()::text);
  v_total numeric := app.money(p ->> 'amount', 'Amount');
  v_your numeric := app.money(p ->> 'your_share', 'Your share', true);
  v_date date := app.txn_date(p ->> 'expense_date');
  v_title text := coalesce(app.clean_text(p ->> 'title', 200), 'Expense');
  v_paid_by uuid := nullif(p ->> 'paid_by_contractor_id', '')::uuid;
  v_cash uuid := nullif(p ->> 'ledger_id', '')::uuid;
  v_cat uuid := nullif(p ->> 'category_id', '')::uuid;
  v_mode text := app.payment_mode(p ->> 'payment_mode');
  v_ref text := app.clean_text(p ->> 'reference_no', 80);
  v_notes text := app.clean_text(p ->> 'notes', 1800);
  v_people jsonb := p -> 'people';
  v_cat_name text;
  v_count integer;
  v_distinct integer;
  v_sum numeric;
  v_owed numeric;
  v_group uuid;
  v_txn uuid;
  v_expense uuid;
  v_item jsonb;
  v_client uuid;
  v_share numeric;
  v_l public.ledgers;
  v_me uuid;
  v_them uuid;
  v_id uuid;
  v_payer uuid;
  v_payers jsonb;
  v_shares jsonb;
  v_leg_total numeric;
begin
  perform app.require_write(v_ws);
  if v_people is null or jsonb_typeof(v_people) <> 'array' or jsonb_array_length(v_people) = 0 then
    raise exception 'Choose who this is with' using errcode = '22023';
  end if;
  if jsonb_array_length(v_people) > 20 then
    raise exception 'Split with up to 20 people at a time' using errcode = '22023';
  end if;
  select count(*), count(distinct x ->> 'contractor_id'), coalesce(sum(app.money(x ->> 'amount', 'Share', true)), 0)
  into v_count, v_distinct, v_sum
  from jsonb_array_elements(v_people) x;
  if v_distinct <> v_count then
    raise exception 'Each person can appear only once' using errcode = '22023';
  end if;
  if v_sum + v_your <> v_total then
    raise exception 'Shares (%) must add up to the total (%)', v_sum + v_your, v_total using errcode = '22023';
  end if;
  if v_paid_by is not null and v_count > 1 then
    raise exception 'When someone else paid for a group, they are owed, not you. Use a shared account for this.' using errcode = '22023';
  end if;
  if v_paid_by is not null and not exists (select 1 from jsonb_array_elements(v_people) x where (x ->> 'contractor_id')::uuid = v_paid_by) then
    raise exception 'Choose who paid from the people in this split' using errcode = '22023';
  end if;
  if v_paid_by is not null and v_cash is not null then
    raise exception 'They paid, so no money left your ledger' using errcode = '22023';
  end if;
  v_owed := case when v_paid_by is null then v_sum else v_your end;
  if v_owed <= 0 then
    raise exception 'No one owes anything here. Save it as a plain expense instead.' using errcode = '22023';
  end if;
  if v_your > 0 and v_cat is null then
    raise exception 'Choose a category' using errcode = '22023';
  end if;
  if v_cat is not null then
    select name into v_cat_name from public.expense_categories where id = v_cat and workspace_id = v_ws;
    if v_cat_name is null then
      raise exception 'Choose a category' using errcode = '22023';
    end if;
  end if;
  if v_cash is not null then
    perform app.lock_cash_ledger(v_cash, v_ws);
  end if;

  -- Claiming the key first makes a double submit harmless, even at the same moment.
  insert into public.split_groups (workspace_id, title, group_date, total_amount, your_share, paid_by_contractor_id, idempotency_key, created_by)
  values (v_ws, v_title, v_date, v_total, v_your, v_paid_by, v_idem, app.uid())
  on conflict (workspace_id, idempotency_key) do nothing
  returning id into v_group;
  if v_group is null then
    select id into v_group from public.split_groups where workspace_id = v_ws and idempotency_key = v_idem;
    return jsonb_build_object('id', v_group, 'duplicate', true);
  end if;

  if v_cash is not null then
    v_txn := app.insert_txn(v_cash, v_ws, v_date, 'out', v_total, 'expense',
      jsonb_build_object('description', v_title, 'counterparty', p ->> 'vendor', 'payment_mode', v_mode, 'reference_no', v_ref),
      'posted', 'member', 'split:' || v_idem);
    update public.split_groups set transaction_id = v_txn where id = v_group;
  end if;

  if v_your > 0 then
    insert into public.expenses (
      workspace_id, category_id, expense_date, title, amount, vendor, payment_mode, reference_no, contractor_id,
      notes, split_group_id, idempotency_key, created_by)
    values (
      v_ws, v_cat, v_date, v_title, v_your, app.clean_text(p ->> 'vendor', 160), v_mode, v_ref,
      case when v_count = 1 then (v_people -> 0 ->> 'contractor_id')::uuid end,
      v_notes, v_group, 'split:' || v_idem, app.uid())
    returning id into v_expense;
  end if;

  -- In a fixed order, so two splits with the same people cannot wait on each other.
  for v_item in select x from jsonb_array_elements(v_people) x order by x ->> 'contractor_id' loop
    v_client := (v_item ->> 'contractor_id')::uuid;
    v_share := app.money(v_item ->> 'amount', 'Share', true);
    continue when v_count > 1 and v_share = 0;
    v_l := app.ensure_direct_ledger(v_ws, v_client);
    v_l := app.lock_ledger(v_l.id, true);
    v_me := app.direct_owner(v_l.id);
    v_them := app.direct_client(v_l.id);
    v_payer := case when v_paid_by is null then v_me else v_them end;
    v_leg_total := case when v_count = 1 then v_total else v_share end;
    v_payers := jsonb_build_array(jsonb_build_object('participant_id', v_payer, 'amount', v_leg_total));
    v_shares := '[]'::jsonb;
    if v_share > 0 then
      v_shares := v_shares || jsonb_build_object('participant_id', v_them, 'amount', v_share);
    end if;
    if v_count = 1 and v_your > 0 then
      v_shares := v_shares || jsonb_build_object('participant_id', v_me, 'amount', v_your);
    end if;
    v_id := app.write_shared_expense(v_l, jsonb_build_object(
      'txn_date', v_date, 'description', v_title, 'total_amount', v_leg_total, 'split_method', 'exact',
      'category', v_cat_name, 'payment_mode', v_mode, 'reference_no', v_ref,
      'notes', case when v_count > 1
        then coalesce(v_notes || E'\n', '') || 'Share of ' || trim(to_char(v_total, 'FM999999999990.00')) || ' split between ' || (v_count + case when v_your > 0 then 1 else 0 end) || ' people'
        else v_notes end,
      'payers', v_payers, 'shares', v_shares), 'member', null);
    update public.shared_expenses set split_group_id = v_group where id = v_id;
  end loop;

  return jsonb_build_object('id', v_group, 'expense_id', v_expense, 'transaction_id', v_txn, 'duplicate', false);
end $$;

create or replace function app.void_split_group(p_group uuid, p_reason text) returns void
language plpgsql set search_path = '' as $$
declare
  g public.split_groups;
begin
  select * into g from public.split_groups where id = p_group for update;
  if not found then
    raise exception 'Split not found' using errcode = 'P0002';
  end if;
  if g.status = 'void' then
    return;
  end if;
  perform set_config('app.linked_op', '1', true);
  update public.shared_expenses set status = 'void', void_reason = p_reason, updated_by = app.uid()
  where split_group_id = p_group and status = 'posted';
  update public.expenses set status = 'void', void_reason = p_reason, updated_by = app.uid()
  where split_group_id = p_group and status <> 'void';
  update public.transactions
  set status = 'void', void_reason = p_reason, voided_at = now(), voided_by = app.uid(), updated_by = app.uid()
  where id = g.transaction_id and status <> 'void';
  perform set_config('app.linked_op', '', true);
  update public.split_groups set status = 'void', void_reason = p_reason where id = p_group;
end $$;

create or replace function public.void_expense(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.expenses;
  v_reason text := app.clean_text(p_reason, 300);
begin
  select * into e from public.expenses where id = p_id for update;
  if not found then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;
  perform app.require_write(e.workspace_id);
  if v_reason is null then
    raise exception 'Give a reason for voiding this expense' using errcode = '22023';
  end if;
  if e.split_group_id is not null then
    perform app.void_split_group(e.split_group_id, v_reason);
    return;
  end if;
  update public.expenses set status = 'void', void_reason = v_reason, updated_by = app.uid() where id = p_id;
  if e.transaction_id is not null then
    update public.transactions
    set status = 'void', void_reason = v_reason, voided_at = now(), voided_by = app.uid(), updated_by = app.uid()
    where id = e.transaction_id and status <> 'void';
  end if;
end $$;

-- A split crosses several accounts, so voiding it takes workspace write access: someone who can
-- only see their own account with you cannot undo your other clients' shares.
create or replace function public.void_shared_expense(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.shared_expenses;
  v_reason text := app.clean_text(p_reason, 300);
begin
  select * into e from public.shared_expenses where id = p_id;
  if not found then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;
  if v_reason is null then
    raise exception 'Give a reason' using errcode = '22023';
  end if;
  if e.split_group_id is not null then
    perform app.require_write(e.workspace_id);
    perform app.void_split_group(e.split_group_id, v_reason);
    return;
  end if;
  perform app.require_ledger_edit(e.ledger_id, e.created_by);
  perform app.lock_ledger(e.ledger_id, true);
  update public.shared_expenses set status = 'void', void_reason = v_reason, updated_by = app.uid()
  where id = p_id and status = 'posted';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Repayments
-- Between two people the limit is what either side is owed. On a group's net alone, someone whose
-- debts and credits cancel out could never pay back the person they owe: A owes B 1000 and C owes
-- A 1000, so A's net is 0. For two people both sides are equal, so nothing changes there.
-- A direct account is a running account and takes any amount.
-- ---------------------------------------------------------------------------------------------
create or replace function public.record_settlement(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ledger_id uuid := (p ->> 'ledger_id')::uuid;
  v public.ledgers;
  v_from uuid := (p ->> 'from_participant_id')::uuid;
  v_to uuid := (p ->> 'to_participant_id')::uuid;
  v_amount numeric := app.money(p ->> 'amount', 'Amount');
  v_limit numeric;
  v_existing uuid;
  v_id uuid;
begin
  perform app.require_ledger_create(v_ledger_id);
  v := app.lock_ledger(v_ledger_id, true);
  if nullif(p ->> 'idempotency_key', '') is not null then
    select id into v_existing from public.settlements where ledger_id = v_ledger_id and idempotency_key = p ->> 'idempotency_key';
    if v_existing is not null then
      return jsonb_build_object('id', v_existing, 'duplicate', true);
    end if;
  end if;
  if not exists (select 1 from public.ledger_participants where id = v_from and ledger_id = v_ledger_id)
     or not exists (select 1 from public.ledger_participants where id = v_to and ledger_id = v_ledger_id) then
    raise exception 'Choose two people from this ledger' using errcode = '22023';
  end if;
  if v_from = v_to then
    raise exception 'Choose two different people' using errcode = '22023';
  end if;
  if not v.is_direct then
    v_limit := greatest(-app.participant_net(v_from), app.participant_net(v_to));
    if v_limit <= 0 then
      raise exception 'Nothing is outstanding between these two' using errcode = '22023';
    end if;
    if v_amount > v_limit then
      raise exception 'Repayment is more than the outstanding amount of %', v_limit using errcode = '22023';
    end if;
  end if;
  insert into public.settlements (
    workspace_id, ledger_id, from_participant_id, to_participant_id, amount, txn_date, payment_mode,
    reference_no, notes, idempotency_key, created_by)
  values (
    v.workspace_id, v_ledger_id, v_from, v_to, v_amount, app.txn_date(p ->> 'txn_date'),
    app.payment_mode(p ->> 'payment_mode'), app.clean_text(p ->> 'reference_no', 80),
    app.clean_text(p ->> 'notes', 2000), nullif(p ->> 'idempotency_key', ''), app.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'duplicate', false);
end $$;

create or replace function public.void_settlement(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.settlements;
  v_reason text := app.clean_text(p_reason, 300);
begin
  select * into s from public.settlements where id = p_id;
  if not found then
    raise exception 'Repayment not found' using errcode = 'P0002';
  end if;
  perform app.require_ledger_edit(s.ledger_id, s.created_by);
  perform app.lock_ledger(s.ledger_id, true);
  if v_reason is null then
    raise exception 'Give a reason' using errcode = '22023';
  end if;
  if s.transaction_id is not null then
    perform app.require_write(s.workspace_id); -- it also moved cash in a workspace ledger
    perform set_config('app.linked_op', '1', true);
    update public.transactions
    set status = 'void', void_reason = v_reason, voided_at = now(), voided_by = app.uid(), updated_by = app.uid()
    where id = s.transaction_id and status <> 'void';
    perform set_config('app.linked_op', '', true);
  end if;
  update public.settlements set status = 'void', void_reason = v_reason where id = p_id and status = 'posted';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Ledgers
-- ---------------------------------------------------------------------------------------------
create or replace function public.update_ledger(p_ledger uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.ledgers;
begin
  select * into v from public.ledgers where id = p_ledger for update;
  if not found then
    raise exception 'Ledger not found' using errcode = 'P0002';
  end if;
  perform app.require_write(v.workspace_id);
  -- The same entries mean opposite things in each perspective, so history would silently invert.
  if p ? 'perspective' and p ->> 'perspective' in ('cashbook', 'party') and p ->> 'perspective' <> v.perspective
     and v.ledger_type <> 'personal'
     and exists (select 1 from public.transactions where ledger_id = p_ledger and status <> 'void') then
    raise exception 'This ledger already has entries, so how its balance is read cannot change. Create a new ledger instead.' using errcode = '22023';
  end if;
  update public.ledgers set
    name = coalesce(app.clean_text(p ->> 'name', 120), name),
    contractor_id = case when p ? 'contractor_id' and not v.is_direct then nullif(p ->> 'contractor_id', '')::uuid else contractor_id end,
    reference_no = case when p ? 'reference_no' then app.clean_text(p ->> 'reference_no', 60) else reference_no end,
    description = case when p ? 'description' then app.clean_text(p ->> 'description', 500) else description end,
    notes = case when p ? 'notes' then app.clean_text(p ->> 'notes', 2000) else notes end,
    opening_balance = case when p ? 'opening_balance' and v.ledger_type <> 'personal'
      then app.signed_money(p ->> 'opening_balance', 'Opening balance') else opening_balance end,
    opening_balance_date = case when p ? 'opening_balance_date' then nullif(p ->> 'opening_balance_date', '')::date else opening_balance_date end,
    perspective = case when p ? 'perspective' and v.ledger_type <> 'personal' and p ->> 'perspective' in ('cashbook', 'party')
      then p ->> 'perspective' else perspective end,
    gst_mode = coalesce(nullif(p ->> 'gst_mode', ''), gst_mode),
    color = coalesce(nullif(p ->> 'color', ''), color)
  where id = p_ledger;
end $$;

-- Archiving hides a shared account from balances. A client's running account stays in them.
create or replace function public.set_ledger_status(p_ledger uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := app.ledger_workspace(p_ledger);
begin
  perform app.require_write(v_ws);
  if p_status not in ('active', 'archived') then
    raise exception 'Status must be active or archived' using errcode = '22023';
  end if;
  if p_status = 'archived' and exists (select 1 from public.ledgers where id = p_ledger and is_direct) then
    raise exception 'A client account cannot be archived. Mark the client inactive instead.' using errcode = '22023';
  end if;
  update public.ledgers set status = p_status where id = p_ledger;
end $$;

-- Merging two clients who each have a direct account: one account per client, so the merged-away
-- one stays as an ordinary shared account with its history and balance intact.
create or replace function public.merge_contractors(p_from uuid, p_into uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_from public.contractors;
  v_into public.contractors;
begin
  select * into v_from from public.contractors where id = p_from for update;
  select * into v_into from public.contractors where id = p_into for update;
  if v_from.id is null or v_into.id is null or v_from.workspace_id <> v_into.workspace_id or p_from = p_into then
    raise exception 'Choose two different contractors from the same workspace' using errcode = '22023';
  end if;
  perform app.require_admin(v_from.workspace_id);
  if v_from.linked_user_id is not null and v_into.linked_user_id is not null and v_from.linked_user_id <> v_into.linked_user_id then
    raise exception 'Both are linked to different Lekha accounts. Unlink one first.' using errcode = '22023';
  end if;
  update public.ledgers set is_direct = false, contractor_id = null
  where contractor_id = p_from and is_direct
    and exists (select 1 from public.ledgers o where o.contractor_id = p_into and o.is_direct);
  update public.ledgers set contractor_id = p_into where contractor_id = p_from;
  update public.advances set contractor_id = p_into where contractor_id = p_from;
  update public.expenses set contractor_id = p_into where contractor_id = p_from;
  update public.split_groups set paid_by_contractor_id = p_into where paid_by_contractor_id = p_from;
  update public.ledger_participants lp set contractor_id = p_into, display_name = v_into.name
  where lp.contractor_id = p_from
    and not exists (select 1 from public.ledger_participants o where o.ledger_id = lp.ledger_id and o.contractor_id = p_into);
  update public.contractors set is_active = false, merged_into = p_into, linked_user_id = null where id = p_from;
  if v_into.linked_user_id is null and v_from.linked_user_id is not null then
    update public.contractors set linked_user_id = v_from.linked_user_id where id = p_into;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Advances: an adjustment that reaches the bill's ledger
-- When the advance sits in a party ledger the two already offset in the client's total, even
-- across two party ledgers, so a further entry would count it twice. Only an advance that no party
-- ledger has seen (no ledger, or a cash book) needs one.
-- ---------------------------------------------------------------------------------------------
create or replace function public.record_advance_allocation(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.advances;
  v_kind text := p ->> 'kind';
  v_idem text := nullif(p ->> 'idempotency_key', '');
  v_existing uuid;
  v_amount numeric := app.money(p ->> 'amount', 'Amount');
  v_date date := app.txn_date(p ->> 'alloc_date');
  v_outstanding numeric;
  v_txn uuid;
  v_bill uuid := nullif(p ->> 'bill_transaction_id', '')::uuid;
  b public.transactions;
  v_bill_ledger public.ledgers;
  v_advance_view text;
  v_id uuid;
  v_name text;
begin
  select * into a from public.advances where id = (p ->> 'advance_id')::uuid for update;
  if not found then
    raise exception 'Advance not found' using errcode = 'P0002';
  end if;
  perform app.require_write(a.workspace_id);
  if v_idem is not null then
    select id into v_existing from public.advance_allocations where workspace_id = a.workspace_id and idempotency_key = v_idem;
    if v_existing is not null then
      return jsonb_build_object('id', v_existing, 'duplicate', true);
    end if;
  end if;
  if a.status = 'void' then
    raise exception 'This advance is void' using errcode = '22023';
  end if;
  if v_kind not in ('recovery', 'adjustment') then
    raise exception 'Choose cash recovery or adjustment against a bill' using errcode = '22023';
  end if;
  if v_date < a.given_date then
    raise exception 'A recovery cannot be dated before the advance was given' using errcode = '22023';
  end if;
  v_outstanding := app.advance_outstanding(a.id);
  if v_amount > v_outstanding then
    raise exception 'Amount is more than the outstanding advance of %', v_outstanding using errcode = '22023';
  end if;
  if v_bill is not null then
    select * into b from public.transactions t where t.id = v_bill and t.workspace_id = a.workspace_id
      and t.kind = 'invoice' and t.status = 'posted';
    if not found then
      raise exception 'Choose a posted bill from this workspace' using errcode = '22023';
    end if;
  end if;

  select name into v_name from public.contractors where id = a.contractor_id;
  if v_kind = 'recovery' and a.ledger_id is not null then
    perform app.lock_ledger(a.ledger_id, false);
    v_txn := app.insert_txn(a.ledger_id, a.workspace_id, v_date, 'in', v_amount, 'advance_recovery',
      jsonb_build_object('description', 'Advance recovered', 'counterparty', v_name,
        'payment_mode', p ->> 'payment_mode', 'reference_no', p ->> 'bill_reference'),
      'posted', 'member', case when v_idem is null then null else 'rec:' || v_idem end);
  elsif v_kind = 'adjustment' and v_bill is not null and b.direction = 'in' then
    select * into v_bill_ledger from public.ledgers where id = b.ledger_id;
    select perspective into v_advance_view from public.ledgers where id = a.ledger_id;
    if v_bill_ledger.perspective = 'party' and coalesce(v_advance_view, 'cashbook') = 'cashbook' then
      perform app.lock_ledger(v_bill_ledger.id, false);
      v_txn := app.insert_txn(v_bill_ledger.id, a.workspace_id, v_date, 'out', v_amount, 'advance_adjustment',
        jsonb_build_object('description', 'Advance adjusted against bill', 'counterparty', v_name,
          'reference_no', p ->> 'bill_reference'),
        'posted', 'member', case when v_idem is null then null else 'adj:' || v_idem end);
    end if;
  end if;

  insert into public.advance_allocations (
    workspace_id, advance_id, kind, amount, alloc_date, transaction_id, bill_transaction_id, bill_reference,
    payment_mode, notes, idempotency_key, created_by)
  values (
    a.workspace_id, a.id, v_kind, v_amount, v_date, v_txn, case when v_kind = 'adjustment' then v_bill end,
    app.clean_text(p ->> 'bill_reference', 80), app.payment_mode(p ->> 'payment_mode'),
    app.clean_text(p ->> 'notes', 2000), v_idem, app.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'transaction_id', v_txn, 'duplicate', false);
end $$;

create or replace function public.void_advance_allocation(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  x public.advance_allocations;
  v_reason text := app.clean_text(p_reason, 300);
begin
  select * into x from public.advance_allocations where id = p_id for update;
  if not found then
    raise exception 'Recovery not found' using errcode = 'P0002';
  end if;
  perform app.require_write(x.workspace_id);
  if v_reason is null then
    raise exception 'Give a reason' using errcode = '22023';
  end if;
  update public.advance_allocations set status = 'void', void_reason = v_reason where id = p_id;
  if x.transaction_id is not null then
    perform set_config('app.linked_op', '1', true);
    update public.transactions
    set status = 'void', void_reason = v_reason, voided_at = now(), voided_by = app.uid(), updated_by = app.uid()
    where id = x.transaction_id and status <> 'void';
    perform set_config('app.linked_op', '', true);
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------------------------
revoke all on function public.record_client_payment(jsonb) from public, anon;
revoke all on function public.record_client_opening(jsonb) from public, anon;
revoke all on function public.adopt_direct_ledger(uuid) from public, anon;
revoke all on function public.create_split_expense(jsonb) from public, anon;
grant execute on function public.record_client_payment(jsonb) to authenticated;
grant execute on function public.record_client_opening(jsonb) to authenticated;
grant execute on function public.adopt_direct_ledger(uuid) to authenticated;
grant execute on function public.create_split_expense(jsonb) to authenticated;

revoke all on function app.ensure_direct_ledger(uuid, uuid) from public, anon, authenticated;
revoke all on function app.direct_owner(uuid) from public, anon, authenticated;
revoke all on function app.direct_client(uuid) from public, anon, authenticated;
revoke all on function app.lock_cash_ledger(uuid, uuid) from public, anon, authenticated;
revoke all on function app.void_split_group(uuid, text) from public, anon, authenticated;
revoke all on function app.guard_linked_txn() from public, anon, authenticated;
revoke all on function app.guard_split_parts() from public, anon, authenticated;
revoke all on function app.guard_direct_participants() from public, anon, authenticated;
revoke all on function app.sync_direct_ledger_name() from public, anon, authenticated;
