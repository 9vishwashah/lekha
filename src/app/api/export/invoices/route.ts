import { auth } from "@clerk/nextjs/server";
import { userDb } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/server/context";
import { listInvoices, listPayments } from "@/lib/server/invoices";
import { exportResponse, parseFormat } from "@/lib/export/respond";
import { invoiceReport, type InvoiceReportType } from "@/lib/invoices/reports";
import { isISODate, todayISO } from "@/lib/domain/dates";

export const runtime = "nodejs";

const TYPES: InvoiceReportType[] = ["register", "payments", "clients", "tax", "overdue", "months"];

export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) return new Response("Sign in to export", { status: 401 });
  const url = new URL(request.url);
  const format = parseFormat(url.searchParams.get("format"));
  const type = url.searchParams.get("type") as InvoiceReportType;
  if (!format || !TYPES.includes(type)) return new Response("Choose a report and a format", { status: 400 });
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const range = { from: from && isISODate(from) ? from : undefined, to: to && isISODate(to) ? to : undefined };
  const ctx = await getWorkspace();
  const db = await userDb();
  const [invoices, payments] = await Promise.all([listInvoices(db, ctx.workspace.id), listPayments(db, ctx.workspace.id)]);
  const table = invoiceReport(type, invoices, payments, range, todayISO(), ctx.workspace.name);
  return exportResponse([table], format, { business: ctx.workspace.name, fileName: table.title });
}
