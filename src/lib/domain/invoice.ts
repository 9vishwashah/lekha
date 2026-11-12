import { type Paise, divRound, formatINR, sum, toDecimal, toPaise, tryPaise } from "./money";
import { formatDateShort } from "./dates";

/**
 * Invoice arithmetic. Mirrors app.recalc_invoice() in the database, which is the authority for
 * anything saved; this copy drives the live preview. Parity is covered by tests.
 *
 *   line      = round(qty × rate), less the line's own discount %
 *   discount  = invoice-level, shared across lines in proportion (the last line takes the remainder)
 *   taxable   = line − its share of the discount
 *   gst       = round(taxable × rate%); intra: cgst = round(gst / 2), sgst = gst − cgst; inter: igst = gst
 *   grand     = taxable + gst + charges, optionally rounded to the rupee
 *
 * Tax is worked out once, on the discounted amount, so neither GST nor a discount can apply twice.
 */
export type SupplyType = "none" | "intra" | "inter";
export type DiscountKind = "amount" | "percent";

export interface LineInput {
  quantity: string | number;
  rate: string | number;
  discount_percent?: string | number | null;
  tax_rate?: string | number | null;
}

export interface InvoiceInput {
  lines: LineInput[];
  gstEnabled: boolean;
  sellerState?: string | null;
  placeOfSupply?: string | null;
  discountKind: DiscountKind;
  discountValue: string | number;
  chargeAmount?: string | number | null;
  roundOff: boolean;
}

export interface ComputedLine {
  lineAmount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  total: Paise;
}

export interface ComputedInvoice {
  supply: SupplyType;
  lines: ComputedLine[];
  subtotal: Paise;
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  tax: Paise;
  charges: Paise;
  rounding: Paise;
  grand: Paise;
}

/** Fixed-point parse: "1.5" with 3 places → 1500n. Anything unreadable is 0 while typing. */
function fixed(value: string | number | null | undefined, places: number): bigint {
  const text = String(value ?? "").replace(/[,\s]/g, "");
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (!m[1] && !m[2])) return 0n;
  const frac = (m[2] ?? "").padEnd(places + 1, "0");
  const scaled = BigInt(m[1] || "0") * 10n ** BigInt(places) + BigInt(frac.slice(0, places) || "0");
  return frac[places] >= "5" ? scaled + 1n : scaled;
}

export function supplyType(gstEnabled: boolean, sellerState?: string | null, placeOfSupply?: string | null): SupplyType {
  if (!gstEnabled) return "none";
  return placeOfSupply && sellerState && placeOfSupply !== sellerState ? "inter" : "intra";
}

export function computeInvoice(input: InvoiceInput): ComputedInvoice {
  const supply = supplyType(input.gstEnabled, input.sellerState, input.placeOfSupply);
  const amounts = input.lines.map((l) => {
    const gross = divRound(fixed(l.quantity, 3) * (tryPaise(l.rate as string) ?? 0n), 1000n);
    return divRound(gross * (10000n - min10000(fixed(l.discount_percent, 2))), 10000n);
  });
  const subtotal = sum(amounts);
  const raw = input.discountKind === "percent" ? divRound(subtotal * min10000(fixed(input.discountValue, 2)), 10000n) : (tryPaise(input.discountValue as string) ?? 0n);
  const discount = raw > subtotal ? subtotal : raw;

  const lastIndex = amounts.reduce((last, a, i) => (a > 0n ? i : last), -1);
  let left = discount;
  const lines = amounts.map((lineAmount, i) => {
    const share = lineAmount <= 0n ? 0n : i === lastIndex ? left : divRound(discount * lineAmount, subtotal);
    left -= share;
    const taxable = lineAmount - share;
    const gst = supply === "none" ? 0n : divRound(taxable * fixed(input.lines[i].tax_rate, 2), 10000n);
    const cgst = supply === "intra" ? divRound(gst, 2n) : 0n;
    const sgst = supply === "intra" ? gst - cgst : 0n;
    const igst = supply === "inter" ? gst : 0n;
    return { lineAmount, taxable, cgst, sgst, igst, total: taxable + gst };
  });

  const taxable = sum(lines.map((l) => l.taxable));
  const cgst = sum(lines.map((l) => l.cgst));
  const sgst = sum(lines.map((l) => l.sgst));
  const igst = sum(lines.map((l) => l.igst));
  const charges = tryPaise(input.chargeAmount as string) ?? 0n;
  const before = taxable + cgst + sgst + igst + charges;
  const rounded = input.roundOff ? divRound(before, 100n) * 100n : before;
  return { supply, lines, subtotal, discount, taxable, cgst, sgst, igst, tax: cgst + sgst + igst, charges, rounding: rounded - before, grand: rounded };
}

