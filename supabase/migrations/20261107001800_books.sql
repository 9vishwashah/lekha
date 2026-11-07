-- The books: where money lives, what every entry means, and clients who link both ways.
--
-- A wallet is a cash book that holds your own money (cash in hand, a bank account). A party ledger
-- is an account with someone. Money that moves on a party ledger or an invoice can name the wallet
-- it went through. That is a pointer on the one entry, not a second entry, so nothing can drift
-- apart, and a void, reversal or correction needs no cascade.
--
-- A wallet entry that is not a payment for anything can say what it was (income, expense, capital,
-- drawings, a transfer). Without that it stays uncategorised rather than being guessed into profit.

-- ---------------------------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------------------------
alter table public.ledgers add column if not exists wallet_kind text;
alter table public.ledgers drop constraint if exists ledgers_wallet_kind_check;
alter table public.ledgers add constraint ledgers_wallet_kind_check
  check (wallet_kind is null or (wallet_kind in ('cash', 'bank') and perspective = 'cashbook'));

alter table public.transactions add column if not exists wallet_ledger_id uuid;
alter table public.transactions add column if not exists nature text;
alter table public.transactions drop constraint if exists transactions_nature_check;
alter table public.transactions add constraint transactions_nature_check
  check (nature is null or nature in ('income', 'expense', 'capital', 'drawings', 'transfer'));
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_wallet_fk') then
    alter table public.transactions add constraint transactions_wallet_fk
      foreign key (wallet_ledger_id, workspace_id) references public.ledgers (id, workspace_id);
  end if;
end $$;
create index if not exists transactions_wallet_idx on public.transactions (wallet_ledger_id) where wallet_ledger_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Rules on entries, on the table so that every path obeys them
-- ---------------------------------------------------------------------------------------------
create or replace function app.txn_wallet_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o public.transactions;
  v_host text;
  v_wallet text;
begin
  -- A reversal goes back through the same wallet and means the same thing as what it reverses.
  if tg_op = 'INSERT' and new.reversal_of is not null then
    select * into o from public.transactions where id = new.reversal_of;
    new.wallet_ledger_id := o.wallet_ledger_id;
    new.nature := o.nature;
  end if;
  if new.wallet_ledger_id is null and new.nature is null then
    return new;
  end if;
  select perspective into v_host from public.ledgers where id = new.ledger_id;
  if new.wallet_ledger_id is not null then
    select perspective into v_wallet from public.ledgers where id = new.wallet_ledger_id and workspace_id = new.workspace_id;
    if v_wallet is distinct from 'cashbook' then
      raise exception 'Choose a cash or bank ledger' using errcode = '22023';
    end if;
    if v_host <> 'party' then
      raise exception 'This entry is already in a cash or bank ledger' using errcode = '22023';
    end if;
    if not new.is_cash and new.reversal_of is null then
      raise exception 'Only money that moved can go through a wallet' using errcode = '22023';
    end if;
  end if;
  if new.nature is not null and v_host <> 'cashbook' then
    raise exception 'Only an entry in a cash or bank ledger can be categorised' using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists transactions_wallet_rules on public.transactions;
create trigger transactions_wallet_rules before insert or update of wallet_ledger_id, nature on public.transactions
  for each row execute function app.txn_wallet_rules();

create or replace function app.insert_txn(
  p_ledger uuid, p_ws uuid, p_date date, p_direction text, p_amount numeric, p_kind text,
  p_fields jsonb, p_status text, p_via text, p_idem text,
  p_reversal_of uuid default null, p_batch uuid default null, p_row integer default null
) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_seq record;
  v_flags record;
  v_id uuid;
