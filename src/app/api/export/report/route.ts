import { auth } from "@clerk/nextjs/server";
import { userDb } from "@/lib/supabase/server";
import { getMemberships, WORKSPACE_COOKIE } from "@/lib/server/context";
import { cookies } from "next/headers";
import { advancesTable, expensesTable, workspaceTaxSummary } from "@/lib/server/report-data";
import { ledgerBalances } from "@/lib/server/workspace-data";
import { taxSummaryTable } from "@/lib/reports";
import { exportResponse, parseFormat } from "@/lib/export/respond";
import { isISODate, todayISO, formatDate } from "@/lib/domain/dates";
import { describeBalance, type Perspective } from "@/lib/domain/ledger";
import { formatINR, sum } from "@/lib/domain/money";
import type { ReportTable } from "@/lib/export/table";

export const runtime = "nodejs";

/** Workspace reports: expenses, advances, tax summary, ledger balances. Reads run under RLS. */
export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) return new Response("Sign in to export", { status: 401 });
  const url = new URL(request.url);
  const format = parseFormat(url.searchParams.get("format"));
  if (!format) return new Response("Choose xlsx, csv or pdf", { status: 400 });
  const memberships = await getMemberships();
  const chosen = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const m = memberships.find((x) => x.workspace.id === chosen) ?? memberships[0];
  if (!m) return new Response("No workspace", { status: 403 });
  const ws = m.workspace;
  const db = await userDb();
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const range = { from: from && isISODate(from) ? from : undefined, to: to && isISODate(to) ? to : undefined };
  const type = url.searchParams.get("type");

  let table: ReportTable;
  switch (type) {
    case "expenses":
      table = await expensesTable(db, ws.id, range, url.searchParams.get("category") ?? undefined);
      break;
    case "advances":
      table = await advancesTable(db, ws.id, todayISO());
      break;
    case "tax": {
      const basis = url.searchParams.get("basis") === "payment" ? "payment" : "invoice";
      const { summary } = await workspaceTaxSummary(db, ws.id, basis, range, url.searchParams.get("ledger") ?? undefined);
      table = taxSummaryTable(summary, { title: "Monthly tax summary", basis, range });
      break;
    }
    case "balances": {
      const { entries } = await ledgerBalances(db, ws.id, range);
      const rows = entries.filter((e) => e.ledger.ledger_type !== "personal");
      table = {
        title: "Ledger balances",
        subtitle: [range.from || range.to ? `Money in/out for ${range.from ? formatDate(range.from) : "start"} to ${range.to ? formatDate(range.to) : "today"}` : "All time", `Balances as of ${formatDate(todayISO())}`],
        summary: [
          { label: "Money in", value: formatINR(sum(rows.map((e) => e.periodStatement?.totals.moneyIn ?? 0n))) },
          { label: "Money out", value: formatINR(sum(rows.map((e) => e.periodStatement?.totals.moneyOut ?? 0n))) },
        ],
        columns: [
          { key: "name", label: "Ledger", kind: "text", width: 1.6 },
          { key: "party", label: "Contractor", kind: "text", width: 1.3 },
          { key: "type", label: "Type", kind: "text", width: 0.8 },
          { key: "in", label: "Money in", kind: "money" },
          { key: "out", label: "Money out", kind: "money" },
          { key: "balance", label: "Balance", kind: "money" },
          { key: "meaning", label: "Meaning", kind: "text", width: 1.4 },
        ],
        rows: rows.map((e) => ({
          name: `${e.ledger.name}${e.ledger.status === "archived" ? " (archived)" : ""}`,
          party: e.ledger.contractor?.name ?? null,
          type: e.ledger.ledger_type === "taxation" ? "Taxation" : "Basic",
          in: e.periodStatement?.totals.moneyIn ?? 0n,
          out: e.periodStatement?.totals.moneyOut ?? 0n,
          balance: e.statement?.closing ?? 0n,
          meaning: describeBalance(e.ledger.perspective as Perspective, e.statement?.closing ?? 0n, e.ledger.contractor?.name).label,
        })),
        footnote: "Cash-book balances and party balances mean different things and are not added together.",
      };
      break;
    }
    default:
      return new Response("Unknown report", { status: 400 });
  }
  return exportResponse([table], format, { business: ws.name, fileName: `${ws.name} ${table.title}` });
}
