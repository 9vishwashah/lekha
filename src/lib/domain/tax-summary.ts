import { type Paise, toPaise } from "./money";

/**
 * Monthly tax summary. "invoice" basis groups bills by invoice date (falls back to entry date);
 * "payment" basis groups by the date the entry was recorded. Only posted entries count, and an
 * entry cancelled by a reversal drops out with it, so GST and TDS are never double counted.
 */
export interface TaxRow {
  txn_date: string;
  status: "draft" | "posted" | "void";
  reversed: boolean;
  invoice_date: string | null;
  taxable_amount: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  gst_amount: string;
  tds_amount: string;
  gross_amount: string;
  net_amount: string;
}

export interface SettlementRow {
  txn_date: string;
  period_month: string;
  tax_type: "gst" | "tds" | "other";
  amount: string;
  status: "draft" | "posted" | "void";
  reversed: boolean;
}

export interface MonthTax {
  month: string; // YYYY-MM
  invoices: number;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  gst: Paise;
  tds: Paise;
  gross: Paise;
  net: Paise;
  gstPaid: Paise;
  tdsPaid: Paise;
}

const empty = (month: string): MonthTax => ({
  month,
  invoices: 0,
  taxable: 0n,
  cgst: 0n,
  sgst: 0n,
  igst: 0n,
  gst: 0n,
  tds: 0n,
  gross: 0n,
  net: 0n,
  gstPaid: 0n,
  tdsPaid: 0n,
});

export function taxSummary(
  rows: TaxRow[],
  settlements: SettlementRow[],
  basis: "invoice" | "payment",
  range: { from?: string; to?: string } = {},
) {
  const months = new Map<string, MonthTax>();
  const bucket = (date: string) => {
    const key = date.slice(0, 7);
    let m = months.get(key);
    if (!m) months.set(key, (m = empty(key)));
    return m;
  };
  const within = (d: string) => (!range.from || d >= range.from) && (!range.to || d <= range.to);

  for (const r of rows) {
    if (r.status !== "posted" || r.reversed) continue;
    const date = basis === "invoice" ? (r.invoice_date ?? r.txn_date) : r.txn_date;
    if (!within(date)) continue;
    const m = bucket(date);
    m.invoices += 1;
    m.taxable += toPaise(r.taxable_amount);
    m.cgst += toPaise(r.cgst_amount);
    m.sgst += toPaise(r.sgst_amount);
    m.igst += toPaise(r.igst_amount);
    m.gst += toPaise(r.gst_amount);
    m.tds += toPaise(r.tds_amount);
    m.gross += toPaise(r.gross_amount);
    m.net += toPaise(r.net_amount);
  }
  for (const s of settlements) {
    if (s.status !== "posted" || s.reversed) continue;
    // Settlements are attributed to the tax period they pay for.
    const date = basis === "invoice" ? s.period_month : s.txn_date;
    if (!within(date)) continue;
    const m = bucket(date);
    if (s.tax_type === "gst") m.gstPaid += toPaise(s.amount);
    if (s.tax_type === "tds") m.tdsPaid += toPaise(s.amount);
  }

  const list = [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
  const total = list.reduce((acc, m) => {
    acc.invoices += m.invoices;
    for (const k of ["taxable", "cgst", "sgst", "igst", "gst", "tds", "gross", "net", "gstPaid", "tdsPaid"] as const) {
      acc[k] += m[k];
    }
    return acc;
  }, empty("total"));
  return { months: list, total, gstOutstanding: total.gst - total.gstPaid };
}
