import type { ReportTable } from "@/lib/export/table";
import { balanceOf, invoiceStatus, invoiceTypeLabel, STATUS_LABEL } from "@/lib/domain/invoice";
import { type Paise, formatINR, sum, toPaise } from "@/lib/domain/money";
import { monthLabel } from "@/lib/domain/dates";
import { paymentModeLabel } from "@/lib/types";
import type { InvoiceListRow, PaymentRow } from "@/lib/server/invoices";

/**
 * Invoice reports. Each takes the same rows the screens use, so a downloaded total always matches
 * the dashboard. "Counted" means issued, not cancelled, and not a proforma.
 */
export type InvoiceReportType = "register" | "payments" | "clients" | "tax" | "overdue" | "months";

export const counted = (i: Pick<InvoiceListRow, "status" | "invoice_type">) => i.status === "issued" && i.invoice_type !== "proforma";

interface Range {
  from?: string;
  to?: string;
}

const inRange = (d: string, r: Range) => (!r.from || d >= r.from) && (!r.to || d <= r.to);
const clientOf = (i: InvoiceListRow) => i.client_business || i.client_name || "No client";

export interface InvoiceTotals {
  invoiced: Paise;
  received: Paise;
  outstanding: Paise;
  overdue: Paise;
  drafts: number;
  count: number;
}

/** Dashboard figures. Invoiced = received + outstanding, for the invoices dated in the range. */
export function invoiceTotals(rows: InvoiceListRow[], range: Range, today: string): InvoiceTotals {
  const inPeriod = rows.filter((i) => inRange(i.invoice_date, range));
  const live = inPeriod.filter(counted);
  return {
    invoiced: sum(live.map((i) => toPaise(i.grand_total))),
    received: sum(live.map((i) => { const g = toPaise(i.grand_total); const r = toPaise(i.amount_received); return r > g ? g : r; })),
    outstanding: sum(live.map(balanceOf)),
    overdue: sum(live.filter((i) => invoiceStatus(i, today) === "overdue").map(balanceOf)),
    drafts: inPeriod.filter((i) => i.status === "draft").length,
    count: live.length,
  };
}

export function monthlyInvoiced(rows: InvoiceListRow[], range: Range) {
  const map = new Map<string, { invoiced: Paise; received: Paise; count: number }>();
  for (const i of rows.filter((x) => counted(x) && inRange(x.invoice_date, range))) {
    const key = i.invoice_date.slice(0, 7);
    const m = map.get(key) ?? { invoiced: 0n, received: 0n, count: 0 };
    m.invoiced += toPaise(i.grand_total);
    m.received += toPaise(i.amount_received);
    m.count += 1;
    map.set(key, m);
  }
  return [...map.entries()].sort(([a], [b]) => (a < b ? 1 : -1));
}

export function clientTotals(rows: InvoiceListRow[], range: Range) {
  const map = new Map<string, { invoiced: Paise; received: Paise; balance: Paise; count: number }>();
  for (const i of rows.filter((x) => counted(x) && inRange(x.invoice_date, range))) {
    const key = clientOf(i);
    const m = map.get(key) ?? { invoiced: 0n, received: 0n, balance: 0n, count: 0 };
    m.invoiced += toPaise(i.grand_total);
    m.received += toPaise(i.amount_received);
    m.balance += balanceOf(i);
    m.count += 1;
    map.set(key, m);
  }
  return [...map.entries()].sort((a, b) => (a[1].invoiced > b[1].invoiced ? -1 : 1));
}

