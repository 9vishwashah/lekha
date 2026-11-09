-- Accounting heads, the way Tally groups ledgers.
--
-- Every rupee in the books already falls under a head: Bank and Cash (wallets), Sundry Debtors and
-- Creditors (people), Duties & Taxes (GST, TDS), Capital. This adds the split profit and loss needs:
--   * Income and expense are Direct (the trade itself: sales, labour, material) or Indirect
--     (everything else: office, rent, interest). Gross profit is direct income less direct
--     expenses; net profit takes the indirect ones as well.
--   * Expense categories carry their head.
--   * A cash or bank ledger can say what its plain money in and out usually count as, so its
--     entries need not each be marked. An entry's own choice still wins, and nothing is assumed:
--     a deposit into Cash in Hand may be capital or a transfer, not income.

alter table public.transactions drop constraint if exists transactions_nature_check;
alter table public.transactions add constraint transactions_nature_check check (nature is null or nature in (
  'direct_income', 'income', 'direct_expense', 'expense', 'capital', 'drawings', 'transfer'));

alter table public.ledgers add column if not exists default_in_nature text;
alter table public.ledgers add column if not exists default_out_nature text;
alter table public.ledgers drop constraint if exists ledgers_default_natures_check;
alter table public.ledgers add constraint ledgers_default_natures_check check (
  (default_in_nature is null or default_in_nature in ('direct_income', 'income', 'capital', 'transfer'))
  and (default_out_nature is null or default_out_nature in ('direct_expense', 'expense', 'drawings', 'transfer'))
  and ((default_in_nature is null and default_out_nature is null) or perspective = 'cashbook'));

alter table public.expense_categories add column if not exists head text not null default 'indirect';
alter table public.expense_categories drop constraint if exists expense_categories_head_check;
alter table public.expense_categories add constraint expense_categories_head_check check (head in ('direct', 'indirect'));

-- The usual direct costs of a trade start as direct; anything can be changed.
update public.expense_categories set head = 'direct'
where lower(btrim(name)) in ('materials', 'material', 'labour', 'labor', 'wages', 'purchases', 'purchase', 'freight', 'raw material');

create or replace function app.default_category_head() returns trigger
language plpgsql set search_path = '' as $$
begin
  if lower(btrim(new.name)) in ('materials', 'material', 'labour', 'labor', 'wages', 'purchases', 'purchase', 'freight', 'raw material') then
    new.head := 'direct';
  end if;
  return new;
end $$;

drop trigger if exists expense_categories_default_head on public.expense_categories;
create trigger expense_categories_default_head before insert on public.expense_categories
  for each row execute function app.default_category_head();

create or replace function public.set_category_head(p_category uuid, p_head text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.expense_categories where id = p_category;
  if v_ws is null then
    raise exception 'Category not found' using errcode = 'P0002';
  end if;
  perform app.require_write(v_ws);
  if p_head not in ('direct', 'indirect') then
    raise exception 'Choose direct or indirect' using errcode = '22023';
  end if;
  update public.expense_categories set head = p_head where id = p_category;
end $$;

-- What a cash or bank ledger's plain money in and out usually count as.
create or replace function public.set_ledger_books(p_ledger uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.ledgers;
begin
  select * into v from public.ledgers where id = p_ledger for update;
  if not found then
    raise exception 'Ledger not found' using errcode = 'P0002';
  end if;
  perform app.require_write(v.workspace_id);
  if v.perspective <> 'cashbook' then
    raise exception 'Only a cash or bank ledger has this. A client ledger''s entries are what that client owes.' using errcode = '22023';
  end if;
  update public.ledgers set
    default_in_nature = case when p ? 'default_in_nature' then nullif(p ->> 'default_in_nature', '') else default_in_nature end,
    default_out_nature = case when p ? 'default_out_nature' then nullif(p ->> 'default_out_nature', '') else default_out_nature end
  where id = p_ledger;
end $$;

revoke all on function public.set_category_head(uuid, text) from public, anon;
revoke all on function public.set_ledger_books(uuid, jsonb) from public, anon;
grant execute on function public.set_category_head(uuid, text) to authenticated;
grant execute on function public.set_ledger_books(uuid, jsonb) to authenticated;
revoke all on function app.default_category_head() from public, anon, authenticated;
