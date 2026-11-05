import { auth } from "@clerk/nextjs/server";
import { userDb } from "@/lib/supabase/server";
import { isUuid } from "@/lib/server/queries";

export const runtime = "nodejs";

/** The screenshot a client attached to a payment note, for the issuer reviewing it. */
export async function GET(_: Request, ctx: RouteContext<"/api/invoices/proofs/[id]">) {
  const { userId } = await auth();
  if (!userId) return new Response("Sign in", { status: 401 });
  const { id } = await ctx.params;
  if (!isUuid(id)) return new Response("Not found", { status: 404 });
  const db = await userDb();
  const { data: row } = await db.from("invoice_payment_submissions").select("proof_path, proof_mime").eq("id", id).maybeSingle();
  if (!row?.proof_path) return new Response("Not found", { status: 404 });
  const { data, error } = await db.storage.from("invoice-files").download(row.proof_path);
  if (error || !data) return new Response("Not found", { status: 404 });
  return new Response(data, {
    headers: {
      "Content-Type": row.proof_mime ?? "application/octet-stream",
      "Content-Disposition": `${row.proof_mime?.startsWith("image/") ? "inline" : "attachment"}; filename="payment-proof"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
