-- TDS a client deducts when paying an invoice.
--
-- A client pays ₹11,70,000 into the bank and deducts ₹10,000 TDS: together they settle an
-- ₹11,80,000 invoice. The wallet receives only the cash. The ₹10,000 is not lost and not owed: it
-- is tax the client paid to the Government on your behalf, so it becomes your TDS credit under
-- Duties & Taxes. On a client ledger it is one non-cash entry beside the receipt, so that ledger
-- settles to zero too. Reversing the payment reverses both.

alter table public.invoice_payments add column if not exists tds_deducted numeric(14,2) not null default 0;
alter table public.invoice_payments drop constraint if exists invoice_payments_tds_check;
alter table public.invoice_payments add constraint invoice_payments_tds_check check (tds_deducted >= 0);
alter table public.invoice_payments add column if not exists tds_transaction_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_payments_tds_txn_fk') then
    alter table public.invoice_payments add constraint invoice_payments_tds_txn_fk
      foreign key (tds_transaction_id, workspace_id) references public.transactions (id, workspace_id) on delete set null (tds_transaction_id);
  end if;
end $$;

-- A non-cash entry that lowers what a client owes: TDS they deducted, now your credit.
alter table public.transactions drop constraint if exists transactions_kind_check;
alter table public.transactions add constraint transactions_kind_check check (kind in (
  'regular', 'invoice', 'tax_settlement', 'advance_given', 'advance_recovery', 'advance_adjustment', 'tds_credit', 'expense', 'reversal'
));

create or replace function app.kind_flags(p_kind text, out is_cash boolean, out affects_party boolean)
language sql immutable set search_path = '' as $$
  select
    p_kind in ('regular', 'tax_settlement', 'advance_given', 'advance_recovery', 'expense'),
    p_kind in ('regular', 'invoice', 'advance_given', 'advance_recovery', 'advance_adjustment', 'tds_credit', 'expense')
$$;