begin
  if p_direction not in ('in', 'out') then
    raise exception 'Choose Money In or Money Out' using errcode = '22023';
  end if;
  if p_status not in ('draft', 'posted') then
    raise exception 'Status must be draft or posted' using errcode = '22023';
  end if;
  select * into v_seq from app.next_seq(p_ledger);
  select * into v_flags from app.kind_flags(p_kind);
  insert into public.transactions (
    workspace_id, ledger_id, seq, voucher_no, txn_date, direction, amount, kind, is_cash, affects_party,
    description, counterparty, payment_mode, reference_no, notes, status, reversal_of,
    import_batch_id, import_row, idempotency_key, created_by, created_via, wallet_ledger_id, nature)
  values (
    p_ws, p_ledger, v_seq.seq, v_seq.voucher_no, p_date, p_direction, p_amount, p_kind,
    v_flags.is_cash, v_flags.affects_party,
    app.clean_text(p_fields ->> 'description', 500), app.clean_text(p_fields ->> 'counterparty', 160),
    app.payment_mode(p_fields ->> 'payment_mode'), app.clean_text(p_fields ->> 'reference_no', 80),
    app.clean_text(p_fields ->> 'notes', 2000), p_status, p_reversal_of,
    p_batch, p_row, p_idem, app.uid(), p_via,
    nullif(p_fields ->> 'wallet_ledger_id', '')::uuid, nullif(p_fields ->> 'nature', ''))
  returning id into v_id;
  return v_id;
end $$;

-- Say afterwards which wallet an entry went through, or what it was. Only the meaning changes:
-- the amount, date and direction stay as recorded.
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
  if p ? 'nature' and t.kind <> 'regular' then
    raise exception 'This entry already says what it is' using errcode = '22023';
  end if;
  update public.transactions set
    wallet_ledger_id = case when p ? 'wallet_ledger_id' then nullif(p ->> 'wallet_ledger_id', '')::uuid else wallet_ledger_id end,
    nature = case when p ? 'nature' then nullif(p ->> 'nature', '') else nature end,
    updated_by = app.uid()
  where id = p_id or (reversal_of = p_id and status = 'posted');
end $$;

-- An expense is a cost. Paid "from" a party ledger it would also read as money they owe you, so
-- the same rupees would count twice. New ones go through a wallet.
create or replace function app.expense_needs_wallet() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.ledger_id is not null and exists (select 1 from public.ledgers where id = new.ledger_id and perspective = 'party') then
    raise exception 'Choose a cash or bank ledger. A party ledger would count this expense twice.' using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists expenses_need_wallet on public.expenses;
create trigger expenses_need_wallet before insert on public.expenses
  for each row execute function app.expense_needs_wallet();