const min10000 = (v: bigint) => (v > 10000n ? 10000n : v);

// ---------------------------------------------------------------------------------------------
// Amount in words (Indian numbering)
// ---------------------------------------------------------------------------------------------
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n: number) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}

function belowThousand(n: number) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? belowHundred(r) : ""].filter(Boolean).join(" ");
}

function wholeWords(n: bigint): string {
  if (n === 0n) return "Zero";
  const crore = n / 10_000_000n;
  const rest = Number(n % 10_000_000n);
  const parts = [
    crore > 0n ? `${wholeWords(crore)} Crore` : "",
    Math.floor(rest / 100_000) ? `${belowHundred(Math.floor(rest / 100_000))} Lakh` : "",
    Math.floor(rest / 1000) % 100 ? `${belowHundred(Math.floor(rest / 1000) % 100)} Thousand` : "",
    rest % 1000 ? belowThousand(rest % 1000) : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/** ₹4,25,000 → "Four Lakh Twenty Five Thousand Rupees Only". */
export function amountInWords(paise: Paise): string {
  const rupees = paise / 100n;
  const rem = Number(paise % 100n);
  if (rupees === 0n && rem > 0) return `${belowHundred(rem)} Paise Only`;
  return `${wholeWords(rupees)} ${rupees === 1n ? "Rupee" : "Rupees"}${rem ? ` and ${belowHundred(rem)} Paise` : ""} Only`;
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------
export type InvoiceStatus = "draft" | "issued" | "sent" | "viewed" | "partial" | "paid" | "overdue" | "cancelled";

export const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  sent: "Sent",
  viewed: "Viewed",
  partial: "Partially paid",
  paid: "Paid",
  overdue: "Overdue",
  cancelled: "Cancelled",
};

export const STATUS_TONE: Record<InvoiceStatus, "neutral" | "in" | "out" | "warn" | "ink"> = {
  draft: "neutral",
  issued: "ink",
  sent: "ink",
  viewed: "ink",
  partial: "warn",
  paid: "in",
  overdue: "out",
  cancelled: "neutral",
};

export interface StatusFields {
  status: "draft" | "issued" | "cancelled";
  invoice_type: string;
  grand_total: string | number;
  amount_received: string | number;
  due_date: string | null;
  sent_at: string | null;
  first_viewed_at: string | null;
}

/** Mirrors app.invoice_status(). A paid invoice is never overdue; a cancelled one is never owed. */
export function invoiceStatus(i: StatusFields, today: string): InvoiceStatus {
  if (i.status === "cancelled") return "cancelled";
  if (i.status === "draft") return "draft";
  const grand = toPaise(i.grand_total);
  const received = toPaise(i.amount_received);
  if (grand > 0n && received >= grand) return "paid";
  if (i.invoice_type !== "proforma" && i.due_date && i.due_date < today) return "overdue";
  if (received > 0n) return "partial";
  if (i.first_viewed_at) return "viewed";
  if (i.sent_at) return "sent";
  return "issued";
}

export const balanceOf = (i: { grand_total: string | number; amount_received: string | number }) => {
  const b = toPaise(i.grand_total) - toPaise(i.amount_received);
  return b > 0n ? b : 0n;
};

// ---------------------------------------------------------------------------------------------
// Types and templates
// ---------------------------------------------------------------------------------------------
export type InvoiceType = "service" | "product" | "gst" | "project" | "proforma" | "custom";
export type TemplateKey = "modern" | "minimal" | "project" | "classic" | "tax" | "compact";

export const INVOICE_TYPES: { value: InvoiceType; label: string; hint: string; template: TemplateKey }[] = [
  { value: "service", label: "Service invoice", hint: "Consulting, design, maintenance, professional fees", template: "classic" },
  { value: "project", label: "Project / deliverables", hint: "Numbered deliverables, links and milestones", template: "project" },
  { value: "product", label: "Itemised product", hint: "SKU, HSN, quantity, unit price and discount", template: "modern" },
  { value: "gst", label: "GST tax invoice", hint: "GSTIN, HSN/SAC, CGST, SGST or IGST", template: "tax" },
  { value: "proforma", label: "Proforma", hint: "Estimate or advance billing. Posts nothing to ledgers", template: "minimal" },
  { value: "custom", label: "Custom", hint: "Your own combination of sections", template: "modern" },
];

export const TEMPLATES: { value: TemplateKey; label: string; hint: string }[] = [
  { value: "modern", label: "Modern Professional", hint: "Solid header band, clean table" },
  { value: "minimal", label: "Minimal Corporate", hint: "Quiet type, thin rules" },
  { value: "project", label: "Branded Project", hint: "Deliverables with a bold total band" },
  { value: "classic", label: "Classic Service", hint: "Letterhead, Bill To panel, right-hand totals" },
  { value: "tax", label: "Tax Invoice", hint: "Dense columns for GST detail" },
  { value: "compact", label: "Compact", hint: "Fits more on one page" },
];

export const documentTitle = (type: string) => (type === "gst" ? "TAX INVOICE" : type === "proforma" ? "PROFORMA INVOICE" : "INVOICE");

export const invoiceTypeLabel = (type: string) => INVOICE_TYPES.find((t) => t.value === type)?.label ?? "Invoice";

/** "2026-27" for a date. Mirrors app.fy_label(), which numbers the real invoices. */
export function fyLabel(date: string, startMonth = 4) {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= startMonth ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

/** What the numbering settings will produce, for previews. The database allocates the real number. */
export function formatInvoiceNumber(s: { format: string; prefix: string; padding: number }, fy: string, date: string, seq: number) {
  return s.format
    .replaceAll("{PREFIX}", s.prefix)
    .replaceAll("{FY}", fy)
    .replaceAll("{YYYY}", date.slice(0, 4))
    .replaceAll("{MM}", date.slice(5, 7))
    .replaceAll("{SEQ}", String(seq).padStart(s.padding, "0"));
}

// ---------------------------------------------------------------------------------------------
// Getting paid and sharing
// ---------------------------------------------------------------------------------------------
/** Letters, digits and spaces only: some UPI apps refuse a name or note with &, / or other symbols. */
const upiText = (s: string, max: number) =>
  s.replace(/&/g, " and ").replace(/[^A-Za-z0-9 .\-]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * A UPI deep link (also drawn as the invoice QR). Starts a payment; it never proves one was made.
 *
 * Only the person-to-person fields are sent: pa, pn, am, cu, tn. The merchant fields (tr, mc) make
 * apps treat it as a payment to a registered merchant; for an ordinary UPI ID that check fails and
 * apps such as Google Pay and PhonePe stop with "could not load banking name". The invoice number
 * goes in the note instead.
 */
export function upiLink(p: { id: string; payee?: string | null; amount?: Paise | null; note?: string | null }) {
  const q = new URLSearchParams();
  q.set("pa", p.id.trim());
  const name = p.payee ? upiText(p.payee, 50) : "";
  if (name) q.set("pn", name);
  if (p.amount && p.amount > 0n) q.set("am", toDecimal(p.amount));
  q.set("cu", "INR");
  const note = p.note ? upiText(p.note, 50) : "";
  if (note) q.set("tn", note);
  // URLSearchParams writes spaces as "+", which UPI apps show literally.
  return `upi://pay?${q.toString().replace(/\+/g, "%20")}`;
}

export function invoiceShareMessage(p: { clientName: string; business: string; invoiceNo: string; total: Paise; dueDate?: string | null; url: string; proforma?: boolean }) {
  return [
    `Hi ${p.clientName},`,
    "",
    `Please find your ${p.proforma ? "proforma invoice" : "invoice"} from ${p.business}.`,
    "",
    `Invoice No: ${p.invoiceNo}`,
    `Amount: ${formatINR(p.total)}`,
    ...(p.dueDate ? [`Due Date: ${formatDateShort(p.dueDate)}`] : []),
    "",
    "You can view, download and access payment details through the link below:",
    "",
    p.url,
    "",
    "Thank you for your business!",
  ].join("\n");
}

export type ReminderStage = "before_due" | "on_due" | "after_due" | "custom";

export const REMINDER_LABEL: Record<ReminderStage, string> = {
  before_due: "Before due date",
  on_due: "On due date",
  after_due: "After due date",
  custom: "Custom reminder",
};

export const reminderStageFor = (dueDate: string | null, today: string): ReminderStage =>
  !dueDate ? "custom" : today < dueDate ? "before_due" : today === dueDate ? "on_due" : "after_due";

export function invoiceReminderMessage(p: { clientName: string; invoiceNo: string; outstanding: Paise; dueDate?: string | null; url: string; stage: ReminderStage }) {
  const due = p.dueDate ? formatDateShort(p.dueDate) : null;
  const line =
    p.stage === "after_due" && due
      ? `The payment was due on ${due}.`
      : p.stage === "on_due"
        ? "The payment is due today."
        : due
          ? `The pending payment is due on ${due}.`
          : "The payment is still pending.";
  return [
    `Hi ${p.clientName},`,
    "",
    `This is a gentle reminder regarding Invoice ${p.invoiceNo} for ${formatINR(p.outstanding)}.`,
    "",
    line,
    "",
    "You can view your invoice and payment details here:",
    "",
    p.url,
    "",
    "Thank you.",
  ].join("\n");
}
