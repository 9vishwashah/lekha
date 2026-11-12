import { amountInWords, computeInvoice, documentTitle, upiLink, type InvoiceType, type SupplyType, type TemplateKey } from "@/lib/domain/invoice";
import { type Paise, formatINR, toPaise } from "@/lib/domain/money";
import { formatDate } from "@/lib/domain/dates";
import { stateName } from "@/lib/domain/india";

/**
 * One description of an invoice document. The on-screen preview, the public page and the PDF all
 * render from this, so what the client sees and what they download cannot disagree.
 */
export interface DocSeller {
  name: string;
  logo: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  website: string | null;
  gstin: string | null;
  pan: string | null;
  state: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  signature: string | null;
  stamp: string | null;
}

export interface DocClient {
  name: string;
  business: string | null;
  contact: string | null;
  address: string | null;
  gstin: string | null;
  state: string | null;
  country: string | null;
}

export interface DocItem {
  n: number;
  name: string;
  description: string | null;
  url: string | null;
  sku: string | null;
  hsn: string | null;
  quantity: string;
  unit: string | null;
  rate: Paise;
  discountPercent: number;
  taxRate: number;
  amount: Paise;
  taxable: Paise;
  tax: Paise;
  total: Paise;
}

export interface DocPayment {
  upi: { id: string | null; payee: string | null; number: string | null; qrImage: string | null; link: string | null } | null;
  bank: { holder: string | null; name: string | null; branch: string | null; account: string; ifsc: string | null } | null;
  cash: boolean;
  cheque: boolean;
  other: string | null;
  instructions: string | null;
}

export interface InvoiceDoc {
  type: InvoiceType;
  heading: string;
  number: string | null;
  title: string | null;
  date: string;
  due: string | null;
  paymentTerms: string | null;
  template: TemplateKey;
  brand: string;
  accent: string;
  logoRight: boolean;
  seller: DocSeller;
  client: DocClient;
  placeOfSupply: string | null;
  gst: boolean;
  supply: SupplyType;
  items: DocItem[];
  subtotal: Paise;
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  chargeLabel: string | null;
  charges: Paise;
  rounding: Paise;
  grand: Paise;
  words: string;
  received: Paise;
  balance: Paise;
  notes: string | null;
  terms: string | null;
  footer: string | null;
  payment: DocPayment;
  digitalUrl: string | null;
}

export const brandUrl = (path: string | null | undefined) => {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!path || !base) return null;
  return `${base.replace(/\/$/, "")}/storage/v1/object/public/invoice-brand/${path.split("/").map(encodeURIComponent).join("/")}`;
};

/** Snapshot of the business, as stored on an issued invoice (or built live for a draft). */
export interface SellerSnapshot {
  business_name?: string | null;
  logo_path?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  website?: string | null;
  gst_registered?: boolean | null;
  gstin?: string | null;
  pan?: string | null;
  state_code?: string | null;
  signatory_name?: string | null;
  signatory_title?: string | null;
  signature_path?: string | null;
  stamp_path?: string | null;
  template?: string | null;
  brand_color?: string | null;
  accent_color?: string | null;
  logo_position?: string | null;
}

export interface PaymentSnapshot {
  upi?: { id?: string | null; payee?: string | null; number?: string | null; qr_path?: string | null; dynamic?: boolean } | null;
  bank?: { holder?: string | null; name?: string | null; branch?: string | null; account: string; ifsc?: string | null } | null;
  cash?: boolean;
  cheque?: boolean;
  other?: string | null;
  instructions?: string | null;
}

export interface DocRecord {
  invoice_type: string;
  invoice_no: string | null;
  title: string | null;
  invoice_date: string;
  due_date: string | null;
  payment_terms: string | null;
  template: string | null;
  client: { name: string | null; business?: string | null; contact?: string | null; address?: string | null; gstin?: string | null; state?: string | null; country?: string | null; logo_path?: string | null };
  place_of_supply: string | null;
  gst_enabled: boolean;
  supply_type: string;
  items: {
    position: number;
    name: string;
    description: string | null;
    reference_url: string | null;
    sku: string | null;
    hsn: string | null;
    quantity: string | number;
    unit: string | null;
    rate: string | number;
    discount_percent: string | number;
    tax_rate: string | number;
    line_amount: string | number;
    taxable_amount: string | number;
    cgst_amount: string | number;
    sgst_amount: string | number;
    igst_amount: string | number;
    line_total: string | number;
  }[];
  totals: {
    subtotal: string | number;
    discount_total: string | number;
    taxable_total: string | number;
    cgst_total: string | number;
    sgst_total: string | number;
    igst_total: string | number;
    charge_label: string | null;
    charge_amount: string | number;
    rounding: string | number;
    grand_total: string | number;
    amount_received: string | number;
  };
  notes: string | null;
  terms: string | null;
  footer: string | null;
  seller: SellerSnapshot;
  payment: PaymentSnapshot;
}

