-- Invoices: documents you issue to clients, their payments, and how both reach the ledgers.
--
-- Accounting model
--   * An issued invoice (not a proforma) with a linked ledger posts ONE 'invoice' entry: non-cash,
--     raises what the party owes. Issuing is never a cash receipt.
--   * invoice_payments is the one canonical payment event. A confirmed payment posts ONE cash
--     receipt ('regular', money in) to the linked ledger and stores its transaction id. Nothing
--     else ever counts money for an invoice, so a payment cannot be counted twice.
--   * Corrections are reversals, never deletes. Entries an invoice owns are guarded: they can only
--     change from the invoice, so the two sides can never drift apart.
--
-- All writes go through the functions below; tables are read-only to clients (RLS on every table).

-- The audit trail must not copy bank details out of an invoice's payment snapshot.
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
  v_ignored text[] := array['updated_at', 'last_activity_at', 'next_seq', 'token_hash', 'token_ciphertext', 'payment_config', 'payment_snapshot', 'seller_snapshot', 'proof_path'];
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
  else
    v_changes := coalesce(v_new, v_old) - v_ignored;
    foreach v_key in array v_masked loop
      if v_changes ? v_key and v_changes ->> v_key is not null then
        v_changes := jsonb_set(v_changes, array[v_key], '"[hidden]"'::jsonb);
      end if;
    end loop;
  end if;

  insert into public.audit_logs (workspace_id, ledger_id, entity_type, entity_id, action, actor_user_id, actor_role, changes)
  values (v_ws, v_ledger, tg_table_name, v_entity, lower(tg_op), app.uid(), app.actor_role(v_ws, v_ledger), v_changes);
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Settings, payment profiles, reusable content
-- ---------------------------------------------------------------------------------------------
create table public.invoice_settings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces (id) on delete cascade,
  business_name text check (business_name is null or char_length(business_name) <= 160),
  logo_path text,
  email text,
  phone text,
  address text,
  website text,
  gst_registered boolean not null default false,
  gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  pan text check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  state_code text check (state_code is null or state_code ~ '^[0-9]{2}$'),
  signatory_name text,
  signatory_title text,
  signature_path text,
  stamp_path text,
  template text not null default 'modern' check (template in ('modern', 'minimal', 'project', 'classic', 'tax', 'compact')),
  brand_color text not null default '#1d1d1b' check (brand_color ~ '^#[0-9a-f]{6}$'),
  accent_color text not null default '#eac119' check (accent_color ~ '^#[0-9a-f]{6}$'),
  logo_position text not null default 'left' check (logo_position in ('left', 'right')),
  number_prefix text not null default 'INV' check (char_length(number_prefix) between 1 and 20),
  proforma_prefix text not null default 'PI' check (char_length(proforma_prefix) between 1 and 20),
  number_format text not null default '{PREFIX}/{FY}/{SEQ}' check (number_format like '%{SEQ}%' and char_length(number_format) <= 60),
  number_padding integer not null default 3 check (number_padding between 1 and 8),
  number_start integer not null default 1 check (number_start between 1 and 99999999),
  number_reset text not null default 'yearly' check (number_reset in ('yearly', 'never')),
  default_due_days integer not null default 14 check (default_due_days between 0 and 365),
  default_payment_terms text,
  default_terms text,
  default_notes text,
  default_footer text,
  default_profile_id uuid,
  show_digital_qr boolean not null default true,
  round_off boolean not null default false,
  allow_payment_claims boolean not null default true,
  show_payment_history boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.invoice_sequences (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  series text not null check (series in ('invoice', 'proforma')),
  period text not null,
  next_number integer not null check (next_number > 0),
  primary key (workspace_id, series, period)
);

