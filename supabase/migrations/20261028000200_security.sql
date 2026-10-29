-- Identity helpers, Row Level Security and explicit grants.
--
-- Identity comes from the Clerk session token (Supabase third-party auth). The Clerk user id is
-- the `sub` claim; it is text, so we never cast it to uuid.
-- Helper functions are SECURITY DEFINER so that policies can consult membership tables without
-- recursive RLS evaluation. Each sets an empty search_path and fully qualifies every object.

create or replace function app.uid() returns text
language sql stable set search_path = '' as $$
  select nullif(auth.jwt() ->> 'sub', '')
$$;

create or replace function app.member_role(p_workspace uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.workspace_members m
  where m.workspace_id = p_workspace and m.user_id = app.uid()
$$;

create or replace function app.is_member(p_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.member_role(p_workspace) is not null
$$;

create or replace function app.can_write(p_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app.member_role(p_workspace) in ('owner', 'admin', 'member'), false)
$$;

create or replace function app.is_admin(p_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app.member_role(p_workspace) in ('owner', 'admin'), false)
$$;

create or replace function app.ledger_workspace(p_ledger uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select l.workspace_id from public.ledgers l where l.id = p_ledger
$$;

-- Returns the caller's active collaborator grant on a ledger as jsonb (null when none).
create or replace function app.collaborator(p_ledger uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'participant_id', c.participant_id,
    'can_create', c.can_create, 'can_edit_own', c.can_edit_own, 'can_edit_all', c.can_edit_all,
    'can_attach', c.can_attach, 'can_view_tax', c.can_view_tax)
  from public.ledger_collaborators c
  where c.ledger_id = p_ledger and c.user_id = app.uid() and c.status = 'active'
$$;

create or replace function app.can_view_ledger(p_ledger uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_member(app.ledger_workspace(p_ledger)) or app.collaborator(p_ledger) is not null
$$;

create or replace function app.can_view_ledger_tax(p_ledger uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_member(app.ledger_workspace(p_ledger))
      or coalesce((app.collaborator(p_ledger) ->> 'can_view_tax')::boolean, false)
$$;

-- Who is acting on this ledger, for audit attribution and permission checks.
create or replace function app.actor_role(p_workspace uuid, p_ledger uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    app.member_role(p_workspace),
    case when p_ledger is not null and app.collaborator(p_ledger) is not null then 'collaborator' end,
    case when app.uid() is null then 'system' else 'unknown' end)
$$;

-- Raises unless the caller may create entries in the ledger. Returns 'member' or 'collaborator'.
create or replace function app.require_ledger_create(p_ledger uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ws uuid := app.ledger_workspace(p_ledger);
  v_collab jsonb;
begin
  if app.uid() is null then
    raise exception 'Sign in to continue' using errcode = '42501';
  end if;
  if v_ws is null then
    raise exception 'Ledger not found' using errcode = 'P0002';
  end if;
  if app.can_write(v_ws) then
    return 'member';
  end if;
  v_collab := app.collaborator(p_ledger);
  if v_collab is not null and (v_collab ->> 'can_create')::boolean then
    return 'collaborator';
  end if;
  raise exception 'You do not have permission to add entries to this ledger' using errcode = '42501';
end $$;

-- Raises unless the caller may edit an entry created by p_created_by in the ledger.
create or replace function app.require_ledger_edit(p_ledger uuid, p_created_by text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ws uuid := app.ledger_workspace(p_ledger);
  v_collab jsonb;
begin
  if app.uid() is null then
    raise exception 'Sign in to continue' using errcode = '42501';
  end if;
  if app.can_write(v_ws) then
    return 'member';
  end if;
  v_collab := app.collaborator(p_ledger);
  if v_collab is not null and (
       (v_collab ->> 'can_edit_all')::boolean
    or ((v_collab ->> 'can_edit_own')::boolean and p_created_by = app.uid())) then
    return 'collaborator';
  end if;
  raise exception 'You do not have permission to change this entry' using errcode = '42501';
end $$;

create or replace function app.require_write(p_workspace uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if app.uid() is null then
    raise exception 'Sign in to continue' using errcode = '42501';
  end if;
  if not app.can_write(p_workspace) then
    raise exception 'You do not have permission to change this workspace' using errcode = '42501';
  end if;
end $$;

create or replace function app.require_admin(p_workspace uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if app.uid() is null then
    raise exception 'Sign in to continue' using errcode = '42501';
  end if;
  if not app.is_admin(p_workspace) then
    raise exception 'Only workspace owners and admins can do this' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Grants: start from nothing. Supabase grants broad default privileges on the public schema,
-- so revoke everything and add back only what the app needs.
-- ---------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;

grant usage on schema app to authenticated, anon;
grant execute on function
  app.uid(), app.member_role(uuid), app.is_member(uuid), app.can_write(uuid), app.is_admin(uuid),
  app.ledger_workspace(uuid), app.collaborator(uuid), app.can_view_ledger(uuid),
  app.can_view_ledger_tax(uuid)
to authenticated;

-- Read access (rows still filtered by RLS below)
grant select on
  public.workspaces, public.workspace_members, public.ledgers, public.transactions,
  public.transaction_tax_details, public.tax_settlements, public.expense_categories, public.expenses,
  public.advances, public.advance_allocations, public.ledger_participants, public.shared_expenses,
  public.shared_expense_payers, public.shared_expense_shares, public.settlements,
  public.invitations, public.ledger_collaborators, public.attachments, public.audit_logs,
  public.import_batches
to authenticated;

-- Share links: never expose the token hash or ciphertext to clients.
grant select (id, workspace_id, ledger_id, token_hint, show_balance, show_running_balance, show_tax,
  show_reference, show_counterparty, expires_at, revoked_at, last_accessed_at, created_by, created_at)
  on public.share_links to authenticated;

-- Contractors: GSTIN and PAN are excluded from the column grant and served by
-- public.contractor_tax_ids() to members who may see them.
grant select (id, workspace_id, name, business_name, phone, email, address, notes, is_active,
  merged_into, created_by, created_at, updated_at)
  on public.contractors to authenticated;
grant insert (workspace_id, name, business_name, phone, email, address, gstin, pan, notes, created_by)
  on public.contractors to authenticated;
grant update (name, business_name, phone, email, address, gstin, pan, notes, is_active, updated_at)
  on public.contractors to authenticated;

grant insert (workspace_id, name) on public.expense_categories to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------------
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.contractors enable row level security;
alter table public.ledgers enable row level security;
alter table public.import_batches enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_tax_details enable row level security;
alter table public.tax_settlements enable row level security;
alter table public.expense_categories enable row level security;
alter table public.expenses enable row level security;
alter table public.advances enable row level security;
alter table public.advance_allocations enable row level security;
alter table public.ledger_participants enable row level security;
alter table public.shared_expenses enable row level security;
alter table public.shared_expense_payers enable row level security;
alter table public.shared_expense_shares enable row level security;
alter table public.settlements enable row level security;
alter table public.share_links enable row level security;
alter table public.invitations enable row level security;
alter table public.ledger_collaborators enable row level security;
alter table public.attachments enable row level security;
alter table public.audit_logs enable row level security;

create policy workspaces_select on public.workspaces for select to authenticated
  using ((select app.is_member(id)));

create policy members_select on public.workspace_members for select to authenticated
  using ((select app.is_member(workspace_id)));

create policy contractors_select on public.contractors for select to authenticated
  using ((select app.is_member(workspace_id)));
create policy contractors_insert on public.contractors for insert to authenticated
  with check ((select app.can_write(workspace_id)) and created_by = (select app.uid()));
create policy contractors_update on public.contractors for update to authenticated
  using ((select app.can_write(workspace_id)))
  with check ((select app.can_write(workspace_id)));

create policy ledgers_select on public.ledgers for select to authenticated
  using ((select app.can_view_ledger(id)));

create policy import_batches_select on public.import_batches for select to authenticated
  using ((select app.is_member(workspace_id)));

create policy transactions_select on public.transactions for select to authenticated
  using ((select app.can_view_ledger(ledger_id)));

create policy tax_details_select on public.transaction_tax_details for select to authenticated
  using ((select app.can_view_ledger_tax(ledger_id)));

create policy tax_settlements_select on public.tax_settlements for select to authenticated
  using ((select app.can_view_ledger_tax(ledger_id)));

create policy categories_select on public.expense_categories for select to authenticated
  using ((select app.is_member(workspace_id)));
create policy categories_insert on public.expense_categories for insert to authenticated
  with check ((select app.can_write(workspace_id)));

create policy expenses_select on public.expenses for select to authenticated
  using ((select app.is_member(workspace_id)));

create policy advances_select on public.advances for select to authenticated
  using ((select app.is_member(workspace_id)));

create policy allocations_select on public.advance_allocations for select to authenticated
  using ((select app.is_member(workspace_id)));

create policy participants_select on public.ledger_participants for select to authenticated
  using ((select app.can_view_ledger(ledger_id)));

create policy shared_expenses_select on public.shared_expenses for select to authenticated
  using ((select app.can_view_ledger(ledger_id)));

create policy payers_select on public.shared_expense_payers for select to authenticated
  using ((select app.can_view_ledger(ledger_id)));

create policy shares_select on public.shared_expense_shares for select to authenticated
  using ((select app.can_view_ledger(ledger_id)));

create policy settlements_select on public.settlements for select to authenticated
  using ((select app.can_view_ledger(ledger_id)));

create policy share_links_select on public.share_links for select to authenticated
  using ((select app.can_write(workspace_id)));

create policy invitations_select on public.invitations for select to authenticated
  using ((select app.can_write(workspace_id)));

create policy collaborators_select on public.ledger_collaborators for select to authenticated
  using ((select app.can_write(workspace_id)) or user_id = (select app.uid()));

create policy attachments_select on public.attachments for select to authenticated
  using ((select app.is_member(workspace_id)));

create policy audit_select on public.audit_logs for select to authenticated
  using ((select app.is_member(workspace_id)));