const qty = (v: string | number) => {
  const s = String(v);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
};

function sellerOf(s: SellerSnapshot): DocSeller {
  return {
    name: s.business_name || "Your business",
    logo: brandUrl(s.logo_path),
    email: s.email ?? null,
    phone: s.phone ?? null,
    address: s.address ?? null,
    website: s.website ?? null,
    gstin: s.gstin ?? null,
    pan: s.pan ?? null,
    state: stateName(s.state_code),
    signatoryName: s.signatory_name ?? null,
    signatoryTitle: s.signatory_title ?? null,
    signature: brandUrl(s.signature_path),
    stamp: brandUrl(s.stamp_path),
  };
}

function paymentOf(p: PaymentSnapshot, balance: Paise, number: string | null, business: string): DocPayment {
  const upi = p.upi?.id || p.upi?.qr_path
    ? {
        id: p.upi.id ?? null,
        payee: p.upi.payee ?? null,
        number: p.upi.number ?? null,
        qrImage: p.upi.dynamic === false ? brandUrl(p.upi.qr_path) : null,
        // Amount-specific QR for what is still owed. A payment link, not proof of payment.
        link: p.upi.dynamic === false || !p.upi.id ? null : upiLink({ id: p.upi.id, payee: p.upi.payee ?? business, amount: balance, note: number ? `Invoice ${number}` : "Invoice" }),
      }
    : null;
  const bank = p.bank?.account
    ? { holder: p.bank.holder ?? null, name: p.bank.name ?? null, branch: p.bank.branch ?? null, account: p.bank.account, ifsc: p.bank.ifsc ?? null }
    : null;
  return { upi, bank, cash: Boolean(p.cash), cheque: Boolean(p.cheque), other: p.other ?? null, instructions: p.instructions ?? null };
}

/** From a saved invoice: the owner's own record, or the public payload. */
export function docFromRecord(r: DocRecord, digitalUrl: string | null): InvoiceDoc {
  const s = r.seller;
  const t = r.totals;
  const grand = toPaise(t.grand_total);
  const received = toPaise(t.amount_received);
  const balance = grand > received ? grand - received : 0n;
  return {
    type: r.invoice_type as InvoiceType,
    heading: documentTitle(r.invoice_type),
    number: r.invoice_no,
    title: r.title,
    date: r.invoice_date,
    due: r.due_date,
    paymentTerms: r.payment_terms,
    template: (r.template ?? s.template ?? "modern") as TemplateKey,
    brand: s.brand_color ?? "#1d1d1b",
    accent: s.accent_color ?? "#eac119",
    logoRight: s.logo_position === "right",
    seller: sellerOf(s),
    client: {
      name: r.client.name ?? "Client",
      business: r.client.business ?? null,
      contact: r.client.contact ?? null,
      address: r.client.address ?? null,
      gstin: r.client.gstin ?? null,
      state: r.client.state ?? null,
      country: r.client.country ?? null,
    },
    placeOfSupply: stateName(r.place_of_supply),
    gst: r.gst_enabled,
    supply: r.supply_type as SupplyType,
    items: r.items.map((x) => ({
      n: x.position,
      name: x.name,
      description: x.description,
      url: x.reference_url,
      sku: x.sku,
      hsn: x.hsn,
      quantity: qty(x.quantity),
      unit: x.unit,
      rate: toPaise(x.rate),
      discountPercent: Number(x.discount_percent),
      taxRate: Number(x.tax_rate),
      amount: toPaise(x.line_amount),
      taxable: toPaise(x.taxable_amount),
      tax: toPaise(x.cgst_amount) + toPaise(x.sgst_amount) + toPaise(x.igst_amount),
      total: toPaise(x.line_total),
    })),
    subtotal: toPaise(t.subtotal),
    discount: toPaise(t.discount_total),
    taxable: toPaise(t.taxable_total),
    cgst: toPaise(t.cgst_total),
    sgst: toPaise(t.sgst_total),
    igst: toPaise(t.igst_total),
    chargeLabel: t.charge_label,
    charges: toPaise(t.charge_amount),
    rounding: toPaise(t.rounding),
    grand,
    words: amountInWords(grand),
    received,
    balance,
    notes: r.notes,
    terms: r.terms,
    footer: r.footer,
    payment: paymentOf(r.payment ?? {}, balance, r.invoice_no, s.business_name ?? ""),
    digitalUrl,
  };
}

