import "server-only";
import type { Db } from "@/lib/supabase/server";
import { anonDb } from "@/lib/supabase/server";
import { appUrl } from "@/lib/env";
import { openToken } from "./tokens";
import { type InvoiceCard, cardVersion } from "@/lib/invoices/card";
import { isTokenShape } from "./shared";
import { fetchAll } from "./queries";
import { docFromRecord, type DocRecord, type PaymentSnapshot, type SellerSnapshot } from "@/lib/invoices/doc";

export interface InvoiceSettings extends SellerSnapshot {
  workspace_id: string;
  number_prefix: string;
  proforma_prefix: string;
  number_format: string;
  number_padding: number;
  number_start: number;
  number_reset: "yearly" | "never";
  default_due_days: number;
  default_payment_terms: string | null;
  default_terms: string | null;
  default_notes: string | null;
  default_footer: string | null;
  default_profile_id: string | null;
  show_digital_qr: boolean;
  round_off: boolean;
  allow_payment_claims: boolean;
  show_payment_history: boolean;
  card_color: string | null;
}

export interface PaymentProfile {
  id: string;
  label: string;
  upi_id: string | null;
  upi_payee: string | null;
  upi_number: string | null;
  upi_qr_path: string | null;
  bank_holder: string | null;
  bank_name: string | null;
  bank_branch: string | null;
  bank_account: string | null;
  bank_ifsc: string | null;
  instructions: string | null;
}

export interface LibraryItem {
  id: string;
  kind: "item" | "terms" | "notes" | "footer" | "payment";
  title: string;
  body: string | null;
  unit: string | null;
  rate: string | null;
  tax_rate: string | null;
  hsn: string | null;
}

export interface PaymentConfig {
  profile_id?: string | null;
  upi?: boolean;
  bank?: boolean;
  cash?: boolean;
  cheque?: boolean;
  other?: string | null;
  qr_mode?: "dynamic" | "fixed";
  /** The issuer chose to show no payment details at all. */
  none?: boolean;
}

export type DocumentMode = "lekha" | "uploaded" | "both";

export interface InvoiceRow {
  id: string;
  workspace_id: string;
  invoice_type: string;
  source: "native" | "uploaded";
  document_mode: DocumentMode;
  card_color: string | null;
  client_logo_path: string | null;
  status: "draft" | "issued" | "cancelled";
  invoice_no: string | null;
  title: string | null;
  invoice_date: string;
  due_date: string | null;
  payment_terms: string | null;
  contractor_id: string | null;
  ledger_id: string | null;
  client_name: string | null;
  client_business: string | null;
  client_contact: string | null;
  client_phone: string | null;
  client_email: string | null;
  client_address: string | null;
  client_gstin: string | null;
  client_pan: string | null;
  client_state: string | null;
  client_country: string;
  place_of_supply: string | null;
  gst_enabled: boolean;
  supply_type: string;
  discount_kind: "amount" | "percent";
  discount_value: string;
  charge_label: string | null;
  charge_amount: string;
  round_off: boolean;
  subtotal: string;
  discount_total: string;
  taxable_total: string;
  cgst_total: string;
  sgst_total: string;
  igst_total: string;
  tax_total: string;
  rounding: string;
  grand_total: string;
  amount_received: string;
  notes: string | null;
  terms: string | null;
  footer: string | null;
  template: string | null;
  payment_config: PaymentConfig;
  seller_snapshot: SellerSnapshot | null;
  payment_snapshot: PaymentSnapshot | null;
  show_digital_qr: boolean;
  allow_payment_claims: boolean;
  show_payment_history: boolean;
  transaction_id: string | null;
  issued_at: string | null;
  sent_at: string | null;
  first_viewed_at: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  last_reminder_at: string | null;
  updated_at: string;
  created_at: string;
}

export type InvoiceItemRow = DocRecord["items"][number];

export interface PaymentRow {
  id: string;
  amount: string;
  paid_on: string;
  mode: string | null;
  reference: string | null;
  notes: string | null;
  source: "manual" | "client_claim";
  status: "confirmed" | "reversed";
  transaction_id: string | null;
  reversal_kind: string | null;
  reversal_reason: string | null;
  reversed_at: string | null;
  created_at: string;
}

export interface SubmissionRow {
  id: string;
  amount: string;
  paid_on: string;
  mode: string | null;
  reference: string | null;
  message: string | null;
  proof_path: string | null;
  proof_received: boolean;
  status: "pending" | "confirmed" | "rejected";
  review_note: string | null;
  created_at: string;
}

