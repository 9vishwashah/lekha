import { type Paise, formatINR, toPaise } from "@/lib/domain/money";
import { type DateRange, KIND_LABEL, type Perspective, buildStatement, describeBalance } from "@/lib/domain/ledger";
import { formatDate } from "@/lib/domain/dates";
import { formatRate } from "@/lib/domain/tax";
import { toRateMilli } from "@/lib/domain/money";
import {
  type SettlementRecord,
  type SharedExpenseRecord,
  participantBalances,
  simplifyDebts,
} from "@/lib/domain/split";
import type { ReportTable } from "@/lib/export/table";
import { type MonthTax, taxSummary } from "@/lib/domain/tax-summary";
import { paymentModeLabel } from "@/lib/types";
import { monthLabel } from "@/lib/domain/dates";

const periodText = (range: DateRange) =>
  range.from || range.to ? `Period ${range.from ? formatDate(range.from) : "start"} to ${range.to ? formatDate(range.to) : "today"}` : "All entries";

export interface StatementTxn {
  seq: number;
  voucher_no: string;
  txn_date: string;
  direction: "in" | "out";
  amount: string;
  kind: keyof typeof KIND_LABEL;
  is_cash: boolean;
  affects_party: boolean;
  status: "draft" | "posted" | "void";
  description?: string | null;
  counterparty?: string | null;
  reference_no?: string | null;
  payment_mode?: string | null;
  tax?: {
    invoice_no?: string | null;
    taxable_amount: string;
    gst_rate?: string;
    cgst_amount: string;
    sgst_amount: string;
    igst_amount: string;
    gst_amount: string;
    tds_rate?: string;
    tds_amount: string;
    gross_amount: string;
    net_amount: string;
  } | null;
}

/**
 * Ledger statement table. Exactly the numbers buildStatement() puts on screen.
 * For public visitors, pass the share-link options so hidden fields stay hidden.
 */