export interface DraftForm {
  invoice_type: string;
  invoice_no: string;
  title: string;
  invoice_date: string;
  due_date: string;
  payment_terms: string;
  template: string;
  client_name: string;
  client_business: string;
  client_contact: string;
  client_address: string;
  client_gstin: string;
  client_state: string;
  client_country: string;
  place_of_supply: string;
  gst_enabled: boolean;
  discount_kind: "amount" | "percent";
  discount_value: string;
  charge_label: string;
  charge_amount: string;
  round_off: boolean;
  notes: string;
  terms: string;
  footer: string;
  items: { name: string; description: string; reference_url: string; sku: string; hsn: string; quantity: string; unit: string; rate: string; discount_percent: string; tax_rate: string }[];
}

/** From the editor, before anything is saved: the live preview. The numbers use the same engine. */
export function docFromDraft(f: DraftForm, seller: SellerSnapshot, payment: PaymentSnapshot, previewNumber: string | null): InvoiceDoc {
  const gst = Boolean(seller.gst_registered) && (f.invoice_type === "gst" || f.gst_enabled);
  const c = computeInvoice({
    lines: f.items,
    gstEnabled: gst,
    sellerState: seller.state_code,
    placeOfSupply: f.place_of_supply,
    discountKind: f.discount_kind,
    discountValue: f.discount_value,
    chargeAmount: f.charge_amount,
    roundOff: f.round_off,
  });
  return {
    type: f.invoice_type as InvoiceType,
    heading: documentTitle(f.invoice_type),
    number: f.invoice_no || previewNumber,
    title: f.title || null,
    date: f.invoice_date,
    due: f.due_date || null,
    paymentTerms: f.payment_terms || null,
    template: (f.template || seller.template || "modern") as TemplateKey,
    brand: seller.brand_color ?? "#1d1d1b",
    accent: seller.accent_color ?? "#eac119",
    logoRight: seller.logo_position === "right",
    seller: sellerOf(seller),
    client: {
      name: f.client_name || "Client name",
      business: f.client_business || null,
      contact: f.client_contact || null,
      address: f.client_address || null,
      gstin: f.client_gstin || null,
      state: f.client_state || null,
      country: f.client_country || null,
    },
    placeOfSupply: stateName(f.place_of_supply),
    gst,
    supply: c.supply,
    items: f.items.map((x, i) => ({
      n: i + 1,
      name: x.name || "Item",
      description: x.description || null,
      url: x.reference_url || null,
      sku: x.sku || null,
      hsn: x.hsn || null,
      quantity: x.quantity || "1",
      unit: x.unit || null,
      rate: tryRate(x.rate),
      discountPercent: Number(x.discount_percent) || 0,
      taxRate: Number(x.tax_rate) || 0,
      amount: c.lines[i].lineAmount,
      taxable: c.lines[i].taxable,
      tax: c.lines[i].cgst + c.lines[i].sgst + c.lines[i].igst,
      total: c.lines[i].total,
    })),
    subtotal: c.subtotal,
    discount: c.discount,
    taxable: c.taxable,
    cgst: c.cgst,
    sgst: c.sgst,
    igst: c.igst,
    chargeLabel: f.charge_label || null,
    charges: c.charges,
    rounding: c.rounding,
    grand: c.grand,
    words: amountInWords(c.grand),
    received: 0n,
    balance: c.grand,
    notes: f.notes || null,
    terms: f.terms || null,
    footer: f.footer || null,
    payment: paymentOf(payment, c.grand, f.invoice_no || previewNumber, seller.business_name ?? ""),
    digitalUrl: null,
  };
}

const tryRate = (v: string) => {
  try {
    return toPaise(v);
  } catch {
    return 0n;
  }
};

// ---------------------------------------------------------------------------------------------
// Layout decisions shared by the screen and the PDF
// ---------------------------------------------------------------------------------------------
export interface DocColumn {
  key: "n" | "item" | "description" | "hsn" | "qty" | "rate" | "disc" | "taxable" | "gst" | "amount";
  label: string;
  align: "left" | "right";
  weight: number;
}

