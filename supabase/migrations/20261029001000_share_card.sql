-- Who sent a share link and how its ledger looks, for the link page and its WhatsApp / social
-- preview card. Only the sharer's name, their business name and the ledger colour leave the
-- database: never ids, email or the mobile number.
create or replace function public.get_share_card(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'color', l.color,
    'shared_by', coalesce(up.full_name, wm.display_name),
    'business', w.name)
  from public.share_links s
  join public.ledgers l on l.id = s.ledger_id
  join public.workspaces w on w.id = s.workspace_id
  left join public.user_profiles up on up.user_id = s.created_by
  left join public.workspace_members wm on wm.workspace_id = s.workspace_id and wm.user_id = s.created_by
  where p_token ~ '^[A-Za-z0-9_-]{32,128}$'
    and s.token_hash = app.token_hash(p_token) and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now())
$$;

revoke all on function public.get_share_card(text) from public;
grant execute on function public.get_share_card(text) to anon, authenticated;
