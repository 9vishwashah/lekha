import type { Direction, Perspective, TxnKind, TxnStatus } from "@/lib/domain/ledger";

export type Role = "owner" | "admin" | "member" | "viewer";
export type LedgerType = "basic" | "taxation" | "personal";
export type PaymentMode = "cash" | "upi" | "bank_transfer" | "cheque" | "card" | "other";

export const PAYMENT_MODES: { value: PaymentMode; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
];

/** What a wallet entry was, when it isn't the money side of an invoice, expense or advance. */
export const NATURES: { value: string; label: string; direction: "in" | "out" | "both" }[] = [
  { value: "direct_income", label: "Direct income (sales, billing)", direction: "in" },
  { value: "income", label: "Indirect income (interest, rent, other)", direction: "in" },
  { value: "direct_expense", label: "Direct expense (labour, material)", direction: "out" },
  { value: "expense", label: "Indirect expense (office, rent, other)", direction: "out" },
  { value: "capital", label: "Capital added", direction: "in" },
  { value: "drawings", label: "Personal drawings", direction: "out" },
  { value: "transfer", label: "Transfer between wallets", direction: "both" },
];

export const paymentModeLabel = (m: string | null | undefined) => PAYMENT_MODES.find((p) => p.value === m)?.label ?? "";

export interface Workspace {
  id: string;
  name: string;
  owner_user_id: string;
  currency: string;
  timezone: string;
  fy_start_month: number;
  default_gst_rate: string;
  default_tds_rate: string;
  default_tds_base: "taxable" | "gross";
  default_gst_mode: "intra" | "inter";
}

export interface Contractor {
  id: string;
  workspace_id: string;
  name: string;
  business_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  is_active: boolean;
  merged_into: string | null;
  kind: "business" | "personal";
  linked_user_id: string | null;
  created_at: string;
}

export interface Ledger {
  id: string;
  workspace_id: string;
  contractor_id: string | null;
  name: string;
  ledger_type: LedgerType;
  perspective: Perspective | "personal";
  reference_no: string | null;
  opening_balance: string;
  opening_balance_date: string | null;
  description: string | null;
  notes: string | null;
  status: "active" | "archived";
  gst_mode: "intra" | "inter";
  color: string;
  owner_user_id: string;
  last_activity_at: string;
  created_at: string;
  is_direct: boolean;
  wallet_kind: "cash" | "bank" | null;
  default_in_nature: string | null;
  default_out_nature: string | null;
}

export interface TaxDetail {
  transaction_id: string;
  invoice_no: string | null;
  invoice_date: string | null;
  taxable_amount: string;
  gst_applicable: boolean;
  gst_type: "intra" | "inter" | "none";
  gst_rate: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  gst_amount: string;
  tds_applicable: boolean;
  tds_section: string | null;
  tds_rate: string;
  tds_base: "taxable" | "gross";
  tds_amount: string;
  gross_amount: string;
  net_amount: string;
  tax_status: "pending" | "paid" | "not_applicable";
  tax_notes: string | null;
}

export interface Txn {
  id: string;
  ledger_id: string;
  wallet_ledger_id: string | null;
  nature: string | null;
  transfer_id: string | null;
  seq: number;
  voucher_no: string;
  txn_date: string;
  direction: Direction;
  amount: string;
  kind: TxnKind;
  is_cash: boolean;
  affects_party: boolean;
  description: string | null;
  counterparty: string | null;
  payment_mode: PaymentMode | null;
  reference_no: string | null;
  notes: string | null;
  status: TxnStatus;
  reversal_of: string | null;
  void_reason: string | null;
  created_by: string;
  created_via: "member" | "collaborator" | "import" | "system";
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  import_batch_id: string | null;
}

export interface Participant {
  id: string;
  ledger_id: string;
  display_name: string;
  user_id: string | null;
  contractor_id: string | null;
  position: number;
}

export interface SharedExpense {
  id: string;
  ledger_id: string;
  txn_date: string;
  description: string;
  total_amount: string;
  split_method: "equal" | "exact" | "percent" | "shares";
  category: string | null;
  payment_mode: PaymentMode | null;
  reference_no: string | null;
  notes: string | null;
  status: "posted" | "void";
  void_reason: string | null;
  replaces_id: string | null;
  split_group_id: string | null;
  created_by: string;
  created_at: string;
  payers: { participant_id: string; amount_paid: string }[];
  shares: { participant_id: string; share_amount: string; share_input: string | null }[];
}

export interface Settlement {
  id: string;
  ledger_id: string;
  from_participant_id: string;
  to_participant_id: string;
  amount: string;
  txn_date: string;
  payment_mode: PaymentMode | null;
  reference_no: string | null;
  notes: string | null;
  status: "posted" | "void";
  void_reason: string | null;
  created_by: string;
  created_at: string;
}

export interface Collaborator {
  id: string;
  ledger_id: string;
  user_id: string;
  participant_id: string | null;
  display_name: string | null;
  email: string | null;
  can_create: boolean;
  can_edit_own: boolean;
  can_edit_all: boolean;
  can_attach: boolean;
  can_view_tax: boolean;
  status: "active" | "revoked";
  created_at: string;
}

export interface Member {
  id: string;
  workspace_id: string;
  user_id: string;
  role: Role;
  display_name: string | null;
  email: string | null;
  created_at: string;
}
