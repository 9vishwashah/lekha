-- Tax paid to the Government names the wallet it left from.
--
-- A GST or TDS payment recorded on a client's taxation ledger can say which bank or cash wallet
-- paid it, in the same step. Like any payment on a client ledger it stays one entry that the wallet
-- also reads, so the wallet's balance goes down with it and moves with any edit, void or reversal.
-- On a taxation ledger that is itself a cash book, the payment already sits in that wallet.

create or replace function public.record_tax_settlement(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ledger_id uuid := (p ->> 'ledger_id')::uuid;
  v public.ledgers;
  v_idem text := nullif(p ->> 'idempotency_key', '');
  v_existing uuid;
  v_id uuid;
  v_tax_type text := p ->> 'tax_type';
  v_wallet uuid := nullif(p ->> 'wallet_ledger_id', '')::uuid;
begin
  perform app.require_write(app.ledger_workspace(v_ledger_id));
  v := app.lock_ledger(v_ledger_id, false);
  if v.ledger_type <> 'taxation' then
    raise exception 'Tax payments are recorded in a taxation ledger' using errcode = '22023';
  end if;
  if v_idem is not null then
    select id into v_existing from public.transactions where workspace_id = v.workspace_id and idempotency_key = v_idem;
    if v_existing is not null then
      return jsonb_build_object('id', v_existing, 'duplicate', true);
    end if;
  end if;
  if v_tax_type not in ('gst', 'tds', 'other') then
    raise exception 'Choose which tax was paid' using errcode = '22023';
  end if;
  if v.perspective <> 'party' then
    v_wallet := null; -- a cash-book ledger is its own wallet
  elsif v_wallet is not null then
    perform app.lock_cash_ledger(v_wallet, v.workspace_id);
  end if;
  v_id := app.insert_txn(v_ledger_id, v.workspace_id, app.txn_date(p ->> 'txn_date'), 'out',
    app.money(p ->> 'amount', 'Amount'), 'tax_settlement',
    jsonb_build_object(
      'description', coalesce(app.clean_text(p ->> 'description', 500), upper(v_tax_type) || ' paid to Government'),
      'payment_mode', p ->> 'payment_mode', 'reference_no', p ->> 'challan_no', 'notes', p ->> 'notes',
      'wallet_ledger_id', v_wallet),
    'posted', 'member', v_idem);
  insert into public.tax_settlements (transaction_id, workspace_id, ledger_id, tax_type, account_mapping, period_month, challan_no, settlement_status)
  values (v_id, v.workspace_id, v_ledger_id, v_tax_type,
    coalesce(nullif(p ->> 'account_mapping', ''), case v_tax_type when 'gst' then 'gst_payable' when 'tds' then 'tds_payable' else 'other' end),
    date_trunc('month', coalesce(nullif(p ->> 'period_month', '')::date, app.txn_date(p ->> 'txn_date')))::date,
    app.clean_text(p ->> 'challan_no', 60), coalesce(nullif(p ->> 'settlement_status', ''), 'completed'));
  return jsonb_build_object('id', v_id, 'duplicate', false);
end $$;