export function invoiceReport(type: InvoiceReportType, rows: InvoiceListRow[], payments: (PaymentRow & { invoice_id: string })[], range: Range, today: string, business: string): ReportTable {
  const period = range.from || range.to ? `${range.from ?? "start"} to ${range.to ?? "today"}` : "All dates";
  const live = rows.filter((i) => counted(i) && inRange(i.invoice_date, range));
  const noById = new Map(rows.map((i) => [i.id, i]));

  if (type === "payments") {
    const list = payments.filter((p) => inRange(p.paid_on, range));
    const good = list.filter((p) => p.status === "confirmed");
    return {
      title: "Invoice payments",
      subtitle: [business, period],
      summary: [{ label: "Received", value: formatINR(sum(good.map((p) => toPaise(p.amount)))) }, { label: "Payments", value: String(good.length) }],
      columns: [
        { key: "date", label: "Date", kind: "date" },
        { key: "invoice", label: "Invoice", kind: "text", width: 1.4 },
        { key: "client", label: "Client", kind: "text", width: 1.6 },
        { key: "mode", label: "Mode", kind: "text", width: 0.8 },
        { key: "reference", label: "Reference", kind: "text" },
        { key: "status", label: "Status", kind: "text", width: 0.8 },
        { key: "amount", label: "Amount", kind: "money" },
      ],
      rows: list.map((p) => {
        const i = noById.get(p.invoice_id);
        return { date: p.paid_on, invoice: i?.invoice_no ?? "", client: i ? clientOf(i) : "", mode: paymentModeLabel(p.mode), reference: p.reference, status: p.status === "reversed" ? `Reversed (${p.reversal_kind})` : "Confirmed", amount: toPaise(p.amount) };
      }),
      totals: { date: "Confirmed total", amount: sum(good.map((p) => toPaise(p.amount))) },
    };
  }

  if (type === "clients") {
    const list = clientTotals(rows, range);
    return {
      title: "Client-wise invoicing",
      subtitle: [business, period],
      summary: [],
      columns: [
        { key: "client", label: "Client", kind: "text", width: 2.4 },
        { key: "count", label: "Invoices", kind: "number", width: 0.7 },
        { key: "invoiced", label: "Invoiced", kind: "money" },
        { key: "received", label: "Received", kind: "money" },
        { key: "balance", label: "Outstanding", kind: "money" },
      ],
      rows: list.map(([client, m]) => ({ client, count: m.count, invoiced: m.invoiced, received: m.received, balance: m.balance })),
      totals: { client: "Total", invoiced: sum(list.map(([, m]) => m.invoiced)), received: sum(list.map(([, m]) => m.received)), balance: sum(list.map(([, m]) => m.balance)) },
    };
  }

  if (type === "months") {
    const list = monthlyInvoiced(rows, range);
    return {
      title: "Invoiced by month",
      subtitle: [business, period],
      summary: [],
      columns: [
        { key: "month", label: "Month", kind: "text", width: 1.6 },
        { key: "count", label: "Invoices", kind: "number", width: 0.7 },
        { key: "invoiced", label: "Invoiced", kind: "money" },
        { key: "received", label: "Received", kind: "money" },
      ],
      rows: list.map(([m, v]) => ({ month: monthLabel(m), count: v.count, invoiced: v.invoiced, received: v.received })),
      totals: { month: "Total", invoiced: sum(list.map(([, m]) => m.invoiced)), received: sum(list.map(([, m]) => m.received)) },
    };
  }

  if (type === "tax") {
    const list = live.filter((i) => toPaise(i.tax_total) > 0n);
    return {
      title: "Taxable invoice summary",
      subtitle: [business, period],
      summary: [{ label: "GST charged", value: formatINR(sum(list.map((i) => toPaise(i.tax_total)))) }],
      landscape: true,
      columns: [
        { key: "date", label: "Date", kind: "date" },
        { key: "invoice", label: "Invoice", kind: "text", width: 1.4 },
        { key: "client", label: "Client", kind: "text", width: 1.6 },
        { key: "taxable", label: "Taxable", kind: "money" },
        { key: "cgst", label: "CGST", kind: "money" },
        { key: "sgst", label: "SGST", kind: "money" },
        { key: "igst", label: "IGST", kind: "money" },
        { key: "total", label: "Total", kind: "money" },
      ],
      rows: list.map((i) => ({ date: i.invoice_date, invoice: i.invoice_no, client: clientOf(i), taxable: toPaise(i.taxable_total), cgst: toPaise(i.cgst_total), sgst: toPaise(i.sgst_total), igst: toPaise(i.igst_total), total: toPaise(i.grand_total) })),
      totals: {
        date: "Total",
        taxable: sum(list.map((i) => toPaise(i.taxable_total))), cgst: sum(list.map((i) => toPaise(i.cgst_total))),
        sgst: sum(list.map((i) => toPaise(i.sgst_total))), igst: sum(list.map((i) => toPaise(i.igst_total))), total: sum(list.map((i) => toPaise(i.grand_total))),
      },
      footnote: "A record of GST charged on your invoices. It is not a GST return.",
    };
  }

  const list = type === "overdue" ? live.filter((i) => invoiceStatus(i, today) === "overdue") : live;
  return {
    title: type === "overdue" ? "Overdue invoices" : "Invoice register",
    subtitle: [business, period],
    summary: [
      { label: "Invoiced", value: formatINR(sum(list.map((i) => toPaise(i.grand_total)))) },
      { label: "Outstanding", value: formatINR(sum(list.map(balanceOf))) },
    ],
    landscape: true,
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "invoice", label: "Invoice", kind: "text", width: 1.4 },
      { key: "type", label: "Type", kind: "text", width: 1.1 },
      { key: "client", label: "Client", kind: "text", width: 1.6 },
      { key: "due", label: "Due", kind: "date" },
      { key: "status", label: "Status", kind: "text", width: 0.9 },
      { key: "total", label: "Total", kind: "money" },
      { key: "received", label: "Received", kind: "money" },
      { key: "balance", label: "Balance", kind: "money" },
    ],
    rows: list.map((i) => ({
      date: i.invoice_date, invoice: i.invoice_no, type: invoiceTypeLabel(i.invoice_type), client: clientOf(i), due: i.due_date,
      status: STATUS_LABEL[invoiceStatus(i, today)], total: toPaise(i.grand_total), received: toPaise(i.amount_received), balance: balanceOf(i),
    })),
    totals: { date: "Total", total: sum(list.map((i) => toPaise(i.grand_total))), received: sum(list.map((i) => toPaise(i.amount_received))), balance: sum(list.map(balanceOf)) },
  };
}
