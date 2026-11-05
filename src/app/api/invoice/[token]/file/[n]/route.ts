import { anonDb } from "@/lib/supabase/server";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { isTokenShape } from "@/lib/server/shared";
import { downloadName } from "@/lib/invoices/files";

export const runtime = "nodejs";

/**
 * A client-visible file of this invoice, streamed unchanged. The storage rule re-checks that the
 * link is live and the file is shared, so turning either off stops downloads at once.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/invoice/[token]/file/[n]">) {
  if (!allow(await clientKey("invoice-file"), 20, 60_000)) return new Response("Too many requests", { status: 429 });
  const { token, n } = await ctx.params;
  if (!isTokenShape(token) || !/^\d{1,3}$/.test(n)) return new Response("Not found", { status: 404 });
  const db = anonDb();
  const { data: file } = await db.rpc("get_public_invoice_file", { p_token: token, p_n: Number(n) });
  const meta = file as { path: string; file_name: string; mime_type: string } | null;
  if (!meta) return new Response("Not found", { status: 404 });
  const { data, error } = await db.storage.from("invoice-files").download(meta.path);
  if (error || !data) return new Response("Not found", { status: 404 });
  // ?view=1 opens PDFs and images in the browser; Word files can only be downloaded.
  const view = new URL(request.url).searchParams.get("view") === "1" && (meta.mime_type === "application/pdf" || meta.mime_type.startsWith("image/"));
  return new Response(data, {
    headers: {
      "Content-Type": meta.mime_type,
      "Content-Disposition": `${view ? "inline" : "attachment"}; filename="${downloadName(meta.file_name)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
