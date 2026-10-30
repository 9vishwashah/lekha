-- A shared account's owner was sometimes stored as the literal name "You" (when the sign-in account
-- had no first name). "You" only makes sense on the owner's own screen; everyone else, and the public
-- share link, then saw "Vishwa owes You". Store the owner's real name instead. Each screen already
-- shows "You" for whoever is looking.

create or replace function app.real_name_for(p_user text, p_workspace uuid) returns text
language sql stable security definer set search_path = '' as $$
  select left(coalesce(
    (select nullif(btrim(full_name), '') from public.user_profiles where user_id = p_user),
    (select nullif(btrim(display_name), '') from public.workspace_members where user_id = p_user and workspace_id = p_workspace),
    'Owner'), 60)
$$;

-- New places: a placeholder name for someone with an account becomes their real name.
create or replace function app.no_placeholder_names() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  if new.user_id is not null and lower(btrim(coalesce(new.display_name, ''))) in ('', 'you', 'me', 'myself') then
    v_name := app.real_name_for(new.user_id, new.workspace_id);
    if exists (select 1 from public.ledger_participants o
               where o.ledger_id = new.ledger_id and o.id is distinct from new.id and lower(o.display_name) = lower(v_name)) then
      v_name := left(v_name, 52) || ' (owner)';
    end if;
    new.display_name := v_name;
  end if;
  return new;
end $$;

drop trigger if exists ledger_participants_no_placeholder on public.ledger_participants;
create trigger ledger_participants_no_placeholder before insert or update of display_name, user_id on public.ledger_participants
  for each row execute function app.no_placeholder_names();

-- Existing places: rewrite "You" / "Me" for anyone with an account (the trigger fills in the name).
update public.ledger_participants set display_name = display_name
where user_id is not null and lower(btrim(display_name)) in ('you', 'me', 'myself');

revoke all on function app.real_name_for(text, uuid) from public, anon, authenticated;
revoke all on function app.no_placeholder_names() from public, anon, authenticated;
