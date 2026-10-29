-- Lekha core schema.
-- Every business table carries workspace_id. Child tables reference their parent through a
-- composite (id, workspace_id) foreign key so a row can never point at another tenant's parent.
-- Money is NUMERIC(14,2), always positive, with an explicit direction.

create schema if not exists app;

-- ---------------------------------------------------------------------------------------------
-- Workspaces and membership
-- ---------------------------------------------------------------------------------------------
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  owner_user_id text not null,
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  locale text not null default 'en-IN',
  timezone text not null default 'Asia/Kolkata',
  fy_start_month smallint not null default 4 check (fy_start_month between 1 and 12),
  default_gst_rate numeric(6,3) not null default 18 check (default_gst_rate between 0 and 50),
  default_tds_rate numeric(6,3) not null default 1 check (default_tds_rate between 0 and 40),
  default_tds_base text not null default 'taxable' check (default_tds_base in ('taxable', 'gross')),
  default_gst_mode text not null default 'intra' check (default_gst_mode in ('intra', 'inter')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id text not null,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  display_name text,
  email text,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

-- ---------------------------------------------------------------------------------------------
-- Contractors / parties
-- ---------------------------------------------------------------------------------------------
create table public.contractors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  business_name text,
  phone text check (phone is null or phone ~ '^[0-9+() -]{6,20}$'),
  email text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address text,
  gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  pan text check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  notes text,
  is_active boolean not null default true,
  merged_into uuid references public.contractors (id),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create index contractors_ws_idx on public.contractors (workspace_id, is_active, name);

-- ---------------------------------------------------------------------------------------------
-- Ledgers
-- perspective:
--   cashbook  balance = opening + cash in - cash out                (Basic / Taxation default)
--   party     balance = opening + out - in   (positive => party owes you)
--   personal  balances come from shared expenses and settlements, never from cash totals
-- ---------------------------------------------------------------------------------------------
create table public.ledgers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  contractor_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  ledger_type text not null check (ledger_type in ('basic', 'taxation', 'personal')),
  perspective text not null check (perspective in ('cashbook', 'party', 'personal')),
  reference_no text,
  opening_balance numeric(14,2) not null default 0,
  opening_balance_date date,
  description text,
  notes text,
  status text not null default 'active' check (status in ('active', 'archived')),
  gst_mode text not null default 'intra' check (gst_mode in ('intra', 'inter')),
  color text not null default 'mustard',
  owner_user_id text not null,
  next_seq integer not null default 1 check (next_seq > 0),
  voucher_prefix text not null default 'TX' check (voucher_prefix ~ '^[A-Z0-9]{1,6}$'),
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (contractor_id, workspace_id) references public.contractors (id, workspace_id),
  check ((ledger_type = 'personal') = (perspective = 'personal')),
  check (ledger_type <> 'personal' or opening_balance = 0)
);
create index ledgers_ws_idx on public.ledgers (workspace_id, status, ledger_type);
create index ledgers_contractor_idx on public.ledgers (contractor_id);

-- ---------------------------------------------------------------------------------------------
-- Import batches (traceability for spreadsheet imports)
-- ---------------------------------------------------------------------------------------------
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  ledger_id uuid not null,
  file_name text not null,
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  sheet_name text not null,
  imported_count integer not null default 0,
  skipped_count integer not null default 0,
  issues jsonb not null default '[]'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (ledger_id, file_hash, sheet_name),
  unique (id, workspace_id),
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id)
);

