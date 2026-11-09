-- Delete instead of void, everywhere.
--
-- A mistake is removed, not kept as a crossed-out row. Every delete takes every part of the record
-- with it in one step (an expense and its wallet entry; a split and every share; a transfer's two
-- halves; a payment and its cash and TDS entries), and refuses to delete one part on its own, so
-- nothing is ever left half there. Entries already voided are removed too.
--
-- The activity log keeps only that something was deleted, by whom and when, not its content.
-- Issued invoices keep Cancel: an invoice number, once issued, has to stay on record for GST.
-- Reversal stays as a separate, dated action (a bounced payment, a refund).

-- ---------------------------------------------------------------------------------------------
-- The activity log records a delete without the deleted content.
-- ---------------------------------------------------------------------------------------------
create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_ws uuid;
  v_ledger uuid;
  v_entity text;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_ignored text[] := array['updated_at', 'last_activity_at', 'next_seq', 'token_hash', 'token_ciphertext'];
  v_masked text[] := array['gstin', 'pan'];
begin
  v_ws := case when tg_table_name = 'workspaces' then (v_row ->> 'id')::uuid else (v_row ->> 'workspace_id')::uuid end;
  v_ledger := case when tg_table_name = 'ledgers' then (v_row ->> 'id')::uuid else (v_row ->> 'ledger_id')::uuid end;
  v_entity := coalesce(v_row ->> 'id', v_row ->> 'transaction_id');

  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_new) loop
      if not (v_key = any (v_ignored)) and (v_new -> v_key) is distinct from (v_old -> v_key) then
        if v_key = any (v_masked) then
          v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('from', '[hidden]', 'to', '[hidden]'));
        else
          v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key));
        end if;
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;
    end if;
  elsif tg_op = 'INSERT' then
    v_changes := v_new - v_ignored;
    foreach v_key in array v_masked loop
      if v_changes ? v_key and v_changes ->> v_key is not null then
        v_changes := jsonb_set(v_changes, array[v_key], '"[hidden]"'::jsonb);
      end if;
    end loop;
  end if;
  -- DELETE: no content is kept, only that it happened.

  insert into public.audit_logs (workspace_id, ledger_id, entity_type, entity_id, action, actor_user_id, actor_role, changes)
  values (v_ws, v_ledger, tg_table_name, v_entity, lower(tg_op), app.uid(), app.actor_role(v_ws, v_ledger), v_changes);
  return null;
end $$;

-- Content already kept for earlier deletes goes too.
alter table public.audit_logs disable trigger audit_logs_immutable;
update public.audit_logs set changes = '{}'::jsonb where action = 'delete' and changes <> '{}'::jsonb;
alter table public.audit_logs enable trigger audit_logs_immutable;

-- ---------------------------------------------------------------------------------------------
-- An entry that is part of something else is deleted from that thing, never on its own.
-- app.linked_op is set only while one of the delete functions below removes all the parts.
-- ---------------------------------------------------------------------------------------------
create or replace function app.guard_txn_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_no text;
begin
  if coalesce(current_setting('app.linked_op', true), '') = '1' then
    return old;
  end if;
  select invoice_no into v_no from public.invoices where transaction_id = old.id;
  if v_no is null then
    select i.invoice_no into v_no from public.invoice_payments p join public.invoices i on i.id = p.invoice_id
    where old.id in (p.transaction_id, p.reversal_transaction_id, p.tds_transaction_id);
  end if;
  if v_no is not null then
    raise exception 'This entry belongs to invoice %. Change it from the invoice.', v_no using errcode = '22023';
  end if;
  if exists (select 1 from public.split_groups where transaction_id = old.id) then
    raise exception 'This entry belongs to a split expense. Delete it from Expenses.' using errcode = '22023';
  end if;
  if exists (select 1 from public.settlements where transaction_id = old.id) then
    raise exception 'This entry is a payment on a client account. Delete it from their page.' using errcode = '22023';
  end if;
  if exists (select 1 from public.expenses where transaction_id = old.id) then
    raise exception 'This entry belongs to an expense. Delete it from Expenses.' using errcode = '22023';
  end if;
  if exists (select 1 from public.advances where transaction_id = old.id)
     or exists (select 1 from public.advance_allocations where old.id in (transaction_id, bill_transaction_id)) then
    raise exception 'This entry belongs to an advance. Delete it from the advance.' using errcode = '22023';
  end if;
  if old.transfer_id is not null then
    raise exception 'This is half of a transfer between wallets. Delete the transfer instead.' using errcode = '22023';
  end if;
  return old;
