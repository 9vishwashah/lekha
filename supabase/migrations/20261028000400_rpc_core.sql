-- Core write paths: workspaces, contractors, ledgers, transactions and the tax engine.
-- Every function authorizes the caller first and runs inside one database transaction, so a
-- failure part-way through leaves nothing behind.

-- ---------------------------------------------------------------------------------------------
-- Input helpers
-- ---------------------------------------------------------------------------------------------
create or replace function app.clean_text(p_value text, p_max integer default 500) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := nullif(btrim(p_value), '');
begin
  if v is not null and char_length(v) > p_max then
    raise exception 'Text is longer than % characters', p_max using errcode = '22001';
  end if;
  return v;
end $$;

-- Parses a money value: positive (or zero when allowed), at most 2 decimals, within NUMERIC(14,2).
create or replace function app.money(p_value text, p_label text, p_allow_zero boolean default false) returns numeric
language plpgsql immutable set search_path = '' as $$
declare
  v numeric;
begin
  if p_value is null or btrim(p_value) = '' then
    raise exception '% is required', p_label using errcode = '22023';
  end if;
  begin
    v := btrim(p_value)::numeric;
  exception when others then
    raise exception '% must be a number', p_label using errcode = '22023';
  end;
  if v <> round(v, 2) then
    raise exception '% can have at most 2 decimal places', p_label using errcode = '22023';
  end if;
  if v < 0 or (v = 0 and not p_allow_zero) then
    raise exception '% must be greater than zero', p_label using errcode = '22023';
  end if;
  if v > 999999999999.99 then
    raise exception '% is too large', p_label using errcode = '22023';
  end if;
  return v;
end $$;

-- Signed amount (opening balances may be negative). Empty means zero.
create or replace function app.signed_money(p_value text, p_label text) returns numeric
language plpgsql immutable set search_path = '' as $$
declare
  v numeric;
begin
  if p_value is null or btrim(p_value) = '' then
    return 0;
  end if;
  begin
    v := btrim(p_value)::numeric;
  exception when others then
    raise exception '% must be a number', p_label using errcode = '22023';
  end;
  if v <> round(v, 2) or abs(v) > 999999999999.99 then
    raise exception '% must be a valid amount with at most 2 decimals', p_label using errcode = '22023';
  end if;
  return v;
end $$;

create or replace function app.rate(p_value text, p_label text, p_max numeric) returns numeric
language plpgsql immutable set search_path = '' as $$
declare
  v numeric;
begin
  if p_value is null or btrim(p_value) = '' then
    return 0;
  end if;
  begin
    v := btrim(p_value)::numeric;
  exception when others then
    raise exception '% must be a number', p_label using errcode = '22023';
  end;
  if v <> round(v, 3) or v < 0 or v > p_max then
    raise exception '% must be between 0 and % with up to 3 decimals', p_label, p_max using errcode = '22023';
  end if;
  return v;
end $$;

create or replace function app.txn_date(p_value text) returns date
language plpgsql stable set search_path = '' as $$
declare
  v date;
begin
  if p_value is null or btrim(p_value) = '' then
    raise exception 'Date is required' using errcode = '22023';
  end if;
  begin
    v := btrim(p_value)::date;
  exception when others then
    raise exception 'Date is not valid' using errcode = '22023';
  end;
  if v < date '1990-01-01' or v > (now() at time zone 'Asia/Kolkata')::date + 366 then
    raise exception 'Date is outside the allowed range' using errcode = '22023';
  end if;
  return v;
end $$;