create table public.invoice_payment_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 60),
  upi_id text check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z0-9.-]{2,64}$'),
  upi_payee text,
  upi_number text,
  upi_qr_path text,
  bank_holder text,
  bank_name text,
  bank_branch text,
  bank_account text check (bank_account is null or bank_account ~ '^[0-9A-Za-z]{6,34}$'),
  bank_ifsc text check (bank_ifsc is null or bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  instructions text,
  is_archived boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create index invoice_payment_profiles_ws_idx on public.invoice_payment_profiles (workspace_id);

alter table public.invoice_settings
  add constraint invoice_settings_default_profile_fk foreign key (default_profile_id, workspace_id)
  references public.invoice_payment_profiles (id, workspace_id) on delete set null (default_profile_id);

create table public.invoice_library (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null check (kind in ('item', 'terms', 'notes', 'footer', 'payment')),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  body text,
  unit text,
  rate numeric(14,2),
  tax_rate numeric(5,2),
  hsn text,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index invoice_library_ws_idx on public.invoice_library (workspace_id, kind);

-- ---------------------------------------------------------------------------------------------
-- Invoices and their lines
-- ---------------------------------------------------------------------------------------------
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  invoice_type text not null default 'service' check (invoice_type in ('service', 'product', 'gst', 'project', 'proforma', 'custom')),
  source text not null default 'native' check (source in ('native', 'uploaded')),
  status text not null default 'draft' check (status in ('draft', 'issued', 'cancelled')),
  invoice_no text check (invoice_no is null or char_length(invoice_no) between 1 and 60),
  title text check (title is null or char_length(title) <= 200),
  invoice_date date not null,
  due_date date,
  currency text not null default 'INR' check (currency = 'INR'),
  payment_terms text,
  contractor_id uuid,
  ledger_id uuid,
  client_name text check (client_name is null or char_length(client_name) <= 160),
  client_business text,
  client_contact text,
  client_phone text,
  client_email text,
  client_address text,
  client_gstin text check (client_gstin is null or client_gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  client_pan text check (client_pan is null or client_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  client_state text,
  client_country text not null default 'India',
  place_of_supply text check (place_of_supply is null or place_of_supply ~ '^[0-9]{2}$'),
  gst_enabled boolean not null default false,
  supply_type text not null default 'none' check (supply_type in ('none', 'intra', 'inter')),
  discount_kind text not null default 'amount' check (discount_kind in ('amount', 'percent')),
  discount_value numeric(14,2) not null default 0 check (discount_value >= 0),
  charge_label text,
  charge_amount numeric(14,2) not null default 0 check (charge_amount >= 0),
  round_off boolean not null default false,
  subtotal numeric(14,2) not null default 0,
  discount_total numeric(14,2) not null default 0,
  taxable_total numeric(14,2) not null default 0,
  cgst_total numeric(14,2) not null default 0,
  sgst_total numeric(14,2) not null default 0,
  igst_total numeric(14,2) not null default 0,
  tax_total numeric(14,2) not null default 0,
  rounding numeric(6,2) not null default 0,
  grand_total numeric(14,2) not null default 0 check (grand_total >= 0),
  amount_received numeric(14,2) not null default 0 check (amount_received >= 0),
  notes text,
  terms text,
  footer text,
  template text check (template is null or template in ('modern', 'minimal', 'project', 'classic', 'tax', 'compact')),
  payment_config jsonb not null default '{}'::jsonb,
  seller_snapshot jsonb,
  payment_snapshot jsonb,
  show_digital_qr boolean not null default true,
  allow_payment_claims boolean not null default true,
  show_payment_history boolean not null default true,
  transaction_id uuid,
  duplicated_from uuid references public.invoices (id) on delete set null,
  issued_at timestamptz,
  issued_by text,
  sent_at timestamptz,
  first_viewed_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by text,
  cancel_reason text,
  last_reminder_at timestamptz,
  created_by text not null,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (contractor_id, workspace_id) references public.contractors (id, workspace_id),
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id),
  foreign key (transaction_id, workspace_id) references public.transactions (id, workspace_id),
  check (status = 'draft' or invoice_no is not null),
  check (status <> 'cancelled' or cancelled_at is not null),
  check (due_date is null or due_date >= invoice_date)
);
create unique index invoices_number_idx on public.invoices (workspace_id, lower(invoice_no)) where invoice_no is not null;
create index invoices_ws_date_idx on public.invoices (workspace_id, invoice_date desc);
create index invoices_ws_status_idx on public.invoices (workspace_id, status);
create index invoices_contractor_idx on public.invoices (contractor_id);
create index invoices_ledger_idx on public.invoices (ledger_id);
create unique index invoices_transaction_idx on public.invoices (transaction_id) where transaction_id is not null;

create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  invoice_id uuid not null,
  position integer not null check (position > 0),
  name text not null check (char_length(btrim(name)) between 1 and 300),
  description text check (description is null or char_length(description) <= 4000),
  reference_url text check (reference_url is null or char_length(reference_url) <= 300),
  sku text,
  hsn text,
  quantity numeric(14,3) not null default 1 check (quantity > 0),
  unit text,
  rate numeric(14,2) not null default 0 check (rate >= 0),
  discount_percent numeric(5,2) not null default 0 check (discount_percent between 0 and 100),
  tax_rate numeric(5,2) not null default 0 check (tax_rate between 0 and 100),
  line_amount numeric(14,2) not null default 0,
  taxable_amount numeric(14,2) not null default 0,
  cgst_amount numeric(14,2) not null default 0,
  sgst_amount numeric(14,2) not null default 0,
  igst_amount numeric(14,2) not null default 0,
  line_total numeric(14,2) not null default 0,
  unique (invoice_id, position),
  foreign key (invoice_id, workspace_id) references public.invoices (id, workspace_id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- Files, links, payments
-- ---------------------------------------------------------------------------------------------
create table public.invoice_attachments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  invoice_id uuid not null,
  role text not null default 'supporting' check (role in ('original', 'supporting')),
  storage_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 200),
  mime_type text not null check (mime_type in (
    'application/pdf', 'image/png', 'image/jpeg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  page_count integer,
  client_visible boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now(),
  foreign key (invoice_id, workspace_id) references public.invoices (id, workspace_id) on delete cascade
);
create index invoice_attachments_invoice_idx on public.invoice_attachments (invoice_id);
create unique index invoice_attachments_one_original_idx on public.invoice_attachments (invoice_id) where role = 'original';

create table public.invoice_share_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  invoice_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_ciphertext text,
  token_hint text not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  view_count integer not null default 0,
  last_viewed_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  foreign key (invoice_id, workspace_id) references public.invoices (id, workspace_id) on delete cascade
);
create unique index invoice_share_links_one_active_idx on public.invoice_share_links (invoice_id) where revoked_at is null;

create table public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  invoice_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  paid_on date not null,
  mode text check (mode is null or mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
  reference text check (reference is null or char_length(reference) <= 80),
  notes text,
  source text not null default 'manual' check (source in ('manual', 'client_claim')),
  status text not null default 'confirmed' check (status in ('confirmed', 'reversed')),
  transaction_id uuid,
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 120),
  reversal_kind text check (reversal_kind is null or reversal_kind in ('correction', 'refund')),
  reversal_reason text,
  reversal_transaction_id uuid,
  reversed_at timestamptz,
  reversed_by text,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  foreign key (invoice_id, workspace_id) references public.invoices (id, workspace_id),
  foreign key (transaction_id, workspace_id) references public.transactions (id, workspace_id),
  foreign key (reversal_transaction_id, workspace_id) references public.transactions (id, workspace_id),
  check ((status = 'reversed') = (reversed_at is not null))
);
create index invoice_payments_invoice_idx on public.invoice_payments (invoice_id, paid_on);
create index invoice_payments_ws_date_idx on public.invoice_payments (workspace_id, paid_on);
create unique index invoice_payments_transaction_idx on public.invoice_payments (transaction_id) where transaction_id is not null;
create unique index invoice_payments_reference_idx on public.invoice_payments (workspace_id, lower(reference))
  where reference is not null and status = 'confirmed';

-- "I've made a payment" from the client. Never money until the issuer confirms it.
create table public.invoice_payment_submissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  invoice_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  paid_on date not null,
  mode text check (mode is null or mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
  reference text check (reference is null or char_length(reference) <= 80),
  message text check (message is null or char_length(message) <= 500),
  proof_path text unique,
  proof_mime text,
  proof_received boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  review_note text,
  reviewed_by text,
  reviewed_at timestamptz,
  payment_id uuid references public.invoice_payments (id),
  created_at timestamptz not null default now(),
  foreign key (invoice_id, workspace_id) references public.invoices (id, workspace_id) on delete cascade
);
create index invoice_submissions_invoice_idx on public.invoice_payment_submissions (invoice_id, status);
create index invoice_submissions_ws_idx on public.invoice_payment_submissions (workspace_id, status);

create table public.invoice_reminders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  invoice_id uuid not null,
  stage text not null check (stage in ('before_due', 'on_due', 'after_due', 'custom')),
  channel text not null default 'whatsapp' check (channel = 'whatsapp'),
  outstanding numeric(14,2) not null,
  sent_by text not null,
  created_at timestamptz not null default now(),
  foreign key (invoice_id, workspace_id) references public.invoices (id, workspace_id) on delete cascade
);
create index invoice_reminders_invoice_idx on public.invoice_reminders (invoice_id, created_at desc);

