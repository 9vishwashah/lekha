import { allow, clientKey } from "@/lib/server/rate-limit";
import { loadPublicInvoice, publicDoc } from "@/lib/server/invoices";
import { invoicePdf } from "@/lib/invoices/pdf";
import { downloadName } from "@/lib/invoices/files";

export const runtime = "nodejs";

/** Public, read-only: the PDF of the one invoice this token opens. */
export async function GET(_: Request, ctx: RouteContext<"/api/invoice/[token]/pdf">) {
  if (!allow(await clientKey("invoice-pdf"), 20, 60_000)) return new Response("Too many requests", { status: 429 });
  const { token } = await ctx.params;
  const invoice = await loadPublicInvoice(token);
  if (!invoice) return new Response("This link is no longer active", { status: 404 });
  // The issuer chose to send only their own document, so the Lekha format is not offered.
  if (invoice.document_mode === "uploaded") return new Response("Not available", { status: 404 });
  const pdf = await invoicePdf(publicDoc(invoice, token));
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${downloadName(invoice.invoice_no ?? "invoice")}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
