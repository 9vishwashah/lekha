-- "This is right": the person a ledger is shared with confirms the statement.
--
-- A confirmation is tied to the exact version of the statement they saw (ledgers.last_activity_at,
-- which moves whenever an entry is added, changed or deleted). When the ledger changes after that,
-- the confirmation no longer counts as current: the viewer sees the button again and the owner sees
-- "changed since confirmed" until they confirm the new version.

create table public.share_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  ledger_id uuid not null,
  share_link_id uuid not null references public.share_links (id) on delete cascade,
  ledger_version timestamptz not null,
  name text check (name is null or char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id) on delete cascade,
  unique (share_link_id, ledger_version)
);
create index share_acknowledgements_ledger_idx on public.share_acknowledgements (ledger_id, created_at desc);

alter table public.share_acknowledgements enable row level security;
-- The owner's side reads them (same people who manage share links); nobody writes directly.
create policy share_acknowledgements_select on public.share_acknowledgements for select to authenticated
  using ((select app.can_write(workspace_id)));
grant select on public.share_acknowledgements to authenticated;

-- The latest confirmation through a link, and whether it is for the statement as it is now.
create or replace function app.share_ack_state(s public.share_links, l public.ledgers) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('at', a.created_at, 'name', a.name, 'current', a.ledger_version = l.last_activity_at)
  from public.share_acknowledgements a
  where a.share_link_id = s.id
  order by a.created_at desc
  limit 1
$$;

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
  return app.public_ledger_payload(l, s.show_balance, s.show_running_balance, s.show_tax, s.show_reference, s.show_counterparty)
    || jsonb_build_object('acknowledgement', app.share_ack_state(s, l));
end $$;

-- Called from the share page. p_version is the version the viewer was looking at: if the ledger
-- changed since, nothing is recorded and they are asked to look at the latest first.
create or replace function public.acknowledge_shared_ledger(p_token text, p_version timestamptz, p_name text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.share_links;
  l public.ledgers;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,128}$' then
    raise exception 'This link is no longer active' using errcode = 'P0002';
  end if;
  select * into s from public.share_links
  where token_hash = app.token_hash(p_token) and revoked_at is null and (expires_at is null or expires_at > now());
  if not found then
    raise exception 'This link is no longer active' using errcode = 'P0002';
  end if;
  select * into l from public.ledgers where id = s.ledger_id;
  if l.ledger_type = 'personal' then
    raise exception 'Shared accounts are not confirmed this way' using errcode = '22023';
  end if;
  if p_version is null or l.last_activity_at <> p_version then
    raise exception 'The statement changed since you opened it. Check the latest entries, then confirm.' using errcode = '40001';
  end if;
  if v_name is not null and char_length(v_name) > 80 then
    v_name := left(v_name, 80);
  end if;
  insert into public.share_acknowledgements (workspace_id, ledger_id, share_link_id, ledger_version, name)
  values (l.workspace_id, l.id, s.id, l.last_activity_at, v_name)
  on conflict (share_link_id, ledger_version) do update set name = coalesce(excluded.name, public.share_acknowledgements.name);
  return app.share_ack_state(s, l);
end $$;

revoke all on function app.share_ack_state(public.share_links, public.ledgers) from public, anon, authenticated;
revoke all on function public.acknowledge_shared_ledger(text, timestamptz, text) from public;
grant execute on function public.acknowledge_shared_ledger(text, timestamptz, text) to anon, authenticated;
grant execute on function public.get_shared_ledger(text) to anon, authenticated;

-- Shows in the ledger's activity log ("Confirmed by …").
create trigger share_acknowledgements_audit after insert or update or delete on public.share_acknowledgements
  for each row execute function app.audit_row();
