-- Ledgers are deleted, not archived.
--
-- Deleting removes the ledger and everything written in it, for good. It is refused while anything
-- outside the ledger still depends on it, so a delete can never leave an invoice, expense, advance,
-- split or payment pointing at money that no longer exists. Those are named in the refusal, so the
-- person knows exactly what to void or cancel first. Void and cancelled records that only mention
-- the ledger are unlinked and kept.
--
-- Archived ledgers already in place are left as they are, can be restored or deleted, and no
-- longer count in any total.

create or replace function public.set_ledger_status(p_ledger uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := app.ledger_workspace(p_ledger);
begin
  perform app.require_write(v_ws);
  if p_status = 'archived' then
    raise exception 'A ledger cannot be archived any more. Delete it, or keep it.' using errcode = '22023';
  end if;
  if p_status <> 'active' then
    raise exception 'Status must be active' using errcode = '22023';
  end if;
  update public.ledgers set status = 'active' where id = p_ledger;
end $$;

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
    raise exception '% invoice payment(s) went into this ledger. Reverse them on the invoice first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.expenses where status = 'active' and (ledger_id = p_ledger or transaction_id = any (v_rows));
  if v_n > 0 then
    raise exception '% expense(s) were paid from this ledger. Void them in Expenses first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.split_groups where status = 'active' and transaction_id = any (v_rows);
  if v_n > 0 then
    raise exception '% split expense(s) were paid from this ledger. Void them in Expenses first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.advances where status = 'active' and (ledger_id = p_ledger or transaction_id = any (v_rows));
  if v_n > 0 then
    raise exception '% advance(s) were paid from this ledger. Void them in Advances first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.advance_allocations
  where status = 'active' and (transaction_id = any (v_rows) or bill_transaction_id = any (v_rows));
  if v_n > 0 then
    raise exception '% advance recovery or adjustment(s) use this ledger. Void them on the advance first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.settlements where status = 'posted' and transaction_id = any (v_rows);
  if v_n > 0 then
    raise exception '% client payment(s) went through this ledger. Void them on the client page first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.transactions where wallet_ledger_id = p_ledger and status = 'posted' and ledger_id <> p_ledger;
  if v_n > 0 then
    raise exception '% entr(ies) on client ledgers went through this wallet. Choose another wallet on them first.', v_n using errcode = '22023';
  end if;
  select count(*) into v_n from public.shared_expenses where ledger_id = p_ledger and status = 'posted' and split_group_id is not null;
  if v_n > 0 then
    raise exception '% expense(s) here are part of a split with other people. Void the split first.', v_n using errcode = '22023';
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

revoke all on function public.delete_ledger(uuid, text) from public, anon;
grant execute on function public.delete_ledger(uuid, text) to authenticated;
