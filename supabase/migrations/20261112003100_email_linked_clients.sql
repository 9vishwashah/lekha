-- Emails to clients who are on Lekha: when no email is typed on their card, the email they signed up
-- with is used (looked up on the server, never shown to the sender). A different address can be
-- typed when sending, and is saved on the card.

drop function if exists public.note_client_reminder(uuid);

create or replace function public.note_client_reminder(p_contractor uuid, p_email text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.contractors;
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
begin
  select * into c from public.contractors where id = p_contractor for update;
  if not found then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;
  perform app.require_write(c.workspace_id);
  if v_email is not null then
    if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(v_email) > 200 then
      raise exception 'Enter a valid email address' using errcode = '22023';
    end if;
    update public.contractors set email = v_email where id = p_contractor;
  elsif c.email is null and c.linked_user_id is null then
    raise exception 'Enter % email address', c.name || '''s' using errcode = '22023';
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
  if p_on and c.email is null and c.linked_user_id is null then
    raise exception 'Add % email address first', c.name || '''s' using errcode = '22023';
  end if;
  update public.contractors set monthly_statement = coalesce(p_on, false) where id = p_contractor;
end $$;

-- Same as before, plus clients who are on Lekha without a typed email (their sign-up email is used).
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
    select c.id, c.name, c.email, c.linked_user_id, c.workspace_id, w.name as workspace, coalesce(s.business_name, w.name) as business,
      (select full_name from public.user_profiles where user_id = w.owner_user_id) as owner_name
    from public.contractors c join public.workspaces w on w.id = c.workspace_id
    left join public.invoice_settings s on s.workspace_id = c.workspace_id
    where c.monthly_statement and (c.email is not null or c.linked_user_id is not null) and c.is_active and c.merged_into is null
  loop
    v_bal := app.client_balance(r.id);
    if v_bal = 0 then continue; end if;
    insert into app.email_log (key) values ('monthly:client:' || r.id::text || ':' || v_month) on conflict do nothing;
    if not found then continue; end if;
    v_clients := v_clients || jsonb_build_object('contractor_id', r.id, 'client_name', r.name, 'client_email', r.email, 'linked_user_id', r.linked_user_id,
      'business', r.business, 'owner_name', r.owner_name, 'balance', v_bal, 'share_cipher', app.client_share_cipher(r.id));
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

revoke all on function public.note_client_reminder(uuid, text) from public, anon;
grant execute on function public.note_client_reminder(uuid, text) to authenticated;
