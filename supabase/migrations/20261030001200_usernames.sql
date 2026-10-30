-- Usernames and profile photos, and adding people by username.
--
-- Everyone picks a unique @username at setup. To give someone access you type their exact
-- username: if they are on Lekha they are added straight away (to a ledger, a shared account or
-- a workspace). If not, you send an invite link instead: it shows the ledger read-only with a
-- sign-up button, and after signing up they join. Invitees no longer pick "who they are" in a
-- shared account: they are added as themselves.
--
-- Replaces the email-based connect requests from 20261029001100_connections.sql.

-- ---------------------------------------------------------------------------------------------
-- Remove email connect requests
-- ---------------------------------------------------------------------------------------------
drop function if exists public.request_client_connection(uuid, text);
drop function if exists public.cancel_client_connection(uuid);
drop function if exists public.my_connection_requests();
drop function if exists public.respond_client_connection(uuid, boolean);
drop table if exists public.client_connections;
drop function if exists app.jwt_email();

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
    raise exception 'Both are linked to different Lekha accounts. Unlink one first.' using errcode = '22023';
  end if;
  update public.ledgers set contractor_id = p_into where contractor_id = p_from;
  update public.advances set contractor_id = p_into where contractor_id = p_from;
  update public.expenses set contractor_id = p_into where contractor_id = p_from;
  update public.ledger_participants lp set contractor_id = p_into, display_name = v_into.name
  where lp.contractor_id = p_from
    and not exists (select 1 from public.ledger_participants o where o.ledger_id = lp.ledger_id and o.contractor_id = p_into);
  update public.contractors set is_active = false, merged_into = p_into, linked_user_id = null where id = p_from;
  if v_into.linked_user_id is null and v_from.linked_user_id is not null then
    update public.contractors set linked_user_id = v_from.linked_user_id where id = p_into;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Profiles: username and photo
-- ---------------------------------------------------------------------------------------------
alter table public.user_profiles
  add column if not exists username text,
  add column if not exists avatar_path text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_profiles_username_format') then
    alter table public.user_profiles add constraint user_profiles_username_format
      check (username is null or username ~ '^[a-z0-9][a-z0-9_.]{2,19}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_profiles_avatar_own_folder') then
    alter table public.user_profiles add constraint user_profiles_avatar_own_folder
      check (avatar_path is null or (avatar_path like user_id || '/%' and avatar_path !~ '\.\.'));
  end if;
end $$;
create unique index if not exists user_profiles_username_idx on public.user_profiles (username) where username is not null;

