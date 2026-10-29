-- Expenses, advances and personal shared ledgers.

-- ---------------------------------------------------------------------------------------------
-- Expenses
-- An expense paid through a ledger creates exactly one linked Money Out entry in the same
-- database transaction. Reports read expense totals from expenses and cash totals from
-- transactions, so the payment is never counted twice.
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_expense(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := (p ->> 'workspace_id')::uuid;
  v_idem text := nullif(p ->> 'idempotency_key', '');
  v_existing uuid;
  v_amount numeric := app.money(p ->> 'amount', 'Amount');
  v_date date := app.txn_date(p ->> 'expense_date');
  v_ledger_id uuid := nullif(p ->> 'ledger_id', '')::uuid;
  v_ledger public.ledgers;
  v_txn uuid;
  v_id uuid;
  v_gst numeric;
begin
  perform app.require_write(v_ws);
  if v_idem is not null then
    select id into v_existing from public.expenses where workspace_id = v_ws and idempotency_key = v_idem;
    if v_existing is not null then
      return jsonb_build_object('id', v_existing, 'duplicate', true);
    end if;
  end if;
  v_gst := case when nullif(p ->> 'gst_amount', '') is null then null else app.money(p ->> 'gst_amount', 'GST amount', true) end;

  if v_ledger_id is not null then
    v_ledger := app.lock_ledger(v_ledger_id, false);
    if v_ledger.workspace_id <> v_ws then
      raise exception 'Ledger not found' using errcode = 'P0002';
    end if;
    v_txn := app.insert_txn(v_ledger_id, v_ws, v_date, 'out', v_amount, 'expense',
      jsonb_build_object('description', p ->> 'title', 'counterparty', p ->> 'vendor',
        'payment_mode', p ->> 'payment_mode', 'reference_no', p ->> 'reference_no'),
      'posted', 'member', case when v_idem is null then null else 'exp:' || v_idem end);
  end if;

  insert into public.expenses (
    workspace_id, category_id, expense_date, title, amount, vendor, payment_mode, reference_no,
    contractor_id, ledger_id, transaction_id, gst_rate, gst_amount, notes, idempotency_key, created_by)
  values (
    v_ws, (p ->> 'category_id')::uuid, v_date, coalesce(app.clean_text(p ->> 'title', 200), 'Expense'), v_amount,
    app.clean_text(p ->> 'vendor', 160), app.payment_mode(p ->> 'payment_mode'), app.clean_text(p ->> 'reference_no', 80),
    nullif(p ->> 'contractor_id', '')::uuid, v_ledger_id, v_txn,
    case when nullif(p ->> 'gst_rate', '') is null then null else app.rate(p ->> 'gst_rate', 'GST rate', 50) end,
    v_gst, app.clean_text(p ->> 'notes', 2000), v_idem, app.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'transaction_id', v_txn, 'duplicate', false);
end $$;

create or replace function public.update_expense(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.expenses;
begin
  select * into e from public.expenses where id = p_id for update;
  if not found then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;
  perform app.require_write(e.workspace_id);
  if e.status = 'void' then
    raise exception 'A void expense cannot be changed' using errcode = '22023';
  end if;
  update public.expenses set
    category_id = coalesce(nullif(p ->> 'category_id', '')::uuid, category_id),
    expense_date = case when p ? 'expense_date' then app.txn_date(p ->> 'expense_date') else expense_date end,
    title = coalesce(app.clean_text(p ->> 'title', 200), title),
    amount = case when p ? 'amount' then app.money(p ->> 'amount', 'Amount') else amount end,
    vendor = case when p ? 'vendor' then app.clean_text(p ->> 'vendor', 160) else vendor end,
    payment_mode = case when p ? 'payment_mode' then app.payment_mode(p ->> 'payment_mode') else payment_mode end,
    reference_no = case when p ? 'reference_no' then app.clean_text(p ->> 'reference_no', 80) else reference_no end,
    contractor_id = case when p ? 'contractor_id' then nullif(p ->> 'contractor_id', '')::uuid else contractor_id end,
    gst_rate = case when p ? 'gst_rate' then
      (case when nullif(p ->> 'gst_rate', '') is null then null else app.rate(p ->> 'gst_rate', 'GST rate', 50) end) else gst_rate end,
    gst_amount = case when p ? 'gst_amount' then
      (case when nullif(p ->> 'gst_amount', '') is null then null else app.money(p ->> 'gst_amount', 'GST amount', true) end) else gst_amount end,
    notes = case when p ? 'notes' then app.clean_text(p ->> 'notes', 2000) else notes end,
    updated_by = app.uid()
  where id = p_id
  returning * into e;

  -- Keep the linked ledger entry identical to its expense.
  if e.transaction_id is not null then
    perform app.lock_ledger(e.ledger_id, false);
    update public.transactions set
      txn_date = e.expense_date, amount = e.amount, description = e.title, counterparty = e.vendor,
      payment_mode = e.payment_mode, reference_no = e.reference_no, updated_by = app.uid()
    where id = e.transaction_id;
  end if;
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
  update public.expenses set status = 'void', void_reason = v_reason, updated_by = app.uid() where id = p_id;
  if e.transaction_id is not null then
    update public.transactions
    set status = 'void', void_reason = v_reason, voided_at = now(), voided_by = app.uid(), updated_by = app.uid()
    where id = e.transaction_id and status <> 'void';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Advances
-- outstanding = advance - cash recovered - amount adjusted against bills
-- ---------------------------------------------------------------------------------------------
create or replace function app.advance_outstanding(p_advance uuid) returns numeric
language sql stable set search_path = '' as $$
  select a.amount - coalesce((select sum(x.amount) from public.advance_allocations x
                              where x.advance_id = a.id and x.status = 'active'), 0)
  from public.advances a where a.id = p_advance
$$;

create or replace function public.create_advance(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := (p ->> 'workspace_id')::uuid;
  v_idem text := nullif(p ->> 'idempotency_key', '');
  v_existing uuid;
  v_amount numeric := app.money(p ->> 'amount', 'Amount');
  v_date date := app.txn_date(p ->> 'given_date');
  v_ledger_id uuid := nullif(p ->> 'ledger_id', '')::uuid;
  v_ledger public.ledgers;
  v_contractor public.contractors;
  v_txn uuid;
  v_id uuid;
begin
  perform app.require_write(v_ws);
  if v_idem is not null then
    select id into v_existing from public.advances where workspace_id = v_ws and idempotency_key = v_idem;
    if v_existing is not null then
      return jsonb_build_object('id', v_existing, 'duplicate', true);
    end if;
  end if;
  select * into v_contractor from public.contractors where id = (p ->> 'contractor_id')::uuid and workspace_id = v_ws;
  if not found then
    raise exception 'Choose a contractor' using errcode = '22023';
  end if;

  if v_ledger_id is not null then
    v_ledger := app.lock_ledger(v_ledger_id, false);
    if v_ledger.workspace_id <> v_ws then
      raise exception 'Ledger not found' using errcode = 'P0002';
    end if;
    v_txn := app.insert_txn(v_ledger_id, v_ws, v_date, 'out', v_amount, 'advance_given',
      jsonb_build_object('description', coalesce('Advance: ' || app.clean_text(p ->> 'purpose', 200), 'Advance given'),
        'counterparty', v_contractor.name, 'payment_mode', p ->> 'payment_mode', 'reference_no', p ->> 'reference_no'),
      'posted', 'member', case when v_idem is null then null else 'adv:' || v_idem end);
  end if;

  insert into public.advances (
    workspace_id, contractor_id, ledger_id, transaction_id, given_date, amount, payment_mode, reference_no,
    purpose, notes, expected_recovery_date, idempotency_key, created_by)
  values (
    v_ws, v_contractor.id, v_ledger_id, v_txn, v_date, v_amount, app.payment_mode(p ->> 'payment_mode'),
    app.clean_text(p ->> 'reference_no', 80), app.clean_text(p ->> 'purpose', 200), app.clean_text(p ->> 'notes', 2000),
    nullif(p ->> 'expected_recovery_date', '')::date, v_idem, app.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'transaction_id', v_txn, 'duplicate', false);
end $$;

-- Cash recovery (Money In) or adjustment against a bill (no cash). The advance row is locked,
-- so concurrent allocations cannot together exceed the outstanding amount.
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
  if v_bill is not null and not exists (
      select 1 from public.transactions t where t.id = v_bill and t.workspace_id = a.workspace_id
        and t.kind = 'invoice' and t.status = 'posted') then
    raise exception 'Choose a posted bill from this workspace' using errcode = '22023';
  end if;

  if v_kind = 'recovery' and a.ledger_id is not null then
    perform app.lock_ledger(a.ledger_id, false);
    select name into v_name from public.contractors where id = a.contractor_id;
    v_txn := app.insert_txn(a.ledger_id, a.workspace_id, v_date, 'in', v_amount, 'advance_recovery',
      jsonb_build_object('description', 'Advance recovered', 'counterparty', v_name,
        'payment_mode', p ->> 'payment_mode', 'reference_no', p ->> 'bill_reference'),
      'posted', 'member', case when v_idem is null then null else 'rec:' || v_idem end);
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
    update public.transactions
    set status = 'void', void_reason = v_reason, voided_at = now(), voided_by = app.uid(), updated_by = app.uid()
    where id = x.transaction_id and status <> 'void';
  end if;
end $$;

create or replace function public.void_advance(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  a public.advances;
  v_reason text := app.clean_text(p_reason, 300);
begin
  select * into a from public.advances where id = p_id for update;
  if not found then
    raise exception 'Advance not found' using errcode = 'P0002';
  end if;
  perform app.require_write(a.workspace_id);
  if v_reason is null then
    raise exception 'Give a reason' using errcode = '22023';
  end if;
  if exists (select 1 from public.advance_allocations where advance_id = p_id and status = 'active') then
    raise exception 'Void the recoveries and adjustments of this advance first' using errcode = '22023';
  end if;
  update public.advances set status = 'void', void_reason = v_reason where id = p_id;
  if a.transaction_id is not null then
    update public.transactions
    set status = 'void', void_reason = v_reason, voided_at = now(), voided_by = app.uid(), updated_by = app.uid()
    where id = a.transaction_id and status <> 'void';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Personal & shared ledgers
-- Participant net position:
--   net = paid for shared expenses - own shares + settlements paid - settlements received
-- Positive => others owe this participant. The sum over all participants is always zero.
-- ---------------------------------------------------------------------------------------------
create or replace function app.participant_net(p_participant uuid) returns numeric
language sql stable set search_path = '' as $$
  select
      coalesce((select sum(py.amount_paid) from public.shared_expense_payers py
                join public.shared_expenses e on e.id = py.shared_expense_id
                where py.participant_id = p_participant and e.status = 'posted'), 0)
    - coalesce((select sum(sh.share_amount) from public.shared_expense_shares sh
                join public.shared_expenses e on e.id = sh.shared_expense_id
                where sh.participant_id = p_participant and e.status = 'posted'), 0)
    + coalesce((select sum(s.amount) from public.settlements s
                where s.from_participant_id = p_participant and s.status = 'posted'), 0)
    - coalesce((select sum(s.amount) from public.settlements s
                where s.to_participant_id = p_participant and s.status = 'posted'), 0)
$$;

-- Validates and writes payers/shares. Shares are computed by the app (src/lib/split.ts) from
-- the chosen method; the database insists they reconcile exactly with the total.
create or replace function app.write_shared_expense(p_ledger public.ledgers, p jsonb, p_via text, p_replaces uuid)
returns uuid
language plpgsql set search_path = '' as $$
declare
  v_total numeric := app.money(p ->> 'total_amount', 'Total amount');
  v_method text := p ->> 'split_method';
  v_id uuid;
  v_item jsonb;
  v_paid numeric := 0;
  v_shared numeric := 0;
  v_inputs numeric := 0;
  v_share numeric;
  v_min numeric;
  v_max numeric;
  v_count integer := 0;
begin
  if v_method not in ('equal', 'exact', 'percent', 'shares') then
    raise exception 'Choose how to split the expense' using errcode = '22023';
  end if;
  if jsonb_typeof(p -> 'payers') <> 'array' or jsonb_array_length(p -> 'payers') = 0 then
    raise exception 'Choose who paid' using errcode = '22023';
  end if;
  if jsonb_typeof(p -> 'shares') <> 'array' or jsonb_array_length(p -> 'shares') = 0 then
    raise exception 'Choose who shares this expense' using errcode = '22023';
  end if;

  insert into public.shared_expenses (
    workspace_id, ledger_id, txn_date, description, total_amount, split_method, category, payment_mode,
    reference_no, notes, replaces_id, idempotency_key, created_by)
  values (
    p_ledger.workspace_id, p_ledger.id, app.txn_date(p ->> 'txn_date'),
    coalesce(app.clean_text(p ->> 'description', 200), 'Shared expense'), v_total, v_method,
    app.clean_text(p ->> 'category', 60), app.payment_mode(p ->> 'payment_mode'),
    app.clean_text(p ->> 'reference_no', 80), app.clean_text(p ->> 'notes', 2000), p_replaces,
    nullif(p ->> 'idempotency_key', ''), app.uid())
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p -> 'payers') loop
    insert into public.shared_expense_payers (shared_expense_id, ledger_id, participant_id, amount_paid)
    values (v_id, p_ledger.id, (v_item ->> 'participant_id')::uuid, app.money(v_item ->> 'amount', 'Amount paid'));
    v_paid := v_paid + (v_item ->> 'amount')::numeric;
  end loop;

  for v_item in select * from jsonb_array_elements(p -> 'shares') loop
    v_share := app.money(v_item ->> 'amount', 'Share', true);
    insert into public.shared_expense_shares (shared_expense_id, ledger_id, participant_id, share_amount, share_input)
    values (v_id, p_ledger.id, (v_item ->> 'participant_id')::uuid, v_share, nullif(v_item ->> 'input', '')::numeric);
    v_shared := v_shared + v_share;
    v_inputs := v_inputs + coalesce(nullif(v_item ->> 'input', '')::numeric, 0);
    v_min := least(coalesce(v_min, v_share), v_share);
    v_max := greatest(coalesce(v_max, v_share), v_share);
    v_count := v_count + 1;
  end loop;

  if v_paid <> v_total then
    raise exception 'Amounts paid (%) must add up to the total (%)', v_paid, v_total using errcode = '22023';
  end if;
  if v_shared <> v_total then
    raise exception 'Shares (%) must add up to the total (%)', v_shared, v_total using errcode = '22023';
  end if;
  if v_method = 'equal' and v_max - v_min > 0.01 then
    raise exception 'An equal split cannot differ by more than one paisa' using errcode = '22023';
  end if;
  if v_method = 'percent' and v_inputs <> 100 then
    raise exception 'Percentages must add up to 100' using errcode = '22023';
  end if;
  return v_id;
end $$;

create or replace function public.create_shared_expense(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ledger_id uuid := (p ->> 'ledger_id')::uuid;
  v_via text;
  v public.ledgers;
  v_existing uuid;
  v_id uuid;
begin
  v_via := app.require_ledger_create(v_ledger_id);
  v := app.lock_ledger(v_ledger_id, true);
  if nullif(p ->> 'idempotency_key', '') is not null then
    select id into v_existing from public.shared_expenses where ledger_id = v_ledger_id and idempotency_key = p ->> 'idempotency_key';
    if v_existing is not null then
      return jsonb_build_object('id', v_existing, 'duplicate', true);
    end if;
  end if;
  v_id := app.write_shared_expense(v, p, v_via, null);
  return jsonb_build_object('id', v_id, 'duplicate', false);
end $$;

-- Correction: voids the original and writes the corrected record in one step. Both stay in history.
create or replace function public.correct_shared_expense(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e public.shared_expenses;
  v public.ledgers;
  v_via text;
  v_id uuid;
begin
  select * into e from public.shared_expenses where id = p_id;
  if not found then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;
  v_via := app.require_ledger_edit(e.ledger_id, e.created_by);
  v := app.lock_ledger(e.ledger_id, true);
  select * into e from public.shared_expenses where id = p_id for update;
  if e.status = 'void' then
    raise exception 'This expense was already voided or corrected' using errcode = '22023';
  end if;
  update public.shared_expenses set status = 'void', void_reason = 'Corrected', updated_by = app.uid() where id = p_id;
  v_id := app.write_shared_expense(v, p - 'idempotency_key', v_via, p_id);
  return jsonb_build_object('id', v_id);
end $$;

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
  perform app.require_ledger_edit(e.ledger_id, e.created_by);
  perform app.lock_ledger(e.ledger_id, true);
  if v_reason is null then
    raise exception 'Give a reason' using errcode = '22023';
  end if;
  update public.shared_expenses set status = 'void', void_reason = v_reason, updated_by = app.uid()
  where id = p_id and status = 'posted';
end $$;

-- Repayment between two participants. Never a new shared expense. It may not exceed what the
-- payer owes or what the receiver is owed.
create or replace function public.record_settlement(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ledger_id uuid := (p ->> 'ledger_id')::uuid;
  v public.ledgers;
  v_from uuid := (p ->> 'from_participant_id')::uuid;
  v_to uuid := (p ->> 'to_participant_id')::uuid;
  v_amount numeric := app.money(p ->> 'amount', 'Amount');
  v_owes numeric;
  v_owed numeric;
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
  v_owes := -app.participant_net(v_from);
  v_owed := app.participant_net(v_to);
  if v_owes <= 0 then
    raise exception 'Nothing is outstanding from this person' using errcode = '22023';
  end if;
  if v_amount > least(v_owes, v_owed) then
    raise exception 'Repayment is more than the outstanding amount of %', least(v_owes, v_owed) using errcode = '22023';
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
  update public.settlements set status = 'void', void_reason = v_reason where id = p_id and status = 'posted';
end $$;
