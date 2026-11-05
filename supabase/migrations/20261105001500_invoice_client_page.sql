-- What the client sees on the invoice page.
--
--  * document_mode: 'lekha' (the generated invoice), 'uploaded' (only the business's own document),
--    or 'both'. With 'uploaded' the Lekha format is never offered, on the page or as a PDF.
--  * Payment details: a saved QR image is enough (no UPI ID needed). An invoice with nothing chosen
--    falls back to the workspace's default payment profile, so details saved after issuing still
--    reach the client, unless the issuer explicitly chose to show none.
--  * Card colour, and logos: yours on the main card, your client's on the Billed To card.

alter table public.invoices
  add column document_mode text not null default 'lekha' check (document_mode in ('lekha', 'uploaded', 'both')),
  add column card_color text check (card_color is null or card_color ~ '^#[0-9a-f]{6}$'),
  add column client_logo_path text;

alter table public.invoice_settings
  add column card_color text check (card_color is null or card_color ~ '^#[0-9a-f]{6}$');

-- Remembered per client, so the next invoice picks it up.
alter table public.contractors add column logo_path text;
grant select (logo_path) on public.contractors to authenticated;

-- Uploaded invoices already shared keep showing what they showed.
update public.invoices i set document_mode = 'both'
where i.source = 'uploaded' and exists (
  select 1 from public.invoice_attachments a where a.invoice_id = i.id and a.role = 'original' and a.client_visible);

create or replace function app.copy_invoice_look() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.duplicated_from is not null then
    select card_color, client_logo_path into new.card_color, new.client_logo_path from public.invoices where id = new.duplicated_from;
  end if;
  return new;
end $$;

create trigger invoices_copy_look before insert on public.invoices
  for each row execute function app.copy_invoice_look();

-- A QR image on its own is a complete way to be paid.
create or replace function app.payment_snapshot(p_ws uuid, c jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f public.invoice_payment_profiles;
  v jsonb := '{}'::jsonb;
  v_fixed boolean;
begin
  select * into f from public.invoice_payment_profiles where id = nullif(c ->> 'profile_id', '')::uuid and workspace_id = p_ws;
  if found and coalesce((c ->> 'upi')::boolean, false) and (f.upi_id is not null or f.upi_qr_path is not null) then
    v_fixed := f.upi_qr_path is not null and (f.upi_id is null or c ->> 'qr_mode' = 'fixed');
    v := v || jsonb_build_object('upi', jsonb_build_object('id', f.upi_id, 'payee', f.upi_payee, 'number', f.upi_number,
      'qr_path', case when v_fixed then f.upi_qr_path end, 'dynamic', not v_fixed));
  end if;
  if found and coalesce((c ->> 'bank')::boolean, false) and f.bank_account is not null then
    v := v || jsonb_build_object('bank', jsonb_build_object('holder', f.bank_holder, 'name', f.bank_name, 'branch', f.bank_branch,
      'account', f.bank_account, 'ifsc', f.bank_ifsc));
  end if;
  if found and f.instructions is not null then
    v := v || jsonb_build_object('instructions', f.instructions);
  end if;
  if coalesce((c ->> 'cash')::boolean, false) then v := v || '{"cash": true}'::jsonb; end if;
  if coalesce((c ->> 'cheque')::boolean, false) then v := v || '{"cheque": true}'::jsonb; end if;
  if app.clean_text(c ->> 'other', 300) is not null then
    v := v || jsonb_build_object('other', app.clean_text(c ->> 'other', 300));
  end if;
  return v;
end $$;

-- What an invoice actually shows: its own snapshot, or the default profile if nothing was chosen.
create or replace function app.effective_payment(i public.invoices) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_profile public.invoice_payment_profiles;
begin
  if coalesce(i.payment_snapshot, '{}'::jsonb) <> '{}'::jsonb then
    return i.payment_snapshot;
  end if;
  if coalesce((i.payment_config ->> 'none')::boolean, false) then
    return '{}'::jsonb;
  end if;
  select p.* into v_profile from public.invoice_payment_profiles p
  left join public.invoice_settings s on s.workspace_id = p.workspace_id
  where p.workspace_id = i.workspace_id and not p.is_archived
  order by (p.id = s.default_profile_id) desc nulls last, p.created_at
  limit 1;
  if v_profile.id is null then
    return '{}'::jsonb;
  end if;
  return app.payment_snapshot(i.workspace_id, jsonb_build_object('profile_id', v_profile.id, 'upi', true, 'bank', true,
    'qr_mode', case when v_profile.upi_qr_path is not null then 'fixed' else 'dynamic' end));
end $$;

create or replace function public.invoice_payment_view(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  i public.invoices;
begin
  select * into i from public.invoices where id = p_id;
  if i.id is null or not app.is_member(i.workspace_id) then
    return null;
  end if;
  return app.effective_payment(i);
end $$;

-- How the client page looks and which document it offers. Works on drafts and issued invoices:
-- none of it touches the money.
create or replace function public.set_invoice_look(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_mode text := coalesce(nullif(p ->> 'document_mode', ''), null);
  v_color text := nullif(lower(p ->> 'card_color'), '');
  v_logo text := nullif(p ->> 'client_logo_path', '');
begin
  select * into i from public.invoices where id = p_id for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(i.workspace_id);
  if i.status = 'cancelled' then
    raise exception 'This invoice is cancelled' using errcode = '22023';
  end if;
  v_mode := coalesce(v_mode, i.document_mode);
  if v_mode not in ('lekha', 'uploaded', 'both') then
    raise exception 'Choose what your client receives' using errcode = '22023';
  end if;
  if p ? 'card_color' and v_color is not null and v_color !~ '^#[0-9a-f]{6}$' then
    raise exception 'Choose a colour' using errcode = '22023';
  end if;
  if p ? 'client_logo_path' and v_logo is not null and (v_logo not like i.workspace_id::text || '/%' or v_logo ~ '\.\.') then
    raise exception 'Upload the logo again' using errcode = '22023';
  end if;

  -- Choosing to send your document is the approval to share it.
  if v_mode <> 'lekha' and i.status = 'issued' then
    if not exists (select 1 from public.invoice_attachments where invoice_id = p_id and role = 'original') then
      update public.invoice_attachments set role = 'original'
      where id = (select id from public.invoice_attachments where invoice_id = p_id order by created_at desc limit 1);
    end if;
    update public.invoice_attachments set client_visible = true where invoice_id = p_id and role = 'original';
    if not found then
      raise exception 'Attach your invoice document first' using errcode = '22023';
    end if;
  end if;

  update public.invoices set document_mode = v_mode,
    card_color = case when p ? 'card_color' then v_color else card_color end,
    client_logo_path = case when p ? 'client_logo_path' then v_logo else client_logo_path end,
    updated_by = app.uid()
  where id = p_id;
  if p ? 'client_logo_path' and i.contractor_id is not null then
    update public.contractors set logo_path = v_logo where id = i.contractor_id;
  end if;
  perform app.invoice_event(i.workspace_id, p_id, 'look_changed');
end $$;

create or replace function public.set_invoice_card_color(p_workspace uuid, p_color text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_color text := nullif(lower(p_color), '');
begin
  perform app.require_admin(p_workspace);
  perform app.invoice_settings_row(p_workspace);
  if v_color is not null and v_color !~ '^#[0-9a-f]{6}$' then
    raise exception 'Choose a colour' using errcode = '22023';
  end if;
  update public.invoice_settings set card_color = v_color where workspace_id = p_workspace;
end $$;

create or replace function public.get_public_invoice(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  i public.invoices := app.invoice_by_token(p_token);
  s public.invoice_settings;
begin
  if i.id is null then
    return null;
  end if;
  select * into s from public.invoice_settings where workspace_id = i.workspace_id;
  return jsonb_build_object(
    'invoice_no', i.invoice_no, 'invoice_type', i.invoice_type, 'source', i.source, 'title', i.title,
    'document_mode', i.document_mode,
    'invoice_date', i.invoice_date, 'due_date', i.due_date, 'currency', i.currency, 'payment_terms', i.payment_terms,
    'status', app.invoice_status(i, app.india_today()),
    -- Page styling follows current settings; what was issued (numbers, parties, amounts) does not.
    'seller', coalesce(i.seller_snapshot, '{}'::jsonb) || jsonb_build_object('logo_path', coalesce(i.seller_snapshot ->> 'logo_path', s.logo_path)),
    'card_color', coalesce(i.card_color, s.card_color, i.seller_snapshot ->> 'brand_color'),
    'template', i.template,
    'client', jsonb_build_object('name', i.client_name, 'business', i.client_business, 'contact', i.client_contact,
      'address', i.client_address, 'gstin', i.client_gstin, 'state', i.client_state, 'country', i.client_country,
      'logo_path', i.client_logo_path),
    'place_of_supply', i.place_of_supply, 'gst_enabled', i.gst_enabled, 'supply_type', i.supply_type,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('position', x.position, 'name', x.name, 'description', x.description,
        'reference_url', x.reference_url, 'sku', x.sku, 'hsn', x.hsn, 'quantity', x.quantity, 'unit', x.unit, 'rate', x.rate,
        'discount_percent', x.discount_percent, 'tax_rate', x.tax_rate, 'line_amount', x.line_amount, 'taxable_amount', x.taxable_amount,
        'cgst_amount', x.cgst_amount, 'sgst_amount', x.sgst_amount, 'igst_amount', x.igst_amount, 'line_total', x.line_total) order by x.position), '[]'::jsonb)
      from public.invoice_items x where x.invoice_id = i.id),
    'totals', jsonb_build_object('subtotal', i.subtotal, 'discount_total', i.discount_total, 'taxable_total', i.taxable_total,
      'cgst_total', i.cgst_total, 'sgst_total', i.sgst_total, 'igst_total', i.igst_total, 'tax_total', i.tax_total,
      'charge_label', i.charge_label, 'charge_amount', i.charge_amount, 'rounding', i.rounding, 'grand_total', i.grand_total,
      'amount_received', i.amount_received, 'balance', greatest(i.grand_total - i.amount_received, 0)),
    'notes', i.notes, 'terms', i.terms, 'footer', i.footer,
    'payment', app.effective_payment(i),
    'show_digital_qr', i.show_digital_qr, 'allow_payment_claims', i.allow_payment_claims,
    'payments', case when i.show_payment_history then (select coalesce(jsonb_agg(jsonb_build_object('paid_on', p.paid_on, 'amount', p.amount, 'mode', p.mode) order by p.paid_on), '[]'::jsonb)
      from public.invoice_payments p where p.invoice_id = i.id and p.status = 'confirmed') else '[]'::jsonb end,
    'pending_claims', (select count(*) from public.invoice_payment_submissions c where c.invoice_id = i.id and c.status = 'pending'),
    'files', (select coalesce(jsonb_agg(jsonb_build_object('n', f.n, 'role', f.role, 'file_name', f.file_name, 'mime_type', f.mime_type, 'size_bytes', f.size_bytes, 'page_count', f.page_count) order by f.n), '[]'::jsonb)
      from (select row_number() over (order by a.created_at, a.id) n, a.* from public.invoice_attachments a where a.invoice_id = i.id) f
      where f.client_visible));
end $$;

revoke all on function app.copy_invoice_look() from public, anon, authenticated;
revoke all on function app.effective_payment(public.invoices) from public, anon, authenticated;
revoke all on function public.invoice_payment_view(uuid), public.set_invoice_look(uuid, jsonb), public.set_invoice_card_color(uuid, text) from public, anon;
grant execute on function public.invoice_payment_view(uuid), public.set_invoice_look(uuid, jsonb), public.set_invoice_card_color(uuid, text) to authenticated;
