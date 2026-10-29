-- Append-only audit trail written by triggers, plus updated_at / last_activity bookkeeping.

create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_ws uuid;
  v_ledger uuid;
  v_entity text;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_ignored text[] := array['updated_at', 'last_activity_at', 'next_seq', 'token_hash', 'token_ciphertext'];
  v_masked text[] := array['gstin', 'pan'];
begin
  v_ws := case when tg_table_name = 'workspaces' then (v_row ->> 'id')::uuid else (v_row ->> 'workspace_id')::uuid end;
  v_ledger := case when tg_table_name = 'ledgers' then (v_row ->> 'id')::uuid else (v_row ->> 'ledger_id')::uuid end;
  v_entity := coalesce(v_row ->> 'id', v_row ->> 'transaction_id');

  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_new) loop
      if not (v_key = any (v_ignored)) and (v_new -> v_key) is distinct from (v_old -> v_key) then
        if v_key = any (v_masked) then
          v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('from', '[hidden]', 'to', '[hidden]'));
        else
          v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key));
        end if;
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;
    end if;
  else
    v_changes := coalesce(v_new, v_old) - v_ignored;
    foreach v_key in array v_masked loop
      if v_changes ? v_key and v_changes ->> v_key is not null then
        v_changes := jsonb_set(v_changes, array[v_key], '"[hidden]"'::jsonb);
      end if;
    end loop;
  end if;

  insert into public.audit_logs (workspace_id, ledger_id, entity_type, entity_id, action, actor_user_id, actor_role, changes)
  values (v_ws, v_ledger, tg_table_name, v_entity, lower(tg_op), app.uid(), app.actor_role(v_ws, v_ledger), v_changes);
  return null;
end $$;

-- Ledger "last updated" indicator used by shared pages and live views.
create or replace function app.touch_ledger_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.ledgers set last_activity_at = now()
  where id = coalesce(new.ledger_id, old.ledger_id);
  return null;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'workspaces', 'contractors', 'ledgers', 'transactions', 'expenses', 'advances', 'shared_expenses'
  ] loop
    execute format('create trigger %I before update on public.%I for each row execute function app.touch_updated_at()',
      t || '_touch_updated_at', t);
  end loop;

  foreach t in array array[
    'workspaces', 'workspace_members', 'contractors', 'ledgers', 'transactions', 'transaction_tax_details',
    'tax_settlements', 'expenses', 'advances', 'advance_allocations', 'ledger_participants',
    'shared_expenses', 'settlements', 'share_links', 'invitations', 'ledger_collaborators', 'import_batches',
    'attachments'
  ] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function app.audit_row()',
      t || '_audit', t);
  end loop;

  foreach t in array array['transactions', 'shared_expenses', 'settlements', 'transaction_tax_details'] loop
    execute format('create trigger %I after insert or update on public.%I for each row execute function app.touch_ledger_activity()',
      t || '_ledger_activity', t);
  end loop;
end $$;

-- Audit rows can never be changed or removed through the API, even by their author.
create or replace function app.block_audit_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Audit history is append-only' using errcode = '42501';
end $$;

create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function app.block_audit_mutation();