-- ---------------------------------------------------------------------------------------------
-- Ledgers: a ledger with a client is an account with them, never a cash book
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_ledger(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := (p ->> 'workspace_id')::uuid;
  v_type text := p ->> 'ledger_type';
  v_client_id uuid := case when p ->> 'ledger_type' = 'personal' then null else nullif(p ->> 'contractor_id', '')::uuid end;
  v_wallet text := nullif(p ->> 'wallet_kind', '');
  v_perspective text;
  v_id uuid;
  v_ledger public.ledgers;
  v_client text;
  v_pos integer := 1;
  v_ws_row public.workspaces;
begin
  perform app.require_write(v_ws);
  select * into v_ws_row from public.workspaces where id = v_ws;
  if v_type not in ('basic', 'taxation', 'personal') then
    raise exception 'Choose a ledger type' using errcode = '22023';
  end if;
  if v_wallet is not null and v_client_id is not null then
    raise exception 'A cash or bank ledger holds your own money, so it has no client' using errcode = '22023';
  end if;
  v_perspective := case
    when v_type = 'personal' then 'personal'
    when v_wallet is not null then 'cashbook'
    when v_client_id is not null then 'party'
    else coalesce(nullif(p ->> 'perspective', ''), 'cashbook') end;
  if v_perspective not in ('cashbook', 'party', 'personal') then
    raise exception 'Choose how the balance should be read' using errcode = '22023';
  end if;

  insert into public.ledgers (
    workspace_id, contractor_id, name, ledger_type, perspective, reference_no, opening_balance,
    opening_balance_date, description, notes, gst_mode, color, owner_user_id, voucher_prefix, wallet_kind)
  values (
    v_ws, v_client_id,
    coalesce(app.clean_text(p ->> 'name', 120), 'Untitled ledger'),
    v_type, v_perspective, app.clean_text(p ->> 'reference_no', 60),
    case when v_type = 'personal' then 0 else app.signed_money(p ->> 'opening_balance', 'Opening balance') end,
    nullif(p ->> 'opening_balance_date', '')::date,
    app.clean_text(p ->> 'description', 500), app.clean_text(p ->> 'notes', 2000),
    coalesce(nullif(p ->> 'gst_mode', ''), v_ws_row.default_gst_mode),
    coalesce(nullif(p ->> 'color', ''), case v_type when 'basic' then 'mustard' when 'taxation' then 'lavender' else 'pink' end),
    app.uid(),
    case v_type when 'basic' then 'BL' when 'taxation' then 'TX' else 'PS' end, v_wallet)
  returning * into v_ledger;
  v_id := v_ledger.id;

  if v_type = 'personal' then
    insert into public.ledger_participants (workspace_id, ledger_id, display_name, user_id, position)
    values (v_ws, v_id, coalesce(app.clean_text(p ->> 'owner_name', 60), 'You'), app.uid(), 0);
    for v_client in select jsonb_array_elements_text(coalesce(p -> 'participant_client_ids', '[]'::jsonb)) loop
      perform app.add_client_participant(v_ledger, v_client::uuid, v_pos);
      v_pos := v_pos + 1;
    end loop;
    if v_pos < 2 then
      raise exception 'Add at least one other person to a shared account' using errcode = '22023';
    end if;
  end if;
  return v_id;
end $$;

create or replace function public.update_ledger(p_ledger uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.ledgers;
  v_client uuid;
  v_has_entries boolean;
  v_perspective text;
begin
  select * into v from public.ledgers where id = p_ledger for update;
  if not found then
    raise exception 'Ledger not found' using errcode = 'P0002';
  end if;
  perform app.require_write(v.workspace_id);
  v_has_entries := exists (select 1 from public.transactions where ledger_id = p_ledger and status <> 'void');
  v_client := case when p ? 'contractor_id' and not v.is_direct then nullif(p ->> 'contractor_id', '')::uuid else v.contractor_id end;
  v_perspective := case when p ? 'perspective' and v.ledger_type <> 'personal' and p ->> 'perspective' in ('cashbook', 'party')
    then p ->> 'perspective' else v.perspective end;
  -- A client given to a cash book makes it an account with them, if nothing has been written yet.
  if v_client is distinct from v.contractor_id and v_client is not null and v.ledger_type <> 'personal' then
    if v.wallet_kind is not null then
      raise exception 'A cash or bank ledger holds your own money, so it has no client' using errcode = '22023';
    end if;
    if v_perspective = 'cashbook' then
      if v_has_entries then
        raise exception 'This cash book already has entries, so it cannot become an account with a client. Create a new ledger instead.' using errcode = '22023';
      end if;
      v_perspective := 'party';
    end if;
  end if;
  -- The same entries mean opposite things in each perspective, so history would silently invert.
  if v_perspective <> v.perspective and v_has_entries then
    raise exception 'This ledger already has entries, so how its balance is read cannot change. Create a new ledger instead.' using errcode = '22023';
  end if;
  update public.ledgers set
    name = coalesce(app.clean_text(p ->> 'name', 120), name),
    contractor_id = v_client,
    reference_no = case when p ? 'reference_no' then app.clean_text(p ->> 'reference_no', 60) else reference_no end,
    description = case when p ? 'description' then app.clean_text(p ->> 'description', 500) else description end,
    notes = case when p ? 'notes' then app.clean_text(p ->> 'notes', 2000) else notes end,
    opening_balance = case when p ? 'opening_balance' and v.ledger_type <> 'personal'
      then app.signed_money(p ->> 'opening_balance', 'Opening balance') else opening_balance end,
    opening_balance_date = case when p ? 'opening_balance_date' then nullif(p ->> 'opening_balance_date', '')::date else opening_balance_date end,
    perspective = v_perspective,
    wallet_kind = case when p ? 'wallet_kind' and v_perspective = 'cashbook' then nullif(p ->> 'wallet_kind', '') else wallet_kind end,
    gst_mode = coalesce(nullif(p ->> 'gst_mode', ''), gst_mode),
    color = coalesce(nullif(p ->> 'color', ''), color)
  where id = p_ledger;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Wallets
-- ---------------------------------------------------------------------------------------------
create or replace function app.seed_wallets(p_ws uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  w public.workspaces;
begin
  select * into w from public.workspaces where id = p_ws;
  if not exists (select 1 from public.ledgers where workspace_id = p_ws and wallet_kind = 'cash') then
    insert into public.ledgers (workspace_id, name, ledger_type, perspective, wallet_kind, color, owner_user_id, voucher_prefix)
    values (p_ws, 'Cash in Hand', 'basic', 'cashbook', 'cash', 'tea', w.owner_user_id, 'CS');
  end if;
  if not exists (select 1 from public.ledgers where workspace_id = p_ws and wallet_kind = 'bank') then
    insert into public.ledgers (workspace_id, name, ledger_type, perspective, wallet_kind, color, owner_user_id, voucher_prefix)
    values (p_ws, 'Bank & UPI', 'basic', 'cashbook', 'bank', 'sky', w.owner_user_id, 'BK');
  end if;
end $$;

-- The wallet a payment mode points to when nobody chose one. Oldest first, so it never moves.
create or replace function app.default_wallet(p_ws uuid, p_mode text) returns uuid
language sql stable set search_path = '' as $$
  select id from public.ledgers
  where workspace_id = p_ws and status = 'active'
    and wallet_kind = case when p_mode = 'cash' then 'cash' when p_mode in ('upi', 'bank_transfer', 'cheque', 'card') then 'bank' end
  order by created_at, id limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Invoice payments go through a wallet
-- ---------------------------------------------------------------------------------------------
drop function if exists app.apply_invoice_payment(uuid, numeric, date, text, text, text, text, text, boolean, text);
create or replace function app.apply_invoice_payment(
  p_invoice uuid, p_amount numeric, p_date date, p_mode text, p_reference text, p_notes text,
  p_source text, p_idem text, p_allow_excess boolean, p_via text, p_wallet uuid
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
begin
  select * into i from public.invoices where id = p_invoice for update;
  if i.status <> 'issued' then
    raise exception 'Payments can only be recorded on an issued invoice' using errcode = '22023';
  end if;
  if i.invoice_type = 'proforma' then
    raise exception 'A proforma is not a final invoice. Convert it to an invoice to record payments.' using errcode = '22023';
  end if;
  v_balance := i.grand_total - i.amount_received;
  if p_amount > v_balance and not p_allow_excess then
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
  insert into public.invoice_payments (id, workspace_id, invoice_id, amount, paid_on, mode, reference, notes, source,
    transaction_id, idempotency_key, created_by)
  values (v_id, i.workspace_id, p_invoice, p_amount, p_date, p_mode, v_ref, app.clean_text(p_notes, 1000), p_source,
    v_txn, p_idem, app.uid());
  perform app.refresh_invoice_money(p_invoice);
  perform app.invoice_event(i.workspace_id, p_invoice, 'payment_recorded',
    jsonb_build_object('amount', p_amount, 'source', p_source, 'mode', p_mode));
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
    case when p ? 'wallet_ledger_id' then nullif(p ->> 'wallet_ledger_id', '')::uuid else app.default_wallet(v_ws, v_mode) end);
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
      case when p ? 'wallet_ledger_id' then nullif(p ->> 'wallet_ledger_id', '')::uuid else app.default_wallet(c.workspace_id, c.mode) end);
  end if;
  update public.invoice_payment_submissions set status = case when p_accept then 'confirmed' else 'rejected' end,
    review_note = app.clean_text(p ->> 'note', 300), reviewed_by = app.uid(), reviewed_at = now(), payment_id = v_payment
  where id = p_id;
  perform app.invoice_event(c.workspace_id, c.invoice_id, case when p_accept then 'claim_confirmed' else 'claim_rejected' end, jsonb_build_object('amount', c.amount));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Clients link both ways
-- Link someone who is on Lekha, and you appear in their Client Accounts without them doing a thing.
-- Their card is theirs: unlinking on your side leaves it in place, and nothing about your books,
-- phone or email is copied, only your name.
-- ---------------------------------------------------------------------------------------------
create or replace function app.ensure_reciprocal_client(p_contractor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.contractors;
  w public.workspaces;
  v_them text;
  v_ws uuid;
  v_name text;
  v_card uuid;
begin
  select * into c from public.contractors where id = p_contractor;
  if c.id is null or c.linked_user_id is null or c.merged_into is not null then
    return;
  end if;
  v_them := c.linked_user_id;
  select * into w from public.workspaces where id = c.workspace_id;
  if v_them = w.owner_user_id
     or exists (select 1 from public.workspace_members where workspace_id = w.id and user_id = v_them) then
    return; -- yourself, or a teammate who already sees this workspace
  end if;
  if exists (select 1 from public.contractors x join public.workspaces y on y.id = x.workspace_id
             where x.linked_user_id = w.owner_user_id and y.owner_user_id = v_them) then
    return;
  end if;
  select id into v_ws from public.workspaces where owner_user_id = v_them order by created_at, id limit 1;
  if v_ws is null then
    return; -- no workspace yet: creating one picks this up
  end if;
  v_name := left(app.real_name_for(w.owner_user_id, w.id), 160);
  -- They may already have you as a client they typed in by hand.
  select id into v_card from public.contractors
  where workspace_id = v_ws and linked_user_id is null and is_active and merged_into is null and lower(name) = lower(v_name)
  order by created_at limit 1;
  if v_card is not null then
    update public.contractors set linked_user_id = w.owner_user_id where id = v_card;
  else
    insert into public.contractors (workspace_id, name, kind, linked_user_id, created_by)
    values (v_ws, v_name, 'personal', w.owner_user_id, v_them);
  end if;
exception
  when unique_violation then
    null; -- the same card was made a moment ago
end $$;

create or replace function app.contractor_linked() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.linked_user_id is not null then
    perform app.ensure_reciprocal_client(new.id);
  end if;
  return null;
end $$;

drop trigger if exists contractors_reciprocal_link on public.contractors;
create trigger contractors_reciprocal_link after insert or update of linked_user_id on public.contractors
  for each row execute function app.contractor_linked();

create or replace function app.workspace_created() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c record;
begin
  perform app.seed_wallets(new.id);
  for c in select id from public.contractors where linked_user_id = new.owner_user_id loop
    perform app.ensure_reciprocal_client(c.id);
  end loop;
  return null;
end $$;

drop trigger if exists workspaces_created on public.workspaces;
create trigger workspaces_created after insert on public.workspaces
  for each row execute function app.workspace_created();

-- ---------------------------------------------------------------------------------------------
-- Existing data
-- ---------------------------------------------------------------------------------------------
-- A cash book for a client that holds only bills was always meant as an account with them: its
-- balance reads zero because bills are not cash. Nothing changes meaning when it turns into a party
-- ledger. One holding real cash or an opening balance is left alone, because turning it would flip
-- the sign of that history; it stays a cash book and Books points it out.
update public.ledgers l set perspective = 'party'
where l.perspective = 'cashbook' and l.contractor_id is not null and l.ledger_type in ('basic', 'taxation')
  and l.opening_balance = 0
  and not exists (select 1 from public.transactions t where t.ledger_id = l.id and t.status <> 'void' and t.is_cash);

-- Existing cash books become wallets by their name; a client's cash book stays what it is.
update public.ledgers set wallet_kind = case when name ~* '\m(cash|petty)\M' then 'cash' else 'bank' end
where perspective = 'cashbook' and contractor_id is null and wallet_kind is null and status = 'active';

do $$
declare
  r record;
begin
  for r in select id from public.workspaces loop
    perform app.seed_wallets(r.id);
  end loop;
  for r in select id from public.contractors where linked_user_id is not null loop
    perform app.ensure_reciprocal_client(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------------------------
revoke all on function public.classify_entry(uuid, jsonb) from public, anon;
grant execute on function public.classify_entry(uuid, jsonb) to authenticated;
revoke all on function app.apply_invoice_payment(uuid, numeric, date, text, text, text, text, text, boolean, text, uuid) from public, anon, authenticated;
revoke all on function app.seed_wallets(uuid) from public, anon, authenticated;
revoke all on function app.default_wallet(uuid, text) from public, anon, authenticated;
revoke all on function app.ensure_reciprocal_client(uuid) from public, anon, authenticated;
revoke all on function app.contractor_linked() from public, anon, authenticated;
revoke all on function app.workspace_created() from public, anon, authenticated;
revoke all on function app.txn_wallet_rules() from public, anon, authenticated;
revoke all on function app.expense_needs_wallet() from public, anon, authenticated;
