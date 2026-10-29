-- Development seed. Run only against a local or throwaway database:
--   supabase db reset            (applies migrations, then this file)
--
-- Rows are owned by a placeholder Clerk user id. After signing in locally, replace it with your
-- own id (Clerk dashboard → Users) so the sample workspace appears for you:
--   update public.workspaces set owner_user_id = 'user_xxx' where owner_user_id = 'user_seed_owner';
--   update public.workspace_members set user_id = 'user_xxx' where user_id = 'user_seed_owner';
-- All writes go through the same functions the app uses, so balances are derived, not typed in.

do $$
declare
  v_ws uuid;
  v_contractor uuid;
  v_basic uuid;
  v_tax uuid;
  v_personal uuid;
  v_me uuid;
  v_friend uuid;
begin
  perform set_config('request.jwt.claims', '{"sub":"user_seed_owner","role":"authenticated"}', true);

  v_ws := public.create_workspace('Saini Constructions (sample)', 'Vishwa', 'owner@example.com');

  insert into public.contractors (workspace_id, name, business_name, phone, created_by)
  values (v_ws, 'Ramesh Saini', 'Saini Civil Works', '9876543210', 'user_seed_owner')
  returning id into v_contractor;

  v_basic := public.create_ledger(jsonb_build_object(
    'workspace_id', v_ws, 'name', 'Ramesh Saini – site work', 'ledger_type', 'basic',
    'contractor_id', v_contractor, 'opening_balance', '25000', 'opening_balance_date', '2026-04-01'));
  perform public.post_transaction(jsonb_build_object('ledger_id', v_basic, 'txn_date', '2026-04-02', 'direction', 'in', 'amount', '50000', 'description', 'Cash from owner'));
  perform public.post_transaction(jsonb_build_object('ledger_id', v_basic, 'txn_date', '2026-04-03', 'direction', 'out', 'amount', '8400', 'description', 'Cement 20 bags', 'counterparty', 'Shree Traders'));
  perform public.post_transaction(jsonb_build_object('ledger_id', v_basic, 'txn_date', '2026-04-05', 'direction', 'out', 'amount', '12500', 'description', 'Labour – week 1', 'payment_mode', 'upi'));

  v_tax := public.create_ledger(jsonb_build_object(
    'workspace_id', v_ws, 'name', 'Rishabh Sales & Creative', 'ledger_type', 'taxation', 'perspective', 'party'));
  perform public.post_transaction(jsonb_build_object('ledger_id', v_tax, 'txn_date', '2026-04-10', 'kind', 'invoice', 'direction', 'out',
    'description', 'Creative campaign', 'tax', jsonb_build_object('taxable_amount', '1000000', 'gst_applicable', true, 'gst_rate', '18',
      'tds_applicable', true, 'tds_rate', '1', 'tds_base', 'taxable', 'invoice_no', 'RS/01')));
  perform public.post_transaction(jsonb_build_object('ledger_id', v_tax, 'txn_date', '2026-04-20', 'direction', 'out', 'amount', '500000', 'description', 'Part payment'));
  perform public.record_tax_settlement(jsonb_build_object('ledger_id', v_tax, 'txn_date', '2026-05-15', 'tax_type', 'gst', 'amount', '180000', 'period_month', '2026-04-01', 'challan_no', 'CH-0001'));

  perform public.create_advance(jsonb_build_object('workspace_id', v_ws, 'contractor_id', v_contractor, 'ledger_id', v_basic,
    'given_date', '2026-04-06', 'amount', '20000', 'purpose', 'Material purchase', 'expected_recovery_date', '2026-05-06'));

  insert into public.contractors (workspace_id, name, kind, phone, created_by)
  values (v_ws, 'Suraj', 'personal', '9123456780', 'user_seed_owner')
  returning id into v_friend;
  v_personal := public.create_ledger(jsonb_build_object('workspace_id', v_ws, 'name', 'Vishwa × Suraj', 'ledger_type', 'personal',
    'owner_name', 'Vishwa', 'participant_client_ids', jsonb_build_array(v_friend)));
  select id into v_me from public.ledger_participants where ledger_id = v_personal and position = 0;
  select id into v_friend from public.ledger_participants where ledger_id = v_personal and position = 1;
  perform public.create_shared_expense(jsonb_build_object('ledger_id', v_personal, 'txn_date', '2026-10-01', 'description', 'Dinner',
    'total_amount', '1000', 'split_method', 'exact',
    'payers', jsonb_build_array(jsonb_build_object('participant_id', v_me, 'amount', '1000')),
    'shares', jsonb_build_array(jsonb_build_object('participant_id', v_me, 'amount', '400'), jsonb_build_object('participant_id', v_friend, 'amount', '600'))));
  perform public.record_settlement(jsonb_build_object('ledger_id', v_personal, 'from_participant_id', v_friend, 'to_participant_id', v_me,
    'amount', '200', 'txn_date', '2026-10-02'));
end $$;
