-- People in shared accounts are real client records.
--
-- Before: a shared (personal) ledger stored free-text names, so "Aagam Jain owes you ₹120" lived only
-- inside that ledger and never reached the workspace overview or the client list.
-- After: every participant other than the owner points at a client (public.contractors) in the same
-- workspace. Balances roll up per client across party ledgers and shared accounts, the client can be
-- invited to see their own side, and once they join, their client record shows it.

-- ---------------------------------------------------------------------------------------------
-- Clients: business (clients, contractors, suppliers) or personal (friends, family)
-- ---------------------------------------------------------------------------------------------
alter table public.contractors
  add column if not exists kind text not null default 'business' check (kind in ('business', 'personal')),
  add column if not exists linked_user_id text;

grant select (kind, linked_user_id) on public.contractors to authenticated;
grant insert (kind) on public.contractors to authenticated;
grant update (kind) on public.contractors to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Participants point at clients
-- ---------------------------------------------------------------------------------------------
alter table public.ledger_participants add column if not exists contractor_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ledger_participants_contractor_fk') then
    alter table public.ledger_participants
      add constraint ledger_participants_contractor_fk
      foreign key (contractor_id, workspace_id) references public.contractors (id, workspace_id);
  end if;
end $$;

create unique index if not exists ledger_participants_contractor_idx
  on public.ledger_participants (ledger_id, contractor_id) where contractor_id is not null;
create index if not exists ledger_participants_contractor_lookup_idx on public.ledger_participants (contractor_id);

-- Backfill existing free-text participants: reuse a client with the same name in the workspace,
-- otherwise create a personal client for them. The ledger owner (position 0) is "you", not a client.
do $$
declare
  p record;
  v_client uuid;
begin
  for p in
    select lp.id, lp.workspace_id, lp.display_name, l.owner_user_id
    from public.ledger_participants lp
    join public.ledgers l on l.id = lp.ledger_id
    where lp.contractor_id is null and lp.position > 0
  loop
    select c.id into v_client from public.contractors c
    where c.workspace_id = p.workspace_id and lower(btrim(c.name)) = lower(btrim(p.display_name))
    order by c.is_active desc, c.created_at
    limit 1;
    if v_client is null then
      insert into public.contractors (workspace_id, name, kind, created_by)
      values (p.workspace_id, p.display_name, 'personal', p.owner_user_id)
      returning id into v_client;
    end if;
    update public.ledger_participants set contractor_id = v_client where id = p.id;
  end loop;
end $$;

-- Someone who already joined: show it on their client record.
update public.contractors c set linked_user_id = lp.user_id
from public.ledger_participants lp
where lp.contractor_id = c.id and lp.user_id is not null and c.linked_user_id is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ledger_participants_need_client') then
    alter table public.ledger_participants
      add constraint ledger_participants_need_client check (position = 0 or contractor_id is not null);
  end if;
end $$;

-- Keep participant names in step with the client record.
create or replace function app.sync_participant_names() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.name is distinct from old.name then
    update public.ledger_participants set display_name = new.name where contractor_id = new.id;
  end if;
  return null;
end $$;

drop trigger if exists contractors_sync_participants on public.contractors;
create trigger contractors_sync_participants after update of name on public.contractors
  for each row execute function app.sync_participant_names();

-- When an invited person joins a shared account, their client record shows they're on Lekha.
create or replace function app.link_client_on_join() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.user_id is not null and old.user_id is null and new.contractor_id is not null then
    update public.contractors set linked_user_id = new.user_id
    where id = new.contractor_id and linked_user_id is null;
  end if;
  return null;
end $$;

drop trigger if exists ledger_participants_link_client on public.ledger_participants;
create trigger ledger_participants_link_client after update of user_id on public.ledger_participants
  for each row execute function app.link_client_on_join();

-- ---------------------------------------------------------------------------------------------
-- Ledger creation: shared accounts take client ids, not names
-- ---------------------------------------------------------------------------------------------
create or replace function app.add_client_participant(p_ledger public.ledgers, p_client uuid, p_position integer)
returns uuid
language plpgsql set search_path = '' as $$
declare
  c public.contractors;
  v_id uuid;
begin
  select * into c from public.contractors where id = p_client and workspace_id = p_ledger.workspace_id;
  if not found then
    raise exception 'Choose people from your client accounts' using errcode = '22023';
  end if;
  if not c.is_active then
    raise exception '% is marked inactive. Reactivate them first.', c.name using errcode = '22023';
  end if;
  if exists (select 1 from public.ledger_participants where ledger_id = p_ledger.id and contractor_id = p_client) then
    raise exception '% is already in this account', c.name using errcode = '22023';
  end if;
  insert into public.ledger_participants (workspace_id, ledger_id, display_name, contractor_id, user_id, position)
  values (p_ledger.workspace_id, p_ledger.id, c.name, c.id, null, p_position)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.create_ledger(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := (p ->> 'workspace_id')::uuid;
  v_type text := p ->> 'ledger_type';
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
  v_perspective := case when v_type = 'personal' then 'personal' else coalesce(nullif(p ->> 'perspective', ''), 'cashbook') end;
  if v_perspective not in ('cashbook', 'party', 'personal') then
    raise exception 'Choose how the balance should be read' using errcode = '22023';
  end if;

  insert into public.ledgers (
    workspace_id, contractor_id, name, ledger_type, perspective, reference_no, opening_balance,
    opening_balance_date, description, notes, gst_mode, color, owner_user_id, voucher_prefix)
  values (
    v_ws, case when v_type = 'personal' then null else nullif(p ->> 'contractor_id', '')::uuid end,
    coalesce(app.clean_text(p ->> 'name', 120), 'Untitled ledger'),
    v_type, v_perspective, app.clean_text(p ->> 'reference_no', 60),
    case when v_type = 'personal' then 0 else app.signed_money(p ->> 'opening_balance', 'Opening balance') end,
    nullif(p ->> 'opening_balance_date', '')::date,
    app.clean_text(p ->> 'description', 500), app.clean_text(p ->> 'notes', 2000),
    coalesce(nullif(p ->> 'gst_mode', ''), v_ws_row.default_gst_mode),
    coalesce(nullif(p ->> 'color', ''), case v_type when 'basic' then 'mustard' when 'taxation' then 'lavender' else 'pink' end),
    app.uid(),
    case v_type when 'basic' then 'BL' when 'taxation' then 'TX' else 'PS' end)
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

drop function if exists public.add_ledger_participant(uuid, text);
create or replace function public.add_ledger_participant(p_ledger uuid, p_client uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v public.ledgers;
begin
  v := app.lock_ledger(p_ledger, true);
  perform app.require_write(v.workspace_id);
  return app.add_client_participant(v, p_client,
    (select coalesce(max(position), 0) + 1 from public.ledger_participants where ledger_id = p_ledger));
end $$;

revoke all on function public.add_ledger_participant(uuid, uuid) from public, anon;
revoke all on function app.add_client_participant(public.ledgers, uuid, integer) from public, anon, authenticated;
revoke all on function app.sync_participant_names() from public, anon, authenticated;
revoke all on function app.link_client_on_join() from public, anon, authenticated;
grant execute on function public.add_ledger_participant(uuid, uuid) to authenticated;
