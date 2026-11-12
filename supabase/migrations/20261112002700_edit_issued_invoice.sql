-- Editing an issued invoice.
--
-- Until now an issued invoice could only have its notes, terms and due date amended; anything else
-- meant cancel and re-issue. public.edit_issued_invoice() edits everything (client, lines, rates,
-- dates, discounts, payment details) and keeps the rest consistent in the same transaction:
--   * the invoice keeps its number (or takes a new one you type), its share link and its payments;
--   * the receivable entry on the ledger is updated to the new total and date (never duplicated);
--   * the total cannot drop below what has already been received;
--   * paid / partly paid status is recalculated, and the change is on the invoice timeline.
-- Moving an invoice to another ledger, or between proforma and a real invoice, still means cancel
-- and issue a new one, because those change what is posted where.

create or replace function public.save_invoice(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_ws uuid := nullif(p ->> 'workspace_id', '')::uuid;
  i public.invoices;
  s public.invoice_settings;
  v_type text := coalesce(nullif(p ->> 'invoice_type', ''), 'service');
  v_contractor uuid := nullif(p ->> 'contractor_id', '')::uuid;
  v_ledger uuid := nullif(p ->> 'ledger_id', '')::uuid;
  v_gst boolean;
  v_date date := app.txn_date(p ->> 'invoice_date');
  v_due date := nullif(p ->> 'due_date', '')::date;
  v_no text := app.clean_text(p ->> 'invoice_no', 60);
  v_item jsonb;
  v_pos integer := 0;
  v_client text := app.clean_text(p ->> 'client_name', 160);
  v_gstin text := nullif(upper(btrim(p ->> 'client_gstin')), '');
  v_pan text := nullif(upper(btrim(p ->> 'client_pan')), '');
begin
  if v_id is not null then
    select * into i from public.invoices where id = v_id for update;
    if not found then
      raise exception 'Invoice not found' using errcode = 'P0002';
    end if;
    v_ws := i.workspace_id;
  end if;
  perform app.require_write(v_ws);
  -- Issued invoices are edited only through public.edit_issued_invoice(), which keeps the ledger
  -- entry, payments and number consistent and sets app.invoice_edit for this one call.
  if v_id is not null and i.status <> 'draft'
     and not (i.status = 'issued' and coalesce(current_setting('app.invoice_edit', true), '') = '1') then
    raise exception 'An issued invoice cannot be edited here. Use Edit on the invoice.' using errcode = '22023';
  end if;
  s := app.invoice_settings_row(v_ws);
  if v_type not in ('service', 'product', 'gst', 'project', 'proforma', 'custom') then
    raise exception 'Choose an invoice type' using errcode = '22023';
  end if;
  v_gst := s.gst_registered and (v_type = 'gst' or coalesce((p ->> 'gst_enabled')::boolean, false));
  if v_type = 'gst' and not s.gst_registered then
    raise exception 'Turn on GST registration in Invoice settings to issue a tax invoice' using errcode = '22023';
  end if;
  if v_due is not null and v_due < v_date then
    raise exception 'The due date cannot be before the invoice date' using errcode = '22023';
  end if;
  if v_gstin is not null and v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
    raise exception 'Enter a valid 15-character client GSTIN' using errcode = '22023';
  end if;
  if v_contractor is not null and not exists (select 1 from public.contractors where id = v_contractor and workspace_id = v_ws) then
    raise exception 'Choose a client from this workspace' using errcode = '22023';
  end if;
  if v_ledger is not null and not exists (select 1 from public.ledgers where id = v_ledger and workspace_id = v_ws and ledger_type <> 'personal') then
    raise exception 'Choose a ledger from this workspace (not a shared account)' using errcode = '22023';
  end if;
  if v_contractor is null and coalesce((p ->> 'save_client')::boolean, false) and v_client is not null then
    insert into public.contractors (workspace_id, name, business_name, phone, email, address, kind, gstin, created_by)
    values (v_ws, v_client, app.clean_text(p ->> 'client_business', 160), app.clean_text(p ->> 'client_phone', 20),
      app.clean_text(p ->> 'client_email', 200), app.clean_text(p ->> 'client_address', 500), 'business', v_gstin, app.uid())
    returning id into v_contractor;
  end if;

  if v_id is null then
    insert into public.invoices (workspace_id, invoice_date, created_by) values (v_ws, v_date, app.uid()) returning id into v_id;
  end if;

  update public.invoices set
    invoice_type = v_type, source = coalesce(nullif(p ->> 'source', ''), source), invoice_no = v_no,
    title = app.clean_text(p ->> 'title', 200), invoice_date = v_date, due_date = v_due,
    payment_terms = app.clean_text(p ->> 'payment_terms', 200), contractor_id = v_contractor, ledger_id = v_ledger,
    client_name = v_client, client_business = app.clean_text(p ->> 'client_business', 160),
    client_contact = app.clean_text(p ->> 'client_contact', 160), client_phone = app.clean_text(p ->> 'client_phone', 20),
    client_email = app.clean_text(p ->> 'client_email', 200), client_address = app.clean_text(p ->> 'client_address', 500),
    client_gstin = v_gstin, client_pan = v_pan, client_state = app.clean_text(p ->> 'client_state', 60),
    client_country = coalesce(app.clean_text(p ->> 'client_country', 60), 'India'),
    place_of_supply = nullif(p ->> 'place_of_supply', ''), gst_enabled = v_gst,
    discount_kind = coalesce(nullif(p ->> 'discount_kind', ''), 'amount'),
    discount_value = coalesce(nullif(p ->> 'discount_value', '')::numeric, 0),
    charge_label = app.clean_text(p ->> 'charge_label', 80), charge_amount = coalesce(nullif(p ->> 'charge_amount', '')::numeric, 0),
    round_off = coalesce((p ->> 'round_off')::boolean, s.round_off),
    notes = app.clean_text(p ->> 'notes', 3000), terms = app.clean_text(p ->> 'terms', 3000), footer = app.clean_text(p ->> 'footer', 300),
    template = nullif(p ->> 'template', ''), payment_config = coalesce(p -> 'payment_config', '{}'::jsonb),
    show_digital_qr = coalesce((p ->> 'show_digital_qr')::boolean, s.show_digital_qr),
    allow_payment_claims = coalesce((p ->> 'allow_payment_claims')::boolean, s.allow_payment_claims),
    show_payment_history = coalesce((p ->> 'show_payment_history')::boolean, s.show_payment_history),
    updated_by = app.uid()
  where id = v_id;

  delete from public.invoice_items where invoice_id = v_id;
  if jsonb_array_length(coalesce(p -> 'items', '[]'::jsonb)) > 200 then
    raise exception 'An invoice can have up to 200 lines' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    if app.clean_text(v_item ->> 'name', 300) is null then
      raise exception 'Line % needs a name', v_pos using errcode = '22023';
    end if;
    insert into public.invoice_items (workspace_id, invoice_id, position, name, description, reference_url, sku, hsn, quantity, unit, rate, discount_percent, tax_rate)
    values (v_ws, v_id, v_pos, app.clean_text(v_item ->> 'name', 300), app.clean_text(v_item ->> 'description', 4000),
      app.clean_text(v_item ->> 'reference_url', 300), app.clean_text(v_item ->> 'sku', 40), app.clean_text(v_item ->> 'hsn', 12),
      coalesce(nullif(v_item ->> 'quantity', '')::numeric, 1), app.clean_text(v_item ->> 'unit', 20),
      coalesce(nullif(v_item ->> 'rate', '')::numeric, 0), coalesce(nullif(v_item ->> 'discount_percent', '')::numeric, 0),
      coalesce(nullif(v_item ->> 'tax_rate', '')::numeric, 0));
  end loop;
  perform app.recalc_invoice(v_id);
  if coalesce(current_setting('app.invoice_edit', true), '') <> '1' then
    perform app.invoice_event(v_ws, v_id, case when i.id is null then 'created' else 'edited' end);
  end if;
  return v_id;
exception
  when unique_violation then
    raise exception 'Invoice number % is already used in this workspace', v_no using errcode = '22023';
end $$;

create or replace function public.edit_issued_invoice(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  i public.invoices;
  n public.invoices;
  s public.invoice_settings;
  v_missing integer;
  v_body jsonb;
begin
  select * into i from public.invoices where id = v_id for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(i.workspace_id);
  if i.status = 'cancelled' then
    raise exception 'A cancelled invoice cannot be edited. Duplicate it instead.' using errcode = '22023';
  end if;
  if i.status <> 'issued' then
    raise exception 'This invoice is still a draft. Save it normally.' using errcode = '22023';
  end if;
  if nullif(p ->> 'ledger_id', '')::uuid is distinct from i.ledger_id then
    raise exception 'An issued invoice stays on its ledger. To move it, cancel it and issue a new one.' using errcode = '22023';
  end if;
  if (coalesce(nullif(p ->> 'invoice_type', ''), i.invoice_type) = 'proforma') <> (i.invoice_type = 'proforma') then
    raise exception 'A proforma cannot become an invoice by editing (or the other way). Duplicate it as the other type.' using errcode = '22023';
  end if;

  -- The invoice keeps its number unless a new one is typed.
  v_body := p || jsonb_build_object('invoice_no', coalesce(nullif(btrim(p ->> 'invoice_no'), ''), i.invoice_no), 'source', i.source);
  perform set_config('app.invoice_edit', '1', true);
  perform public.save_invoice(v_body);
  perform set_config('app.invoice_edit', '', true);

  select * into n from public.invoices where id = v_id;
  s := app.invoice_settings_row(n.workspace_id);
  if n.client_name is null then
    raise exception 'Add the client' using errcode = '22023';
  end if;
  if not exists (select 1 from public.invoice_items where invoice_id = v_id) or n.grand_total <= 0 then
    raise exception 'The invoice total must be more than zero' using errcode = '22023';
  end if;
  if n.grand_total < n.amount_received then
    raise exception 'The new total (₹%) is less than what was already received (₹%). Delete or reverse a payment first.', n.grand_total, n.amount_received using errcode = '22023';
  end if;
  if n.invoice_type = 'gst' then
    if s.gstin is null then
      raise exception 'A tax invoice needs your GSTIN. Add it in Invoice settings.' using errcode = '22023';
    end if;
    if n.place_of_supply is null then
      raise exception 'A tax invoice needs the place of supply' using errcode = '22023';
    end if;
    select count(*) into v_missing from public.invoice_items where invoice_id = v_id and hsn is null;
    if v_missing > 0 then
      raise exception 'Every line on a tax invoice needs an HSN or SAC code' using errcode = '22023';
    end if;
  end if;

  update public.invoices set payment_snapshot = app.payment_snapshot(n.workspace_id, n.payment_config), updated_by = app.uid()
  where id = v_id;

  -- The receivable on the ledger follows the invoice.
  if n.transaction_id is not null then
    perform app.lock_ledger(n.ledger_id, false);
    perform set_config('app.invoice_op', '1', true);
    update public.transactions set
      amount = n.grand_total, txn_date = n.invoice_date,
      description = 'Invoice ' || n.invoice_no || coalesce(' · ' || n.title, ''),
      counterparty = n.client_name, reference_no = left(n.invoice_no, 80), updated_by = app.uid()
    where id = n.transaction_id;
    perform set_config('app.invoice_op', '', true);
  end if;

  perform app.refresh_invoice_money(v_id);
  perform app.invoice_event(n.workspace_id, v_id, 'edited',
    jsonb_build_object('after_issue', true, 'invoice_no', n.invoice_no, 'old_total', i.grand_total, 'new_total', n.grand_total));
  return v_id;
end $$;

revoke all on function public.edit_issued_invoice(jsonb) from public, anon;
grant execute on function public.edit_issued_invoice(jsonb) to authenticated;
