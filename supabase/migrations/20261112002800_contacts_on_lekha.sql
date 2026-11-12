-- Finding people you know on Lekha by phone number.
--
--  * public.client_lekha_matches(workspace): your clients who are not linked yet but whose phone
--    number belongs to someone on Lekha. The client page offers a one-tap "Link". Linking stays a
--    choice you make (you see their name and @username first), never automatic: the phone number
--    on a Lekha profile is typed by its owner, not verified, so it alone must not open your books.
--  * public.phones_on_lekha(phones): for contacts you pick on your phone, which ones are on Lekha
--    (yes / no only, no names), so the rest can get an "Invite on Lekha" button.

create or replace function app.phone_key(p text) returns text
language sql immutable set search_path = '' as $$
  select case when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) >= 10
    then right(regexp_replace(p, '\D', '', 'g'), 10) end
$$;

create index if not exists user_profiles_phone_key_idx on public.user_profiles (app.phone_key(phone)) where phone is not null;

create or replace function public.client_lekha_matches(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_write(p_workspace);
  return coalesce((
    select jsonb_agg(jsonb_build_object('contractor_id', m.contractor_id, 'username', m.username, 'full_name', m.full_name, 'avatar_path', m.avatar_path))
    from (
      select c.id as contractor_id, min(u.username) as username, min(u.full_name) as full_name, min(u.avatar_path) as avatar_path
      from public.contractors c
      join public.user_profiles u on app.phone_key(u.phone) = app.phone_key(c.phone)
      where c.workspace_id = p_workspace and c.linked_user_id is null and c.is_active and c.merged_into is null
        and app.phone_key(c.phone) is not null and u.username is not null and u.user_id <> app.uid()
        and not exists (select 1 from public.contractors o where o.workspace_id = p_workspace and o.linked_user_id = u.user_id)
      group by c.id
      -- Two Lekha accounts with the same number: ambiguous, so suggest nothing.
      having count(distinct u.user_id) = 1
    ) m
  ), '[]'::jsonb);
end $$;

create or replace function public.phones_on_lekha(p_phones text[]) returns text[]
language plpgsql stable security definer set search_path = '' as $$
begin
  if app.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if coalesce(array_length(p_phones, 1), 0) > 100 then
    raise exception 'Check up to 100 contacts at a time' using errcode = '22023';
  end if;
  return coalesce((
    select array_agg(distinct app.phone_key(x))
    from unnest(p_phones) x
    where app.phone_key(x) is not null
      and exists (select 1 from public.user_profiles u where app.phone_key(u.phone) = app.phone_key(x) and u.username is not null and u.user_id <> app.uid())
  ), '{}');
end $$;

revoke all on function app.phone_key(text) from public, anon;
grant execute on function app.phone_key(text) to authenticated;
revoke all on function public.client_lekha_matches(uuid), public.phones_on_lekha(text[]) from public, anon;
grant execute on function public.client_lekha_matches(uuid), public.phones_on_lekha(text[]) to authenticated;