create or replace function app.clean_username(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(lower(regexp_replace(btrim(coalesce(p, '')), '^@', '')), '')
$$;

create or replace function public.set_my_username(p_username text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid text := app.uid();
  v_name text := app.clean_username(p_username);
begin
  if v_uid is null then
    raise exception 'Sign in to continue' using errcode = '42501';
  end if;
  if v_name is null or v_name !~ '^[a-z0-9][a-z0-9_.]{2,19}$' then
    raise exception 'Use 3–20 letters, numbers, dots or underscores, starting with a letter or number' using errcode = '22023';
  end if;
  if v_name in ('admin', 'support', 'help', 'lekha', 'settings', 'invite', 'share', 'root', 'system') then
    raise exception '@% is reserved. Try another.', v_name using errcode = '22023';
  end if;
  if exists (select 1 from public.user_profiles where username = v_name and user_id <> v_uid) then
    raise exception '@% is taken. Try another.', v_name using errcode = '23505';
  end if;
  if not exists (select 1 from public.user_profiles where user_id = v_uid) then
    raise exception 'Add your name first' using errcode = '22023';
  end if;
  update public.user_profiles set username = v_name, updated_at = now() where user_id = v_uid;
  return v_name;
end $$;

create or replace function public.username_available(p_username text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.clean_username(p_username) ~ '^[a-z0-9][a-z0-9_.]{2,19}$'
     and not exists (select 1 from public.user_profiles where username = app.clean_username(p_username) and user_id <> coalesce(app.uid(), ''))
$$;

create or replace function public.set_my_avatar(p_path text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid text := app.uid();
begin
  if v_uid is null then
    raise exception 'Sign in to continue' using errcode = '42501';
  end if;
  if p_path is not null and (p_path not like v_uid || '/%' or p_path ~ '\.\.' or length(p_path) > 200) then
    raise exception 'Upload the photo again' using errcode = '22023';
  end if;
  update public.user_profiles set avatar_path = p_path, updated_at = now() where user_id = v_uid;
  if not found then
    raise exception 'Add your name first' using errcode = '22023';
  end if;
end $$;

-- What anyone signed in may know about a person: their username, name and photo. Never the mobile.
create or replace function public.people_profiles(p_ids text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'username', username, 'full_name', full_name, 'avatar_path', avatar_path)), '[]'::jsonb)
  from public.user_profiles
  where app.uid() is not null and user_id = any (p_ids[1:300])
$$;

-- Exact username only. There is no partial matching and no list of users.
create or replace function public.find_by_username(p_username text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('username', username, 'full_name', full_name, 'avatar_path', avatar_path)
  from public.user_profiles
  where app.uid() is not null and username = app.clean_username(p_username)
$$;

create or replace function app.user_by_username(p_username text) returns public.user_profiles
language plpgsql stable security definer set search_path = '' as $$
declare
  u public.user_profiles;
begin
  select * into u from public.user_profiles where username = app.clean_username(p_username);
  if not found then
    raise exception 'No one on Lekha has the username @%', coalesce(app.clean_username(p_username), '') using errcode = 'P0002';
  end if;
  if u.user_id = app.uid() then
    raise exception 'That’s you' using errcode = '22023';
  end if;
  return u;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Putting a person into a shared account as themselves
-- ---------------------------------------------------------------------------------------------
-- Finds (or creates) the client record for this user in the ledger's workspace and gives them a
-- place in the shared account. A client already in the account with the same name and no account
-- of their own is taken to be this person. Returns the participant id.
create or replace function app.add_user_to_shared_account(p_ledger public.ledgers, p_user text, p_by text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  u public.user_profiles;
  v_name text;
  v_client uuid;
  v_place uuid;
begin
  if exists (select 1 from public.ledger_participants where ledger_id = p_ledger.id and user_id = p_user) then
    raise exception 'They are already in this account' using errcode = '22023';
  end if;
  select * into u from public.user_profiles where user_id = p_user;
  v_name := left(coalesce(u.full_name, 'Friend'), 60);

  select id into v_client from public.contractors where workspace_id = p_ledger.workspace_id and linked_user_id = p_user limit 1;
  if v_client is null then
    select lp.contractor_id into v_client
    from public.ledger_participants lp join public.contractors c on c.id = lp.contractor_id
    where lp.ledger_id = p_ledger.id and lp.user_id is null and c.linked_user_id is null and lower(c.name) = lower(v_name)
    limit 1;
    if v_client is not null then
      update public.contractors set linked_user_id = p_user where id = v_client;
    end if;
  end if;
  if v_client is null then
    insert into public.contractors (workspace_id, name, kind, linked_user_id, created_by)
    values (p_ledger.workspace_id, v_name, 'personal', p_user, p_by)
    returning id into v_client;
  end if;

  select id into v_place from public.ledger_participants where ledger_id = p_ledger.id and contractor_id = v_client;
  if v_place is null then
    -- Another person in the account already uses this name: tell them apart by username.
    if exists (select 1 from public.ledger_participants where ledger_id = p_ledger.id and lower(display_name) = lower(v_name)) then
      update public.contractors set name = left(v_name || ' (@' || coalesce(u.username, 'user') || ')', 120) where id = v_client and linked_user_id = p_user;
    end if;
    v_place := app.add_client_participant(p_ledger, v_client,
      (select coalesce(max(position), 0) + 1 from public.ledger_participants where ledger_id = p_ledger.id));
  end if;
  perform app.join_as_participant(v_place, p_user, p_by);
  return v_place;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Add by username
-- ---------------------------------------------------------------------------------------------
create or replace function public.add_to_ledger_by_username(p_ledger uuid, p_username text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.ledgers;
  u public.user_profiles;
begin
  select * into v from public.ledgers where id = p_ledger;
  if not found then
    raise exception 'Ledger not found' using errcode = 'P0002';
  end if;
  perform app.require_write(v.workspace_id);
  u := app.user_by_username(p_username);
  if exists (select 1 from public.workspace_members where workspace_id = v.workspace_id and user_id = u.user_id) then
    raise exception '@% already sees this ledger as a member of the workspace', u.username using errcode = '22023';
  end if;

  if v.ledger_type = 'personal' then
    perform app.lock_ledger(v.id, true);
    perform app.add_user_to_shared_account(v, u.user_id, app.uid());
  else
    if exists (select 1 from public.ledger_collaborators where ledger_id = v.id and user_id = u.user_id and status = 'active') then
      raise exception '@% already has access', u.username using errcode = '22023';
    end if;
    insert into public.ledger_collaborators (
      workspace_id, ledger_id, user_id, display_name, can_create, can_edit_own, can_edit_all, can_attach, can_view_tax, invited_by)
    values (
      v.workspace_id, v.id, u.user_id, u.full_name,
      coalesce((p ->> 'can_create')::boolean, false), coalesce((p ->> 'can_edit_own')::boolean, false),
      coalesce((p ->> 'can_edit_all')::boolean, false), coalesce((p ->> 'can_attach')::boolean, false),
      coalesce((p ->> 'can_view_tax')::boolean, false), app.uid())
    on conflict (ledger_id, user_id) do update set
      status = 'active', revoked_at = null, display_name = excluded.display_name,
      can_create = excluded.can_create, can_edit_own = excluded.can_edit_own, can_edit_all = excluded.can_edit_all,
      can_attach = excluded.can_attach, can_view_tax = excluded.can_view_tax, invited_by = excluded.invited_by;
  end if;
  return jsonb_build_object('username', u.username, 'full_name', u.full_name);
end $$;

create or replace function public.add_member_by_username(p_workspace uuid, p_username text, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u public.user_profiles;
begin
  perform app.require_admin(p_workspace);
  if p_role not in ('admin', 'member', 'viewer') then
    raise exception 'Choose a role' using errcode = '22023';
  end if;
  u := app.user_by_username(p_username);
  if exists (select 1 from public.workspace_members where workspace_id = p_workspace and user_id = u.user_id) then
    raise exception '@% is already a member', u.username using errcode = '22023';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role, display_name)
  values (p_workspace, u.user_id, p_role, u.full_name);
  return jsonb_build_object('username', u.username, 'full_name', u.full_name);
end $$;

-- A client record ↔ that person's own account. Their shared accounts open up for them.
create or replace function public.link_client_by_username(p_contractor uuid, p_username text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.contractors;
  u public.user_profiles;
  v_other text;
  p record;
begin
  select * into c from public.contractors where id = p_contractor for update;
  if not found then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;
  perform app.require_write(c.workspace_id);
  u := app.user_by_username(p_username);
  if c.linked_user_id is not null then
    raise exception '% is already linked to a Lekha account', c.name using errcode = '22023';
  end if;
  select name into v_other from public.contractors where workspace_id = c.workspace_id and linked_user_id = u.user_id and id <> c.id limit 1;
  if v_other is not null then
    raise exception '@% is already linked to your client “%”. Merge the two instead.', u.username, v_other using errcode = '22023';
  end if;
  update public.contractors set linked_user_id = u.user_id where id = c.id;
  for p in select id from public.ledger_participants where contractor_id = c.id and user_id is null loop
    perform app.join_as_participant(p.id, u.user_id, app.uid());
  end loop;
  return jsonb_build_object('username', u.username, 'full_name', u.full_name);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Invite links: for people not on Lekha yet. They join as themselves.
-- ---------------------------------------------------------------------------------------------
create or replace function public.accept_invitation(p_token text, p_display_name text, p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid text := app.uid();
  i public.invitations;
  v public.ledgers;
  v_name text;
begin
  if v_uid is null then
    raise exception 'Sign in to accept this invitation' using errcode = '42501';
  end if;
  perform app.require_token(p_token);
  select * into i from public.invitations where token_hash = app.token_hash(p_token) for update;
  if not found or i.status <> 'pending' or i.expires_at <= now() then
    raise exception 'This invitation is no longer valid. Ask for a new link.' using errcode = '22023';
  end if;
  v_name := coalesce((select full_name from public.user_profiles where user_id = v_uid), app.clean_text(p_display_name, 120));

  if i.scope = 'workspace' then
    if app.is_member(i.workspace_id) then
      raise exception 'You are already a member of this workspace' using errcode = '22023';
    end if;
    insert into public.workspace_members (workspace_id, user_id, role, display_name, email)
    values (i.workspace_id, v_uid, i.role, v_name, app.clean_text(p_email, 200));
  else
    if app.is_member(i.workspace_id) then
      raise exception 'You already have access to this ledger through its workspace' using errcode = '22023';
    end if;
    select * into v from public.ledgers where id = i.ledger_id;
    if v.ledger_type = 'personal' and i.participant_id is null then
      -- Joins the shared account as themselves (a place is made for them if needed).
      if not exists (select 1 from public.ledger_participants where ledger_id = v.id and user_id = v_uid) then
        perform app.lock_ledger(v.id, true);
        perform app.add_user_to_shared_account(v, v_uid, i.created_by);
      end if;
    else
      insert into public.ledger_collaborators (
        workspace_id, ledger_id, user_id, participant_id, display_name, email, can_create, can_edit_own,
        can_edit_all, can_attach, can_view_tax, invited_by)
      values (
        i.workspace_id, i.ledger_id, v_uid, i.participant_id, v_name,
        app.clean_text(p_email, 200), i.can_create, i.can_edit_own, i.can_edit_all, i.can_attach,
        i.can_view_tax, i.created_by)
      on conflict (ledger_id, user_id) do update set
        status = 'active', revoked_at = null, participant_id = coalesce(excluded.participant_id, public.ledger_collaborators.participant_id),
        can_create = excluded.can_create, can_edit_own = excluded.can_edit_own, can_edit_all = excluded.can_edit_all,
        can_attach = excluded.can_attach, can_view_tax = excluded.can_view_tax, invited_by = excluded.invited_by;
      if i.participant_id is not null then
        if exists (select 1 from public.ledger_participants where ledger_id = i.ledger_id and user_id = v_uid and id <> i.participant_id) then
          raise exception 'You are already a different person in this ledger' using errcode = '22023';
        end if;
        update public.ledger_participants set user_id = v_uid where id = i.participant_id and user_id is null;
      end if;
    end if;
  end if;

  update public.invitations set status = 'accepted', accepted_by = v_uid, accepted_at = now() where id = i.id;
  return jsonb_build_object('scope', i.scope, 'workspace_id', i.workspace_id, 'ledger_id', i.ledger_id);
end $$;

create or replace function public.get_invitation_preview(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  i public.invitations;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,128}$' then
    return null;
  end if;
  select * into i from public.invitations where token_hash = app.token_hash(p_token);
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'scope', i.scope,
    'status', case when i.status = 'pending' and i.expires_at <= now() then 'expired' else i.status end,
    'ledger_name', (select name from public.ledgers where id = i.ledger_id),
    'ledger_type', (select ledger_type from public.ledgers where id = i.ledger_id),
    'workspace_name', (select name from public.workspaces where id = i.workspace_id),
    'participant_name', (select display_name from public.ledger_participants where id = i.participant_id),
    'invited_by', coalesce(
      (select full_name from public.user_profiles where user_id = i.created_by),
      (select display_name from public.workspace_members where workspace_id = i.workspace_id and user_id = i.created_by)),
    'invited_by_avatar', (select avatar_path from public.user_profiles where user_id = i.created_by),
    'role', i.role,
    'permissions', jsonb_build_object('can_create', i.can_create, 'can_edit_own', i.can_edit_own,
      'can_edit_all', i.can_edit_all, 'can_attach', i.can_attach, 'can_view_tax', i.can_view_tax),
    'expires_at', i.expires_at);
end $$;

-- ---------------------------------------------------------------------------------------------
-- The read-only view behind a share link or an open ledger invitation
-- ---------------------------------------------------------------------------------------------
create or replace function app.public_ledger_payload(
  l public.ledgers, p_balance boolean, p_running boolean, p_tax boolean, p_reference boolean, p_counterparty boolean)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_contractor text;
  v_rows jsonb;
  v_people jsonb;
  v_expenses jsonb;
  v_settlements jsonb;
begin
  select name into v_contractor from public.contractors where id = l.contractor_id;
  if l.ledger_type = 'personal' then
    select coalesce(jsonb_agg(jsonb_build_object('key', p.position, 'name', p.display_name) order by p.position), '[]'::jsonb)
      into v_people from public.ledger_participants p where p.ledger_id = l.id;
    select coalesce(jsonb_agg(jsonb_build_object(
        'date', e.txn_date, 'description', e.description, 'total', e.total_amount, 'method', e.split_method,
        'category', e.category, 'created', e.created_at,
        'payers', (select jsonb_agg(jsonb_build_object('key', p.position, 'amount', py.amount_paid))
                   from public.shared_expense_payers py join public.ledger_participants p on p.id = py.participant_id
                   where py.shared_expense_id = e.id),
        'shares', (select jsonb_agg(jsonb_build_object('key', p.position, 'amount', sh.share_amount))
                   from public.shared_expense_shares sh join public.ledger_participants p on p.id = sh.participant_id
                   where sh.shared_expense_id = e.id))
        order by e.txn_date, e.created_at), '[]'::jsonb)
      into v_expenses from public.shared_expenses e where e.ledger_id = l.id and e.status = 'posted';
    select coalesce(jsonb_agg(jsonb_build_object(
        'date', st.txn_date, 'amount', st.amount, 'created', st.created_at,
        'from', (select position from public.ledger_participants where id = st.from_participant_id),
        'to', (select position from public.ledger_participants where id = st.to_participant_id))
        order by st.txn_date, st.created_at), '[]'::jsonb)
      into v_settlements from public.settlements st where st.ledger_id = l.id and st.status = 'posted';
  else
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'voucher_no', t.voucher_no, 'seq', t.seq, 'date', t.txn_date, 'direction', t.direction,
        'amount', t.amount, 'kind', t.kind, 'is_cash', t.is_cash, 'affects_party', t.affects_party,
        'description', t.description,
        'counterparty', case when p_counterparty then t.counterparty end,
        'reference_no', case when p_reference then t.reference_no end,
        'tax', case when p_tax and d.transaction_id is not null then jsonb_build_object(
          'invoice_no', d.invoice_no, 'taxable_amount', d.taxable_amount, 'gst_type', d.gst_type,
          'gst_rate', d.gst_rate, 'cgst_amount', d.cgst_amount, 'sgst_amount', d.sgst_amount,
          'igst_amount', d.igst_amount, 'gst_amount', d.gst_amount, 'tds_rate', d.tds_rate,
          'tds_base', d.tds_base, 'tds_amount', d.tds_amount, 'gross_amount', d.gross_amount,
          'net_amount', d.net_amount) end))
        order by t.txn_date, t.seq), '[]'::jsonb)
      into v_rows
    from public.transactions t
    left join public.transaction_tax_details d on d.transaction_id = t.id
    where t.ledger_id = l.id and t.status = 'posted';
  end if;

  return jsonb_build_object(
    'ledger', jsonb_build_object(
      'name', l.name, 'ledger_type', l.ledger_type, 'perspective', l.perspective,
      'contractor_name', v_contractor,
      'opening_balance', case when p_balance then l.opening_balance end,
      'opening_balance_date', l.opening_balance_date,
      'last_activity_at', l.last_activity_at),
    'options', jsonb_build_object(
      'show_balance', p_balance, 'show_running_balance', p_running,
      'show_tax', p_tax, 'show_reference', p_reference, 'show_counterparty', p_counterparty),
    'transactions', coalesce(v_rows, '[]'::jsonb),
    'participants', v_people,
    'shared_expenses', v_expenses,
    'settlements', v_settlements);
end $$;

create or replace function public.get_shared_ledger(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.share_links;
  l public.ledgers;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,128}$' then
    return null;
  end if;
  select * into s from public.share_links
  where token_hash = app.token_hash(p_token) and revoked_at is null and (expires_at is null or expires_at > now());
  if not found then
    return null;
  end if;
  select * into l from public.ledgers where id = s.ledger_id;
  if s.last_accessed_at is null or s.last_accessed_at < now() - interval '5 minutes' then
    update public.share_links set last_accessed_at = now() where id = s.id;
  end if;
  return app.public_ledger_payload(l, s.show_balance, s.show_running_balance, s.show_tax, s.show_reference, s.show_counterparty);
end $$;

-- An open ledger invitation shows the ledger read-only (no tax details, no references), so the
-- person knows what they are joining before signing up.
create or replace function public.get_invitation_ledger(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  i public.invitations;
  l public.ledgers;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,128}$' then
    return null;
  end if;
  select * into i from public.invitations
  where token_hash = app.token_hash(p_token) and scope = 'ledger' and status = 'pending' and expires_at > now();
  if not found then
    return null;
  end if;
  select * into l from public.ledgers where id = i.ledger_id;
  return app.public_ledger_payload(l, true, true, false, false, true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Profile photos: public bucket, each person writes only inside their own folder
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
    execute 'drop policy if exists avatars_insert on storage.objects';
    execute 'drop policy if exists avatars_update on storage.objects';
    execute 'drop policy if exists avatars_delete on storage.objects';
    execute $p$
      create policy avatars_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'))
    $p$;
    execute $p$
      create policy avatars_update on storage.objects for update to authenticated
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'))
    $p$;
    execute $p$
      create policy avatars_delete on storage.objects for delete to authenticated
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'))
    $p$;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
revoke all on function app.clean_username(text) from public, anon;
grant execute on function app.clean_username(text) to authenticated;
revoke all on function app.user_by_username(text) from public, anon, authenticated;
revoke all on function app.add_user_to_shared_account(public.ledgers, text, text) from public, anon, authenticated;
revoke all on function app.public_ledger_payload(public.ledgers, boolean, boolean, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function
  public.set_my_username(text), public.username_available(text), public.set_my_avatar(text),
  public.people_profiles(text[]), public.find_by_username(text),
  public.add_to_ledger_by_username(uuid, text, jsonb), public.add_member_by_username(uuid, text, text),
  public.link_client_by_username(uuid, text)
from public, anon;
grant execute on function
  public.set_my_username(text), public.username_available(text), public.set_my_avatar(text),
  public.people_profiles(text[]), public.find_by_username(text),
  public.add_to_ledger_by_username(uuid, text, jsonb), public.add_member_by_username(uuid, text, text),
  public.link_client_by_username(uuid, text)
to authenticated;
grant execute on function public.get_invitation_ledger(text) to anon, authenticated;
grant select (username, avatar_path) on public.user_profiles to authenticated;
