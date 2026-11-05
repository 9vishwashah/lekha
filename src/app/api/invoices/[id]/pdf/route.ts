import { auth } from "@clerk/nextjs/server";
import { userDb } from "@/lib/supabase/server";
import { getInvoice, getInvoiceSettings, invoiceLink, listPaymentProfiles, recordOf } from "@/lib/server/invoices";
import { previewPayment } from "@/lib/invoices/editor";
import { docFromRecord } from "@/lib/invoices/doc";
import { invoicePdf } from "@/lib/invoices/pdf";
import { downloadName } from "@/lib/invoices/files";
import { isUuid } from "@/lib/server/queries";

export const runtime = "nodejs";

/** The invoice PDF for members of its workspace. RLS decides whether the invoice is visible at all. */
export async function GET(request: Request, ctx: RouteContext<"/api/invoices/[id]/pdf">) {
  const { userId } = await auth();
  if (!userId) return new Response("Sign in to download", { status: 401 });
  const { id } = await ctx.params;
  if (!isUuid(id)) return new Response("Not found", { status: 404 });
  const db = await userDb();
  const data = await getInvoice(db, id);
  if (!data) return new Response("Not found", { status: 404 });
  const { invoice: i, items } = data;
  const settings = i.seller_snapshot ?? (await getInvoiceSettings(db, i.workspace_id, "Your business"));
  const payment = i.payment_snapshot ?? previewPayment(i.payment_config, await listPaymentProfiles(db, i.workspace_id));
  const url = i.show_digital_qr && i.status === "issued" ? await invoiceLink(db, id) : null;
  const pdf = await invoicePdf(docFromRecord(recordOf(i, items, settings, payment), url));
  const inline = new URL(request.url).searchParams.get("inline") === "1";
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${downloadName(i.invoice_no ?? "draft-invoice")}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