end $$;

drop trigger if exists transactions_guard_delete on public.transactions;
create trigger transactions_guard_delete before delete on public.transactions
  for each row execute function app.guard_txn_delete();

-- Removes entries and anything that reverses them. Callers have already checked access.
create or replace function app.drop_txns(p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;
  perform set_config('app.linked_op', '1', true);
  delete from public.attachments where entity_id = any (p_ids);
  delete from public.transactions where reversal_of = any (p_ids);
  delete from public.transactions where id = any (p_ids);
  perform set_config('app.linked_op', '', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Delete functions, one per kind of record
-- ---------------------------------------------------------------------------------------------
create or replace function app.drop_split_group(p_group uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_txn uuid;
begin
  select transaction_id into v_txn from public.split_groups where id = p_group for update;
  perform set_config('app.linked_op', '1', true);
  update public.shared_expenses set replaces_id = null where replaces_id in (select id from public.shared_expenses where split_group_id = p_group);
  delete from public.shared_expenses where split_group_id = p_group;
  delete from public.expenses where split_group_id = p_group;
  delete from public.split_groups where id = p_group;
  perform app.drop_txns(array[v_txn]);
end $$;

create or replace function public.delete_expense(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.expenses;
begin
  select * into e from public.expenses where id = p_id for update;
  if not found then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;
  perform app.require_write(e.workspace_id);
  if e.split_group_id is not null then
    perform app.drop_split_group(e.split_group_id);
    return;
  end if;
  perform set_config('app.linked_op', '1', true);
  delete from public.attachments where entity_id = p_id;
  delete from public.expenses where id = p_id;
  perform app.drop_txns(array[e.transaction_id]);
end $$;

-- A share of a split crosses several accounts, so it needs workspace write access and takes the
-- whole split; a client who can see one share cannot remove the others.
create or replace function public.delete_shared_expense(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.shared_expenses;
begin
  select * into e from public.shared_expenses where id = p_id;
  if not found then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;
  if e.split_group_id is not null then
    perform app.require_write(e.workspace_id);
    perform app.drop_split_group(e.split_group_id);
    return;
  end if;
  perform app.require_ledger_edit(e.ledger_id, e.created_by);
  perform app.lock_ledger(e.ledger_id, true);
  update public.shared_expenses set replaces_id = null where replaces_id = p_id;
  delete from public.shared_expenses where id = p_id;
end $$;

-- A correction replaces the record in one step; the old one is removed, not kept.
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
  if e.split_group_id is not null then
    raise exception 'This is part of a split expense. Delete it and add it again.' using errcode = '22023';
  end if;
  v_via := app.require_ledger_edit(e.ledger_id, e.created_by);
  v := app.lock_ledger(e.ledger_id, true);
  select * into e from public.shared_expenses where id = p_id for update;
  update public.shared_expenses set replaces_id = null where replaces_id = p_id;
  delete from public.shared_expenses where id = p_id;
  v_id := app.write_shared_expense(v, p - 'idempotency_key', v_via, null);
  update public.shared_expenses set book_kind = e.book_kind where id = v_id;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.delete_settlement(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.settlements;
  v_txns uuid[];
begin
  select * into s from public.settlements where id = p_id;
  if not found then
    raise exception 'Repayment not found' using errcode = 'P0002';
  end if;
  perform app.require_ledger_edit(s.ledger_id, s.created_by);
  perform app.lock_ledger(s.ledger_id, true);
  if s.transaction_id is not null or s.contra_id is not null then
    perform app.require_write(s.workspace_id); -- it moved cash, or it is half of a two-person settle
  end if;
  select coalesce(array_agg(transaction_id) filter (where transaction_id is not null), '{}') into v_txns
  from public.settlements where id = p_id or (s.contra_id is not null and contra_id = s.contra_id);
  delete from public.settlements where id = p_id or (s.contra_id is not null and contra_id = s.contra_id);
  perform app.drop_txns(v_txns);
end $$;

create or replace function public.delete_advance_allocation(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  x public.advance_allocations;
begin
  select * into x from public.advance_allocations where id = p_id for update;
  if not found then
    raise exception 'Recovery not found' using errcode = 'P0002';
  end if;
  perform app.require_write(x.workspace_id);
  delete from public.advance_allocations where id = p_id;
  perform app.drop_txns(array[x.transaction_id]);
end $$;

create or replace function public.delete_advance(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  a public.advances;
  v_txns uuid[];
begin
  select * into a from public.advances where id = p_id for update;
  if not found then
    raise exception 'Advance not found' using errcode = 'P0002';
  end if;
  perform app.require_write(a.workspace_id);
  -- Its recoveries and adjustments go with it.
  select coalesce(array_agg(transaction_id) filter (where transaction_id is not null), '{}') into v_txns
  from public.advance_allocations where advance_id = p_id;
  delete from public.advance_allocations where advance_id = p_id;
  delete from public.attachments where entity_id = p_id;
  delete from public.advances where id = p_id;
  perform app.drop_txns(v_txns || a.transaction_id);
end $$;

create or replace function public.delete_transfer(p_transfer uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_ids uuid[];
begin
  select workspace_id, array_agg(id) into v_ws, v_ids from public.transactions where transfer_id = p_transfer group by workspace_id;
  if v_ws is null then
    raise exception 'Transfer not found' using errcode = 'P0002';
  end if;
  perform app.require_write(v_ws);
  perform app.drop_txns(v_ids);
end $$;

-- A payment and everything it wrote: its cash entry, its TDS entry, any reversal of them.
create or replace function public.delete_invoice_payment(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.invoice_payments;
begin
  select * into p from public.invoice_payments where id = p_id;
  if not found then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;
  perform app.require_write(p.workspace_id);
  perform 1 from public.invoices where id = p.invoice_id for update;
  update public.invoice_payment_submissions set payment_id = null where payment_id = p_id;
  perform set_config('app.invoice_op', '1', true);
  delete from public.invoice_payments where id = p_id;
  perform app.drop_txns(array_remove(array[p.transaction_id, p.reversal_transaction_id, p.tds_transaction_id], null));
  perform set_config('app.invoice_op', '', true);
  perform app.refresh_invoice_money(p.invoice_id);
  perform app.invoice_event(p.workspace_id, p.invoice_id, 'payment_deleted', jsonb_build_object('amount', p.amount));
end $$;

-- An entry on a ledger. One that belongs to an expense, advance or tax payment takes that record
-- with it; one that belongs to an invoice, split, transfer or client payment is refused and says
-- where to delete it.
create or replace function public.delete_transaction(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.transactions;
  v_via text;
  v_ref uuid;
begin
  select * into t from public.transactions where id = p_id for update;
  if not found then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;
  v_via := app.require_ledger_edit(t.ledger_id, t.created_by);
  if v_via = 'collaborator' and t.kind not in ('regular', 'invoice') then
    raise exception 'You do not have permission to delete this entry' using errcode = '42501';
  end if;
  perform app.lock_ledger(t.ledger_id, false);
  if t.kind = 'expense' then
    select id into v_ref from public.expenses where transaction_id = p_id;
    if v_ref is not null then
      perform public.delete_expense(v_ref);
      return;
    end if;
  elsif t.kind = 'advance_given' then
    select id into v_ref from public.advances where transaction_id = p_id;
    if v_ref is not null then
      perform public.delete_advance(v_ref);
      return;
    end if;
  elsif t.kind = 'advance_recovery' then
    select id into v_ref from public.advance_allocations where transaction_id = p_id;
    if v_ref is not null then
      perform public.delete_advance_allocation(v_ref);
      return;
    end if;
  end if;
  -- Anything that belongs elsewhere is refused by the table's guard, with where to go instead.
  delete from public.attachments where entity_id = p_id;
  delete from public.transactions where reversal_of = p_id;
  delete from public.transactions where id = p_id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Deleting a ledger: the same checks, now telling you what to delete first
-- ---------------------------------------------------------------------------------------------
create or replace function public.delete_ledger(p_ledger uuid, p_confirm text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.ledgers;
  v_rows uuid[];
  v_n integer;
  v_what text;
  v_files text[];
begin
  select * into v from public.ledgers where id = p_ledger for update;
  if not found then
    raise exception 'Ledger not found' using errcode = 'P0002';
  end if;
  perform app.require_admin(v.workspace_id);
  if lower(btrim(coalesce(p_confirm, ''))) <> lower(btrim(v.name)) then
    raise exception 'Type the ledger name exactly to delete it' using errcode = '22023';
  end if;
  select coalesce(array_agg(id), '{}') into v_rows from public.transactions where ledger_id = p_ledger;

  -- Anything still counting that lives outside this ledger blocks the delete.
  select string_agg(coalesce(invoice_no, 'a draft'), ', ') into v_what from public.invoices
  where (ledger_id = p_ledger or transaction_id = any (v_rows)) and status = 'issued' and invoice_type <> 'proforma';
  if v_what is not null then
    raise exception 'Invoice % is posted to this ledger. Cancel it first, or keep the ledger.', v_what using errcode = '22023';
  end if;
  select count(*) into v_n from public.invoice_payments where status = 'confirmed' and transaction_id = any (v_rows);
  if v_n > 0 then
    raise exception '% invoice payment(s) went into this ledger. Delete them on the invoice first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.expenses where status = 'active' and (ledger_id = p_ledger or transaction_id = any (v_rows));
  if v_n > 0 then
    raise exception '% expense(s) were paid from this ledger. Delete them in Expenses first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.split_groups where status = 'active' and transaction_id = any (v_rows);
  if v_n > 0 then
    raise exception '% split expense(s) were paid from this ledger. Delete them in Expenses first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.advances where status = 'active' and (ledger_id = p_ledger or transaction_id = any (v_rows));
  if v_n > 0 then
    raise exception '% advance(s) were paid from this ledger. Delete them in Advances first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.advance_allocations
  where status = 'active' and (transaction_id = any (v_rows) or bill_transaction_id = any (v_rows));
  if v_n > 0 then
    raise exception '% advance recovery or adjustment(s) use this ledger. Delete them on the advance first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.settlements where status = 'posted' and transaction_id = any (v_rows);
  if v_n > 0 then
    raise exception '% client payment(s) went through this ledger. Delete them on the client page first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.transactions where wallet_ledger_id = p_ledger and status = 'posted' and ledger_id <> p_ledger;
  if v_n > 0 then
    raise exception '% entr(ies) on client ledgers went through this wallet. Choose another wallet on them first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.shared_expenses where ledger_id = p_ledger and status = 'posted' and split_group_id is not null;
  if v_n > 0 then
    raise exception '% expense(s) here are part of a split with other people. Delete the split first.', v_n using errcode = '22023';
  end if;

  -- What is left outside only mentions the ledger and counts for nothing: unlink it, keep it.
  update public.invoices set ledger_id = null, transaction_id = null
  where ledger_id = p_ledger or transaction_id = any (v_rows);
  update public.invoice_payments set transaction_id = case when transaction_id = any (v_rows) then null else transaction_id end,
    reversal_transaction_id = case when reversal_transaction_id = any (v_rows) then null else reversal_transaction_id end
  where transaction_id = any (v_rows) or reversal_transaction_id = any (v_rows);
  update public.expenses set ledger_id = null, transaction_id = null where ledger_id = p_ledger or transaction_id = any (v_rows);
  update public.split_groups set transaction_id = null where transaction_id = any (v_rows);
  update public.advances set ledger_id = null, transaction_id = null where ledger_id = p_ledger or transaction_id = any (v_rows);
  update public.advance_allocations set
    transaction_id = case when transaction_id = any (v_rows) then null else transaction_id end,
    bill_transaction_id = case when bill_transaction_id = any (v_rows) then null else bill_transaction_id end
  where transaction_id = any (v_rows) or bill_transaction_id = any (v_rows);
  update public.settlements set transaction_id = null where transaction_id = any (v_rows) and ledger_id <> p_ledger;
  update public.transactions set wallet_ledger_id = null where wallet_ledger_id = p_ledger and ledger_id <> p_ledger;

  -- Then the ledger and everything in it. The audit log keeps a record of each row removed.
  select coalesce(array_agg(storage_path), '{}') into v_files from public.attachments where ledger_id = p_ledger;
  delete from public.attachments where ledger_id = p_ledger;
  delete from public.ledger_collaborators where ledger_id = p_ledger;
  delete from public.invitations where ledger_id = p_ledger;
  delete from public.share_links where ledger_id = p_ledger;
  delete from public.settlements where ledger_id = p_ledger;
  delete from public.shared_expenses where ledger_id = p_ledger;
  delete from public.transactions where ledger_id = p_ledger;
  delete from public.import_batches where ledger_id = p_ledger;
  delete from public.ledger_participants where ledger_id = p_ledger;
  delete from public.ledgers where id = p_ledger;
  return jsonb_build_object('name', v.name, 'entries', coalesce(array_length(v_rows, 1), 0), 'files', to_jsonb(v_files));
end $$;

-- ---------------------------------------------------------------------------------------------
-- No more voiding: the old functions go
-- ---------------------------------------------------------------------------------------------
drop function if exists public.void_transaction(uuid, text);
drop function if exists public.void_expense(uuid, text);
drop function if exists public.void_shared_expense(uuid, text);
drop function if exists public.void_settlement(uuid, text);
drop function if exists public.void_advance_allocation(uuid, text);
drop function if exists public.void_advance(uuid, text);
drop function if exists public.void_transfer(uuid, text);
drop function if exists app.void_split_group(uuid, text);

-- ---------------------------------------------------------------------------------------------
-- Entries already voided are removed
-- ---------------------------------------------------------------------------------------------
do $$
declare
  v_txns uuid[];
begin
  perform set_config('app.linked_op', '1', true);
  -- Records first, then the entries they pointed at.
  update public.shared_expenses set replaces_id = null where replaces_id in (select id from public.shared_expenses where status = 'void');
  delete from public.shared_expenses where status = 'void';
  delete from public.settlements where status = 'void';
  select coalesce(array_agg(transaction_id), '{}') into v_txns from (
    select transaction_id from public.advance_allocations where status = 'void' and transaction_id is not null
    union all select transaction_id from public.advances where status = 'void' and transaction_id is not null
    union all select transaction_id from public.expenses where status = 'void' and transaction_id is not null
    union all select transaction_id from public.split_groups where status = 'void' and transaction_id is not null
  ) x;
  delete from public.advance_allocations where status = 'void' or advance_id in (select id from public.advances where status = 'void');
  delete from public.advances where status = 'void';
  delete from public.expenses where status = 'void';
  delete from public.split_groups where status = 'void';
  -- Any other record still naming a void entry lets go of it.
  update public.advance_allocations set bill_transaction_id = null
  where bill_transaction_id in (select id from public.transactions where status = 'void');
  delete from public.attachments where entity_id in (select id from public.transactions where status = 'void') or entity_id = any (v_txns);
  delete from public.transactions where status = 'void' and reversal_of is not null;
  delete from public.transactions where status = 'void' or id = any (v_txns);
  perform set_config('app.linked_op', '', true);
end $$;

revoke all on function app.guard_txn_delete() from public, anon, authenticated;
revoke all on function app.drop_txns(uuid[]) from public, anon, authenticated;
revoke all on function app.drop_split_group(uuid) from public, anon, authenticated;
revoke all on function public.delete_expense(uuid) from public, anon;
revoke all on function public.delete_shared_expense(uuid) from public, anon;
revoke all on function public.delete_settlement(uuid) from public, anon;
revoke all on function public.delete_advance_allocation(uuid) from public, anon;
revoke all on function public.delete_advance(uuid) from public, anon;
revoke all on function public.delete_transfer(uuid) from public, anon;
revoke all on function public.delete_invoice_payment(uuid) from public, anon;
revoke all on function public.delete_transaction(uuid) from public, anon;
grant execute on function public.delete_expense(uuid) to authenticated;
grant execute on function public.delete_shared_expense(uuid) to authenticated;
grant execute on function public.delete_settlement(uuid) to authenticated;
grant execute on function public.delete_advance_allocation(uuid) to authenticated;
grant execute on function public.delete_advance(uuid) to authenticated;
grant execute on function public.delete_transfer(uuid) to authenticated;
grant execute on function public.delete_invoice_payment(uuid) to authenticated;
grant execute on function public.delete_transaction(uuid) to authenticated;