-- The human timeline of an invoice (the row-level audit_logs trail runs alongside it).
create table public.invoice_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  invoice_id uuid not null,
  event text not null,
  detail jsonb not null default '{}'::jsonb,
  actor_user_id text,
  actor_type text not null default 'member' check (actor_type in ('member', 'client', 'system')),
  created_at timestamptz not null default now(),
  foreign key (invoice_id, workspace_id) references public.invoices (id, workspace_id) on delete cascade
);
create index invoice_events_invoice_idx on public.invoice_events (invoice_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Row level security. Reads for members; every write goes through a function.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'invoice_settings', 'invoices', 'invoice_items', 'invoice_attachments', 'invoice_share_links',
    'invoice_payments', 'invoice_payment_submissions', 'invoice_reminders', 'invoice_events', 'invoice_library'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select app.is_member(workspace_id)))', t || '_members', t);
  end loop;
  -- Bank details: only people who can write see them, and never through unrelated screens.
  alter table public.invoice_payment_profiles enable row level security;
  revoke all on public.invoice_payment_profiles from anon, authenticated;
  grant select on public.invoice_payment_profiles to authenticated;
  create policy invoice_payment_profiles_writers on public.invoice_payment_profiles for select to authenticated
    using ((select app.can_write(workspace_id)));
  -- No client access at all; reached only through functions below.
  foreach t in array array['invoice_sequences'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Tokens are never readable from the table; the owner gets the link through a function.
revoke select on public.invoice_share_links from authenticated;
grant select (id, workspace_id, invoice_id, token_hint, expires_at, revoked_at, view_count, last_viewed_at, created_at)
  on public.invoice_share_links to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['invoices', 'invoice_settings'] loop
    execute format('create trigger %I before update on public.%I for each row execute function app.touch_updated_at()', t || '_touch_updated_at', t);
  end loop;
  foreach t in array array[
    'invoices', 'invoice_settings', 'invoice_attachments', 'invoice_share_links', 'invoice_payments',
    'invoice_payment_submissions'
  ] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function app.audit_row()', t || '_audit', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Guard: entries owned by an invoice change only through the invoice
-- ---------------------------------------------------------------------------------------------
create or replace function app.guard_invoice_txn() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_no text;
  v_target uuid;
begin
  if coalesce(current_setting('app.invoice_op', true), '') = '1' then
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
  select invoice_no into v_no from public.invoices where transaction_id = v_target;
  if v_no is null then
    select i.invoice_no into v_no from public.invoice_payments p join public.invoices i on i.id = p.invoice_id
    where p.transaction_id = v_target and p.status = 'confirmed';
  end if;
  if v_no is not null then
    raise exception 'This entry belongs to invoice %. Change it from the invoice.', v_no using errcode = '22023';
  end if;
  return new;
end $$;

create trigger transactions_guard_invoice before insert or update on public.transactions
  for each row execute function app.guard_invoice_txn();

create or replace function app.reverse_linked_txn(p_txn uuid, p_reason text, p_date date, p_via text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t public.transactions;
  v_id uuid;
begin
  perform 1 from public.ledgers l join public.transactions x on x.ledger_id = l.id where x.id = p_txn for update of l;
  select * into t from public.transactions where id = p_txn for update;
  perform set_config('app.invoice_op', '1', true);
  v_id := app.insert_txn(t.ledger_id, t.workspace_id, p_date,
    case t.direction when 'in' then 'out' else 'in' end, t.amount, 'reversal',
    jsonb_build_object('description', 'Reversal of ' || t.voucher_no || ': ' || left(p_reason, 300),
      'counterparty', t.counterparty, 'reference_no', t.voucher_no),
    'posted', p_via, null, p_txn);
  update public.transactions set is_cash = t.is_cash, affects_party = t.affects_party where id = v_id;
  perform set_config('app.invoice_op', '', true);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
create or replace function app.india_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;

create or replace function app.invoice_event(p_ws uuid, p_invoice uuid, p_event text, p_detail jsonb default '{}'::jsonb, p_actor text default 'member')
returns void
language sql security definer set search_path = '' as $$
  insert into public.invoice_events (workspace_id, invoice_id, event, detail, actor_user_id, actor_type)
  values (p_ws, p_invoice, p_event, coalesce(p_detail, '{}'::jsonb), app.uid(), p_actor)
$$;

create or replace function app.invoice_settings_row(p_ws uuid) returns public.invoice_settings
language plpgsql security definer set search_path = '' as $$
declare
  s public.invoice_settings;
begin
  insert into public.invoice_settings (workspace_id, business_name)
  values (p_ws, (select name from public.workspaces where id = p_ws))
  on conflict (workspace_id) do nothing;
  select * into s from public.invoice_settings where workspace_id = p_ws;
  return s;
end $$;

create or replace function app.fy_label(p_date date, p_start integer) returns text
language sql immutable set search_path = '' as $$
  select case when extract(month from p_date)::int >= p_start
    then extract(year from p_date)::int::text || '-' || right((extract(year from p_date)::int + 1)::text, 2)
    else (extract(year from p_date)::int - 1)::text || '-' || right(extract(year from p_date)::int::text, 2) end
$$;

-- Atomic: the conflict update serialises concurrent issuers, so two invoices can never share a number.
create or replace function app.next_invoice_no(s public.invoice_settings, p_series text, p_date date) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_fy text := app.fy_label(p_date, (select fy_start_month from public.workspaces where id = s.workspace_id));
  v_period text := case s.number_reset when 'yearly' then v_fy else 'all' end;
  v_seq integer;
begin
  insert into public.invoice_sequences (workspace_id, series, period, next_number)
  values (s.workspace_id, p_series, v_period, s.number_start + 1)
  on conflict (workspace_id, series, period) do update set next_number = public.invoice_sequences.next_number + 1
  returning next_number - 1 into v_seq;
  return replace(replace(replace(replace(replace(s.number_format,
    '{PREFIX}', case p_series when 'proforma' then s.proforma_prefix else s.number_prefix end),
    '{FY}', v_fy),
    '{YYYY}', extract(year from p_date)::int::text),
    '{MM}', lpad(extract(month from p_date)::int::text, 2, '0')),
    '{SEQ}', lpad(v_seq::text, s.number_padding, '0'));
end $$;

-- Totals. Mirrors computeInvoice() in src/lib/domain/invoice.ts; parity is covered by tests.
--   line      = round(qty * rate, 2), less its own discount %
--   discount  = invoice-level, shared across lines in proportion (last line takes the remainder)
--   taxable   = line - its share of the discount
--   gst       = round(taxable * rate / 100, 2); intra: cgst = round(gst / 2, 2), sgst = gst - cgst
--   grand     = taxable + gst + charges, optionally rounded to the rupee
-- Tax is only ever worked out once, on the discounted amount.
create or replace function app.recalc_invoice(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  r record;
  v_seller text;
  v_supply text := 'none';
  v_subtotal numeric := 0;
  v_discount numeric;
  v_left numeric;
  v_share numeric;
  v_taxable numeric;
  v_gst numeric;
  v_c numeric;
  v_s numeric;
  v_ig numeric;
  v_tt numeric := 0;
  v_ct numeric := 0;
  v_st numeric := 0;
  v_it numeric := 0;
  v_count integer;
  v_n integer := 0;
  v_grand numeric;
  v_round numeric := 0;
begin
  select * into i from public.invoices where id = p_id for update;
  v_seller := (select state_code from public.invoice_settings where workspace_id = i.workspace_id);
  if i.gst_enabled then
    v_supply := case when i.place_of_supply is not null and v_seller is not null and i.place_of_supply <> v_seller then 'inter' else 'intra' end;
  end if;

  update public.invoice_items
  set line_amount = round(round(quantity * rate, 2) * (100 - discount_percent) / 100, 2)
  where invoice_id = p_id;
  select coalesce(sum(line_amount), 0), count(*) filter (where line_amount > 0) into v_subtotal, v_count
  from public.invoice_items where invoice_id = p_id;

  v_discount := least(v_subtotal, case i.discount_kind when 'percent' then round(v_subtotal * least(i.discount_value, 100) / 100, 2) else i.discount_value end);
  v_left := v_discount;
  for r in select id, line_amount, tax_rate from public.invoice_items where invoice_id = p_id order by position loop
    if r.line_amount > 0 then
      v_n := v_n + 1;
      v_share := case when v_n = v_count then v_left else round(v_discount * r.line_amount / v_subtotal, 2) end;
      v_left := v_left - v_share;
    else
      v_share := 0;
    end if;
    v_taxable := r.line_amount - v_share;
    v_gst := case when i.gst_enabled then round(v_taxable * r.tax_rate / 100, 2) else 0 end;
    v_c := case when v_supply = 'intra' then round(v_gst / 2, 2) else 0 end;
    v_s := case when v_supply = 'intra' then v_gst - v_c else 0 end;
    v_ig := case when v_supply = 'inter' then v_gst else 0 end;
    update public.invoice_items set taxable_amount = v_taxable, cgst_amount = v_c, sgst_amount = v_s, igst_amount = v_ig,
      line_total = v_taxable + v_gst
    where id = r.id;
    v_tt := v_tt + v_taxable;
    v_ct := v_ct + v_c;
    v_st := v_st + v_s;
    v_it := v_it + v_ig;
  end loop;

  v_grand := v_tt + v_ct + v_st + v_it + i.charge_amount;
  if i.round_off then
    v_round := round(v_grand, 0) - v_grand;
    v_grand := v_grand + v_round;
  end if;

  update public.invoices set
    supply_type = v_supply, subtotal = v_subtotal, discount_total = v_discount, taxable_total = v_tt,
    cgst_total = v_ct, sgst_total = v_st, igst_total = v_it, tax_total = v_ct + v_st + v_it,
    rounding = v_round, grand_total = v_grand
  where id = p_id;
end $$;

-- Status shown to people. Stored status is only draft / issued / cancelled; the rest follows from
-- the money and the dates. Mirrors invoiceStatus() in src/lib/domain/invoice.ts.
create or replace function app.invoice_status(i public.invoices, p_today date) returns text
language sql stable set search_path = '' as $$
  select case
    when i.status = 'cancelled' then 'cancelled'
    when i.status = 'draft' then 'draft'
    when i.grand_total > 0 and i.amount_received >= i.grand_total then 'paid'
    when i.invoice_type <> 'proforma' and i.due_date is not null and i.due_date < p_today then 'overdue'
    when i.amount_received > 0 then 'partial'
    when i.first_viewed_at is not null then 'viewed'
    when i.sent_at is not null then 'sent'
    else 'issued' end
$$;

create or replace function app.refresh_invoice_money(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_total numeric;
begin
  select coalesce(sum(amount), 0) into v_total from public.invoice_payments where invoice_id = p_id and status = 'confirmed';
  update public.invoices set amount_received = v_total,
    paid_at = case when grand_total > 0 and v_total >= grand_total then coalesce(paid_at, now()) end
  where id = p_id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------------------------
create or replace function public.save_invoice_settings(p_workspace uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.invoice_settings;
  v_gstin text := nullif(upper(btrim(p ->> 'gstin')), '');
  v_state text := nullif(p ->> 'state_code', '');
  v_format text := coalesce(nullif(btrim(p ->> 'number_format'), ''), '{PREFIX}/{FY}/{SEQ}');
begin
  perform app.require_admin(p_workspace);
  s := app.invoice_settings_row(p_workspace);
  if v_format not like '%{SEQ}%' then
    raise exception 'The number format must contain {SEQ}' using errcode = '22023';
  end if;
  if v_gstin is not null and v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
    raise exception 'Enter a valid 15-character GSTIN' using errcode = '22023';
  end if;
  if coalesce((p ->> 'gst_registered')::boolean, false) and v_gstin is null then
    raise exception 'A GST-registered business needs a GSTIN' using errcode = '22023';
  end if;
  if v_gstin is not null then
    v_state := coalesce(v_state, left(v_gstin, 2));
    if left(v_gstin, 2) <> v_state then
      raise exception 'The GSTIN does not match the selected state' using errcode = '22023';
    end if;
  end if;
  update public.invoice_settings set
    business_name = app.clean_text(p ->> 'business_name', 160),
    email = app.clean_text(p ->> 'email', 200), phone = app.clean_text(p ->> 'phone', 40),
    address = app.clean_text(p ->> 'address', 500), website = app.clean_text(p ->> 'website', 200),
    gst_registered = coalesce((p ->> 'gst_registered')::boolean, false),
    gstin = v_gstin, pan = nullif(upper(btrim(p ->> 'pan')), ''), state_code = v_state,
    signatory_name = app.clean_text(p ->> 'signatory_name', 120), signatory_title = app.clean_text(p ->> 'signatory_title', 120),
    template = coalesce(nullif(p ->> 'template', ''), template),
    brand_color = lower(coalesce(nullif(p ->> 'brand_color', ''), brand_color)),
    accent_color = lower(coalesce(nullif(p ->> 'accent_color', ''), accent_color)),
    logo_position = coalesce(nullif(p ->> 'logo_position', ''), logo_position),
    number_prefix = coalesce(app.clean_text(p ->> 'number_prefix', 20), number_prefix),
    proforma_prefix = coalesce(app.clean_text(p ->> 'proforma_prefix', 20), proforma_prefix),
    number_format = v_format,
    number_padding = coalesce((p ->> 'number_padding')::integer, number_padding),
    number_start = coalesce((p ->> 'number_start')::integer, number_start),
    number_reset = coalesce(nullif(p ->> 'number_reset', ''), number_reset),
    default_due_days = coalesce((p ->> 'default_due_days')::integer, default_due_days),
    default_payment_terms = app.clean_text(p ->> 'default_payment_terms', 200),
    default_terms = app.clean_text(p ->> 'default_terms', 3000), default_notes = app.clean_text(p ->> 'default_notes', 3000),
    default_footer = app.clean_text(p ->> 'default_footer', 300),
    default_profile_id = nullif(p ->> 'default_profile_id', '')::uuid,
    show_digital_qr = coalesce((p ->> 'show_digital_qr')::boolean, show_digital_qr),
    round_off = coalesce((p ->> 'round_off')::boolean, round_off),
    allow_payment_claims = coalesce((p ->> 'allow_payment_claims')::boolean, allow_payment_claims),
    show_payment_history = coalesce((p ->> 'show_payment_history')::boolean, show_payment_history)
  where workspace_id = p_workspace;
end $$;

create or replace function public.set_invoice_brand_image(p_workspace uuid, p_field text, p_path text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_admin(p_workspace);
  perform app.invoice_settings_row(p_workspace);
  if p_field not in ('logo_path', 'signature_path', 'stamp_path') then
    raise exception 'Unknown image' using errcode = '22023';
  end if;
  if p_path is not null and (p_path not like p_workspace::text || '/%' or p_path ~ '\.\.') then
    raise exception 'Upload the image again' using errcode = '22023';
  end if;
  execute format('update public.invoice_settings set %I = $1 where workspace_id = $2', p_field) using p_path, p_workspace;
end $$;

create or replace function public.save_payment_profile(p_workspace uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_upi text := nullif(btrim(p ->> 'upi_id'), '');
  v_ifsc text := nullif(upper(btrim(p ->> 'bank_ifsc')), '');
  v_account text := nullif(regexp_replace(coalesce(p ->> 'bank_account', ''), '\s', '', 'g'), '');
  v_qr text := nullif(p ->> 'upi_qr_path', '');
begin
  perform app.require_admin(p_workspace);
  if app.clean_text(p ->> 'label', 60) is null then
    raise exception 'Name this payment profile' using errcode = '22023';
  end if;
  if v_upi is not null and v_upi !~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z0-9.-]{2,64}$' then
    raise exception 'Enter a valid UPI ID, like name@bank' using errcode = '22023';
  end if;
  if v_ifsc is not null and v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
    raise exception 'Enter a valid 11-character IFSC' using errcode = '22023';
  end if;
  if v_qr is not null and (v_qr not like p_workspace::text || '/%' or v_qr ~ '\.\.') then
    raise exception 'Upload the QR again' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.invoice_payment_profiles (workspace_id, label, upi_id, upi_payee, upi_number, upi_qr_path, bank_holder,
      bank_name, bank_branch, bank_account, bank_ifsc, instructions, created_by)
    values (p_workspace, app.clean_text(p ->> 'label', 60), v_upi, app.clean_text(p ->> 'upi_payee', 120),
      app.clean_text(p ->> 'upi_number', 20), v_qr, app.clean_text(p ->> 'bank_holder', 160), app.clean_text(p ->> 'bank_name', 160),
      app.clean_text(p ->> 'bank_branch', 200), v_account, v_ifsc, app.clean_text(p ->> 'instructions', 1000), app.uid())
    returning id into v_id;
  else
    update public.invoice_payment_profiles set label = app.clean_text(p ->> 'label', 60), upi_id = v_upi,
      upi_payee = app.clean_text(p ->> 'upi_payee', 120), upi_number = app.clean_text(p ->> 'upi_number', 20), upi_qr_path = v_qr,
      bank_holder = app.clean_text(p ->> 'bank_holder', 160), bank_name = app.clean_text(p ->> 'bank_name', 160),
      bank_branch = app.clean_text(p ->> 'bank_branch', 200), bank_account = v_account, bank_ifsc = v_ifsc,
      instructions = app.clean_text(p ->> 'instructions', 1000)
    where id = v_id and workspace_id = p_workspace;
    if not found then
      raise exception 'Payment profile not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end $$;

-- Issued invoices keep their own snapshot, so a profile can be retired without touching them.
create or replace function public.archive_payment_profile(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.invoice_payment_profiles where id = p_id;
  if v_ws is null then
    raise exception 'Payment profile not found' using errcode = 'P0002';
  end if;
  perform app.require_admin(v_ws);
  update public.invoice_payment_profiles set is_archived = true where id = p_id;
  update public.invoice_settings set default_profile_id = null where workspace_id = v_ws and default_profile_id = p_id;
end $$;

create or replace function public.save_invoice_library_item(p_workspace uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform app.require_write(p_workspace);
  if app.clean_text(p ->> 'title', 160) is null then
    raise exception 'Give it a name' using errcode = '22023';
  end if;
  insert into public.invoice_library (workspace_id, kind, title, body, unit, rate, tax_rate, hsn, created_by)
  values (p_workspace, p ->> 'kind', app.clean_text(p ->> 'title', 160), app.clean_text(p ->> 'body', 4000),
    app.clean_text(p ->> 'unit', 20), nullif(p ->> 'rate', '')::numeric, nullif(p ->> 'tax_rate', '')::numeric,
    app.clean_text(p ->> 'hsn', 12), app.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.delete_invoice_library_item(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.invoice_library where id = p_id;
  if v_ws is null then
    return;
  end if;
  perform app.require_write(v_ws);
  delete from public.invoice_library where id = p_id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Drafts
-- ---------------------------------------------------------------------------------------------
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
  if v_id is not null and i.status <> 'draft' then
    raise exception 'An issued invoice cannot be edited. Cancel it and duplicate, or amend its notes and due date.' using errcode = '22023';
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
  perform app.invoice_event(v_ws, v_id, case when i.id is null then 'created' else 'edited' end);
  return v_id;
exception
  when unique_violation then
    raise exception 'Invoice number % is already used in this workspace', v_no using errcode = '22023';
end $$;

create or replace function public.delete_draft_invoice(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
begin
  select * into i from public.invoices where id = p_id for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(i.workspace_id);
  if i.status <> 'draft' then
    raise exception 'Only drafts can be deleted. Cancel an issued invoice instead.' using errcode = '22023';
  end if;
  delete from public.invoices where id = p_id;
end $$;

create or replace function public.duplicate_invoice(p_id uuid, p_type text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_id uuid;
  s public.invoice_settings;
begin
  select * into i from public.invoices where id = p_id;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(i.workspace_id);
  s := app.invoice_settings_row(i.workspace_id);
  insert into public.invoices (workspace_id, invoice_type, title, invoice_date, due_date, payment_terms, contractor_id, ledger_id,
    client_name, client_business, client_contact, client_phone, client_email, client_address, client_gstin, client_pan,
    client_state, client_country, place_of_supply, gst_enabled, discount_kind, discount_value, charge_label, charge_amount,
    round_off, notes, terms, footer, template, payment_config, show_digital_qr, allow_payment_claims, show_payment_history,
    duplicated_from, created_by)
  values (i.workspace_id, coalesce(p_type, i.invoice_type), i.title, app.india_today(),
    app.india_today() + s.default_due_days, i.payment_terms, i.contractor_id, i.ledger_id,
    i.client_name, i.client_business, i.client_contact, i.client_phone, i.client_email, i.client_address, i.client_gstin, i.client_pan,
    i.client_state, i.client_country, i.place_of_supply, i.gst_enabled, i.discount_kind, i.discount_value, i.charge_label, i.charge_amount,
    i.round_off, i.notes, i.terms, i.footer, i.template, i.payment_config, i.show_digital_qr, i.allow_payment_claims, i.show_payment_history,
    i.id, app.uid())
  returning id into v_id;
  insert into public.invoice_items (workspace_id, invoice_id, position, name, description, reference_url, sku, hsn, quantity, unit, rate, discount_percent, tax_rate)
  select workspace_id, v_id, position, name, description, reference_url, sku, hsn, quantity, unit, rate, discount_percent, tax_rate
  from public.invoice_items where invoice_id = p_id;
  perform app.recalc_invoice(v_id);
  perform app.invoice_event(i.workspace_id, v_id, 'created', jsonb_build_object('from', i.invoice_no));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Issuing
-- ---------------------------------------------------------------------------------------------
-- Only the methods selected for this invoice are copied; nothing else reaches a public page.
create or replace function app.payment_snapshot(p_ws uuid, c jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f public.invoice_payment_profiles;
  v jsonb := '{}'::jsonb;
begin
  select * into f from public.invoice_payment_profiles where id = nullif(c ->> 'profile_id', '')::uuid and workspace_id = p_ws;
  if found and coalesce((c ->> 'upi')::boolean, false) and f.upi_id is not null then
    v := v || jsonb_build_object('upi', jsonb_build_object('id', f.upi_id, 'payee', f.upi_payee, 'number', f.upi_number,
      'qr_path', case when coalesce(c ->> 'qr_mode', 'dynamic') = 'fixed' then f.upi_qr_path end,
      'dynamic', coalesce(c ->> 'qr_mode', 'dynamic') <> 'fixed'));
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

create or replace function app.seller_snapshot(s public.invoice_settings) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('business_name', s.business_name, 'logo_path', s.logo_path, 'email', s.email, 'phone', s.phone,
    'address', s.address, 'website', s.website, 'gst_registered', s.gst_registered, 'gstin', s.gstin, 'pan', s.pan, 'state_code', s.state_code,
    'signatory_name', s.signatory_name, 'signatory_title', s.signatory_title, 'signature_path', s.signature_path, 'stamp_path', s.stamp_path,
    'template', s.template, 'brand_color', s.brand_color, 'accent_color', s.accent_color, 'logo_position', s.logo_position)
$$;

create or replace function public.issue_invoice(p_id uuid, p_token text, p_ciphertext text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  s public.invoice_settings;
  v_no text;
  v_txn uuid;
  v_missing integer;
  v_seller jsonb;
begin
  select * into i from public.invoices where id = p_id for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(i.workspace_id);
  perform app.require_token(p_token);
  if i.status <> 'draft' then
    raise exception 'This invoice has already been issued' using errcode = '22023';
  end if;
  if i.client_name is null then
    raise exception 'Add the client before issuing' using errcode = '22023';
  end if;
  if not exists (select 1 from public.invoice_items where invoice_id = p_id) or i.grand_total <= 0 then
    raise exception 'The invoice total must be more than zero' using errcode = '22023';
  end if;
  s := app.invoice_settings_row(i.workspace_id);
  if s.business_name is null then
    raise exception 'Add your business name in Invoice settings first' using errcode = '22023';
  end if;
  if i.source = 'uploaded' and not exists (select 1 from public.invoice_attachments where invoice_id = p_id and role = 'original') then
    raise exception 'Upload the original invoice first' using errcode = '22023';
  end if;
  if i.invoice_type = 'gst' then
    if s.gstin is null then
      raise exception 'A tax invoice needs your GSTIN. Add it in Invoice settings.' using errcode = '22023';
    end if;
    if i.place_of_supply is null then
      raise exception 'A tax invoice needs the place of supply' using errcode = '22023';
    end if;
    select count(*) into v_missing from public.invoice_items where invoice_id = p_id and hsn is null;
    if v_missing > 0 then
      raise exception 'Every line on a tax invoice needs an HSN or SAC code' using errcode = '22023';
    end if;
  end if;

  perform app.recalc_invoice(p_id);
  select * into i from public.invoices where id = p_id;
  v_no := coalesce(i.invoice_no, app.next_invoice_no(s, case when i.invoice_type = 'proforma' then 'proforma' else 'invoice' end, i.invoice_date));
  v_seller := app.seller_snapshot(s);

  update public.invoices set status = 'issued', invoice_no = v_no, seller_snapshot = v_seller,
    payment_snapshot = app.payment_snapshot(i.workspace_id, i.payment_config),
    template = coalesce(template, s.template), issued_at = now(), issued_by = app.uid(), updated_by = app.uid()
  where id = p_id;

  -- The receivable. Non-cash: raises what the party owes, moves no money. Proformas post nothing.
  if i.ledger_id is not null and i.invoice_type <> 'proforma' then
    perform app.lock_ledger(i.ledger_id, false);
    v_txn := app.insert_txn(i.ledger_id, i.workspace_id, i.invoice_date, 'out', i.grand_total, 'invoice',
      jsonb_build_object('description', 'Invoice ' || v_no || coalesce(' · ' || i.title, ''), 'counterparty', i.client_name, 'reference_no', left(v_no, 80)),
      'posted', 'member', 'invoice:' || p_id::text);
    update public.invoices set transaction_id = v_txn where id = p_id;
  end if;

  insert into public.invoice_share_links (workspace_id, invoice_id, token_hash, token_ciphertext, token_hint, created_by)
  values (i.workspace_id, p_id, app.token_hash(p_token), p_ciphertext, right(p_token, 4), app.uid());

  perform app.invoice_event(i.workspace_id, p_id, 'issued', jsonb_build_object('invoice_no', v_no, 'total', i.grand_total));
  return jsonb_build_object('invoice_no', v_no);
exception
  when unique_violation then
    raise exception 'Invoice number % is already used in this workspace', v_no using errcode = '22023';
end $$;

-- Issued invoices: only what does not change the money. Every change is on the timeline.
create or replace function public.amend_issued_invoice(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_due date;
  v_snapshot jsonb;
begin
  select * into i from public.invoices where id = p_id for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(i.workspace_id);
  if i.status <> 'issued' then
    raise exception 'Only issued invoices can be amended' using errcode = '22023';
  end if;
  v_due := case when p ? 'due_date' then nullif(p ->> 'due_date', '')::date else i.due_date end;
  if v_due is not null and v_due < i.invoice_date then
    raise exception 'The due date cannot be before the invoice date' using errcode = '22023';
  end if;
  v_snapshot := case when p ? 'payment_config' then app.payment_snapshot(i.workspace_id, p -> 'payment_config') else i.payment_snapshot end;
  update public.invoices set
    due_date = v_due,
    notes = case when p ? 'notes' then app.clean_text(p ->> 'notes', 3000) else notes end,
    terms = case when p ? 'terms' then app.clean_text(p ->> 'terms', 3000) else terms end,
    payment_config = coalesce(p -> 'payment_config', payment_config), payment_snapshot = v_snapshot,
    show_digital_qr = coalesce((p ->> 'show_digital_qr')::boolean, show_digital_qr),
    allow_payment_claims = coalesce((p ->> 'allow_payment_claims')::boolean, allow_payment_claims),
    show_payment_history = coalesce((p ->> 'show_payment_history')::boolean, show_payment_history),
    updated_by = app.uid()
  where id = p_id;
  perform app.invoice_event(i.workspace_id, p_id, 'amended', jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p) k)));
end $$;

create or replace function public.cancel_invoice(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_reason text := app.clean_text(p_reason, 300);
  v_paid integer;
begin
  select * into i from public.invoices where id = p_id for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(i.workspace_id);
  if i.status <> 'issued' then
    raise exception 'Only an issued invoice can be cancelled' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Give a reason for cancelling' using errcode = '22023';
  end if;
  select count(*) into v_paid from public.invoice_payments where invoice_id = p_id and status = 'confirmed';
  if v_paid > 0 then
    raise exception 'This invoice has % recorded payment(s). Reverse them first.', v_paid using errcode = '22023';
  end if;
  if i.transaction_id is not null then
    perform app.reverse_linked_txn(i.transaction_id, 'Invoice ' || i.invoice_no || ' cancelled: ' || v_reason, app.india_today(), 'member');
  end if;
  update public.invoices set status = 'cancelled', cancelled_at = now(), cancelled_by = app.uid(), cancel_reason = v_reason, updated_by = app.uid()
  where id = p_id;
  update public.invoice_share_links set revoked_at = now() where invoice_id = p_id and revoked_at is null;
  update public.invoice_payment_submissions set status = 'rejected', review_note = 'Invoice cancelled', reviewed_by = app.uid(), reviewed_at = now()
  where invoice_id = p_id and status = 'pending';
  perform app.invoice_event(i.workspace_id, p_id, 'cancelled', jsonb_build_object('reason', v_reason));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------------------------
create or replace function app.apply_invoice_payment(
  p_invoice uuid, p_amount numeric, p_date date, p_mode text, p_reference text, p_notes text,
  p_source text, p_idem text, p_allow_excess boolean, p_via text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_balance numeric;
  v_ref text := app.clean_text(p_reference, 80);
  v_other text;
  v_id uuid;
  v_txn uuid;
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

  v_id := gen_random_uuid();
  -- One ledger receipt for one payment. Without a linked ledger the payment still counts here.
  if i.ledger_id is not null then
    perform 1 from public.ledgers where id = i.ledger_id for update;
    v_txn := app.insert_txn(i.ledger_id, i.workspace_id, p_date, 'in', p_amount, 'regular',
      jsonb_build_object('description', 'Payment for invoice ' || i.invoice_no, 'counterparty', i.client_name,
        'payment_mode', p_mode, 'reference_no', coalesce(v_ref, left(i.invoice_no, 80))),
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
    app.payment_mode(p ->> 'mode'), p ->> 'reference', p ->> 'notes', 'manual', v_idem,
    coalesce((p ->> 'allow_excess')::boolean, false), 'member');
  return jsonb_build_object('id', v_id, 'duplicate', false);
end $$;

-- A payment is never deleted. Reversing keeps the row, posts a contra entry and restores the balance.
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
  update public.invoice_payments set status = 'reversed', reversal_kind = p_kind, reversal_reason = v_reason,
    reversal_transaction_id = v_rev, reversed_at = now(), reversed_by = app.uid()
  where id = p_id;
  perform app.refresh_invoice_money(p.invoice_id);
  perform app.invoice_event(p.workspace_id, p.invoice_id, 'payment_reversed', jsonb_build_object('amount', p.amount, 'kind', p_kind, 'reason', v_reason));
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
      'Confirmed from client notification', 'client_claim', null, coalesce((p ->> 'allow_excess')::boolean, false), 'member');
  end if;
  update public.invoice_payment_submissions set status = case when p_accept then 'confirmed' else 'rejected' end,
    review_note = app.clean_text(p ->> 'note', 300), reviewed_by = app.uid(), reviewed_at = now(), payment_id = v_payment
  where id = p_id;
  perform app.invoice_event(c.workspace_id, c.invoice_id, case when p_accept then 'claim_confirmed' else 'claim_rejected' end, jsonb_build_object('amount', c.amount));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Sharing and reminders
-- ---------------------------------------------------------------------------------------------
create or replace function public.rotate_invoice_link(p_invoice uuid, p_token text, p_ciphertext text, p_expires timestamptz default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
begin
  select * into i from public.invoices where id = p_invoice for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(i.workspace_id);
  perform app.require_token(p_token);
  if i.status <> 'issued' then
    raise exception 'Only issued invoices have a link' using errcode = '22023';
  end if;
  update public.invoice_share_links set revoked_at = now() where invoice_id = p_invoice and revoked_at is null;
  insert into public.invoice_share_links (workspace_id, invoice_id, token_hash, token_ciphertext, token_hint, expires_at, created_by)
  values (i.workspace_id, p_invoice, app.token_hash(p_token), p_ciphertext, right(p_token, 4), p_expires, app.uid());
  perform app.invoice_event(i.workspace_id, p_invoice, 'link_rotated');
end $$;

create or replace function public.revoke_invoice_link(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.invoices where id = p_invoice;
  if v_ws is null then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(v_ws);
  update public.invoice_share_links set revoked_at = now() where invoice_id = p_invoice and revoked_at is null;
  perform app.invoice_event(v_ws, p_invoice, 'link_revoked');
end $$;

create or replace function public.invoice_link_secret(p_invoice uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.invoices where id = p_invoice;
  if v_ws is null or not app.can_write(v_ws) then
    return null;
  end if;
  return (select token_ciphertext from public.invoice_share_links
    where invoice_id = p_invoice and revoked_at is null and (expires_at is null or expires_at > now()));
end $$;

create or replace function public.mark_invoice_shared(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
begin
  select * into i from public.invoices where id = p_invoice for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(i.workspace_id);
  if i.status = 'issued' then
    update public.invoices set sent_at = coalesce(sent_at, now()) where id = p_invoice;
    perform app.invoice_event(i.workspace_id, p_invoice, 'shared', '{"channel": "whatsapp"}'::jsonb);
  end if;
end $$;

create or replace function public.record_invoice_reminder(p_invoice uuid, p_stage text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
begin
  select * into i from public.invoices where id = p_invoice for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(i.workspace_id);
  if i.status <> 'issued' or i.invoice_type = 'proforma' or i.amount_received >= i.grand_total then
    raise exception 'There is nothing to remind about on this invoice' using errcode = '22023';
  end if;
  insert into public.invoice_reminders (workspace_id, invoice_id, stage, outstanding, sent_by)
  values (i.workspace_id, p_invoice, p_stage, i.grand_total - i.amount_received, app.uid());
  update public.invoices set last_reminder_at = now(), sent_at = coalesce(sent_at, now()) where id = p_invoice;
  perform app.invoice_event(i.workspace_id, p_invoice, 'reminder', jsonb_build_object('stage', p_stage));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------------------------------------------
create or replace function public.add_invoice_attachment(p_invoice uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_role text := coalesce(nullif(p ->> 'role', ''), 'supporting');
  v_path text := p ->> 'storage_path';
  v_id uuid;
begin
  select * into i from public.invoices where id = p_invoice for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform app.require_write(i.workspace_id);
  if i.status = 'cancelled' then
    raise exception 'This invoice is cancelled' using errcode = '22023';
  end if;
  if v_path not like i.workspace_id::text || '/' || i.id::text || '/%' or v_path ~ '\.\.' then
    raise exception 'Upload the file again' using errcode = '22023';
  end if;
  if v_role = 'original' then
    if i.status <> 'draft' and exists (select 1 from public.invoice_attachments where invoice_id = p_invoice and role = 'original') then
      raise exception 'The original of an issued invoice cannot be replaced' using errcode = '22023';
    end if;
    delete from public.invoice_attachments where invoice_id = p_invoice and role = 'original';
  end if;
  insert into public.invoice_attachments (workspace_id, invoice_id, role, storage_path, file_name, mime_type, size_bytes, sha256, page_count, client_visible, created_by)
  values (i.workspace_id, p_invoice, v_role, v_path, app.clean_text(p ->> 'file_name', 200), p ->> 'mime_type',
    (p ->> 'size_bytes')::integer, p ->> 'sha256', nullif(p ->> 'page_count', '')::integer,
    coalesce((p ->> 'client_visible')::boolean, false), app.uid())
  returning id into v_id;
  perform app.invoice_event(i.workspace_id, p_invoice, 'attachment_added', jsonb_build_object('file', p ->> 'file_name', 'role', v_role));
  return v_id;
end $$;

create or replace function public.set_attachment_visibility(p_id uuid, p_visible boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  a public.invoice_attachments;
begin
  select * into a from public.invoice_attachments where id = p_id;
  if not found then
    raise exception 'File not found' using errcode = 'P0002';
  end if;
  perform app.require_write(a.workspace_id);
  update public.invoice_attachments set client_visible = p_visible where id = p_id;
  perform app.invoice_event(a.workspace_id, a.invoice_id, case when p_visible then 'attachment_shared' else 'attachment_hidden' end, jsonb_build_object('file', a.file_name));
end $$;

create or replace function public.remove_invoice_attachment(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  a public.invoice_attachments;
  v_status text;
begin
  select * into a from public.invoice_attachments where id = p_id;
  if not found then
    raise exception 'File not found' using errcode = 'P0002';
  end if;
  perform app.require_write(a.workspace_id);
  select status into v_status from public.invoices where id = a.invoice_id;
  if a.role = 'original' and v_status <> 'draft' then
    raise exception 'The original of an issued invoice cannot be removed' using errcode = '22023';
  end if;
  delete from public.invoice_attachments where id = p_id;
  perform app.invoice_event(a.workspace_id, a.invoice_id, 'attachment_removed', jsonb_build_object('file', a.file_name));
  return a.storage_path;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Public access. A token reaches one issued invoice and nothing else.
-- ---------------------------------------------------------------------------------------------
create or replace function app.invoice_by_token(p_token text) returns public.invoices
language plpgsql stable security definer set search_path = '' as $$
declare
  i public.invoices;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,128}$' then
    return null;
  end if;
  select v.* into i from public.invoice_share_links l join public.invoices v on v.id = l.invoice_id
  where l.token_hash = app.token_hash(p_token) and l.revoked_at is null and (l.expires_at is null or l.expires_at > now())
    and v.status = 'issued';
  return i;
end $$;

create or replace function public.get_public_invoice(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  i public.invoices := app.invoice_by_token(p_token);
begin
  if i.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'invoice_no', i.invoice_no, 'invoice_type', i.invoice_type, 'source', i.source, 'title', i.title,
    'invoice_date', i.invoice_date, 'due_date', i.due_date, 'currency', i.currency, 'payment_terms', i.payment_terms,
    'status', app.invoice_status(i, app.india_today()),
    'seller', i.seller_snapshot, 'template', i.template,
    'client', jsonb_build_object('name', i.client_name, 'business', i.client_business, 'contact', i.client_contact,
      'address', i.client_address, 'gstin', i.client_gstin, 'state', i.client_state, 'country', i.client_country),
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
    'payment', i.payment_snapshot,
    'show_digital_qr', i.show_digital_qr, 'allow_payment_claims', i.allow_payment_claims,
    'payments', case when i.show_payment_history then (select coalesce(jsonb_agg(jsonb_build_object('paid_on', p.paid_on, 'amount', p.amount, 'mode', p.mode) order by p.paid_on), '[]'::jsonb)
      from public.invoice_payments p where p.invoice_id = i.id and p.status = 'confirmed') else '[]'::jsonb end,
    'pending_claims', (select count(*) from public.invoice_payment_submissions c where c.invoice_id = i.id and c.status = 'pending'),
    'files', (select coalesce(jsonb_agg(jsonb_build_object('n', f.n, 'role', f.role, 'file_name', f.file_name, 'mime_type', f.mime_type, 'size_bytes', f.size_bytes, 'page_count', f.page_count) order by f.n), '[]'::jsonb)
      from (select row_number() over (order by a.created_at, a.id) n, a.* from public.invoice_attachments a where a.invoice_id = i.id) f
      where f.client_visible));
end $$;

-- What a link preview may say: who sent it and which invoice. Never the amount or the client.
create or replace function public.get_invoice_card(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  i public.invoices := app.invoice_by_token(p_token);
begin
  if i.id is null then
    return null;
  end if;
  return jsonb_build_object('invoice_no', i.invoice_no, 'invoice_type', i.invoice_type,
    'business', i.seller_snapshot ->> 'business_name', 'logo_path', i.seller_snapshot ->> 'logo_path',
    'brand_color', i.seller_snapshot ->> 'brand_color');
end $$;

create or replace function public.note_invoice_view(p_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices := app.invoice_by_token(p_token);
begin
  if i.id is null then
    return;
  end if;
  update public.invoice_share_links set view_count = view_count + 1, last_viewed_at = now()
  where token_hash = app.token_hash(p_token);
  if i.first_viewed_at is null then
    update public.invoices set first_viewed_at = now() where id = i.id;
    perform app.invoice_event(i.workspace_id, i.id, 'viewed', '{}'::jsonb, 'client');
  end if;
end $$;

-- The n-th visible file of this invoice, for the server to stream. Never returns a hidden file.
create or replace function public.get_public_invoice_file(p_token text, p_n integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  i public.invoices := app.invoice_by_token(p_token);
begin
  if i.id is null then
    return null;
  end if;
  return (select jsonb_build_object('path', f.storage_path, 'file_name', f.file_name, 'mime_type', f.mime_type)
    from (select row_number() over (order by a.created_at, a.id) n, a.* from public.invoice_attachments a where a.invoice_id = i.id) f
    where f.n = p_n and f.client_visible);
end $$;

-- Client says "I've paid". Stored as a claim only; no balance, status or ledger moves.
create or replace function public.submit_payment_claim(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices := app.invoice_by_token(p_token);
  v_id uuid := gen_random_uuid();
  v_path text;
  v_mime text := nullif(p ->> 'proof_mime', '');
begin
  if i.id is null or not i.allow_payment_claims or i.invoice_type = 'proforma' then
    raise exception 'This invoice is not accepting payment notes' using errcode = '22023';
  end if;
  if (select count(*) from public.invoice_payment_submissions where invoice_id = i.id and status = 'pending') >= 10 then
    raise exception 'Several notes are already waiting for review. Please contact the business.' using errcode = '22023';
  end if;
  if v_mime is not null and v_mime not in ('image/png', 'image/jpeg', 'application/pdf') then
    raise exception 'Attach a JPG, PNG or PDF' using errcode = '22023';
  end if;
  if v_mime is not null then
    v_path := i.workspace_id::text || '/' || i.id::text || '/proofs/' || encode(sha256(convert_to(v_id::text || p_token, 'UTF8')), 'hex');
  end if;
  insert into public.invoice_payment_submissions (id, workspace_id, invoice_id, amount, paid_on, mode, reference, message, proof_path, proof_mime)
  values (v_id, i.workspace_id, i.id, app.money(p ->> 'amount', 'Amount'), app.txn_date(p ->> 'paid_on'), app.payment_mode(p ->> 'mode'),
    app.clean_text(p ->> 'reference', 80), app.clean_text(p ->> 'message', 500), v_path, v_mime);
  perform app.invoice_event(i.workspace_id, i.id, 'claim_submitted', jsonb_build_object('amount', p ->> 'amount'), 'client');
  return jsonb_build_object('proof_path', v_path);
end $$;

create or replace function public.confirm_claim_proof(p_token text, p_path text) returns void
language sql security definer set search_path = '' as $$
  update public.invoice_payment_submissions c set proof_received = true
  where c.proof_path = p_path and c.invoice_id = (app.invoice_by_token(p_token)).id
$$;

-- Storage rules call these. A public read works only while the invoice's link is live and the file
-- is marked client-visible; a public write works only for a path a claim just reserved.
create or replace function app.invoice_file_public(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.invoice_attachments a
    join public.invoice_share_links l on l.invoice_id = a.invoice_id
    join public.invoices i on i.id = a.invoice_id
    where a.storage_path = p_path and a.client_visible and i.status = 'issued'
      and l.revoked_at is null and (l.expires_at is null or l.expires_at > now()))
$$;

create or replace function app.claim_proof_open(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.invoice_payment_submissions c
    where c.proof_path = p_path and not c.proof_received and c.created_at > now() - interval '15 minutes')
$$;

-- ---------------------------------------------------------------------------------------------
-- Storage buckets
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'buckets') then
    -- Logos, signatures and fixed QRs: they print on every invoice; names are random.
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('invoice-brand', 'invoice-brand', true, 2097152, array['image/png', 'image/jpeg'])
    on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    -- Original invoices, supporting files and payment proofs: private.
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('invoice-files', 'invoice-files', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

    execute 'drop policy if exists invoice_brand_write on storage.objects';
    execute 'drop policy if exists invoice_brand_delete on storage.objects';
    execute 'drop policy if exists invoice_files_read on storage.objects';
    execute 'drop policy if exists invoice_files_write on storage.objects';
    execute 'drop policy if exists invoice_files_delete on storage.objects';
    execute 'drop policy if exists invoice_files_public on storage.objects';
    execute 'drop policy if exists invoice_proofs_public on storage.objects';
    execute $p$
      create policy invoice_brand_write on storage.objects for insert to authenticated
      with check (bucket_id = 'invoice-brand' and (select app.can_write(((storage.foldername(name))[1])::uuid)))
    $p$;
    execute $p$
      create policy invoice_brand_delete on storage.objects for delete to authenticated
      using (bucket_id = 'invoice-brand' and (select app.can_write(((storage.foldername(name))[1])::uuid)))
    $p$;
    execute $p$
      create policy invoice_files_read on storage.objects for select to authenticated
      using (bucket_id = 'invoice-files' and (select app.is_member(((storage.foldername(name))[1])::uuid)))
    $p$;
    execute $p$
      create policy invoice_files_write on storage.objects for insert to authenticated
      with check (bucket_id = 'invoice-files' and (select app.can_write(((storage.foldername(name))[1])::uuid)))
    $p$;
    execute $p$
      create policy invoice_files_delete on storage.objects for delete to authenticated
      using (bucket_id = 'invoice-files' and (select app.can_write(((storage.foldername(name))[1])::uuid)))
    $p$;
    execute $p$
      create policy invoice_files_public on storage.objects for select to anon
      using (bucket_id = 'invoice-files' and app.invoice_file_public(name))
    $p$;
    execute $p$
      create policy invoice_proofs_public on storage.objects for insert to anon
      with check (bucket_id = 'invoice-files' and app.claim_proof_open(name))
    $p$;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'app.guard_invoice_txn()', 'app.reverse_linked_txn(uuid, text, date, text)', 'app.invoice_event(uuid, uuid, text, jsonb, text)',
    'app.invoice_settings_row(uuid)', 'app.fy_label(date, integer)', 'app.next_invoice_no(public.invoice_settings, text, date)',
    'app.recalc_invoice(uuid)', 'app.refresh_invoice_money(uuid)', 'app.payment_snapshot(uuid, jsonb)',
    'app.seller_snapshot(public.invoice_settings)', 'app.india_today()', 'app.invoice_status(public.invoices, date)',
    'app.apply_invoice_payment(uuid, numeric, date, text, text, text, text, text, boolean, text)',
    'app.invoice_by_token(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function app.invoice_file_public(text), app.claim_proof_open(text) to anon, authenticated;

revoke all on function
  public.save_invoice_settings(uuid, jsonb), public.set_invoice_brand_image(uuid, text, text),
  public.save_payment_profile(uuid, jsonb), public.archive_payment_profile(uuid),
  public.save_invoice_library_item(uuid, jsonb), public.delete_invoice_library_item(uuid),
  public.save_invoice(jsonb), public.delete_draft_invoice(uuid), public.duplicate_invoice(uuid, text),
  public.issue_invoice(uuid, text, text), public.amend_issued_invoice(uuid, jsonb), public.cancel_invoice(uuid, text),
  public.record_invoice_payment(uuid, jsonb), public.reverse_invoice_payment(uuid, text, text),
  public.review_payment_submission(uuid, boolean, jsonb), public.rotate_invoice_link(uuid, text, text, timestamptz),
  public.revoke_invoice_link(uuid), public.invoice_link_secret(uuid), public.mark_invoice_shared(uuid),
  public.record_invoice_reminder(uuid, text), public.add_invoice_attachment(uuid, jsonb),
  public.set_attachment_visibility(uuid, boolean), public.remove_invoice_attachment(uuid),
  public.get_public_invoice(text), public.get_invoice_card(text), public.note_invoice_view(text),
  public.get_public_invoice_file(text, integer), public.submit_payment_claim(text, jsonb), public.confirm_claim_proof(text, text)
from public, anon;

grant execute on function
  public.save_invoice_settings(uuid, jsonb), public.set_invoice_brand_image(uuid, text, text),
  public.save_payment_profile(uuid, jsonb), public.archive_payment_profile(uuid),
  public.save_invoice_library_item(uuid, jsonb), public.delete_invoice_library_item(uuid),
  public.save_invoice(jsonb), public.delete_draft_invoice(uuid), public.duplicate_invoice(uuid, text),
  public.issue_invoice(uuid, text, text), public.amend_issued_invoice(uuid, jsonb), public.cancel_invoice(uuid, text),
  public.record_invoice_payment(uuid, jsonb), public.reverse_invoice_payment(uuid, text, text),
  public.review_payment_submission(uuid, boolean, jsonb), public.rotate_invoice_link(uuid, text, text, timestamptz),
  public.revoke_invoice_link(uuid), public.invoice_link_secret(uuid), public.mark_invoice_shared(uuid),
  public.record_invoice_reminder(uuid, text), public.add_invoice_attachment(uuid, jsonb),
  public.set_attachment_visibility(uuid, boolean), public.remove_invoice_attachment(uuid)
to authenticated;

-- The only entry points without signing in, each scoped by an unguessable token.
grant execute on function
  public.get_public_invoice(text), public.get_invoice_card(text), public.note_invoice_view(text),
  public.get_public_invoice_file(text, integer), public.submit_payment_claim(text, jsonb), public.confirm_claim_proof(text, text)
to anon, authenticated;