-- ---------------------------------------------------------------------------------------------
-- Transactions: the single source of truth for every ledger movement
-- ---------------------------------------------------------------------------------------------
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  ledger_id uuid not null,
  seq integer not null check (seq > 0),
  voucher_no text not null,
  txn_date date not null,
  direction text not null check (direction in ('in', 'out')),
  amount numeric(14,2) not null check (amount > 0),
  kind text not null default 'regular' check (kind in (
    'regular', 'invoice', 'tax_settlement', 'advance_given', 'advance_recovery', 'expense', 'reversal'
  )),
  is_cash boolean not null,
  affects_party boolean not null,
  description text check (description is null or char_length(description) <= 500),
  counterparty text check (counterparty is null or char_length(counterparty) <= 160),
  payment_mode text check (payment_mode is null or payment_mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
  reference_no text check (reference_no is null or char_length(reference_no) <= 80),
  notes text,
  status text not null default 'posted' check (status in ('draft', 'posted', 'void')),
  reversal_of uuid references public.transactions (id),
  void_reason text,
  voided_at timestamptz,
  voided_by text,
  import_batch_id uuid,
  import_row integer,
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 120),
  created_by text not null,
  created_via text not null default 'member' check (created_via in ('member', 'collaborator', 'import', 'system')),
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ledger_id, seq),
  unique (workspace_id, idempotency_key),
  unique (id, workspace_id),
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id),
  foreign key (import_batch_id, workspace_id) references public.import_batches (id, workspace_id),
  check ((status = 'void') = (voided_at is not null)),
  check ((kind = 'reversal') = (reversal_of is not null))
);
create index transactions_ledger_order_idx on public.transactions (ledger_id, txn_date, seq);
create index transactions_ws_date_idx on public.transactions (workspace_id, txn_date);
create index transactions_ws_status_idx on public.transactions (workspace_id, status);
create unique index transactions_one_reversal_idx on public.transactions (reversal_of)
  where reversal_of is not null and status <> 'void';

-- Tax breakdown attached to a transaction (Taxation ledgers). Amounts are computed by the
-- database at posting time and the rates used are frozen on the row.
create table public.transaction_tax_details (
  transaction_id uuid primary key,
  workspace_id uuid not null,
  ledger_id uuid not null,
  invoice_no text,
  invoice_date date,
  taxable_amount numeric(14,2) not null check (taxable_amount >= 0),
  gst_applicable boolean not null,
  gst_type text not null check (gst_type in ('intra', 'inter', 'none')),
  gst_rate numeric(6,3) not null default 0 check (gst_rate between 0 and 50),
  cgst_amount numeric(14,2) not null default 0 check (cgst_amount >= 0),
  sgst_amount numeric(14,2) not null default 0 check (sgst_amount >= 0),
  igst_amount numeric(14,2) not null default 0 check (igst_amount >= 0),
  gst_amount numeric(14,2) not null default 0 check (gst_amount >= 0),
  tds_applicable boolean not null,
  tds_section text check (tds_section is null or char_length(tds_section) <= 20),
  tds_rate numeric(6,3) not null default 0 check (tds_rate between 0 and 40),
  tds_base text not null default 'taxable' check (tds_base in ('taxable', 'gross')),
  tds_amount numeric(14,2) not null default 0 check (tds_amount >= 0),
  gross_amount numeric(14,2) not null check (gross_amount >= 0),
  net_amount numeric(14,2) not null check (net_amount >= 0),
  tax_status text not null default 'pending' check (tax_status in ('pending', 'paid', 'not_applicable')),
  tax_notes text,
  foreign key (transaction_id, workspace_id) references public.transactions (id, workspace_id) on delete cascade,
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id),
  check (gst_amount = cgst_amount + sgst_amount + igst_amount),
  check (gross_amount = taxable_amount + gst_amount),
  check (net_amount = gross_amount - tds_amount),
  check (gst_applicable or (gst_amount = 0 and gst_type = 'none')),
  check (tds_applicable or tds_amount = 0),
  check (gst_type <> 'intra' or igst_amount = 0),
  check (gst_type <> 'inter' or (cgst_amount = 0 and sgst_amount = 0))
);
create index tax_details_ledger_idx on public.transaction_tax_details (ledger_id);
create index tax_details_invoice_idx on public.transaction_tax_details (workspace_id, invoice_date);

-- Government tax settlements (e.g. "GST paid to Government"). The cash leg is a transaction of
-- kind tax_settlement which never touches a party balance.
create table public.tax_settlements (
  transaction_id uuid primary key,
  workspace_id uuid not null,
  ledger_id uuid not null,
  tax_type text not null check (tax_type in ('gst', 'tds', 'other')),
  account_mapping text not null check (account_mapping in ('gst_payable', 'gst_input_credit', 'tds_payable', 'other')),
  period_month date not null check (extract(day from period_month) = 1),
  challan_no text,
  settlement_status text not null default 'completed' check (settlement_status in ('pending', 'completed')),
  foreign key (transaction_id, workspace_id) references public.transactions (id, workspace_id) on delete cascade,
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id)
);

