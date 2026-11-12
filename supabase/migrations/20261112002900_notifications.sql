-- In-app notifications.
--
-- One row per person per event, readable only by that person. Written by the database itself,
-- so nothing can be missed by a screen that forgot to send one:
--   * entry       someone else added money in / out on a ledger you are in
--   * expense     someone else added an expense with you (shared and one-to-one accounts)
--   * payment     someone else recorded a payment between you
--   * confirmed   the person you shared a statement with confirmed it
--   * invoice_viewed / invoice_claim   your client opened an invoice / says they paid
--   * joined      someone with your client's phone number joined Lekha (link them on their page)
--   * invoice_overdue / advance_due    reminders, made when you open Lekha (once each)
-- Your own actions never notify you.

create table public.notifications (
  id bigint generated always as identity primary key,
  user_id text not null,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  kind text not null check (kind in ('entry', 'expense', 'payment', 'confirmed', 'invoice_viewed', 'invoice_claim', 'joined', 'invoice_overdue', 'advance_due')),
  actor_name text,
  subject text,            -- ledger, invoice or client the event is about
  amount numeric(14, 2),
  direction text check (direction is null or direction in ('in', 'out')),
  detail text,
  href text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, dedupe_key)
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;
create policy notifications_select_own on public.notifications for select to authenticated
  using (user_id = (select app.uid()));
grant select on public.notifications to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
create or replace function app.person_name(p_user text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select full_name from public.user_profiles where user_id = p_user),
    (select display_name from public.workspace_members where user_id = p_user and display_name is not null limit 1),
    'Someone')
$$;

create or replace function app.notify(p_users text[], p_ws uuid, p_kind text, p_actor text, p_subject text,
  p_amount numeric, p_direction text, p_detail text, p_href text, p_dedupe text default null) returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (user_id, workspace_id, kind, actor_name, subject, amount, direction, detail, href, dedupe_key)
  select distinct u, p_ws, p_kind, p_actor, left(p_subject, 160), p_amount, p_direction, left(p_detail, 300), p_href, p_dedupe
  from unnest(p_users) u
  where u is not null and u is distinct from app.uid()
  on conflict (user_id, dedupe_key) do nothing
$$;

-- Everyone who can see a ledger: workspace members, plus people it was shared with.
create or replace function app.ledger_audience(p_ledger uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct u), '{}') from (
    select m.user_id u from public.ledgers l join public.workspace_members m on m.workspace_id = l.workspace_id where l.id = p_ledger
    union
    select c.user_id from public.ledger_collaborators c where c.ledger_id = p_ledger and c.status = 'active'
    union
    select p.user_id from public.ledger_participants p where p.ledger_id = p_ledger and p.user_id is not null
  ) x
$$;

-- People who manage a workspace (owners and admins, plus members who can write).
create or replace function app.workspace_writers(p_ws uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(user_id), '{}') from public.workspace_members where workspace_id = p_ws and role <> 'viewer'
$$;

-- ---------------------------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------------------------
create or replace function app.notify_transaction() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  l public.ledgers;
begin
  -- Imports post many rows at once and the importer already knows; drafts are not news yet.
  if new.status <> 'posted' or new.import_batch_id is not null or app.uid() is null then
    return null;
  end if;
  select * into l from public.ledgers where id = new.ledger_id;
  if l.ledger_type = 'personal' then
    return null; -- shared accounts notify through their expenses and payments
  end if;
  perform app.notify(app.ledger_audience(l.id), l.workspace_id, 'entry', app.person_name(app.uid()), l.name,
    new.amount, new.direction, coalesce(new.description, new.counterparty), '/ledgers/' || l.id::text);
  return null;
end $$;

create trigger transactions_notify after insert on public.transactions
  for each row execute function app.notify_transaction();

create or replace function app.notify_shared_expense() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  l public.ledgers;
begin
  if new.status <> 'posted' or app.uid() is null then
    return null;
  end if;
  select * into l from public.ledgers where id = new.ledger_id;
  perform app.notify(
    (select coalesce(array_agg(user_id), '{}') from public.ledger_participants where ledger_id = l.id and user_id is not null),
    l.workspace_id, 'expense', app.person_name(app.uid()), l.name, new.total_amount, null, new.description, '/ledgers/' || l.id::text);
  return null;
end $$;

create trigger shared_expenses_notify after insert on public.shared_expenses
  for each row execute function app.notify_shared_expense();

create or replace function app.notify_settlement() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  l public.ledgers;
begin
  if new.status <> 'posted' or app.uid() is null then
    return null;
  end if;
  select * into l from public.ledgers where id = new.ledger_id;
  perform app.notify(
    (select coalesce(array_agg(user_id), '{}') from public.ledger_participants where id in (new.from_participant_id, new.to_participant_id) and user_id is not null)
      || (select coalesce(array_agg(user_id), '{}') from public.workspace_members where workspace_id = l.workspace_id and role in ('owner', 'admin')),
    l.workspace_id, 'payment', app.person_name(app.uid()), l.name, new.amount, null,
    (select display_name from public.ledger_participants where id = new.from_participant_id) || ' paid ' ||
    (select display_name from public.ledger_participants where id = new.to_participant_id),
    '/ledgers/' || l.id::text);
  return null;
end $$;