export function ledgerStatementTable(input: {
  ledger: { name: string; ledger_type: string; perspective: Perspective; opening_balance: string };
  partyName?: string | null;
  txns: StatementTxn[];
  range: DateRange;
  includeTax: boolean;
  includeRunning?: boolean;
  includeBalance?: boolean;
  includeReference?: boolean;
  includeCounterparty?: boolean;
  includeDrafts?: boolean;
}): ReportTable {
  const {
    ledger,
    range,
    includeTax,
    includeRunning = true,
    includeBalance = true,
    includeReference = true,
    includeCounterparty = true,
    includeDrafts = true,
  } = input;
  const txns = includeDrafts ? input.txns : input.txns.filter((t) => t.status === "posted");
  const s = buildStatement(ledger, txns, range);
  const meaning = describeBalance(ledger.perspective, s.closing, input.partyName);

  const columns: ReportTable["columns"] = [
    { key: "voucher", label: "No.", kind: "text", width: 0.75 },
    { key: "date", label: "Date", kind: "date", width: 0.85 },
    { key: "description", label: "Description", kind: "text", width: 2 },
  ];
  if (includeCounterparty) columns.push({ key: "party", label: "Payee", kind: "text", width: 1.3 });
  if (includeReference) columns.push({ key: "reference", label: "Reference", kind: "text", width: 1 });
  columns.push({ key: "credit", label: "Credit (In)", kind: "money" }, { key: "debit", label: "Debit (Out)", kind: "money" });
  if (includeTax) {
    columns.push(
      { key: "taxable", label: "Bill amt", kind: "money" },
      { key: "gst", label: "GST", kind: "money" },
      { key: "tds", label: "TDS", kind: "money" },
      { key: "net", label: "After TDS", kind: "money" },
    );
  }
  if (includeRunning && includeBalance) columns.push({ key: "running", label: "Balance", kind: "money" });

  const rows = s.lines.map(({ row, counted, running }) => {
    const t = row as StatementTxn;
    const flags = [t.status === "void" ? "VOID" : t.status === "draft" ? "DRAFT" : "", t.kind !== "regular" ? KIND_LABEL[t.kind] : ""]
      .filter(Boolean)
      .join(" · ");
    const amount = toPaise(t.amount);
    return {
      voucher: t.voucher_no,
      date: t.txn_date,
      description: [t.description, flags && `(${flags})`].filter(Boolean).join(" "),
      party: t.counterparty ?? null,
      reference: [t.reference_no, paymentModeLabel(t.payment_mode)].filter(Boolean).join(" · ") || null,
      credit: t.direction === "in" ? amount : null,
      debit: t.direction === "out" ? amount : null,
      taxable: t.tax ? toPaise(t.tax.taxable_amount) : null,
      gst: t.tax ? toPaise(t.tax.gst_amount) : null,
      tds: t.tax ? toPaise(t.tax.tds_amount) : null,
      net: t.tax ? toPaise(t.tax.net_amount) : null,
      running: counted ? running : null,
    };
  });

  const posted = s.lines.filter((l) => l.row.status === "posted");
  const taxTotal = (k: "taxable_amount" | "gst_amount" | "tds_amount" | "net_amount") =>
    posted.reduce((acc, l) => acc + ((l.row as StatementTxn).tax ? toPaise((l.row as StatementTxn).tax![k]) : 0n), 0n);

  const summary = [
    ...(includeBalance ? [{ label: "Opening balance", value: formatINR(s.opening) }] : []),
    { label: "Money in", value: formatINR(s.totals.moneyIn) },
    { label: "Money out", value: formatINR(s.totals.moneyOut) },
    ...(s.totals.billsIn || s.totals.billsOut
      ? [{ label: "Bills (non-cash)", value: `${formatINR(s.totals.billsIn)} in · ${formatINR(s.totals.billsOut)} out` }]
      : []),
    ...(includeBalance ? [{ label: `Closing · ${meaning.label}`, value: formatINR(ledger.perspective === "party" ? (s.closing < 0n ? -s.closing : s.closing) : s.closing) }] : []),
  ];
  if (includeTax) {
    summary.push(
      { label: "Taxable billed", value: formatINR(taxTotal("taxable_amount")) },
      { label: "GST", value: formatINR(taxTotal("gst_amount")) },
      { label: "TDS withheld", value: formatINR(taxTotal("tds_amount")) },
    );
  }

  const postedCredit = posted.filter((l) => l.row.direction === "in").reduce((a, l) => a + toPaise(l.row.amount), 0n);
  const postedDebit = posted.filter((l) => l.row.direction === "out").reduce((a, l) => a + toPaise(l.row.amount), 0n);

  return {
    title: ledger.name,
    subtitle: [
      [input.partyName && `Party: ${input.partyName}`, `${ledger.ledger_type === "taxation" ? "Taxation" : "Basic"} ledger`].filter(Boolean).join(" · "),
      periodText(range),
    ],
    summary,
    columns,
    rows,
    totals: {
      description: "Total (posted entries)",
      credit: postedCredit,
      debit: postedDebit,
      taxable: includeTax ? taxTotal("taxable_amount") : null,
      gst: includeTax ? taxTotal("gst_amount") : null,
      tds: includeTax ? taxTotal("tds_amount") : null,
      net: includeTax ? taxTotal("net_amount") : null,
      running: includeBalance ? s.closing : null,
    },
    landscape: includeTax || columns.length > 7,
    footnote:
      ledger.perspective === "cashbook"
        ? "Balance = opening balance + money in − money out. Bills and tax-only rows do not move cash. Void and draft rows are shown but not counted."
        : "Balance = opening + paid to party − received from party − their bills. Positive means the party owes you. Void and draft rows are not counted.",
  };
}