-- ---------------------------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------------------------
create table public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create unique index expense_categories_name_idx on public.expense_categories (workspace_id, lower(name));

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  category_id uuid not null,
  expense_date date not null,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  amount numeric(14,2) not null check (amount > 0),
  vendor text,
  payment_mode text check (payment_mode is null or payment_mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
  reference_no text,
  contractor_id uuid,
  ledger_id uuid,
  transaction_id uuid unique,
  gst_rate numeric(6,3) check (gst_rate is null or gst_rate between 0 and 50),
  gst_amount numeric(14,2) check (gst_amount is null or gst_amount >= 0),
  notes text,
  status text not null default 'active' check (status in ('active', 'void')),
  void_reason text,
  idempotency_key text,
  created_by text not null,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  foreign key (category_id, workspace_id) references public.expense_categories (id, workspace_id),
  foreign key (contractor_id, workspace_id) references public.contractors (id, workspace_id),
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id),
  foreign key (transaction_id, workspace_id) references public.transactions (id, workspace_id),
  check (transaction_id is null or ledger_id is not null),
  check (gst_amount is null or gst_amount <= amount)
);
create index expenses_ws_date_idx on public.expenses (workspace_id, expense_date);

-- ---------------------------------------------------------------------------------------------
-- Advances and their recovery / adjustment allocations
-- ---------------------------------------------------------------------------------------------
create table public.advances (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  contractor_id uuid not null,
  ledger_id uuid,
  transaction_id uuid unique,
  given_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  payment_mode text check (payment_mode is null or payment_mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
  reference_no text,
  purpose text,
  notes text,
  expected_recovery_date date,
  status text not null default 'active' check (status in ('active', 'void')),
  void_reason text,
  idempotency_key text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, idempotency_key),
  foreign key (contractor_id, workspace_id) references public.contractors (id, workspace_id),
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id),
  foreign key (transaction_id, workspace_id) references public.transactions (id, workspace_id),
  check (transaction_id is null or ledger_id is not null),
  check (expected_recovery_date is null or expected_recovery_date >= given_date)
);
create index advances_ws_idx on public.advances (workspace_id, contractor_id);

create table public.advance_allocations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  advance_id uuid not null,
  kind text not null check (kind in ('recovery', 'adjustment')),
  amount numeric(14,2) not null check (amount > 0),
  alloc_date date not null,
  transaction_id uuid unique,
  bill_transaction_id uuid,
  bill_reference text,
  payment_mode text check (payment_mode is null or payment_mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
  notes text,
  status text not null default 'active' check (status in ('active', 'void')),
  void_reason text,
  idempotency_key text,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  foreign key (advance_id, workspace_id) references public.advances (id, workspace_id),
  foreign key (transaction_id, workspace_id) references public.transactions (id, workspace_id),
  foreign key (bill_transaction_id, workspace_id) references public.transactions (id, workspace_id),
  check (kind = 'recovery' or transaction_id is null)
);
create index advance_allocations_advance_idx on public.advance_allocations (advance_id);

-- ---------------------------------------------------------------------------------------------
-- Personal & shared account ledgers
-- One canonical record per shared expense; every participant's view is derived from it.
-- ---------------------------------------------------------------------------------------------
create table public.ledger_participants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  ledger_id uuid not null,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  user_id text,
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  unique (ledger_id, user_id),
  unique (id, ledger_id),
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id) on delete cascade
);
create unique index ledger_participants_name_idx on public.ledger_participants (ledger_id, lower(display_name));

create table public.shared_expenses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  ledger_id uuid not null,
  txn_date date not null,
  description text not null check (char_length(btrim(description)) between 1 and 200),
  total_amount numeric(14,2) not null check (total_amount > 0),
  split_method text not null check (split_method in ('equal', 'exact', 'percent', 'shares')),
  category text,
  payment_mode text check (payment_mode is null or payment_mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
  reference_no text,
  notes text,
  status text not null default 'posted' check (status in ('posted', 'void')),
  void_reason text,
  replaces_id uuid references public.shared_expenses (id),
  idempotency_key text,
  created_by text not null,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, ledger_id),
  unique (ledger_id, idempotency_key),
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id)
);
create index shared_expenses_ledger_idx on public.shared_expenses (ledger_id, txn_date);

