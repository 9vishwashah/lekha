-- Connect requests: linking a client record to that person's own Lekha account, with their consent.
--
-- Before: a client showed "On Lekha" only if the person happened to join through one of your
-- invitation links. Someone who signed up on their own was never linked, and linking by matching
-- emails or phone numbers automatically would let anyone attach themselves to anyone.
-- Now: you send a request to the email on the client record. It waits in that person's Lekha
-- (whether they signed up before or after) until they accept or decline. Nothing is linked without
-- their yes, and the sender never learns whether an email belongs to a Lekha account.
--
-- Requires the Clerk session token to carry the verified primary email:
--   "email": "{{user.primary_email_address}}"

create or replace function app.jwt_email() returns text
language sql stable set search_path = '' as $$
  select nullif(lower(btrim(auth.jwt() ->> 'email')), '')
$$;

create table if not exists public.client_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  contractor_id uuid not null,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  requested_by text not null,
  responded_by text,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  foreign key (contractor_id, workspace_id) references public.contractors (id, workspace_id) on delete cascade
);
create unique index if not exists client_connections_one_pending_idx on public.client_connections (contractor_id) where status = 'pending';
create index if not exists client_connections_inbox_idx on public.client_connections (email) where status = 'pending';

alter table public.client_connections enable row level security;
revoke all on public.client_connections from anon, authenticated;
grant select on public.client_connections to authenticated;
-- Members see the requests their workspace sent. The recipient reads theirs through
-- my_connection_requests(), which reveals only who is asking.
drop policy if exists client_connections_members on public.client_connections;
create policy client_connections_members on public.client_connections for select to authenticated
  using ((select app.is_member(workspace_id)));

