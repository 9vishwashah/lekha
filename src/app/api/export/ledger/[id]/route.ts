import { auth } from "@clerk/nextjs/server";
import { userDb } from "@/lib/supabase/server";
import { getLedger, getLedgerTax, getLedgerTxns, getPersonalLedger } from "@/lib/server/queries";
import { ledgerStatementTable, personalLedgerTable } from "@/lib/reports";
import { exportResponse, parseFormat } from "@/lib/export/respond";
import { isISODate } from "@/lib/domain/dates";
import type { Perspective } from "@/lib/domain/ledger";

export const runtime = "nodejs";

/**
 * Ledger statement export. Reads run as the signed-in user, so RLS decides what is visible:
 * a collaborator without tax permission gets no tax columns because the rows never arrive.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/export/ledger/[id]">) {
  const { userId } = await auth();
  if (!userId) return new Response("Sign in to export", { status: 401 });
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const format = parseFormat(url.searchParams.get("format"));
  if (!format) return new Response("Choose xlsx, csv or pdf", { status: 400 });
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const range = { from: from && isISODate(from) ? from : undefined, to: to && isISODate(to) ? to : undefined };

  const db = await userDb();
  const ledger = await getLedger(db, id);
  const { data: ws } = await db.from("workspaces").select("name").eq("id", ledger.workspace_id).maybeSingle();
  const business = ws?.name ?? "Lekha";

  if (ledger.ledger_type === "personal") {
    const data = await getPersonalLedger(db, id);
    const inRange = (d: string) => (!range.from || d >= range.from) && (!range.to || d <= range.to);
    const table = personalLedgerTable({
      name: ledger.name,
      participants: data.participants.map((p) => ({ id: p.id, name: p.display_name })),
      expenses: data.expenses.filter((e) => inRange(e.txn_date)),
      settlements: data.settlements.filter((s) => inRange(s.txn_date)),
    });
    return exportResponse([table], format, { business, fileName: `${ledger.name} statement` });
  }

  const [txns, tax] = await Promise.all([getLedgerTxns(db, id), getLedgerTax(db, id)]);
  const table = ledgerStatementTable({
    ledger: { ...ledger, perspective: ledger.perspective as Perspective },
    partyName: ledger.contractor?.name,
    txns: txns.map((t) => ({ ...t, tax: tax.get(t.id) ?? null })),
    range,
    includeTax: ledger.ledger_type === "taxation" && tax.size > 0,
  });
  return exportResponse([table], format, { business, fileName: `${ledger.name} statement` });
}
