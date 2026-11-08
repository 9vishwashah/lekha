-- The entries the Universal Entry Composer needs that Lekha could not yet record:
--   * a bill on a client with no money moving (income, and they owe you)
--   * one person's debt set against another's, with no money moving
--   * money moved between your own wallets (cash to bank and back)
-- Each is one event with both sides written together, so nothing can be changed half-way.

alter table public.shared_expenses add column if not exists book_kind text;
alter table public.shared_expenses drop constraint if exists shared_expenses_book_kind_check;
alter table public.shared_expenses add constraint shared_expenses_book_kind_check check (book_kind is null or book_kind = 'income');

alter table public.settlements add column if not exists no_cash boolean not null default false;
alter table public.settlements add column if not exists contra_id uuid;
create index if not exists settlements_contra_idx on public.settlements (contra_id) where contra_id is not null;

alter table public.transactions add column if not exists transfer_id uuid;
create index if not exists transactions_transfer_idx on public.transactions (transfer_id) where transfer_id is not null;

-- A correction keeps what the record was: a corrected bill is still a bill.
create or replace function app.keep_book_kind() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.replaces_id is not null and new.book_kind is null then
    select book_kind into new.book_kind from public.shared_expenses where id = new.replaces_id;
  end if;
  return new;
end $$;

drop trigger if exists shared_expenses_keep_book_kind on public.shared_expenses;
create trigger shared_expenses_keep_book_kind before insert on public.shared_expenses
  for each row execute function app.keep_book_kind();

-- Both halves of a transfer change together or not at all.
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
  if exists (select 1 from public.transactions where id = v_target and transfer_id is not null) then
    raise exception 'This is half of a transfer between wallets. Void the transfer instead.' using errcode = '22023';
  end if;
  return new;
end $$;