create trigger settlements_notify after insert on public.settlements
  for each row execute function app.notify_settlement();

create or replace function app.notify_acknowledgement() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  l public.ledgers;
begin
  select * into l from public.ledgers where id = new.ledger_id;
  perform app.notify(app.workspace_writers(l.workspace_id), l.workspace_id, 'confirmed', coalesce(new.name, 'The person you shared it with'),
    l.name, null, null, null, '/ledgers/' || l.id::text, 'ack:' || new.id::text);
  return null;
end $$;

create trigger share_acknowledgements_notify after insert on public.share_acknowledgements
  for each row execute function app.notify_acknowledgement();

create or replace function app.notify_invoice_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
begin
  if new.actor_type <> 'client' or new.event not in ('viewed', 'claim_submitted') then
    return null;
  end if;
  select * into i from public.invoices where id = new.invoice_id;
  perform app.notify(app.workspace_writers(i.workspace_id), i.workspace_id,
    case when new.event = 'viewed' then 'invoice_viewed' else 'invoice_claim' end,
    i.client_name, 'Invoice ' || coalesce(i.invoice_no, ''), nullif(new.detail ->> 'amount', '')::numeric, case when new.event = 'claim_submitted' then 'in' end,
    null, '/invoices/' || i.id::text, new.event || ':' || new.id::text);
  return null;
end $$;

create trigger invoice_events_notify after insert on public.invoice_events
  for each row execute function app.notify_invoice_event();

-- Someone joins (or adds their number): tell whoever holds a client card with that number.
create or replace function app.notify_joined() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c record;
begin
  if new.username is null or app.phone_key(new.phone) is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.username is not distinct from new.username and app.phone_key(old.phone) is not distinct from app.phone_key(new.phone) then
    return null;
  end if;
  for c in
    select id, workspace_id, created_by, name from public.contractors
    where app.phone_key(phone) = app.phone_key(new.phone) and linked_user_id is null and is_active and merged_into is null
  loop
    perform app.notify(array[c.created_by], c.workspace_id, 'joined', new.full_name, c.name, null, null, '@' || new.username,
      '/contractors/' || c.id::text, 'joined:' || c.id::text || ':' || new.user_id);
  end loop;
  return null;
end $$;

create trigger user_profiles_notify_joined after insert or update on public.user_profiles
  for each row execute function app.notify_joined();

-- ---------------------------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------------------------
-- Reminders are made when you open Lekha: once per overdue invoice / advance, never repeated.
create or replace function public.refresh_my_reminders() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid text := app.uid();
  r record;
begin
  if v_uid is null then
    return;
  end if;
  for r in
    select i.id, i.workspace_id, i.invoice_no, i.client_name, i.grand_total - i.amount_received as due, i.due_date
    from public.invoices i join public.workspace_members m on m.workspace_id = i.workspace_id and m.user_id = v_uid and m.role <> 'viewer'
    where i.status = 'issued' and i.invoice_type <> 'proforma' and i.due_date < app.india_today() and i.grand_total > i.amount_received
  loop
    insert into public.notifications (user_id, workspace_id, kind, actor_name, subject, amount, direction, detail, href, dedupe_key)
    values (v_uid, r.workspace_id, 'invoice_overdue', r.client_name, 'Invoice ' || coalesce(r.invoice_no, ''), r.due, 'in',
      'Was due ' || to_char(r.due_date, 'DD Mon YYYY'), '/invoices/' || r.id::text, 'overdue:' || r.id::text)
    on conflict (user_id, dedupe_key) do nothing;
  end loop;
  for r in
    select a.id, a.workspace_id, a.amount, a.expected_recovery_date, c.name
    from public.advances a join public.workspace_members m on m.workspace_id = a.workspace_id and m.user_id = v_uid and m.role <> 'viewer'
    left join public.contractors c on c.id = a.contractor_id
    where a.status = 'active' and a.expected_recovery_date < app.india_today()
  loop
    insert into public.notifications (user_id, workspace_id, kind, actor_name, subject, amount, direction, detail, href, dedupe_key)
    values (v_uid, r.workspace_id, 'advance_due', r.name, 'Advance', r.amount, 'in',
      'Expected back by ' || to_char(r.expected_recovery_date, 'DD Mon YYYY'), '/advances/' || r.id::text, 'advance:' || r.id::text)
    on conflict (user_id, dedupe_key) do nothing;
  end loop;
  -- Keep it light: read notifications older than 90 days are cleared.
  delete from public.notifications where user_id = v_uid and read_at is not null and created_at < now() - interval '90 days';
end $$;

create or replace function public.mark_notifications_read(p_ids bigint[] default null) returns void
language sql security definer set search_path = '' as $$
  update public.notifications set read_at = now()
  where user_id = app.uid() and read_at is null and (p_ids is null or id = any(p_ids))
$$;

revoke all on function app.person_name(text), app.notify(text[], uuid, text, text, text, numeric, text, text, text, text),
  app.ledger_audience(uuid), app.workspace_writers(uuid) from public, anon, authenticated;
revoke all on function public.refresh_my_reminders(), public.mark_notifications_read(bigint[]) from public, anon;
grant execute on function public.refresh_my_reminders(), public.mark_notifications_read(bigint[]) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.notifications';
  end if;
end $$;