export interface AttachmentRow {
  id: string;
  role: "original" | "supporting";
  file_name: string;
  mime_type: string;
  size_bytes: number;
  page_count: number | null;
  client_visible: boolean;
  storage_path: string;
  created_at: string;
}

export interface EventRow {
  id: number;
  event: string;
  detail: Record<string, unknown>;
  actor_type: string;
  created_at: string;
}

export const DEFAULT_SETTINGS = (workspaceId: string, name: string): InvoiceSettings => ({
  workspace_id: workspaceId,
  business_name: name,
  brand_color: "#1d1d1b",
  accent_color: "#eac119",
  template: "modern",
  logo_position: "left",
  gst_registered: false,
  number_prefix: "INV",
  proforma_prefix: "PI",
  number_format: "{PREFIX}/{FY}/{SEQ}",
  number_padding: 3,
  number_start: 1,
  number_reset: "yearly",
  default_due_days: 14,
  default_payment_terms: null,
  default_terms: null,
  default_notes: null,
  default_footer: null,
  default_profile_id: null,
  show_digital_qr: true,
  round_off: false,
  allow_payment_claims: true,
  show_payment_history: true,
  card_color: null,
});

export async function getInvoiceSettings(db: Db, workspaceId: string, name: string): Promise<InvoiceSettings> {
  const { data } = await db.from("invoice_settings").select("*").eq("workspace_id", workspaceId).maybeSingle();
  return (data as InvoiceSettings | null) ?? DEFAULT_SETTINGS(workspaceId, name);
}

export async function listPaymentProfiles(db: Db, workspaceId: string): Promise<PaymentProfile[]> {
  const { data } = await db.from("invoice_payment_profiles").select("*").eq("workspace_id", workspaceId).eq("is_archived", false).order("created_at");
  return (data ?? []) as PaymentProfile[];
}

export async function listLibrary(db: Db, workspaceId: string): Promise<LibraryItem[]> {
  const { data } = await db.from("invoice_library").select("id, kind, title, body, unit, rate, tax_rate, hsn").eq("workspace_id", workspaceId).order("title");
  return (data ?? []) as LibraryItem[];
}

const LIST_COLUMNS =
  "id, workspace_id, invoice_type, source, status, invoice_no, title, invoice_date, due_date, contractor_id, ledger_id, client_name, client_business, client_phone, grand_total, amount_received, taxable_total, cgst_total, sgst_total, igst_total, tax_total, transaction_id, sent_at, first_viewed_at, updated_at, created_at";

export type InvoiceListRow = Pick<
  InvoiceRow,
  | "id" | "workspace_id" | "invoice_type" | "source" | "status" | "invoice_no" | "title" | "invoice_date" | "due_date" | "contractor_id" | "ledger_id"
  | "client_name" | "client_business" | "client_phone" | "grand_total" | "amount_received" | "taxable_total" | "cgst_total" | "sgst_total" | "igst_total" | "tax_total" | "transaction_id"
  | "sent_at" | "first_viewed_at" | "updated_at" | "created_at"
>;

export function listInvoices(db: Db, workspaceId: string) {
  return fetchAll<InvoiceListRow>((from, to) =>
    db.from("invoices").select(LIST_COLUMNS).eq("workspace_id", workspaceId).order("invoice_date", { ascending: false }).order("created_at", { ascending: false }).range(from, to),
  );
}

export function listPayments(db: Db, workspaceId: string) {
  return fetchAll<PaymentRow & { invoice_id: string }>((from, to) =>
    db.from("invoice_payments").select("*").eq("workspace_id", workspaceId).order("paid_on").order("created_at").range(from, to),
  );
}

/** Clients' remembered logos. Optional: a missing column must not stop an invoice being written. */
export async function clientLogos(db: Db, workspaceId: string): Promise<Map<string, string>> {
  const { data } = await db.from("contractors").select("id, logo_path").eq("workspace_id", workspaceId).not("logo_path", "is", null);
  return new Map(((data ?? []) as { id: string; logo_path: string }[]).map((c) => [c.id, c.logo_path]));
}

export async function pendingClaims(db: Db, workspaceId: string) {
  const { count } = await db.from("invoice_payment_submissions").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "pending");
  return count ?? 0;
}

