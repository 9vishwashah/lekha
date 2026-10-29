-- Personal profile: the name people see and a private mobile number.
-- One row per signed-in user. Only that user can read or change it; the name is copied to the
-- places other people see it (workspace members, ledger collaborators, the owner's place in
-- shared accounts), and the mobile number is never shared.

create table if not exists public.user_profiles (
  user_id text primary key,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 120),
  phone text check (phone is null or phone ~ '^\+?[0-9]{10,15}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;
revoke all on public.user_profiles from anon, authenticated;
grant select on public.user_profiles to authenticated;

drop policy if exists profiles_select_own on public.user_profiles;
create policy profiles_select_own on public.user_profiles for select to authenticated
  using (user_id = (select app.uid()));

drop trigger if exists user_profiles_touch_updated_at on public.user_profiles;
create trigger user_profiles_touch_updated_at before update on public.user_profiles
  for each row execute function app.touch_updated_at();

-- Saves the caller's profile and updates the name everywhere others see it.
create or replace function public.save_my_profile(p_full_name text, p_phone text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid text := app.uid();
  v_name text := app.clean_text(p_full_name, 120);
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[\s()-]', '', 'g'), '');
begin
  if v_uid is null then
    raise exception 'Sign in to continue' using errcode = '42501';
  end if;
  if v_name is null then
    raise exception 'Enter your name' using errcode = '22023';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9]{10,15}$' then
    raise exception 'Enter a valid mobile number' using errcode = '22023';
  end if;

  insert into public.user_profiles (user_id, full_name, phone)
  values (v_uid, v_name, v_phone)
  on conflict (user_id) do update set full_name = excluded.full_name, phone = excluded.phone;

  update public.workspace_members set display_name = v_name where user_id = v_uid;
  update public.ledger_collaborators set display_name = v_name where user_id = v_uid;
  -- The owner's own place in their shared accounts (other people's places come from client records).
  update public.ledger_participants lp set display_name = left(v_name, 60)
  where lp.user_id = v_uid and lp.contractor_id is null
    and not exists (
      select 1 from public.ledger_participants o
      where o.ledger_id = lp.ledger_id and o.id <> lp.id and lower(o.display_name) = lower(left(v_name, 60)));
end $$;

revoke all on function public.save_my_profile(text, text) from public, anon;
grant execute on function public.save_my_profile(text, text) to authenticated;