create or replace function app.payment_mode(p_value text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := nullif(btrim(p_value), '');
begin
  if v is not null and v not in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other') then
    raise exception 'Payment mode is not valid' using errcode = '22023';
  end if;
  return v;
end $$;

-- How each kind of entry behaves: does it move cash, and does it change a party balance?
create or replace function app.kind_flags(p_kind text, out is_cash boolean, out affects_party boolean)
language sql immutable set search_path = '' as $$
  select
    p_kind in ('regular', 'tax_settlement', 'advance_given', 'advance_recovery', 'expense'),
    p_kind in ('regular', 'invoice', 'advance_given', 'advance_recovery', 'expense')
$$;

-- ---------------------------------------------------------------------------------------------
-- Tax engine (mirrors src/lib/tax.ts; parity is covered by tests)
--   gst   = round(taxable * gst_rate / 100, 2)            (0 when not applicable)
--   cgst  = round(gst / 2, 2), sgst = gst - cgst          (intra-state)
--   igst  = gst                                           (inter-state)
--   gross = taxable + gst
--   tds   = round(base * tds_rate / 100, 2)  base = taxable | gross
--   net   = gross - tds
-- NUMERIC round() is half-away-from-zero, identical to half-up for these non-negative values.
-- ---------------------------------------------------------------------------------------------
create or replace function app.compute_tax(
  p_taxable numeric, p_gst_applicable boolean, p_gst_type text, p_gst_rate numeric,
  p_tds_applicable boolean, p_tds_rate numeric, p_tds_base text
) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_type text := case when p_gst_applicable then p_gst_type else 'none' end;
  v_gst numeric := 0;
  v_cgst numeric := 0;
  v_sgst numeric := 0;
  v_igst numeric := 0;
  v_gross numeric;
  v_tds numeric := 0;
begin
  if p_gst_applicable and v_type not in ('intra', 'inter') then
    raise exception 'GST type must be intra-state or inter-state' using errcode = '22023';
  end if;
  if p_tds_base not in ('taxable', 'gross') then
    raise exception 'TDS base must be taxable or gross' using errcode = '22023';
  end if;
  if p_gst_applicable then
    v_gst := round(p_taxable * p_gst_rate / 100, 2);
    if v_type = 'intra' then
      v_cgst := round(v_gst / 2, 2);
      v_sgst := v_gst - v_cgst;
    else
      v_igst := v_gst;
    end if;
  end if;
  v_gross := p_taxable + v_gst;
  if p_tds_applicable then
    v_tds := round((case p_tds_base when 'gross' then v_gross else p_taxable end) * p_tds_rate / 100, 2);
  end if;
  return jsonb_build_object(
    'gst_type', v_type,
    'gst_amount', v_gst, 'cgst_amount', v_cgst, 'sgst_amount', v_sgst, 'igst_amount', v_igst,
    'gross_amount', v_gross, 'tds_amount', v_tds, 'net_amount', v_gross - v_tds);
end $$;

-- Inserts the tax row for a transaction from raw inputs. Returns the computed breakdown.
-- When p_tax carries explicit gst_amount / tds_amount (spreadsheet import), those amounts are kept
-- and the effective rates are derived for display; the totals are still recomputed here.
create or replace function app.write_tax_details(
  p_txn uuid, p_ws uuid, p_ledger uuid, p_default_gst_mode text, p_tax jsonb, p_replace boolean default false
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_taxable numeric := app.money(p_tax ->> 'taxable_amount', 'Taxable amount', true);
  v_gst_app boolean := coalesce((p_tax ->> 'gst_applicable')::boolean, false);
  v_gst_type text := coalesce(nullif(p_tax ->> 'gst_type', ''), p_default_gst_mode);
  v_gst_rate numeric := case when v_gst_app then app.rate(p_tax ->> 'gst_rate', 'GST rate', 50) else 0 end;
  v_tds_app boolean := coalesce((p_tax ->> 'tds_applicable')::boolean, false);
  v_tds_rate numeric := case when v_tds_app then app.rate(p_tax ->> 'tds_rate', 'TDS rate', 40) else 0 end;
  v_tds_base text := coalesce(nullif(p_tax ->> 'tds_base', ''), 'taxable');
  v_calc jsonb;
  v_explicit boolean := p_tax ? 'gst_amount' or p_tax ? 'tds_amount';
  v_gst numeric;
  v_tds numeric;
  v_cgst numeric;
begin
  if v_explicit then
    v_gst := app.money(coalesce(p_tax ->> 'gst_amount', '0'), 'GST amount', true);
    v_tds := app.money(coalesce(p_tax ->> 'tds_amount', '0'), 'TDS amount', true);
    v_gst_app := v_gst > 0;
    v_tds_app := v_tds > 0;
    v_gst_type := case when v_gst_app then v_gst_type else 'none' end;
    v_gst_rate := case when v_gst_app and v_taxable > 0 then least(round(v_gst * 100 / v_taxable, 3), 50) else 0 end;
    v_tds_rate := case when v_tds_app and v_taxable > 0 then least(round(v_tds * 100 / v_taxable, 3), 40) else 0 end;
    v_tds_base := 'taxable';
    v_cgst := case when v_gst_type = 'intra' then round(v_gst / 2, 2) else 0 end;
    if v_tds > v_taxable + v_gst then
      raise exception 'TDS cannot exceed the gross invoice amount' using errcode = '22023';
    end if;
    v_calc := jsonb_build_object(
      'gst_type', v_gst_type, 'gst_amount', v_gst,
      'cgst_amount', v_cgst,
      'sgst_amount', case when v_gst_type = 'intra' then v_gst - v_cgst else 0 end,
      'igst_amount', case when v_gst_type = 'inter' then v_gst else 0 end,
      'gross_amount', v_taxable + v_gst, 'tds_amount', v_tds, 'net_amount', v_taxable + v_gst - v_tds);
  else
    v_calc := app.compute_tax(v_taxable, v_gst_app, v_gst_type, v_gst_rate, v_tds_app, v_tds_rate, v_tds_base);
  end if;

  if p_replace then
    delete from public.transaction_tax_details where transaction_id = p_txn;
  end if;

  insert into public.transaction_tax_details (
    transaction_id, workspace_id, ledger_id, invoice_no, invoice_date, taxable_amount,
    gst_applicable, gst_type, gst_rate, cgst_amount, sgst_amount, igst_amount, gst_amount,
    tds_applicable, tds_section, tds_rate, tds_base, tds_amount, gross_amount, net_amount,
    tax_status, tax_notes)
  values (
    p_txn, p_ws, p_ledger, app.clean_text(p_tax ->> 'invoice_no', 60),
    nullif(p_tax ->> 'invoice_date', '')::date, v_taxable,
    v_gst_app, v_calc ->> 'gst_type', v_gst_rate,
    (v_calc ->> 'cgst_amount')::numeric, (v_calc ->> 'sgst_amount')::numeric,
    (v_calc ->> 'igst_amount')::numeric, (v_calc ->> 'gst_amount')::numeric,
    v_tds_app, app.clean_text(p_tax ->> 'tds_section', 20), v_tds_rate, v_tds_base,
    (v_calc ->> 'tds_amount')::numeric, (v_calc ->> 'gross_amount')::numeric, (v_calc ->> 'net_amount')::numeric,
    coalesce(nullif(p_tax ->> 'tax_status', ''), 'pending'), app.clean_text(p_tax ->> 'tax_notes', 500));
  return v_calc;
end $$;

-- Allocates the next voucher number. The caller must already hold the ledger row lock.
create or replace function app.next_seq(p_ledger uuid, out seq integer, out voucher_no text)
language plpgsql set search_path = '' as $$
begin
  update public.ledgers set next_seq = next_seq + 1
  where id = p_ledger
  returning next_seq - 1, voucher_prefix || '-' || lpad((next_seq - 1)::text, 4, '0')
  into seq, voucher_no;
end $$;

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
    import_batch_id, import_row, idempotency_key, created_by, created_via)
  values (
    p_ws, p_ledger, v_seq.seq, v_seq.voucher_no, p_date, p_direction, p_amount, p_kind,
    v_flags.is_cash, v_flags.affects_party,
    app.clean_text(p_fields ->> 'description', 500), app.clean_text(p_fields ->> 'counterparty', 160),
    app.payment_mode(p_fields ->> 'payment_mode'), app.clean_text(p_fields ->> 'reference_no', 80),
    app.clean_text(p_fields ->> 'notes', 2000), p_status, p_reversal_of,
    p_batch, p_row, p_idem, app.uid(), p_via)
  returning id into v_id;
  return v_id;
end $$;

-- Locks and returns a ledger for writing. Rejects archived and wrong-type ledgers.
create or replace function app.lock_ledger(p_ledger uuid, p_personal boolean) returns public.ledgers
language plpgsql set search_path = '' as $$
declare
  v public.ledgers;
begin
  select * into v from public.ledgers where id = p_ledger for update;
  if not found then
    raise exception 'Ledger not found' using errcode = 'P0002';
  end if;
  if v.status = 'archived' then
    raise exception 'This ledger is archived. Restore it to add entries.' using errcode = '22023';
  end if;
  if p_personal is not null and (v.ledger_type = 'personal') <> p_personal then
    raise exception 'This action is not available for this ledger type' using errcode = '22023';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Workspaces
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_workspace(p_name text, p_display_name text, p_email text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid text := app.uid();
  v_ws uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to continue' using errcode = '42501';
  end if;
  if (select count(*) from public.workspaces where owner_user_id = v_uid) >= 20 then
    raise exception 'You can own up to 20 workspaces' using errcode = '22023';
  end if;
  insert into public.workspaces (name, owner_user_id)
  values (coalesce(app.clean_text(p_name, 120), 'My workspace'), v_uid)
  returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role, display_name, email)
  values (v_ws, v_uid, 'owner', app.clean_text(p_display_name, 120), app.clean_text(p_email, 200));
  insert into public.expense_categories (workspace_id, name, is_default)
  select v_ws, c, true from unnest(array[
    'Materials', 'Labour', 'Transport', 'Food', 'Office', 'Service charges', 'Miscellaneous']) as c;
  return v_ws;
end $$;

create or replace function public.update_workspace(p_workspace uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_admin(p_workspace);
  update public.workspaces set
    name = coalesce(app.clean_text(p ->> 'name', 120), name),
    fy_start_month = coalesce((p ->> 'fy_start_month')::smallint, fy_start_month),
    default_gst_rate = case when nullif(p ->> 'default_gst_rate', '') is not null
      then app.rate(p ->> 'default_gst_rate', 'GST rate', 50) else default_gst_rate end,
    default_tds_rate = case when nullif(p ->> 'default_tds_rate', '') is not null
      then app.rate(p ->> 'default_tds_rate', 'TDS rate', 40) else default_tds_rate end,
    default_tds_base = coalesce(nullif(p ->> 'default_tds_base', ''), default_tds_base),
    default_gst_mode = coalesce(nullif(p ->> 'default_gst_mode', ''), default_gst_mode),
    timezone = coalesce(app.clean_text(p ->> 'timezone', 60), timezone)
  where id = p_workspace;
end $$;

create or replace function public.set_member_role(p_member uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.workspace_members;
begin
  select * into v from public.workspace_members where id = p_member;
  if not found then
    raise exception 'Member not found' using errcode = 'P0002';
  end if;
  perform app.require_admin(v.workspace_id);
  if v.role = 'owner' or p_role not in ('admin', 'member', 'viewer') then
    raise exception 'The owner role cannot be changed here' using errcode = '22023';
  end if;
  if v.user_id = app.uid() then
    raise exception 'You cannot change your own role' using errcode = '42501';
  end if;
  update public.workspace_members set role = p_role where id = p_member;
end $$;

create or replace function public.remove_member(p_member uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.workspace_members;
begin
  select * into v from public.workspace_members where id = p_member;
  if not found then
    raise exception 'Member not found' using errcode = 'P0002';
  end if;
  perform app.require_admin(v.workspace_id);
  if v.role = 'owner' then
    raise exception 'The workspace owner cannot be removed' using errcode = '42501';
  end if;
  delete from public.workspace_members where id = p_member;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Contractors
-- ---------------------------------------------------------------------------------------------
create or replace function public.contractor_tax_ids(p_contractor uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.contractors;
begin
  select * into v from public.contractors where id = p_contractor;
  if not found or not app.can_write(v.workspace_id) then
    return null;
  end if;
  return jsonb_build_object('gstin', v.gstin, 'pan', v.pan);
end $$;

-- Explicit, user-confirmed merge. Never automatic.
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
  update public.ledgers set contractor_id = p_into where contractor_id = p_from;
  update public.advances set contractor_id = p_into where contractor_id = p_from;
  update public.expenses set contractor_id = p_into where contractor_id = p_from;
  update public.contractors set is_active = false, merged_into = p_into where id = p_from;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Ledgers
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_ledger(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := (p ->> 'workspace_id')::uuid;
  v_type text := p ->> 'ledger_type';
  v_perspective text;
  v_id uuid;
  v_name text;
  v_pos integer := 1;
  v_ws_row public.workspaces;
begin
  perform app.require_write(v_ws);
  select * into v_ws_row from public.workspaces where id = v_ws;
  if v_type not in ('basic', 'taxation', 'personal') then
    raise exception 'Choose a ledger type' using errcode = '22023';
  end if;
  v_perspective := case when v_type = 'personal' then 'personal' else coalesce(nullif(p ->> 'perspective', ''), 'cashbook') end;
  if v_perspective not in ('cashbook', 'party', 'personal') then
    raise exception 'Choose how the balance should be read' using errcode = '22023';
  end if;

  insert into public.ledgers (
    workspace_id, contractor_id, name, ledger_type, perspective, reference_no, opening_balance,
    opening_balance_date, description, notes, gst_mode, color, owner_user_id, voucher_prefix)
  values (
    v_ws, nullif(p ->> 'contractor_id', '')::uuid, coalesce(app.clean_text(p ->> 'name', 120), 'Untitled ledger'),
    v_type, v_perspective, app.clean_text(p ->> 'reference_no', 60),
    case when v_type = 'personal' then 0 else app.signed_money(p ->> 'opening_balance', 'Opening balance') end,
    nullif(p ->> 'opening_balance_date', '')::date,
    app.clean_text(p ->> 'description', 500), app.clean_text(p ->> 'notes', 2000),
    coalesce(nullif(p ->> 'gst_mode', ''), v_ws_row.default_gst_mode),
    coalesce(nullif(p ->> 'color', ''), case v_type when 'basic' then 'mustard' when 'taxation' then 'lavender' else 'pink' end),
    app.uid(),
    case v_type when 'basic' then 'BL' when 'taxation' then 'TX' else 'PS' end)
  returning id into v_id;

  if v_type = 'personal' then
    insert into public.ledger_participants (workspace_id, ledger_id, display_name, user_id, position)
    values (v_ws, v_id, coalesce(app.clean_text(p ->> 'owner_name', 60), 'You'), app.uid(), 0);
    for v_name in select jsonb_array_elements_text(coalesce(p -> 'participants', '[]'::jsonb)) loop
      if app.clean_text(v_name, 60) is not null then
        insert into public.ledger_participants (workspace_id, ledger_id, display_name, position)
        values (v_ws, v_id, app.clean_text(v_name, 60), v_pos);
        v_pos := v_pos + 1;
      end if;
    end loop;
    if v_pos < 2 then
      raise exception 'Add at least one other person to a shared ledger' using errcode = '22023';
    end if;
  end if;
  return v_id;
end $$;

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
  update public.ledgers set
    name = coalesce(app.clean_text(p ->> 'name', 120), name),
    contractor_id = case when p ? 'contractor_id' then nullif(p ->> 'contractor_id', '')::uuid else contractor_id end,
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

create or replace function public.set_ledger_status(p_ledger uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := app.ledger_workspace(p_ledger);
begin
  perform app.require_write(v_ws);
  if p_status not in ('active', 'archived') then
    raise exception 'Status must be active or archived' using errcode = '22023';
  end if;
  update public.ledgers set status = p_status where id = p_ledger;
end $$;

create or replace function public.add_ledger_participant(p_ledger uuid, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v public.ledgers;
  v_id uuid;
begin
  v := app.lock_ledger(p_ledger, true);
  perform app.require_write(v.workspace_id);
  insert into public.ledger_participants (workspace_id, ledger_id, display_name, position)
  values (v.workspace_id, p_ledger, coalesce(app.clean_text(p_name, 60), 'Friend'),
    (select coalesce(max(position), 0) + 1 from public.ledger_participants where ledger_id = p_ledger))
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------------------------
create or replace function public.post_transaction(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ledger_id uuid := (p ->> 'ledger_id')::uuid;
  v_via text;
  v public.ledgers;
  v_kind text := coalesce(nullif(p ->> 'kind', ''), 'regular');
  v_idem text := nullif(p ->> 'idempotency_key', '');
  v_existing public.transactions;
  v_direction text := p ->> 'direction';
  v_amount numeric;
  v_tax jsonb := p -> 'tax';
  v_calc jsonb;
  v_id uuid;
begin
  v_via := app.require_ledger_create(v_ledger_id);
  v := app.lock_ledger(v_ledger_id, false);

  if v_idem is not null then
    select * into v_existing from public.transactions where workspace_id = v.workspace_id and idempotency_key = v_idem;
    if found then
      return jsonb_build_object('id', v_existing.id, 'voucher_no', v_existing.voucher_no, 'duplicate', true);
    end if;
  end if;

  if v_kind not in ('regular', 'invoice') then
    raise exception 'Use the dedicated form for this kind of entry' using errcode = '22023';
  end if;
  if v_tax is not null and jsonb_typeof(v_tax) = 'object' then
    if v.ledger_type <> 'taxation' then
      raise exception 'Tax details can only be added to a taxation ledger' using errcode = '22023';
    end if;
    if v_via = 'collaborator' and not coalesce((app.collaborator(v_ledger_id) ->> 'can_view_tax')::boolean, false) then
      raise exception 'You do not have permission to record tax details' using errcode = '42501';
    end if;
  else
    v_tax := null;
  end if;

  if v_kind = 'invoice' then
    if v_tax is null then
      raise exception 'A bill needs its tax breakdown' using errcode = '22023';
    end if;
    -- Placeholder amount; replaced with the computed net amount below.
    v_amount := 0.01;
  else
    v_amount := app.money(p ->> 'amount', 'Amount');
  end if;

  v_id := app.insert_txn(v_ledger_id, v.workspace_id, app.txn_date(p ->> 'txn_date'), v_direction, v_amount,
    v_kind, p, coalesce(nullif(p ->> 'status', ''), 'posted'), v_via, v_idem);

  if v_tax is not null then
    v_calc := app.write_tax_details(v_id, v.workspace_id, v_ledger_id, v.gst_mode, v_tax);
    if v_kind = 'invoice' then
      if (v_calc ->> 'net_amount')::numeric <= 0 then
        raise exception 'The bill amount after TDS must be greater than zero' using errcode = '22023';
      end if;
      update public.transactions set amount = (v_calc ->> 'net_amount')::numeric where id = v_id;
    end if;
  end if;

  return jsonb_build_object('id', v_id,
    'voucher_no', (select voucher_no from public.transactions where id = v_id), 'duplicate', false);
end $$;

-- Controlled amendment of an entry. Every changed field lands in the audit log.
create or replace function public.amend_transaction(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.transactions;
  v public.ledgers;
  v_calc jsonb;
  v_amount numeric;
begin
  select * into t from public.transactions where id = p_id for update;
  if not found then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;
  perform app.require_ledger_edit(t.ledger_id, t.created_by);
  v := app.lock_ledger(t.ledger_id, false);
  if t.status = 'void' then
    raise exception 'A void entry cannot be changed' using errcode = '22023';
  end if;
  if t.kind not in ('regular', 'invoice') then
    raise exception 'Change this entry from its expense, advance or tax payment record' using errcode = '22023';
  end if;
  if exists (select 1 from public.transactions r where r.reversal_of = p_id and r.status <> 'void') then
    raise exception 'This entry has been reversed and can no longer be changed' using errcode = '22023';
  end if;
  if p ? 'status' and p ->> 'status' not in ('draft', 'posted') then
    raise exception 'Status must be draft or posted' using errcode = '22023';
  end if;
  if t.status = 'posted' and p ->> 'status' = 'draft' then
    raise exception 'A posted entry cannot go back to draft' using errcode = '22023';
  end if;

  v_amount := case when t.kind = 'regular' and p ? 'amount' then app.money(p ->> 'amount', 'Amount') else t.amount end;

  update public.transactions set
    txn_date = case when p ? 'txn_date' then app.txn_date(p ->> 'txn_date') else txn_date end,
    direction = case when t.kind = 'regular' and p ->> 'direction' in ('in', 'out') then p ->> 'direction'
                     when t.kind = 'invoice' and p ->> 'direction' in ('in', 'out') then p ->> 'direction'
                     else direction end,
    amount = v_amount,
    description = case when p ? 'description' then app.clean_text(p ->> 'description', 500) else description end,
    counterparty = case when p ? 'counterparty' then app.clean_text(p ->> 'counterparty', 160) else counterparty end,
    payment_mode = case when p ? 'payment_mode' then app.payment_mode(p ->> 'payment_mode') else payment_mode end,
    reference_no = case when p ? 'reference_no' then app.clean_text(p ->> 'reference_no', 80) else reference_no end,
    notes = case when p ? 'notes' then app.clean_text(p ->> 'notes', 2000) else notes end,
    status = coalesce(nullif(p ->> 'status', ''), status),
    updated_by = app.uid()
  where id = p_id;

  if p ? 'tax' then
    if jsonb_typeof(p -> 'tax') = 'object' then
      if v.ledger_type <> 'taxation' then
        raise exception 'Tax details can only be added to a taxation ledger' using errcode = '22023';
      end if;
      if not app.can_view_ledger_tax(t.ledger_id) then
        raise exception 'You do not have permission to change tax details' using errcode = '42501';
      end if;
      v_calc := app.write_tax_details(p_id, t.workspace_id, t.ledger_id, v.gst_mode, p -> 'tax', true);
      if t.kind = 'invoice' then
        update public.transactions set amount = (v_calc ->> 'net_amount')::numeric where id = p_id;
      end if;
    elsif t.kind = 'regular' then
      delete from public.transaction_tax_details where transaction_id = p_id;
    end if;
  end if;
end $$;

-- Voiding keeps the row (struck through, excluded from totals) and cascades to linked records.
create or replace function public.void_transaction(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.transactions;
  v_reason text := app.clean_text(p_reason, 300);
  v_via text;
begin
  select * into t from public.transactions where id = p_id for update;
  if not found then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;
  v_via := app.require_ledger_edit(t.ledger_id, t.created_by);
  -- Advances, expenses and tax payments belong to the workspace, not to ledger collaborators.
  if v_via = 'collaborator' and t.kind not in ('regular', 'invoice') then
    raise exception 'You do not have permission to change this entry' using errcode = '42501';
  end if;
  perform app.lock_ledger(t.ledger_id, false);
  if v_reason is null then
    raise exception 'Give a reason for voiding this entry' using errcode = '22023';
  end if;
  if t.status = 'void' then
    return;
  end if;
  if exists (select 1 from public.transactions r where r.reversal_of = p_id and r.status <> 'void') then
    raise exception 'Void the reversal entry first' using errcode = '22023';
  end if;
  if t.kind = 'advance_given' then
    if exists (select 1 from public.advance_allocations a join public.advances ad on ad.id = a.advance_id
               where ad.transaction_id = p_id and a.status = 'active') then
      raise exception 'Void the recoveries and adjustments of this advance first' using errcode = '22023';
    end if;
    update public.advances set status = 'void', void_reason = v_reason where transaction_id = p_id;
  elsif t.kind = 'advance_recovery' then
    update public.advance_allocations set status = 'void', void_reason = v_reason where transaction_id = p_id;
  elsif t.kind = 'expense' then
    update public.expenses set status = 'void', void_reason = v_reason, updated_by = app.uid() where transaction_id = p_id;
  end if;
  update public.transactions
  set status = 'void', void_reason = v_reason, voided_at = now(), voided_by = app.uid(), updated_by = app.uid()
  where id = p_id;
end $$;

-- Reversal posts an equal and opposite entry; both remain visible and net to zero.
create or replace function public.reverse_transaction(p_id uuid, p_reason text, p_date text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.transactions;
  v_via text;
  v public.ledgers;
  v_reason text := app.clean_text(p_reason, 300);
  v_id uuid;
begin
  select * into t from public.transactions where id = p_id;
  if not found then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;
  v_via := app.require_ledger_edit(t.ledger_id, t.created_by);
  if v_via = 'collaborator' and t.kind not in ('regular', 'invoice') then
    raise exception 'You do not have permission to change this entry' using errcode = '42501';
  end if;
  v := app.lock_ledger(t.ledger_id, false);
  select * into t from public.transactions where id = p_id for update;
  if v_reason is null then
    raise exception 'Give a reason for the reversal' using errcode = '22023';
  end if;
  if t.status <> 'posted' or t.kind not in ('regular', 'invoice', 'tax_settlement') then
    raise exception 'Only posted regular entries, bills and tax payments can be reversed' using errcode = '22023';
  end if;
  if exists (select 1 from public.transactions r where r.reversal_of = p_id and r.status <> 'void') then
    raise exception 'This entry is already reversed' using errcode = '22023';
  end if;
  v_id := app.insert_txn(t.ledger_id, t.workspace_id, app.txn_date(coalesce(p_date, t.txn_date::text)),
    case t.direction when 'in' then 'out' else 'in' end, t.amount, 'reversal',
    jsonb_build_object('description', 'Reversal of ' || t.voucher_no || ': ' || v_reason,
      'counterparty', t.counterparty, 'reference_no', t.voucher_no),
    'posted', v_via, null, p_id);
  -- A reversal inherits the cash / party behaviour of the entry it cancels.
  update public.transactions set is_cash = t.is_cash, affects_party = t.affects_party where id = v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- "GST paid to Government" and similar. Moves cash, never changes a party balance.
create or replace function public.record_tax_settlement(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ledger_id uuid := (p ->> 'ledger_id')::uuid;
  v public.ledgers;
  v_idem text := nullif(p ->> 'idempotency_key', '');
  v_existing uuid;
  v_id uuid;
  v_tax_type text := p ->> 'tax_type';
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
  v_id := app.insert_txn(v_ledger_id, v.workspace_id, app.txn_date(p ->> 'txn_date'), 'out',
    app.money(p ->> 'amount', 'Amount'), 'tax_settlement',
    jsonb_build_object(
      'description', coalesce(app.clean_text(p ->> 'description', 500), upper(v_tax_type) || ' paid to Government'),
      'payment_mode', p ->> 'payment_mode', 'reference_no', p ->> 'challan_no', 'notes', p ->> 'notes'),
    'posted', 'member', v_idem);
  insert into public.tax_settlements (transaction_id, workspace_id, ledger_id, tax_type, account_mapping, period_month, challan_no, settlement_status)
  values (v_id, v.workspace_id, v_ledger_id, v_tax_type,
    coalesce(nullif(p ->> 'account_mapping', ''), case v_tax_type when 'gst' then 'gst_payable' when 'tds' then 'tds_payable' else 'other' end),
    date_trunc('month', coalesce(nullif(p ->> 'period_month', '')::date, app.txn_date(p ->> 'txn_date')))::date,
    app.clean_text(p ->> 'challan_no', 60), coalesce(nullif(p ->> 'settlement_status', ''), 'completed'));
  return jsonb_build_object('id', v_id, 'duplicate', false);
end $$;
