import type { InvoiceItemRow, InvoiceRow, InvoiceSettings, PaymentConfig, PaymentProfile } from "@/lib/server/invoices";
import { INVOICE_TYPES } from "@/lib/domain/invoice";
import type { DraftForm, PaymentSnapshot } from "./doc";

/** The editor's state: the document fields plus what only the record needs. */
export interface EditorState extends DraftForm {
  id?: string;
  source?: "native" | "uploaded";
  contractor_id: string;
  ledger_id: string;
  save_client: boolean;
  client_phone: string;
  client_email: string;
  client_pan: string;
  client_logo_path: string;
  payment_config: PaymentConfig;
  show_digital_qr: boolean;
  allow_payment_claims: boolean;
  show_payment_history: boolean;
}

export type EditorItem = DraftForm["items"][number];

export const blankItem = (): EditorItem => ({ name: "", description: "", reference_url: "", sku: "", hsn: "", quantity: "1", unit: "", rate: "", discount_percent: "", tax_rate: "" });

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function configFor(profile: PaymentProfile | undefined): PaymentConfig {
  // A QR image you saved yourself is what you meant to show, so it is the default when there is one.
  return { profile_id: profile?.id ?? null, upi: Boolean(profile?.upi_id || profile?.upi_qr_path), bank: Boolean(profile?.bank_account), qr_mode: profile?.upi_qr_path ? "fixed" : "dynamic" };
}

export function blankDraft(type: string, s: InvoiceSettings, profiles: PaymentProfile[], today: string): EditorState {
  const known = INVOICE_TYPES.find((t) => t.value === type) ?? INVOICE_TYPES[0];
  const profile = profiles.find((p) => p.id === s.default_profile_id) ?? profiles[0];
  return {
    invoice_type: known.value,
    invoice_no: "",
    title: "",
    invoice_date: today,
    due_date: addDays(today, s.default_due_days),
    payment_terms: s.default_payment_terms ?? "",
    template: known.value === "service" || known.value === "custom" ? (s.template ?? known.template) : known.template,
    contractor_id: "",
    ledger_id: "",
    save_client: true,
    client_name: "",
    client_business: "",
    client_contact: "",
    client_phone: "",
    client_email: "",
    client_address: "",
    client_gstin: "",
    client_pan: "",
    client_logo_path: "",
    client_state: "",
    client_country: "India",
    place_of_supply: s.state_code ?? "",
    gst_enabled: known.value === "gst",
    discount_kind: "amount",
    discount_value: "",
    charge_label: "",
    charge_amount: "",
    round_off: s.round_off,
    notes: s.default_notes ?? "",
    terms: s.default_terms ?? "",
    footer: s.default_footer ?? "",
    items: [blankItem()],
    payment_config: configFor(profile),
    show_digital_qr: s.show_digital_qr,
    allow_payment_claims: s.allow_payment_claims,
    show_payment_history: s.show_payment_history,
  };
}

const text = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const zeroEmpty = (v: string | number) => (Number(v) ? String(v) : "");

export function draftFromRow(i: InvoiceRow, items: InvoiceItemRow[]): EditorState {
  return {
    id: i.id,
    source: i.source,
    invoice_type: i.invoice_type,
    invoice_no: text(i.invoice_no),
    title: text(i.title),
    invoice_date: i.invoice_date,
    due_date: text(i.due_date),
    payment_terms: text(i.payment_terms),
    template: text(i.template),
    contractor_id: text(i.contractor_id),
    ledger_id: text(i.ledger_id),
    save_client: false,
    client_name: text(i.client_name),
    client_business: text(i.client_business),
    client_contact: text(i.client_contact),
    client_phone: text(i.client_phone),
    client_email: text(i.client_email),
    client_address: text(i.client_address),
    client_gstin: text(i.client_gstin),
    client_pan: text(i.client_pan),
    client_logo_path: text(i.client_logo_path),
    client_state: text(i.client_state),
    client_country: i.client_country,
    place_of_supply: text(i.place_of_supply),
    gst_enabled: i.gst_enabled,
    discount_kind: i.discount_kind,
    discount_value: zeroEmpty(i.discount_value),
    charge_label: text(i.charge_label),
    charge_amount: zeroEmpty(i.charge_amount),
    round_off: i.round_off,
    notes: text(i.notes),
    terms: text(i.terms),
    footer: text(i.footer),
    items: items.length
      ? items.map((x) => ({
          name: x.name,
          description: text(x.description),
          reference_url: text(x.reference_url),
          sku: text(x.sku),
          hsn: text(x.hsn),
          quantity: String(x.quantity),
          unit: text(x.unit),
          rate: String(x.rate),
          discount_percent: zeroEmpty(x.discount_percent),
          tax_rate: zeroEmpty(x.tax_rate),
        }))
      : [blankItem()],
    payment_config: i.payment_config ?? {},
    show_digital_qr: i.show_digital_qr,
    allow_payment_claims: i.allow_payment_claims,
    show_payment_history: i.show_payment_history,
  };
}

/** What a draft will show, from the live settings and the chosen payment profile. */
export function previewPayment(config: PaymentConfig, profiles: PaymentProfile[]): PaymentSnapshot {
  const f = profiles.find((p) => p.id === config.profile_id);
  const fixed = Boolean(f?.upi_qr_path) && (!f?.upi_id || config.qr_mode === "fixed");
  return {
    upi: (f?.upi_id || f?.upi_qr_path) && config.upi ? { id: f.upi_id, payee: f.upi_payee, number: f.upi_number, qr_path: fixed ? f.upi_qr_path : null, dynamic: !fixed } : null,
    bank: f?.bank_account && config.bank ? { holder: f.bank_holder, name: f.bank_name, branch: f.bank_branch, account: f.bank_account, ifsc: f.bank_ifsc } : null,
    cash: config.cash,
    cheque: config.cheque,
    other: config.other ?? null,
    instructions: f?.instructions ?? null,
  };
}
