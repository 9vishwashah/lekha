-- A wallet's share link shows the same balance as the wallet screen.
--
-- Money received or paid on a party ledger can name the wallet it went through
-- (transactions.wallet_ledger_id). The wallet screen already lists those entries; the public share
-- payload only read the wallet's own rows, so a shared wallet showed a different (wrong) balance.
--
-- Also: the "last updated" stamp that share links and live views poll now moves when such an entry
-- changes, and when any entry is deleted (entries are deleted, not voided, since 20261109002400).

create or replace function app.public_ledger_payload(
  l public.ledgers, p_balance boolean, p_running boolean, p_tax boolean, p_reference boolean, p_counterparty boolean)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_contractor text;
  v_rows jsonb;
  v_people jsonb;
  v_expenses jsonb;
  v_settlements jsonb;
begin
  select name into v_contractor from public.contractors where id = l.contractor_id;
  if l.ledger_type = 'personal' then
    select coalesce(jsonb_agg(jsonb_build_object('key', p.position, 'name', p.display_name) order by p.position), '[]'::jsonb)
      into v_people from public.ledger_participants p where p.ledger_id = l.id;
    select coalesce(jsonb_agg(jsonb_build_object(
        'date', e.txn_date, 'description', e.description, 'total', e.total_amount, 'method', e.split_method,
        'category', e.category, 'created', e.created_at,
        'payers', (select jsonb_agg(jsonb_build_object('key', p.position, 'amount', py.amount_paid))
                   from public.shared_expense_payers py join public.ledger_participants p on p.id = py.participant_id
                   where py.shared_expense_id = e.id),
        'shares', (select jsonb_agg(jsonb_build_object('key', p.position, 'amount', sh.share_amount))
                   from public.shared_expense_shares sh join public.ledger_participants p on p.id = sh.participant_id
                   where sh.shared_expense_id = e.id))
        order by e.txn_date, e.created_at), '[]'::jsonb)
      into v_expenses from public.shared_expenses e where e.ledger_id = l.id and e.status = 'posted';
    select coalesce(jsonb_agg(jsonb_build_object(
        'date', st.txn_date, 'amount', st.amount, 'created', st.created_at,
        'from', (select position from public.ledger_participants where id = st.from_participant_id),
        'to', (select position from public.ledger_participants where id = st.to_participant_id))
        order by st.txn_date, st.created_at), '[]'::jsonb)
      into v_settlements from public.settlements st where st.ledger_id = l.id and st.status = 'posted';
  else
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'voucher_no', t.voucher_no, 'seq', t.seq, 'date', t.txn_date, 'direction', t.direction,
        'amount', t.amount, 'kind', t.kind, 'is_cash', t.is_cash, 'affects_party', t.affects_party,
        'description', t.description,
        -- An entry from a party ledger names that ledger when it has no payee of its own.
        'counterparty', case when p_counterparty then coalesce(t.counterparty, src.name) end,
        'reference_no', case when p_reference then t.reference_no end,
        -- Tax details belong to the ledger the bill was raised on, never shown through a wallet.
        'tax', case when p_tax and d.transaction_id is not null and t.ledger_id = l.id then jsonb_build_object(
          'invoice_no', d.invoice_no, 'taxable_amount', d.taxable_amount, 'gst_type', d.gst_type,
          'gst_rate', d.gst_rate, 'cgst_amount', d.cgst_amount, 'sgst_amount', d.sgst_amount,
          'igst_amount', d.igst_amount, 'gst_amount', d.gst_amount, 'tds_rate', d.tds_rate,
          'tds_base', d.tds_base, 'tds_amount', d.tds_amount, 'gross_amount', d.gross_amount,
          'net_amount', d.net_amount) end))
        order by t.txn_date, t.seq), '[]'::jsonb)
      into v_rows
    from public.transactions t
    left join public.transaction_tax_details d on d.transaction_id = t.id
    left join public.ledgers src on src.id = t.ledger_id and t.ledger_id <> l.id
    where t.status = 'posted'
      and (t.ledger_id = l.id or (l.perspective = 'cashbook' and t.wallet_ledger_id = l.id));
  end if;

  return jsonb_build_object(
    'ledger', jsonb_build_object(
      'name', l.name, 'ledger_type', l.ledger_type, 'perspective', l.perspective,
      'contractor_name', v_contractor,
      'opening_balance', case when p_balance then l.opening_balance end,
      'opening_balance_date', l.opening_balance_date,
      'last_activity_at', l.last_activity_at),
    'options', jsonb_build_object(
      'show_balance', p_balance, 'show_running_balance', p_running,
      'show_tax', p_tax, 'show_reference', p_reference, 'show_counterparty', p_counterparty),
    'transactions', coalesce(v_rows, '[]'::jsonb),
    'participants', v_people,
    'shared_expenses', v_expenses,
    'settlements', v_settlements);
end $$;

revoke all on function app.public_ledger_payload(public.ledgers, boolean, boolean, boolean, boolean, boolean) from public, anon, authenticated;

-- "Last updated" moves on the ledger an entry is in, and on the wallet it went through (old and new).
create or replace function app.touch_ledger_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  o jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
begin
  update public.ledgers set last_activity_at = now()
  where id in (
    (n ->> 'ledger_id')::uuid, (o ->> 'ledger_id')::uuid,
    (n ->> 'wallet_ledger_id')::uuid, (o ->> 'wallet_ledger_id')::uuid);
  return null;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['transactions', 'shared_expenses', 'settlements', 'transaction_tax_details'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_ledger_activity', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function app.touch_ledger_activity()',
      t || '_ledger_activity', t);
  end loop;
end $$;