-- An invoice is settled by what was received and what the client deducted as TDS.
create or replace function app.refresh_invoice_money(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_total numeric;
begin
  select coalesce(sum(amount + tds_deducted), 0) into v_total from public.invoice_payments where invoice_id = p_id and status = 'confirmed';
  update public.invoices set amount_received = v_total,
    paid_at = case when grand_total > 0 and v_total >= grand_total then coalesce(paid_at, now()) end
  where id = p_id;
end $$;

-- The TDS half of a payment changes only with its payment.
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
  if exists (select 1 from public.invoice_payments where tds_transaction_id = v_target) then
    raise exception 'This is the TDS on an invoice payment. Change it from the invoice.' using errcode = '22023';
  end if;
  if exists (select 1 from public.transactions where id = v_target and transfer_id is not null) then
    raise exception 'This is half of a transfer between wallets. Void the transfer instead.' using errcode = '22023';
  end if;
  return new;
end $$;


drop function if exists app.apply_invoice_payment(uuid, numeric, date, text, text, text, text, text, boolean, text, uuid);
create or replace function app.apply_invoice_payment(
  p_invoice uuid, p_amount numeric, p_date date, p_mode text, p_reference text, p_notes text,
  p_source text, p_idem text, p_allow_excess boolean, p_via text, p_wallet uuid, p_tds numeric
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_balance numeric;
  v_ref text := app.clean_text(p_reference, 80);
  v_other text;
  v_id uuid;
  v_txn uuid;
  v_host text;
  v_target uuid;
  v_tds numeric := coalesce(p_tds, 0);
  v_tds_txn uuid;
begin
  select * into i from public.invoices where id = p_invoice for update;
  if i.status <> 'issued' then
    raise exception 'Payments can only be recorded on an issued invoice' using errcode = '22023';
  end if;
  if i.invoice_type = 'proforma' then
    raise exception 'A proforma is not a final invoice. Convert it to an invoice to record payments.' using errcode = '22023';
  end if;
  v_balance := i.grand_total - i.amount_received;
  if v_tds < 0 then
    raise exception 'Enter the TDS deducted as a positive amount' using errcode = '22023';
  end if;
  if p_amount + v_tds > v_balance and not p_allow_excess then
    raise exception 'That is more than the balance of ₹%. Confirm it as an excess payment if it is right.', v_balance using errcode = '22023';
  end if;
  if v_ref is not null then
    select x.invoice_no into v_other from public.invoice_payments p join public.invoices x on x.id = p.invoice_id
    where p.workspace_id = i.workspace_id and lower(p.reference) = lower(v_ref) and p.status = 'confirmed';
    if v_other is not null then
      raise exception 'Reference % is already recorded on invoice %', v_ref, v_other using errcode = '22023';
    end if;
  end if;
  if p_wallet is not null then
    perform app.lock_cash_ledger(p_wallet, i.workspace_id);
  end if;

  v_id := gen_random_uuid();
  select perspective into v_host from public.ledgers where id = i.ledger_id;
  -- On a party ledger the receipt sits there and names the wallet. Otherwise it is the wallet's own
  -- entry. With neither, the payment is still counted, as money not yet in a wallet.
  v_target := case when v_host = 'party' then i.ledger_id else coalesce(p_wallet, i.ledger_id) end;
  if v_target is not null then
    perform 1 from public.ledgers where id = v_target for update;
    v_txn := app.insert_txn(v_target, i.workspace_id, p_date, 'in', p_amount, 'regular',
      jsonb_build_object('description', 'Payment for invoice ' || i.invoice_no, 'counterparty', i.client_name,
        'payment_mode', p_mode, 'reference_no', coalesce(v_ref, left(i.invoice_no, 80)),
        'wallet_ledger_id', case when v_host = 'party' then p_wallet end),
      'posted', p_via, 'invpay:' || v_id::text);
  end if;
  -- On a client ledger the TDS also settles: one non-cash entry beside the receipt.
  if v_tds > 0 and v_host = 'party' then
    v_tds_txn := app.insert_txn(i.ledger_id, i.workspace_id, p_date, 'in', v_tds, 'tds_credit',
      jsonb_build_object('description', 'TDS deducted on invoice ' || i.invoice_no, 'counterparty', i.client_name,
        'reference_no', coalesce(v_ref, left(i.invoice_no, 80))),
      'posted', p_via, 'invtds:' || v_id::text);
  end if;
  insert into public.invoice_payments (id, workspace_id, invoice_id, amount, paid_on, mode, reference, notes, source,
    transaction_id, idempotency_key, created_by, tds_deducted, tds_transaction_id)
  values (v_id, i.workspace_id, p_invoice, p_amount, p_date, p_mode, v_ref, app.clean_text(p_notes, 1000), p_source,
    v_txn, p_idem, app.uid(), v_tds, v_tds_txn);
  perform app.refresh_invoice_money(p_invoice);
  perform app.invoice_event(i.workspace_id, p_invoice, 'payment_recorded',
    jsonb_build_object('amount', p_amount, 'tds', v_tds, 'source', p_source, 'mode', p_mode));
  return v_id;
end $$;

create or replace function public.record_invoice_payment(p_invoice uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_idem text := nullif(p ->> 'idempotency_key', '');
  v_mode text := app.payment_mode(p ->> 'mode');
  v_existing uuid;
  v_id uuid;
begin
  select workspace_id into v_ws from public.invoices where id = p_invoice;
  if v_ws is null then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(v_ws);
  if v_idem is not null then
    select id into v_existing from public.invoice_payments where workspace_id = v_ws and idempotency_key = v_idem;
    if found then
      return jsonb_build_object('id', v_existing, 'duplicate', true);
    end if;
  end if;
  v_id := app.apply_invoice_payment(p_invoice, app.money(p ->> 'amount', 'Amount'), app.txn_date(p ->> 'paid_on'),
    v_mode, p ->> 'reference', p ->> 'notes', 'manual', v_idem,
    coalesce((p ->> 'allow_excess')::boolean, false), 'member',
    case when p ? 'wallet_ledger_id' then nullif(p ->> 'wallet_ledger_id', '')::uuid else app.default_wallet(v_ws, v_mode) end,
    case when nullif(p ->> 'tds_deducted', '') is null then 0 else app.money(p ->> 'tds_deducted', 'TDS deducted', true) end);
  return jsonb_build_object('id', v_id, 'duplicate', false);
end $$;

create or replace function public.review_payment_submission(p_id uuid, p_accept boolean, p jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.invoice_payment_submissions;
  v_payment uuid;
begin
  select * into c from public.invoice_payment_submissions where id = p_id for update;
  if not found then
    raise exception 'Submission not found' using errcode = 'P0002';
  end if;
  perform app.require_write(c.workspace_id);
  if c.status <> 'pending' then
    raise exception 'This has already been reviewed' using errcode = '22023';
  end if;
  if p_accept then
    -- The issuer may correct what the client typed; the record posted is what they confirm.
    v_payment := app.apply_invoice_payment(c.invoice_id, app.money(coalesce(p ->> 'amount', c.amount::text), 'Amount'),
      app.txn_date(coalesce(p ->> 'paid_on', c.paid_on::text)), c.mode, coalesce(p ->> 'reference', c.reference),
      'Confirmed from client notification', 'client_claim', null, coalesce((p ->> 'allow_excess')::boolean, false), 'member',
      case when p ? 'wallet_ledger_id' then nullif(p ->> 'wallet_ledger_id', '')::uuid else app.default_wallet(c.workspace_id, c.mode) end,
      case when nullif(p ->> 'tds_deducted', '') is null then 0 else app.money(p ->> 'tds_deducted', 'TDS deducted', true) end);
  end if;
  update public.invoice_payment_submissions set status = case when p_accept then 'confirmed' else 'rejected' end,
    review_note = app.clean_text(p ->> 'note', 300), reviewed_by = app.uid(), reviewed_at = now(), payment_id = v_payment
  where id = p_id;
  perform app.invoice_event(c.workspace_id, c.invoice_id, case when p_accept then 'claim_confirmed' else 'claim_rejected' end, jsonb_build_object('amount', c.amount));
end $$;

create or replace function public.reverse_invoice_payment(p_id uuid, p_reason text, p_kind text default 'correction') returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.invoice_payments;
  v_reason text := app.clean_text(p_reason, 300);
  v_rev uuid;
begin
  select * into p from public.invoice_payments where id = p_id;
  if not found then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;
  perform app.require_write(p.workspace_id);
  perform 1 from public.invoices where id = p.invoice_id for update;
  select * into p from public.invoice_payments where id = p_id for update;
  if p.status <> 'confirmed' then
    raise exception 'This payment has already been reversed' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Give a reason' using errcode = '22023';
  end if;
  if p_kind not in ('correction', 'refund') then
    raise exception 'Choose correction or refund' using errcode = '22023';
  end if;
  if p.transaction_id is not null then
    v_rev := app.reverse_linked_txn(p.transaction_id, case p_kind when 'refund' then 'Refund: ' else 'Correction: ' end || v_reason, app.india_today(), 'member');
  end if;
  if p.tds_transaction_id is not null then
    perform set_config('app.linked_op', '1', true);
    perform app.reverse_linked_txn(p.tds_transaction_id, 'TDS: ' || v_reason, app.india_today(), 'member');
    perform set_config('app.linked_op', '', true);
  end if;
  update public.invoice_payments set status = 'reversed', reversal_kind = p_kind, reversal_reason = v_reason,
    reversal_transaction_id = v_rev, reversed_at = now(), reversed_by = app.uid()
  where id = p_id;
  perform app.refresh_invoice_money(p.invoice_id);
  perform app.invoice_event(p.workspace_id, p.invoice_id, 'payment_reversed', jsonb_build_object('amount', p.amount, 'kind', p_kind, 'reason', v_reason));
end $$;

revoke all on function app.apply_invoice_payment(uuid, numeric, date, text, text, text, text, text, boolean, text, uuid, numeric) from public, anon, authenticated;