create or replace function public.classify_entry(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.transactions;
begin
  select * into t from public.transactions where id = p_id for update;
  if not found then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;
  perform app.require_write(t.workspace_id);
  if t.status <> 'posted' then
    raise exception 'Only a posted entry can be changed here' using errcode = '22023';
  end if;
  if t.transfer_id is not null then
    raise exception 'This is a transfer between wallets' using errcode = '22023';
  end if;
  if p ? 'nature' and t.kind <> 'regular' then
    raise exception 'This entry already says what it is' using errcode = '22023';
  end if;
  update public.transactions set
    wallet_ledger_id = case when p ? 'wallet_ledger_id' then nullif(p ->> 'wallet_ledger_id', '')::uuid else wallet_ledger_id end,
    nature = case when p ? 'nature' then nullif(p ->> 'nature', '') else nature end,
    updated_by = app.uid()
  where id = p_id or (reversal_of = p_id and status = 'posted');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Bill on a client, no money moving: income now, and they owe you until they pay.
-- For a GST invoice, use Invoices; this is the plain case.
-- ---------------------------------------------------------------------------------------------
create or replace function public.record_client_bill(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := (p ->> 'workspace_id')::uuid;
  v_amount numeric := app.money(p ->> 'amount', 'Amount');
  v_idem text := nullif(p ->> 'idempotency_key', '');
  v public.ledgers;
  v_id uuid;
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
  v_id := app.write_shared_expense(v, jsonb_build_object(
    'txn_date', p ->> 'txn_date', 'description', coalesce(app.clean_text(p ->> 'description', 200), 'Bill'),
    'total_amount', v_amount, 'split_method', 'exact', 'category', 'Bill', 'idempotency_key', v_idem, 'notes', p ->> 'notes',
    'payers', jsonb_build_array(jsonb_build_object('participant_id', app.direct_owner(v.id), 'amount', v_amount)),
    'shares', jsonb_build_array(jsonb_build_object('participant_id', app.direct_client(v.id), 'amount', v_amount))),
    'member', null);
  update public.shared_expenses set book_kind = 'income' where id = v_id;
  return jsonb_build_object('id', v_id, 'ledger_id', v.id, 'duplicate', false);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Set one person's debt against another's: the first pays the second on your behalf.
-- What the first owes you goes down, and so does what you owe the second. No money of yours moves.
-- ---------------------------------------------------------------------------------------------
create or replace function public.record_party_transfer(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := (p ->> 'workspace_id')::uuid;
  v_from uuid := (p ->> 'from_contractor_id')::uuid;
  v_to uuid := (p ->> 'to_contractor_id')::uuid;
  v_amount numeric := app.money(p ->> 'amount', 'Amount');
  v_date date := app.txn_date(p ->> 'txn_date');
  v_idem text := nullif(p ->> 'idempotency_key', '');
  v_notes text := app.clean_text(p ->> 'notes', 2000);
  a public.ledgers;
  b public.ledgers;
  v_contra uuid := gen_random_uuid();
  v_existing uuid;
begin
  perform app.require_write(v_ws);
  if v_from is null or v_to is null or v_from = v_to then
    raise exception 'Choose two different people' using errcode = '22023';
  end if;
  -- Always in the same order, so two of these at once cannot wait on each other.
  if v_from < v_to then
    a := app.ensure_direct_ledger(v_ws, v_from);
    b := app.ensure_direct_ledger(v_ws, v_to);
  else
    b := app.ensure_direct_ledger(v_ws, v_to);
    a := app.ensure_direct_ledger(v_ws, v_from);
  end if;
  perform app.lock_ledger(least(a.id, b.id), true);
  perform app.lock_ledger(greatest(a.id, b.id), true);
  if v_idem is not null then
    select contra_id into v_existing from public.settlements where ledger_id = a.id and idempotency_key = v_idem || ':from';
    if v_existing is not null then
      return jsonb_build_object('id', v_existing, 'duplicate', true);
    end if;
  end if;
  insert into public.settlements (workspace_id, ledger_id, from_participant_id, to_participant_id, amount, txn_date, notes,
    no_cash, contra_id, idempotency_key, created_by)
  values (v_ws, a.id, app.direct_client(a.id), app.direct_owner(a.id), v_amount, v_date,
    coalesce(v_notes, 'Paid ' || (select name from public.contractors where id = v_to) || ' for you'),
    true, v_contra, case when v_idem is null then null else v_idem || ':from' end, app.uid());
  insert into public.settlements (workspace_id, ledger_id, from_participant_id, to_participant_id, amount, txn_date, notes,
    no_cash, contra_id, idempotency_key, created_by)
  values (v_ws, b.id, app.direct_owner(b.id), app.direct_client(b.id), v_amount, v_date,
    coalesce(v_notes, 'Received from ' || (select name from public.contractors where id = v_from) || ' for you'),
    true, v_contra, case when v_idem is null then null else v_idem || ':to' end, app.uid());
  return jsonb_build_object('id', v_contra, 'duplicate', false);
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
  if s.contra_id is not null then
    -- Both people's sides of the same arrangement go together.
    perform app.require_write(s.workspace_id);
    update public.settlements set status = 'void', void_reason = v_reason where contra_id = s.contra_id and status = 'posted';
    return;
  end if;
  update public.settlements set status = 'void', void_reason = v_reason where id = p_id and status = 'posted';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Between your own wallets: out of one, into the other. Neither income nor cost.
-- ---------------------------------------------------------------------------------------------
create or replace function public.record_transfer(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := (p ->> 'workspace_id')::uuid;
  v_from uuid := (p ->> 'from_ledger_id')::uuid;
  v_to uuid := (p ->> 'to_ledger_id')::uuid;
  v_amount numeric := app.money(p ->> 'amount', 'Amount');
  v_date date := app.txn_date(p ->> 'txn_date');
  v_idem text := nullif(p ->> 'idempotency_key', '');
  v_transfer uuid := gen_random_uuid();
  v_out uuid;
  v_in uuid;
  v_existing uuid;
  v_from_name text;
  v_to_name text;
begin
  perform app.require_write(v_ws);
  if v_from is null or v_to is null or v_from = v_to then
    raise exception 'Choose two different wallets' using errcode = '22023';
  end if;
  perform app.lock_cash_ledger(least(v_from, v_to), v_ws);
  perform app.lock_cash_ledger(greatest(v_from, v_to), v_ws);
  if v_idem is not null then
    select transfer_id into v_existing from public.transactions where workspace_id = v_ws and idempotency_key = 'tr:' || v_idem || ':out';
    if v_existing is not null then
      return jsonb_build_object('id', v_existing, 'duplicate', true);
    end if;
  end if;
  select name into v_from_name from public.ledgers where id = v_from;
  select name into v_to_name from public.ledgers where id = v_to;
  v_out := app.insert_txn(v_from, v_ws, v_date, 'out', v_amount, 'regular',
    jsonb_build_object('description', coalesce(app.clean_text(p ->> 'description', 200), 'To ' || v_to_name), 'nature', 'transfer'),
    'posted', 'member', case when v_idem is null then null else 'tr:' || v_idem || ':out' end);
  v_in := app.insert_txn(v_to, v_ws, v_date, 'in', v_amount, 'regular',
    jsonb_build_object('description', coalesce(app.clean_text(p ->> 'description', 200), 'From ' || v_from_name), 'nature', 'transfer'),
    'posted', 'member', case when v_idem is null then null else 'tr:' || v_idem || ':in' end);
  update public.transactions set transfer_id = v_transfer where id in (v_out, v_in);
  return jsonb_build_object('id', v_transfer, 'duplicate', false);
end $$;

create or replace function public.void_transfer(p_transfer uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_reason text := app.clean_text(p_reason, 300);
begin
  select workspace_id into v_ws from public.transactions where transfer_id = p_transfer limit 1;
  if v_ws is null then
    raise exception 'Transfer not found' using errcode = 'P0002';
  end if;
  perform app.require_write(v_ws);
  if v_reason is null then
    raise exception 'Give a reason' using errcode = '22023';
  end if;
  perform set_config('app.linked_op', '1', true);
  update public.transactions
  set status = 'void', void_reason = v_reason, voided_at = now(), voided_by = app.uid(), updated_by = app.uid()
  where transfer_id = p_transfer and status <> 'void';
  perform set_config('app.linked_op', '', true);
end $$;

revoke all on function public.record_client_bill(jsonb) from public, anon;
revoke all on function public.record_party_transfer(jsonb) from public, anon;
revoke all on function public.record_transfer(jsonb) from public, anon;
revoke all on function public.void_transfer(uuid, text) from public, anon;
grant execute on function public.record_client_bill(jsonb) to authenticated;
grant execute on function public.record_party_transfer(jsonb) to authenticated;
grant execute on function public.record_transfer(jsonb) to authenticated;
grant execute on function public.void_transfer(uuid, text) to authenticated;
revoke all on function app.keep_book_kind() from public, anon, authenticated;