/** Shared-account statement: every expense with who paid and each person's share. */
export function personalLedgerTable(input: {
  name: string;
  participants: { id: string; name: string }[];
  expenses: (SharedExpenseRecord & { txn_date: string; description: string })[];
  settlements: (SettlementRecord & { txn_date: string })[];
}): ReportTable {
  const names = new Map(input.participants.map((p) => [p.id, p.name]));
  const ids = input.participants.map((p) => p.id);
  const balances = participantBalances(ids, input.expenses, input.settlements);
  const debts = simplifyDebts(balances, ids);
  type Row = { date: string; kind: string; description: string; paid_by: string; total: Paise } & Record<string, string | Paise | null>;
  const rows: Row[] = [];
  for (const e of input.expenses.filter((x) => x.status === "posted")) {
    const row: Row = {
      date: e.txn_date,
      kind: "Expense",
      description: e.description,
      paid_by: e.payers.map((p) => `${names.get(p.participant_id)} ${formatINR(toPaise(p.amount_paid))}`).join(", "),
      total: toPaise(e.total_amount),
    };
    for (const p of input.participants) {
      const share = e.shares.find((s) => s.participant_id === p.id);
      row[`share_${p.id}`] = share ? toPaise(share.share_amount) : null;
    }
    rows.push(row);
  }
  for (const s of input.settlements.filter((x) => x.status === "posted")) {
    rows.push({
      date: s.txn_date,
      kind: "Repayment",
      description: `${names.get(s.from_participant_id)} paid ${names.get(s.to_participant_id)}`,
      paid_by: names.get(s.from_participant_id) ?? "",
      total: toPaise(s.amount),
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    title: input.name,
    subtitle: [`Shared account · ${input.participants.map((p) => p.name).join(", ")}`],
    summary: [
      ...input.participants.map((p) => {
        const net = balances.get(p.id)!.net;
        return { label: p.name, value: net === 0n ? "Settled" : net > 0n ? `Is owed ${formatINR(net)}` : `Owes ${formatINR(-net)}` };
      }),
      ...debts.map((d) => ({ label: "To settle", value: `${names.get(d.from)} → ${names.get(d.to)} ${formatINR(d.amount)}` })),
    ],
    columns: [
      { key: "date", label: "Date", kind: "date", width: 0.9 },
      { key: "kind", label: "Type", kind: "text", width: 0.9 },
      { key: "description", label: "Description", kind: "text", width: 2 },
      { key: "paid_by", label: "Paid by", kind: "text", width: 1.6 },
      { key: "total", label: "Amount", kind: "money" },
      ...input.participants.map((p) => ({ key: `share_${p.id}`, label: `${p.name}'s share`, kind: "money" as const })),
    ],
    rows,
    landscape: input.participants.length > 2,
    footnote: "Each person's balance = paid − own share + repayments made − repayments received. Repayments are not expenses.",
  };
}

export function taxSummaryTable(
  summary: ReturnType<typeof taxSummary>,
  meta: { title: string; basis: "invoice" | "payment"; range: DateRange },
): ReportTable {
  const row = (m: MonthTax, label: string) => ({
    month: label,
    invoices: m.invoices,
    taxable: m.taxable,
    cgst: m.cgst,
    sgst: m.sgst,
    igst: m.igst,
    gst: m.gst,
    gross: m.gross,
    tds: m.tds,
    net: m.net,
    gst_paid: m.gstPaid,
    tds_paid: m.tdsPaid,
  });
  return {
    title: meta.title,
    subtitle: [`Grouped by ${meta.basis === "invoice" ? "invoice date" : "entry date"}`, periodText(meta.range)],
    summary: [
      { label: "Taxable billed", value: formatINR(summary.total.taxable) },
      { label: "GST on bills", value: formatINR(summary.total.gst) },
      { label: "GST paid", value: formatINR(summary.total.gstPaid) },
      { label: "GST not yet paid", value: formatINR(summary.gstOutstanding) },
      { label: "TDS withheld", value: formatINR(summary.total.tds) },
    ],
    columns: [
      { key: "month", label: "Month", kind: "text", width: 1 },
      { key: "invoices", label: "Bills", kind: "number", width: 0.5 },
      { key: "taxable", label: "Taxable", kind: "money" },
      { key: "cgst", label: "CGST", kind: "money" },
      { key: "sgst", label: "SGST", kind: "money" },
      { key: "igst", label: "IGST", kind: "money" },
      { key: "gst", label: "GST", kind: "money" },
      { key: "gross", label: "Gross", kind: "money" },
      { key: "tds", label: "TDS", kind: "money" },
      { key: "net", label: "After TDS", kind: "money" },
      { key: "gst_paid", label: "GST paid", kind: "money" },
      { key: "tds_paid", label: "TDS paid", kind: "money" },
    ],
    rows: summary.months.map((m) => row(m, monthLabel(m.month))),
    totals: row(summary.total, "Total"),
    landscape: true,
    footnote:
      "Calculated from the bills and tax payments recorded in Lekha. Reversed entries are excluded. This is not a GST or TDS return; confirm figures with your accountant before filing.",
  };
}

export const rateText = (r: string | null | undefined) => (r ? formatRate(toRateMilli(r)) : "");
