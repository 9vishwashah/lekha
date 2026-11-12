-- Email (sent through Resend by the app server).
--
-- Interactive emails (a payment reminder to a client, an invoice by email) are sent from the
-- signed-in user's session. Scheduled emails (the daily "new activity" digest and the monthly
-- statements) are sent by a scheduled job that has no user session and no service-role key, so it
-- calls two functions guarded by a shared secret instead:
--   select app.set_cron_secret('<the same value as CRON_SECRET on Vercel>');   -- run once
-- Each scheduled email is recorded so it is never sent twice.

alter table public.contractors
  add column if not exists monthly_statement boolean not null default false,
  add column if not exists last_reminded_at timestamptz;
alter table public.user_profiles
  add column if not exists email_new_activity boolean not null default true,
  add column if not exists email_monthly boolean not null default true;
alter table public.notifications add column if not exists emailed_at timestamptz;
-- Contractor columns are granted one by one (tax ids are kept back), so grant the new ones.
grant select (monthly_statement, last_reminded_at) on public.contractors to authenticated;

create table if not exists app.cron_secrets (name text primary key, hash text not null);
create table if not exists app.email_log (key text primary key, created_at timestamptz not null default now());
revoke all on app.cron_secrets, app.email_log from public, anon, authenticated;

create or replace function app.set_cron_secret(p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_secret is null or length(p_secret) < 24 then
    raise exception 'Use a long random secret (24+ characters)';
  end if;
  insert into app.cron_secrets (name, hash) values ('email', app.token_hash(p_secret))
  on conflict (name) do update set hash = excluded.hash;
end $$;
revoke all on function app.set_cron_secret(text) from public, anon, authenticated;

create or replace function app.check_cron(p_secret text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_secret is null or not exists (select 1 from app.cron_secrets where name = 'email' and hash = app.token_hash(p_secret)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- What a client owes the business (positive) or is owed (negative), the way Books counts it:
-- party ledgers + invoices not on a ledger + advances still out + one-to-one accounts.
-- ---------------------------------------------------------------------------------------------
create or replace function app.client_balance(p_contractor uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  with c as (select id, workspace_id from public.contractors where id = p_contractor),
  party as (
    select coalesce(sum(l.opening_balance), 0) + coalesce(sum((
      select coalesce(sum(case when t.direction = 'out' then t.amount else -t.amount end), 0)
      from public.transactions t where t.ledger_id = l.id and t.status = 'posted' and t.affects_party)), 0) as v
    from public.ledgers l, c
    where l.workspace_id = c.workspace_id and l.contractor_id = c.id and l.perspective = 'party' and l.status = 'active'
  ),
  inv as (
    select coalesce(sum(i.grand_total - i.amount_received), 0) as v
    from public.invoices i, c
    where i.workspace_id = c.workspace_id and i.contractor_id = c.id and i.status = 'issued' and i.invoice_type <> 'proforma'
      and not exists (select 1 from public.transactions t join public.ledgers l on l.id = t.ledger_id
                      where t.id = i.transaction_id and l.perspective = 'party')
  ),
  adv as (
    select coalesce(sum(a.amount - coalesce((select sum(x.amount) from public.advance_allocations x where x.advance_id = a.id and x.status = 'active'), 0)), 0) as v
    from public.advances a, c
    where a.workspace_id = c.workspace_id and a.contractor_id = c.id and a.status = 'active'
      and not exists (select 1 from public.ledgers l where l.id = a.ledger_id and l.perspective = 'party')
  ),
  shared as (
    -- Two-person accounts: what the client's side is short is what they owe the owner.
    select coalesce(sum(-(
      coalesce((select sum(py.amount_paid) from public.shared_expense_payers py join public.shared_expenses e on e.id = py.shared_expense_id where py.participant_id = p.id and e.status = 'posted'), 0)
      - coalesce((select sum(sh.share_amount) from public.shared_expense_shares sh join public.shared_expenses e on e.id = sh.shared_expense_id where sh.participant_id = p.id and e.status = 'posted'), 0)
      + coalesce((select sum(s.amount) from public.settlements s where s.from_participant_id = p.id and s.status = 'posted'), 0)
      - coalesce((select sum(s.amount) from public.settlements s where s.to_participant_id = p.id and s.status = 'posted'), 0)
    )), 0) as v
    from public.ledger_participants p join public.ledgers l on l.id = p.ledger_id, c
    where l.workspace_id = c.workspace_id and p.contractor_id = c.id and l.ledger_type = 'personal' and l.status = 'active'
      and (select count(*) from public.ledger_participants q where q.ledger_id = l.id) = 2
  )
  select (select v from party) + (select v from inv) + (select v from adv) + (select v from shared)
$$;

-- The client's statement link (one-to-one account first, then a party ledger), still encrypted.
create or replace function app.client_share_cipher(p_contractor uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.token_ciphertext
  from public.share_links s join public.ledgers l on l.id = s.ledger_id
  where s.revoked_at is null and (s.expires_at is null or s.expires_at > now()) and s.token_ciphertext is not null
    and (l.contractor_id = p_contractor or exists (select 1 from public.ledger_participants p where p.ledger_id = l.id and p.contractor_id = p_contractor))
  order by l.is_direct desc, s.created_at desc
  limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Used from the signed-in user's session
-- ---------------------------------------------------------------------------------------------
create or replace function public.client_balance(p_contractor uuid) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.contractors where id = p_contractor;
  if v_ws is null then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;
  perform app.require_write(v_ws);
  return app.client_balance(p_contractor);
end $$;

-- A payment reminder: at most one per client every 12 hours, so a client is never spammed.
create or replace function public.note_client_reminder(p_contractor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.contractors;
begin
  select * into c from public.contractors where id = p_contractor for update;
  if not found then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;
  perform app.require_write(c.workspace_id);
  if c.email is null then
    raise exception 'Add % email address first', c.name || '''s' using errcode = '22023';
  end if;
  if c.last_reminded_at > now() - interval '12 hours' then
    raise exception 'A reminder was sent % ago. Try again later.', to_char(now() - c.last_reminded_at, 'HH24"h"MI"m"') using errcode = '22023';
  end if;
  update public.contractors set last_reminded_at = now() where id = p_contractor;
end $$;

create or replace function public.set_client_monthly_statement(p_contractor uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.contractors;
begin
  select * into c from public.contractors where id = p_contractor for update;
  if not found then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;
  perform app.require_write(c.workspace_id);
  if p_on and c.email is null then
    raise exception 'Add % email address first', c.name || '''s' using errcode = '22023';
  end if;
  update public.contractors set monthly_statement = coalesce(p_on, false) where id = p_contractor;
end $$;

create or replace function public.set_my_email_prefs(p_new_activity boolean, p_monthly boolean) returns void
language sql security definer set search_path = '' as $$
  update public.user_profiles set email_new_activity = coalesce(p_new_activity, email_new_activity), email_monthly = coalesce(p_monthly, email_monthly)
  where user_id = app.uid()
$$;

-- ---------------------------------------------------------------------------------------------
-- Used by the scheduled job (secret-guarded)
-- ---------------------------------------------------------------------------------------------
-- Unread activity people asked to get by email, grouped per person; marked so it goes out once.
create or replace function public.email_digest_claim(p_secret text, p_limit integer default 300) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v jsonb;
begin
  perform app.check_cron(p_secret);
  with picked as (
    select n.* from public.notifications n join public.user_profiles u on u.user_id = n.user_id
    where n.emailed_at is null and n.read_at is null and u.email_new_activity
      and n.kind in ('entry', 'expense', 'payment', 'confirmed', 'invoice_claim', 'joined')
      and n.created_at > now() - interval '3 days'
    order by n.created_at
    limit greatest(1, least(p_limit, 1000))
    for update of n skip locked
  ), marked as (
    update public.notifications n set emailed_at = now() from picked where n.id = picked.id returning n.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'name', (select full_name from public.user_profiles where user_id = g.user_id), 'items', items)), '[]'::jsonb)
  into v
  from (
    select user_id, jsonb_agg(jsonb_build_object('kind', kind, 'actor_name', actor_name, 'subject', subject, 'amount', amount, 'direction', direction,
      'detail', detail, 'href', href, 'created_at', created_at) order by created_at) as items
    from marked group by user_id
  ) g;
  return v;
end $$;

-- Monthly statements to clients who opted in, and a monthly summary to each workspace's owner.
create or replace function public.email_monthly_claim(p_secret text, p_month date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_month text := to_char(date_trunc('month', p_month), 'YYYY-MM');
  v_clients jsonb := '[]'::jsonb;
  v_owners jsonb := '[]'::jsonb;
  r record;
  v_bal numeric;
begin
  perform app.check_cron(p_secret);
  for r in
    select c.id, c.name, c.email, c.workspace_id, w.name as workspace, coalesce(s.business_name, w.name) as business,
      (select full_name from public.user_profiles where user_id = w.owner_user_id) as owner_name
    from public.contractors c join public.workspaces w on w.id = c.workspace_id
    left join public.invoice_settings s on s.workspace_id = c.workspace_id
    where c.monthly_statement and c.email is not null and c.is_active and c.merged_into is null
  loop
    v_bal := app.client_balance(r.id);
    if v_bal = 0 then continue; end if;
    insert into app.email_log (key) values ('monthly:client:' || r.id::text || ':' || v_month) on conflict do nothing;
    if not found then continue; end if;
    v_clients := v_clients || jsonb_build_object('contractor_id', r.id, 'client_name', r.name, 'client_email', r.email, 'business', r.business,
      'owner_name', r.owner_name, 'balance', v_bal, 'share_cipher', app.client_share_cipher(r.id));
  end loop;

  for r in
    select w.id, w.name, w.owner_user_id from public.workspaces w join public.user_profiles u on u.user_id = w.owner_user_id where u.email_monthly
  loop
    insert into app.email_log (key) values ('monthly:owner:' || r.id::text || ':' || v_month) on conflict do nothing;
    if not found then continue; end if;
    v_owners := v_owners || (
      select jsonb_build_object('user_id', r.owner_user_id, 'workspace', r.name, 'name', (select full_name from public.user_profiles where user_id = r.owner_user_id),
        'owed_to_you', coalesce(sum(b) filter (where b > 0), 0), 'you_owe', coalesce(-sum(b) filter (where b < 0), 0),
        'top', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'balance', b) order by abs(b) desc) from (
           select name, b from (select c2.name, app.client_balance(c2.id) b from public.contractors c2 where c2.workspace_id = r.id and c2.is_active and c2.merged_into is null) z
           where b <> 0 order by abs(b) desc limit 6) t), '[]'::jsonb))
      from (select app.client_balance(c3.id) b from public.contractors c3 where c3.workspace_id = r.id and c3.is_active and c3.merged_into is null) x
    );
  end loop;
  return jsonb_build_object('month', v_month, 'clients', v_clients, 'owners', v_owners);
end $$;

revoke all on function app.check_cron(text), app.client_balance(uuid), app.client_share_cipher(uuid) from public, anon, authenticated;
revoke all on function public.client_balance(uuid), public.note_client_reminder(uuid), public.set_client_monthly_statement(uuid, boolean),
  public.set_my_email_prefs(boolean, boolean) from public, anon;
grant execute on function public.client_balance(uuid), public.note_client_reminder(uuid), public.set_client_monthly_statement(uuid, boolean),
  public.set_my_email_prefs(boolean, boolean) to authenticated;
-- The scheduled job uses the public (anon) key; the secret is the guard.
revoke all on function public.email_digest_claim(text, integer), public.email_monthly_claim(text, date) from public;
grant execute on function public.email_digest_claim(text, integer), public.email_monthly_claim(text, date) to anon, authenticated;