create table public.shared_expense_payers (
  shared_expense_id uuid not null,
  ledger_id uuid not null,
  participant_id uuid not null,
  amount_paid numeric(14,2) not null check (amount_paid > 0),
  primary key (shared_expense_id, participant_id),
  foreign key (shared_expense_id, ledger_id) references public.shared_expenses (id, ledger_id) on delete cascade,
  foreign key (participant_id, ledger_id) references public.ledger_participants (id, ledger_id)
);

create table public.shared_expense_shares (
  shared_expense_id uuid not null,
  ledger_id uuid not null,
  participant_id uuid not null,
  share_amount numeric(14,2) not null check (share_amount >= 0),
  share_input numeric(12,4),
  primary key (shared_expense_id, participant_id),
  foreign key (shared_expense_id, ledger_id) references public.shared_expenses (id, ledger_id) on delete cascade,
  foreign key (participant_id, ledger_id) references public.ledger_participants (id, ledger_id)
);

create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  ledger_id uuid not null,
  from_participant_id uuid not null,
  to_participant_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  txn_date date not null,
  payment_mode text check (payment_mode is null or payment_mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
  reference_no text,
  notes text,
  status text not null default 'posted' check (status in ('posted', 'void')),
  void_reason text,
  idempotency_key text,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (ledger_id, idempotency_key),
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id),
  foreign key (from_participant_id, ledger_id) references public.ledger_participants (id, ledger_id),
  foreign key (to_participant_id, ledger_id) references public.ledger_participants (id, ledger_id),
  check (from_participant_id <> to_participant_id)
);
create index settlements_ledger_idx on public.settlements (ledger_id, txn_date);

-- ---------------------------------------------------------------------------------------------
-- Sharing, invitations and collaborators
-- ---------------------------------------------------------------------------------------------
create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  ledger_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_ciphertext text,
  token_hint text not null,
  show_balance boolean not null default true,
  show_running_balance boolean not null default true,
  show_tax boolean not null default false,
  show_reference boolean not null default false,
  show_counterparty boolean not null default true,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_accessed_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id) on delete cascade
);
create unique index share_links_one_active_idx on public.share_links (ledger_id) where revoked_at is null;

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  scope text not null check (scope in ('workspace', 'ledger')),
  ledger_id uuid,
  participant_id uuid,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  email text,
  role text check (role is null or role in ('admin', 'member', 'viewer')),
  can_create boolean not null default false,
  can_edit_own boolean not null default false,
  can_edit_all boolean not null default false,
  can_attach boolean not null default false,
  can_view_tax boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_by text,
  accepted_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id) on delete cascade,
  check ((scope = 'ledger') = (ledger_id is not null)),
  check (scope = 'ledger' or role is not null)
);

create table public.ledger_collaborators (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  ledger_id uuid not null,
  user_id text not null,
  participant_id uuid,
  display_name text,
  email text,
  can_create boolean not null default false,
  can_edit_own boolean not null default false,
  can_edit_all boolean not null default false,
  can_attach boolean not null default false,
  can_view_tax boolean not null default false,
  status text not null default 'active' check (status in ('active', 'revoked')),
  invited_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (ledger_id, user_id),
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id) on delete cascade,
  foreign key (participant_id, ledger_id) references public.ledger_participants (id, ledger_id)
);
create index ledger_collaborators_user_idx on public.ledger_collaborators (user_id, status);

-- ---------------------------------------------------------------------------------------------
-- Attachments (files live in the private "attachments" storage bucket)
-- ---------------------------------------------------------------------------------------------
create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  ledger_id uuid,
  entity_type text not null check (entity_type in ('transaction', 'expense', 'advance', 'shared_expense')),
  entity_id uuid not null,
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  created_by text not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, workspace_id) references public.ledgers (id, workspace_id)
);
create index attachments_entity_idx on public.attachments (entity_type, entity_id);

-- ---------------------------------------------------------------------------------------------
-- Audit log (append-only; written only by triggers)
-- ---------------------------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  ledger_id uuid,
  entity_type text not null,
  entity_id text not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  actor_user_id text,
  actor_role text not null,
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_ws_idx on public.audit_logs (workspace_id, created_at desc);
create index audit_logs_ledger_idx on public.audit_logs (ledger_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
