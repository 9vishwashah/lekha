import { auth } from "@clerk/nextjs/server";
import { userDb } from "@/lib/supabase/server";
import { isUuid } from "@/lib/server/queries";
import { downloadName } from "@/lib/invoices/files";

export const runtime = "nodejs";

/** A member downloads a stored file: the exact bytes that were uploaded. */
export async function GET(request: Request, ctx: RouteContext<"/api/invoices/files/[fileId]">) {
  const { userId } = await auth();
  if (!userId) return new Response("Sign in to download", { status: 401 });
  const { fileId } = await ctx.params;
  if (!isUuid(fileId)) return new Response("Not found", { status: 404 });
  const db = await userDb();
  const { data: file } = await db.from("invoice_attachments").select("storage_path, file_name, mime_type").eq("id", fileId).maybeSingle();
  if (!file) return new Response("Not found", { status: 404 });
  const { data, error } = await db.storage.from("invoice-files").download(file.storage_path);
  if (error || !data) return new Response("Not found", { status: 404 });
  const inline = new URL(request.url).searchParams.get("inline") === "1" && file.mime_type !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return new Response(data, {
    headers: {
      "Content-Type": file.mime_type,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${downloadName(file.file_name)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
