import "server-only";
import type { Db } from "@/lib/supabase/server";
import { fetchAll, getTaxSettlements, reversedIds } from "./queries";
import { type TaxRow, type SettlementRow, taxSummary } from "@/lib/domain/tax-summary";
import type { DateRange } from "@/lib/domain/ledger";
import type { ReportTable } from "@/lib/export/table";
import { formatINR, sum, toPaise } from "@/lib/domain/money";
import { formatDate } from "@/lib/domain/dates";
import { ADVANCE_STATUS_LABEL } from "@/lib/domain/advances";
import { paymentModeLabel } from "@/lib/types";
import { advancesWithPositions } from "./workspace-data";

/** Monthly tax summary across every taxation ledger in the workspace (or one ledger). */
export async function workspaceTaxSummary(db: Db, workspaceId: string, basis: "invoice" | "payment", range: DateRange, ledgerId?: string) {
  const { data: ledgers } = await db.from("ledgers").select("id, name").eq("workspace_id", workspaceId).eq("ledger_type", "taxation");
  const ids = (ledgers ?? []).map((l) => l.id).filter((id) => !ledgerId || id === ledgerId);
  if (!ids.length) return { summary: taxSummary([], [], basis, range), ledgers: ledgers ?? [], details: [] };
  const [txns, details, settlements] = await Promise.all([
    fetchAll<{ id: string; ledger_id: string; voucher_no: string; txn_date: string; status: TaxRow["status"]; reversal_of: string | null; description: string | null; counterparty: string | null; amount: string }>(
      (from, to) => db.from("transactions").select("id, ledger_id, voucher_no, txn_date, status, reversal_of, description, counterparty, amount").in("ledger_id", ids).order("id").range(from, to),
    ),
    fetchAll<TaxRow & { transaction_id: string; invoice_no: string | null; gst_rate: string; tds_rate: string }>((from, to) =>
      db.from("transaction_tax_details").select("*").in("ledger_id", ids).order("transaction_id").range(from, to),
    ),
    getTaxSettlements(db, ids),
  ]);
  const byId = new Map(txns.map((t) => [t.id, t]));
  const reversed = reversedIds(txns);
  const rows: (TaxRow & { transaction_id: string; voucher_no: string; ledger: string; party: string | null; invoice_no: string | null })[] = details.map((d) => {
    const t = byId.get(d.transaction_id)!;
    return {
      ...d,
      txn_date: t.txn_date,
      status: t.status,
      reversed: reversed.has(t.id),
      voucher_no: t.voucher_no,
      ledger: ledgers?.find((l) => l.id === t.ledger_id)?.name ?? "",
      party: t.counterparty ?? t.description,
    };
  });
  const settlementRows: SettlementRow[] = settlements.map((s) => {
    const t = byId.get(s.transaction_id)!;
    return { txn_date: t.txn_date, period_month: s.period_month, tax_type: s.tax_type, amount: t.amount, status: t.status, reversed: reversed.has(t.id) };
  });
  return { summary: taxSummary(rows, settlementRows, basis, range), ledgers: ledgers ?? [], details: rows };
}

