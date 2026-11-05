-- The link preview shows what the client page shows: the current card colour, logo, title and the
-- invoice total. Never the client's name.

create or replace function public.get_invoice_card(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  i public.invoices := app.invoice_by_token(p_token);
  s public.invoice_settings;
begin
  if i.id is null then
    return null;
  end if;
  select * into s from public.invoice_settings where workspace_id = i.workspace_id;
  return jsonb_build_object('invoice_no', i.invoice_no, 'invoice_type', i.invoice_type, 'title', i.title,
    'amount', i.grand_total,
    'business', i.seller_snapshot ->> 'business_name',
    'logo_path', coalesce(i.seller_snapshot ->> 'logo_path', s.logo_path),
    'card_color', coalesce(i.card_color, s.card_color, i.seller_snapshot ->> 'brand_color'));
end $$;

-- A title describes the invoice; it is not part of the money, so it can change after issuing.
create or replace function public.set_invoice_title(p_id uuid, p_title text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
begin
  select * into i from public.invoices where id = p_id for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(i.workspace_id);
  if i.status = 'cancelled' then
    raise exception 'This invoice is cancelled' using errcode = '22023';
  end if;
  update public.invoices set title = app.clean_text(p_title, 200), updated_by = app.uid() where id = p_id;
  perform app.invoice_event(i.workspace_id, p_id, 'look_changed', jsonb_build_object('title', app.clean_text(p_title, 200)));
end $$;

revoke all on function public.set_invoice_title(uuid, text) from public, anon;
grant execute on function public.set_invoice_title(uuid, text) to authenticated;