export async function getInvoice(db: Db, id: string) {
  const { data } = await db.from("invoices").select("*").eq("id", id).maybeSingle();
  if (!data) return null;
  const [items, payments, submissions, attachments, events, reminders, link] = await Promise.all([
    db.from("invoice_items").select("*").eq("invoice_id", id).order("position"),
    db.from("invoice_payments").select("*").eq("invoice_id", id).order("paid_on").order("created_at"),
    db.from("invoice_payment_submissions").select("*").eq("invoice_id", id).order("created_at", { ascending: false }),
    db.from("invoice_attachments").select("*").eq("invoice_id", id).order("created_at"),
    db.from("invoice_events").select("id, event, detail, actor_type, created_at").eq("invoice_id", id).order("created_at", { ascending: false }).limit(50),
    db.from("invoice_reminders").select("id, stage, outstanding, created_at").eq("invoice_id", id).order("created_at", { ascending: false }),
    db.from("invoice_share_links").select("id, token_hint, expires_at, revoked_at, view_count, last_viewed_at, created_at").eq("invoice_id", id).is("revoked_at", null).maybeSingle(),
  ]);
  return {
    invoice: data as InvoiceRow,
    items: (items.data ?? []) as InvoiceItemRow[],
    payments: (payments.data ?? []) as PaymentRow[],
    submissions: (submissions.data ?? []) as SubmissionRow[],
    attachments: (attachments.data ?? []) as AttachmentRow[],
    events: (events.data ?? []) as EventRow[],
    reminders: (reminders.data ?? []) as { id: string; stage: string; outstanding: string; created_at: string }[],
    link: link.data as { id: string; token_hint: string; expires_at: string | null; view_count: number; last_viewed_at: string | null; created_at: string } | null,
  };
}

export function recordOf(i: InvoiceRow, items: InvoiceItemRow[], seller: SellerSnapshot, payment: PaymentSnapshot): DocRecord {
  return {
    invoice_type: i.invoice_type,
    invoice_no: i.invoice_no,
    title: i.title,
    invoice_date: i.invoice_date,
    due_date: i.due_date,
    payment_terms: i.payment_terms,
    template: i.template,
    client: { name: i.client_name, business: i.client_business, contact: i.client_contact, address: i.client_address, gstin: i.client_gstin, state: i.client_state, country: i.client_country },
    place_of_supply: i.place_of_supply,
    gst_enabled: i.gst_enabled,
    supply_type: i.supply_type,
    items,
    totals: { ...i, charge_label: i.charge_label, charge_amount: i.charge_amount },
    notes: i.notes,
    terms: i.terms,
    footer: i.footer,
    seller,
    payment,
  };
}

/** The live public link for the owner, or null when off, expired or not recoverable. */
export async function invoiceLink(db: Db, id: string): Promise<string | null> {
  const { data } = await db.rpc("invoice_link_secret", { p_invoice: id });
  const token = openToken(data as string | null);
  return token ? invoiceShareUrl(token) : null;
}

/**
 * The one link people are given, for Copy link and WhatsApp alike, so both preview the same. The
 * ?v= changes when the preview's content does, which is what makes WhatsApp fetch it again. The
 * page ignores it, so older links keep opening.
 */
export async function invoiceShareUrl(token: string) {
  const card = await loadInvoiceCard(token);
  return `${appUrl()}/invoice/${token}${card ? `?v=${cardVersion(card)}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Public side. Everything here is reached with a token and the anonymous client.
// ---------------------------------------------------------------------------------------------
export interface PublicInvoice extends Omit<DocRecord, "totals" | "client"> {
  status: string;
  source: string;
  document_mode: DocumentMode;
  card_color: string | null;
  currency: string;
  client: DocRecord["client"];
  totals: DocRecord["totals"] & { balance: string | number; tax_total: string | number };
  show_digital_qr: boolean;
  allow_payment_claims: boolean;
  payments: { paid_on: string; amount: string | number; mode: string | null }[];
  pending_claims: number;
  files: { n: number; role: string; file_name: string; mime_type: string; size_bytes: number; page_count: number | null }[];
}

export async function loadPublicInvoice(token: string): Promise<PublicInvoice | null> {
  if (!isTokenShape(token)) return null;
  const { data, error } = await anonDb().rpc("get_public_invoice", { p_token: token });
  if (error || !data) return null;
  return data as PublicInvoice;
}

export function publicDoc(p: PublicInvoice, token: string) {
  const r = p as unknown as DocRecord;
  return docFromRecord({ ...r, seller: p.seller ?? {}, payment: p.payment ?? {} }, p.show_digital_qr ? `${appUrl()}/invoice/${token}` : null);
}

export async function loadInvoiceCard(token: string) {
  if (!isTokenShape(token)) return null;
  const { data, error } = await anonDb().rpc("get_invoice_card", { p_token: token });
  if (error || !data) return null;
  return data as InvoiceCard;
}