export async function expensesTable(db: Db, workspaceId: string, range: DateRange, category?: string): Promise<ReportTable> {
  const [{ data: cats }, rows] = await Promise.all([
    db.from("expense_categories").select("id, name").eq("workspace_id", workspaceId),
    fetchAll<{ expense_date: string; title: string; amount: string; vendor: string | null; payment_mode: string | null; reference_no: string | null; category_id: string; status: string; gst_amount: string | null; ledger_id: string | null }>((from, to) => {
      let q = db.from("expenses").select("expense_date, title, amount, vendor, payment_mode, reference_no, category_id, status, gst_amount, ledger_id").eq("workspace_id", workspaceId);
      if (range.from) q = q.gte("expense_date", range.from);
      if (range.to) q = q.lte("expense_date", range.to);
      if (category) q = q.eq("category_id", category);
      return q.order("expense_date").order("id").range(from, to);
    }),
  ]);
  const name = new Map((cats ?? []).map((c) => [c.id, c.name]));
  const active = rows.filter((r) => r.status === "active");
  const byCat = new Map<string, bigint>();
  for (const r of active) byCat.set(r.category_id, (byCat.get(r.category_id) ?? 0n) + toPaise(r.amount));
  return {
    title: "Expenses",
    subtitle: [range.from || range.to ? `Period ${range.from ? formatDate(range.from) : "start"} to ${range.to ? formatDate(range.to) : "today"}` : "All expenses"],
    summary: [
      { label: "Total", value: formatINR(sum(active.map((r) => toPaise(r.amount)))) },
      ...[...byCat.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1)).slice(0, 7).map(([id, v]) => ({ label: name.get(id) ?? "Other", value: formatINR(v) })),
    ],
    columns: [
      { key: "date", label: "Date", kind: "date", width: 0.9 },
      { key: "title", label: "Expense", kind: "text", width: 2 },
      { key: "category", label: "Category", kind: "text", width: 1 },
      { key: "vendor", label: "Vendor", kind: "text", width: 1.2 },
      { key: "mode", label: "Mode", kind: "text", width: 0.8 },
      { key: "gst", label: "GST", kind: "money" },
      { key: "amount", label: "Amount", kind: "money" },
    ],
    rows: rows.map((r) => ({
      date: r.expense_date,
      title: `${r.title}${r.status === "void" ? " (VOID)" : ""}${r.ledger_id ? " · paid from ledger" : ""}`,
      category: name.get(r.category_id) ?? "",
      vendor: r.vendor,
      mode: [paymentModeLabel(r.payment_mode), r.reference_no].filter(Boolean).join(" · "),
      gst: r.gst_amount ? toPaise(r.gst_amount) : null,
      amount: toPaise(r.amount),
    })),
    totals: { title: "Total", amount: sum(active.map((r) => toPaise(r.amount))) },
    footnote: "Expenses paid from a ledger also appear there as one Money Out entry. Add them up from one place only.",
  };
}

export async function advancesTable(db: Db, workspaceId: string, today: string): Promise<ReportTable> {
  const list = (await advancesWithPositions(db, workspaceId, today)).filter((a) => a.status === "active");
  return {
    title: "Outstanding advances",
    subtitle: [`As of ${formatDate(today)}`],
    summary: [
      { label: "Given", value: formatINR(sum(list.map((a) => a.position.amount))) },
      { label: "Recovered", value: formatINR(sum(list.map((a) => a.position.recovered))) },
      { label: "Adjusted", value: formatINR(sum(list.map((a) => a.position.adjusted))) },
      { label: "Outstanding", value: formatINR(sum(list.map((a) => a.position.outstanding))) },
    ],
    columns: [
      { key: "date", label: "Given on", kind: "date", width: 0.9 },
      { key: "contractor", label: "Contractor", kind: "text", width: 1.4 },
      { key: "purpose", label: "Purpose", kind: "text", width: 1.6 },
      { key: "due", label: "Due back", kind: "date", width: 0.9 },
      { key: "status", label: "Status", kind: "text", width: 1 },
      { key: "amount", label: "Given", kind: "money" },
      { key: "recovered", label: "Recovered", kind: "money" },
      { key: "adjusted", label: "Adjusted", kind: "money" },
      { key: "outstanding", label: "Outstanding", kind: "money" },
    ],
    rows: list.map((a) => ({
      date: a.given_date,
      contractor: a.contractor?.name ?? "",
      purpose: a.purpose,
      due: a.expected_recovery_date,
      status: a.position.overdue ? "Overdue" : ADVANCE_STATUS_LABEL[a.position.status],
      amount: a.position.amount,
      recovered: a.position.recovered,
      adjusted: a.position.adjusted,
      outstanding: a.position.outstanding,
    })),
    totals: {
      contractor: "Total",
      amount: sum(list.map((a) => a.position.amount)),
      recovered: sum(list.map((a) => a.position.recovered)),
      adjusted: sum(list.map((a) => a.position.adjusted)),
      outstanding: sum(list.map((a) => a.position.outstanding)),
    },
    landscape: true,
  };
}
