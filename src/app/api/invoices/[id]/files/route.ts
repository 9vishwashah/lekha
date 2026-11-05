import { createHash, randomBytes } from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { userDb } from "@/lib/supabase/server";
import { friendly } from "@/lib/server/errors";
import { isUuid } from "@/lib/server/queries";
import { checkUpload } from "@/lib/invoices/files";

export const runtime = "nodejs";

/**
 * Attach a file to an invoice. The bytes are checked (not the extension or the browser's claim)
 * and stored exactly as received, in a private bucket. Client visibility is off unless asked for.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/invoices/[id]/files">) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in to upload" }, { status: 401 });
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a file" }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkUpload(file.name, bytes);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  const db = await userDb();
  const { data: invoice } = await db.from("invoices").select("id, workspace_id").eq("id", id).maybeSingle();
  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  let pageCount: number | null = null;
  if (check.mime === "application/pdf") {
    try {
      pageCount = (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
    } catch {
      return NextResponse.json({ error: "That PDF could not be read. It may be damaged." }, { status: 400 });
    }
  }
  const path = `${invoice.workspace_id}/${id}/${randomBytes(16).toString("hex")}.${check.ext}`;
  const up = await db.storage.from("invoice-files").upload(path, bytes, { contentType: check.mime, upsert: false });
  if (up.error) return NextResponse.json({ error: "The file could not be stored. Try again." }, { status: 500 });
  const { data, error } = await db.rpc("add_invoice_attachment", {
    p_invoice: id,
    p: {
      storage_path: path,
      file_name: file.name,
      mime_type: check.mime,
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      page_count: pageCount,
      role: form?.get("role") === "original" ? "original" : "supporting",
      client_visible: form?.get("client_visible") === "true",
    },
  });
  if (error) {
    await db.storage.from("invoice-files").remove([path]);
    return NextResponse.json({ error: friendly(error) }, { status: 400 });
  }
  return NextResponse.json({ id: data, pageCount });
}
