-- Function privileges, Realtime publication and private attachment storage.

-- Functions are executable by PUBLIC by default; revoke, then grant exactly what each role needs.
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;

grant execute on function
  app.uid(), app.member_role(uuid), app.is_member(uuid), app.can_write(uuid), app.is_admin(uuid),
  app.ledger_workspace(uuid), app.collaborator(uuid), app.can_view_ledger(uuid), app.can_view_ledger_tax(uuid)
to authenticated;

grant execute on function
  public.create_workspace(text, text, text),
  public.update_workspace(uuid, jsonb),
  public.set_member_role(uuid, text),
  public.remove_member(uuid),
  public.contractor_tax_ids(uuid),
  public.merge_contractors(uuid, uuid),
  public.create_ledger(jsonb),
  public.update_ledger(uuid, jsonb),
  public.set_ledger_status(uuid, text),
  public.add_ledger_participant(uuid, text),
  public.post_transaction(jsonb),
  public.amend_transaction(uuid, jsonb),
  public.void_transaction(uuid, text),
  public.reverse_transaction(uuid, text, text),
  public.record_tax_settlement(jsonb),
  public.create_expense(jsonb),
  public.update_expense(uuid, jsonb),
  public.void_expense(uuid, text),
  public.create_advance(jsonb),
  public.record_advance_allocation(jsonb),
  public.void_advance_allocation(uuid, text),
  public.void_advance(uuid, text),
  public.create_shared_expense(jsonb),
  public.correct_shared_expense(uuid, jsonb),
  public.void_shared_expense(uuid, text),
  public.record_settlement(jsonb),
  public.void_settlement(uuid, text),
  public.create_share_link(uuid, text, text, jsonb),
  public.update_share_link(uuid, jsonb),
  public.revoke_share_link(uuid),
  public.share_link_secret(uuid),
  public.create_invitation(text, jsonb),
  public.revoke_invitation(uuid),
  public.accept_invitation(text, text, text),
  public.update_collaborator(uuid, jsonb),
  public.revoke_collaborator(uuid),
  public.import_transactions(jsonb)
to authenticated;

-- The only entry points available without signing in.
grant execute on function
  public.get_shared_ledger(text),
  public.get_shared_ledger_version(text),
  public.get_invitation_preview(text)
to anon, authenticated;

-- Realtime: authenticated views subscribe to these tables. Postgres Changes honours the
-- SELECT policies above, so subscribers only receive rows they could already read.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.transactions, public.shared_expenses, public.settlements, public.ledgers;
  end if;
end $$;

-- Private storage bucket for receipts and bills. Objects are stored under
-- "<workspace_id>/<entity_type>/<entity_id>/<file>" and readable only by workspace members.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('attachments', 'attachments', false, 10485760,
      array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

    execute $p$
      create policy attachments_read on storage.objects for select to authenticated
      using (bucket_id = 'attachments' and (select app.is_member(((storage.foldername(name))[1])::uuid)))
    $p$;
    execute $p$
      create policy attachments_write on storage.objects for insert to authenticated
      with check (bucket_id = 'attachments' and (select app.can_write(((storage.foldername(name))[1])::uuid)))
    $p$;
  end if;
end $$;