-- ---------------------------------------------------------------------------------------------
-- Joining shared accounts: a connected person sees the shared accounts they are part of
-- ---------------------------------------------------------------------------------------------
create or replace function app.join_as_participant(p_participant uuid, p_user text, p_by text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  lp public.ledger_participants;
begin
  select * into lp from public.ledger_participants where id = p_participant;
  if not found or (lp.user_id is not null and lp.user_id <> p_user) then
    return false;
  end if;
  -- Already someone else in this account, or a member of the workspace (sees it anyway).
  if exists (select 1 from public.ledger_participants where ledger_id = lp.ledger_id and user_id = p_user and id <> lp.id)
     or exists (select 1 from public.workspace_members where workspace_id = lp.workspace_id and user_id = p_user) then
    return false;
  end if;
  update public.ledger_participants set user_id = p_user where id = lp.id;
  insert into public.ledger_collaborators (
    workspace_id, ledger_id, user_id, participant_id, display_name, can_create, can_edit_own, can_edit_all,
    can_attach, can_view_tax, invited_by)
  values (lp.workspace_id, lp.ledger_id, p_user, lp.id, lp.display_name, true, true, false, false, false, p_by)
  on conflict (ledger_id, user_id) do update set
    status = 'active', revoked_at = null, participant_id = excluded.participant_id;
  return true;
end $$;

-- Adding a connected client to a shared account gives them access straight away.
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
  if c.linked_user_id is not null then
    perform app.join_as_participant(v_id, c.linked_user_id, app.uid());
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Sender side
-- ---------------------------------------------------------------------------------------------
create or replace function public.request_client_connection(p_contractor uuid, p_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.contractors;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
begin
  select * into c from public.contractors where id = p_contractor for update;
  if not found then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;
  perform app.require_write(c.workspace_id);
  if c.linked_user_id is not null then
    raise exception '% is already connected', c.name using errcode = '22023';
  end if;
  if v_email = '' then
    v_email := lower(btrim(coalesce(c.email, '')));
  end if;
  if v_email = '' then
    raise exception 'Add % email address to send a request', c.name || '’s' using errcode = '22023';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 200 then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  if v_email = app.jwt_email() then
    raise exception 'That is your own email. Use the email % signs in with.', c.name using errcode = '22023';
  end if;
  if c.email is null then
    update public.contractors set email = v_email where id = c.id;
  end if;
  update public.client_connections set status = 'cancelled', responded_at = now()
  where contractor_id = c.id and status = 'pending';
  insert into public.client_connections (workspace_id, contractor_id, email, requested_by)
  values (c.workspace_id, c.id, v_email, app.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.cancel_client_connection(p_contractor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.contractors;
begin
  select * into c from public.contractors where id = p_contractor;
  if not found then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;
  perform app.require_write(c.workspace_id);
  update public.client_connections set status = 'cancelled', responded_at = now()
  where contractor_id = c.id and status = 'pending';
end $$;

-- Unlinks a client from their account. They lose access to this workspace's shared accounts;
-- every entry stays. They can be sent a new request later.
create or replace function public.disconnect_client(p_contractor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.contractors;
begin
  select * into c from public.contractors where id = p_contractor for update;
  if not found then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;
  perform app.require_write(c.workspace_id);
  if c.linked_user_id is null then
    return;
  end if;
  update public.ledger_collaborators lc set status = 'revoked', revoked_at = now()
  from public.ledger_participants lp
  where lc.participant_id = lp.id and lp.contractor_id = c.id and lc.user_id = c.linked_user_id and lc.status = 'active';
  update public.ledger_participants set user_id = null where contractor_id = c.id and user_id = c.linked_user_id;
  update public.contractors set linked_user_id = null where id = c.id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Recipient side
-- ---------------------------------------------------------------------------------------------
create or replace function public.my_connection_requests() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id,
      'from_name', coalesce(up.full_name, wm.display_name, 'Someone'),
      'business', w.name,
      'as_name', c.name,
      'created_at', r.created_at)
    order by r.created_at desc), '[]'::jsonb)
  from public.client_connections r
  join public.contractors c on c.id = r.contractor_id
  join public.workspaces w on w.id = r.workspace_id
  left join public.user_profiles up on up.user_id = r.requested_by
  left join public.workspace_members wm on wm.workspace_id = r.workspace_id and wm.user_id = r.requested_by
  where r.status = 'pending' and app.jwt_email() is not null and r.email = app.jwt_email()
    and r.requested_by <> app.uid() and c.linked_user_id is null
$$;

create or replace function public.respond_client_connection(p_id uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid text := app.uid();
  r public.client_connections;
  c public.contractors;
  v_other text;
  v_joined integer := 0;
  p record;
begin
  if v_uid is null then
    raise exception 'Sign in to continue' using errcode = '42501';
  end if;
  select * into r from public.client_connections where id = p_id for update;
  if not found or r.status <> 'pending' or app.jwt_email() is null or r.email <> app.jwt_email() then
    raise exception 'This request is no longer open' using errcode = '22023';
  end if;
  if not p_accept then
    update public.client_connections set status = 'declined', responded_by = v_uid, responded_at = now() where id = r.id;
    return jsonb_build_object('accepted', false);
  end if;

  select * into c from public.contractors where id = r.contractor_id for update;
  if c.linked_user_id is not null and c.linked_user_id <> v_uid then
    raise exception 'This client is already connected to another account' using errcode = '22023';
  end if;
  select name into v_other from public.contractors
  where workspace_id = c.workspace_id and linked_user_id = v_uid and id <> c.id limit 1;
  if v_other is not null then
    raise exception 'You are already connected in this workspace as %. Ask them to merge the two client records.', v_other using errcode = '22023';
  end if;

  update public.contractors set linked_user_id = v_uid where id = c.id;
  for p in select id from public.ledger_participants where contractor_id = c.id and user_id is null loop
    if app.join_as_participant(p.id, v_uid, r.requested_by) then
      v_joined := v_joined + 1;
    end if;
  end loop;
  update public.client_connections set status = 'accepted', responded_by = v_uid, responded_at = now() where id = r.id;
  -- Any other open request for the same client is settled by this one.
  update public.client_connections set status = 'cancelled', responded_at = now()
  where contractor_id = c.id and status = 'pending';
  return jsonb_build_object('accepted', true, 'shared_accounts', v_joined);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Merging two client records keeps the account link and the shared-account places
-- ---------------------------------------------------------------------------------------------
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
  if v_from.linked_user_id is not null and v_into.linked_user_id is not null and v_from.linked_user_id <> v_into.linked_user_id then
    raise exception 'Both are connected to different Lekha accounts. Disconnect one first.' using errcode = '22023';
  end if;
  update public.ledgers set contractor_id = p_into where contractor_id = p_from;
  update public.advances set contractor_id = p_into where contractor_id = p_from;
  update public.expenses set contractor_id = p_into where contractor_id = p_from;
  -- Shared-account places move too, except where both already sit in the same account.
  update public.ledger_participants lp set contractor_id = p_into, display_name = v_into.name
  where lp.contractor_id = p_from
    and not exists (select 1 from public.ledger_participants o where o.ledger_id = lp.ledger_id and o.contractor_id = p_into);
  update public.client_connections set status = 'cancelled', responded_at = now() where contractor_id = p_from and status = 'pending';
  update public.contractors set is_active = false, merged_into = p_into, linked_user_id = null where id = p_from;
  if v_into.linked_user_id is null and v_from.linked_user_id is not null then
    update public.contractors set linked_user_id = v_from.linked_user_id where id = p_into;
  end if;
end $$;

revoke all on function app.jwt_email() from public, anon;
grant execute on function app.jwt_email() to authenticated;
revoke all on function app.join_as_participant(uuid, text, text) from public, anon, authenticated;
revoke all on function app.add_client_participant(public.ledgers, uuid, integer) from public, anon, authenticated;
revoke all on function
  public.request_client_connection(uuid, text),
  public.cancel_client_connection(uuid),
  public.disconnect_client(uuid),
  public.my_connection_requests(),
  public.respond_client_connection(uuid, boolean)
from public, anon;
grant execute on function
  public.request_client_connection(uuid, text),
  public.cancel_client_connection(uuid),
  public.disconnect_client(uuid),
  public.my_connection_requests(),
  public.respond_client_connection(uuid, boolean)
to authenticated;