export function docColumns(doc: InvoiceDoc): DocColumn[] {
  const n: DocColumn = { key: "n", label: doc.type === "project" ? "#" : "Sr.", align: "left", weight: 0.5 };
  const amount: DocColumn = { key: "amount", label: "Amount", align: "right", weight: 1.3 };
  if (doc.type === "project") {
    return [n, { key: "item", label: "Deliverable", align: "left", weight: 2.4 }, { key: "description", label: "Description", align: "left", weight: 3.6 }, amount];
  }
  const hasDisc = doc.items.some((i) => i.discountPercent > 0);
  const base: DocColumn[] = [n, { key: "item", label: doc.type === "product" ? "Item" : "Description", align: "left", weight: doc.gst ? 3 : 4 }];
  if (doc.type === "product" || doc.gst) base.push({ key: "hsn", label: doc.gst ? "HSN/SAC" : "HSN", align: "left", weight: 0.9 });
  base.push({ key: "qty", label: "Qty", align: "right", weight: 0.7 }, { key: "rate", label: "Rate", align: "right", weight: 1.1 });
  if (hasDisc) base.push({ key: "disc", label: "Disc", align: "right", weight: 0.6 });
  if (doc.gst) base.push({ key: "taxable", label: "Taxable", align: "right", weight: 1.1 }, { key: "gst", label: "GST", align: "right", weight: 0.6 });
  base.push(amount);
  return base;
}

export function cellText(item: DocItem, key: DocColumn["key"]): string {
  switch (key) {
    case "n":
      return String(item.n).padStart(2, "0");
    case "item":
      return item.name;
    case "description":
      return item.description ?? "";
    case "hsn":
      return item.hsn ?? "";
    case "qty":
      return item.unit ? `${item.quantity} ${item.unit}` : item.quantity;
    case "rate":
      return formatINR(item.rate);
    case "disc":
      return item.discountPercent ? `${item.discountPercent}%` : "";
    case "taxable":
      return formatINR(item.taxable);
    case "gst":
      return `${item.taxRate}%`;
    case "amount":
      return formatINR(item.amount);
  }
}

export interface TotalRow {
  label: string;
  value: string;
}

export function totalRows(doc: InvoiceDoc): TotalRow[] {
  const rows: TotalRow[] = [];
  const hasAdjust = doc.discount > 0n || doc.gst || doc.charges > 0n || doc.rounding !== 0n;
  if (hasAdjust) rows.push({ label: "Subtotal", value: formatINR(doc.subtotal) });
  if (doc.discount > 0n) rows.push({ label: "Discount", value: `− ${formatINR(doc.discount)}` });
  if (doc.gst) {
    rows.push({ label: "Taxable amount", value: formatINR(doc.taxable) });
    if (doc.supply === "inter") rows.push({ label: "IGST", value: formatINR(doc.igst) });
    else rows.push({ label: "CGST", value: formatINR(doc.cgst) }, { label: "SGST", value: formatINR(doc.sgst) });
  }
  if (doc.charges > 0n) rows.push({ label: doc.chargeLabel || "Other charges", value: formatINR(doc.charges) });
  if (doc.rounding !== 0n) rows.push({ label: "Rounding", value: `${doc.rounding < 0n ? "− " : ""}${formatINR(doc.rounding < 0n ? -doc.rounding : doc.rounding)}` });
  return rows;
}

export const metaRows = (doc: InvoiceDoc) => {
  const rows: { label: string; value: string }[] = [];
  rows.push({ label: "Invoice No.", value: doc.number ?? "Assigned when issued" });
  rows.push({ label: "Date", value: formatDate(doc.date) });
  if (doc.due) rows.push({ label: "Due", value: formatDate(doc.due) });
  if (doc.paymentTerms) rows.push({ label: "Terms", value: doc.paymentTerms });
  if (doc.gst && doc.placeOfSupply) rows.push({ label: "Place of supply", value: doc.placeOfSupply });
  return rows;
};

/** Readable text colour on a solid brand colour (WCAG relative luminance). */
export function onColor(hex: string) {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#1d1d1b" : "#ffffff";
}

/** A pale wash of a brand colour for alternate rows: `amount` of the colour, the rest white. */
export function tint(hex: string, amount = 0.08) {
  const v = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => Math.round(255 - (255 - parseInt(v.slice(i, i + 2), 16)) * amount));
  return `#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Link-preview images (WhatsApp, iMessage, Slack). */
export const OG_SIZE = { width: 1200, height: 630 };

export type TemplateStyle = { header: "band" | "plain"; total: "band" | "right"; table: "solid" | "line"; zebra: boolean; panel: boolean; dense: boolean };

export const TEMPLATE_STYLE: Record<TemplateKey, TemplateStyle> = {
  modern: { header: "band", total: "right", table: "solid", zebra: false, panel: false, dense: false },
  minimal: { header: "plain", total: "right", table: "line", zebra: false, panel: false, dense: false },
  project: { header: "plain", total: "band", table: "solid", zebra: true, panel: false, dense: false },
  classic: { header: "plain", total: "right", table: "solid", zebra: false, panel: true, dense: false },
  tax: { header: "plain", total: "right", table: "solid", zebra: false, panel: true, dense: true },
  compact: { header: "plain", total: "right", table: "line", zebra: false, panel: false, dense: true },
};
